'use strict';

// August 2026 — Meta spec correction. Every Meta number in copy_fields was wrong,
// and every wrong one traces to the same omission: Meta's spec pages had never
// been fetched.
//
// ─── THE FETCHED PAGES ──────────────────────────────────────────────────────
// Read 2026-08-18 through the detector's own fetchText + normalize, from the
// Railway console. Verbatim, so the next person does not have to take this on
// trust — and so the numbers below can be checked against their source without
// leaving the file:
//
//   .../ads-guide/update/image
//     "Text Recommendations Primary Text: 50-150 characters Headline: 27 characters"
//   .../ads-guide/update/carousel
//     "Text Recommendations Primary Text: 80 characters Headline: 20 characters
//      Description: 18 characters"
//   .../ads-guide/update/video       (no asset — recorded for completeness)
//     "Text Recommendations Primary Text: 50-150 characters Headline: 27 characters"
//   .../ads-guide/update/collection  (no asset — and the source of the old numbers)
//     "Text Recommendations Primary Text: 125 characters Headline: 40 characters"
//
// ─── WHAT WAS WRONG, AND WHY ────────────────────────────────────────────────
// The stored 125 / 40 is COLLECTION's pair, applied to single-image and carousel,
// which publish different numbers. The stored 30 (Single Image Description)
// appears on no Meta page at all. And scripts/migrateSpecIntegrityFixes.js — a
// migration whose stated purpose was correcting numbers that "did not match the
// platforms' own published specs" — moved card description from 18 to 20 on the
// written grounds that "18 matches no published Meta figure". Meta's carousel
// page says 18. That migration corrected Meta by comparing against LinkedIn's
// published number instead of Meta's page, and shipped a justification the page
// contradicts.
//
// Its Meta entries have been removed (not corrected) in the same change that
// added this file, because RETIER, CHAR_FIXES and SOURCE_URLS are all WRITES and
// a re-run would silently revert everything below.
//
// ─── THE CITATION WAS ALSO WRONG, WHICH IS WHY BOTH SHIP TOGETHER ───────────
// Both Meta assets cited .../ads-guide/update — the INDEX. 2,208 normalized
// characters of nav, marketing copy, an email signup form and a language footer,
// containing no character limit and stating outright that the guide "provides
// information on dimensions, file sizes, character limits and more" — the page
// telling you the specs are elsewhere. spec_source is the hyperlink behind
// "Meta" in the doc's tier line, so a writer who doubted a number and clicked
// through landed somewhere that could not settle it. Correcting the number while
// leaving that link would make the document self-contradicting.
//
// ─── THE DESCRIPTION FIELD: DEMOTED, NOT DELETED, NOT RE-NUMBERED ───────────
// /image's Text Recommendations lists Primary Text and Headline only. There is
// nothing to cite, so the field moves to house_default with the quillio_default
// sentinel and KEEPS its 30 — which is honest: 30 is Quillio's number and the
// tier line now says so ("House default — set your own in Settings."), with no
// source named and no link. It is not deleted, because a Description renders in
// several Meta placements and writers fill it; removing the field would delete a
// deliberate deliverable from every future document. It is not re-numbered,
// because inventing a sourced-looking value is the failure this whole migration
// exists to undo.
//
// CONSEQUENCE: it leaves the LiveSpecs write gate. spec_watch_list.affected_fields
// derives from spec_source, so the pair drops out — correctly. A field with no
// platform source has no business being writable by a platform-change flag.
//
// ─── THE CAROUSEL HEADLINE IS PER CARD ──────────────────────────────────────
// Meta states one entry, "Headline: 20 characters", with no cardinality. A Meta
// carousel has no format-level headline — the headline exists once per card by
// construction — so the field the page names can only be the per-card one. That
// is a claim about Meta's ad structure, not a quote, and it is recorded here
// rather than in the note. The alternative reading (a single global headline)
// describes a field this asset does not have, and would leave all five card
// headlines on the old wrong 40. CARD_HEADLINE_NOTE tells the writer the fact
// without the hedging.
//
// ─── char_min 50 ON PRIMARY TEXT ────────────────────────────────────────────
// This is the FIRST new floor on a paid-social field since scripts/floorAB.js
// measured what a floor costs: stating one collapsed the Subhead's spread from
// 54-85 to 66-75 while in-band stayed 5/5 in both arms — the count said nothing
// changed and the best line in the run disappeared. The recorded rule is that a
// nudge's cost is proportional to how LITTLE slack the band has, and the damage
// landed on a 15-character band. 50-150 is 100 characters of slack, so the
// expected cost here is small. IF META PRIMARY TEXT OUTPUT EVER GOES FLAT, THIS
// IS THE PLACE TO LOOK.
//
// ─── SCOPE / SAFETY ─────────────────────────────────────────────────────────
// Every tenant, matched by (asset_types.name, copy_fields.field_name) — the same
// cross-tenant match-by-name pattern services/specReview.js uses.
//
// Each write is GUARDED ON THE VALUE IT EXPECTS TO REPLACE, per the house rule,
// so it touches only rows still holding the old number and a row some other
// migration has since moved is left alone rather than silently taken back.
//
// It writes the BASE columns. getTenantAssets resolves COALESCE(override, base),
// so a tenant who has set their own Meta number in Settings keeps it and is not
// dragged along — which is what the override columns are for.
//
// IDEMPOTENT: a second run reports 0 changed. DRY RUN BY DEFAULT — runs in a
// transaction and ROLLBACKs, printing what it would change. --commit writes.
//
// Run in the Railway console (plain node — never `railway run`):
//   node scripts/migrateFixMetaSpecs.js            # dry run
//   node scripts/migrateFixMetaSpecs.js --commit   # write

const TAG = '[migrate-meta-specs]';
const COMMIT = process.argv.includes('--commit');

// --- 1. Character bands -------------------------------------------------------
// [asset, field, newMin, newMax, expectMin, expectMax]. The last two are the
// guard: the UPDATE matches only a row still holding them.
const CHAR_FIXES = [
  ['Meta Single Image Ad', 'Primary Text', 50, 150, 0, 125],
  ['Meta Single Image Ad', 'Headline', 0, 27, 0, 40],
  ['Meta Carousel Ad', 'Primary Text', 0, 80, 0, 125],
  ['Meta Carousel Ad', 'Card 1 Headline', 0, 20, 0, 40],
  ['Meta Carousel Ad', 'Card 2 Headline', 0, 20, 0, 40],
  ['Meta Carousel Ad', 'Card 3 Headline', 0, 20, 0, 40],
  ['Meta Carousel Ad', 'Card 4 Headline', 0, 20, 0, 40],
  ['Meta Carousel Ad', 'Card 5 Headline', 0, 20, 0, 40],
  // 20 -> 18, reverting migrateSpecIntegrityFixes. The guard is 20 (what that
  // migration wrote), not 18 (where we are going).
  ['Meta Carousel Ad', 'Card Description', 0, 18, 0, 20],
];

// --- 2. Tier demotion ---------------------------------------------------------
// [asset, field]. recommended -> house_default, and the source falls back to the
// sentinel in the same statement: a tier with no citation must not keep a URL.
const DEMOTE = [['Meta Single Image Ad', 'Description']];

// --- 3. Per-format source URLs ------------------------------------------------
// Applied to every field still tiered enforced/recommended on the asset, which is
// what leaves the demoted Description behind. Kept BYTE-IDENTICAL to
// SPEC_SOURCE_URLS in src/data/defaultAssets.js; a smoke test asserts it.
const SOURCE_URLS = {
  'Meta Single Image Ad': 'https://www.facebook.com/business/ads-guide/update/image',
  'Meta Carousel Ad': 'https://www.facebook.com/business/ads-guide/update/carousel',
};

// --- 4. Card-headline note ----------------------------------------------------
// BYTE-IDENTICAL to META_CAROUSEL_CARD_NOTE in src/data/defaultAssets.js.
const CARD_HEADLINE_NOTE =
  'Meta publishes one Headline recommendation for carousel; it applies to each card.';
const CARD_HEADLINE_FIELDS = [
  'Card 1 Headline', 'Card 2 Headline', 'Card 3 Headline', 'Card 4 Headline', 'Card 5 Headline',
];

const SENTINEL = 'quillio_default';

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
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    await client.query('BEGIN');
    console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

    // 1. Character bands.
    let bands = 0;
    for (const [asset, field, min, max, expMin, expMax] of CHAR_FIXES) {
      const r = await client.query(
        `UPDATE copy_fields cf
            SET char_min = $3, char_max = $4
           FROM asset_types at
          WHERE cf.asset_type_id = at.id
            AND at.name = $1
            AND cf.field_name = $2
            AND cf.char_min = $5
            AND cf.char_max = $6`,
        [asset, field, min, max, expMin, expMax]
      );
      if (r.rowCount) console.log(`${TAG}   ${asset} / ${field}: ${expMin}-${expMax} → ${min}-${max} (${r.rowCount} row(s))`);
      bands += r.rowCount;
    }
    console.log(`${TAG} corrected ${bands} character band(s)`);

    // 2. Demotion. Tier and source move together — a house default that kept a
    //    platform URL would render no source name but still carry a live link.
    let demoted = 0;
    for (const [asset, field] of DEMOTE) {
      const r = await client.query(
        `UPDATE copy_fields cf
            SET spec_type = 'house_default', spec_source = $3
           FROM asset_types at
          WHERE cf.asset_type_id = at.id
            AND at.name = $1
            AND cf.field_name = $2
            AND cf.spec_type = 'recommended'`,
        [asset, field, SENTINEL]
      );
      if (r.rowCount) console.log(`${TAG}   ${asset} / ${field}: recommended → house_default (${r.rowCount} row(s))`);
      demoted += r.rowCount;
    }
    console.log(`${TAG} demoted ${demoted} field(s)`);

    // 3. Sources. AFTER the demotion, so the demoted row is already out of the
    //    tiered set this matches and cannot be re-pointed at a Meta page.
    let sources = 0;
    for (const [asset, url] of Object.entries(SOURCE_URLS)) {
      const r = await client.query(
        `UPDATE copy_fields cf
            SET spec_source = $2
           FROM asset_types at
          WHERE cf.asset_type_id = at.id
            AND at.name = $1
            AND cf.spec_type IN ('enforced', 'recommended')
            AND cf.spec_source IS DISTINCT FROM $2`,
        [asset, url]
      );
      if (r.rowCount) console.log(`${TAG}   source ${asset} → ${url}: ${r.rowCount} row(s)`);
      sources += r.rowCount;
    }
    console.log(`${TAG} repointed ${sources} spec_source value(s)`);

    // 4. Card note. NON-CLOBBERING — only a row with no note is touched, so a
    //    hand-written note is never overwritten and a re-run changes nothing.
    let notes = 0;
    for (const field of CARD_HEADLINE_FIELDS) {
      const r = await client.query(
        `UPDATE copy_fields cf
            SET spec_note = $2
           FROM asset_types at
          WHERE cf.asset_type_id = at.id
            AND at.name = 'Meta Carousel Ad'
            AND cf.field_name = $1
            AND cf.spec_note IS NULL`,
        [field, CARD_HEADLINE_NOTE]
      );
      notes += r.rowCount;
    }
    console.log(`${TAG} added ${notes} card-headline note(s)`);

    // Confirmation: every Meta field, as it now stands.
    const after = await client.query(
      `SELECT at.name AS asset, cf.field_name AS field, cf.char_min, cf.char_max,
              cf.spec_type, cf.spec_source,
              cf.char_max_override IS NOT NULL AS has_override
         FROM copy_fields cf
         JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE at.name IN ('Meta Single Image Ad', 'Meta Carousel Ad')
          AND cf.spec_type IS DISTINCT FROM 'house_default'
        ORDER BY at.name, cf.field_name`
    );
    console.log(`${TAG} tiered Meta fields after this run:`);
    for (const r of after.rows) {
      console.log(`${TAG}   ${r.asset} / ${r.field}  ${r.char_min}-${r.char_max}  ${r.spec_type}  ${r.spec_source}` +
        (r.has_override ? '  [tenant override present — their value wins]' : ''));
    }

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`${TAG} COMMITTED.`);
    } else {
      await client.query('ROLLBACK');
      console.log(`${TAG} DRY RUN — rolled back. Pass --commit to write.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`${TAG} FAILED — rolled back:`, err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) main();

module.exports = { CHAR_FIXES, DEMOTE, SOURCE_URLS, CARD_HEADLINE_NOTE, CARD_HEADLINE_FIELDS };
