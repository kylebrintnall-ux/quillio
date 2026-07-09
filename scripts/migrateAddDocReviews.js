'use strict';

// Copy-review feature — add the doc_reviews table that remembers, per copy doc,
// what the last review flagged and the copy state at that time, so a re-review
// can recognize the writer's improvements and not re-nag.
//
// Idempotent: CREATE TABLE IF NOT EXISTS, safe to run repeatedly. Wrapped in a
// transaction. Matches scripts/migrate*.js (sslFor, DATABASE_URL required).
//
// Run on Railway:  railway run node scripts/migrateAddDocReviews.js
//   (or:  npm run migrate-reviews)

function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS doc_reviews (
     copy_doc_id TEXT PRIMARY KEY,
     state JSONB,
     updated_at TIMESTAMPTZ DEFAULT now()
   )`,
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate-reviews] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-reviews] could not load "pg": ' + err.message);
    process.exit(1);
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  try {
    await client.connect();
    await client.query('BEGIN');
    for (const sql of STATEMENTS) await client.query(sql);
    await client.query('COMMIT');

    const check = await client.query(
      `SELECT to_regclass('public.doc_reviews') AS t`
    );
    if (check.rows[0] && check.rows[0].t) {
      console.log('[migrate-reviews] done — doc_reviews table EXISTS');
    } else {
      console.error('[migrate-reviews] WARNING — table still not present after migration');
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[migrate-reviews] FAILED (rolled back):', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
