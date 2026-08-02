'use strict';

// BUILD AND DRAFT ONE DOCUMENT TEMPLATE, end to end (document templates, rework
// step two).
//
// This is the only entry point to the confirmed-template build path. parseBrief
// does not know templates exist yet — that is step four — so a brief cannot
// reach here. A human hands over a template id it already has.
//
//   node scripts/buildTemplateDoc.js --tenant <id> --template <id> \
//        [--title "Spring Launch"] [--summary "..."] [--prompt "..."] \
//        [--folder <driveFolderId>] [--dry]
//
// --dry does everything EXCEPT copying and writing: it reads the confirmed
// markers, prints exactly which cells would be written and which are left as
// metadata, and stops. Useful for checking a template's confirm state without
// putting a file in Drive.
//
// Needs the database (for the template and its confirmed markers), Google
// credentials (to copy and write), and GEMINI_API_KEY (to draft). Run it in the
// Railway console as plain node — never `railway run`.
//
// It prints the DOC LINK at the end. That link is the point: the structural
// result is checkable from the report, but whether the copy is any good is a
// human judgement made by opening the document.

const { getClients } = require('../src/google');
const { getDocTemplate } = require('../src/db/docTemplates');
const { listTemplateMarkers } = require('../src/db/templateMarkers');
const pipeline = require('../src/core/pipeline');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY = process.argv.includes('--dry');
const line = (s) => console.log('\n' + '='.repeat(78) + '\n' + s + '\n' + '='.repeat(78));
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

(async () => {
  const tenantId = arg('--tenant') || process.env.TENANT_ID;
  const templateId = arg('--template');
  if (!tenantId || !templateId) {
    console.error('Usage: node scripts/buildTemplateDoc.js --tenant <id> --template <id> [--title "…"] [--dry]');
    process.exit(1);
  }

  const template = await getDocTemplate(tenantId, templateId);
  if (!template) {
    console.error(`No template ${templateId} for tenant ${tenantId}.`);
    process.exit(1);
  }
  const markers = await listTemplateMarkers(tenantId, templateId);
  if (markers === null) {
    console.error('template_markers is not available. Run scripts/migrateAddTemplateMarkers.js --commit first.');
    process.exit(1);
  }

  const copy = markers.filter((m) => m.is_copy);
  const meta = markers.filter((m) => !m.is_copy);
  const placeable = copy.filter((m) => m.part != null && m.table_index != null && m.row_index != null && m.column_index != null);

  line(`TEMPLATE "${template.name}" — what is confirmed`);
  console.log(`  ${markers.length} marker(s): ${copy.length} copy, ${meta.length} metadata`);
  console.log(`  of the copy markers, ${placeable.length} have a cell coordinate and ${copy.length - placeable.length} do not\n`);
  console.log('  ' + pad('MARKER', 30) + pad('COPY?', 7) + pad('LIMIT', 12) + 'CELL');
  console.log('  ' + '-'.repeat(84));
  for (const m of markers) {
    const cell = m.part == null || m.table_index == null
      ? '(no coordinate)'
      : `${m.part} table ${m.table_index + 1}, row ${m.row_index + 1}, col ${m.column_index + 1}` +
        (m.row_span > 1 || m.column_span > 1 ? ` (merged ${m.row_span}x${m.column_span})` : '');
    console.log(
      '  ' + pad(`{{${m.marker_name}}}`, 30) + pad(m.is_copy ? 'draft' : 'LEAVE', 7) +
        pad(m.char_max > 0 ? `${m.char_max} ${m.field_type === 'words' ? 'words' : 'chars'}` : '(none)', 12) + cell
    );
  }

  if (DRY) {
    console.log(`\n  --dry: nothing was copied, drafted or written.`);
    console.log(`  A real run would draft ${copy.length} marker(s) and leave ${meta.length} showing.`);
    process.exit(0);
  }

  line('BUILDING');
  const clients = await getClients();
  const result = await pipeline.buildTemplateDocument({
    tenantId,
    templateId,
    clients,
    folderId: arg('--folder'),
    spec: {
      campaignTitle: arg('--title', 'Template test build'),
      summary: arg('--summary', 'A test build of this template, to check the copy lands in the right cells.'),
      writerPrompt: arg('--prompt', 'Write in the brand voice. Keep every field inside its limit.'),
    },
  });

  line('RESULT');
  console.log(`  copied to:  ${result.title}`);
  // The one line that accounts for every copy marker. A marker that was placed
  // but drafted nothing looks identical in the document to one that was never
  // meant to be written — reporting only the unplaced ones hid that.
  console.log(`\n  ${result.summary}.`);
  if (!result.accounted) console.log('  (WARNING: those counts do not add up to the copy-marker total)');
  console.log(`  plus ${result.markers - result.copyMarkers} metadata marker(s), never touched — still {{showing}}.`);

  if (result.written.length) console.log(`\n  DRAFTED (${result.written.length}):\n    ${result.written.join(', ')}`);
  if (result.skipped.length) {
    console.log(`\n  LEFT AS {{marker}} (${result.skipped.length}) — the cell was found, but the draft came back empty:`);
    console.log(`    ${result.skipped.join(', ')}`);
    console.log(`    These are worth a look: the field was ticked as copy, so somebody expected words.`);
  }

  if (result.healed.length) {
    console.log(`\n  FOUND BY LABEL after a document edit (${result.healed.length}):`);
    for (const h of result.healed) console.log(`    {{${h.name}}} — ${h.reason}`);
  }
  if (result.missing.length) {
    console.log(`\n  UNPLACED (${result.missing.length}) — reported rather than written to a guessed cell:`);
    for (const m of result.missing) console.log(`    {{${m.name}}} — ${m.reason}`);
  }

  line('OPEN IT');
  console.log(`  ${result.docUrl}`);
  console.log(`\n  What to check by eye: every drafted cell holds copy and nothing else;`);
  console.log(`  every metadata cell still reads {{Marker}}; and the table structure —`);
  console.log(`  column widths, merges, shading — is exactly the template's.`);
  process.exit(0);
})().catch((err) => {
  console.error('\nFAILED:', err && err.message ? err.message : err);
  console.error('\nThis needs DATABASE_URL, Google credentials (GOOGLE_SERVICE_ACCOUNT_JSON, or');
  console.error('GOOGLE_CLIENT_ID/SECRET + GOOGLE_REFRESH_TOKEN) and GEMINI_API_KEY.');
  process.exit(1);
});
