'use strict';

// Header-table primitive (doc-header-template work, step 1). Renders a
// structured, bordered metadata header as a real Google Docs table.
//
// WHY THIS IS TWO-PHASE (and not folded into DocBuilder's single index-1 insert):
// Google Docs tables can't be built in one batchUpdate alongside the rest of the
// doc. `insertTable` creates the structure, but the cell indices needed to fill
// cells aren't known until the table exists — Google's own guidance is to create
// the table, then re-read the document to locate the cells, then write into them.
// So rendering is:
//   Phase 1 — insert the empty table (tableInsertRequests).
//   [caller re-reads the doc and locates the table via findHeaderTable]
//   Phase 2 — style the table + fill cells (tableStyleRequests + cellFillRequests),
//             filling cells in REVERSE order so each insert can't shift the
//             indices of cells not yet filled.
// The caller orchestrates the read between phases (see scripts/genHeaderTableTestDoc.js).

const HEADER_BORDER = {
  color: { color: { rgbColor: { red: 0.4, green: 0.4, blue: 0.4 } } },
  width: { magnitude: 1, unit: 'PT' },
  dashStyle: 'SOLID',
};
const CELL_PAD = { magnitude: 5, unit: 'PT' };

// Hardcoded sample modeled on the "MC Creative" creative-brief header
// (PHASE4_BUILD_PLAN_EXTENSIONS.md §2):
//   Left col:  wordmark, Project, Writer
//   Right col: Product, (Date + Version), Last edit by
// A cell is either { wordmark } (large brand text) or { fields: [{label, value}] }
// (labels regular weight, values bold). This is intentionally hardcoded — schema
// extraction, storage, and UI are later steps.
const SAMPLE_HEADER_SCHEMA = {
  columns: 2,
  colWidthsPt: [260, 260],
  rows: [
    [{ wordmark: 'MC Creative' }, { fields: [{ label: 'Product', value: 'Agentforce Service' }] }],
    [
      { fields: [{ label: 'Project', value: 'State of Support 2026' }] },
      { fields: [{ label: 'Date', value: '2026-07-05' }, { label: 'Version', value: 'v1' }] },
    ],
    [
      { fields: [{ label: 'Writer', value: 'Kyle Brintnall' }] },
      { fields: [{ label: 'Last edit by', value: 'Kyle Brintnall' }] },
    ],
  ],
};

function rowCount(schema) {
  return schema.rows.length;
}
function colCount(schema) {
  return schema.columns;
}

// Phase 1 — insert the empty table at the top of the doc (index 1).
function tableInsertRequests(schema) {
  return [
    { insertTable: { rows: rowCount(schema), columns: colCount(schema), location: { index: 1 } } },
  ];
}

// Find the (first) table element in a re-read document. Returns the structural
// element ({ startIndex, endIndex, table: { tableRows: [...] } }) or null.
function findHeaderTable(doc) {
  const content = (doc && doc.body && doc.body.content) || [];
  return content.find((e) => e.table) || null;
}

// The plain text + per-run styling for one cell. Offsets in styleRuns are
// relative to the cell text (0-based). An empty cell → { text: '', styleRuns: [] }.
function renderCell(cell) {
  if (cell && cell.wordmark) {
    const text = String(cell.wordmark);
    return {
      text,
      styleRuns: [
        {
          start: 0,
          len: text.length,
          textStyle: { bold: true, fontSize: { magnitude: 32, unit: 'PT' } },
          fields: 'bold,fontSize',
        },
      ],
    };
  }
  const fields = (cell && cell.fields) || [];
  if (fields.length === 0) return { text: '', styleRuns: [] };
  let text = '';
  const styleRuns = [];
  fields.forEach((f, i) => {
    if (i > 0) text += '    '; // gap between multiple fields in one cell (e.g. Date + Version)
    text += `${f.label}: `;
    const valStart = text.length;
    const val = String(f.value == null ? '' : f.value);
    text += val;
    // Only bold a non-empty value. A blank-for-human field ("Product:") has an
    // empty value → a zero-length range, which the Docs API rejects
    // ("updateTextStyle: The range should not be empty").
    if (val.length > 0) {
      styleRuns.push({ start: valStart, len: val.length, textStyle: { bold: true }, fields: 'bold' });
    }
  });
  return { text, styleRuns };
}

// Phase 2a — structural styling (column widths + a uniform border/padding over
// every cell). No content is inserted, so cell indices stay stable; safe to run
// before the cell-fill requests in the same batch.
function tableStyleRequests(tableEl, schema) {
  const tableStartLocation = { index: tableEl.startIndex };
  const reqs = [];

  (schema.colWidthsPt || []).forEach((w, i) => {
    reqs.push({
      updateTableColumnProperties: {
        tableStartLocation,
        columnIndices: [i],
        tableColumnProperties: { widthType: 'FIXED_WIDTH', width: { magnitude: w, unit: 'PT' } },
        fields: 'width,widthType',
      },
    });
  });

  reqs.push({
    updateTableCellStyle: {
      tableRange: {
        tableCellLocation: { tableStartLocation, rowIndex: 0, columnIndex: 0 },
        rowSpan: rowCount(schema),
        columnSpan: colCount(schema),
      },
      tableCellStyle: {
        borderTop: HEADER_BORDER,
        borderBottom: HEADER_BORDER,
        borderLeft: HEADER_BORDER,
        borderRight: HEADER_BORDER,
        paddingTop: CELL_PAD,
        paddingBottom: CELL_PAD,
        paddingLeft: CELL_PAD,
        paddingRight: CELL_PAD,
      },
      fields:
        'borderTop,borderBottom,borderLeft,borderRight,paddingTop,paddingBottom,paddingLeft,paddingRight',
    },
  });

  return reqs;
}

// Phase 2b — fill cell text + per-run styling. Cells are filled in REVERSE order
// (bottom-right → top-left) so each insert happens at a higher index than the
// cells still to be filled, keeping the read-back indices valid throughout.
function cellFillRequests(tableEl, schema) {
  const reqs = [];
  const R = rowCount(schema);
  const C = colCount(schema);
  for (let r = R - 1; r >= 0; r--) {
    for (let c = C - 1; c >= 0; c--) {
      const cell = schema.rows[r] && schema.rows[r][c];
      const { text, styleRuns } = renderCell(cell);
      if (!text) continue;
      const cellStart = tableEl.table.tableRows[r].tableCells[c].content[0].startIndex;
      reqs.push({ insertText: { location: { index: cellStart }, text } });
      for (const run of styleRuns) {
        if (!(run.len > 0)) continue; // never emit an empty-range updateTextStyle
        reqs.push({
          updateTextStyle: {
            range: { startIndex: cellStart + run.start, endIndex: cellStart + run.start + run.len },
            textStyle: run.textStyle,
            fields: run.fields,
          },
        });
      }
    }
  }
  return reqs;
}

module.exports = {
  SAMPLE_HEADER_SCHEMA,
  tableInsertRequests,
  findHeaderTable,
  tableStyleRequests,
  cellFillRequests,
  renderCell,
};
