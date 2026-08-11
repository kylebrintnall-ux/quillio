'use strict';

// A/B: per-field guidance has never reached the copy-doc drafter. Does sending it
// improve the draft, or does a batch of untested instructions arriving at once
// flatten it?
//
// THE QUESTION IS NOT WHETHER THE GUIDANCE APPEARS — it will. It is whether
// guidance the system was designed to send and never sent actually helps. It may
// not. Every measured prompt change in this project has spent variance, and the
// sign has only ever been decided by reading the copy.
//
// THE PRE-REGISTERED FAILURE, NAMED BEFORE THE RUN: UNIFORMITY IN THE OPENING.
// Twelve of the twenty-five newly-arriving notes are the Litmus line — "Mobile
// inboxes cut around 40 characters — front-load the first 40." — on every Subject
// Line and Preheader across the five email assets. That is precisely the
// instruction that produces five subject lines sharing their first four words.
// If invention goes to zero and the openings converge, this is the `char_min`
// floor result in a new place: the Subhead scored 5/5 in band in BOTH arms while
// its spread collapsed from 31 characters to 9, and the punchiest line in the run
// was the one that disappeared.
//
// So `distinct` and `shapes` run on Subject Line 1 in both arms, alongside
// spread and never instead of it, plus an OPENING metric this run adds: how many
// of N samples share their first four words. Spread measures range; templating is
// a property of mode; and neither sees a shared opening with different tails.
//
// THE CONTROL IS ONE PARAMETER. `notes: ''` reproduces the prompt exactly as it
// was while assetTargets dropped them — same builder, same call, same model.
// Nothing is stubbed and no old code is checked out.
//
// DEMAND GEN NURTURE EMAIL, because it exercises four of the twelve Litmus notes
// in a single draft (two Subject Lines, the Preheader) plus the Offer Body 1 note.
//
// MAKES REAL MODEL CALLS — 2 arms x N runs, one batch call each. Writes NOTHING.
// Read-only against Gemini, safe to run in production.
//
//   node scripts/notesAB.js        # 5 runs per arm (10 calls)
//   node scripts/notesAB.js 3      # 6 calls

const { generateAssetDrafts } = require('../src/services/gemini');
const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
const { fieldHint, stripReaderOnlyLines } = require('../src/destinations/googleDocs');

const RUNS = Number(process.argv[2]) || 5;
const ASSET = 'Demand Gen Nurture Email';
const WATCH = 'Subject Line 1';

const BRIEF =
  'Nurture email for our Q3 launch push. Quillio turns a campaign brief into a '
  + 'formatted, on-brand copy doc in about a minute, so marketing teams stop '
  + 'rewriting the same brief into six different asset templates. The audience is '
  + 'marketing leads at mid-size B2B companies who are drowning in asset requests.';
const SUMMARY =
  'Quillio turns a campaign brief into a formatted, on-brand copy doc, so marketing '
  + 'teams stop rewriting the same brief into six different asset templates.';
const WRITER_PROMPT =
  'Speak to a marketing lead at a mid-size B2B company who is drowning in asset '
  + 'requests. Lead with the time they get back. Concrete, not clever.';

// EXACTLY WHAT THE DOC WOULD CARRY, composed the way createDocument composes it
// and recovered the way parseDoc recovers it — so the arm sends the real string
// rather than the seed's raw spec_note. That difference is the whole point: the
// tier line joins the note, and the reader-only sentences are stripped back out.
function noteFor(field) {
  const hint = fieldHint({
    fieldName: field.field_name,
    charMin: field.char_min,
    charMax: field.char_max,
    fieldType: field.field_type,
    specNote: field.spec_note || null,
    specType: field.spec_type || null,
    specSource: field.spec_source || null,
    specOverridden: false,
  });
  return stripReaderOnlyLines(hint ? hint.text : '');
}

function fieldsFor(asset, withNotes) {
  return (asset.fields || []).map((f) => ({
    fieldName: f.field_name,
    charMin: f.char_min || 0,
    charMax: f.char_max || 0,
    fieldType: f.field_type === 'words' ? 'words' : 'text',
    notes: withNotes ? noteFor(f) : '',
  }));
}

async function arm(asset, withNotes) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    try {
      const drafts = await generateAssetDrafts({
        assetType: asset.name,
        assetDirection: asset.asset_direction || '',
        brief: BRIEF,
        summary: SUMMARY,
        writerPrompt: WRITER_PROMPT,
        fields: fieldsFor(asset, withNotes),
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
  return { min: v[0], max: v[v.length - 1], spread: v[v.length - 1] - v[0],
    median: v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2) };
}

const NUM = /(?<![A-Za-z0-9.])\d+(?:\.\d+)?(?![A-Za-z0-9])/g;
const shapeOf = (t) => String(t).toLowerCase().replace(NUM, '#').replace(/[^\w#\s]/g, '').replace(/\s+/g, ' ').trim();
// THE METRIC THIS RUN ADDS. "Front-load the first 40" acts on the OPENING, so the
// failure it can cause is five lines that begin identically and diverge after.
// `distinct` counts those as 5 distinct and `shapes` as 5 shapes; only this sees it.
const openingOf = (t) => shapeOf(t).split(' ').slice(0, 4).join(' ');

function modeOf(values) {
  const by = new Map();
  for (const v of values) by.set(v, (by.get(v) || 0) + 1);
  let top = null; let n = 0;
  for (const [k, c] of by) if (c > n) { top = k; n = c; }
  return { unique: by.size, top, count: n };
}

(async () => {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set — this makes real model calls and cannot be faked.');
    process.exit(1);
  }
  const asset = DEFAULT_ASSETS.find((x) => x.name === ASSET);
  if (!asset) throw new Error(`asset not in the bundled library: ${ASSET}`);

  console.log(`${ASSET} — ${RUNS} runs per arm`);
  console.log('\nWHAT THE AFTER ARM NEWLY SENDS:');
  for (const f of asset.fields) {
    const n = noteFor(f);
    if (n) console.log(`  ${f.field_name.padEnd(22)} ${n}`);
  }

  const summary = [];
  for (const withNotes of [false, true]) {
    const label = withNotes ? 'AFTER  (per-field guidance arrives)' : 'BEFORE (notes dropped, as shipped)';
    console.log(`\n${'='.repeat(78)}\n${label}\n${'='.repeat(78)}`);
    const runs = await arm(asset, withNotes);

    for (const f of fieldsFor(asset, withNotes)) {
      const copies = runs.map((r) => (r.__error ? `ERROR: ${r.__error}` : (r[f.fieldName] || '')));
      const lens = copies.map((c) => (c.startsWith('ERROR:') ? null : c.length));
      const s = stats(lens);
      const watched = f.fieldName === WATCH ? '   <<< WATCHED' : '';
      console.log(`\n  ${f.fieldName}  [${f.charMin}-${f.charMax}]${watched}`);
      console.log(`    lengths: ${lens.join(', ')}` + (s ? `   median ${s.median}   SPREAD ${s.spread} (${s.min}-${s.max})` : ''));
      copies.forEach((t, i) => {
        const mark = s && lens[i] === s.min ? ' <- MIN' : s && lens[i] === s.max ? ' <- MAX' : '';
        console.log(`      ${String(lens[i]).padStart(4)}  ${t}${mark}`);
      });

      if (f.fieldName === WATCH) {
        const real = copies.filter((c) => c && !c.startsWith('ERROR:'));
        const d = modeOf(real);
        const sh = modeOf(real.map(shapeOf));
        const op = modeOf(real.map(openingOf));
        console.log(`    distinct ${d.unique}/${real.length}   shapes ${sh.unique}/${real.length}   OPENINGS ${op.unique}/${real.length}`);
        if (op.count > 1) console.log(`    shared opening x${op.count}: "${op.top}"`);
        summary.push({ arm: withNotes ? 'AFTER' : 'BEFORE', n: real.length,
          distinct: d.unique, shapes: sh.unique, openings: op.unique, spread: s ? s.spread : null });
      }
    }
  }

  console.log(`\n${'='.repeat(78)}\n${WATCH} — the watched field\n${'='.repeat(78)}`);
  console.log(`${'arm'.padEnd(9)}${'spread'.padEnd(9)}${'distinct'.padEnd(11)}${'shapes'.padEnd(9)}openings`);
  for (const r of summary) {
    console.log(`${r.arm.padEnd(9)}${String(r.spread).padEnd(9)}${`${r.distinct}/${r.n}`.padEnd(11)}`
      + `${`${r.shapes}/${r.n}`.padEnd(9)}${r.openings}/${r.n}`);
  }
  console.log('');
  console.log('READ IT LIKE THIS:');
  console.log('  openings collapse, distinct holds  -> "front-load the first 40" is acting on');
  console.log('     the opening. Five lines that begin the same and diverge after read as');
  console.log('     5/5 distinct AND 5/5 shapes — only the openings column sees it.');
  console.log('  spread collapses                   -> the floorAB result in a new place.');
  console.log('  nothing moves                      -> the guidance is inert, and 25 notes of');
  console.log('     prompt is being paid for nothing.');
  console.log('');
  console.log('AND READ THE COPY. The question is whether the drafts got BETTER, and no');
  console.log('column above answers that. Compare the MIN and MAX of each arm by eye.');
})();
