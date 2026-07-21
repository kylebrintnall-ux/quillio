'use strict';

// Per-field spec_type migration. Adds a `spec_type` column to copy_fields and
// backfills a three-tier provenance-of-constraint classification:
//
//   'enforced'      platform hard cap — over it the asset breaks / is rejected
//   'recommended'   advisory; can be exceeded (source column says by whom)
//   'house_default' Quillio's own convention, no external authority
//
// This build is DATA ONLY — nothing renders or branches on spec_type yet, and
// char_max enforcement is unchanged. `spec_source` is intentionally NOT touched
// here (provenance re-anchoring is a separate later pass).
//
// Idempotent + non-destructive:
//   • ADD COLUMN IF NOT EXISTS — safe to run repeatedly.
//   • Both backfill UPDATEs are guarded by `spec_type IS NULL`, so a re-run
//     no-ops and never clobbers a value edited later.
//
// Run on Railway with: railway run node scripts/migrateAddCopyFieldSpecType.js
//
// SEQUENCING (important): run this BEFORE the code that references
// copy_fields.spec_type goes live — seedTenantAssets() inserts the column, so
// it must exist first (same ordering as the spec_note change).

// Platform hard-cap fields, keyed by (asset_types.name, copy_fields.field_name).
// Enforcement is PER ASSET: the same field name (e.g. "Headline", "Intro Text",
// "Description") is a hard cap in one asset but only a house default in another,
// so this is a pair set — never a global field_name match. Field names are
// byte-identical to src/data/defaultAssets.js (see the fieldSpecType helper
// there, which tiers new tenants off this exact same set).
const ENFORCED = [
  ['Meta Single Image Ad', 'Primary Text'],
  ['Meta Single Image Ad', 'Headline'],
  ['Meta Single Image Ad', 'Description'],
  ['Meta Carousel Ad', 'Primary Text'],
  ['Meta Carousel Ad', 'Card 1 Headline'],
  ['Meta Carousel Ad', 'Card 2 Headline'],
  ['Meta Carousel Ad', 'Card 3 Headline'],
  ['Meta Carousel Ad', 'Card 4 Headline'],
  ['Meta Carousel Ad', 'Card 5 Headline'],
  ['Meta Carousel Ad', 'Card Description'],
  ['LinkedIn Single Image Ad', 'Intro Text'],
  ['LinkedIn Single Image Ad', 'Headline'],
  ['LinkedIn Carousel Ad', 'Intro Text'],
  ['LinkedIn Carousel Ad', 'Card 1 Headline'],
  ['LinkedIn Carousel Ad', 'Card 2 Headline'],
  ['LinkedIn Carousel Ad', 'Card 3 Headline'],
  ['LinkedIn Carousel Ad', 'Card 4 Headline'],
  ['LinkedIn Carousel Ad', 'Card 5 Headline'],
  ['Twitter/X Ad', 'Ad Copy'],
  ['Google DV360 / Responsive Display', 'Short Headline'],
  ['Google DV360 / Responsive Display', 'Long Headline'],
  ['Google DV360 / Responsive Display', 'Description'],
  ['Google DV360 / Responsive Display', 'Business Name'],
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate-spectype] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-spectype] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    // 1. Add the column (idempotent).
    await client.query('ALTER TABLE copy_fields ADD COLUMN IF NOT EXISTS spec_type TEXT');
    console.log('[migrate-spectype] ensured column: copy_fields.spec_type');

    // 2. Tag the platform hard-cap pairs 'enforced' (only rows still NULL, so a
    //    re-run is non-clobbering). Matched on (asset name, field name) via join.
    const tuples = ENFORCED.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
    const enforcedRes = await client.query(
      `UPDATE copy_fields cf
          SET spec_type = 'enforced'
         FROM asset_types at
        WHERE cf.asset_type_id = at.id
          AND cf.spec_type IS NULL
          AND (at.name, cf.field_name) IN (${tuples})`,
      ENFORCED.flat()
    );
    console.log(`[migrate-spectype] set 'enforced' on ${enforcedRes.rowCount} field row(s)`);

    // 3. Everything else still unset becomes 'house_default'.
    const houseRes = await client.query(
      `UPDATE copy_fields SET spec_type = 'house_default' WHERE spec_type IS NULL`
    );
    console.log(`[migrate-spectype] set 'house_default' on ${houseRes.rowCount} field row(s)`);

    console.log('[migrate-spectype] done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate-spectype] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

// Run only when invoked directly (railway run node …). Requiring this module
// (e.g. from the smoke test to verify byte-identical tiering) must NOT connect
// to a database, so main() is gated on require.main.
if (require.main === module) {
  main();
}

module.exports = { ENFORCED };
