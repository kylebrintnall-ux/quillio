'use strict';

// Web app routes (Phase 3 / Week 8). Serves the (placeholder) browser UI and
// the JSON API that runs the pipeline via the web adapter. Intentionally has
// ZERO Slack imports — this is the non-Slack product surface. All tenant
// resolution degrades gracefully when DATABASE_URL is unset (env fallback), and
// errors return a clean { success:false, error } — stack traces are logged
// server-side only, never sent to the browser.

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { resolveTenant } = require('../db');
const { getProjects, getProject, setProjectStatus } = require('../db/projects');
const { runWebBrief, runWebDraft, runWebProjectContent, runWebReview } = require('../adapters/web');
const { requireAuth } = require('../middleware/auth');
const { briefLimiter, draftLimiter, uploadLimiter } = require('../middleware/rateLimit');
const { clientErrorMessage } = require('../utils/errors');

const router = express.Router();

// The demo tenant — used when a request doesn't carry a workspace id.
const DEFAULT_WORKSPACE_ID = 'T0B8LPRDKHR';

// --- File attachment uploads (Phase 3 additions) ---
// Brief reference files are uploaded to /api/upload, stored in the OS temp dir,
// and their paths handed to /api/brief. Caps: 10MB per file, 3 files max; only
// PDF / DOCX / JPG / PNG accepted. The pipeline deletes the temp files after
// ingestion.
const ALLOWED_UPLOAD_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
]);
const uploadMw = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 10 * 1024 * 1024, files: 3 },
  fileFilter: (req, file, cb) => {
    const ok =
      ALLOWED_UPLOAD_MIME.has(file.mimetype) || /\.(pdf|docx|jpe?g|png)$/i.test(file.originalname);
    cb(null, ok);
  },
}).array('files', 3);

// /api/brief is open and `fileRefs` arrives in the client JSON body, so paths are
// attacker-controlled. Only honor paths that resolve INSIDE the temp dir (where
// /api/upload writes), preventing path traversal / arbitrary file reads
// (e.g. {path:'/etc/passwd'}). Caps to 3 and re-stringifies the metadata.
const TMP_PREFIX = path.resolve(os.tmpdir());
function safeFileRefs(refs) {
  if (!Array.isArray(refs)) return [];
  return refs
    .filter((f) => f && typeof f.path === 'string')
    .filter((f) => {
      const p = path.resolve(f.path);
      return p === TMP_PREFIX || p.startsWith(TMP_PREFIX + path.sep);
    })
    .slice(0, 3)
    .map((f) => ({
      path: f.path,
      filename: String(f.filename || 'attachment'),
      mimetype: String(f.mimetype || ''),
    }));
}

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

// POST /api/upload — accept brief reference files (multipart form-data) and
// stash them in the temp dir. Returns { fileRefs: [{ path, filename, mimetype }] }
// for the client to pass into /api/brief. Requires a session (audit HIGH 1) so
// unauthenticated callers can't write temp files / fill the disk. Multer errors
// (too big / too many) return a clean 400 rather than crashing.
router.post('/api/upload', uploadLimiter, requireAuth, (req, res) => {
  uploadMw(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    const fileRefs = (req.files || []).map((f) => ({
      path: f.path,
      filename: f.originalname,
      mimetype: f.mimetype,
    }));
    console.log(`[web] /api/upload received ${fileRefs.length} file(s)`);
    return res.status(200).json({ success: true, fileRefs });
  });
});

// POST /api/brief — START a brief run and return a job id immediately. The work
// (~30-90s) runs fire-and-forget; the client polls the status endpoint below.
// This avoids holding a long request open, which Railway's proxy closes.
// Optional `fileRefs` (from /api/upload) are ingested as upload references.
// Requires a session (audit HIGH 2); the tenant comes from req.user.tenant_id —
// never a client-supplied workspaceId — so a brief always runs as the signed-in
// tenant. In demo mode requireAuth attaches the demo tenant (T0B8LPRDKHR).
router.post('/api/brief', briefLimiter, requireAuth, (req, res) => {
  const body = req.body || {};
  const briefText = (body.briefText || '').trim();
  const sessionTenant = (req.user && req.user.tenant_id) || DEFAULT_WORKSPACE_ID;
  const fileRefs = safeFileRefs(body.fileRefs);

  if (!briefText) {
    return res.status(400).json({ success: false, error: 'briefText is required' });
  }

  const jobId = startJob(`brief tenant=${sessionTenant}`, async () => {
    const tenantContext = await resolveTenant(sessionTenant);
    return runWebBrief(briefText, tenantContext, fileRefs); // the full { docUrl, assetBlocks, … }
  });
  // Log the brief length so a truncated brief (e.g. a cut folder URL) is obvious
  // — never the brief content itself.
  console.log(
    `[web] /api/brief start → job=${jobId} tenant=${sessionTenant} briefText.length=${briefText.length} files=${fileRefs.length}`
  );
  return res.status(202).json({ success: true, jobId });
});

// GET /api/brief/:jobId/status — poll a brief job. On complete, `result` is the
// same structured payload the old synchronous endpoint returned.
router.get('/api/brief/:jobId/status', sendJobStatus);

// POST /api/draft — START draft generation and return a job id immediately.
// The work (~1 min) runs fire-and-forget; the client polls the status endpoint
// below. This avoids holding a long request open, which Railway's proxy closes.
// Requires a session (audit HIGH 2); the tenant comes from req.user.tenant_id,
// never a client-supplied workspaceId.
router.post('/api/draft', draftLimiter, requireAuth, (req, res) => {
  const body = req.body || {};
  const docId = (body.docId || '').trim();
  const direction = (body.direction || '').trim(); // optional regenerate feedback
  const sessionTenant = (req.user && req.user.tenant_id) || DEFAULT_WORKSPACE_ID;

  if (!docId) {
    return res.status(400).json({ success: false, error: 'docId is required' });
  }

  const mode = direction ? `regenerate (${direction.length} chars)` : 'first draft';
  const jobId = startJob(`draft doc=${docId} ${mode}`, async () => {
    const tenantContext = await resolveTenant(sessionTenant);
    const out = await runWebDraft(docId, tenantContext, direction);
    return { docId: out.docId, fieldCount: out.fieldCount };
  });
  console.log(`[web] /api/draft start → job=${jobId} doc=${docId} tenant=${sessionTenant} mode=${mode}`);
  return res.status(202).json({ success: true, jobId });
});

// GET /api/draft/:jobId/status — poll a draft job. Unknown id → 404 (e.g. the
// job expired or the server restarted; the client falls back to reading the doc).
router.get('/api/draft/:jobId/status', sendJobStatus);

// POST /api/review — START a copy review and return a job id. The work (Gemini
// per-field eval + Drive comment writes) runs fire-and-forget; the client polls
// the status endpoint below. Tenant comes from the session, never the client.
router.post('/api/review', draftLimiter, requireAuth, (req, res) => {
  const docId = ((req.body && req.body.docId) || '').trim();
  const sessionTenant = (req.user && req.user.tenant_id) || DEFAULT_WORKSPACE_ID;
  if (!docId) {
    return res.status(400).json({ success: false, error: 'docId is required' });
  }
  const jobId = startJob(`review doc=${docId}`, async () => {
    const tenantContext = await resolveTenant(sessionTenant);
    return runWebReview(docId, tenantContext);
  });
  console.log(`[web] /api/review start → job=${jobId} doc=${docId} tenant=${sessionTenant}`);
  return res.status(202).json({ success: true, jobId });
});

// GET /api/review/:jobId/status — poll a review job.
router.get('/api/review/:jobId/status', sendJobStatus);

// Project status lifecycle (Week 12). Closed projects are hidden by default but
// never deleted.
const VALID_STATUSES = ['not_started', 'in_progress', 'finished', 'closed'];

// GET /api/projects — the tenant's projects, newest first. Closed are hidden
// unless ?include_closed=true. Without a DB this resolves to [].
router.get('/api/projects', requireAuth, async (req, res) => {
  const includeClosed = req.query.include_closed === 'true';
  try {
    // Tenant comes from the authenticated session (req.user.tenant_id), never a
    // client-supplied param — prevents cross-tenant reads (audit HIGH 3). In demo
    // mode requireAuth attaches the demo tenant (T0B8LPRDKHR).
    const { tenant } = await resolveTenant(req.user && req.user.tenant_id);
    const projects = await getProjects(tenant && tenant.id, includeClosed);
    return res.status(200).json({ success: true, projects });
  } catch (err) {
    console.error('[web] /api/projects failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// PATCH /api/projects/:id/status — update a project's status. Degrades
// gracefully: returns success even without a DB (no row to persist) so the
// optimistic UI stays consistent. Invalid statuses are rejected.
router.patch('/api/projects/:id/status', requireAuth, async (req, res) => {
  const status = (req.body || {}).status;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, error: 'Invalid status' });
  }
  try {
    // Tenant from the session, not a client param (audit HIGH 3).
    const { tenant } = await resolveTenant(req.user && req.user.tenant_id);
    await setProjectStatus(tenant && tenant.id, req.params.id, status);
    return res.status(200).json({ success: true, status });
  } catch (err) {
    console.error('[web] PATCH /api/projects/:id/status failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// GET /api/projects/:id — a single project, scoped to its tenant.
router.get('/api/projects/:id', requireAuth, async (req, res) => {
  try {
    // Tenant from the session, not a client param (audit HIGH 3).
    const { tenant } = await resolveTenant(req.user && req.user.tenant_id);
    const project = await getProject(tenant && tenant.id, req.params.id);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found' });
    return res.status(200).json({ success: true, project });
  } catch (err) {
    console.error('[web] /api/projects/:id failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// GET /api/projects/:id/content — the project's doc content, parsed into
// sections + per-field copy. A Docs read failure returns { success:false } so
// the UI can fall back to "Content unavailable" + Open in Drive.
router.get('/api/projects/:id/content', requireAuth, async (req, res) => {
  try {
    // Tenant from the session, not a client param (audit HIGH 3).
    const { tenant } = await resolveTenant(req.user && req.user.tenant_id);
    const project = await getProject(tenant && tenant.id, req.params.id);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found' });
    if (!project.copy_doc_id) {
      return res.status(200).json({ success: false, error: 'No document for this project' });
    }
    const content = await runWebProjectContent(project.copy_doc_id);
    return res.status(200).json({ success: true, content });
  } catch (err) {
    console.error('[web] /api/projects/:id/content failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

module.exports = router;
