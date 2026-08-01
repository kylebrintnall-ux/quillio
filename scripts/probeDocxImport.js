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
  // MERGES ARE COUNTED AS DOCS CELLS THAT SPAN, NOT AS OOXML PROPERTIES.
  //
  // This expectation was wrong on the first run and reported "expected 3, got 2".
  // The 3 counted XML elements carrying a merge property — one w:gridSpan plus
  // BOTH rows of the w:vMerge pair. summarizeStructure counts something else: a
  // Docs cell whose tableCellStyle reports rowSpan or columnSpan > 1. A vertical
  // merge across two rows is two XML elements but ONE spanning Docs cell, so the
  // fixture contains two spanning cells, not three.
  //
  // Stated as the two merges the fixture actually has, so the report names them:
  mergedCells: 2,
  merges: [
    { kind: 'horizontal', columnSpan: 2, what: 'w:gridSpan=2 on the {{Submit Button}} cell' },
    { kind: 'vertical', rowSpan: 2, what: 'w:vMerge restart+continue on the Element ID column' },
  ],
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

// A row is EXACT unless there is a stated reason it cannot be. The first version
// of this report compared merged cells, shaded cells and page headers with
// `>= 1` — which reports SURVIVED when two thirds of something is missing, and
// did exactly that. A floor is a legitimate comparison only when the converter
// is genuinely allowed to return a different number, and then the reason has to
// be written down next to it, because a floor with no reason is a check that
// cannot fail.
const exact = (want, got) => ({ want, got, ok: String(want) === String(got) });
const atLeast = (want, got, why) => {
  if (!why) throw new Error('a floor comparison must state why it is not exact');
  return { want: `>= ${want}`, got, ok: Number(got) >= Number(want), why };
};

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
    ['page orientation', exact(EXPECTED.orientation, s.orientation)],
    ['page size (pt)', {
      want: 'landscape (w > h)',
      got: `${s.pageSizePt.width} x ${s.pageSizePt.height}`,
      ok: s.pageSizePt.width > s.pageSizePt.height,
    }],
    ['table count', exact(EXPECTED.tableCount, s.tableCount)],
    ['columns per table', exact(EXPECTED.columnsPerTable.join(','), s.tables.map((t) => t.columns).join(','))],
    ['merged cells', exact(EXPECTED.mergedCells, s.mergedCells)],
    ['shaded cells', exact(EXPECTED.shadedCells, s.shadedCells)],
    ['non-default fonts', exact(EXPECTED.fonts.join(','), s.fonts.join(',') || '(none)')],
    ['page headers', atLeast(EXPECTED.headers, s.headers,
      'Docs may split one Word header into first-page/default/even variants, so more than one is correct; zero is not')],
  ];
  for (const [what, r] of rows) {
    console.log(
      `  ${String(what).padEnd(20)} expected ${String(r.want).padEnd(22)} got ${String(r.got).padEnd(22)} ${verdict(r.ok)}`
    );
    if (r.why && r.ok) console.log(`  ${''.padEnd(20)}   (floor, not exact: ${r.why})`);
  }
  const lost = rows.filter(([, r]) => !r.ok);
  console.log(lost.length ? `\n  ${lost.length} FEATURE(S) LOST — see below` : '\n  every structural feature survived');

  line('MERGED CELLS, ONE BY ONE — which merge, not how many');
  // A total can only say something is missing. This says WHICH, and that is the
  // thing that constrains what a tenant's matrix may contain: if horizontal
  // merges survive and vertical ones do not, that is a rule they have to be
  // told, and no count can express it.
  if (!s.merges.length) {
    console.log('  none reported — BOTH merge types lost');
  } else {
    s.merges.forEach((m) => {
      console.log(
        `  table ${m.table + 1}, row ${m.row + 1}, column ${m.column + 1} — ` +
          `${m.kind} (rowSpan ${m.rowSpan}, columnSpan ${m.columnSpan})`
      );
    });
  }
  const kinds = new Set(s.merges.map((m) => m.kind));
  for (const want of EXPECTED.merges) {
    const found = s.merges.some(
      (m) =>
        m.kind === want.kind &&
        (want.columnSpan ? m.columnSpan === want.columnSpan : true) &&
        (want.rowSpan ? m.rowSpan === want.rowSpan : true)
    );
    console.log(`\n  ${want.kind.toUpperCase()} — ${want.what}`);
    console.log(`    ${found ? 'SURVIVED' : 'LOST — a tenant matrix must not rely on this merge type'}`);
  }

  // How a vertical merge is represented decides whether a row is short. Reported
  // rather than assumed, because both representations are legal and which one
  // Docs uses is not something to guess at.
  console.log('\n  cells per row, per table (a short row = the covered cell is omitted):');
  s.tables.forEach((t, i) => console.log(`    table ${i + 1}: [${(t.rowCellCounts || []).join(', ')}] of ${t.columns} columns`));
  console.log(`\n  merge kinds present: ${[...kinds].join(', ') || '(none)'}`);

  line('COLUMN WIDTHS — the detail a matrix lives or dies on');
  s.tables.forEach((t, i) => {
    const widths = (t.colWidthsPt || []).map((w) => (w == null ? '?' : w)).join(', ');
    console.log(`  table ${i + 1}: ${t.rows} rows x ${t.columns} cols — widths (pt): ${widths || '(none reported)'}`);
  });
  const allWidths = s.tables.flatMap((t) => t.colWidthsPt || []).filter((w) => w != null);
  const distinct = new Set(allWidths).size;
  const widthCheck = exact(EXPECTED.distinctColWidths, distinct);
  console.log(`\n  distinct widths reported: ${distinct} (fixture has ${EXPECTED.distinctColWidths})`);
  console.log(`  every distinct width preserved: ${verdict(widthCheck.ok)}`);
  if (!widthCheck.ok) {
    // The failure that matters is EQUALIZATION — the converter throwing the grid
    // away and giving every column the same width. Distinguish that from a
    // rounding difference, which is harmless, because they look the same in a count.
    console.log(
      distinct <= 1
        ? '    EQUALIZED — the converter discarded the column grid. A tenant matrix cannot rely on column widths.'
        : `    ${distinct} of ${EXPECTED.distinctColWidths} widths distinct — the grid survived but not exactly; compare the per-table rows above.`
    );
  }

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
