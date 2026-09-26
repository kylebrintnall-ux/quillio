'use strict';

// Migration — detection_runs: one row per detection run, written BY THE RUN.
//
// WHY THIS EXISTS. Until now a detection run's summary was printed to whichever
// process ran it and then discarded — scripts/runDetection.js logs it and exits.
// The admin page's "last run" was not a run at all: it was MAX(last_checked_at)
// over the watch rows, the most recent moment any single page was touched. So the
// console could not answer the three questions it exists for — when did checks
// happen, what did they find, and was the agentic reader even on — because nothing
// had kept the answers.
//
// And that last question is not hypothetical. GEMINI_API_KEY was set on the web
// service and not the cron service, every weekly run stored a NULL proposal, and
// nothing anywhere said so. summary.reader now states it on every run; this table
// is what lets a page SHOW it honestly. The rule (CLAUDE.md) is that a health
// signal about a scheduled job must be emitted by that job, not computed by a
// sibling reading its own environment. A row the run wrote about itself satisfies
// that: the page only displays it.
//
// OPENED AT THE START, CLOSED AT THE END — and the gap between them is a feature.
// runDetection inserts the row before it fetches anything and fills in
// finished_at, summary and results when it finishes. A run that dies partway —
// an uncaught throw, or the container killed, which on a restartPolicyType: NEVER
// service means no detection until next week — leaves a row with started_at and
// NO finished_at. The console shows that as a run that did not finish. Written
// only at the end, the same crash would leave no row at all, which reads exactly
// like a week in which nothing ran. (CLAUDE.md, "The one decision rule that
// recurs": take the visible failure.)
//
//   trigger     'scheduled'  scripts/runDetection.js --scheduled (the cron)
//               'script'     scripts/runDetection.js without the flag — the cron
//                            OR a console run; deliberately not claimed as either
//               'admin'      the admin page: Run detection now, and each
//                            row's Check now (the web process, either way)
//               'unknown'    any other caller
//   watch_id    NULL for a full run; the entry id for a scoped one. No foreign key:
//               this is history, and it must outlive a deleted watch row.
//   reader      'on' | 'off' — whether the agentic reader could run at all.
//   summary     the run's summary object, exactly as it is logged.
//   results     the per-entry results array, exactly as it is returned.
//
// NEVER A REASON FOR A RUN TO FAIL. Both writes are caught in the detector; a
// missing table (42P01) warns once and the run proceeds unrecorded. So a deploy
// landing before this migration detects exactly as it always did, and either
// deploy order is safe.
//
// Idempotent (IF NOT EXISTS). Dry run by default; --commit writes.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateAddDetectionRuns.js            # dry run
//   node scripts/migrateAddDetectionRuns.js --commit   # write

const { Pool } = require('pg');

const TAG = '[detection-runs]';
const COMMIT = process.argv.includes('--commit');

// TIMESTAMPTZ, like every other timestamp the detector writes — a plain TIMESTAMP
// would be reinterpreted in the server's local zone, and this table is compared
// against a cron slot evaluated in UTC.
const STATEMENTS = [
  [
    'detection_runs',
    `CREATE TABLE IF NOT EXISTS detection_runs (
       id           BIGSERIAL PRIMARY KEY,
       started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       finished_at  TIMESTAMPTZ,
       trigger      TEXT NOT NULL,
       watch_id     BIGINT,
       reader       TEXT,
       summary      JSONB,
       results      JSONB
     )`,
  ],
  [
    'detection_runs_started_at_idx',
    'CREATE INDEX IF NOT EXISTS detection_runs_started_at_idx ON detection_runs (started_at DESC)',
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
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString, ssl: sslFor(connectionString) });
  const client = await pool.connect();
  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  try {
    await client.query('BEGIN');
    for (const [label, sql] of STATEMENTS) {
      await client.query(sql);
      console.log(`  ok  ${label}`);
    }

    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'detection_runs'
        ORDER BY ordinal_position`
    );
    console.log(`\n${TAG} detection_runs:`);
    for (const r of cols.rows) {
      console.log(`  ${r.column_name.padEnd(12)} ${r.data_type}${r.is_nullable === 'NO' ? ' NOT NULL' : ''}`);
    }

    const n = await client.query('SELECT count(*)::int AS n FROM detection_runs');
    console.log(`\n${TAG} ${n.rows[0].n} run(s) recorded.`);
    console.log(`${TAG} The table starts EMPTY, and that is the honest state: no run before this`);
    console.log(`${TAG} migration was ever recorded, so the console will show "can't tell" for any`);
    console.log(`${TAG} scheduled slot older than the first run written after it.`);

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n${TAG} COMMITTED.`);
    } else {
      await client.query('ROLLBACK');
      console.log(`\n${TAG} ROLLED BACK (dry run) — no changes were written. Re-run with --commit to apply.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\n${TAG} ROLLED BACK — nothing was written.`);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${TAG} FAILED:`, err.message);
    process.exit(1);
  });
