'use strict';

// REPLAY TESTS for generateDraft's write path.
//
// These drive the REAL generateDraft with a stubbed Gemini transport and a
// stubbed Docs client backed by test/lib/docSim.js, then read the resulting
// DOCUMENT. Nothing here scans source text, deliberately: the defect these were
// written for was two well-formed deleteContentRange requests whose damage was
// entirely in what the second addressed after the first had shortened the doc.
// Every string a source scan could have looked for was present and correct.
//
// The regression case is `two fields under one asset whose names differ only by
// their bracket`. parseDoc strips the bracket to derive fieldName, so
// "Headline [50]" and "Headline [60]" both parse as "Headline"; the draft-to-
// position mapping used to be keyed on that name (last wins), so both fields
// resolved to one position and Phase 1 issued its delete range twice.

const test = require('node:test');
const assert = require('node:assert');

const { Doc, simClients, H2, H3, LABEL, ITALIC, TEXT, BLANK } = require('./lib/docSim');

const gd = require('../src/destinations/googleDocs');
const cfg = require('../src/config');

// Drive generateDraft against `paras`, with Gemini answering every field with
// `reply`. Returns the document, the batches issued, and any thrown error.
async function replay(paras, { reply = 'NEW COPY.', scopedFields = null } = {}) {
  const doc = Doc.from(paras);
  const { clients, batches } = simClients(doc);

  const hadKey = cfg.GEMINI_API_KEY;
  const realFetch = global.fetch;
  cfg.GEMINI_API_KEY = 'test-key';
  // Answer every batch prompt with an object mapping each of the document's own
  // field names to the same copy — what a good Gemini response looks like.
  // `text()` is implemented as well as `json()`: callGemini reads a FAILED
  // response with res.text(), and a double that only implements the happy path
  // turns the first non-2xx into a TypeError instead of the error it was.
  const names = paras
    .filter(([, s]) => s.bold && s.named === 'NORMAL_TEXT')
    .map(([t]) => t.replace(/\s*\[[^\]]*\]\s*$/, '').trim());
  const body = {};
  for (const n of names) body[n] = reply;
  global.fetch = async () => ({
    ok: true,
    text: async () => '',
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }),
  });

  let error = null;
  try {
    await gd.generateDraft('doc', null, clients, null, null, scopedFields, false, null);
  } catch (err) {
    error = err;
  } finally {
    global.fetch = realFetch;
    cfg.GEMINI_API_KEY = hadKey;
  }
  return { doc, batches, error, paragraphs: doc.paragraphs() };
}

// Every bold label in the fixture must still be its own paragraph afterwards.
function labelsIntact(paras, after) {
  const labels = paras.filter(([, s]) => s.bold && s.named === 'NORMAL_TEXT').map(([t]) => t);
  const present = new Set(after);
  return labels.filter((l) => !present.has(l));
}

const HEADER = [
  H2('Campaign Summary'), ITALIC('Q3 always-on demand gen.'),
  H2('Writer Direction'), ITALIC('Confident, concrete.'),
];

// ---------------------------------------------------------------------------

test('replay: the simulator reproduces the Docs index model parseDoc reads back', () => {
  const doc = Doc.from([H3('Asset'), LABEL('Headline [50]'), TEXT('Copy.'), BLANK()]);
  const parsed = gd.parseDoc(doc.toJson());
  assert.strictEqual(parsed.assets.length, 1);
  const f = parsed.assets[0].fields[0];
  assert.strictEqual(f.fieldName, 'Headline');
  // insertIndex is the label paragraph's endIndex; the label starts the doc at 1
  // after the 'Asset\n' heading (6 chars), so it ends at 7 + 'Headline [50]\n'.
  assert.strictEqual(f.insertIndex, 7 + 'Headline [50]\n'.length);
  assert.strictEqual(f.deleteEnd, f.insertIndex + 'Copy.\n'.length);

  // And a delete of [insertIndex, deleteEnd) removes exactly the copy paragraph.
  doc.apply([{ deleteContentRange: { range: { startIndex: f.insertIndex, endIndex: f.deleteEnd } } }]);
  assert.deepStrictEqual(doc.paragraphs(), ['Asset', 'Headline [50]', '']);
});

test('replay: REGRESSION — two fields under one asset differing only by bracket', async () => {
  // The reported production shape. Both labels parse to fieldName "Headline".
  const paras = [
    ...HEADER,
    H3('LinkedIn Single Image Ad'), ITALIC('Punchy · Confident'),
    LABEL('Headline [50]'), TEXT('Old headline one.'), BLANK(),
    LABEL('Headline [60]'), TEXT('Old headline two, which is a good deal longer.'), BLANK(),
    LABEL('Headline (Offer 2) [60]'), TEXT('Old offer two copy.'), BLANK(),
    H3('Demand Gen Nurture Email'), ITALIC('Warm'),
    LABEL('Subject Line 1 [40]'), TEXT('Old subject.'), BLANK(),
  ];

  const { paragraphs, error } = await replay(paras);
  assert.strictEqual(error, null, `generateDraft threw: ${error && error.message}`);

  // 1. No label was cut. Pre-fix this lost "Headline (Offer 2) [60]" and left an
  //    orphaned bracket fragment in its own paragraph.
  assert.deepStrictEqual(labelsIntact(paras, paragraphs), [], 'every label survived as its own paragraph');

  // 2. No orphaned bracket tail anywhere — the signature of a mid-string cut.
  const orphan = paragraphs.find((p) => /^[^[]*\]$/.test(p) && !/\[/.test(p));
  assert.strictEqual(orphan, undefined, `orphaned bracket fragment: ${JSON.stringify(orphan)}`);

  // 3. Both asset headings survived. The second delete used to swallow one whole.
  assert.ok(paragraphs.includes('LinkedIn Single Image Ad'), 'first asset heading survived');
  assert.ok(paragraphs.includes('Demand Gen Nurture Email'), 'second asset heading survived');

  // 4. Each of the two same-named fields got its OWN copy, in its own place —
  //    the actual point, not just the absence of damage.
  const at = (label) => paragraphs[paragraphs.indexOf(label) + 1];
  assert.strictEqual(at('Headline [50]'), 'NEW COPY.', 'first Headline drafted in place');
  assert.strictEqual(at('Headline [60]'), 'NEW COPY.', 'second Headline drafted in place');
  assert.strictEqual(at('Headline (Offer 2) [60]'), 'NEW COPY.');
  assert.strictEqual(at('Subject Line 1 [40]'), 'NEW COPY.');
});

test('replay: the duplicate delete range is gone from the issued requests', async () => {
  const paras = [
    ...HEADER,
    H3('LinkedIn Single Image Ad'), ITALIC('Punchy'),
    LABEL('Headline [50]'), TEXT('Old one.'), BLANK(),
    LABEL('Headline [60]'), TEXT('Old two.'), BLANK(),
  ];
  const { batches, error } = await replay(paras);
  assert.strictEqual(error, null);

  const deletes = batches
    .flat()
    .filter((r) => r.deleteContentRange)
    .map((r) => `${r.deleteContentRange.range.startIndex},${r.deleteContentRange.range.endIndex}`);
  assert.strictEqual(deletes.length, 2, 'one delete per field');
  assert.strictEqual(new Set(deletes).size, deletes.length, `duplicate delete range issued: ${deletes}`);
});

test('replay: a first draft issues no deletes and is unchanged by the fix', async () => {
  const paras = [
    ...HEADER,
    H3('LinkedIn Single Image Ad'), ITALIC('Punchy'),
    LABEL('Intro Text [150]'), BLANK(),
    LABEL('Headline [70]'), BLANK(),
  ];
  const { batches, paragraphs, error } = await replay(paras);
  assert.strictEqual(error, null);
  assert.strictEqual(batches.flat().filter((r) => r.deleteContentRange).length, 0, 'no deletes on a first draft');
  assert.deepStrictEqual(labelsIntact(paras, paragraphs), []);
  const at = (label) => paragraphs[paragraphs.indexOf(label) + 1];
  assert.strictEqual(at('Intro Text [150]'), 'NEW COPY.');
  assert.strictEqual(at('Headline [70]'), 'NEW COPY.');
});

test('replay: a well-formed whole-doc regenerate still replaces every field in place', async () => {
  const paras = [
    ...HEADER,
    H3('LinkedIn Single Image Ad'), ITALIC('Punchy'),
    LABEL('Intro Text [150]'), TEXT('Old intro.'), BLANK(),
    LABEL('Headline [70]'), TEXT('Old headline.'), BLANK(),
    H3('Demand Gen Nurture Email'), ITALIC('Warm'),
    LABEL('Headline (Offer 1) [50]'), TEXT('Old offer one.'), BLANK(),
    LABEL('Headline (Offer 2) [60]'), TEXT('Old offer two.'), BLANK(),
  ];
  const { paragraphs, error } = await replay(paras);
  assert.strictEqual(error, null);
  assert.deepStrictEqual(labelsIntact(paras, paragraphs), []);
  const at = (label) => paragraphs[paragraphs.indexOf(label) + 1];
  for (const l of ['Intro Text [150]', 'Headline [70]', 'Headline (Offer 1) [50]', 'Headline (Offer 2) [60]']) {
    assert.strictEqual(at(l), 'NEW COPY.', `${l} replaced in place`);
  }
  // The old copy is gone rather than stacked on top of.
  assert.ok(!paragraphs.some((p) => p.startsWith('Old ')), 'no old copy left behind');
});

test('replay: multi-paragraph existing copy is replaced without touching its label', async () => {
  const paras = [
    ...HEADER,
    H3('LinkedIn Single Image Ad'), ITALIC('Punchy'),
    LABEL('Intro Text [150]'), TEXT('Para one.'), TEXT('Para two.'), TEXT('Para three.'), BLANK(),
    LABEL('Headline [70]'), TEXT('Old headline.'), BLANK(),
  ];
  const { paragraphs, error } = await replay(paras);
  assert.strictEqual(error, null);
  assert.deepStrictEqual(labelsIntact(paras, paragraphs), []);
  assert.ok(!paragraphs.includes('Para two.'), 'all of the multi-paragraph copy was removed');
  assert.strictEqual(paragraphs[paragraphs.indexOf('Intro Text [150]') + 1], 'NEW COPY.');
});

test('replay: an append batch deletes nothing and lands BELOW the existing copy', async () => {
  const paras = [
    ...HEADER,
    H3('LinkedIn Single Image Ad'), ITALIC('Punchy'),
    LABEL('Headline [50]'), TEXT('Existing headline copy.'), BLANK(),
    LABEL('Headline [60]'), TEXT('The other existing copy.'), BLANK(),
  ];
  const doc = Doc.from(paras);
  const { clients, batches } = simClients(doc);

  const hadKey = cfg.GEMINI_API_KEY;
  const realFetch = global.fetch;
  cfg.GEMINI_API_KEY = 'test-key';
  // The scoped/variations path asks for a JSON array of options.
  global.fetch = async () => ({
    ok: true,
    text: async () => '',
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify([{ copy: 'RIFFED.' }]) }] } }],
    }),
  });
  try {
    await gd.generateDraft(
      'doc', null, clients, null, null,
      [{ assetType: 'LinkedIn Single Image Ad', fieldName: 'Headline', instance: 0 }],
      true, null
    );
  } finally {
    global.fetch = realFetch;
    cfg.GEMINI_API_KEY = hadKey;
  }

  const after = doc.paragraphs();
  // Nothing was deleted — the guarantee lives in the data (deleteEnd:null), and
  // this is the behavioural proof of it rather than a source match.
  assert.strictEqual(batches.flat().filter((r) => r.deleteContentRange).length, 0, 'append issues no delete');
  assert.ok(after.includes('Existing headline copy.'), 'existing copy survived');
  assert.ok(after.includes('The other existing copy.'), 'the other field survived');
  assert.deepStrictEqual(labelsIntact(paras, after), [], 'labels intact');

  // And each new batch sits BELOW the copy it was appended to, not above it.
  // Anchored on the "Riff N" header rather than the copy itself: what the model
  // returns is this test's stub, whereas WHERE the batch lands is the behaviour
  // under test. Both fields are in scope — scoping matches on the field NAME, so
  // one selection of "Headline" covers both labels (see the note in the summary).
  for (const label of ['Headline [50]', 'Headline [60]']) {
    const labelAt = after.indexOf(label);
    const copyAt = labelAt + 1;
    const riffAt = after.findIndex((p, i) => i > copyAt && /^Riff \d+$/.test(p));
    assert.ok(riffAt > copyAt, `${label}: the appended batch is below its existing copy`);
    assert.notStrictEqual(after[copyAt], undefined);
    assert.ok(!/^Riff /.test(after[copyAt]), `${label}: nothing was inserted above the existing copy`);
  }
});

// Riff one field N times, one option each, and return the doc's option lines.
async function riffTimes(doorways) {
  const paras = [
    ...HEADER,
    H3('LinkedIn Single Image Ad'), ITALIC('Punchy'),
    LABEL('Headline [70]'), TEXT('Existing headline copy.'), BLANK(),
  ];
  const doc = Doc.from(paras);
  const { clients } = simClients(doc);
  const hadKey = cfg.GEMINI_API_KEY;
  const realFetch = global.fetch;
  cfg.GEMINI_API_KEY = 'test-key';
  try {
    for (const door of doorways) {
      global.fetch = async () => ({
        ok: true,
        text: async () => '',
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify([{ doorway: door, copy: `Copy ${door}` }]) }] } }],
        }),
      });
      // eslint-disable-next-line no-await-in-loop
      await gd.generateDraft('doc', null, clients, null, null,
        [{ assetType: 'LinkedIn Single Image Ad', fieldName: 'Headline', instance: 0,
           variations: [{ angle: door, count: 1, intensity: 'Safe' }] }], true, null);
    }
  } finally {
    global.fetch = realFetch;
    cfg.GEMINI_API_KEY = hadKey;
  }
  return doc.paragraphs().filter((p) => /^\d+\.\s/.test(p));
}

test('replay: successive riffs number continuously, so no two options collide', async () => {
  // THE DEFECT: the append call hardcoded startIndex 1, so every batch restarted
  // its numbering — three riffs on one field wrote "1.", "1.", "1.". Within one
  // batch the numbering was always right, which is why it looked cosmetic.
  const lines = await riffTimes(['Proof', 'Pain', 'Reframe']);
  assert.deepStrictEqual(lines, [
    '1. (Proof) Copy Proof',
    '2. (Pain) Copy Pain',
    '3. (Reframe) Copy Reframe',
  ]);
});

test('replay: the option number is what keeps two same-doorway riffs apart', async () => {
  // NOT COSMETIC. copyReview parses the option number back out of the document
  // and composes the review unit key and the comment locator from it, so two
  // options sharing a doorway collided on an identical key — one variation's
  // review comment reconciled against the other's. Driven through the real
  // parser and the real key builder rather than asserted on the rendered text.
  const { parseNumberedStack } = require('../src/utils/variants');
  const { variationFieldName } = require('../src/services/copyReview');

  const lines = await riffTimes(['Proof', 'Pain', 'Proof']); // two Proofs on purpose
  const opts = parseNumberedStack(lines.join('\n'));
  assert.strictEqual(opts.length, 3, 'all three options parse');
  assert.deepStrictEqual(opts.map((o) => o.index), [1, 2, 3], 'indices are distinct and in order');

  const keys = opts.map((o) => variationFieldName('Headline', o.index, o.doorway));
  assert.strictEqual(new Set(keys).size, 3, `review keys must be distinct, got ${JSON.stringify(keys)}`);
  // The exact collision this fixes: with the old numbering both Proofs were
  // "Headline · option 1 (Proof)".
  assert.strictEqual(
    new Set([1, 1, 1].map((i, n) => variationFieldName('Headline', i, opts[n].doorway))).size,
    2,
    'sanity: restarting at 1 really would have collided'
  );
});

// ---------------------------------------------------------------------------
// The guard, exercised directly. It should be unreachable through generateDraft
// now, so a replay cannot cover it — which is exactly why it is also a unit.

test('guard: overlapping delete ranges are refused, naming both fields', () => {
  const { assertDisjointDeletes } = gd;

  // Disjoint and adjacent are both fine — ranges are half-open, so an end that
  // equals the next start is two regions touching, not overlapping.
  assert.doesNotThrow(() => assertDisjointDeletes([]));
  assert.doesNotThrow(() => assertDisjointDeletes([{ insertIndex: 10, deleteEnd: 20 }]));
  assert.doesNotThrow(() =>
    assertDisjointDeletes([
      { insertIndex: 30, deleteEnd: 40 },
      { insertIndex: 20, deleteEnd: 30 },
      { insertIndex: 10, deleteEnd: 20 },
    ])
  );

  // The duplicate-delete defect: two identical ranges.
  assert.throws(
    () =>
      assertDisjointDeletes([
        { insertIndex: 195, deleteEnd: 266, assetType: 'LinkedIn Single Image Ad', fieldName: 'Headline' },
        { insertIndex: 195, deleteEnd: 266, assetType: 'LinkedIn Single Image Ad', fieldName: 'Headline' },
      ]),
    (err) => {
      assert.match(err.message, /overlapping delete ranges/);
      assert.match(err.message, /\[195, 266\)/, 'names the range');
      assert.match(err.message, /LinkedIn Single Image Ad \/ Headline/, 'names the field');
      assert.match(err.message, /NOT modified/, 'says the document was left alone');
      return true;
    }
  );

  // Partial overlap, in either input order.
  const partial = [
    { insertIndex: 10, deleteEnd: 25, assetType: 'A', fieldName: 'one' },
    { insertIndex: 20, deleteEnd: 30, assetType: 'A', fieldName: 'two' },
  ];
  assert.throws(() => assertDisjointDeletes(partial), /overlapping delete ranges/);
  assert.throws(() => assertDisjointDeletes([...partial].reverse()), /overlapping delete ranges/);
});

test('guard: it runs BEFORE any write, so a refusal leaves the document untouched', async () => {
  // Reach the guard by handing generateDraft a doc whose parse yields overlapping
  // regions is not possible (parseDoc cannot emit them), so drive the ordering
  // claim structurally instead: the guard must precede the Phase 1 batchUpdate.
  //
  // This is the one place a source check is the right instrument — the claim is
  // about ORDER OF EXECUTION in a path that can no longer produce the input, and
  // a replay that cannot trigger the guard cannot prove the guard runs first.
  const src = require('fs').readFileSync(require.resolve('../src/destinations/googleDocs.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function generateDraft(id, direction'));
  const guard = fn.indexOf('assertDisjointDeletes(deletions)');
  const firstWrite = fn.indexOf('await docs.documents.batchUpdate');
  assert.ok(guard > 0, 'generateDraft calls the guard');
  assert.ok(firstWrite > 0, 'generateDraft issues a batchUpdate');
  assert.ok(guard < firstWrite, 'the guard runs before the first write');
});
