'use strict';

// Synthetic precision harness for the agentic spec-reading layer.
//
// ════════════════════════════════════════════════════════════════════════════
// WHAT THIS MEASURES, AND WHAT IT DOES NOT. Read this before quoting a number
// out of it.
//
// It measures TRIGGER COVERAGE ON PAGES WE WROTE OURSELVES. Every fixture below
// is a literal HTML string in this file, built to trip one specific ambiguity
// trigger. A pass means the trigger fired on an input constructed to trip it.
//
// IT IS NOT A MEASUREMENT OF REAL-WORLD PRECISION. A model that scores 7/7 here
// may still do worse on Meta's or LinkedIn's actual markup, which is longer,
// noisier, and not written by the person choosing the test cases. This is the
// same limitation services/specAgent.js and scripts/agentProposalReport.js
// already state about the is_test row — "the test page is fabricated seed
// content, so scoring against it would be measuring precision on fiction" — and
// it applies here in full. The harness buys a LOWER BOUND on trigger coverage,
// available on demand, where previously nothing was available at all.
//
// So the honest sentence to quote is "every ambiguity trigger fires on a page
// built to trip it", and explicitly NOT "the extraction is accurate". The run
// prints this caveat itself, because CLAUDE.md records the failure where a tool
// measuring one property made the others feel covered.
//
// WHY IT EXISTS. A stored proposal only happens when the detector CONFIRMS a
// change on one of twelve watched platform pages. Every measured run on record
// reports them all unchanged, so the real-world sample is empty and accrues at
// approximately zero. The is_test row is the only page anybody can move on
// demand, and agentProposalReport refuses to score it (correctly). The result is
// that extraction precision had no controllable input whatsoever. This is that
// input, with its fiction clearly labelled.
// ════════════════════════════════════════════════════════════════════════════
//
// READ-ONLY. No database connection, no writes to any table, not in `npm test`
// (it needs a GEMINI_API_KEY and makes real model calls — same posture as
// scripts/checkContrast.js).
//
//   node scripts/agentExtractAB.js              # real Gemini, all fixtures
//   node scripts/agentExtractAB.js --selftest   # no key, no network, no DB
//   node scripts/agentExtractAB.js --only=conditional
//   node scripts/agentExtractAB.js --runs=1
//
// IT DRIVES readSpecProposal, NOT extractSpecValuesDetailed. The citation gate,
// the confidence capping and every ambiguity trigger live in specAgent above the
// extraction call, and they are the subject. CLAUDE.md records two incidents
// from measuring one layer below production's entry point: the per-field note
// whose A/B called generateAssetDrafts directly and so never noticed production
// passed no `notes` at all, and scripts/lib/realDraftPath.js whose fetch shim
// implemented only the success path.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const specAgent = require('../src/services/specAgent');
const { readSpecProposal, buildFieldProposal, collapseCurrentCharMax, readerEnabled } = specAgent;

const SPEC_WATCH_PATH = path.join(__dirname, '..', 'src', 'db', 'specWatch.js');

// ─── The schema assertion ───────────────────────────────────────────────────
//
// Every key a fixture row carries must be a column getWatchList can actually
// SELECT, so a fixture cannot invent a field the production row would never
// have. getWatchList needs a database and this harness has none, so the column
// list is derived from the constants that build its SELECT.
//
// DERIVED FROM SOURCE, AND MADE SAFE RATHER THAN TRUSTED. A regex over source is
// exactly the fragile thing this repo warns about, so the derivation asserts its
// own result: five named constants must all be found, a floor on the column
// count, and four sentinel columns must be present. A rename then fails LOUDLY
// here instead of quietly shrinking the set and letting a bad fixture key pass.
const COLUMN_CONSTANTS = [
  'WATCH_BASE',
  'ANCHOR_COLS',
  'UNCONFIRMED_COLS',
  'STOP_MARKER_COL',
  'RUN_HISTORY_COLS',
];
const SENTINEL_COLUMNS = ['id', 'affected_fields', 'is_test', 'change_count', 'source_kind'];
const MIN_COLUMNS = 18;

function addColumns(cols, text) {
  for (const raw of text.split(',')) {
    const col = raw.trim().replace(/\s+/g, ' ');
    // Identifier-shaped only. Anything else is punctuation left over from a
    // template literal and must not silently become a "column".
    if (/^[a-z_][a-z0-9_]*$/.test(col)) cols.add(col);
  }
}

function watchListColumns() {
  const src = fs.readFileSync(SPEC_WATCH_PATH, 'utf8');
  const cols = new Set();
  for (const name of COLUMN_CONSTANTS) {
    const m = src.match(new RegExp('const\\s+' + name + '\\s*=\\s*([`\'"])([\\s\\S]*?)\\1'));
    if (!m) {
      throw new Error(
        `agentExtractAB: could not find \`const ${name}\` in src/db/specWatch.js. ` +
          'The watch-list column constants have been renamed or restructured. Fix this ' +
          'derivation rather than deleting the assertion — it is what stops a fixture row ' +
          'carrying a key the production row never has.'
      );
    }
    addColumns(cols, m[2]);
  }

  // AND THE TIER ARRAY SPLICES SOME COLUMNS IN AS LITERALS rather than through a
  // named constant — `source_kind` is one, sitting between two interpolations in
  // each tier's `extra`. The five constants alone therefore do NOT name every
  // column getWatchList can select, which the sentinel check below caught the
  // first time this ran. Parse the tier template literals too: strip the ${...}
  // interpolations (already covered above) and take what is left.
  const tiers = src.match(/const\s+WATCH_TIERS\s*=\s*\[([\s\S]*?)\n\];/);
  if (!tiers) {
    throw new Error(
      'agentExtractAB: could not find `const WATCH_TIERS = [...]` in src/db/specWatch.js. ' +
        'Columns spliced in as literals would be missed. Fix the derivation.'
    );
  }
  for (const lit of tiers[1].match(/`[^`]*`/g) || []) {
    addColumns(cols, lit.slice(1, -1).replace(/\$\{[^}]*\}/g, ','));
  }
  for (const s of SENTINEL_COLUMNS) {
    if (!cols.has(s)) {
      throw new Error(
        `agentExtractAB: derived column set is missing the sentinel "${s}". The derivation ` +
          'is reading the wrong thing — it must not be trusted to bound the fixtures.'
      );
    }
  }
  if (cols.size < MIN_COLUMNS) {
    throw new Error(
      `agentExtractAB: derived only ${cols.size} watch-list columns, expected at least ` +
        `${MIN_COLUMNS}. Partial derivation would let bad fixture keys through.`
    );
  }
  return cols;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────
//
// Each case is a page we wrote, a controlled "current stored value", the watch
// row's change_count, and a PRE-REGISTERED expectation. CLAUDE.md's rule is to
// name the failure before the run, so `expect` is written from reading the
// trigger logic in specAgent, not from a first run's output.
//
// ON change_count, AND THIS IS THE TRAP THIS HARNESS WAS WARNED ABOUT.
// changeHistoryAmbiguity() branches on Object.prototype.hasOwnProperty, so:
//
//     key absent          → change_history_unavailable
//     key present, 0      → first_change_since_baseline
//     key present, > 0    → no history code at all
//
// A rig that simply FORGOT the key would run clean and silently measure a
// different ambiguity set than production produces — the test/lib/docSim.js
// failure exactly (that rig omitted startIndex, every in-paragraph range read as
// "do not touch", and a spec-sweep replay would have corrected nothing and
// PASSED). So omission here is never incidental: a fixture must set
// `omitChangeCount: true` to leave the key off, and buildRow refuses to omit it
// any other way.
//
// WHY MOST FIXTURES USE A NON-ZERO change_count: so their expected ambiguity set
// is purely about the page and the stored value. A 0 would add
// first_change_since_baseline to every case and bury the trigger under test.

const CURRENT = {
  // Shapes matching currentFieldValues' real SELECT: { tenant_id, char_max, spec_note }.
  one: (charMax) => [{ tenant_id: 'T_ONE', char_max: charMax, spec_note: null }],
  diverging: (a, b) => [
    { tenant_id: 'T_ONE', char_max: a, spec_note: null },
    { tenant_id: 'T_TWO', char_max: b, spec_note: null },
  ],
  none: () => [],
};

const FIXTURES = [
  {
    key: 'clean',
    title: 'One field, one plainly stated limit',
    asset: 'X Post',
    field: 'Post Copy',
    changeCount: 7,
    current: CURRENT.one(280),
    // Deliberately ONE number on the whole page: the prompt asks the model for
    // every integer that could plausibly be this field's limit, so a stray
    // dimension or count would legitimately raise multiple_candidates and this
    // case is about the no-ambiguity path.
    page: [
      '<html><body>',
      '<h1>X creative ad specs</h1>',
      '<h2>Post copy</h2>',
      '<p>Post copy: 280 characters.</p>',
      '<p>Keep the post readable and lead with the point you want carried.</p>',
      '</body></html>',
    ].join('\n'),
    expect: { value: 280, codes: [], valueNote: 'the number the page states' },
  },

  {
    key: 'conditional',
    title: 'THE CASE THE LAYER EXISTS FOR — 45, or 30 with a Lead Gen Form CTA',
    asset: 'LinkedIn Carousel Ad',
    field: 'Card 1 Headline',
    changeCount: 4,
    current: CURRENT.one(45),
    // Two published limits for ONE field. An extraction returning 45 with high
    // confidence is not wrong about the page; it is silent about the half that
    // changes the answer. If this case fails, the layer's premise fails.
    page: [
      '<html><body>',
      '<h1>LinkedIn Carousel Ads — specifications</h1>',
      '<h2>Text recommendations</h2>',
      '<p>Card headline: 45 characters.</p>',
      '<p>When the carousel CTA opens a Lead Gen Form rather than a destination',
      'URL, the card headline is limited to 30 characters.</p>',
      '</body></html>',
    ].join('\n'),
    expect: {
      value: null, // either published number is defensible — see valueAny
      valueAny: [45, 30],
      codes: ['conditional_limit', 'multiple_candidates'],
      candidatesInclude: [45, 30],
      valueNote: 'either 45 or 30 — the point is that BOTH are surfaced',
    },
  },

  {
    key: 'silent',
    title: 'Page renders but states no limit for this field',
    asset: 'Meta Single Image Ad',
    field: 'Description',
    // change_count 0 on purpose: this is also the live coverage for
    // first_change_since_baseline, and stacking it here costs nothing because
    // the page itself raises no codes.
    changeCount: 0,
    current: CURRENT.one(30),
    // The Meta Description rule: /image publishes no Description recommendation.
    // The honest output is silence, NOT a number reasoned into existence.
    page: [
      '<html><body>',
      '<h1>Meta single image ads — Facebook Feed</h1>',
      '<h2>Text recommendations</h2>',
      '<p>Primary text and headline recommendations are listed above.</p>',
      '<p>Write a description that gives the reader a reason to act.</p>',
      '</body></html>',
    ].join('\n'),
    expect: {
      value: null,
      valueMustBeNull: true,
      codes: ['first_change_since_baseline'],
      valueNote: 'MUST be null — a number here is an invention',
    },
  },

  {
    key: 'large-delta',
    title: 'Page states a value far from the stored one',
    asset: 'Google Responsive Search Ad',
    field: 'Headline 1',
    changeCount: 6,
    current: CURRENT.one(45),
    page: [
      '<html><body>',
      '<h1>Responsive search ads — character limits</h1>',
      '<p>Each headline may be up to 200 characters.</p>',
      '</body></html>',
    ].join('\n'),
    // |200-45|/45 = 3.44, well past LARGE_DELTA_RATIO (0.5).
    expect: { value: 200, codes: ['large_delta'], valueNote: '45 → 200' },
  },

  {
    key: 'implausible',
    title: 'Page states an absurd value',
    asset: 'Pinterest Pin',
    field: 'Title',
    changeCount: 6,
    current: CURRENT.one(45),
    page: [
      '<html><body>',
      '<h1>Pin specifications</h1>',
      '<p>Title: 99999 characters.</p>',
      '</body></html>',
    ].join('\n'),
    // BOTH fire, and pre-registering only implausible_value would have
    // mis-scored this: 99999 is over IMPLAUSIBLE_CHAR_MAX (5000) AND the ratio
    // against 45 is far past 0.5. Working this out before the run is the whole
    // point of pre-registration.
    expect: {
      value: 99999,
      codes: ['implausible_value', 'large_delta'],
      valueNote: 'both codes — the delta fires as well',
    },
  },

  {
    key: 'diverges',
    title: 'Two tenants hold different stored values',
    asset: 'LinkedIn Single Image Ad',
    field: 'Headline',
    changeCount: 5,
    current: CURRENT.diverging(70, 60),
    page: [
      '<html><body>',
      '<h1>LinkedIn single image ads</h1>',
      '<p>Headline: 70 characters.</p>',
      '</body></html>',
    ].join('\n'),
    // The diverges branch is an else-if AHEAD of the delta check, so
    // large_delta is skipped even though 70 vs "70 | 60" would otherwise
    // compare. Forced entirely from the runner stub, which is why the stub
    // exists at all.
    expect: {
      value: 70,
      codes: ['current_value_diverges'],
      forbid: ['large_delta'],
      valueNote: 'diverges pre-empts the delta check',
    },
  },

  {
    key: 'unknown-and-no-history',
    title: 'No stored value at all, and a pre-migration watch row',
    asset: 'Quillio Test Asset',
    field: 'Test Headline',
    // DELIBERATE OMISSION, declared rather than forgotten — this is the fixture
    // that exercises change_history_unavailable. buildRow will leave the key off
    // only because of this flag.
    omitChangeCount: true,
    current: CURRENT.none(),
    page: [
      '<html><body>',
      '<h1>Quillio Test Spec</h1>',
      '<p>Test headline: 50 characters.</p>',
      '</body></html>',
    ].join('\n'),
    expect: {
      value: 50,
      codes: ['current_value_unknown', 'change_history_unavailable'],
      forbid: ['large_delta', 'current_value_diverges'],
      valueNote: 'no stored value to compare, and no run-history column',
    },
  },
];

// The four codes NO page content can force, because each is a property of how
// the MODEL quotes rather than of the page. verifyCitation compares the snippet
// against the same pageText the model was given, so a model quoting verbatim
// always lands `exact`; and a number the page does not render is invisible to
// the model too, which collapses into the `silent` case above.
//
// They get DETERMINISTIC coverage in --selftest instead, driven through
// buildFieldProposal with fabricated extraction results. That is the honest
// split: forced where forcing is possible, and never dressed up as a live
// result where it is not.
const SELFTEST_ONLY_CODES = [
  'citation_unverified',
  'citation_fuzzy_match',
  'snippet_omits_number',
  'page_text_truncated',
];

// ─── Rig ────────────────────────────────────────────────────────────────────

function buildRow(fx, columns) {
  const row = {
    id: 9000,
    source_url: `https://synthetic.invalid/${fx.key}`,
    display_name: `synthetic: ${fx.key}`,
    affected_fields: [{ asset: fx.asset, field: fx.field }],
    current_hash: null,
    is_test: true,
    source_kind: 'platform_enforced',
  };
  if (!fx.omitChangeCount) {
    if (!Number.isInteger(fx.changeCount)) {
      throw new Error(
        `fixture "${fx.key}": changeCount must be an integer, or omitChangeCount must be ` +
          'set explicitly. An accidental omission silently swaps ' +
          'first_change_since_baseline for change_history_unavailable.'
      );
    }
    row.change_count = fx.changeCount;
  }
  for (const key of Object.keys(row)) {
    if (!columns.has(key)) {
      throw new Error(
        `fixture "${fx.key}": row key "${key}" is not a column getWatchList selects. ` +
          'Either the schema moved or the fixture invented a field production never has.'
      );
    }
  }
  return row;
}

// The ONLY database call in readSpecProposal's path is
// currentFieldValues(pool, asset, field), which issues one runner.query() and
// returns res.rows. So overriding `runner` is sufficient — and note it beats
// patching specWatch.currentFieldValues, which specAgent DESTRUCTURES at require
// time and would therefore never see the patch (the patch-after-require trap
// this repo has hit more than once).
function stubRunner(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

async function runFixture(fx, columns) {
  const row = buildRow(fx, columns);
  const runner = stubRunner(fx.current);
  const out = await readSpecProposal({
    row,
    pageText: fx.page,
    pageHash: sha(fx.page),
    // One extraction per call, each call its own budget. Deliberately not a
    // large number: the cap is not what is under test here, and a generous max
    // would hide it if the budget logic ever broke.
    budget: { max: 1, used: 0 },
    runner,
  });
  return { out, dbCalls: runner.calls.length };
}

// ─── Verdicts ───────────────────────────────────────────────────────────────

function gradeSample(fx, out) {
  const problems = [];
  if (out === null) {
    return { pass: false, problems: ['readSpecProposal returned null — the reader is OFF'] };
  }
  if (out.status !== 'read') {
    return { pass: false, problems: [`status "${out.status}" (${out.reason || 'no reason'}) — expected "read"`] };
  }
  const f = (out.fields || [])[0];
  if (!f) return { pass: false, problems: ['no field proposal returned'] };

  const got = new Set(f.ambiguities || []);
  const e = fx.expect;

  if (e.valueMustBeNull) {
    if (f.suggestedCharMax != null) {
      problems.push(`INVENTED a value (${f.suggestedCharMax}) on a page that states none`);
    }
  } else if (Array.isArray(e.valueAny)) {
    if (!e.valueAny.includes(f.suggestedCharMax)) {
      problems.push(`value ${f.suggestedCharMax} is not one of ${e.valueAny.join(' / ')}`);
    }
  } else if (e.value != null && f.suggestedCharMax !== e.value) {
    problems.push(`value ${f.suggestedCharMax}, expected ${e.value}`);
  }

  for (const code of e.codes || []) {
    if (!got.has(code)) {
      let why = `missing "${code}"`;
      // conditional_limit can only be evaluated when a snippet VERIFIED —
      // detectConditional runs on the cited text. So "missing" has two very
      // different causes and the harness must say which, or a citation failure
      // reads as the model having missed the condition.
      if (code === 'conditional_limit' && !f.snippet) {
        why += ' — but the snippet did not verify, so the check never ran (citation cause, not a model miss)';
      }
      problems.push(why);
    }
  }
  for (const code of e.forbid || []) {
    if (got.has(code)) problems.push(`unexpected "${code}"`);
  }
  if (Array.isArray(e.codes) && e.codes.length === 0 && got.size > 0) {
    problems.push(`expected no ambiguity, got ${[...got].join(', ')}`);
  }
  for (const n of e.candidatesInclude || []) {
    if (!(f.candidates || []).includes(n)) problems.push(`candidates missing ${n}`);
  }
  // Tier and code must agree whichever way the model quoted — a consistency
  // check rather than a demand, since the tier is not forceable from the page.
  if (f.citationTier !== 'exact' && f.citationTier !== 'none' && !got.has('citation_fuzzy_match')) {
    problems.push(`tier "${f.citationTier}" but no citation_fuzzy_match`);
  }

  return { pass: problems.length === 0, problems };
}

function printSample(fx, i, out, grade, dbCalls) {
  const f = out && (out.fields || [])[0];
  console.log(`    run ${i + 1}: ${grade.pass ? 'PASS' : 'FAIL'}`);
  if (!out) {
    console.log('      (null — reader off)');
  } else if (out.status !== 'read') {
    console.log(`      status=${out.status} reason=${out.reason || '-'}`);
  } else if (f) {
    console.log(`      value       ${f.suggestedCharMax}`);
    console.log(`      current     ${f.currentCharMax || '(none)'}`);
    console.log(`      candidates  [${(f.candidates || []).join(', ')}]`);
    console.log(`      confidence  ${f.confidence}`);
    console.log(`      citation    ${f.citationTier}`);
    console.log(`      snippet     ${f.snippet ? JSON.stringify(f.snippet) : '(emptied)'}`);
    console.log(`      ambiguities [${(f.ambiguities || []).join(', ') || 'none'}]`);
    for (const [code, why] of Object.entries(f.ambiguityDetail || {})) {
      console.log(`         ${code}: ${why}`);
    }
    console.log(`      db reads    ${dbCalls}`);
  }
  for (const p of grade.problems) console.log(`      ✗ ${p}`);
}

const CAVEAT = [
  '',
  '─────────────────────────────────────────────────────────────────────────────',
  'WHAT THIS RUN DOES AND DOES NOT SAY',
  '',
  'It measures whether each ambiguity trigger fires on a page written HERE to',
  'trip it. It is NOT a measurement of real-world precision: these pages are',
  'ours, and a model that passes every case may still do worse on real platform',
  'markup, which is longer, noisier and not written by whoever picked the cases.',
  '',
  'Quote this as "every trigger fires on a page built to trip it".',
  'Do NOT quote it as "the extraction is accurate".',
  '─────────────────────────────────────────────────────────────────────────────',
].join('\n');

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(argv) {
  const only = (argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;
  const runs = Number((argv.find((a) => a.startsWith('--runs=')) || '').split('=')[1]) || 3;

  const columns = watchListColumns();
  console.log(`[agentExtractAB] watch-list columns derived: ${columns.size}`);

  if (!readerEnabled()) {
    console.error(
      '[agentExtractAB] the agentic reader is OFF — set GEMINI_API_KEY (and do not set\n' +
        '  SPEC_AGENT_ENABLED=false). readSpecProposal returns null when it is off, which\n' +
        '  would print as a clean sweep of nulls rather than as an error.'
    );
    process.exit(1);
  }

  const chosen = FIXTURES.filter((f) => !only || f.key === only);
  if (chosen.length === 0) {
    console.error(`[agentExtractAB] no fixture matches --only=${only}`);
    process.exit(1);
  }

  console.log(CAVEAT);
  console.log(`\nfixtures: ${chosen.length}   runs each: ${runs}   (temperature is 0.1 in the real call;`);
  console.log('repeats are here to catch flakiness, not to average out noise)\n');

  const verdicts = [];
  for (const fx of chosen) {
    console.log(`── ${fx.key} — ${fx.title}`);
    console.log(`   ${fx.asset} / ${fx.field}`);
    console.log(`   pre-registered: value ${fx.expect.valueNote}; codes [${(fx.expect.codes || []).join(', ') || 'none'}]`);
    const passes = [];
    for (let i = 0; i < runs; i += 1) {
      const { out, dbCalls } = await runFixture(fx, columns);
      const grade = gradeSample(fx, out);
      printSample(fx, i, out, grade, dbCalls);
      passes.push(grade.pass);
    }
    const n = passes.filter(Boolean).length;
    verdicts.push({ key: fx.key, n, of: runs });
    console.log(`   → ${n}/${runs}\n`);
  }

  console.log('── verdicts against the pre-registration');
  let failed = 0;
  for (const v of verdicts) {
    const all = v.n === v.of;
    if (!all) failed += 1;
    console.log(`   ${all ? 'PASS' : 'FAIL'}  ${v.key}  ${v.n}/${v.of}`);
  }
  console.log(`\n   not forceable from page content, covered in --selftest instead:`);
  console.log(`   ${SELFTEST_ONLY_CODES.join(', ')}`);
  console.log(CAVEAT);

  if (failed) {
    console.error(`\n[agentExtractAB] ${failed} fixture(s) did not meet their pre-registration.`);
    process.exit(1);
  }
}

// ─── Selftest ───────────────────────────────────────────────────────────────
//
// No key, no network, no database. Proves the RIG rather than the model:
//   1. the column derivation works and every fixture row respects it
//   2. the deliberate change_count omission is the only omission possible
//   3. the runner stub feeds collapseCurrentCharMax the shape it expects
//   4. the four non-forceable codes fire, driven through buildFieldProposal
//   5. gradeSample FAILS a bad sample — without this the harness could not fail

function selftest() {
  const assert = require('assert');
  let n = 0;
  const ok = (label, fn) => {
    fn();
    n += 1;
    console.log(`  ok  ${label}`);
  };

  const columns = watchListColumns();
  ok('column derivation finds the real set', () => {
    for (const s of SENTINEL_COLUMNS) assert.ok(columns.has(s), s);
    assert.ok(columns.size >= MIN_COLUMNS);
  });

  ok('every fixture row uses only real columns', () => {
    for (const fx of FIXTURES) buildRow(fx, columns);
  });

  ok('change_count presence matches each fixture\'s declared intent', () => {
    for (const fx of FIXTURES) {
      const row = buildRow(fx, columns);
      const has = Object.prototype.hasOwnProperty.call(row, 'change_count');
      assert.strictEqual(has, !fx.omitChangeCount, fx.key);
      const code = specAgent.changeHistoryAmbiguity(row);
      if (fx.omitChangeCount) assert.strictEqual(code, 'change_history_unavailable', fx.key);
      else if (fx.changeCount === 0) assert.strictEqual(code, 'first_change_since_baseline', fx.key);
      else assert.strictEqual(code, null, fx.key);
    }
  });

  ok('an undeclared omission is refused', () => {
    assert.throws(() => buildRow({ key: 'bad', asset: 'A', field: 'F' }, columns), /omitChangeCount/);
  });

  ok('a fixture inventing a column is refused', () => {
    assert.throws(
      () => {
        const fx = { key: 'bad', asset: 'A', field: 'F', changeCount: 1 };
        const row = buildRow(fx, columns);
        row.not_a_column = 1;
        for (const k of Object.keys(row)) if (!columns.has(k)) throw new Error('row key "not_a_column"');
      },
      /not_a_column/
    );
  });

  ok('the runner stub feeds collapseCurrentCharMax correctly', () => {
    assert.strictEqual(collapseCurrentCharMax(CURRENT.one(45)).numeric, 45);
    assert.strictEqual(collapseCurrentCharMax(CURRENT.diverging(70, 60)).diverges, true);
    assert.strictEqual(collapseCurrentCharMax(CURRENT.none()).numeric, null);
  });

  // The four codes no page can force. Driven straight through buildFieldProposal.
  const field = { asset: 'A', field: 'F', current: collapseCurrentCharMax(CURRENT.one(45)) };
  const PAGE = 'Card headline: 45 characters. Conditional on the CTA type.';

  ok('citation_unverified fires on a quote absent from the page', () => {
    const p = buildFieldProposal({
      field,
      extracted: { suggested_char_max: 45, snippet: 'a quote that is not on the page', candidates: [45], confidence: 'high' },
      pageText: PAGE,
      rowAmbiguities: [],
      truncated: false,
    });
    assert.ok(p.ambiguities.includes('citation_unverified'));
    assert.strictEqual(p.snippet, '', 'the ungrounded quote is emptied');
    assert.strictEqual(p.suggestedCharMax, 45, 'the number survives');
    assert.strictEqual(p.confidence, 'low', 'pinned to the floor');
  });

  ok('citation_fuzzy_match fires on a whitespace-only mismatch', () => {
    const p = buildFieldProposal({
      field,
      extracted: { suggested_char_max: 45, snippet: 'Card  headline:   45 characters.', candidates: [45], confidence: 'high' },
      pageText: PAGE,
      rowAmbiguities: [],
      truncated: false,
    });
    assert.ok(p.ambiguities.includes('citation_fuzzy_match'), p.ambiguities.join(','));
    assert.notStrictEqual(p.citationTier, 'exact');
  });

  ok('snippet_omits_number fires on a verified quote without the number', () => {
    const p = buildFieldProposal({
      field,
      extracted: { suggested_char_max: 45, snippet: 'Conditional on the CTA type.', candidates: [45], confidence: 'high' },
      pageText: PAGE,
      rowAmbiguities: [],
      truncated: false,
    });
    assert.ok(p.ambiguities.includes('snippet_omits_number'), p.ambiguities.join(','));
  });

  ok('page_text_truncated rides through', () => {
    const p = buildFieldProposal({
      field,
      extracted: { suggested_char_max: 45, snippet: 'Card headline: 45 characters.', candidates: [45], confidence: 'high' },
      pageText: PAGE,
      rowAmbiguities: [],
      truncated: true,
    });
    assert.ok(p.ambiguities.includes('page_text_truncated'));
  });

  // WITHOUT THIS THE HARNESS COULD NOT FAIL, which is the defect every
  // measurement entry in CLAUDE.md is about: a green result that is green
  // because nothing was checked.
  ok('gradeSample FAILS a sample that misses its pre-registration', () => {
    const fx = FIXTURES.find((f) => f.key === 'conditional');
    const good = gradeSample(fx, {
      status: 'read',
      fields: [{ suggestedCharMax: 45, candidates: [45, 30], ambiguities: ['conditional_limit', 'multiple_candidates'], citationTier: 'exact', snippet: 'x' }],
    });
    assert.strictEqual(good.pass, true, good.problems.join('; '));

    const bad = gradeSample(fx, {
      status: 'read',
      fields: [{ suggestedCharMax: 45, candidates: [45], ambiguities: [], citationTier: 'exact', snippet: 'x' }],
    });
    assert.strictEqual(bad.pass, false);
    assert.ok(bad.problems.some((p) => p.includes('conditional_limit')));
    assert.ok(bad.problems.some((p) => p.includes('candidates missing 30')));

    const invented = gradeSample(FIXTURES.find((f) => f.key === 'silent'), {
      status: 'read',
      fields: [{ suggestedCharMax: 30, candidates: [30], ambiguities: ['first_change_since_baseline'], citationTier: 'exact', snippet: 'x' }],
    });
    assert.strictEqual(invented.pass, false);
    assert.ok(invented.problems.some((p) => p.includes('INVENTED')));
  });

  ok('the missing-conditional diagnosis names the citation cause', () => {
    const fx = FIXTURES.find((f) => f.key === 'conditional');
    const g = gradeSample(fx, {
      status: 'read',
      fields: [{ suggestedCharMax: 45, candidates: [45, 30], ambiguities: ['multiple_candidates'], citationTier: 'none', snippet: '' }],
    });
    assert.ok(g.problems.some((p) => p.includes('citation cause')), g.problems.join('; '));
  });

  ok('a null return is graded as reader-off, not as a pass', () => {
    const g = gradeSample(FIXTURES[0], null);
    assert.strictEqual(g.pass, false);
    assert.ok(g.problems[0].includes('reader is OFF'));
  });

  console.log(`\n[agentExtractAB --selftest] ${n} checks passed. No key, no network, no database.`);
  console.log('This proves the RIG. It says nothing about the model.');
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    try {
      selftest();
      process.exit(0);
    } catch (err) {
      console.error('[agentExtractAB --selftest] FAILED:', err && err.stack ? err.stack : err);
      process.exit(1);
    }
  } else {
    main(argv).catch((err) => {
      console.error('[agentExtractAB] FAILED:', err && err.stack ? err.stack : err);
      process.exit(1);
    });
  }
}

module.exports = { FIXTURES, buildRow, stubRunner, gradeSample, watchListColumns, SELFTEST_ONLY_CODES };
