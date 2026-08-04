'use strict';

// Read-only audit — projects with a copy doc whose LINK was never recorded.
//
// public/app.html now hides the detail view's "Open copy doc" button when
// projects.copy_doc_url is null. Before that it was always shown, and its
// handler (`if (p && p.copy_doc_url) openDocUrl(...)`) silently did nothing —
// so a row in this state has always been broken, just visibly rather than
// invisibly. This says how many such rows exist.
//
// WHY THE STATE IS REACHABLE. pipeline.generateDoc writes
//   copy_doc_id:  doc ? doc.id  : null
//   copy_doc_url: doc ? doc.url : null
// and googleDocs.createDocument ends with
//   return { id: docId, url: created.data.webViewLink, title };
// — no fallback. If Drive's files.create response omits webViewLink, the id is
// recorded and the url is not. googleDocs.createFromTemplate, on the same API,
// DOES defend against it:
//   const url = copied.data.webViewLink || `https://docs.google.com/document/d/${id}/edit`;
// The asymmetry is the whole reason to run this rather than assume zero.
//
// WRITES NOTHING. No transaction, no DDL — a single SELECT.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/auditCopyDocUrls.js

const { Pool } = require('pg');

const TAG = '[copy-doc-url-audit]';

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

  try {
    const totals = await pool.query(
      `SELECT count(*)::int                                                                    AS projects,
              count(*) FILTER (WHERE copy_doc_id IS NOT NULL)::int                             AS with_copy_doc,
              count(*) FILTER (WHERE copy_doc_id IS NOT NULL AND copy_doc_url IS NULL)::int    AS id_no_url,
              count(*) FILTER (WHERE copy_doc_id IS NULL AND copy_doc_url IS NOT NULL)::int    AS url_no_id,
              count(*) FILTER (WHERE copy_doc_id IS NULL)::int                                 AS no_copy_doc
         FROM projects`
    );
    const t = totals.rows[0];
    console.log(`${TAG} ${t.projects} project(s)`);
    console.log(`  ${String(t.with_copy_doc).padStart(5)}  have a copy doc`);
    console.log(`  ${String(t.no_copy_doc).padStart(5)}  have none (template-only, or a failed build)`);
    console.log(`  ${String(t.id_no_url).padStart(5)}  <- THE ONE THAT MATTERS: copy_doc_id set, copy_doc_url NULL`);
    console.log(`  ${String(t.url_no_id).padStart(5)}      url set, id NULL (would be stranger still)`);

    if (t.id_no_url > 0) {
      const rows = await pool.query(
        `SELECT id, tenant_id, name, copy_doc_id, created_at
           FROM projects
          WHERE copy_doc_id IS NOT NULL AND copy_doc_url IS NULL
          ORDER BY created_at DESC
          LIMIT 50`
      );
      console.log(`\n${TAG} the affected rows (newest first, capped at 50):`);
      for (const r of rows.rows) {
        console.log(`  project ${String(r.id).padEnd(6)} tenant=${String(r.tenant_id).padEnd(12)} ${String(r.name || '(unnamed)').slice(0, 40).padEnd(42)} doc=${r.copy_doc_id}  ${new Date(r.created_at).toISOString().slice(0, 10)}`);
      }
      console.log(
        `\n${TAG} Each of these has a real document in Drive that the row cannot link to.\n` +
          `  The url is reconstructible from the id — https://docs.google.com/document/d/<id>/edit —\n` +
          `  which is exactly the fallback createFromTemplate already applies. Backfilling them, and\n` +
          `  adding that same fallback to createDocument so no new row lands here, is the fix.`
      );
    } else {
      console.log(
        `\n${TAG} NONE. Every project that recorded a copy doc also recorded its link, so hiding the\n` +
          `  button on a null url changes nothing for any existing row. Worth adding the\n` +
          `  createDocument fallback anyway — the state is reachable, it just has not happened.`
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
