'use strict';

// Phase 3 / Week 12 migration — adds the `asset_direction` column to asset_types
// for asset-level creative direction (one italic line under the asset heading).
// Standalone + idempotent (ADD COLUMN IF NOT EXISTS). Run on Railway with:
//   railway run node scripts/migrateAddAssetDirection.js
// Run this BEFORE deploying the code that reads/writes the column, and before
// scripts/seedAssetDirection.js.

const DDL = 'ALTER TABLE asset_types ADD COLUMN IF NOT EXISTS asset_direction TEXT';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate-asset-direction] DATABASE_URL not set — nothing to do.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-asset-direction] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    await client.query(DDL);
    console.log('[migrate-asset-direction] added column: asset_types.asset_direction');
    console.log('[migrate-asset-direction] done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate-asset-direction] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
