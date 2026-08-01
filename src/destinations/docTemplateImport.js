'use strict';

// IMPORT A TENANT'S OWN TEMPLATE DOCUMENT (custom document types, step one).
//
// WHY UPLOAD AND NOT A PASTED LINK. The tenant OAuth scope is drive.file
// (routes/oauth.js:45) — "files this app creates … no access to pre-existing
// Drive files". A tenant pasting a link to a matrix they built by hand gets a
// 404, not a permissions prompt. There is no flag to change that; drive.readonly
// and drive are Google RESTRICTED scopes behind a security assessment and an
// annual third-party audit.
//
// An upload sidesteps the whole question. The bytes arrive through Quillio, so
// Quillio creates the Drive file — and drive.file covers a file the app created.
// The tenant keeps their original; this is a copy Quillio owns.
//
// THE IMPORT ITSELF is one call: drive.files.create with the .docx as the media
// body and mimeType 'application/vnd.google-apps.document' as the REQUEST BODY
// mime. That pairing is what makes Drive run its Word→Docs converter rather than
// storing the .docx as an opaque blob. What that converter does to a landscape
// multi-table document with merged cells is the open question step one exists to
// answer — see scripts/probeDocxImport.js, which runs the import against a real
// fixture and prints a fidelity report.

const { discoverPlaceholders } = require('./docPlaceholders');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const GDOC_MIME = 'application/vnd.google-apps.document';

// Import one .docx into Drive as a Google Doc, then read it back and discover its
// placeholders. Returns { docId, docUrl, title, discovery }.
//
// `clients` is { drive, docs } — the caller decides whose identity that is
// (getClientsForTenant, so the import runs as the acting user, exactly like every
// other write). `stream` is a readable stream of the .docx bytes.
async function importDocxTemplate({ clients, stream, name, folderId = null }) {
  if (!clients || !clients.drive || !clients.docs) throw new Error('No Google client for template import.');
  if (!stream) throw new Error('No file to import.');

  const created = await clients.drive.files.create({
    requestBody: {
      name: name || 'Quillio template',
      // The TARGET type. With a .docx media body, this is what triggers the
      // conversion — omit it and Drive keeps an unconvertible Word file.
      mimeType: GDOC_MIME,
      ...(folderId ? { parents: [folderId] } : {}),
    },
    media: { mimeType: DOCX_MIME, body: stream },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });

  const docId = created.data.id;
  const docUrl = created.data.webViewLink || `https://docs.google.com/document/d/${docId}/edit`;

  // Read the CONVERTED document, not the .docx. Everything discovery reports is
  // therefore a fact about what survived the import, which is the point.
  const doc = await clients.docs.documents.get({ documentId: docId });
  const discovery = discoverPlaceholders(doc.data);

  console.log(
    `[templateImport] imported "${created.data.name}" -> ${docId} — ` +
      `${discovery.counts.distinct} placeholder(s), ${discovery.counts.tables} table(s), ` +
      `${discovery.counts.warnings} warning(s)`
  );

  return { docId, docUrl, title: created.data.name, discovery };
}

// A compact structural summary of a converted document, for the fidelity report.
// Pure — takes documents.get JSON, returns what a reader needs to judge whether
// the import preserved the document. Separated from the import so it can be run
// over a fixture without credentials.
function summarizeStructure(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const style = d.documentStyle || {};
  const size = style.pageSize || {};
  const w = size.width && size.width.magnitude ? size.width.magnitude : 0;
  const h = size.height && size.height.magnitude ? size.height.magnitude : 0;

  const tables = [];
  const fonts = new Set();
  const merges = [];
  let shadedCells = 0;
  let mergedCells = 0;
  let tableIndex = 0;

  const walk = (content) => {
    for (const el of content || []) {
      if (el.paragraph) {
        for (const e of el.paragraph.elements || []) {
          const ff = e.textRun && e.textRun.textStyle && e.textRun.textStyle.weightedFontFamily;
          if (ff && ff.fontFamily) fonts.add(ff.fontFamily);
        }
        continue;
      }
      if (!el.table) continue;
      const t = el.table;
      const thisTable = tableIndex;
      tableIndex += 1;
      const rows = t.tableRows || [];
      const colWidths = ((t.tableStyle || {}).tableColumnProperties || []).map((c) =>
        c.width && c.width.magnitude ? Math.round(c.width.magnitude * 10) / 10 : null
      );
      let cells = 0;
      // Row widths as the API reports them. A vertical merge may be represented
      // either by an anchor with rowSpan and NO covered cell in the next row, or
      // by an anchor plus a covered cell — which of those Docs does decides
      // whether a row is short. Recording it means the report shows the answer
      // rather than depending on knowing it in advance.
      const rowCellCounts = [];
      for (const r of rows) {
        const rowCells = r.tableCells || [];
        rowCellCounts.push(rowCells.length);
        rowCells.forEach((c, colIndex) => {
          cells += 1;
          const cs = c.tableCellStyle || {};
          const rowSpan = cs.rowSpan || 1;
          const columnSpan = cs.columnSpan || 1;
          if (columnSpan > 1 || rowSpan > 1) {
            mergedCells += 1;
            // Enumerated, not just counted. "Which merge was lost" has to be
            // answerable by reading the report — a bare total can only say that
            // something is missing, never what.
            merges.push({
              table: thisTable,
              row: rowCellCounts.length - 1,
              column: colIndex,
              rowSpan,
              columnSpan,
              kind: columnSpan > 1 && rowSpan > 1 ? 'both' : columnSpan > 1 ? 'horizontal' : 'vertical',
            });
          }
          const bg = cs.backgroundColor;
          if (bg && bg.color) shadedCells += 1;
          walk(c.content);
        });
      }
      tables.push({
        rows: rows.length,
        columns: t.columns || 0,
        cells,
        colWidthsPt: colWidths,
        rowCellCounts,
      });
    }
  };
  walk((d.body && d.body.content) || []);

  return {
    pageSizePt: { width: Math.round(w * 10) / 10, height: Math.round(h * 10) / 10 },
    orientation: w > h ? 'landscape' : 'portrait',
    marginsPt: {
      top: style.marginTop && style.marginTop.magnitude,
      right: style.marginRight && style.marginRight.magnitude,
      bottom: style.marginBottom && style.marginBottom.magnitude,
      left: style.marginLeft && style.marginLeft.magnitude,
    },
    tables,
    tableCount: tables.length,
    mergedCells,
    merges,
    shadedCells,
    fonts: [...fonts].sort(),
    headers: Object.keys(d.headers || {}).length,
    footers: Object.keys(d.footers || {}).length,
  };
}

module.exports = { importDocxTemplate, summarizeStructure, DOCX_MIME, GDOC_MIME };
