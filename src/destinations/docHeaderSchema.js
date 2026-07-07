'use strict';

// Block-based doc-header schema (doc-header-template work, step 2).
//
// A doc header is NOT always a table — it's whatever structure a team puts at the
// top of their copy docs: a title, a few label:value lines, or a bordered
// metadata table. So the schema is format-agnostic: a header is an ordered
// sequence of typed BLOCKS. DocBuilder.renderHeader() loops the blocks and
// dispatches each to the matching primitive.
//
// Schema shape:
//   { version: 1, blocks: [ <block>, ... ] }
//
// Block types:
//   { type: 'heading', text }                       -> large heading line
//   { type: 'text', text }                           -> a plain line
//   { type: 'text', label, value, fill }             -> a "label: value" line (value bold)
//   { type: 'field_row', fields: [ {label,value,fill}, ... ] }  -> label:value pairs on one row
//   { type: 'divider' }                              -> horizontal rule
//   { type: 'table', table: { columns, colWidthsPt, rows } }    -> the two-column metadata table
//        where each row is an array of cells, and a cell is either
//          { wordmark, fill }                        (large brand text)
//        or { fields: [ {label,value,fill}, ... ] }  (labels regular, values bold)
//        This is exactly the shape the step-1 table primitive already renders.
//
// FILL CLASSIFICATION — every field/value carries a `fill` marking how it should
// eventually be populated:
//   'auto'   — auto-fillable from Quillio data (campaign/project, writer, date, version)
//   'static' — fixed branding (e.g. the team wordmark)
//   'blank'  — Quillio doesn't own it; reproduce the label, leave the value for a human
// NOTE: auto-fill POPULATION is a later step. For now rendering uses each field's
// stored `value` verbatim; `fill` is carried through as metadata only.

const FILL = { AUTO: 'auto', STATIC: 'static', BLANK: 'blank' };

const BLOCK_TYPES = ['heading', 'text', 'field_row', 'divider', 'table'];

// A header schema is usable if it's an object with a non-empty `blocks` array.
// Unknown block types are skipped at render time (never thrown), so validity here
// is deliberately lenient — a malformed/edge schema degrades to the default
// header rather than failing doc creation.
function isValidHeaderSchema(schema) {
  return !!(schema && typeof schema === 'object' && Array.isArray(schema.blocks) && schema.blocks.length > 0);
}

// True if the schema renders a Docs table (which forces the two-phase
// insert -> re-read -> fill flow, unlike the single-batch text blocks).
function schemaHasTable(schema) {
  return isValidHeaderSchema(schema) && schema.blocks.some((b) => b && b.type === 'table');
}

// --- Seed schemas (for verification; no UI/extraction yet) ---
// Both model the same "MC Creative" header, one as a bordered table and one as a
// heading-plus-text layout, so we can confirm BOTH a table header and a non-table
// header render correctly from a stored schema.

const SEED_TABLE_HEADER = {
  version: 1,
  blocks: [
    {
      type: 'table',
      table: {
        columns: 2,
        colWidthsPt: [260, 260],
        rows: [
          [
            { wordmark: 'MC Creative', fill: FILL.STATIC },
            { fields: [{ label: 'Product', value: 'Agentforce Service', fill: FILL.BLANK }] },
          ],
          [
            { fields: [{ label: 'Project', value: 'State of Support 2026', fill: FILL.AUTO }] },
            {
              fields: [
                { label: 'Date', value: '2026-07-05', fill: FILL.AUTO },
                { label: 'Version', value: 'v1', fill: FILL.AUTO },
              ],
            },
          ],
          [
            { fields: [{ label: 'Writer', value: 'Kyle Brintnall', fill: FILL.AUTO }] },
            { fields: [{ label: 'Last edit by', value: 'Kyle Brintnall', fill: FILL.BLANK }] },
          ],
        ],
      },
    },
  ],
};

const SEED_TEXT_HEADER = {
  version: 1,
  blocks: [
    { type: 'heading', text: 'MC Creative' },
    { type: 'text', label: 'Project', value: 'State of Support 2026', fill: FILL.AUTO },
    {
      type: 'field_row',
      fields: [
        { label: 'Date', value: '2026-07-05', fill: FILL.AUTO },
        { label: 'Version', value: 'v1', fill: FILL.AUTO },
      ],
    },
    { type: 'text', label: 'Writer', value: 'Kyle Brintnall', fill: FILL.AUTO },
    { type: 'divider' },
  ],
};

// Look up a named seed schema ('table' | 'text'), or null.
function seedSchema(name) {
  if (name === 'table') return SEED_TABLE_HEADER;
  if (name === 'text') return SEED_TEXT_HEADER;
  return null;
}

// --- Normalization (Gemini extraction, step 5) ---
// Gemini's raw JSON is untrusted: coerce it into the canonical schema so a
// malformed/loose extraction can never reach the renderer. Unknown block types
// and label-less fields are dropped; every field/cell gets a valid `fill`.
// Returns { version: 1, blocks: [...] } — blocks may be empty (an invalid /
// empty extraction), which isValidHeaderSchema() then reports as unusable.

function normFill(v) {
  const s = String(v || '').toLowerCase();
  return s === 'auto' || s === 'static' || s === 'blank' ? s : FILL.BLANK;
}

function normField(f) {
  const label = String((f && f.label) || '').trim();
  if (!label) return null;
  return { label, value: f && f.value != null ? String(f.value) : '', fill: normFill(f && f.fill) };
}

function normCell(c) {
  if (c && c.wordmark != null && String(c.wordmark).trim()) {
    return { wordmark: String(c.wordmark).trim(), fill: normFill(c.fill) === 'blank' ? FILL.STATIC : normFill(c.fill) };
  }
  const fields = ((c && c.fields) || []).map(normField).filter(Boolean);
  return { fields };
}

function normTable(t) {
  const rows = ((t && t.rows) || []).map((r) => (Array.isArray(r) ? r.map(normCell) : []));
  const columns = Number(t && t.columns) || rows.reduce((m, r) => Math.max(m, r.length), 0) || 2;
  const table = { columns, rows };
  const widths = t && t.colWidthsPt;
  if (Array.isArray(widths) && widths.some((w) => Number(w) > 0)) {
    table.colWidthsPt = widths.map((w) => Number(w) || 0);
  }
  return table;
}

function normBlock(b) {
  switch (b && b.type) {
    case 'heading': {
      const text = String(b.text || '').trim();
      return text ? { type: 'heading', text } : null;
    }
    case 'text': {
      if (b.label != null && String(b.label).trim()) {
        const f = normField(b);
        return f ? { type: 'text', label: f.label, value: f.value, fill: f.fill } : null;
      }
      const text = String(b.text || '').trim();
      return text ? { type: 'text', text } : null;
    }
    case 'field_row': {
      const fields = ((b && b.fields) || []).map(normField).filter(Boolean);
      return fields.length ? { type: 'field_row', fields } : null;
    }
    case 'divider':
      return { type: 'divider' };
    case 'table':
      return { type: 'table', table: normTable(b.table) };
    default:
      return null; // unknown/edge block — drop rather than render garbage
  }
}

function normalizeHeaderSchema(raw) {
  const rawBlocks = raw && Array.isArray(raw.blocks) ? raw.blocks : [];
  const blocks = rawBlocks.map(normBlock).filter(Boolean);
  return { version: 1, blocks };
}

module.exports = {
  FILL,
  BLOCK_TYPES,
  isValidHeaderSchema,
  schemaHasTable,
  normalizeHeaderSchema,
  SEED_TABLE_HEADER,
  SEED_TEXT_HEADER,
  seedSchema,
};
