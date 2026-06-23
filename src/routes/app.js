'use strict';

// Web app routes (Phase 3 / Week 8). Serves the (placeholder) browser UI and
// the JSON API that runs the pipeline via the web adapter. Intentionally has
// ZERO Slack imports — this is the non-Slack product surface. All tenant
// resolution degrades gracefully when DATABASE_URL is unset (env fallback), and
// errors return a clean { success:false, error } — stack traces are logged
// server-side only, never sent to the browser.

const express = require('express');
const { resolveTenant } = require('../db');
const { runWebBrief, runWebDraft } = require('../adapters/web');

const router = express.Router();

// The demo tenant — used when a request doesn't carry a workspace id.
const DEFAULT_WORKSPACE_ID = 'T0B8LPRDKHR';

// GET /app — placeholder shell. The real brief form lands in a later week.
router.get('/app', (req, res) => {
  res
    .status(200)
    .type('html')
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Quillio</title></head>` +
        `<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem;">` +
        `<h1>Quillio Web App — coming soon</h1>` +
        `</body></html>`
    );
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
router.post('/api/draft', async (req, res) => {
  const body = req.body || {};
  const docId = (body.docId || '').trim();
  const workspaceId = body.workspaceId || DEFAULT_WORKSPACE_ID;

  if (!docId) {
    return res.status(400).json({ success: false, error: 'docId is required' });
  }

  try {
    const tenantContext = await resolveTenant(workspaceId);
    const out = await runWebDraft(docId, tenantContext);
    return res.status(200).json({ success: true, docId: out.docId });
  } catch (err) {
    console.error('[web] /api/draft failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
