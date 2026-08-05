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
// SAFETY: this NEVER writes to copy_fields or any spec/field data. It only
//   - updates spec_watch_list (current_hash, last_checked_at, last_error,
//     consecutive_failures), and
//   - inserts spec_review_queue rows (flags) on a CONFIRMED change.
// A fetch failure or a missed anchor updates last_checked_at + last_error +
// consecutive_failures only — it never flags and never overwrites a good
// current_hash, so neither can look like a change. is_test is inherited onto the
// flag row so test-page changes stay structurally isolated from real specs.
//
// Requires scripts/migrateAddSpecAnchors.js (expected_content, anchor_scope,
// consecutive_failures).

const crypto = require('crypto');
const { getPool } = require('../db');
const { getWatchList } = require('../db/specWatch');

const FETCH_TIMEOUT_MS = 10000;
// Delay before the confirmation refetch. Long enough that a per-request-varying
// page returns a different value; short enough to keep a run snappy. Overridable.
const REFETCH_DELAY_MS = Number(process.env.SPEC_REFETCH_DELAY_MS) || 1500;

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
      `UPDATE spec_watch_list SET current_hash = $1, last_checked_at = NOW(), last_error = NULL${resetFailures(row)} WHERE id = $2`,
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
  // `unanchored` is a SEPARATE axis, not a status: an entry can be unanchored and
  // unchanged at the same time, and both facts matter.
  const summary = { total: rows.length, baseline: 0, unchanged: 0, changed: 0, unconfirmed: 0, failed: 0, error: 0, unanchored: 0 };

  for (const row of rows) {
    const checkedAt = new Date().toISOString();
    let status;
    let error = null;
    let failures = null;
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
          `UPDATE spec_watch_list SET current_hash = $1, last_checked_at = NOW(), last_error = NULL${resetFailures(row)} WHERE id = $2`,
          [newHash, row.id]
        );
        status = 'baseline';
      } else if (row.current_hash === newHash) {
        // Unchanged → just bump last_checked_at (and clear any stale error).
        await pool.query(
          `UPDATE spec_watch_list SET last_checked_at = NOW(), last_error = NULL${resetFailures(row)} WHERE id = $1`,
          [row.id]
        );
        status = 'unchanged';
      } else {
        // Hash moved — but confirm it reproduces before flagging (chunk 2.5).
        // Refetch after a short delay; a genuine change gives the SAME newHash
        // again, transient noise gives a different one.
        let confirmHash = null;
        try {
          await sleep(REFETCH_DELAY_MS);
          confirmHash = hashText(normalize(await fetchText(row.source_url)));
        } catch (e) {
          // Couldn't refetch → can't confirm → treat as unconfirmed (no flag).
          confirmHash = null;
        }

        if (confirmHash && confirmHash === newHash) {
          // Reproduced → real change. Flag it (transaction), then advance the hash.
          await recordChange(pool, row, newHash);
          status = 'changed';
        } else {
          // Did not reproduce → transient noise. DON'T flag, DON'T advance the
          // baseline hash (leave current_hash where it was); just bump the check.
          await pool.query(
            `UPDATE spec_watch_list SET last_checked_at = NOW(), last_error = NULL${resetFailures(row)} WHERE id = $1`,
            [row.id]
          );
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

    summary[status] = (summary[status] || 0) + 1;
    results.push({
      watch_id: row.id,
      display_name: row.display_name,
      source_url: row.source_url,
      is_test: row.is_test,
      status,
      last_checked_at: checkedAt,
      error,
      anchored,
      consecutive_failures: failures,
    });
    console.log(
      `[detector] ${row.display_name}: ${status}${anchored ? '' : ' (no anchor)'}` +
        `${error ? ` (${error})` : ''}` +
        `${failures > 1 ? ` [${failures} consecutive failures]` : ''}`
    );
  }

  return { ran: true, summary, results };
}

module.exports = { runDetection, normalize, hashText, fetchText, checkAnchor };
