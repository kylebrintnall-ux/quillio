'use strict';

// A/B: does the client's own language survive into the copy now that the brief
// itself is in the prompt?
//
// THE TEST IS A PHRASE, NOT A COUNT. The brief says "in about a minute". With no
// brief in the prompt — 2% of 15,405 characters being Gemini's paraphrase — ten
// of twelve headlines said "in 60 seconds", a string that appears in the brief,
// the writer prompt, craft.md and voice.md exactly zero times. The model
// converted a vague duration into a specific one and repeated it, because
// craft.md §1.7 and §2.54 both supply number-plus-time-unit examples.
//
// So: BEFORE = summary + writerPrompt only, which is what every draft did until
// `projects.brief_raw`. AFTER = the same call with the brief passed. One
// parameter differs. Everything else — asset, field, limits, craft slice, voice,
// summary, writer prompt — is identical.
//
// It prints the copy. The question is whether the brief's OWN words come through,
// and no count answers that: a run could hold "about a minute" and still be
// twelve rewrites of one sentence. Phrase tracking is printed as a hint beside
// the copy, not instead of it.
//
// MAKES REAL MODEL CALLS — 2 arms x N fields. Writes NOTHING: no database, no
// Drive, no Doc. It does not need the migration to have run: the brief is passed
// directly rather than read from a project row.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//
//   node scripts/briefFidelityAB.js

const { generateFieldDraft } = require('../src/services/gemini');
const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');

// A brief in a person's own voice, with phrasing a paraphrase would smooth away.
// The tracked phrases are all things a summariser would "improve": a hedged
// duration, an internal nickname, a specific unglamorous number.
const BRIEF = `Hey — pulling together the Q3 push for Quillio.

Context: our people are marketing leads at mid-size B2B shops. They are drowning
in asset requests and they've told us the worst part is the retyping. One brief
becomes an email sequence, three social ads, a landing page, and they're doing it
by hand every time.

What we do: you send us the brief you already have, in whatever shape it's in,
and you get back a formatted copy doc for every channel. Takes about a minute.
Internally we call this "one brief, every channel" and that framing has tested
well with customers, so use it where it fits.

The offer is a free trial, no card. We are NOT saying "AI-powered" anywhere —
they're sick of hearing it and it tests badly with this audience.

Tone: talk like a colleague who has done the job. Concrete over clever.`;

// What the pipeline would derive from that brief — a plausible parseBrief output.
// Deliberately faithful and deliberately smoother than the original, because
// that is exactly what a summariser produces and what the drafter used to see.
const SUMMARY =
  'Quillio turns a campaign brief into a formatted, on-brand copy doc in about a minute, '
  + 'so marketing teams stop rewriting the same brief into six different asset templates.';
const WRITER =
  'Speak to a marketing lead at a mid-size B2B company drowning in asset requests. '
  + 'Lead with the time they get back. Concrete, not clever.';

// Phrases the BRIEF supplies and the summary does not, or supplies differently.
// A hint, printed beside the copy. Cohesion and fidelity are both structural, and
// a phrase count can be satisfied by a set that is otherwise identical twelve times.
const TRACK = [
  { label: 'the brief\'s own duration', re: /about a minute/i, good: true },
  { label: 'the invented duration', re: /60 seconds|sixty seconds|60-second/i, good: false },
  { label: 'the tested framing', re: /one brief,? every channel/i, good: true },
  { label: 'the retyping complaint', re: /retyp|by hand/i, good: true },
  { label: 'free trial, no card', re: /no card|without a card/i, good: true },
  { label: 'BANNED — "AI-powered"', re: /ai[- ]powered/i, good: false },
];

function pick() {
  const out = [];
  const seen = new Map();
  const cand = [];
  for (const a of DEFAULT_ASSETS) {
    for (const f of a.fields) {
      if ((f.field_type || 'text') === 'words') continue;
      if (!/headline|subject line/i.test(f.field_name)) continue;
      cand.push({ asset: a, field: f });
    }
  }
  cand.sort((x, y) => (y.field.char_max || 0) - (x.field.char_max || 0));
  for (const t of cand) {
    const n = seen.get(t.asset.name) || 0;
    if (n >= 2) continue;
    seen.set(t.asset.name, n + 1);
    out.push(t);
    if (out.length >= 10) break;
  }
  return out;
}

async function arm(label, withBrief) {
  const picked = pick();
  const out = [];
  process.stderr.write(`  [${label}] ${picked.length} fields\n`);
  let n = 0;
  for (const t of picked) {
    n += 1;
    process.stderr.write(`  [${label}] ${String(n).padStart(2)}/${picked.length} ${t.asset.name} / ${t.field.field_name}\n`);
    try {
      const copy = await generateFieldDraft({
        assetType: t.asset.name,
        brief: withBrief ? BRIEF : undefined,   // THE ONLY DIFFERENCE
        fieldName: t.field.field_name,
        charMax: t.field.char_max,
        charMin: t.field.char_min,
        fieldType: 'text',
        notes: t.field.spec_note || '',
        assetDirection: t.asset.asset_direction || '',
        summary: SUMMARY,
        writerPrompt: WRITER,
        voiceGuide: '',
      });
      out.push({ asset: t.asset.name, field: t.field.field_name, copy });
    } catch (err) {
      out.push({ asset: t.asset.name, field: t.field.field_name, error: err.message });
    }
  }
  return out;
}

function report(label, rows) {
  const ok = rows.filter((r) => r.copy);
  const bad = rows.filter((r) => !r.copy);
  console.log(`\n${'#'.repeat(78)}\n# ${label}   (${ok.length} of ${rows.length} usable)\n${'#'.repeat(78)}`);
  for (const b of bad) console.log(`  !! ${b.asset} / ${b.field} — ${String(b.error).split('\n')[0].slice(0, 110)}`);
  for (const r of ok) {
    console.log(`  ${String(r.copy.length).padStart(3)}  ${r.copy}`);
    console.log(`       ${r.asset} / ${r.field}`);
  }
  if (!ok.length) return null;
  const all = ok.map((r) => r.copy).join('\n');
  console.log('');
  for (const t of TRACK) {
    const hits = ok.filter((r) => t.re.test(r.copy)).length;
    console.log(`  ${t.good ? '+' : '-'} ${t.label.padEnd(26)} ${hits}/${ok.length}`);
  }
  const dupes = [...ok.reduce((m, r) => {
    const k = r.copy.trim().toLowerCase();
    return m.set(k, (m.get(k) || 0) + 1);
  }, new Map())].filter(([, v]) => v > 1);
  console.log(`  duplicates: ${dupes.length}`);
  return { all, ok };
}

(async () => {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set — this makes real model calls and cannot be faked.');
    process.exit(1);
  }
  console.log('BEFORE = summary + writerPrompt only (every draft until projects.brief_raw)');
  console.log('AFTER  = the same call, with the client\'s brief passed. One parameter differs.\n');
  console.log(`The brief says "about a minute". "60 seconds" appears in it ${(BRIEF.match(/60 seconds/g) || []).length} times.\n`);

  console.log('--- drafting BEFORE arm ---');
  const before = await arm('before', false);
  console.log('--- drafting AFTER arm ---');
  const after = await arm('after', true);

  report('BEFORE — no brief', before);
  report('AFTER — brief present', after);

  console.log(`\n${'='.repeat(78)}\nWHAT TO READ\n${'='.repeat(78)}`);
  console.log('  The phrase counts are a hint. The question is whether the copy sounds like');
  console.log('  the person who wrote the brief — their framing, their hedge, their refusal');
  console.log('  to say "AI-powered" — or like a summary of them. Read both columns.');
  console.log('  A run can hold every tracked phrase and still be one sentence ten times.');
})();
