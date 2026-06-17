'use strict';

// Quick Postgres connectivity test. Connects using DATABASE_URL, runs a trivial
// query, logs success or the error, and exits. Run with: node scripts/testDb.js
// (on Railway: `railway run node scripts/testDb.js`).

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[testDb] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[testDb] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  // Managed Postgres (Railway, etc.) usually requires SSL; relax cert checking.
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const res = await client.query('SELECT version()');
    console.log('[testDb] connection OK:', res.rows[0].version);
    process.exit(0);
  } catch (err) {
    console.error('[testDb] connection FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
