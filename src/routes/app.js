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
const { getProjects, getProject, setProjectStatus } = require('../db/projects');
const { runWebBrief, runWebDraft, runWebProjectContent } = require('../adapters/web');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// The demo tenant — used when a request doesn't carry a workspace id.
const DEFAULT_WORKSPACE_ID = 'T0B8LPRDKHR';

// GET /app — the single-file web UI (HTML + CSS + vanilla JS). Static asset,
// no templating: the page talks to /api/brief and /api/draft itself.
const APP_HTML = path.join(__dirname, '..', '..', 'public', 'app.html');
router.get('/app', requireAuth, (req, res) => {
  res.status(200).sendFile(APP_HTML);
});

// POST /api/brief — run a brief through the pipeline, return structured data.
// A large brief (4+ assets with references) runs well past a minute, so disable
// the per-request socket idle timeout — the response is long-running but
// healthy, and we don't want Node (or an upstream proxy) to close it early.
router.post('/api/brief', async (req, res) => {
  if (req.socket && typeof req.setTimeout === 'function') req.setTimeout(0);
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
  const direction = (body.direction || '').trim(); // optional regenerate feedback
  const workspaceId = body.workspaceId || DEFAULT_WORKSPACE_ID;

  if (!docId) {
    return res.status(400).json({ success: false, error: 'docId is required' });
  }

  const startedAt = Date.now();
  const mode = direction ? `regenerate (${direction.length} chars)` : 'first draft';
  console.log(`[web] /api/draft start → doc=${docId} workspace=${workspaceId} mode=${mode}`);
  try {
    const tenantContext = await resolveTenant(workspaceId);
    const out = await runWebDraft(docId, tenantContext, direction);
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[web] /api/draft done → doc=${docId} workspace=${workspaceId} fields=${out.fieldCount} in ${secs}s`);
    return res.status(200).json({ success: true, docId: out.docId, fieldCount: out.fieldCount });
  } catch (err) {
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.error(`[web] /api/draft failed → doc=${docId} after ${secs}s:`, err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Project status lifecycle (Week 12). Closed projects are hidden by default but
// never deleted.
const VALID_STATUSES = ['not_started', 'in_progress', 'finished', 'closed'];

// GET /api/projects — the tenant's projects, newest first. Closed are hidden
// unless ?include_closed=true. Without a DB this resolves to [].
router.get('/api/projects', requireAuth, async (req, res) => {
  const workspaceId = req.query.workspaceId || DEFAULT_WORKSPACE_ID;
  const includeClosed = req.query.include_closed === 'true';
  try {
    const { tenant } = await resolveTenant(workspaceId);
    const projects = await getProjects(tenant && tenant.id, includeClosed);
    return res.status(200).json({ success: true, projects });
  } catch (err) {
    console.error('[web] /api/projects failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/projects/:id/status — update a project's status. Degrades
// gracefully: returns success even without a DB (no row to persist) so the
// optimistic UI stays consistent. Invalid statuses are rejected.
router.patch('/api/projects/:id/status', requireAuth, async (req, res) => {
  const workspaceId = req.query.workspaceId || DEFAULT_WORKSPACE_ID;
  const status = (req.body || {}).status;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, error: 'Invalid status' });
  }
  try {
    const { tenant } = await resolveTenant(workspaceId);
    await setProjectStatus(tenant && tenant.id, req.params.id, status);
    return res.status(200).json({ success: true, status });
  } catch (err) {
    console.error('[web] PATCH /api/projects/:id/status failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/projects/:id — a single project, scoped to its tenant.
router.get('/api/projects/:id', requireAuth, async (req, res) => {
  const workspaceId = req.query.workspaceId || DEFAULT_WORKSPACE_ID;
  try {
    const { tenant } = await resolveTenant(workspaceId);
    const project = await getProject(tenant && tenant.id, req.params.id);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found' });
    return res.status(200).json({ success: true, project });
  } catch (err) {
    console.error('[web] /api/projects/:id failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/projects/:id/content — the project's doc content, parsed into
// sections + per-field copy. A Docs read failure returns { success:false } so
// the UI can fall back to "Content unavailable" + Open in Drive.
router.get('/api/projects/:id/content', requireAuth, async (req, res) => {
  const workspaceId = req.query.workspaceId || DEFAULT_WORKSPACE_ID;
  try {
    const { tenant } = await resolveTenant(workspaceId);
    const project = await getProject(tenant && tenant.id, req.params.id);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found' });
    if (!project.copy_doc_id) {
      return res.status(200).json({ success: false, error: 'No document for this project' });
    }
    const content = await runWebProjectContent(project.copy_doc_id);
    return res.status(200).json({ success: true, content });
  } catch (err) {
    console.error('[web] /api/projects/:id/content failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
