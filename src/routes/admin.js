'use strict';

// Admin area (LiveSpecs admin). Everything here is gated by requireAdmin
// (users.is_admin = true; 404 for everyone else). Chunk 1 adds the LiveSpecs
// data-layer read endpoints (watch list + review queue) as JSON only — no UI,
// no detector, no writes. Later LiveSpecs features hang off this router.

const express = require('express');
const { requireAdmin } = require('../middleware/requireAdmin');
const { getWatchList, getReviewQueue } = require('../db/specWatch');

const router = express.Router();

// GET /admin — minimal proof the gate works. Admins get "admin ok"; everyone
// else is stopped by requireAdmin with a bare 404 before reaching this handler.
router.get('/admin', requireAdmin, (req, res) => {
  res.status(200).type('text').send('admin ok');
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

// GET /admin/api/review-queue — flagged changes (JSON). Empty until the detector
// runs in a later chunk. Admin-gated.
router.get('/admin/api/review-queue', requireAdmin, async (req, res) => {
  try {
    const reviewQueue = await getReviewQueue();
    res.status(200).json({ success: true, reviewQueue });
  } catch (err) {
    console.error('[admin] review-queue read failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to read review queue' });
  }
});

module.exports = router;
