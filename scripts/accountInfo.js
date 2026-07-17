'use strict';

// Read-only diagnostic: print everything tied to one account (by email) so it
// can be verified before any cleanup. Saves pasting SQL into a console.
//
// Prints: the users row (id, email, google_id, tenant_id), that tenant's row
// (id, workspace_id, plan), the tenant's tenant_tokens SERVICE NAMES ONLY (never
// token values), and counts of asset_types + copy_fields for the tenant.
//
// Usage:  railway run node scripts/accountInfo.js [email]
//   email  optional — defaults to the account currently under test.
// Requires DATABASE_URL. Reads only — never writes, never deletes.

const EMAIL = process.argv[2] || 'soundkid.management@gmail.com';

function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[account] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[account] could not load "pg": ' + err.message);
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  try {
    await client.connect();

    // 1) users row(s) for this email.
    const users = await client.query(
      'SELECT id, email, google_id, tenant_id FROM users WHERE email = $1',
      [EMAIL]
    );

    console.log(`\n=== account: ${EMAIL} ===\n`);
    console.log(`(1) users rows found: ${users.rows.length}`);
    if (users.rows.length === 0) {
      console.log('    -> no user with this email. Nothing to delete.\n');
      process.exit(0);
    }
    for (const u of users.rows) {
      console.log(`    id=${u.id}  google_id=${u.google_id}  tenant_id=${u.tenant_id}`);
    }
    if (users.rows.length > 1) {
      console.log('    !! more than one user row — STOP and review before deleting.\n');
    }

    const tenantId = users.rows[0].tenant_id;
    console.log(`\n    tenant_id under inspection: ${tenantId}\n`);

    // 2) tenants row for that tenant_id.
    const tenant = await client.query(
      'SELECT id, workspace_id, plan FROM tenants WHERE id = $1',
      [tenantId]
    );
    console.log(`(2) tenants row: ${tenant.rows.length ? '' : '(none found)'}`);
    for (const t of tenant.rows) {
      console.log(`    id=${t.id}  workspace_id=${t.workspace_id}  plan=${t.plan}`);
    }

    // 3) tenant_tokens — service names only, never the token values.
    const tokens = await client.query(
      'SELECT service FROM tenant_tokens WHERE tenant_id = $1 ORDER BY service',
      [tenantId]
    );
    console.log(`\n(3) tenant_tokens services (${tokens.rows.length}):`);
    console.log(
      tokens.rows.length ? '    ' + tokens.rows.map((r) => r.service).join(', ') : '    (none)'
    );

    // 4) counts of asset_types + copy_fields for the tenant. copy_fields has no
    // tenant_id — it links via asset_type_id, so count through asset_types.
    const counts = await client.query(
      `SELECT
         (SELECT count(*) FROM asset_types WHERE tenant_id = $1) AS asset_types,
         (SELECT count(*) FROM copy_fields
            WHERE asset_type_id IN (SELECT id FROM asset_types WHERE tenant_id = $1)) AS copy_fields`,
      [tenantId]
    );
    const c = counts.rows[0];
    console.log(`\n(4) library row counts for tenant ${tenantId}:`);
    console.log(`    asset_types = ${c.asset_types}`);
    console.log(`    copy_fields = ${c.copy_fields}`);
    console.log('');

    process.exit(0);
  } catch (err) {
    console.error('[account] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
