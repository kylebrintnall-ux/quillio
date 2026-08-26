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

// How many times `value` occurs in `text` as a whole number.
function countWholeNumber(text, value) {
  const want = assertDigits(value);
  const runs = String(text == null ? '' : text).match(/\d+/g);
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
