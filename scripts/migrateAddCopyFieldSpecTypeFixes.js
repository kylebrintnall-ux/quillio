'use strict';

// Corrective spec_type migration. Promotes two fields confirmed as genuine
// platform hard caps (verified against the platforms' own spec pages) from
// 'house_default' to 'enforced':
//   • LinkedIn Single Image Ad → "LAN Description"
//       (LinkedIn Audience Network description, 70-char cap)
//   • Twitter/X Ad → "Headline"
//       (X media/website-card headline, 70-char cap)
//
// Per-asset-pair matching ONLY: "Headline"/"Description" exist on many other
// assets (Meta, LinkedIn variants, emails, signage, one-pagers, …) that MUST
// stay house_default, so this never uses a global field_name match. On Twitter/X
// the plain "Headline" is a different field from "Graphic Headline" — only the
// former is promoted.
//
// Idempotent + non-clobbering: only rows currently 'house_default' for these
// exact pairs are touched, so a re-run (they're now 'enforced') changes nothing
// and it never overwrites a value set elsewhere.
//
// Run on Railway with: railway run node scripts/migrateAddCopyFieldSpecTypeFixes.js
//
// SEQUENCING: run this BEFORE the code that seeds these tiers goes live
// (src/data/defaultAssets.js now seeds both pairs 'enforced') — same ordering
// as the prior spec_type work.

// The (asset_types.name, copy_fields.field_name) pairs to promote. Kept in sync
// with the additions to ENFORCED_SPEC_FIELDS in src/data/defaultAssets.js; the
// current full enforced set = migrateAddCopyFieldSpecType.ENFORCED (23) ∪ this (2).
const PROMOTE = [
  ['LinkedIn Single Image Ad', 'LAN Description'],
  ['Twitter/X Ad', 'Headline'],
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate-spectype-fix] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-spectype-fix] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    // Promote only the two exact pairs, and only where still 'house_default'.
    const tuples = PROMOTE.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
    const res = await client.query(
      `UPDATE copy_fields cf
          SET spec_type = 'enforced'
         FROM asset_types at
        WHERE cf.asset_type_id = at.id
          AND cf.spec_type = 'house_default'
          AND (at.name, cf.field_name) IN (${tuples})`,
      PROMOTE.flat()
    );
    console.log(
      `[migrate-spectype-fix] promoted ${res.rowCount} field row(s) to 'enforced' (expected 4: 2 fields × 2 tenants)`
    );

    console.log('[migrate-spectype-fix] done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate-spectype-fix] FAILED:', err.message);
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

module.exports = { PROMOTE };
