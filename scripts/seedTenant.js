'use strict';

// Seeds the default (single-tenant demo) row into the Phase 3 Postgres schema
// from the current env vars. Idempotent — safe to re-run. Run on Railway:
//   railway run node scripts/seedTenant.js
//
// NOTE on the schema: the migrated `tenants` table uses `id` (TEXT) as the
// primary key and has no unique constraint on `workspace_id`. So we set
// id = workspace_id and conflict on the primary key (id), rather than on
// workspace_id, which is what the schema actually supports.

const WORKSPACE_ID = 'T0B8LPRDKHR';
const WORKSPACE_NAME = 'Quillio Inc.';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[seed] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[seed] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    // Default tenant.
    await client.query(
      `INSERT INTO tenants
         (id, workspace_id, workspace_name, plan, onboarding_complete, default_folder_id)
       VALUES ($1, $2, $3, 'demo', true, $4)
       ON CONFLICT (id) DO NOTHING`,
      [WORKSPACE_ID, WORKSPACE_ID, WORKSPACE_NAME, process.env.DRIVE_FOLDER_ID || null]
    );
    console.log(`[seed] tenant ensured: ${WORKSPACE_ID} (${WORKSPACE_NAME})`);

    // Service tokens. One row per service; re-running refreshes the token.
    const tokens = [
      ['slack_bot', process.env.SLACK_BOT_TOKEN],
      ['slack_user', process.env.SLACK_USER_TOKEN],
      ['google', process.env.GOOGLE_REFRESH_TOKEN],
    ];
    for (const [service, token] of tokens) {
      if (!token) {
        console.log(`[seed] skipped token (env not set): ${service}`);
        continue;
      }
      await client.query(
        `INSERT INTO tenant_tokens (tenant_id, service, access_token, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (tenant_id, service) DO UPDATE
           SET access_token = EXCLUDED.access_token, updated_at = now()`,
        [WORKSPACE_ID, service, token]
      );
      console.log(`[seed] token upserted: ${service}`);
    }

    console.log('[seed] done');
    process.exit(0);
  } catch (err) {
    console.error('[seed] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
