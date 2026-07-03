'use strict';

// Read-only diagnostic: print a tenant's FULL asset library — every asset_type
// with its copy_fields (field name, char min–max, and Graphic Copy grouping) in
// order. Saves pasting SQL into a console.
//
// Usage:  railway run node scripts/queryAssetSpecs.js [tenantId]
//   tenantId defaults to the demo tenant T0B8LPRDKHR.
// Requires DATABASE_URL. Reads only — never writes.

const TENANT = process.argv[2] || 'T0B8LPRDKHR';

function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function limit(min, max) {
  if (min > 0 && max > 0) return `[${min}-${max}]`;
  if (max > 0) return `[${max}]`;
  return '[—]';
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[query] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[query] could not load "pg": ' + err.message);
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  try {
    await client.connect();
    const types = await client.query(
      'SELECT id, name, "group" AS group_name, sort_order FROM asset_types WHERE tenant_id = $1 ORDER BY sort_order, id',
      [TENANT]
    );
    if (types.rows.length === 0) {
      console.log(`\nNo asset_types found for tenant ${TENANT}.\n`);
      process.exit(0);
    }
    const ids = types.rows.map((t) => t.id);
    const fields = await client.query(
      `SELECT asset_type_id, field_name, char_min, char_max, sort_order, group_label
         FROM copy_fields WHERE asset_type_id = ANY($1::bigint[])
        ORDER BY sort_order, id`,
      [ids]
    );
    const byType = new Map();
    for (const f of fields.rows) {
      if (!byType.has(f.asset_type_id)) byType.set(f.asset_type_id, []);
      byType.get(f.asset_type_id).push(f);
    }

    let totalFields = 0;
    console.log(`\nAsset library for tenant ${TENANT} — ${types.rows.length} assets\n`);
    for (const t of types.rows) {
      const fs = byType.get(t.id) || [];
      totalFields += fs.length;
      console.log(`${t.sort_order}. ${t.name}  (${t.group_name || '—'})`);
      for (const f of fs) {
        const grp = f.group_label ? `   « ${f.group_label}` : '';
        console.log(`     - ${f.field_name} ${limit(f.char_min, f.char_max)}${grp}`);
      }
      console.log('');
    }
    console.log(`Total: ${types.rows.length} assets, ${totalFields} fields\n`);
    process.exit(0);
  } catch (err) {
    console.error('[query] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
