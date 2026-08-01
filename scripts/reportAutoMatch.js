'use strict';

// AUTO-MATCH REPORT — what the matcher achieves against a real template.
//
// Two modes.
//
//   node scripts/reportAutoMatch.js --template <id> --asset <id>
//       Runs against THIS DATABASE: the tenant's stored template markers and the
//       asset's real copy fields. This is the number that means something. Run it
//       in the Railway console (plain node, never `railway run`).
//
//   node scripts/reportAutoMatch.js
//       Runs against test/fixtures/formConfirmationMatrix.json — a RECONSTRUCTED
//       33-marker matrix, not anybody's real document. Needs no database.
//
// WHY THE FIXTURE EXISTS AND WHAT IT IS NOT. The real template lives in the
// production database, which the build environment cannot reach. A hit rate
// quoted from a document I invented is not evidence about a document I have
// never seen, so the fixture is not offered as one. It is a CALIBRATION: it is
// built to contain the cases that are actually hard (a section-qualified marker
// competing for one field, metadata markers no writer drafts, a marker whose
// field does not exist) so the matcher's behaviour on those cases is visible.
// The fixture is deliberately not tuned to flatter the matcher — see its header.

const path = require('path');
const { matchMarkersToFields } = require('../src/destinations/markerMatch');

const FIXTURE = path.join(__dirname, '..', 'test', 'fixtures', 'formConfirmationMatrix.json');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}

const line = (s) => console.log('\n' + '='.repeat(78) + '\n' + s + '\n' + '='.repeat(78));

// Markers a writer does not draft. Reported as a SEPARATE bucket rather than
// counted as misses — see the report at the bottom for why this is presentation
// only and not a stored state.
const METADATA_HINT = /\b(id|code|url|owner|updated|locale|version|status|date|link|slug)\b/i;

function report(label, markers, fields, note) {
  const r = matchMarkersToFields(markers, fields);

  line(label);
  if (note) console.log(note + '\n');
  console.log(`  ${r.counts.markers} marker(s) in the template, ${r.counts.fields} copy field(s) on the asset`);

  console.log('\n  MATCHED — auto-mapped, for a human to confirm:');
  if (!r.matched.length) console.log('    (none)');
  for (const m of r.matched) {
    console.log(`    {{${m.markerName}}}`.padEnd(42) + `-> ${m.fieldName}   [${m.how}]`);
  }

  console.log('\n  CONTESTED — deliberately NOT matched, a human decides:');
  if (!r.contested.length) console.log('    (none)');
  for (const c of r.contested) {
    const subject = c.marker ? `{{${c.marker}}}` : `field "${c.field}"`;
    console.log(`    ${subject} — ${c.reason}`);
    console.log(`      candidates: ${c.candidates.join(', ')}`);
  }

  const meta = r.unmatchedMarkers.filter((m) => METADATA_HINT.test(m.name));
  const copyish = r.unmatchedMarkers.filter((m) => !METADATA_HINT.test(m.name));

  console.log('\n  UNMATCHED MARKERS that look like METADATA (no writer drafts these):');
  console.log(meta.length ? meta.map((m) => `    {{${m.name}}}`).join('\n') : '    (none)');

  console.log('\n  UNMATCHED MARKERS that look like COPY (a real miss, or a field the asset lacks):');
  console.log(copyish.length ? copyish.map((m) => `    {{${m.name}}}`).join('\n') : '    (none)');

  console.log('\n  UNMATCHED FIELDS (a writer drafts these; the template has nowhere to put them):');
  console.log(
    r.unmatchedFields.length ? r.unmatchedFields.map((f) => `    ${f.field_name}`).join('\n') : '    (none)'
  );

  console.log('\n  ' + '-'.repeat(74));
  console.log(`  HIT RATE (fields placed):    ${r.counts.matched}/${r.counts.fields} = ${r.counts.hitRate}%`);
  console.log(`  MARKER COVERAGE:             ${r.counts.matched}/${r.counts.markers} = ${r.counts.markerCoverage}%`);
  console.log(`  of the ${r.counts.unmatchedMarkers} unmatched markers, ${meta.length} look like metadata and ${copyish.length} like copy`);
  console.log(`  contested (left for a human): ${r.counts.contested}`);
  console.log(
    `\n  Read the hit rate, not the coverage: a matrix carries cells no writer fills.\n` +
      `  Every unmatched thing above is VISIBLE in the settings panel — nothing here is silent.`
  );
  return r;
}

(async () => {
  const templateId = arg('--template');
  const assetId = arg('--asset');

  if (templateId && assetId) {
    const { getDocTemplate } = require('../src/db/docTemplates');
    const { getTenantLibrary } = require('../src/db/assets');
    const tenantId = arg('--tenant') || process.env.TENANT_ID;
    if (!tenantId) {
      console.error('Pass --tenant <id> (or set TENANT_ID). Both reads are tenant-scoped by design.');
      process.exit(1);
    }
    const tpl = await getDocTemplate(tenantId, templateId);
    if (!tpl) {
      console.error(`No template ${templateId} for tenant ${tenantId}.`);
      process.exit(1);
    }
    const lib = await getTenantLibrary(tenantId);
    const asset = (lib || []).find((a) => String(a.id) === String(assetId));
    if (!asset) {
      console.error(`No asset ${assetId} for tenant ${tenantId}.`);
      process.exit(1);
    }
    report(
      `REAL TEMPLATE — "${tpl.name}" against asset "${asset.name}"`,
      tpl.placeholders,
      asset.fields,
      '  This is the real stored template and the real asset. These numbers count.'
    );
    process.exit(0);
  }

  const fx = require(FIXTURE);
  report(
    `RECONSTRUCTED ${fx.markers.length}-MARKER MATRIX — a calibration, NOT a real tenant document`,
    fx.markers,
    fx.fields,
    '  NOT the tenant\'s template. The real one is in the production database, which\n' +
      '  this environment cannot reach. Run with --template <id> --asset <id> --tenant <id>\n' +
      '  in the Railway console for the number that actually describes their document.'
  );
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
