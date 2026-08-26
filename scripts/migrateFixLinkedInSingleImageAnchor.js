'use strict';

// August 2026 — replace the anchor on the LinkedIn – single image watch row
// with one scoped to the section its fields actually come from.
//
// Shape copied from scripts/migrateFixGoogleDisplayAnchor.js: same ranking, same
// refusal discipline, same unnest-of-two-arrays limit resolution, same inTxn
// flag, and the same DIGIT-FREE precondition rather than X's looser "holds no
// stored limit" rule. Read that file first; the reasoning it records is not
// repeated here except where this row differs — and it differs in one way that
// changes how the output should be read.
//
// ─── THE PROBLEM — AND THE ORIGINAL STATEMENT OF IT WAS WRONG ───────────────
//
// THIS FILE FIRST SHIPPED CLAIMING the row's "Introductory text" anchor was the
// X / Meta defect again: 2x in the normalized text, so one occurrence in the
// watched table and one somewhere else, and dropping the table would leave the
// other match and a healthy-looking row.
//
// THE --discover RUN FALSIFIED THAT, and the correction is left in place rather
// than quietly rewritten, because it is the more useful thing for the next
// reader to see.
//
// WHAT IS ACTUALLY HAPPENING: this page emits every content block TWICE in the
// normalized text — once as ESCAPED HTML SOURCE (`&lt;b>`, `&amp;nbsp;`) and
// once as RENDERED PLAIN TEXT. normalize() strips real tags, but escaped source
// is literal characters and survives, so the whole table appears twice over.
//
//   "Introductory text" at 8338  — the escaped-source copy
//   "Introductory text" at 8642  — the rendered copy
//
// BOTH ARE INSIDE THE TEXT-RECOMMENDATIONS TABLE. The 2x is a RENDERING
// ARTIFACT of this CMS, not evidence the anchor was matching the wrong section.
// Drop the table and both occurrences go with it, so the old anchor DOES assert
// that the watched section rendered. It is not the Meta failure mode and never
// was.
//
// ─── SO WHY CHANGE IT AT ALL? A SMALLER, REAL REASON ────────────────────────
// Stated plainly because the original justification is gone and a reader is
// entitled to ask what is left of it.
//
// "Introductory text" IS A FIELD LABEL, and specifically the label of one of the
// three fields this row watches. That couples the anchor to the thing being
// watched, which is the same defect the digit-free rule exists to prevent —
// arriving as a LABEL instead of a NUMBER:
//
//   • LinkedIn renames the row "Introductory text" → "Intro text", limits
//     unchanged: old anchor reports `failed`, a broken-page alarm for a
//     cosmetic edit.
//   • LinkedIn restructures the table and drops or merges that row — which IS a
//     spec change we want in the review queue as `changed`: the old anchor
//     reports `failed` instead, so a real spec event arrives dressed as a broken
//     page. That is precisely the cost the header's option-2 argument describes
//     for a numeric anchor.
//
// "Text Recommendations" is the table's HEADING. It is not one of the watched
// things, so neither of those turns a spec move into a broken-page report.
//
// THE HONEST SIZE OF THIS CHANGE: it is a decoupling, not a defect fix. If you
// are deciding whether it is worth running, that is the whole of the case for
// it. The row is not currently blind, and nothing here is urgent.
//
// scripts/migrateAddSpecAnchors.js seeded the old anchor and defended a repeated
// spec label on the grounds that "what disqualifies a phrase is being site
// chrome that survives an error page". On this page that defence happens to hold
// — unlike on X, where the same argument was wrong.
//
// ─── WHY THIS PAGE IS HARDER THAN THE GOOGLE ONE, AND IT IS ONE REASON ──────
// THE PAGE IS BIG. ~24,500 normalized characters against the Google display
// page's ~5,059 — nearly five times the text. That inverts the difficulty:
//
//   Google display  small page, few distinct phrases, so a digit-free unique
//                   candidate was SCARCE and the risk was finding none at all.
//   This page       large page, many distinct phrases, so digit-free unique
//                   candidates will be PLENTIFUL — and most of them will be
//                   unique BY ACCIDENT rather than because they belong to the
//                   section holding these fields.
//
// SO THE IN-SECTION TEST IS DOING MOST OF THE WORK HERE, and uniqueness is
// doing almost none. On a page this size, "occurs exactly once" is close to
// free: a sentence from LinkedIn's video-ad block, its billing FAQ or its
// accessibility notes is just as unique as one from the text-recommendations
// table, and just as useless — it proves a page rendered.
//
// The practical consequences, and both are implemented rather than left as
// advice:
//
//   • --discover prints the COUNT of candidates and warns when it is large,
//     because a long list invites picking the nicest-sounding string rather
//     than the one that sits in the right table.
//   • --discover takes --window=START-END so the dump and the candidate list
//     can be narrowed to the region around the table once you have found it.
//     Reading 24,500 characters to choose one phrase is how the wrong phrase
//     gets chosen.
//   • Every candidate reports its character OFFSET and its PERCENTAGE into the
//     document, at discover time and at verify time, so section placement is
//     auditable from the output rather than taken on trust.
//
// ─── THE PAGE TEXT, AND WHERE IT CAME FROM ──────────────────────────────────
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ READ THIS BEFORE TRUSTING THE QUOTES BELOW.                              │
// │                                                                          │
// │ The session that AUTHORED this file could not reach business.linkedin    │
// │ .com — the egress proxy answers 403 to CONNECT. It therefore shipped     │
// │ with QUOTES and SECTION empty, refusing to write, rather than with       │
// │ inherited or invented text. That refusal is what produced the reading    │
// │ below.                                                                   │
// │                                                                          │
// │ The text now in QUOTES was SUPPLIED BY THE OPERATOR from their own       │
// │ `--discover` run against the live page, and is NOT a fetch performed by  │
// │ the author of this file. Same provenance, and the same weakness, as      │
// │ scripts/migrateFixXAnchor.js and migrateFixGoogleDisplayAnchor.js.       │
// │                                                                          │
// │ WHAT CLOSES THE GAP: readPage() FETCHES THE PAGE AND ASSERTS EVERY QUOTE │
// │ BEFORE ANYTHING IS WRITTEN, and the write path calls the same function.  │
// │ The quote is a claim this file CHECKS, never a claim it MAKES.           │
// │                                                                          │
// │ NOTE WHAT THAT ALREADY BOUGHT: the run did not merely confirm a guess,   │
// │ it OVERTURNED this file's stated premise about the 2x anchor. A header   │
// │ written from a plausible reading rather than a real one would have been  │
// │ wrong, internally consistent, and unfalsifiable — which is the           │
// │ scripts/migrateSpecIntegrityFixes.js failure exactly.                    │
// └──────────────────────────────────────────────────────────────────────────┘
//
// THE TEXT-RECOMMENDATIONS BLOCK, verbatim as supplied. Both copies, because
// the page emits the table twice (see THE PROBLEM above) and the span covers
// both:
//
//   source copy, from ~8186:
//     "Text Recommendations &lt;b>Ad name (optional):&amp;nbsp;&lt;/b>255 characters"
//
//   rendered copy, running to ~8790:
//     "Ad name (optional): 255 characters Headline: 70 characters Introductory
//      text: 150 characters Description (LAN only): 70 characters. Only required
//      if using LinkedIn Audience Network (LAN). Technical Requirements"
//
// This block publishes all three of this row's stored limits — Headline 70,
// Introductory text 150, Description (LAN only) 70 — and nothing else on the
// page does.
//
// WHY THE FIRST QUOTE STOPS WHERE IT DOES. The source copy continues into an
// element id, `text-d20e36d2fe`. That is a CMS-GENERATED HASH: it can change on
// any republish without a single spec changing. Quoting it would make this
// file's own quote check fail on a healthy page, and spanning it would put a
// volatile token inside the anchor region. It is excluded deliberately, and this
// paragraph exists so nobody "completes" the quote later by pasting the rest of
// the line in.
//
// It is the same class of hazard as a digit, arriving as a hex string: a token
// that moves for reasons unrelated to the numbers being watched. The digit-free
// rule would not have caught it — `d20e36d2fe` contains digits, so in this case
// it happens to, but a hash of pure letters would sail through. Judgement, not
// the gate, is what excludes this one.
//
// ─── KNOWN RESIDUAL — THIS ANCHOR DOES NOT CLOSE THE SIBLING-PAGE GAP ───────
// STATED PLAINLY BECAUSE IT WOULD BE EASY TO IMPLY OTHERWISE, and every other
// anchor migration in this repo makes a discrimination claim.
//
// "Text Recommendations" is very likely the SAME HEADING LinkedIn uses on its
// carousel and video ad-spec pages. So this anchor asserts WHICH SECTION OF
// THIS PAGE rendered — which is what it was chosen for — and would NOT catch a
// redirect to a sibling ad-format page. That is the Meta "Primary Text" failure
// mode (present on /image, /video and /collection alike), and it remains open
// here.
//
// NOTHING AVAILABLE CLOSES IT. There is no digit-free phrase inside this table
// specific to Single Image Ads: the table's content is field labels and numbers,
// and the labels are shared across LinkedIn's ad formats. Choosing a
// discriminating string would mean either taking a digit-bearing one (refused,
// see below) or reaching outside the table (refused — that is the defect this
// file exists to fix).
//
// So the gap is RECORDED, not solved. If it is ever worth closing, the route is
// a second assertion — an anchor pair, or a check that the URL did not redirect
// — and that is a change to the DETECTOR, not to this row.
//
// ─── THE 255 CASE — WHY DIGIT-FREE AND NOT X'S RULE, CONCRETELY ─────────────
// The table contains "Ad name (optional): 255 characters".
//
// 255 is NOT stored by this row. So scripts/migrateFixXAnchor.js's rule — refuse
// a candidate holding a STORED limit — would have PASSED a candidate containing
// it. A LinkedIn revision to the ad-name cap would then report `failed`: a
// broken-page alarm for an event none of Headline 70, Introductory text 150 or
// Description (LAN only) 70 care about.
//
// This is the concrete case for the digit-free precondition on this page, and it
// is stronger than the Google display page's equivalent (the article id 73067,
// which was page furniture): 255 is a real published number sitting inside the
// watched table, one row above the limits being watched.
//
// TO FILL IT IN — this is the whole workflow, and step 1 is a real step:
//
//   1.  node scripts/migrateFixLinkedInSingleImageAnchor.js --discover
//       Fetches the page through the DETECTOR'S OWN fetchText + hashableText,
//       twice, and dumps: the hashed text in offset-labelled chunks, every
//       occurrence of the old anchor, where each stored limit appears, and every
//       digit-free phrase that occurs exactly once — each with its character
//       offset and percentage. Writes nothing and needs no section, because at
//       that point there is no section to have.
//
//       On a page this size, start by finding where 70 and 150 appear close
//       together. That cluster is the text-recommendations table. Then re-run
//       with --window=<start>-<end> around it to get a readable candidate list.
//
//   2.  READ THE DUMP. Identify the block publishing Headline 70, Introductory
//       text 150 and Description (LAN only) 70. Paste the sentences that bound
//       it into QUOTES, set SECTION.from/.to to substrings of those sentences,
//       and put the phrases you are willing to anchor on into CANDIDATES with a
//       `why` each.
//
//   3.  node scripts/migrateFixLinkedInSingleImageAnchor.js --verify
//       Re-fetches and asserts every quote is present, the section is locatable
//       and ordered, and the chosen candidate is unique, digit-free and inside
//       the span. Writes nothing.
//
//   4.  node scripts/migrateFixLinkedInSingleImageAnchor.js            (dry run)
//   5.  node scripts/migrateFixLinkedInSingleImageAnchor.js --commit
//
// Steps 3–5 all re-fetch and re-assert. The quote in the header is a claim this
// file CHECKS on every run, never a claim it makes.
//
// ─── THE SECTION IS DECLARED, NEVER INFERRED ────────────────────────────────
// An explicit from/to marker pair, per scripts/migrateAddGoogleVideoAssets.js,
// and BOTH MARKERS MUST BE SUBSTRINGS OF QUOTES — asserted, not trusted. On a
// 24,500-character page that assertion matters more than it did on a 5,000-
// character one: there is far more text a marker could be accidentally drawn
// from, and far less chance a reader would notice.
//
// A MISSING OR UNLOCATABLE SECTION MAKES NOTHING ELIGIBLE. Fail closed.
//
// ─── ANCHOR SELECTION, RANKED ───────────────────────────────────────────────
//   1. clean and in-section          — no digit anywhere in the text. Ideal.
//   2. in-section, holds a limit     — REFUSED ON THIS ROW. See below.
//   3. clean but OUT of section      — REFUSED. That is the defect being fixed,
//                                      and on this page it is the LIKELY one.
//
// Option 3 deserves the extra word. On the Google display page a clean
// out-of-section candidate was a curiosity; here it is the default outcome of
// scanning a big page and picking a nice sentence. The run names every refused
// out-of-section candidate explicitly for that reason.
//
// ─── DIGIT-FREE IS A HARDER BAR THAN "HOLDS NO STORED LIMIT", ON PURPOSE ────
// scripts/migrateFixXAnchor.js refuses a candidate holding a STORED LIMIT.
// This file, like the Google display one, refuses ANY DIGIT AT ALL, which
// strictly subsumes that. On this page the extra width is doing specific work:
//
//   • THE 255 PROBLEM. The text-recommendations block contains "Ad name
//     (optional): 255 characters". 255 is not a limit this row stores, so a
//     stored-limit test PASSES a candidate containing it — and LinkedIn
//     revising the ad-name cap would then report `failed`, a broken-page alarm
//     for an event none of this row's three fields care about. The digit-free
//     rule excludes it without needing to enumerate which numbers are ours.
//   • A page of this size carries dates, dimensions, file-size caps and format
//     tables. Every one of those is a number that can move independently of the
//     three limits being watched.
//   • normalize() deletes every run of 12+ digits (the zwieback strip), so a
//     candidate containing a long digit run would be asserted against text the
//     detector has already altered. Digit-free sidesteps that entirely.
//
// Both gates are implemented and both are printed, even though the first
// subsumes the second, because they answer different questions and a reader
// should see each answered: "does this contain a number at all" and "does this
// contain one of OUR numbers".
//
// ─── OPTION 2, AND THE ARITHMETIC IS RECOMPUTED LIVE ────────────────────────
// An anchor holding limit X converts a MOVE on X from `changed` into `failed`.
// Whether that is survivable is decided BY THE OTHER ROWS, not by this one, and
// that argument HAS TO BE REDONE rather than inherited — it depends on which
// pages are watched and what their anchors are RIGHT NOW.
//
// So this run derives it against the live database every time, via soleWitness()
// below. NOTHING IN THIS HEADER IS TRUSTED FOR IT.
//
// What the run is expected to show, stated as a PREDICTION to be checked:
//
//   70    Stored by many seeded fields, but most carry the quillio_default
//         sentinel — a house default, cited to nobody and watched by nothing.
//         The ones cited to a watched page are this row's Headline and LAN
//         Description here, and Twitter/X Ad / Headline on X's page.
//   150   This row's Intro Text here, and Meta Single Image Ad / Primary Text
//         on facebook-feed.
//
// IN BOTH CASES THE OTHER WATCHED ROW IS A DIFFERENT PLATFORM'S PAGE. Two
// platforms publishing the same integer is a COINCIDENCE, not a second
// instrument: if LinkedIn moves its Headline off 70, X's row reports nothing —
// it is watching X. So for a move in LINKEDIN's 70 or LINKEDIN's 150, this row
// is the sole witness, and the summary line saying "N other watched rows would
// also report a move on this VALUE" must be read with that in mind. The run
// prints that caveat beside the count rather than leaving it to be remembered.
//
// Option 2 is refused regardless, because the digit-free rule already excludes
// every such candidate and reaching one would mean relaxing the wider rule.
//
// ─── WHAT IT DOES NOT TOUCH ─────────────────────────────────────────────────
// expected_content, and nothing else. NOT current_hash, NOT affected_fields, NOT
// content_stop_marker, NOT source_kind, NOT spec_source. The hashed content is
// unaffected by an anchor swap, so the row must not re-baseline: a cleared hash
// takes the next run down the baseline branch, where it writes a hash and CANNOT
// flag, and a real spec change landing that week would be silently absorbed.
//
// The next detection run must report `unchanged`, NOT `baseline`.
//
// ─── STOP MARKER — MEASURED, NOT ASSUMED ────────────────────────────────────
// This row has no content_stop_marker and this migration does not add one. The
// run fetches twice, three seconds apart, and REFUSES if the hashed text
// differs. If it does differ, the answer is a stop marker in its own migration,
// not an anchor swap. A 24,500-character marketing page has more room for a
// per-request element than a help-centre article does, so this check is more
// likely to fire here than it was on the Google page — treat a VARIES result as
// information, not as an obstacle.
//
// ─── ORDERING ───────────────────────────────────────────────────────────────
// Same deviation as the files this copies: the stored limits and affected pairs
// live ON THE ROW and the anchor choice depends on them, so the database is
// opened and read BEFORE the page is fetched. Nothing is written until every
// check passes, and no transaction is opened until then.
//
// ─── WHAT MAKES THIS REFUSE ─────────────────────────────────────────────────
//   • QUOTES is empty, or SECTION is unset            (the unfilled-header case)
//   • a SECTION marker is not a substring of any quote
//   • CANDIDATES contains nothing but the recorded old anchor
//   • the target row is not found, or more than one row matches
//   • the page cannot be fetched — a run with no network is a refusal
//   • the two fetches disagree — it needs a stop marker, not an anchor
//   • any quoted sentence is absent from the page
//   • the section markers are not locatable, or are out of order
//   • no in-section candidate is unique
//   • every eligible candidate contains a digit
//   • affected_fields is empty, or its pairs resolve to no ACTIVE copy_fields
//
// A REFUSAL IS A RESULT. If this page cannot carry a clean in-section anchor,
// the correct outcome is to know that — not to install a mediocre one quietly.
//
//   node scripts/migrateFixLinkedInSingleImageAnchor.js --discover
//   node scripts/migrateFixLinkedInSingleImageAnchor.js --discover --window=8000-12000
//   node scripts/migrateFixLinkedInSingleImageAnchor.js --verify
//   node scripts/migrateFixLinkedInSingleImageAnchor.js             # dry run
//   node scripts/migrateFixLinkedInSingleImageAnchor.js --commit
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[linkedin-sia-anchor]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');
const DISCOVER = process.argv.includes('--discover');

const URL = 'https://business.linkedin.com/advertise/ads/sponsored-content/single-image-ads-specs';
const DISPLAY = 'LinkedIn – single image';
const OLD_ANCHOR = 'Introductory text';

// --window=START-END narrows --discover's dump and candidate list to a character
// range. Exists because of the page size — see the header. Parsed once, here, so
// an unparseable value is a null rather than a NaN that silently selects nothing.
function parseWindow() {
  const hit = process.argv.find((a) => a.startsWith('--window='));
  if (!hit) return null;
  const m = /^(\d+)-(\d+)$/.exec(hit.slice('--window='.length).trim());
  if (!m) return { bad: hit };
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!(end > start)) return { bad: hit };
  return { start, end };
}
const WINDOW = parseWindow();

// ─── FILLED FROM AN OPERATOR'S --discover RUN. See the boxed note above. ────
//
// Both copies of the table, VERBATIM from the normalized text. The escaped
// entities (`&lt;b>`, `&amp;nbsp;`) are LITERAL CHARACTERS in the hashed text,
// not markup — normalize() strips real tags, and escaped source survives it.
// Do not "tidy" them into `<b>` or a space: that would be text this page does
// not contain, and readPage() would refuse on a perfectly healthy page.
//
// Quote 1 stops before the CMS element id `text-d20e36d2fe` that follows it in
// the source copy. See the header for why that exclusion is deliberate.
const QUOTES = [
  'Text Recommendations &lt;b>Ad name (optional):&amp;nbsp;&lt;/b>255 characters',
  'Ad name (optional): 255 characters Headline: 70 characters Introductory text: 150 characters Description (LAN only): 70 characters. Only required if using LinkedIn Audience Network (LAN). Technical Requirements',
];

// THE SECTION, declared. Both markers MUST be substrings of QUOTES above —
// asserted by requireHeaderEvidence(), not trusted.
//
// `from` is the table's heading, at the top of the SOURCE copy; `to` is the
// heading of the NEXT block, at the end of the RENDERED copy. So the span runs
// ~8186-8790 and deliberately covers BOTH emissions of the table — anything
// narrower would put one copy in-section and the other out, for no reason a
// reader could reconstruct.
const SECTION = {
  name: 'LinkedIn single image — the text-recommendations block (both copies)',
  from: 'Text Recommendations',
  to: 'Technical Requirements',
};

// CANDIDATES IN PREFERENCE ORDER, filled from --discover.
//
// The old anchor is recorded here so every run prints it being refused and says
// why. It is NOT eligible: `refusedByDesign` bars it from ever being chosen even
// if the page changed such that it became unique and in-section.
const CANDIDATES = [
  {
    text: 'Text Recommendations',
    why: 'PREFERRED. The heading of the block publishing all three of this row\'s stored limits '
      + '(Headline 70, Introductory text 150, Description (LAN only) 70). 1x, digit-free.\n'
      + '      IT DISCRIMINATES WITHIN THIS PAGE: the other headings are "Design Recommendations", '
      + '"Technical Requirements", "Call To Action Options" and "URL Requirements", so it belongs '
      + 'to the text block rather than merely to the page. Drop that block and the anchor goes.\n'
      + '      IT DOES NOT DISCRIMINATE BETWEEN AD-FORMAT PAGES — LinkedIn very likely uses the '
      + 'same heading on the carousel and video specs pages. See KNOWN RESIDUAL in the header: '
      + 'that gap is recorded rather than closed, because nothing digit-free inside this table is '
      + 'specific to Single Image Ads.',
  },
  {
    text: 'characters. Only required if using LinkedIn Audience Network (LAN). Technical',
    why: 'FALLBACK ONLY. 1x at 8703, digit-free, marking the tail of the RENDERED table running '
      + 'into the Technical Requirements heading.\n'
      + '      WEAKER THAN CANDIDATE 1 because it sits ON THE BOUNDARY: it spans the seam between '
      + 'this block and the next, so it asserts that the join between two sections rendered rather '
      + 'than that the watched table did. It would also survive the three spec rows being removed '
      + 'so long as the LAN footnote and the next heading remained.',
  },
  {
    text: OLD_ANCHOR,
    refusedByDesign: true,
    why: 'REFUSED BY DESIGN — the incumbent. NOT refused for being 2x: both occurrences are '
      + 'inside the watched table (the page emits it twice, once escaped and once rendered), so '
      + 'it does assert the section rendered. It is refused because it is a FIELD LABEL for one '
      + 'of the three watched fields, which couples the anchor to the thing being watched: rename '
      + 'or restructure that row and a spec event arrives as `failed` rather than `changed`. See '
      + 'THE PROBLEM in the header, where this file\'s original and incorrect reason is recorded '
      + 'alongside the real one.',
  },
];

// ─── helpers ────────────────────────────────────────────────────────────────

// A unix-socket connection is local by construction and never speaks SSL.
// THE ANCHOR MECHANICS ARE SHARED. scripts/lib/anchorChoice.js carries the
// ranking, the section test, the rejection reasons, the stored-limit query and
// the sole-witness arithmetic — the parts that were a copy in each of the four
// anchor migrations. QUOTES, SECTION and CANDIDATES stay here, because they are
// this page's evidence and belong beside the page they were read from.
const {
  POLICY, count, occurrences, sectionSpan, chooseAnchor,
  LIMITS_SQL, resolveStoredLimits, soleWitnessData, printSoleWitness, soleWitnessHeader,
} = require('./lib/anchorChoice');
const { hasDigit } = require('./lib/anchorChoice');

// This row's ranking policy, and the one clause of rejection prose that is about
// THIS page rather than about anchors in general. Bound here so every call in
// this file uses the same pair and the module needs no default — see
// scripts/lib/anchorChoice.js, "THE ONE DIFFERENCE THAT IS KEPT".
const ANCHOR_OPTS = { policy: POLICY.DIGIT_FREE,
  outOfSectionClean:
    'OUT OF SECTION — clean and unique, and REFUSED anyway: on a page this size uniqueness is '
    + 'nearly free, so this proves a page rendered and not that the watched section did' };

function chooseAnchorHere(text, candidates, limits, section) {
  return chooseAnchor(text, candidates, limits, section, ANCHOR_OPTS);
}

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// ANY digit, not just a stored limit. See the header for why the wider bar.

// ─── the unfilled-header gate ───────────────────────────────────────────────
// The absence of page text is turned into a refusal rather than a default.
function requireHeaderEvidence() {
  if (!Array.isArray(QUOTES) || QUOTES.length === 0) {
    return {
      ok: false,
      why: 'QUOTES is empty — no reading of this page stands behind this file. Nobody has fetched '
        + 'single-image-ads-specs for it: the authoring session had no egress and no operator has '
        + 'supplied the text. The block quoted in the header comes from another file\'s reading '
        + 'months ago and is a hypothesis about where to look, not evidence about the page today. '
        + 'Choosing an anchor now would be choosing a string from a page nobody opened, which is '
        + 'the failure scripts/migrateSpecIntegrityFixes.js is the record of.\n'
        + '       Run: node scripts/migrateFixLinkedInSingleImageAnchor.js --discover\n'
        + '       then fill QUOTES, SECTION and CANDIDATES from what it prints.',
    };
  }
  if (!SECTION || !SECTION.from || !SECTION.to) {
    return {
      ok: false,
      why: 'SECTION is unset. Without a declared span nothing can be in-section — and on a page '
        + 'this size that is the whole of the decision, because uniqueness alone is nearly free.',
    };
  }
  // BOTH MARKERS MUST COME FROM QUOTED TEXT. This is what stops the span being
  // built out of page text nobody read.
  for (const key of ['from', 'to']) {
    const marker = SECTION[key];
    if (!QUOTES.some((q) => String(q).includes(marker))) {
      return {
        ok: false,
        why: `SECTION.${key} is not a substring of any quoted sentence: ${JSON.stringify(marker)}. `
          + 'Both markers must come from text this file quotes, or the span is inferred rather than '
          + 'read — the guess that produced the Google in-feed-video near-miss.',
      };
    }
  }
  const usable = CANDIDATES.filter((c) => !c.refusedByDesign);
  if (usable.length === 0) {
    return {
      ok: false,
      why: 'CANDIDATES holds nothing but the recorded old anchor, which is refused by design. '
        + 'There is no proposal to evaluate.',
    };
  }
  return { ok: true };
}

// ─── discovery ──────────────────────────────────────────────────────────────
// Mechanical candidate generation, for step 1. This does NOT choose an anchor —
// it cannot, because it has no section to judge against. It prints what is on
// the page so a human can declare one.
//
// ON THIS PAGE IT WILL FIND A LOT. That is the point and also the hazard: see
// the header. The count is reported and the list can be windowed.
const MIN_WORDS = 6;
const MAX_WORDS = 16;
const MIN_CHARS = 34;
const MAX_CHARS = 140;
// Above this many candidates the list stops being readable and starts inviting
// a pick-the-nicest-sentence choice. Not a limit — a prompt to use --window.
const CANDIDATE_FLOOD = 60;

function generateCandidates(text) {
  const words = String(text).split(' ').filter(Boolean);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < words.length; i += 1) {
    for (let n = MIN_WORDS; n <= MAX_WORDS && i + n <= words.length; n += 1) {
      const phrase = words.slice(i, i + n).join(' ');
      if (phrase.length < MIN_CHARS) continue;
      if (phrase.length > MAX_CHARS) break;
      if (hasDigit(phrase)) continue;
      if (seen.has(phrase)) continue;
      seen.add(phrase);
      if (count(text, phrase) !== 1) continue;
      out.push({ text: phrase, at: text.indexOf(phrase), words: n });
    }
  }
  // TWO ROUNDS OF THINNING, because the raw sweep is unreadable and an
  // unreadable dump is a dump nobody checks.
  //
  // 1. Shortest unique phrase per START offset. A longer window over the same
  //    start is unique for the trivial reason that its prefix already was.
  const byStart = new Map();
  for (const c of out) {
    const prev = byStart.get(c.at);
    if (!prev || c.text.length < prev.text.length) byStart.set(c.at, c);
  }
  // 2. NON-OVERLAPPING. Windows starting one word apart describe the same region
  //    and are not separate choices. Walk left to right and skip past each one
  //    taken, so what prints is one candidate per REGION and the count means
  //    something — which matters far more on 24,500 characters than on 5,000.
  const ordered = [...byStart.values()].sort((a, b) => a.at - b.at || a.text.length - b.text.length);
  const picked = [];
  let cursor = -1;
  for (const c of ordered) {
    if (c.at < cursor) continue;
    picked.push(c);
    cursor = c.at + c.text.length;
  }
  return picked;
}

function chunkDump(text, size, win) {
  const lines = [];
  const from = win ? Math.max(0, win.start) : 0;
  const to = win ? Math.min(text.length, win.end) : text.length;
  for (let i = from; i < to; i += size) {
    const pct = Math.round((i / text.length) * 1000) / 10;
    lines.push(`   [${String(i).padStart(6)}  ${String(pct).padStart(5)}%]  ${text.slice(i, Math.min(i + size, to))}`);
  }
  return lines;
}

// ─── the page ───────────────────────────────────────────────────────────────
// Fetched through the DETECTOR'S OWN fetchText and hashableText, never a
// reimplementation, so the candidate search runs against exactly the text the
// detector will assert against.
async function fetchHashedText() {
  const { fetchText, hashableText } = require('../src/services/specDetector');
  const rawA = await fetchText(URL);
  await new Promise((r) => setTimeout(r, 3000));
  const rawB = await fetchText(URL);
  // content_stop_marker is null on this row, so hashableText is normalize().
  // Called through the helper anyway, so this measures the path the detector
  // takes rather than a shortcut around it.
  return {
    a: hashableText({ content_stop_marker: null }, rawA),
    b: hashableText({ content_stop_marker: null }, rawB),
  };
}

function reportStability(a, b) {
  console.log(`   hashed ${a.length} chars (expected ~24,500)`);
  const stable = a === b;
  console.log(`   across two fetches, 3s apart: ${stable ? 'STABLE' : 'VARIES'}`);
  if (a.length < 5000) {
    console.log('   WARNING: far shorter than the ~24,500 this page is expected to normalize to.');
    console.log('   That is consistent with a JS shell or a consent wall rather than the specs page.');
    console.log('   Confirm the page rendered before anchoring anything to it.');
  }
  return stable;
}

const VARIES_WHY = 'the two fetches disagree. Something outside <script> varies per request, so this '
  + 'row needs a content_stop_marker before any anchor can be trusted — that is a different '
  + 'migration, and swapping the anchor first would hide the problem.';

async function runDiscover(limits) {
  console.log(`\n${'='.repeat(74)}\nDISCOVER — ${DISPLAY}\n${URL}\n${'='.repeat(74)}`);
  if (WINDOW && WINDOW.bad) {
    console.error(`${TAG} unparseable --window: ${JSON.stringify(WINDOW.bad)} — expected --window=START-END with END > START.`);
    return false;
  }
  let a;
  let b;
  try {
    ({ a, b } = await fetchHashedText());
  } catch (err) {
    console.error(`\n${TAG} fetch failed: ${err.message}`);
    console.error(`${TAG} A run with no network is a refusal, not a fallback. Nothing to report.`);
    return false;
  }
  if (!reportStability(a, b)) {
    console.error(`\n${TAG} ${VARIES_WHY}`);
    return false;
  }

  const hits = occurrences(a, OLD_ANCHOR);
  console.log(`\n   THE OLD ANCHOR ${JSON.stringify(OLD_ANCHOR)} — ${hits.length}x`);
  console.log(`   at ${hits.map((h) => `${h.at} (${h.pct}%)`).join('  ')}`);
  if (hits.length > 1) {
    console.log('   EXPECT 2x AND EXPECT BOTH TO BE IN-SECTION. This page emits every block twice —');
    console.log('   once as escaped HTML source (&lt;b> …) and once rendered — so the whole table');
    console.log('   appears twice. The repeat is a CMS artifact, NOT the anchor matching a second');
    console.log('   section. Check the offsets against the section span before concluding anything.');
  } else if (hits.length <= 1) {
    console.log('   NOTE: NOT repeating on this fetch. The premise of this change is not reproducing —');
    console.log('   the page may have been restructured. Re-read the header before trusting it.');
  }

  // WHERE THE STORED LIMITS CLUSTER. On a 24,500-character page this is the
  // fastest way to find the section: the block publishing all three of this
  // row's numbers is the one they appear close together in.
  if (limits && limits.length) {
    console.log(`\n   STORED LIMITS ON THIS ROW: ${limits.join(', ')}`);
    for (const n of limits) {
      const o = occurrences(a, n);
      console.log(`   value ${String(n).padEnd(4)} ${String(o.length).padStart(3)}x  `
        + o.map((h) => `${h.at}(${h.pct}%)`).join(' '));
    }
    const all = limits.flatMap((n) => occurrences(a, n).map((h) => h.at)).sort((x, y) => x - y);
    if (all.length > 1) {
      // Tightest window containing at least one occurrence of every limit is
      // overkill; the tightest pair is enough to point a human at the region.
      let best = null;
      for (let i = 1; i < all.length; i += 1) {
        const gap = all[i] - all[i - 1];
        if (!best || gap < best.gap) best = { gap, from: all[i - 1], to: all[i] };
      }
      if (best) {
        const lo = Math.max(0, best.from - 400);
        const hi = Math.min(a.length, best.to + 400);
        console.log(`\n   TIGHTEST CLUSTER of stored limits: ${best.from}–${best.to} (gap ${best.gap}).`);
        console.log(`   The table is likely around there. To read just that region:`);
        console.log(`     node scripts/migrateFixLinkedInSingleImageAnchor.js --discover --window=${lo}-${hi}`);
      }
    }
  }

  const win = WINDOW && !WINDOW.bad ? WINDOW : null;
  console.log(`\n${'─'.repeat(74)}\nTHE HASHED TEXT, 120-char chunks with offsets`
    + `${win ? ` — WINDOWED ${win.start}-${win.end}` : ' — FULL'}\n${'─'.repeat(74)}`);
  for (const line of chunkDump(a, 120, win)) console.log(line);

  const allCands = generateCandidates(a);
  const cands = win ? allCands.filter((c) => c.at >= win.start && c.at < win.end) : allCands;
  console.log(`\n${'─'.repeat(74)}\nDIGIT-FREE PHRASES OCCURRING EXACTLY ONCE — `
    + `${cands.length}${win ? ` in window (${allCands.length} on the page)` : ' found'}`
    + `\n${'─'.repeat(74)}`);

  if (allCands.length === 0) {
    console.log('   NONE. Every unique phrase on this page of between');
    console.log(`   ${MIN_WORDS}-${MAX_WORDS} words / ${MIN_CHARS}-${MAX_CHARS} chars contains a digit.`);
    console.log('');
    console.log('   THAT IS THE FINDING, and it is a legitimate one. Do not lower the bar to');
    console.log('   manufacture a candidate. The options are, in order:');
    console.log('     • widen MIN/MAX_WORDS here and re-run, if the window was simply wrong;');
    console.log('     • anchor on a digit-free phrase shorter or longer than the window;');
    console.log('     • decide deliberately that a digit-bearing anchor is worth its cost, and');
    console.log('       record that decision IN THIS FILE before relaxing the gate;');
    console.log('     • leave the row on its 2x anchor and log the gap, which is honest.');
  } else {
    for (const c of cands) {
      const pct = Math.round((c.at / a.length) * 1000) / 10;
      console.log(`   [${String(c.at).padStart(6)}  ${String(pct).padStart(5)}%]  ${JSON.stringify(c.text)}`);
    }
  }

  if (!win && allCands.length > CANDIDATE_FLOOD) {
    console.log(`\n   ${allCands.length} CANDIDATES IS TOO MANY TO CHOOSE FROM BY READING.`);
    console.log('   On a page this size, occurring exactly once is nearly free — most of these are');
    console.log('   unique BY ACCIDENT and belong to sections this row stores nothing from. A long');
    console.log('   list invites picking the nicest-sounding string, which is the defect this');
    console.log('   migration exists to fix, arriving through the front door.');
    console.log('   Narrow to the table first with --window=START-END (see the cluster hint above).');
  }

  console.log(`\n${'─'.repeat(74)}\nNEXT\n${'─'.repeat(74)}`);
  console.log('   1. Find the block publishing Headline 70, Introductory text 150 and');
  console.log('      Description (LAN only) 70 — the stored-limit cluster above points at it.');
  console.log('   2. Paste the sentences bounding it into QUOTES, verbatim.');
  console.log('   3. Set SECTION.from/.to to substrings of those quotes.');
  console.log('   4. Copy the phrases you would anchor on into CANDIDATES, each with a `why`,');
  console.log('      preferring ones INSIDE that block. Offsets above tell you which are.');
  console.log('      Check whether "Text Recommendations" is 1x — if it is, it is the direct');
  console.log('      analogue of the Google display row\'s table header. If LinkedIn repeats it');
  console.log('      per ad format, it is disqualified for the same reason as the incumbent.');
  console.log('   5. Re-run with --verify.');
  console.log('\n   NOTHING WAS WRITTEN. --discover is read-only.');
  return true;
}

// Returns { ok, why, anchor, tier }. Called by --verify and by the write path,
// so the anchor is never swapped without the page being read in the same run.
async function readPage(limits) {
  console.log(`\n${'='.repeat(74)}\n${DISPLAY}\n${URL}\n${'='.repeat(74)}`);

  let a;
  let b;
  try {
    ({ a, b } = await fetchHashedText());
  } catch (err) {
    return {
      ok: false,
      why: `fetch failed: ${err.message}. A run with no network is a refusal, not a fallback.`,
    };
  }
  if (!reportStability(a, b)) return { ok: false, why: VARIES_WHY };

  // THE QUOTES, asserted. The header's provenance is an operator's reading
  // rather than a fetch by this file's author, so this check is what the header
  // rests on.
  console.log('\n   QUOTED SENTENCES (this file\'s header would be making an unsupported claim without these):');
  let missing = 0;
  for (const q of QUOTES) {
    const n = count(a, q);
    if (n === 0) missing += 1;
    console.log(`   ${n > 0 ? 'PRESENT' : 'ABSENT '} ${n}x  ${JSON.stringify(q.slice(0, 62))}${q.length > 62 ? '…' : ''}`);
  }
  if (missing > 0) {
    return {
      ok: false,
      why: `${missing} quoted sentence(s) are not on the page. The header's text was supplied from `
        + 'an operator\'s reading rather than fetched by this file, and this is the check that was '
        + 'supposed to catch exactly that being stale. Re-read the page before changing anything.',
    };
  }

  // THE DEFECT, SHOWN RATHER THAN ASSERTED.
  const hits = occurrences(a, OLD_ANCHOR);
  console.log(`\n   THE OLD ANCHOR ${JSON.stringify(OLD_ANCHOR)} — ${hits.length}x`);
  console.log(`   ${hits.map((h) => `${h.at} (${h.pct}%)`).join('  ')}`);
  console.log('   Both occurrences are expected to be INSIDE the section span below: this page emits');
  console.log('   every block twice, escaped-source and rendered, so the table appears twice over.');
  console.log('   The incumbent is not refused for multiplicity — it is refused for being a FIELD');
  console.log('   LABEL of a watched field. See THE PROBLEM in the header.');
  if (hits.length <= 1) {
    console.log('\n   NOTE: the old anchor is NOT repeating on this fetch. The premise of this change');
    console.log('   is not reproducing — the page may have been restructured. Re-read the header.');
  }

  console.log(`\n   STORED LIMITS ON THIS ROW: ${limits.join(', ')}`);
  for (const n of limits) console.log(`   value ${n}: ${count(a, n)}x in the hashed text`);

  const { chosen, seen, span, tier } = chooseAnchorHere(a, CANDIDATES, limits, SECTION);

  console.log(`\n   SECTION  ${SECTION.name}`);
  if (!span) {
    console.log(`      NOT LOCATED — from ${JSON.stringify(String(SECTION.from).slice(0, 46))}`);
    console.log(`                     to ${JSON.stringify(String(SECTION.to).slice(0, 46))}`);
    return {
      ok: false,
      why: 'the text-recommendations section could not be located. Both markers are substrings of '
        + 'sentences quoted in this file, so if the quote check passed and this did not, the two '
        + 'markers are no longer adjacent or are out of order — the page has been restructured and '
        + 'the section must be re-read before anything is anchored to it.',
    };
  }
  const spanPct = Math.round((span.start / a.length) * 1000) / 10;
  console.log(`      chars ${span.start}–${span.end} of ${a.length} (${span.end - span.start} chars,`
    + ` ${spanPct}% into the document)`);
  console.log(`      the span is ${Math.round(((span.end - span.start) / a.length) * 1000) / 10}% of the page — `
    + 'everything outside it is text this row stores nothing from');

  console.log('\n   ANCHOR CANDIDATES, in preference order:');
  for (const c of seen) {
    const mark = c === chosen ? '=>' : '  ';
    const where = c.count === 0 ? '—' : c.inSection ? 'in-section' : 'OUT';
    const at = c.at >= 0 ? `@${c.at} (${c.pct}%)` : '@—';
    const digitCol = c.digits.length ? `digits ${c.digits.join('/')}` : 'digit-free';
    console.log(`   ${mark} ${String(c.count)}x  ${where.padEnd(10)} ${at.padEnd(17)} ${digitCol.padEnd(16)}`
      + ` ${JSON.stringify(c.text.slice(0, 44))}${c.text.length > 44 ? '…' : ''}`);
    if (c.holds.length) console.log(`         holds STORED limit(s): ${c.holds.join(', ')}`);
    if (c.reason) console.log(`         rejected: ${c.reason}`);
  }

  if (!chosen) {
    const cleanOutside = seen.find((c) => !c.refusedByDesign && c.clean && !c.inSection);
    if (cleanOutside) {
      console.log(`\n   NAMING THE REFUSED CANDIDATE: ${JSON.stringify(cleanOutside.text)}`);
      console.log(`   Digit-free, unique, and OUT OF SECTION at ${cleanOutside.pct}% of the page.`);
      console.log('   On 24,500 characters uniqueness is nearly free, so this tells you almost');
      console.log('   nothing — it is the defect this migration exists to fix. Refused, not taken.');
    }
    const digitInside = seen.find((c) => !c.refusedByDesign && c.unique && c.inSection && c.digits.length);
    if (digitInside) {
      console.log(`\n   NAMING THE REFUSED CANDIDATE: ${JSON.stringify(digitInside.text)}`);
      console.log(`   In-section and unique, and it carries ${digitInside.digits.join(', ')}`);
      console.log('   — so a LinkedIn revision to any of those numbers would arrive as `failed`, a');
      console.log('   broken-page alarm for an event that is not a broken page. Note that this');
      console.log('   includes 255 (Ad name), which this row does not even store.');
    }
    return {
      ok: false,
      why: 'no candidate is digit-free, unique AND in-section. Nothing is eligible. A clean '
        + 'out-of-section string is not a substitute — least of all on a page this size, where '
        + 'being unique says almost nothing — and neither is an in-section string carrying a '
        + 'number. If the page genuinely cannot carry one, that is the finding: record it and '
        + 'leave the row as it is rather than installing something weaker.',
    };
  }

  console.log(`\n   CHOSEN — tier ${tier}`);
  console.log(`      ${JSON.stringify(chosen.text)}`);
  console.log(`      at char ${chosen.at} (${chosen.pct}% into the document), inside the section span`);
  console.log(`      ${chosen.why}`);

  return { ok: true, anchor: chosen.text, tier };
}

// ─── main ───────────────────────────────────────────────────────────────────

// SOLE WITNESS. The arithmetic and the per-source lines come from
// scripts/lib/anchorChoice.js; the commentary below is THIS row's and stays
// here, because it is an argument about this platform rather than about anchors.
async function soleWitness(client, rowId, limits) {
  soleWitnessHeader();
  const data = await soleWitnessData(client, rowId, limits);
  for (const entry of data) {
    printSoleWitness(entry, rowId);
    if (!entry.sole) {
      console.log('         READ THAT CAREFULLY, and on this row it is the usual case rather than');
      console.log('         the exception: another PLATFORM publishing the same integer is a');
      console.log('         coincidence, not a second instrument. 70 and 150 are round numbers that');
      console.log('         X and Meta happen to share. If LINKEDIN moves its Headline off 70, a');
      console.log('         row watching x.com reports nothing. For a move in LINKEDIN\'s limits,');
      console.log('         this row is the only witness there is.');
    }
  }
  return data.map((e) => ({ value: e.value, others: e.others }));
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(`${TAG} DATABASE_URL not set — the stored limits and affected pairs are read off `
      + `the row, so this needs a database even to --discover or --verify.`);
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
  console.log(`${TAG} mode: ${DISCOVER ? 'DISCOVER (no write)'
    : VERIFY ? 'VERIFY (no write)'
      : COMMIT ? 'COMMIT (writes)'
        : 'DRY RUN (rolls back — pass --commit to write)'}`);

  // WHETHER A TRANSACTION IS ACTUALLY OPEN, tracked rather than assumed.
  //
  // Everything up to and including the page fetch runs OUTSIDE a transaction —
  // the reads that pick the anchor, and the --discover and --verify paths in
  // full. An unconditional ROLLBACK in the catch would print "FAILED (rolled
  // back)" regardless, so a --verify failure would report a rollback that never
  // happened: Postgres answers ROLLBACK-with-no-transaction with a WARNING,
  // which `.catch(() => {})` swallows, and the message then describes a
  // transaction that was never opened.
  //
  // Cosmetic in effect and not in what it TELLS YOU. "Rolled back" on a
  // read-only path sends a reader looking for a write that does not exist, and
  // the first thing anyone does with a failing migration is ask what it touched.
  let inTxn = false;

  try {
    // READ-ONLY, and BEFORE any transaction. See the ordering note in the header.
    const found = await client.query(
      `SELECT id, display_name, source_url, expected_content, anchor_scope, content_stop_marker,
              source_kind, affected_fields,
              current_hash IS NOT NULL AS baselined,
              last_checked_at, consecutive_failures, consecutive_unconfirmed
         FROM spec_watch_list WHERE source_url = $1`,
      [URL]
    );
    console.log(`\n${TAG} rows matching ${URL}: ${found.rowCount}`);
    for (const r of found.rows) {
      console.log(`    #${r.id}  ${r.display_name}`);
      console.log(`        expected_content    ${JSON.stringify(r.expected_content)}`);
      console.log(`        anchor_scope        ${r.anchor_scope}`);
      console.log(`        content_stop_marker ${JSON.stringify(r.content_stop_marker)}`);
      console.log(`        source_kind         ${r.source_kind}`);
      console.log(`        last_checked_at     ${r.last_checked_at ? r.last_checked_at.toISOString() : '(never)'}`);
      console.log(`        failures / unconf   ${r.consecutive_failures} / ${r.consecutive_unconfirmed}`);
      console.log(`        ${r.baselined ? 'baselined' : 'not baselined'}`);
    }
    if (found.rowCount !== 1) {
      throw new Error(
        `expected exactly 1 row on that URL, found ${found.rowCount}. `
        + (found.rowCount === 0
          ? 'Check scripts/migrateAddSpecTables.js and scripts/migrateAddSpecAnchors.js — this row '
            + 'should already exist and already carry the "Introductory text" anchor.'
          : 'Two rows on one URL is a state no migration creates; resolve it before changing an anchor.')
      );
    }
    const row = found.rows[0];

    // THE PAIRS, READ OFF THE ROW. Never hardcoded: affected_fields is the write
    // gate, and a list typed into this file could describe a gate that has since
    // been re-derived. NOTE for this row specifically: scripts/rederiveAffectedFields.js
    // has an outstanding job here — migrateSpecIntegrityFixes repointed LinkedIn
    // Carousel's six pairs to the carousel page in July and this entry still
    // lists them. If they appear below, that is the known staleness, not a
    // surprise, and it does not block an anchor swap.
    const pairs = Array.isArray(row.affected_fields) ? row.affected_fields : [];
    console.log(`\n${TAG} affected_fields on the row — ${pairs.length} pair(s):`);
    for (const p of pairs) console.log(`    ${p.asset} || ${p.field}`);
    if (pairs.length === 0) {
      throw new Error('affected_fields is empty. This row gates nothing, and an anchor swap is not the problem to solve first.');
    }

    // THE STORED LIMITS, CONFIRMED AGAINST copy_fields IN THE SAME RUN. The
    // anchor choice depends on which values are in play, so they are read rather
    // than believed — the header predicts 70 and 150 and this is what checks it.
    const { rows: limRows, limits } = await resolveStoredLimits(client, pairs);
    console.log(`\n${TAG} those pairs resolve to ${limRows.length} distinct copy_fields shape(s):`);
    for (const r of limRows) {
      console.log(`    ${(r.asset + ' / ' + r.field).padEnd(44)} ${r.char_min}-${r.char_max}  ${r.spec_type}`);
    }
    if (limRows.length === 0) {
      throw new Error(
        'the row\'s affected_fields resolve to no ACTIVE copy_fields rows. Either the gate is stale — '
        + 'a re-derivation problem (scripts/rederiveAffectedFields.js), not an anchor problem — or every '
        + 'asset behind it has been retired, in which case the row gates nothing and the anchor is the '
        + 'least of it.'
      );
    }
    console.log(`\n${TAG} stored limits in play: ${limits.join(', ')}`);

    await soleWitness(client, row.id, limits);

    // DISCOVERY runs before the header gate, deliberately: it is the step that
    // EXISTS to fill the header in, so requiring a filled header first would be
    // a deadlock.
    if (DISCOVER) {
      const ok = await runDiscover(limits);
      if (!ok) process.exitCode = 1;
      return;
    }

    // THE UNFILLED-HEADER GATE. Everything below writes or claims to have read
    // the page, and neither is possible without evidence in the header.
    const evidence = requireHeaderEvidence();
    if (!evidence.ok) {
      console.error(`\n${TAG} REFUSING TO WRITE: ${evidence.why}`);
      process.exitCode = 1;
      return;
    }

    const page = await readPage(limits);
    if (!page.ok) {
      console.error(`\n${TAG} REFUSING TO WRITE: ${page.why}`);
      process.exitCode = 1;
      return;
    }

    if (VERIFY) {
      console.log(`\n${TAG} VERIFY PASSED — nothing written.`);
      console.log(`${TAG} would set expected_content:`);
      console.log(`${TAG}     from  ${JSON.stringify(row.expected_content)}`);
      console.log(`${TAG}     to    ${JSON.stringify(page.anchor)}`);
      return;
    }

    if (row.expected_content === page.anchor) {
      console.log(`\n${TAG} the row already carries this anchor — nothing to do.`);
      return;
    }

    // THE DIFF, BEFORE ANY WRITE.
    console.log(`\n${'─'.repeat(74)}\nANCHOR DIFF — row #${row.id} ${row.display_name}\n${'─'.repeat(74)}`);
    console.log(`   -  ${JSON.stringify(row.expected_content)}`);
    console.log(`   +  ${JSON.stringify(page.anchor)}`);
    console.log(`   tier ${page.tier}`);

    await client.query('BEGIN');
    inTxn = true;

    // expected_content AND NOTHING ELSE. current_hash in particular is untouched:
    // the hashed content does not change when an anchor does, so the row must not
    // re-baseline. Guarded on the id AND the anchor just read, so a concurrent
    // change between the SELECT and here refuses rather than overwriting.
    const upd = await client.query(
      `UPDATE spec_watch_list SET expected_content = $1
        WHERE id = $2 AND expected_content IS NOT DISTINCT FROM $3
        RETURNING id`,
      [page.anchor, row.id, row.expected_content]
    );
    if (upd.rowCount !== 1) {
      throw new Error(`UPDATE matched ${upd.rowCount} row(s) — the anchor changed between the read and the write. Nothing written.`);
    }

    const after = await client.query(
      `SELECT expected_content, anchor_scope, content_stop_marker, source_kind, source_url,
              current_hash IS NOT NULL AS baselined,
              COALESCE(jsonb_array_length(affected_fields), 0) AS pairs
         FROM spec_watch_list WHERE id = $1`,
      [row.id]
    );
    const a = after.rows[0];
    console.log(`\n${TAG} row #${row.id} — ${row.display_name}`);
    console.log(`    before  ${JSON.stringify(row.expected_content)}`);
    console.log(`    after   ${JSON.stringify(a.expected_content)}`);
    console.log(`\n${TAG} unchanged, as intended:`);
    console.log(`    source_url           ${a.source_url}`);
    console.log(`    anchor_scope         ${a.anchor_scope}`);
    console.log(`    content_stop_marker  ${JSON.stringify(a.content_stop_marker)}`);
    console.log(`    source_kind          ${a.source_kind}`);
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

// UNIT TESTS ONLY. chooseAnchor, sectionSpan, generateCandidates,
// requireHeaderEvidence and parseWindow are the properties this change rests on,
// exported so a test drives the same code the migration does rather than
// reimplementing the ranking beside it.
module.exports = {
  ANCHOR_OPTS,
  chooseAnchor: chooseAnchorHere, sectionSpan, occurrences, hasDigit, generateCandidates,
  requireHeaderEvidence, resolveStoredLimits, LIMITS_SQL, parseWindow, chunkDump,
  CANDIDATES, SECTION, QUOTES, OLD_ANCHOR, URL, DISPLAY, CANDIDATE_FLOOD,
};
