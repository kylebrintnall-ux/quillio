'use strict';

// August 2026 — add a watch row for LinkedIn's CAROUSEL ads specs page.
//
// ─── THE GAP ────────────────────────────────────────────────────────────────
// Six enforced copy_fields rows cite
//   https://business.linkedin.com/advertise/ads/sponsored-content/carousel-ads/specs
// and that page is on NO spec_watch_list row. A change to LinkedIn's carousel
// limits has never been detectable.
//
// It is not a new gap — scripts/migrateSpecIntegrityFixes.js repointed those six
// fields at this page in July precisely because the single-image page does not
// carry the carousel's numbers, and no watch row was added alongside. What makes
// it worth closing now is that one of those six numbers moved TODAY:
// scripts/migrateFixLinkedInCarouselIntro.js corrected Intro Text from an
// unsourced 600 to the published 255. A number we just went to the page to fix is
// exactly the kind that should be watched for moving again.
//
// The six pairs currently resolve through the LinkedIn SINGLE-IMAGE entry's
// frozen affected_fields — that snapshot was taken before the July repoint and
// still lists them. So they can be approved today, through a flag raised by the
// wrong page. This row makes the gate and the detection agree.
//
// ─── THE FETCHED PAGE ───────────────────────────────────────────────────────
// Read 2026-08-18 through the detector's own fetchText + normalize, from the
// Railway console. Verbatim, per CLAUDE.md's fetch rule, so the claims below can
// be checked without leaving the file:
//
//   "Text Recommendations Ad name (optional): 255 characters
//    Card headline: 45 characters Introductory text: 255 characters"
//   "Number of carousel cards: 2-10 Maximum File Size: 10 MB"
//   "URL characters: 2000 characters for destination field URL"
//
//   normalized 20,838 chars, STABLE across two fetches 2.5s apart.
//
// ─── NO CONTENT STOP MARKER, DELIBERATELY ───────────────────────────────────
// The full normalized text is stable — no per-request token, no shuffled list.
// Meta's per-format pages needed a marker because their call-to-action list
// permutes on every request; nothing on this page does. So content_stop_marker
// stays NULL.
//
// That is a decision, not an omission. A marker on a page that does not need one
// is a string that can go missing later — turning a healthy row into `failed`
// for no benefit, since a set-but-absent marker is a hard failure by design.
// --verify re-measures stability before any write, so this is checked rather
// than assumed.
//
// This migration therefore does NOT name content_stop_marker in its INSERT, and
// does not require scripts/migrateAddContentStopMarker.js to have run. It can go
// before or after the Meta split work.
//
// ─── THE ANCHOR ─────────────────────────────────────────────────────────────
// "Card headline" — the label LinkedIn attaches to five of the six fields we
// store, and the analogue of the LinkedIn single-image row's "Introductory text".
//
// It is CONTENT, not chrome: a spec label cannot appear on a 404, an auth wall or
// a consent interstitial, because those pages have no spec table. And it does not
// appear on the single-image page, so it catches a redirect between the two
// LinkedIn spec pages — the plausible failure here, since they share a URL prefix
// and a nav. That is the same property "Description" gives Meta's carousel row.
//
// CANDIDATE, NOT SEEDED ON TRUST. --verify measures it against the text the
// detector actually hashes, and reports a case-insensitive count on a miss. This
// project has now had two anchors that looked obviously right and were absent:
// X's came from the URL slug rather than the page, and Meta's "Primary text" was
// wrong on capitalisation. Measure, then seed.
//
// ─── SAFETY ─────────────────────────────────────────────────────────────────
// Refuses to write if: the anchor columns are absent, a row for this URL already
// exists, or the derivation returns ZERO pairs. That last one matters most — an
// empty affected_fields is a gate that permits nothing, and creating one silently
// is worse than not creating the row at all.
//
// affected_fields is DERIVED at run time from copy_fields.spec_source rather than
// pasted, so it reflects what the library actually holds. Every pair is printed
// by name.
//
//   node scripts/migrateAddLinkedInCarouselWatch.js --verify   # fetch + measure, no writes
//   node scripts/migrateAddLinkedInCarouselWatch.js            # dry run (ROLLBACK)
//   node scripts/migrateAddLinkedInCarouselWatch.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[li-carousel-watch]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');

const URL = 'https://business.linkedin.com/advertise/ads/sponsored-content/carousel-ads/specs';
const DISPLAY = 'LinkedIn – carousel';
const ANCHOR = 'Card headline';
const ANCHOR_SCOPE = 'normalized';

// The single-image row, renamed for symmetry. See the note in main().
const SIA_URL = 'https://business.linkedin.com/advertise/ads/sponsored-content/single-image-ads-specs';
const SIA_OLD_DISPLAY = 'LinkedIn';
const SIA_NEW_DISPLAY = 'LinkedIn – single image';

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function pairKey(p) {
  return `${p.asset} || ${p.field}`;
}

// DISTINCT (asset, field) pairs for one source URL, across all tenants, ACTIVE
// assets only. Mirrors affectedFieldsWhere() in migrateAddSpecTables.js plus the
// is_active predicate that function is missing — the same derivation
// scripts/migrateSplitMetaWatchRows.js uses.
async function derivePairs(client, url) {
  const res = await client.query(
    `SELECT DISTINCT at.name AS asset, cf.field_name AS field
       FROM copy_fields cf
       JOIN asset_types at ON at.id = cf.asset_type_id
      WHERE cf.spec_source = $1 AND at.is_active
      ORDER BY at.name, cf.field_name`,
    [url]
  );
  return res.rows.map((r) => ({ asset: r.asset, field: r.field }));
}

// --- VERIFY -----------------------------------------------------------------
// Measures the anchor against the text the detector will actually hash, using the
// detector's OWN helper rather than a copy — a reimplementation here could drift
// and would then be measuring something production never sees.
async function verify() {
  const { fetchText, normalize, hashableText } = require('../src/services/specDetector');
  console.log(`\n${'='.repeat(74)}\n${DISPLAY}  ${URL}\n${'='.repeat(74)}`);
  let a;
  let b;
  try {
    const rawA = await fetchText(URL);
    await new Promise((r) => setTimeout(r, 2500));
    const rawB = await fetchText(URL);
    // content_stop_marker is null for this row, so hashableText is normalize().
    // Called through the helper anyway, so this measures the real path.
    a = { full: normalize(rawA), cut: hashableText({ content_stop_marker: null }, rawA) };
    b = { full: normalize(rawB), cut: hashableText({ content_stop_marker: null }, rawB) };
  } catch (err) {
    console.log(`   FETCH FAILED: ${err.message}`);
    console.log('   ^ the detector would call this `error` — unreachable, not unanchored.');
    return;
  }

  console.log(`   normalized ${a.full.length} chars   hashed ${a.cut.length} chars` +
    `   (equal: ${a.full.length === a.cut.length ? 'yes — no marker, as intended' : 'NO — unexpected'})`);
  console.log(`   across two fetches: ${a.cut === b.cut
    ? 'STABLE  <- no marker needed, leave content_stop_marker NULL'
    : 'VARIES  <- STOP. This page needs a marker or a token rule; do not seed it as-is.'}`);

  // The detector does a plain, case-sensitive includes(). The two diagnostics
  // exist because the two ways a plausible anchor silently misses are a capital
  // letter and a tag boundary.
  const exact = a.cut.split(ANCHOR).length - 1;
  const loose = a.cut.toLowerCase().split(ANCHOR.toLowerCase()).length - 1;
  console.log(`   anchor ${JSON.stringify(ANCHOR)} in the HASHED text: ${exact}x` +
    `  => the detector would ${exact > 0 ? 'PASS' : 'FAIL'}`);
  if (exact === 0 && loose > 0) {
    console.log(`   !! present ${loose}x ignoring case — seed the capitalisation the page renders,`);
    console.log('      and do NOT substitute a different string without measuring it.');
  }
  if (exact === 0 && loose === 0) {
    console.log('   !! absent in every variant. Report this rather than picking another string.');
  }
  // Sanity: the numbers we store should be on the page we are about to watch.
  for (const n of ['255', '45']) {
    const hits = a.cut.split(n).length - 1;
    console.log(`   stored value ${n} appears ${hits}x in the hashed text`);
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(`${TAG} DATABASE_URL not set — nothing to do.`);
    process.exit(1);
  }

  if (VERIFY) {
    await verify();
    console.log(`\n${TAG} VERIFY only — nothing written.`);
    return;
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

    // The anchor columns must exist — this row is seeded WITH an anchor, and
    // seeding it without one would add the eighth watch row in the exact state
    // (unanchored) that the previous three changes have been removing.
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'spec_watch_list' AND column_name = 'expected_content'`
    );
    if (cols.rowCount === 0) {
      throw new Error('spec_watch_list.expected_content does not exist — run scripts/migrateAddSpecAnchors.js --commit first');
    }

    const existing = await client.query('SELECT id, display_name FROM spec_watch_list WHERE source_url = $1', [URL]);
    if (existing.rowCount > 0) {
      console.log(`${TAG} a row for this URL already exists (#${existing.rows[0].id} ${existing.rows[0].display_name}) — nothing to do.`);
      await client.query('ROLLBACK');
      return;
    }

    // DERIVED, NOT PASTED.
    const pairs = await derivePairs(client, URL);
    console.log(`\n${TAG} derived ${pairs.length} pair(s) from copy_fields.spec_source:`);
    for (const p of pairs) console.log(`    ${pairKey(p)}`);

    if (pairs.length === 0) {
      throw new Error(
        `derived ZERO pairs for ${URL} — copy_fields.spec_source does not point here for any active asset. ` +
        'Expected the six LinkedIn Carousel Ad fields (Intro Text + Card 1-5 Headline), repointed by ' +
        'scripts/migrateSpecIntegrityFixes.js. An empty affected_fields is a gate that permits nothing, ' +
        'and creating one silently is worse than not creating the row.'
      );
    }

    const ins = await client.query(
      `INSERT INTO spec_watch_list
              (source_url, display_name, affected_fields, is_test, expected_content, anchor_scope)
       VALUES ($1, $2, $3::jsonb, false, $4, $5)
       RETURNING id`,
      [URL, DISPLAY, JSON.stringify(pairs), ANCHOR, ANCHOR_SCOPE]
    );
    console.log(`\n${TAG} inserted watch row #${ins.rows[0].id} — ${DISPLAY}`);
    console.log(`${TAG}   anchor ${JSON.stringify(ANCHOR)} (${ANCHOR_SCOPE}), no stop marker, current_hash NULL`);
    console.log(`${TAG}   current_hash is NULL, so the next detection run takes the BASELINE branch:`);
    console.log(`${TAG}   it writes the hash and cannot raise a flag.`);

    // DISPLAY-ONLY, AND SEPARABLE. With a carousel row on the list, a sibling row
    // reading plain "LinkedIn" is ambiguous — a reader cannot tell whether it
    // means all of LinkedIn or specifically single-image. Guarded on the exact old
    // value, so it is a no-op if anyone has already renamed it, and it touches
    // nothing the detector reads. Delete this block if you would rather keep the
    // original label.
    const ren = await client.query(
      'UPDATE spec_watch_list SET display_name = $1 WHERE source_url = $2 AND display_name = $3 RETURNING id',
      [SIA_NEW_DISPLAY, SIA_URL, SIA_OLD_DISPLAY]
    );
    console.log(`\n${TAG} renamed ${ren.rowCount} sibling row: ${JSON.stringify(SIA_OLD_DISPLAY)} -> ${JSON.stringify(SIA_NEW_DISPLAY)}` +
      `${ren.rowCount === 0 ? '  (already renamed, or a different label — display only, nothing depends on it)' : ''}`);

    const all = await client.query(
      `SELECT display_name, source_url,
              COALESCE(jsonb_array_length(affected_fields), 0) AS pairs,
              expected_content IS NOT NULL AS anchored,
              current_hash IS NOT NULL AS baselined
         FROM spec_watch_list ORDER BY is_test, display_name NULLS LAST, id`
    );
    console.log(`\n${TAG} watch list is now ${all.rowCount} row(s):`);
    for (const r of all.rows) {
      console.log(`    ${String(r.display_name || '(no name)').padEnd(24)} ${r.pairs} pair(s)  ` +
        `${r.anchored ? 'anchored' : 'UNANCHORED'}  ${r.baselined ? 'baselined' : 'not baselined'}`);
    }

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n${TAG} COMMITTED.`);
      console.log(`${TAG} Next: node scripts/runDetection.js — expect this row to report 'baseline'.`);
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
