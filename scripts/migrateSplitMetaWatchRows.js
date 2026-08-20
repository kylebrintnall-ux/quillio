'use strict';

// Migration — split Meta's single watch row into the two per-format pages that
// actually publish the numbers, and configure both to survive the CTA shuffle.
//
// ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
// The Meta row watched https://www.facebook.com/business/ads-guide/update — the
// ads guide INDEX. 2,208 normalized characters of nav tabs, a marketing
// paragraph, an email signup form and a language footer, containing ZERO
// character limits. It even states that the guide "provides information on
// dimensions, file sizes, character limits and more" — the page telling you the
// specs are elsewhere.
//
// It reported `unchanged` every week since it was added, with total confidence,
// watching a page that could never contain what it was watching for. It was also
// UNANCHORED, so nothing verified the content had rendered at all. It was the
// weakest entry on the list by a wide margin and the only watched row with no
// anchor.
//
// ─── THE FETCHED PAGES ──────────────────────────────────────────────────────
// Read 2026-08-18 through the detector's own fetchText + normalize, from the
// Railway console. Verbatim, so the numbers below can be checked without leaving
// the file (CLAUDE.md: fetch the source page in the same change):
//
//   .../ads-guide/update/image       4,971 chars, stop marker @2896
//     "Text Recommendations Primary Text: 50-150 characters Headline: 27 characters"
//   .../ads-guide/update/carousel    4,880 chars, stop marker @2803
//     "Text Recommendations Primary Text: 80 characters Headline: 20 characters
//      Description: 18 characters"
//
// Anchor counts measured BEFORE the stop marker, i.e. inside the region that is
// actually hashed:
//   "Primary Text"  1x on image, carousel, video and collection
//   "Description"   1x on CAROUSEL ONLY — 0x on image, video and collection
//   "Primary text"  (lowercase t) 0x everywhere — the first candidate was wrong
//                   on case, which is the failure --verify exists to catch.
//
// ─── THE CTA SHUFFLE ────────────────────────────────────────────────────────
// image, video and carousel are UNSTABLE between fetches 2.5s apart. Meta
// permutes its call-to-action list on every request — same items, same count,
// different order, ~480-530 characters of churn. Not a token, so the digit rule
// cannot reach it. The block is preceded on every page by "View available calls
// to action" and every spec number appears BEFORE it, so both rows carry that
// string as content_stop_marker and we hash the head.
//
// ─── WHY /video AND /collection GET NO ROW ──────────────────────────────────
// There is no Meta Video Ad and no Meta Collection Ad asset in the library, so a
// row for either would carry EMPTY affected_fields — and affected_fields is the
// write gate. specReview.guardEdits refuses any edit whose pair is not in it, so
// such a row could raise flags that can never be approved, and a queue nobody can
// action teaches a reviewer to dismiss Meta flags. That is the Litmus failure
// arriving from a new direction. Add them if the library ever gains those assets.
//
// ─── THE ROW IS REPURPOSED, NOT DELETED ─────────────────────────────────────
// spec_review_queue.watch_id is a FK to spec_watch_list(id), so deleting would
// break it for any historical Meta flag. Meta has never flagged, so there are
// probably none — but repurposing costs nothing and does not depend on that.
//
// ─── affected_fields: DERIVED LIVE, NOT HARDCODED ───────────────────────────
// The column is a FROZEN SNAPSHOT computed once by migrateAddSpecTables.js and
// recomputed by nothing (scripts/rederiveAffectedFields.js:247 is the only writer
// in the tree). So the OLD row still holds whatever was derived then — 10 pairs.
//
// A derivation TODAY returns 9, because the Meta value correction demoted
// 'Meta Single Image Ad / Description' to house_default with spec_source
// 'quillio_default'. It no longer resolves to a Meta URL, so it correctly leaves
// the gate: a field with no platform source has no business being writable by a
// platform-change flag.
//
// This script therefore DERIVES both arrays at run time rather than pasting a
// count, prints the old array beside the two new ones, and names every pair that
// left. A hardcoded 10 would have been wrong by the time it ran; a hardcoded 9
// would have been right for the wrong reason.
//
// SAFETY: the derivation carries `AND at.is_active`, which affectedFieldsWhere()
// in migrateAddSpecTables.js does NOT — that function predates b2e13f2. Without
// it we would write pairs specReview can never reach.
//
// Dry run by default (transaction + ROLLBACK). --commit writes.
// --verify fetches both pages and measures the anchors against the TRUNCATED
// text — the bytes we hash — and writes nothing.
//
// Run in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateSplitMetaWatchRows.js --verify   # fetch + measure, no writes
//   node scripts/migrateSplitMetaWatchRows.js            # dry run
//   node scripts/migrateSplitMetaWatchRows.js --commit   # write
//
// REQUIRES scripts/migrateAddContentStopMarker.js to have run first.

const TAG = '[meta-watch-split]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');

const OLD_URL = 'https://www.facebook.com/business/ads-guide/update';
const STOP_MARKER = 'View available calls to action';

const ROWS = [
  {
    key: 'image',
    url: 'https://www.facebook.com/business/ads-guide/update/image',
    display: 'Meta – image',
    anchor: 'Primary Text',
    asset: 'Meta Single Image Ad',
    // Why this anchor: it is Meta's own label for a field whose limit we store,
    // so it is content rather than chrome — the direct analogue of LinkedIn's
    // "Introductory text". A 404 or an auth wall on this host still carries
    // Facebook nav markup, which is why the anchor is a SPEC LABEL and not the
    // page title.
    //
    // KNOWN LIMIT, logged rather than solved: "Primary Text" appears on /video
    // and /collection too, so a redirect from /image to a sibling format page
    // still passes. The numbers would change and the row would flag as `changed`
    // rather than `failed` — a wrong answer wearing the right status. Nothing in
    // the measured output distinguishes /image from /video, whose Text
    // Recommendations are byte-identical ("50-150" and "27" on both).
  },
  {
    key: 'carousel',
    url: 'https://www.facebook.com/business/ads-guide/update/carousel',
    display: 'Meta – carousel',
    anchor: 'Description',
    asset: 'Meta Carousel Ad',
    // Why THIS anchor and not "Primary Text": Description is 1x on carousel and
    // 0x on image, video and collection. It is the only label that differs
    // between the format pages, so it catches a redirect between siblings that
    // "Primary Text" would sail straight through. All four pages share a URL
    // prefix and a nav, so that redirect is the plausible failure here.
  },
];

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
// is_active predicate that function is missing.
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
// Measures each anchor against the text the detector will actually hash, using
// the detector's OWN helper rather than a copy — a reimplementation here could
// drift and would then be measuring something production never sees.
async function verify() {
  const { fetchText, normalize, hashableText } = require('../src/services/specDetector');
  for (const row of ROWS) {
    console.log(`\n${'='.repeat(74)}\n${row.display}  ${row.url}\n${'='.repeat(74)}`);
    let a;
    let b;
    try {
      const rawA = await fetchText(row.url);
      a = { full: normalize(rawA), cut: hashableText({ content_stop_marker: STOP_MARKER }, rawA) };
      await new Promise((r) => setTimeout(r, 2500));
      const rawB = await fetchText(row.url);
      b = { full: normalize(rawB), cut: hashableText({ content_stop_marker: STOP_MARKER }, rawB) };
    } catch (err) {
      console.log(`   FETCH FAILED: ${err.message}`);
      console.log('   ^ the detector would call this `error` — unreachable, not unanchored.');
      continue;
    }

    if (a.cut === null) {
      console.log(`   STOP MARKER NOT FOUND: ${JSON.stringify(STOP_MARKER)}`);
      console.log('   ^ the detector would call this `failed`. Do NOT seed this row until it is.');
      continue;
    }

    console.log(`   normalized ${a.full.length} chars   hashed (truncated) ${a.cut.length} chars`);
    console.log(`   dropped by the marker: ${a.full.length - a.cut.length} chars`);
    console.log(`   full page across two fetches: ${a.full === b.full ? 'STABLE' : 'VARIES'}` +
      `   truncated: ${a.cut === b.cut ? 'STABLE  <- this is the one that matters' : 'VARIES  <- STILL BROKEN'}`);

    // The detector does a plain, case-sensitive includes(). The two diagnostics
    // exist because the two ways a plausible anchor silently misses are a capital
    // letter and a tag boundary.
    const exact = a.cut.split(row.anchor).length - 1;
    const loose = a.cut.toLowerCase().split(row.anchor.toLowerCase()).length - 1;
    console.log(`   anchor ${JSON.stringify(row.anchor)} in the HASHED region: ${exact}x` +
      `  => the detector would ${exact > 0 ? 'PASS' : 'FAIL'}`);
    if (exact === 0 && loose > 0) {
      console.log(`   !! present ${loose}x ignoring case — seed the capitalisation the page renders.`);
    }
    // Present in the discarded tail? That would mean the anchor is asserting
    // content we throw away, which is the "anchor that cannot fail" problem.
    const inTail = a.full.slice(a.cut.length).split(row.anchor).length - 1;
    if (inTail > 0) {
      console.log(`   note: also ${inTail}x AFTER the marker, in text we discard — not counted.`);
    }
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(`${TAG} DATABASE_URL is not set.`);
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error(`${TAG} could not load "pg" — is it installed? ${err.message}`);
    process.exit(1);
  }

  if (VERIFY) {
    await verify();
    console.log(`\n${TAG} VERIFY only — nothing written.`);
    return;
  }

  const client = new Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();
  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  try {
    await client.query('BEGIN');

    // The column has to exist. Failing here with a clear message beats a
    // confusing 42703 three statements later.
    const col = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'spec_watch_list' AND column_name = 'content_stop_marker'`
    );
    if (!col.rowCount) {
      throw new Error('spec_watch_list.content_stop_marker does not exist — run scripts/migrateAddContentStopMarker.js --commit first');
    }

    const oldRes = await client.query(
      'SELECT id, display_name, affected_fields, current_hash FROM spec_watch_list WHERE source_url = $1 FOR UPDATE',
      [OLD_URL]
    );
    if (!oldRes.rowCount) {
      throw new Error(`no watch row found for ${OLD_URL} — already split, or the URL changed`);
    }
    const oldRow = oldRes.rows[0];
    const oldPairs = Array.isArray(oldRow.affected_fields) ? oldRow.affected_fields : [];
    console.log(`\n${TAG} existing row #${oldRow.id} "${oldRow.display_name}"`);
    console.log(`  affected_fields as STORED: ${oldPairs.length} pair(s)  [frozen snapshot, recomputed by nothing]`);
    for (const p of oldPairs) console.log(`    ${pairKey(p)}`);

    // Derive the new arrays from the CURRENT spec_source values.
    const derived = {};
    let total = 0;
    for (const row of ROWS) {
      derived[row.key] = await derivePairs(client, row.url);
      total += derived[row.key].length;
      console.log(`\n${TAG} derived for ${row.display} (${row.url}): ${derived[row.key].length} pair(s)`);
      for (const p of derived[row.key]) console.log(`    ${pairKey(p)}`);
      if (!derived[row.key].length) {
        throw new Error(`derived ZERO pairs for ${row.url} — copy_fields.spec_source has not been repointed. Run scripts/migrateFixMetaSpecs.js --commit first; an empty gate is not a correct answer.`);
      }
    }

    // WHAT LEFT THE GATE, named rather than counted. The union should be a
    // SUBSET of the old array; anything in the new arrays that was not in the old
    // one would mean a pair appeared from somewhere and is worth stopping for.
    const oldKeys = new Set(oldPairs.map(pairKey));
    const newKeys = new Set([...derived.image, ...derived.carousel].map(pairKey));
    const left = [...oldKeys].filter((k) => !newKeys.has(k));
    const gained = [...newKeys].filter((k) => !oldKeys.has(k));
    console.log(`\n${TAG} ${oldPairs.length} stored -> ${total} derived (${derived.image.length} image + ${derived.carousel.length} carousel)`);
    for (const k of left) console.log(`  LEFT THE GATE:  ${k}   (expected: Description, demoted to house_default)`);
    for (const k of gained) console.log(`  !! GAINED:      ${k}   (unexpected — investigate before committing)`);
    if (gained.length) {
      throw new Error('a pair appeared that the old row did not carry — refusing to write');
    }

    // 1. Repurpose the existing row -> /image. current_hash = NULL so the next
    //    run takes the BASELINE branch, which writes without flagging and clears
    //    the streak counters via resetStreaks().
    const img = ROWS[0];
    await client.query(
      `UPDATE spec_watch_list
          SET source_url = $1, display_name = $2, affected_fields = $3::jsonb,
              expected_content = $4, anchor_scope = 'normalized',
              content_stop_marker = $5, current_hash = NULL, last_error = NULL
        WHERE id = $6`,
      [img.url, img.display, JSON.stringify(derived.image), img.anchor, STOP_MARKER, oldRow.id]
    );
    console.log(`\n${TAG} repurposed #${oldRow.id} -> ${img.url}`);

    // 2. Insert the carousel row. No current_hash — a new row is NULL by
    //    definition, so it baselines on the next run exactly as the repurposed
    //    one does.
    const car = ROWS[1];
    const ins = await client.query(
      `INSERT INTO spec_watch_list
         (source_url, display_name, affected_fields, is_test, expected_content,
          anchor_scope, content_stop_marker)
       VALUES ($1, $2, $3::jsonb, false, $4, 'normalized', $5)
       ON CONFLICT (source_url) DO NOTHING
       RETURNING id`,
      [car.url, car.display, JSON.stringify(derived.carousel), car.anchor, STOP_MARKER]
    );
    console.log(`${TAG} ${ins.rowCount ? `inserted #${ins.rows[0].id}` : 'carousel row already existed — left alone'} -> ${car.url}`);

    // Confirmation read of the whole list.
    const after = await client.query(
      `SELECT id, display_name, source_url, expected_content, content_stop_marker,
              source_kind, current_hash IS NOT NULL AS baselined,
              COALESCE(jsonb_array_length(affected_fields), 0) AS pairs
         FROM spec_watch_list ORDER BY is_test, display_name NULLS LAST, id`
    );
    console.log(`\n${TAG} watch list after (${after.rowCount} rows):`);
    for (const r of after.rows) {
      console.log(`  #${String(r.id).padStart(3)} ${String(r.display_name || '(no name)').padEnd(24)}` +
        ` pairs=${String(r.pairs).padStart(2)} anchor=${r.expected_content ? JSON.stringify(r.expected_content) : 'NONE'}` +
        ` marker=${r.content_stop_marker ? 'set' : '-'} baselined=${r.baselined}`);
    }

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n${TAG} COMMITTED.`);
      console.log(`${TAG} next: node scripts/runDetection.js  (expect baseline 2, changed 0, unanchored 0)`);
      console.log(`${TAG} then run it a SECOND time — baseline proves deployment, the first COMPARISON proves the fix.`);
    } else {
      await client.query('ROLLBACK');
      console.log(`\n${TAG} DRY RUN — rolled back. Re-run with --commit to write.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\n${TAG} FAILED, rolled back: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
