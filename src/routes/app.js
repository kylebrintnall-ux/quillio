'use strict';

// Web app routes (Phase 3 / Week 8). Serves the (placeholder) browser UI and
// the JSON API that runs the pipeline via the web adapter. Intentionally has
// ZERO Slack imports — this is the non-Slack product surface. All tenant
// resolution degrades gracefully when DATABASE_URL is unset (env fallback), and
// errors return a clean { success:false, error } — stack traces are logged
// server-side only, never sent to the browser.

const path = require('path');
const express = require('express');
const { resolveTenant } = require('../db');
const { runWebBrief, runWebDraft } = require('../adapters/web');

const router = express.Router();

// The demo tenant — used when a request doesn't carry a workspace id.
const DEFAULT_WORKSPACE_ID = 'T0B8LPRDKHR';

// GET /app — the single-file web UI (HTML + CSS + vanilla JS). Static asset,
// no templating: the page talks to /api/brief and /api/draft itself.
const APP_HTML = path.join(__dirname, '..', '..', 'public', 'app.html');
router.get('/app', (req, res) => {
  res.status(200).sendFile(APP_HTML);
});

// POST /api/brief — run a brief through the pipeline, return structured data.
router.post('/api/brief', async (req, res) => {
  const body = req.body || {};
  const briefText = (body.briefText || '').trim();
  const workspaceId = body.workspaceId || DEFAULT_WORKSPACE_ID;

  if (!briefText) {
    return res.status(400).json({ success: false, error: 'briefText is required' });
  }

  try {
    const tenantContext = await resolveTenant(workspaceId);
    const out = await runWebBrief(briefText, tenantContext);
    return res.status(200).json({ success: true, ...out });
  } catch (err) {
    console.error('[web] /api/brief failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/draft — generate the first draft for an existing doc.
// Draft generation calls Gemini per field and takes 60-90s, so disable the
// per-request socket idle timeout: the response is long-running but healthy,
// and we don't want Node (or an upstream proxy honoring it) to close it early.
router.post('/api/draft', async (req, res) => {
  if (req.socket && typeof req.setTimeout === 'function') req.setTimeout(0);
  const body = req.body || {};
  const docId = (body.docId || '').trim();
  const workspaceId = body.workspaceId || DEFAULT_WORKSPACE_ID;

  if (!docId) {
    return res.status(400).json({ success: false, error: 'docId is required' });
  }

  try {
    const tenantContext = await resolveTenant(workspaceId);
    const out = await runWebDraft(docId, tenantContext);
    return res.status(200).json({ success: true, docId: out.docId, fieldCount: out.fieldCount });
  } catch (err) {
    console.error('[web] /api/draft failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
