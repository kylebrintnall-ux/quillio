'use strict';

// Migration — per-user credentials (accounts/tenants split, step 1: SCHEMA).
//
// Moves credentials that belong to a PERSON off the tenant:
//   user_tokens        — (user_id, service) → that user's own service token.
//                        Replaces tenant_tokens for 'google' / 'slack_user',
//                        which upserted on (tenant_id, service), so the second
//                        person on a tenant silently overwrote the first.
//   user_slack_links   — (slack_team_id, slack_user_id) UNIQUE → user_id.
//                        Replaces the single tenants.slack_team_id /
//                        tenants.slack_user_id pair, which allowed exactly ONE
//                        linked Slack identity per tenant.
//   projects.created_by — nullable FK to users(id) so a project records who
//                        made it. Existing rows stay NULL.
//
// This script only creates schema; it moves no data. Run
// scripts/migrateBackfillUserCredentials.js afterwards to carry the existing
// tenant-level credentials forward.
//
// NOTHING IS DROPPED. tenant_tokens and the tenants.slack_* columns stay in
// place and are still read as a fallback, so a deploy that lands before this
// migration (or before the backfill) keeps working.
//
// Standalone and idempotent (IF NOT EXISTS everywhere); safe to re-run and safe
// to run alongside migrateDb.js. Run in the Railway console:
//   node scripts/migrateAddUserCredentials.js

const TAG = '[migrate-user-creds]';

const STATEMENTS = [
  [
    'user_tokens',
    // Column layout deliberately mirrors tenant_tokens so the backfill is a
    // straight copy. Note the same misnomer as tenant_tokens: a Google REFRESH
    // token is stored in access_token (that is what saveTenantToken always did).
    `CREATE TABLE IF NOT EXISTS user_tokens (
      user_id BIGINT REFERENCES users(id),
      service TEXT NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (user_id, service)
    )`,
  ],
  [
    'user_slack_links',
    `CREATE TABLE IF NOT EXISTS user_slack_links (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      slack_team_id TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
  ],
  [
    'index uq_user_slack_links_identity',
    // One Slack identity maps to exactly one user. NOT partial (unlike
    // uq_tenants_slack_link) because both columns are NOT NULL here. A user may
    // hold several rows — one per Slack workspace they belong to.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_user_slack_links_identity
       ON user_slack_links (slack_team_id, slack_user_id)`,
  ],
  [
    'index ix_user_slack_links_user',
    `CREATE INDEX IF NOT EXISTS ix_user_slack_links_user ON user_slack_links (user_id)`,
  ],
  [
    'projects.created_by',
    'ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_by BIGINT REFERENCES users(id)',
  ],
];

// Railway's Postgres needs SSL; a local/dev URL generally does not.
function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`${TAG} DATABASE_URL is not set in this environment.`);
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error(`${TAG} could not load "pg" — is it installed? ` + err.message);
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });

  try {
    await client.connect();
    for (const [name, ddl] of STATEMENTS) {
      await client.query(ddl);
      console.log(`${TAG} ensured: ${name}`);
    }
    console.log(`${TAG} done — nothing was dropped; run migrateBackfillUserCredentials.js next`);
    process.exit(0);
  } catch (err) {
    console.error(`${TAG} FAILED:`, err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
