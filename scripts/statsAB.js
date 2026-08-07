'use strict';

// A/B: what do the reference figures do to the copy — and specifically, do they
// turn every headline into a number-led line?
//
// THE PRE-REGISTERED FAILURE, NAMED BEFORE THE RUN. craft.md demonstrates a
// number-led opening TWICE (§1.7 "Save 4 hours a week", §2.54 "'3 ways,' 'in 10
// minutes'"), and the one time this system was measured on it, the model copied
// the SYNTAX rather than the point: 10 of 12 headlines ended "in 60 seconds", a
// figure present in no input, invented to fill the slot the examples had taught
// it to want. Two real figures in the prompt beside those two examples is the
// same setup with live ammunition. So this run counts, per arm:
//
//   figure-led     the copy opens with a number (first 20 chars)
//   uses supplied  a number from the reference stats appears
//   INVENTED       a number appears that is in NEITHER the brief NOR the stats
//
// The third is the one that matters. The block tells the model not to "round,
// combine or sharpen" a figure, and this is the check on whether it obeyed. An
// invented number in published copy is a false factual claim, which is a
// different class of failure from a weak headline — so a rise in that column is
// a reason to change the block, whatever else improved.
//
// THE CONTROL IS ONE PARAMETER, and it needs no special flag: `referenceStats:
// []` makes referenceStatsBlock return [] and reproduces the prompt exactly as
// it was before the block existed. `enrichedFromReferences` moves with it,
// because in production the two always travel together — a doc with a Reference
// Insights section has both, a doc without has neither. Arm A is therefore a
// brief that linked nothing and arm B is the same brief that linked two sources,
// which is the real comparison rather than a synthetic one.
//
// REPORT THE SPREAD AND READ THE EXTREMES (CLAUDE.md standing rule). The three
// counts above are safety checks, not a result. Every sample is printed with its
// length and the extremes marked.
//
// MAKES REAL MODEL CALLS — 2 assets x 2 arms x N runs, one batch call each.
// Writes NOTHING. Read-only against Gemini, safe to run in production.
//
//   node scripts/statsAB.js        # 5 runs per arm (20 calls)
//   node scripts/statsAB.js 3      # fewer

const { generateAssetDrafts } = require('../src/services/gemini');
const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');

const RUNS = Number(process.argv[2]) || 5;

// Headline-heavy assets, because the fabrication failure was a HEADLINE failure.
const CASES = ['LinkedIn Single Image Ad', 'Demand Gen Nurture Email'];

const BRIEF = {
  brief:
    'We are running the Q3 launch push for Quillio. Quillio turns a campaign brief '
    + 'into a formatted, on-brand copy doc in about a minute, so marketing teams stop '
    + 'rewriting the same brief into six different asset templates. The audience is '
    + 'marketing leads at mid-size B2B companies who are drowning in asset requests.',
  summary:
    'Quillio turns a campaign brief into a formatted, on-brand copy doc in about a minute, '
    + 'so marketing teams stop rewriting the same brief into six different asset templates.',
  writerPrompt:
    'Speak to a marketing lead at a mid-size B2B company who is drowning in asset requests. '
    + 'Lead with the time they get back. Concrete, not clever.',
};

// Two figures, from two differently-named sources, in the shape the enrich pass
// produces (under 10 words each). The numbers are deliberately DISTINCT from any
// number in the brief, so "uses supplied" and "invented" can be told apart.
const STATS = [
  { text: '71% of teams rebuild the same asset weekly', source: 'B2B Content Ops Benchmark 2026' },
  { text: '4.5 hours a week lost to reformatting', source: 'marketingops.example' },
];

// --- THE NUMERIC COUNTER, AND WHAT IT CANNOT SEE ---------------------------
//
// READ THIS BEFORE TRUSTING ANY NUMBER BELOW. A perfect version of this counter
// still reports "Get the 2026 Content Ops Benchmark" as CLEAN. Every digit in
// that line was supplied; the failure is that the line offers the reader a
// document that does not exist. The counter measures whether the FIGURES were
// handled honestly. It cannot measure whether the copy invented an OFFER, which
// is the failure the first run actually produced — in five of five Offer 2
// bodies, while the invented-number column was reporting something else. The
// TRIPWIRES below exist because of that, and they are tripwires, not coverage.
//
// The first version of this counter was wrong in BOTH directions at once:
//
//   OVER-REPORTED. SUPPLIED_NUMBERS was built from `s.text` only, so 2026 — the
//   year inside the source name, which the prompt itself carried at the time —
//   counted as invented. And the brief spells "six", so the model writing "6"
//   was flagged for converting a spelled number to a digit, which is faithful.
//
//   UNDER-REPORTED. A bare \d+ scan of the brief whitelisted "3" (from "Q3") and
//   "2" (from "B2B"), so a genuine invention of "3 ways" or "2x faster" would
//   have passed clean. Junk in the allowlist is worse than junk in the count:
//   one is visible noise, the other is a silent hole.
//
// Both are fixed here. NUM_RE ignores digits welded to letters, so Q3 and B2B
// contribute nothing, and spelled numbers in the brief are mapped to digits.
//
// SOURCE-NAME NUMBERS ARE NO LONGER WHITELISTED, AND THAT IS A CHANGE OF FACT,
// NOT A CHANGE OF MIND: the block no longer sends the source, so 2026 appearing
// in the output is now a genuine invention AND a source leak. It should show up
// in this column and in TRIPWIRE A at the same time.
//
// STILL BLIND, and stated so nobody reads a zero as safety: spelled-out
// inventions ("four hours a week") are invisible, so this column is a FLOOR ON
// INVENTION, NOT A CENSUS.
const NUM_RE = /(?<![A-Za-z0-9.])\d+(?:\.\d+)?(?![A-Za-z0-9])/g;
const SPELLED = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
  eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', twenty: '20',
  thirty: '30', forty: '40', fifty: '50', hundred: '100',
};

const numbersIn = (t) => (String(t).match(NUM_RE) || []);

const BRIEF_TEXT = [BRIEF.brief, BRIEF.summary, BRIEF.writerPrompt].join(' ');
const SUPPLIED_NUMBERS = STATS.flatMap((s) => numbersIn(s.text));
const BRIEF_NUMBERS = [
  ...numbersIn(BRIEF_TEXT),
  // "six different asset templates" makes 6 a faithful rendering, not invention.
  ...(BRIEF_TEXT.toLowerCase().match(/\b[a-z]+\b/g) || []).map((w) => SPELLED[w]).filter(Boolean),
];
const KNOWN = new Set([...SUPPLIED_NUMBERS, ...BRIEF_NUMBERS]);

const isFigureLed = (t) => /\d/.test(String(t).slice(0, 20));
const usesSupplied = (t) => numbersIn(t).some((n) => SUPPLIED_NUMBERS.includes(n));
const invented = (t) => numbersIn(t).filter((n) => !KNOWN.has(n));

// --- TRIPWIRE A: SOURCE LEAK. Must read 0. ---------------------------------
//
// A REGRESSION ALARM, NOT COVERAGE. The source name is no longer sent to the
// model at all, so after this change nothing in the output can legitimately
// contain a distinctive piece of one. A non-zero here means either the block
// started rendering `source` again or something else is leaking it — and it is
// the check that would have caught both first-run failures: the fabricated
// "B2B Content Ops Benchmark 2026" offer and the "marketingops.example"
// hostname appearing in three drafts of customer-facing copy.
//
// "Distinctive" = a token from a source name that is 4+ chars and does NOT
// already appear in the brief or the figures. That drops "B2B" (in the brief)
// and "2026" (handled by the invented-number column) and keeps "Benchmark",
// "Content", "marketingops".
const SOURCE_TOKENS = (() => {
  const own = new Set(
    (`${BRIEF_TEXT} ${STATS.map((s) => s.text).join(' ')}`.toLowerCase().match(/[a-z]{4,}/g) || [])
  );
  const out = new Set();
  for (const s of STATS) {
    for (const tok of String(s.source).toLowerCase().match(/[a-z]{4,}/g) || []) {
      if (!own.has(tok)) out.add(tok);
    }
  }
  return [...out];
})();
const sourceLeak = (t) => SOURCE_TOKENS.filter((tok) => String(t).toLowerCase().includes(tok));

// --- TRIPWIRE B: FABRICATED OFFER. Read the lines. -------------------------
//
// HINT, NOT A VERDICT, and it has known false positives BY DESIGN. "Get the
// Guide" is an approved craft.md CTA and appeared legitimately in the first
// run's BEFORE arm. An artefact noun is not proof of a fabricated offer — a
// campaign really can be offering a report. What this does is put every line
// that could be one in front of you, which is the only check that works,
// because the thing being asked is "does the client actually have this".
const ARTEFACT_NOUNS = [
  'report', 'benchmark', 'study', 'whitepaper', 'white paper', 'guide',
  'research', 'survey', 'ebook', 'e-book', 'playbook', 'toolkit',
];
const artefactHits = (t) =>
  ARTEFACT_NOUNS.filter((n) => new RegExp(`\\b${n.replace(/[-\s]/g, '[-\\s]')}s?\\b`, 'i').test(String(t)));

function fieldsFor(asset) {
  return (asset.fields || []).map((f) => ({
    fieldName: f.field_name,
    charMin: f.char_min || 0,
    charMax: f.char_max || 0,
    fieldType: f.field_type === 'words' ? 'words' : 'text',
    notes: '',
  }));
}

async function arm(asset, withStats) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    try {
      const drafts = await generateAssetDrafts({
        assetType: asset.name,
        assetDirection: asset.asset_direction || '',
        brief: BRIEF.brief,
        summary: BRIEF.summary,
        writerPrompt: BRIEF.writerPrompt,
        // THE ONLY DIFFERENCE BETWEEN THE ARMS. Both move together because in
        // production they always do.
        referenceStats: withStats ? STATS : [],
        enrichedFromReferences: withStats,
        fields: fieldsFor(asset),
        voiceGuide: '',
      });
      const byName = {};
      for (const d of drafts || []) byName[d.fieldName] = String(d.copy || '').trim();
      runs.push(byName);
    } catch (err) {
      runs.push({ __error: err.message });
    }
  }
  return runs;
}

function stats(ns) {
  const v = ns.filter((n) => typeof n === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return {
    min: v[0], max: v[v.length - 1], spread: v[v.length - 1] - v[0],
    median: v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2),
  };
}

(async () => {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set — this makes real model calls and cannot be faked.');
    process.exit(1);
  }

  console.log('Supplied figures:');
  for (const s of STATS) console.log(`  - ${s.text} — ${s.source}`);
  console.log(`Numbers the model may legitimately use: ${[...KNOWN].join(', ') || '(none)'}`);

  for (const name of CASES) {
    const asset = DEFAULT_ASSETS.find((x) => x.name === name);
    if (!asset) throw new Error(`asset not in the bundled library: ${name}`);

    console.log(`\n${'='.repeat(78)}`);
    console.log(`${asset.name}   ${RUNS} runs per arm`);
    console.log('='.repeat(78));

    for (const withStats of [false, true]) {
      const label = withStats ? 'AFTER  (reference figures supplied)' : 'BEFORE (no figures)';
      const runs = await arm(asset, withStats);
      console.log(`\n${label}`);

      const all = [];
      for (const f of asset.fields) {
        const copies = runs.map((r) => (r.__error ? `ERROR: ${r.__error}` : (r[f.field_name] || '')));
        const lens = copies.map((s) => (s.startsWith('ERROR:') ? null : s.length));
        const s = stats(lens);
        all.push(...copies.filter((x) => x && !x.startsWith('ERROR:')));

        console.log(`\n  ${f.field_name}  [${f.char_min}-${f.char_max}]`);
        console.log(
          `    lengths: ${lens.join(', ')}`
          + (s ? `   median ${s.median}   SPREAD ${s.spread} (${s.min}-${s.max})` : '')
        );
        copies.forEach((t, i) => {
          const n = lens[i];
          const mark = s && n === s.min ? ' <- MIN' : s && n === s.max ? ' <- MAX' : '';
          const inv = invented(t);
          const leak = sourceLeak(t);
          const tags = [
            inv.length ? `INVENTED: ${inv.join(', ')}` : (usesSupplied(t) ? 'supplied' : ''),
            leak.length ? `SOURCE LEAK: ${leak.join(', ')}` : '',
            artefactHits(t).length ? `artefact?: ${artefactHits(t).join(', ')}` : '',
          ].filter(Boolean);
          console.log(`      ${String(n).padStart(4)}  ${t}${mark}${tags.length ? `  [${tags.join('] [')}]` : ''}`);
        });
      }

      const led = all.filter(isFigureLed).length;
      const used = all.filter(usesSupplied).length;
      const inv = all.filter((t) => invented(t).length > 0);
      const leaks = all.filter((t) => sourceLeak(t).length > 0);
      const artefacts = all.filter((t) => artefactHits(t).length > 0);

      console.log(`\n  figure-led (a number in the first 20 chars): ${led}/${all.length}`);
      console.log(`  uses a supplied figure:                      ${used}/${all.length}`);
      console.log(`  INVENTED a number:                           ${inv.length}/${all.length}`);
      if (inv.length) {
        console.log('  ↑ do NOT round or sharpen, do NOT combine two into one. Each of these');
        console.log('    is a factual claim no source made. Read them:');
        for (const t of inv) console.log(`      ${t}`);
      }

      // TRIPWIRE A — a regression alarm. The source is not in the prompt.
      console.log(`  TRIPWIRE A · source leak (MUST be 0):        ${leaks.length}/${all.length}`);
      if (leaks.length) {
        console.log('  ↑ THE SOURCE NAME IS NOT SENT TO THE MODEL. If this is non-zero the');
        console.log('    withholding has regressed. Read them:');
        for (const t of leaks) console.log(`      ${t}`);
      }

      // TRIPWIRE B — a hint with deliberate false positives. Read the lines.
      console.log(`  TRIPWIRE B · artefact noun (READ, not fail): ${artefacts.length}/${all.length}`);
      if (artefacts.length) {
        console.log('  ↑ "Get the Guide" is an approved craft.md CTA, so a hit here is NOT a');
        console.log('    failure by itself. The question each line has to answer is: does the');
        console.log('    client actually HAVE this thing? Read them:');
        for (const t of artefacts) console.log(`      ${t}`);
      }
    }
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('THE COUNTS ARE SAFETY CHECKS, NOT THE RESULT. If figure-led rose sharply,');
  console.log('the figures are being used as a TEMPLATE rather than as evidence — the same');
  console.log('shape as the "in 60 seconds" run — and that is a reason to reword the block');
  console.log('even if every number in it is real. Read the extremes in both arms.');
  console.log('');
  console.log('AND NAME THE FAILURE YOU ARE WATCHING FOR BEFORE THE RUN, THEN READ THE COPY');
  console.log('FOR THE ONES YOU DID NOT NAME. The first run of this script counted invented');
  console.log('numbers — most of which turned out to be its own arithmetic — while five of');
  console.log('five Offer 2 bodies pitched a report the client does not have, unflagged. No');
  console.log('numeric column could have seen it. The Offer 2 fields are where to look.');
  console.log('='.repeat(78));
})();
