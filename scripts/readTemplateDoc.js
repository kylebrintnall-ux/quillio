'use strict';

// READ A BUILT TEMPLATE DOCUMENT BACK — and optionally revise a cell or review it
// (document templates, rework step three).
//
// Step two built the document. This reads it back through the SAME stored
// coordinates, which is the point: the marker text has been replaced by copy, so
// if the coordinate still finds the cell then "the position IS the mapping" has
// stopped being a design claim and become an observation.
//
//   node scripts/readTemplateDoc.js --doc <docId> --template <id> --tenant <id>
//   node scripts/readTemplateDoc.js --doc <docId> --template <id> --tenant <id> \
//        --regenerate "Form Headline[,Another Field]" [--direction "shorter"]
//   node scripts/readTemplateDoc.js --doc <docId> --template <id> --tenant <id> --review
//
// PLAIN READ IS THE DEFAULT AND WRITES NOTHING. No flag, no change: it prints
// every located cell and stops. --regenerate and --review are the only two
// things here that touch the document, and each says what it did.
//
// --doc is the BUILT document — the copy in the campaign folder — not the source
// template. Pointing it at the source would read markers that were never
// replaced and, with --regenerate, would write copy into the template every
// future build is copied from.
//
// Needs the database (template + confirmed markers) and Google credentials.
// --regenerate additionally needs GEMINI_API_KEY. Run it in the Railway console
// as plain node — never `railway run`.

const { getClients } = require('../src/google');
const pipeline = require('../src/core/pipeline');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const has = (name) => process.argv.includes(name);
const line = (s) => console.log('\n' + '='.repeat(78) + '\n' + s + '\n' + '='.repeat(78));
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
// Cell text is one line in the report; a 120-word body would bury everything else.
const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
};
const lengthOf = (row) =>
  row.field_type === 'words'
    ? `${row.text.trim() ? row.text.trim().split(/\s+/).length : 0}w`
    : `${row.text.length}c`;

(async () => {
  const tenantId = arg('--tenant') || process.env.TENANT_ID;
  const templateId = arg('--template');
  const docId = arg('--doc');
  if (!tenantId || !templateId || !docId) {
    console.error('Usage: node scripts/readTemplateDoc.js --doc <docId> --template <id> --tenant <id> [--regenerate "Field[,Field]"] [--direction "…"] [--review]');
    process.exit(1);
  }
  const regenerate = arg('--regenerate');
  const review = has('--review');
  const clients = await getClients();

  // --- always: read back -----------------------------------------------------
  const read = await pipeline.readTemplateDocument({ tenantId, templateId, docId, clients });

  line(`"${read.title || docId}" — template "${read.templateName}"`);
  console.log(`  ${read.summary}\n`);
  console.log('  ' + pad('MARKER', 26) + pad('COPY?', 7) + pad('LIMIT', 11) + pad('NOW', 7) + 'CELL HOLDS');
  console.log('  ' + '-'.repeat(110));
  for (const r of read.rows) {
    const limit = r.char_max > 0 ? `${r.char_max}${r.field_type === 'words' ? 'w' : 'c'}` : '(none)';
    // The three states a cell can be in, named rather than left to be inferred
    // from an empty column: a marker still standing, an empty cell, or copy.
    const holds = r.showingMarker ? `{{marker}} still standing` : r.empty ? '(empty)' : clip(r.text, 60);
    console.log(
      '  ' + pad(r.marker_name, 26) + pad(r.is_copy ? 'copy' : 'LEAVE', 7) +
        pad(limit, 11) + pad(lengthOf(r), 7) + holds
    );
  }
  if (read.rows.some((r) => r.healed)) {
    console.log('\n  FOUND BY LABEL after a document edit:');
    for (const r of read.rows.filter((x) => x.healed)) console.log(`    ${r.marker_name} — ${r.healedReason}`);
  }
  if (read.missing.length) {
    console.log(`\n  UNPLACED (${read.missing.length}) — reported rather than guessed at:`);
    for (const m of read.missing) console.log(`    {{${m.name}}} — ${m.reason}`);
  }

  if (!regenerate && !review) {
    console.log('\n  Read only — nothing was written. Add --regenerate "Field" or --review to act.');
    process.exit(0);
  }

  // --- --regenerate ----------------------------------------------------------
  if (regenerate) {
    const names = regenerate.split(',').map((s) => s.trim()).filter(Boolean);
    line(`REGENERATING ${names.length} field(s)`);
    const out = await pipeline.regenerateTemplateFields({
      tenantId,
      templateId,
      docId,
      clients,
      fieldNames: names,
      direction: arg('--direction', ''),
      spec: {
        summary: arg('--summary', ''),
        writerPrompt: arg('--prompt', ''),
      },
    });

    console.log(`  ${out.summary || 'nothing to do'}.\n`);
    for (const r of out.regenerated) {
      console.log(`  ${r.name}`);
      console.log(`    was: ${clip(r.before, 90)}`);
      console.log(`    now: ${clip(r.after, 90)}`);
    }
    // A refusal is the interesting output, not an error: it is the is_copy flag
    // and the stored coordinate doing exactly what they exist to do.
    if (out.refused.length) {
      console.log(`\n  REFUSED (${out.refused.length}) — nothing was written to these:`);
      for (const r of out.refused) console.log(`    ${r.name} — ${r.reason}`);
    }
    if (out.failed.length) {
      console.log(`\n  FAILED (${out.failed.length}) — the cell is unchanged:`);
      for (const r of out.failed) console.log(`    ${r.name} — ${r.reason}`);
    }
    if (out.unenforced && out.unenforced.length) {
      console.log(`\n  OVER LIMIT (${out.unenforced.length}) — written, but nothing shortened it:`);
      console.log(`    ${out.unenforced.join(', ')}`);
    }
    console.log('\n  One cell holds one answer — this replaced the copy, it did not stack options below it.');
  }

  // --- --review --------------------------------------------------------------
  if (review) {
    line('REVIEW');
    // Re-read when a regenerate just ran, so the review judges what is in the
    // document now rather than what was there before the rewrite.
    const out = await pipeline.reviewTemplateDocument({ tenantId, templateId, docId, clients });
    if (out.notes.length === 0) {
      console.log('  Nothing measurably wrong: every copy cell holds copy, and every one is inside its limit.');
      console.log('  (This pass only counts. Whether the copy is any GOOD is not a question it asks.)');
    } else {
      console.log(`  ${out.notes.length} note(s): ${out.posted.length} posted, ${out.duplicates.length} already live, ${out.failed.length} failed\n`);
      for (const n of out.notes) console.log(`    ${n.text}`);
      console.log('\n  These are UNANCHORED comments — a Drive comment cannot anchor inside a table');
      console.log('  cell, so each one names its field instead. Find the row by the Field column.');
    }
  }

  line('OPEN IT');
  console.log(`  https://docs.google.com/document/d/${docId}/edit`);
  process.exit(0);
})().catch((err) => {
  console.error('\nFAILED:', err && err.message ? err.message : err);
  console.error('\nThis needs DATABASE_URL and Google credentials (GOOGLE_SERVICE_ACCOUNT_JSON, or');
  console.error('GOOGLE_CLIENT_ID/SECRET + GOOGLE_REFRESH_TOKEN). --regenerate also needs GEMINI_API_KEY.');
  process.exit(1);
});
