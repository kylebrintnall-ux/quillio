'use strict';

// August 2026 — LinkedIn Carousel "Intro Text" 600 -> 255, plus X's link-cost
// note and the removal of an unsourced clause from the LinkedIn SIA note.
//
// ─── THE FETCHED PAGES ──────────────────────────────────────────────────────
// Read 2026-08-18 through the detector's own fetchText + normalize, from the
// Railway console. Verbatim, so the numbers below can be checked against their
// source without leaving this file:
//
//   .../sponsored-content/carousel-ads/specs
//     "Text Recommendations Ad name (optional): 255 characters
//      Card headline: 45 characters Introductory text: 255 characters"
//
//   .../sponsored-content/single-image-ads-specs
//     "Text Recommendations Ad name (optional): 255 characters
//      Headline: 70 characters Introductory text: 150 characters
//      Description (LAN only): 70 characters"
//
//   .../campaign-setup/creative-ad-specifications  (X)
//     "post copy: 280 characters."
//     "(Note: each link used reduces character count by 23 characters, electing 257 characters for X copy.)"
//
// The X note above is deliberately NOT wrapped, even though it runs past the
// column the rest of this file keeps to. A quoted fetch has to be greppable as
// one contiguous string — a test asserts it is present, and wrapping it would
// break that assertion while still looking correct to a reader.
//
// ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
// LinkedIn Carousel Ad / Intro Text was stored at 600, spec_type ENFORCED — so
// the document asserted a hard platform cap of 600 where LinkedIn publishes 255.
// It is the strongest claim the renderer makes ("Platform limit (LinkedIn). Stay
// within this count.") over a number the platform does not state.
//
// 600 APPEARS NOWHERE ON EITHER LINKEDIN PAGE, and this is worth more than
// "unsourced". The only other large number on those pages is
//
//     "URL characters: 2000 characters for destination field URL"
//
// — a limit on a different field entirely. So 600 was not a misreading of
// something on the page. It corresponded to nothing.
//
// ─── WHERE IT CAME FROM ─────────────────────────────────────────────────────
// scripts/migrateAssetSpecFixes.js:35-65 swept SIX LinkedIn assets with
// `'Intro Text': [0, 600]` — Single Image, Carousel, and SIA Variants A-D.
// scripts/migrateFixLinkedInIntroText.js then corrected exactly one of them to
// 150, and asserted at :8-10 that the others "MUST stay 600 / null" with no
// source given. That sentence is the whole provenance of this defect. It has been
// corrected in place rather than deleted, so the record survives.
//
// ─── WHAT IS NOT TOUCHED, AND WHY ───────────────────────────────────────────
// THE FOUR SIA VARIANTS STILL HOLD 600. They are retired — migrateRetireDeadAssets
// sets is_active = false — and getTenantAssets filters `AND is_active = true`, so
// the value cannot reach a document, a prompt or a spec review. It is dead data.
//
// They are deliberately NOT swept in, and the reason is the one that matters: a
// blind `char_max = 600 -> 255` guarded only on the old value would hit all five
// assets and hand the four variants the CAROUSEL's number. They are copies of
// LinkedIn SINGLE IMAGE Ad, whose published Introductory text is 150. Giving them
// 255 would be this exact defect committed a second time, in the change that
// fixes it. Every statement below carries `AND at.is_active`.
//
// If a variant is ever revived, its Intro Text belongs at 150.
//
// ─── SPEC_TYPE IS NOT CHANGED HERE ──────────────────────────────────────────
// All nine LinkedIn fields stay `enforced`. Both pages put their numbers under a
// heading reading "Text Recommendations", which is the same evidence that got
// Meta's ten fields retiered enforced -> recommended in July — so the tier is an
// open question. It is deliberately NOT answered here: the value is wrong in a
// customer document today and the tier is not, and settling the tier needs its
// own evidence (whether LinkedIn's Campaign Manager rejects above the number at
// ingest, the way Google's Responsive Display fields do). Value and tier are
// independent; this migration is the value.
//
// ─── SCOPE ──────────────────────────────────────────────────────────────────
// Every tenant, matched by (asset_types.name, copy_fields.field_name) — the same
// cross-tenant, match-by-name pattern services/specReview.js uses. Every write is
// guarded on the exact value it expects to replace, per the house rule, so a row
// some other migration has since moved is skipped rather than taken back.
//
// Writes the BASE columns. A tenant who has set their own value in Settings has
// it in char_max_override, getTenantAssets resolves COALESCE(override, base), and
// their number still wins. That is the override columns working as designed.
//
// IDEMPOTENT: every statement is conditioned on the old value, so a second run
// reports 0 changed and writes nothing.
//
// DRY RUN BY DEFAULT — runs inside a transaction and ROLLBACKs, printing what it
// would change. --commit writes.
//
// Run in the Railway console (plain node — never `railway run`):
//   node scripts/migrateFixLinkedInCarouselIntro.js            # dry run
//   node scripts/migrateFixLinkedInCarouselIntro.js --commit   # write

const TAG = '[migrate-li-carousel-intro]';
const COMMIT = process.argv.includes('--commit');

// --- 1. The band --------------------------------------------------------------
// [asset, field, newMin, newMax, expectMin, expectMax]. The last two are the
// guard: the UPDATE matches only a row still holding them.
const CHAR_FIXES = [
  ['LinkedIn Carousel Ad', 'Intro Text', 0, 255, 0, 600],
];

// --- 2. The SIA note ----------------------------------------------------------
// Dropping the unsourced "600 is the technical max" clause. The surviving
// sentence explains WHY the number is 150 rather than restating it, which is what
// a note is for. BYTE-IDENTICAL to LINKEDIN_SIA_INTRO_NOTE in
// src/data/defaultAssets.js and to NOTE in migrateFixLinkedInIntroText.js.
const SIA_NOTE_NEW = 'In-feed preview truncates near 150.';
const SIA_NOTE_OLD = 'In-feed preview truncates near 150; 600 is the technical max.';

// --- 3. X's link cost ---------------------------------------------------------
// Additive: no value, tier or source changes. BYTE-IDENTICAL to X_LINK_COST_NOTE
// in src/data/defaultAssets.js.
//
// The two POST COPY fields only. Twitter/X Ad → Headline is deliberately excluded:
// the 23-character cost is on links in the post body, a headline does not carry
// them, and the page attaches the note to "post copy".
const X_LINK_COST_NOTE =
  'Every link costs 23 characters regardless of its length, so a post with one link has 257 characters of copy.';
const X_NOTE_TARGETS = [
  ['Twitter/X Ad', 'Ad Copy'],
  ['Organic Social — Twitter/X', 'Post Copy'],
];

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// Print every row this migration cares about, so the dry run and the post-commit
// state are read from the database rather than inferred from rowCounts.
async function report(client, label) {
  const res = await client.query(
    `SELECT at.tenant_id, at.name AS asset, cf.field_name AS field,
            cf.char_min, cf.char_max,
            cf.char_min_override AS min_ov, cf.char_max_override AS max_ov,
            cf.spec_type, cf.spec_note
       FROM copy_fields cf
       JOIN asset_types at ON at.id = cf.asset_type_id
      WHERE at.is_active
        AND ((at.name = 'LinkedIn Carousel Ad' AND cf.field_name = 'Intro Text')
          OR (at.name = 'LinkedIn Single Image Ad' AND cf.field_name = 'Intro Text')
          OR (at.name = 'Twitter/X Ad' AND cf.field_name = 'Ad Copy')
          OR (at.name = 'Organic Social — Twitter/X' AND cf.field_name = 'Post Copy'))
      ORDER BY at.name, cf.field_name, at.tenant_id`
  );
  console.log(`\n${TAG} --- ${label} (${res.rowCount} row(s)) ---`);
  for (const r of res.rows) {
    const ov = r.min_ov !== null || r.max_ov !== null ? '  [TENANT OVERRIDE — their value wins]' : '';
    console.log(
      `  ${String(r.asset).padEnd(28)} ${String(r.field).padEnd(12)} ` +
        `${String(r.char_min).padStart(4)}-${String(r.char_max).padStart(4)}  ` +
        `${String(r.spec_type).padEnd(11)}${ov}`
    );
    if (r.spec_note) console.log(`      note: ${r.spec_note}`);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(`${TAG} DATABASE_URL not set — nothing to do.`);
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error(`${TAG} could not load "pg" — is it installed? ${err.message}`);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: sslFor(process.env.DATABASE_URL),
  });

  try {
    await client.connect();
    await client.query('BEGIN');
    console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

    await report(client, 'BEFORE');

    // 1. The band.
    let bands = 0;
    for (const [asset, field, newMin, newMax, expMin, expMax] of CHAR_FIXES) {
      const res = await client.query(
        `UPDATE copy_fields cf
            SET char_min = $1, char_max = $2
           FROM asset_types at
          WHERE cf.asset_type_id = at.id
            AND at.name = $3
            AND cf.field_name = $4
            AND cf.char_min = $5
            AND cf.char_max = $6
            AND at.is_active`,
        [newMin, newMax, asset, field, expMin, expMax]
      );
      bands += res.rowCount;
      console.log(
        `${TAG}   band  ${asset} / ${field}: ${expMin}-${expMax} -> ${newMin}-${newMax}  (${res.rowCount} row(s))`
      );
    }

    // 2. The SIA note — guarded on the exact old string, so a tenant who has
    //    written their own note is not overwritten.
    const sia = await client.query(
      `UPDATE copy_fields cf
          SET spec_note = $1
         FROM asset_types at
        WHERE cf.asset_type_id = at.id
          AND at.name = 'LinkedIn Single Image Ad'
          AND cf.field_name = 'Intro Text'
          AND cf.spec_note = $2
          AND at.is_active`,
      [SIA_NOTE_NEW, SIA_NOTE_OLD]
    );
    console.log(`${TAG}   note  LinkedIn SIA / Intro Text: dropped the unsourced 600 clause  (${sia.rowCount} row(s))`);

    // 3. X's link cost — only where there is no note today, so nothing a tenant
    //    or a later migration wrote is clobbered.
    let xNotes = 0;
    for (const [asset, field] of X_NOTE_TARGETS) {
      const res = await client.query(
        `UPDATE copy_fields cf
            SET spec_note = $1
           FROM asset_types at
          WHERE cf.asset_type_id = at.id
            AND at.name = $2
            AND cf.field_name = $3
            AND cf.spec_note IS NULL
            AND at.is_active`,
        [X_LINK_COST_NOTE, asset, field]
      );
      xNotes += res.rowCount;
      console.log(`${TAG}   note  ${asset} / ${field}: link cost  (${res.rowCount} row(s))`);
    }

    await report(client, COMMIT ? 'AFTER' : 'AFTER (will roll back)');

    console.log(
      `\n${TAG} totals: ${bands} band(s), ${sia.rowCount} SIA note(s), ${xNotes} X note(s)` +
        `  — expected 2 / 2 / 4 on a two-tenant database.`
    );

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`${TAG} COMMITTED.`);
    } else {
      await client.query('ROLLBACK');
      console.log(`${TAG} DRY RUN — rolled back. Pass --commit to write.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`${TAG} FAILED — rolled back: ${err.message}`);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

// Guarded so the smoke test can require this file for its constants without
// opening a database connection — the same pattern migrateFixMetaSpecs.js uses.
if (require.main === module) main();

module.exports = { CHAR_FIXES, SIA_NOTE_NEW, SIA_NOTE_OLD, X_LINK_COST_NOTE, X_NOTE_TARGETS };
