'use strict';

// DESTRUCTIVE — fully deletes one account (user + its tenant + all tenant-owned
// rows) so the same Google identity can re-sign-up from scratch. Companion to
// the read-only scripts/accountInfo.js — run that FIRST and confirm the account.
//
// Safety guards (aborts, deletes nothing, if any fail):
//   • exactly one users row matches the email
//   • that user's tenant exists
//   • the tenant is an unlinked per-user tenant (workspace_id IS NULL) — refuses
//     to touch a Slack/shared workspace tenant
//   • exactly one user belongs to that tenant
// All deletes run inside a single transaction (BEGIN/COMMIT), FK-safe order
// (children before parents), ROLLBACK on any error. Prints a per-table count.
//
// Usage:  railway run node scripts/accountDelete.js [email]
//   email  optional — defaults to the account currently under test.
// Requires DATABASE_URL.

const EMAIL = process.argv[2] || 'soundkid.management@gmail.com';

function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// FK-safe delete order: each entry deletes rows for the tenant, children first.
// $1 is always the tenant id.
const STEPS = [
  ['project_assets', 'DELETE FROM project_assets WHERE project_id IN (SELECT id FROM projects WHERE tenant_id = $1)'],
  ['copy_fields', 'DELETE FROM copy_fields WHERE asset_type_id IN (SELECT id FROM asset_types WHERE tenant_id = $1)'],
  ['design_mappings', 'DELETE FROM design_mappings WHERE tenant_id = $1'],
  ['projects', 'DELETE FROM projects WHERE tenant_id = $1'],
  ['asset_types', 'DELETE FROM asset_types WHERE tenant_id = $1'],
  ['templates', 'DELETE FROM templates WHERE tenant_id = $1'],
  ['workflow_roles', 'DELETE FROM workflow_roles WHERE tenant_id = $1'],
  ['deck_templates', 'DELETE FROM deck_templates WHERE tenant_id = $1'],
  ['personas', 'DELETE FROM personas WHERE tenant_id = $1'],
  ['prompt_templates', 'DELETE FROM prompt_templates WHERE tenant_id = $1'],
  ['voice_guide', 'DELETE FROM voice_guide WHERE tenant_id = $1'],
  ['tenant_tokens', 'DELETE FROM tenant_tokens WHERE tenant_id = $1'],
  ['users', 'DELETE FROM users WHERE tenant_id = $1'],
  ['tenants', 'DELETE FROM tenants WHERE id = $1'],
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[delete] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[delete] could not load "pg": ' + err.message);
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  try {
    await client.connect();
    console.log(`\n=== delete account: ${EMAIL} ===\n`);

    // Guard 1: exactly one user for this email.
    const users = await client.query('SELECT id, tenant_id FROM users WHERE email = $1', [EMAIL]);
    if (users.rows.length !== 1) {
      console.error(`[delete] ABORT: expected exactly 1 user for ${EMAIL}, found ${users.rows.length}. Nothing deleted.`);
      process.exit(1);
    }
    const tenantId = users.rows[0].tenant_id;
    console.log(`user id=${users.rows[0].id}  tenant_id=${tenantId}`);
    if (!tenantId) {
      console.error('[delete] ABORT: user has no tenant_id. Nothing deleted.');
      process.exit(1);
    }

    // Guard 2: tenant exists and is an unlinked per-user tenant (workspace_id NULL).
    const tenant = await client.query('SELECT id, workspace_id FROM tenants WHERE id = $1', [tenantId]);
    if (tenant.rows.length !== 1) {
      console.error(`[delete] ABORT: tenant ${tenantId} not found (${tenant.rows.length} rows). Nothing deleted.`);
      process.exit(1);
    }
    if (tenant.rows[0].workspace_id !== null) {
      console.error(
        `[delete] ABORT: tenant workspace_id is ${JSON.stringify(tenant.rows[0].workspace_id)}, not NULL — ` +
          'this looks like a linked/shared workspace, not a per-user tenant. Nothing deleted.'
      );
      process.exit(1);
    }

    // Guard 3: exactly one user belongs to this tenant.
    const tenantUsers = await client.query('SELECT count(*)::int AS n FROM users WHERE tenant_id = $1', [tenantId]);
    if (tenantUsers.rows[0].n !== 1) {
      console.error(
        `[delete] ABORT: tenant ${tenantId} has ${tenantUsers.rows[0].n} users — deleting it would affect others. Nothing deleted.`
      );
      process.exit(1);
    }

    console.log('guards passed (1 user for email, tenant exists, workspace_id NULL, 1 user on tenant)\n');

    // Delete everything for this tenant in one transaction.
    await client.query('BEGIN');
    const deleted = [];
    for (const [table, sql] of STEPS) {
      const r = await client.query(sql, [tenantId]);
      deleted.push([table, r.rowCount]);
      console.log(`  deleted ${String(r.rowCount).padStart(3)}  from ${table}`);
    }
    await client.query('COMMIT');

    const total = deleted.reduce((s, [, n]) => s + n, 0);
    console.log(`\nCOMMIT ok — ${total} rows removed across ${deleted.length} tables.`);
    console.log(`Account ${EMAIL} (tenant ${tenantId}) fully deleted. The Google identity can now re-sign-up clean.\n`);
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[delete] FAILED — rolled back, nothing deleted:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
