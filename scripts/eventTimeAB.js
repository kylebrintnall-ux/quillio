'use strict';

// A/B: does Event Reminder Email invent an event time — and does it still invent
// one when the brief TELLS it the time?
//
// THE PRE-REGISTERED FAILURE, NAMED BEFORE THE RUN (CLAUDE.md standing rule):
// ANY TIME OR DATE IN THE OUTPUT THAT DOES NOT APPEAR IN THE BRIEF. Every one is
// printed. This is the most operationally harmful output this system has
// produced — a reminder email carrying a wrong time makes the reader miss the
// event, which is the only failure here that harms the READER rather than the
// client. statsAB measured 8 of 30 in one arm and 4 of 30 with no reference
// material at all, with two drafts of the same email disagreeing by 24 hours.
//
// NO NUMERIC COUNTER CATCHES THIS. "Thursday" has no digits. Neither does
// "tomorrow", "tonight", or "noon". statsAB's invented-number column reported
// clean while every one of those was in the copy. So the detector below matches
// weekday names, month names, clock times, ordinals, relative days and relative
// durations — and it is still a FLOOR, not a census (see TEMPORAL below).
//
// THE 2x2, AND ARM B IS THE ONE THAT MATTERS:
//
//              brief states no time          brief states the time
//   no field   A1  does it invent?           B1  does it use THAT, or its own?
//   field      A2  does the field make it    B2  does it transcribe correctly
//                  invent MORE (a slot to        into the field and STILL
//                  fill)?                        invent in Subject Line 1?
//
// B2 is the sharpest cell. If the model transcribes correctly into a field built
// for it and invents anyway in the subject line, the field is NECESSARY AND NOT
// SUFFICIENT — which is worth knowing before a line of prompt text is written,
// because a refusal signal would then be fixing the wrong half.
//
// A2 is the cell that could embarrass the field: an empty slot is an invitation.
// If A2 invents more than A1, adding the field made things worse when the brief
// is silent, and that is a result, not a bug in the run.
//
// THE FIELD IS TOGGLED IN THIS SCRIPT, not in the database — the fields list is
// built here, so no migration is needed to measure either arm and nothing is
// written anywhere.
//
// MAKES REAL MODEL CALLS — 5 cells x N runs, THROUGH generateDraft. Writes
// NOTHING: documents.get returns a synthetic doc, documents.batchUpdate is a
// no-op. Read-only against Gemini, safe to run in production.
//
//   node scripts/eventTimeAB.js        # 5 runs per cell (20 calls)
//   node scripts/eventTimeAB.js 3      # 12 calls

const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');
// THROUGH THE REAL PATH. This script used to call generateAssetDrafts directly,
// and that is how it reported the Date / Location Line going 5/5 -> 0/5 on a wire
// production did not use: generateDraft's assetTargets rebuilt every field
// without notes, so the note never reached the model. Fixed August 2026, and this
// harness exists so the arms cannot drift off the path again. Each note cell
// asserts its own guidance arrived (wireOk) before its number means anything.
const { draftOnce, noteLineFor, wireOk } = require('./lib/realDraftPath');
// The SAME definitions the pipeline reads the brief with — one source, so the
// measurement and the behaviour cannot drift apart silently.
const { briefStatesDateTime, MISSING_DATETIME_NOTE } = require('../src/utils/briefFacts');

// THE NOTE WORDINGS UNDER TEST — a variant arm, not a second sentence.
//
// The shipped note took the silent-brief Date / Location Line from 4/5 fabricated
// to 2/5 on the real path, with three clean placeholders and no bracket
// instruction. Real, and short of the near-zero bar that was pre-registered.
//
// WHAT THE RE-RUN IS FOR, and it rests on a delivery fact that was got wrong the
// first time: the BATCH prompt composes every field's bullet into ONE call, so
// the note is present in the same prompt that writes Subject Line 1. The model
// read "The brief does not state a date, time or venue" and wrote "We start in 10
// minutes" in the subject line of that same call. The generative fields are not
// MISSING the string. They are reading it as a statement about one line.
//
// So two hypotheses, and neither is answerable by argument:
//
//   `line`      the shipped wording. "this line waits for them" names a LINE, so
//               its scope may be grammatical — true of that field, silent about
//               the others.
//   `campaign`  names no line at all. If grammar is what scopes it, this one
//               should reach the generative fields; if it does not, placement was
//               never the mechanism.
//   `single`    one fact instead of three. "Today at [Time] | Live Stream" is
//               partial compliance to an ENUMERATION — the model placeholder'd
//               the time, invented the date and invented the venue, complying on
//               exactly one of the three it was offered. That is the specificity
//               finding's shape: a rule that enumerates hands over a menu. This
//               variant removes the menu.
//
// Run together so one pass separates grammar from enumeration. Nothing is added
// anywhere until this says which wording holds.
const NOTE_VARIANTS = [
  // Read from src, not retyped, so the arm cannot test a wording production is
  // not sending.
  { id: 'line', text: MISSING_DATETIME_NOTE },
  { id: 'campaign', text: 'The brief does not state when or where this event happens.' },
  { id: 'single', text: 'The brief does not state when this event starts.' },
];

const RUNS = Number(process.argv[2]) || 5;
const ASSET = 'Event Reminder Email';
const DATE_FIELD = 'Date / Location Line';

// The ONLY difference between the arms. Everything else — audience, product,
// the fact that they already registered — is held identical, so a temporal
// expression in arm A's output came from nowhere.
const BRIEF_SILENT =
  'Reminder email for our product launch webinar. The audience already registered. '
  + 'Quillio turns a campaign brief into a formatted, on-brand copy doc, so marketing '
  + 'teams stop rewriting the same brief into six different asset templates. '
  + 'Get them to show up.';

const BRIEF_STATED =
  'Reminder email for our product launch webinar on Thursday August 24 at 12 PM PT, '
  + 'Moscone West. The audience already registered. '
  + 'Quillio turns a campaign brief into a formatted, on-brand copy doc, so marketing '
  + 'teams stop rewriting the same brief into six different asset templates. '
  + 'Get them to show up.';

const SUMMARY = 'Remind registrants to attend the Quillio product launch webinar.';
const WRITER_PROMPT =
  'Speak to someone who already registered. Reinforce the decision, do not re-sell it. '
  + 'Get them to turn up.';

// --- THE TEMPORAL DETECTOR, AND WHAT IT CANNOT SEE -------------------------
//
// A FLOOR, NOT A CENSUS, and the gaps are named so nobody reads a zero as safe:
//   • A spelled-out clock time ("half past noon") is missed.
//   • A bare number that IS a date ("the 24th" is caught; "on the 24" is not).
//   • "Later this week" and similar loose ranges are missed by design — they sit
//     between "soon" (safe) and "Thursday" (a claim) and calling either way
//     would be wrong without reading the line.
// Everything it does match is printed, so the ratio is never the whole answer.
const TEMPORAL = [
  [/\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/gi, 'weekday'],
  // FIXED — this was `(?:jan|feb|mar|...)[a-z]*`, which is not a month pattern at
  // all: [a-z]* swallows any word with those three letters at the front. It
  // matched MARKETING, marked, marketers, decision, decline, deck, separate,
  // novel, junior, augment and march. "marketing" is in every brief this project
  // has ever measured with, so the pattern fired constantly — and because
  // inventedIn filters against the brief, every one of those landed in the
  // "from the brief" column rather than the invented one. It inflated the tally
  // that was already the least trustworthy (see the note on it below).
  //
  // Now: a full month NAME, or a three-letter abbreviation adjacent to a day.
  // "may" stays out of the abbreviation list on purpose — it is a verb far more
  // often than a month, and "May 24" is caught by the day-adjacent form anyway.
  [/\b(?:january|february|march|april|june|july|august|september|october|november|december)\b/gi, 'month'],
  [/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)\.?\s+\d{1,2}\b/gi, 'month + day'],
  [/\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\b/gi, 'day + month'],
  [/\b\d{1,2}\s*(?::\s*\d{2})?\s*(?:am|pm)\b/gi, 'clock time'],
  [/\b\d{1,2}:\d{2}\b/g, 'clock time'],
  [/\bin\s+\d+\s+(?:second|minute|hour|day|week)s?\b/gi, 'relative duration'],
  [/\b\d+\s+(?:minute|hour|day|week)s?\s+(?:away|from now|to go)\b/gi, 'relative duration'],
  [/\b(?:today|tomorrow|tonight|this\s+(?:morning|afternoon|evening)|next\s+week)\b/gi, 'relative day'],
  [/\b(?:noon|midnight)\b/gi, 'clock time'],
  [/\b\d{1,2}(?:st|nd|rd|th)\b/g, 'ordinal date'],
];

// The CORRECT output when the brief is silent. Counted separately, because the
// question "did invention stop" is not the same as "was it replaced by
// something usable" — a run where invention drops to zero and nothing takes its
// place is a different result from one where "starts soon" takes over.
const VAGUE_SAFE = /\b(?:soon|shortly|coming up|almost here|any minute|just around the corner)\b/gi;

function temporalIn(text) {
  const out = [];
  for (const [re, kind] of TEMPORAL) {
    for (const m of String(text).match(re) || []) out.push({ text: m, kind });
  }
  return out;
}

// An expression is INVENTED when it does not appear in the brief. Compared
// case-insensitively on the raw substring, which is deliberately strict: "Friday"
// against a brief saying "Thursday" is invented, and so is "3 PM" against "12 PM".
//
// BRIEF FIDELITY IS NOT FACTUAL ACCURACY, AND THIS CANNOT TELL THEM APART.
//
// Measured, in the no-note cell: four fields — Subject Line 1, Subject Line 2,
// Headline and Preheader — said the event starts "in about a minute". That is the
// brief's phrase VERBATIM, and in the brief it describes how fast the DEMO is.
// Attached to the event's start time it is a false claim, and every check below
// scores it CLEAN and files it under "matched the brief".
//
// It cannot be fixed here. Deciding that "in about a minute" is true of the
// product and false of the start time requires knowing what the phrase REFERS to,
// which is a semantic question a substring comparison cannot ask. A longer
// pattern list makes it worse, not better: the phrase is already an exact match.
//
// So the column below is renamed to what it actually measures — a temporal
// phrase that ALSO OCCURS IN THE BRIEF — and it is explicitly NOT a correctness
// signal. Every matched phrase is printed, because the only thing that can judge
// whether a borrowed phrase is being applied to the right fact is a human reading
// the line.
function inventedIn(text, brief) {
  const b = String(brief).toLowerCase();
  return temporalIn(text).filter((t) => !b.includes(t.text.toLowerCase()));
}

// The complement: temporal phrases lifted from the brief. NOT a clean bill.
function borrowedIn(text, brief) {
  const b = String(brief).toLowerCase();
  return temporalIn(text).filter((t) => b.includes(t.text.toLowerCase()));
}

// `withNote` reproduces what pipeline.generateDoc does when a fact_kind:'datetime'
// field meets a brief that states no date: the note joins the field's spec_note,
// renders in the doc's italic line, and reaches the prompt as that field's
// `Field guidance:`. Passing it here goes through the same prompt builder, so the
// arm is the real thing rather than an imitation of it.
function fieldsFor(asset, withDateField) {
  return (asset.fields || []).filter((f) => withDateField || f.field_name !== DATE_FIELD);
}

async function cell(asset, brief, withDateField, note) {
  const fields = fieldsFor(asset, withDateField);
  const runs = [];
  let wired = 0;
  for (let i = 0; i < RUNS; i++) {
    try {
      const { copy, prompts } = await draftOnce({
        assetName: asset.name,
        fields,
        summary: SUMMARY,
        writerPrompt: WRITER_PROMPT,
        brief,
        assetDirection: asset.asset_direction || '',
        noteFor: (f) => noteLineFor(f, note && f.fact_kind === 'datetime' ? note : null),
      });
      // THE WIRE CHECK. An arm that cannot show its own guidance reached a prompt
      // is not a control, and its number describes nothing. This is the exact
      // failure that made the first 0/5 meaningless.
      if (!note || wireOk(prompts, note)) wired++;
      // A RUN THAT PRODUCED NOTHING IS NOT A ZERO, IT IS A DEAD RUN. The first
      // version pushed an empty object here and the cell reported 0/0 — a clean
      // number for a cell that drafted nothing, which is exactly the contaminated
      // arm the wire check exists to refuse. Same class, so same treatment.
      if (Object.keys(copy).length === 0) runs.push({ __error: 'every field failed — no copy produced' });
      else runs.push(copy);
    } catch (err) {
      runs.push({ __error: err.message });
    }
  }
  return { runs, wired };
}

(async () => {
  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set — this makes real model calls and cannot be faked.');
    process.exit(1);
  }

  const asset = DEFAULT_ASSETS.find((x) => x.name === ASSET);
  if (!asset) throw new Error(`asset not in the bundled library: ${ASSET}`);
  const hasField = (asset.fields || []).some((f) => f.field_name === DATE_FIELD);
  if (!hasField) {
    console.error(`${ASSET} has no ${JSON.stringify(DATE_FIELD)} in the bundled library — the field arms cannot run.`);
    process.exit(1);
  }

  console.log(`${ASSET} — ${RUNS} runs per cell`);
  console.log(`asset_direction: ${JSON.stringify(asset.asset_direction || '')}`);
  console.log('');
  console.log('THE FACTS THE BRIEF SUPPLIES:');
  console.log('  arm A (silent) : none');
  console.log('  arm B (stated) : Thursday · August 24 · 12 PM PT · Moscone West');

  const summary = [];

  // THREE cells per arm, not two. The third is the one this run exists for: the
  // field present AND carrying the note. In arm B the note is absent by design —
  // pipeline.generateDoc only attaches it when the brief states nothing — so that
  // cell is skipped rather than faked.
  const CELLS = [
    { field: false, note: null, label: `${DATE_FIELD}: absent` },
    { field: true, note: null, label: `${DATE_FIELD}: PRESENT, no note` },
    ...NOTE_VARIANTS.map((v) => ({ field: true, note: v.text, label: `${DATE_FIELD}: PRESENT + note:${v.id}` })),
  ];

  for (const [armName, brief] of [['A  brief SILENT', BRIEF_SILENT], ['B  brief STATES the time', BRIEF_STATED]]) {
    const briefStates = briefStatesDateTime(brief);
    console.log(`\n\n### ${armName} — briefStatesDateTime() says ${briefStates}`);
    if (armName.startsWith('A') === briefStates) {
      console.error('  !! the detector disagrees with the fixture — the arms are not what they claim.');
      process.exit(1);
    }

    for (const c of CELLS) {
      // The note only exists when the brief is silent. Faking it in arm B would
      // measure a state production never produces.
      if (c.note && briefStates) continue;
      const withField = c.field;
      const label = `${armName}   |   ${c.label}`;
      console.log(`\n${'='.repeat(78)}\n${label}\n${'='.repeat(78)}`);

      const { runs, wired } = await cell(asset, brief, withField, c.note);
      // REFUSE A CELL THAT DID NOT DRAFT. A single failed run makes the cell's
      // denominator a lie; every run failing makes its numerator one too.
      const dead = runs.filter((r) => r.__error).length;
      if (dead) {
        console.error(`  !! ${dead}/${RUNS} RUNS PRODUCED NO COPY — this cell is not a measurement.`);
        for (const r of runs.filter((x) => x.__error)) console.error(`     ${r.__error}`);
        process.exit(1);
      }
      if (c.note && wired !== RUNS) {
        console.error(`  !! THE NOTE REACHED ONLY ${wired}/${RUNS} PROMPTS — this cell is not a control.`);
        process.exit(1);
      }
      if (c.note) console.log(`  wire check: the note reached ${wired}/${RUNS} prompts`);
      const all = [];

      for (const seed of fieldsFor(asset, withField)) {
        const f = { fieldName: seed.field_name, charMin: seed.char_min || 0, charMax: seed.char_max || 0 };
        const copies = runs.map((r) => (r.__error ? `ERROR: ${r.__error}` : (r[f.fieldName] || '')));
        console.log(`\n  ${f.fieldName}  [${f.charMin}-${f.charMax}]`);
        copies.forEach((t) => {
          if (t && !t.startsWith('ERROR:')) all.push({ field: f.fieldName, text: t });
          const inv = inventedIn(t, brief);
          const supplied = temporalIn(t).length - inv.length;
          const tags = [
            inv.length ? `INVENTED: ${inv.map((x) => `${x.text} (${x.kind})`).join(', ')}` : '',
            supplied > 0 ? `${supplied} from the brief` : '',
            (String(t).match(VAGUE_SAFE) || []).length ? 'vague-safe' : '',
          ].filter(Boolean);
          console.log(`      ${String(t.length).padStart(4)}  ${t}${tags.length ? `  [${tags.join('] [')}]` : ''}`);
        });
      }

      const invented = all.filter((x) => inventedIn(x.text, brief).length > 0);
      const borrowed = all.filter((x) => borrowedIn(x.text, brief).length > 0);
      const vague = all.filter((x) => (String(x.text).match(VAGUE_SAFE) || []).length > 0);

      console.log(`\n  INVENTED a time or date:      ${invented.length}/${all.length}`);
      console.log(`  BORROWED a phrase from the brief (NOT a clean bill): ${borrowed.length}/${all.length}`);
      console.log(`  vague-safe ("soon" etc):      ${vague.length}/${all.length}`);
      if (invented.length) {
        console.log('  ↑ each of these is a time the brief did not state. On a reminder email');
        console.log('    that is the reader missing the event. Read them:');
        for (const x of invented) console.log(`      ${x.field}: ${x.text}`);
      }
      if (borrowed.length) {
        console.log('  ↑ these reuse a temporal phrase that IS in the brief — which does NOT');
        console.log('    make them true. "in about a minute" is the brief\'s phrase for how');
        console.log('    fast the DEMO is; on the start time it is a false claim, and every');
        console.log('    check here scores it clean. Only reading decides. Read them:');
        for (const x of borrowed) console.log(`      ${x.field}: ${x.text}`);
      }

      // THE TRANSCRIPTION FIELD, WHERE ONE DISTINCT VALUE IS THE GOAL.
      //
      // Every other variance metric in this project treats collapse as the
      // failure — the char_min floor cost the punchiest Subhead, and `shapes`
      // exists to catch a frame being reused. This field inverts all of it. In
      // the B/present cell the Date / Location Line came back BYTE-IDENTICAL five
      // times — "Thursday, August 24 at 12 PM PT | Moscone West" — and that is
      // correct: there is one true answer, and five renderings of it would be the
      // defect. It is the only cell in this work where zero variance is the win.
      //
      // Read the opposite way, therefore: on a fact_kind field whose fact the
      // brief SUPPLIED, anything above 1 means the model is paraphrasing a value
      // it was handed.
      const dateCopies = runs
        .map((r) => (r.__error ? '' : String(r[DATE_FIELD] || '').trim()))
        .filter(Boolean);
      if (withField && dateCopies.length) {
        const uniq = new Set(dateCopies).size;
        const verdict = briefStates
          ? (uniq === 1 ? 'correct — one true answer, rendered once' : 'PARAPHRASING A SUPPLIED VALUE')
          : 'brief supplied nothing, so variance is not the question here';
        console.log(`\n  ${DATE_FIELD}: ${uniq} distinct of ${dateCopies.length} — ${verdict}`);
      }

      summary.push({
        arm: armName.split(' ')[0], field: c.label.replace(`${DATE_FIELD}: `, ''),
        invented: invented.length, used: borrowed.length, vague: vague.length, n: all.length,
      });
    }
  }

  console.log(`\n${'='.repeat(78)}\nTHE 2x2\n${'='.repeat(78)}`);
  console.log(`${'arm'.padEnd(6)}${'date field'.padEnd(24)}${'INVENTED'.padEnd(11)}${'borrowed*'.padEnd(13)}vague-safe`);
  for (const r of summary) {
    console.log(
      `${r.arm.padEnd(6)}${r.field.padEnd(24)}${`${r.invented}/${r.n}`.padEnd(11)}`
      + `${`${r.used}/${r.n}`.padEnd(13)}${r.vague}/${r.n}`
    );
  }
  console.log('');
  console.log('READ IT LIKE THIS:');
  console.log('  B invents anyway            -> the model OVERRIDES an available fact. A');
  console.log('                                 refusal signal would fix the wrong half.');
  console.log('  B clean, A invents          -> silence is the trigger. A refusal signal is');
  console.log('                                 the right next piece.');
  console.log('  B2 transcribes but B1-style -> the field is NECESSARY AND NOT SUFFICIENT:');
  console.log('     invention persists          correct in the slot, invented in the subject.');
  console.log('  A2 invents MORE than A1     -> the empty slot is an invitation. The field');
  console.log('                                 made the silent case worse. That is a result.');
  console.log('');
  console.log('THE CELL THIS RUN EXISTS FOR: A, PRESENT + NOTE. It was 15/35 with the empty');
  console.log('field. If the note does not take it to near zero, the note is not carrying it');
  console.log('and the FIELD SHOULD COME BACK OUT — the migration is held for exactly this.');
  console.log('');
  console.log('AND READ THE LINES, not the ratios. No numeric counter catches "Thursday",');
  console.log('and this detector misses spelled clock times and loose ranges by design.');
})();
