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
const { setTenantDefaultFolder, saveVoiceGuide, getVoiceGuide } = require('../db');
const { getTenantAssets, setActiveAssets } = require('../db/assets');
const { DEFAULT_ASSETS } = require('../data/defaultAssets');
const { generateVoiceGuide } = require('../services/gemini');

const router = express.Router();

// GET /onboarding — the single-file onboarding UI.
const ONBOARDING_HTML = path.join(__dirname, '..', '..', 'public', 'onboarding.html');
router.get('/onboarding', (req, res) => {
  res.status(200).sendFile(ONBOARDING_HTML);
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
    let rows = tenantId ? await getTenantAssets(tenantId) : null; // null without DB / unseeded
    if (!rows) {
      rows = DEFAULT_ASSETS.map((a) => ({ name: a.name, group: a.group, is_active: a.is_active !== false }));
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
      byGroup.get(g).assets.push({ name: a.name, active: a.is_active !== false });
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

// POST /api/onboarding/assets — deactivate the named asset types (others active).
router.post('/api/onboarding/assets', requireAuth, async (req, res) => {
  try {
    const deactivated = Array.isArray((req.body || {}).deactivated) ? req.body.deactivated : [];
    await setActiveAssets(req.user && req.user.tenant_id, deactivated);
    return res.status(200).json({ success: true, deactivated });
  } catch (err) {
    console.error('[onboarding] /assets save failed:', err && err.stack ? err.stack : err);
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
