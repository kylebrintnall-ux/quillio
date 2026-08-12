'use strict';

// Onboarding flow (Phase 3 / Week 11). Serves the step-by-step setup page and
// the small JSON API it calls. Every data route is behind requireAuth so it
// runs against the signed-in user's tenant (req.user.tenant_id) — and in demo
// mode (no DATABASE_URL) requireAuth attaches a demo user so this still works.
// Zero Slack imports. All DB writes degrade gracefully without a database.

const path = require('path');
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { voiceLimiter } = require('../middleware/rateLimit');
const { clientErrorMessage } = require('../utils/errors');
const { setTenantDefaultFolder, saveVoiceGuide, getVoiceGuide, setTenantOnboardingComplete } = require('../db');
const { getTenantLibrary, setActiveAssets, setActiveAssetIds } = require('../db/assets');
const { DEFAULT_ASSETS } = require('../data/defaultAssets');
const { generateVoiceGuide } = require('../services/gemini');
const { renderShell } = require('../utils/shellHtml');

const router = express.Router();

// GET /onboarding — the single-file onboarding UI.
const ONBOARDING_HTML = path.join(__dirname, '..', '..', 'public', 'onboarding.html');
router.get('/onboarding', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0'); // never cache the shell (no stale UI)
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  // Read and stamped rather than streamed: sendFile would ship the literal
  // `__BUILD__` in every asset URL, which busts the cache once and never again.
  res.status(200).type('html').send(renderShell(ONBOARDING_HTML));
});

// GET /api/onboarding/me — the signed-in user's display info for Step 2.
router.get('/api/onboarding/me', requireAuth, (req, res) => {
  const u = req.user || {};
  return res.status(200).json({
    success: true,
    email: u.email || null,
    displayName: u.display_name || null,
    avatarUrl: u.avatar_url || null,
  });
});

// GET /api/onboarding/assets — the tenant's asset library grouped by category
// (active flags included) for the Step 3 toggles. NOT auth-gated: the asset
// library isn't sensitive, and the onboarding page must be able to render it
// even before/without a session. Uses the signed-in tenant when present, else
// falls back to the bundled default library.
router.get('/api/onboarding/assets', async (req, res) => {
  try {
    const tenantId = req.user && req.user.tenant_id;
    // getTenantLibrary, not getTenantAssets: the toggles must show the assets a
    // returning tenant has already switched OFF, or the page would render them
    // as on and switch them back on at the next save. It also carries the ids
    // the save posts back.
    let rows = tenantId ? await getTenantLibrary(tenantId) : null; // null without DB
    if (!rows || rows.length === 0) {
      // No DB / unseeded: the bundled library, with no ids — there are no rows to
      // have ids yet. The client falls back to posting names for these.
      rows = DEFAULT_ASSETS.map((a) => ({
        id: null,
        name: a.name,
        group: a.group,
        is_active: a.is_active !== false,
      }));
    }
    const groups = [];
    const byGroup = new Map();
    for (const a of rows) {
      const g = a.group || 'Other';
      if (!byGroup.has(g)) {
        const entry = { group: g, assets: [] };
        byGroup.set(g, entry);
        groups.push(entry);
      }
      // `id` is what the save keys on. `name` stays for display (and for the
      // legacy name-based save a pre-deploy browser will still send).
      byGroup.get(g).assets.push({ id: a.id || null, name: a.name, active: a.is_active !== false });
    }
    return res.status(200).json({ success: true, groups });
  } catch (err) {
    console.error('[onboarding] /assets failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// Pull a Drive folder id out of a pasted folder URL (…/folders/<id> or ?id=<id>).
function folderIdFromUrl(url) {
  const s = String(url || '');
  const m = s.match(/\/folders\/([^/?#]+)/) || s.match(/[?&]id=([^&]+)/);
  return m ? m[1] : (s.trim() || null);
}

// POST /api/onboarding/folder — save the tenant's default Drive folder.
router.post('/api/onboarding/folder', requireAuth, async (req, res) => {
  try {
    const folderId = folderIdFromUrl((req.body || {}).folderUrl);
    await setTenantDefaultFolder(req.user && req.user.tenant_id, folderId);
    return res.status(200).json({ success: true, folderId });
  } catch (err) {
    console.error('[onboarding] /folder failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// POST /api/onboarding/assets — deactivate the given asset types (others active).
//
// Prefers `deactivatedIds`. Ids are stable; names are a value a tenant will soon
// be able to edit, and a toggle keyed on one silently deactivates nothing (or
// the wrong row) if a rename lands between the page loading and the user saving.
//
// `deactivated` (names) is still accepted for the deploy window in which a
// browser that loaded the old script is still open. It resolves names to ids
// through the shared normalizer rather than a raw-text SQL match, so even that
// path no longer misses on a dash or spacing difference.
router.post('/api/onboarding/assets', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const tenantId = req.user && req.user.tenant_id;
    const ids = Array.isArray(body.deactivatedIds) ? body.deactivatedIds : null;
    if (ids) {
      await setActiveAssetIds(tenantId, ids);
      return res.status(200).json({ success: true, deactivatedIds: ids });
    }
    const deactivated = Array.isArray(body.deactivated) ? body.deactivated : [];
    console.log('[onboarding] /assets save via legacy name list — pre-deploy client');
    await setActiveAssets(tenantId, deactivated);
    return res.status(200).json({ success: true, deactivated });
  } catch (err) {
    console.error('[onboarding] /assets save failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// POST /api/onboarding/complete — mark the signed-in user's onboarding done (the
// step-6 finish action). Flips tenants.onboarding_complete = true so sign-in
// routing sends this user to the app next time. Best-effort/no-DB safe.
router.post('/api/onboarding/complete', requireAuth, async (req, res) => {
  try {
    await setTenantOnboardingComplete(req.user && req.user.tenant_id);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[onboarding] /complete failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// GET /api/onboarding/voice — the tenant's saved voice guide, or null. Lets
// Step 4 show the existing guide (with edit/regenerate) for a returning user.
router.get('/api/onboarding/voice', requireAuth, async (req, res) => {
  try {
    const markdown = await getVoiceGuide(req.user && req.user.tenant_id);
    return res.status(200).json({ success: true, voiceMarkdown: markdown || null });
  } catch (err) {
    console.error('[onboarding] GET /voice failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// POST /api/onboarding/voice — dual mode:
//   { answers: {...} } → generate a voice guide via Gemini, save it, return it.
//   { markdown: "..." } → save the user's edited markdown (the inline-edit path).
router.post('/api/onboarding/voice', voiceLimiter, requireAuth, async (req, res) => {
  const body = req.body || {};
  const tenantId = req.user && req.user.tenant_id;
  try {
    let markdown;
    let mode;
    // `answers` present → generate (or regenerate with `direction`). Otherwise a
    // bare `markdown` is the user's edited text being saved as-is.
    if (body.answers) {
      const a = body.answers || {};
      mode = body.direction ? 'regenerate' : 'generate';
      markdown = await generateVoiceGuide({
        brandPersonality: a.brandPersonality,
        toneGuidance: a.toneGuidance,
        audienceLanguage: a.audienceLanguage,
        wordsToUse: a.wordsToUse,
        wordsToAvoid: a.wordsToAvoid,
        toneReference: a.toneReference,
        direction: body.direction,
        previousGuide: body.previousGuide,
      });
    } else if (typeof body.markdown === 'string' && body.markdown.trim()) {
      mode = 'save';
      markdown = body.markdown;
    } else {
      return res.status(400).json({ success: false, error: 'answers or markdown required' });
    }
    // Persist (best-effort — no-ops without a DB).
    try {
      await saveVoiceGuide(tenantId, markdown);
    } catch (e) {
      console.error('[onboarding] voice save failed (continuing):', e.message);
    }
    // Confirm what's going back to the client (length only — not the full body).
    console.log(
      `[onboarding] POST /voice → mode=${mode} returning voiceMarkdown length=${(markdown || '').length}`
    );
    return res.status(200).json({ success: true, voiceMarkdown: markdown });
  } catch (err) {
    console.error('[onboarding] /voice failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

module.exports = router;
