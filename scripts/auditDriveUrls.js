'use strict';

// Read-only audit — rows whose Drive LINK was never recorded.
//
// Renamed from auditCopyDocUrls.js, which only covered projects.copy_doc_url.
// The sweep that followed found the same gap on the project FOLDER, so this now
// reports every url column fed by a drive.files.create / files.copy response.
//
// THE FOUR COLUMNS, and which were ever exposed:
//
//   projects.copy_doc_url      <- googleDocs.createDocument
//       Was un-guarded. Fixed: the link is derived from the id when Drive omits
//       webViewLink. Audited zero affected rows before the fix.
//
//   projects.drive_folder_url  <- pipeline.generateDoc's project folder
//       Was un-guarded. Fixed the same way, with the folder URL shape
//       (/drive/folders/<id>). THIS ONE IS WORSE — see below.
//
//   projects.template_doc_url  <- googleDocs.createFromTemplate
//       Always guarded. Reported here for completeness.
//
//   doc_templates.source_doc_url <- docTemplateImport.importDocxTemplate
//       Always guarded. Reported here for completeness.
//
// WHY THE FOLDER IS THE AWKWARD ONE. saveProject writes
//     drive_folder_id: projectFolderUrl ? docFolderId : null
// so a missing webViewLink discarded the folder's ID along with its link. That
// has two consequences this audit cannot argue its way out of:
//
//   1. A row in that state is (null, null) — INDISTINGUISHABLE from a project
//      whose folder creation genuinely threw, which lands both columns null too.
//      So the number below is an UPPER BOUND on the webViewLink cause, not a
//      measurement of it. A thrown create was logged at the time
//      ('[Quillio] project folder creation failed'); a missing webViewLink was
//      not, which is the only way to tell them apart after the fact.
//
//   2. There is no id on the row to rebuild the link from. It is still
//      recoverable — the copy doc's `parents` names the folder — but that is a
//      Drive round-trip per project, not a SQL update. The script prints the
//      candidates so that decision can be made on real numbers.
//
// WRITES NOTHING. No transaction, no DDL — SELECTs only.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/auditDriveUrls.js

const { Pool } = require('pg');

const TAG = '[drive-url-audit]';

function sslFor(url) {
  // A unix-socket connection is local by construction and never speaks SSL.
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// A table that may not exist yet on an un-migrated database. 42P01 is
// undefined_table — the same tolerance db.js applies everywhere else.
async function maybeQuery(pool, sql, label) {
  try {
    return await pool.query(sql);
  } catch (err) {
    if (err && err.code === '42P01') {
      console.log(`  (${label}: table does not exist on this database — skipped)`);
      return null;
    }
    throw err;
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString, ssl: sslFor(connectionString) });

  try {
    const p = (
      await pool.query(
        `SELECT count(*)::int                                                                 AS projects,
                count(*) FILTER (WHERE copy_doc_id IS NOT NULL)::int                          AS with_copy_doc,
                count(*) FILTER (WHERE copy_doc_id IS NOT NULL AND copy_doc_url IS NULL)::int AS copy_id_no_url,
                count(*) FILTER (WHERE template_doc_id IS NOT NULL)::int                      AS with_template_doc,
                count(*) FILTER (WHERE template_doc_id IS NOT NULL
                                   AND template_doc_url IS NULL)::int                         AS tpl_id_no_url,
                count(*) FILTER (WHERE drive_folder_url IS NULL)::int                         AS no_folder_url,
                count(*) FILTER (WHERE drive_folder_url IS NULL
                                   AND copy_doc_id IS NOT NULL)::int                          AS no_folder_but_built
           FROM projects`
      )
    ).rows[0];

    console.log(`${TAG} ${p.projects} project(s)\n`);
    console.log('  DOCUMENT LINKS — an id with no url is the fault; both null is a normal outcome.');
    console.log(`    copy doc:      ${p.with_copy_doc} recorded, ${p.copy_id_no_url} missing a link`);
    console.log(`    template doc:  ${p.with_template_doc} recorded, ${p.tpl_id_no_url} missing a link`);

    console.log('\n  FOLDER LINK — the id was discarded with the url, so this count CONFLATES');
    console.log('  a missing webViewLink with a folder creation that threw. Upper bound, not a');
    console.log('  measurement.');
    console.log(`    ${p.no_folder_url} project(s) have no folder link`);
    console.log(`    ${p.no_folder_but_built} of those DID build a copy doc — the recoverable ones`);
    console.log("      (their folder is the copy doc's Drive `parents`, one round-trip each)");

    for (const [label, count, sql] of [
      [
        'copy doc id with no link',
        p.copy_id_no_url,
        `SELECT id, tenant_id, name, copy_doc_id AS doc, created_at
           FROM projects WHERE copy_doc_id IS NOT NULL AND copy_doc_url IS NULL
          ORDER BY created_at DESC LIMIT 50`,
      ],
      [
        'template doc id with no link',
        p.tpl_id_no_url,
        `SELECT id, tenant_id, name, template_doc_id AS doc, created_at
           FROM projects WHERE template_doc_id IS NOT NULL AND template_doc_url IS NULL
          ORDER BY created_at DESC LIMIT 50`,
      ],
      [
        "no folder link but a copy doc was built (recoverable via its parents)",
        p.no_folder_but_built,
        `SELECT id, tenant_id, name, copy_doc_id AS doc, created_at
           FROM projects WHERE drive_folder_url IS NULL AND copy_doc_id IS NOT NULL
          ORDER BY created_at DESC LIMIT 50`,
      ],
    ]) {
      if (!count) continue;
      const rows = await pool.query(sql);
      console.log(`\n${TAG} ${label} (newest first, capped at 50):`);
      for (const r of rows.rows) {
        console.log(
          `  project ${String(r.id).padEnd(6)} tenant=${String(r.tenant_id).padEnd(12)} ` +
            `${String(r.name || '(unnamed)').slice(0, 36).padEnd(38)} ${r.doc}  ` +
            `${new Date(r.created_at).toISOString().slice(0, 10)}`
        );
      }
    }

    console.log('');
    const t = await maybeQuery(
      pool,
      `SELECT count(*)::int                                       AS templates,
              count(*) FILTER (WHERE source_doc_id IS NOT NULL
                                 AND source_doc_url IS NULL)::int AS id_no_url
         FROM doc_templates`,
      'doc_templates'
    );
    if (t) {
      const d = t.rows[0];
      console.log(`  IMPORTED TEMPLATES — ${d.templates} template(s), ${d.id_no_url} missing a link`);
    }

    const clean =
      p.copy_id_no_url === 0 && p.tpl_id_no_url === 0 && p.no_folder_url === 0 && (!t || t.rows[0].id_no_url === 0);
    console.log(
      clean
        ? `\n${TAG} CLEAN. Every recorded Drive object also recorded its link, so the guards are\n` +
            '  about the next row rather than any existing one. Nothing to backfill.'
        : `\n${TAG} See the rows above before deciding on a backfill. The document links are\n` +
            "  reconstructible from their ids in SQL; the folder links need the copy doc's\n" +
            '  Drive `parents`, so those are a script, not an UPDATE.'
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
