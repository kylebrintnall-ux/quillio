'use strict';

// Migration — give every BUNDLED asset's untiered field the tier the seed says
// it has. NULL -> 'house_default', on seeded assets only.
//
// THE DRIFT. migrateAddCopyFieldSpecType ended with
//   UPDATE copy_fields SET spec_type = 'house_default' WHERE spec_type IS NULL
// so at that moment every row had a tier. Three later migrations then INSERT
// fields into seeded assets and OMIT spec_type from the column list:
//   scripts/migrateAssetSpecFixes.js:238    (Graphic Headline, ~10 assets)
//   scripts/migrateAddSubheadField.js:102   (Subhead)
//   scripts/migrateAddGraphicCopyGroup.js:142
// Any of those that ran after the backfill left NULL rows behind. The seed
// (src/data/defaultAssets.js) gives those same fields 'house_default', so a
// freshly seeded tenant and a migrated one disagree about the same field —
// exactly the divergence CLAUDE.md's seed-vs-migration rule exists to prevent.
//
// WHY IT HAS NEVER SHOWN. Nothing distinguished the two values: specTypeLine
// returns null for house_default AND for null, and settings.html's libTierNode
// does the same. The house-default editing work is the first code to tell them
// apart — the doc's "House default — set your own in Settings." line renders for
// 'house_default' and NOT for null, because a NULL tier is also what every
// TENANT-AUTHORED field carries, and a custom field has no house default to set.
// Left alone, the longest-lived tenants would be the ones whose Graphic Headline
// and Subhead silently never mention Settings.
//
// SEEDED ASSETS ONLY, AND THE PREDICATE IS THE APP'S. The asset list and the
// name fold both come from the running code — DEFAULT_ASSETS through
// db/assets.isSeededAssetName, which folds via utils/normalize, the same fold
// the Postgres unique index uses. Deliberately NOT a SQL name match and NOT
// quillio_normalize_name(): matching in JS through the exported predicate means
// this script and updateAssetType's gate cannot drift, and it does not depend on
// that SQL function existing. A tenant-authored field keeps its NULL, which is
// correct and is the whole reason this is scoped.
//
// Idempotent: guarded on spec_type IS NULL, so a re-run touches 0 rows.
// Reversible in principle but not worth it — it writes the value the seed
// already asserts for the same field.
//
// Order relative to the code deploy does not matter. Before: fresh and migrated
// tenants agree from the first request. After: the affected fields are editable
// (the gate treats NULL as house_default) but render no Settings line until this
// runs. Neither state is broken.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateBackfillSeededSpecType.js            # dry run
//   node scripts/migrateBackfillSeededSpecType.js --commit   # write

const { Pool } = require('pg');
const { isSeededAssetName } = require('../src/db/assets');

const TAG = '[backfill-spectype]';
const COMMIT = process.argv.includes('--commit');

function sslFor(url) {
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
  const client = await pool.connect();
  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  try {
    await client.query('BEGIN');

    // Every untiered field, with its asset's name and tenant, so the report can
    // say what it is about to change before it changes anything.
    const { rows } = await client.query(
      `SELECT cf.id, cf.field_name, at.name AS asset_name, at.tenant_id
         FROM copy_fields cf
         JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE cf.spec_type IS NULL
        ORDER BY at.tenant_id, at.name, cf.sort_order, cf.id`
    );

    const seeded = rows.filter((r) => isSeededAssetName(r.asset_name));
    const custom = rows.filter((r) => !isSeededAssetName(r.asset_name));

    console.log(`\n${TAG} ${rows.length} field(s) with spec_type IS NULL:`);
    console.log(`${TAG}   ${seeded.length} on BUNDLED assets   -> house_default`);
    console.log(`${TAG}   ${custom.length} on TENANT assets    -> left NULL (a custom field has no house default)`);

    if (seeded.length > 0) {
      // Grouped by asset+field rather than listed per row: the same pair across
      // N tenants is one fact, and printing it N times buries it.
      const byPair = new Map();
      for (const r of seeded) {
        const k = `${r.asset_name} / ${r.field_name}`;
        byPair.set(k, (byPair.get(k) || 0) + 1);
      }
      console.log(`\n${TAG} bundled pairs to tier (pair × tenant rows):`);
      for (const [pair, n] of [...byPair].sort()) console.log(`  ${pair}  ×${n}`);

      const res = await client.query(
        `UPDATE copy_fields SET spec_type = 'house_default'
          WHERE id = ANY($1::bigint[]) AND spec_type IS NULL`,
        [seeded.map((r) => r.id)]
      );
      console.log(`\n${TAG} tiered ${res.rowCount} row(s)`);
    } else {
      console.log(`\n${TAG} nothing to do — no bundled asset has an untiered field.`);
    }

    if (custom.length > 0) {
      const names = [...new Set(custom.map((r) => r.asset_name))].sort();
      console.log(
        `${TAG} untouched tenant assets: ${names.slice(0, 10).join(', ')}` +
          (names.length > 10 ? ` … (+${names.length - 10} more)` : '')
      );
    }

    const { rows: after } = await client.query(
      `SELECT COALESCE(spec_type, '(null)') AS t, COUNT(*)::int AS n
         FROM copy_fields GROUP BY spec_type ORDER BY spec_type`
    );
    console.log(`\n${TAG} copy_fields by spec_type after:`);
    for (const r of after) console.log(`  ${String(r.t).padEnd(14)} ${r.n}`);

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n${TAG} COMMITTED.`);
    } else {
      await client.query('ROLLBACK');
      console.log(`\n${TAG} ROLLED BACK (dry run) — no changes were written. Re-run with --commit to apply.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\n${TAG} ROLLED BACK — nothing was written.`);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run only when invoked directly. Requiring this module (the smoke test does)
// must NOT connect to a database.
if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { isSeededAssetName };
