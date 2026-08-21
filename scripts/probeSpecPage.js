'use strict';

// READ-ONLY candidate-page probe for LiveSpecs. Takes one or more URLs on argv
// and prints a report per URL.
//
// It NEVER writes to the database, never writes to disk, and never touches a
// watch row. It does not require DATABASE_URL and does not load `pg`. A test
// asserts it imports nothing from src/db. This is a diagnostic and nothing else.
//
//   node scripts/probeSpecPage.js <url> [url …]
//
// Run in the Railway console as plain node — never `railway run`.
//
// ─── WHY IT IMPORTS THE DETECTOR'S OWN FUNCTIONS ────────────────────────────
// normalize, truncateAtMarker and hashableText come from
// src/services/specDetector — the module scripts/runDetection.js drives. They
// are NOT reimplemented here, and that is the whole point: a probe that
// normalizes differently from the detector measures a different string, so
// every number it reports would be about a page the detector never sees. This
// project has already paid for that class of error once, in a measurement rig
// whose shim implemented only the success path.
//
// If any of them cannot be resolved this exits non-zero naming which, rather
// than falling back to a local copy.
//
// ─── WHY IT DOES ITS OWN FETCH ──────────────────────────────────────────────
// The detector's fetchText throws on a non-2xx and returns only the body, so it
// cannot report an HTTP status — and the status belongs at the top of every
// report, because a 200 that is not the page is the failure the anchor feature
// exists for.
//
// THE MITIGATION COVERS TWO PROPERTIES OF A FETCH THAT HAS MORE THAN TWO, and
// saying so is the point. A smoke test asserts the User-Agent and the timeout
// match the detector's source. It does NOT assert redirect handling, accept-
// encoding, cookie or referer policy, or retry behaviour — every one of which
// this file now implements independently of fetchText.
//
// What makes that survivable rather than a hole: BOTH call sites pass the same
// two keys and nothing else — { signal, headers } — so today the option sets are
// not merely similar, they are identical, and the runtime's defaults govern the
// rest for both. A second test asserts fetchText passes NO other key, so the day
// somebody adds `redirect: 'manual'` to the detector it goes red here rather
// than in a report that quietly disagrees with production.
//
// If the two ever do diverge, the consequence is specific: the probe can propose
// an anchor for a page the detector reads differently, or report a page
// unreachable that the detector reaches. Both are the wrong-number-that-looks-
// like-a-result shape.
//
// ─── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
// Stated at the foot of every report as well as here, because a tool that
// measures one property makes the others feel covered:
//   • it cannot tell whether the page's numbers are CORRECT
//   • it cannot tell whether this is the AUTHORITATIVE page for that platform
//   • STABLE is the absence of one failure mode, not proof of stability

const TAG = '[probe-spec-page]';

// --- the detector's own helpers, resolved and checked ------------------------
let detector;
try {
  detector = require('../src/services/specDetector');
} catch (err) {
  console.error(`${TAG} could not load src/services/specDetector: ${err.message}`);
  console.error(`${TAG} a probe that normalizes differently from the detector measures the wrong thing.`);
  process.exit(1);
}

const REQUIRED = ['normalize', 'truncateAtMarker', 'hashableText', 'hashText'];
const absent = REQUIRED.filter((n) => typeof detector[n] !== 'function');
if (absent.length) {
  for (const n of absent) {
    console.error(`${TAG} src/services/specDetector does not export ${n}() — cannot continue.`);
  }
  console.error(`${TAG} Missing: ${absent.join(', ')}.`);
  console.error(`${TAG} These are deliberately NOT reimplemented here. A probe that normalizes,`);
  console.error(`${TAG} truncates or hashes differently from the detector measures a different`);
  console.error(`${TAG} string, so every number it reports would be about a page the detector`);
  console.error(`${TAG} never sees. Fix the export rather than adding a local copy.`);
  process.exit(1);
}

const { normalize, truncateAtMarker, hashableText, hashText } = detector;

// The detector strips digit runs of this length or longer INSIDE normalize, so
// the raw HTML is the only place the zwieback shape is visible. Taken from the
// detector's export rather than written as a literal 12, so lowering it there
// lowers it here.
const MIN_TOKEN_DIGITS = Number(detector.PER_REQUEST_TOKEN_MIN_DIGITS) || 12;

// --- fetch, with the detector's options --------------------------------------
// KEPT BYTE-IDENTICAL to fetchText's in src/services/specDetector.js; a smoke
// test asserts it. Reported in the header of every run so a reader never has to
// assume which headers produced the bytes below.
const USER_AGENT = 'Quillio-LiveSpecs/1.0 (spec-watch)';
const FETCH_TIMEOUT_MS = 10000;
const REFETCH_DELAY_MS = 3000;

async function fetchOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    const body = await res.text();
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

// --- small helpers -----------------------------------------------------------
function rule(title) {
  console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`);
}

// "Exactly once" WITHOUT counting to the end. The candidate search asks this
// question tens of thousands of times on a long page, and split() builds an
// array of every piece before the caller throws all but the length away — so on
// a repetitive page, where a phrase occurs two hundred times, it does two
// hundred allocations to answer a question settled by the second hit.
//
// Measured on a deliberately pathological fixture (29,812 normalized chars, 600
// integers, almost nothing unique — so the early exit at ten candidates never
// fires): 340ms of work before, 96ms after.
function occursExactlyOnce(hay, needle) {
  if (!needle) return false;
  const first = hay.indexOf(needle);
  if (first < 0) return false;
  return hay.indexOf(needle, first + needle.length) < 0;
}

// `pad` characters either side, on ONE line, with the match wrapped so it is
// findable by eye and by grep. Never called without a match to wrap: a bare
// number is not a finding.
function withContext(text, at, len, pad) {
  const before = text.slice(Math.max(0, at - pad), at);
  const after = text.slice(at + len, at + len + pad);
  return `${before}>>> ${text.slice(at, at + len)} <<<${after}`.replace(/\s+/g, ' ');
}

function pct(n, total) {
  if (!total) return '0.0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

// Every integer in `text`, as { value, at, len }.
function findIntegers(text) {
  const out = [];
  const re = /\d+/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ value: m[0], at: m.index, len: m[0].length });
  return out;
}

function mentionsCharacter(text, at, len, pad) {
  const window = text.slice(Math.max(0, at - pad), at + len + pad);
  return /character/i.test(window);
}

// --- divergence --------------------------------------------------------------
// A RESYNCHRONISING SCANNER, AND IT IS APPROXIMATE — labelled as such wherever
// it prints. An index-wise walk finds the FIRST difference correctly and then
// reports every remaining character as different the moment one side inserts or
// deletes anything, which would turn one shuffled list into "diverges
// everywhere". This walks both strings, and on a mismatch looks forward for a
// window of WINDOW characters that agrees again, in either string or both.
//
// It is a heuristic for the REGION COUNT only. The first-difference index it
// reports is exact, because that part needs no resynchronisation.
const WINDOW = 32;
const MAX_SKIP = 4000;
const MAX_REGIONS = 200;

function divergenceRegions(a, b) {
  const regions = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length && regions.length < MAX_REGIONS) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    const aStart = i;
    const bStart = j;
    let resynced = false;
    for (let d = 1; d <= MAX_SKIP && !resynced; d += 1) {
      // Same-length change, then a deletion from each side. Cheap and covers the
      // three shapes a page actually produces: a substituted token, an inserted
      // element, a removed one.
      for (const [da, db] of [[d, d], [d, 0], [0, d]]) {
        if (i + da + WINDOW > a.length || j + db + WINDOW > b.length) continue;
        if (a.substr(i + da, WINDOW) === b.substr(j + db, WINDOW)) {
          regions.push({ aStart, aEnd: i + da, bStart, bEnd: j + db });
          i += da;
          j += db;
          resynced = true;
          break;
        }
      }
    }
    if (!resynced) {
      regions.push({ aStart, aEnd: a.length, bStart, bEnd: b.length, tail: true });
      return { regions, truncated: false };
    }
  }
  if (regions.length >= MAX_REGIONS) return { regions, truncated: true };
  if (i < a.length || j < b.length) {
    regions.push({ aStart: i, aEnd: a.length, bStart: j, bEnd: b.length, tail: true });
  }
  return { regions, truncated: false };
}

function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

// --- anchor candidates -------------------------------------------------------
// Snap a window inward to whole words. An anchor cut mid-word is both ugly and
// fragile: a tag boundary inside the fragment is exactly what makes a plausible
// anchor silently miss.
function snapToWords(text, start, end) {
  let s = Math.max(0, start);
  let e = Math.min(text.length, end);
  if (s > 0 && !/\s/.test(text[s - 1])) {
    while (s < e && !/\s/.test(text[s])) s += 1;
  }
  while (s < e && /\s/.test(text[s])) s += 1;
  if (e < text.length && !/\s/.test(text[e])) {
    while (e > s && !/\s/.test(text[e - 1])) e -= 1;
  }
  while (e > s && /\s/.test(text[e - 1])) e -= 1;
  return [s, e];
}

const ANCHOR_MIN = 40;
const ANCHOR_MAX = 80;

// `source` is the region candidates are DRAWN from; `corpusOne`/`corpusTwo` are
// the full documents uniqueness is checked against. They differ for a stop
// marker, which is drawn from the prefix before the first divergence but has to
// be unique in the WHOLE text — truncateAtMarker does indexOf over everything,
// so a phrase unique in the prefix and repeated after it is not a unique marker.
// `opts.fromEnd` sweeps BACKWARD, and it is not a preference — it is a
// correctness fix for the stop-marker search.
//
// THE LIMIT IS APPLIED DURING DISCOVERY, so a forward sweep that stops at the
// twelfth hit has sampled only the START of the region. Sorting those twelve
// latest-first afterwards reorders an early-biased sample and calls the result
// BEST, which is a wrong answer wearing the shape of a right one. Measured on a
// fixture whose divergence sits at character 18,050: the forward sweep proposed
// a marker at 1,327 (retaining 7.3% and dropping every character number on the
// page), because that was the latest of the first twelve it happened to find.
function anchorCandidates(source, corpusOne, corpusTwo, seeds, limit, opts = {}) {
  const one = source;
  const accepted = [];
  const spans = [];
  const tried = new Set();

  // DECLARED BEFORE THE CLOSURE THAT READS IT. `consider` captures `via`, and
  // with the declaration below the closure it works only because every call
  // happens after that line executes — a ReferenceError waiting for whoever
  // moves a call site up.
  let via = 'seeded';

  const consider = (start, end) => {
    if (accepted.length >= limit) return;
    const [s, e] = snapToWords(one, start, end);
    const len = e - s;
    if (len < ANCHOR_MIN || len > ANCHOR_MAX) return;
    const key = `${s}:${e}`;
    if (tried.has(key)) return;
    tried.add(key);
    // Skip anything overlapping an already-accepted candidate: ten near-identical
    // windows around one sentence is a list of one suggestion printed ten times.
    for (const [as, ae] of spans) if (s < ae && e > as) return;
    const text = one.slice(s, e);
    if (!occursExactlyOnce(corpusOne, text)) return;
    if (!occursExactlyOnce(corpusTwo, text)) return;
    accepted.push({ text, at: s, via });
    spans.push([s, e]);
  };

  // WHICH PASS FOUND IT is carried on the candidate, because it is the strongest
  // thing known about an anchor's quality and it is not recoverable afterwards.
  // A seeded candidate sits beside a character-adjacent number, so it is in the
  // spec BODY by construction; a swept one is wherever the sampler happened to
  // land, which on most pages is chrome.
  //
  // Seeded first — a spec label beside a character number is the anchor shape
  // this project has settled on, and it is the opposite of site chrome.
  for (const p of seeds) {
    for (const len of [ANCHOR_MAX, 72, 64, 56, 48, ANCHOR_MIN]) {
      for (const shift of [Math.floor(len * 0.6), Math.floor(len * 0.3), 0, len - 8]) {
        consider(p - shift, p - shift + len);
      }
    }
    if (accepted.length >= limit) break;
  }

  // Then a sweep, so a page with no character-adjacent number still gets
  // suggestions rather than an empty section.
  via = 'swept';
  if (accepted.length < limit) {
    const step = Math.max(120, Math.floor(one.length / 400));
    if (opts.fromEnd) {
      for (let p = one.length - ANCHOR_MAX; p >= 0 && accepted.length < limit; p -= step) {
        consider(p, p + ANCHOR_MAX);
      }
    } else {
      for (let p = 0; p < one.length && accepted.length < limit; p += step) {
        consider(p, p + ANCHOR_MAX);
      }
    }
  }
  return accepted;
}

// --- ranking -----------------------------------------------------------------
// RANK BY PROVENANCE, NOT BY DIGITS. The first version of this sorted
// digit-bearing candidates to the bottom, and the result was worse than no sort
// at all: on a page whose spec block is the only part carrying numbers, it
// promoted NAV BOILERPLATE to the top. The BEST suggestion on an 18k fixture
// became a header at offset 0.0%.
//
// That is the anchor-that-cannot-fail, which this project has already rejected
// once — specDetector.js:481 names it, and scripts/migrateAddSpecAnchors.js
// rejected Meta's candidate for exactly this: it "asserts the document was
// SERVED, not that the content RENDERED, so it would pass on exactly the broken
// page the feature exists to catch."
//
// THE TWO HAZARDS ARE NOT SYMMETRIC, which is what decides the order:
//
//   a candidate holding a NUMBER    a real spec change reports `failed` instead
//                                   of `changed`. Bad, visible, and marked.
//   a candidate made of CHROME      no change ever reports anything, on any
//                                   week, forever. Worse, and invisible.
//
// So [CONTAINS A NUMBER] stays as a MARK and stops being a DEMOTION.
function citesAny(text, cited) {
  if (!cited || !cited.size) return false;
  return (text.match(/\d+/g) || []).some((d) => cited.has(d));
}

// `cited` is an optional Set of the char_min/char_max values the row being
// probed already cites — supplied via --cited=, never queried. See main().
//
// The cited preference is described as a TIEBREAK and is applied ABOVE document
// order, because document order is total: there are no ties left for it to
// break underneath. It only ever reorders within the seeded group.
function rankCandidates(candidates, { cited } = {}) {
  const rank = (c) => (c.via === 'seeded' ? 0 : 1);
  return candidates.slice().sort((x, y) => {
    if (rank(x) !== rank(y)) return rank(x) - rank(y);
    if (rank(x) === 0 && cited && cited.size) {
      const cx = citesAny(x.text, cited) ? 1 : 0;
      const cy = citesAny(y.text, cited) ? 1 : 0;
      if (cx !== cy) return cx - cy;
    }
    return x.at - y.at;
  });
}

// --- the region the detector would hash --------------------------------------
// EXTRACTED SO THE TEST DRIVES THE SAME CODE probe() DOES. The property — anchor
// candidates never come from past the stop marker — used to be asserted by
// comparing the POSITION OF TWO STRING LITERALS in this file, which is a claim
// about today's line order rather than about behaviour. Refactor either of those
// lines and the assertion breaks for no reason or silently stops checking
// anything. That is the third time this file has been corrected for asserting a
// property somewhere other than where it lives.
//
// Returns everything downstream needs, so probe() composes rather than computes.
function hashRegionFor(normOne, normTwo) {
  const stable = hashText(normOne) === hashText(normTwo);
  const firstDiff = stable ? -1 : firstDifference(normOne, normTwo);

  let markers = [];
  let bestMarker = null;
  if (!stable) {
    // Drawn from the prefix, unique across BOTH whole documents. fromEnd, so the
    // twelve DISCOVERED are the twelve latest rather than the twelve earliest —
    // see anchorCandidates for the measured failure that makes this a fix and
    // not a tidy-up. The sort then makes the print order explicit rather than
    // dependent on discovery order.
    markers = anchorCandidates(normOne.slice(0, firstDiff), normOne, normTwo, [], 12, { fromEnd: true })
      .sort((x, y) => y.at - x.at)
      .slice(0, 5);
    if (markers.length) {
      const kept = truncateAtMarker(normOne, markers[0].text);
      bestMarker = { ...markers[0], keptLen: kept === null ? 0 : kept.length };
    }
  }

  // truncateAtMarker is what the run loop would apply, so the region comes from
  // it rather than from offset arithmetic that could disagree with it.
  return {
    stable,
    firstDiff,
    markers,
    bestMarker,
    hashOneRegion: bestMarker ? (truncateAtMarker(normOne, bestMarker.text) || normOne) : normOne,
    hashTwoRegion: bestMarker ? (truncateAtMarker(normTwo, bestMarker.text) || normTwo) : normTwo,
  };
}

// --- the report --------------------------------------------------------------
async function probe(url, opts = {}) {
  console.log(`\n${'═'.repeat(78)}`);
  console.log(`URL     ${url}`);

  let one;
  let two;
  try {
    one = await fetchOnce(url);
    console.log(`STATUS  ${one.status}${one.ok ? '' : '  <- NOT OK'}`);
    // EVERY OPTION THIS FILE SETS, named — so a reader never has to assume
    // which request produced the bytes below, and can see at a glance that the
    // list is short.
    console.log(`FETCH   signal: AbortController, ${FETCH_TIMEOUT_MS}ms timeout`);
    console.log(`        headers: { "User-Agent": ${JSON.stringify(USER_AGENT)} }`);
    console.log('        nothing else set — redirect, encoding, cookies and retries');
    console.log('        are the runtime defaults, for this file and for the detector alike.');
    console.log('═'.repeat(78));
    if (!one.ok) {
      console.log(`\n${TAG} non-2xx — the detector would route this to \`error\`. Nothing measured.`);
      return false;
    }
    if (!one.body || !one.body.trim()) {
      console.log(`\n${TAG} EMPTY BODY on a ${one.status}. Nothing measured.`);
      return false;
    }
    await new Promise((r) => setTimeout(r, REFETCH_DELAY_MS));
    two = await fetchOnce(url);
    if (!two.ok || !two.body || !two.body.trim()) {
      console.log(`\n${TAG} second fetch returned ${two.status}${two.body && two.body.trim() ? '' : ' with an empty body'}` +
        ' — stability cannot be measured, and neither can anything downstream of it.');
      return false;
    }
  } catch (err) {
    console.log('═'.repeat(78));
    console.log(`\n${TAG} FETCH FAILED: ${err.message}`);
    console.log(`${TAG} the detector would route this to \`error\` — unreachable, not unanchored.`);
    return false;
  }

  const rawOne = one.body;
  const rawTwo = two.body;
  // hashableText with a null marker IS normalize — called through the helper so
  // this measures the path the run loop takes, not a shortcut around it.
  const normOne = hashableText({ content_stop_marker: null }, rawOne);
  const normTwo = hashableText({ content_stop_marker: null }, rawTwo);

  // ---- SIZE
  rule('SIZE');
  console.log(`   raw HTML        ${rawOne.length} chars`);
  console.log(`   normalized      ${normOne.length} chars` +
    `   (${pct(normOne.length, rawOne.length)} of raw survives normalize)`);

  // ---- LABELED NUMBERS
  const PAD = 80;
  const ints = findIntegers(normOne);
  rule('LABELED NUMBERS');
  console.log(`   ${ints.length} integer(s) in the normalized text, each with ${PAD} chars either side.`);
  console.log(`   normalize() has already removed every run of ${MIN_TOKEN_DIGITS}+ digits, so a`);
  console.log('   per-request token cannot appear below. See DIGIT RUN TEST for those.\n');
  for (const n of ints) {
    console.log(`   ${withContext(normOne, n.at, n.len, PAD)}`);
  }

  const charInts = ints.filter((n) => mentionsCharacter(normOne, n.at, n.len, PAD));
  console.log(`\n   ${charInts.length} of those ${ints.length} sit within ${PAD} chars of the word "character":\n`);
  for (const n of charInts) {
    console.log(`   ${withContext(normOne, n.at, n.len, PAD)}`);
  }
  if (charInts.length === 0) {
    console.log('   (none — a page publishing no character limit is the ads-guide-index shape.)');
  }

  // ---- DISTINCT NUMBERS
  rule('DISTINCT NUMBERS');
  console.log('   How often each integer occurs. One occurrence in a nav element and');
  console.log('   one in a spec table look identical until they are counted.\n');
  const freq = new Map();
  for (const n of ints) freq.set(n.value, (freq.get(n.value) || 0) + 1);
  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]));
  for (const [value, n] of sorted) {
    console.log(`   ${String(n).padStart(4)}x  ${value}`);
  }

  // ---- STABILITY
  // COMPUTED ONCE, HERE, for the whole report — the stop marker has to be
  // decided before the anchors, because the anchors are searched inside the
  // region it implies. Printed in the order you read them; computed in the order
  // they depend on each other.
  const region = hashRegionFor(normOne, normTwo);
  const { stable, firstDiff, markers, bestMarker, hashOneRegion, hashTwoRegion } = region;

  rule('STABILITY');
  console.log(`   fetch 1  ${hashText(normOne)}`);
  console.log(`   fetch 2  ${hashText(normTwo)}`);
  console.log(`   ${stable ? 'MATCH' : 'DIVERGENT'}`);
  if (!stable) {
    console.log(`\n   first difference at character ${firstDiff} (${pct(firstDiff, normOne.length)} in)\n`);
    const from = Math.max(0, firstDiff - 100);
    console.log(`   FETCH 1: ${JSON.stringify(normOne.slice(from, from + 200))}`);
    console.log(`   FETCH 2: ${JSON.stringify(normTwo.slice(from, from + 200))}`);
    const { regions, truncated } = divergenceRegions(normOne, normTwo);
    console.log(`\n   ${regions.length}${truncated ? '+' : ''} separate divergence region(s)` +
      `${truncated ? ` (stopped counting at ${MAX_REGIONS})` : ''}.`);
    console.log('   The region COUNT is approximate — it comes from a resynchronising');
    console.log('   scanner, not a diff. The first-difference index above is exact.');
    for (const r of regions.slice(0, 10)) {
      console.log(`      at ${String(r.aStart).padStart(7)} (${pct(r.aStart, normOne.length).padStart(6)})` +
        `  ${r.aEnd - r.aStart} vs ${r.bEnd - r.bStart} chars${r.tail ? '  [tail]' : ''}`);
    }
    if (regions.length > 10) console.log(`      … ${regions.length - 10} more`);
  }

  // ---- DIGIT RUN TEST
  rule('DIGIT RUN TEST');
  console.log(`   /\\d{${MIN_TOKEN_DIGITS},}/ against the RAW html of both fetches — the shape a`);
  console.log('   per-request token takes. normalize() strips these, so a hit here is not');
  console.log('   by itself a problem; it is the reason a page can look stable.\n');
  const runRe = new RegExp(`\\d{${MIN_TOKEN_DIGITS},}`, 'g');
  let anyRun = false;
  for (const [label, raw] of [['fetch 1', rawOne], ['fetch 2', rawTwo]]) {
    const hits = [];
    let m;
    runRe.lastIndex = 0;
    while ((m = runRe.exec(raw)) !== null) hits.push({ at: m.index, len: m[0].length });
    console.log(`   ${label}: ${hits.length} match(es)`);
    if (hits.length) anyRun = true;
    for (const h of hits.slice(0, 20)) {
      console.log(`      ${withContext(raw, h.at, h.len, 60)}`);
    }
    if (hits.length > 20) console.log(`      … ${hits.length - 20} more`);
  }
  if (!anyRun) console.log('\n   No run of that length in either fetch.');

  // ---- DIMENSION CHECK
  rule('DIMENSION CHECK');
  console.log('   raw / normalized occurrences, case-insensitive.\n');
  for (const word of ['placement', 'format', 'tab', 'select']) {
    const re = new RegExp(word, 'gi');
    const r = (rawOne.match(re) || []).length;
    const n = (normOne.match(re) || []).length;
    console.log(`   ${word.padEnd(12)} ${String(r).padStart(5)} raw / ${String(n).padStart(4)} normalized`);
  }
  console.log('\n   Many raw and few normalized suggests a SELECTOR CONTROL — markup that');
  console.log('   switches a view without rendering its alternatives. Repeating in the');
  console.log('   NORMALIZED text suggests a rendered MENU, which is the Meta index-page');
  console.log('   shape: a page listing the places the specs live rather than the specs.');
  console.log('   THIS SECTION IS A SIGNAL, NOT A VERDICT. Read the page.');

  // ---- ANCHOR CANDIDATES
  // THE DETECTOR CHECKS AN ANCHOR AGAINST THE TRUNCATED TEXT — specDetector.js
  // passes hashableText(row, html) to checkAnchor, and says so at that call
  // site: "an anchor living past the stop marker would assert that content we
  // then throw away rendered". So the search runs inside hashOneRegion, computed
  // above. See hashRegionFor.
  rule('ANCHOR CANDIDATES');
  console.log(`   ${ANCHOR_MIN}-${ANCHOR_MAX} chars, occurring EXACTLY ONCE in both fetches, snapped to`);
  console.log('   whole words. Seeded near character-adjacent numbers first, because a spec');
  console.log('   label beside a limit is the opposite of chrome: it cannot appear on a 404,');
  console.log('   an auth wall or a consent interstitial, none of which has a spec block.');
  if (bestMarker) {
    console.log(`\n   SEARCHED INSIDE THE TRUNCATED REGION — the first ${hashOneRegion.length} of`);
    console.log(`   ${normOne.length} normalized chars, which is what a row carrying the BEST stop`);
    console.log('   marker below would hash. The detector checks an anchor against the');
    console.log('   truncated text, so a candidate from past the marker would look perfect');
    console.log('   here and report `failed` on its first real run.\n');
  } else {
    console.log(`\n   Searched the whole normalized text (${normOne.length} chars) — this page needs`);
    console.log('   no stop marker, so the hashed region is the whole of it.\n');
  }
  const seeds = charInts.filter((n) => n.at < hashOneRegion.length).map((n) => n.at);
  // RANKED BY PROVENANCE — seeded above swept, document order within each. See
  // rankCandidates for why this is not sorted by whether a candidate holds a
  // number, and what the previous version of that sort promoted to the top.
  const candidates = rankCandidates(
    anchorCandidates(hashOneRegion, hashOneRegion, hashTwoRegion, seeds, 10),
    { cited: opts.cited }
  );
  if (candidates.length === 0) {
    console.log('   NONE FOUND. Every window in range repeats or moves between fetches.');
    console.log('   Report that rather than lowering the bar — an anchor that can be');
    console.log('   satisfied by chrome is worse than no anchor, because it reports a');
    console.log('   guarantee it is not providing.');
  }
  // BOTH PERCENTAGES WHEN THEY DIFFER. The offset used to print as a share of the
  // whole DOCUMENT while the search ran inside the truncated REGION, so a
  // candidate at the very edge of a 40%-retained region read as "39.8%" — early
  // in the page, when it is in fact at the boundary of everything that gets
  // hashed. Cosmetic, and exactly the kind of number a reader would act on.
  const truncated = hashOneRegion.length < normOne.length;
  for (const c of candidates) {
    const digits = /\d/.test(c.text);
    const where = truncated
      ? `${pct(c.at, hashOneRegion.length).padStart(6)} of region (${pct(c.at, normOne.length)} of doc)`
      : `${pct(c.at, normOne.length).padStart(6)} of doc`;
    console.log(`   ${c.via === 'seeded' ? '[SEEDED]' : '[SWEPT] '} at ${where}  ` +
      `${JSON.stringify(c.text)}${digits ? '   [CONTAINS A NUMBER]' : ''}`);
  }
  if (candidates.some((c) => c.via === 'swept')) {
    console.log('\n   [SWEPT] means the sampler landed there, not that anything about the page');
    console.log('   recommended it. On most pages the sampler lands in chrome, and an anchor');
    console.log('   made of chrome stays true when the entire spec body disappears — so a');
    console.log('   [SWEPT] candidate is a last resort, ranked below every [SEEDED] one.');
  }
  if (opts.cited && opts.cited.size) {
    console.log(`\n   --cited was supplied (${[...opts.cited].join(', ')}), so within [SEEDED] a`);
    console.log('   candidate holding one of those values ranks below one that does not.');
  }
  if (candidates.some((c) => /\d/.test(c.text))) {
    console.log('\n   [CONTAINS A NUMBER] is a warning, not a disqualification. A missed anchor');
    console.log('   is `failed` — the page could not be READ — while a moved number is');
    console.log('   `changed`. An anchor holding a spec limit turns the second into the');
    console.log('   first, so a real spec change would be reported as a broken page.');
  }

  // ---- STOP MARKER CANDIDATES
  if (!stable) {
    rule('STOP MARKER CANDIDATES');
    console.log(`   Everything below character ${firstDiff} is identical across both fetches.`);
    console.log('   A content_stop_marker cuts there, so the churn stops being hashed.\n');
    // Computed above, before the anchors, because the anchors depend on it.
    if (markers.length === 0) {
      console.log('   NONE FOUND before the first divergence. Either the page moves too early');
      console.log('   to truncate usefully, or it needs a rule in normalize() rather than a');
      console.log('   marker on the row — and that re-baselines every other page.');
    }
    for (const m of markers) {
      const kept = truncateAtMarker(normOne, m.text);
      const keptLen = kept === null ? 0 : kept.length;
      console.log(`   ${m === markers[0] ? 'BEST  ' : '      '}` +
        `at ${pct(m.at, normOne.length).padStart(6)}  retains ${pct(keptLen, normOne.length).padStart(6)}` +
        `  ${JSON.stringify(m.text)}`);
    }
    const best = bestMarker;
    if (best) {
      const dropped = charInts.filter((n) => n.at >= best.keptLen);
      if (dropped.length) {
        console.log(`\n   WARNING: truncating at the BEST candidate drops ${dropped.length} number(s)`);
        console.log('   whose context mentions "character". Those are the values this row exists');
        console.log('   to watch, and a marker above them makes the row permanently blind to a');
        console.log('   change in them. Pick a later marker, or do not use one.');
        for (const n of dropped.slice(0, 8)) {
          console.log(`      ${withContext(normOne, n.at, n.len, 60)}`);
        }
      } else {
        console.log('\n   No "character"-adjacent number falls after the BEST candidate — nothing');
        console.log('   this row would watch for is lost by truncating there.');
      }
    }
  }

  // ---- FOOTER
  rule('WHAT THIS PROBE CANNOT DO');
  console.log('   It cannot tell whether the numbers on this page are CORRECT. It reads');
  console.log('   what the page says, not whether the platform enforces it.');
  console.log();
  console.log('   It cannot tell whether this is the AUTHORITATIVE page for that platform.');
  console.log('   A page can be stable, anchorable and entirely the wrong page — that is');
  console.log('   the Meta ads-guide index exactly, which reported clean every week while');
  console.log('   watching a page with no character limit on it.');
  console.log();
  console.log('   ITS FETCH MATCHES THE DETECTOR ON USER-AGENT AND TIMEOUT ONLY. Those two');
  console.log('   are asserted by a test; redirect handling, accept-encoding, cookie policy');
  console.log('   and retries are the runtime\'s defaults here and in the detector, which is');
  console.log('   why they agree today — not because anything checks them. If the two ever');
  console.log('   diverge, this can propose an anchor for a page the detector reads');
  console.log('   differently.');
  console.log();
  console.log('   THE ANCHOR CANDIDATE LIST IS A SAMPLE, NOT AN ENUMERATION. The seeded pass');
  console.log('   tries a fixed set of windows per character-adjacent number, the sweep');
  console.log('   examines roughly one position in 120, and both stop at ten accepted. So');
  console.log('   "4 candidates" means four were FOUND, not four EXIST — and an empty list');
  console.log('   means none was sampled, not that the page has none.');
  console.log();
  console.log('   A STABLE result is the ABSENCE OF ONE FAILURE MODE, not proof of');
  console.log('   stability. It says these two fetches agreed, seconds apart, from one');
  console.log('   place. It does not say the page holds still next week, or from another');
  console.log('   region, or for a client the site treats differently.');
  return true;
}

// --cited=30,90,15 — the char_min/char_max values the row being probed already
// cites, used only to break ties inside the seeded group.
//
// PASSED IN, NEVER QUERIED, and that is the whole design of this flag. The probe
// has no database and must keep none: the moment it reads affected_fields for
// itself it needs a connection, a tenant scope and a schema tolerance, and it
// stops being the thing you can point at a URL you have never watched. Absent,
// the tiebreak is skipped in silence — it is a refinement, not a requirement.
function citedFromArgv(argv) {
  const flag = argv.find((a) => a.startsWith('--cited='));
  if (!flag) return null;
  const values = flag.slice('--cited='.length).split(/[,\s]+/).map((v) => v.trim()).filter(Boolean);
  return values.length ? new Set(values) : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const urls = argv.filter((a) => !a.startsWith('--'));
  if (urls.length === 0) {
    console.error(`${TAG} usage: node scripts/probeSpecPage.js <url> [url …] [--cited=30,90,15]`);
    console.error(`${TAG} read-only: no database, no writes, no files.`);
    process.exit(1);
  }
  const cited = citedFromArgv(argv);
  console.log(`${TAG} READ-ONLY. No database, no writes, no files.`);
  console.log(`${TAG} normalize / truncateAtMarker / hashableText / hashText come from`);
  console.log(`${TAG} src/services/specDetector — the module scripts/runDetection.js drives.`);
  if (cited) console.log(`${TAG} --cited: ${[...cited].join(', ')} (tiebreak within seeded candidates)`);

  let failed = 0;
  for (const url of urls) {
    const ok = await probe(url, { cited });
    if (!ok) failed += 1;
  }
  console.log(`\n${TAG} ${urls.length - failed}/${urls.length} URL(s) fetched.`);
  process.exit(failed > 0 ? 1 : 0);
}

// Guarded so a test can require this file and drive the pure ranking without the
// probe running — the same shape scripts/migrateFixMetaSpecs.js uses for its maps.
if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} ${err.message}`);
    process.exit(1);
  });
}

// UNIT TESTS ONLY. Not an interface — nothing in src/ requires this file. The
// ordering is the part worth testing behaviourally rather than by scanning the
// source, because "boilerplate outranks the spec body" is a property of the
// COMPARATOR and no string match can see it.
module.exports = {
  anchorCandidates, rankCandidates, citedFromArgv, snapToWords, occursExactlyOnce, hashRegionFor,
};
