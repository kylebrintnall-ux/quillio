'use strict';

// Doc-header-template work, step 2 — add the per-tenant copy-doc header schema
// column to the templates table:
//   • templates.doc_header_schema JSONB — a block-based header layout schema
//     (see src/destinations/docHeaderSchema.js). Null → the tenant uses today's
//     default doc header (title + HR), unchanged.
//
// Idempotent: ADD COLUMN IF NOT EXISTS, safe to run repeatedly. Wrapped in a
// transaction. Matches the scripts/migrate*.js pattern (sslFor, DATABASE_URL
// required). The templates table itself is created by migrateAddFigmaSchema.js
// (Phase 4 / Stage 1.1) — run that first on a DB that doesn't have it yet.
//
// Run on Railway with:  railway run node scripts/migrateAddHeaderSchema.js
// (or any env with DATABASE_URL set — e.g. a local Postgres for validation).

function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

const STATEMENTS = [
  'ALTER TABLE templates ADD COLUMN IF NOT EXISTS doc_header_schema JSONB',
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate-header] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-header] could not load "pg": ' + err.message);
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  try {
    await client.connect();
    await client.query('BEGIN');
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    await client.query('COMMIT');

    // Verify + report the column so a run is self-confirming.
    const check = await client.query(
      `SELECT data_type FROM information_schema.columns
         WHERE table_name = 'templates' AND column_name = 'doc_header_schema'`
    );
    if (check.rows[0]) {
      console.log(`[migrate-header] done — templates.doc_header_schema EXISTS (${check.rows[0].data_type})`);
    } else {
      console.error('[migrate-header] WARNING — column still not present after migration');
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate-header] FAILED (rolled back):', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
