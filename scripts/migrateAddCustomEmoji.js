'use strict';

// Migration: add tenants.custom_emoji (BOOLEAN). Tracks whether a tenant's
// workspace has the custom Quillio emoji available, so the adapter can choose
// custom vs. fallback emoji per tenant. Idempotent (ADD COLUMN IF NOT EXISTS).
// Run on Railway: railway run node scripts/migrateAddCustomEmoji.js

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    await client.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS custom_emoji BOOLEAN DEFAULT false');
    console.log('[migrate] added column: tenants.custom_emoji');
    console.log('[migrate] done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
