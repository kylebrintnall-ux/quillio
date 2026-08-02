'use strict';

// WHAT THE STRUCTURAL READ ACHIEVES ON A REAL TEMPLATE.
//
// Two modes.
//
//   node scripts/reportTemplateRead.js --template <id> --tenant <id>
//       Reads THIS TENANT'S stored template out of the database, fetches its
//       imported Google Doc, and reports what the reader proposes for every
//       marker: field name, limit, is-copy, and WHICH PATH produced each value.
//       This is the number that means something. Run it in the Railway console
//       (plain node, never `railway run`). Needs Google credentials.
//
//   node scripts/reportTemplateRead.js
//       Runs against test/fixtures/formConfirmationMatrixDoc.json — a
//       RECONSTRUCTED matrix in Docs API shape, not anybody's real document.
//       Needs no database and no credentials.
//
// WHY THE FIXTURE EXISTS AND WHAT IT IS NOT. The real 33-marker template lives
// in the production database, which the build environment cannot reach. A
// derivation quoted from a document I invented is not evidence about a document
// I have never seen, so it is not offered as one. The fixture is a CALIBRATION:
// it is built to contain the cases that are actually hard — a header row that
// names its columns, a second table with NO header row, a limit written as
// "60 chars", a limit written as an em dash, a metadata row, and a marker
// outside any table — so the reader's behaviour on each is visible.

const fs = require('fs');
const path = require('path');
const { discoverPlaceholders } = require('../src/destinations/docPlaceholders');
const { deriveTemplateFields, describeRoles, tablesIn } = require('../src/destinations/templateTableReader');

const FIXTURE = path.join(__dirname, '..', 'test', 'fixtures', 'formConfirmationMatrixDoc.json');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}
const line = (s) => console.log('\n' + '='.repeat(78) + '\n' + s + '\n' + '='.repeat(78));

function report(label, doc, note) {
  const discovery = discoverPlaceholders(doc);
  const fields = deriveTemplateFields(doc, discovery.placeholders);

  line(label);
  if (note) console.log(note + '\n');

  const tables = tablesIn((doc.body && doc.body.content) || []);
  console.log(`  ${tables.length} table(s) in the body. What each header row named:`);
  tables.forEach((t, i) => {
    const roles = describeRoles(t);
    console.log(`    table ${i + 1}: ${roles || 'NOTHING — falls back to the positional read'}`);
  });

  console.log(`\n  ${fields.length} marker(s):\n`);
  const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
  console.log(
    '  ' + pad('MARKER', 26) + pad('PROPOSED FIELD NAME', 26) + pad('LIMIT', 12) + pad('COPY?', 7) + 'HOW'
  );
  console.log('  ' + '-'.repeat(94));
  for (const f of fields) {
    const limit = f.charMax > 0 ? `${f.charMax}${f.fieldType === 'words' ? ' words' : ''}` : '(none)';
    console.log(
      '  ' +
        pad(`{{${f.name}}}`, 26) +
        pad(f.label, 26) +
        pad(limit, 12) +
        pad(f.isCopy ? 'yes' : 'NO', 7) +
        `label:${f.labelSource} limit:${f.limitSource}`
    );
  }

  const byLabel = {};
  const byLimit = {};
  for (const f of fields) {
    byLabel[f.labelSource] = (byLabel[f.labelSource] || 0) + 1;
    byLimit[f.limitSource] = (byLimit[f.limitSource] || 0) + 1;
  }
  console.log('\n  ' + '-'.repeat(94));
  console.log(`  labels  : ${JSON.stringify(byLabel)}`);
  console.log(`  limits  : ${JSON.stringify(byLimit)}`);
  console.log(`  proposed as copy    : ${fields.filter((f) => f.isCopy).length}/${fields.length}`);
  console.log(`  proposed as metadata: ${fields.filter((f) => !f.isCopy).length}/${fields.length}`);
  console.log(
    `\n  READ THIS AS A PROPOSAL. "label:marker-name" means the row said nothing and the\n` +
      `  marker's own name was used; "limit:none" means no limit was found and the field is\n` +
      `  unlimited until the tenant says otherwise. Both are the confirm screen's job.`
  );

  console.log('\n  WHY EACH is-copy PROPOSAL:');
  for (const f of fields) console.log(`    ${pad(`{{${f.name}}}`, 26)} ${f.isCopy ? 'copy' : 'NOT copy'} — ${f.isCopyReason}`);
  return fields;
}

(async () => {
  const templateId = arg('--template');
  const tenantId = arg('--tenant') || process.env.TENANT_ID;

  if (templateId) {
    if (!tenantId) {
      console.error('Pass --tenant <id> (or set TENANT_ID). The read is tenant-scoped by design.');
      process.exit(1);
    }
    const { getDocTemplate } = require('../src/db/docTemplates');
    const { getClients } = require('../src/google');
    const tpl = await getDocTemplate(tenantId, templateId);
    if (!tpl) {
      console.error(`No template ${templateId} for tenant ${tenantId}.`);
      process.exit(1);
    }
    if (!tpl.source_doc_id) {
      console.error(`Template ${templateId} has no imported document to read.`);
      process.exit(1);
    }
    const clients = await getClients();
    const doc = (await clients.docs.documents.get({ documentId: tpl.source_doc_id })).data;
    report(
      `REAL TEMPLATE — "${tpl.name}" (${tpl.source_doc_id})`,
      doc,
      '  This is the tenant\'s own stored template. These numbers count.'
    );
    process.exit(0);
  }

  const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  report(
    'RECONSTRUCTED MATRIX — a calibration, NOT a real tenant document',
    doc,
    "  NOT the tenant's template. The real one is in the production database, which\n" +
      '  this environment cannot reach. Run with --template <id> --tenant <id> in the\n' +
      '  Railway console for the read that actually describes their document.'
  );
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
