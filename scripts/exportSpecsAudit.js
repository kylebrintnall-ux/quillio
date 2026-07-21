'use strict';

// One-off spec audit export. Connects to the production Postgres database
// (Railway), joins asset_types → copy_fields, and emits one JSON object per
// field with the shape:
//
//   { assetType, fieldName, charLimit, specSource, specNote }
//
// The full array is written to /tmp/current-specs-export.json AND printed to
// stdout so it can be copied straight from the terminal.
//
// Usage:  railway run node scripts/exportSpecsAudit.js [tenantId]
//   tenantId defaults to the demo tenant T0B8LPRDKHR.
// Requires DATABASE_URL. READ-ONLY — never writes to the database.

const fs = require('fs');

const TENANT = process.argv[2] || 'T0B8LPRDKHR';
const OUTPUT_PATH = '/tmp/current-specs-export.json';

function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[export] DATABASE_URL is not set in this environment.');
    console.error('[export] Run via Railway, e.g.:  railway run node scripts/exportSpecsAudit.js');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[export] could not load "pg": ' + err.message);
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  try {
    await client.connect();

    // Read-only join. spec_note lives on asset_types; spec_source, field_name
    // and char_max live on copy_fields. char_max is the enforced character
    // limit. Ordered by asset then field sort_order for a stable, readable dump.
    const res = await client.query(
      `SELECT at.name        AS asset_type,
              cf.field_name   AS field_name,
              cf.char_max     AS char_limit,
              cf.spec_source  AS spec_source,
              at.spec_note    AS spec_note
         FROM asset_types at
         JOIN copy_fields cf ON cf.asset_type_id = at.id
        WHERE at.tenant_id = $1
        ORDER BY at.sort_order, at.id, cf.sort_order, cf.id`,
      [TENANT]
    );

    const rows = res.rows.map((r) => ({
      assetType: r.asset_type,
      fieldName: r.field_name,
      charLimit: r.char_limit,
      specSource: r.spec_source,
      specNote: r.spec_note,
    }));

    const json = JSON.stringify(rows, null, 2);
    fs.writeFileSync(OUTPUT_PATH, json + '\n');

    // Full JSON to stdout so it can be copied directly from the terminal.
    console.log(json);

    // Summary to stderr so it doesn't pollute the copyable JSON on stdout.
    const assetTypeCount = new Set(rows.map((r) => r.assetType)).size;
    console.error('');
    console.error(`[export] wrote ${rows.length} field rows to ${OUTPUT_PATH}`);
    console.error(`[export] distinct asset types: ${assetTypeCount} (expected ~30)`);
    if (assetTypeCount < 25) {
      console.error(`[export] WARNING: only ${assetTypeCount} asset types — expected ~30. Check the tenant / DB.`);
    }

    process.exit(0);
  } catch (err) {
    console.error('[export] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
