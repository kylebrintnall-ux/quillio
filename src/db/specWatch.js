'use strict';

// LiveSpecs data-layer accessors. Reads for the two global spec tables
// (spec_watch_list, spec_review_queue) used by the admin JSON endpoints, plus
// the editable test-page store (chunk 2). Degrades gracefully when DATABASE_URL
// is unset (reads return [] / null), matching the rest of db/. The detector's
// hash/flag writes live in services/specDetector.js, not here.

const { getPool } = require('../db');

// All watch-list rows (the URLs being monitored). Ordered real-entries-first,
// test entries last. Returns [] when there's no DB.
async function getWatchList() {
  const p = getPool();
  if (!p) return [];
  const res = await p.query(
    `SELECT id, source_url, display_name, affected_fields, current_hash,
            last_checked_at, last_error, is_test, created_at
       FROM spec_watch_list
      ORDER BY is_test, display_name NULLS LAST, id`
  );
  return (res && res.rows) || [];
}

// The editable test-page content (singleton row id=1). Returns the string, or
// null when there's no DB / no row yet.
async function getTestPageContent() {
  const p = getPool();
  if (!p) return null;
  const res = await p.query('SELECT content FROM spec_test_page WHERE id = 1');
  return (res && res.rows && res.rows[0] && res.rows[0].content) || null;
}

// Update the test-page content (singleton row id=1). Upserts so it works even if
// the seed row is somehow absent. Returns the saved string, or null with no DB.
async function setTestPageContent(content) {
  const p = getPool();
  if (!p) return null;
  await p.query(
    `INSERT INTO spec_test_page (id, content, updated_at)
       VALUES (1, $1, NOW())
     ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
    [content]
  );
  return content;
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

module.exports = { getWatchList, getReviewQueue, getTestPageContent, setTestPageContent };
