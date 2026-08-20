'use strict';

// August 2026 — record the audit that actually happened.
//
// On 2026-08-20 every enforced and recommended limit in the library was read
// against the page it is cited to. Four pages were fetched, their spec labels
// read, and each stored number compared field by field. One number was wrong and
// was corrected. Nothing recorded that the reading took place, because no code
// path can observe a human opening a page.
//
// This writes copy_fields.spec_verified_at = 2026-08-20 for the 25 (asset, field)
// pairs that were read — 50 rows across two tenants.
//
// ─── WHY A DATE HERE IS HONEST ──────────────────────────────────────────────
// A date is a claim that a specific event happened at a specific time. Writing
// one is honest when the event occurred and the date is when it occurred. It is
// dishonest when no such event happened, however plausible the date looks —
// because the reader cannot tell the difference, and the entire value of the date
// is that they do not have to.
//
// The test is not "is this date plausible" or "is the number probably right". It
// is "did somebody do the thing this date says they did".
//
// Here they did. The pages below were fetched through the detector's own
// fetchText + normalize, from the Railway console, and the quotes are what came
// back.
//
// REJECTED, and named rather than quietly not chosen: backfilling from the SEED
// date. Nobody verified anything on the seed date — insertDefaultLibrary ran a
// transaction. A date there would assert a human reading that never took place,
// in the one place this product cannot afford an invented fact, and it would be
// indistinguishable from an honest one to every future reader.
//
// ─── THE PAGES, QUOTED AGAIN RATHER THAN CROSS-REFERENCED ───────────────────
// These quotes already sit in the headers of scripts/migrateFixMetaSpecs.js and
// scripts/migrateFixLinkedInCarouselIntro.js. They are repeated here in full, and
// deliberately so: a reader of THIS migration is being asked to believe a reading
// happened, and should not have to open two other files to see what was read.
//
//   https://www.facebook.com/business/ads-guide/update/image
//     "Text Recommendations Primary Text: 50-150 characters Headline: 27 characters"
//     -> scripts/migrateFixMetaSpecs.js
//
//   https://www.facebook.com/business/ads-guide/update/carousel
//     "Text Recommendations Primary Text: 80 characters Headline: 20 characters
//      Description: 18 characters"
//     -> scripts/migrateFixMetaSpecs.js
//
//   https://business.linkedin.com/advertise/ads/sponsored-content/single-image-ads-specs
//     "Text Recommendations Ad name (optional): 255 characters Headline: 70
//      characters Introductory text: 150 characters Description (LAN only): 70
//      characters"
//     -> read in the same audit; the three stored numbers matched and no
//        correction migration was needed, which is why this quote appears here
//        first rather than being cross-referenced.
//
//   https://business.linkedin.com/advertise/ads/sponsored-content/carousel-ads/specs
//     "Text Recommendations Ad name (optional): 255 characters Card headline: 45
//      characters Introductory text: 255 characters"
//     -> scripts/migrateFixLinkedInCarouselIntro.js. Intro Text was stored at an
//        unsourced 600 and was corrected to 255.
//
//   https://business.x.com/en/help/campaign-setup/creative-ad-specifications
//     "post copy: 280 characters. (Note: each link used reduces character count
//      by 23 characters, electing 257 characters for X copy.)"
//     -> scripts/migrateFixLinkedInCarouselIntro.js added that note; the 280 and
//        the 70 headline matched and needed no correction.
//
//   https://support.google.com/google-ads/answer/17090561
//     Short Headline 30, Long Headline 90, Description 90, Business Name 25 —
//     all four confirmed against the page's own table. No correction needed.
//
// ─── THE TWO GOOGLE ROWS THAT ALREADY HELD A DATE ───────────────────────────
// Two rows carried spec_verified_at = 2026-07-23, written by
// services/specReview.js commitReview when an admin approved a LiveSpecs change.
// This migration moves them forward to 2026-08-20, and the reason is worth
// stating rather than leaving a reader to wonder why a date advanced.
//
// Their old value was not wrong. Approving a change is a NARROWER event that
// entails the broader one: you cannot approve a number without reading the page
// and deciding the new value is right. Under the column's semantics — "a human
// last confirmed this number against its page" — 2026-07-23 was true.
//
// It moves because 2026-08-20 is ALSO true and is more recent: all four Google
// fields were read against answer/17090561 in this audit, not just the two that
// had been approved. Leaving two of four Google fields dated a month earlier, for
// a reason no reader could reconstruct from the document, invites someone to
// invent an explanation for the gap. The original event is not lost — it is in
// spec_change_log, which is what the audit trail is for.
//
// ─── SAFETY ─────────────────────────────────────────────────────────────────
// Never moves a date BACKWARD (`spec_verified_at IS NULL OR < $1`), so a future
// audit's later date survives a re-run of this file. Scoped to the six watched
// platform URLs and to tiered, active fields, so it cannot reach a house_default
// row, a tenant-authored field, or the two research citations — none of which was
// read in this audit.
//
// Dry run by default inside a transaction that ROLLBACKs. --commit writes.
//
//   node scripts/migrateBackfillSpecVerifiedAt.js            # dry run
//   node scripts/migrateBackfillSpecVerifiedAt.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[backfill-verified-at]';
const COMMIT = process.argv.includes('--commit');

// The date of the audit, not the date this runs. Hardcoded on purpose: NOW()
// would stamp whenever somebody happened to execute the file, which is a
// different event from the one being recorded.
const AUDITED_ON = '2026-08-20';

// The six pages read. Byte-identical to the source_url values on the six
// platform_enforced watch rows.
const AUDITED_URLS = [
  'https://www.facebook.com/business/ads-guide/update/image',
  'https://www.facebook.com/business/ads-guide/update/carousel',
  'https://business.linkedin.com/advertise/ads/sponsored-content/single-image-ads-specs',
  'https://business.linkedin.com/advertise/ads/sponsored-content/carousel-ads/specs',
  'https://business.x.com/en/help/campaign-setup/creative-ad-specifications',
  'https://support.google.com/google-ads/answer/17090561',
];

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(`${TAG} DATABASE_URL not set — nothing to do.`);
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error(`${TAG} could not load "pg": ${err.message}`);
    process.exit(1);
  }

  const client = new Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();
  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  try {
    await client.query('BEGIN');

    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'copy_fields' AND column_name = 'spec_verified_at'`
    );
    if (cols.rowCount === 0) {
      throw new Error('copy_fields.spec_verified_at does not exist — run scripts/migrateAddSpecChangeLog.js first');
    }

    // BEFORE, by name. A count would not show which rows already held a date.
    const before = await client.query(
      `SELECT at.name AS asset, cf.field_name AS field, cf.spec_type,
              MIN(cf.spec_verified_at) AS oldest, COUNT(*)::int AS rows
         FROM copy_fields cf
         JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE at.is_active
          AND cf.spec_source = ANY($1)
          AND cf.spec_type IN ('enforced', 'recommended')
        GROUP BY 1, 2, 3 ORDER BY 1, 2`,
      [AUDITED_URLS]
    );
    console.log(`\n${TAG} ${before.rowCount} pair(s) in scope:`);
    for (const r of before.rows) {
      const held = r.oldest ? new Date(r.oldest).toISOString().slice(0, 10) : '—';
      console.log(`    ${String(r.rows)}x ${r.asset} / ${r.field}`.padEnd(56) +
        `${r.spec_type.padEnd(12)} held: ${held}`);
    }

    if (before.rowCount === 0) {
      throw new Error(
        'ZERO pairs in scope. copy_fields.spec_source does not point at any of the six audited URLs ' +
        'for an active tiered field — which would mean the correction migrations have not run. ' +
        'Refusing to write: a backfill that stamps nothing is not a success.'
      );
    }

    const upd = await client.query(
      `UPDATE copy_fields cf
          SET spec_verified_at = $1::date
         FROM asset_types at
        WHERE cf.asset_type_id = at.id
          AND at.is_active
          AND cf.spec_source = ANY($2)
          AND cf.spec_type IN ('enforced', 'recommended')
          AND (cf.spec_verified_at IS NULL OR cf.spec_verified_at < $1::date)
        RETURNING at.tenant_id`,
      [AUDITED_ON, AUDITED_URLS]
    );
    const tenants = new Set(upd.rows.map((r) => String(r.tenant_id)));
    console.log(`\n${TAG} stamped ${upd.rowCount} row(s) across ${tenants.size} tenant(s) with ${AUDITED_ON}`);

    // AFTER, so the outcome is read from the database rather than inferred from a
    // rowCount — the same standard the Meta split used.
    const after = await client.query(
      `SELECT to_char(cf.spec_verified_at, 'YYYY-MM-DD') AS d, COUNT(*)::int AS rows
         FROM copy_fields cf
         JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE at.is_active
          AND cf.spec_source = ANY($1)
          AND cf.spec_type IN ('enforced', 'recommended')
        GROUP BY 1 ORDER BY 1`,
      [AUDITED_URLS]
    );
    console.log(`${TAG} verification dates now held by those rows:`);
    for (const r of after.rows) console.log(`    ${r.d || '(none)'}  ${r.rows} row(s)`);

    // Nothing outside the audited set should have gained a date.
    const stray = await client.query(
      `SELECT COUNT(*)::int AS n FROM copy_fields cf
         JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE cf.spec_verified_at = $1::date
          AND NOT (cf.spec_source = ANY($2) AND cf.spec_type IN ('enforced', 'recommended') AND at.is_active)`,
      [AUDITED_ON, AUDITED_URLS]
    );
    if (stray.rows[0].n > 0) {
      throw new Error(`${stray.rows[0].n} row(s) outside the audited set carry ${AUDITED_ON} — refusing to write`);
    }
    console.log(`${TAG} no rows outside the audited set carry ${AUDITED_ON}`);

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n${TAG} COMMITTED.`);
      console.log(`${TAG} Documents built from now on carry "Verified against <platform>'s spec page on ${AUDITED_ON}."`);
      console.log(`${TAG} on those fields. Existing documents are unchanged — the sentence is written at creation.`);
    } else {
      await client.query('ROLLBACK');
      console.log(`\n${TAG} DRY RUN — rolled back. Pass --commit to write.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\n${TAG} FAILED (rolled back): ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`${TAG} ${err.message}`);
  process.exit(1);
});
