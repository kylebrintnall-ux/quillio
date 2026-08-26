'use strict';

// August 2026 — seed Pinterest's three remaining ad formats into already-seeded
// tenants: Idea, Showcase and Quiz.
//
// Structural precedent: scripts/migrateAddGoogleVideoAssets.js. Same shape —
// --verify / dry-run-by-default / --commit, one transaction, per-tenant
// existence check through quillio_normalize_name, sort_order anchored on a
// SIBLING ROW rather than a literal, and an exported ASSETS array that
// test/smoke.test.js compares field-for-field against src/data/defaultAssets.js.
//
// THREE DELIBERATE DEVIATIONS FROM THAT PRECEDENT, all stated here rather than
// left to be noticed in the diff:
//
//   1. IT CREATES NO WATCH ROW, because the page is already watched. What that
//      costs is the whole of "THE GATE" below, and it is the most important
//      section in this file.
//   2. IT WRITES field_type PER FIELD. The precedent hardcodes 'text' in its
//      INSERT; two fields here are counted in WORDS.
//   3. IT CHOOSES NO ANCHOR. There is no candidate list, no section span and no
//      chooseAnchor — the existing row's anchor is not this migration's to move.
//      scripts/migrateFixGoogleDisplayAnchor.js is the shape for that job.
//
// ─── THE FETCHED PAGE ───────────────────────────────────────────────────────
// https://help.pinterest.com/en/business/article/pinterest-product-specs — read
// through scripts/probeSpecPage.js against the live normalized text, 2026-08-25.
// Verbatim, per CLAUDE.md's fetch rule, so every number below can be checked
// without leaving this file. The percentages are where each block sits in the
// normalized document, which is what says these are three DIFFERENT sections of
// one page rather than one sentence read three times.
//
// IDEA ADS, ~65%:
//
//   "Character length Title: 100 characters max On page: 250 characters max"
//
// SHOWCASE ADS, ~77%:
//
//   "Character length Text overlay : Limited to no more than 10 words. Font
//    must be legible.&nbsp; Features : Limited to 50&nbsp;characters including
//    spaces. For titles, anything after 50 characters will be hidden."
//
// QUIZ ADS, ~85%:
//
//   "Character length Title: 100 characters max.&nbsp; Text overlay : Limited
//    to no more than 10 words. Font should be easy to read. Consider stacking
//    brand logo, quiz title and CTA at the top of the Pin.&nbsp; Questions and
//    answers : Questions can be up to 96&nbsp;characters, including spaces.
//    Answers can be up to 48&nbsp;characters, including spaces.&nbsp; Results :
//    100 characters max in title and 800 characters max for description."
//
// ─── THE &nbsp; ENTITIES ARE PART OF THE TEXT. QUOTE THEM. ─────────────────
// Read this before "tidying" the entities out of VERBATIM below.
//
// `normalize()` in src/services/specDetector.js strips TAGS — `<script>`,
// `<style>`, then `<[^>]+>` — and DECODES NOTHING. So an `&nbsp;` in the served
// HTML survives into the hashed text as the seven literal characters `&nbsp;`,
// and a quote that writes a plain space where the page writes an entity reports
// ABSENT on a page that is perfectly healthy.
//
// THIS ALREADY HAPPENED, and it is recorded because the correction is more
// useful than a clean history. The first version of this file carried the two
// blocks below with plain spaces where the page has `&nbsp;`. Two --verify runs
// refused to write. The Idea block passed both times — it happens to carry no
// entities at all, which is exactly why the failure looked like a property of
// the other two blocks rather than of the transcription.
//
// A TRANSCRIPTION FAILURE ON OUR SIDE, NOT A PAGE CHANGE. Pinterest published
// the same thing throughout. The blocks were copied out of a probe report with
// the entities flattened, and `&nbsp;&#32;` — an entity followed by a space —
// arrived as two plain spaces, which is why the section that used to stand here
// was titled "THE DOUBLE SPACES ARE REAL" and explained the failure in terms of
// whitespace. It was right that the cause was transcription and wrong about
// which character. Corrected rather than deleted: the wrong diagnosis is the
// instructive part, because it was a plausible reading of a real symptom.
//
// ─── WHAT THE FAILURE DEMONSTRATED, AND IT IS THE POINT OF THE CHECK ───────
// THE QUOTE CHECK WORKED. Two blocks that did not match the page refused to
// write — no asset seeded, no limit stored, no verification date stamped
// against text nobody had matched — and the refusal named TRANSCRIPTION rather
// than a page change, which is the distinction that decides whether the next
// person edits this file or goes and re-reads Pinterest.
//
// That is worth stating plainly because a check whose only visible behaviour is
// refusing looks like an obstacle until the day it catches something. Without
// it this migration would have seeded seventeen enforced fields, each carrying
// spec_verified_at = 2026-08-25 — a claim that a human read these numbers on
// the cited page — while two of the three blocks that claim rests on were not
// on the page as written. Nothing downstream would ever have said so.
//
// ─── asNormalized IS A NO-OP TODAY, AND THAT IS WORTH KNOWING ──────────────
// All three corrected blocks are collapse-stable: zero runs of two or more
// whitespace characters between them, so `asNormalized` returns each one
// unchanged. It is kept anyway, because normalize() really does end with
// `.replace(/\s+/g, ' ')` and a future quote pasted with a wrapped line would
// otherwise fail for a reason nobody would find. Collapsing the NEEDLE can only
// ever make it match text the page contains — it cannot invent a match — so the
// guard is free.
//
// But it is a no-op, and nobody should read the fact that these quotes pass as
// evidence that it does anything. What made them pass is the entities.
//
// So the verbatim strings are the SOURCE OF TRUTH and live in VERBATIM below,
// byte for byte as read, entities included. Each asset's `quotes` array holds
// those same strings — the objects, not copies — and readPage matches them
// through `asNormalized`. One copy of the text, one transformation, both
// visible. Editing VERBATIM changes what is matched; there is no second place
// to keep in step, and there is deliberately no pre-collapsed constant sitting
// beside the verbatim one to drift from it.
//
// ─── WHAT THE PAGE DOES NOT SAY, AND WHERE THE COUNTS COME FROM ────────────
// copy_fields has NO REPEAT MECHANISM. A field is one row with one limit, so a
// format publishing "up to N of these" becomes N NUMBERED FIELDS — the way
// LinkedIn Carousel carries Card 1-5 Headline and Google Performance Max
// carries Headline 1-3. That is a modelling decision every time, and it is
// wrong in two different directions: too few fields and a writer has nowhere to
// put the copy, too many and the copy-done screen reports an incomplete draft
// forever because nobody filled Answer 4.
//
// Three counts are needed and the page supplies none of them in the blocks
// above. Their provenance differs and is recorded per count rather than
// averaged into one sentence:
//
//   Feature x3    From the operator's reading of the Showcase block's
//                 surrounding text: "Minimum of 1 and maximum 3 per card".
//                 NOT in the quoted block above and therefore NOT in QUOTES —
//                 it is not matched, not asserted, and is recorded as supplied
//                 rather than fetched. If it turns out to be wrong the fix is a
//                 field count, not a limit.
//
//   Question x3   Inferred from "Up to three results Pins with one title Pin",
//                 also from the operator. STATED PLAINLY BECAUSE THE INFERENCE
//                 IS NOT TIGHT: that sentence counts RESULTS PINS, not
//                 questions. Three questions is a reasonable reading of a quiz
//                 that resolves to three outcomes and it is not something the
//                 page says. Same evidential status as the four answers below.
//
//   Answer x4     A JUDGEMENT, not a published number. The page gives no answer
//                 count at all. Four is the common quiz shape; nothing supports
//                 it beyond that, and it is the first thing to revisit if
//                 writers report empty or missing answer fields.
//
// ─── WHY enforced ───────────────────────────────────────────────────────────
// "characters max", "Limited to 50 characters including spaces", "can be up to
// 96 characters". Entry language describing what the field will accept — the
// same construction as Pinterest's own "Enter up to" on the standard image
// block (scripts/migrateAddPinterestSpecs.js) and Google's "support up to". It
// is not the "Text Recommendations" heading that left LinkedIn's nine an open
// question, so that caution does not transfer here either.
//
// ─── TRUNCATION GOES IN spec_note, NEVER IN char_max ───────────────────────
// The same split scripts/migrateAddPinterestSpecs.js made for the 40-character
// feed truncation: a cap is a rule, a truncation is writing guidance, and they
// live in different channels so the doc renders both without the prompt reading
// one as the other.
//
//   "anything after 50 characters will be hidden"   -> Feature 1-3 spec_note.
//                                                     char_max stays 50, which
//                                                     is the number Pinterest
//                                                     accepts.
//   the results screen being its own Pin            -> Results Title and Results
//                                                     Description spec_note.
//
// BOTH ARE PHRASED AS STATEMENTS OF CONSEQUENCE, NOT IMPERATIVES, and that is
// measured rather than stylistic. scripts/notesAB.js ran three arms on Pinterest
// Pin / Title, ceiling 100 in every arm:
//
//   NONE (no note)                                  0/10 within 40, spread 17
//   statement  "Only the first 40 characters ..."   3/10 within 40, spread 64
//   instruction "Front-load the first 40 ..."       0/10 within 40, spread 13
//
// Rewriting the statement into an imperative took it to level with no note at
// all and collapsed the spread from 64 to 13 — the floorAB shape, uniformity
// bought and the tail lost, and the three shortest titles in the run all came
// from the statement arm. Do not reword these toward the imperative.
//
// ─── TWO WORD-COUNTED FIELDS, AND THE INSERT HAD TO CHANGE FOR THEM ────────
// "Limited to no more than 10 words" is a WORD limit. copy_fields.field_type
// carries the unit — 'words' means char_min/char_max are a word range — and
// until now only email body fields used it (scripts/migrateEmailBodyWordCounts).
// These are the first non-email fields to.
//
// So the field tuple carries a SEVENTH element, the unit, and insertForTenant
// writes it instead of the literal 'text' the precedent hardcodes. The general
// seed-agreement test compares the first six elements only, so a smoke test in
// this file's block asserts the seventh against the seed's own field_type —
// otherwise the unit could drift between the seed and the migration silently,
// which is precisely the drift that test exists to prevent for the other six.
//
// Storing 10 in char_max with field_type 'words' is not a workaround; it is what
// the column means. The label renders "[10 words]" and the prompt asks for a
// word count.
//
// ─── THE GATE: THIS RUN LEAVES 17 FIELDS OUTSIDE IT ────────────────────────
// READ THIS BEFORE RUNNING --commit. It is the one consequence of this
// migration that nothing in the system will tell you about afterwards.
//
// The watch row for this URL ALREADY EXISTS — scripts/migrateAddPinterestSpecs
// created it, anchored, baselined, and it has been reporting `unchanged`. This
// migration deliberately does not touch it: an anchor is chosen against a
// fetched page with a section argument behind it, and re-choosing one as a side
// effect of seeding assets is how a row ends up watching a table nobody meant.
//
// But spec_watch_list.affected_fields is a SNAPSHOT computed once and recomputed
// by nothing. It is also the WRITE GATE — services/specReview.js guardEdits
// refuses any edit whose (asset, field) pair is not in that array. So after this
// runs:
//
//   the page changes            -> the detector still flags it, once, correctly
//   the admin opens the flag    -> the approve form is populated FROM
//                                  affected_fields, so these 17 fields are not
//                                  offered
//   somebody posts them anyway  -> guardEdits answers "not an affected field of
//                                  this flag"
//   Pinterest Pin updates       -> and the three new assets keep the old number,
//                                  diverging from it permanently
//
// Nothing errors. checkSpecHealth does NOT catch it: its coverage check fires
// only for a cited URL with NO watch row, and this URL has one. Its `numbers`
// check derives what to look for FROM affected_fields, so the new values are not
// in it either. scripts/auditWatchList.js checks that every pair IN the array
// still resolves, never that a pair that should be there is missing.
//
// So a successful --commit PRINTS THE FIX, with the row's real id looked up in
// the same transaction rather than a placeholder:
//
//   node scripts/rederiveAffectedFields.js --only=<id>            # dry run
//   node scripts/rederiveAffectedFields.js --only=<id> --commit
//
// It re-derives from cf.spec_source = source_url AND at.is_active, which is
// exactly these fields plus the two already there.
//
// AND THE RUN REFUSES IF THE WATCH ROW IS ABSENT. Seeding enforced fields that
// cite an unwatched page creates a coverage gap silently — the page could change
// and nothing would fetch it. Fail closed, name the migration that creates the
// row, write nothing.
//
// ─── ROUTING: NOTHING TO ADD, AND THAT IS CHECKED RATHER THAN ASSUMED ──────
// src/services/gemini.js mediumKeywordsForAsset line 172 is
// `if (a.includes('pinterest')) return ['paid social'];`, tested above the
// platform regex and above the `form`/"perFORMance" trap at the bottom of that
// function. All three names here contain "Pinterest", so all three route to
// craft.md's `### Paid Social` with no new branch. Asserted by the pinned
// routing table rather than left as a claim.
//
// ASSET_PHRASE_HINTS: NOTHING ADDED, DELIBERATELY. A hint wiring a generic
// phrase to one specialised sibling is the edit that sent every "a landing page"
// brief to Event Landing Page, and four Pinterest formats is exactly the
// "a couple of paid posts" ambiguity CLAUDE.md logs as an open question — a
// generic phrase over a set of siblings, where a WRONG match is invisible
// because unmatchedAssets only ever holds what failed to map. Adding
// "- 'pinterest' -> Pinterest Pin" now would aim the bare word at the format
// that happens to have been seeded first. Left unrouted so the model picks and
// the picker confirms.
//
//   node scripts/migrateAddPinterestAdFormats.js --verify   # fetch + quotes only
//   node scripts/migrateAddPinterestAdFormats.js            # dry run (ROLLBACK)
//   node scripts/migrateAddPinterestAdFormats.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[pinterest-ad-formats]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');

// The date a human read the page. Hardcoded rather than NOW(), for the reason
// scripts/migrateBackfillSpecVerifiedAt.js states: NOW() stamps whenever
// somebody runs the file, which is a different event from the one recorded.
const VERIFIED_ON = '2026-08-25';

const URL = 'https://help.pinterest.com/en/business/article/pinterest-product-specs';

// The sentinel every house_default field carries. Never a URL. Unused here —
// every field on all three assets is cited — and named so the INSERT reads the
// same as the two migrations this copies rather than special-casing.
const HOUSE_SOURCE = 'quillio_default';
const SPEC_VERSION = '1.0';

// Per-field notes. Named constants because the seed needs the identical strings
// and a smoke test compares the two byte for byte.
const SHOWCASE_FEATURE_NOTE = 'Anything past 50 characters is hidden on titles.';
const QUIZ_RESULTS_NOTE = 'The results screen is a separate Pin from the title Pin.';

// THE PAGE TEXT AS READ, byte for byte, &nbsp; ENTITIES INCLUDED. The header
// quotes these; each asset's `quotes` array holds these same strings and
// readPage matches them through asNormalized. See "THE &nbsp; ENTITIES ARE PART
// OF THE TEXT" above — normalize() decodes nothing, so an entity written as a
// plain space here can never match, and two --verify runs already refused for
// exactly that.
const VERBATIM = {
  idea: 'Character length Title: 100 characters max On page: 250 characters max',
  showcase: 'Character length Text overlay : Limited to no more than 10 words. Font must be legible.&nbsp; '
    + 'Features : Limited to 50&nbsp;characters including spaces. For titles, anything after 50 characters will be hidden.',
  quiz: 'Character length Title: 100 characters max.&nbsp; Text overlay : Limited to no more than 10 words. '
    + 'Font should be easy to read. Consider stacking brand logo, quiz title and CTA at the top of the Pin.&nbsp; '
    + 'Questions and answers : Questions can be up to 96&nbsp;characters, including spaces. Answers can be up to '
    + '48&nbsp;characters, including spaces.&nbsp; Results : 100 characters max in title and 800 characters max '
    + 'for description.',
};

// The ONE transformation applied to a verbatim quote before it is matched, and
// it is the same one normalize() ends with. Not a general cleaner: no case
// folding, no punctuation folding, no entity decoding. Anything beyond
// whitespace collapse would make a quote match text the page does not contain,
// which is the opposite of what the quote check is for.
function asNormalized(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// [field_name, char_min, char_max, group_label|null, spec_type, spec_note|null, unit]
//
// `unit` is the seventh element and defaults to 'text' — see "TWO WORD-COUNTED
// FIELDS" above for why it exists and what asserts it.
//
// char_min is 0 on every field. Pinterest publishes no floor for any of these,
// and a floor this project invented would collapse the spread of the copy
// without being anybody's rule — measured on the Subhead in scripts/floorAB.js,
// where stating a band cut the range by two thirds and cost the best line in the
// run. Absent a published number, no band.
const ASSETS = [
  {
    url: URL,
    name: 'Pinterest Idea Ad',
    group: 'Paid Social',
    direction: 'Swiped through, not skipped past. The title has to earn the first swipe.',
    // ORDERED. The first that exists in a tenant decides where this sits; if none
    // does, it appends. Pinterest Pin is the natural neighbour and is present in
    // every tenant that ran migrateAddPinterestSpecs.
    siblings: ['Pinterest Pin'],
    quotes: [VERBATIM.idea],
    fields: [
      ['Title', 0, 100, null, 'enforced', null],
      ['On-Page Text', 0, 250, null, 'enforced', null],
    ],
  },
  {
    url: URL,
    name: 'Pinterest Showcase Ad',
    group: 'Paid Social',
    direction: 'Each card stands alone. Three short labels, not one sentence split three ways.',
    // CHAINED, so the three land in seed order however many of them a tenant
    // already has. Anchoring all three on Pinterest Pin would insert each at the
    // same position and reverse them.
    siblings: ['Pinterest Idea Ad', 'Pinterest Pin'],
    quotes: [VERBATIM.showcase],
    fields: [
      ['Text Overlay', 0, 10, null, 'enforced', null, 'words'],
      // THE NOTE IS ON ALL THREE, not on the first, and that is the LinkedIn
      // Carousel precedent rather than an oversight: a writer working on Feature
      // 3 must not have to remember what Feature 1 said. It is deliberately NOT
      // added to SHOW_ONCE_NOTES, whose stated criterion is notes REDUNDANT with
      // their field — this one carries information the label does not.
      ['Feature 1', 0, 50, null, 'enforced', SHOWCASE_FEATURE_NOTE],
      ['Feature 2', 0, 50, null, 'enforced', SHOWCASE_FEATURE_NOTE],
      ['Feature 3', 0, 50, null, 'enforced', SHOWCASE_FEATURE_NOTE],
    ],
  },
  {
    url: URL,
    name: 'Pinterest Quiz Ad',
    group: 'Paid Social',
    direction: 'The question does the work. Answers are choices, not copy.',
    siblings: ['Pinterest Showcase Ad', 'Pinterest Idea Ad', 'Pinterest Pin'],
    quotes: [VERBATIM.quiz],
    fields: [
      ['Title', 0, 100, null, 'enforced', null],
      ['Text Overlay', 0, 10, null, 'enforced', null, 'words'],
      ['Question 1', 0, 96, null, 'enforced', null],
      ['Question 2', 0, 96, null, 'enforced', null],
      ['Question 3', 0, 96, null, 'enforced', null],
      ['Answer 1', 0, 48, null, 'enforced', null],
      ['Answer 2', 0, 48, null, 'enforced', null],
      ['Answer 3', 0, 48, null, 'enforced', null],
      ['Answer 4', 0, 48, null, 'enforced', null],
      ['Results Title', 0, 100, null, 'enforced', QUIZ_RESULTS_NOTE],
      ['Results Description', 0, 800, null, 'enforced', QUIZ_RESULTS_NOTE],
    ],
  },
];

// The unit a field's numbers are counted in. Seventh tuple element, 'text' when
// absent — so every field written before this migration reads exactly as it did.
function fieldUnit(row) {
  return row[6] === 'words' ? 'words' : 'text';
}

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function count(hay, needle) {
  return hay.split(needle).length - 1;
}

// Value checks match WHOLE NUMBERS. A substring count of "100" on this page also
// counts the 100 inside "1000 x 1500 pixels", which is the defect
// scripts/lib/wholeNumber.js was written for — measured on this exact URL.
const { countWholeNumber } = require('./lib/wholeNumber');

// Every stored limit across all three assets, as strings. Reported as a floor
// rather than a census: a short number turns up in dates and pixel sizes, so
// this is weak evidence on its own and is here to catch the strong case — a
// seed whose numbers are not on the page it cites.
function storedLimits(asset) {
  return [...new Set(asset.fields.flatMap((f) => [f[1], f[2]]).filter((n) => n > 0).map(String))];
}

// --- the page ---------------------------------------------------------------
// Returns { ok, why }. Called by --verify AND by the write path, so no value is
// written without the page being read in the same run.
async function readPage() {
  const { fetchText, hashableText } = require('../src/services/specDetector');
  console.log(`\n${'='.repeat(74)}\nPinterest — product specs\n${URL}\n${'='.repeat(74)}`);

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
  const stable = a === b;
  console.log(`   across two fetches: ${stable ? 'STABLE — no stop marker needed' : 'VARIES — needs a marker'}`);
  if (!stable) {
    return { ok: false, why: 'the page varies between fetches; the existing row would need a content_stop_marker' };
  }

  let missing = 0;
  for (const asset of ASSETS) {
    console.log(`\n   ${asset.name}`);
    for (const raw of asset.quotes) {
      const q = asNormalized(raw);
      const n = count(a, q);
      if (n === 0) missing += 1;
      console.log(`   ${n > 0 ? 'PRESENT' : 'ABSENT '} ${n}x  ${JSON.stringify(q.slice(0, 58))}${q.length > 58 ? '…' : ''}`);
      // WHERE, not just whether. Three blocks of one page: if two of them report
      // the same offset the quotes are not describing three sections.
      if (n > 0) {
        const at = a.indexOf(q);
        console.log(`            at char ${at} of ${a.length} (${Math.round((at / a.length) * 1000) / 10}%)`);
      }
    }
  }
  if (missing > 0) {
    return {
      ok: false,
      why: `${missing} quoted block(s) are not on the page — this file's header would be making a claim the page `
        + 'does not support. BEFORE CONCLUDING THE PAGE CHANGED, check the transcription, because that is what it '
        + 'was the first two times: normalize() strips tags and DECODES NOTHING, so an &nbsp; on the page reaches '
        + 'the hashed text as the seven literal characters "&nbsp;" and a plain space written in its place will '
        + 'never match. Whitespace is the same class — a run of two or more collapses, and these quotes are '
        + 'matched collapsed for that reason. A block differing only in entities or spacing is ours to fix; a '
        + 'block differing in a NUMBER or a LABEL is Pinterest\'s, and that one is a real finding.',
    };
  }

  console.log('\n   stored limits, as a floor rather than a census:');
  const limits = [...new Set(ASSETS.flatMap(storedLimits))].sort((x, y) => Number(x) - Number(y));
  for (const n of limits) console.log(`   value ${String(n).padStart(4)}: ${countWholeNumber(a, n)}x in the hashed text`);

  return { ok: true };
}

// --- the asset --------------------------------------------------------------
// One tenant, one asset. Returns 'inserted' | 'exists'.
async function insertForTenant(client, tenantId, asset) {
  const has = await client.query(
    'SELECT id FROM asset_types WHERE tenant_id = $1 AND quillio_normalize_name(name) = quillio_normalize_name($2)',
    [tenantId, asset.name]
  );
  if (has.rowCount > 0) return 'exists';

  // SORT ORDER IS ANCHORED ON THE TENANT'S OWN SIBLING ROW, not on a number from
  // the seed: a tenant seeded before the prune has different sort_order values
  // for the same assets, so a literal position would land somewhere arbitrary in
  // their library. The list is ordered, and the first sibling that exists wins.
  let at = null;
  for (const sibling of asset.siblings) {
    const sib = await client.query(
      'SELECT sort_order FROM asset_types WHERE tenant_id = $1 AND name = $2',
      [tenantId, sibling]
    );
    if (sib.rowCount > 0) {
      at = Number(sib.rows[0].sort_order) + 1;
      await client.query(
        'UPDATE asset_types SET sort_order = sort_order + 1 WHERE tenant_id = $1 AND sort_order >= $2',
        [tenantId, at]
      );
      break;
    }
  }
  if (at === null) {
    const max = await client.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM asset_types WHERE tenant_id = $1',
      [tenantId]
    );
    at = Number(max.rows[0].n);
    console.log(`${TAG}   ${tenantId}  none of [${asset.siblings.join(', ')}] present — appending at ${at}`);
  }

  const ins = await client.query(
    `INSERT INTO asset_types (tenant_id, name, "group", is_active, sort_order, asset_direction, spec_note)
       VALUES ($1, $2, $3, true, $4, $5, NULL) RETURNING id`,
    [tenantId, asset.name, asset.group, at, asset.direction]
  );
  const assetTypeId = ins.rows[0].id;

  for (let i = 0; i < asset.fields.length; i++) {
    const row = asset.fields[i];
    const [name, min, max, groupLabel, tier, note] = row;
    const enforced = tier === 'enforced';
    await client.query(
      `INSERT INTO copy_fields
              (asset_type_id, field_name, char_min, char_max, field_type, sort_order,
               spec_source, spec_version, group_label, spec_note, spec_type, spec_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        assetTypeId, name, min, max,
        // PER FIELD, not the literal 'text' the precedent writes. Two fields here
        // are counted in words.
        fieldUnit(row),
        i + 1,
        enforced ? asset.url : HOUSE_SOURCE,
        SPEC_VERSION,
        groupLabel,
        note,
        tier,
        // ONLY THE CITED FIELDS CARRY A DATE. A house default has no page to have
        // been read against, so a verification date on one would assert an event
        // that cannot have happened. (Every field here is cited, so this is
        // always VERIFIED_ON — kept as the conditional the precedent uses so the
        // rule survives a future house_default field being added.)
        enforced ? VERIFIED_ON : null,
      ]
    );
  }
  console.log(`${TAG}   ${tenantId}  ${asset.name} at sort_order ${at}, ${asset.fields.length} field(s)`);
  return 'inserted';
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
  // fetches; a refusal after the writes costs a rollback and reads as a failure
  // of the migration rather than of the evidence for it.
  const page = await readPage();
  if (!page.ok) {
    console.error(`\n${TAG} REFUSING TO WRITE: ${page.why}`);
    process.exit(1);
  }

  const client = new Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();
  console.log(`\n${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  // So a failure BEFORE the transaction opens does not print a rollback that
  // never happened. The catch below is reached by connection and query failures
  // alike, and "rolled back" about a transaction that was never begun is a false
  // statement in the one line somebody reads when a run fails.
  let inTxn = false;
  try {
    await client.query('BEGIN');
    inTxn = true;

    // THE WATCH ROW MUST EXIST. Fail closed: seeding enforced fields that cite an
    // unwatched page creates a coverage gap silently — the page could change and
    // nothing would fetch it, and checkSpecHealth would report the URL uncovered
    // only if somebody ran it.
    const watch = await client.query(
      'SELECT id, display_name, expected_content, current_hash IS NOT NULL AS baselined FROM spec_watch_list WHERE source_url = $1',
      [URL]
    );
    if (watch.rowCount === 0) {
      throw new Error(
        `no watch row for ${URL}. These 17 fields cite it, so seeding them now would create a coverage gap `
        + 'with nothing watching the page. Run scripts/migrateAddPinterestSpecs.js --commit first.'
      );
    }
    const watchRow = watch.rows[0];
    console.log(`\n${TAG} watch row #${watchRow.id} — ${watchRow.display_name}`);
    console.log(`${TAG}   anchor ${JSON.stringify(watchRow.expected_content)}`);
    console.log(`${TAG}   ${watchRow.baselined ? 'baselined' : 'NOT baselined'} — this run does not touch it.`);

    const tenants = await client.query('SELECT DISTINCT tenant_id FROM asset_types ORDER BY tenant_id');
    console.log(`\n${TAG} ${tenants.rowCount} tenant(s) with an asset library`);

    const seededPairs = [];
    for (const asset of ASSETS) {
      console.log(`\n${'─'.repeat(74)}\n${asset.name}\n${'─'.repeat(74)}`);
      let inserted = 0;
      let existed = 0;
      // COLLECTED IN THE SAME LOOP THAT SEEDS THEM. A pasted snapshot is the
      // failure affected_fields already has on the board.
      for (const row of tenants.rows) {
        const what = await insertForTenant(client, row.tenant_id, asset);
        if (what === 'inserted') {
          inserted += 1;
          for (const f of asset.fields) {
            if (f[4] === 'enforced') seededPairs.push({ asset: asset.name, field: f[0] });
          }
        } else {
          existed += 1;
          console.log(`${TAG}   ${row.tenant_id}  already has ${asset.name} — skipped`);
        }
      }
      console.log(`${TAG} ${inserted} tenant(s) gained it, ${existed} already had it`);

      // Read the outcome back rather than trusting rowCounts.
      const check = await client.query(
        `SELECT cf.field_name, cf.char_min, cf.char_max, cf.field_type, cf.spec_type, cf.spec_note,
                cf.spec_verified_at::date AS verified, COUNT(*)::int AS tenants
           FROM copy_fields cf JOIN asset_types at ON at.id = cf.asset_type_id
          WHERE at.name = $1
          GROUP BY 1,2,3,4,5,6,7 ORDER BY MIN(cf.sort_order)`,
        [asset.name]
      );
      for (const r of check.rows) {
        const band = `${r.char_min}-${r.char_max}${r.field_type === 'words' ? 'w' : ''}`;
        console.log(`    ${String(r.field_name).padEnd(20)} ${band.padEnd(8)}` +
          ` ${String(r.spec_type).padEnd(9)} verified ${r.verified || '—'}  x${r.tenants}` +
          `${r.spec_note ? `\n        note: ${JSON.stringify(r.spec_note)}` : ''}`);
      }
    }

    const pairs = [...new Map(seededPairs.map((p) => [`${p.asset}||${p.field}`, p])).values()]
      .sort((x, y) => x.asset.localeCompare(y.asset) || x.field.localeCompare(y.field));

    // --- the gate ------------------------------------------------------------
    // Named loudly because nothing else will ever mention it. See "THE GATE" in
    // the header for why no health check catches this.
    console.log(`\n${'═'.repeat(74)}`);
    console.log(`${TAG} THE WRITE GATE IS NOW STALE — ${pairs.length} pair(s) seeded, none of them in it.`);
    console.log(`${'═'.repeat(74)}`);
    for (const p of pairs) console.log(`    ${p.asset} / ${p.field}`);
    console.log(`\n${TAG} spec_watch_list #${watchRow.id}.affected_fields still holds only what`);
    console.log(`${TAG} migrateAddPinterestSpecs derived. A flag on this page will not offer the`);
    console.log(`${TAG} pairs above, and guardEdits will refuse them if posted. Nothing errors and`);
    console.log(`${TAG} no health check reports it — the URL is watched, so it looks covered.`);

    if (COMMIT) {
      await client.query('COMMIT');
      inTxn = false;
      console.log(`\n${TAG} COMMITTED.`);
      console.log(`\n${TAG} RUN THIS NEXT — it is the other half of this migration:`);
      console.log(`\n    node scripts/rederiveAffectedFields.js --only=${watchRow.id}`);
      console.log(`    node scripts/rederiveAffectedFields.js --only=${watchRow.id} --commit`);
      console.log(`\n${TAG} (dry run first. It re-derives from cf.spec_source = source_url AND`);
      console.log(`${TAG}  at.is_active, so it should report ${pairs.length} pair(s) gained and 0 lost.)`);
      console.log(`\n${TAG} Then: node scripts/checkSpecHealth.js — the row now gates ${pairs.length} more pairs.`);
      console.log(`${TAG} No detection run is needed: no watch row was added, and current_hash is untouched.`);
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

// Required by smoke tests. Guarded above so requiring this file runs nothing,
// the same way scripts/migrateAddGoogleVideoAssets.js is.
//
// SOURCE_URLS and ENFORCE are keyed per asset the way every earlier link in the
// chain is. ASSETS (plural) is what the general seed-agreement test reads.
const SOURCE_URLS = Object.fromEntries(ASSETS.map((a) => [a.name, a.url]));
const ENFORCE = ASSETS.flatMap((a) =>
  a.fields.filter((f) => f[4] === 'enforced').map((f) => [a.name, f[0]]));

module.exports = {
  ASSETS, SOURCE_URLS, ENFORCE, VERIFIED_ON, URL,
  VERBATIM, asNormalized, fieldUnit, storedLimits,
  SHOWCASE_FEATURE_NOTE, QUIZ_RESULTS_NOTE,
};
