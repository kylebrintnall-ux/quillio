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
const {
  resolveTenant,
  getVoiceGuide,
  saveVoiceGuide,
  setTenantDefaultFolder,
} = require('../db');
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
  res.status(200).sendFile(SETTINGS_HTML);
});

// GET /api/settings/voice — the tenant's saved voice guide (or null).
router.get('/api/settings/voice', requireAuth, async (req, res) => {
  try {
    const markdown = await getVoiceGuide(req.user && req.user.tenant_id);
    return res.status(200).json({ success: true, voiceMarkdown: markdown || null });
  } catch (err) {
    console.error('[settings] GET /voice failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: err.message });
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
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/settings/voice/generate — six answers (+ optional direction) →
// Gemini → save → return the new markdown.
router.post('/api/settings/voice/generate', requireAuth, async (req, res) => {
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
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/settings/workspace — current connections for the Workspace tab.
router.get('/api/settings/workspace', requireAuth, async (req, res) => {
  try {
    const { tenant, tokens } = await resolveTenant(req.user && req.user.tenant_id);
    return res.status(200).json({
      success: true,
      defaultFolderUrl: folderUrlFromId(tenant && tenant.default_folder_id),
      // "Connected" is gated on a stored token; show the signed-in email when so.
      googleEmail: tokens && tokens.google ? (req.user && req.user.email) || null : null,
      slackWorkspaceName: tokens && tokens.slack_bot ? (tenant && tenant.workspace_name) || null : null,
    });
  } catch (err) {
    console.error('[settings] GET /workspace failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: err.message });
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
    return res.status(500).json({ success: false, error: err.message });
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
