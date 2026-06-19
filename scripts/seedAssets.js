'use strict';

// Seeds the default asset library into the demo tenant (T0B8LPRDKHR) in the
// Phase 3 Postgres schema. Idempotent — skips if the tenant already has asset
// types. Run on Railway with: railway run node scripts/seedAssets.js
//
// Prereqs: scripts/migrateDb.js (asset_types + copy_fields) and
// scripts/migrateAddSpecColumns.js (copy_fields.spec_source/spec_version) must
// have run first. Uses the shared seedTenantAssets() so the seed logic stays in
// one place (src/db/assets.js).

const WORKSPACE_ID = 'T0B8LPRDKHR';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[seed-assets] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }

  const { seedTenantAssets } = require('../src/db/assets');

  try {
    const seeded = await seedTenantAssets(WORKSPACE_ID);
    if (seeded) {
      console.log(`[seed-assets] seeded default asset library for ${WORKSPACE_ID}`);
    } else {
      console.log(`[seed-assets] no seed performed for ${WORKSPACE_ID} (already seeded or no DB)`);
    }
    console.log('[seed-assets] done');
    process.exit(0);
  } catch (err) {
    console.error('[seed-assets] FAILED:', err.message);
    process.exit(1);
  }
}

main();
