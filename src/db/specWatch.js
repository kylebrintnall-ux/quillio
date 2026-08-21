'use strict';

// LiveSpecs data-layer accessors. Reads for the two global spec tables
// (spec_watch_list, spec_review_queue) used by the admin JSON endpoints, plus
// the editable test-page store (chunk 2). Degrades gracefully when DATABASE_URL
// is unset (reads return [] / null), matching the rest of db/. The detector's
// hash/flag writes live in services/specDetector.js, not here.

const { getPool, isUndefinedColumn, warnMissingSchema } = require('../db');

const WATCH_ORDER = 'ORDER BY is_test, display_name NULLS LAST, id';
const WATCH_BASE = `id, source_url, display_name, affected_fields, current_hash,
            last_checked_at, last_error, is_test, created_at`;

// Three independent migrations have added columns here, and a person can be in
// any state between them. Tried newest-first; a 42703 falls to the next tier.
//
// The row a tier returns LACKS THE KEYS its tier dropped, and the detector reads
// key presence to decide what it may write — so a fallback must never default
// the missing columns in. "Column absent" and "column present and NULL" are
// different states (an unseeded anchor is the latter) and only one of them means
// "do not write here".
//
// One tier per migration, newest first, rather than one per combination: a
// database that ran a later migration and not an earlier one degrades all the
// way past both. That requires running them out of the documented order, and
// degrading further than strictly necessary is safe — it writes less, never
// wrongly. The one thing it must never do is default a missing column IN.
const ANCHOR_COLS = 'expected_content, anchor_scope, consecutive_failures';
const UNCONFIRMED_COLS = 'consecutive_unconfirmed, last_unconfirmed_reason';
const STOP_MARKER_COL = 'content_stop_marker';
const WATCH_TIERS = [
  { extra: `${ANCHOR_COLS}, ${UNCONFIRMED_COLS}, source_kind, ${STOP_MARKER_COL}` },
  {
    extra: `${ANCHOR_COLS}, ${UNCONFIRMED_COLS}, source_kind`,
    missing: ['spec_watch_list.content_stop_marker', 'scripts/migrateAddContentStopMarker.js'],
  },
  {
    extra: `${ANCHOR_COLS}, ${UNCONFIRMED_COLS}`,
    missing: ['spec_watch_list.source_kind', 'scripts/migrateAddSourceKind.js'],
  },
  {
    extra: ANCHOR_COLS,
    missing: ['spec_watch_list.consecutive_unconfirmed', 'scripts/migrateAddUnconfirmedTracking.js'],
  },
  {
    extra: null,
    missing: ['spec_watch_list.expected_content', 'scripts/migrateAddSpecAnchors.js'],
  },
];

// All watch-list rows (the URLs being monitored). Ordered real-entries-first,
// test entries last. Returns [] when there's no DB.
async function getWatchList() {
  const p = getPool();
  if (!p) return [];
  let lastErr = null;
  for (const tier of WATCH_TIERS) {
    const cols = tier.extra ? `${WATCH_BASE}, ${tier.extra}` : WATCH_BASE;
    try {
      const res = await p.query(`SELECT ${cols} FROM spec_watch_list ${WATCH_ORDER}`);
      if (tier.missing) warnMissingSchema(tier.missing[0], tier.missing[1]);
      return (res && res.rows) || [];
    } catch (err) {
      if (!isUndefinedColumn(err)) throw err;
      lastErr = err;
    }
  }
  // Even the base columns are missing — that is not a pre-migration deploy,
  // it is a broken table, and swallowing it would report an empty watch list.
  throw lastErr;
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
  const byWatch = await pendingByWatch(p);

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
    pending_count: (byWatch.get(String(r.id)) || EMPTY_PENDING).n,
    // When the OLDEST unreviewed flag was raised. Additive for this page; the
    // settings library needs it, because "this page changed on <date> and is
    // waiting on review" is the one withdrawal that can carry a real event date.
    pending_since: (byWatch.get(String(r.id)) || EMPTY_PENDING).since,
    // An observed_practice row is not hash-watched at all, so every health column
    // beside it is historical from the moment it was reclassified. The page has
    // to say which rows they no longer describe, or they read as current.
    source_kind: r.source_kind === 'observed_practice' ? 'observed_practice' : 'platform_enforced',
    // Anchor state, so "this entry isn't really being watched" is visible on the
    // health page and not only in a run's output. `null` for consecutive_failures
    // means the column isn't there yet (pre-migration), which is a different
    // thing from 0 and is rendered differently.
    anchored: !!(r.expected_content && String(r.expected_content).trim()),
    consecutive_failures: Object.prototype.hasOwnProperty.call(r, 'consecutive_failures')
      ? Number(r.consecutive_failures) || 0
      : null,
    // Stability. An entry stuck on `unconfirmed` is read fine every week and
    // still not watched, and it is the one state that leaves no error behind —
    // so the streak and its reason are what the health page has to render.
    consecutive_unconfirmed: Object.prototype.hasOwnProperty.call(r, 'consecutive_unconfirmed')
      ? Number(r.consecutive_unconfirmed) || 0
      : null,
    unconfirmed_reason: r.last_unconfirmed_reason || null,
  }));

  return { lastRun, watch };
}

const EMPTY_PENDING = { n: 0, since: null };

// Unreviewed flags per watch row: how many, and when the oldest was raised.
// Shared by both readers below so a count on one surface cannot disagree with a
// count on the other.
async function pendingByWatch(p) {
  const res = await p.query(
    `SELECT watch_id, COUNT(*)::int AS n, MIN(detected_at) AS since
       FROM spec_review_queue WHERE status = 'pending' GROUP BY watch_id`
  );
  const m = new Map();
  for (const r of res.rows) m.set(String(r.watch_id), { n: r.n, since: r.since || null });
  return m;
}

// THE TENANT-SAFE VIEW of the same state, keyed by source_url — what the settings
// library joins onto a field's spec_source.
//
// spec_watch_list has NO tenant_id, deliberately: platform specs are universal.
// So this is not an authorization boundary, it is a DETAIL boundary, and the
// difference is what these omissions are about:
//
//   last_error's TEXT      raw fetch failures, HTTP status, possibly internal
//                          hostnames. The tenant gets the fact, not the string.
//   current_hash           meaningless to a reader and an internal detail.
//   affected_fields        the write gate. Nothing tenant-facing reads it.
//   the is_test row        /admin/test-spec is fake seed data and is not a page
//                          any tenant's field is cited to.
//
// Booleans and dates only, so a future field added to the health row cannot leak
// onto a tenant surface by being picked up automatically.
async function getWatchStateBySource() {
  const p = getPool();
  if (!p) return new Map();
  const rows = await getWatchList();
  const pending = await pendingByWatch(p);
  const out = new Map();
  for (const r of rows) {
    if (r.is_test) continue;
    const pend = pending.get(String(r.id)) || EMPTY_PENDING;
    out.set(String(r.source_url), {
      lastCheckedAt: r.last_checked_at || null,
      baselined: !!r.current_hash,
      // Pre-migration these columns are ABSENT, not null, and the honest
      // degradation is to report what can be read: with no expected_content
      // column nothing anchors any row, which is exactly what `anchored: false`
      // says. See WATCH_TIERS above for why absence is not defaulted in.
      anchored: !!(r.expected_content && String(r.expected_content).trim()),
      hasError: !!r.last_error,
      pendingCount: pend.n,
      pendingSince: pend.since,
      failures: Number(r.consecutive_failures) || 0,
      unconfirmed: Number(r.consecutive_unconfirmed) || 0,
      sourceKind: r.source_kind === 'observed_practice' ? 'observed_practice' : 'platform_enforced',
    });
  }
  return out;
}

module.exports = {
  getWatchList,
  getReviewQueue,
  getTestPageContent,
  setTestPageContent,
  getDetectionHealth,
  // The tenant-facing subset of the same rows. Derived from getWatchList, like
  // getDetectionHealth, so the two views cannot describe different states.
  getWatchStateBySource,
};
