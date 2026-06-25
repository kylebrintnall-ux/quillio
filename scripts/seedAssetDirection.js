'use strict';

// One-off backfill: set asset_types.asset_direction for existing rows from the
// default library, matched by name (across all tenants). Idempotent — re-running
// just re-applies the same values. Run AFTER scripts/migrateAddAssetDirection.js:
//   railway run node scripts/seedAssetDirection.js

const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[seed-asset-direction] DATABASE_URL not set — nothing to do.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[seed-asset-direction] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    let updated = 0;
    for (const asset of DEFAULT_ASSETS) {
      const direction = asset.asset_direction || null;
      if (!direction) continue;
      const res = await client.query(
        'UPDATE asset_types SET asset_direction = $1 WHERE name = $2',
        [direction, asset.name]
      );
      updated += res.rowCount || 0;
      console.log(`[seed-asset-direction] ${asset.name} → ${res.rowCount} row(s)`);
    }
    console.log(`[seed-asset-direction] done — ${updated} asset_types row(s) updated`);
    process.exit(0);
  } catch (err) {
    console.error('[seed-asset-direction] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
