'use strict';

// Manual check for the parse step of the instance work: run REAL briefs through
// gemini.parseBrief and print the asset plan each one produces.
//
// This is the verification that cannot run in CI or in a sandbox — it needs a live
// GEMINI_API_KEY and it exercises the model's judgement, which is exactly the part
// unit tests stub out. Everything downstream of the plan (clamping, expansion,
// rendering) IS covered by test/smoke.test.js.
//
// Run it wherever the key lives — the Railway console, or locally:
//   node --env-file=.env scripts/checkParsePlans.js
//   GEMINI_API_KEY=… node scripts/checkParsePlans.js
//
// Add a one-off brief as an argument:
//   node scripts/checkParsePlans.js "two landing pages, one per region"
//
// WHAT TO LOOK FOR, case by case (the expectations are printed alongside):
//   • an explicit number becomes a count, not several entries
//   • a number crossed with named groups multiplies, and the groups become labels
//   • A/B phrasing produces count > 1 of the BASE asset, never a "— Variant A" type
//   • a plain one-of-each brief is all count 1 (the backward-compatible case)
//   • a vague plural does NOT invent a number
//   • a vague brief still returns a small sensible set

const CASES = [
  {
    brief: 'five nurture emails for two audiences: downtown and suburban',
    expect: 'ONE Demand Gen Nurture Email entry, count 10 (5 x 2), labels naming Downtown / Suburban',
  },
  {
    brief: '3 LinkedIn ads to A/B test',
    expect: 'ONE LinkedIn Single Image Ad entry at count 3 — and NO "— Variant A/B/C/D" asset type',
  },
  {
    brief: 'a landing page and a nurture email',
    expect: 'exactly two entries, both count 1 — the backward-compatible case',
  },
  {
    brief: 'a bunch of LinkedIn ads',
    expect: 'a vague plural: count should stay 1 rather than a guessed number',
  },
  {
    brief: 'full campaign, all assets',
    expect: 'the vague case: a small set of relevant assets, all count 1 (never a guessed pile)',
  },
];

function render(plan) {
  if (!Array.isArray(plan) || plan.length === 0) return '    (empty — the whole library will be rendered)';
  return plan
    .map((e) => {
      const labels = Array.isArray(e.labels) && e.labels.some(Boolean) ? `  labels: ${JSON.stringify(e.labels)}` : '';
      return `    ${String(e.count).padStart(2)} x ${e.asset}${labels}`;
    })
    .join('\n');
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set — this script makes real Gemini calls.');
    process.exit(1);
  }
  const { parseBrief } = require('../src/services/gemini');
  const extra = process.argv.slice(2).filter(Boolean);
  const cases = extra.length ? extra.map((brief) => ({ brief, expect: '(ad hoc)' })) : CASES;

  let failures = 0;
  for (const { brief, expect } of cases) {
    console.log('\n' + '='.repeat(78));
    console.log(`BRIEF:  ${brief}`);
    console.log(`EXPECT: ${expect}`);
    try {
      const t0 = Date.now();
      const parsed = await parseBrief(brief);
      const total = (parsed.assets || []).reduce((n, e) => n + (e.count || 1), 0);
      console.log(`PLAN (${parsed.assets.length} entr${parsed.assets.length === 1 ? 'y' : 'ies'}, ${total} version(s), ${((Date.now() - t0) / 1000).toFixed(1)}s):`);
      console.log(render(parsed.assets));
      if (parsed.unmatchedAssets.length) console.log(`    unmatched: ${JSON.stringify(parsed.unmatchedAssets)}`);
      const variants = (parsed.assets || []).filter((e) => / — Variant [A-D]$/.test(e.asset));
      if (variants.length) {
        failures += 1;
        console.log(`    *** ROUTED TO A VARIANT ASSET TYPE: ${variants.map((v) => v.asset).join(', ')}`);
      }
    } catch (err) {
      failures += 1;
      console.log(`    *** FAILED: ${err.message}`);
    }
  }
  console.log('\n' + '='.repeat(78));
  console.log(failures === 0 ? 'No variant-routing or errors detected. Read the plans above and judge the counts.' : `${failures} case(s) need a look.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
