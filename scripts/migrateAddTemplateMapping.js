'use strict';

// Migration — attach a template to an asset type, and map its markers to that
// asset's copy fields (custom document types, STEP TWO).
//
// Step one stored uploaded templates and the {{markers}} found in them. Nothing
// connected them to anything. This adds the two connections step three will use
// to build:
//
//   asset_types.doc_template_id       WHICH template this asset renders into.
//                                     NULL means "the copy doc" — which is every
//                                     asset today and stays the default forever.
//                                     Nullable with no default is the whole
//                                     point: existing rows are already correct.
//
//   copy_fields.template_marker_key   WHICH marker in that template this field
//   copy_fields.template_marker_name  fills. Both NULL = unmapped, which is a
//                                     VALID state, not an incomplete one — a
//                                     matrix carries markers no writer drafts
//                                     ({{Form ID}}, {{Owner}}, {{Last Updated}}).
//
// WHY COLUMNS ON copy_fields AND NOT A MAPPING TABLE. A mapping is one-to-one
// with the field and meaningless without it, so it belongs on the row. This also
// makes deletion correct for free: updateAssetType reconciles fields by id and
// DELETEs the ones a tenant removed, and a mapping stored on the row dies with
// it — no cascade to declare, no orphan to sweep. A side table keyed on
// copy_field_id would need ON DELETE CASCADE to reach the same place.
//
// The key is stored ALONGSIDE the display name on purpose. The key is the folded
// identity (utils/normalize, the same fold the asset-name unique index uses), so
// re-uploading a template that spells a marker differently still matches. The
// name is what a human reads in the settings panel, and reconstructing it from
// the key would print "form headline" where the document says "Form Headline".
//
// WHAT THIS DOES NOT DO. Nothing copies a template and nothing fills one in. An
// attached asset renders into the copy doc exactly as it did before — the
// pipeline never reads either column. The attachment is inert until step three.
//
// Dry run by default: it applies inside a transaction, prints the resulting
// state, then ROLLBACKs. --commit writes. Postgres DDL is transactional, so the
// dry run genuinely exercises the statements rather than guessing at them.
//
// Idempotent — IF NOT EXISTS everywhere, safe to re-run.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateAddTemplateMapping.js            # dry run — no writes
//   node scripts/migrateAddTemplateMapping.js --commit   # write

const { Pool } = require('pg');

const TAG = '[template-mapping]';
const COMMIT = process.argv.includes('--commit');

const STATEMENTS = [
  [
    'asset_types.doc_template_id',
    // ON DELETE SET NULL, not CASCADE: deleting a template must never delete a
    // tenant's asset. It falls back to the copy doc, which is the default and
    // always works.
    `ALTER TABLE asset_types
       ADD COLUMN IF NOT EXISTS doc_template_id BIGINT
       REFERENCES doc_templates(id) ON DELETE SET NULL`,
  ],
  [
    'asset_types_doc_template_idx',
    `CREATE INDEX IF NOT EXISTS asset_types_doc_template_idx
       ON asset_types (doc_template_id) WHERE doc_template_id IS NOT NULL`,
  ],
  [
    'copy_fields.template_marker_key',
    'ALTER TABLE copy_fields ADD COLUMN IF NOT EXISTS template_marker_key TEXT',
  ],
  [
    'copy_fields.template_marker_name',
    'ALTER TABLE copy_fields ADD COLUMN IF NOT EXISTS template_marker_name TEXT',
  ],
  [
    'copy_fields_marker_unique',
    // One marker, one field, WITHIN an asset. Two fields pointing at the same
    // cell is not a preference to be resolved at build time — it is a mapping
    // that cannot be rendered, and the database is the only place that can say
    // so regardless of which route or script is writing.
    `CREATE UNIQUE INDEX IF NOT EXISTS copy_fields_marker_unique
       ON copy_fields (asset_type_id, template_marker_key)
       WHERE template_marker_key IS NOT NULL`,
  ],
];

function sslFor(url) {
  // A unix-socket connection (host=/var/run/…) is local by construction and
  // never speaks SSL — without this the driver offers it and a local Postgres
  // answers "the server does not support SSL connections".
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
  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  try {
    await client.query('BEGIN');
    for (const [label, sql] of STATEMENTS) {
      await client.query(sql);
      console.log(`  ok  ${label}`);
    }

    // Read the state back INSIDE the transaction, so a dry run reports what the
    // migration would actually produce rather than what it intends to.
    const cols = await client.query(
      `SELECT table_name, column_name, is_nullable, data_type
         FROM information_schema.columns
        WHERE (table_name = 'asset_types'  AND column_name = 'doc_template_id')
           OR (table_name = 'copy_fields'  AND column_name LIKE 'template_marker%')
        ORDER BY table_name, column_name`
    );
    console.log(`\n${TAG} columns now present:`);
    for (const r of cols.rows) {
      console.log(`  ${r.table_name}.${r.column_name}  ${r.data_type}  nullable=${r.is_nullable}`);
    }

    // The claim that matters for safety: every existing asset is unattached, so
    // every asset still renders into the copy doc. Printed, not assumed.
    const counts = await client.query(
      `SELECT
         (SELECT count(*)::int FROM asset_types)                                    AS assets,
         (SELECT count(*)::int FROM asset_types WHERE doc_template_id IS NOT NULL)  AS attached,
         (SELECT count(*)::int FROM copy_fields)                                    AS fields,
         (SELECT count(*)::int FROM copy_fields WHERE template_marker_key IS NOT NULL) AS mapped`
    );
    const c = counts.rows[0];
    console.log(
      `\n${TAG} ${c.assets} asset type(s), ${c.attached} attached to a template ` +
        `(${c.assets - c.attached} render into the copy doc, unchanged)`
    );
    console.log(`${TAG} ${c.fields} copy field(s), ${c.mapped} mapped to a marker`);

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
