'use strict';

// Migration — template_markers (document templates, REWORK step one: SCHEMA).
//
// A template's markers become fields in their own right: a name, a limit, a
// note, and whether anybody writes them. No asset type in the middle.
//
// WHY A TABLE AND NOT MORE JSONB ON doc_templates. `placeholders` already holds
// the discovery result as JSONB and that is the right shape for it — it is a
// verbatim record of one scan, rewritten wholesale every time. What the tenant
// CONFIRMS is different: it has to survive re-discovery. saveDocTemplate only
// ever INSERTs, so a revised .docx becomes a new row and anything stored in the
// old row's JSONB is stranded. Keyed rows keyed on marker_key survive an upsert;
// a blob does not.
//
// THE POSITION IS THE MAPPING. part / table_index / row / column say exactly
// which cell holds this field's copy, so nothing has to match a marker name to a
// field name ever again. It also survives replaceAllText consuming the marker,
// because the coordinate never referenced the marker's text.
//
// label_text IS A SELF-HEALING HINT, not decoration. The coordinate is stored on
// the TEMPLATE and every project copy inherits the structure exactly — but a
// writer who inserts a row in their copy shifts everything below it. On read-back
// the plan is: go to the coordinate, and if the neighbouring label cell is not
// label_text, scan the table for a row whose label is, and use that instead.
// Twenty lines that make the common hand edit non-fatal.
//
// is_copy DEFAULTS TO FALSE. A marker wrongly treated as copy gets prose drafted
// into a form-ID cell, invisible until a client reads it. Wrongly treated as
// metadata it just stays visible, which is this feature's established failure
// mode everywhere else. The reader proposes; the tenant ticks; the column starts
// where the cheaper mistake is.
//
// NOTHING READS THIS YET. It is deliberately inert — the confirm screen writes
// it, and the build, draft and review paths do not know it exists.
//
// Run scripts/migrateBackfillTemplateMarkers.js afterwards to carry the existing
// attach/map state onto it.
//
// Dry run by default: applies inside a transaction, prints the resulting state,
// then ROLLBACKs. --commit writes. Postgres DDL is transactional, so the dry run
// genuinely executes the statements rather than describing them.
//
// Idempotent — IF NOT EXISTS everywhere, safe to re-run.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateAddTemplateMarkers.js            # dry run — no writes
//   node scripts/migrateAddTemplateMarkers.js --commit   # write

const { Pool } = require('pg');

const TAG = '[template-markers]';
const COMMIT = process.argv.includes('--commit');

const STATEMENTS = [
  [
    'template_markers',
    `CREATE TABLE IF NOT EXISTS template_markers (
       id BIGSERIAL PRIMARY KEY,
       template_id BIGINT NOT NULL REFERENCES doc_templates(id) ON DELETE CASCADE,
       marker_key TEXT NOT NULL,
       marker_name TEXT NOT NULL,
       is_copy BOOLEAN NOT NULL DEFAULT false,
       char_min INTEGER NOT NULL DEFAULT 0,
       char_max INTEGER NOT NULL DEFAULT 0,
       field_type TEXT DEFAULT 'text',
       spec_note TEXT,
       sort_order INTEGER NOT NULL DEFAULT 0,
       part TEXT,
       table_index INTEGER,
       row_index INTEGER,
       column_index INTEGER,
       row_span INTEGER DEFAULT 1,
       column_span INTEGER DEFAULT 1,
       label_text TEXT,
       created_at TIMESTAMPTZ DEFAULT now(),
       updated_at TIMESTAMPTZ DEFAULT now()
     )`,
  ],
  [
    'template_markers_unique',
    // One row per marker per template. This is what makes re-discovery an UPSERT
    // rather than a wipe: a re-uploaded template matches its existing rows by
    // key and keeps the limits and notes the tenant entered.
    'CREATE UNIQUE INDEX IF NOT EXISTS template_markers_unique ON template_markers (template_id, marker_key)',
  ],
  [
    'template_markers_template_idx',
    'CREATE INDEX IF NOT EXISTS template_markers_template_idx ON template_markers (template_id)',
  ],
];

function sslFor(url) {
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

    const cols = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'template_markers'
        ORDER BY ordinal_position`
    );
    console.log(`\n${TAG} columns:`);
    for (const r of cols.rows) {
      console.log(
        `  ${r.column_name.padEnd(14)} ${r.data_type.padEnd(26)} ` +
          `null=${r.is_nullable.padEnd(3)} default=${r.column_default || '—'}`
      );
    }

    const counts = await client.query(
      `SELECT (SELECT count(*)::int FROM doc_templates)     AS templates,
              (SELECT count(*)::int FROM template_markers)  AS markers,
              (SELECT count(*)::int FROM template_markers WHERE is_copy) AS copy_markers`
    );
    const c = counts.rows[0];
    console.log(`\n${TAG} ${c.templates} template(s), ${c.markers} marker row(s), ${c.copy_markers} marked as copy`);
    console.log(
      `${TAG} nothing reads this table yet — the confirm screen writes it, and the\n` +
        `${TAG} build, draft and review paths do not know it exists.`
    );

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n${TAG} COMMITTED. Now run: node scripts/migrateBackfillTemplateMarkers.js`);
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
