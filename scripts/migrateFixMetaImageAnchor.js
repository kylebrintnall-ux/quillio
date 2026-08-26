'use strict';

// August 2026 — replace the anchor on the Meta IMAGE watch row with one that
// actually discriminates between Meta's format pages.
//
// ─── THE PROBLEM ────────────────────────────────────────────────────────────
// The row anchors on "Primary Text". That string is on Meta's /video and
// /collection pages too — siblings under the same URL path, sharing a nav and a
// layout — so a redirect from /image to one of them PASSES the anchor.
//
// The row then reports `changed` rather than `failed`: a wrong answer wearing the
// right status. And nothing downstream tells them apart, because /image and
// /video publish BYTE-IDENTICAL Text Recommendations — "50-150" and "27" on both.
// A reviewer would see a spec change flagged on Meta's image ad and approve a
// number that came off a different format's page.
//
// The anchor exists to catch exactly that class of failure and currently cannot.
// scripts/migrateSplitMetaWatchRows.js logged this as a KNOWN LIMIT when it
// seeded the anchor; this closes it.
//
// ─── THE FETCHED PAGES ──────────────────────────────────────────────────────
// Both read 2026-08-21 through scripts/probeSpecPage.js, which uses the
// detector's own fetchText + normalize. Verbatim, per CLAUDE.md's fetch rule:
//
//   .../ads-guide/update/image/facebook-feed
//     "File Type: JPG or PNG Ratio: 4:5 Resolution: 1440 x 1800 pixels Text"
//     "Text Recommendations Primary Text: 50-150 characters Headline: 27 characters"
//
//   .../ads-guide/update/video/facebook-feed
//     "File Type: MP4, MOV or GIF"
//     "Text Recommendations Primary Text: 50-150 characters Headline: 27 characters"
//
// THE VIDEO PAGE WAS FETCHED SPECIFICALLY TO PROVE AN ABSENCE. It is not cited by
// any field, is on no watch row, and is read here for one reason: to show that
// the new anchor is NOT on it. A discriminating anchor is a claim about two pages,
// and a claim about two pages cannot be checked by reading one.
//
// The difference the new anchor rests on is the FILE TYPE line — JPG or PNG on
// the image page, MP4/MOV/GIF on the video page. The Text Recommendations block
// is identical on both, which is precisely why the anchor cannot come from there.
//
// ─── THE NEW ANCHOR CONTAINS NUMBERS, AND THEY ARE THE SAFE KIND ────────────
// 4:5, 1440 and 1800 are IMAGE DIMENSION recommendations. The limits this row
// watches are 150 and 27.
//
// That distinction decides which status a real spec change reports. A missed
// anchor is `failed` — the page could not be READ. A moved number is `changed` —
// the spec moved. An anchor holding one of the watched limits converts the second
// into the first, so the event the row exists to catch arrives disguised as a
// broken page, which is the one failure mode that teaches a reviewer to dismiss
// the queue. Meta can restyle its creative recommendations without touching a
// character limit, and can move a character limit without touching them.
//
// ─── THE TRUNCATION IS ASYMMETRIC, AND DELIBERATELY SO ──────────────────────
// Both Meta rows carry a content_stop_marker for the call-to-action list that
// shuffles per request. checkAnchor is handed hashableText(row, html) — normalize
// THEN truncate — so an anchor living past the marker would look present in a
// naive check and report `failed` on its first real run.
//
//   the IMAGE page   measured against the TRUNCATED text, using the marker read
//                    off the row itself. That is the exact string the detector
//                    will search.
//   the VIDEO page   measured against the FULL normalized text.
//
// The video check is asymmetric ON PURPOSE. It asserts an ABSENCE, and absence
// from a truncated slice is a WEAKER claim than absence from the whole page — an
// anchor sitting past the marker would be reported absent when it is present,
// which is a false pass in the direction that matters. Absence from the full text
// implies absence from any slice of it.
//
// ─── WHAT IT DOES NOT TOUCH ─────────────────────────────────────────────────
// expected_content, and nothing else. NOT current_hash, NOT content_stop_marker,
// NOT affected_fields. The hashed content is unchanged by an anchor swap, so the
// row must not re-baseline — a cleared hash would take the next run down the
// baseline branch, where it writes a hash and cannot flag, and a real spec change
// landing that week would be silently absorbed into the new baseline.
//
// ─── ORDERING, AND ONE DEVIATION FROM THE PINTEREST SHAPE ───────────────────
// scripts/migrateAddPinterestSpecs.js reads its page BEFORE opening the database.
// This one cannot, and the reason is the truncation above: the marker it must
// measure against lives ON THE ROW. So it opens a connection first and SELECTs
// the row read-only, then fetches, then refuses or writes.
//
// Nothing is written before every check has passed. No transaction is opened
// until the pages have been read and the anchor proven on one and disproven on
// the other. A read-only SELECT is not the thing the "refuse before you open the
// database" rule is protecting against — a write is — but the deviation is real
// and is named here rather than left for a reader to notice.
//
// ─── WHAT MAKES THIS REFUSE ─────────────────────────────────────────────────
//   • the target row is not found, or more than one row matches
//   • either page cannot be fetched (a run with no network is a refusal)
//   • the NEW anchor is not on the image page's truncated text, exactly once
//   • the NEW anchor IS on the video page — then it discriminates no better than
//     the anchor it replaces, and swapping one for the other buys nothing
//
//   node scripts/migrateFixMetaImageAnchor.js --verify   # fetch + measure, no write
//   node scripts/migrateFixMetaImageAnchor.js            # dry run (ROLLBACK)
//   node scripts/migrateFixMetaImageAnchor.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[meta-image-anchor]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');

const IMAGE_URL = 'https://www.facebook.com/business/ads-guide/update/image/facebook-feed';
// Fetched to prove an absence. On no watch row, cited by no field. If this 404s,
// the run refuses rather than falling back to the bare .../update/video — an
// automatic fallback would measure a different page than the one a redirect from
// the image row would land on, and report the answer for the wrong URL.
const VIDEO_URL = 'https://www.facebook.com/business/ads-guide/update/video/facebook-feed';

const OLD_ANCHOR = 'Primary Text';
const NEW_ANCHOR = 'File Type: JPG or PNG Ratio: 4:5 Resolution: 1440 x 1800 pixels Text';

// The limits this row watches. Named so the check below can state the property
// the anchor has to keep rather than assert it by eye.
const WATCHED_LIMITS = ['150', '27'];

// WHOLE NUMBERS for the gate below. It was `NEW_ANCHOR.includes(n)` — a
// SUBSTRING test on a number, and the sixth instance of the class the other five
// were fixed as. This anchor is the reason the class is not academic here: it
// carries the digit runs 4, 5, 1440 and 1800, so "40" and "80" and "18" are all
// substrings of it while none of them is a number it contains.
//
// NO BEHAVIOUR CHANGE FOR THIS ROW'S OWN LIMITS — 150 and 27 are substrings of
// nothing in the anchor, so both tests agree and both allow. The change removes
// a hazard for whoever edits WATCHED_LIMITS or NEW_ANCHOR next: a limit of 40 or
// 80 would be refused today for a dimension, and the refusal message would name
// a spec revision that could not happen.
const { hasWholeNumber } = require('./lib/wholeNumber');

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function count(hay, needle) {
  return hay.split(needle).length - 1;
}

// THE PROPERTY THE WHOLE CHANGE RESTS ON, as a pure function so a test can drive
// the same code this migration does rather than reimplementing the comparison.
//
// `imageText` is the TRUNCATED image page — what the detector will search.
// `videoText` is the FULL video page — see the asymmetry note in the header.
function anchorDiscriminates(imageText, videoText, anchor) {
  const onImage = count(String(imageText || ''), anchor);
  const onVideo = count(String(videoText || ''), anchor);
  return {
    onImage,
    onVideo,
    ok: onImage === 1 && onVideo === 0,
    why: onImage === 0 ? 'absent from the image page — the detector would report `failed` every week'
      : onImage > 1 ? `on the image page ${onImage}x — an anchor that repeats says nothing about WHICH section rendered`
        : onVideo > 0 ? 'ALSO on the video page — it discriminates no better than the anchor it replaces'
          : null,
  };
}

// --- the pages --------------------------------------------------------------
// Returns { ok, why }. Called by --verify and by the write path, so the anchor is
// never swapped without both pages being read in the same run.
async function readPages(marker) {
  const { fetchText, normalize, hashableText } = require('../src/services/specDetector');

  console.log(`\n${'='.repeat(74)}\nIMAGE  ${IMAGE_URL}\n${'='.repeat(74)}`);
  let imageCut;
  let imageFull;
  try {
    const raw = await fetchText(IMAGE_URL);
    imageFull = normalize(raw);
    // THE ROW'S OWN MARKER, not a literal. hashableText is the only sanctioned
    // way to derive a row's hashable text, and it returns null when a configured
    // marker is missing — which is a failure, not a fallback.
    imageCut = hashableText({ content_stop_marker: marker }, raw);
  } catch (err) {
    return { ok: false, why: `image page fetch failed: ${err.message}. A run with no network is a refusal, not a fallback.` };
  }
  if (imageCut === null) {
    return {
      ok: false,
      why: `the row's content_stop_marker ${JSON.stringify(marker)} is not on the image page. `
        + 'The detector calls that `failed` too, so this row is already broken and the anchor is not the reason.',
    };
  }
  console.log(`   normalized ${imageFull.length} chars, truncated to ${imageCut.length}`);
  console.log(`   stop marker used: ${marker ? JSON.stringify(marker) : 'NONE — the row carries no marker'}`);
  console.log(`   measured against the TRUNCATED text, which is what checkAnchor searches.`);

  console.log(`\n${'='.repeat(74)}\nVIDEO  ${VIDEO_URL}\n${'='.repeat(74)}`);
  let videoFull;
  try {
    videoFull = normalize(await fetchText(VIDEO_URL));
  } catch (err) {
    return {
      ok: false,
      why: `video page fetch failed: ${err.message}. It is read to PROVE AN ABSENCE, and an `
        + 'absence cannot be proven from a page that would not load. If this URL is gone, check '
        + 'whether the placement form exists for video before substituting the bare .../update/video.',
    };
  }
  console.log(`   normalized ${videoFull.length} chars`);
  console.log('   measured against the FULL text — absence from the whole page is a STRONGER');
  console.log('   claim than absence from a truncated slice, and the weaker one would report a');
  console.log('   false pass if the anchor sat past the marker.');

  console.log(`\n${'─'.repeat(74)}\nTHE SWAP\n${'─'.repeat(74)}`);
  const old = anchorDiscriminates(imageCut, videoFull, OLD_ANCHOR);
  console.log(`   OLD ${JSON.stringify(OLD_ANCHOR)}`);
  console.log(`       image ${old.onImage}x   video ${old.onVideo}x` +
    `${old.onVideo > 0 ? '   <- THIS IS THE DEFECT: a redirect to /video passes it' : ''}`);

  const fresh = anchorDiscriminates(imageCut, videoFull, NEW_ANCHOR);
  console.log(`   NEW ${JSON.stringify(NEW_ANCHOR)}`);
  console.log(`       image ${fresh.onImage}x   video ${fresh.onVideo}x` +
    `${fresh.ok ? '   <- discriminates' : ''}`);

  if (!fresh.ok) return { ok: false, why: `the new anchor ${fresh.why}` };

  // Reported rather than enforced. If the old anchor turns out to be absent from
  // the video page after all, the premise of this change is wrong and somebody
  // should know before the swap lands — but the new anchor is still the better
  // one, so this is not a refusal.
  if (old.onVideo === 0) {
    console.log(`\n   NOTE: the OLD anchor is NOT on the video page either. The premise of this`);
    console.log('   change — that "Primary Text" fails to discriminate — is not reproducing.');
    console.log('   The swap is still an improvement, but re-read the header before trusting it.');
  }

  // The property the header claims, checked rather than asserted by eye.
  //
  // WHOLE NUMBERS, not substrings: the anchor's "1440 x 1800" must not read as
  // holding 40, 80 or 18. See the note on WATCHED_LIMITS. The refusal itself is
  // unchanged — an anchor that really does contain a watched limit still stops
  // the run, because a spec revision would then report `failed` rather than
  // `changed`.
  for (const n of WATCHED_LIMITS) {
    const inAnchor = hasWholeNumber(NEW_ANCHOR, n);
    console.log(`   watched limit ${n}: ${inAnchor ? 'IN THE ANCHOR — a spec change would report `failed`' : 'not in the anchor'}`);
    if (inAnchor) {
      return { ok: false, why: `the new anchor contains ${n}, a limit this row watches — a spec change would report \`failed\` instead of \`changed\`` };
    }
  }

  return { ok: true };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(`${TAG} DATABASE_URL not set — the stop marker is read off the row, so this needs a database even to --verify.`);
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
  console.log(`${TAG} mode: ${VERIFY ? 'VERIFY (no write)' : COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  // WHETHER A TRANSACTION IS ACTUALLY OPEN, tracked rather than assumed.
  //
  // Everything up to and including the page fetches runs OUTSIDE a transaction —
  // the row read, both fetches, the anchor comparison, and the --verify path in
  // full. The catch below used to issue an unconditional ROLLBACK and print
  // "FAILED (rolled back)" regardless, so a failure on any of those reported a
  // rollback that never happened: Postgres answers ROLLBACK-with-no-transaction
  // with a WARNING, which the `.catch(() => {})` swallowed, and the message then
  // described a transaction that was never opened.
  //
  // Cosmetic in EFFECT and not in what it TELLS YOU. The first thing anyone does
  // with a failing migration is ask what it touched, and "rolled back" on a
  // read-only path sends them looking for a write that does not exist.
  //
  // Found when scripts/migrateFixXAnchor.js — which copies this file's shape —
  // failed in --verify on a query error and announced a rollback. That file
  // carried a note saying this one wants the same fix; this is that fix, so the
  // note does not outlive the defect it describes.
  let inTxn = false;

  try {
    // READ-ONLY, and BEFORE any transaction. The marker lives on the row, so the
    // page checks cannot run without reading it first — see the ordering note in
    // the header for why this deviates from the Pinterest shape.
    const found = await client.query(
      `SELECT id, display_name, source_url, expected_content, anchor_scope, content_stop_marker,
              current_hash IS NOT NULL AS baselined
         FROM spec_watch_list WHERE source_url = $1`,
      [IMAGE_URL]
    );
    console.log(`\n${TAG} rows matching ${IMAGE_URL}: ${found.rowCount}`);
    for (const r of found.rows) {
      console.log(`    #${r.id}  ${r.display_name}`);
      console.log(`        expected_content    ${JSON.stringify(r.expected_content)}`);
      console.log(`        anchor_scope        ${r.anchor_scope}`);
      console.log(`        content_stop_marker ${JSON.stringify(r.content_stop_marker)}`);
      console.log(`        ${r.baselined ? 'baselined' : 'not baselined'}`);
    }
    if (found.rowCount !== 1) {
      throw new Error(
        `expected exactly 1 row on that URL, found ${found.rowCount}. `
        + (found.rowCount === 0
          ? 'The Meta split or the placement repoint may not have run here — check scripts/migrateSplitMetaWatchRows.js and scripts/migrateMetaPlacementCitations.js.'
          : 'Two rows on one URL is a state no migration creates; resolve it before changing an anchor.')
      );
    }
    const row = found.rows[0];

    const pages = await readPages(row.content_stop_marker);
    if (!pages.ok) {
      console.error(`\n${TAG} REFUSING TO WRITE: ${pages.why}`);
      process.exitCode = 1;
      return;
    }

    if (VERIFY) {
      console.log(`\n${TAG} VERIFY PASSED — nothing written.`);
      return;
    }

    if (row.expected_content === NEW_ANCHOR) {
      console.log(`\n${TAG} the row already carries the new anchor — nothing to do.`);
      return;
    }

    await client.query('BEGIN');
    inTxn = true;

    // expected_content AND NOTHING ELSE. current_hash in particular is untouched:
    // the hashed content does not change when an anchor does, so the row must not
    // re-baseline. Guarded on the id AND the anchor we just read, so a concurrent
    // change between the SELECT and here refuses rather than overwriting.
    const upd = await client.query(
      `UPDATE spec_watch_list SET expected_content = $1
        WHERE id = $2 AND expected_content IS NOT DISTINCT FROM $3
        RETURNING id`,
      [NEW_ANCHOR, row.id, row.expected_content]
    );
    if (upd.rowCount !== 1) {
      throw new Error(
        `UPDATE matched ${upd.rowCount} row(s) — the anchor changed between the read and the write. Nothing written.`
      );
    }

    const after = await client.query(
      `SELECT expected_content, content_stop_marker, current_hash IS NOT NULL AS baselined,
              COALESCE(jsonb_array_length(affected_fields), 0) AS pairs
         FROM spec_watch_list WHERE id = $1`,
      [row.id]
    );
    const a = after.rows[0];
    console.log(`\n${TAG} row #${row.id} — ${row.display_name}`);
    console.log(`    before  ${JSON.stringify(row.expected_content)}`);
    console.log(`    after   ${JSON.stringify(a.expected_content)}`);
    console.log(`\n${TAG} unchanged, as intended:`);
    console.log(`    content_stop_marker  ${JSON.stringify(a.content_stop_marker)}`);
    console.log(`    affected_fields      ${a.pairs} pair(s)`);
    console.log(`    ${a.baselined ? 'still baselined — the next run compares, it does not re-baseline' : 'not baselined'}`);

    if (COMMIT) {
      await client.query('COMMIT');
      inTxn = false;
      console.log(`\n${TAG} COMMITTED.`);
      console.log(`${TAG} Next: node scripts/runDetection.js — expect this row to report 'unchanged',`);
      console.log(`${TAG} NOT 'baseline'. A baseline here would mean current_hash was cleared.`);
      console.log(`${TAG} Then: node scripts/checkSpecHealth.js — an anchor was repointed.`);
    } else {
      await client.query('ROLLBACK');
      inTxn = false;
      console.log(`\n${TAG} DRY RUN — rolled back. Pass --commit to write.`);
    }
  } catch (err) {
    // ONLY ROLL BACK WHAT WAS ACTUALLY OPENED, and say which happened. A failure
    // before BEGIN wrote nothing because there was nothing to write, and saying
    // "rolled back" there is a claim about the database that is not true.
    if (inTxn) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`\n${TAG} FAILED (rolled back): ${err.message}`);
    } else {
      console.error(`\n${TAG} FAILED before any transaction was opened — nothing was written, `
        + `and nothing needed rolling back: ${err.message}`);
    }
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} ${err.message}`);
    process.exit(1);
  });
}

// UNIT TESTS ONLY. anchorDiscriminates is the property this whole change rests
// on, exported so a test drives the same comparison the migration does rather
// than reimplementing it beside it.
module.exports = {
  anchorDiscriminates, OLD_ANCHOR, NEW_ANCHOR, IMAGE_URL, VIDEO_URL, WATCHED_LIMITS,
};
