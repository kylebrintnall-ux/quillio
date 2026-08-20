'use strict';

// Migration — spec_watch_list.content_stop_marker. SCHEMA ONLY, no data.
//
// THE PROBLEM. Meta's per-format spec pages SHUFFLE THE ORDER of their
// call-to-action list on every request. Same items, same count, permuted —
// measured at ~480-530 characters of churn on /image, /video and /carousel,
// against pages of ~4,200-5,600 normalized characters. The character limits and
// everything else are byte-identical between fetches.
//
// That is fatal to a hash watch and it is fatal SILENTLY: the hash moves, the
// confirming refetch produces a THIRD permutation, nothing ever reproduces, and
// the entry reports `unconfirmed` every run forever. Repeatable, silent,
// terminal — the same shape as the Google zwieback token that went five weeks
// without surfacing, and NOT fixable by the digit rule, because the varying
// region is words rather than a number.
//
// THE COLUMN. A string; the hashed text is everything BEFORE its first
// occurrence. NULL (the default, and every row today) means no truncation and
// byte-identical behaviour to before this migration.
//
//   content_stop_marker   TEXT, nullable. NULL = hash the whole normalized page.
//
// Both Meta rows will carry "View available calls to action". Every spec number
// on those pages appears before it, so the cut removes the shuffle and loses
// nothing that is watched for.
//
// WHY PER-ROW DATA AND NOT A RULE IN normalize(). A truncation marker inside
// normalize() would be one page's English chrome string hardcoded into a function
// shared by seven sources, where any other page containing that phrase
// mid-document would be silently cut. On the row it applies to the row that owns
// it, and NULL everywhere else means no other entry's hashable text changes by a
// single byte — so nothing else re-baselines. Same mechanism, opposite blast
// radius. That distinction is why the identical proposal was REJECTED for Google
// (where it would have been code) and accepted here (where it is data).
//
// A SET-BUT-ABSENT MARKER IS A FAILURE, NOT A FALLBACK. specDetector routes it to
// status 'failed', exactly as a missed anchor. Falling back to the full page would
// silently reintroduce the shuffle with nothing naming the cause, which is the bug
// this exists to remove.
//
// SEQUENCING: safe in either order relative to the deploy. src/db/specWatch.js
// gains a tier that SELECTs this column and falls back to the existing query when
// it is absent, so a pre-migration database behaves exactly as it does today.
//
// This migration does NOT touch the Meta rows — that is
// scripts/migrateSplitMetaWatchRows.js, which needs this column to exist first.
//
// Dry run by default: applies inside a transaction, prints the state, ROLLBACKs.
// --commit writes. Idempotent (IF NOT EXISTS).
//
// Run in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateAddContentStopMarker.js            # dry run
//   node scripts/migrateAddContentStopMarker.js --commit   # write

const TAG = '[stop-marker]';
const COMMIT = process.argv.includes('--commit');

const STATEMENTS = [
  [
    'spec_watch_list.content_stop_marker',
    'ALTER TABLE spec_watch_list ADD COLUMN IF NOT EXISTS content_stop_marker TEXT',
  ],
];

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(`${TAG} DATABASE_URL is not set.`);
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error(`${TAG} could not load "pg" — is it installed? ${err.message}`);
    process.exit(1);
  }

  const client = new Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();
  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  try {
    await client.query('BEGIN');

    for (const [name, sql] of STATEMENTS) {
      await client.query(sql);
      console.log(`${TAG} ensured column: ${name}`);
    }

    // Confirmation read. Every row should report NULL — this migration seeds
    // nothing, and a non-NULL here would mean somebody set a marker by hand.
    const res = await client.query(
      `SELECT id, display_name, source_url, content_stop_marker
         FROM spec_watch_list ORDER BY is_test, display_name NULLS LAST, id`
    );
    const set = res.rows.filter((r) => r.content_stop_marker);
    console.log(`${TAG} watch rows: ${res.rowCount}, with a marker set: ${set.length} (expected 0)`);
    for (const r of res.rows) {
      console.log(`  #${r.id} ${String(r.display_name || '(no name)').padEnd(24)} ${r.content_stop_marker === null ? 'NULL' : JSON.stringify(r.content_stop_marker)}`);
    }

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`${TAG} COMMITTED.`);
      console.log(`${TAG} next: node scripts/migrateSplitMetaWatchRows.js --verify`);
    } else {
      await client.query('ROLLBACK');
      console.log(`${TAG} DRY RUN — rolled back. Re-run with --commit to write.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`${TAG} FAILED, rolled back: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
