'use strict';

// LiveSpecs detector (chunk 2 + 2.5). For each spec_watch_list row: fetch the
// URL, normalize the HTML to visible text, hash it, and compare to the stored
// hash. Manual trigger only (POST /admin/api/run-detection) — NO cron.
//
// CONFIRM-ON-REFETCH (chunk 2.5): a changed hash is NOT flagged on the first
// observation. We refetch once after a short delay and only flag if the new
// hash reproduces. This filters transient per-request noise — dynamic widgets,
// counters, nonces that survive the tag strip and change on every fetch (e.g.
// Google's help pages) — while a genuine spec edit, which is stable, reproduces
// and flags. A change that doesn't reproduce is reported as 'unconfirmed': no
// flag, and the baseline hash is left untouched so it never advances to a noisy
// value.
//
// ANCHOR ASSERTION: before any hash comparison, an entry's expected_content (if
// it has one) must be present in the fetched page. If it isn't, the entry's
// status is 'failed' — a distinct status, not 'error' and emphatically not
// 'unchanged' — and consecutive_failures increments. See checkAnchor below for
// why a 200 response is not evidence that we read the right page.
//
// UNCONFIRMED IS NOT FREE EITHER. A page that genuinely changed AND varies per
// request reports 'unconfirmed' every run, forever, and never surfaces its
// change — repeatable, silent, terminal. So it carries its OWN streak
// (consecutive_unconfirmed) and its own reason, separate from
// consecutive_failures because the reset rules differ: an unconfirmed run
// CLEARS the failure count (we read the page, twice), while a failed or errored
// run leaves the unconfirmed streak untouched (a week we could not read says
// nothing about whether the page holds still).
//
// SAFETY: this NEVER writes to copy_fields or any spec/field data. It only
//   - updates spec_watch_list (current_hash, last_checked_at, last_error,
//     consecutive_failures, consecutive_unconfirmed, last_unconfirmed_reason),
//     and
//   - inserts spec_review_queue rows (flags) on a CONFIRMED change.
// A fetch failure or a missed anchor updates last_checked_at + last_error +
// consecutive_failures only — it never flags and never overwrites a good
// current_hash, so neither can look like a change. is_test is inherited onto the
// flag row so test-page changes stay structurally isolated from real specs.
//
// Requires scripts/migrateAddSpecAnchors.js (expected_content, anchor_scope,
// consecutive_failures) and scripts/migrateAddUnconfirmedTracking.js
// (consecutive_unconfirmed, last_unconfirmed_reason). Both are tolerated absent.

const crypto = require('crypto');
const { getPool } = require('../db');
const { getWatchList } = require('../db/specWatch');

const FETCH_TIMEOUT_MS = 10000;
// Delay before the confirmation refetch. Long enough that a per-request-varying
// page returns a different value; short enough to keep a run snappy. Overridable.
// Read with Number.isFinite rather than `|| 1500`, so 0 means 0 — the obvious
// value to set when you want a run to go fast, and the one `||` silently turns
// back into the default.
const REFETCH_DELAY_MS = (() => {
  const raw = Number(process.env.SPEC_REFETCH_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
})();

// A streak of unconfirmed runs stops being noise and becomes "we cannot watch
// this page" at three. The confirm step EXISTS to absorb one-off noise, so 1 is
// the design working and 2 is two bad Mondays; 3 consecutive weekly runs is a
// month in which the entry has produced no usable comparison, and it is the
// smallest number that cannot be coincidence. The streak is REPORTED from 1
// upward — only the alert is held to this threshold, so a row climbing toward it
// is visible on the way rather than appearing fully formed after a month.
const UNCONFIRMED_STREAK_ALERT = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Normalize HTML to the visible text we hash. Middle-ground strip: drop
// <script>/<style> blocks AND their contents (noise that changes constantly),
// strip all remaining tags, collapse every run of whitespace to a single space,
// and trim. Keeps visible text — that's where spec numbers live — so real
// content changes are caught while scripts/ads/whitespace churn are not.
function normalize(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// sha256 of the normalized text, hex.
function hashText(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// ANCHOR ASSERTION — did we actually read the page, or something standing where
// it should be?
//
// fetchText only throws on a non-2xx or a timeout, so a 200 serving a soft-404,
// an auth interstitial or a JS shell with no rendered content flows straight down
// the success path. Its normalized text is empty or generic, it hashes to a
// constant, and the entry reports "unchanged" every week — confidently, forever.
// Worse on a first run: sha256('') gets stored as the legitimate baseline and
// every later run agrees with it.
//
// So each row carries a string that must be present for the fetch to count as a
// read. `raw` checks the response body, `normalized` (the default) checks the
// text that is actually hashed. That choice is PER ROW because both are wrong for
// some page: normalize() strips <script> and its contents, so an anchor living
// only in a JSON island vanishes on a page that is perfectly healthy — and raw
// HTML carries every nav label and meta tag, so a generic anchor survives on an
// error page sharing the site's chrome.
//
// NO ANCHOR IS NOT A PASS AND NOT A FAILURE. { ok: true, anchored: false } — the
// entry is fetched, hashed and compared exactly as before, so nothing stops being
// watched, and the caller counts it as unanchored so the gap is visible in the
// run rather than absent from it.
function checkAnchor(row, raw, normalized) {
  const anchor = row && typeof row.expected_content === 'string' ? row.expected_content.trim() : '';
  if (!anchor) return { ok: true, anchored: false, anchor: null };
  const scope = row.anchor_scope === 'raw' ? 'raw' : 'normalized';
  const hay = scope === 'raw' ? String(raw || '') : String(normalized || '');
  return { ok: hay.includes(anchor), anchored: true, anchor, scope };
}

// Fetch a URL as text with a hard timeout. Throws on timeout or non-2xx so the
// caller routes it to the error branch.
async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Quillio-LiveSpecs/1.0 (spec-watch)' },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// PRE-MIGRATION TOLERANCE (CLAUDE.md, "Either deploy order is safe"). Railway
// auto-deploys main on merge, so this code runs against a database that has not
// had migrateAddSpecAnchors.js applied yet. getWatchList falls back to a SELECT
// without the three new columns in that case, so the row it returns LACKS THE
// KEY — which is how we tell "column absent" from "column present and NULL" (an
// unseeded anchor on a migrated database, which is a real and different state).
//
// With the columns absent we leave consecutive_failures out of the UPDATEs
// entirely. Nothing is watched less carefully than it was: no anchor can be
// configured on such a database, so every entry behaves exactly as it did
// before this change until the migration runs.
function hasAnchorColumns(row) {
  return !!row && Object.prototype.hasOwnProperty.call(row, 'consecutive_failures');
}

// The trailing SET fragment that clears the failure counter on a success path —
// or nothing at all, pre-migration.
function resetFailures(row) {
  return hasAnchorColumns(row) ? ', consecutive_failures = 0' : '';
}

// Same key-presence trick for the second migration. The two are independent —
// a database can have the anchor columns and not these — so they are tested
// separately rather than inferred from one another.
function hasUnconfirmedColumns(row) {
  return !!row && Object.prototype.hasOwnProperty.call(row, 'consecutive_unconfirmed');
}

// Clears the unconfirmed streak. Appended ONLY on a definite outcome — baseline,
// unchanged, changed. Deliberately NOT on failed or error: a week in which we
// could not read the page says nothing about whether the page holds still, so
// it must neither increment the streak nor reset it. That asymmetry is why this
// is a separate counter from consecutive_failures and not the same one.
function resetUnconfirmed(row) {
  return hasUnconfirmedColumns(row) ? ', consecutive_unconfirmed = 0, last_unconfirmed_reason = NULL' : '';
}

// The full SET fragment for a run that reached a definite answer.
function resetStreaks(row) {
  return `${resetFailures(row)}${resetUnconfirmed(row)}`;
}

// Record a detected change atomically: insert the flag, then advance the hash.
// Wrapped in a transaction so we never insert a flag but fail to move the hash
// (which would re-flag the same change on every subsequent run).
async function recordChange(pool, row, newHash) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO spec_review_queue (watch_id, source_url, old_hash, new_hash, detected_at, status, is_test)
         VALUES ($1, $2, $3, $4, NOW(), 'pending', $5)`,
      [row.id, row.source_url, row.current_hash, newHash, row.is_test]
    );
    await client.query(
      `UPDATE spec_watch_list SET current_hash = $1, last_checked_at = NOW(), last_error = NULL${resetStreaks(row)} WHERE id = $2`,
      [newHash, row.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Record a read that failed its anchor assertion, or failed to fetch at all.
// Writes last_error and INCREMENTS consecutive_failures; deliberately does NOT
// touch current_hash, so the last good baseline survives however long the
// failure lasts and a recovery compares against the right thing.
//
// The counter is the whole point. A wrongly-anchored entry stops being watched
// and says nothing while it does — "failed once" (the site had a bad morning)
// and "failed for six weeks" (the anchor is wrong, or the page is gone) look
// identical in a single run's output, and only the second needs a human.
// Every success path resets it to 0.
async function bumpFailure(pool, row, error) {
  if (!hasAnchorColumns(row)) {
    // Pre-migration: the counter has nowhere to live. Record the error exactly
    // as the detector always did and report null rather than a made-up count.
    await pool.query(
      'UPDATE spec_watch_list SET last_checked_at = NOW(), last_error = $1 WHERE id = $2',
      [error, row.id]
    );
    return null;
  }
  const res = await pool.query(
    `UPDATE spec_watch_list
        SET last_checked_at = NOW(),
            last_error = $1,
            consecutive_failures = COALESCE(consecutive_failures, 0) + 1
      WHERE id = $2
      RETURNING consecutive_failures`,
    [error, row.id]
  );
  return (res && res.rows && res.rows[0] && res.rows[0].consecutive_failures) || null;
}

// Record a run that read the page but could not get a stable comparison out of
// it. Clears last_error and consecutive_failures — we DID read the page, twice,
// so the URL and the anchor are demonstrably fine — while incrementing a streak
// of its own and storing WHY.
//
// Never touches current_hash. The baseline stays where it was, so it never
// advances to a value we could not reproduce.
async function bumpUnconfirmed(pool, row, reason) {
  if (!hasUnconfirmedColumns(row)) {
    // Pre-migration: exactly the write this branch always did.
    await pool.query(
      `UPDATE spec_watch_list SET last_checked_at = NOW(), last_error = NULL${resetFailures(row)} WHERE id = $1`,
      [row.id]
    );
    return null;
  }
  const res = await pool.query(
    `UPDATE spec_watch_list
        SET last_checked_at = NOW(),
            last_error = NULL${resetFailures(row)},
            consecutive_unconfirmed = COALESCE(consecutive_unconfirmed, 0) + 1,
            last_unconfirmed_reason = $1
      WHERE id = $2
      RETURNING consecutive_unconfirmed`,
    [reason, row.id]
  );
  return (res && res.rows && res.rows[0] && res.rows[0].consecutive_unconfirmed) || null;
}

// Run the detector over every watch entry. Returns a per-URL summary so the
// caller (the admin endpoint) can show what happened. Never throws for a single
// bad URL — that row is reported as status:'error' and the run continues.
async function runDetection() {
  const pool = getPool();
  if (!pool) return { ran: false, reason: 'no-database', summary: {}, results: [] };

  const rows = await getWatchList();
  const results = [];
  // `failed` is pre-seeded like the rest so a clean run reports 0 rather than
  // omitting the key — an absent count and a zero count read differently to
  // whoever is scanning the summary, and this is the one worth noticing.
  // `unanchored` and `stuck` are SEPARATE axes, not statuses: an entry can be
  // unanchored and unchanged at the same time, or unconfirmed this run and stuck
  // for a month, and in each case both facts matter.
  const summary = {
    total: rows.length,
    baseline: 0,
    unchanged: 0,
    changed: 0,
    unconfirmed: 0,
    failed: 0,
    error: 0,
    unanchored: 0,
    stuck: 0,
  };

  for (const row of rows) {
    let status;
    let error = null;
    let failures = null;
    let streak = null;
    let unconfirmedReason = null;
    // Read off the ROW, not off anchorInfo: an entry that never got as far as
    // the anchor check (the fetch threw) is not thereby "unanchored". Whether an
    // anchor is configured is a property of the entry and is true or false
    // before the run starts.
    const anchored = !!(row && typeof row.expected_content === 'string' && row.expected_content.trim());
    if (!anchored) summary.unanchored += 1;
    try {
      const html = await fetchText(row.source_url);
      const normalized = normalize(html);
      const newHash = hashText(normalized);

      // BEFORE ANY COMPARISON. A page that failed to read must not be able to
      // reach the baseline branch (where an empty page becomes the truth), the
      // unchanged branch (where it agrees with itself forever), or the changed
      // branch (where it would flag a real spec edit into existence out of an
      // error page).
      const anchorInfo = checkAnchor(row, html, normalized);
      if (!anchorInfo.ok) {
        // Name the string that missed, verbatim and quoted. The two ways an
        // anchor fails are "the page changed shape" and "the anchor was always
        // wrong", and you cannot tell them apart from a bare "anchor not found".
        error = `anchor not found in ${anchorInfo.scope} content: ${JSON.stringify(anchorInfo.anchor)}`;
        failures = await bumpFailure(pool, row, error);
        status = 'failed';
      } else if (!row.current_hash) {
        // First ever check → record the baseline. Nothing to compare to, so no flag.
        await pool.query(
          `UPDATE spec_watch_list SET current_hash = $1, last_checked_at = NOW(), last_error = NULL${resetStreaks(row)} WHERE id = $2`,
          [newHash, row.id]
        );
        status = 'baseline';
      } else if (row.current_hash === newHash) {
        // Unchanged → just bump last_checked_at (and clear any stale error).
        await pool.query(
          `UPDATE spec_watch_list SET last_checked_at = NOW(), last_error = NULL${resetStreaks(row)} WHERE id = $1`,
          [row.id]
        );
        status = 'unchanged';
      } else {
        // Hash moved — but confirm it reproduces before flagging (chunk 2.5).
        // Refetch after a short delay; a genuine change gives the SAME newHash
        // again, transient noise gives a different one.
        let confirmHash = null;
        // KEEP THE REASON. The refetch has two distinct ways of not confirming,
        // and discarding which one it was made every unconfirmed run look
        // identical: "this page has a nonce" and "the site was down for the 1.5
        // seconds between our two fetches" are the two answers, and a streak
        // counter is only actionable if the run also says which.
        let refetchError = null;
        try {
          await sleep(REFETCH_DELAY_MS);
          confirmHash = hashText(normalize(await fetchText(row.source_url)));
        } catch (e) {
          // Couldn't refetch → can't confirm → treat as unconfirmed (no flag).
          refetchError = e.message || String(e);
          confirmHash = null;
        }

        if (confirmHash && confirmHash === newHash) {
          // Reproduced → real change. Flag it (transaction), then advance the hash.
          //
          // NO SECOND ANCHOR CHECK HERE, AND THAT IS CORRECT — do not "fix" it.
          // confirmHash === newHash means the refetch produced the identical
          // normalized text to the first fetch, which checkAnchor already
          // verified. The refetch is implicitly anchored by the equality. A
          // checkAnchor call on this branch could never fail, i.e. it would be
          // dead code that reads like a safeguard.
          await recordChange(pool, row, newHash);
          status = 'changed';
        } else {
          // Did not reproduce. DON'T flag, DON'T advance the baseline hash.
          //
          // This is the one status that is repeatable, silent and terminal at
          // once: a page that genuinely changed AND varies per request reports
          // this every week, forever, and never surfaces its change. So it
          // carries its own streak — see bumpUnconfirmed.
          unconfirmedReason = refetchError ? `refetch failed: ${refetchError}` : 'page varies per request';
          streak = await bumpUnconfirmed(pool, row, unconfirmedReason);
          status = 'unconfirmed';
        }
      }
    } catch (err) {
      // Fetch/processing failure: record it, DON'T flag, DON'T touch current_hash.
      // Counts toward consecutive_failures for the same reason an anchor miss
      // does — a URL that has 404'd for six weeks is as unwatched as a wrongly
      // anchored one, and the run says so either way.
      error = err.message || String(err);
      try {
        failures = await bumpFailure(pool, row, error);
      } catch (e) {
        console.error(`[detector] could not record error for watch ${row.id}:`, e.message);
      }
      status = 'error';
    }

    // The streak AFTER this run, which is not always the one we just wrote:
    // a definite outcome cleared it to 0, an unconfirmed run returned the new
    // value, and failed/error left the stored value alone — deliberately, since
    // a week we could not read says nothing about whether the page holds still.
    let streakAfter;
    if (status === 'unconfirmed') streakAfter = streak;
    else if (status === 'failed' || status === 'error') {
      streakAfter = hasUnconfirmedColumns(row) ? Number(row.consecutive_unconfirmed) || 0 : null;
      // Carry the stored reason too, so a stuck entry that errors this week
      // still says what it was stuck ON rather than going quiet.
      unconfirmedReason = (streakAfter && row.last_unconfirmed_reason) || null;
    } else streakAfter = hasUnconfirmedColumns(row) ? 0 : null;

    // Same shape for the failure counter: what it IS after this run, not only
    // what this run wrote. A success path resets it, so 0 — and null still means
    // "the column isn't there". Reporting null-on-success next to a streak that
    // reports 0 would invite a reader to infer a difference that isn't there.
    if (failures === null && hasAnchorColumns(row)) failures = 0;

    summary[status] = (summary[status] || 0) + 1;
    if (streakAfter >= UNCONFIRMED_STREAK_ALERT) summary.stuck += 1;

    results.push({
      watch_id: row.id,
      display_name: row.display_name,
      source_url: row.source_url,
      is_test: row.is_test,
      status,
      // Stamped AFTER the work, not before it. The database gets NOW() at the
      // moment of the UPDATE, and a run with a refetch spends 1.5s between the
      // two — so a timestamp captured at the top of the loop had the run output
      // and the health page disagreeing by seconds about the same event.
      last_checked_at: new Date().toISOString(),
      error,
      anchored,
      consecutive_failures: failures,
      consecutive_unconfirmed: streakAfter,
      unconfirmed_reason: unconfirmedReason,
    });
    console.log(
      `[detector] ${row.display_name}: ${status}${anchored ? '' : ' (no anchor)'}` +
        `${error ? ` (${error})` : ''}` +
        `${failures > 1 ? ` [${failures} consecutive failures]` : ''}` +
        `${streakAfter ? ` [unconfirmed ${streakAfter} in a row: ${unconfirmedReason}]` : ''}` +
        `${streakAfter >= UNCONFIRMED_STREAK_ALERT ? ' — STUCK, this page is not being watched' : ''}`
    );
  }

  return { ran: true, summary, results };
}

module.exports = { runDetection, normalize, hashText, fetchText, checkAnchor, UNCONFIRMED_STREAK_ALERT };
