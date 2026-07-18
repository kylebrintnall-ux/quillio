'use strict';

// Migration — Slack-user link (Stage 1). Adds tenants.slack_team_id and a
// partial unique index so two tenants can't claim the same Slack user within a
// workspace. Together with the existing tenants.slack_user_id column this lets
// /quillio resolve (team_id + user_id) → the user's own tenant.
// Standalone and idempotent (IF NOT EXISTS); safe to run alongside migrateDb.js.
// Run on Railway with: railway run node scripts/migrateAddSlackTeamLink.js

const STATEMENTS = [
  'ALTER TABLE tenants ADD COLUMN IF NOT EXISTS slack_team_id TEXT',
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_tenants_slack_link
     ON tenants (slack_team_id, slack_user_id)
     WHERE slack_team_id IS NOT NULL AND slack_user_id IS NOT NULL`,
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate-slack-link] DATABASE_URL not set — nothing to do.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-slack-link] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    console.log('[migrate-slack-link] added column: tenants.slack_team_id');
    console.log('[migrate-slack-link] added index: uq_tenants_slack_link (partial unique on team+user)');
    console.log('[migrate-slack-link] done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate-slack-link] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
