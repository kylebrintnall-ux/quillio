'use strict';

// Migration — retire the dead asset types, for every tenant.
//
// The seed dropped from 30 names to 25 (src/data/defaultAssets.js), and
// config.ALLOWED_ASSETS with it. Those are source files: they fix the vocabulary
// for tenants seeded from here on. This is the other half — the rows already in
// Postgres, which no source edit reaches.
//
// WHAT AND WHY:
//   'Form Confirm Page'                      seeded. A form-and-confirmation page
//                                            is a document a tenant NAMES; a
//                                            three-field house approximation of it
//                                            competed with that name at parse time.
//   'LinkedIn Single Image Ad — Variant A–D' seeded. Four identical asset types so
//                                            a brief could ask for four versions of
//                                            one ad. Multi-instance made that a
//                                            count, and the four names stayed on as
//                                            near-duplicates for the parse to trip
//                                            over.
//   'Form and Confirmation Copy'             NOT seeded — a tenant row. The asset
//                                            that hung off a template under the
//                                            deleted attach/map design. Its fields
//                                            live in template_markers now.
//
// DEACTIVATES, NEVER DELETES, and that is not timidity — it is the rule this
// schema already follows. asset_types(id) is referenced by copy_fields,
// prompt_templates, project_assets and design_mappings, none of which declare ON
// DELETE, so Postgres REFUSES a delete the moment any child row exists. db/assets.js
// says so in as many words ("the ASSET-level removal is is_active and not a
// DELETE"), there is no DELETE FROM asset_types anywhere in the codebase, and
// is_active is what getTenantAssets filters on — so an inactive row is as absent
// from parse as a deleted one, and can be switched back on.
//
// EXISTING PROJECTS ARE UNAFFECTED. A built doc carries its own field labels and
// limits; googleDocs.generateDraft re-reads the document (parseDoc) and never
// consults the library, and copy review does not read it at all. The library is
// read at BRIEF time only. The one thing that changes for an existing project is
// that a redraft of one of these assets loses its per-asset creative direction
// line, because getAssetDirections is built from the active library.
//
// Dry run by default: applies inside a transaction, prints the resulting state,
// then ROLLBACKs. --commit writes.
//
// Idempotent — already-inactive rows are counted and skipped, so re-running is a
// no-op. Safe to run before the deploy that ships the new seed, or after.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateRetireDeadAssets.js            # dry run — no writes
//   node scripts/migrateRetireDeadAssets.js --commit   # write

const { Pool } = require('pg');

const TAG = '[retire-dead-assets]';
const COMMIT = process.argv.includes('--commit');

// Matched through quillio_normalize_name (the same normalizer the uniqueness
// indexes and tenantAssetsToSpecs use), so "Form  Confirm Page", an en dash where
// an em dash was, and case variants are all caught. Raw-text matching would miss
// exactly the duplicates that made this list worth pruning.
const RETIRE = [
  ['Form Confirm Page', 'seeded'],
  ['LinkedIn Single Image Ad — Variant A', 'seeded'],
  ['LinkedIn Single Image Ad — Variant B', 'seeded'],
  ['LinkedIn Single Image Ad — Variant C', 'seeded'],
  ['LinkedIn Single Image Ad — Variant D', 'seeded'],
  ['Form and Confirmation Copy', 'tenant-created'],
];
const NAMES = RETIRE.map(([n]) => n);

// The names that were in the seed before this change and are not in it after.
// Printed so the permissions note below can name them exactly.
const WERE_SEEDED = RETIRE.filter(([, origin]) => origin === 'seeded').map(([n]) => n);

function sslFor(url) {
  // A unix-socket connection is local by construction and never speaks SSL.
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString, ssl: sslFor(connectionString) });
  const client = await pool.connect();
  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}\n`);

  try {
    // The normalizer must exist — scripts/migrateAddAssetUniqueness.js defines it.
    // Without it this would fall back to raw-text matching and quietly miss rows,
    // which is the one failure mode worth stopping for rather than working around.
    const fn = await client.query(
      `SELECT 1 FROM pg_proc WHERE proname = 'quillio_normalize_name' LIMIT 1`
    );
    if (fn.rowCount === 0) {
      console.error(
        `${TAG} quillio_normalize_name() is not defined on this database.\n` +
          '  Run scripts/migrateAddAssetUniqueness.js first — matching on raw text\n' +
          '  would miss the spacing and dash variants this prune exists to catch.'
      );
      process.exit(1);
    }

    await client.query('BEGIN');

    // --- WHAT REFERENCES THESE ROWS, before touching anything ----------------
    // Read from information_schema rather than a hard-coded list, so a foreign key
    // added by hand-run DDL shows up here instead of being discovered by a failure.
    const fks = await client.query(
      `SELECT tc.table_name, kcu.column_name, rc.delete_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
         JOIN information_schema.referential_constraints rc
           ON rc.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND ccu.table_name = 'asset_types'
        ORDER BY tc.table_name`
    );
    console.log(`${TAG} tables referencing asset_types(id): ${fks.rows.length}`);
    for (const r of fks.rows) {
      console.log(`  ${r.table_name}.${r.column_name}  ON DELETE ${r.delete_rule}`);
    }
    console.log(
      '  ^ every one of these with NO ACTION is a reason this deactivates rather\n' +
        '    than deletes: Postgres would refuse the delete outright.'
    );

    // How many child rows each of those tables actually holds for the targeted
    // assets. Zero everywhere would mean a delete were POSSIBLE — it would still
    // not be what this script does.
    const ids = await client.query(
      `SELECT id FROM asset_types
        WHERE quillio_normalize_name(name) = ANY(
                SELECT quillio_normalize_name(n) FROM unnest($1::text[]) AS n)`,
      [NAMES]
    );
    const targetIds = ids.rows.map((r) => r.id);
    console.log(`\n${TAG} rows hanging off the ${targetIds.length} targeted asset(s):`);
    for (const r of fks.rows) {
      try {
        const c = await client.query(
          `SELECT count(*)::int AS n FROM ${r.table_name} WHERE ${r.column_name} = ANY($1::bigint[])`,
          [targetIds]
        );
        console.log(`  ${r.table_name.padEnd(20)} ${c.rows[0].n}`);
      } catch (err) {
        console.log(`  ${r.table_name.padEnd(20)} (could not count: ${err.message})`);
      }
    }

    // --- WHAT IS ABOUT TO CHANGE ---------------------------------------------
    const before = await client.query(
      `SELECT at.tenant_id, at.name, at.is_active,
              (SELECT count(*)::int FROM copy_fields cf WHERE cf.asset_type_id = at.id) AS fields
         FROM asset_types at
        WHERE quillio_normalize_name(at.name) = ANY(
                SELECT quillio_normalize_name(n) FROM unnest($1::text[]) AS n)
        ORDER BY at.tenant_id, at.name`,
      [NAMES]
    );
    console.log(`\n${TAG} matching rows: ${before.rowCount}`);
    for (const r of before.rows) {
      console.log(
        `  ${String(r.tenant_id || '(no tenant)').padEnd(14)} ${r.name.padEnd(40)} ` +
          `${r.fields} field(s)  ${r.is_active ? 'ACTIVE -> retiring' : 'already inactive — no change'}`
      );
    }
    for (const n of NAMES) {
      if (!before.rows.some((r) => r.name.toLowerCase().replace(/\s+/g, ' ').trim() === n.toLowerCase())) {
        console.log(`  (no exact-name row for "${n}" — a normalized variant may still be listed above)`);
      }
    }

    const res = await client.query(
      `UPDATE asset_types SET is_active = false
        WHERE is_active = true
          AND quillio_normalize_name(name) = ANY(
                SELECT quillio_normalize_name(n) FROM unnest($1::text[]) AS n)`,
      [NAMES]
    );
    console.log(`\n${TAG} switched off: ${res.rowCount} row(s)`);

    const remaining = await client.query(
      `SELECT tenant_id, count(*)::int AS active
         FROM asset_types WHERE is_active = true GROUP BY tenant_id ORDER BY tenant_id`
    );
    console.log(`\n${TAG} active asset types per tenant, after:`);
    for (const r of remaining.rows) {
      console.log(`  ${String(r.tenant_id || '(no tenant)').padEnd(14)} ${r.active}`);
    }

    // --- THE SIDE EFFECT WORTH SAYING OUT LOUD -------------------------------
    // db/assets.js decides "is this a bundled asset?" by testing the name against
    // the CURRENT seed (isSeededAssetName → SEEDED_NAME_SET). Bundled assets are
    // read-only in Settings apart from is_active. These five names have just left
    // the seed, so that test now answers false for them.
    console.log(
      `\n${TAG} A PERMISSIONS CHANGE COMES WITH THIS, and it is not caused by the\n` +
        '  UPDATE above — it is caused by the five names leaving the seed:\n'
    );
    for (const n of WERE_SEEDED) console.log(`    ${n}`);
    console.log(
      '\n  Settings treats a BUNDLED asset as read-only apart from its on/off\n' +
        '  toggle (db/assets.js isSeededAssetName → updateAssetType returns\n' +
        "  reason:'seeded'). Those names are no longer in the seed, so any\n" +
        '  surviving row with one of them now reads as a TENANT-CREATED asset:\n' +
        '  fully editable and renameable in Settings, where yesterday it was not.\n' +
        '  Nothing is lost by it — the rows are inactive and invisible to parse —\n' +
        '  but a tenant who switches one back on will find it editable, and that\n' +
        '  should not be a surprise six months from now.'
    );

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n${TAG} COMMITTED.`);
    } else {
      await client.query('ROLLBACK');
      console.log(`\n${TAG} ROLLED BACK (dry run) — no changes were written. Re-run with --commit to apply.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// Guarded so this file can be REQUIRED without running the migration.
// src/utils/assetMatch.js keeps a table of what replaced each of these names,
// and a smoke test reads RETIRE below to assert the two cannot fall out of step.
// Without the guard that test would run a migration (and exit(1) on no
// DATABASE_URL). Same shape as scripts/migrateSpecIntegrityFixes.js.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { RETIRE };
