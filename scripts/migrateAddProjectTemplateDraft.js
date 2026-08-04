'use strict';

// Migration — projects.doc_template_id, brief_summary, brief_writer_prompt.
//
// The matrix is copied as STRUCTURE at brief time and drafted on the same button
// that drafts the copy doc. To draft it, the draft path — which is handed a
// document id and a tenant and nothing else — has to answer two questions the
// project row could not answer:
//
//   WHICH TEMPLATE was this document copied from?
//     projects.template_doc_id records the COPY; nothing recorded the source.
//     Without it there is no way to read template_markers, which is where the
//     fields and their cell coordinates live. doc_template_id is that link.
//
//     NOT to be confused with projects.template_id, which already exists and is
//     a foreign key to `templates` — the per-tenant doc-header/naming record,
//     unrelated to doc_templates. Reusing that name would have been a silent
//     collision with a live column.
//
//   WHAT WAS THE BRIEF ABOUT?
//     The drafter needs the campaign summary and writer direction. The copy doc
//     carries both and parseDoc returns them — but reading them from there would
//     make drafting the matrix depend on the copy doc, which is exactly the
//     coupling syncTemplateDocuments had and was deleted for. And a
//     template-only brief has no copy doc to read at all.
//
//     So the brief's own words are recorded on the project row. Drafting the
//     matrix then touches the copy doc never, and the two documents share a
//     campaign and a button and nothing else.
//
// All three are NULLABLE and every existing row keeps NULL. A project built
// before this migration has no matrix to draft; one whose brief context is
// missing drafts with an empty summary, which is worse copy but not a failure.
//
// Dry run by default: applies inside a transaction, prints the resulting state,
// then ROLLBACKs. --commit writes. Postgres DDL is transactional, so the dry run
// genuinely executes the statements rather than describing them.
//
// Idempotent — IF NOT EXISTS, safe to re-run.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateAddProjectTemplateDraft.js            # dry run — no writes
//   node scripts/migrateAddProjectTemplateDraft.js --commit   # write

const { Pool } = require('pg');

const TAG = '[project-template-draft]';
const COMMIT = process.argv.includes('--commit');

const STATEMENTS = [
  ['projects.doc_template_id', 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS doc_template_id BIGINT'],
  ['projects.brief_summary', 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS brief_summary TEXT'],
  ['projects.brief_writer_prompt', 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS brief_writer_prompt TEXT'],
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
          AND column_name IN ('copy_doc_id', 'template_doc_id', 'template_id',
                              'doc_template_id', 'brief_summary', 'brief_writer_prompt')
        ORDER BY column_name`
    );
    console.log(`\n${TAG} the project's document columns now:`);
    for (const r of cols.rows) {
      const note =
        r.column_name === 'template_id'
          ? '  <- FK to `templates` (header/naming), UNRELATED, untouched'
          : r.column_name === 'doc_template_id'
            ? '  <- NEW: which doc_templates row the matrix was copied from'
            : r.column_name === 'copy_doc_id'
              ? '  <- the copy doc; idempotency still keys on it'
              : r.column_name.startsWith('brief_')
                ? '  <- NEW: so drafting the matrix never reads the copy doc'
                : '';
      console.log(`  projects.${r.column_name.padEnd(20)} ${r.data_type.padEnd(8)} nullable=${r.is_nullable}${note}`);
    }

    const counts = await client.query(
      `SELECT count(*)::int AS projects,
              count(*) FILTER (WHERE template_doc_id IS NOT NULL)::int AS with_template
         FROM projects`
    );
    const c = counts.rows[0];
    console.log(
      `\n${TAG} ${c.projects} project(s), ${c.with_template} with a template document. ` +
        'Every existing row keeps NULL in all three: a project built before this has no matrix to draft.'
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
