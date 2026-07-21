'use strict';

// Note-only data fix: add mobile truncation/visibility spec_notes to email
// Subject Line and Preheader fields, citing Litmus. These fields carry a
// working-range char_max (Subject Lines 50–75, Preheader 85–120) but nothing
// told the writer where MOBILE inboxes clip — ~40 chars for subject lines,
// ~35–40 for preheaders. A writer seeing "75" doesn't know mobile cuts at 40.
//
// NOTHING numeric changes: char_max, char_min, spec_type and spec_source are
// left untouched. Only spec_note is set.
//
// PER-ASSET-PAIR match: "Subject Line 1/2" and "Preheader" appear on all 5
// email assets, and reused names like "Body Copy"/"Headline"/"CTA Text" also
// live on non-email assets — so we match the exact (asset_name, field_name)
// pairs, never field_name alone. Only these 15 field defs (3 fields × 5 email
// assets) are touched.
//
// Idempotent + non-clobbering: guarded by spec_note IS NULL, so a re-run — or a
// field that already carries a note — changes nothing.
//
// Run on Railway with:
//   railway run node scripts/migrateAddEmailSubjectPreheaderNotes.js
//
// SEQUENCING: run this BEFORE deploying the seed change (defaultAssets.js now
// seeds the same notes) — same ordering as the prior data migrations.

// spec_note text — kept BYTE-IDENTICAL to EMAIL_SUBJECT_NOTE / EMAIL_PREHEADER_NOTE
// in src/data/defaultAssets.js (the smoke test asserts it).
const SUBJECT_NOTE = 'Mobile inboxes cut around 40 characters — front-load the first 40. (Litmus)';
const PREHEADER_NOTE = 'Mobile shows ~35–40 characters of preheader — keep the key part first. (Litmus)';

// The 5 email assets that carry these notes.
const EMAIL_ASSETS = [
  'Demand Gen Nurture Email',
  'Event Invitation Email',
  'Event Reminder Email',
  'Event Follow-Up / Recap Email',
  'Sales Basho Email',
];

// (field_name, note) applied to each email asset above → 3 × 5 = 15 field defs.
const FIELD_NOTES = [
  ['Subject Line 1', SUBJECT_NOTE],
  ['Subject Line 2', SUBJECT_NOTE],
  ['Preheader', PREHEADER_NOTE],
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate-email-notes] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-email-notes] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    let subjectRows = 0;
    let preheaderRows = 0;

    for (const assetName of EMAIL_ASSETS) {
      for (const [fieldName, note] of FIELD_NOTES) {
        const res = await client.query(
          `UPDATE copy_fields cf
              SET spec_note = $1
             FROM asset_types at
            WHERE cf.asset_type_id = at.id
              AND at.name = $2
              AND cf.field_name = $3
              AND cf.spec_note IS NULL`,
          [note, assetName, fieldName]
        );
        if (fieldName === 'Preheader') preheaderRows += res.rowCount;
        else subjectRows += res.rowCount;
      }
    }

    const total = subjectRows + preheaderRows;
    console.log(
      `[migrate-email-notes] updated ${total} row(s) — Subject: ${subjectRows}, Preheader: ${preheaderRows} ` +
      `(expected 30 total: Subject 20, Preheader 10 — 15 field defs × 2 tenants)`
    );

    console.log('[migrate-email-notes] done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate-email-notes] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

// Run only when invoked directly. Requiring this module (e.g. the smoke test's
// byte-identity check of the notes) must NOT connect to a database.
if (require.main === module) {
  main();
}

module.exports = { SUBJECT_NOTE, PREHEADER_NOTE, EMAIL_ASSETS, FIELD_NOTES };
