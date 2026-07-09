'use strict';

// File-naming convention (§3) — pure preview of the naming logic (no creds/DB).
// Shows how a pattern's static text is preserved verbatim and dynamic spans fill
// from sample data. Also demonstrates segmentsFromSpans (the select-a-span core).
//
// Usage:  node scripts/previewNamingPattern.js

const {
  SAMPLE_NAMING_PATTERN,
  applyNamingPattern,
  segmentsFromSpans,
} = require('../src/destinations/docNaming');

const ctx = {
  campaign: 'State of Support 2026',
  date: '2026-07-07',
  year: '2026',
  version: 'v1',
  writer: 'Kyle Brintnall',
};

console.log('\nSeed pattern segments:');
console.log(JSON.stringify(SAMPLE_NAMING_PATTERN.segments, null, 2));
console.log('\nFilled filename:');
console.log('  ' + applyNamingPattern(SAMPLE_NAMING_PATTERN, ctx));

// Demonstrate the select-a-span core on the worked example: the user typed the
// whole string and selected "State of Service 2026" (chars 5..26) as Campaign.
const typed = 'SVC: State of Service 2026_ Promo Copy';
const spans = [{ start: 5, end: 26, token: 'campaign' }];
console.log('\nsegmentsFromSpans("' + typed + '", select "' + typed.slice(5, 26) + '" -> campaign):');
console.log(JSON.stringify(segmentsFromSpans(typed, spans), null, 2));
console.log('  -> ' + applyNamingPattern({ segments: segmentsFromSpans(typed, spans) }, ctx) + '\n');
