'use strict';

// A/B: does giving the batch-failure rescue SIBLING CONTEXT make an asset's
// fields cohere, or are they nine independent lines either way?
//
// generateAssetDrafts writes every field in ONE call, so it can make them
// reference each other. When that response fails to parse, every field falls
// through to a single-field rescue — and until this commit that rescue was given
// no siblings at all. This prints the actual copy, side by side, because a
// character count cannot answer a question about whether nine lines belong
// together.
//
// NO TEST SEAMS, AND NO MOCKED PARSER. Both arms go through the real public API:
//
//   BEFORE  generateFieldDraft called directly, once per field, with exactly the
//           arguments the old rescue passed and no siblings. That IS the old
//           behaviour — the rescue is that call — so this reproduces it without
//           checking out old code or patching a private function.
//
//   AFTER   generateAssetDrafts with global fetch intercepted so the FIRST
//           request (the batch) returns a body whose text reproduces the exact
//           production failure — a complete two-character JSON value with
//           something immediately after it:
//
//               Unexpected non-whitespace character after JSON at position 2
//
//           Every later request goes to the real model untouched. So the real
//           catch runs, the real BATCH_PARSE_FAIL line is logged, and the real
//           sequential rescue loop drafts all nine fields.
//
// Same asset, same brief, same model, same field specs. The one difference is
// whether the rescue can see its siblings.
//
// MAKES REAL MODEL CALLS — 18 drafts plus one intercepted batch. It writes
// NOTHING: no database, no Drive, no Doc. Safe in production, which is the only
// place with a key.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//
//   node scripts/cohesionAB.js

const { generateAssetDrafts, generateFieldDraft } = require('../src/services/gemini');
const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');

const ASSET = 'Demand Gen Nurture Email';

const BRIEF = {
  summary:
    'Quillio turns a campaign brief into a formatted, on-brand copy doc in about a minute, '
    + 'so marketing teams stop rewriting the same brief into six different asset templates.',
  writerPrompt:
    'Speak to a marketing lead at a mid-size B2B company drowning in asset requests. '
    + 'Lead with the time they get back. Concrete, not clever. One offer: a free trial.',
};

// The exact shape seen in production: `{}` immediately followed by content.
const BAD_JSON = '{}{"note":"reasoning leaked here"}';

function specFor(assetName) {
  const a = DEFAULT_ASSETS.find((x) => x.name === assetName);
  if (!a) throw new Error(`asset not found in the seed: ${assetName}`);
  return {
    asset: a,
    fields: a.fields.map((f) => ({
      fieldName: f.field_name,
      charMin: f.char_min,
      charMax: f.char_max,
      fieldType: f.field_type === 'words' ? 'words' : 'text',
      notes: f.spec_note || '',
    })),
  };
}

// BEFORE: the rescue as it was — one call per field, no siblings, nothing shared.
// The argument list mirrors generateAssetDrafts' rescue exactly.
async function armBefore() {
  const { asset, fields } = specFor(ASSET);
  const out = [];
  for (const f of fields) {
    let copy = '';
    try {
      copy = await generateFieldDraft({
        assetType: asset.name,
        fieldName: f.fieldName,
        charMax: f.charMax,
        charMin: f.charMin,
        fieldType: f.fieldType,
        notes: f.notes,
        assetDirection: asset.asset_direction || '',
        summary: BRIEF.summary,
        writerPrompt: BRIEF.writerPrompt,
        voiceGuide: '',
      });
    } catch (err) {
      copy = `ERROR: ${err.message}`;
    }
    out.push({ fieldName: f.fieldName, copy });
  }
  return out;
}

// AFTER: the real path, with the batch response forced to be unparseable.
async function armAfter() {
  const { asset, fields } = specFor(ASSET);
  const realFetch = global.fetch;
  let intercepted = false;
  global.fetch = async (url, opts) => {
    if (!intercepted && String(url).includes('generateContent')) {
      intercepted = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: BAD_JSON }] } }] }),
        text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: BAD_JSON }] } }] }),
      };
    }
    return realFetch(url, opts);
  };
  try {
    const drafts = await generateAssetDrafts({
      assetType: asset.name,
      assetDirection: asset.asset_direction || '',
      summary: BRIEF.summary,
      writerPrompt: BRIEF.writerPrompt,
      fields,
      voiceGuide: '',
    });
    if (!intercepted) console.warn('WARNING: the batch call was never intercepted — the arms are not comparable.');
    return drafts;
  } finally {
    global.fetch = realFetch;
  }
}

(async () => {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set — this makes real model calls and cannot be faked.');
    process.exit(1);
  }

  const { fields } = specFor(ASSET);
  console.log(`Asset: ${ASSET}  (${fields.length} fields)`);
  console.log(`Batch forced to fail with: ${JSON.stringify(BAD_JSON)}\n`);

  console.log('--- drafting BEFORE arm (no siblings) ---');
  const before = await armBefore();
  console.log('--- drafting AFTER arm (siblings, via the real rescue path) ---');
  const after = await armAfter();

  const map = (list) => new Map((list || []).map((d) => [d.fieldName, d.copy]));
  const b = map(before);
  const a = map(after);

  for (const f of fields) {
    const unit = f.fieldType === 'words' ? 'words' : 'chars';
    console.log('\n' + '='.repeat(78));
    console.log(`${f.fieldName}   [${f.charMin}-${f.charMax} ${unit}]`);
    console.log('='.repeat(78));
    console.log(`BEFORE : ${b.get(f.fieldName) || '(none)'}`);
    console.log(`AFTER  : ${a.get(f.fieldName) || '(none)'}`);
  }

  // A hint, printed to prompt reading rather than to stand in for it. Cohesion is
  // NOT word reuse: a set can cohere by carrying one offer through different
  // words, and can repeat words while saying nine unrelated things. If the two
  // numbers are close, that is not evidence the fix did nothing — read the copy.
  const words = (s) => new Set(String(s || '').toLowerCase().match(/[a-z']{4,}/g) || []);
  const meanOverlap = (list) => {
    const m = map(list);
    const sets = fields.map((f) => words(m.get(f.fieldName)));
    let pairs = 0;
    let shared = 0;
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        pairs++;
        for (const w of sets[i]) if (sets[j].has(w)) shared++;
      }
    }
    return pairs ? (shared / pairs).toFixed(2) : '0';
  };
  console.log(`\nmean shared content words per field pair — BEFORE ${meanOverlap(before)}   AFTER ${meanOverlap(after)}`);
  console.log('(a hint, not a verdict — the question is whether the nine read as one email)');
})();
