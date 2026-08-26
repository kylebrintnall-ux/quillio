'use strict';

// August 2026 — record X's media-headline truncation guidance as a spec_note on
// Twitter/X Ad / Headline.
//
// Structure follows scripts/migrateVerifySoleWitnessSpecs.js: pair-scoped, dry
// run by default, --commit to write, inTxn, one transaction, the fetched page
// text quoted in the header, and a per-pair preview printed before anything
// happens. The value guard follows X_EXPECTED_MAX in
// scripts/migrateFixLinkedInCarouselIntro.js.
//
// ─── THE FETCHED PAGE ───────────────────────────────────────────────────────
// https://business.x.com/en/help/campaign-setup/creative-ad-specifications —
// read through scripts/probeSpecPage.js against the live normalized text,
// 2026-08-25. Verbatim, per CLAUDE.md's fetch rule.
//
// Dumped from the live normalized text through the detector's own fetchText and
// normalize. THE SENTENCE BEING ASSERTED, and the one in QUOTE below:
//
//   "Media headline length: Max 70 characters. Please note — depending on
//    device and app settings this description may truncate. Up to two lines of
//    text are rendered on the card title; any text beyond that is truncated
//    with an ellipsis. Although not guaranteed, limiting the description to
//    50 characters"
//
// THE EM DASH AFTER "Please note" IS U+2014 and is the page's own character.
// There are NO HTML ENTITIES in this stretch — which is a fact about this
// stretch and not about the page. Pinterest's blocks carried &nbsp; in two of
// three, and the one that did not is exactly why that failure looked like a
// property of the other two (scripts/migrateAddPinterestAdFormats.js).
//
// ─── TRUNCATED AT A CLEAN BOUNDARY, AND WHY THAT RATHER THAN COMPLETED ─────
// The dump stops mid-word at "50 characters s". Two options: extend the dump,
// or cut the quote at a boundary that is unambiguous on its own. THIS FILE
// CUTS, at "limiting the description to 50 characters".
//
// Cutting rather than completing, because completing it here would mean
// WRITING THE TAIL FROM MEMORY — and the remembered tail is "should ensure that
// truncation won't occur across most devices", which is a phrase from the
// SUPERSEDED quote this section exists to correct. Re-introducing it would be
// the same error a second time, in the change that fixes it. The author of this
// file cannot reach business.x.com to check, so the honest move is to assert
// less.
//
// WHAT THE CUT COSTS: nothing that is load-bearing. The hedge survives —
// "Although not guaranteed" is inside the quote — and the hedge is what makes
// 50 guidance rather than a limit. Extending the dump later is welcome; a
// longer quote asserts more and is strictly better evidence.
//
// ─── THE SUPERSEDED QUOTE, AND WHAT REFUSED IT ────────────────────────────
// The first version of this file asserted:
//
//   "... this description may be truncated with an ellipsis. Although not
//    guaranteed, limiting the description to 50 characters should ensure that
//    truncation won't occur across most devices."
//
// That sentence IS NOT ON THE PAGE. It collapsed TWO of X's sentences into one
// — "this description may truncate" and "any text beyond that is truncated with
// an ellipsis" — producing a plausible hybrid that reads correctly and matches
// nothing. It was reconstructed from truncated context rather than read.
//
// --verify refused it, and the refusal named TRANSCRIPTION rather than a page
// change, which is the distinction that decides whether the next person edits
// this file or goes and re-reads X.
//
// SECOND TIME IN ONE SESSION THE QUOTE CHECK HAS CAUGHT A WRONG SENTENCE, and
// that is the part worth carrying rather than the individual error. Pinterest's
// &nbsp; was the first (two blocks, two refusals); this is the second. Both
// times the sentence was wrong in a way that LOOKED RIGHT to its author, both
// times nothing else in the system would ever have said so, and both times the
// refusal pointed at the right side.
//
// The two failure modes are different and neither is exotic: the first was a
// CHARACTER-level flattening of what the page emits, this one a SENTENCE-level
// recombination of what the page says. A check that only caught one of them
// would have passed this quote.
//
// ─── IT OCCURS MORE THAN ONCE, AND THE WORDINGS DIFFER ─────────────────────
// The same guidance appears in the **Video Ads with Website Card** block, and
// **Website Carousels** publishes the same 70/50 pair. The wording is NOT
// identical between them — one block writes "Max 70 characters" and another
// writes "70 characters" — so this file quotes the ONE it is asserting and says
// which block it came from, rather than quoting a merged sentence that appears
// nowhere.
//
// WHY THAT MATTERS BEYOND TIDINESS. A quote is evidence only if it is checkable,
// and a reader who greps the page for a sentence assembled from two blocks finds
// nothing and cannot tell whether the page changed or the quote was never real.
// This project has already spent two --verify runs on the entity version of that
// mistake (see scripts/migrateAddPinterestAdFormats.js).
//
// THE COUNT IS NOT ASSERTED HERE. `count(text, QUOTE)` is printed by --verify,
// but a run is NOT refused for finding the sentence more than once: repetition
// per format block is this page's normal shape — the same is true of "post copy:
// 280 characters", which recurs across text, image, video, carousel,
// conversation card and polls. Refusing on 2x would be refusing the page for
// being itself. What IS refused is ZERO.
//
// ─── 50 IS NOT A LIMIT, AND MUST NEVER BECOME ONE ──────────────────────────
// The same shape as the 257 in the link-cost note, and it will be tempting in
// the same way.
//
// 70 is the published cap and is correct as stored. 50 is a TRUNCATION
// THRESHOLD, and the page hedges it: truncation depends on "device and app
// settings", and the 50 arrives under "Although not guaranteed". X is describing
// a rendering behaviour it will not promise.
//
// THE MECHANISM IS A TWO-LINE RENDER, which the corrected quote makes explicit
// and the superseded one did not: "Up to two lines of text are rendered on the
// card title; any text beyond that is truncated with an ellipsis." So 50 is
// roughly what fits two lines, not a device threshold in its own right — which
// is why it is approximate, and why it cannot be a limit.
//
// So 50 must not become char_max: it would tell a writer that 51 characters is
// over the limit when X accepts 70, and the tier line beside it would assert
// "Platform limit (X). Stay within this count." over a number X does not
// publish as a limit. That is the LinkedIn 600 defect with a smaller number.
//
// And it must not become char_min either, which is the less obvious half. A
// floor of 50 would say the copy has to REACH 50, which the page does not say
// and which inverts the guidance exactly — the sentence is about staying UNDER
// it. scripts/floorAB.js separately measured what an invented floor costs: the
// Subhead's in-band rate did not move at all (5/5 both arms) while its spread
// collapsed from 54-85 to 66-75, and the punchiest line in the run was the 54
// that no longer appeared.
//
// The truncation goes in spec_note, the writing-guidance channel, which is the
// same split scripts/migrateAddPinterestSpecs.js made for the 40-character feed
// truncation and scripts/migrateFixLinkedInCarouselIntro.js made for the 23.
//
// ─── THE WORDING IS A STATEMENT OF CONSEQUENCE, AND THAT IS MEASURED ───────
// scripts/notesAB.js, Pinterest Pin / Title, three arms of ten, ceiling 100 in
// every arm:
//
//   NONE (no note)                                  0/10 within 40, spread 17
//   statement  "Only the first 40 characters ..."   3/10 within 40, spread 64
//   instruction "Front-load the first 40 ..."       0/10 within 40, spread 13
//
// The imperative form scored level with having no note at all AND collapsed the
// spread from 64 to 13 — the floorAB shape, uniformity bought and the tail lost,
// with the three shortest titles in the whole run coming from the statement arm.
//
// So the wording below deliberately mirrors the GRAMMAR of the arm that won:
// subject is the characters, verb is what the reader sees. "Only the first N
// ... show". It is not "keep it under 50", and it should not be reworded that
// way on the assumption that instructions outperform statements — on this exact
// field shape, measured, they did not.
//
// ─── WHAT IT TOUCHES ───────────────────────────────────────────────────────
// copy_fields.spec_note, on ONE (asset, field) pair, across every tenant that
// has it. NOT char_max, NOT char_min, NOT spec_type, NOT spec_source, NOT
// spec_verified_at, NOT any override column, and NOTHING in spec_watch_list or
// spec_review_queue. One UPDATE.
//
// TWO GUARDS, and they refuse for different reasons:
//
//   cf.spec_note IS NULL    ADDITIVE. Nothing a tenant or a later migration
//                           wrote is clobbered. At the time of writing the seed
//                           carries NULL here and no migration writes one, so
//                           this is expected to match every row — but a note
//                           silently overwritten is worse than a note not
//                           written, and the run reports any pair it skips.
//
//   cf.char_max = 70        THE TRUTH OF THE SENTENCE, the X_EXPECTED_MAX
//                           pattern. The note describes where a 70-character
//                           field truncates. Against a row holding a different
//                           limit it is describing something else, and it would
//                           be wrong in two customer-visible places at once —
//                           the italic hint under the field label, and the
//                           drafting prompt's `Field guidance:` line — with the
//                           run reporting success both times.
//
// A SKIPPED PAIR IS THE CORRECT OUTCOME on either guard. If the limit has moved,
// the note needs rewriting by whoever reads the new page; this file has no
// business guessing. The run prints the pair with the reason, which is the
// visible failure, and the alternative is a wrong number nothing raises again.
//
// ─── THE SEED IS NOT UPDATED BY THIS FILE ──────────────────────────────────
// src/data/defaultAssets.js has to gain the same string or a tenant created
// tomorrow will not have what a tenant migrated today has. That edit is in the
// same commit, and a smoke test asserts the two are byte-identical — the same
// arrangement HOOK_SPEC_NOTE, LINKEDIN_SIA_INTRO_NOTE and X_LINK_COST_NOTE all
// use. If you are reading this file alone, the seed is the other half.
//
//   node scripts/migrateAddXHeadlineTruncationNote.js --verify   # fetch + quote
//   node scripts/migrateAddXHeadlineTruncationNote.js            # dry run
//   node scripts/migrateAddXHeadlineTruncationNote.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[x-headline-truncation]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');

const URL = 'https://business.x.com/en/help/campaign-setup/creative-ad-specifications';

// The sentence being asserted. Byte-identical to the header quote above, and
// CUT rather than completed — see "TRUNCATED AT A CLEAN BOUNDARY".
//
// ATTRIBUTED TO THE IMAGE ADS WITH WEBSITE CARD BLOCK ON ONE PIECE OF EVIDENCE,
// stated so nobody treats it as measured: the operator reported that the two
// blocks differ in exactly this way — one writes "Max 70 characters", the other
// "70 characters" — and this dump carries "Max". The dump itself did not record
// which block it came from. If --verify ever reports 2x for this string, that
// attribution is wrong and the two blocks agree after all.
const QUOTE = 'Media headline length: Max 70 characters. Please note \u2014 depending on device and app '
  + 'settings this description may truncate. Up to two lines of text are rendered on the card title; any '
  + 'text beyond that is truncated with an ellipsis. Although not guaranteed, limiting the description to '
  + '50 characters';

// THE NOTE. Statement of consequence, grammar mirroring the arm notesAB measured
// as better — see the header. BYTE-IDENTICAL to X_HEADLINE_TRUNCATION_NOTE in
// src/data/defaultAssets.js; a smoke test compares the two.
//
// IT CHANGED WITH THE QUOTE, and that is the point rather than an afterthought.
// The superseded wording was "Only the first 50 characters reliably show on most
// devices." — which is not false, and which described 50 as a DEVICE THRESHOLD
// because the superseded quote gave no other reason for it. The corrected quote
// supplies the mechanism: "Up to two lines of text are rendered on the card
// title; any text beyond that is truncated with an ellipsis." 50 is roughly what
// fits two lines. It is a property of the CARD, not of the phone.
//
// So the note carries the REASON rather than the statistic. "Two lines" is a
// thing a writer can picture and check as they write; "most devices" is a number
// they can only take on trust, and it quietly implies the threshold is about
// hardware. The device variance is still carried, in "about".
//
// The measured constraint is unchanged: still a statement, still "Only …" with
// the characters as subject, and three characters shorter. Do not reword it to
// "keep the title to two lines" — notesAB scored the imperative form of the
// comparable Pinterest note 0/10 within 40, level with no note at all, with
// spread collapsing 64 to 13.
//
// THE SUPERSEDED STRING SHIPPED. It was deployed to the seed at fecc346, so a
// tenant installing between that commit and this one carries the older wording
// in copy_fields. Closing that would take a follow-up migration matching on the
// old text; with no real customers on the product it is not worth one, and it is
// recorded here rather than left for somebody to discover as a divergence.
const NOTE = 'Only about 50 characters fit the card title\'s two lines.';

// The pair, its expected stored limit, and the field the note describes.
// PAIR-SCOPED rather than URL-scoped: five other tiered fields cite this URL
// (Twitter/X Ad / Ad Copy, Graphic Headline, Subhead, CTA Button and Organic
// Social — Twitter/X / Post Copy), and none of them is a media headline.
const PAIRS = [
  { asset: 'Twitter/X Ad', field: 'Headline', expected: 70 },
];

// A unix-socket connection is local by construction and never speaks SSL.
function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// --- the page ---------------------------------------------------------------
// Returns { ok, why }. Called by --verify AND by the write path, so the note is
// never written without the page being read in the same run.
async function readPage() {
  const { fetchText, hashableText } = require('../src/services/specDetector');
  console.log(`\n${'='.repeat(74)}\nX — creative ad specifications\n${URL}\n${'='.repeat(74)}`);

  let a;
  let b;
  try {
    const rawA = await fetchText(URL);
    await new Promise((r) => setTimeout(r, 2500));
    const rawB = await fetchText(URL);
    // content_stop_marker is null on this row, so hashableText is normalize().
    // Called through the helper anyway, so this measures the path the detector's
    // run loop takes rather than a shortcut around it.
    a = hashableText({ content_stop_marker: null }, rawA);
    b = hashableText({ content_stop_marker: null }, rawB);
  } catch (err) {
    return { ok: false, why: `fetch failed: ${err.message}. A run with no network is a refusal, not a fallback.` };
  }

  console.log(`   hashed ${a.length} chars`);
  console.log(`   across two fetches: ${a === b ? 'STABLE' : 'VARIES'}`);

  const n = a.split(QUOTE).length - 1;
  console.log(`   ${n > 0 ? 'PRESENT' : 'ABSENT '} ${n}x  ${JSON.stringify(QUOTE.slice(0, 58))}…`);
  if (n > 1) {
    // NOT A REFUSAL. Repetition per format block is this page's normal shape —
    // "post copy: 280 characters" recurs across six of them. Printed so the
    // reader knows which they are looking at.
    console.log(`            ${n} occurrences — expected: the Video Ads with Website Card block`);
    console.log('            carries the same guidance, and Website Carousels the same 70/50 pair.');
  }
  if (n === 0) {
    return {
      ok: false,
      why: 'the quoted sentence is not on the page. BEFORE CONCLUDING X CHANGED IT, check the '
        + 'transcription — that is what it was both times this check has fired. TWO WAYS TO GET IT WRONG, '
        + 'and they need different fixes. (1) CHARACTER level: normalize() strips tags and DECODES NOTHING, '
        + 'so an &nbsp; or an &amp; reaches the hashed text as literal characters, and this quote carries an '
        + 'EM DASH (U+2014) after "Please note" that is easy to flatten to a hyphen. (2) SENTENCE level: the '
        + 'superseded version of this quote merged two of X\'s sentences into a plausible hybrid that reads '
        + 'correctly and matches nothing — if you assembled this from more than one screenful, suspect that '
        + 'first. A quote differing in punctuation, entities or sentence boundaries is ours to fix; one '
        + 'differing in a NUMBER is X\'s, and that is a real finding.',
    };
  }

  // The stored limit, as a floor rather than a census — weak evidence on its
  // own, here to catch a row cited to a page carrying none of its numbers.
  const { countWholeNumber } = require('./lib/wholeNumber');
  for (const v of ['70', '50']) {
    console.log(`   value ${v}: ${countWholeNumber(a, v)}x in the hashed text`);
  }

  return { ok: true };
}

// --- the reads --------------------------------------------------------------
//
// UNNEST OF PARALLEL ARRAYS, the shape scripts/migrateVerifySoleWitnessSpecs.js
// uses — NOT a multidimensional ANY, whose elements are text scalars rather than
// sub-arrays, so the comparison becomes record = text and Postgres answers
// `operator does not exist: record = text`.
//
// AND IT CARRIES `at.is_active`, matching specReview.currentValues and every
// migration in this chain. A deactivated asset is invisible to every document —
// getTenantAssets filters on it — so a note on one would describe a field no
// writer can see.
//
// spec_note_override IS READ AND PRINTED, though nothing here writes it. A
// tenant holding an override renders THEIR note, not this one, so a run
// reporting "1 row updated" against such a tenant would be true and misleading.
const PREVIEW_SQL = `
  SELECT want.asset,
         want.field,
         at.tenant_id,
         cf.char_max,
         cf.spec_type,
         cf.spec_note,
         cf.spec_note_override
    FROM unnest($1::text[], $2::text[]) AS want(asset, field)
    JOIN asset_types at ON at.name = want.asset AND at.is_active
    JOIN copy_fields cf ON cf.asset_type_id = at.id AND cf.field_name = want.field
   ORDER BY want.asset, want.field, at.tenant_id`;

// THE WRITE. Both guards ride in the JOIN rather than in application code — one
// statement, one round trip, and no way for the pair list and the guards to
// drift apart.
const UPDATE_SQL = `
  UPDATE copy_fields cf
     SET spec_note = $4
    FROM unnest($1::text[], $2::text[], $3::int[]) AS want(asset, field, expected),
         asset_types at
   WHERE cf.asset_type_id = at.id
     AND at.name = want.asset
     AND cf.field_name = want.field
     AND at.is_active
     AND cf.spec_note IS NULL
     AND cf.char_max = want.expected
  RETURNING at.tenant_id`;

// Everything else citing this URL, so the run can PROVE it left them alone
// rather than assert it. Named as data, not prose.
const NOT_TOUCHED = [
  { asset: 'Twitter/X Ad', field: 'Ad Copy' },
  { asset: 'Twitter/X Ad', field: 'Graphic Headline' },
  { asset: 'Twitter/X Ad', field: 'Subhead' },
  { asset: 'Twitter/X Ad', field: 'CTA Button' },
  { asset: 'Organic Social — Twitter/X', field: 'Post Copy' },
];

const UNTOUCHED_SQL = `
  SELECT want.asset, want.field, at.tenant_id, cf.spec_note
    FROM unnest($1::text[], $2::text[]) AS want(asset, field)
    JOIN asset_types at ON at.name = want.asset AND at.is_active
    JOIN copy_fields cf ON cf.asset_type_id = at.id AND cf.field_name = want.field
   ORDER BY want.asset, want.field, at.tenant_id`;

function cols(rows, key) {
  return rows.map((r) => r[key]);
}

function short(s, n = 62) {
  if (s == null) return '(none)';
  const t = String(s);
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;

  if (VERIFY) {
    const r = await readPage();
    console.log(`\n${TAG} ${r.ok ? 'VERIFY PASSED — nothing written.' : `VERIFY FAILED: ${r.why}`}`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }

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

  // THE PAGE IS READ BEFORE THE DATABASE IS OPENED. A refusal here costs two
  // fetches; a refusal after the write costs a rollback and reads as a failure
  // of the migration rather than of the evidence for it.
  const page = await readPage();
  if (!page.ok) {
    console.error(`\n${TAG} REFUSING TO WRITE: ${page.why}`);
    process.exit(1);
  }

  const client = new Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();
  console.log(`\n${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);
  console.log(`${TAG} PAIR-scoped: ${PAIRS.length} pair(s). NOT url-scoped — see the header.`);
  console.log(`${TAG} note: ${JSON.stringify(NOTE)}`);

  // So a failure BEFORE the transaction opens does not print a rollback that
  // never happened.
  let inTxn = false;
  try {
    await client.query('BEGIN');
    inTxn = true;

    const before = await client.query(PREVIEW_SQL, [cols(PAIRS, 'asset'), cols(PAIRS, 'field')]);
    if (before.rowCount === 0) {
      throw new Error(
        'the pair resolves to ZERO rows. Either the asset name is wrong (note the exact spelling '
        + '"Twitter/X Ad"), the field name is wrong, or the asset is not active for any tenant. '
        + 'Nothing written.'
      );
    }

    console.log(`\n${'─'.repeat(78)}`);
    console.log('PER-PAIR PREVIEW — every row, including any the guards will skip');
    console.log(`${'─'.repeat(78)}`);
    console.log('   asset / field                 tenant        max   tier      current note');
    let willWrite = 0;
    const skipped = [];
    for (const r of before.rows) {
      const want = PAIRS.find((p) => p.asset === r.asset && p.field === r.field);
      const badMax = Number(r.char_max) !== want.expected;
      const hasNote = r.spec_note !== null;
      let mark = '  ->  will write';
      if (badMax) {
        mark = `  SKIP  char_max is ${r.char_max}, expected ${want.expected}`;
        skipped.push(`${r.tenant_id}: char_max ${r.char_max}`);
      } else if (hasNote) {
        mark = '  SKIP  already has a note';
        skipped.push(`${r.tenant_id}: existing note`);
      } else {
        willWrite += 1;
      }
      console.log(
        `   ${`${r.asset} / ${r.field}`.padEnd(29)} ${String(r.tenant_id).padEnd(13)} `
        + `${String(r.char_max).padStart(3)}   ${String(r.spec_type).padEnd(9)} ${short(r.spec_note, 28)}`
      );
      console.log(`     ${mark}`);
      // A TENANT OVERRIDE MEANS THIS NOTE WILL NOT RENDER FOR THEM. The base
      // column is what this writes; getTenantAssets resolves
      // COALESCE(spec_note_override, spec_note), so their own text wins.
      if (r.spec_note_override !== null) {
        console.log(`     NOTE: this tenant holds spec_note_override = ${JSON.stringify(short(r.spec_note_override, 40))}`);
        console.log('           — the base note is written but THEIR text is what renders.');
      }
    }
    console.log(`\n   ${willWrite} row(s) to write, ${skipped.length} skipped`
      + `${skipped.length ? ` (${skipped.join('; ')})` : ''}.`);

    const upd = await client.query(UPDATE_SQL, [
      cols(PAIRS, 'asset'), cols(PAIRS, 'field'), cols(PAIRS, 'expected'), NOTE,
    ]);
    console.log(`\n${TAG} UPDATE wrote ${upd.rowCount} row(s) (expected ${willWrite})`);
    if (upd.rowCount !== willWrite) {
      throw new Error(
        `the UPDATE wrote ${upd.rowCount} row(s) but the preview predicted ${willWrite}. The preview and `
        + 'the write disagree, which means one of them is reading a condition the other is not. Nothing '
        + 'written.'
      );
    }

    // PROVE the rest of the page's fields were left alone rather than assert it.
    const rest = await client.query(UNTOUCHED_SQL, [cols(NOT_TOUCHED, 'asset'), cols(NOT_TOUCHED, 'field')]);
    const wrongly = rest.rows.filter((r) => r.spec_note === NOTE);
    console.log(`\n${'─'.repeat(78)}`);
    console.log('NOT TOUCHED — the other tiered fields citing this same URL');
    console.log(`${'─'.repeat(78)}`);
    for (const r of rest.rows) {
      console.log(`   ${`${r.asset} / ${r.field}`.padEnd(38)} ${String(r.tenant_id).padEnd(13)} ${short(r.spec_note, 30)}`);
    }
    if (wrongly.length > 0) {
      throw new Error(
        `${wrongly.length} field(s) outside the pair now carry this note. The UPDATE reached further than `
        + 'its pair list. Nothing written.'
      );
    }
    console.log(`   all ${rest.rowCount} row(s) unchanged, as intended`);

    if (COMMIT) {
      await client.query('COMMIT');
      inTxn = false;
      console.log(`\n${TAG} COMMITTED.`);
      console.log(`${TAG} Nothing else to run: no watch row, no limit and no tier moved, so`);
      console.log(`${TAG} affected_fields is unchanged and no detection run is needed.`);
    } else {
      await client.query('ROLLBACK');
      inTxn = false;
      console.log(`\n${TAG} DRY RUN — rolled back. Pass --commit to write.`);
    }
  } catch (err) {
    if (inTxn) await client.query('ROLLBACK').catch(() => {});
    console.error(`\n${TAG} FAILED${inTxn ? ' (rolled back)' : ' (before any transaction opened)'}: ${err.message}`);
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

module.exports = { NOTE, QUOTE, URL, PAIRS, NOT_TOUCHED, UPDATE_SQL };
