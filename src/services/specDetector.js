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
// SAFETY: this NEVER writes to copy_fields or any spec/field data. It only
//   - updates spec_watch_list (current_hash, last_checked_at, last_error), and
//   - inserts spec_review_queue rows (flags) on a CONFIRMED change.
// A fetch failure updates last_checked_at + last_error only — it never flags and
// never overwrites a good current_hash, so a failed fetch can't look like a
// change. is_test is inherited onto the flag row so test-page changes stay
// structurally isolated from real specs.

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
      'UPDATE spec_watch_list SET current_hash = $1, last_checked_at = NOW(), last_error = NULL WHERE id = $2',
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

// Run the detector over every watch entry. Returns a per-URL summary so the
// caller (the admin endpoint) can show what happened. Never throws for a single
// bad URL — that row is reported as status:'error' and the run continues.
async function runDetection() {
  const pool = getPool();
  if (!pool) return { ran: false, reason: 'no-database', summary: {}, results: [] };

  const rows = await getWatchList();
  const results = [];
  const summary = { total: rows.length, baseline: 0, unchanged: 0, changed: 0, unconfirmed: 0, error: 0 };

  for (const row of rows) {
    const checkedAt = new Date().toISOString();
    let status;
    let error = null;
    try {
      const html = await fetchText(row.source_url);
      const newHash = hashText(normalize(html));

      if (!row.current_hash) {
        // First ever check → record the baseline. Nothing to compare to, so no flag.
        await pool.query(
          'UPDATE spec_watch_list SET current_hash = $1, last_checked_at = NOW(), last_error = NULL WHERE id = $2',
          [newHash, row.id]
        );
        status = 'baseline';
      } else if (row.current_hash === newHash) {
        // Unchanged → just bump last_checked_at (and clear any stale error).
        await pool.query(
          'UPDATE spec_watch_list SET last_checked_at = NOW(), last_error = NULL WHERE id = $1',
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
            'UPDATE spec_watch_list SET last_checked_at = NOW(), last_error = NULL WHERE id = $1',
            [row.id]
          );
          status = 'unconfirmed';
        }
      }
    } catch (err) {
      // Fetch/processing failure: record it, DON'T flag, DON'T touch current_hash.
      error = err.message || String(err);
      try {
        await pool.query(
          'UPDATE spec_watch_list SET last_checked_at = NOW(), last_error = $1 WHERE id = $2',
          [error, row.id]
        );
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
    });
    console.log(`[detector] ${row.display_name}: ${status}${error ? ` (${error})` : ''}`);
  }

  return { ran: true, summary, results };
}

module.exports = { runDetection, normalize, hashText, fetchText };
