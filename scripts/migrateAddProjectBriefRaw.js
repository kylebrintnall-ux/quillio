'use strict';

// Migration — projects.brief_raw: the client's own brief, verbatim.
//
// WHY THIS EXISTS. The product's claim is "send the brief you already have, in
// your own words". Until now `createDocument` received `brief` and used it for
// exactly one thing — `makeTitle` — so the original named a FILE and the drafter
// read `summary` + `writer_prompt`, which are Gemini's compression of it. The
// campaign's own language was discarded at the one point where it mattered most.
//
// Measured before this landed: a field-draft prompt was 15,405 characters, of
// which 66% was craft.md (never varies), 24% voice.md or the tenant guide
// (varies per tenant, never per campaign), and 2% the campaign. Twelve
// independently drafted headlines shared 99% of their input and produced one
// shape, twice byte-identically. The brief said "in about a minute"; ten of
// twelve outputs said "in 60 seconds", a phrase that appears in no input at all.
//
// A THIRD COLUMN BESIDE TWO SIBLINGS, not a new mechanism.
// scripts/migrateAddProjectTemplateDraft.js already added `brief_summary` and
// `brief_writer_prompt` for the same reason — the draft path is handed a
// document id and a tenant, and needs the campaign context without reading it
// back out of the copy doc. `pipeline.js` already reads those two through
// `getProjectByAnyDocId`. This adds the source those two are derived from.
//
// WHY NOT IN THE DOCUMENT. The alternative was rendering the brief into the doc
// and recovering it in `parseDoc`. Rejected on FIDELITY: a Docs round-trip is a
// lossy channel (formatting, line breaks) for the one value whose exactness is
// the entire point, and `parseDoc` takes only the FIRST paragraph after a
// HEADING_2, so multi-paragraph briefs would need a parser change shared by the
// draft and regenerate paths. The trade that was given up is real and is recorded
// in CLAUDE.md: a writer can no longer correct the brief in the doc and redraft
// against the correction.
//
// Purely additive: one nullable column, no backfill. Rows created before it have
// NULL and degrade to exactly the previous behaviour — `saveProject` drops the
// column group on 42703 and the draft path treats a missing brief as absent.
// Either deploy order is safe.
//
// Idempotent (IF NOT EXISTS). Dry run by default; --commit writes.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateAddProjectBriefRaw.js            # dry run
//   node scripts/migrateAddProjectBriefRaw.js --commit   # write

const { Pool } = require('pg');

const TAG = '[brief-raw]';
const COMMIT = process.argv.includes('--commit');

// TEXT, not VARCHAR(n). The cap that matters is the PROMPT's, applied at read
// time in services/gemini.js where it can be reported to the model — a column
// that silently refused a long brief would fail at the worst possible moment,
// and one that truncated on write would lose the original permanently.
const STATEMENTS = [
  ['projects.brief_raw', 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS brief_raw TEXT'],
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

    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(brief_raw)::int AS with_brief,
              COUNT(brief_summary)::int AS with_summary
         FROM projects`
    );
    const r = rows[0];
    console.log(
      `\n${TAG} ${r.total} project row(s) — brief_raw set on ${r.with_brief}, `
        + `brief_summary on ${r.with_summary}`
    );
    console.log(
      `${TAG} existing rows keep NULL and draft exactly as they do today; only briefs run `
        + 'after this migration carry their own words.'
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

module.exports = { STATEMENTS };
