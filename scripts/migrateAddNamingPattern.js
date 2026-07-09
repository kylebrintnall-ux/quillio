'use strict';

// File-naming convention (§3) — add the per-tenant naming pattern column:
//   • templates.naming_pattern JSONB — a segment-based filename pattern
//     (see src/destinations/docNaming.js). Null → the tenant uses today's
//     default doc naming, unchanged.
//
// Idempotent: ADD COLUMN IF NOT EXISTS, safe to run repeatedly. Wrapped in a
// transaction. Matches the scripts/migrate*.js pattern (sslFor, DATABASE_URL
// required). The templates table is created by migrateAddFigmaSchema.js.
//
// Run on Railway with:  railway run node scripts/migrateAddNamingPattern.js
// (or:  npm run migrate-naming)

function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

const STATEMENTS = ['ALTER TABLE templates ADD COLUMN IF NOT EXISTS naming_pattern JSONB'];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate-naming] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-naming] could not load "pg": ' + err.message);
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

    const check = await client.query(
      `SELECT data_type FROM information_schema.columns
         WHERE table_name = 'templates' AND column_name = 'naming_pattern'`
    );
    if (check.rows[0]) {
      console.log(`[migrate-naming] done — templates.naming_pattern EXISTS (${check.rows[0].data_type})`);
    } else {
      console.error('[migrate-naming] WARNING — column still not present after migration');
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate-naming] FAILED (rolled back):', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
