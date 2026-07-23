'use strict';

// Admin area (LiveSpecs admin). Admin surfaces are gated by requireAdmin
// (users.is_admin = true; 404 for everyone else). Chunk 2 adds the detector
// trigger and the editable test page; chunk 3a adds the review UI + the
// approve→write path. NOTE: GET /admin/test-spec is deliberately PUBLIC (see
// below) — the detector fetches it over HTTP with no session, so it can't be
// admin-gated. It serves only fake seed data. Everything else here stays
// admin-gated.

const path = require('path');
const express = require('express');
const { requireAdmin } = require('../middleware/requireAdmin');
const {
  getWatchList,
  getReviewQueue,
  getTestPageContent,
  setTestPageContent,
  getDetectionHealth,
} = require('../db/specWatch');
const { runDetection } = require('../services/specDetector');
const {
  getFlagForReview,
  getSuggestions,
  buildPreview,
  commitReview,
  dismiss,
} = require('../services/specReview');

const router = express.Router();

const ADMIN_HTML = path.join(__dirname, '..', '..', 'public', 'admin.html');

// Minimal HTML-escape for the test page (content is admin-controlled fake data,
// but escape anyway so it can never inject markup into the served page).
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// GET /admin — the review console (chunk 3a). Admin-gated static page that
// renders the pending queue and drives dismiss/approve via the JSON endpoints
// below. Non-admins are stopped by requireAdmin with a bare 404.
router.get('/admin', requireAdmin, (req, res) => {
  res.status(200).sendFile(ADMIN_HTML);
});

// GET /admin/api/watch-list — the URLs being monitored (JSON). Admin-gated.
router.get('/admin/api/watch-list', requireAdmin, async (req, res) => {
  try {
    const watchList = await getWatchList();
    res.status(200).json({ success: true, watchList });
  } catch (err) {
    console.error('[admin] watch-list read failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to read watch list' });
  }
});

// GET /admin/api/health — detection health (chunk 4c): watch-list state
// (last_checked_at / baselined / last_error) + pending-flag counts + overall
// last-run timestamp. READ-ONLY. Admin-gated.
router.get('/admin/api/health', requireAdmin, async (req, res) => {
  try {
    const health = await getDetectionHealth();
    res.status(200).json({ success: true, ...health });
  } catch (err) {
    console.error('[admin] health read failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to read health' });
  }
});

// GET /admin/api/review-queue — flagged changes (JSON). Empty until a detected
// change inserts a row. Admin-gated.
router.get('/admin/api/review-queue', requireAdmin, async (req, res) => {
  try {
    const reviewQueue = await getReviewQueue();
    res.status(200).json({ success: true, reviewQueue });
  } catch (err) {
    console.error('[admin] review-queue read failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to read review queue' });
  }
});

// --- Chunk 2: detector test harness + trigger ---

// GET /admin/test-spec — the editable fake spec page the detector watches.
// PUBLIC ON PURPOSE: the detector fetches this over HTTP with no admin session
// (it's a plain server-side request), so admin-gating it would make the detector
// get a 404 instead of the content. It only ever serves fake seed data, never
// anything real. Served as a minimal HTML page so the detector processes it
// exactly like a real watched page.
router.get('/admin/test-spec', async (req, res) => {
  try {
    const content = (await getTestPageContent()) || '';
    res
      .status(200)
      .type('html')
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Quillio Test Spec</title></head><body><pre>${escapeHtml(content)}</pre></body></html>`
      );
  } catch (err) {
    console.error('[admin] test-spec render failed:', err.message);
    res.status(500).type('text').send('test-spec error');
  }
});

// POST /admin/api/test-spec { content } — edit the test-page content. This is
// how an admin changes the page to trigger a detection. Admin-gated.
router.post('/admin/api/test-spec', requireAdmin, async (req, res) => {
  const content = req.body && req.body.content;
  if (typeof content !== 'string' || content.length === 0) {
    return res.status(400).json({ success: false, error: 'content (non-empty string) is required' });
  }
  try {
    const saved = await setTestPageContent(content);
    res.status(200).json({ success: true, content: saved });
  } catch (err) {
    console.error('[admin] test-spec update failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to update test spec' });
  }
});

// POST /admin/api/run-detection — run the detector over ALL watch entries and
// return a per-URL summary. Manual trigger only (no cron). Admin-gated.
router.post('/admin/api/run-detection', requireAdmin, async (req, res) => {
  try {
    const result = await runDetection();
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('[admin] run-detection failed:', err.message);
    res.status(500).json({ success: false, error: 'Detection run failed' });
  }
});

// --- Chunk 3a: review a flag → dismiss, or approve → diff → confirm → write ---

// GET /admin/api/flag/:id — a flag + every affected (asset,field) with its
// current char_max/spec_note, to populate the approve form. Admin-gated.
router.get('/admin/api/flag/:id', requireAdmin, async (req, res) => {
  try {
    const flag = await getFlagForReview(req.params.id);
    if (!flag) return res.status(404).json({ success: false, error: 'flag not found' });
    res.status(200).json({ success: true, flag });
  } catch (err) {
    console.error('[admin] flag read failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to read flag' });
  }
});

// GET /admin/api/flag/:id/suggestions — chunk 3b. Re-fetch the changed page and
// suggest a char_max per affected field (Gemini) + a supporting snippet.
// Suggestion only — writes nothing. Admin-gated.
router.get('/admin/api/flag/:id/suggestions', requireAdmin, async (req, res) => {
  try {
    const result = await getSuggestions(req.params.id);
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('[admin] suggestions failed:', err.message);
    res.status(500).json({ success: false, error: 'Suggestions failed' });
  }
});

// POST /admin/api/dismiss { flagId } — mark a flag dismissed. Touches ONLY the
// queue status, never copy_fields. Allowed for any flag (incl. test). Admin-gated.
router.post('/admin/api/dismiss', requireAdmin, async (req, res) => {
  const flagId = req.body && req.body.flagId;
  if (!flagId) return res.status(400).json({ success: false, error: 'flagId is required' });
  try {
    const result = await dismiss(flagId);
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('[admin] dismiss failed:', err.message);
    res.status(500).json({ success: false, error: 'Dismiss failed' });
  }
});

// POST /admin/api/approve-preview { flagId, edits } — compute the diff for the
// checked fields. Writes NOTHING. Admin-gated. is_test / validation / affected-
// pair checks all run here (and again on commit).
router.post('/admin/api/approve-preview', requireAdmin, async (req, res) => {
  const { flagId, edits } = req.body || {};
  if (!flagId) return res.status(400).json({ success: false, error: 'flagId is required' });
  try {
    const result = await buildPreview(flagId, edits);
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('[admin] approve-preview failed:', err.message);
    res.status(500).json({ success: false, error: 'Preview failed' });
  }
});

// POST /admin/api/approve-commit { flagId, edits } — THE ONLY path that writes
// copy_fields. Re-validates server-side, then value write + spec_verified_at
// stamp + audit log + flag flip in one transaction. changed_by is the signed-in
// admin (req.user.id). Admin-gated.
router.post('/admin/api/approve-commit', requireAdmin, async (req, res) => {
  const { flagId, edits } = req.body || {};
  if (!flagId) return res.status(400).json({ success: false, error: 'flagId is required' });
  try {
    const changedBy = req.user && req.user.id;
    const result = await commitReview(flagId, edits, changedBy);
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error('[admin] approve-commit failed:', err.message);
    res.status(500).json({ success: false, error: 'Write failed' });
  }
});

module.exports = router;
