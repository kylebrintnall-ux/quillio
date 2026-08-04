'use strict';

// LiveSpecs data-layer accessors. Reads for the two global spec tables
// (spec_watch_list, spec_review_queue) used by the admin JSON endpoints, plus
// the editable test-page store (chunk 2). Degrades gracefully when DATABASE_URL
// is unset (reads return [] / null), matching the rest of db/. The detector's
// hash/flag writes live in services/specDetector.js, not here.

const { getPool, isUndefinedColumn, warnMissingSchema } = require('../db');

const WATCH_ORDER = 'ORDER BY is_test, display_name NULLS LAST, id';
const WATCH_COLUMNS = `id, source_url, display_name, affected_fields, current_hash,
            last_checked_at, last_error, is_test, created_at`;

// All watch-list rows (the URLs being monitored). Ordered real-entries-first,
// test entries last. Returns [] when there's no DB.
//
// expected_content / anchor_scope / consecutive_failures arrive with
// scripts/migrateAddSpecAnchors.js. Until it runs we fall back to the columns
// that have always existed, so a deploy that lands ahead of the migration still
// runs detection instead of erroring out of every admin read. The detector tells
// the two states apart by KEY PRESENCE — a fallback row has no
// `consecutive_failures` key at all, where a migrated-but-unseeded row has the
// key set to a value — so don't "tidy" this by defaulting the missing columns in.
async function getWatchList() {
  const p = getPool();
  if (!p) return [];
  try {
    const res = await p.query(
      `SELECT ${WATCH_COLUMNS}, expected_content, anchor_scope, consecutive_failures
         FROM spec_watch_list ${WATCH_ORDER}`
    );
    return (res && res.rows) || [];
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    warnMissingSchema('spec_watch_list.expected_content', 'scripts/migrateAddSpecAnchors.js');
    const res = await p.query(`SELECT ${WATCH_COLUMNS} FROM spec_watch_list ${WATCH_ORDER}`);
    return (res && res.rows) || [];
  }
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

// Detection health (read-only, chunk 4c). The watch-list state the admin page's
// health module renders: each entry's last_checked_at / baselined / last_error,
// its pending-flag count, plus the overall last-run timestamp (newest
// last_checked_at across the watch list). No writes. Returns { lastRun: null,
// watch: [] } with no DB.
async function getDetectionHealth() {
  const p = getPool();
  if (!p) return { lastRun: null, watch: [] };

  const rows = await getWatchList(); // real-first, test-last; carries the fields we need
  const counts = await p.query(
    "SELECT watch_id, COUNT(*)::int AS n FROM spec_review_queue WHERE status = 'pending' GROUP BY watch_id"
  );
  const byWatch = new Map();
  for (const c of counts.rows) byWatch.set(String(c.watch_id), c.n);

  const lr = await p.query('SELECT MAX(last_checked_at) AS last_run FROM spec_watch_list');
  const lastRun = (lr.rows && lr.rows[0] && lr.rows[0].last_run) || null;

  const watch = rows.map((r) => ({
    id: r.id,
    display_name: r.display_name,
    source_url: r.source_url,
    is_test: r.is_test,
    last_checked_at: r.last_checked_at || null,
    baselined: !!r.current_hash,
    last_error: r.last_error || null,
    pending_count: byWatch.get(String(r.id)) || 0,
    // Anchor state, so "this entry isn't really being watched" is visible on the
    // health page and not only in a run's output. `null` for consecutive_failures
    // means the column isn't there yet (pre-migration), which is a different
    // thing from 0 and is rendered differently.
    anchored: !!(r.expected_content && String(r.expected_content).trim()),
    consecutive_failures: Object.prototype.hasOwnProperty.call(r, 'consecutive_failures')
      ? Number(r.consecutive_failures) || 0
      : null,
  }));

  return { lastRun, watch };
}

module.exports = {
  getWatchList,
  getReviewQueue,
  getTestPageContent,
  setTestPageContent,
  getDetectionHealth,
};
