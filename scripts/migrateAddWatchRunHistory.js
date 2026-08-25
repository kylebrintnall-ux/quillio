'use strict';

// August 2026 — run-history columns on spec_watch_list.
//
// Structure follows scripts/migrateFixGoogleDisplayAnchor.js: dry run by
// default, --commit to write, one transaction, and the inTxn flag so a failure
// before BEGIN does not print a rollback that never happened.
//
// ─── THE PROBLEM: A ROW THAT IS FINE AND A ROW THAT IS BLIND LOOK IDENTICAL ──
// The detector persists four things per row, and none of them accumulates:
//
//   current_hash              overwritten on baseline and on change
//   last_checked_at           ONE timestamp, overwritten every run
//   consecutive_failures      reset to 0 by every success path
//   consecutive_unconfirmed   same
//
// Both counters only ever climb on FAILED or UNCONFIRMED — the two states a
// mis-pointed row never enters. So a row watching exactly the right table and a
// row that has been watching the wrong page since the day it was created present
// identically, every week, forever:
//
//   status unchanged · last_error NULL · failures 0 · unconfirmed 0
//
// THE DANGEROUS FAILURE IS THE ONE THAT ACCUMULATES NO EVIDENCE, and there is no
// history in which its silence could become conspicuous. That is the gap these
// columns close: not by detecting anything new, but by making a long silence
// legible as a long silence.
//
// scripts/checkSpecHealth.js partially compensates already, by deriving a move
// count from spec_review_queue. That only sees rows which have FLAGGED. A row
// repointed before it ever flagged leaves no queue trace at all — which is
// precisely Meta's case, and the case this is worst for.
//
// ─── THE COLUMNS ────────────────────────────────────────────────────────────
//
//   first_baselined_at  timestamptz  when this row first received a baseline
//                                    hash. Written ONCE, by the baseline branch,
//                                    and never moved afterwards.
//   last_changed_at     timestamptz  when current_hash last actually changed.
//   change_count        integer      how many confirmed changes have been
//                                    recorded. DEFAULT 0.
//
// WHAT EACH ONE ANSWERS THAT NOTHING ANSWERS TODAY:
//
//   "how long has this row been silent"     NOW() - GREATEST(first_baselined_at,
//                                            last_changed_at)
//   "has this row EVER produced a signal"   change_count > 0
//   "is this row young or long-dormant"     first_baselined_at, which — unlike
//                                            created_at — is about the CURRENT
//                                            baseline rather than the row.
//
// The third is the one created_at cannot give. A repurposed row keeps its
// created_at: migrateSplitMetaWatchRows moved Meta's entry from the ads-guide
// index to /image, and migrateFixGoogleSpecSource repointed Google's, both by
// UPDATE in place, because spec_review_queue.watch_id is a foreign key.
// checkSpecHealth's own header says "27d old, never moved" can therefore
// describe a row that spent 26 of those days watching a different page.
//
// first_baselined_at does not fully fix that either — a repoint that clears
// current_hash re-baselines the row, and the baseline branch would then leave
// the ORIGINAL first_baselined_at in place, because it only writes when the
// column is NULL. That is deliberate and it is a judgement call, stated rather
// than buried: "when did this row first start watching anything" is a stable
// fact worth keeping, and a column that silently moves under a repoint is the
// confidently-wrong-date failure checkSpecHealth already declined to build.
// If a repoint should reset it, that is the repoint migration's job to do
// explicitly, and it should say so in its own header.
//
// ─── BACKFILL: TWO COLUMNS ARE RECOVERABLE, ONE IS NOT ──────────────────────
//
// first_baselined_at — LEFT NULL FOR EVERY EXISTING ROW.
//
//   There is no reliable source. created_at is the obvious candidate and it is
//   WRONG for exactly the rows this feature exists to help: a repurposed row
//   keeps its created_at while having been baselined against a different page
//   later, so backfilling from it would stamp a confident date describing an
//   event that did not happen then. That is the same class of invention
//   scripts/migrateBackfillSpecVerifiedAt.js refused when it declined to
//   backfill a verification date from the seed date — "nobody verified anything
//   on the seed date".
//
//   NULL means UNKNOWN, and unknown is the truth. Existing rows will acquire a
//   real value only if they are ever re-baselined. A reader who sees NULL learns
//   something accurate; a reader who sees created_at copied across learns
//   something false and has no way to tell.
//
// last_changed_at and change_count — BACKFILLED FROM spec_review_queue.
//
//   recordChange inserts a queue row and advances the hash in ONE transaction,
//   so the queue is the ledger of confirmed movement. MAX(detected_at) and
//   COUNT(*) per watch_id reconstruct both values for any row that has flagged.
//
//   IT IS A FLOOR, NOT A CENSUS, for the reason checkSpecHealth already
//   documents: the queue can only speak for rows that have flagged at least
//   once. A row repointed and re-baselined before it ever flagged has no queue
//   row, so it backfills to change_count 0 and last_changed_at NULL — which
//   understates its real history. Going forward the columns are exact; for the
//   period before this migration they are a lower bound, and the header of
//   checkSpecHealth says so beside the number.
//
// ─── WHY change_count DEFAULTS TO 0 WHILE first_baselined_at STAYS NULL ─────
// The asymmetry is not arbitrary and it is worth stating, because "be honest
// about what you do not know" would naively argue for NULL on all three.
//
//   change_count      0 is HONEST for a row with no queue entries, because the
//                     queue is a COMPLETE ledger of the event being counted —
//                     nothing deletes from it, and a dismissed flag keeps its
//                     row with status 'dismissed'. "No confirmed change has been
//                     recorded" is a true statement about such a row.
//   first_baselined_at NULL is honest because there is NO ledger of that event
//                     anywhere in the schema. Not an incomplete one — none.
//
// So one column is unknown and says so; the other is known and says that.
//
// ─── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
// It adds no detection. A row watching the wrong page still reports `unchanged`
// every week; what changes is that after six months the row can be SEEN to have
// been silent for six months, next to rows that have not. Reading that and
// acting on it is still a human running checkSpecHealth.
//
// It also does not touch current_hash, last_checked_at, either streak counter,
// expected_content, affected_fields or source_url. Three ADD COLUMNs and two
// backfill UPDATEs, nothing else.
//
// ─── DEPLOY ORDER IS SAFE IN BOTH DIRECTIONS ────────────────────────────────
// Railway auto-deploys main on merge, so the code runs against an unmigrated
// database first. src/db/specWatch.js gains a NEW TOP TIER selecting these
// columns and falls to the existing tiers on 42703, and the detector decides
// what it may write from KEY PRESENCE on the returned row — the same mechanism
// migrateAddSpecAnchors and migrateAddUnconfirmedTracking already use. Before
// this migration runs, the detector writes exactly what it writes today.
//
//   node scripts/migrateAddWatchRunHistory.js            # dry run (ROLLBACK)
//   node scripts/migrateAddWatchRunHistory.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[watch-run-history]';
const COMMIT = process.argv.includes('--commit');

// A unix-socket connection is local by construction and never speaks SSL.
function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// IF NOT EXISTS on every one, so a re-run is a no-op rather than an error.
const COLUMNS = [
  ['first_baselined_at',
    'ALTER TABLE spec_watch_list ADD COLUMN IF NOT EXISTS first_baselined_at TIMESTAMPTZ'],
  ['last_changed_at',
    'ALTER TABLE spec_watch_list ADD COLUMN IF NOT EXISTS last_changed_at TIMESTAMPTZ'],
  ['change_count',
    'ALTER TABLE spec_watch_list ADD COLUMN IF NOT EXISTS change_count INTEGER DEFAULT 0'],
];

// THE BACKFILL, as a SELECT first so the dry run can show it per row.
//
// LEFT JOIN, not JOIN: rows with no queue entries must appear in the output as
// rows that get NOTHING. A migration that prints only what it touches leaves the
// reader unable to tell "no rows needed it" from "the query missed them".
const BACKFILL_PREVIEW_SQL = `
  SELECT w.id,
         w.display_name,
         w.source_url,
         w.is_test,
         w.current_hash IS NOT NULL AS baselined,
         q.n,
         q.last
    FROM spec_watch_list w
    LEFT JOIN (
      SELECT watch_id, COUNT(*)::int AS n, MAX(detected_at) AS last
        FROM spec_review_queue GROUP BY watch_id
    ) q ON q.watch_id = w.id
   ORDER BY w.is_test, w.id`;

// GUARDED ON THE VALUE IT EXPECTS TO REPLACE, per CLAUDE.md's house rule for a
// migration that writes a value: only rows still holding the pre-migration state
// are touched. A re-run after a real detection change must not drag a newer
// last_changed_at backwards to the queue's older MAX.
const BACKFILL_SQL = `
  UPDATE spec_watch_list w
     SET last_changed_at = q.last,
         change_count    = q.n
    FROM (
      SELECT watch_id, COUNT(*)::int AS n, MAX(detected_at) AS last
        FROM spec_review_queue GROUP BY watch_id
    ) q
   WHERE q.watch_id = w.id
     AND w.last_changed_at IS NULL
     AND COALESCE(w.change_count, 0) = 0
   RETURNING w.id`;

function short(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function iso(d) {
  return d ? new Date(d).toISOString().slice(0, 10) : null;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(`${TAG} DATABASE_URL not set — nothing to do.`);
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error(`${TAG} could not load "pg": ${err.message}`);
    process.exit(1);
  }

  const client = new Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();
  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  // WHETHER A TRANSACTION IS ACTUALLY OPEN, tracked rather than assumed. An
  // unconditional ROLLBACK in the catch prints "FAILED (rolled back)" even when
  // the failure happened before BEGIN — Postgres answers ROLLBACK-with-no-
  // transaction with a WARNING, which `.catch(() => {})` swallows, and the
  // message then describes a transaction that was never opened. Cosmetic in
  // effect and not in what it TELLS YOU: the first thing anyone does with a
  // failing migration is ask what it touched.
  let inTxn = false;

  try {
    // READ-ONLY, and BEFORE the transaction: what is already present.
    const existing = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'spec_watch_list'
          AND column_name = ANY($1::text[])`,
      [COLUMNS.map((c) => c[0])]
    );
    const present = new Set(existing.rows.map((r) => r.column_name));
    console.log(`\n${TAG} columns already present: ${present.size ? [...present].join(', ') : '(none)'}`);

    await client.query('BEGIN');
    inTxn = true;

    for (const [name, ddl] of COLUMNS) {
      await client.query(ddl);
      console.log(`${TAG}   ${present.has(name) ? 'already there' : 'ADDED       '}  spec_watch_list.${name}`);
    }

    // ─── THE BACKFILL, SHOWN PER ROW ─────────────────────────────────────────
    const preview = await client.query(BACKFILL_PREVIEW_SQL);
    console.log(`\n${'─'.repeat(78)}\nBACKFILL PREVIEW — every row, including the ones that get nothing\n${'─'.repeat(78)}`);
    console.log(`   ${'id'.padStart(3)}  ${'row'.padEnd(28)} ${'baselined'.padEnd(10)} ${'change_count'.padEnd(13)} last_changed_at`);
    let willGet = 0;
    let willNot = 0;
    for (const r of preview.rows) {
      const label = `${r.is_test ? '[TEST] ' : ''}${short(r.display_name || r.source_url, 26)}`;
      if (r.n > 0) {
        willGet += 1;
        console.log(`   ${String(r.id).padStart(3)}  ${label.padEnd(28)} ${(r.baselined ? 'yes' : 'no').padEnd(10)}`
          + ` ${String(r.n).padEnd(13)} ${iso(r.last)}`);
      } else {
        willNot += 1;
        console.log(`   ${String(r.id).padStart(3)}  ${label.padEnd(28)} ${(r.baselined ? 'yes' : 'no').padEnd(10)}`
          + ` ${'0 (no flags)'.padEnd(13)} NULL — nothing to recover`);
      }
    }
    console.log(`\n   ${willGet} row(s) backfilled from the queue, ${willNot} row(s) get nothing.`);
    console.log('   A row getting nothing has never produced a confirmed change. That is either');
    console.log('   true (it has been stable) or unknowable (it was repointed before it ever');
    console.log('   flagged) — and the queue cannot tell those apart. See the header.');

    console.log(`\n   first_baselined_at: LEFT NULL on all ${preview.rowCount} row(s), deliberately.`);
    console.log('   There is no reliable source. created_at is wrong for exactly the repurposed');
    console.log('   rows this feature exists to help, and NULL means UNKNOWN, which is the truth.');

    const done = await client.query(BACKFILL_SQL);
    console.log(`\n${TAG} backfill UPDATE touched ${done.rowCount} row(s)`
      + ` (expected ${willGet}${done.rowCount === willGet ? '' : ' — MISMATCH, investigate'})`);

    // CONFIRMATION, read back inside the transaction.
    const after = await client.query(
      `SELECT COUNT(*)::int AS rows,
              COUNT(first_baselined_at)::int AS with_first,
              COUNT(last_changed_at)::int AS with_changed,
              COALESCE(SUM(change_count), 0)::int AS total_changes
         FROM spec_watch_list`
    );
    const a = after.rows[0];
    console.log(`\n${TAG} after: ${a.rows} row(s) — first_baselined_at set on ${a.with_first}`
      + ` (expected 0), last_changed_at set on ${a.with_changed}, change_count total ${a.total_changes}`);
    if (a.with_first !== 0) {
      throw new Error(`first_baselined_at is set on ${a.with_first} row(s) and this migration writes it on none. `
        + 'Either it was already populated by a later run of the detector, or something else wrote it. Investigate before committing.');
    }

    if (COMMIT) {
      await client.query('COMMIT');
      inTxn = false;
      console.log(`\n${TAG} COMMITTED.`);
      console.log(`${TAG} Next: deploy the detector change that writes these columns, then`);
      console.log(`${TAG} node scripts/runDetection.js — the baseline branch will start setting`);
      console.log(`${TAG} first_baselined_at on any row that re-baselines.`);
      console.log(`${TAG} Then: node scripts/checkSpecHealth.js — its 'moved' line now prefers`);
      console.log(`${TAG} the stored columns and marks queue-derived values as inferred.`);
    } else {
      await client.query('ROLLBACK');
      inTxn = false;
      console.log(`\n${TAG} DRY RUN — rolled back. Pass --commit to write.`);
    }
  } catch (err) {
    // ONLY ROLL BACK WHAT WAS ACTUALLY OPENED, and say which happened.
    if (inTxn) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`\n${TAG} FAILED (rolled back): ${err.message}`);
    } else {
      console.error(`\n${TAG} FAILED before any transaction was opened — nothing was written, `
        + `and nothing needed rolling back: ${err.message}`);
    }
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} ${err.message}`);
    process.exit(1);
  });
}

module.exports = { COLUMNS, BACKFILL_SQL, BACKFILL_PREVIEW_SQL };
