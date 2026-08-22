'use strict';

// A/B/C: does the GRAMMAR of a spec_note change what gets drafted?
//
// Pinterest Pin / Title. char_max is 100 — the number Pinterest accepts — and
// the feed shows about 40. The 40 lives in spec_note, in the writing-guidance
// channel, because a display truncation is not a cap. So the drafter is told
// 100 as a hard ceiling and 40 as guidance, in the same line of the same prompt:
//
//   - "Title" — character limit 100 — stay within this limit; guidance:
//     <the note> Platform limit (Pinterest). Stay within this count.
//
// A production run drafted a 45-character title. That obeyed the 100 and
// ignored the 40, and the note it was carrying said "Only the first 40
// characters typically show in feeds." — true, and asking for nothing. It was
// reworded to "Front-load the first 40 characters — that is typically all that
// shows in feeds.", copying EMAIL_SUBJECT_NOTE, which instructs.
//
// THIS MEASURES WHETHER THAT REWORDING DID ANYTHING.
//
// ─── THREE ARMS, AND WHY THE THIRD ──────────────────────────────────────────
//
//   NONE   spec_note absent. The field still renders its tier line, because
//          spec_type is 'enforced' — so this arm is what Pinterest Title would
//          look like if nobody had ever written a note, NOT an empty guidance
//          clause. That is the honest control: it holds the tier line constant
//          across all three arms, so the only thing that varies is the note.
//   OLD    "Only the first 40 characters typically show in feeds."   (statement)
//   NEW    "Front-load the first 40 characters — …"                  (instruction)
//
// Two arms would confound the claim. NEW-vs-NONE can only show that A NOTE
// helps; it cannot separate that from the specific claim being made, which is
// that an INSTRUCTION beats a STATEMENT of the same fact. OLD is the arm that
// actually shipped and actually produced the 45, so it is also the only arm
// whose behaviour we have a production observation for.
//
// The comparison that carries the claim is OLD vs NEW. NONE is the floor.
//
// ─── PRE-REGISTRATION — WRITTEN BEFORE THE FIRST RUN ────────────────────────
//
// CLAUDE.md's rule: the bar is set before the run, because this repo has an
// aggregate that REVERSED between two runs of the same cell (eventTimeAB), and
// because a reader who sets the bar afterwards will set it where the data
// already is. NOTHING BELOW MOVES AFTER RESULTS ARE SEEN. If the outcome is one
// this section did not anticipate, it is recorded as UNANTICIPATED and the
// section is left as written — an amended pre-registration is not one.
//
// PRIMARY METRIC: WITHIN — how many Title drafts come in at 40 characters or
// fewer, out of n, per arm. This is the note's own claim, measured; the
// threshold is pulled from the note text rather than hardcoded here.
//
// SECONDARY, REPORTED ALWAYS AND NEVER INSTEAD: median, SPREAD (max − min), the
// min and max themselves, distinct, shapes, openings.
//
//   WORKED
//     NEW's WITHIN exceeds OLD's by >= 4 of 10
//     AND NEW's median is below OLD's
//     AND NEW's spread is at least half of OLD's spread.
//   The third clause is not decoration. floorAB measured a note that took the
//   Subhead from 5/5 in band to 5/5 in band — changing nothing by hit rate —
//   while its spread collapsed from 31 characters to 9 and the best line in the
//   run was the one that disappeared. A note that pulls every title to exactly
//   40 has bought compliance with uniformity, and the hit rate alone cannot
//   tell that from a note that moved the whole distribution.
//
//   DID NOT WORK
//     NEW's WITHIN is within +/-1 of OLD's.
//   Then the grammar is inert on this field, the 45-character title was a tail
//   sample rather than a mechanism, and the rewording should be described in
//   CLAUDE.md as unmeasured-and-harmless rather than as a fix.
//
//   WORKED, AT A COST  (a real outcome, not a hedge)
//     NEW's WITHIN improves by >= 4 but spread collapses below half of OLD's,
//     or distinct drops below 7/10, or openings drop below 5/10.
//   Report as a COST and read the lines that disappeared. This is the floorAB
//   result arriving in a new place, and it is the single most likely way for
//   this change to be wrong while looking right.
//
//   UNINFORMATIVE — the run settles nothing and must not be reported as if it
//   did. Any of:
//     * OLD's WITHIN is within +/-1 of NONE's AND NEW's is within +/-1 of OLD's.
//       All three arms behave the same, the field does not respond to spec_note
//       in any grammar, and the question is misframed rather than answered.
//
//       BOTH CLAUSES ARE REQUIRED, and the first draft of this file had only the
//       first — which would have thrown away the best outcome the run can
//       produce. OLD == NONE with NEW moving is not a disqualifier; it is the
//       CLEANEST FORM OF THE CLAIM: the statement is indistinguishable from
//       having no note at all, and the instruction is not. Caught by driving
//       this script with a stub that made exactly that pattern and watching it
//       print UNINFORMATIVE over a 0/10 -> 10/10 move. Fixed before any real
//       data existed, which is the only time a bar may be corrected.
//     * All three arms read 10/10 or all three read 0/10. Ceiling or floor; no
//       resolution available at any n.
//     * Any arm contains a dead run — a thrown error, or an EMPTY Title. Per
//       the dead-cell rule a cell that produced no copy did not happen, and
//       reporting it as a zero is the contaminated-arm failure.
//
//       AN EMPTY TITLE IS ZERO CHARACTERS, WHICH IS INSIDE THE THRESHOLD. The
//       first draft of this file took `copy || ''` and measured its length, so a
//       total model failure — every field blank — scored WITHIN 10/10 with a
//       median near zero and would have read as PERFECT COMPLIANCE. That is the
//       August 2026 outage's own shape (1 of 40 fields drafted, reported as
//       ready) arriving inside the instrument built to measure the fix. Empty is
//       now dead, never a length.
//
//   AND ONE THAT WOULD WEAKEN THE PREMISE ITSELF, pre-registered because it is
//   entirely possible and would be easy to skip past:
//     * OLD's WITHIN is already >= 7/10. Then the shipped note was mostly
//       working, the observed 45 was the tail, and NEW is improving something
//       that was not very broken. Say so plainly if it happens.
//
// n = 10 PER ARM, 30 CALLS TOTAL. Why 10 and not the 5 this script used to use:
// the primary metric is a PROPORTION, and at n=5 one sample is 20 points, so
// the smallest move the metric can even express is larger than the effect worth
// detecting. At n=10 a sample is 10 points and the >= 4/10 bar above is four
// samples rather than two. It is still far too small for a subtle effect, which
// is why the bar is set at a coarse difference rather than a plausible one —
// n=10 can clear "the note moved the field" and cannot clear "the note moved
// the field a little", and no bar here pretends otherwise.
// Pinterest Pin has two fields, so a batch call is small; 30 of them is cheap.
//
//   node scripts/notesAB.js        # 10 runs per arm (30 calls)
//   node scripts/notesAB.js 3      # 9 calls — a smoke check, NOT a measurement
//
// MAKES REAL MODEL CALLS. Writes NOTHING — no Docs, no Postgres. Read-only
// against Gemini and safe to run in production.

const { generateAssetDrafts } = require('../src/services/gemini');
const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
const { fieldHint, stripReaderOnlyLines } = require('../src/destinations/googleDocs');

const RUNS = Number(process.argv[2]) || 10;
const ASSET = 'Pinterest Pin';
const WATCH = 'Title';

// THE ARMS. `note` is the raw spec_note the arm substitutes for the seed's own,
// so all three go through the identical composer below and differ in one string.
// null is a real value here and means "this field has no spec_note" — NOT an
// empty guidance clause. See the header.
//
// OLD_NOTE is byte-identical to scripts/migrateFixPinterestTitleNote.js's
// OLD_NOTE, and NEW_NOTE to src/data/defaultAssets.js's PINTEREST_TITLE_NOTE.
// Asserted at startup rather than trusted, because an arm carrying a string
// nothing in the product ever wrote is measuring a wording that does not exist.
const OLD_NOTE = 'Only the first 40 characters typically show in feeds.';
const NEW_NOTE = 'Front-load the first 40 characters — that is typically all that shows in feeds.';
const ARMS = [
  { key: 'NONE', note: null, label: 'NONE  (no spec_note — tier line only, as if nobody wrote one)' },
  { key: 'OLD', note: OLD_NOTE, label: 'OLD   (the statement — what shipped, and what drafted the 45)' },
  { key: 'NEW', note: NEW_NOTE, label: 'NEW   (the instruction — what this commit changed it to)' },
];

const BRIEF =
  'Pinterest pin for our Q3 launch push. Quillio turns a campaign brief into a '
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
// rather than a raw spec_note. That difference is the whole point: the tier line
// joins the note, and the reader-only sentences are stripped back out.
//
// `noteOverride` is the ARM's spec_note, substituted for the seed's. Passing
// undefined keeps the seed's own, which is what the threshold lookup wants.
function noteFor(field, noteOverride) {
  const specNote = noteOverride === undefined ? (field.spec_note || null) : noteOverride;
  const hint = fieldHint({
    fieldName: field.field_name,
    charMin: field.char_min,
    charMax: field.char_max,
    fieldType: field.field_type,
    specNote,
    specType: field.spec_type || null,
    specSource: field.spec_source || null,
    specOverridden: false,
  });
  return stripReaderOnlyLines(hint ? hint.text : '');
}

// ONLY THE WATCHED FIELD'S NOTE VARIES BETWEEN ARMS. Description carries its
// seed value (null) in every arm — swapping a note on a field nobody is
// measuring would put a second difference in the prompt and make the comparison
// two changes wide.
function fieldsFor(asset, arm) {
  return (asset.fields || []).map((f) => ({
    fieldName: f.field_name,
    charMin: f.char_min || 0,
    charMax: f.char_max || 0,
    fieldType: f.field_type === 'words' ? 'words' : 'text',
    notes: noteFor(f, f.field_name === WATCH ? arm.note : undefined),
  }));
}

async function arm(asset, armDef) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    try {
      const drafts = await generateAssetDrafts({
        assetType: asset.name,
        assetDirection: asset.asset_direction || '',
        brief: BRIEF,
        summary: SUMMARY,
        writerPrompt: WRITER_PROMPT,
        fields: fieldsFor(asset, armDef),
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
// "Front-load the first 40" acts on the OPENING, so the failure it can cause is
// N lines that begin identically and diverge after. `distinct` counts those as
// N distinct and `shapes` as N shapes; only this sees it.
const openingOf = (t) => shapeOf(t).split(' ').slice(0, 4).join(' ');

// THE NOTE'S OWN CLAIM, MEASURED. Added after a run where every column read
// clean and the real change was invisible to all of them: the median moved and
// the samples crossed the number the note names, and no column was watching
// that number. So when a note carries one, this pulls it out and reports how
// many samples fall inside it.
//
// TAKEN FROM THE NEW NOTE AND APPLIED TO ALL THREE ARMS. The control has no
// note and therefore no threshold of its own; measuring it against a different
// number, or not at all, would leave the improvement with nothing to be an
// improvement over.
//
// Deliberately crude: the FIRST number in a "first N" or "N-M characters"
// phrase. A note with no number yields null and this reports nothing rather
// than guessing.
function noteThreshold(note) {
  const t = String(note || '');
  const window = t.match(/(\d{1,3})\s*[–-]\s*(\d{1,3})\s*characters/i);
  if (window) return Number(window[2]);
  const first = t.match(/first\s+(\d{1,3})/i);
  if (first) return Number(first[1]);
  const chars = t.match(/(\d{1,3})\s*characters/i);
  return chars ? Number(chars[1]) : null;
}

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
  const watched = (asset.fields || []).find((f) => f.field_name === WATCH);
  if (!watched) throw new Error(`${ASSET} has no field named ${WATCH}`);

  // THE ARMS CARRY STRINGS THE PRODUCT ACTUALLY WROTE, asserted rather than
  // assumed. If the seed is reworded again and NEW_NOTE here is not moved with
  // it, this measures a wording nothing ships — which is a measurement that
  // looks exactly like a result.
  if (watched.spec_note !== NEW_NOTE) {
    throw new Error(
      `NEW_NOTE does not match the seed's ${ASSET} / ${WATCH} spec_note.\n`
      + `  seed: ${JSON.stringify(watched.spec_note)}\n`
      + `  here: ${JSON.stringify(NEW_NOTE)}\n`
      + 'Refusing to run: an arm carrying a string the product never wrote measures nothing.'
    );
  }
  if (OLD_NOTE === NEW_NOTE) throw new Error('OLD_NOTE and NEW_NOTE are identical — there are only two arms.');

  const TH = noteThreshold(noteFor(watched));
  if (!TH) throw new Error(`no threshold could be read out of the ${WATCH} note — nothing to measure against.`);

  console.log(`${ASSET} / ${WATCH} — ${ARMS.length} arms x ${RUNS} runs (${ARMS.length * RUNS} calls)`);
  console.log(`threshold ${TH}, read from the note text. Ceiling is ${watched.char_max} in EVERY arm.`);
  if (RUNS < 10) {
    console.log('\n*** RUNS < 10 — this is a smoke check, not a measurement. The pre-registered');
    console.log('*** bars in this file\'s header are written for n=10 and do not apply below it.');
  }
  console.log('\nWHAT EACH ARM SENDS AS THE WATCHED FIELD\'S GUIDANCE:');
  for (const a of ARMS) console.log(`  ${a.key.padEnd(5)} ${JSON.stringify(noteFor(watched, a.note))}`);

  const summary = [];
  for (const armDef of ARMS) {
    console.log(`\n${'='.repeat(78)}\n${armDef.label}\n${'='.repeat(78)}`);
    const runs = await arm(asset, armDef);

    for (const f of fieldsFor(asset, armDef)) {
      const copies = runs.map((r) => (r.__error ? `ERROR: ${r.__error}` : (r[f.fieldName] || '')));
      // NULL, NOT ZERO. An empty draft is a run that did not happen — scoring it
      // as a 0-character title puts it INSIDE the threshold and turns a model
      // failure into perfect compliance. See the header.
      const lens = copies.map((c) => (c.startsWith('ERROR:') || c === '' ? null : c.length));
      const s = stats(lens);
      const mark = f.fieldName === WATCH ? '   <<< WATCHED' : '';
      console.log(`\n  ${f.fieldName}  [${f.charMin}-${f.charMax}]${mark}`);
      console.log(`    lengths: ${lens.join(', ')}`
        + (s ? `   median ${s.median}   SPREAD ${s.spread} (min ${s.min}, max ${s.max})` : ''));
      const real = lens.filter((x) => typeof x === 'number');
      const within = real.filter((x) => x <= TH).length;
      console.log(`    threshold ${TH} — WITHIN ${within}/${real.length}`);
      copies.forEach((t, i) => {
        const tag = lens[i] === null ? ' <- DEAD (no copy)'
          : s && lens[i] === s.min ? ' <- MIN' : s && lens[i] === s.max ? ' <- MAX' : '';
        console.log(`      ${String(lens[i] === null ? '--' : lens[i]).padStart(4)}  ${t}${tag}`);
      });
      // NOT dead, but not plausible copy either. A handful of characters inside
      // the threshold counts as a hit and is almost certainly a truncated or
      // malformed response, so it is flagged for a human rather than dropped —
      // dropping it silently is the same class of error as counting it.
      const runty = real.filter((x) => x < 10).length;
      if (runty) console.log(`    *** ${runty} draft(s) under 10 characters — READ THEM. Counted as WITHIN.`);

      if (f.fieldName === WATCH) {
        const texts = copies.filter((c) => c && !c.startsWith('ERROR:'));
        const d = modeOf(texts);
        const sh = modeOf(texts.map(shapeOf));
        const op = modeOf(texts.map(openingOf));
        console.log(`    distinct ${d.unique}/${texts.length}   shapes ${sh.unique}/${texts.length}`
          + `   OPENINGS ${op.unique}/${texts.length}`);
        if (op.count > 1) console.log(`    shared opening x${op.count}: "${op.top}"`);
        // A DEAD RUN IS RECORDED, NOT AVERAGED AWAY. The header calls any arm
        // with one UNINFORMATIVE, so it has to survive to the summary table.
        summary.push({ arm: armDef.key, n: real.length, dead: RUNS - real.length,
          within, median: s ? s.median : null, spread: s ? s.spread : null,
          min: s ? s.min : null, max: s ? s.max : null,
          distinct: d.unique, shapes: sh.unique, openings: op.unique });
      }
    }
  }

  console.log(`\n${'='.repeat(78)}\n${WATCH} — the watched field, all arms\n${'='.repeat(78)}`);
  console.log(`${'arm'.padEnd(6)}${`WITHIN<=${TH}`.padEnd(12)}${'median'.padEnd(8)}${'spread'.padEnd(8)}`
    + `${'min'.padEnd(6)}${'max'.padEnd(6)}${'distinct'.padEnd(10)}${'shapes'.padEnd(9)}${'openings'.padEnd(10)}dead`);
  for (const r of summary) {
    console.log(`${r.arm.padEnd(6)}${`${r.within}/${r.n}`.padEnd(12)}${String(r.median).padEnd(8)}`
      + `${String(r.spread).padEnd(8)}${String(r.min).padEnd(6)}${String(r.max).padEnd(6)}`
      + `${`${r.distinct}/${r.n}`.padEnd(10)}${`${r.shapes}/${r.n}`.padEnd(9)}`
      + `${`${r.openings}/${r.n}`.padEnd(10)}${r.dead}`);
  }

  // THE PRE-REGISTERED BARS, EVALUATED BY THE SCRIPT rather than by whoever
  // reads the output. A human comparing two columns after the fact is the
  // failure the pre-registration exists to prevent, and printing the verdict
  // beside the numbers is what makes moving the bar afterwards a visible edit
  // to this file rather than a different sentence in a summary.
  const by = Object.fromEntries(summary.map((r) => [r.arm, r]));
  const none = by.NONE; const old = by.OLD; const neu = by.NEW;
  console.log(`\n${'='.repeat(78)}\nPRE-REGISTERED VERDICT (bars set before the run — see the file header)\n${'='.repeat(78)}`);

  const dead = summary.filter((r) => r.dead > 0);
  const allSame = summary.every((r) => r.within === r.n) || summary.every((r) => r.within === 0);
  // BOTH CLAUSES. OLD == NONE alone is a FINDING (the statement does nothing a
  // missing note would not do), and only becomes uninformative if NEW is flat too.
  const noteInert = Math.abs(old.within - none.within) <= 1 && Math.abs(neu.within - old.within) <= 1;

  if (dead.length) {
    console.log(`UNINFORMATIVE — dead run(s) in: ${dead.map((r) => `${r.arm} (${r.dead})`).join(', ')}.`);
    console.log('  A cell that produced no copy did not happen. Re-run before reading anything else.');
  } else if (allSame) {
    console.log(`UNINFORMATIVE — every arm is at the floor or the ceiling of WITHIN<=${TH}.`);
    console.log('  No resolution is available here at any n.');
  } else if (noteInert) {
    console.log(`UNINFORMATIVE — OLD (${old.within}/${old.n}) is within 1 of NONE (${none.within}/${none.n}).`);
    console.log('  The field does not respond to spec_note in either grammar, so OLD-vs-NEW has');
    console.log('  nothing to sit on. The question is misframed rather than answered.');
  } else {
    const gain = neu.within - old.within;
    const medianDown = neu.median < old.median;
    const spreadHeld = old.spread === 0 ? true : neu.spread >= old.spread / 2;
    const varietyHeld = neu.distinct >= Math.ceil(neu.n * 0.7) && neu.openings >= Math.ceil(neu.n * 0.5);
    const statementInert = Math.abs(old.within - none.within) <= 1;
    if (gain >= 4 && medianDown && spreadHeld && varietyHeld) {
      console.log(`WORKED — WITHIN ${old.within}/${old.n} -> ${neu.within}/${neu.n} (+${gain}),`
        + ` median ${old.median} -> ${neu.median}, spread held (${old.spread} -> ${neu.spread}).`);
      if (statementInert) {
        console.log(`  AND IN ITS CLEANEST FORM: OLD (${old.within}/${old.n}) is indistinguishable from`);
        console.log(`  NONE (${none.within}/${none.n}), so the STATEMENT did nothing a missing note would`);
        console.log('  not have done, and the INSTRUCTION did. That is the claim, isolated.');
      }
    } else if (gain >= 4 && (!spreadHeld || !varietyHeld)) {
      console.log(`WORKED, AT A COST — WITHIN +${gain}, but`
        + `${!spreadHeld ? ` spread collapsed ${old.spread} -> ${neu.spread}` : ''}`
        + `${!varietyHeld ? ` variety fell (distinct ${neu.distinct}/${neu.n}, openings ${neu.openings}/${neu.n})` : ''}.`);
      console.log('  This is the floorAB result in a new place. READ THE LINES THAT DISAPPEARED');
      console.log(`  — compare OLD's MIN/MAX against NEW's before calling this a win.`);
    } else if (Math.abs(gain) <= 1) {
      console.log(`DID NOT WORK — WITHIN ${old.within}/${old.n} -> ${neu.within}/${neu.n} (${gain >= 0 ? '+' : ''}${gain}).`);
      console.log('  The grammar is inert on this field. The 45-character title was a tail sample,');
      console.log('  not a mechanism. Describe the rewording as unmeasured-and-harmless, not a fix.');
    } else {
      console.log(`UNANTICIPATED — WITHIN moved by ${gain >= 0 ? '+' : ''}${gain}, which falls between the`);
      console.log('  pre-registered bars (+/-1 = did not work, >=+4 = worked). Record it as');
      console.log('  unanticipated. DO NOT move a bar in this file to accommodate it.');
    }
  }
  if (old.within >= Math.ceil(old.n * 0.7)) {
    console.log(`\nAND NOTE, pre-registered: OLD is already ${old.within}/${old.n}. The shipped note was`);
    console.log('  mostly working and the observed 45 was the tail. Whatever NEW did, it improved');
    console.log('  something that was not very broken. Say so plainly.');
  }

  console.log('');
  console.log('THEN READ THE COPY. No column above says whether the titles got BETTER, and');
  console.log('that is the only question that matters. Read each arm\'s MIN and MAX by eye:');
  console.log('a title that fits 40 by saying less is not the same as one that fits by');
  console.log('saying it tighter, and only one of those is worth shipping.');
})();
