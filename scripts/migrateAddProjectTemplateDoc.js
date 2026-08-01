'use strict';

// Migration — projects.template_doc_id / template_doc_url (custom document
// types, STEP THREE).
//
// A brief that names a template-attached asset now produces TWO documents in the
// campaign folder: the copy doc, and a copy of the tenant's own template with
// this project's copy filled into it. This records the second one.
//
// WHY NOT REUSE deck_id / deck_url. They exist and are unused — a leftover from
// a deck plan that was never built — so reusing them would have cost nothing and
// saved this migration. The reason not to is that the name would lie. A copy
// matrix is not a deck, and this repository already carries a documented list of
// things that "still exist but are wired to nothing" precisely because names
// that stopped matching their contents are expensive to live with. A column read
// by two surfaces and a project row is not the place to start a second such list.
//
// WHY NOT A project_documents JOIN TABLE. Because there are two artifacts, not
// n. A join table is the right shape the day a project has a third kind of
// document and something needs to iterate them; today it would mean a JOIN on
// every project read, a second write path, and an ordering question, to store
// one row. When the third arrives, this pair migrates into it.
//
// WHAT HAPPENS WITH MORE THAN ONE TEMPLATE DOCUMENT. A brief CAN produce several
// — two attached assets pointing at two different templates. The pair holds the
// FIRST; the rest are built, land in the campaign folder, and are reported on
// both surfaces from the in-memory result, but are not recorded on the row. That
// is a known and deliberate limit of a named pair, and it is the point at which
// the join table above stops being premature.
//
// NOT TO BE CONFUSED WITH projects.template_id, which already exists and is a
// foreign key to `templates` — the per-tenant doc-header/naming record. Unrelated
// to doc_templates and untouched here.
//
// Dry run by default: applies inside a transaction, prints the resulting state,
// then ROLLBACKs. --commit writes. Postgres DDL is transactional, so the dry run
// genuinely executes the statements rather than describing them.
//
// Idempotent — IF NOT EXISTS, safe to re-run.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateAddProjectTemplateDoc.js            # dry run — no writes
//   node scripts/migrateAddProjectTemplateDoc.js --commit   # write

const { Pool } = require('pg');

const TAG = '[project-template-doc]';
const COMMIT = process.argv.includes('--commit');

const STATEMENTS = [
  ['projects.template_doc_id', 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS template_doc_id TEXT'],
  ['projects.template_doc_url', 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS template_doc_url TEXT'],
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

    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'projects'
          AND column_name IN ('copy_doc_id', 'template_doc_id', 'template_doc_url', 'deck_id', 'template_id')
        ORDER BY column_name`
    );
    console.log(`\n${TAG} the project's document columns now:`);
    for (const r of cols.rows) {
      const note =
        r.column_name === 'copy_doc_id'
          ? '  <- the promo doc, unchanged; idempotency keys on it'
          : r.column_name === 'deck_id'
            ? '  <- still unused, deliberately left alone'
            : r.column_name === 'template_id'
              ? '  <- FK to `templates` (header/naming), unrelated'
              : '';
      console.log(`  projects.${r.column_name.padEnd(17)} ${r.data_type.padEnd(8)} nullable=${r.is_nullable}${note}`);
    }

    const counts = await client.query(
      `SELECT count(*)::int AS projects,
              count(*) FILTER (WHERE template_doc_id IS NOT NULL)::int AS with_template
         FROM projects`
    );
    const c = counts.rows[0];
    console.log(
      `\n${TAG} ${c.projects} project(s), ${c.with_template} with a template document ` +
        `(${c.projects - c.with_template} are copy-doc only, unchanged)`
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
