'use strict';

// Migration — spec_review_queue.agent_proposal: what the agentic read proposed
// at the moment the flag was raised.
//
// WHY AT DETECTION TIME AND NOT AT REVIEW TIME. services/specReview.getSuggestions
// already reads a changed page and proposes a char_max per affected field, but it
// runs on demand when an admin opens the approve form — which can be days later —
// and it keeps nothing. The page text that RAISED the flag is never persisted, so
// by the time anybody looks, the only way to propose is to fetch the page again.
// That re-read compares against a page that may have moved since, and against a
// hash that already advanced (recordChange advances current_hash in the same
// transaction that inserts the flag). The proposal stored here is taken from the
// exact bytes that were hashed, in the same run, before the hash moves.
//
// NULLABLE, NO DEFAULT, AND THE THREE STATES ARE THE POINT. The same discipline
// projects.field_manifest uses, for the same reason:
//
//   NULL                                  no agentic read happened. A row from
//                                         before this migration, or a run with
//                                         the reader disabled (no GEMINI_API_KEY,
//                                         or SPEC_AGENT_ENABLED=false).
//   { status: 'skipped'|'failed', ... }   the reader was ON and did not produce
//                                         proposals. CARRIES NO `fields` KEY AT
//                                         ALL — see below.
//   { status: 'read', fields: [...] }     the page was read. `fields: []` here
//                                         legitimately means "read, proposed
//                                         nothing".
//
// A `fields: []` on a skipped or failed read would be a lie, and it is the exact
// lie this column is most likely to tell: spec_watch_list.affected_fields is a
// snapshot nothing recomputes (CLAUDE.md, "`affected_fields` is a snapshot"), so
// a watch row whose pairs went stale produces NO fields to propose on — and
// recording that as `[]` would say "the page stated no limits" when the truth is
// "the write gate named no fields". The key is therefore ABSENT on any outcome
// that did not read the page, so a reader cannot destructure a claim out of it.
// Branch on `status`, never on the presence of a value inside `fields`.
//
// NOTHING READS THIS COLUMN ON A WRITE PATH. It is shadow mode: the detector is
// its only writer, buildPreview and commitReview never look at it, and the admin
// form renders it beside the field for a human to accept or ignore. Smoke tests
// pin both halves of that.
//
// WHY JSONB ON spec_review_queue AND NOT A TABLE. One blob per flag, written once
// by the run that raised the flag and read WHOLE when a human opens that flag.
// It is never queried relationally — scripts/agentProposalReport.js scans the
// queue and diffs each proposal against spec_change_log, which is a scan either
// way. A child table would add a join to a read that already has the row in hand,
// plus a row per field per flag.
//
// Purely additive. recordChange retries its INSERT without this column on a 42703,
// and both queue readers fall back to a SELECT that omits it, so a deploy landing
// before this migration records flags exactly as it always did. That tolerance is
// not decoration: the INSERT runs inside the transaction that also advances
// current_hash, so an unhandled 42703 there would roll back the FLAG as well and
// detection would silently stop recording anything until this ran. Either deploy
// order is safe.
//
// Idempotent (IF NOT EXISTS). Dry run by default; --commit writes.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateAddAgentProposal.js            # dry run
//   node scripts/migrateAddAgentProposal.js --commit   # write

const { Pool } = require('pg');

const TAG = '[agent-proposal]';
const COMMIT = process.argv.includes('--commit');

// JSONB, not JSON: the report script filters on the contents, and jsonb is the
// type every other structured column in this schema already uses
// (projects.field_manifest, spec_watch_list.affected_fields, doc_reviews.state).
const STATEMENTS = [
  [
    'spec_review_queue.agent_proposal',
    'ALTER TABLE spec_review_queue ADD COLUMN IF NOT EXISTS agent_proposal JSONB',
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
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'spec_review_queue' AND column_name = 'agent_proposal'`
    );
    for (const r of cols.rows) {
      console.log(
        `\n${TAG} spec_review_queue.${r.column_name} ${r.data_type} ` +
          `nullable=${r.is_nullable} default=${r.column_default || 'none'}`
      );
    }

    const counts = await client.query(
      `SELECT count(*)::int AS flags,
              count(*) FILTER (WHERE status = 'pending')::int AS pending,
              count(agent_proposal)::int AS with_proposal
         FROM spec_review_queue`
    );
    const c = counts.rows[0];
    console.log(
      `\n${TAG} ${c.flags} flag(s), ${c.pending} pending, ${c.with_proposal} carrying a proposal`
    );
    console.log(`${TAG} every existing row keeps NULL, which means NO AGENTIC READ HAPPENED —`);
    console.log(`${TAG} not "the page was read and proposed nothing". Only flags raised after`);
    console.log(`${TAG} this migration, by a run with the reader enabled, carry one.`);

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
