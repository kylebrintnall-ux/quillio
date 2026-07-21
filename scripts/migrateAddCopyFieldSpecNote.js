'use strict';

// Field-level guidance migration. Adds a per-field `spec_note` column to
// copy_fields and backfills the previously-hardcoded "Hook" explainer into it,
// so per-field italic guidance in the copy doc becomes DB-driven instead of
// hardcoded in fieldHint() (src/destinations/googleDocs.js).
//
// Idempotent + non-destructive:
//   • ADD COLUMN IF NOT EXISTS — safe to run repeatedly.
//   • The backfill only sets rows whose spec_note IS NULL, so a re-run never
//     clobbers a value edited later.
//
// Run on Railway with: railway run node scripts/migrateAddCopyFieldSpecNote.js
//
// SEQUENCING (important): run this BEFORE the code that reads
// copy_fields.spec_note goes live. The code change removes the hardcoded Hook
// hint and relies solely on spec_note, so if the migration hasn't run yet, Hook
// fields render no note in the gap between deploy and migration.

// The EXACT text currently hardcoded in fieldHint(), kept byte-identical so the
// rendered doc note is unchanged (note the curly “…” quotes and the em dash —).
const HOOK_NOTE =
  'Only this opening runs before the app collapses the rest behind “…more.” ' +
  'Land the hook within the character limit; the full caption/post can keep going — it just shows after the fold.';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate-specnote] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-specnote] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    // 1. Add the per-field column (idempotent).
    await client.query('ALTER TABLE copy_fields ADD COLUMN IF NOT EXISTS spec_note TEXT');
    console.log('[migrate-specnote] ensured column: copy_fields.spec_note');

    // 2. Backfill the Hook explainer onto every Hook field, across all tenants.
    //    `~* '^Hook\y'` mirrors the old /^Hook\b/i regex (case-insensitive, with a
    //    word boundary after "Hook" so e.g. "Hookah" would not match). The
    //    `spec_note IS NULL` guard keeps this idempotent and non-clobbering.
    const res = await client.query(
      `UPDATE copy_fields
          SET spec_note = $1
        WHERE field_name ~* '^Hook\\y'
          AND spec_note IS NULL`,
      [HOOK_NOTE]
    );
    console.log(`[migrate-specnote] backfilled Hook spec_note on ${res.rowCount} field row(s)`);

    console.log('[migrate-specnote] done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate-specnote] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
