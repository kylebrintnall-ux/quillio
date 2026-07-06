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

module.exports = {
  FILL,
  BLOCK_TYPES,
  isValidHeaderSchema,
  schemaHasTable,
  SEED_TABLE_HEADER,
  SEED_TEXT_HEADER,
  seedSchema,
};
