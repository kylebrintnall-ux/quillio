'use strict';

// Read-only diagnostic: print recent projects rows so you can verify that
// briefs (web AND Slack) persist — and, via slack_channel_id, tell which
// entry point created each. Saves pasting SQL into a console.
//
// Usage:  railway run node scripts/queryProjects.js [tenantId] [limit]
//   tenantId  optional — filter to one tenant (default: all tenants).
//   limit     optional — how many rows, newest first (default: 10).
// Requires DATABASE_URL. Reads only — never writes.

const arg1 = process.argv[2] || null;
const arg2 = process.argv[3] || null;
// Allow `queryProjects.js 20` (a bare limit with no tenant).
const TENANT = arg1 && /^\d+$/.test(arg1) ? null : arg1;
const LIMIT = Number(arg2) || (arg1 && /^\d+$/.test(arg1) ? Number(arg1) : 10);

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
    const where = TENANT ? 'WHERE tenant_id = $1' : '';
    const params = TENANT ? [TENANT, LIMIT] : [LIMIT];
    const res = await client.query(
      `SELECT id, tenant_id, name, status, slack_channel_id, slack_thread_ts, created_at
         FROM projects ${where}
        ORDER BY created_at DESC
        LIMIT $${TENANT ? 2 : 1}`,
      params
    );

    console.log(
      `\nprojects${TENANT ? ` for tenant ${TENANT}` : ' (all tenants)'} — newest ${res.rows.length}\n`
    );
    if (res.rows.length === 0) {
      console.log('(no rows)\n');
      process.exit(0);
    }
    for (const r of res.rows) {
      const source = r.slack_channel_id ? `slack (ch ${r.slack_channel_id})` : 'web';
      console.log(`#${r.id}  ${r.created_at ? r.created_at.toISOString() : ''}`);
      console.log(`     tenant : ${r.tenant_id}`);
      console.log(`     name   : ${r.name}`);
      console.log(`     status : ${r.status}`);
      console.log(`     source : ${source}${r.slack_thread_ts ? `  thread ${r.slack_thread_ts}` : ''}`);
      console.log('');
    }
    process.exit(0);
  } catch (err) {
    console.error('[query] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
