'use strict';

// August 2026 — cite the placement, not the default view of it.
//
// ─── WHAT WAS FALSE ─────────────────────────────────────────────────────────
// Meta's ads guide serves DIFFERENT NUMBERS PER PLACEMENT from the same format
// URL. The bare .../ads-guide/update/image is Facebook Feed's view; the other
// placements publish their own, and they are not close:
//
//   facebook-feed          Primary Text 50-150,  Headline 27
//   instagram-feed         Primary Text 125,     Headline 40
//   instagram-story        Primary Text 125,     no headline field
//   instagram-reels        Primary Text 44,      no headline field
//   facebook-marketplace   Primary Text 125,     Headline 40, Description 30
//
// So the nine Meta fields cited a URL that serves one placement's numbers and
// names no placement anywhere. The NUMBERS ARE NOT WRONG — every one was read off
// the page it points at, and a writer who doubted one and clicked through landed
// somewhere that confirmed it. What was wrong is that the page could not tell
// them WHICH VIEW they were reading, and the asset heading says "Meta".
//
// This repoints the nine to the explicit /facebook-feed URLs. Nothing else moves:
// not the numbers, not the tiers, not the asset names, not the field names.
//
// ─── WHY THE ASSET IS NOT RENAMED ───────────────────────────────────────────
// "Meta Single Image Ad — Facebook Feed" was the obvious next step and it is the
// wrong one, because it presumes a model that has not been chosen. If the library
// ends up with one asset per (format, placement) the name must carry the
// placement; if the placement becomes a dimension BELOW the asset — a column, or
// part of the field name — the asset must stay "Meta Single Image Ad" and a
// placement suffix would be false in the other direction.
//
// A rename is also the expensive half: asset names are what specReview reaches by
// (`WHERE at.name = $1`, cross-tenant), what projects.field_manifest matches on
// (so the sweep would silently stop covering every Meta document ever built), and
// what isSeededAssetName derives the read-only lock from at module load — which
// would unlock both Meta assets for every tenant in the window between deploy and
// migration. Doing it and undoing it costs all of that twice.
//
// REPOINTING THE CITATION IS A STRICT SUBSET OF EVERY MODEL. Under one-asset-per-
// pair, the Facebook Feed asset cites the Facebook Feed page. Under a placement
// dimension, the Facebook-Feed rows cite the Facebook Feed page. There is no
// design in which a field holding Facebook Feed's number should cite a URL that
// serves it by default and says so nowhere. These nine values are never undone.
//
// ─── WHY THE WATCH ROWS MOVE IN THE SAME TRANSACTION ────────────────────────
// scripts/checkSpecHealth.js compares cited URLs to watched URLs AS STRINGS
// (`citedNorm.has(normUrl(row.source_url))`). Repointing spec_source alone would
// fire two checks, permanently, on both rows: the coverage gap (a page we cite
// that nobody watches) and the orphaned row (a watch row nothing cites, still
// holding affected_fields — the pairs would be gated by a page nothing cites).
//
// AND IT IS A ONE-LINE UPDATE RATHER THAN THE USUAL ADD-BASELINE-REPOINT-RETIRE
// ORDERING, because the two URLs are the same page as far as anything we hash.
// Measured through the detector's own hashableText, with each row's stored
// content_stop_marker applied:
//
//   image     bare and /facebook-feed  ->  e5792dad455fcade, 2895 chars
//   carousel  bare and /facebook-feed  ->  8fd92feee0d3025d, 2802 chars
//
// The normalized texts diverge at offset 3045 on image — same length, inside the
// call-to-action list that shuffles per request, which is the region
// content_stop_marker already truncates. So current_hash is unchanged, the next
// detection run compares equal and reports `unchanged`, and there is no window in
// which a row is unbaselined.
//
// affected_fields is NOT re-derived and does not need to be: it stores
// (asset, field) NAME pairs, and no name moves here.
//
// ─── THE DESCRIPTION FIELD, RE-EXAMINED RATHER THAN REVERSED ────────────────
// scripts/migrateFixMetaSpecs.js demoted Meta Single Image Ad / Description to
// house_default on the written grounds that "/image's Text Recommendations lists
// Primary Text and Headline only. There is nothing to cite." Facebook
// Marketplace publishes Description 30 — the same number that was called
// unsourced.
//
// THE DEMOTION STANDS AND THE REASONING NEEDED SCOPING. Facebook Feed genuinely
// publishes no Description, so a field whose other numbers are Facebook Feed's
// correctly holds a house_default 30 with the quillio_default sentinel. What was
// wrong is that the reason read as a claim about META when it was a claim about
// one placement view of one page.
//
// Marketplace's 30 is a sourced number with nowhere to live until there is a
// Marketplace asset. Recorded here so it is findable then, rather than
// rediscovered as a contradiction.
//
// ─── SAFETY ─────────────────────────────────────────────────────────────────
// Guarded on the exact old value (`= $old`), so it touches only rows still
// holding the bare URL and a re-run is a no-op. Never writes a number, a tier or
// a name. Dry run by default inside a transaction that ROLLBACKs.
//
//   node scripts/migrateMetaPlacementCitations.js            # dry run
//   node scripts/migrateMetaPlacementCitations.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[meta-placement-citations]';
const COMMIT = process.argv.includes('--commit');

// bare -> placement-explicit. Both halves are byte-equal after the stop marker;
// see the header for the hashes.
const REPOINT = [
  {
    from: 'https://www.facebook.com/business/ads-guide/update/image',
    to: 'https://www.facebook.com/business/ads-guide/update/image/facebook-feed',
    expect: 2,
  },
  {
    from: 'https://www.facebook.com/business/ads-guide/update/carousel',
    to: 'https://www.facebook.com/business/ads-guide/update/carousel/facebook-feed',
    expect: 7,
  },
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

    // BEFORE, by name, so the outcome can be checked against a row somebody
    // recognises rather than against a count.
    for (const r of REPOINT) {
      const before = await client.query(
        `SELECT at.name AS asset, cf.field_name AS field, cf.spec_type, COUNT(*)::int AS rows
           FROM copy_fields cf
           JOIN asset_types at ON at.id = cf.asset_type_id
          WHERE cf.spec_source = $1
          GROUP BY 1, 2, 3 ORDER BY 1, 2`,
        [r.from]
      );
      console.log(`\n${TAG} ${r.from.split('/update/')[1]} — ${before.rowCount} pair(s):`);
      for (const row of before.rows) {
        console.log(`    ${String(row.rows)}x ${row.asset} / ${row.field}`.padEnd(56) + row.spec_type);
      }
      if (before.rowCount !== r.expect) {
        throw new Error(
          `expected ${r.expect} (asset, field) pair(s) on ${r.from}, found ${before.rowCount}. `
          + 'Refusing to write: the library is not the shape this migration was written against.'
        );
      }
    }

    let fields = 0;
    let watch = 0;
    for (const r of REPOINT) {
      const f = await client.query(
        'UPDATE copy_fields SET spec_source = $1 WHERE spec_source = $2',
        [r.to, r.from]
      );
      fields += f.rowCount;
      // The watch row moves with the citation, in the same transaction. Same
      // page after the stop marker, so current_hash and affected_fields are
      // deliberately untouched.
      const w = await client.query(
        'UPDATE spec_watch_list SET source_url = $1 WHERE source_url = $2',
        [r.to, r.from]
      );
      watch += w.rowCount;
      console.log(`${TAG} ${r.to.split('/update/')[1]}: ${f.rowCount} field(s), ${w.rowCount} watch row(s)`);
    }
    console.log(`${TAG} ${fields} copy_fields row(s), ${watch} watch row(s) repointed`);

    // Read the outcome back rather than trusting rowCounts.
    const stale = await client.query(
      `SELECT COUNT(*)::int AS n FROM copy_fields WHERE spec_source = ANY($1)`,
      [REPOINT.map((r) => r.from)]
    );
    if (stale.rows[0].n > 0) throw new Error(`${stale.rows[0].n} field(s) still cite a bare URL`);

    // EVERY CITED META URL MUST BE WATCHED, which is checkSpecHealth's coverage
    // check asked at write time — the two moved together or they did not move.
    const orphan = await client.query(
      `SELECT DISTINCT cf.spec_source AS url
         FROM copy_fields cf
        WHERE cf.spec_source LIKE '%facebook.com%'
          AND NOT EXISTS (SELECT 1 FROM spec_watch_list w WHERE w.source_url = cf.spec_source)`
    );
    if (orphan.rowCount > 0) {
      throw new Error(`cited but unwatched: ${orphan.rows.map((r) => r.url).join(', ')}`);
    }
    console.log(`${TAG} every cited Meta URL is watched, and no watch row is orphaned`);

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n${TAG} COMMITTED.`);
      console.log(`${TAG} Documents built from now on read "Recommended by Meta (Facebook Feed)."`);
      console.log(`${TAG} Run scripts/checkSpecHealth.js — a spec_source was repointed.`);
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

// The next link in the replay chain. scripts/migrateSpecIntegrityFixes pointed
// Meta at the ads-guide INDEX; scripts/migrateFixMetaSpecs moved it to the format
// pages; this moves it to the placement pages. A smoke test spreads the three in
// order and asserts the seed matches the LAST one, which is what a replay chain
// means — the later migration wins, and the earlier maps stay readable rather
// than being edited into agreement.
const SOURCE_URLS = {
  'Meta Single Image Ad': REPOINT[0].to,
  'Meta Carousel Ad': REPOINT[1].to,
};

// Guarded so the maps above can be required by a test without running anything,
// the same way scripts/migrateFixMetaSpecs.js is.
if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} ${err.message}`);
    process.exit(1);
  });
}

module.exports = { SOURCE_URLS, REPOINT };
