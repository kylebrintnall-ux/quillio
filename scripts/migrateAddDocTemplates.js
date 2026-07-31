'use strict';

// Migration — doc_templates (custom document types, STEP ONE: storage only).
//
// A tenant uploads a .docx of their own template document (a Salesforce-style
// landscape "copy matrix", say). Quillio imports it into Drive as a Google Doc
// IT OWNS, discovers the {{Placeholders}} inside it, and stores both here.
//
// WHY A TABLE AND NOT A COLUMN ON `templates`. `templates` is the per-tenant
// doc-header/naming record — one default per tenant. A tenant will hold several
// document templates (a form matrix, a confirmation matrix, later a deck), so
// bolting two columns onto a one-per-tenant row would have to be undone at the
// second one. This table is deliberately tiny and holds ONLY what step one
// produces.
//
// WHAT IS NOT HERE, ON PURPOSE. No placeholder→field mapping, no asset_type link,
// no is_default, no rendering config. Step one answers two questions — does a
// .docx import survive, and can the placeholders be found — and stops. Every
// column below exists to answer those.
//
//   source_doc_id   the imported Google Doc's file id. Owned by the app, which
//                   is the entire reason this is an upload and not a pasted
//                   link: the tenant OAuth scope is drive.file (routes/oauth.js:45),
//                   which reaches only files the app created. A link to a file
//                   the tenant made by hand returns 404. A file that arrives
//                   THROUGH Quillio and is imported by Quillio does not.
//   placeholders    the discovery result, verbatim — [{ name, key, count,
//                   locations }]. Stored rather than re-derived so the settings
//                   screen is a read, and so a later mapping step has a stable
//                   list to map against even if the tenant edits the doc.
//   discovered_at   when that scan ran, so a stale list is visibly stale.
//
// Standalone and idempotent (IF NOT EXISTS everywhere); safe to re-run.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateAddDocTemplates.js

const { Pool } = require('pg');

const STATEMENTS = [
  [
    'doc_templates',
    `CREATE TABLE IF NOT EXISTS doc_templates (
       id BIGSERIAL PRIMARY KEY,
       tenant_id TEXT REFERENCES tenants(id),
       name TEXT NOT NULL,
       source_doc_id TEXT,
       source_doc_url TEXT,
       original_filename TEXT,
       placeholders JSONB DEFAULT '[]'::jsonb,
       discovered_at TIMESTAMPTZ,
       created_by BIGINT,
       created_at TIMESTAMPTZ DEFAULT now()
     )`,
  ],
  [
    'doc_templates_tenant_idx',
    'CREATE INDEX IF NOT EXISTS doc_templates_tenant_idx ON doc_templates (tenant_id)',
  ],
];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString });
  try {
    for (const [label, sql] of STATEMENTS) {
      await pool.query(sql);
      console.log(`  ok  ${label}`);
    }
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM doc_templates');
    console.log(`\ndoc_templates ready — ${rows[0].n} row(s).`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
