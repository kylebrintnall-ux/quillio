'use strict';

// August 2026 — replace the anchor on the Google – responsive display watch row
// with one scoped to the section its fields actually come from.
//
// Shape copied from scripts/migrateFixXAnchor.js: same ranking, same refusal
// discipline, same unnest-of-two-arrays limit resolution, same inTxn flag. Read
// that file first; the reasoning it records is not repeated here except where
// this row differs, and it differs in two ways that matter.
//
// ─── THE PROBLEM ────────────────────────────────────────────────────────────
// The row anchors on "Responsive display ads", which occurs FIVE TIMES in the
// normalized text of support.google.com/google-ads/answer/17090561.
//
// So the anchor proves A PAGE RENDERED. It says nothing about WHICH SECTION
// rendered. Same defect as "post copy:" on X (9x, once per format block) and
// "Primary Text" on Meta's /image (present on /video and /collection too), and
// the same rule CLAUDE.md records: AN ANCHOR MUST COME FROM THE SECTION THAT
// PUBLISHES THE WATCHED FIELDS. Clean and unique are properties of a STRING;
// in-section is the only one of the three that is a property of the page's
// STRUCTURE, which is what a watch row exists to have an opinion about.
//
// ─── WHY THIS ROW IS HARDER THAN X'S, AND IT IS TWO SEPARATE REASONS ────────
//
// 1. IT IS THE HIGHEST-CHURN ROW ON THE LIST. It was repointed here from
//    answer/7684791 by scripts/migrateFixGoogleSpecSource.js — that URL was
//    "About responsive search ads" and had been set on the Responsive DISPLAY
//    fields, so the citation was wrong while the stored 30/90/90/25 were right.
//    The row has moved twice, most recently within the last week.
//
//    A row that has moved twice is a row whose anchor has been chosen twice
//    against two different pages, and neither choice was made with the
//    in-section rule in hand. It is the row least entitled to the benefit of
//    the doubt, not the most.
//
//    NOTE FOR WHOEVER RUNS THIS: answer/7684791 is now the Responsive SEARCH
//    watch row's URL — the same string left this row and came back as a
//    different row's legitimate citation. If you are reading git history and
//    see that URL leave under "this was the wrong doc" and return later, the
//    second use is correct and is a different row. Nothing is wrong.
//
// 2. THE PAGE IS SMALL. ~5,059 normalized characters against Responsive
//    Search's 18,144 on a sibling Google help page. A short page has fewer
//    distinct phrases, and the four limits this row stores (25, 30, 90, 90) are
//    a large fraction of what is on it — so digit-free, unique, in-section text
//    may simply not exist here.
//
//    THIS FILE DOES NOT ASSUME ONE DOES. --discover exists precisely because
//    the honest first move is to go and look, and "this page cannot be anchored
//    well" is a result this run is allowed to return. See the REFUSAL section.
//
// ─── THE PAGE TEXT — UNFILLED, AND THIS FILE REFUSES TO WRITE UNTIL IT IS ───
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ QUOTES and SECTION below are EMPTY. That is deliberate and it is the      │
// │ single most important thing about this file.                             │
// │                                                                          │
// │ The session that authored it could not reach support.google.com — the     │
// │ egress proxy answers 403 to CONNECT — and no operator supplied the page   │
// │ text either. So there is NO reading of this page behind this file, by     │
// │ anyone.                                                                  │
// │                                                                          │
// │ CLAUDE.md's most expensive rule is that a spec change quotes the page it  │
// │ fetched, in the same change, so the next reader can check the claim       │
// │ without leaving the file. scripts/migrateSpecIntegrityFixes.js is what    │
// │ happens when that rule is skipped: every cell in it was a REASONED        │
// │ number, internally consistent, peer-reviewable, and wrong, because not    │
// │ one was READ. Writing plausible Google help-page sentences into this      │
// │ header would be that failure exactly, with a fresh coat on.               │
// │                                                                          │
// │ An anchor is not a spec value, but it is a claim about what is on a page, │
// │ and it fails the same way: silently, in the reassuring direction.         │
// │                                                                          │
// │ So the header carries no quote rather than an invented one, and           │
// │ requireHeaderEvidence() below turns that absence into a refusal instead   │
// │ of a default.                                                            │
// └──────────────────────────────────────────────────────────────────────────┘
//
// TO FILL IT IN — this is the whole workflow, and step 1 is a real step:
//
//   1.  node scripts/migrateFixGoogleDisplayAnchor.js --discover
//       Fetches the page through the DETECTOR'S OWN fetchText + hashableText,
//       twice, and dumps: the full hashed text in offset-labelled chunks, every
//       occurrence of the old anchor, where each stored limit appears, and every
//       digit-free phrase that occurs exactly once — each with its character
//       offset and percentage into the document. Writes nothing and needs no
//       section, because at that point there is no section to have.
//
//   2.  READ THE DUMP. Identify the responsive-display block — the one
//       publishing Business Name 25, Description 90, Long Headline 90, Short
//       Headline 30. Paste the sentences that bound it into QUOTES, set
//       SECTION.from/.to to substrings of those sentences, and put the phrases
//       you are willing to anchor on into CANDIDATES with a `why` each.
//
//   3.  node scripts/migrateFixGoogleDisplayAnchor.js --verify
//       Re-fetches and asserts every quote is present, the section is locatable
//       and ordered, and the chosen candidate is unique, digit-free and inside
//       the span. Writes nothing.
//
//   4.  node scripts/migrateFixGoogleDisplayAnchor.js            (dry run)
//   5.  node scripts/migrateFixGoogleDisplayAnchor.js --commit
//
// Steps 3–5 all re-fetch and re-assert. The quote in the header is a claim this
// file CHECKS on every run, never a claim it makes — which is what makes an
// operator-supplied reading acceptable provenance, exactly as in
// scripts/migrateFixXAnchor.js.
//
// ─── THE SECTION IS DECLARED, NEVER INFERRED ────────────────────────────────
// An explicit from/to marker pair, per scripts/migrateAddGoogleVideoAssets.js,
// and BOTH MARKERS MUST BE SUBSTRINGS OF QUOTES — asserted, not trusted. That
// check is the point: it makes the span out of text somebody read, rather than
// out of page text nobody looked at. Inferring which table a sentence belongs to
// FROM the sentence is the guess that produced the Google in-feed-video
// near-miss, on this same help-centre domain.
//
// A MISSING OR UNLOCATABLE SECTION MAKES NOTHING ELIGIBLE. Fail closed, the same
// axis as TENANT_EDITABLE_TIERS.
//
// ─── ANCHOR SELECTION, RANKED ───────────────────────────────────────────────
//   1. clean and in-section          — no digit anywhere in the text. Ideal.
//   2. in-section, holds a limit     — REFUSED ON THIS ROW. See below.
//   3. clean but OUT of section      — REFUSED. That is the defect being fixed.
//
// Every candidate is printed with its verdict and the reason it lost, including
// refused ones. A rejection recorded only in a commit message gets re-proposed
// by the next person who notices how clean the string is.
//
// ─── DIGIT-FREE IS A HARDER BAR THAN "HOLDS NO STORED LIMIT", ON PURPOSE ────
// scripts/migrateFixXAnchor.js refuses a candidate holding a STORED LIMIT.
// This file refuses a candidate containing ANY DIGIT AT ALL, which strictly
// subsumes that, and the extra width is doing real work on this page:
//
//   • answer/17090561 is an ads-specs page, so it carries pixel dimensions,
//     aspect ratios, file-size caps and image counts. A run like "1200" or
//     "1.91" is not a stored limit today, so a stored-limit test passes it —
//     and Google revising a recommended image width would then report `failed`,
//     a broken-page alarm for an event that is not a broken page.
//   • help.google.com pages carry "Last updated" style furniture and article
//     ids. A date in an anchor guarantees a false failure on a schedule.
//   • normalize() deletes every run of 12+ digits (the zwieback strip), so a
//     candidate containing a long digit run would be asserted against text the
//     detector has already altered. Digit-free sidesteps that interaction
//     entirely rather than reasoning about where the boundary falls.
//
// Both gates are implemented and both are printed, even though the first
// subsumes the second, because they answer different questions and a reader
// should see each answered: "does this contain a number at all" and "does this
// contain one of OUR numbers".
//
// ─── OPTION 2, AND THE ARITHMETIC IS RECOMPUTED LIVE ────────────────────────
// An anchor holding limit X converts a MOVE on X from `changed` into `failed`.
// Whether that is survivable is decided BY THE OTHER ROWS, not by this one, and
// scripts/migrateAddGoogleVideoAssets.js's header says that argument HAS TO BE
// REDONE rather than inherited — it depends on which pages are watched and what
// their anchors are RIGHT NOW, and nothing recomputes it.
//
// So this run derives it against the live database every time, via soleWitness()
// below. NOTHING IN THIS HEADER IS TRUSTED FOR IT.
//
// What the run is expected to show, stated as a PREDICTION to be checked rather
// than as a fact: 25, 30 and 90 each appear on several watched Google pages
// (responsive search answer/7684791, Performance Max answer/17091269, Demand Gen
// video answer/17091270), and all three of those rows carry digit-free anchors —
// so a move on any of this row's limits should still reach the queue from
// elsewhere. If that holds, this row is NOT a sole witness to any of its stored
// values, and option 2 would be more survivable here than it was for X.
//
// IT IS STILL REFUSED. Two reasons, and the second is the load-bearing one:
//   • the digit-free rule above already excludes every such candidate, so
//     permitting option 2 would mean relaxing the wider rule to reach it;
//   • "another watched page also publishes this integer" is exactly the
//     inference migrateFixXAnchor warns about — a second page carrying the same
//     number is a second instrument only if it watches the page THIS row's
//     fields are cited to. For a move in GOOGLE'S DISPLAY limit specifically,
//     the display page is the only witness, whatever the integer arithmetic says.
// The run prints the arithmetic so the day somebody wants to relax this, the
// evidence is on screen rather than in a paragraph.
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
// not an anchor swap — swapping the anchor first would hide the problem. Do not
// add a marker on the strength of having seen a nonce in the raw HTML;
// normalize() strips <script> and its contents already.
//
// ─── ORDERING ───────────────────────────────────────────────────────────────
// Same deviation as migrateFixXAnchor.js and migrateFixMetaImageAnchor.js, for
// the same reason: the stored limits and affected pairs live ON THE ROW and the
// anchor choice depends on them, so the database is opened and read BEFORE the
// page is fetched. Nothing is written until every check passes, and no
// transaction is opened until then. Named here rather than left to be noticed.
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
// The run says so and exits non-zero.
//
//   node scripts/migrateFixGoogleDisplayAnchor.js --discover  # fetch + dump
//   node scripts/migrateFixGoogleDisplayAnchor.js --verify    # fetch + measure
//   node scripts/migrateFixGoogleDisplayAnchor.js             # dry run (ROLLBACK)
//   node scripts/migrateFixGoogleDisplayAnchor.js --commit    # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[google-display-anchor]';
const COMMIT = process.argv.includes('--commit');
const VERIFY = process.argv.includes('--verify');
const DISCOVER = process.argv.includes('--discover');

const URL = 'https://support.google.com/google-ads/answer/17090561';
const DISPLAY = 'Google – responsive display';
const OLD_ANCHOR = 'Responsive display ads';

// ─── UNFILLED. See the boxed note in the header. ────────────────────────────
//
// Every sentence this file quotes, asserted against the fetched page before
// anything is written. Fill from --discover output, verbatim, including
// punctuation and spacing as normalize() leaves it.
const QUOTES = [];

// THE SECTION, declared. Both markers MUST be substrings of QUOTES above —
// asserted by requireHeaderEvidence(), not trusted.
//
//   { name: 'Responsive display ads — the text-asset table this row stores',
//     from: '<substring of a QUOTE that opens the block>',
//     to:   '<substring of a QUOTE that closes it>' }
const SECTION = null;

// CANDIDATES IN PREFERENCE ORDER, filled from --discover.
//
// The old anchor is recorded here so every run prints it being refused and says
// why — the same reason migrateFixXAnchor keeps 'Creative ad specs' in its list.
// It is NOT eligible: `refusedByDesign` bars it from ever being chosen even if
// the page changed such that it became unique and in-section.
const CANDIDATES = [
  {
    text: OLD_ANCHOR,
    refusedByDesign: true,
    why: 'REFUSED BY DESIGN — the incumbent. Occurs 5x, which proves the page rendered and not '
      + 'which section did. Kept in the list so every run shows it losing rather than having it '
      + 'silently disappear; a reader who finds it gone will wonder whether it was considered.',
  },
];

// ─── helpers ────────────────────────────────────────────────────────────────

// A unix-socket connection is local by construction and never speaks SSL.
function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function count(hay, needle) {
  if (!needle) return 0;
  return String(hay).split(needle).length - 1;
}

// Every occurrence of a needle, as a character offset and as a percentage of the
// document. The percentage is what makes "five times" legible: five hits spread
// from 3% to 88% is a heading repeated per section, which is the thing being
// claimed about the old anchor.
function occurrences(hay, needle) {
  const out = [];
  if (!needle) return out;
  let i = String(hay).indexOf(needle);
  while (i >= 0) {
    out.push({ at: i, pct: hay.length ? Math.round((i / hay.length) * 1000) / 10 : 0 });
    i = String(hay).indexOf(needle, i + needle.length);
  }
  return out;
}

// ANY digit, not just a stored limit. See the header for why the wider bar.
function hasDigit(s) {
  return /\d/.test(String(s));
}

function sectionSpan(text, section) {
  if (!section || !section.from || !section.to) return null;
  const start = text.indexOf(section.from);
  if (start < 0) return null;
  const end = text.indexOf(section.to, start);
  if (end < 0) return null;
  return { start, end: end + section.to.length };
}

function rejectionReason(c, span, chosen) {
  if (c.refusedByDesign) return 'REFUSED BY DESIGN — recorded here to be shown losing, never eligible';
  if (c.count === 0) return 'ABSENT — an anchor that never matches reports `failed` every week';
  if (!c.unique) return `${c.count}x — not unique, so it says nothing about WHICH section rendered`;
  if (!span) return 'NO SECTION SPAN — the markers are not on this page, so nothing is in-section';
  if (!c.inSection) {
    return c.clean
      ? 'OUT OF SECTION — clean and unique, and REFUSED anyway: it proves a page rendered, not '
        + 'that the watched section did'
      : 'OUT OF SECTION';
  }
  if (c.digits) {
    return `in-section and unique, but CONTAINS DIGITS (${c.digits.join(', ')})`
      + `${c.holds.length ? ` including stored limit(s) ${c.holds.join(', ')}` : ''}`
      + ' — a number in an anchor turns a spec revision into a broken-page report';
  }
  if (chosen && chosen.clean && !c.clean) {
    return 'a clean in-section candidate ranked above it';
  }
  return 'in-section and eligible — a candidate ranked above it';
}

// THE ANCHOR CHOICE, pure so a test drives the same code the migration does.
// Same ranking as scripts/migrateFixXAnchor.js and
// scripts/migrateAddGoogleVideoAssets.js, with `clean` tightened from "holds no
// stored limit" to "contains no digit at all".
function chooseAnchor(text, candidates, limits, section) {
  const span = sectionSpan(text, section);
  const seen = candidates.map((c) => {
    const n = count(text, c.text);
    const at = text.indexOf(c.text);
    const digits = String(c.text).match(/\d+/g) || [];
    const holds = limits.filter((v) => String(c.text).includes(v));
    const unique = n === 1;
    const inSection = !!span && at >= 0 && at >= span.start && at + c.text.length <= span.end;
    return {
      ...c,
      count: n,
      at,
      pct: text.length && at >= 0 ? Math.round((at / text.length) * 1000) / 10 : null,
      digits,
      holds,
      unique,
      inSection,
      // CLEAN means digit-free here, which strictly subsumes "holds no stored
      // limit". Both are carried so the output can report each separately.
      clean: unique && digits.length === 0,
      eligible: !c.refusedByDesign && unique && inSection && digits.length === 0,
    };
  });
  // NOTE THE ASYMMETRY WITH migrateFixXAnchor: there, `eligible` allowed a
  // digit-bearing in-section candidate through so option 2 could be considered
  // and then refused with its cost stated. Here digit-free is a precondition of
  // eligibility, so option 2 cannot be selected at all — see the header. A
  // digit-bearing in-section candidate is still SHOWN, with its numbers named.
  const chosen = seen.find((c) => c.eligible) || null;
  for (const c of seen) c.reason = c === chosen ? null : rejectionReason(c, span, chosen);
  const tier = chosen ? '1 — clean (digit-free) and in-section' : null;
  return { chosen, seen, span, tier };
}

// ─── the unfilled-header gate ───────────────────────────────────────────────
// The absence of page text is turned into a refusal rather than a default.
// Returns { ok, why }.
function requireHeaderEvidence() {
  if (!Array.isArray(QUOTES) || QUOTES.length === 0) {
    return {
      ok: false,
      why: 'QUOTES is empty — no reading of this page stands behind this file. Nobody has fetched '
        + 'answer/17090561 for it: the authoring session had no egress and no operator supplied the '
        + 'text. Writing an anchor now would be choosing a string from a page nobody opened, which is '
        + 'the failure scripts/migrateSpecIntegrityFixes.js is the record of.\n'
        + `       Run: node scripts/migrateFixGoogleDisplayAnchor.js --discover\n`
        + '       then fill QUOTES, SECTION and CANDIDATES from what it prints.',
    };
  }
  if (!SECTION || !SECTION.from || !SECTION.to) {
    return {
      ok: false,
      why: 'SECTION is unset. Without a declared span nothing can be in-section, and "clean and '
        + 'unique" alone is the defect this migration exists to fix.',
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
// WHY GENERATE RATHER THAN HAND-WRITE, on this row specifically: the page is
// ~5,059 chars and the header's whole premise is that a good anchor may not
// exist here. A hand-written list of four strings cannot establish absence; an
// exhaustive sweep of every digit-free unique phrase can. If this prints
// nothing, that IS the finding.
const MIN_WORDS = 6;
const MAX_WORDS = 16;
const MIN_CHARS = 34;
const MAX_CHARS = 140;

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
  //    of the page and are not separate choices — on an 821-char fixture the raw
  //    sweep produced 92 candidates covering about eleven distinct places. Walk
  //    left to right and skip past each one taken, so what prints is one
  //    candidate per REGION and the count means something.
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

function chunkDump(text, size) {
  const lines = [];
  for (let i = 0; i < text.length; i += size) {
    const pct = Math.round((i / text.length) * 1000) / 10;
    lines.push(`   [${String(i).padStart(5)}  ${String(pct).padStart(5)}%]  ${text.slice(i, i + size)}`);
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
  console.log(`   hashed ${a.length} chars`);
  const stable = a === b;
  console.log(`   across two fetches, 3s apart: ${stable ? 'STABLE' : 'VARIES'}`);
  if (a.length < 1200) {
    console.log('   WARNING: under 1,200 chars. checkSpecHealth treats <200 as a JS shell; this is');
    console.log('   short enough to be worth confirming the page rendered before anchoring to it.');
  }
  return stable;
}

const VARIES_WHY = 'the two fetches disagree. Something outside <script> varies per request, so this '
  + 'row needs a content_stop_marker before any anchor can be trusted — that is a different '
  + 'migration, and swapping the anchor first would hide the problem.';

async function runDiscover(limits) {
  console.log(`\n${'='.repeat(74)}\nDISCOVER — ${DISPLAY}\n${URL}\n${'='.repeat(74)}`);
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
  if (hits.length <= 1) {
    console.log('   NOTE: NOT repeating on this fetch. The premise of this change is not reproducing —');
    console.log('   the page may have been restructured. Re-read the header before trusting it.');
  }

  if (limits && limits.length) {
    console.log(`\n   STORED LIMITS ON THIS ROW: ${limits.join(', ')}`);
    for (const n of limits) {
      const o = occurrences(a, n);
      console.log(`   value ${String(n).padEnd(4)} ${String(o.length).padStart(3)}x  `
        + o.map((h) => `${h.pct}%`).join(' '));
    }
  }

  console.log(`\n${'─'.repeat(74)}\nTHE HASHED TEXT, in 100-char chunks with offsets\n${'─'.repeat(74)}`);
  for (const line of chunkDump(a, 100)) console.log(line);

  const cands = generateCandidates(a);
  console.log(`\n${'─'.repeat(74)}\nDIGIT-FREE PHRASES OCCURRING EXACTLY ONCE — ${cands.length} found`
    + `\n${'─'.repeat(74)}`);
  if (cands.length === 0) {
    console.log('   NONE. Every unique phrase on this page of between');
    console.log(`   ${MIN_WORDS}-${MAX_WORDS} words / ${MIN_CHARS}-${MAX_CHARS} chars contains a digit.`);
    console.log('');
    console.log('   THAT IS THE FINDING, and it is a legitimate one: this page may not be');
    console.log('   anchorable to the standard this file requires. Do not lower the bar to');
    console.log('   manufacture a candidate. The options are, in order:');
    console.log('     • widen MIN/MAX_WORDS here and re-run, if the window was simply wrong;');
    console.log('     • anchor on a digit-free phrase shorter or longer than the window;');
    console.log('     • decide deliberately that a digit-bearing anchor is worth its cost, and');
    console.log('       record that decision IN THIS FILE before relaxing the gate;');
    console.log('     • leave the row on its 5x anchor and log the gap, which is honest.');
  } else {
    for (const c of cands) {
      const pct = Math.round((c.at / a.length) * 1000) / 10;
      console.log(`   [${String(c.at).padStart(5)}  ${String(pct).padStart(5)}%]  ${JSON.stringify(c.text)}`);
    }
  }

  console.log(`\n${'─'.repeat(74)}\nNEXT\n${'─'.repeat(74)}`);
  console.log('   1. Find the responsive-display text-asset block in the chunk dump above');
  console.log('      (Business Name 25, Description 90, Long Headline 90, Short Headline 30).');
  console.log('   2. Paste the sentences bounding it into QUOTES, verbatim.');
  console.log('   3. Set SECTION.from/.to to substrings of those quotes.');
  console.log('   4. Copy the phrases you would anchor on into CANDIDATES, each with a `why`,');
  console.log('      preferring ones INSIDE that block. Offsets above tell you which are.');
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
  // rests on. Same argument as scripts/migrateFixXAnchor.js.
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
  console.log(`   ${hits.map((h) => `${h.pct}%`).join('  ')}`);
  console.log('   An anchor matching in several places proves A PAGE rendered and says nothing about');
  console.log('   WHICH section did — so dropping the responsive-display block would leave the other');
  console.log('   matches and a healthy-looking row.');
  if (hits.length <= 1) {
    console.log('\n   NOTE: the old anchor is NOT repeating on this fetch. The premise of this change');
    console.log('   is not reproducing — the page may have been restructured. Re-read the header.');
  }

  console.log(`\n   STORED LIMITS ON THIS ROW: ${limits.join(', ')}`);
  for (const n of limits) console.log(`   value ${n}: ${count(a, n)}x in the hashed text`);

  const { chosen, seen, span, tier } = chooseAnchor(a, CANDIDATES, limits, SECTION);

  console.log(`\n   SECTION  ${SECTION.name}`);
  if (!span) {
    console.log(`      NOT LOCATED — from ${JSON.stringify(String(SECTION.from).slice(0, 46))}`);
    console.log(`                     to ${JSON.stringify(String(SECTION.to).slice(0, 46))}`);
    return {
      ok: false,
      why: 'the responsive-display section could not be located. Both markers are substrings of '
        + 'sentences quoted in this file, so if the quote check passed and this did not, the two '
        + 'markers are no longer adjacent or are out of order — the page has been restructured and '
        + 'the section must be re-read before anything is anchored to it.',
    };
  }
  console.log(`      chars ${span.start}–${span.end} of ${a.length} (${span.end - span.start} chars,`
    + ` ${Math.round((span.start / a.length) * 1000) / 10}% into the document)`);

  console.log('\n   ANCHOR CANDIDATES, in preference order:');
  for (const c of seen) {
    const mark = c === chosen ? '=>' : '  ';
    const where = c.count === 0 ? '—' : c.inSection ? 'in-section' : 'OUT';
    const at = c.at >= 0 ? `@${c.at} (${c.pct}%)` : '@—';
    const digitCol = c.digits.length ? `digits ${c.digits.join('/')}` : 'digit-free';
    console.log(`   ${mark} ${String(c.count)}x  ${where.padEnd(10)} ${at.padEnd(15)} ${digitCol.padEnd(16)}`
      + ` ${JSON.stringify(c.text.slice(0, 44))}${c.text.length > 44 ? '…' : ''}`);
    if (c.holds.length) console.log(`         holds STORED limit(s): ${c.holds.join(', ')}`);
    if (c.reason) console.log(`         rejected: ${c.reason}`);
  }

  if (!chosen) {
    const cleanOutside = seen.find((c) => !c.refusedByDesign && c.clean && !c.inSection);
    if (cleanOutside) {
      console.log(`\n   NAMING THE REFUSED CANDIDATE: ${JSON.stringify(cleanOutside.text)}`);
      console.log('   Digit-free, unique, and OUT OF SECTION — which is the defect this migration');
      console.log('   exists to fix. Refused rather than taken.');
    }
    const digitInside = seen.find((c) => !c.refusedByDesign && c.unique && c.inSection && c.digits.length);
    if (digitInside) {
      console.log(`\n   NAMING THE REFUSED CANDIDATE: ${JSON.stringify(digitInside.text)}`);
      console.log(`   In-section and unique, and it carries ${digitInside.digits.join(', ')}`);
      console.log('   — so a Google revision to any of those numbers would arrive as `failed`, a');
      console.log('   broken-page alarm for an event that is not a broken page. Refused. See the');
      console.log('   header before deciding a noisy signal beats none.');
    }
    return {
      ok: false,
      why: 'no candidate is digit-free, unique AND in-section. Nothing is eligible. A clean '
        + 'out-of-section string is not a substitute, and neither is an in-section string carrying '
        + 'a number. If the page genuinely cannot carry one, that is the finding — record it and '
        + 'leave the row as it is rather than installing something weaker.',
    };
  }

  console.log(`\n   CHOSEN — tier ${tier}`);
  console.log(`      ${JSON.stringify(chosen.text)}`);
  console.log(`      at char ${chosen.at} (${chosen.pct}% into the document), inside the section span`);
  console.log(`      ${chosen.why}`);

  return { ok: true, anchor: chosen.text, tier };
}

// ─── the stored limits behind this row's gate ───────────────────────────────
//
// UNNEST OF TWO PARALLEL ARRAYS, joined as a set — NOT a multidimensional ANY.
// The shape that does not work, kept because it looks correct:
//
//   WHERE (at.name, cf.field_name) = ANY($1::text[][])
//
// `(at.name, cf.field_name)` is a ROW CONSTRUCTOR. `ANY` over an array iterates
// that array's ELEMENTS, and the elements of a text[][] are TEXT SCALARS —
// Postgres multidimensional arrays are rectangular, not nested. So the
// comparison is record = text and Postgres answers
// `operator does not exist: record = text`. It is not a cast away from correct;
// ANY cannot iterate rows of a 2-D array at all.
//
// With unnest the tuple structure lives in the FROM clause where Postgres can
// see it, and the parameters are visibly the two columns.
//
// AND IT CARRIES `at.is_active`, matching specReview.currentValues and
// scripts/rederiveAffectedFields.js. affected_fields is a frozen snapshot that
// outlives asset retirement, so a pair can name an asset nothing renders any
// more. A retired asset's limit is not "in play" for an anchor decision, and
// including it would put a number in the sole-witness arithmetic that no
// document has carried for months.
const LIMITS_SQL = `
  SELECT at.name AS asset, cf.field_name AS field, cf.char_min, cf.char_max, cf.spec_type
    FROM unnest($1::text[], $2::text[]) AS want(asset, field)
    JOIN asset_types at ON at.name = want.asset AND at.is_active
    JOIN copy_fields cf ON cf.asset_type_id = at.id AND cf.field_name = want.field
   GROUP BY 1, 2, 3, 4, 5
   ORDER BY 1, 2`;

// Pure but for the one query, and exported so a test drives the same SQL and the
// same parameter construction the migration does rather than restating them.
async function resolveStoredLimits(runner, pairs) {
  const list = Array.isArray(pairs) ? pairs : [];
  const res = await runner.query(LIMITS_SQL, [
    list.map((p) => p.asset),
    list.map((p) => p.field),
  ]);
  const rows = (res && res.rows) || [];
  // char_max 0 is NO LIMIT everywhere else in this codebase, so it is not a
  // value an anchor could hold and does not belong in the arithmetic.
  const limits = [...new Set(rows.map((r) => String(r.char_max)).filter((v) => v && v !== '0'))]
    .sort((x, y) => Number(x) - Number(y));
  return { rows, limits };
}

// ─── the sole-witness arithmetic, recomputed live ───────────────────────────
// The header states a PREDICTION about which other rows would report a move on
// each stored limit. That argument depends on which pages are watched and what
// their anchors are RIGHT NOW, and nothing recomputes it — the same staleness
// class as affected_fields. So it is derived here, against the live database,
// every run, and the header is not trusted for it.
async function soleWitness(client, rowId, limits) {
  console.log(`\n${'─'.repeat(74)}\nSOLE WITNESS — who else would see a move on each stored limit\n${'─'.repeat(74)}`);
  const verdicts = [];
  for (const v of limits) {
    const rows = await client.query(
      `SELECT cf.spec_source,
              COUNT(*)::int AS fields,
              MAX(w.id) AS watch_id,
              MAX(w.expected_content) AS watch_anchor
         FROM copy_fields cf
         LEFT JOIN spec_watch_list w ON w.source_url = cf.spec_source
        WHERE cf.char_max = $1
        GROUP BY cf.spec_source
        ORDER BY 2 DESC`,
      [Number(v)]
    );
    console.log(`\n   ${v} is stored by ${rows.rows.reduce((n, r) => n + r.fields, 0)} copy_fields row(s):`);
    for (const r of rows.rows) {
      const watched = r.watch_id ? `watch #${r.watch_id}` : 'NOT WATCHED';
      const holds = r.watch_anchor && String(r.watch_anchor).includes(v) ? '  <- its anchor HOLDS this value' : '';
      const self = r.watch_id === rowId ? '  (this row)' : '';
      console.log(`      x${String(r.fields).padStart(3)}  ${watched.padEnd(14)} ${r.spec_source}${self}${holds}`);
    }
    const others = rows.rows.filter((r) => r.watch_id && r.watch_id !== rowId
      && !(r.watch_anchor && String(r.watch_anchor).includes(v)));
    verdicts.push({ value: v, others: others.length });
    console.log(`      => ${others.length === 0
      ? 'NO other watched row would report a move on this value. THIS ROW IS THE SOLE WITNESS.'
      : `${others.length} other watched row(s) would also report a move on this VALUE.`}`);
    if (others.length > 0) {
      console.log('         Read that carefully: another platform publishing the same integer is a');
      console.log('         coincidence, not a second instrument. It only counts if it watches the');
      console.log('         page THIS row\'s fields are cited to — and for a move in GOOGLE\'S');
      console.log('         DISPLAY limit, this page is the only one that publishes it.');
    }
  }
  return verdicts;
}

// ─── main ───────────────────────────────────────────────────────────────────

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
  //
  // scripts/migrateFixXAnchor.js and scripts/migrateFixMetaImageAnchor.js carry
  // this same flag. Any future migration built on any of the three should carry
  // it rather than the unconditional ROLLBACK.
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
          ? 'Check scripts/migrateFixGoogleSpecSource.js — that migration repointed this row here '
            + 'from answer/7684791, and this file assumes it has run.'
          : 'Two rows on one URL is a state no migration creates; resolve it before changing an anchor.')
      );
    }
    const row = found.rows[0];

    // THE PAIRS, READ OFF THE ROW. Never hardcoded: affected_fields is the write
    // gate, and a list typed into this file could describe a gate that has since
    // been re-derived.
    const pairs = Array.isArray(row.affected_fields) ? row.affected_fields : [];
    console.log(`\n${TAG} affected_fields on the row — ${pairs.length} pair(s):`);
    for (const p of pairs) console.log(`    ${p.asset} || ${p.field}`);
    if (pairs.length === 0) {
      throw new Error('affected_fields is empty. This row gates nothing, and an anchor swap is not the problem to solve first.');
    }

    // THE STORED LIMITS, CONFIRMED AGAINST copy_fields IN THE SAME RUN. The
    // anchor choice depends on which values are in play, so they are read rather
    // than believed — the header predicts 25/30/90 and this is what checks it.
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

// UNIT TESTS ONLY. chooseAnchor, sectionSpan, generateCandidates and
// requireHeaderEvidence are the properties this change rests on, exported so a
// test drives the same code the migration does rather than reimplementing the
// ranking beside it.
module.exports = {
  chooseAnchor, sectionSpan, occurrences, hasDigit, generateCandidates,
  requireHeaderEvidence, resolveStoredLimits, LIMITS_SQL,
  CANDIDATES, SECTION, QUOTES, OLD_ANCHOR, URL, DISPLAY,
};
