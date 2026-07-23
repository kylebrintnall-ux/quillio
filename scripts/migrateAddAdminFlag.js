'use strict';

// Migration — admin gate (LiveSpecs admin, Step 1). Adds users.is_admin and
// grants it to the single admin user, matched by email. Standalone and
// idempotent (ADD COLUMN IF NOT EXISTS; the UPDATE is a no-op the second time);
// safe to run alongside migrateDb.js.
// Run on Railway with: railway run node scripts/migrateAddAdminFlag.js
//
// The admin email can be overridden at run time:
//   railway run ADMIN_EMAIL=you@example.com node scripts/migrateAddAdminFlag.js
// Matching is case-insensitive (LOWER(email)). Prints the rows changed by the
// grant (expected 1).

// The user row to grant admin. Overridable via ADMIN_EMAIL. This is matched
// against users.email (the Google sign-in email), case-insensitively.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'kyle.brintnall@gmail.com').trim();

const ADD_COLUMN_SQL =
  'ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false';
const GRANT_SQL =
  'UPDATE users SET is_admin = true WHERE LOWER(email) = LOWER($1)';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate-admin] DATABASE_URL not set — nothing to do.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-admin] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    await client.query(ADD_COLUMN_SQL);
    console.log('[migrate-admin] added column: users.is_admin (BOOLEAN DEFAULT false)');

    const res = await client.query(GRANT_SQL, [ADMIN_EMAIL]);
    console.log(`[migrate-admin] granted is_admin=true where LOWER(email)=LOWER('${ADMIN_EMAIL}')`);
    console.log(`[migrate-admin] rows changed: ${res.rowCount} (expected 1)`);
    if (res.rowCount !== 1) {
      console.warn(
        `[migrate-admin] WARNING: expected exactly 1 row, got ${res.rowCount}. ` +
          'Check that the ADMIN_EMAIL matches your users.email row exactly.'
      );
    }

    console.log('[migrate-admin] done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate-admin] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
