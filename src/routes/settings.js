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
  isTenantEditableTier,
} = require('../db/assets');
const {
  normalizeNewAsset,
  normalizeAssetEdit,
  normalizeHouseDefaults,
  MAX_FIELDS_PER_ASSET,
  MAX_ASSETS_PER_TENANT,
} = require('../utils/assetInput');
// Same fold the unique index uses, so "renamed" here means what Postgres means.
const { normalize } = require('../utils/normalize');
const { generateVoiceGuide } = require('../services/gemini');
const {
  listDocTemplates,
  saveDocTemplate,
  getDocTemplate,
  renameDocTemplate,
} = require('../db/docTemplates');
const { importDocxTemplate, DOCX_MIME } = require('../destinations/docTemplateImport');
const { describeLocation, discoverPlaceholders } = require('../destinations/docPlaceholders');
const { deriveTemplateFields } = require('../destinations/templateTableReader');
const {
  listTemplateMarkers,
  saveTemplateMarkers,
  seedTemplateMarkers,
} = require('../db/templateMarkers');
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

router.get('/api/settings/library', settingsReadLimiter, requireAuth, async (req, res) => {
  try {
    const tenantId = (req.user && req.user.tenant_id) || null;
    const assets = await getTenantLibrary(tenantId);
    if (assets === null) {
      // No DB / no tenant. Distinct from an empty library, and the UI says so.
      return res.status(200).json({ success: true, available: false, assets: [] });
    }
    // Templates come along so the panel can list them. They are no longer
    // ATTACHED to anything — a brief names a template directly — so there is no
    // per-asset mapping summary to compute. null when the table is not there yet.
    const templates = await listDocTemplates(tenantId);

    // `editable` is derived, not stored — see db/assets.isSeededAssetName. It is
    // sent so the UI can show the right affordance, and it is ALSO enforced
    // server-side in updateAssetType against the stored row, because a flag in a
    // response the client can ignore is a hint, not a rule.
    //
    // TWO AXES NOW, because a seeded asset is no longer uniformly read-only:
    //   editable        — the whole asset: name, field list, tiers. Tenant-authored only.
    //   fields[].editable — this FIELD's char_min/char_max/spec_note. True on every
    //                     field of a tenant asset, and on the house_default fields
    //                     of a seeded one, which is the change.
    //   houseEditable   — does this seeded asset have any such field? Drives whether
    //                     the card offers an Edit button at all; a bundled asset
    //                     that is all enforced has nothing for a tenant to set.
    // Per field rather than per asset because the seeded assets are MIXED — the
    // paid-social ones carry three house defaults beside their platform limits.
    const decorated = assets.map((a) => {
      const editable = !isSeededAssetName(a.name);
      const fields = a.fields.map((f) => ({
        ...f,
        editable: editable || isTenantEditableTier(f.spec_type),
      }));
      return {
        ...a,
        editable,
        fields,
        houseEditable: !editable && fields.some((f) => f.editable),
      };
    });
    return res.status(200).json({
      success: true,
      available: true,
      assets: decorated,
      templates: (templates || []).map((t) => ({ id: t.id, name: t.name, markers: (t.placeholders || []).length })),
      counts: {
        assets: assets.length,
        active: assets.filter((a) => a.is_active).length,
        fields: assets.reduce((n, a) => n + a.fields.length, 0),
        // UNCHANGED MEANING: assets the tenant can edit outright. A second count
        // carries the new state rather than this one widening — a client holding
        // the old script reads `editable` to mean "has an Edit button that opens
        // the full form", and quietly making it mean something adjacent is how a
        // stale tab shows a number that is wrong in a way nobody can see.
        editable: assets.filter((a) => !isSeededAssetName(a.name)).length,
        // Bundled assets with at least one house_default field — reduced mode.
        houseEditable: decorated.filter((a) => a.houseEditable).length,
        attached: decorated.filter((a) => a.mapping).length,
        incomplete: decorated.filter((a) => a.mapping && !a.mapping.complete).length,
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
// ONE ROUTE, TWO SHAPES, chosen from the STORED row. A tenant-authored asset
// takes the full edit described above. A SEEDED asset takes the reduced
// house-default submission — { fields: [{ id, char_min?, char_max?, spec_note?,
// reset? }] } — and nothing else about it can be touched. Same endpoint because
// it is the same act from the tenant's side (open the card, change a number,
// save); a second route would mean a second Save button for a difference that is
// the server's business, not theirs.
//
// Three refusals, all decided from the STORED row rather than the request:
//   • not this tenant's asset → 404 (never 403; a 403 would confirm the id exists)
//   • a SEEDED asset with no house_default field → 403, with the reason said out loud
//   • a name another asset already holds → 409 from the unique index
//
// The seeded restriction is the one that matters, and it is NARROWED here, not
// removed. services/specReview.js updates copy_fields by asset NAME with no
// tenant filter, so a renamed seeded asset silently stops receiving
// platform-limit updates while its doc keeps rendering "Platform limit
// (LinkedIn)" beside a stale number with a live citation link. That is a fact
// about the asset's NAME and its FIELD LIST, which is why those stay locked —
// and it says nothing about a house_default number, which no platform publishes
// and LiveSpecs has no business writing. The tenant's value also lands in an
// OVERRIDE column, so the cross-tenant writer keeps its base row and cannot
// collide with them either way.
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
    // THE SEEDED BRANCH. Decided here from the stored row so the message can name
    // the asset; updateAssetType re-decides it from the row it LOCKS, which is
    // the authority — this read and that write are separate moments.
    if (isSeededAssetName(current.name)) {
      const settable = current.fields.filter((f) => isTenantEditableTier(f.spec_type));
      // A bundled asset whose every field is a platform limit has nothing here
      // for a tenant to set, and the old refusal is still exactly right for it.
      if (settable.length === 0) {
        return res.status(403).json({
          success: false,
          error: `"${current.name}" is one of Quillio's built-in asset types, and every one of its fields tracks a platform limit — so it can only be switched on or off. Copy it into an asset type of your own to change it.`,
        });
      }

      const house = normalizeHouseDefaults(req.body);
      if (house.errors.length > 0) {
        return res.status(400).json({ success: false, error: house.errors[0], errors: house.errors });
      }

      const hResult = await updateAssetType(tenantId, assetId, { fields: house.fields }, {
        mode: 'houseDefaultsOnly',
      });
      if (!hResult.ok && hResult.reason === 'not_seeded') {
        // The stored row changed between the read above and the lock — somebody
        // renamed the asset out of the bundled set mid-request. Not an error to
        // explain in product terms; ask for the save again against what is there
        // now, rather than applying a reduced edit to an asset that is no longer
        // the one the form was built from.
        return res.status(409).json({
          success: false,
          error: 'This asset type changed while you were editing it. Reload and try again.',
        });
      }
      if (!hResult.ok) {
        return res.status(404).json({ success: false, error: 'Asset not found.' });
      }

      const afterH = (await getTenantLibrary(tenantId)) || [];
      const h = hResult.houseDefaults || {};
      console.log(
        `[settings] tenant ${tenantId} set house defaults on seeded asset ${assetId} ` +
          `(${h.changed || 0} changed, ${h.cleared || 0} reset, ${h.locked || 0} locked)`
      );
      return res.status(200).json({
        success: true,
        id: assetId,
        mode: 'houseDefaults',
        // Said back because the form posts every row it rendered, including the
        // enforced ones it disabled. A count of what was NOT applied is how the
        // client can tell "saved" from "saved, and quietly ignored half of it".
        applied: { changed: h.changed || 0, reset: h.cleared || 0, locked: h.locked || 0 },
        counts: {
          assets: afterH.length,
          active: afterH.filter((a) => a.is_active).length,
          fields: afterH.reduce((n, a) => n + a.fields.length, 0),
        },
        limits: { fieldsPerAsset: MAX_FIELDS_PER_ASSET, assetsPerTenant: MAX_ASSETS_PER_TENANT },
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

      // Seed the confirm screen with what the reader proposed. Best-effort and
      // never overwriting: the document imported fine either way, and a template
      // re-uploaded over one the tenant has already confirmed keeps their
      // answers (ON CONFLICT DO NOTHING).
      if (id) await seedTemplateMarkers(id, imported.derived || []);

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

// POST /api/settings/templates/:id — rename ONE template (custom document
// types, STEP TWO). The display name only.
//
// The upload names a template after the file it came from, which is how a
// settings panel ends up reading "copy-matrix-template-v4-FINAL". Nothing else
// about a template is writable: the imported Doc, the discovered markers and
// every mapping key off the id, so a rename moves no ground.
router.post('/api/settings/templates/:id', settingsWriteLimiter, requireAuth, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!/^\d+$/.test(id)) return res.status(400).json({ success: false, error: 'A valid template id is required.' });
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ success: false, error: 'Give the template a name.' });
  if (name.length > 120) return res.status(400).json({ success: false, error: 'Keep the name under 120 characters.' });
  try {
    const tenantId = (req.user && req.user.tenant_id) || null;
    const ok = await renameDocTemplate(tenantId, id, name);
    // False covers "no such template" and "not yours" alike — answering
    // differently would confirm an id in someone else's account.
    if (!ok) return res.status(404).json({ success: false, error: 'Template not found.' });
    return res.status(200).json({ success: true, id, name });
  } catch (err) {
    console.error('[settings] POST /templates/:id failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// THE ATTACH/MAP ROUTES ARE GONE (rework step four).
//
// POST /api/settings/library/asset/:id/template attached an asset type to a
// template; POST /api/settings/library/asset/:id/markers mapped that asset's
// fields to the template's markers. Both are deleted, with the auto-matcher
// (destinations/markerMatch.js) they existed to propose from.
//
// They put an ASSET TYPE in the middle of something that never needed one, and
// the cost was concrete: an attached asset rendered in the copy doc AND filled
// the matrix, so form and confirmation copy came out in both documents from one
// brief. A brief now NAMES the template, and the template's own fields
// (template_markers, confirmed on upload) are drafted straight into its cells.
//
// The columns those routes wrote — asset_types.doc_template_id,
// copy_fields.template_marker_key/name — are deliberately still in the schema
// and are read by nothing. Dropping them is a separate, irreversible migration
// and is not worth doing in the commit that stops using them.

// --- The confirm screen (document templates, REWORK step one) ----------------
//
// On upload Quillio reads the template's tables and proposes, per marker, a
// field name and a limit. These two routes are where the tenant sees that and
// corrects it. NOTHING ELSE READS template_markers — the build, draft and review
// paths do not know it exists. This step is deliberately inert.

// GET /api/settings/templates/:id/markers — the proposed (or confirmed) fields.
router.get('/api/settings/templates/:id/markers', settingsReadLimiter, requireAuth, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!/^\d+$/.test(id)) return res.status(400).json({ success: false, error: 'A valid template id is required.' });
  try {
    const tenantId = (req.user && req.user.tenant_id) || null;
    // Ownership first: a template that is not this tenant's is a 404 before the
    // markers are read, so a foreign id never reaches a second query.
    const tpl = await getDocTemplate(tenantId, id);
    if (!tpl) return res.status(404).json({ success: false, error: 'Template not found.' });

    const markers = await listTemplateMarkers(tenantId, id);
    if (markers === null) {
      // No DB, or the migration has not run here yet. Distinct from "none
      // found", and the UI says so rather than showing an empty list.
      return res.status(200).json({ success: true, available: false, markers: [] });
    }
    return res.status(200).json({
      success: true,
      available: true,
      templateName: tpl.name,
      markers: markers.map((m) => ({
        ...m,
        // `where` is rendered server-side, exactly as the placeholder list is,
        // so the two halves of this panel describe a cell the same way.
        where: m.part
          ? describeLocation({
              part: m.part,
              kind: m.table_index == null ? 'paragraph' : 'table',
              tableIndex: m.table_index,
              row: m.row_index,
              column: m.column_index,
              rowSpan: m.row_span,
              columnSpan: m.column_span,
              index: m.row_index,
            })
          : null,
      })),
      counts: {
        markers: markers.length,
        copy: markers.filter((m) => m.is_copy).length,
        limited: markers.filter((m) => m.is_copy && m.char_max > 0).length,
      },
    });
  } catch (err) {
    console.error('[settings] GET /templates/:id/markers failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// POST /api/settings/templates/:id/markers { markers: [...] } — the tenant's
// confirmed answers. Upserted by marker key, so a later re-upload of the same
// template keeps them.
//
// The POSITION is never taken from the browser (see db/templateMarkers) — it
// comes from reading the document. A screen that could move a marker to a
// different cell would be a way to point a field at the wrong column with no way
// to notice.
router.post('/api/settings/templates/:id/markers', settingsWriteLimiter, requireAuth, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!/^\d+$/.test(id)) return res.status(400).json({ success: false, error: 'A valid template id is required.' });
  const markers = (req.body && req.body.markers) || null;
  if (!Array.isArray(markers)) return res.status(400).json({ success: false, error: 'A marker list is required.' });
  if (markers.length > 500) return res.status(400).json({ success: false, error: 'That is more markers than a template can have.' });
  try {
    const tenantId = (req.user && req.user.tenant_id) || null;
    // Built key by key, never spread. Only these seven are writable; everything
    // else on the row — the position, the label hint — is the document's.
    const clean = markers.map((m, i) => ({
      marker_key: m && m.marker_key != null ? String(m.marker_key) : '',
      marker_name: m && m.marker_name != null ? String(m.marker_name) : '',
      is_copy: m ? m.is_copy === true : false,
      char_min: m ? m.char_min : 0,
      char_max: m ? m.char_max : 0,
      field_type: m && m.field_type === 'words' ? 'words' : 'text',
      spec_note: m && m.spec_note ? String(m.spec_note) : null,
      sort_order: i,
    }));
    const result = await saveTemplateMarkers(tenantId, id, clean);
    if (!result.ok) {
      if (result.reason === 'unavailable') {
        return res.status(409).json({ success: false, error: 'Template fields need a database connection. Nothing was saved.' });
      }
      return res.status(404).json({ success: false, error: 'Template not found.' });
    }
    return res.status(200).json({ success: true, id, saved: result.saved });
  } catch (err) {
    console.error('[settings] POST /templates/:id/markers failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
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
