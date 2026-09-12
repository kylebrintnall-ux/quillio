'use strict';

// Read-only diagnostic: print what a project's field_manifest ACTUALLY RECORDED,
// with the v1/v2 distinction and the three provenance states made explicit.
//
// Usage (in the Railway console):
//   node scripts/queryFieldManifest.js            newest project, any tenant
//   node scripts/queryFieldManifest.js 412        that project id
//   node scripts/queryFieldManifest.js T0B8LPRDKHR  newest for that tenant
//
// Requires DATABASE_URL. Reads only — never writes. Sibling of queryProjects.js.
//
// WHY THIS EXISTS RATHER THAN A PASTED ONE-LINER. The question it answers has
// three possible answers that look alike in raw JSONB, and two of them are
// failures that read as success:
//
//   version 1                     the deploy did not take. Old code.
//   version 2, provenance ABSENT  buildFieldManifest ran, but createDocument
//                                 returned no fieldProvenance — the googleDocs
//                                 half did not land. A v2 row that records no
//                                 claim, which is NOT the same as a document
//                                 that claimed nothing.
//   version 2, provenance PRESENT full v2. '' on a field is a RECORDED ABSENCE.
//
// Reading "not recorded" as "claimed nothing" is the one misreading that turns
// this record into a false one, so the two are never printed the same way.

const ARG = process.argv[2] || null;
const BY_ID = ARG && /^\d+$/.test(ARG);

function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// Pure, so it is testable without a database — see --selftest below.
function report(project) {
  const out = [];
  const say = (s) => out.push(s);
  if (!project) return ['[manifest] no project row found.'];

  say(`project ${project.id} — ${project.campaign_title || '(untitled)'}`);
  say(`  tenant ${project.tenant_id}   created ${project.created_at}`);
  say(`  copy doc ${project.copy_doc_id || '(none)'}`);

  const m = project.field_manifest;
  if (m == null) {
    say('  field_manifest: NULL — meaning UNKNOWN. generateDoc caught an error');
    say('    building it; the document itself was still created. Check the logs');
    say('    for "[pipeline] field manifest SKIPPED".');
    return out;
  }
  const fields = Array.isArray(m.fields) ? m.fields : [];
  say(`  field_manifest: version ${m.version}   writtenAt ${m.writtenAt}   ${fields.length} field(s)`);

  if (m.version !== 2) {
    say('  *** VERSION 1 — the v2 code is not what built this row. ***');
    say('      Either the deploy had not landed when this brief ran, or the');
    say('      service is not running the commit you think it is. Check /health.');
    return out;
  }

  const has = (f) => Object.prototype.hasOwnProperty.call(f, 'provenance');
  const reported = fields.filter(has).length;
  if (reported === 0) {
    say('  *** provenance key ABSENT on every field — NOT RECORDED. ***');
    say('      buildFieldManifest ran at v2 but createDocument returned no');
    say('      fieldProvenance. This is not "the document claimed nothing".');
  } else if (reported !== fields.length) {
    say(`  *** provenance present on ${reported} of ${fields.length} — partial, which`);
    say('      buildFieldManifest cannot produce. Investigate.');
  }

  const cited = fields.filter((f) => f.specSource && f.specSource !== 'quillio_default');
  const withSentence = fields.filter((f) => has(f) && f.provenance);
  const recordedAbsence = fields.filter((f) => has(f) && f.provenance === '');
  const dated = fields.filter((f) => f.specVerifiedAt);

  say('');
  say(`  cited to a real page      ${cited.length}`);
  say(`  carrying specVerifiedAt   ${dated.length}`);
  say(`  provenance non-empty      ${withSentence.length}`);
  say(`  provenance '' (recorded absence) ${recordedAbsence.length}`);

  const tiers = {};
  for (const f of fields) tiers[String(f.specType)] = (tiers[String(f.specType)] || 0) + 1;
  say(`  specType breakdown        ${JSON.stringify(tiers)}`);

  // The fields worth reading: the ones making a claim, then one that withholds.
  say('');
  say('  --- fields that recorded a sentence ---');
  for (const f of withSentence.slice(0, 8)) {
    say(`  ${f.assetType} / ${f.fieldName}`);
    say(`      specType ${f.specType}  specVerifiedAt ${f.specVerifiedAt}`);
    say(`      specSource ${f.specSource}`);
    say(`      provenance "${f.provenance}"`);
  }
  if (withSentence.length > 8) say(`  … and ${withSentence.length - 8} more`);
  if (withSentence.length === 0) say('  (none — see the counts above)');

  // A dated field whose line withheld the sentence is the collapse working.
  const withheld = fields.filter((f) => has(f) && f.specVerifiedAt && !/\d{4}-\d{2}-\d{2}/.test(f.provenance || ''));
  say('');
  say(`  --- dated fields whose own line WITHHELD the sentence (${withheld.length}) ---`);
  say('  A collapsed provenance run, or a tier line naming no source. Expected,');
  say('  and the whole reason the sentence is reported rather than recomputed.');
  for (const f of withheld.slice(0, 4)) {
    say(`  ${f.assetType} / ${f.fieldName}  ->  "${f.provenance}"`);
  }
  return out;
}

function selftest() {
  const base = { id: 1, tenant_id: 'T', created_at: 'now', campaign_title: 'X', copy_doc_id: 'd' };
  const cases = [
    ['NULL manifest', { ...base, field_manifest: null }, /NULL — meaning UNKNOWN/],
    ['v1', { ...base, field_manifest: { version: 1, writtenAt: 'w', fields: [{}] } }, /VERSION 1/],
    ['v2 no provenance key', {
      ...base,
      field_manifest: { version: 2, writtenAt: 'w', fields: [{ specType: 'recommended', specSource: 'u', specVerifiedAt: '2026-08-20' }] },
    }, /provenance key ABSENT/],
    ['v2 full', {
      ...base,
      field_manifest: {
        version: 2, writtenAt: 'w',
        fields: [
          { assetType: 'A', fieldName: 'F', specType: 'recommended', specSource: 'https://x', specVerifiedAt: '2026-08-20', provenance: 'Recommended by Meta. Read against Meta\'s spec page on 2026-08-20.' },
          { assetType: 'A', fieldName: 'G', specType: 'recommended', specSource: 'https://x', specVerifiedAt: '2026-08-20', provenance: 'Recommended by Meta.' },
          { assetType: 'A', fieldName: 'H', specType: null, specSource: null, specVerifiedAt: null, provenance: '' },
        ],
      },
      // THE FULL-v2 CASE ASSERTS THE ABSENCE OF THE TWO WARNINGS, not a count.
      // A count here was the first version of this assertion and it was WRONG —
      // it expected 1 non-empty provenance where the fixture has 2, because a
      // collapsed member's truncated attribution is still non-empty. Wrong in a
      // way that looked like a result, which is the failure this whole script is
      // written to make impossible to have about production data.
    }, /^(?!.*(?:VERSION 1|provenance key ABSENT|partial)).*field_manifest: version 2/s],
  ];
  let ok = true;
  for (const [name, row, expect] of cases) {
    const text = report(row).join('\n');
    const pass = expect.test(text);
    if (!pass) ok = false;
    console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}`);
    if (!pass) console.log(text);
  }
  // The v2-full case must ALSO show the withheld field and the recorded absence.
  const full = report(cases[3][1]).join('\n');
  for (const [label, re] of [
    ['withheld line listed', /A \/ G  ->  "Recommended by Meta\."/],
    ['recorded absence counted', /provenance '' \(recorded absence\) 1/],
    ['withheld section counts 1', /WITHHELD the sentence \(1\)/],
  ]) {
    const pass = re.test(full);
    if (!pass) ok = false;
    console.log(`${pass ? 'ok  ' : 'FAIL'}  ${label}`);
  }
  console.log(ok ? '\nselftest PASSED' : '\nselftest FAILED');
  process.exit(ok ? 0 : 1);
}

async function main() {
  if (process.argv.includes('--selftest')) return selftest();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[manifest] DATABASE_URL is not set in this environment.');
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[manifest] could not load "pg": ' + err.message);
    process.exit(1);
  }
  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  const cols = 'id, tenant_id, campaign_title, created_at, copy_doc_id, field_manifest';
  try {
    await client.connect();
    let res;
    if (BY_ID) {
      res = await client.query(`SELECT ${cols} FROM projects WHERE id = $1`, [Number(ARG)]);
    } else if (ARG) {
      res = await client.query(`SELECT ${cols} FROM projects WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1`, [ARG]);
    } else {
      res = await client.query(`SELECT ${cols} FROM projects ORDER BY id DESC LIMIT 1`);
    }
    console.log(report(res.rows[0]).join('\n'));
  } catch (err) {
    console.error('[manifest] query failed: ' + err.message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main();

module.exports = { report };
