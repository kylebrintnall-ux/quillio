'use strict';

// Manual check for the parse step: run REAL briefs through the parse the
// adapters call and print what the model returned.
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
// Prove the harness works before spending 13 model calls on it:
//   node scripts/checkParsePlans.js --selftest      (no key, no network)
//
// TWO GROUPS OF CASES, measuring different things.
//
// COUNT_CASES came first and ask whether a NUMBER survives the parse:
//   • an explicit number becomes a count, not several entries
//   • a number crossed with named groups multiplies, and the groups become labels
//   • A/B phrasing produces count > 1 of the BASE asset, never a "— Variant A" type
//   • a plain one-of-each brief is all count 1 (the backward-compatible case)
//   • a vague plural does NOT invent a number
//   • a vague brief still returns a small sensible set
//
// MATCH_CASES ask a question nothing here has ever asked: when the brief names a
// deliverable, does the model reach the asset the brief MEANT?
//
// The refusal path is measured and the substitution path is not. `parseBrief`'s
// prompt tells the model to put an unmappable phrase in `unmatchedAssets` rather
// than guess, and both adapters surface that list — so a brief asking for a
// billboard fails loudly and correctly. But a brief asking for something with a
// plausible NEIGHBOUR is mapped onto that neighbour, and no gate downstream
// compares the asset returned against the words that produced it
// (tenantAssetsToSpecs and sanitizeAssetPlan both check the name against the
// LIBRARY, never against the BRIEF). The known instance is the phrase table in
// services/gemini.js routing a bare "landing page" to Event Landing Page while
// Campaign Landing Page is reachable only by the literal phrase "campaign page".
//
// THE VERDICT IS PRE-REGISTERED, per CLAUDE.md's rule that a count only earns
// trust when you named the failure before the run. Every probe below declares
// which assets are RIGHT, which are the known-bad WRONG, and which are
// DEFENSIBLE, and the summary table classifies against those lists rather than
// against a reading of the output. Anything the lists do not mention prints as
// UNEXPECTED and is for a human to judge — that column existing is the point.
//
// AND EVERY PLAN IS PRINTED, because the table cannot see quality. This whole
// file's history is counts that were blind to what actually changed.
//
// THE ENTRY POINT IS pipeline.parseBrief, NOT gemini.parseBrief — changed here
// deliberately. This script used to call the Gemini layer directly, which skips
// resolveAssetVocabulary and resolveTemplateVocabulary and so measured a parse
// no adapter performs. CLAUDE.md's recorded lesson from the notes A/B is exactly
// this: check the measurement calls the entry point production calls. With no
// tenant id it degrades to config.ALLOWED_ASSETS and no templates, which is what
// a stock tenant's library resolves to anyway — but the wire is now the real one.

// --- The count/label cases (unchanged) --------------------------------------
const COUNT_CASES = [
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

// --- The matching cases ------------------------------------------------------
//
// `probes` are the deliverables the brief names, in the brief's OWN WORDS —
// which is the thing the parse does not retain and this script exists to put
// back beside the answer.
//
//   right       an asset that answers the phrase. EMPTY means no asset does, so
//               the correct outcome is a refusal into unmatchedAssets.
//   wrong       the known-bad substitution this probe is watching for.
//   defensible  neither ideal nor a defect — recorded, not scored.
//
// A returned asset in none of the three lists prints as UNEXPECTED rather than
// being folded into one, because a list that absorbs its own surprises stops
// being a pre-registration.
const MATCH_CASES = [
  {
    id: 'ambiguous-landing',
    brief:
      'We are launching Quillio Copilot on September 9. It writes campaign copy from a brief. ' +
      'We need a landing page and an announcement email to go out to our customer list.',
    why: 'THE REPORTED FAILURE. A product launch, no event anywhere in it, and a bare "landing page".',
    probes: [
      {
        phrase: 'a landing page',
        right: ['Campaign Landing Page'],
        wrong: ['Event Landing Page'],
        note: 'nothing in this brief is an event. Event Landing Page brings Stat 1-3 and four benefit blocks.',
      },
      {
        phrase: 'an announcement email',
        right: [],
        wrong: ['Event Invitation Email', 'Event Reminder Email', 'Event Follow-Up / Recap Email'],
        defensible: ['Demand Gen Nurture Email'],
        note: 'there IS no announcement email asset. Refusing is a correct answer; nurture is the nearest thing and is a two-offer promo shape.',
      },
    ],
  },
  {
    id: 'literal-campaign-page',
    brief:
      'We are launching Quillio Copilot on September 9. It writes campaign copy from a brief. ' +
      'We need a campaign page and an announcement email to go out to our customer list.',
    why: 'THE CONTROL. Identical brief, the one literal phrase the table routes to Campaign Landing Page. '
      + 'If this lands and the case above does not, the difference is the route rather than the model.',
    probes: [
      {
        phrase: 'a campaign page',
        right: ['Campaign Landing Page'],
        wrong: ['Event Landing Page'],
        note: 'the literal phrase in ASSET_PHRASE_HINTS.',
      },
      {
        phrase: 'an announcement email',
        right: [],
        wrong: ['Event Invitation Email'],
        defensible: ['Demand Gen Nurture Email'],
      },
    ],
  },
  {
    id: 'event-landing-still-works',
    brief:
      'We are hosting DevSummit on October 3 at the Austin Convention Center. ' +
      'We need a landing page for the event and a reminder email to everyone who registered.',
    why: 'THE GUARD RAIL. A bare "landing page" WITH an event signal must still reach the event asset. '
      + 'Any change that routes bare "landing page" to Campaign has to leave this alone, and without '
      + 'this case a regression here is invisible.',
    probes: [
      {
        phrase: 'a landing page for the event',
        right: ['Event Landing Page'],
        wrong: ['Campaign Landing Page'],
        note: 'a date, a venue and the word "event" — every signal there is.',
      },
      {
        phrase: 'a reminder email',
        right: ['Event Reminder Email'],
        wrong: ['Event Invitation Email', 'Demand Gen Nurture Email'],
      },
    ],
  },
  {
    id: 'no-neighbour',
    brief:
      'For the Copilot launch we need a press release for the trade press and a customer case study ' +
      'featuring Northwind, who cut their brief turnaround from two days to twenty minutes.',
    why: 'NO NEIGHBOUR AT ALL. The library has no long-form asset of any kind. Every asset returned here '
      + 'is a substitution, and the refusal path is what should fire.',
    probes: [
      {
        phrase: 'a press release',
        right: [],
        wrong: ['One-Pager', 'Campaign Landing Page', 'Demand Gen Nurture Email', 'Battle Card'],
        note: 'must land in unmatchedAssets. Anything else is the silent substitution.',
      },
      {
        phrase: 'a customer case study',
        right: [],
        wrong: ['One-Pager', 'Battle Card', 'Campaign Landing Page'],
        note: 'One-Pager has a Proof Point field, which is a line, not a case study.',
      },
    ],
  },
  {
    id: 'clean-plus-ambiguous',
    brief:
      'New pricing goes live next month. We need three LinkedIn ads and a landing page to send them to.',
    why: 'MIXED. One unambiguous ask beside one ambiguous one — does a clean match nearby change the '
      + 'ambiguous one, and does the count survive?',
    probes: [
      {
        phrase: 'three LinkedIn ads',
        right: ['LinkedIn Single Image Ad'],
        wrong: ['LinkedIn Carousel Ad'],
        expectCount: 3,
        note: 'the clean match. Also re-checks that a count survives beside an ambiguous sibling.',
      },
      {
        phrase: 'a landing page',
        right: ['Campaign Landing Page'],
        wrong: ['Event Landing Page'],
      },
    ],
  },
  {
    id: 'bare-email',
    brief:
      'Send an email to our install base telling them the Salesforce integration is out of beta.',
    why: 'THE "email" ROUTE. The table maps a bare "email" to Demand Gen Nurture Email, a two-offer '
      + 'promotional shape. This brief has one message and no offer.',
    probes: [
      {
        phrase: 'an email',
        right: [],
        wrong: ['Event Invitation Email', 'Event Reminder Email', 'Sales Basho Email'],
        defensible: ['Demand Gen Nurture Email'],
        note: 'no product-announcement email asset exists. Recording what the bare route does, not scoring it.',
      },
    ],
  },
  {
    id: 'bare-display',
    brief: 'We want display ads running against the launch for six weeks.',
    why: 'THE "display" ROUTE. Two assets answer to it — Display Banner — Standard and Google '
      + 'Responsive Display Ad — and the table names only the first.',
    probes: [
      {
        phrase: 'display ads',
        right: ['Display Banner — Standard', 'Google Responsive Display Ad'],
        note: 'both are genuinely correct readings. Watching whether it picks one silently or asks for both.',
      },
    ],
  },
  {
    id: 'bare-organic',
    brief: 'Some organic social to support the launch, plus a couple of paid posts.',
    why: 'THE "organic" ROUTE. Three organic assets exist and the table names LinkedIn.',
    probes: [
      {
        phrase: 'some organic social',
        right: ['Organic Social — LinkedIn', 'Organic Social — Instagram', 'Organic Social — Twitter/X'],
        note: 'no platform named, so any is defensible — the question is whether it silently picks one.',
      },
    ],
  },
];

function render(plan) {
  if (!Array.isArray(plan) || plan.length === 0) return '    (empty — the brief named nothing to build)';
  return plan
    .map((e) => {
      const labels = Array.isArray(e.labels) && e.labels.some(Boolean) ? `  labels: ${JSON.stringify(e.labels)}` : '';
      return `    ${String(e.count).padStart(2)} x ${e.asset}${labels}`;
    })
    .join('\n');
}

// Classify one case's plan against its pre-registered probes.
//
// Attribution is by NAME: a returned asset belongs to the first probe naming it
// in any of its three lists. That is crude and it is deliberate — the alternative
// is asking the model which phrase produced which asset, which is the very thing
// the parse does not carry and which this measurement exists to price.
function classify(kase, parsed) {
  const plan = Array.isArray(parsed.assets) ? parsed.assets : [];
  const unmatched = [...(parsed.unmatchedAssets || []), ...(parsed.unmatchedTemplates || [])];
  const rows = [];
  const claimed = new Set();

  for (const probe of kase.probes) {
    const right = probe.right || [];
    const wrong = probe.wrong || [];
    const defensible = probe.defensible || [];
    const hit = plan.find(
      (e) => !claimed.has(e) && (right.includes(e.asset) || wrong.includes(e.asset) || defensible.includes(e.asset))
    );

    if (!hit) {
      // Nothing was built for this phrase. When no asset could have been right,
      // that IS the right answer — but only if the refusal actually surfaced.
      if (right.length === 0) {
        const refused = unmatched.length > 0;
        rows.push({
          phrase: probe.phrase,
          chose: refused ? `(refused: ${unmatched.join(', ')})` : '(nothing, and nothing refused)',
          verdict: refused ? 'RIGHT' : 'UNEXPECTED',
          note: refused ? 'refused rather than substituted' : 'dropped silently — worse than either outcome',
        });
      } else {
        rows.push({ phrase: probe.phrase, chose: '(nothing)', verdict: 'MISSING', note: probe.note || '' });
      }
      continue;
    }

    claimed.add(hit);
    let verdict = right.includes(hit.asset) ? 'RIGHT' : wrong.includes(hit.asset) ? 'WRONG' : 'DEFENSIBLE';
    let note = probe.note || '';
    if (verdict === 'RIGHT' && probe.expectCount && (hit.count || 1) !== probe.expectCount) {
      verdict = 'WRONG';
      note = `right asset, count ${hit.count || 1} where the brief said ${probe.expectCount}. ${note}`.trim();
    }
    rows.push({ phrase: probe.phrase, chose: `${hit.count || 1} x ${hit.asset}`, verdict, note });
  }

  // Anything built that no probe named. On a no-neighbour brief this is the
  // substitution itself; elsewhere it is the model adding work nobody asked for.
  for (const e of plan) {
    if (claimed.has(e)) continue;
    rows.push({
      phrase: '(not asked for)',
      chose: `${e.count || 1} x ${e.asset}`,
      verdict: 'UNEXPECTED',
      note: 'no probe named this — the brief did not ask for it',
    });
  }
  return rows;
}

function table(results) {
  const head = ['CASE', 'BRIEF PHRASE', 'ASSET THE MODEL CHOSE', 'VERDICT'];
  const body = results.flatMap((r) => r.rows.map((row) => [r.id, row.phrase, row.chose, row.verdict]));
  const all = [head, ...body];
  const w = head.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join('  ');
  const out = [line(head), w.map((n) => '-'.repeat(n)).join('  '), ...body.map(line)];
  return out.join('\n');
}

async function runCases(parse, cases, { matching }) {
  const results = [];
  for (const kase of cases) {
    console.log('\n' + '='.repeat(78));
    console.log(`BRIEF:  ${kase.brief}`);
    console.log(matching ? `WHY:    ${kase.why}` : `EXPECT: ${kase.expect}`);
    try {
      const t0 = Date.now();
      const parsed = await parse(kase.brief);
      const plan = parsed.assets || [];
      const total = plan.reduce((n, e) => n + (e.count || 1), 0);
      console.log(
        `PLAN (${plan.length} entr${plan.length === 1 ? 'y' : 'ies'}, ${total} version(s), ${((Date.now() - t0) / 1000).toFixed(1)}s):`
      );
      console.log(render(plan));
      const unmatched = [...(parsed.unmatchedAssets || []), ...(parsed.unmatchedTemplates || [])];
      if (unmatched.length) console.log(`    unmatched: ${JSON.stringify(unmatched)}`);

      const variants = plan.filter((e) => / — Variant [A-D]$/.test(e.asset));
      if (variants.length) {
        console.log(`    *** ROUTED TO A VARIANT ASSET TYPE: ${variants.map((v) => v.asset).join(', ')}`);
        results.push({ id: kase.id || kase.brief.slice(0, 20), rows: [], failed: true });
        continue;
      }
      if (matching) {
        const rows = classify(kase, parsed);
        for (const row of rows) {
          console.log(`    ${row.verdict.padEnd(11)} ${row.phrase} -> ${row.chose}`);
          if (row.note) console.log(`                ${row.note}`);
        }
        results.push({ id: kase.id, rows });
      }
    } catch (err) {
      console.log(`    *** FAILED: ${err.message}`);
      results.push({ id: kase.id || kase.brief.slice(0, 20), rows: [], failed: true });
    }
  }
  return results;
}

// A run that produced no usable output is an ERROR, not a clean sheet. Recorded
// because the same trap has been hit here before: a dead cell reported as a zero
// reads exactly like a passing measurement.
function summarise(results) {
  const rows = results.flatMap((r) => r.rows);
  const dead = results.filter((r) => r.failed).length;
  const tally = {};
  for (const row of rows) tally[row.verdict] = (tally[row.verdict] || 0) + 1;
  return { rows, dead, tally };
}

// --- Self-test ---------------------------------------------------------------
//
// Drives the WHOLE harness with a stubbed transport, so the classifier and the
// table are exercised before anyone spends real calls on them. It asserts the
// three verdicts that carry the measurement — a known-bad substitution scores
// WRONG, a correct route scores RIGHT, and a refusal on a no-neighbour brief
// scores RIGHT rather than being counted as a miss.
//
// It does NOT check the model. It checks that the instrument can tell the
// difference between the answers, which is the failure this project has actually
// had: an arm that leaked its treatment, a shim with no failure path, a slice
// that silently measured the wrong region.
async function selftest() {
  const assert = require('node:assert');
  const parseOf = (assets, unmatchedAssets = []) => async () => ({ assets, unmatchedAssets, unmatchedTemplates: [] });

  const landing = MATCH_CASES.find((c) => c.id === 'ambiguous-landing');
  let rows = classify(landing, { assets: [{ asset: 'Event Landing Page', count: 1 }, { asset: 'Demand Gen Nurture Email', count: 1 }] });
  assert.strictEqual(rows[0].verdict, 'WRONG', 'the reported substitution scores WRONG');
  assert.strictEqual(rows[1].verdict, 'DEFENSIBLE', 'the nearest-available email scores DEFENSIBLE');

  rows = classify(landing, { assets: [{ asset: 'Campaign Landing Page', count: 1 }], unmatchedAssets: ['announcement email'] });
  assert.strictEqual(rows[0].verdict, 'RIGHT', 'the correct route scores RIGHT');
  assert.strictEqual(rows[1].verdict, 'RIGHT', 'a refusal where no asset fits scores RIGHT');

  rows = classify(landing, { assets: [{ asset: 'Campaign Landing Page', count: 1 }] });
  assert.strictEqual(rows[1].verdict, 'UNEXPECTED', 'dropped with no refusal is not a pass');

  const guard = MATCH_CASES.find((c) => c.id === 'event-landing-still-works');
  rows = classify(guard, { assets: [{ asset: 'Campaign Landing Page', count: 1 }, { asset: 'Event Reminder Email', count: 1 }] });
  assert.strictEqual(rows[0].verdict, 'WRONG', 'an event brief reaching the campaign asset is a regression');

  const mixed = MATCH_CASES.find((c) => c.id === 'clean-plus-ambiguous');
  rows = classify(mixed, { assets: [{ asset: 'LinkedIn Single Image Ad', count: 1 }, { asset: 'Campaign Landing Page', count: 1 }] });
  assert.strictEqual(rows[0].verdict, 'WRONG', 'the right asset at the wrong count is still wrong');

  const none = MATCH_CASES.find((c) => c.id === 'no-neighbour');
  rows = classify(none, { assets: [{ asset: 'One-Pager', count: 1 }], unmatchedAssets: ['a case study'] });
  assert.strictEqual(rows[0].verdict, 'WRONG', 'a substitution on a no-neighbour brief is WRONG');

  rows = classify(none, { assets: [{ asset: 'Battle Card', count: 1 }] });
  assert.ok(rows.some((r) => r.verdict === 'UNEXPECTED'), 'an unasked-for asset surfaces as UNEXPECTED');

  // And the whole loop, end to end, on the stub.
  const results = await runCases(parseOf([{ asset: 'Event Landing Page', count: 1 }]), [landing], { matching: true });
  assert.strictEqual(results[0].rows[0].verdict, 'WRONG');
  const { dead, tally } = summarise(results);
  assert.strictEqual(dead, 0);
  assert.ok(tally.WRONG >= 1);

  // The failure path, which is where the last measurement shim broke: a parse
  // that throws must be recorded as a dead cell, never as an empty result.
  const boom = await runCases(async () => { throw new Error('Gemini API error 429'); }, [landing], { matching: true });
  assert.strictEqual(summarise(boom).dead, 1, 'a thrown parse is a dead cell');

  console.log('\nselftest OK — the classifier separates RIGHT / WRONG / DEFENSIBLE / UNEXPECTED,');
  console.log('and a failed parse is recorded as a dead cell rather than a clean sheet.');
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();

  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set — this script makes real Gemini calls.');
    console.error('Run the instrument check without one:  node scripts/checkParsePlans.js --selftest');
    process.exit(1);
  }
  const pipeline = require('../src/core/pipeline');
  // No tenant id: resolveAssetVocabulary falls back to config.ALLOWED_ASSETS and
  // resolveTemplateVocabulary returns empty without touching the database, so
  // this runs anywhere the key does. Pass one to measure a real tenant's library.
  const tenantId = process.env.PARSE_CHECK_TENANT || null;
  const parse = (brief) => pipeline.parseBrief(brief, tenantId);

  const extra = process.argv.slice(2).filter((a) => a && !a.startsWith('--'));
  if (extra.length) {
    await runCases(parse, extra.map((brief) => ({ brief, expect: '(ad hoc)' })), { matching: false });
    return;
  }

  console.log('\n### COUNT AND LABEL CASES ###');
  const counts = await runCases(parse, COUNT_CASES, { matching: false });

  console.log('\n\n### MATCHING CASES — does the asset answer the phrase? ###');
  const matches = await runCases(parse, MATCH_CASES, { matching: true });

  const { rows, dead, tally } = summarise([...counts, ...matches]);
  console.log('\n' + '='.repeat(78));
  console.log('SUMMARY\n');
  console.log(table(matches.filter((r) => r.rows.length)));
  console.log('');
  for (const k of ['RIGHT', 'DEFENSIBLE', 'WRONG', 'MISSING', 'UNEXPECTED']) {
    if (tally[k]) console.log(`  ${k.padEnd(11)} ${tally[k]}`);
  }
  console.log(`\n  ${rows.length} probe outcome(s), ${dead} dead case(s).`);
  console.log('\nREAD THE PLANS ABOVE. The table cannot see whether the copy plan makes sense —');
  console.log('it only reports whether each asset was one this file named in advance.');
  if (dead > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

module.exports = { COUNT_CASES, MATCH_CASES, classify };
