'use strict';

// Migration — make a permanently-unconfirmed watch entry visible.
//
// THE PROBLEM. `unconfirmed` is the one detector status that is repeatable,
// silent and terminal at the same time. A page whose hash moves and does not
// reproduce is not flagged, its baseline is not advanced, and — until this
// migration — nothing counted it. Worse, the unconfirmed branch clears
// last_error and resets consecutive_failures, so an entry that has produced no
// usable comparison for a month reads as perfectly healthy: no error, zero
// failures, last_checked_at bumped every week.
//
// A page that genuinely changed AND varies per request (Google's help pages are
// the case named in the detector's own header) therefore never surfaces its
// change. Ever. That is the same class of failure the anchor work addressed —
// repeatable, invisible, terminal.
//
// TWO COLUMNS:
//   consecutive_unconfirmed  runs in a row that produced no usable comparison.
//   last_unconfirmed_reason  WHICH of the two causes, because a counter without
//                            it says "six weeks of trouble" and stops there.
//
// WHY NOT REUSE consecutive_failures. The two counters have different RESET
// rules, and one field cannot hold both:
//
//   - An `unconfirmed` run is evidence the URL and the anchor are FINE — we
//     read the page, twice. It must CLEAR consecutive_failures, which it
//     already does. Sharing would make it increment the field it ought to
//     clear.
//   - An `error` week says nothing about whether the page holds still, so it
//     must leave the unconfirmed streak alone — neither incrementing nor
//     resetting. Sharing would count a site outage as instability.
//
// So consecutive_unconfirmed is reset only by a DEFINITE outcome (baseline,
// unchanged, changed) and is untouched by failed and error. An entry that goes
// unconfirmed twice, errors for three weeks, then unconfirmed again reads 3 —
// and 3 is the true answer: no stable comparison in six runs.
//
// THE TWO REASONS, both recorded verbatim by the detector:
//   'page varies per request'   the refetch succeeded and hashed differently —
//                               a nonce, a counter, a rotating widget. Or our
//                               own normalizer leaking a CDN cache timestamp
//                               into the hashed text (see CLAUDE.md, "Changing
//                               normalize() re-baselines every affected page").
//   'refetch failed: <reason>'  the refetch could not be made at all — the site
//                               was briefly down, rate-limited or blocked.
//
// SEPARATE FILE FROM migrateAddSpecAnchors.js on purpose. That script is
// written, reviewed and about to be run; editing a migration between the review
// and the run is how a script gets executed in a state nobody read. These two
// can be run in either order.
//
// Dry run by default: applies inside a transaction, prints the state, ROLLBACKs.
// --commit writes. Idempotent — the DDL is IF NOT EXISTS and there is no seed.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateAddUnconfirmedTracking.js            # dry run
//   node scripts/migrateAddUnconfirmedTracking.js --commit   # write

const { Pool } = require('pg');

const TAG = '[unconfirmed-tracking]';
const COMMIT = process.argv.includes('--commit');

const STATEMENTS = [
  [
    'spec_watch_list.consecutive_unconfirmed',
    'ALTER TABLE spec_watch_list ADD COLUMN IF NOT EXISTS consecutive_unconfirmed INTEGER NOT NULL DEFAULT 0',
  ],
  [
    'spec_watch_list.last_unconfirmed_reason',
    'ALTER TABLE spec_watch_list ADD COLUMN IF NOT EXISTS last_unconfirmed_reason TEXT',
  ],
];

function sslFor(url) {
  // A unix-socket connection is local by construction and never speaks SSL.
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

    // Every existing row starts at 0 with no reason, which is the correct
    // starting state and not a gap: nothing is known about any entry's
    // stability until the next run measures it. No backfill is possible —
    // no hash history is kept.
    const { rows } = await client.query(
      'SELECT COUNT(*)::int AS n FROM spec_watch_list WHERE consecutive_unconfirmed > 0'
    );
    console.log(`\n${TAG} ${rows[0].n} entries carry a non-zero streak (expected 0 on a first run).`);
    console.log(
      `${TAG} the next detection run will start measuring. An entry reaching 3 in a row is\n` +
        '  reported under `stuck` in the run summary and turns its row red on the health page —\n' +
        '  the confirm step exists to absorb one-off noise, so 1 is the design working and 2 is\n' +
        '  two bad Mondays, but 3 consecutive weekly runs is a month with no usable comparison.\n' +
        '  The streak is shown from 1 upward so a row climbing toward it is visible on the way.'
    );

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n${TAG} COMMITTED.`);
    } else {
      await client.query('ROLLBACK');
      console.log(`\n${TAG} ROLLED BACK (dry run) — no changes were written. Re-run with --commit to apply.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run only when invoked directly. Requiring this module (the smoke test does)
// must NOT connect to a database.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { STATEMENTS };
