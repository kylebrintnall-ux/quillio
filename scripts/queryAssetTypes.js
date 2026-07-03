'use strict';

// Read-only diagnostic: print a tenant's asset_types (name, group, sort_order),
// so you don't have to paste SQL into a console. Runs the same query as:
//   SELECT name, "group", sort_order FROM asset_types
//    WHERE tenant_id = $1 ORDER BY sort_order;
//
// Usage:  railway run node scripts/queryAssetTypes.js [tenantId]
//   tenantId defaults to the demo tenant T0B8LPRDKHR.
// Requires DATABASE_URL. Reads only — never writes.

const TENANT = process.argv[2] || 'T0B8LPRDKHR';

function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
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
    const res = await client.query(
      'SELECT name, "group" AS group_name, sort_order FROM asset_types WHERE tenant_id = $1 ORDER BY sort_order, id',
      [TENANT]
    );

    console.log(`\nasset_types for tenant ${TENANT} — ${res.rows.length} row(s)\n`);
    const w = Math.max(4, ...res.rows.map((r) => String(r.name || '').length));
    console.log('sort'.padEnd(6) + 'name'.padEnd(w + 2) + 'group');
    console.log('-'.repeat(6) + '-'.repeat(w + 2) + '-'.repeat(20));
    for (const r of res.rows) {
      console.log(
        String(r.sort_order).padEnd(6) +
          String(r.name || '').padEnd(w + 2) +
          String(r.group_name || '')
      );
    }
    console.log('');
    process.exit(0);
  } catch (err) {
    console.error('[query] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
