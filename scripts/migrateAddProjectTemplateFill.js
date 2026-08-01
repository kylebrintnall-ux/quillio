'use strict';

// Migration — projects.template_fill (custom document types, STEP FOUR).
//
// Records, per project, the exact text last written into each of the template
// document's markers: { markerKey: "the copy that went in" }.
//
// WHY THIS HAS TO EXIST. Filling uses replaceAllText, which CONSUMES the thing
// it matches. The first sync turns {{Form Headline}} into "Book your seat" — and
// the marker is then gone, so a second sync looking for {{Form Headline}} finds
// nothing and a regenerated field would never reach the template. Remembering
// what was written lets the next sync ask for the OLD COPY instead, which is the
// only string still in the document.
//
// Each sync therefore sends two replacements per marker — {{Marker}} -> new, and
// oldCopy -> new — and whichever is actually present wins. That makes the sync
// idempotent (re-running with unchanged copy matches nothing new) and correct on
// every subsequent regeneration.
//
// IT ALSO DECIDES WHAT HAPPENS TO A HAND EDIT. If a writer edits the matrix cell
// directly, neither the marker nor the remembered copy is there any more, so the
// replacement matches nothing and their edit survives. That is deliberate: the
// alternative is silently overwriting a person's work with a model's.
//
// WHY JSONB ON projects AND NOT A TABLE. It is one blob per project, read and
// written whole by one caller, never queried across rows. A table would add a
// join to a read that already has the row in hand.
//
// Dry run by default: applies inside a transaction, prints the resulting state,
// then ROLLBACKs. --commit writes. Idempotent — IF NOT EXISTS, safe to re-run.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateAddProjectTemplateFill.js            # dry run — no writes
//   node scripts/migrateAddProjectTemplateFill.js --commit   # write

const { Pool } = require('pg');

const TAG = '[project-template-fill]';
const COMMIT = process.argv.includes('--commit');

const STATEMENTS = [
  [
    'projects.template_fill',
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS template_fill JSONB DEFAULT '{}'::jsonb`,
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
        WHERE table_name = 'projects' AND column_name LIKE 'template_%'
        ORDER BY column_name`
    );
    console.log(`\n${TAG} the project's template columns now:`);
    for (const r of cols.rows) {
      console.log(
        `  projects.${r.column_name.padEnd(17)} ${r.data_type.padEnd(9)} ` +
          `nullable=${r.is_nullable} default=${r.column_default || 'none'}`
      );
    }

    const counts = await client.query(
      `SELECT count(*)::int AS projects,
              count(*) FILTER (WHERE template_doc_id IS NOT NULL)::int AS with_template,
              count(*) FILTER (WHERE template_fill IS NOT NULL AND template_fill <> '{}'::jsonb)::int AS with_fill
         FROM projects`
    );
    const c = counts.rows[0];
    console.log(
      `\n${TAG} ${c.projects} project(s), ${c.with_template} with a template document, ${c.with_fill} already synced`
    );
    console.log(
      `${TAG} every existing project starts with an EMPTY fill, which is correct: ` +
        `nothing has been written into their markers, so the first sync looks for {{Marker}}.`
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
