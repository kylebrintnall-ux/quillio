'use strict';

// DRIVE THE DRAFT THE WAY PRODUCTION DRIVES IT.
//
// Every A/B in this project until now called `generateAssetDrafts` directly. That
// is the prompt BUILDER, not the path — and the difference cost us a result:
// `eventTimeAB` measured the Date / Location Line going 5/5 fabricated to 0/5
// through a wire production did not use, because `generateDraft`'s `assetTargets`
// rebuilt each field without `notes` and the note never reached the model. The
// measurement was clean and the plumbing between it and production was not.
//
// So the rule that came out of it — CHECK THE MEASUREMENT CALLS THE ENTRY POINT
// PRODUCTION CALLS — needs something to call. This is it.
//
// WHAT IT DOES. Builds a synthetic Google Doc exactly as `createDocument` renders
// one (bold `Field [limit]` label, the italic note, a blank line), hands it to
// `googleDocs.generateDraft` behind a stubbed Docs client, and lets the REAL
// Gemini call happen. Nothing is written: `documents.get` returns the synthetic
// doc and `documents.batchUpdate` is a no-op.
//
// The copy is recovered from the model's own RESPONSES rather than from the
// batchUpdate requests, because a batch response is already keyed by field name
// and the requests are keyed by document index. The single-field rescue returns
// bare text, so its prompt's `Field: <name>` line supplies the key.
//
// It also returns the PROMPTS, which is the point: an arm can assert its own
// guidance arrived instead of assuming it. `wireOk` is that check, and a run
// that reports a number without it is the failure this module exists to prevent.

const {
  fieldLabel, fieldHint, stripReaderOnlyLines, generateDraft,
} = require('../../src/destinations/googleDocs');

// The italic line the doc would carry for a field, composed the way
// createDocument composes it and stripped the way parseDoc recovers it — so the
// harness sends the string production sends, not the seed's raw spec_note.
function noteLineFor(field, extraNote) {
  const specNote = [field.spec_note || null, extraNote || null].filter(Boolean).join(' ') || null;
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

// A Google Docs `documents.get` payload with one asset section. `fields` is the
// seed shape ({ field_name, char_min, char_max, field_type, ... }); `noteFor` is
// called per field and may return '' for no italic line.
function buildDoc({ assetName, fields, summary, writerPrompt, noteFor }) {
  const paras = [
    { text: 'Campaign Summary', style: 'HEADING_2' },
    { text: summary, italic: true },
    { text: 'Writer Direction', style: 'HEADING_2' },
    { text: writerPrompt, italic: true },
    { text: assetName, style: 'HEADING_3' },
  ];
  for (const f of fields) {
    paras.push({
      text: fieldLabel({
        fieldName: f.field_name, charMin: f.char_min, charMax: f.char_max, fieldType: f.field_type,
      }),
      bold: true,
    });
    const note = noteFor ? noteFor(f) : '';
    if (note) paras.push({ text: note, italic: true });
    paras.push({ text: '' }); // the insertion point parseDoc looks for
  }

  let idx = 1;
  const content = paras.map((p) => {
    const raw = `${p.text || ''}\n`;
    const startIndex = idx;
    idx += raw.length;
    return {
      startIndex,
      endIndex: idx,
      paragraph: {
        paragraphStyle: p.style ? { namedStyleType: p.style } : {},
        elements: [{ textRun: { content: raw, textStyle: { bold: !!p.bold, italic: !!p.italic } } }],
      },
    };
  });
  return { body: { content } };
}

// Run ONE draft through generateDraft. Returns { copy, prompts } where `copy` is
// { fieldName -> string }. `brief` is threaded exactly as pipeline.generateDraft
// threads it off the project row.
async function draftOnce({ assetName, fields, summary, writerPrompt, noteFor, brief, assetDirection }) {
  const doc = buildDoc({ assetName, fields, summary, writerPrompt, noteFor });
  const clients = {
    docs: {
      documents: {
        get: async () => ({ data: doc }),
        batchUpdate: async () => ({ data: {} }),
      },
    },
  };

  const prompts = [];
  const copy = {};
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
    prompts.push(prompt);
    const res = await realFetch(url, opts);
    // Read the body once, hand a replayable object back to the caller.
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    try {
      if (/Respond with valid JSON only/.test(prompt)) {
        const parsed = JSON.parse(String(text).replace(/^```(?:json)?|```$/gm, '').trim());
        for (const [k, v] of Object.entries(parsed)) {
          copy[k] = typeof v === 'string' ? v : (v && v.copy) || '';
        }
      } else {
        // Single-field rescue: its own prompt names the field it is drafting.
        const m = prompt.match(/^Field: (.+)$/m);
        if (m) copy[m[1].trim()] = String(text).trim();
      }
    } catch {
      /* a parse failure is the rescue's business, not the harness's */
    }
    return { ok: res.ok, json: async () => json };
  };

  try {
    await generateDraft('synthetic-doc', null, clients, '', () => assetDirection || null, null, false, brief);
  } finally {
    global.fetch = realFetch;
  }
  return { copy, prompts };
}

// THE WIRE CHECK. Did the string this arm is supposed to be testing actually
// reach a prompt? An arm that cannot answer yes is not a control, and a number
// taken from it describes nothing.
function wireOk(prompts, needle) {
  return prompts.some((p) => p.includes(needle));
}

module.exports = { buildDoc, draftOnce, noteLineFor, wireOk };
