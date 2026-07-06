'use strict';

// Header re-read / reconstruction (doc-header-template work, step 4 — the crux).
//
// Given an edited Google Doc (the Docs API documents.get JSON), reconstruct the
// HEADER portion — everything ABOVE the HEADER_BOUNDARY_MARKER — back into the
// Step-2 block schema (docHeaderSchema.js). Whatever the user shaped above the
// line becomes their saved standard header format.
//
// Contract (from Step 3): the boundary is the FIRST top-level paragraph whose
// trimmed text equals HEADER_BOUNDARY_MARKER. Everything before it is the header;
// the marker and everything after are ignored. If no marker is found we parse the
// whole doc (best-effort) and log a warning.
//
// Docs-JSON -> block mapping (parse IN ORDER, faithfully; never assume a table):
//   • a Docs table element        -> { type:'table', table:{columns,colWidthsPt,rows} }
//   • a heading-styled paragraph  -> { type:'heading', text }
//         (namedStyleType HEADING_*/TITLE, or bold + large font with no colon)
//   • one "Label: value" line     -> { type:'text', label, value, fill }
//   • many "Label: value" pairs   -> { type:'field_row', fields:[{label,value,fill}] }
//   • an empty bordered paragraph -> { type:'divider' }   (how horizontalRule renders)
//   • any other non-empty line    -> { type:'text', text }
//   • empty, unbordered paragraph -> skipped (spacing)
//
// Label/value detection prefers TEXT STYLE: the renderer writes "Label: " in
// regular weight and the value in bold, so we pair a regular run (ending in a
// colon) with the following bold run. If the user stripped the bold, we fall back
// to a text regex. `fill` is re-inferred from the label by keyword (best-effort);
// it does not affect rendering, so it never breaks the render round-trip.

const { getClients } = require('../google');
const { HEADER_BOUNDARY_MARKER } = require('./docHeaderSample');

const HEADING_STYLES = new Set([
  'TITLE',
  'SUBTITLE',
  'HEADING_1',
  'HEADING_2',
  'HEADING_3',
  'HEADING_4',
  'HEADING_5',
  'HEADING_6',
]);

// Labels Quillio can auto-fill from its own data vs. fields it doesn't own.
// Re-inferred on re-read (the user's edit carries no fill intent). Best-effort.
const AUTO_LABEL_RE = /\b(project|campaign|date|version|writer|owner|author)\b/i;

function fillFor(label) {
  return AUTO_LABEL_RE.test(String(label || '')) ? 'auto' : 'blank';
}

// Flatten a paragraph into { text, runs, namedStyle, alignment, hasBottomBorder,
// maxFontSize, anyBold }. `runs` are [{ text, bold, fontSize }] in order (the
// trailing newline run is kept but is whitespace-only, so it never affects
// label/value pairing).
function paraInfo(paragraph) {
  const els = paragraph.elements || [];
  const runs = [];
  let text = '';
  let maxFontSize = 0;
  let anyBold = false;
  let hasHorizontalRule = false;
  for (const el of els) {
    // Insert > Horizontal line renders as a horizontalRule element (not a
    // textRun), which is one of the two ways a rule can appear (the other is an
    // empty paragraph with a bottom border, from our own horizontalRule()).
    if (el.horizontalRule) hasHorizontalRule = true;
    const tr = el.textRun;
    if (!tr || tr.content == null) continue;
    const content = tr.content;
    const ts = tr.textStyle || {};
    const bold = !!ts.bold;
    const fontSize = ts.fontSize && ts.fontSize.magnitude ? ts.fontSize.magnitude : 0;
    if (bold && content.trim()) anyBold = true;
    if (fontSize > maxFontSize) maxFontSize = fontSize;
    runs.push({ text: content, bold, fontSize });
    text += content;
  }
  text = text.replace(/\n+$/, '');
  const ps = paragraph.paragraphStyle || {};
  return {
    text: text.trim(),
    rawText: text,
    runs,
    namedStyle: ps.namedStyleType || 'NORMAL_TEXT',
    alignment: ps.alignment || null,
    hasBottomBorder: !!ps.borderBottom,
    hasHorizontalRule,
    maxFontSize,
    anyBold,
  };
}

// A run is a "value" if it's bold and has visible text.
function isValueRun(r) {
  return r.bold && r.text.trim().length > 0;
}

// Pair label(regular) + value(bold) runs into [{label, value}]. The label is the
// accumulated regular text before a bold value run, with any inter-pair separator
// whitespace and the trailing colon stripped. Returns only clean pairs.
function pairsFromRuns(runs) {
  const pairs = [];
  let pending = '';
  for (const r of runs) {
    if (isValueRun(r)) {
      let label = pending.replace(/\s+/g, ' ').trim();
      label = label.replace(/:\s*$/, '').trim();
      const value = r.text.trim();
      if (label && value && label.length <= 40) pairs.push({ label, value });
      pending = '';
    } else {
      pending += r.text;
    }
  }
  return pairs;
}

// Fallback when bold was stripped: split a line into "Label: value" pairs on a
// run of 3+ spaces (the renderer joins pairs with 4 spaces) or a tab. Returns
// null if the line isn't cleanly all label:value pairs.
function pairsFromText(text) {
  const segs = String(text)
    .split(/\s{3,}|\t+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!segs.length) return null;
  const pairs = [];
  for (const s of segs) {
    const m = s.match(/^(.{1,40}?):\s+(.+)$/);
    if (!m) return null;
    pairs.push({ label: m[1].trim(), value: m[2].trim() });
  }
  return pairs.length ? pairs : null;
}

function isHeading(info) {
  if (HEADING_STYLES.has(info.namedStyle)) return true;
  // A prominent standalone line (bold, large) with no "label:" reads as a heading.
  if (info.anyBold && info.maxFontSize >= 16 && !info.text.includes(':')) return true;
  return false;
}

// Convert a single paragraph to a block, or null to skip (spacing).
function paragraphToBlock(paragraph) {
  const info = paraInfo(paragraph);

  // A rule is either an inserted horizontalRule element or (how our own
  // horizontalRule() renders) an empty paragraph with a bottom border.
  if (info.hasHorizontalRule || (!info.text && info.hasBottomBorder)) {
    return { type: 'divider' };
  }
  if (!info.text) {
    return null; // empty spacing paragraph
  }
  if (isHeading(info)) {
    return { type: 'heading', text: info.text };
  }

  let pairs = pairsFromRuns(info.runs);
  if (!pairs.length) {
    const fallback = pairsFromText(info.text);
    if (fallback) pairs = fallback;
  }
  if (pairs.length >= 2) {
    return { type: 'field_row', fields: pairs.map((p) => ({ ...p, fill: fillFor(p.label) })) };
  }
  if (pairs.length === 1) {
    return { type: 'text', label: pairs[0].label, value: pairs[0].value, fill: fillFor(pairs[0].label) };
  }
  return { type: 'text', text: info.text };
}

// Read fixed column widths (PT) off a table element, if present.
function readColWidths(tableEl) {
  const props =
    tableEl.table && tableEl.table.tableStyle && tableEl.table.tableStyle.tableColumnProperties;
  if (!Array.isArray(props)) return undefined;
  const widths = props.map((p) => (p && p.width && p.width.magnitude ? Math.round(p.width.magnitude) : null));
  return widths.some((w) => w != null) ? widths.map((w) => w || 0) : undefined;
}

// Parse one table cell into a schema cell: { wordmark, fill } or { fields:[...] }.
// Combines the cell's paragraph(s), then detects label/value pairs (fields) vs a
// standalone prominent string (wordmark). Empty cell -> { fields: [] }.
function parseCell(cell) {
  const paras = (cell.content || []).filter((e) => e.paragraph);
  let runs = [];
  let text = '';
  for (const e of paras) {
    const info = paraInfo(e.paragraph);
    if (info.text) {
      if (text) text += ' ';
      text += info.text;
      runs = runs.concat(info.runs);
    }
  }
  if (!text.trim()) return { fields: [] };

  let pairs = pairsFromRuns(runs);
  if (!pairs.length) {
    const fallback = pairsFromText(text);
    if (fallback) pairs = fallback;
  }
  if (pairs.length) {
    return { fields: pairs.map((p) => ({ ...p, fill: fillFor(p.label) })) };
  }
  // No pairs -> a brand/wordmark cell (static).
  return { wordmark: text.trim(), fill: 'static' };
}

function parseTable(tableEl) {
  const tableRows = (tableEl.table && tableEl.table.tableRows) || [];
  const rows = tableRows.map((r) => (r.tableCells || []).map(parseCell));
  const columns = rows.reduce((m, r) => Math.max(m, r.length), 0) || tableEl.table.columns || 2;
  const table = { columns, rows };
  const colWidthsPt = readColWidths(tableEl);
  if (colWidthsPt) table.colWidthsPt = colWidthsPt;
  return { type: 'table', table };
}

// Index in body.content of the boundary-marker paragraph, or -1.
function findBoundaryIndex(content) {
  for (let i = 0; i < content.length; i++) {
    const item = content[i];
    if (!item.paragraph) continue;
    if (paraInfo(item.paragraph).text === HEADER_BOUNDARY_MARKER) return i;
  }
  return -1;
}

// Parse a documents.get() doc into a header block schema { version, blocks }.
// Stops at the boundary marker (parses the whole doc, with a warning, if absent).
function parseHeaderSchema(doc) {
  const content = (doc && doc.body && doc.body.content) || [];
  let end = content.length;
  const markerIdx = findBoundaryIndex(content);
  if (markerIdx >= 0) {
    end = markerIdx;
  } else {
    console.warn('[docHeaderReader] boundary marker not found — parsing entire doc as header');
  }

  const blocks = [];
  for (let i = 0; i < end; i++) {
    const item = content[i];
    if (item.table) {
      blocks.push(parseTable(item));
      continue;
    }
    if (!item.paragraph) continue;
    const block = paragraphToBlock(item.paragraph);
    if (block) blocks.push(block);
  }
  return { version: 1, blocks };
}

// Fetch a doc by id and parse its header schema. Optional `clients` runs the read
// as a tenant's OAuth user. Returns { version, blocks }.
async function readHeaderSchema(docId, clients) {
  const { docs } = clients || (await getClients());
  const doc = (await docs.documents.get({ documentId: docId })).data;
  return parseHeaderSchema(doc);
}

module.exports = {
  parseHeaderSchema,
  readHeaderSchema,
  findBoundaryIndex,
  // exposed for unit tests
  paragraphToBlock,
  parseTable,
  parseCell,
  pairsFromRuns,
  pairsFromText,
  paraInfo,
  fillFor,
};
