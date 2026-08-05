'use strict';

// Migration — source_kind on the watch list: platform_enforced vs observed_practice.
//
// THE PROBLEM, observed 2026-08-05. A detection run produced 6 pending flags,
// all from the two Litmus blog posts, going back to 27 July. Both pages changed
// twice in a single run. Those posts are not revising a spec — the pages churn,
// and each churn queues a review of an article that says what it said in 2021.
// A review queue that fills with noise trains a reviewer to dismiss Litmus
// flags, and a reviewer who has learned that will eventually dismiss a real one.
//
// THE UNDERLYING POINT. There is no authoritative email spec. Nobody enforces
// subject-line length — clients truncate. So email guidance is observed best
// practice from trusted sources, not an enforced rule, and hash-diffing a blog
// post measures the wrong variable: the post does not change, it AGES, while
// client behaviour moves independently of it.
//
// WHAT THIS MIGRATION DOES:
//   1. adds spec_watch_list.source_kind, defaulting to 'platform_enforced' so
//      every existing row keeps behaving exactly as it does today;
//   2. sets the two Litmus rows to 'observed_practice';
//   3. dismisses their pending flags, in the SAME transaction, after printing
//      every one of them.
//
// An observed_practice row is not fetched, not hashed and not compared. The
// detector reports it as `not_watched` — a status, counted in the run summary,
// so a skipped row is a fact the run states rather than a row that quietly
// vanished from it.
//
// WHY THE FLAGS GO IN THIS TRANSACTION. They are queued against rows that stop
// producing flags the moment step 2 commits, so leaving them is leaving a queue
// nobody can ever act on for a reason nobody can see. specReview.dismiss() is a
// bare status UPDATE with no audit row, no actor and no reason — clicking
// Dismiss six times in the admin UI records strictly less than this script does,
// because this one prints what it touched and carries the reason in its own
// text. Reversible: status back to 'pending' is one UPDATE.
//
// It REFUSES rather than guesses. If either Litmus row is missing, or the number
// of pending flags is not the 6 that were observed, it prints what it found and
// rolls back — the queue is live data and this script's whole justification is
// that the reason is identical for all six. A seventh flag might not be.
//
// WHAT THIS MIGRATION DOES NOT DO. The writer-facing half — a spec source
// registry, repointing the 15 email copy_fields off `quillio_default` onto real
// Litmus URLs, the observed-practice tier line, published dates and a staleness
// horizon — is deliberately NOT here. Until it lands, an observed_practice
// field renders in the doc exactly as it does today.
//
// Dry run by default: applies inside a transaction, prints the state, ROLLBACKs.
// --commit writes. Idempotent — the DDL is IF NOT EXISTS, the row update is
// keyed on source_kind still being the default, and a re-run finds 0 pending
// flags and says so instead of refusing.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateAddSourceKind.js            # dry run
//   node scripts/migrateAddSourceKind.js --commit   # write

const { Pool } = require('pg');

const TAG = '[source-kind]';
const COMMIT = process.argv.includes('--commit');

const STATEMENTS = [
  [
    'spec_watch_list.source_kind',
    "ALTER TABLE spec_watch_list ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'platform_enforced'",
  ],
];

// Matched on a distinctive fragment of source_url, like the anchor migration, so
// a trailing slash or a query string cannot silently skip a row. These are the
// only two observed_practice sources today; a platform spec page publishes a
// limit its own product enforces, which is a different kind of claim.
const OBSERVED = [
  { match: 'litmus.com/blog/how-to-write-the-perfect-subject-line', why: 'blog post, published 2021' },
  { match: 'litmus.com/blog/the-ultimate-guide-to-preview-text-support', why: 'blog post' },
];

// What was on the queue when this was written. Not a magic number — the count is
// the evidence that the situation is the one this script was reasoned about, and
// a different count means someone should look before six rows are dismissed.
const EXPECTED_PENDING = 6;

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

    // --- 1. the rows -------------------------------------------------------
    const { rows: all } = await client.query(
      'SELECT id, display_name, source_url, source_kind FROM spec_watch_list ORDER BY is_test, id'
    );
    const targets = [];
    console.log(`\n${TAG} ${all.length} watch entries:`);
    for (const row of all) {
      const obs = OBSERVED.find((o) => String(row.source_url || '').includes(o.match));
      if (!obs) {
        console.log(`  #${row.id} ${String(row.display_name || '').padEnd(24)} platform_enforced (unchanged)`);
        continue;
      }
      targets.push(row);
      if (row.source_kind === 'observed_practice') {
        console.log(`  #${row.id} ${String(row.display_name || '').padEnd(24)} already observed_practice — left alone`);
        continue;
      }
      await client.query(
        "UPDATE spec_watch_list SET source_kind = 'observed_practice' WHERE id = $1 AND source_kind = 'platform_enforced'",
        [row.id]
      );
      console.log(`  #${row.id} ${String(row.display_name || '').padEnd(24)} -> observed_practice (${obs.why})`);
    }

    if (targets.length !== OBSERVED.length) {
      throw new Error(
        `expected ${OBSERVED.length} observed-practice rows on the watch list, found ${targets.length}. ` +
          'Refusing rather than guessing which rows were meant — the flag dismissal below is scoped by these ids.'
      );
    }

    // --- 2. their pending flags --------------------------------------------
    const ids = targets.map((r) => r.id);
    const { rows: pending } = await client.query(
      `SELECT id, watch_id, detected_at, old_hash, new_hash
         FROM spec_review_queue
        WHERE watch_id = ANY($1::bigint[]) AND status = 'pending'
        ORDER BY detected_at, id`,
      [ids]
    );

    console.log(`\n${TAG} pending flags on those rows: ${pending.length}`);
    for (const f of pending) {
      const when = f.detected_at ? new Date(f.detected_at).toISOString().slice(0, 16).replace('T', ' ') : '(no date)';
      const short = (h) => (h ? String(h).slice(0, 10) : '(none)');
      console.log(`  flag #${f.id}  watch #${f.watch_id}  detected ${when}  ${short(f.old_hash)} -> ${short(f.new_hash)}`);
    }

    if (pending.length === 0) {
      console.log('  nothing to dismiss (already run, or the queue was cleared by hand).');
    } else if (pending.length !== EXPECTED_PENDING) {
      // The count IS the evidence. Six flags, all Litmus, all the same cause, is
      // the situation this script reasoned about; a different number means the
      // queue has something in it that was not part of that reasoning.
      throw new Error(
        `expected ${EXPECTED_PENDING} pending Litmus flags, found ${pending.length}. Refusing. ` +
          'Read the list above: if the extra ones are the same churn, raise EXPECTED_PENDING and re-run; ' +
          'if any of them is a genuine revision, deal with it in the admin UI first.'
      );
    } else {
      const res = await client.query(
        `UPDATE spec_review_queue SET status = 'dismissed'
          WHERE watch_id = ANY($1::bigint[]) AND status = 'pending'`,
        [ids]
      );
      console.log(`  dismissed ${res.rowCount} — reversible: status back to 'pending' is one UPDATE.`);
    }

    console.log(
      `\n${TAG} after this, the next detection run reports  not_watched: ${targets.length}  of ${all.length}.\n` +
        '  An observed_practice row is not fetched, not hashed and not compared, and can never\n' +
        '  produce a flag. It keeps its place on this table because affected_fields — the write\n' +
        "  gate — lives on the row; deleting it would leave those pairs gated by nothing.\n" +
        '  Its hash-watch columns (current_hash, last_checked_at, consecutive_failures,\n' +
        '  consecutive_unconfirmed, expected_content, anchor_scope) are meaningless from now on\n' +
        '  and are left as they are rather than cleared — see CLAUDE.md.'
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
    console.error(`\n${TAG} ROLLED BACK — nothing was written.`);
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
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { STATEMENTS, OBSERVED, EXPECTED_PENDING };
