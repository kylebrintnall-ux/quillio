'use strict';

// August 2026 — seed Twitter/X Poll Ad into already-seeded tenants.
//
// Structural precedent: scripts/migrateAddPinterestAdFormats.js. Same shape —
// --verify / dry-run-by-default / --commit, inTxn, one transaction, per-tenant
// existence check through quillio_normalize_name, sort_order anchored on a
// SIBLING ROW rather than a literal, an exported ASSETS array that
// test/smoke.test.js compares field-for-field against src/data/defaultAssets.js,
// no watch row created, and the rederive command printed on a successful commit.
//
// ─── IT SHIPPED REFUSING, AND HAS SINCE BEEN FILLED ────────────────────────
// QUOTES was empty at 3420134 and requireHeaderEvidence() turned that absence
// into a refusal before the network and before DATABASE_URL was read. The
// authoring session had no egress to business.x.com — the proxy answers 403 to
// CONNECT — so no reading of this page stood behind the file.
//
// That was deliberate rather than unfinished. This session had already had TWO
// quotes refused for being wrong (Pinterest's &nbsp;, and X's own media-headline
// sentence, which merged two of the page's sentences into a hybrid that reads
// correctly and matches nothing). Both were written by someone who believed they
// were reading the page. A file shipping plausible-looking quotes nobody fetched
// is the same failure with nothing left to catch it.
//
// IT IS FILLED NOW, from a dump the operator took through the detector's own
// fetchText and normalize on 2026-08-25. The refusal moved from "no evidence" to
// "no network": requireHeaderEvidence passes, and --verify from a session
// without egress now fails at the fetch instead — which is a different and
// smaller gap, and one only a console with egress can close.
//
// ─── THE PAGE ───────────────────────────────────────────────────────────────
// https://business.x.com/en/help/campaign-setup/creative-ad-specifications
//
// Already watched: spec_watch_list carries a row for this URL, anchored on the
// "post copy:" spec label (scripts/migrateFixXAnchor.js). This migration does
// NOT touch it — see "THE WRITE GATE".
//
// ─── THE QUOTED TEXT, AND WHAT EACH QUOTE IS FOR ──────────────────────────
// Both from the IMAGE ADS WITH POLLS block. Dumped through fetchText +
// normalize, 2026-08-25, and reproduced verbatim in QUOTES below.
//
// QUOTE 1 — the Post Copy citation:
//
//   "post copy: Polls can include up to 280 characters of post copy that appear
//    above the image."
//
// QUOTE 2 — the option limit AND the relationship the note rests on:
//
//   "Poll options: 2-4 custom poll options Once you’ve written your copy and
//    added your image, you can add two to four custom poll responses to create
//    your poll. Poll copy: 25 characters each Each poll option can include up to
//    a maximum of 25 characters of text (which do not count against the 280 you
//    can include in post copy)."
//
// THE APOSTROPHE IN "you’ve" IS U+2019, the page's own character, and there are
// no HTML entities in this stretch. Both facts are asserted rather than trusted:
// the constant is written with an explicit \u2019 escape and a smoke test checks
// it, because a straight apostrophe pasted in its place would report ABSENT on a
// perfectly healthy page — the Pinterest &nbsp; failure in a different
// character, and the third time this file's family has met it.
//
// ─── QUOTE 1 MAKES THE 280 A POLLS CLAIM, NOT A BORROWED ONE ──────────────
// This is the part that changes how "THE POST COPY DUPLICATION" below should be
// read, and it is better than expected.
//
// X states the 280 SEPARATELY FOR POLLS — "Polls can include up to 280
// characters of post copy" — rather than only as the generic "post copy: 280
// characters" repeated per format block with "same as above". So this asset's
// Post Copy cites a sentence about POLLS, not a sentence about promoted ads that
// polls happen to inherit.
//
// THE DUPLICATION IS THEREFORE OF A VALUE, NOT OF A CLAIM. Twitter/X Ad / Ad
// Copy and Twitter/X Poll Ad / Post Copy hold the same number because X publishes
// the same number twice, in two sentences, about two things. That does not remove
// the operational cost recorded below — one flag, two pairs to tick, no sibling
// comparison — but it does mean the second row is not a copy of the first row's
// evidence. If X ever changed one and not the other, this library could represent
// that; a borrowed claim could not.
//
// ─── QUOTE 2 IS WHAT MAKES THE NOTE CHECKABLE ─────────────────────────────
// The note asserts a RELATIONSHIP between two numbers — the option's 25 does not
// draw down the post's 280 — and a relationship is exactly the kind of claim
// that is impossible to check after the fact. Quote 2 carries it in X's own
// words: "(which do not count against the 280 you can include in post copy)".
//
// Without that clause the note would be an inference from two limits sitting near
// each other on a page, which is how the wrong Meta numbers were produced.
//
// ─── EXPECT 1x EACH, NOT 2x, AND WHAT 2x WOULD MEAN ───────────────────────
// This block appears TWICE on the page: once under Image Ads with Polls and once
// under Video Ads with Polls, with "image" and "video" swapped in the wording.
// The quotes above are the IMAGE variant, and both carry the word — quote 1 in
// "above the image", quote 2 in "added your image" — so each should report 1x.
//
// IF EITHER REPORTS 2x, THE ATTRIBUTION IS WRONG: the two blocks are identical
// and this file is claiming a specificity the page does not have. That is a
// finding to act on, not noise to accept — the count is printed for exactly this
// reason. (A count above 1 is still not a REFUSAL here; see "THE COUNT IS NOT
// ASSERTED".)
//
// ─── A THIRD, SHORTER POLL BLOCK EXISTS AND IS DELIBERATELY NOT QUOTED ────
// Under Standard Features the page also says, with a capital P and no "above the
// image" clause:
//
//   "Post copy: Polls can include up to 280 characters of post copy."
//
// Recorded so nobody later reads three 280s on this page and concludes the count
// should be higher, or "corrects" a quote to match the shorter wording. It is not
// quoted because it says strictly less than quote 1 and asserting it would add a
// third string to keep in step for no gain.
//
// requireHeaderEvidence asserts every stored limit appears in some quote as a
// WHOLE NUMBER (scripts/lib/wholeNumber.js — "25" must not be satisfied by a
// "250" somewhere on the page). It cannot check the 2-4, which is prose about a
// count rather than a limit; that one is recorded below as a modelling decision
// and is not asserted.
//
// ─── FOUR NUMBERED FIELDS FOR A RANGE OF TWO TO FOUR ───────────────────────
// copy_fields has NO REPEAT MECHANISM. A field is one row with one limit, so a
// format publishing "2-4 of these" becomes N NUMBERED FIELDS — the way LinkedIn
// Carousel carries Card 1-5 Headline and Google Performance Max carries
// Headline 1-3.
//
// FOUR, because the seed has to hold the MAXIMUM: a writer who needs a fourth
// option and has no field for it has nowhere to put the copy, where a writer who
// needs two simply leaves two blank.
//
// AND LEAVING TWO BLANK HAS A COST WORTH KNOWING, because it is invisible from
// here. A blank field is the document's vocabulary for "still to do" — parseDoc
// reads the blank paragraph after a bold label as an undrafted field — so a
// two-option poll reports as an incomplete draft on the copy-done screen and in
// the Slack card's denominator. That is the correct trade (the alternative is a
// writer with nowhere to put option four), and it is the same trade LinkedIn
// Carousel already makes with five cards. It is written down so nobody later
// reads those blanks as a defect.
//
// The MINIMUM of two is the reason a writer may legitimately leave two empty,
// and it is recorded here rather than in a spec_note: it is a fact about the
// FORMAT, not guidance for writing any one field, and a note repeating "2-4" on
// four fields would say the same thing four times.
//
// ─── THE 25 IS NOT PART OF THE 280, AND THAT RELATIONSHIP IS A NOTE ────────
// THIRD INSTANCE OF THIS SHAPE IN THIS LIBRARY, and it is worth naming as a
// class rather than as a coincidence:
//
//   257   = 280 minus a link's 23. In X_LINK_COST_NOTE, not in char_max.
//   50    = roughly what fits the card title's two lines, under a 70 cap. In
//          X_HEADLINE_TRUNCATION_NOTE, not in char_max and not in char_min.
//   25    = the poll option cap, which does NOT draw down the 280.
//
// Every one is a RELATIONSHIP BETWEEN TWO NUMBERS, and every one is the kind of
// number somebody promotes into a limit by reading the arithmetic and not the
// sentence. Here the promotion would go the other way from the first two: the
// tempting move is to reduce Post Copy's char_max by the options' 100, on the
// reasoning that a poll ad has less room. The page says it does not. char_max
// stays 280.
//
// The note goes on the OPTION fields rather than on Post Copy. The writer who
// needs to know is the one budgeting an option and wondering whether it eats
// into their post; a note on Post Copy would be answering a question from the
// other end, on a field where the answer changes nothing.
//
// PHRASED AS A STATEMENT OF CONSEQUENCE, NOT AN IMPERATIVE, and that is
// measured. scripts/notesAB.js, Pinterest Pin / Title, three arms of ten:
//
//   NONE (no note)                                  0/10 within 40, spread 17
//   statement  "Only the first 40 characters ..."   3/10 within 40, spread 64
//   instruction "Front-load the first 40 ..."       0/10 within 40, spread 13
//
// The imperative scored level with no note at all and collapsed the spread from
// 64 to 13. The note below names the OTHER field's number (280) and does not
// restate this field's own 25, which the label already renders as "[25]".
//
// ─── THE POST COPY DUPLICATION — A WORKAROUND, NOT A DESIGN ───────────────
// READ THIS BEFORE ADDING THE NEXT X FORMAT.
//
// Post Copy [280] here is a SECOND COPY of a number Twitter/X Ad / Ad Copy
// already stores, from the same page, published once. The page itself says "same
// as above" where it repeats it — so this row duplicates a value rather than
// adding one.
//
// WHAT THE DUPLICATE COSTS, concretely and per tenant: its own copy_fields row,
// its own spec_source, its own spec_verified_at, its own override columns, and
// its own (asset, field) pair in the watch row's affected_fields. When X moves
// 280, ONE flag is raised for the page and an admin ticks each copy separately —
// specReview.commitReview runs one UPDATE per pair — and NOTHING IN THE PRODUCT
// COMPARES SIBLING ASSETS. A partial approval leaves the two holding different
// numbers for the same published limit, permanently, with only
// scripts/exportActiveSpecs.js able to show it and only if somebody runs it.
//
// WHY IT IS DONE ANYWAY. The page describes Polls as an ADDITION to a Promoted
// Ad, not a separate format, and copy_fields has no optional-field mechanism:
// the plan a brief produces is {asset, count, labels} with no field axis,
// cloneSpecGroup copies the whole field list, and appendBody renders every field
// unconditionally. So the only two expressions are this duplicate, or extra
// always-rendered fields on Twitter/X Ad — and the second taxes every ordinary X
// ad with poll fields that draft, consume a Gemini call each, and report the run
// as incomplete when the writer deletes them.
//
// The duplicate's failure is VISIBLE (two different numbers a writer can see);
// the always-rendered fields' failure is a completion signal that is wrong on
// every run until people stop reading it. That is this repo's own rule: when one
// failure is visible and the other is not, take the visible one.
//
// IF AN OPTIONAL-FIELD MECHANISM IS EVER BUILT, THIS ASSET AND CONVERSATION
// BUTTON ARE THE TWO TO BUILD IT FOR. They are the two X formats the page
// describes as additions rather than formats, and they are the two that pay this
// cost. Recording it here so the duplication reads as a workaround with a known
// replacement, rather than as a decision somebody later defends.
//
// ─── THE WRITE GATE: THIS RUN LEAVES 5 FIELDS OUTSIDE IT ──────────────────
// The watch row for this URL ALREADY EXISTS and this migration deliberately does
// not touch it: an anchor is chosen against a fetched page with a section
// argument behind it, and re-choosing one as a side effect of seeding an asset
// is how a row ends up watching something nobody meant.
//
// But spec_watch_list.affected_fields is a SNAPSHOT computed once and recomputed
// by nothing, and it is also the WRITE GATE — services/specReview.js guardEdits
// refuses any edit whose (asset, field) pair is not in that array. So after this
// runs, the page changes, the detector flags it correctly, and the approve form
// — populated FROM affected_fields — does not offer these five fields. Posting
// them anyway is refused. Twitter/X Ad updates and this asset does not.
//
// Nothing errors, and no health check reports it: checkSpecHealth's coverage
// check fires only for a cited URL with NO watch row, and this URL has one; its
// `numbers` check derives what to look for FROM affected_fields, so these values
// are not in it either; scripts/auditWatchList.js checks that pairs IN the array
// resolve, never that a pair that should be there is missing.
//
// A successful --commit therefore PRINTS THE FIX, with the row's real id looked
// up in the same transaction rather than a placeholder.
//
// AND THE RUN REFUSES IF THE WATCH ROW IS ABSENT. Seeding enforced fields that
// cite an unwatched page creates a coverage gap silently.
//
// ─── ROUTING: NOTHING TO ADD, AND IT IS MEASURED ──────────────────────────
// mediumKeywordsForAsset('Twitter/X Poll Ad') returns ['paid social'] TODAY,
// with no new branch: the name contains "twitter", which the platform regex
// matches, and the organic branch above it does not fire. Measured by calling
// the real function, not read off the source.
//
// THE NAME IS "Twitter/X Poll Ad" FOR THAT REASON. A bare "X Poll Ad" returns
// NULL — every craft.md medium section injected — because the regex matches
// 'twitter' and not a standalone 'x', and widening it to \\b(...|x)\\b is refused:
// measured against plausible future names it mis-routes "Poster — 24 x 36",
// "Trade Show Banner 8 x 10" and, worst, "Product X Launch Email", which would
// land on paid social because the email branch sits after the platform regex.
// That is the "Demand Gen Nurture Email" mis-route reproduced. One letter is the
// worst possible keyword for that function, and it is a preposition in every
// size string a print asset will ever carry.
//
// ASSET_PHRASE_HINTS: NOTHING ADDED. A generic phrase wired to one specialised
// sibling is the edit that sent every "a landing page" brief to Event Landing
// Page, and "poll" over a library that now has both this and Pinterest Quiz Ad
// is exactly that shape.
//
//   node scripts/migrateAddXPollAd.js --verify   # evidence + fetch + quotes
//   node scripts/migrateAddXPollAd.js            # dry run (ROLLBACK)
//   node scripts/migrateAddXPollAd.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[x-poll-ad]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');

// The date a human read the page. Hardcoded rather than NOW(), for the reason
// scripts/migrateBackfillSpecVerifiedAt.js states. IT IS NOT WRITTEN UNTIL
// QUOTES IS FILLED — requireHeaderEvidence refuses first — so this date and the
// reading it names cannot come apart.
const VERIFIED_ON = '2026-08-25';

const URL = 'https://business.x.com/en/help/campaign-setup/creative-ad-specifications';

// The sentinel every house_default field carries. Never a URL. Unused here —
// every field is cited — and named so the INSERT reads the same as the two
// migrations this copies rather than special-casing.
const HOUSE_SOURCE = 'quillio_default';
const SPEC_VERSION = '1.0';

// ─── THE PAGE TEXT, AS READ ────────────────────────────────────────────────
// Both from the IMAGE ADS WITH POLLS block, 2026-08-25, through the detector's
// own fetchText + normalize. Byte for byte — see the header.
//
// THE \u2019 IS WRITTEN AS AN ESCAPE ON PURPOSE. It is U+2019 (RIGHT SINGLE
// QUOTATION MARK) in "you’ve", the page's own character, and a straight ' pasted
// in its place would never match. Escaped rather than typed so it is
// unmistakable in a diff, in a terminal with a narrow font, and to anyone
// copying this constant somewhere else. A smoke test asserts the character is
// U+2019 and that no straight apostrophe appears in the quotes.
const QUOTES = [
  'post copy: Polls can include up to 280 characters of post copy that appear above the image.',
  'Poll options: 2-4 custom poll options Once you\u2019ve written your copy and added your image, '
    + 'you can add two to four custom poll responses to create your poll. Poll copy: 25 characters '
    + 'each Each poll option can include up to a maximum of 25 characters of text (which do not count '
    + 'against the 280 you can include in post copy).',
];

// THE NOTE. On the four option fields. Statement of consequence, naming the
// OTHER field's number rather than restating this field's own 25.
// BYTE-IDENTICAL to X_POLL_OPTION_NOTE in src/data/defaultAssets.js; a smoke
// test compares the two.
const POLL_OPTION_NOTE = 'Poll options do not count against the post\'s 280 characters.';

// [field_name, char_min, char_max, group_label|null, spec_type, spec_note|null, unit]
//
// char_min is 0 throughout: X publishes no floor for any of these, and a floor
// this project invented would collapse the spread of the copy without being
// anybody's rule — measured on the Subhead in scripts/floorAB.js, where stating
// a band cut the range by two thirds and cost the best line in the run.
//
// POST COPY CARRIES NO NOTE HERE, and that is a deliberate omission rather than
// an oversight. Twitter/X Ad / Ad Copy carries X_LINK_COST_NOTE — every link
// costs 23 of the 280 — which is equally true of this field. It is not added
// because this change was scoped to the poll options, and copying that string
// into a third file needs the byte-identity arrangement the other two have
// (constant, seed, and a test comparing them). Worth doing; not done here, and
// named so it is a known gap rather than a silent asymmetry.
const ASSETS = [
  {
    url: URL,
    name: 'Twitter/X Poll Ad',
    group: 'Paid Social',
    direction: 'Ask, do not tell. The post sets it up; each option has to be worth a tap.',
    // ORDERED. The first that exists in a tenant decides where this sits; if
    // none does, it appends. Twitter/X Ad is the natural neighbour and is
    // present in every seeded tenant.
    siblings: ['Twitter/X Ad', 'Meta Carousel Ad', 'Pinterest Pin'],
    fields: [
      ['Post Copy', 0, 280, null, 'enforced', null],
      ['Poll Option 1', 0, 25, null, 'enforced', POLL_OPTION_NOTE],
      ['Poll Option 2', 0, 25, null, 'enforced', POLL_OPTION_NOTE],
      ['Poll Option 3', 0, 25, null, 'enforced', POLL_OPTION_NOTE],
      ['Poll Option 4', 0, 25, null, 'enforced', POLL_OPTION_NOTE],
    ],
  },
];

// The unit a field's numbers are counted in. Seventh tuple element, 'text' when
// absent. No field here is word-counted; the helper is kept so the tuple shape
// matches the precedent and a future word field needs no change to the INSERT.
function fieldUnit(row) {
  return row[6] === 'words' ? 'words' : 'text';
}

// Every stored limit across the asset, as strings.
function storedLimits(asset) {
  return [...new Set(asset.fields.flatMap((f) => [f[1], f[2]]).filter((n) => n > 0).map(String))];
}

// The ONE transformation applied to a quote before matching, and it is the same
// one normalize() ends with. Not a general cleaner: no case folding, no
// punctuation folding, no entity decoding. Anything beyond whitespace collapse
// would make a quote match text the page does not contain.
function asNormalized(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// ─── THE REFUSAL ────────────────────────────────────────────────────────────
// Called before the network and before the database, by --verify and by the
// write path alike.
function requireHeaderEvidence() {
  if (!Array.isArray(QUOTES) || QUOTES.length === 0) {
    return {
      ok: false,
      why: 'QUOTES is empty — no reading of this page stands behind this file. The authoring session '
        + 'had no egress to business.x.com (the proxy answers 403 to CONNECT) and no operator supplied '
        + 'the text, so every number below is a claim with nothing behind it. Seeding five enforced '
        + `fields now would stamp spec_verified_at = ${VERIFIED_ON} on all of them — an assertion that a `
        + 'human read these values on the cited page.\n'
        + '       Run: node scripts/probeSpecPage.js ' + URL + ' --cited=280,25\n'
        + '       then paste the poll block\'s sentences into QUOTES byte for byte.',
    };
  }
  // EVERY STORED LIMIT MUST APPEAR IN SOME QUOTE, AS A WHOLE NUMBER. This is
  // what stops a filled QUOTES from being evidence for a different claim than
  // the one the fields make — quoting the page's poll sentence while seeding a
  // number that sentence does not contain.
  //
  // WHOLE NUMBERS, via scripts/lib/wholeNumber.js: a substring test would let
  // "25" be satisfied by a "250" or a "125" elsewhere in the quote, which is the
  // defect that made a Pinterest --verify report 100 sixteen times and 500 three
  // times against a page carrying neither.
  const { countWholeNumber } = require('./lib/wholeNumber');
  for (const asset of ASSETS) {
    for (const v of storedLimits(asset)) {
      const seen = QUOTES.some((q) => countWholeNumber(asNormalized(q), v) > 0);
      if (!seen) {
        return {
          ok: false,
          why: `the stored limit ${v} appears in no quoted sentence. Either the quotes are from the wrong `
            + 'block, or a field carries a number this file has no evidence for. Both are refusals: the '
            + 'header would be citing a page for a value it does not state.',
        };
      }
    }
  }
  return { ok: true };
}

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function count(hay, needle) {
  return hay.split(needle).length - 1;
}

// --- the page ---------------------------------------------------------------
// Returns { ok, why }. Called by --verify AND by the write path, so no value is
// written without the page being read in the same run.
async function readPage() {
  const evidence = requireHeaderEvidence();
  if (!evidence.ok) return evidence;

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

  let missing = 0;
  for (const raw of QUOTES) {
    const q = asNormalized(raw);
    const n = count(a, q);
    if (n === 0) missing += 1;
    console.log(`   ${n > 0 ? 'PRESENT' : 'ABSENT '} ${n}x  ${JSON.stringify(q.slice(0, 58))}${q.length > 58 ? '…' : ''}`);
    if (n > 0) {
      const at = a.indexOf(q);
      console.log(`            at char ${at} of ${a.length} (${Math.round((at / a.length) * 1000) / 10}%)`);
    }
  }
  if (missing > 0) {
    return {
      ok: false,
      why: `${missing} quoted sentence(s) are not on the page. BEFORE CONCLUDING X CHANGED IT, check the `
        + 'transcription — that is what it was both times this check has fired in this repo. TWO WAYS to '
        + 'get it wrong, needing different fixes. (1) CHARACTER level: normalize() strips tags and DECODES '
        + 'NOTHING, so an &nbsp; or an &amp; reaches the hashed text as literal characters, and an em dash '
        + '(U+2014) flattened to a hyphen fails identically. (2) SENTENCE level: a quote assembled from '
        + 'more than one screenful can merge two of the page\'s sentences into a plausible hybrid that '
        + 'reads correctly and matches nothing — that is exactly how the X media-headline quote was wrong. '
        + 'A quote differing in punctuation, entities or sentence boundaries is ours to fix; one differing '
        + 'in a NUMBER is X\'s, and that is a real finding.',
    };
  }

  console.log('\n   stored limits, as a floor rather than a census:');
  const { countWholeNumber } = require('./lib/wholeNumber');
  for (const v of storedLimits(ASSETS[0])) {
    console.log(`   value ${String(v).padStart(4)}: ${countWholeNumber(a, v)}x in the hashed text`);
  }

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
        assetTypeId, name, min, max, fieldUnit(row), i + 1,
        enforced ? asset.url : HOUSE_SOURCE,
        SPEC_VERSION,
        groupLabel,
        note,
        tier,
        // ONLY THE CITED FIELDS CARRY A DATE. A house default has no page to
        // have been read against, so a verification date on one would assert an
        // event that cannot have happened.
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

  // THE EVIDENCE CHECK RUNS BEFORE DATABASE_URL IS EVEN READ. A file with no
  // quotes has nothing to say to a database, and refusing here means the message
  // is about the evidence rather than about a missing connection string.
  const evidence = requireHeaderEvidence();
  if (!evidence.ok) {
    console.error(`\n${TAG} REFUSING TO WRITE: ${evidence.why}`);
    process.exit(1);
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
  // never happened.
  let inTxn = false;
  try {
    await client.query('BEGIN');
    inTxn = true;

    // THE WATCH ROW MUST EXIST. Fail closed: seeding enforced fields that cite
    // an unwatched page creates a coverage gap silently.
    const watch = await client.query(
      'SELECT id, display_name, expected_content, current_hash IS NOT NULL AS baselined '
      + 'FROM spec_watch_list WHERE source_url = $1',
      [URL]
    );
    if (watch.rowCount === 0) {
      throw new Error(
        `no watch row for ${URL}. These 5 fields cite it, so seeding them now would create a coverage `
        + 'gap with nothing watching the page. Nothing written.'
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
        console.log(`    ${String(r.field_name).padEnd(16)} ${band.padEnd(8)}`
          + ` ${String(r.spec_type).padEnd(9)} verified ${r.verified || '—'}  x${r.tenants}`
          + `${r.spec_note ? `\n        note: ${JSON.stringify(r.spec_note)}` : ''}`);
      }
    }

    const pairs = [...new Map(seededPairs.map((p) => [`${p.asset}||${p.field}`, p])).values()]
      .sort((x, y) => x.asset.localeCompare(y.asset) || x.field.localeCompare(y.field));

    // --- the gate ------------------------------------------------------------
    console.log(`\n${'═'.repeat(74)}`);
    console.log(`${TAG} THE WRITE GATE IS NOW STALE — ${pairs.length} pair(s) seeded, none of them in it.`);
    console.log(`${'═'.repeat(74)}`);
    for (const p of pairs) console.log(`    ${p.asset} / ${p.field}`);
    console.log(`\n${TAG} spec_watch_list #${watchRow.id}.affected_fields still holds only what`);
    console.log(`${TAG} earlier migrations derived. A flag on this page will not offer the pairs`);
    console.log(`${TAG} above, and guardEdits will refuse them if posted. Nothing errors and no`);
    console.log(`${TAG} health check reports it — the URL is watched, so it looks covered.`);
    console.log(`${TAG} Twitter/X Ad / Ad Copy would update on a 280 move and this asset's`);
    console.log(`${TAG} Post Copy would not, which is the duplication cost arriving in practice.`);

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
      console.log(`${TAG} No detection run is needed: no watch row was added, current_hash untouched.`);
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

// Required by smoke tests. Guarded above so requiring this file runs nothing.
const SOURCE_URLS = Object.fromEntries(ASSETS.map((a) => [a.name, a.url]));
const ENFORCE = ASSETS.flatMap((a) =>
  a.fields.filter((f) => f[4] === 'enforced').map((f) => [a.name, f[0]]));

module.exports = {
  ASSETS, SOURCE_URLS, ENFORCE, VERIFIED_ON, URL, QUOTES,
  POLL_OPTION_NOTE, asNormalized, fieldUnit, storedLimits, requireHeaderEvidence,
};
