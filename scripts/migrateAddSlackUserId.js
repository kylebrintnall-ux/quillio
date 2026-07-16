'use strict';

// Migration — adds the `slack_user_id` column to the `tenants` table.
// Standalone and idempotent (ADD COLUMN IF NOT EXISTS); safe to run alongside
// migrateDb.js. Run on Railway with: railway run node scripts/migrateAddSlackUserId.js

const SLACK_USER_ID_DDL =
  'ALTER TABLE tenants ADD COLUMN IF NOT EXISTS slack_user_id TEXT';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate-slack-user-id] DATABASE_URL not set — nothing to do.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-slack-user-id] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    await client.query(SLACK_USER_ID_DDL);
    console.log('[migrate-slack-user-id] added column: tenants.slack_user_id');
    console.log('[migrate-slack-user-id] done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate-slack-user-id] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
