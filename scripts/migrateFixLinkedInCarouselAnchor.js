'use strict';

// August 2026 — replace the anchor on the LinkedIn – carousel watch row with one
// scoped to the section its fields actually come from.
//
// Follows scripts/migrateFixLinkedInSingleImageAnchor.js exactly: same ranking,
// same refusal discipline, the same unnest-of-two-arrays limit resolution, the
// same inTxn flag, --window on --discover, and DIGIT-FREE as a precondition of
// eligibility rather than X's looser "holds no stored limit" rule. That file is
// the closest precedent — same platform, same CMS, adjacent page — and its
// reasoning is not repeated except where this row differs.
//
// ─── THE ROW ────────────────────────────────────────────────────────────────
//   business.linkedin.com/advertise/ads/sponsored-content/carousel-ads/specs
//   anchored on "Card headline", which reads 2x
//   six pairs in affected_fields; limits 45 (the five card headlines) and
//   255 (intro text)
//   ~20,838 normalized characters
//
// ─── THE QUESTION IS RESOLVED: THE 2x IS A CMS ARTIFACT ────────────────────
//
// This file shipped with the 2x written as an OPEN QUESTION and both branches
// spelled out, because a 2x anchor LOOKS like the X / Meta defect and the
// sibling page's finding was not evidence about this document. The --discover
// run has answered it.
//
// MEASURED, both occurrences of "Card headline":
//
//     8125   the ESCAPED-SOURCE copy      IN-SECTION
//     8329   the RENDERED copy            IN-SECTION
//            204 characters apart, both inside the text-recommendations block
//
// This is the same CMS double emission established on the single-image page:
// LinkedIn emits every content block TWICE in the normalized text, once as
// escaped HTML source (`&lt;b>`, `&amp;nbsp;`) and once as rendered plain text.
// normalize() strips real tags, but escaped source is literal characters and
// survives, so the whole table appears twice over.
//
// THE MULTIPLICITY CASE EVAPORATES. Drop the table and both occurrences go with
// it, so the old anchor DOES assert that the watched section rendered. It is not
// the Meta failure mode, and THE ROW IS NOT BLIND.
//
// The refused branch — one occurrence outside the section — is DELETED rather
// than left in place beside the answer. Keeping a disproved alternative next to
// a measured one is the stale-prose failure this repo's preamble is about; the
// question it was asking is recorded above, and the answer with it.
//
// ─── WHAT REMAINS IS A DECOUPLING, NOT A DEFECT FIX ────────────────────────
// Say it plainly when deciding whether to run this: NOTHING IS CURRENTLY BROKEN.
//
// "Card headline" is the FIELD LABEL of five of this row's six watched pairs.
// That couples the anchor to the thing being watched — the digit-free rule's
// defect arriving as a LABEL rather than a NUMBER:
//
//   • LinkedIn renames the row "Card headline" -> "Card title", limits
//     unchanged: the anchor reports `failed`, a broken-page alarm for a
//     cosmetic edit.
//   • LinkedIn drops or merges that row — which IS a spec change we want queued
//     as `changed`: the anchor reports `failed` instead, so a real spec event
//     arrives dressed as a broken page.
//
// "Text Recommendations" is the block's HEADING. It is not one of the watched
// things, so neither turns a spec move into a broken-page report. That is the
// whole of the gain: an anchor that is not itself one of the strings whose
// movement it exists to report.
//
// ─── AND THE DECOUPLING MATTERS MORE HERE THAN ON THE SIBLING, BECAUSE THIS
// ─── ROW IS A TRUE SOLE WITNESS ON BOTH ITS LIMITS
// RECORDED, NOT SOLVED. From the run:
//
//     45    stored by 10 copy_fields rows, ALL cited to this page
//     255   stored by 2, both here
//
// NO OTHER WATCHED ROW WOULD REPORT A MOVE ON EITHER VALUE. Contrast the
// single-image row, where 70 also appears on X's page and 150 on facebook-feed —
// coincidences rather than second instruments, but at least the run has to
// explain itself. Here there is nothing to explain away: this row is the only
// instrument either limit has.
//
// TWO CONSEQUENCES, and the second is the uncomfortable one:
//
//   1. An anchor that converts a real move into `failed` is worse here than
//      anywhere else on the watch list, because there is no second row to catch
//      what this one turns into an alarm. That is the case for the decoupling.
//   2. THE ANCHOR IS NOT A CORRECTNESS CHECK. It asserts the page rendered and
//      the block is present; it never re-reads a number. If the seeded 45 or 255
//      were wrong the day they were written, this row will report `unchanged`
//      forever and be right to. Correctness still depends on a human opening the
//      page — see CLAUDE.md, "'Checked', not 'verified'".
//
// ─── KNOWN RESIDUAL — THIS ANCHOR DOES NOT CLOSE THE SIBLING-PAGE GAP ──────
// RECORDED, NOT SOLVED, and stated plainly because every other anchor migration
// here makes a discrimination claim.
//
// "Text Recommendations" is the SAME HEADING the single-image page uses — it is
// what won there — and very likely the same on LinkedIn's video and lead-gen
// spec pages. So it asserts WHICH SECTION OF THIS PAGE rendered, and would NOT
// catch a redirect to a sibling ad-format page. That is the Meta "Primary Text"
// failure mode (present on /image, /video and /collection alike), and it stays
// open.
//
// NOTHING INSIDE THIS TABLE CLOSES IT. The block is field labels and numbers;
// the labels are shared across LinkedIn's ad formats, and the numbers are
// refused by the digit rule. A discriminating string would have to come from
// outside the table, which is the defect this file exists to fix.
//
// If it is ever worth closing, the route is a second assertion — an anchor pair,
// or a redirect check — and that is a change to the DETECTOR, not to this row.
//
// ─── 255 IS A STORED LIMIT HERE, WHICH IT WAS NOT ON THE SIBLING PAGE ───────
// Worth its own note, because the single-image file discusses 255 at length and
// means something different by it.
//
//   single-image page   "Ad name (optional): 255 characters" — the AD-NAME cap,
//                       which that row does NOT store. A stored-limit test
//                       therefore PASSES a candidate holding it, and only the
//                       digit-free rule refuses it. That was the concrete case
//                       for the wider rule.
//
//   THIS page           255 IS one of this row's limits (intro text). So a
//                       candidate containing it is refused TWICE OVER, by two
//                       independent rules, for two different reasons:
//                         - the digit rule, because it contains a digit at all;
//                         - the stored-limit rule, because that digit is ours.
//
// The run prints both facts — `digits 255` in the column and `holds STORED
// limit(s): 255` on its own line — rather than collapsing them into one refusal.
// They are different findings and a reader should see each.
//
// The practical consequence is the same either way: do not anchor on it. A
// revision to the intro-text cap is exactly the event this row exists to report,
// and an anchor holding 255 converts that from `changed` into `failed` — the one
// failure mode that teaches a reviewer to dismiss the queue.
//
// ─── THE PAGE IS BIG, SO IN-SECTION DOES THE WORK ──────────────────────────
// ~20,838 normalized characters. As on the single-image page, digit-free unique
// candidates will be PLENTIFUL and most unique BY ACCIDENT rather than by
// belonging to the section holding these fields. Uniqueness is close to free at
// this size; the in-section test is nearly the whole decision.
//
// Hence, implemented rather than left as advice: --discover reports the
// candidate COUNT and warns above 60, takes --window=START-END to narrow the
// dump and the list, prints the tightest cluster of stored-limit occurrences
// with the exact --window command for that region, and reports offset AND
// percentage for every candidate at both discover and verify time.
//
// ─── SOLE WITNESS — CONFIRMED, see the section above ──────────────────────
// Recomputed live every run regardless; nothing in this header is trusted for
// it. The prediction this file shipped with — that 45 and 255 are stored only by
// this page's fields — was confirmed by the run, and the consequences are
// recorded under THE DECOUPLING above rather than repeated here.
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
// ─── THIS ROW'S HISTORY ─────────────────────────────────────────────────────
// Created by scripts/migrateAddLinkedInCarouselWatch.js to close a real gap: six
// enforced fields had been repointed to this page by migrateSpecIntegrityFixes
// and NOTHING watched it for about a month. That migration measured the page
// STABLE across two fetches and deliberately left content_stop_marker NULL. Its
// anchor choice was made before the in-section rule existed — the same position
// the single-image and Google display rows were in.
//
// ─── THE PAGE TEXT — UNFILLED, AND THIS FILE REFUSES TO WRITE UNTIL IT IS ───
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ READ THIS BEFORE TRUSTING THE QUOTES BELOW.                              │
// │                                                                          │
// │ The session that AUTHORED this file could not reach business.linkedin    │
// │ .com — the egress proxy answers 403 to CONNECT. It shipped with QUOTES   │
// │ and SECTION empty, refusing to write, and with the 2x written as an open │
// │ question. That refusal is what produced the reading below.               │
// │                                                                          │
// │ The text now in QUOTES was SUPPLIED BY THE OPERATOR from their own       │
// │ `--discover` run against the live page, and is NOT a fetch performed by  │
// │ the author of this file. Same provenance, and the same weakness, as      │
// │ migrateFixXAnchor.js and the two other anchor migrations.                │
// │                                                                          │
// │ WHAT CLOSES THE GAP: readPage() FETCHES THE PAGE AND ASSERTS EVERY QUOTE │
// │ BEFORE ANYTHING IS WRITTEN, and the write path calls the same function.  │
// │ The quote is a claim this file CHECKS, never a claim it MAKES.           │
// │                                                                          │
// │ AND THE SAME RUN SETTLED THE OPEN QUESTION rather than merely confirming │
// │ a guess. That is the second time in this series the measurement has told │
// │ us something the header could not have known — on the single-image page  │
// │ it OVERTURNED the stated premise.                                        │
// └──────────────────────────────────────────────────────────────────────────┘
//
// TO FILL IT IN:
//
//   1.  node scripts/migrateFixLinkedInCarouselAnchor.js --discover
//       Fetches through the DETECTOR'S OWN fetchText + hashableText, twice, and
//       dumps the hashed text in offset-labelled chunks, both offsets of the old
//       anchor, where each stored limit appears, and every digit-free phrase
//       occurring exactly once — each with offset and percentage.
//
//       On a page this size, start from where 45 and 255 appear close together.
//       That cluster is the table; the run prints the --window command for it.
//
//   2.  READ THE DUMP. Identify the block publishing Card headline 45 and
//       Introductory text 255. Paste the sentences bounding it into QUOTES, set
//       SECTION.from/.to to substrings of those sentences, and put the phrases
//       you are willing to anchor on into CANDIDATES with a `why` each.
//
//   3.  node scripts/migrateFixLinkedInCarouselAnchor.js --verify
//       Re-fetches, asserts every quote, locates the span, prints the
//       in-section verdict for the old anchor, and ranks the candidates.
//
//   4.  node scripts/migrateFixLinkedInCarouselAnchor.js             # dry run
//   5.  node scripts/migrateFixLinkedInCarouselAnchor.js --commit
//
// Steps 3-5 all re-fetch and re-assert. The quote is a claim this file CHECKS,
// never a claim it makes.
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
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[linkedin-carousel-anchor]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');
const DISCOVER = process.argv.includes('--discover');

const URL = 'https://business.linkedin.com/advertise/ads/sponsored-content/carousel-ads/specs';
const DISPLAY = 'LinkedIn – carousel';
const OLD_ANCHOR = 'Card headline';

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
// entities (`&lt;b>`, `&amp;nbsp;`, `&lt;br>`) are LITERAL CHARACTERS in the
// hashed text, not markup — normalize() strips real tags, and escaped source
// survives it. Do not "tidy" them: that would be text this page does not
// contain, and readPage() would refuse on a perfectly healthy page.
//
// QUOTE 1 STOPS BEFORE `text-7023bc0bef`, the CMS element id that follows it in
// the source copy. That is a generated hash: it can change on any republish
// without a single spec changing, so quoting it would make this file's own quote
// check fail on a healthy page.
//
// AND THAT EXCLUSION IS JUDGEMENT, NOT A GATE — the point this file shipped
// making, now with a second instance behind it. The digit-free rule would catch
// `text-7023bc0bef` only by accident, because that hash happens to contain
// digits; `text-d20e36d2fe` on the single-image page was the same accident. An
// all-letter id would sail straight through both. Nothing here mechanically
// excludes a CMS id — the person filling this in does.
const QUOTES = [
  'Text Recommendations &lt;b>Ad name&amp;nbsp;(optional):&amp;nbsp;&lt;/b>255 characters&lt;br>',
  'Ad name (optional): 255 characters Card headline: 45 characters Introductory text: 255 characters Technical Requirements',
];

// THE SECTION, declared. Both markers MUST be substrings of QUOTES above —
// asserted by requireHeaderEvidence(), not trusted.
//
// `from` is the block heading at the top of the SOURCE copy; `to` is the tail of
// the RENDERED copy running into the next heading. So the span covers BOTH
// emissions of the table — which is what makes the in-section verdict on the old
// anchor meaningful, since its two occurrences are one per copy.
const SECTION = {
  name: 'LinkedIn carousel — the text-recommendations block (both copies)',
  from: 'Text Recommendations',
  to: 'characters Technical Requirements',
};

const CANDIDATES = [
  {
    text: 'Text Recommendations',
    why: 'PREFERRED. The heading of the block publishing both of this row\'s stored limits '
      + '(Card headline 45, Introductory text 255). 1x at 8010, digit-free.\n'
      + '      IT DISCRIMINATES WITHIN THIS PAGE: the other headings are "Design '
      + 'Recommendations*", "Technical Requirements" and "URL Requirements", so it belongs to the '
      + 'text block rather than merely to the page. Drop that block and the anchor goes.\n'
      + '      IT DOES NOT DISCRIMINATE BETWEEN AD-FORMAT PAGES — it is the same heading that won '
      + 'on the single-image row, and very likely the same on the video and lead-gen spec pages. '
      + 'See KNOWN RESIDUAL in the header: that gap is recorded rather than closed, because '
      + 'nothing inside this table is specific to Carousel Ads.',
  },
  {
    text: 'characters Technical Requirements &lt;b>Number of carousel',
    why: 'FALLBACK ONLY. 1x at 8381, digit-free, marking the tail of the rendered table running '
      + 'into the Technical Requirements heading.\n'
      + '      WEAKER THAN CANDIDATE 1 because it is a BOUNDARY string: it spans the seam between '
      + 'this block and the next, so it asserts that the join between two sections rendered rather '
      + 'than that the watched table did. It would survive the spec rows being removed so long as '
      + 'the seam remained.\n'
      + '      AND NOTE IT EXTENDS PAST SECTION.to, so the span as declared does not contain it '
      + 'and the run reports it OUT OF SECTION rather than as a ranked fallback. That is the '
      + 'section rule working, not a bug — see the note beside the run output. It is kept here so '
      + 'the refusal is visible rather than the candidate silently disappearing.',
  },
  {
    text: OLD_ANCHOR,
    refusedByDesign: true,
    why: 'REFUSED BY DESIGN — the incumbent. NOT refused for being 2x: both occurrences are '
      + 'inside the watched block (8125 escaped-source, 8329 rendered, 204 chars apart), so it '
      + 'does assert the section rendered and the row is not blind. It is refused because it is '
      + 'the FIELD LABEL of five of this row\'s six watched pairs, which couples the anchor to the '
      + 'thing being watched: rename or restructure that row and a spec event arrives as `failed` '
      + 'rather than `changed`. See THE QUESTION IS RESOLVED in the header, where the measurement '
      + 'and this file\'s original, disproved reading are both recorded.',
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
        + 'carousel-ads/specs for it: the authoring session had no egress and no operator has '
        + 'supplied the text. The block quoted in the header comes from another file\'s reading '
        + 'months ago and is a hypothesis about where to look, not evidence about the page today. '
        + 'Choosing an anchor now would be choosing a string from a page nobody opened, which is '
        + 'the failure scripts/migrateSpecIntegrityFixes.js is the record of.\n'
        + '       Run: node scripts/migrateFixLinkedInCarouselAnchor.js --discover\n'
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
  console.log(`   hashed ${a.length} chars (expected ~20,838)`);
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
    console.log('   ESTABLISHED: both occurrences are IN-SECTION — 8125 escaped-source, 8329');
    console.log('   rendered, 204 chars apart. LinkedIn\'s CMS emits every block twice, so the');
    console.log('   whole table appears twice over. The 2x is an ARTIFACT, not a defect, and the');
    console.log('   row is not blind. If the offsets above are far apart instead, the page has');
    console.log('   been restructured since — re-read THE QUESTION IS RESOLVED in the header.');
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
        console.log(`     node scripts/migrateFixLinkedInCarouselAnchor.js --discover --window=${lo}-${hi}`);
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
  console.log('   THE HEADER IS ALREADY FILLED from a previous --discover run. These steps are');
  console.log('   the REPAIR PROCEDURE if the page is restructured and it has to be re-derived.');
  console.log('   1. Find the block publishing Card headline 45 and Introductory text 255 —');
  console.log('      the stored-limit cluster above points at it.');
  console.log('   2. Paste the sentences bounding it into QUOTES, verbatim.');
  console.log('   3. Set SECTION.from/.to to substrings of those quotes.');
  console.log('   4. Copy the phrases you would anchor on into CANDIDATES, each with a `why`,');
  console.log('      preferring ones INSIDE that block. Offsets above tell you which are.');
  console.log('      Check the BLOCK HEADING and its count: on the single-image page "Text');
  console.log('      Recommendations" was 1x and won. If LinkedIn repeats it per ad format here,');
  console.log('      it is disqualified for the incumbent\'s reason. And a heading shared with');
  console.log('      the sibling spec pages asserts which SECTION of THIS page rendered, not');
  console.log('      which PAGE — that residual is not closable from inside the table.');
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

  // ─── THE OPEN QUESTION, OFFSETS ONLY ─────────────────────────────────────
  // Collected here; the VERDICT is printed once the span exists, further down.
  // An occurrence cannot be called in-section before there is a section.
  const hits = occurrences(a, OLD_ANCHOR);
  console.log(`\n   THE OLD ANCHOR ${JSON.stringify(OLD_ANCHOR)} — ${hits.length}x`);
  console.log(`   ${hits.map((h) => `${h.at} (${h.pct}%)`).join('  ')}`);
  if (hits.length <= 1) {
    console.log('\n   NOTE: NOT repeating on this fetch. The premise this file was written');
    console.log('   against is not reproducing — the page may have been restructured.');
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

  // ─── THE VERDICT THIS RUN EXISTS TO PRODUCE ──────────────────────────────
  // Every occurrence of the old anchor, against the span. This is the whole of
  // THE OPEN QUESTION, printed as a table so the answer cannot read as opinion.
  const anchorHits = hits.map((h) => ({
    ...h, inSection: h.at >= span.start && h.at + OLD_ANCHOR.length <= span.end,
  }));
  console.log(`\n   IS THE ${anchorHits.length}x A CMS ARTIFACT, OR A REAL DEFECT?`);
  for (const h of anchorHits) {
    console.log(`      @${String(h.at).padStart(6)} (${String(h.pct).padStart(5)}%)  `
      + `${h.inSection ? 'IN-SECTION' : 'OUT OF SECTION'}`);
  }
  if (anchorHits.length && anchorHits.every((h) => h.inSection)) {
    console.log('      => ALL IN-SECTION, which CONFIRMS the finding recorded in the header: the');
    console.log('         2x is LinkedIn\'s CMS double emission (escaped source + rendered), not');
    console.log('         the Meta failure mode. The row is not blind, and this change is a');
    console.log('         DECOUPLING — the incumbent is the field label of five watched pairs.');
  } else {
    console.log('      => NOT all in-section. THIS CONTRADICTS THE HEADER, which records both');
    console.log('         occurrences as in-section at 8125 and 8329, measured. Either the page');
    console.log('         has been restructured or SECTION no longer spans both copies of the');
    console.log('         table. Do not proceed on the header\'s account — re-read the page and');
    console.log('         correct THE QUESTION IS RESOLVED before changing any anchor.');
  }

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
