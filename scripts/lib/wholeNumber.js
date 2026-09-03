'use strict';

// Counting a STORED VALUE's occurrences in page text — as a number, not as a
// digit substring.
//
// ─── THE DEFECT THIS EXISTS TO REMOVE ───────────────────────────────────────
// Every value check in scripts/ was written as `hay.split(needle).length - 1`
// or `text.includes(String(n))`, with the needle a NUMBER. Both are substring
// tests, so on the Pinterest help-centre page:
//
//   --verify said            an independent probe of the same normalized text
//   ------------------       ------------------------------------------------
//   100: 16x                 13x  — three of the sixteen were "1000"
//   800:  7x                  7x  — agreed
//   500:  3x  <- UNEXPECTED    0x  — all three were "1500"
//
// The 500 line printed "Re-read the page before writing 800." about a number
// that is not on the page. That is worse than the inflated 100: an alarm that
// fires on a page that is fine teaches its reader to dismiss it, which is the
// same cost the Litmus flags had and the reason source_kind exists.
//
// ─── THE RULE, AND WHY IT IS DIGIT-ADJACENCY RATHER THAN \b ─────────────────
// A hit is a MAXIMAL RUN OF DIGITS equal to the value. Equivalently: the value,
// with no digit immediately before it and no digit immediately after. It is
// implemented by tokenising with /\d+/g and comparing exactly, which cannot be
// got wrong by regex escaping and is the shape scripts/probeSpecPage.js already
// uses (`citesAny`) — the one counter in the repo that was never wrong.
//
// \b was considered and REJECTED, and the case that decides it is on this very
// page. The two rules agree on everything the defect was about:
//
//   "1500 pixel size"        500 → NO   under both
//   "1000 x 1500 pixels"     100 → NO   under both
//   "Enter up to 800 characters."  800 → YES under both
//   "&amp;nbsp;800"          800 → YES under both  (a ';' is a boundary either way)
//
// They disagree on a letter touching a digit, and there the digit rule is right:
//
//   "100MB"                  100 → YES under digit-adjacency, NO under \b
//   "1080x1920"             1080 → YES under digit-adjacency, NO under \b
//
// The 100 in "100MB" IS the number one hundred. It is measuring megabytes rather
// than characters, which is a question about UNITS and not about digits — and
// this counter has never claimed to answer it. Its own call sites describe it as
// "a floor rather than a census … here to catch the strong case: a row watching
// a page that carries none of them", and checkSpecHealth's red is raised only
// when a page contains NONE of a row's numbers.
//
// That asymmetry is what picks the rule. Counting "1000" as 100 makes the
// wrong-page alarm QUIETER — the Meta-index defect, which reported `unchanged`
// for weeks against a page with no character limit on it, is exactly a row whose
// numbers were not really there. Refusing to count "100MB" makes it LOUDER on a
// page that is fine. So the rule errs toward counting a real number and never
// toward counting a digit that happens to sit inside a bigger one. Deciding
// whether a counted hit is the limit we cite is the reader's job, and it always
// was — the neighbouring "N of those sit within 80 chars of the word
// 'character'" line in probeSpecPage is the tool for that, not this.
//
// ─── THE SECOND MEASUREMENT: A GROUPED NUMBER IS NOT ONE RUN ────────────────
// MEASURED IN THE RAILWAY CONSOLE 2026-08-29, on the LinkedIn Conversation Ads
// specs page, and it is the same species as the Pinterest defect arriving from
// the opposite side.
//
// That page publishes "Message Text: 8,000 characters maximum", and normalize()
// keeps the comma — it strips tags and decodes nothing. Tokenising the hashed
// text with /\d+/g therefore returned ZERO occurrences of 8000: the comma splits
// the number into the runs "8" and "000", and A BARE 8000 OCCURS NOWHERE ON THE
// PAGE. checkSpecHealth printed
//
//     numbers   25 ok · 255 ok · 8000 MISSING
//
// every run, about a page that plainly states the limit.
//
// THE MISSING WORD IS THE COSMETIC HALF. The half that decides this rule is that
// the separators MANUFACTURE RUNS THE PAGE NEVER PUBLISHED. The same page carries
// "Custom Footer: 20,000 characters maximum" and "URL characters: 2,000
// characters maximum", so the tokens "8", "20", "2" and "000" are all in the
// stream — and 20 is a real stored limit elsewhere in the library (Meta carousel
// card description). A row watching a WRONG page that happens to carry any
// "…,000" scores "20 ok" off half of a number, and checkSpecHealth's
// `hits.length === 0` red — the wrong-page alarm — is suppressed by it.
//
// That is the alarm getting QUIETER on a wrong page, which is the one direction
// the paragraph above says this rule must never err toward. It is the Meta-index
// defect with a comma for a mechanism.
//
// WHY IT TOOK THIS LONG TO MEET ONE: 8000 IS THE FIRST STORED LIMIT IN THE
// LIBRARY ABOVE 800. Every other value in the seed is three digits or fewer, and
// no publisher writes those with a thousands separator, so twelve callers have
// passed three-digit values against real page text and could not have hit it.
//
// ─── SO THE TEXT IS UN-GROUPED BEFORE TOKENISING ────────────────────────────
// The TEXT side only. assertDigits is untouched: a value carrying a separator is
// still a caller bug and still throws, which is the only reason any of this
// surfaced — see scripts/migrateAddLinkedInConversationAd.js, whose first version
// passed '8,000' in here and got the refusal rather than a silent 0.
//
// A NAIVE REGEX GETS THIS WRONG, and the case is on real repo data. A rule of the
// shape /(\d)[,](\d{3})\b/ rewrites "20,30,280" to "20,30280" and the runs 30 and
// 280 vanish — a RIGHT page reading WRONG. That exact string occurs at
// scripts/migrateAddXSpotlightAndLive.js:340, in a --cited= argument this repo
// prints for a human to paste.
//
// So the rule works on the MAXIMAL comma-joined run and strips only when the run
// is shaped like grouping all the way through: the first group is one to three
// digits and EVERY group after it is exactly three.
//
//   "8,000"        → "8000"      stripped   the case this exists for
//   "1,234,567"    → "1234567"   stripped
//   "20,000"       → "20000"     stripped   and the phantom "20" is gone
//   "20,30,280"    → unchanged              30 is not three digits
//   "18,000"       → "18000"     stripped   and 8000 still does NOT match it,
//                                             so the substring defect this module
//                                             was written to remove cannot return
//                                             through the new path
//   "1,5"          → unchanged              a decimal comma is not grouping
//
// "100,800" IS GENUINELY AMBIGUOUS — a grouped hundred thousand, or two limits in
// a list written without a space — and the rule STRIPS IT. Two reasons, and the
// second is the one that decides it:
//
//   1. Publishers write a list with a space ("100, 800"), which does not match the
//      pattern at all, and write a grouped thousand without one. The no-space list
//      is the rarer shape.
//   2. The two errors are not symmetric, which is this file's standing rule. If
//      "100,800" really was a list, stripping it loses the runs 100 and 800 and
//      the check reports MISSING on a page that is fine — a false alarm on a good
//      page, which is survivable noise. If it really was a grouped number and we
//      left it, the phantom "100" and "800" both stay in the stream and can
//      satisfy a cited limit on a wrong page — which is the silence this whole
//      change is closing. The ambiguity is resolved toward the loud failure.
//
// THE MERGED RUN IS NOT A MANUFACTURED NUMBER. Stripping only ever produces the
// value the page actually published; it never invents a smaller one. So the
// rewrite is monotone in the safe direction — it removes false halves and
// restores true wholes — with the one exception argued above.
//
// SCOPE IS THE COMMA, DELIBERATELY, AND THIS IS NOT AN OVERSIGHT. The other
// grouping separators fail in exactly the same silent way and are NOT handled:
//
//   "8.000"     period          de, es, it, pt-BR
//   "8 000"     thin / narrow no-break space, and U+00A0 — all collapse to a
//               plain space in normalize()'s /\s+/ pass, so they reach here as
//               "8 000"
//   "8&nbsp;000"  the literal entity — normalize() decodes nothing
//   "8'000"     apostrophe       de-CH
//
// NO WATCHED PAGE IS KNOWN TO USE ANY OF THEM. Every spec page on the list today
// is English-language, and the only separator quoted verbatim in any migration
// header is the comma on the LinkedIn Conversation Ads page. That is a statement
// about what has been READ, not about what the pages contain — this repo has no
// egress to those hosts, so a grouped number outside a quoted sentence would not
// be recorded anywhere. If one of these forms ever turns up, it fails silently
// and identically, and the fix is another clause here rather than a new rule
// somewhere else.
//
// ─── NOT A REPLACEMENT FOR count() ──────────────────────────────────────────
// The `count(hay, needle)` helper in these scripts also counts QUOTED SENTENCES
// and ANCHOR STRINGS, where substring matching is exactly right. Only the
// numeric call sites move here. A general "make count() smarter" change would
// have broken every quote check in the repo.

// True when `value` is a string this module can reason about: digits only.
// Anything else is a caller bug rather than a page fact, so it throws rather
// than silently answering 0 — a value check that quietly counts nothing is the
// failure this whole module is about.
function assertDigits(value) {
  const s = String(value);
  if (!/^\d+$/.test(s)) {
    throw new Error(`wholeNumber: expected a digits-only value, got ${JSON.stringify(s)}`);
  }
  return s;
}

// A maximal comma-joined run of digit groups. Maximal because the global scan is
// greedy: "20,30,280" is ONE match rather than three overlapping pairs, which is
// what lets the shape test below see the whole list before deciding.
const COMMA_JOINED_RUN = /\d+(?:,\d+)+/g;

// Undo thousands grouping in PAGE TEXT so a grouped number tokenises as one run.
// See "SO THE TEXT IS UN-GROUPED BEFORE TOKENISING" above for the shape test, the
// "20,30,280" case that rules out the naive regex, how "100,800" is resolved, and
// why the scope is the comma alone.
function ungroupThousands(text) {
  return String(text).replace(COMMA_JOINED_RUN, (run) => {
    const parts = run.split(',');
    // A grouped number's leading group is one to three digits; anything longer is
    // not grouping, so the run is left exactly as the page wrote it.
    if (parts[0].length > 3) return run;
    for (let i = 1; i < parts.length; i += 1) {
      // ONE non-triple anywhere and the whole run is a list, not a number. This
      // is the clause that keeps "20,30,280" intact.
      if (parts[i].length !== 3) return run;
    }
    return parts.join('');
  });
}

// How many times `value` occurs in `text` as a whole number.
function countWholeNumber(text, value) {
  const want = assertDigits(value);
  const runs = ungroupThousands(String(text == null ? '' : text)).match(/\d+/g);
  if (!runs) return 0;
  let n = 0;
  for (const run of runs) if (run === want) n += 1;
  return n;
}

// Does `text` contain `value` as a whole number? The presence half of the same
// question — used by the anchor `holds` tests and by checkSpecHealth.
function hasWholeNumber(text, value) {
  return countWholeNumber(text, value) > 0;
}

module.exports = { countWholeNumber, hasWholeNumber, assertDigits };
