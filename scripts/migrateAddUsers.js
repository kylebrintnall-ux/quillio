'use strict';

// Phase 3 / Week 11 migration — adds the `users` table for web sign-in (Sign in
// with Google). Standalone and idempotent (IF NOT EXISTS); safe to run alongside
// migrateDb.js. Run on Railway with: railway run node scripts/migrateAddUsers.js
//
// The connect-pg-simple session table is created automatically at boot, so it
// is intentionally NOT defined here.

const USERS_DDL = `CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  google_id TEXT UNIQUE,
  display_name TEXT,
  avatar_url TEXT,
  tenant_id TEXT REFERENCES tenants(id),
  role TEXT DEFAULT 'owner',
  created_at TIMESTAMPTZ DEFAULT NOW()
)`;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate-users] DATABASE_URL not set — nothing to do.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-users] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    await client.query(USERS_DDL);
    console.log('[migrate-users] created table: users');
    console.log('[migrate-users] done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate-users] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
