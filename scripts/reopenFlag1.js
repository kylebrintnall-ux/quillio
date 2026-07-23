'use strict';

// One-off ops script (LiveSpecs chunk 3b testing). Re-opens spec_review_queue
// flag #1 — the Google false positive — back to 'pending' so the extraction
// (Approve → Suggest values) can be exercised on a real flag. Touches EXACTLY
// that one row and nothing else.
//
// Guarded with is_test = false so it can only ever reopen the real Google flag,
// never a test flag (test flags can't be approved anyway). Prints the before/
// after status and the rows changed (expected 1).
//
// This does NOT approve or write any spec value — it only flips a queue status.
// After eyeballing the suggestion, dismiss flag #1 again (the Dismiss button in
// /admin, or set status='dismissed') so it doesn't linger as a fake pending flag.
//
// Run on Railway with: railway run node scripts/reopenFlag1.js

const TARGET_ID = 1;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[reopen-flag1] DATABASE_URL not set — nothing to do.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[reopen-flag1] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    // Show the current state first (id, status, is_test) for transparency.
    const before = await client.query(
      'SELECT id, status, is_test, source_url FROM spec_review_queue WHERE id = $1',
      [TARGET_ID]
    );
    if (before.rowCount === 0) {
      console.error(`[reopen-flag1] no spec_review_queue row with id=${TARGET_ID} — aborting.`);
      process.exit(1);
    }
    const row = before.rows[0];
    console.log(
      `[reopen-flag1] flag #${row.id}: status='${row.status}', is_test=${row.is_test}, ${row.source_url}`
    );
    if (row.is_test) {
      console.error('[reopen-flag1] ABORTED: flag #1 is a TEST flag — refusing to reopen (guard).');
      process.exit(1);
    }

    // Reopen ONLY this one real row.
    const res = await client.query(
      "UPDATE spec_review_queue SET status = 'pending' WHERE id = $1 AND is_test = false RETURNING id, status",
      [TARGET_ID]
    );
    console.log(`[reopen-flag1] rows changed: ${res.rowCount} (expected 1)`);
    if (res.rowCount === 1) {
      console.log(`[reopen-flag1] flag #${res.rows[0].id} is now '${res.rows[0].status}'.`);
    }

    console.log('[reopen-flag1] done');
    process.exit(0);
  } catch (err) {
    console.error('[reopen-flag1] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
