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

// --- The dates the doc renders ------------------------------------------------
//
// WHICH WATCHED PAGES ARE CURRENTLY IN A STATE WORTH CITING A DATE FOR.
//
// Returns Map<source_url, last_checked_at> holding ONLY rows that pass every
// freshness test. A field whose spec_source is absent from the map renders
// exactly as it does today — no clause, no placeholder.
//
// THE PREDICATE, clause by clause, and what each one stops:
//
//   source_kind = 'platform_enforced'  excludes both Litmus rows. They are never
//                                      fetched, so their timestamp is a fossil
//                                      from before they were reclassified.
//   expected_content non-empty         EXCLUDES NOTHING TODAY — every platform
//                                      row is anchored, `unanchored` reads 0. It
//                                      has become a GUARD rather than a filter: a
//                                      watch row is BORN unanchored (the
//                                      CANDIDATES table in migrateAddSpecAnchors
//                                      deliberately seeds nothing until someone
//                                      measures), so without this the next row
//                                      added starts publishing dates from its
//                                      first baseline. Do not remove it as dead
//                                      weight.
//   current_hash IS NOT NULL           a row that has never baselined has never
//                                      compared anything.
//   last_error IS NULL                 excludes `error` and `failed`.
//   consecutive_failures = 0           redundant with last_error today, kept
//                                      because only the counter is guaranteed to
//                                      be reset on every success path.
//   consecutive_unconfirmed = 0        THE ONE last_error CANNOT DO.
//                                      bumpUnconfirmed CLEARS last_error while
//                                      incrementing this, so a row stuck the way
//                                      Google was for five weeks reads pristine
//                                      on every other column.
//   last_checked_at within 35 days     a stopped cron freezes every other column
//                                      in its last good state, and nothing else
//                                      here notices. Five missed weekly runs.
//   is_test = false                    the test page is healthy and anchored and
//                                      describes no platform's limits.
//   no pending flag                    the page changed and the stored number is
//                                      under review. "Unchanged as of" is exactly
//                                      the claim that is not true then.
//
// NO STOP-MARKER CLAUSE, DELIBERATELY. Both marker failures are already covered
// and covered better: a marker that goes missing makes the row `failed`, which
// sets last_error and the failure counter; a marker that stops covering the whole
// varying region makes the hash vary, which increments the unconfirmed counter. A
// set marker is also NOT treated as a positive signal — it records something
// about the PAGE (it has a region that moves), not about the quality of the
// check, and rewarding it would score a row on a well-behaved page below one on a
// badly behaved page somebody worked around.
const CHECKED_SOURCES_SQL = `
  SELECT source_url, last_checked_at
    FROM spec_watch_list w
   WHERE w.source_kind = 'platform_enforced'
     AND w.expected_content IS NOT NULL
     AND btrim(w.expected_content) <> ''
     AND w.current_hash IS NOT NULL
     AND w.last_error IS NULL
     AND w.last_checked_at IS NOT NULL
     AND w.last_checked_at >= NOW() - INTERVAL '35 days'
     AND COALESCE(w.consecutive_failures, 0) = 0
     AND COALESCE(w.consecutive_unconfirmed, 0) = 0
     AND w.is_test = false
     AND NOT EXISTS (SELECT 1 FROM spec_review_queue q
                      WHERE q.watch_id = w.id AND q.status = 'pending')`;

// Ten minutes. The underlying data changes at most weekly (the detector's cron),
// so this is long enough that a burst of document builds shares one read and
// short enough that an admin who has just run detection sees the effect without a
// redeploy. Nothing about correctness depends on the number.
const CHECKED_TTL_MS = 10 * 60 * 1000;

// ONE cache for every tenant, and that is correct HERE and almost nowhere else in
// db/. spec_watch_list has no tenant_id — deliberately, because platform specs
// are universal — so there is nothing to key by and nothing to leak.
let checkedCache = null;

// FAIL CLOSED. This is the OPPOSITE of the progressive fallback used by
// getWatchList above and by getTenantAssets, and the inversion is the point.
//
// Those degrade by SELECTing fewer columns, because there a missing column costs
// INFORMATION that has a safe default (no fact_kind, nothing overridden). Here a
// missing column costs a GUARANTEE, and a guarantee has no safe default: dropping
// `consecutive_unconfirmed` from the query because the column is absent would
// publish a confident date for a row stuck exactly the way Google was.
//
// So there is ONE query naming every freshness column and NO lower tier. Any
// failure — 42703 undefined_column, 42P01 undefined_table, permissions,
// connectivity — returns an EMPTY MAP, which resolves to no date on every field,
// which is byte-identical to the pre-change document.
//
// It never rethrows. getTenantAssets returning null makes generateDoc throw, so
// an error escaping here would stop every document being built over a cosmetic
// line.
async function getCheckedSourceDates() {
  const now = Date.now();
  if (checkedCache && checkedCache.expires > now) return checkedCache.value;
  const p = getPool();
  if (!p) return new Map();
  let value = new Map();
  try {
    const res = await p.query(CHECKED_SOURCES_SQL);
    value = new Map((res.rows || []).map((r) => [r.source_url, r.last_checked_at]));
  } catch (err) {
    // Logged once per TTL, not swallowed silently: a connectivity or permissions
    // failure that merely removes an italic clause should still be visible.
    console.warn('[db/specWatch] checked-source dates unavailable, rendering none:', err.message);
    value = new Map();
  }
  // The FAILURE is cached too, for the same interval. Otherwise a database in a
  // bad state adds a failing query to every document build. The cost is that
  // dates stay absent for up to ten minutes after recovery, which is the right
  // trade for a line nothing depends on.
  checkedCache = { value, expires: now + CHECKED_TTL_MS };
  return value;
}

module.exports = {
  getWatchList,
  getReviewQueue,
  getTestPageContent,
  setTestPageContent,
  getDetectionHealth,
  getCheckedSourceDates,
};
