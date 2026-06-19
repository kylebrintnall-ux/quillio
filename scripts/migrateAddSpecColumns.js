'use strict';

// Phase 3 / Week 7 schema migration. Adds spec provenance columns to
// copy_fields so each seeded field can record where its spec came from
// (`spec_source`, e.g. 'quillio_default') and its version (`spec_version`).
// Both use ADD COLUMN IF NOT EXISTS, so it's safe to run repeatedly.
// Run on Railway with: railway run node scripts/migrateAddSpecColumns.js
//
// Scope note: spec columns live on copy_fields ONLY (per the Week 7 plan) —
// not asset_types — because provenance is tracked at the field-spec level.

const ALTERS = [
  ['copy_fields.spec_source', `ALTER TABLE copy_fields ADD COLUMN IF NOT EXISTS spec_source TEXT`],
  ['copy_fields.spec_version', `ALTER TABLE copy_fields ADD COLUMN IF NOT EXISTS spec_version TEXT`],
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate-spec] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-spec] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    for (const [col, ddl] of ALTERS) {
      await client.query(ddl);
      console.log('[migrate-spec] ensured column: ' + col);
    }
    console.log('[migrate-spec] done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate-spec] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
