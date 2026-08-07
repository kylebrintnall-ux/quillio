'use strict';

// A/B: does telling the drafter to INFER the funnel stage change the copy — and
// does it change it in the two specific directions the instruction predicts?
//
// THE CONTROL IS ONE PARAMETER. `funnelInference: false` omits the block and
// reproduces the prompt exactly as it was before it existed; `true` (the default,
// and what production sends) includes it. Same code path, same call, same model.
// Nothing is stubbed and no old code is checked out. That flag exists ONLY for
// this script — floorAB got a free control because `char_min: 0` was already a
// real production value; there is no lucky equivalent here.
//
// TWO ASSETS, DELIBERATELY AT OPPOSITE ENDS, ON THE SAME BRIEF:
//
//   Organic Social — LinkedIn   TOP of funnel. A cold, scrolling audience that
//                               has never heard of the product. The failure to
//                               watch is copy that ASSUMES TRUST — booking a
//                               demo, "your team already knows", product-name
//                               -first, an ask that presumes a relationship.
//   Event Reminder Email        BOTTOM of funnel. The reader ALREADY REGISTERED.
//                               The failure to watch is RE-SELLING — restating
//                               the value proposition to somebody who has said
//                               yes, instead of getting them to turn up.
//
// The brief is identical for both. If the instruction is doing anything, the two
// arms should diverge in opposite directions on the two assets — that is a
// sharper question than "did the copy change", which any added instruction
// achieves.
//
// REPORT THE SPREAD AND READ THE EXTREMES. Per the standing rule (CLAUDE.md), a
// compliance count cannot tell redundancy leaving from range leaving. Every
// sample is printed with its length; the min and max of each arm are marked, and
// whoever runs this reads those two lines. The keyword tallies below are
// LABELLED HINTS and nothing else — they are the same class of lexical metric
// that was blind to the entire cohesion change (2.81 in both arms), and they
// cannot see the thing that matters here, which is whether the copy CHANGED ITS
// JOB. Do not report a run from the tallies.
//
// MAKES REAL MODEL CALLS — 2 assets x 2 arms x N runs, one batch call each. It
// writes NOTHING: no database, no Drive, no Doc. Read-only against Gemini, so it
// is safe to run in production, which is the only place with a key.
//
// Run it in the Railway console as plain node — NEVER `railway run`, same rule
// as the migrations (the console already has GEMINI_API_KEY in its environment):
//
//   node scripts/funnelAB.js        # 5 runs per arm (20 calls)
//   node scripts/funnelAB.js 3      # fewer

const { generateAssetDrafts } = require('../src/services/gemini');
const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');

const RUNS = Number(process.argv[2]) || 5;

const CASES = [
  {
    asset: 'Organic Social — LinkedIn',
    end: 'TOP of funnel — cold, scrolling, no trust yet',
    // HINT ONLY. Language that presumes a relationship or a decision already
    // made. On a cold post these are the tell that the model wrote for an
    // audience it does not have.
    watch: 'assumes trust',
    markers: [
      /\bbook (a|your) demo\b/i, /\bschedule (a|your)\b/i, /\bget started\b/i,
      /\bsign up\b/i, /\bstart your (free )?trial\b/i, /\bupgrade\b/i,
      /\byou already know\b/i, /\bas you know\b/i, /\byour team already\b/i,
    ],
  },
  {
    asset: 'Event Reminder Email',
    end: 'BOTTOM of funnel — already registered, just needs to turn up',
    // HINT ONLY. Value-proposition language aimed at somebody still deciding.
    // To a registrant it is a re-pitch of a decision they already made.
    watch: 're-sells',
    markers: [
      /\bdiscover\b/i, /\blearn (how|why|what)\b/i, /\bfind out (how|why)\b/i,
      /\bwhy attend\b/i, /\bdon't miss out on\b/i, /\bregister (now|today)\b/i,
      /\bsecure your (spot|seat|place)\b/i, /\bsave your (spot|seat)\b/i,
    ],
  },
];

// One brief, both assets. Deliberately says nothing about funnel stage — the
// whole question is whether the model infers it from the ASSET plus this text.
const BRIEF = {
  brief:
    'We are running the Q3 launch push for Quillio. Quillio turns a campaign brief '
    + 'into a formatted, on-brand copy doc in about a minute, so marketing teams stop '
    + 'rewriting the same brief into six different asset templates. The audience is '
    + 'marketing leads at mid-size B2B companies who are drowning in asset requests. '
    + 'We are also running a launch webinar on the 18th.',
  summary:
    'Quillio turns a campaign brief into a formatted, on-brand copy doc in about a minute, '
    + 'so marketing teams stop rewriting the same brief into six different asset templates.',
  writerPrompt:
    'Speak to a marketing lead at a mid-size B2B company who is drowning in asset requests. '
    + 'Lead with the time they get back. Concrete, not clever.',
};

function fieldsFor(asset) {
  return (asset.fields || []).map((f) => ({
    fieldName: f.field_name,
    charMin: f.char_min || 0,
    charMax: f.char_max || 0,
    fieldType: f.field_type === 'words' ? 'words' : 'text',
    notes: '',
  }));
}

async function arm(asset, funnelInference) {
  // runs[i] = { fieldName -> copy } for one whole-asset batch call.
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    try {
      const drafts = await generateAssetDrafts({
        assetType: asset.name,
        assetDirection: asset.asset_direction || '',
        brief: BRIEF.brief,
        summary: BRIEF.summary,
        writerPrompt: BRIEF.writerPrompt,
        fields: fieldsFor(asset),
        voiceGuide: '',
        funnelInference,
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
    min: v[0],
    max: v[v.length - 1],
    spread: v[v.length - 1] - v[0],
    median: v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2),
  };
}

function hitCount(texts, markers) {
  return texts.filter((t) => markers.some((re) => re.test(t))).length;
}

(async () => {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set — this makes real model calls and cannot be faked.');
    process.exit(1);
  }

  for (const c of CASES) {
    const asset = DEFAULT_ASSETS.find((x) => x.name === c.asset);
    if (!asset) throw new Error(`asset not in the bundled library: ${c.asset}`);

    console.log(`\n${'='.repeat(78)}`);
    console.log(`${asset.name}`);
    console.log(`${c.end}`);
    console.log(`watching for: ${c.watch}   ${RUNS} runs per arm`);
    console.log('='.repeat(78));

    const results = {};
    for (const on of [false, true]) {
      const label = on ? 'AFTER  (funnel inference stated)' : 'BEFORE (no funnel instruction)';
      const runs = await arm(asset, on);
      results[String(on)] = runs;

      console.log(`\n${label}`);
      const allText = [];
      for (const f of asset.fields) {
        const name = f.field_name;
        const copies = runs.map((r) => (r.__error ? `ERROR: ${r.__error}` : (r[name] || '')));
        const lens = copies.map((s) => (s.startsWith('ERROR:') ? null : s.length));
        const s = stats(lens);
        allText.push(...copies.filter((x) => x && !x.startsWith('ERROR:')));

        console.log(`\n  ${name}  [${f.char_min}-${f.char_max}]`);
        console.log(
          `    lengths: ${lens.join(', ')}`
          + (s ? `   median ${s.median}   SPREAD ${s.spread} (${s.min}-${s.max})` : '')
        );
        // EVERY SAMPLE, and the two extremes marked. The punchiest line in the
        // floor run was the one that disappeared, and only reading it showed that.
        copies.forEach((t, i) => {
          const n = lens[i];
          const mark = s && n === s.min ? ' <- MIN' : s && n === s.max ? ' <- MAX' : '';
          console.log(`      ${String(n).padStart(4)}  ${t}${mark}`);
        });
      }

      console.log(
        `\n  HINT ONLY — "${c.watch}" markers in ${hitCount(allText, c.markers)} of ${allText.length} lines.`
      );
      console.log('  A keyword tally cannot see whether the copy changed its JOB. Read the copy.');
    }

    // The comparison that is actually the point: did the marker rate move in the
    // direction the instruction predicts, on THIS end of the funnel?
    const before = results.false.flatMap((r) => Object.values(r).filter((v) => typeof v === 'string'));
    const after = results.true.flatMap((r) => Object.values(r).filter((v) => typeof v === 'string'));
    console.log(`\n  ${asset.name} — "${c.watch}" hint, BEFORE ${hitCount(before, c.markers)}/${before.length}`
      + ` → AFTER ${hitCount(after, c.markers)}/${after.length}`);
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log('READ BOTH EXTREMES IN EVERY ARM BEFORE CONCLUDING ANYTHING.');
  console.log('A narrower spread is only a win if what left was redundancy. If the line');
  console.log('that disappeared was the best one, the instruction cost range and that is');
  console.log('a loss no in-band count will ever show you.');
  console.log('='.repeat(78));
})();
