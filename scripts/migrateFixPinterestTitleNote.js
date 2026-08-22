'use strict';

// August 2026 — reword Pinterest Pin / Title's spec_note from a STATEMENT into
// an INSTRUCTION, on rows already in the database.
//
//   old: "Only the first 40 characters typically show in feeds."
//   new: "Front-load the first 40 characters — that is typically all that shows in feeds."
//
// ─── WHY A SEPARATE MIGRATION AT ALL ────────────────────────────────────────
// scripts/migrateAddPinterestSpecs.js has already run against both tenants, and
// its per-tenant path is `insertForTenant` → 'exists' → skip. So changing the
// constant in that file (and in src/data/defaultAssets.js, which it stays
// byte-identical to) fixes what a NEW tenant is seeded with and moves nothing
// that is already stored. Re-running it writes no copy_fields row.
//
// ─── WHY THE WORDING CHANGED ────────────────────────────────────────────────
// The note reaches the drafting prompt. That is measured rather than assumed:
// the composed hint is recovered by parseDoc into `field.notes`
// (destinations/googleDocs.js), carried by `assetTargets` and rendered by
// gemini.fieldGuidanceFor into the `guidance:` clause of the field's line in the
// batch prompt —
//
//   - "Title" — character limit 100 — stay within this limit; guidance: Only the
//     first 40 characters typically show in feeds. Platform limit (Pinterest).
//     Stay within this count.
//
// — so the model was told 100 as a hard rule twice (the field line, and the
// PROMPT HIERARCHY's "Character limits = HARD constraints that ALWAYS win") and
// told the 40 as a fact about Pinterest's rendering that asks for nothing. A run
// produced a 45-character title, which obeys the 100 and ignores the 40.
// EMAIL_SUBJECT_NOTE's "front-load the first 40" is the shape that instructs.
//
// ─── WHAT THIS IS NOT ───────────────────────────────────────────────────────
// NOT a spec correction. char_max stays 100, spec_type stays 'enforced',
// spec_source stays the help-centre page and spec_verified_at is NOT touched —
// no number moved, so no page needs re-fetching under CLAUDE.md's fetch rule and
// no human re-verified anything. The claim is the one the page already supports
// ("Depending on the device, the first 40 characters may show in people's
// feeds", quoted in migrateAddPinterestSpecs.js's header); only its grammar is
// different. Stamping spec_verified_at here would assert a verification event
// that did not happen.
//
// ─── THE VALUE GUARD ────────────────────────────────────────────────────────
// The UPDATE matches on the OLD STRING EXACTLY, per CLAUDE.md's house rule for
// any migration that writes a spec value (scripts/migrateFixLinkedInIntroText.js
// is the shape). A row holding anything else — a tenant's own wording, or a
// value some later migration moved — is left alone and reported, not rewritten.
//
// OVERRIDES ARE NOT TOUCHED, and that is the override columns working rather
// than an omission: this writes the BASE spec_note, and a tenant holding
// spec_note_override keeps their own wording. getTenantAssets resolves
// COALESCE(spec_note_override, spec_note), so their document does not change.
// The count of such rows is reported so the number of tenants who will NOT see
// this is visible rather than silent.
//
// Usage:
//   node scripts/migrateFixPinterestTitleNote.js            # dry run (default)
//   node scripts/migrateFixPinterestTitleNote.js --commit   # write
//
// Run in the Railway console as plain node — never `railway run`.

const TAG = '[pinterest-title-note]';
const COMMIT = process.argv.includes('--commit');

const ASSET = 'Pinterest Pin';
const FIELD = 'Title';

// BYTE-IDENTICAL to the constants this moves between. OLD is what
// migrateAddPinterestSpecs.js seeded; NEW is what it and
// src/data/defaultAssets.js PINTEREST_TITLE_NOTE now both hold. A smoke test
// asserts NEW against both, so a future reword cannot land in one file only.
const OLD_NOTE = 'Only the first 40 characters typically show in feeds.';
const NEW_NOTE = 'Front-load the first 40 characters — that is typically all that shows in feeds.';

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(`${TAG} DATABASE_URL is not set.`);
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error(`${TAG} could not load "pg": ${err.message}`);
    process.exit(1);
  }

  const client = new Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();
  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  try {
    await client.query('BEGIN');

    // WHAT IS THERE NOW, before touching anything — every Title row across every
    // tenant, whatever it holds, so a row that is neither OLD nor NEW is visible
    // rather than merely unmatched by the UPDATE below.
    const before = await client.query(
      `SELECT at.tenant_id, cf.spec_note, cf.spec_note_override
         FROM copy_fields cf
         JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE at.name = $1 AND cf.field_name = $2
        ORDER BY at.tenant_id`,
      [ASSET, FIELD]
    );
    console.log(`\n${TAG} ${before.rowCount} ${ASSET} / ${FIELD} row(s) across all tenants:`);
    for (const r of before.rows) {
      const state = r.spec_note === OLD_NOTE ? 'OLD  ' : r.spec_note === NEW_NOTE ? 'NEW  ' : 'OTHER';
      console.log(`    ${String(r.tenant_id).padEnd(14)} ${state} ${JSON.stringify(r.spec_note)}`);
      if (r.spec_note_override !== null) {
        console.log(`        override present: ${JSON.stringify(r.spec_note_override)}` +
          '  <- this tenant keeps their own wording; the base write below does not reach their doc');
      }
    }

    const holdingOld = before.rows.filter((r) => r.spec_note === OLD_NOTE).length;
    const holdingNew = before.rows.filter((r) => r.spec_note === NEW_NOTE).length;
    const holdingOther = before.rowCount - holdingOld - holdingNew;
    const overridden = before.rows.filter((r) => r.spec_note_override !== null).length;

    // THE WRITE. Guarded on the exact old value, so it is idempotent (a second
    // run matches nothing) and cannot take back a row something else moved.
    const upd = await client.query(
      `UPDATE copy_fields cf
          SET spec_note = $3
         FROM asset_types at
        WHERE at.id = cf.asset_type_id
          AND at.name = $1
          AND cf.field_name = $2
          AND cf.spec_note = $4
        RETURNING at.tenant_id`,
      [ASSET, FIELD, NEW_NOTE, OLD_NOTE]
    );

    console.log(`\n${TAG} rows changed: ${upd.rowCount} (expected ${holdingOld})`);
    for (const r of upd.rows) console.log(`    ${r.tenant_id}`);
    if (upd.rowCount !== holdingOld) {
      throw new Error(
        `matched ${holdingOld} row(s) holding the old note but updated ${upd.rowCount}. ` +
        'Nothing written.'
      );
    }
    if (holdingNew > 0) console.log(`${TAG} ${holdingNew} row(s) already held the new note — left alone (idempotent).`);
    if (holdingOther > 0) {
      console.log(`${TAG} ${holdingOther} row(s) hold NEITHER wording and were NOT rewritten — listed above as OTHER.`);
    }
    if (overridden > 0) {
      console.log(`${TAG} ${overridden} row(s) carry a spec_note_override: those tenants keep their own`);
      console.log(`${TAG}   wording and this change does not reach their documents. That is the override`);
      console.log(`${TAG}   columns working as designed, not a row this run failed to reach.`);
    }

    // Read the outcome back rather than trusting the rowCount.
    const after = await client.query(
      `SELECT cf.spec_note, COUNT(*)::int AS rows
         FROM copy_fields cf
         JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE at.name = $1 AND cf.field_name = $2
        GROUP BY 1 ORDER BY 2 DESC`,
      [ASSET, FIELD]
    );
    console.log(`\n${TAG} ${ASSET} / ${FIELD} spec_note as stored, after:`);
    for (const r of after.rows) console.log(`    x${r.rows}  ${JSON.stringify(r.spec_note)}`);

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n${TAG} COMMITTED.`);
      console.log(`${TAG} No spec value moved, so nothing needs re-detecting and no watch row changed.`);
      console.log(`${TAG} Documents already built keep the old sentence — a document is a file.`);
    } else {
      await client.query('ROLLBACK');
      console.log(`\n${TAG} DRY RUN — rolled back. Pass --commit to write.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\n${TAG} FAILED (rolled back): ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

module.exports = { OLD_NOTE, NEW_NOTE, ASSET, FIELD };

if (require.main === module) main();
