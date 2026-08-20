'use strict';

// Data-only fix for LinkedIn Single Image Ad → "Intro Text". LinkedIn's technical
// maximum is 600, but the published recommendation is ~150 (where the in-feed
// preview truncates) — the number writers should actually work to. This changes
// char_max 600 → 150 and adds a spec_note explaining it.
//
// PER-ASSET-PAIR match: "Intro Text" also exists on LinkedIn Carousel Ad and the
// LinkedIn SIA Variants A–D. This touches ONLY the exact pair ("LinkedIn Single
// Image Ad", "Intro Text"). spec_type and spec_source are left untouched.
//
// CORRECTED 2026-08-18 — this comment used to say the others "MUST stay 600 /
// null", with no source given. It was WRONG for the carousel. LinkedIn's carousel
// specs page publishes "Introductory text: 255 characters" and 600 appears nowhere
// on it; scripts/migrateFixLinkedInCarouselIntro.js moved that pair to 255 and
// carries the fetched page text.
//
// The 600 in this file's own header (:3-4, "LinkedIn's technical maximum is 600")
// is unsourced too, and the note text below has been shortened to drop it. It is
// not on either LinkedIn page; the only other large number there is "URL
// characters: 2000 characters for destination field URL", a limit on a different
// field. So 600 corresponded to nothing rather than being a misread of something.
//
// NOTHING IN THIS FILE NEEDS REMOVING, unlike the Meta entries stripped from
// migrateSpecIntegrityFixes.js. Its UPDATE is scoped to
// at.name = 'LinkedIn Single Image Ad' and guarded on char_max = 600, so a re-run
// cannot reach the carousel row and cannot revert that correction. Only the
// comment was wrong. Do not apply the Meta de-hazarding pattern here.
//
// The four SIA Variants still hold 600. They are retired (is_active = false), so
// getTenantAssets never reads them and the value cannot reach a document. If one
// is ever revived, its Intro Text is a SINGLE IMAGE field and belongs at 150 —
// NOT the carousel's 255.
//
// Idempotent + non-clobbering: guarded by char_max = 600 AND spec_note IS NULL, so
// a re-run (already 150 / noted) changes nothing.
//
// Run in the Railway console: node scripts/migrateFixLinkedInIntroText.js
//
// SEQUENCING: run this BEFORE deploying the seed change (defaultAssets.js now
// seeds the same 150 / note) — same ordering as the prior data migrations.

// spec_note text — kept BYTE-IDENTICAL to LINKEDIN_SIA_INTRO_NOTE in
// src/data/defaultAssets.js (the smoke test asserts it).
const NOTE = 'In-feed preview truncates near 150.';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate-li-intro] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-li-intro] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    const res = await client.query(
      `UPDATE copy_fields cf
          SET char_max = 150, spec_note = $1
         FROM asset_types at
        WHERE cf.asset_type_id = at.id
          AND at.name = $2
          AND cf.field_name = $3
          AND cf.char_max = 600
          AND cf.spec_note IS NULL`,
      [NOTE, 'LinkedIn Single Image Ad', 'Intro Text']
    );
    console.log(
      `[migrate-li-intro] updated ${res.rowCount} row(s) — char_max=150 + spec_note (expected 2: 1 field × 2 tenants)`
    );

    console.log('[migrate-li-intro] done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate-li-intro] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

// Run only when invoked directly. Requiring this module (e.g. the smoke test's
// byte-identity check of NOTE) must NOT connect to a database.
if (require.main === module) {
  main();
}

module.exports = { NOTE };
