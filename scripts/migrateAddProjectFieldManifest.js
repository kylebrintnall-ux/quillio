'use strict';

// Migration — projects.field_manifest: what each document was actually built with.
//
// WHY THIS EXISTS. `projects` records the doc id, tenant, folder, Slack thread and
// brief, and nothing about the CONTENTS. So "which existing documents contain
// <asset>/<field>?" — the question any spec-change sweep has to answer first — is
// unanswerable from stored data. Answering it today means listing every
// projects.copy_doc_id and opening each document through the Docs API to parse it,
// which is one Google read per document per sweep.
//
// The library is not a substitute. copy_fields describes what a document WOULD be
// built from now; documents drift from it (a field renamed, an asset retired, a
// writer deleting a section), and a document built before a field existed does not
// contain it. Only a snapshot taken at creation says what was written.
//
// WHY JSONB ON projects AND NOT A TABLE. Same reasoning as template_fill: one blob
// per project, written once and read WHOLE for comparison against the current
// spec. It is never queried relationally — the sweep's access pattern is "give me
// every project's manifest, diff each against the changed (asset, field) pairs",
// which is a scan either way. A child table would add a join to a read that
// already has the row in hand, plus a row per field per document.
//
// AND NOT project_assets. That table exists in the schema and is referenced by
// zero lines of code. Reviving a dead table to carry a new meaning is worse than
// adding a column: it would look like the feature it was originally designed for.
//
// NULLABLE, NO DEFAULT, NO BACKFILL — the load-bearing detail. An existing row
// keeps NULL, and NULL means "the manifest is UNKNOWN for this document", which is
// the truth: it was created before manifests existed. That is a different fact from
// `[]`, which would claim the document contains no fields. A sweep must treat NULL
// as "open it and parse it, or skip it" and must never read it as "nothing to
// correct". This is why the column takes no `DEFAULT '[]'::jsonb` — template_fill
// defaults to '{}' because an empty fill is genuinely correct there (nothing has
// been written into its markers yet); here an empty manifest would be a lie.
//
// Purely additive. `saveProject` drops unknown column groups on 42703, so a deploy
// landing before this migration writes the row without the manifest and logs it.
// Either deploy order is safe.
//
// Idempotent (IF NOT EXISTS). Dry run by default; --commit writes.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateAddProjectFieldManifest.js            # dry run
//   node scripts/migrateAddProjectFieldManifest.js --commit   # write

const { Pool } = require('pg');

const TAG = '[field-manifest]';
const COMMIT = process.argv.includes('--commit');

// JSONB, not JSON: the sweep will filter on the contents, and jsonb is the type
// every other structured column here already uses (templates.doc_header_schema,
// projects.template_fill, doc_reviews.state).
const STATEMENTS = [
  ['projects.field_manifest', 'ALTER TABLE projects ADD COLUMN IF NOT EXISTS field_manifest JSONB'],
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
        WHERE table_name = 'projects' AND column_name = 'field_manifest'`
    );
    for (const r of cols.rows) {
      console.log(
        `\n${TAG} projects.${r.column_name} ${r.data_type} ` +
          `nullable=${r.is_nullable} default=${r.column_default || 'none'}`
      );
    }

    const counts = await client.query(
      `SELECT count(*)::int AS projects,
              count(*) FILTER (WHERE copy_doc_id IS NOT NULL)::int AS with_copy_doc,
              count(field_manifest)::int AS with_manifest
         FROM projects`
    );
    const c = counts.rows[0];
    console.log(
      `\n${TAG} ${c.projects} project(s), ${c.with_copy_doc} with a copy doc, ` +
        `${c.with_manifest} carrying a manifest`
    );
    console.log(
      `${TAG} every existing row keeps NULL, which means UNKNOWN — not empty. A document`
    );
    console.log(
      `${TAG} created before this migration has to be opened and parsed to learn its fields;`
    );
    console.log(
      `${TAG} only briefs run after it record one. Do not read NULL as "contains nothing".`
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

// Run only when invoked directly. Requiring this module must NOT connect to a
// database — the smoke test reads STATEMENTS.
if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { STATEMENTS };
