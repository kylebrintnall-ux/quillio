'use strict';

// Migration — spec_sweep_state: where the spec correction sweep got to.
//
// WHY A TABLE AND NOT A DERIVED VALUE. The sweep processes spec_change_log rows
// newer than the last one it finished, so it needs a durable high-water mark.
// The tempting alternative is to derive it — "the newest spec-change notification
// we have written" — and that is WRONG for a reason that only shows up after an
// outage: notifications are filtered to the last seven days (db/notifications.js
// WINDOW_DAYS), so a sweep that had not run for eight would find no notification,
// derive an empty watermark, and re-sweep from the beginning of time. Every
// document it had already corrected would be re-opened and every notification
// re-written. A watermark has to outlive the thing it is inferred from, so it
// gets its own row.
//
// A SINGLETON ROW, not a log. `id SMALLINT PRIMARY KEY DEFAULT 1` with a CHECK
// pinning it to 1: there is exactly one sweep and exactly one place it got to.
// The row is seeded here so the sweep never has to branch on "no row yet" — it
// reads a row whose watermark columns are NULL, and NULL means "nothing has been
// swept", which is the correct starting state.
//
// THE WATERMARK IS A TUPLE, (last_changed_at, last_change_id), and both columns
// are load-bearing. spec_change_log.changed_at defaults to NOW(), which in
// Postgres is the TRANSACTION timestamp — so every row written by one
// specReview.commitReview call carries the IDENTICAL timestamp (that function
// writes one row per changed attribute inside a single BEGIN/COMMIT). A
// timestamp-only watermark with a `>` comparison would therefore be ambiguous the
// moment a run stopped part-way through such a group: resuming at
// `changed_at > ts` skips the rest of the group, and `>=` re-processes the part
// already done. Comparing `(changed_at, id) > (ts, id)` is exact in both
// directions and needs no tie-breaking rule anywhere in the sweep.
//
// WHAT last_run_status IS FOR. A run that fails part-way leaves the watermark at
// the last CHANGE IT FULLY FINISHED, deliberately — see services/specSweep.js.
// This column records that the run was partial so an operator reading the table
// can tell "nothing changed this week" from "we stopped early and there is more
// waiting", which the watermark alone cannot say.
//
// Purely additive: one new table, nothing existing is read or written. Safe in
// either deploy order — db/specSweep.js catches 42P01 and reports the sweep as
// not-ready rather than crashing the cron service, exactly as db/notifications.js
// does (CLAUDE.md: "either deploy order is safe").
//
// Idempotent (IF NOT EXISTS + ON CONFLICT DO NOTHING). Dry run by default;
// --commit writes.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateAddSpecSweepState.js            # dry run
//   node scripts/migrateAddSpecSweepState.js --commit   # write

const { Pool } = require('pg');

const TAG = '[spec-sweep-state]';
const COMMIT = process.argv.includes('--commit');

const STATEMENTS = [
  [
    'spec_sweep_state',
    // TIMESTAMPTZ to match spec_change_log.changed_at exactly — comparing a
    // timestamptz against a timestamp would silently reinterpret one of them in
    // the server's local zone, and the watermark is the one value in this feature
    // where an hour of drift means re-sweeping or skipping real changes.
    `CREATE TABLE IF NOT EXISTS spec_sweep_state (
       id               SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
       last_changed_at  TIMESTAMPTZ,
       last_change_id   BIGINT,
       last_run_at      TIMESTAMPTZ,
       last_run_status  TEXT,
       last_run_note    TEXT
     )`,
  ],
  [
    'spec_sweep_state seed row',
    // NULL watermark = nothing swept yet. Seeding here rather than on first run
    // means the sweep only ever UPDATEs, so two overlapping runs cannot both
    // insert.
    'INSERT INTO spec_sweep_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING',
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
        WHERE table_name = 'spec_sweep_state'
        ORDER BY ordinal_position`
    );
    console.log(`\n${TAG} columns:`);
    for (const r of cols.rows) {
      console.log(`  ${r.column_name.padEnd(17)} ${r.data_type.padEnd(26)} null=${r.is_nullable}`);
    }

    // What the first run will face. A large pending count on an existing database
    // is expected and not a problem — it is every approval ever made — but it is
    // worth seeing before the sweep runs rather than after.
    const state = await client.query('SELECT * FROM spec_sweep_state WHERE id = 1');
    const pending = await client.query(
      `SELECT count(*)::int AS n FROM spec_change_log WHERE field_attr = 'char_max'`
    );
    const manifests = await client.query(
      `SELECT count(*)::int AS total,
              count(field_manifest)::int AS with_manifest
         FROM projects WHERE status IS DISTINCT FROM 'finished'`
    );
    const m = manifests.rows[0];
    console.log(
      `\n${TAG} watermark: ${state.rows[0] && state.rows[0].last_changed_at ? state.rows[0].last_changed_at.toISOString() : 'NULL (nothing swept yet)'}`
    );
    console.log(`${TAG} char_max changes in spec_change_log: ${pending.rows[0].n}`);
    console.log(
      `${TAG} unfinished projects: ${m.total} (${m.with_manifest} with a manifest, ` +
        `${m.total - m.with_manifest} pre-manifest and skippable)`
    );

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n${TAG} COMMITTED.`);
    } else {
      await client.query('ROLLBACK');
      console.log(`\n${TAG} rolled back (dry run). Re-run with --commit to apply.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`${TAG} FAILED:`, err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
