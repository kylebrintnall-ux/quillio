'use strict';

// THE .DOCX IMPORT FIDELITY PROBE (custom document types, step one, item 2).
//
// Imports test/fixtures/copy-matrix.docx into Drive as a Google Doc and prints
// what survived the conversion, feature by feature, against what the fixture is
// known to contain. This is the risky question of step one: if Drive's Word→Docs
// converter flattens tables or drops merged cells, the copy-the-template approach
// does not work and everything built on it is wasted.
//
// It needs REAL GOOGLE CREDENTIALS and is therefore not part of `npm test` — the
// suite runs with no credentials and no network, deliberately. Run it once,
// anywhere the app's own credentials are configured (a Railway console is
// simplest, since GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_REFRESH_TOKEN are already
// in that environment):
//
//   node scripts/probeDocxImport.js
//
// It creates ONE file in Drive and deletes it again unless --keep is passed.
//
// The expectations below come from the fixture's OOXML, not from a guess — see
// scripts/makeTemplateFixture.js, which authors each feature explicitly.

const fs = require('fs');
const path = require('path');
const { getClients } = require('../src/google');
const { importDocxTemplate, summarizeStructure } = require('../src/destinations/docTemplateImport');
const { describeLocation } = require('../src/destinations/docPlaceholders');

const FIXTURE = path.join(__dirname, '..', 'test', 'fixtures', 'copy-matrix.docx');
const KEEP = process.argv.includes('--keep');

// What the .docx provably contains (verified by reading its XML).
const EXPECTED = {
  orientation: 'landscape',
  tableCount: 3,
  // Table 1 has 5 grid columns with FIVE DIFFERENT widths; table 2 has 3; table 3 has 2.
  columnsPerTable: [5, 3, 2],
  distinctColWidths: 8,
  mergedCells: 3, // one gridSpan + two vMerge rows
  shadedCells: 10,
  fonts: ['Georgia'],
  headers: 1,
  placeholders: ['Form Heading', 'Form Subhead', 'Submit Button', 'Confirmation Heading', 'Locale', 'Campaign Name'],
  duplicated: 'Form Heading',
  splitAcrossRuns: 'Confirmation Heading',
  inPageHeader: 'Campaign Name',
  malformed: '{{Unclosed legal line',
};

const line = (s) => console.log('\n' + '='.repeat(78) + '\n' + s + '\n' + '='.repeat(78));
const verdict = (ok) => (ok ? 'SURVIVED' : 'LOST');

(async () => {
  if (!fs.existsSync(FIXTURE)) {
    console.error(`Fixture missing: ${FIXTURE}\nRun: node scripts/makeTemplateFixture.js`);
    process.exit(1);
  }
  const clients = await getClients();

  line('IMPORTING test/fixtures/copy-matrix.docx');
  const imported = await importDocxTemplate({
    clients,
    stream: fs.createReadStream(FIXTURE),
    name: 'Quillio import probe — copy matrix',
  });
  console.log(`  ${imported.docUrl}`);

  const doc = await clients.docs.documents.get({ documentId: imported.docId });
  const s = summarizeStructure(doc.data);

  line('STRUCTURAL FIDELITY — what the converter did');
  const rows = [
    ['page orientation', EXPECTED.orientation, s.orientation, s.orientation === EXPECTED.orientation],
    ['page size (pt)', 'landscape (w > h)', `${s.pageSizePt.width} x ${s.pageSizePt.height}`, s.pageSizePt.width > s.pageSizePt.height],
    ['table count', EXPECTED.tableCount, s.tableCount, s.tableCount === EXPECTED.tableCount],
    ['columns per table', EXPECTED.columnsPerTable.join(','), s.tables.map((t) => t.columns).join(','),
      s.tables.map((t) => t.columns).join(',') === EXPECTED.columnsPerTable.join(',')],
    ['merged cells', EXPECTED.mergedCells, s.mergedCells, s.mergedCells >= 1],
    ['shaded cells', EXPECTED.shadedCells, s.shadedCells, s.shadedCells >= 1],
    ['non-default fonts', EXPECTED.fonts.join(','), s.fonts.join(',') || '(none)', s.fonts.includes('Georgia')],
    ['page headers', EXPECTED.headers, s.headers, s.headers >= 1],
  ];
  for (const [what, want, got, ok] of rows) {
    console.log(`  ${String(what).padEnd(20)} expected ${String(want).padEnd(22)} got ${String(got).padEnd(22)} ${verdict(ok)}`);
  }

  line('COLUMN WIDTHS — the detail a matrix lives or dies on');
  s.tables.forEach((t, i) => {
    const widths = (t.colWidthsPt || []).map((w) => (w == null ? '?' : w)).join(', ');
    console.log(`  table ${i + 1}: ${t.rows} rows x ${t.columns} cols — widths (pt): ${widths || '(none reported)'}`);
  });
  const allWidths = s.tables.flatMap((t) => t.colWidthsPt || []).filter((w) => w != null);
  const distinct = new Set(allWidths).size;
  console.log(`\n  distinct widths reported: ${distinct} (fixture has ${EXPECTED.distinctColWidths})`);
  console.log(`  widths preserved rather than equalized: ${verdict(distinct > 2)}`);

  line('PLACEHOLDER DISCOVERY over the CONVERTED document');
  const d = imported.discovery;
  console.log(`  counts: ${JSON.stringify(d.counts)}\n`);
  d.placeholders.forEach((ph) =>
    console.log(`  {{${ph.name}}}  x${ph.count}  ${ph.locations.map(describeLocation).join(' | ')}`)
  );
  console.log('\n  warnings:');
  d.warnings.forEach((w) => console.log(`    [${w.kind}] ${JSON.stringify(w.text)} at ${describeLocation(w.location)}`));

  line('THE FIVE EDGE CASES, AGAINST A REALLY-CONVERTED DOCUMENT');
  const names = d.placeholders.map((ph) => ph.name);
  const has = (n) => names.some((x) => x.toLowerCase() === n.toLowerCase());
  const dupe = d.placeholders.find((ph) => ph.name.toLowerCase() === EXPECTED.duplicated.toLowerCase());
  const hdr = d.placeholders.find((ph) => ph.name.toLowerCase() === EXPECTED.inPageHeader.toLowerCase());
  const checks = [
    ['split across two runs', EXPECTED.splitAcrossRuns, has(EXPECTED.splitAcrossRuns)],
    ['inside a merged cell', 'Submit Button', has('Submit Button')],
    ['appears twice', `${EXPECTED.duplicated} x2`, !!dupe && dupe.count === 2],
    ['malformed marker', EXPECTED.malformed, d.warnings.some((w) => w.kind === 'unclosed')],
    ['in a page header', EXPECTED.inPageHeader, !!hdr && hdr.locations.some((l) => l.part === 'header')],
  ];
  for (const [what, want, ok] of checks) {
    console.log(`  ${String(what).padEnd(24)} ${String(want).padEnd(26)} ${ok ? 'FOUND' : 'NOT FOUND'}`);
  }

  if (!KEEP) {
    await clients.drive.files.delete({ fileId: imported.docId, supportsAllDrives: true });
    console.log('\n(probe document deleted — pass --keep to inspect it in Drive)');
  }
  process.exit(0);
})().catch((err) => {
  console.error('\nPROBE FAILED:', err && err.message ? err.message : err);
  console.error('\nThis needs real Google credentials (GOOGLE_SERVICE_ACCOUNT_JSON, or');
  console.error('GOOGLE_CLIENT_ID/SECRET + GOOGLE_REFRESH_TOKEN). It is not part of npm test.');
  process.exit(1);
});
