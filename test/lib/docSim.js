'use strict';

// A Google Docs index model, so a write path can be REPLAYED rather than
// asserted about.
//
// WHY THIS EXISTS. Roughly a third of test/smoke.test.js reads source files as
// strings and asserts that a line is present. That methodology cannot see the
// defect this file was built for: the duplicate-delete bug was two perfectly
// well-formed `deleteContentRange` requests, both matching any pattern you might
// grep for, whose damage lived entirely in what the SECOND one addressed after
// the first had shortened the document. Nothing about the source text was wrong.
// The only way to see it is to apply the requests and look at the result.
//
// THE MODEL. The body is a flat character stream whose first index is 1, which
// is where Docs' body starts. Paragraphs are the spans between '\n' characters,
// and a paragraph's endIndex is one past its own '\n'. A batchUpdate applies its
// requests IN ORDER against a document each one has already changed — that
// sequential-mutation property is the whole reason bottom-to-top ordering works
// and the whole reason an overlapping pair does not, so it is the property this
// model has to reproduce faithfully.
//
// WHAT IT IS NOT. It models indices and text, not Docs. Tables, lists, inline
// objects, suggestions and named ranges are absent; styling is tracked only well
// enough that parseDoc can tell a bold label from copy. It is a rig for
// reasoning about index arithmetic, and claims about anything else do not follow
// from it.

const STYLE = (bold, italic, named) => ({ bold: !!bold, italic: !!italic, named: named || 'NORMAL_TEXT' });

class Doc {
  constructor() {
    this.chars = []; // [{ c, style }] — one entry per character, '\n' included
  }

  // paras: [[text, style]] — the trailing newline is added here, never passed in.
  static from(paras) {
    const d = new Doc();
    for (const [text, style] of paras) {
      for (const c of `${text}\n`) d.chars.push({ c, style });
    }
    return d;
  }

  get text() {
    return this.chars.map((x) => x.c).join('');
  }

  // Docs indices are 1-based over the body; this array is 0-based.
  _pos(index) {
    return index - 1;
  }

  insertText(index, text) {
    const pos = this._pos(index);
    if (pos < 0 || pos > this.chars.length) {
      throw new Error(`insertText index ${index} is outside the document (length ${this.chars.length})`);
    }
    // Inherit the style at the insertion point. Real Docs is subtler; every
    // caller here follows an insert with an explicit updateTextStyle, and
    // styling never moves an index, so the difference cannot affect a replay.
    const style = (this.chars[pos] && this.chars[pos].style) || STYLE(false, false);
    this.chars.splice(pos, 0, ...[...text].map((c) => ({ c, style })));
  }

  deleteContentRange(startIndex, endIndex) {
    const s = this._pos(startIndex);
    const e = this._pos(endIndex);
    if (s < 0 || e < s || e > this.chars.length) {
      throw new Error(
        `deleteContentRange [${startIndex}, ${endIndex}) is outside the document (length ${this.chars.length})`
      );
    }
    this.chars.splice(s, e - s);
  }

  setStyle(startIndex, endIndex, patch) {
    for (let p = this._pos(startIndex); p < this._pos(endIndex) && p < this.chars.length; p += 1) {
      this.chars[p] = { c: this.chars[p].c, style: { ...this.chars[p].style, ...patch } };
    }
  }

  // Apply one batchUpdate's requests, in order, each against the document as the
  // previous ones left it.
  apply(requests) {
    for (const r of requests || []) {
      if (r.insertText) {
        this.insertText(r.insertText.location.index, r.insertText.text);
      } else if (r.deleteContentRange) {
        const { startIndex, endIndex } = r.deleteContentRange.range;
        this.deleteContentRange(startIndex, endIndex);
      } else if (r.updateTextStyle) {
        const { startIndex, endIndex } = r.updateTextStyle.range;
        const ts = r.updateTextStyle.textStyle || {};
        this.setStyle(startIndex, endIndex, { bold: !!ts.bold, italic: !!ts.italic });
      } else if (r.updateParagraphStyle) {
        const { startIndex, endIndex } = r.updateParagraphStyle.range;
        this.setStyle(startIndex, endIndex, {
          named: (r.updateParagraphStyle.paragraphStyle || {}).namedStyleType || 'NORMAL_TEXT',
        });
      }
      // Anything else (tables, bullets) is not modelled and is ignored rather
      // than guessed at — see the header.
    }
  }

  // The shape parseDoc / getDocContent consume, rebuilt from current state so a
  // re-read after a write sees what the write actually did.
  toJson(title = 'Sim Doc') {
    const content = [];
    let start = 1;
    let buf = [];
    for (const ch of this.chars) {
      buf.push(ch);
      if (ch.c !== '\n') continue;
      const elements = [];
      let cur = null;
      for (const x of buf) {
        const key = `${x.style.bold}|${x.style.italic}`;
        if (!cur || cur.key !== key) {
          cur = { key, content: '', textStyle: { bold: x.style.bold, italic: x.style.italic } };
          elements.push(cur);
        }
        cur.content += x.c;
      }
      content.push({
        startIndex: start,
        endIndex: start + buf.length,
        paragraph: {
          elements: elements.map((e) => ({ textRun: { content: e.content, textStyle: e.textStyle } })),
          paragraphStyle: { namedStyleType: buf[0].style.named },
        },
      });
      start += buf.length;
      buf = [];
    }
    return { title, body: { content } };
  }

  // Paragraph texts without their newlines — what a reader sees.
  paragraphs() {
    return this.text.split('\n').slice(0, -1);
  }
}

// Paragraph builders, so a fixture reads like the document it stands for.
const H2 = (t) => [t, STYLE(false, false, 'HEADING_2')];
const H3 = (t) => [t, STYLE(false, false, 'HEADING_3')];
const H4 = (t) => [t, STYLE(false, false, 'HEADING_4')];
const LABEL = (t) => [t, STYLE(true, false)];
const ITALIC = (t) => [t, STYLE(false, true)];
const TEXT = (t) => [t, STYLE(false, false)];
const BLANK = () => ['', STYLE(false, false)];

// A `clients` double that drives the REAL generateDraft against a Doc: reads
// return the document's current state, writes are applied to it, and every
// batch is recorded so a test can assert on the requests as well as the result.
function simClients(doc, title = 'Sim Doc') {
  const batches = [];
  return {
    batches,
    clients: {
      docs: {
        documents: {
          get: async () => ({ data: doc.toJson(title) }),
          batchUpdate: async ({ requestBody }) => {
            batches.push(requestBody.requests);
            doc.apply(requestBody.requests);
            return { data: {} };
          },
        },
      },
    },
  };
}

module.exports = { Doc, STYLE, simClients, H2, H3, H4, LABEL, ITALIC, TEXT, BLANK };
