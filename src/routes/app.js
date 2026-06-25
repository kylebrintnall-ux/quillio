'use strict';

// Web app routes (Phase 3 / Week 8). Serves the (placeholder) browser UI and
// the JSON API that runs the pipeline via the web adapter. Intentionally has
// ZERO Slack imports — this is the non-Slack product surface. All tenant
// resolution degrades gracefully when DATABASE_URL is unset (env fallback), and
// errors return a clean { success:false, error } — stack traces are logged
// server-side only, never sent to the browser.

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { resolveTenant } = require('../db');
const { getProjects, getProject, setProjectStatus } = require('../db/projects');
const { runWebBrief, runWebDraft, runWebProjectContent } = require('../adapters/web');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// The demo tenant — used when a request doesn't carry a workspace id.
const DEFAULT_WORKSPACE_ID = 'T0B8LPRDKHR';

// In-memory async job store (Week 12). Brief runs (~30-90s) and draft runs
// (~1 min) both outlast Railway's edge proxy, which closes a connection held
// open with no response bytes — so instead of one long-awaited POST we start a
// job and let the client poll its status. Shared by /api/brief and /api/draft.
// Single-instance only (fine here); a multi-instance deploy would need a shared
// store. Jobs are swept after a TTL so the Map can't grow unbounded.
const JOBS = new Map(); // jobId -> { status, result, error, ts }
const JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes

function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    if (now - job.ts > JOB_TTL_MS) JOBS.delete(id);
  }
}

// Start a job: register it as pending, run `work()` fire-and-forget, and record
// its result/error on settle. Returns the new jobId. `label` is for logs only.
function startJob(label, work) {
  sweepJobs();
  const jobId = crypto.randomUUID();
  JOBS.set(jobId, { status: 'pending', result: null, error: null, ts: Date.now() });
  const startedAt = Date.now();
  (async () => {
    try {
      const result = await work();
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`[web] job done → ${label} job=${jobId} in ${secs}s`);
      JOBS.set(jobId, { status: 'complete', result, error: null, ts: Date.now() });
    } catch (err) {
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.error(`[web] job failed → ${label} job=${jobId} after ${secs}s:`, err && err.stack ? err.stack : err);
      JOBS.set(jobId, { status: 'failed', result: null, error: err.message, ts: Date.now() });
    }
  })();
  return jobId;
}

// Shared poll handler for a job's status route. Unknown id → 404 (job expired
// or the server restarted; clients fall back as appropriate).
function sendJobStatus(req, res) {
  const job = JOBS.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, status: 'failed', error: 'Unknown or expired job' });
  }
  return res.status(200).json({ success: true, status: job.status, result: job.result, error: job.error });
}

// GET /app — the single-file web UI (HTML + CSS + vanilla JS). Static asset,
// no templating: the page talks to /api/brief and /api/draft itself.
const APP_HTML = path.join(__dirname, '..', '..', 'public', 'app.html');
router.get('/app', requireAuth, (req, res) => {
  res.status(200).sendFile(APP_HTML);
});

// POST /api/brief — START a brief run and return a job id immediately. The work
// (~30-90s) runs fire-and-forget; the client polls the status endpoint below.
// This avoids holding a long request open, which Railway's proxy closes.
router.post('/api/brief', (req, res) => {
  const body = req.body || {};
  const briefText = (body.briefText || '').trim();
  const workspaceId = body.workspaceId || DEFAULT_WORKSPACE_ID;

  if (!briefText) {
    return res.status(400).json({ success: false, error: 'briefText is required' });
  }

  const jobId = startJob(`brief workspace=${workspaceId}`, async () => {
    const tenantContext = await resolveTenant(workspaceId);
    return runWebBrief(briefText, tenantContext); // the full { docUrl, assetBlocks, … }
  });
  console.log(`[web] /api/brief start → job=${jobId} workspace=${workspaceId}`);
  return res.status(202).json({ success: true, jobId });
});

// GET /api/brief/:jobId/status — poll a brief job. On complete, `result` is the
// same structured payload the old synchronous endpoint returned.
router.get('/api/brief/:jobId/status', sendJobStatus);

// POST /api/draft — START draft generation and return a job id immediately.
// The work (~1 min) runs fire-and-forget; the client polls the status endpoint
// below. This avoids holding a long request open, which Railway's proxy closes.
router.post('/api/draft', (req, res) => {
  const body = req.body || {};
  const docId = (body.docId || '').trim();
  const direction = (body.direction || '').trim(); // optional regenerate feedback
  const workspaceId = body.workspaceId || DEFAULT_WORKSPACE_ID;

  if (!docId) {
    return res.status(400).json({ success: false, error: 'docId is required' });
  }

  const mode = direction ? `regenerate (${direction.length} chars)` : 'first draft';
  const jobId = startJob(`draft doc=${docId} ${mode}`, async () => {
    const tenantContext = await resolveTenant(workspaceId);
    const out = await runWebDraft(docId, tenantContext, direction);
    return { docId: out.docId, fieldCount: out.fieldCount };
  });
  console.log(`[web] /api/draft start → job=${jobId} doc=${docId} workspace=${workspaceId} mode=${mode}`);
  return res.status(202).json({ success: true, jobId });
});

// GET /api/draft/:jobId/status — poll a draft job. Unknown id → 404 (e.g. the
// job expired or the server restarted; the client falls back to reading the doc).
router.get('/api/draft/:jobId/status', sendJobStatus);

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
