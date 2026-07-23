'use strict';

// LiveSpecs data-layer reads (chunk 1). Read-only accessors for the two global
// spec tables (spec_watch_list, spec_review_queue), used by the admin-gated
// JSON endpoints. Degrades gracefully when DATABASE_URL is unset (returns []),
// matching the rest of db/. No writes live here — this chunk is read-only.

const { getPool } = require('../db');

// All watch-list rows (the URLs being monitored). Ordered real-entries-first,
// test entries last. Returns [] when there's no DB.
async function getWatchList() {
  const p = getPool();
  if (!p) return [];
  const res = await p.query(
    `SELECT id, source_url, display_name, affected_fields, current_hash,
            last_checked_at, is_test, created_at
       FROM spec_watch_list
      ORDER BY is_test, display_name NULLS LAST, id`
  );
  return (res && res.rows) || [];
}

// All review-queue rows (flagged changes). Empty until the detector runs in a
// later chunk. Newest first. Returns [] when there's no DB.
async function getReviewQueue() {
  const p = getPool();
  if (!p) return [];
  const res = await p.query(
    `SELECT id, watch_id, source_url, old_hash, new_hash, detected_at,
            status, is_test, created_at
       FROM spec_review_queue
      ORDER BY detected_at DESC, id DESC`
  );
  return (res && res.rows) || [];
}

module.exports = { getWatchList, getReviewQueue };
