'use strict';

// Settings page + API (Phase 3 / Week 12). Serves the settings UI and the JSON
// it calls to view/edit the tenant's voice guide, workspace connections, and
// account. Every data route is behind requireAuth so it runs against the
// signed-in user's tenant (req.user.tenant_id); in demo mode (no DATABASE_URL)
// requireAuth attaches a demo user so this still works. All DB ops degrade
// gracefully. Never logs voice guide content or tokens.

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const {
  voiceLimiter,
  settingsReadLimiter,
  settingsWriteLimiter,
  uploadLimiter,
} = require('../middleware/rateLimit');
const { clientErrorMessage } = require('../utils/errors');
const {
  resolveTenant,
  getVoiceGuide,
  saveVoiceGuide,
  setTenantDefaultFolder,
} = require('../db');
const { getSlackLinksForUser } = require('../db/users');
const {
  getTenantLibrary,
  setActiveAssetIds,
  createAssetType,
  updateAssetType,
  isSeededAssetName,
} = require('../db/assets');
const {
  normalizeNewAsset,
  normalizeAssetEdit,
  MAX_FIELDS_PER_ASSET,
  MAX_ASSETS_PER_TENANT,
} = require('../utils/assetInput');
// Same fold the unique index uses, so "renamed" here means what Postgres means.
const { normalize } = require('../utils/normalize');
const { generateVoiceGuide } = require('../services/gemini');
const { listDocTemplates, saveDocTemplate } = require('../db/docTemplates');
const { importDocxTemplate, DOCX_MIME } = require('../destinations/docTemplateImport');
const { describeLocation } = require('../destinations/docPlaceholders');
const { getClientsForTenant } = require('../google');

const router = express.Router();

// Template upload. Same shape as routes/app.js:60 — multer to the OS temp dir, a
// hard size cap, a mime allowlist — with two deliberate differences: ONE file
// (a template is a single document, and accepting three would invite the
// question of which one won), and .docx ONLY.
//
// .docx only because the import's whole value is Drive's Word→Docs converter.
// A PDF would import as an image with no table structure, and a .doc (the old
// binary format) converts unreliably. Better to refuse the format than to accept
// it and hand back a document with no placeholders in it for reasons the tenant
// cannot see.
const TEMPLATE_MAX_BYTES = 10 * 1024 * 1024;
const templateUploadMw = multer({
  dest: os.tmpdir(),
  limits: { fileSize: TEMPLATE_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === DOCX_MIME || /\.docx$/i.test(file.originalname || '');
    cb(null, ok);
  },
}).single('file');

// Pull a Drive folder id out of a pasted folder URL (…/folders/<id> or ?id=<id>).
function folderIdFromUrl(url) {
  const s = String(url || '');
  const m = s.match(/\/folders\/([^/?#]+)/) || s.match(/[?&]id=([^&]+)/);
  return m ? m[1] : (s.trim() || null);
}
function folderUrlFromId(id) {
  return id ? `https://drive.google.com/drive/folders/${id}` : null;
}

// GET /settings — the single-file settings UI.
const SETTINGS_HTML = path.join(__dirname, '..', '..', 'public', 'settings.html');
router.get('/settings', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0'); // never cache the shell (no stale UI)
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.status(200).sendFile(SETTINGS_HTML);
});

// GET /api/settings/voice — the tenant's saved voice guide (or null).
router.get('/api/settings/voice', requireAuth, async (req, res) => {
  try {
    const markdown = await getVoiceGuide(req.user && req.user.tenant_id);
    return res.status(200).json({ success: true, voiceMarkdown: markdown || null });
  } catch (err) {
    console.error('[settings] GET /voice failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// POST /api/settings/voice — save edited voice guide markdown.
router.post('/api/settings/voice', requireAuth, async (req, res) => {
  const markdown = (req.body || {}).voiceMarkdown;
  if (typeof markdown !== 'string' || !markdown.trim()) {
    return res.status(400).json({ success: false, error: 'voiceMarkdown is required' });
  }
  try {
    await saveVoiceGuide(req.user && req.user.tenant_id, markdown);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[settings] POST /voice failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// POST /api/settings/voice/generate — six answers (+ optional direction) →
// Gemini → save → return the new markdown.
router.post('/api/settings/voice/generate', voiceLimiter, requireAuth, async (req, res) => {
  const body = req.body || {};
  const a = body.answers || {};
  try {
    const markdown = await generateVoiceGuide({
      brandPersonality: a.brandPersonality,
      toneGuidance: a.toneGuidance,
      audienceLanguage: a.audienceLanguage,
      wordsToUse: a.wordsToUse,
      wordsToAvoid: a.wordsToAvoid,
      toneReference: a.toneReference,
      direction: body.direction,
      previousGuide: body.previousGuide,
    });
    try {
      await saveVoiceGuide(req.user && req.user.tenant_id, markdown);
    } catch (e) {
      console.error('[settings] voice save failed (continuing):', e.message);
    }
    return res.status(200).json({ success: true, voiceMarkdown: markdown });
  } catch (err) {
    console.error('[settings] /voice/generate failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// GET /api/settings/library — the tenant's asset library, READ-ONLY.
//
// Every asset, active and inactive, with stable ids on the assets and their
// fields. This is the surface a clone-and-edit feature attaches to; nothing here
// writes, and there is no id in the request — the tenant comes from the SESSION
// (req.user.tenant_id), never from the body or a query param, so this endpoint
// cannot be pointed at somebody else's library.
//
// Deliberately NOT the same handler as GET /api/onboarding/assets. That one is
// intentionally un-gated (the onboarding page must render before a session
// exists) and returns names and active flags only. This one is behind
// requireAuth and returns ids, limits and spec provenance — a strictly larger
// payload that must not become reachable without a session by sharing a route.
router.get('/api/settings/library', settingsReadLimiter, requireAuth, async (req, res) => {
  try {
    const tenantId = (req.user && req.user.tenant_id) || null;
    const assets = await getTenantLibrary(tenantId);
    if (assets === null) {
      // No DB / no tenant. Distinct from an empty library, and the UI says so.
      return res.status(200).json({ success: true, available: false, assets: [] });
    }
    // `editable` is derived, not stored — see db/assets.isSeededAssetName. It is
    // sent so the UI can show the right affordance, and it is ALSO enforced
    // server-side in updateAssetType against the stored row, because a flag in a
    // response the client can ignore is a hint, not a rule.
    return res.status(200).json({
      success: true,
      available: true,
      assets: assets.map((a) => ({ ...a, editable: !isSeededAssetName(a.name) })),
      counts: {
        assets: assets.length,
        active: assets.filter((a) => a.is_active).length,
        fields: assets.reduce((n, a) => n + a.fields.length, 0),
        editable: assets.filter((a) => !isSeededAssetName(a.name)).length,
      },
    });
  } catch (err) {
    console.error('[settings] GET /library failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// POST /api/settings/library/active { id, active } — switch ONE asset type on or
// off. The only writable thing about the library: is_active and nothing else.
//
// Onboarding was the only place with these toggles, so once a tenant finished
// setup their asset list was frozen unless they signed out and re-onboarded.
//
// Single-asset, not a whole-list replace. It reads the tenant's own library,
// derives the new deactivated set from it, and hands that to setActiveAssetIds —
// the same write onboarding uses. Sending the full list from the browser would
// have been fewer moving parts, but two open tabs would then silently undo each
// other: whichever saved last would re-activate everything the other had turned
// off. This way a stale tab can only ever be wrong about the one asset it
// touched.
//
// The tenant comes from the SESSION. The id in the body is checked against that
// tenant's own library, so an id belonging to somebody else is a 404 rather than
// a no-op — setActiveAssetIds is already tenant-scoped and would ignore it
// silently, and a silent ignore is the failure mode this work exists to remove.
router.post('/api/settings/library/active', settingsWriteLimiter, requireAuth, async (req, res) => {
  const body = req.body || {};
  const id = String(body.id == null ? '' : body.id).trim();
  const active = body.active;
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ success: false, error: 'A valid asset id is required.' });
  }
  if (typeof active !== 'boolean') {
    return res.status(400).json({ success: false, error: 'active must be true or false.' });
  }
  try {
    const tenantId = (req.user && req.user.tenant_id) || null;
    const assets = await getTenantLibrary(tenantId);
    if (!assets) {
      return res.status(400).json({ success: false, error: 'No asset library is connected to this workspace.' });
    }
    // Not this tenant's asset → 404, the same shape a missing one gets, so the
    // response never confirms that somebody else's id exists.
    if (!assets.some((a) => a.id === id)) {
      return res.status(404).json({ success: false, error: 'Asset not found.' });
    }
    // Everything currently off, plus/minus the one being changed.
    const deactivated = assets.filter((a) => !a.is_active).map((a) => a.id).filter((x) => x !== id);
    if (!active) deactivated.push(id);
    await setActiveAssetIds(tenantId, deactivated);

    const after = (await getTenantLibrary(tenantId)) || [];
    return res.status(200).json({
      success: true,
      id,
      active,
      counts: {
        assets: after.length,
        active: after.filter((a) => a.is_active).length,
        fields: after.reduce((n, a) => n + a.fields.length, 0),
      },
    });
  } catch (err) {
    console.error('[settings] POST /library/active failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// POST /api/settings/library/asset — create ONE tenant-authored asset type.
//
// The first write path into asset_types that is not a seed or a migration. It
// creates and nothing else: no clone, no delete, no editing of an existing
// asset. A seeded asset stays read-only apart from is_active.
//
// The body is passed through utils/assetInput normalizeNewAsset, which is the
// column allowlist — it builds the stored shape key by key and has no branch
// that can set spec_type or spec_source, so a tenant field is NULL on both by
// construction. Those two render as claims of authority in the generated doc
// (googleDocs.js specTypeLine / fieldHint), which is why they are absent from
// the accepted set rather than validated within it.
//
// The tenant comes from the SESSION. The body carries no tenant, and the
// existing-name list the duplicate check runs against is read from that tenant's
// own library, so a name can only ever collide with the caller's own assets.
router.post('/api/settings/library/asset', settingsWriteLimiter, requireAuth, async (req, res) => {
  try {
    const tenantId = (req.user && req.user.tenant_id) || null;
    const existing = await getTenantLibrary(tenantId);
    if (existing === null) {
      return res.status(400).json({ success: false, error: 'No asset library is connected to this workspace.' });
    }

    const { errors, asset } = normalizeNewAsset(req.body, {
      existingNames: existing.map((a) => a.name),
      existingAssetCount: existing.length,
    });
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors[0], errors });
    }

    let id;
    try {
      id = await createAssetType(tenantId, asset);
    } catch (err) {
      // 23505 = the normalized-name unique index. Reachable despite the check
      // above if two tabs submit the same name at once; the index is the
      // authority and this turns its error into the same sentence.
      if (err && err.code === '23505') {
        return res
          .status(409)
          .json({ success: false, error: `You already have an asset type called "${asset.name}".` });
      }
      throw err;
    }

    const after = (await getTenantLibrary(tenantId)) || [];
    console.log(`[settings] created asset type ${id} for tenant ${tenantId} (${asset.fields.length} field(s))`);
    return res.status(201).json({
      success: true,
      id,
      counts: {
        assets: after.length,
        active: after.filter((a) => a.is_active).length,
        fields: after.reduce((n, a) => n + a.fields.length, 0),
      },
      limits: { fieldsPerAsset: MAX_FIELDS_PER_ASSET, assetsPerTenant: MAX_ASSETS_PER_TENANT },
    });
  } catch (err) {
    console.error('[settings] POST /library/asset failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// POST /api/settings/library/asset/:id — EDIT one asset the tenant created.
//
// Everything about it: name, group, creative direction, and the whole field list
// (rename, limits, unit, writing note, order, add, remove). Fields are addressed
// BY ID — the ids getTenantLibrary has been returning since the editor read
// shipped — so a rename is applied to a row rather than inferred from a name.
//
// Three refusals, all decided from the STORED row rather than the request:
//   • not this tenant's asset → 404 (never 403; a 403 would confirm the id exists)
//   • a SEEDED asset          → 403, with the reason said out loud
//   • a name another asset already holds → 409 from the unique index
//
// The seeded refusal is the one that matters. services/specReview.js updates
// copy_fields by asset NAME with no tenant filter, so a renamed seeded asset
// silently stops receiving platform-limit updates while its doc keeps rendering
// "Platform limit (LinkedIn)" beside a stale number with a live citation link.
// Hiding the UI is not enough — this route is what makes it true.
//
// The body goes through utils/assetInput normalizeAssetEdit, which shares its
// field allowlist with the create path (literally the same function), so
// spec_type and spec_source are absent from an update for the same reason they
// are absent from a create: there is no branch that can set them.
router.post('/api/settings/library/asset/:id', settingsWriteLimiter, requireAuth, async (req, res) => {
  const assetId = String(req.params.id || '').trim();
  if (!/^\d+$/.test(assetId)) {
    return res.status(400).json({ success: false, error: 'A valid asset id is required.' });
  }
  try {
    const tenantId = (req.user && req.user.tenant_id) || null;
    const existing = await getTenantLibrary(tenantId);
    if (existing === null) {
      return res.status(400).json({ success: false, error: 'No asset library is connected to this workspace.' });
    }
    const current = existing.find((a) => a.id === assetId);
    if (!current) {
      return res.status(404).json({ success: false, error: 'Asset not found.' });
    }
    // Reported early so the UI can say why before the user types; the authority
    // is still updateAssetType, which re-checks against the row it locks.
    if (isSeededAssetName(current.name)) {
      return res.status(403).json({
        success: false,
        error: `"${current.name}" is one of Quillio's built-in asset types. Its fields track platform limits, so it can only be switched on or off — copy it into an asset type of your own to change it.`,
      });
    }

    const { errors, asset } = normalizeAssetEdit(req.body, {
      existingNames: existing.map((a) => a.name),
      selfName: current.name,
    });
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors[0], errors });
    }

    let result;
    try {
      result = await updateAssetType(tenantId, assetId, asset);
    } catch (err) {
      if (err && err.code === '23505') {
        return res
          .status(409)
          .json({ success: false, error: `You already have an asset type called "${asset.name}".` });
      }
      throw err;
    }
    if (!result.ok && result.reason === 'seeded') {
      return res.status(403).json({ success: false, error: 'Built-in asset types are read-only.' });
    }
    if (!result.ok) {
      return res.status(404).json({ success: false, error: 'Asset not found.' });
    }

    const after = (await getTenantLibrary(tenantId)) || [];
    const renamed = normalize(current.name) !== normalize(asset.name);
    console.log(
      `[settings] updated asset type ${assetId} for tenant ${tenantId} ` +
        `(${asset.fields.length} field(s)${renamed ? ', renamed' : ''})`
    );
    return res.status(200).json({
      success: true,
      id: assetId,
      renamed,
      // Said back to the client because it is the one consequence of an edit that
      // is not visible in the library: a doc built under the OLD name no longer
      // matches this asset, so a re-draft of that doc loses its creative
      // direction (core/pipeline getAssetDirections matches by normalized name).
      // Nothing errors; the doc just drafts without it.
      ...(renamed && current.asset_direction
        ? { warning: `Docs already built as "${current.name}" won't pick up this asset's creative direction if you re-draft them.` }
        : {}),
      counts: {
        assets: after.length,
        active: after.filter((a) => a.is_active).length,
        fields: after.reduce((n, a) => n + a.fields.length, 0),
      },
      limits: { fieldsPerAsset: MAX_FIELDS_PER_ASSET, assetsPerTenant: MAX_ASSETS_PER_TENANT },
    });
  } catch (err) {
    console.error('[settings] POST /library/asset/:id failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// --- Template documents (custom document types, STEP ONE) --------------------
//
// A tenant brings their own template document — the landscape multi-table "copy
// matrix" a form/confirmation page is written in — and Quillio finds the
// {{Placeholders}} in it. That is all this step does. Nothing maps a placeholder
// to a field and nothing builds from a template yet.
//
// It is an UPLOAD rather than a pasted link because it has to be: the tenant
// OAuth scope is drive.file (routes/oauth.js:45), which reaches only files the
// app created, so a link to a hand-made file returns 404. Bytes that arrive
// through Quillio become a Drive file Quillio created.

// GET /api/settings/templates — what this tenant has uploaded, with the
// placeholders found in each. Read-only.
router.get('/api/settings/templates', settingsReadLimiter, requireAuth, async (req, res) => {
  try {
    const tenantId = (req.user && req.user.tenant_id) || null;
    const templates = await listDocTemplates(tenantId);
    if (templates === null) {
      // No DB, or the migration has not run here yet. Distinct from "none
      // uploaded", and the UI says so rather than showing an empty list.
      return res.status(200).json({ success: true, available: false, templates: [] });
    }
    return res.status(200).json({
      success: true,
      available: true,
      // `where` is rendered here rather than in the browser so the two surfaces
      // cannot describe the same location differently.
      templates: templates.map((t) => ({
        ...t,
        placeholders: (t.placeholders || []).map((p) => ({
          ...p,
          where: (p.locations || []).map(describeLocation),
        })),
      })),
    });
  } catch (err) {
    console.error('[settings] GET /templates failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// POST /api/settings/templates — upload ONE .docx, import it to Drive as a Google
// Doc the app owns, discover its placeholders, store both.
//
// The tenant comes from the SESSION and the Drive write runs as the ACTING USER
// (getClientsForTenant), exactly like every other Drive write — so the imported
// file lands in that person's Drive and is theirs, not a shared service
// account's. The multipart body carries the file and nothing else: no tenant, no
// id, no path.
router.post('/api/settings/templates', uploadLimiter, requireAuth, (req, res) => {
  templateUploadMw(req, res, async (err) => {
    // A rejected mime yields no file rather than an error, so both are handled.
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({
        success: false,
        error: tooBig ? 'That file is over 10MB. Try a smaller template.' : err.message,
      });
    }
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Upload a .docx template. Other formats (PDF, .doc) do not carry table structure through the import.',
      });
    }

    const tenantId = (req.user && req.user.tenant_id) || null;
    const userId = (req.user && req.user.id) || null;
    const original = req.file.originalname || 'template.docx';
    const name = String(req.body && req.body.name ? req.body.name : original)
      .replace(/\.docx$/i, '')
      .trim()
      .slice(0, 120) || 'Template';

    try {
      const clients = await getClientsForTenant({ tenantId, userId });
      const imported = await importDocxTemplate({
        clients,
        stream: fs.createReadStream(req.file.path),
        name: `Quillio template — ${name}`,
      });

      const id = await saveDocTemplate(tenantId, {
        name,
        source_doc_id: imported.docId,
        source_doc_url: imported.docUrl,
        original_filename: original,
        placeholders: imported.discovery.placeholders,
        created_by: userId,
      });

      return res.status(201).json({
        success: true,
        id,
        name,
        docUrl: imported.docUrl,
        counts: imported.discovery.counts,
        placeholders: imported.discovery.placeholders.map((p) => ({
          ...p,
          where: (p.locations || []).map(describeLocation),
        })),
        // Surfaced, not swallowed: a tenant whose {{Unclosed marker was typo'd
        // needs to see it here rather than discover it when nothing fills in.
        warnings: imported.discovery.warnings.map((w) => ({
          kind: w.kind,
          text: w.text,
          where: describeLocation(w.location),
        })),
      });
    } catch (e) {
      console.error('[settings] template import failed:', e && e.stack ? e.stack : e);
      return res.status(500).json({ success: false, error: clientErrorMessage(e) });
    } finally {
      // The temp file has served its purpose either way.
      fs.unlink(req.file.path, () => {});
    }
  });
});

// GET /api/settings/workspace — current connections for the Workspace tab.
router.get('/api/settings/workspace', requireAuth, async (req, res) => {
  try {
    const userId = (req.user && req.user.id) || null;
    // Pass the acting user so `tokens` reflects THEIR credentials, not whatever
    // the tenant happens to hold — otherwise a second person on a tenant would
    // see their colleague's Google connection reported as their own.
    const { tenant, tokens } = await resolveTenant(req.user && req.user.tenant_id, null, userId);
    // Slack connection status is the LINK, not a bot token — the bot
    // token/workspace_name live on the workspace tenant, which a per-user tenant
    // never resolves to. Gating on the link is what the resolver actually uses.
    // Prefer this user's own link (user_slack_links); fall back to the
    // deprecated tenant-row link for accounts the backfill hasn't moved yet.
    let slackConnected = false;
    if (userId) slackConnected = (await getSlackLinksForUser(userId)).length > 0;
    if (!slackConnected) slackConnected = !!(tenant && tenant.slack_team_id);
    return res.status(200).json({
      success: true,
      defaultFolderUrl: folderUrlFromId(tenant && tenant.default_folder_id),
      // "Connected" is gated on a stored token; show the signed-in email when so.
      googleEmail: tokens && tokens.google ? (req.user && req.user.email) || null : null,
      slackConnected,
      // Kept for backward-compat (workspace-tenant installs still populate it);
      // the frontend now reads slackConnected.
      slackWorkspaceName: tokens && tokens.slack_bot ? (tenant && tenant.workspace_name) || null : null,
    });
  } catch (err) {
    console.error('[settings] GET /workspace failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// POST /api/settings/workspace/folder — save a new default Drive folder.
router.post('/api/settings/workspace/folder', requireAuth, async (req, res) => {
  try {
    const folderId = folderIdFromUrl((req.body || {}).folderUrl);
    await setTenantDefaultFolder(req.user && req.user.tenant_id, folderId);
    return res.status(200).json({ success: true, folderUrl: folderUrlFromId(folderId) });
  } catch (err) {
    console.error('[settings] /workspace/folder failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// POST /api/auth/signout — destroy the session; the client then navigates to
// /onboarding. Not auth-gated so it always succeeds.
router.post('/api/auth/signout', (req, res) => {
  const done = () => res.status(200).json({ success: true });
  if (req.session && typeof req.session.destroy === 'function') {
    req.session.destroy((err) => {
      if (err) console.error('[settings] session destroy failed:', err.message);
      res.clearCookie('connect.sid');
      done();
    });
  } else {
    done();
  }
});

module.exports = router;
