'use strict';

// Build test/fixtures/copy-matrix.docx — the fidelity fixture for the .docx
// import (custom document types, step one).
//
// Hand-authored OOXML rather than a file exported from Word, so every feature
// under test is provably present and can be read straight out of the XML. It
// carries, deliberately, exactly the things a Salesforce-style copy matrix has
// and that a converter might not survive:
//
//   • LANDSCAPE page (w:pgSz w:orient="landscape")
//   • THREE TABLES, one of them 5 columns wide
//   • UNEVEN COLUMN WIDTHS in the grid (w:tblGrid w:gridCol)
//   • A MERGED CELL across two columns (w:gridSpan="2")
//   • A VERTICALLY MERGED cell (w:vMerge)
//   • CELL SHADING on the header row (w:shd w:fill)
//   • A NON-DEFAULT FONT (Georgia) on one run
//   • A PLACEHOLDER SPLIT ACROSS TWO RUNS by bold — visually identical to an
//     unsplit one, and the case that breaks run-by-run scanning
//   • A PLACEHOLDER IN A PAGE HEADER, which lives outside body.content
//   • A MALFORMED marker ({{Unclosed …) and a duplicate placeholder
//
// Run: node scripts/makeTemplateFixture.js
// (jszip is present via mammoth; this script is dev-only and never runs in prod.)

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const OUT = path.join(__dirname, '..', 'test', 'fixtures', 'copy-matrix.docx');

const p = (text, opts = {}) => {
  const rPr =
    (opts.bold ? '<w:b/>' : '') + (opts.font ? `<w:rFonts w:ascii="${opts.font}" w:hAnsi="${opts.font}"/>` : '');
  return `<w:p><w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
};

// A paragraph whose text is split across TWO runs at a formatting boundary.
const pSplit = (a, b) =>
  `<w:p><w:r><w:t xml:space="preserve">${a}</w:t></w:r>` +
  `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${b}</w:t></w:r></w:p>`;

const tc = (inner, opts = {}) => {
  const props =
    `<w:tcPr>` +
    (opts.w ? `<w:tcW w:w="${opts.w}" w:type="dxa"/>` : '') +
    (opts.gridSpan ? `<w:gridSpan w:val="${opts.gridSpan}"/>` : '') +
    (opts.vMerge ? `<w:vMerge w:val="${opts.vMerge}"/>` : '') +
    (opts.shd ? `<w:shd w:val="clear" w:color="auto" w:fill="${opts.shd}"/>` : '') +
    `</w:tcPr>`;
  return `<w:tc>${props}${inner}</w:tc>`;
};

const tr = (cells) => `<w:tr>${cells.join('')}</w:tr>`;

const tbl = (gridCols, rows) =>
  `<w:tbl>` +
  `<w:tblPr><w:tblW w:w="0" w:type="auto"/>` +
  `<w:tblBorders>` +
  ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((s) => `<w:${s} w:val="single" w:sz="6" w:color="999999"/>`)
    .join('') +
  `</w:tblBorders></w:tblPr>` +
  `<w:tblGrid>${gridCols.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` +
  rows.join('') +
  `</w:tbl>`;

const SHADE = 'D9E2F3';

// --- Table 1: the form copy matrix. 5 columns, uneven widths, shaded header,
//     one horizontally merged cell, one vertically merged cell.
const T1_GRID = [2200, 3400, 2600, 1800, 2400];
const table1 = tbl(T1_GRID, [
  tr([
    tc(p('Field', { bold: true }), { w: T1_GRID[0], shd: SHADE }),
    tc(p('Copy', { bold: true }), { w: T1_GRID[1], shd: SHADE }),
    tc(p('Character limit', { bold: true }), { w: T1_GRID[2], shd: SHADE }),
    tc(p('Element ID', { bold: true }), { w: T1_GRID[3], shd: SHADE }),
    tc(p('Notes', { bold: true }), { w: T1_GRID[4], shd: SHADE }),
  ]),
  tr([
    tc(p('Form heading'), { w: T1_GRID[0] }),
    tc(p('{{Form Heading}}'), { w: T1_GRID[1] }),
    tc(p('60'), { w: T1_GRID[2] }),
    tc(p('frm-hd-01'), { w: T1_GRID[3], vMerge: 'restart' }),
    tc(p('Above the fold'), { w: T1_GRID[4] }),
  ]),
  tr([
    tc(p('Form subhead'), { w: T1_GRID[0] }),
    tc(p('{{Form Subhead}}'), { w: T1_GRID[1] }),
    tc(p('120'), { w: T1_GRID[2] }),
    tc(p(''), { w: T1_GRID[3], vMerge: 'continue' }),
    tc(p('Optional'), { w: T1_GRID[4] }),
  ]),
  tr([
    tc(p('Submit button'), { w: T1_GRID[0] }),
    // MERGED across Copy + Character limit.
    tc(p('{{Submit Button}}'), { w: T1_GRID[1] + T1_GRID[2], gridSpan: 2 }),
    tc(p('frm-btn-01'), { w: T1_GRID[3] }),
    tc(p('Verb first'), { w: T1_GRID[4] }),
  ]),
  tr([
    tc(p('Legal'), { w: T1_GRID[0] }),
    // MALFORMED — no closing braces.
    tc(p('{{Unclosed legal line'), { w: T1_GRID[1] }),
    tc(p('—'), { w: T1_GRID[2] }),
    tc(p('frm-lgl-01'), { w: T1_GRID[3] }),
    tc(p('Legal to approve', { font: 'Georgia' }), { w: T1_GRID[4] }),
  ]),
]);

// --- Table 2: the confirmation page. Reuses {{Form Heading}} — a DUPLICATE.
const T2_GRID = [2600, 4200, 2000];
const table2 = tbl(T2_GRID, [
  tr([
    tc(p('Field', { bold: true }), { w: T2_GRID[0], shd: SHADE }),
    tc(p('Copy', { bold: true }), { w: T2_GRID[1], shd: SHADE }),
    tc(p('Element ID', { bold: true }), { w: T2_GRID[2], shd: SHADE }),
  ]),
  tr([
    tc(p('Confirmation heading'), { w: T2_GRID[0] }),
    // SPLIT ACROSS TWO RUNS at a bold boundary — reads as one token on screen.
    tc(pSplit('{{Confirmation ', 'Heading}}'), { w: T2_GRID[1] }),
    tc(p('cnf-hd-01'), { w: T2_GRID[2] }),
  ]),
  tr([
    tc(p('Echoed form heading'), { w: T2_GRID[0] }),
    tc(p('{{Form Heading}}'), { w: T2_GRID[1] }),
    tc(p('cnf-echo-01'), { w: T2_GRID[2] }),
  ]),
]);

// --- Table 3: a small technical table, to prove multiple tables survive.
const T3_GRID = [3000, 3000];
const table3 = tbl(T3_GRID, [
  tr([tc(p('Property', { bold: true }), { w: T3_GRID[0], shd: SHADE }), tc(p('Value', { bold: true }), { w: T3_GRID[1], shd: SHADE })]),
  tr([tc(p('Locale'), { w: T3_GRID[0] }), tc(p('{{Locale}}'), { w: T3_GRID[1] })]),
]);

const SECT_PR =
  '<w:sectPr>' +
  // US Letter LANDSCAPE: 15840 x 12240 twips.
  '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>' +
  '<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/>' +
  '<w:headerReference w:type="default" r:id="rId10"/>' +
  '</w:sectPr>';

const DOCUMENT =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<w:body>' +
  p('Campaign copy matrix', { bold: true }) +
  p('Form') +
  table1 +
  p('') +
  p('Confirmation') +
  table2 +
  p('') +
  table3 +
  SECT_PR +
  '</w:body></w:document>';

const HEADER =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  p('{{Campaign Name}} — internal use only') +
  '</w:hdr>';

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' +
  '</Types>';

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

const DOC_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' +
  '</Relationships>';

(async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels').file('.rels', ROOT_RELS);
  const word = zip.folder('word');
  word.file('document.xml', DOCUMENT);
  word.file('header1.xml', HEADER);
  word.folder('_rels').file('document.xml.rels', DOC_RELS);

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buf);
  console.log(`wrote ${OUT} (${buf.length} bytes)`);
  console.log('  landscape 15840x12240 twips · 3 tables · uneven grid · gridSpan + vMerge · shaded header · Georgia run');
  console.log('  placeholders: Form Heading (x2), Form Subhead, Submit Button, Confirmation Heading (split across runs),');
  console.log('                Locale, Campaign Name (page header) · malformed: {{Unclosed legal line');
})();
