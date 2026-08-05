'use strict';

// A/B for craft.md §2's "Internal punctuation" permission.
//
// THE QUESTION IS NOT "DID HEADLINES ACQUIRE A COLON". Nine headlines with a mark
// is the same defect as nine without: both are a house tic. The failure being
// watched for is UNIFORM SHAPE — nine lines that turn in the same place, whether
// or not they use the same mark — and an adoption count cannot see it. Neither
// can a length spread: a set can hold its length range and still put an em dash
// at 60% of the line every time.
//
// So this reports, per arm:
//   • the LENGTH spread (min, max, range, median) — the floorAB lesson
//   • WHICH mark each line uses, if any
//   • WHERE the mark falls, as a fraction of the line, and how tightly those
//     fractions cluster — this is the tic detector
//   • how many distinct OPENING words the set uses — the BEFORE arm of the
//     cohesion run opened four of five headlines with "Stop"
//   • every line, printed, because the note in CLAUDE.md says a hit rate is a
//     safety check and not a result
//
// HOW THE ARMS DIFFER. craft.md is read once at module load, so the two arms run
// in separate CHILD PROCESSES of this script. The BEFORE child patches
// fs.readFileSync BEFORE requiring gemini and strips the "Internal punctuation"
// block out of craft.md in memory. THE REPO FILE IS NEVER TOUCHED — no mutation,
// no backup to restore, nothing left behind if the run is interrupted. The strip
// is asserted: if the block is not found, the child exits rather than reporting
// two identical arms as a comparison.
//
// WHAT VARIES IS THE PERMISSION ALONE. §2's setup-and-punchline line was
// reworded in the same commit so it would stop contradicting the permission, and
// that rewording is present in BOTH arms. Only the "Internal punctuation" block
// differs. That isolates the variable actually in question — does stating the
// permission produce a tic — rather than measuring two edits at once. If you
// instead want the shipped delta against the true prior state, strip both.
//
// EACH HEADLINE IS DRAFTED INDEPENDENTLY, via generateFieldDraft with no
// siblings. That is deliberate and is NOT how a real brief drafts them — it is
// the cleaner instrument for this question. If independently drafted headlines
// all land a mark at the same relative position, that is unambiguously the
// prompt, with no sibling influence to argue about.
//
// MAKES REAL MODEL CALLS — 2 arms x N headlines. Writes NOTHING: no database, no
// Drive, no Doc.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//
//   node scripts/punctuationAB.js

const path = require('path');

const BLOCK_RE = /\*\*Internal punctuation\.\*\*[\s\S]*?\n\n(?=-----)/;

// ---------------------------------------------------------------- child arm --
if (process.env.QUILLIO_AB_ARM) {
  const before = process.env.QUILLIO_AB_ARM === 'before';
  if (before) {
    const fs = require('fs');
    const realRead = fs.readFileSync;
    let stripped = false;
    fs.readFileSync = function (p, ...rest) {
      const out = realRead.call(this, p, ...rest);
      if (typeof p === 'string' && p.endsWith('craft.md') && typeof out === 'string') {
        if (!BLOCK_RE.test(out)) {
          console.error('BEFORE arm: the Internal punctuation block was not found in craft.md — the arms would be identical.');
          process.exit(2);
        }
        stripped = true;
        return out.replace(BLOCK_RE, '');
      }
      return out;
    };
    process.on('exit', () => {
      if (!stripped) {
        console.error('BEFORE arm: craft.md was never read as a string — the strip did not apply.');
        process.exitCode = 2;
      }
    });
  }

  const { generateFieldDraft } = require('../src/services/gemini');
  const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');

  // Headline-shaped fields across DISTINCT assets. Subject lines are included
  // because craft.md's headline punctuation rule names them explicitly.
  const targets = [];
  for (const a of DEFAULT_ASSETS) {
    for (const f of a.fields) {
      if ((f.field_type || 'text') === 'words') continue;
      if (!/headline|subject line/i.test(f.field_name)) continue;
      targets.push({ asset: a, field: f });
    }
  }
  const picked = [];
  const seenAsset = new Map();
  for (const t of targets) {
    const n = seenAsset.get(t.asset.name) || 0;
    if (n >= 2) continue;                 // at most two per asset, for spread
    seenAsset.set(t.asset.name, n + 1);
    picked.push(t);
    if (picked.length >= 12) break;
  }

  const SUMMARY =
    'Quillio turns a campaign brief into a formatted, on-brand copy doc in about a minute, '
    + 'so marketing teams stop rewriting the same brief into six different asset templates.';
  const WRITER =
    'Speak to a marketing lead at a mid-size B2B company drowning in asset requests. '
    + 'Lead with the time they get back. Concrete, not clever.';

  (async () => {
    const out = [];
    for (const t of picked) {
      let copy = '';
      try {
        copy = await generateFieldDraft({
          assetType: t.asset.name,
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
      } catch (err) {
        copy = '';
        out.push({ asset: t.asset.name, field: t.field.field_name, error: err.message });
        continue;
      }
      out.push({ asset: t.asset.name, field: t.field.field_name, charMax: t.field.char_max, copy });
    }
    process.stdout.write('\n__AB_RESULT__' + JSON.stringify(out) + '\n');
  })();
  return;
}

// --------------------------------------------------------------- parent run --
const { spawn } = require('child_process');

const MARKS = [
  { name: 'em dash', re: /—/ },
  { name: 'colon', re: /:/ },
  { name: 'question', re: /\?/ },
  { name: 'en dash', re: /–/ },
  { name: 'semicolon', re: /;/ },
  { name: 'comma', re: /,/ },
];

function shapeOf(copy) {
  const s = String(copy || '');
  const hits = [];
  for (const m of MARKS) {
    const i = s.search(m.re);
    if (i >= 0) hits.push({ name: m.name, index: i, at: s.length ? i / s.length : 0 });
  }
  hits.sort((a, b) => a.index - b.index);
  return {
    length: s.length,
    marks: hits.map((h) => h.name),
    primary: hits[0] || null,
    opener: (s.trim().split(/\s+/)[0] || '').toLowerCase().replace(/[^a-z']/g, ''),
  };
}

const med = (v) => {
  const a = v.slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
};
const stdev = (v) => {
  if (v.length < 2) return null;
  const mu = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / v.length);
};

function report(label, rows) {
  const ok = rows.filter((r) => r.copy);
  const shapes = ok.map((r) => ({ ...r, ...shapeOf(r.copy) }));
  const lens = shapes.map((s) => s.length);
  const withMark = shapes.filter((s) => s.primary);
  const positions = withMark.map((s) => s.primary.at);
  const openers = new Set(shapes.map((s) => s.opener));

  console.log(`\n${'#'.repeat(78)}\n# ${label}   (${ok.length} headlines)\n${'#'.repeat(78)}`);
  for (const s of shapes) {
    const mark = s.primary ? `${s.primary.name}@${Math.round(s.primary.at * 100)}%` : '—none—';
    console.log(`  ${String(s.length).padStart(3)}  ${mark.padEnd(16)}  ${s.copy}`);
    console.log(`       ${s.asset} / ${s.field}`);
  }
  console.log(`\n  LENGTH   min ${Math.min(...lens)}  max ${Math.max(...lens)}  `
    + `range ${Math.max(...lens) - Math.min(...lens)}  median ${med(lens)}`);
  const byMark = {};
  for (const s of shapes) byMark[s.primary ? s.primary.name : 'none'] = (byMark[s.primary ? s.primary.name : 'none'] || 0) + 1;
  console.log(`  MARKS    ${Object.entries(byMark).map(([k, v]) => `${k} ${v}`).join('   ')}`);
  if (positions.length >= 2) {
    const pct = positions.map((p) => Math.round(p * 100));
    console.log(`  POSITION of the first mark, as % of the line: ${pct.sort((a, b) => a - b).join(', ')}`);
    console.log(`           spread ${Math.max(...pct) - Math.min(...pct)} points   stdev ${stdev(pct).toFixed(1)}`);
  } else {
    console.log('  POSITION n/a — fewer than two lines carry a mark');
  }
  console.log(`  OPENERS  ${openers.size} distinct across ${shapes.length} lines`);
  return { lens, positions, openers, withMark: withMark.length, n: shapes.length };
}

function runArm(arm) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'punctuationAB.js')], {
      env: { ...process.env, QUILLIO_AB_ARM: arm },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${arm} arm exited ${code}`));
      const i = buf.indexOf('__AB_RESULT__');
      if (i < 0) return reject(new Error(`${arm} arm produced no result`));
      resolve(JSON.parse(buf.slice(i + '__AB_RESULT__'.length)));
    });
  });
}

(async () => {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set — this makes real model calls and cannot be faked.');
    process.exit(1);
  }
  console.log('BEFORE = craft.md with the "Internal punctuation" block stripped in memory.');
  console.log('AFTER  = craft.md as committed. The repo file is never modified.\n');

  console.log('--- drafting BEFORE arm ---');
  const before = await runArm('before');
  console.log('--- drafting AFTER arm ---');
  const after = await runArm('after');

  const b = report('BEFORE — no internal-punctuation permission', before);
  const a = report('AFTER — permission present', after);

  console.log(`\n${'='.repeat(78)}\nWHAT TO READ\n${'='.repeat(78)}`);
  console.log(`  length range      BEFORE ${Math.max(...b.lens) - Math.min(...b.lens)}   AFTER ${Math.max(...a.lens) - Math.min(...a.lens)}`);
  console.log(`  lines with a mark BEFORE ${b.withMark}/${b.n}   AFTER ${a.withMark}/${a.n}`);
  console.log(`  distinct openers  BEFORE ${b.openers.size}/${b.n}   AFTER ${a.openers.size}/${a.n}`);
  if (a.positions.length >= 2) {
    const pct = a.positions.map((p) => Math.round(p * 100));
    console.log(`  AFTER mark position spread ${Math.max(...pct) - Math.min(...pct)} points, stdev ${stdev(pct).toFixed(1)}`);
  }
  console.log('\n  Adoption is NOT the result. A high count is fine and a low count is fine.');
  console.log('  THE TIC LOOKS LIKE: mark position clustering (a small spread / low stdev),');
  console.log('  a collapsing length range, or openers repeating. Read the lines.');
})();
