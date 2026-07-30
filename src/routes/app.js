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
const {
  runWebBriefParse,
  runWebBriefGenerate,
  runWebDraft,
  runWebProjectContent,
  runWebReview,
} = require('../adapters/web');
const { getTenantAssets } = require('../db/assets');
const { MAX_TOTAL_INSTANCES } = require('../core/pipeline');
const {
  putPending,
  getPending,
  planNeedsConfirmation,
  sanitizeAssetPlan,
} = require('../pendingBriefs');
const { requireAuth } = require('../middleware/auth');
const { briefLimiter, draftLimiter, uploadLimiter } = require('../middleware/rateLimit');
const { clientErrorMessage } = require('../utils/errors');

const router = express.Router();

// The demo tenant — used when a request doesn't carry a workspace id.
const DEFAULT_WORKSPACE_ID = 'T0B8LPRDKHR';

// The signed-in user's id (users.id), or null in demo mode where requireAuth
// attaches a synthetic user with no row behind it. This is the ACTING USER: it
// selects their own Google credentials for Drive/Docs writes and is recorded as
// the author of any project they create.
function sessionUser(req) {
  return (req.user && req.user.id) || null;
}

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

// --- Scoped-field instance ordinal ---
//
// A doc can hold several instances of one asset, whose fields are identically
// named, so a scoped draft/review target is only unambiguous with the instance
// ordinal attached. Both consumers already key on it —
// googleDocs.generateDraft builds its scopeKeys from
// `ctxKey(assetType, fieldName, instance)`, and copyReview's `inScope` uses the
// same composite — but the two sanitizers below used to drop the field, so the
// ordinal never survived the HTTP boundary.
//
// Dropping it did NOT fail loudly. An absent ordinal serializes to nothing, and
// so does 0 (the backward-compatibility rule in utils/instanceKey), so a request
// naming instance 2 silently matched INSTANCE 0 — a user selecting the Chicago
// email got the Austin one rewritten, with no error anywhere.
//
// Client-supplied, so never trusted:
//   - anything non-finite (absent, null, '', 'abc', NaN, Infinity) → 0, which is
//     exactly the pre-instance behavior every older client depends on;
//   - clamped to 0..MAX_TOTAL_INSTANCES-1, since no doc can hold more instances
//     than the whole-plan ceiling allows. An in-range ordinal with no matching
//     asset simply matches nothing and that field is skipped — the right failure,
//     and better than a huge number quietly landing on instance 0.
function scopedInstance(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_TOTAL_INSTANCES - 1, n));
}

// In-memory async job store (Week 12). Brief runs (~30-90s) and draft runs
// (~1 min) both outlast Railway's edge proxy, which closes a connection held
// open with no response bytes — so instead of one long-awaited POST we start a
// job and let the client poll its status. Shared by /api/brief and /api/draft.
// Single-instance only (fine here); a multi-instance deploy would need a shared
// store. Jobs are swept after a TTL so the Map can't grow unbounded.
const JOBS = new Map(); // jobId -> { tenantId, status, result, error, ts }
const JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Hard ceiling on a single job's runtime. Every Gemini call is already bounded
// (callGemini aborts at 45s), but the Google Docs/Drive calls in the draft path
// use the googleapis client, which has NO default timeout — so a stalled
// documents.get / batchUpdate would leave work() un-settled forever, and the job
// would sit 'pending' until the client's own 8-min ceiling. This races every job
// against a deadline so it ALWAYS settles: on timeout the job flips to 'failed'
// with a clear message the client surfaces on its next poll (~3s), instead of an
// endless spinner. The underlying work isn't cancellable, so it may finish in the
// background, but the user gets a definite outcome and can retry. Env-overridable.
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS) || 4 * 60 * 1000; // 4 minutes

function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    if (now - job.ts > JOB_TTL_MS) JOBS.delete(id);
  }
}

// Start a job: register it as pending, run `work()` fire-and-forget, and record
// its result/error on settle. Returns the new jobId. `label` is for logs only.
// `tenantId` is the owning tenant (from the starter's session) — it's stamped on
// the record and re-checked on every poll so one tenant can't read another's job
// result by guessing/leaking a job id. Every settle below re-writes the record,
// so each write must carry tenantId forward.
function startJob(label, tenantId, work, timeoutMs = JOB_TIMEOUT_MS) {
  sweepJobs();
  const jobId = crypto.randomUUID();
  JOBS.set(jobId, { tenantId, status: 'pending', result: null, error: null, ts: Date.now() });
  const startedAt = Date.now();
  (async () => {
    let timer;
    // Race the work against a hard deadline so a hung (un-timed-out) call can't
    // leave the job 'pending' forever. Promise.race can't cancel the work, so we
    // clear the timer on settle to avoid a dangling handle.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('This is taking longer than expected — please try again.')),
        timeoutMs
      );
    });
    try {
      const result = await Promise.race([work(), deadline]);
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`[web] job done → ${label} job=${jobId} in ${secs}s`);
      JOBS.set(jobId, { tenantId, status: 'complete', result, error: null, ts: Date.now() });
    } catch (err) {
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.error(`[web] job failed → ${label} job=${jobId} after ${secs}s:`, err && err.stack ? err.stack : err);
      JOBS.set(jobId, { tenantId, status: 'failed', result: null, error: err.message, ts: Date.now() });
    } finally {
      clearTimeout(timer);
    }
  })();
  return jobId;
}

// === Parse-then-confirm ===
//
// The pending-brief store, the pause rule and the plan validator all live in
// src/pendingBriefs.js — ONE of each, shared with the Slack flow, which needs the
// same three things. They were module-local here until Slack grew a confirmation
// step; reaching them from the Slack adapter would have made it depend on this
// web router. Web records are owned by the session tenant id.
//
// Same single-instance caveat as JOBS above: a restart loses pending briefs, and
// the confirm route answers 404 for a lost id (see below).

// Shared poll handler for a job's status route. Mounted behind requireAuth, so
// req.user is always populated (in demo mode with the demo tenant) — the tenant
// is read exactly as the POST starters read it, so a job is only visible to the
// tenant that started it.
//
// Unknown id → 404 (job expired or the server restarted; clients fall back as
// appropriate). A job owned by ANOTHER tenant returns that same 404, not a 403:
// a 403 would confirm the id exists, turning the endpoint into an oracle for
// probing other tenants' job ids. Cross-tenant reads are indistinguishable from
// "no such job". The response shape is byte-identical to the pre-auth one, so
// the client's polling contract is unchanged.
function sendJobStatus(req, res) {
  const sessionTenant = (req.user && req.user.tenant_id) || DEFAULT_WORKSPACE_ID;
  const job = JOBS.get(req.params.jobId);
  if (!job || job.tenantId !== sessionTenant) {
    return res.status(404).json({ success: false, status: 'failed', error: 'Unknown or expired job' });
  }
  return res.status(200).json({ success: true, status: job.status, result: job.result, error: job.error });
}

// GET /app — the single-file web UI (HTML + CSS + vanilla JS). Served with the
// deploy commit stamped into a __BUILD__ placeholder so the running shell knows
// its own version and can detect when it's stale (an edge cache serving old HTML
// despite no-store). The raw file is read once and cached in memory.
const APP_HTML = path.join(__dirname, '..', '..', 'public', 'app.html');
let APP_HTML_RAW = null;
function renderAppHtml() {
  if (APP_HTML_RAW == null) APP_HTML_RAW = require('fs').readFileSync(APP_HTML, 'utf8');
  const build = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_VERSION || '').slice(0, 7) || 'dev';
  return APP_HTML_RAW.split('__BUILD__').join(build);
}
router.get('/app', requireAuth, (req, res) => {
  // The HTML shell must never be cached — otherwise a phone serves a stale
  // app.html and never sees newly shipped UI (e.g. the Review Copy button).
  // no-store is stronger than no-cache: it forbids storing the shell at all,
  // so there's no cached copy to serve. Pragma/Expires cover legacy + proxy
  // caches. Versioned /assets + /fonts keep their long cache; only this shell.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.status(200).type('html').send(renderAppHtml());
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
  const sessionUserId = sessionUser(req);
  const fileRefs = safeFileRefs(body.fileRefs);

  if (!briefText) {
    return res.status(400).json({ success: false, error: 'briefText is required' });
  }

  const jobId = startJob(`brief tenant=${sessionTenant}`, sessionTenant, async () => {
    const tenantContext = await resolveTenant(sessionTenant, null, sessionUserId);
    const parsed = await runWebBriefParse(briefText, tenantContext, fileRefs);

    // Nothing to correct → finish in THIS job. No second request, no extra click,
    // no behavior change. This is the only path parseBrief can reach today, since
    // it returns a deduped string[] (every count 1, no labels).
    if (!planNeedsConfirmation(parsed.plan)) {
      return runWebBriefGenerate(parsed, parsed.plan, tenantContext); // { docUrl, assetBlocks, … }
    }

    // Otherwise stop and hand the interpretation back for review. No doc exists yet.
    const pendingId = putPending(sessionTenant, parsed);
    console.log(
      `[web] brief needs confirmation → pending=${pendingId} tenant=${sessionTenant} ` +
        `plan=${JSON.stringify(parsed.plan.map((e) => `${e.asset}x${e.count}`))}`
    );
    return {
      needsConfirmation: true,
      pendingId,
      interpretation: {
        campaignTitle: parsed.campaignTitle,
        summary: parsed.summary,
        writerDirection: parsed.writerPrompt,
        referenceInsights: parsed.referenceInsights,
        plan: parsed.plan,
        // What the brief named that didn't map to a supported asset type. The
        // confirmation screen is the last point before anything is built, so
        // this is where a partial miss is cheapest to correct — it reached the
        // route but stopped here before, leaving the screen unable to show it.
        unmatchedAssets: parsed.unmatchedAssets || [],
        unmatchedNotice: parsed.unmatchedNotice || null,
      },
    };
  });
  // Log the brief length so a truncated brief (e.g. a cut folder URL) is obvious
  // — never the brief content itself.
  console.log(
    `[web] /api/brief start → job=${jobId} tenant=${sessionTenant} briefText.length=${briefText.length} files=${fileRefs.length}`
  );
  return res.status(202).json({ success: true, jobId });
});

// GET /api/brief/:jobId/status — poll a brief job. On complete, `result` is the
// same structured payload the old synchronous endpoint returned. Requires a
// session (same gate as the POST above) and only returns the session tenant's
// own jobs.
router.get('/api/brief/:jobId/status', requireAuth, sendJobStatus);

// POST /api/brief/confirm — resume a paused brief from a reviewed asset plan.
// Takes { pendingId, plan } and returns 202 { jobId }, polled at the SAME
// /api/brief/:jobId/status endpoint above, so the client's polling contract is
// unchanged. Only reachable when /api/brief actually paused; a plan with nothing
// to confirm never gets here.
router.post('/api/brief/confirm', briefLimiter, requireAuth, async (req, res) => {
  const body = req.body || {};
  const sessionTenant = (req.user && req.user.tenant_id) || DEFAULT_WORKSPACE_ID;
  const sessionUserId = sessionUser(req);
  const pendingId = String(body.pendingId || '');

  // Unknown / expired / another tenant's → the same 404, never a 403 (see getPending).
  const parsed = getPending(pendingId, sessionTenant);
  if (!parsed) {
    return res.status(404).json({ success: false, error: 'Unknown or expired brief — please run it again.' });
  }

  // The plan is CLIENT-supplied and edited by hand, so it is validated against the
  // tenant's real library before anything runs. Falls back to the parse's own plan
  // when the client sends none.
  let plan = parsed.plan;
  if (body.plan !== undefined) {
    let libraryNames = [];
    try {
      const rows = await getTenantAssets(sessionTenant);
      libraryNames = (rows || []).map((r) => r.name);
    } catch (err) {
      console.error('[web] /api/brief/confirm library read failed:', err.message);
      return res.status(500).json({ success: false, error: clientErrorMessage(err) });
    }
    // No library at all is a different failure from "you named an asset I don't
    // have" — say so, rather than blaming every name in the plan.
    if (libraryNames.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Your workspace has no asset library yet, so there's nothing to build from.",
      });
    }
    const checked = sanitizeAssetPlan(body.plan, libraryNames);
    if (checked.error) return res.status(400).json({ success: false, error: checked.error });
    if (checked.plan.length === 0) {
      return res.status(400).json({ success: false, error: 'Pick at least one asset.' });
    }
    plan = checked.plan;
  }

  const jobId = startJob(`brief-confirm tenant=${sessionTenant}`, sessionTenant, async () => {
    const tenantContext = await resolveTenant(sessionTenant, null, sessionUserId);
    return runWebBriefGenerate(parsed, plan, tenantContext);
  });
  console.log(
    `[web] /api/brief/confirm start → job=${jobId} pending=${pendingId} tenant=${sessionTenant} ` +
      `plan=${JSON.stringify(plan.map((e) => `${e.asset}x${e.count}`))}`
  );
  return res.status(202).json({ success: true, jobId });
});

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
  const sessionUserId = sessionUser(req);

  if (!docId) {
    return res.status(400).json({ success: false, error: 'docId is required' });
  }

  // Optional scoping: only draft the named fields (selective generate/regen).
  // Sanitize to [{assetType, instance, fieldName}]; empty/absent → whole doc.
  // count (1–4) and distance (close|explore|wide) are the optional per-field
  // variation controls (Phase 2/3); absent/invalid → 1 / 'close' = Phase-1.
  const scopedFields = Array.isArray(body.scopedFields)
    ? body.scopedFields
        .filter((f) => f && typeof f.assetType === 'string' && typeof f.fieldName === 'string')
        .map((f) => ({
          assetType: f.assetType,
          // Which of several same-named assets this field belongs to (see
          // scopedInstance). Absent → 0, so an older client is unaffected.
          instance: scopedInstance(f.instance),
          fieldName: f.fieldName,
          count: Math.max(1, Math.min(4, parseInt(f.count, 10) || 1)),
          distance: ['close', 'explore', 'wide'].includes(f.distance) ? f.distance : 'close',
          // Variations Matrix (Step 3): optional per-angle rows. Passed through
          // loosely — googleDocs validates angle/intensity names + caps count 1–5
          // authoritatively (normalizeVarControls). A valid matrix overrides
          // count/distance downstream; absent → the legacy path is unchanged.
          variations: Array.isArray(f.variations)
            ? f.variations
                .filter((r) => r && typeof r.angle === 'string')
                .map((r) => ({
                  angle: r.angle,
                  count: Math.max(1, Math.min(10, parseInt(r.count, 10) || 1)),
                  intensity: typeof r.intensity === 'string' ? r.intensity : 'Safe',
                }))
                .slice(0, 20)
            : undefined,
        }))
        .slice(0, 200)
    : null;
  const scoped = scopedFields && scopedFields.length > 0;
  // ADDITIVE write (Variations Matrix Step 1): append the batch below existing
  // copy instead of replacing. Scoped-only; ignored on a whole-doc call.
  const append = body.append === true && scoped;

  const mode = `${direction ? `regenerate (${direction.length} chars)` : 'first draft'}${scoped ? ` scoped ${scopedFields.length}` : ''}${append ? ' append' : ''}`;
  const jobId = startJob(`draft doc=${docId} ${mode}`, sessionTenant, async () => {
    const tenantContext = await resolveTenant(sessionTenant, null, sessionUserId);
    const out = await runWebDraft(docId, tenantContext, direction, scoped ? scopedFields : undefined, append);
    return { docId: out.docId, fieldCount: out.fieldCount };
  });
  console.log(`[web] /api/draft start → job=${jobId} doc=${docId} tenant=${sessionTenant} mode=${mode}`);
  return res.status(202).json({ success: true, jobId });
});

// GET /api/draft/:jobId/status — poll a draft job. Unknown id → 404 (e.g. the
// job expired or the server restarted; the client falls back to reading the doc).
// Requires a session (same gate as the POST above) and only returns the session
// tenant's own jobs.
router.get('/api/draft/:jobId/status', requireAuth, sendJobStatus);

// POST /api/review — START a copy review and return a job id. The work (Gemini
// per-field eval + Drive comment writes) runs fire-and-forget; the client polls
// the status endpoint below. Tenant comes from the session, never the client.
router.post('/api/review', draftLimiter, requireAuth, (req, res) => {
  const body = req.body || {};
  const docId = (body.docId || '').trim();
  const sessionTenant = (req.user && req.user.tenant_id) || DEFAULT_WORKSPACE_ID;
  const sessionUserId = sessionUser(req);
  if (!docId) {
    return res.status(400).json({ success: false, error: 'docId is required' });
  }
  // Optional scoping: review only the named fields (with asset context). Sanitize
  // to [{assetType, instance, fieldName}]; empty/absent → whole-doc review, exactly
  // as today. copyReview's inScope keys on the instance the same way generateDraft
  // does, so the ordinal has to survive this map or it targets instance 0.
  const scopedFields = Array.isArray(body.scopedFields)
    ? body.scopedFields
        .filter((f) => f && typeof f.assetType === 'string' && typeof f.fieldName === 'string')
        .map((f) => ({ assetType: f.assetType, instance: scopedInstance(f.instance), fieldName: f.fieldName }))
        .slice(0, 200)
    : null;
  const scoped = scopedFields && scopedFields.length > 0;

  const jobId = startJob(`review doc=${docId}${scoped ? ` scoped ${scopedFields.length}` : ''}`, sessionTenant, async () => {
    const tenantContext = await resolveTenant(sessionTenant, null, sessionUserId);
    return runWebReview(docId, tenantContext, scoped ? scopedFields : undefined);
  });
  console.log(`[web] /api/review start → job=${jobId} doc=${docId} tenant=${sessionTenant}${scoped ? ` scoped ${scopedFields.length}` : ''}`);
  return res.status(202).json({ success: true, jobId });
});

// GET /api/review/:jobId/status — poll a review job. Requires a session (same
// gate as the POST above) and only returns the session tenant's own jobs.
router.get('/api/review/:jobId/status', requireAuth, sendJobStatus);

// Project status lifecycle (Week 12). Closed projects are hidden by default but
// never deleted.
const VALID_STATUSES = ['not_started', 'in_progress', 'finished', 'closed'];

// GET /api/projects — the tenant's projects, newest first. Closed are hidden
// unless ?include_closed=true. Without a DB this resolves to [].
router.get('/api/projects', requireAuth, async (req, res) => {
  const includeClosed = req.query.include_closed === 'true';
  res.set('Cache-Control', 'no-store'); // mutable list — never cache (fresh after create/status change)
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
  // Mutable state — never cache. Otherwise an edge/CDN (Cloudflare) can serve a
  // pre-generation "no copy" body to the refetch right after a draft completes,
  // so the Review Copy button stays hidden until the short edge cache expires.
  res.set('Cache-Control', 'no-store');
  try {
    // Tenant from the session, not a client param (audit HIGH 3).
    const { tenant, user } = await resolveTenant(req.user && req.user.tenant_id, null, sessionUser(req));
    const project = await getProject(tenant && tenant.id, req.params.id);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found' });
    if (!project.copy_doc_id) {
      return res.status(200).json({ success: false, error: 'No document for this project' });
    }
    // Read the doc as this tenant's Google user — the doc lives in their own
    // Drive (created via their OAuth), so the service-account fallback can't see
    // it. Without passing { tenant }, the read fails and the UI drops to the
    // "Open in Drive" fallback instead of rendering the copy inline.
    const content = await runWebProjectContent(project.copy_doc_id, { tenant, user });
    return res.status(200).json({ success: true, content });
  } catch (err) {
    console.error('[web] /api/projects/:id/content failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

module.exports = router;
