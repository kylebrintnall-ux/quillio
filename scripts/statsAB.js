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

// Every number that is legitimately available to the model: the brief's own, and
// the supplied figures'. Anything else in the output was made up.
const SUPPLIED_NUMBERS = STATS.flatMap((s) => s.text.match(/\d+(?:\.\d+)?/g) || []);
const BRIEF_NUMBERS = [BRIEF.brief, BRIEF.summary, BRIEF.writerPrompt]
  .join(' ')
  .match(/\d+(?:\.\d+)?/g) || [];
const KNOWN = new Set([...SUPPLIED_NUMBERS, ...BRIEF_NUMBERS]);

const numbersIn = (t) => (String(t).match(/\d+(?:\.\d+)?/g) || []);
const isFigureLed = (t) => /\d/.test(String(t).slice(0, 20));
const usesSupplied = (t) => numbersIn(t).some((n) => SUPPLIED_NUMBERS.includes(n));
// Spelled-out numbers are NOT counted — "four hours" is the same claim as "4
// hours" and this would miss it. The count is a floor on invention, not a census.
const invented = (t) => numbersIn(t).filter((n) => !KNOWN.has(n));

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
          const tag = inv.length ? `  [INVENTED: ${inv.join(', ')}]` : (usesSupplied(t) ? '  [supplied]' : '');
          console.log(`      ${String(n).padStart(4)}  ${t}${mark}${tag}`);
        });
      }

      const led = all.filter(isFigureLed).length;
      const used = all.filter(usesSupplied).length;
      const inv = all.filter((t) => invented(t).length > 0);
      console.log(`\n  figure-led (a number in the first 20 chars): ${led}/${all.length}`);
      console.log(`  uses a supplied figure:                      ${used}/${all.length}`);
      console.log(`  INVENTED a number:                           ${inv.length}/${all.length}`);
      if (inv.length) {
        console.log('  ↑ the block says do NOT round, combine or sharpen. Each of these is a');
        console.log('    factual claim no source made. Read them:');
        for (const t of inv) console.log(`      ${t}`);
      }
    }
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('THE COUNTS ARE SAFETY CHECKS, NOT THE RESULT. If figure-led rose sharply,');
  console.log('the figures are being used as a TEMPLATE rather than as evidence — the same');
  console.log('shape as the "in 60 seconds" run — and that is a reason to reword the block');
  console.log('even if every number in it is real. Read the extremes in both arms.');
  console.log('='.repeat(78));
})();
