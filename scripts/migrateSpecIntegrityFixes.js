'use strict';

// July 2026 spec-integrity migration. Corrects the copy_fields rows whose numbers,
// tiers, or citations did not match the platforms' own published specs, and renames
// one asset whose name disagreed with both.
//
// WHY THIS MATTERS BEYOND THE DATA: copy_fields.spec_type and spec_source are
// RENDERED. spec_type becomes the italic sentence under the field label, so an
// advisory number tiered 'enforced' told a writer "Platform limit (Meta). Stay
// within this count." about a number Meta will happily exceed. spec_source is the
// hyperlink behind the platform name, so a wrong URL sent a reader who wanted to
// check the number to a page that does not contain it. Both are user-visible.
//
// WHAT IT DOES
//   1. RETIER — Meta's ten fields enforced → recommended. Meta publishes 125 / 40
//      / 30 as what renders untruncated across placements; the technical ceilings
//      are 255 for headlines and far larger for primary text. This is also what
//      first puts a row in the 'recommended' tier: the renderer has had the branch
//      since spec tiers shipped, but no seeded row ever used it.
//   2. CHAR_FIXES — Meta Carousel card headline 45 → 40 (45 is LinkedIn's carousel
//      number, not Meta's) and card description 18 → 20 (18 matches no published
//      Meta figure). Email preheaders 85–120 → 85–100. Email subject lines split
//      by type, with the char_min floor dropped (see SUBJECT_BANDS).
//   3. SOURCE_FIXES — LinkedIn Carousel cited the SINGLE IMAGE ads page, which does
//      not carry the carousel's numbers; it now cites the carousel specs page.
//   4. RENAME — 'Google DV360 / Responsive Display' → 'Google Responsive Display
//      Ad'. Its numbers (30 / 90 / 90 / 25) and its cited page are Google Ads
//      Responsive Display values, not DV360's. The NAME was wrong, so the name is
//      what changed; the numbers are correct and are left alone.
//   5. PROMOTE — Organic Social — Twitter/X "Post Copy" 280 from an uncited house
//      default to 'enforced' citing X's spec page. 280 is a hard cap on an organic
//      post exactly as it is on a paid one.
//   6. FIELD_NOTES — the LinkedIn Carousel card headlines gain a note saying the
//      45 applies to a destination-URL carousel and that a Lead Gen Form CTA caps
//      them at 30. A conditional limit the label cannot express.
//
// SCOPE: every tenant, matched by (asset_types.name, copy_fields.field_name) — the
// same cross-tenant, match-by-name pattern services/specReview.js uses. Asset and
// field names are shared across tenants; only ids differ.
//
// IDEMPOTENT: every statement is conditioned on the row not already holding the new
// value, so a second run reports 0 changed and writes nothing. The RENAME is
// additionally guarded against colliding with an existing row of the target name.
//
// DRY RUN BY DEFAULT — it runs inside a transaction and ROLLBACKs, printing exactly
// what it would change. Pass --commit to write.
//
// Run in the Railway console (plain node — never `railway run`):
//   node scripts/migrateSpecIntegrityFixes.js            # dry run
//   node scripts/migrateSpecIntegrityFixes.js --commit   # write
//
// SEQUENCING: safe in either order relative to the deploy. src/data/defaultAssets.js
// seeds these same values byte-identically, so a tenant seeded after the deploy is
// already correct and this migration finds nothing to do for it.

const TAG = '[migrate-spec-integrity]';
const COMMIT = process.argv.includes('--commit');

// --- 1. Tier corrections ------------------------------------------------------
// [assetName, fieldName, newTier]. Every one of these is currently 'enforced'.
const RETIER = [
  ['Meta Single Image Ad', 'Primary Text', 'recommended'],
  ['Meta Single Image Ad', 'Headline', 'recommended'],
  ['Meta Single Image Ad', 'Description', 'recommended'],
  ['Meta Carousel Ad', 'Primary Text', 'recommended'],
  ['Meta Carousel Ad', 'Card 1 Headline', 'recommended'],
  ['Meta Carousel Ad', 'Card 2 Headline', 'recommended'],
  ['Meta Carousel Ad', 'Card 3 Headline', 'recommended'],
  ['Meta Carousel Ad', 'Card 4 Headline', 'recommended'],
  ['Meta Carousel Ad', 'Card 5 Headline', 'recommended'],
  ['Meta Carousel Ad', 'Card Description', 'recommended'],
];

// --- 5. Promotion to enforced -------------------------------------------------
// [assetName, fieldName]. Currently 'house_default' with the quillio_default
// sentinel; becomes 'enforced' citing SOURCE_URLS for its asset.
const PROMOTE = [['Organic Social — Twitter/X', 'Post Copy']];

// --- 2. Character-band corrections --------------------------------------------
// [assetName, fieldName, charMin, charMax].
const CHAR_FIXES = [
  // Meta carousel: two numbers that came from the wrong places.
  ['Meta Carousel Ad', 'Card 1 Headline', 0, 40],
  ['Meta Carousel Ad', 'Card 2 Headline', 0, 40],
  ['Meta Carousel Ad', 'Card 3 Headline', 0, 40],
  ['Meta Carousel Ad', 'Card 4 Headline', 0, 40],
  ['Meta Carousel Ad', 'Card 5 Headline', 0, 40],
  ['Meta Carousel Ad', 'Card Description', 0, 20],
];

// The five email assets, and the subject-line ceiling each one gets.
//
// They all shared 50–75, which is one band pretending to fit two jobs. Cold B2B
// outreach performs best at roughly 2–4 words, so a Basho subject caps at 40;
// opt-in nurture and event mail keep earning clicks well past 130 characters, so
// those cap at 130.
//
// The char_min FLOOR is dropped on every one of them. `[50-75]` rendered as an
// instruction to REACH 50 characters, which is actively wrong for cold outreach —
// the shortest subject is often the best one. There is no lower bound worth
// enforcing on a subject line; the ceiling is the only real constraint.
const SUBJECT_BANDS = [
  ['Demand Gen Nurture Email', 130],
  ['Event Invitation Email', 130],
  ['Event Reminder Email', 130],
  ['Event Follow-Up / Recap Email', 130],
  ['Sales Basho Email', 40], // cold outreach
];
// Litmus recommends staying under 90 characters of preheader; 85–100 is the
// published sweet spot. 120 overshot it.
const PREHEADER_BAND = [85, 100];

for (const [asset, subjectMax] of SUBJECT_BANDS) {
  CHAR_FIXES.push([asset, 'Subject Line 1', 0, subjectMax]);
  CHAR_FIXES.push([asset, 'Subject Line 2', 0, subjectMax]);
  CHAR_FIXES.push([asset, 'Preheader', PREHEADER_BAND[0], PREHEADER_BAND[1]]);
}

// --- 3. Source URLs -----------------------------------------------------------
// Per ASSET, not per platform — one URL per platform is exactly how LinkedIn
// Carousel ended up citing the single-image page. Applies to every tiered
// (enforced or recommended) field on that asset. Kept BYTE-IDENTICAL to
// SPEC_SOURCE_URLS in src/data/defaultAssets.js; a smoke test asserts it.
const SOURCE_URLS = {
  'Meta Single Image Ad': 'https://www.facebook.com/business/ads-guide/update',
  'Meta Carousel Ad': 'https://www.facebook.com/business/ads-guide/update',
  'LinkedIn Single Image Ad':
    'https://business.linkedin.com/advertise/ads/sponsored-content/single-image-ads-specs',
  'LinkedIn Carousel Ad':
    'https://business.linkedin.com/advertise/ads/sponsored-content/carousel-ads/specs',
  'Twitter/X Ad': 'https://business.x.com/en/help/campaign-setup/creative-ad-specifications',
  'Organic Social — Twitter/X': 'https://business.x.com/en/help/campaign-setup/creative-ad-specifications',
  'Google Responsive Display Ad': 'https://support.google.com/google-ads/answer/17090561',
};

// --- 4. Asset rename ----------------------------------------------------------
const RENAME = { from: 'Google DV360 / Responsive Display', to: 'Google Responsive Display Ad' };

// --- 6. Field notes -----------------------------------------------------------
// LinkedIn's 45-character carousel card headline is CONDITIONAL: it holds for a
// carousel driving to a destination URL, but a carousel whose CTA opens a Lead Gen
// Form caps its cards at 30. The label can only carry one number, so the note
// carries the other — otherwise a writer building a Lead Gen carousel writes to 45
// and is silently 15 characters over.
//
// Kept BYTE-IDENTICAL to LINKEDIN_CAROUSEL_CARD_NOTE in
// src/data/defaultAssets.js (a smoke test asserts it).
const CARD_HEADLINE_NOTE =
  'Applies to carousels driving to a destination URL; with a Lead Gen Form CTA the cap is 30.';

// [assetName, fieldName, note]. Per-asset-pair, never a bare field_name sweep:
// "Card N Headline" also exists on Meta Carousel Ad, where this caveat is false.
const FIELD_NOTES = [1, 2, 3, 4, 5].map((n) => [
  'LinkedIn Carousel Ad',
  `Card ${n} Headline`,
  CARD_HEADLINE_NOTE,
]);

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(`${TAG} DATABASE_URL is not set in this environment.`);
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

  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  try {
    await client.connect();
    await client.query('BEGIN');

    // --- 4. RENAME FIRST. Everything below keys on the NEW name, so the rename has
    //        to land before the Google rows are looked up. Guarded against a tenant
    //        that somehow already has a row of the target name — renaming into a
    //        collision would create two assets the library treats as one.
    const collide = await client.query(
      `SELECT at_old.tenant_id
         FROM asset_types at_old
         JOIN asset_types at_new
           ON at_new.tenant_id = at_old.tenant_id AND at_new.name = $2
        WHERE at_old.name = $1`,
      [RENAME.from, RENAME.to]
    );
    if (collide.rowCount > 0) {
      throw new Error(
        `${collide.rowCount} tenant(s) already have an asset named "${RENAME.to}" alongside ` +
          `"${RENAME.from}" — renaming would collide. Resolve by hand first.`
      );
    }
    const renamed = await client.query('UPDATE asset_types SET name = $2 WHERE name = $1', [
      RENAME.from,
      RENAME.to,
    ]);
    console.log(`${TAG} rename "${RENAME.from}" → "${RENAME.to}": ${renamed.rowCount} asset row(s)`);

    // --- 1. RETIER (enforced → recommended). Conditioned on the row not already
    //        holding the target tier, so a re-run is a no-op.
    let retiered = 0;
    for (const [asset, field, tier] of RETIER) {
      const r = await client.query(
        `UPDATE copy_fields cf
            SET spec_type = $3
           FROM asset_types at
          WHERE cf.asset_type_id = at.id
            AND at.name = $1 AND cf.field_name = $2
            AND cf.spec_type IS DISTINCT FROM $3`,
        [asset, field, tier]
      );
      if (r.rowCount) console.log(`${TAG}   retier ${asset} / ${field} → ${tier}: ${r.rowCount} row(s)`);
      retiered += r.rowCount;
    }
    console.log(`${TAG} retiered ${retiered} field row(s) to 'recommended'`);

    // --- 5. PROMOTE to enforced. Only from 'house_default', so this never
    //        overwrites a tier set deliberately elsewhere.
    let promoted = 0;
    for (const [asset, field] of PROMOTE) {
      const r = await client.query(
        `UPDATE copy_fields cf
            SET spec_type = 'enforced'
           FROM asset_types at
          WHERE cf.asset_type_id = at.id
            AND at.name = $1 AND cf.field_name = $2
            AND cf.spec_type = 'house_default'`,
        [asset, field]
      );
      if (r.rowCount) console.log(`${TAG}   promote ${asset} / ${field} → enforced: ${r.rowCount} row(s)`);
      promoted += r.rowCount;
    }
    console.log(`${TAG} promoted ${promoted} field row(s) to 'enforced'`);

    // --- 2. CHARACTER BANDS.
    let bands = 0;
    for (const [asset, field, min, max] of CHAR_FIXES) {
      const r = await client.query(
        `UPDATE copy_fields cf
            SET char_min = $3, char_max = $4
           FROM asset_types at
          WHERE cf.asset_type_id = at.id
            AND at.name = $1 AND cf.field_name = $2
            AND (cf.char_min IS DISTINCT FROM $3 OR cf.char_max IS DISTINCT FROM $4)`,
        [asset, field, min, max]
      );
      if (r.rowCount) console.log(`${TAG}   band ${asset} / ${field} → [${min}-${max}]: ${r.rowCount} row(s)`);
      bands += r.rowCount;
    }
    console.log(`${TAG} corrected ${bands} character band(s)`);

    // --- 3. SOURCE URLS. Every TIERED field on the asset cites that asset's page;
    //        house_default fields keep the 'quillio_default' sentinel and are not
    //        touched. This also (re)points the fields promoted/retiered above, so
    //        the order — tiers first, sources second — matters.
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

    // --- 6. FIELD NOTES. Non-clobbering: only rows with no note are touched, so a
    //        hand-written note already on a field is never overwritten and a re-run
    //        changes nothing.
    let notes = 0;
    for (const [asset, field, note] of FIELD_NOTES) {
      const r = await client.query(
        `UPDATE copy_fields cf
            SET spec_note = $3
           FROM asset_types at
          WHERE cf.asset_type_id = at.id
            AND at.name = $1 AND cf.field_name = $2
            AND cf.spec_note IS NULL`,
        [asset, field, note]
      );
      if (r.rowCount) console.log(`${TAG}   note ${asset} / ${field}: ${r.rowCount} row(s)`);
      notes += r.rowCount;
    }
    console.log(`${TAG} added ${notes} field note(s)`);

    // Post-state, so the operator sees the shape rather than only the deltas.
    const after = await client.query(
      `SELECT spec_type, COUNT(*)::int AS n FROM copy_fields GROUP BY spec_type ORDER BY spec_type`
    );
    console.log(`${TAG} copy_fields by spec_type after:`);
    for (const row of after.rows) console.log(`${TAG}   ${row.spec_type || '(null)'}: ${row.n}`);

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`${TAG} COMMITTED`);
    } else {
      await client.query('ROLLBACK');
      console.log(`${TAG} ROLLED BACK (dry run) — no changes were written. Re-run with --commit to apply.`);
    }
    console.log(`${TAG} done`);
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`${TAG} FAILED: ${err.message}`);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

// Run only when invoked directly. Requiring this module (the smoke test does, to
// prove the seed and the migration agree) must NOT connect to a database.
if (require.main === module) {
  main();
}

module.exports = {
  RETIER, PROMOTE, CHAR_FIXES, SUBJECT_BANDS, PREHEADER_BAND, SOURCE_URLS, RENAME,
  CARD_HEADLINE_NOTE, FIELD_NOTES,
};
