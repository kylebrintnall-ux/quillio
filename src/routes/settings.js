'use strict';

// Settings page + API (Phase 3 / Week 12). Serves the settings UI and the JSON
// it calls to view/edit the tenant's voice guide, workspace connections, and
// account. Every data route is behind requireAuth so it runs against the
// signed-in user's tenant (req.user.tenant_id); in demo mode (no DATABASE_URL)
// requireAuth attaches a demo user so this still works. All DB ops degrade
// gracefully. Never logs voice guide content or tokens.

const path = require('path');
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { voiceLimiter, settingsReadLimiter, settingsWriteLimiter } = require('../middleware/rateLimit');
const { clientErrorMessage } = require('../utils/errors');
const {
  resolveTenant,
  getVoiceGuide,
  saveVoiceGuide,
  setTenantDefaultFolder,
} = require('../db');
const { getSlackLinksForUser } = require('../db/users');
const { getTenantLibrary, setActiveAssetIds } = require('../db/assets');
const { generateVoiceGuide } = require('../services/gemini');

const router = express.Router();

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
    return res.status(200).json({
      success: true,
      available: true,
      assets,
      counts: {
        assets: assets.length,
        active: assets.filter((a) => a.is_active).length,
        fields: assets.reduce((n, a) => n + a.fields.length, 0),
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
