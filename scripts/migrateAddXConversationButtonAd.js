'use strict';

// August 2026 — seed Twitter/X Conversation Button Ad into already-seeded tenants.
//
// Structural precedent: scripts/migrateAddXPollAd.js, which itself follows
// scripts/migrateAddPinterestAdFormats.js. Same shape — --verify / dry-run-by-
// default / --commit, inTxn, one transaction, per-tenant existence check through
// quillio_normalize_name, sort_order anchored on a SIBLING ROW rather than a
// literal, no watch row created or touched, and the rederive command printed on
// a successful commit with the row's real id looked up in the same transaction.
//
// ─── IT SHIPPED REFUSING, AND HAS SINCE BEEN FILLED ───────────────────────
// QUOTES was empty when this file was written and requireHeaderEvidence() turned
// that absence into a refusal before the network and before DATABASE_URL was
// read. The authoring session had no egress to business.x.com — the proxy
// answers 403 to CONNECT, measured, not assumed — so no reading of this page
// stood behind it, and the five limits came from the operator's instruction
// rather than from the page.
//
// That was deliberate rather than unfinished, and it is the precedent
// scripts/migrateAddXPollAd.js set. This repo's most expensive lesson is that a
// reasoned number and a read number are indistinguishable once written down:
// scripts/migrateSpecIntegrityFixes.js produced every wrong Meta value in the
// library that way, carefully.
//
// IT IS FILLED NOW, from a dump the operator took on 2026-08-26. The refusal
// moved from "no evidence" to "no network": requireHeaderEvidence passes, and
// --verify from a session without egress fails at the fetch instead — a
// different and smaller gap, and one only a console with egress can close.
//
// ─── THE PAGE ───────────────────────────────────────────────────────────────
// https://business.x.com/en/help/campaign-setup/creative-ad-specifications
//
// ALREADY WATCHED, anchored on the Promoted Ads sentence chosen by
// scripts/migrateFixXAnchor.js:
//   "of your posts beyond your followers to your desired target audience"
// This migration does NOT touch that row — see "THE WRITE GATE". An anchor is
// chosen against a fetched page with a declared section behind it, and
// re-choosing one as a side effect of seeding an asset is how a row ends up
// watching something nobody meant.
//
// NO NEW PAGE COST: the fields cite a URL that is already fetched and hashed
// once a week. What this run DOES cost is five pairs outside the write gate,
// which is the whole of the rederive half below.
//
// ─── THE SAME BLOCK APPEARS THREE TIMES, AND ONLY ONE OF THEM WAS READ ────
// The conversation-button spec appears under Image Ads, under Video Ads, and as
// a STANDALONE "Conversation Buttons" section. THE THREE DIFFER IN WORDING, and
// the differences are exactly the kind a transcription flattens without noticing:
// the other two use a lowercase "post copy:", add "(same as above)" after 280,
// and say "posted out the post".
//
// EVERY QUOTE BELOW IS FROM THE STANDALONE SECTION. That is the operator's
// instruction and it is also the only defensible choice — the standalone section
// is the one that describes the format on its own terms rather than as an
// addition to another format's block.
//
// THE CAPITAL "P" IS THE DISCRIMINATOR, and it is what makes two of the six
// quotes checkable rather than merely plausible. QUOTES[1] and QUOTES[2] both
// carry "Post copy:" with a capital P, which the other two blocks do not use, so
// each should report 1x. See "READING THE COUNTS" below for what a 2x or 3x on
// those two would mean, because it is a finding rather than noise.
//
// ─── THE 23 PROBLEM, AND WHY THIS FILE CHECKS EVIDENCE PER FIELD ──────────
// READ THIS BEFORE FILLING QUOTES. It is the one place this migration is
// deliberately STRICTER than the Poll Ad it copies, and the reason is specific.
//
// THREE of the five fields are stated at 23 — Headline, Thank-you text,
// Thank-you URL — and a FOURTH, unrelated 23 is published on the same page and
// already stored in this library:
//
//     X_LINK_COST_NOTE (src/data/defaultAssets.js)
//       "Every link costs 23 characters regardless of its length, so a post
//        with one link has 257 characters of copy."
//
// The Poll Ad's evidence check asks whether each stored limit appears in SOME
// quote as a whole number. On this asset that check is nearly free to pass and
// nearly worthless: quote the link-cost sentence by accident and all three 23s
// report satisfied, by a sentence about t.co link lengths. The number would be
// right, the citation would be for a different claim, and nothing downstream
// would ever say so.
//
// So EVIDENCE maps each cited field to the INDEX of the quote that states ITS
// limit, and requireHeaderEvidence asserts the number in THAT quote. Every cited
// field must appear in the map; an unmapped field is a refusal. This is a strict
// superset of the Poll Ad's check, not a replacement for it — the storedLimits
// sweep still runs, because a limit in no quote at all is a different failure
// from a limit in the wrong quote.
//
// WHAT IT CATCHES AND WHAT IT DOES NOT — measured against the real function with
// synthetic quotes, because the distinction decides how far this check can be
// trusted and the last row is the one that matters:
//
//   CAUGHT   a cited field named in no quote                   -> refuse
//   CAUGHT   a field mapped to a quote lacking its number      -> refuse
//   CAUGHT   a limit appearing in no quote at all              -> refuse
//   NOT      a field mapped to the LINK-COST sentence, which
//            really does contain a 23                          -> ALLOWS
//
// So this does NOT close the 23 problem. No string comparison can: two different
// sentences that both legitimately say 23 are indistinguishable by their digits.
// What the map buys is that citing the wrong sentence becomes something somebody
// TYPED, per field, rather than something that happened by default — and that a
// reader can see which sentence each field rests on without re-deriving it.
//
// THE REMAINING GUARD IS A HUMAN ONE, and --verify is built to support it: the
// per-quote output names which fields each quote is evidence for, and the totals
// line says outright that 23 is expected MORE than three times on this page for
// a reason that is not these fields.
//
// ─── CLOSED: 21 INCLUDES THE "#", AND THE PAGE SAYS SO ───────────────────
// This was written as an OPEN QUESTION when the file shipped refusing — whether
// the hashtag's 21 counts the leading "#" is a fact about how X measures, and a
// writer who assumes wrong is one character over on a hard cap. It was
// deliberately not guessed in either direction: reducing it to 20 "to be safe"
// would have invented a limit X does not publish, which is the Meta defect
// exactly.
//
// The dump answers it outright, in the sentence that states the limit:
//
//     "Hashtag: 21 characters, including the hashtag character"
//
// So the clause resolving it is INSIDE QUOTES[0], the same span that is
// evidence for the number. The note and the limit rest on one sentence and
// cannot come apart — which is the arrangement the char_max/citation pairing
// exists for, arriving here for free.
//
// HASHTAG_NOTE states the consequence rather than the fact. "Including the
// hashtag character" is the page's phrasing and it is a statement about
// counting; what a writer needs is how much room is left. The measured
// preference for consequence over instruction is in "THE NOTES" below.
//
// ─── THANK-YOU URL IS A DESTINATION, NOT COPY, AND IT WILL BE DRAFTED ─────
// There is no mechanism to exclude a field from drafting. copy_fields has no
// is_copy flag (template_markers does; this is not that), generateAssetDrafts
// drafts every field it is handed, and appendBody renders every field
// unconditionally. So a field named "Thank-you URL" gets a Gemini draft like any
// other, and the most available thing for a model to produce in a 23-character
// slot labelled URL is a plausible URL that does not exist.
//
// THAT IS THE SAME CLASS AS THE INVENTED EVENT TIME, and this repo has measured
// what helps: scripts/eventTimeAB.js found that a note STATING THE ABSENCE took
// the transcription field from 5/5 fabricated to 5/5 honest placeholders, while
// no wording moved the generative fields at all. A field that is waiting for a
// value the campaign has to supply is exactly that shape, so THANKYOU_URL_NOTE
// says what the field is rather than instructing the model not to invent.
//
// Expect a placeholder rather than a real URL, and expect the writer to paste
// the real one. That is the correct outcome for this field and it is written
// down so a bracketed placeholder in a document does not read as a defect.
//
// ─── NO DUPLICATED FIELD — THIS ASSET DOES NOT PAY THE POLL AD'S COST ─────
// scripts/migrateAddXPollAd.js names Conversation Button as the OTHER X format
// that would justify an optional-field mechanism, and records that its own Post
// Copy [280] is a second copy of a number Twitter/X Ad / Ad Copy already stores.
//
// This asset carries no such duplicate. All five fields are its own — a hashtag,
// a pre-populated post, a button headline and the two thank-you fields — and
// none of them restates a limit another asset holds. So the "one flag, two pairs
// to tick, no sibling comparison" cost does not arise here.
//
// IT DOES STILL BELONG IN THAT MECHANISM'S SCOPE if one is built: X describes
// the conversation button as an addition to a Promoted Ad, so under an optional-
// field model these five would be optional fields ON Twitter/X Ad rather than a
// separate type. The reason to build it separately today is unchanged — extra
// always-rendered fields tax every ordinary X ad, draft, consume a Gemini call
// each and report the run as incomplete when the writer deletes them.
//
// ─── ROUTING: NOTHING TO ADD, AND IT IS MEASURED ──────────────────────────
// mediumKeywordsForAsset('Twitter/X Conversation Button Ad') returns
// ['paid social'] TODAY, with no new branch. Measured by CALLING the real
// function, not read off the source:
//
//     "Twitter/X Conversation Button Ad" -> ["paid social"]
//     "Twitter/X Poll Ad"                -> ["paid social"]
//     "Twitter/X Ad"                     -> ["paid social"]
//
// The name contains "twitter", which the platform regex matches on a word
// boundary (the "/" is a non-word character, so \btwitter\b holds), and the
// organic branch that sits ABOVE it does not fire. That ordering is load-
// bearing: the same regex used to shadow craft.md's Organic Social section for
// the whole seeded library until the organic test was moved above it.
//
// THE NAME IS "Twitter/X Conversation Button Ad" FOR THAT REASON. A bare
// "X Conversation Button Ad" returns NULL — every craft.md medium section
// injected — and widening the regex to \b(...|x)\b is refused for the reasons
// migrateAddXPollAd records: it mis-routes "Poster — 24 x 36" and, worst,
// "Product X Launch Email".
//
// Checked for collisions the other way too: "conversation" does not contain
// "confirm", so the Confirmation / Post-Conversion branch cannot claim it — the
// perFORMance collision that gave Google Performance Max the wrong section for
// its entire life is what that check exists for.
//
// ASSET_PHRASE_HINTS: NOTHING ADDED. "conversation button" over a library that
// now has three X paid formats is the generic-phrase-to-one-specialised-sibling
// edit that sent every "a landing page" brief to Event Landing Page.
//
// ─── WHAT IS NOT IN THIS CHANGE ───────────────────────────────────────────
// This file seeds EXISTING tenants only. Three things live elsewhere and are
// NOT here, named so their absence is deliberate rather than forgotten:
//
//   1. src/data/defaultAssets.js — a NEW tenant seeded from the bundled library
//      does not get this asset until the entry is added there, byte-identical to
//      ASSETS below (a smoke test compares them for the other two migrations of
//      this family and would for this one).
//   2. src/config.js ALLOWED_ASSETS — the fallback vocabulary for a no-DB, demo
//      or unseeded tenant. A seeded tenant reaches this asset through its own
//      library, so briefing works without it; a demo tenant cannot name it.
//   3. test/smoke.test.js — the medium routing table is a DELIBERATE per-asset
//      snapshot, so adding this asset to the seed fails it until somebody writes
//      the entry by hand. That friction is the feature: a coverage check cannot
//      catch a mis-route, because a mis-route IS coverage.
//
//   node scripts/migrateAddXConversationButtonAd.js --verify   # evidence + fetch + quotes
//   node scripts/migrateAddXConversationButtonAd.js            # dry run (ROLLBACK)
//   node scripts/migrateAddXConversationButtonAd.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[x-conversation-button-ad]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');

// The date a human read the page. Hardcoded rather than NOW(), for the reason
// scripts/migrateBackfillSpecVerifiedAt.js states. IT IS NOT WRITTEN UNTIL
// QUOTES IS FILLED — requireHeaderEvidence refuses first — so this date and the
// reading it names cannot come apart.
//
// The operator read the standalone Conversation Buttons section on this date and
// supplied the transcription below. Every enforced field carries it.
const VERIFIED_ON = '2026-08-26';

const URL = 'https://business.x.com/en/help/campaign-setup/creative-ad-specifications';

// The sentinel every house_default field carries. Never a URL. Unused today —
// every field is cited — and named so the INSERT reads the same as the two
// migrations this copies rather than special-casing.
const HOUSE_SOURCE = 'quillio_default';
const SPEC_VERSION = '1.0';

// ─── THE PAGE TEXT, AS READ ────────────────────────────────────────────────
// Transcribed 2026-08-26 from the STANDALONE "Conversation Buttons" section, in
// the order the section lists them. NOT from the Image Ads or Video Ads copies of
// the same block — see "THE SAME BLOCK APPEARS THREE TIMES" in the header.
//
// The section reads, as one whitespace-collapsed run:
//
//   Conversation Card (original post in timeline) Post copy: 280 characters
//   Hashtag: 21 characters, including the hashtag character Pre-populated user
//   post (once user clicks on the CTA) Post copy: 256 characters Headline: 23
//   characters Thank You post (after user has published their post) Thank you
//   text: 23 characters Thank you URL (optional): 23 characters Conversation
//   Buttons must be paired with media (image or video).
//
// Each entry below is a contiguous SPAN of that run — not a paraphrase and not a
// reassembly. normalize() collapses whitespace and decodes nothing, so a span is
// matched with one whitespace collapse (asNormalized) and nothing else.
//
// THE SPANS ARE SIZED BY WHAT THEY HAVE TO DISAMBIGUATE, not by sentence:
// QUOTES[2] reaches BACKWARDS to include "Post copy: 256 characters" because a
// bare "Headline: 23 characters" is one of four 23s on this page and would be
// evidence for nothing in particular. That widening is the operator's
// instruction and it is the whole reason EVIDENCE exists.
//
// ASCII throughout — this section carries no curly quote, no entity and no dash.
// Checked rather than assumed: a smoke test would assert it, and until that half
// lands, `node -e` over QUOTES answers it in one line.
const QUOTES = [
  // [0] Hashtag's limit AND the clause that closes the "does 21 include the #"
  //     question. One sentence, so the note and the number cannot come apart.
  'Hashtag: 21 characters, including the hashtag character',
  // [1] The 256, with the "Pre-populated user post" lead-in that says WHOSE post
  //     it is. Capital "P" in "Post copy:" — the standalone section's own
  //     wording, which the Image and Video blocks do not use.
  'Pre-populated user post (once user clicks on the CTA) Post copy: 256 characters',
  // [2] Headline's 23, widened backwards over the 256 so the span is anchored to
  //     a number that occurs once rather than floating among four 23s.
  'Post copy: 256 characters Headline: 23 characters',
  // [3] Thank-you text's 23.
  'Thank you text: 23 characters',
  // [4] Thank-you URL's 23, including "(optional)" — which is the page telling a
  //     writer this one may legitimately be left blank.
  'Thank you URL (optional): 23 characters',
  // [5] Evidence for the media-pairing sentence in asset_direction. Carries no
  //     number, so it satisfies no limit and is checked only for PRESENCE.
  'Conversation Buttons must be paired with media (image or video).',
];

// WHICH QUOTE STATES WHICH FIELD'S LIMIT. Field name -> index into QUOTES.
//
// See "THE 23 PROBLEM" above for why this exists and why the Poll Ad did not
// need it. Every cited field must be a key here; requireHeaderEvidence refuses
// an unmapped one rather than falling back to the any-quote sweep, because
// falling back is precisely how a link-cost sentence would come to stand as
// evidence for a button headline.
//
// QUOTES[5] is deliberately unmapped: it is evidence for a sentence in
// asset_direction, not for a limit, and mapping a field to it would assert that
// a numberless sentence states that field's number.
const EVIDENCE = {
  Hashtag: 0,
  'Pre-populated user post': 1,
  Headline: 2,
  'Thank-you text': 3,
  'Thank-you URL': 4,
};

// ─── THE NOTES ─────────────────────────────────────────────────────────────
// Statements of consequence, not imperatives. Measured on Pinterest Pin / Title,
// three arms of ten (scripts/notesAB.js): the statement form scored 3/10 within
// its stated 40 with a spread of 64, the imperative rewrite scored 0/10 — level
// with no note at all — and collapsed the spread to 13. The three shortest
// titles in the whole run came from the statement arm.
//
// EACH MUST BE BYTE-IDENTICAL to its twin in src/data/defaultAssets.js when that
// half lands, with a smoke test comparing them. Until then they exist only here.

// HASHTAG — the consequence, not the fact. QUOTES[0] says "including the hashtag
// character", which is a statement about how X counts; what a writer needs is
// how much room that leaves them. Phrased as a consequence for the reason under
// "THE NOTES" above.
const HASHTAG_NOTE = 'The 21 counts the "#" itself, so the tag has 20 characters after it.';

// Names what the field IS, so the model has something true to put in it. The
// eventTimeAB precedent: stating an absence took a transcription field from 5/5
// fabricated to 5/5 honest placeholders, where no prohibition moved it at all.
const THANKYOU_URL_NOTE =
  'This is the destination the thank-you text links to, not copy \u2014 it waits for the campaign\'s own URL.';

// The pre-populated post is what the READER sends from their own account, which
// is the one thing about this format a writer meets nowhere else in the library.
const PREPOPULATED_NOTE =
  'This posts from the reader\'s own account, so it has to sound like them rather than like the brand.';

// [field_name, char_min, char_max, group_label|null, spec_type, spec_note|null, unit]
//
// char_min is 0 throughout: X publishes no floor for any of these, and a floor
// this project invented would collapse the spread of the copy without being
// anybody's rule — measured on the Subhead in scripts/floorAB.js, where stating
// a band cut the range by two thirds and cost the best line in the run.
//
// ORDER is the order the operator supplied, which is also the order the page
// lists them. It decides sort_order and therefore the order a writer meets the
// fields in the document.
const ASSETS = [
  {
    url: URL,
    name: 'Twitter/X Conversation Button Ad',
    group: 'Paid Social',
    // TWO SENTENCES DOING TWO JOBS, joined because asset_direction is the only
    // asset-level channel that reaches anybody (see "WHERE AN ASSET-LEVEL FACT
    // CAN GO"). The first is creative direction; the second is a production
    // constraint from QUOTES[5], kept as its own sentence rather than woven in,
    // so a writer meets it as a fact rather than as a suggestion.
    direction:
      'The button is the ask. Give the reader a line worth posting from their own account, '
      + 'and a thank-you that lands the moment they do. '
      + 'This format cannot ship without an image or a video.',
    // ORDERED. The first that exists in a tenant decides where this sits; if
    // none does, it appends. Poll Ad first so the two X additions sit together,
    // then the base X ad, which is present in every seeded tenant.
    siblings: ['Twitter/X Poll Ad', 'Twitter/X Ad', 'Meta Carousel Ad'],
    fields: [
      ['Hashtag', 0, 21, null, 'enforced', HASHTAG_NOTE],
      ['Pre-populated user post', 0, 256, null, 'enforced', PREPOPULATED_NOTE],
      ['Headline', 0, 23, null, 'enforced', null],
      ['Thank-you text', 0, 23, null, 'enforced', null],
      ['Thank-you URL', 0, 23, null, 'enforced', THANKYOU_URL_NOTE],
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

// Every cited (enforced) field, with the limit it claims.
function citedFields(asset) {
  return asset.fields.filter((f) => f[4] === 'enforced').map((f) => ({ field: f[0], max: String(f[2]) }));
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
        + 'the text, so all five limits below are claims with nothing behind them. Seeding five enforced '
        + 'fields now would stamp a spec_verified_at on every one of them — an assertion that a human '
        + 'read these values on the cited page.\n'
        + '       Run: node scripts/probeSpecPage.js ' + URL + ' --cited=21,256,23\n'
        + '       then paste the conversation-button block\'s sentences into QUOTES byte for byte,\n'
        + '       fill EVIDENCE with which quote states which field, and set VERIFIED_ON to the day\n'
        + '       you read it.',
    };
  }

  if (!VERIFIED_ON) {
    return {
      ok: false,
      why: 'VERIFIED_ON is null. QUOTES is filled but nobody recorded WHEN the page was read, and '
        + 'spec_verified_at is the column the document renders as "Verified against X\'s spec page on '
        + 'DATE." A date is not derivable from the quotes.',
    };
  }

  // 1. EVERY STORED LIMIT MUST APPEAR IN SOME QUOTE, AS A WHOLE NUMBER.
  //
  // WHOLE NUMBERS, via scripts/lib/wholeNumber.js: a substring test would let
  // "23" be satisfied by a "230" or a "123" elsewhere in the quote, and "21" by
  // the "21" inside a "210". That is the defect that made a Pinterest --verify
  // report 100 sixteen times and 500 three times against a page carrying
  // neither.
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

  // 2. AND EACH CITED FIELD'S LIMIT MUST APPEAR IN THE QUOTE THAT FIELD NAMES.
  //
  // The check above is a floor, and on this asset it is a low one: three fields
  // share 23 and the page publishes a fourth, unrelated 23 (a link's t.co cost).
  // Without this, quoting the link-cost sentence by accident satisfies all three.
  for (const asset of ASSETS) {
    for (const { field, max } of citedFields(asset)) {
      if (!Object.prototype.hasOwnProperty.call(EVIDENCE, field)) {
        return {
          ok: false,
          why: `${field} is cited to ${URL} but names no quote in EVIDENCE. Every cited field says which `
            + 'sentence states its limit — see "THE 23 PROBLEM" in the header. An unmapped field is a '
            + 'refusal rather than a fall back to the any-quote sweep, because falling back is how a '
            + 'sentence about link lengths comes to stand as evidence for a button headline.',
        };
      }
      const idx = EVIDENCE[field];
      if (!Number.isInteger(idx) || idx < 0 || idx >= QUOTES.length) {
        return {
          ok: false,
          why: `EVIDENCE[${JSON.stringify(field)}] is ${JSON.stringify(idx)}, which is not an index into `
            + `QUOTES (0..${QUOTES.length - 1}).`,
        };
      }
      if (countWholeNumber(asNormalized(QUOTES[idx]), max) === 0) {
        return {
          ok: false,
          why: `${field} stores ${max}, but the quote it names — QUOTES[${idx}] — does not contain that `
            + 'number. Either the field is mapped to the wrong sentence, or the sentence does not say '
            + 'what this field claims it says.',
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
  for (let i = 0; i < QUOTES.length; i++) {
    const q = asNormalized(QUOTES[i]);
    const n = count(a, q);
    if (n === 0) missing += 1;
    const fields = Object.entries(EVIDENCE).filter(([, v]) => v === i).map(([k]) => k);
    console.log(`   [${i}] ${n > 0 ? 'PRESENT' : 'ABSENT '} ${n}x  ${JSON.stringify(q.slice(0, 52))}${q.length > 52 ? '…' : ''}`);
    if (fields.length) console.log(`            evidence for: ${fields.join(', ')}`);
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
        + 'reads correctly and matches nothing — that is exactly how the X media-headline quote was wrong, '
        + 'on this same page. A quote differing in punctuation, entities or sentence boundaries is ours to '
        + 'fix; one differing in a NUMBER is X\'s, and that is a real finding.',
    };
  }

  // COUNTS ARE PRINTED, NOT ASSERTED. A count above 1 means the sentence is not
  // specific to this format's block — worth knowing, and a judgement rather than
  // a rule, because X repeats whole spec blocks per format with one word changed.
  console.log('\n   stored limits, as a floor rather than a census:');
  const { countWholeNumber } = require('./lib/wholeNumber');
  for (const v of storedLimits(ASSETS[0])) {
    console.log(`   value ${String(v).padStart(4)}: ${countWholeNumber(a, v)}x in the hashed text`);
  }
  console.log('   (23 is expected MORE than three times: the page also publishes a link\'s');
  console.log('    23-character t.co cost, three times, which is X_LINK_COST_NOTE and none of');
  console.log('    these fields. A high 23 count is expected; a LOW one would be the finding.)');
  console.log('\n   READING THE COUNTS. QUOTES[1] and QUOTES[2] carry a capital-P "Post copy:",');
  console.log('   which the Image Ads and Video Ads copies of this block do not use, so each');
  console.log('   should report 1x. EITHER READING ABOVE 1x MEANS THE DISCRIMINATOR HAS FAILED');
  console.log('   — the three blocks have converged, or this transcription mixed them — and the');
  console.log('   standalone-only claim in the header is no longer true. QUOTES[0], [3] and [4]');
  console.log('   may legitimately read up to 3x; they are not the discriminating spans.');

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
    // an unwatched page creates a coverage gap silently. Looked up BY URL rather
    // than by a hardcoded id — an id is production state, and a literal one here
    // would be a number this file cannot check.
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
        console.log(`    ${String(r.field_name).padEnd(24)} ${band.padEnd(8)}`
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
  ASSETS, SOURCE_URLS, ENFORCE, VERIFIED_ON, URL, QUOTES, EVIDENCE,
  HASHTAG_NOTE, THANKYOU_URL_NOTE, PREPOPULATED_NOTE,
  asNormalized, fieldUnit, storedLimits, citedFields, requireHeaderEvidence,
};
