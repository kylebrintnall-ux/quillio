'use strict';

// A/B: does STATING the floor move the model, or do Subhead and Preheader draft
// short for some other reason?
//
// THE CONTROL IS ONE PARAMETER. The no-floor branch of lengthClause is
// byte-identical to the function before today's change, so passing char_min 0
// reproduces the OLD prompt exactly, through the same code path, same call, same
// model. The only difference between arm A and arm B is whether the floor is
// present. Nothing is stubbed and no old code is checked out.
//
// N runs per arm because one sample cannot answer "does it move the model" — a
// single short draft is indistinguishable from noise. Reports every count, the
// median, and how many landed inside the band.
//
// MAKES REAL MODEL CALLS — 2 fields x 2 arms x N runs. It writes NOTHING: no
// database, no Drive, no Doc. Read-only against Gemini, so it is safe to run in
// production, which is the only place with a key.
//
// Run it in the Railway console as plain node — NEVER `railway run`, same rule
// as the migrations (the console already has GEMINI_API_KEY in its environment):
//
//   node scripts/floorAB.js        # 5 runs per arm (20 calls)
//   node scripts/floorAB.js 3      # fewer

const { generateAssetDrafts } = require('../src/services/gemini');
const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');

const RUNS = Number(process.argv[2]) || 5;

// Two fields, both seeded with a real character floor, in their own assets.
const CASES = [
  { asset: 'LinkedIn Single Image Ad', field: 'Subhead' },
  { asset: 'Demand Gen Nurture Email', field: 'Preheader' },
];

const BRIEF = {
  summary:
    'Quillio turns a campaign brief into a formatted, on-brand copy doc in about a minute, '
    + 'so marketing teams stop rewriting the same brief into six different asset templates.',
  writerPrompt:
    'Speak to a marketing lead at a mid-size B2B company who is drowning in asset requests. '
    + 'Lead with the time they get back. Concrete, not clever.',
};

function specFor(assetName, fieldName, withFloor) {
  const a = DEFAULT_ASSETS.find((x) => x.name === assetName);
  const f = a.fields.find((x) => x.field_name === fieldName);
  return {
    asset: a,
    field: f,
    // The ONLY difference between the arms.
    fields: [{
      fieldName: f.field_name,
      charMin: withFloor ? f.char_min : 0,
      charMax: f.char_max,
      fieldType: f.field_type === 'words' ? 'words' : 'text',
      notes: '',
    }],
  };
}

async function arm(assetName, fieldName, withFloor) {
  const { asset, field, fields } = specFor(assetName, fieldName, withFloor);
  const counts = [];
  const samples = [];
  for (let i = 0; i < RUNS; i++) {
    try {
      const drafts = await generateAssetDrafts({
        assetType: asset.name,
        assetDirection: asset.asset_direction || '',
        summary: BRIEF.summary,
        writerPrompt: BRIEF.writerPrompt,
        fields,
        voiceGuide: '',
      });
      const d = (drafts || []).find((x) => x.fieldName === field.field_name);
      const copy = d ? String(d.copy || '').trim() : '';
      counts.push(copy.length);
      samples.push(copy);
    } catch (err) {
      counts.push(null);
      samples.push('ERROR: ' + err.message);
    }
  }
  return { field, counts, samples };
}

function median(ns) {
  const v = ns.filter((n) => typeof n === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

(async () => {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set — this makes real model calls and cannot be faked.');
    process.exit(1);
  }
  for (const c of CASES) {
    const a = DEFAULT_ASSETS.find((x) => x.name === c.asset);
    const f = a.fields.find((x) => x.field_name === c.field);
    console.log(`\n${'='.repeat(78)}`);
    console.log(`${c.asset} / ${c.field}   floor ${f.char_min}, ceiling ${f.char_max}   ${RUNS} runs per arm`);
    console.log('='.repeat(78));

    for (const withFloor of [false, true]) {
      const label = withFloor ? 'AFTER  (floor stated)' : 'BEFORE (ceiling only)';
      const r = await arm(c.asset, c.field, withFloor);
      const inBand = r.counts.filter((n) => typeof n === 'number' && n >= f.char_min && n <= f.char_max).length;
      const under = r.counts.filter((n) => typeof n === 'number' && n < f.char_min).length;
      const over = r.counts.filter((n) => typeof n === 'number' && n > f.char_max).length;
      console.log(`\n${label}`);
      console.log(`  counts : ${r.counts.join(', ')}`);
      console.log(`  median : ${median(r.counts)}   in-band ${inBand}/${RUNS}   under ${under}   over ${over}`);
      r.samples.forEach((s, i) => console.log(`    ${String(r.counts[i]).padStart(4)}  ${s}`));
    }
  }
})();
