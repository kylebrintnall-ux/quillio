'use strict';

// Migration + seed — LiveSpecs data layer (chunk 1). Creates the two GLOBAL
// tables that back spec-change detection, then seeds the watch list from the
// spec data already in Postgres. Standalone and idempotent (CREATE TABLE IF NOT
// EXISTS; seed guards on the UNIQUE source_url), so it's safe to re-run.
// Run on Railway with: railway run node scripts/migrateAddSpecTables.js
//
// SCOPE (chunk 1): tables + watch-list seed ONLY. No detector, no hashing, no
// queue rows, no writes to copy_fields. current_hash / last_checked_at stay NULL
// until the detector (a later chunk) fills them.

// --- DDL: both tables are GLOBAL (no tenant_id — platform specs are universal) ---
const CREATE_WATCH_LIST = `CREATE TABLE IF NOT EXISTS spec_watch_list (
  id              BIGSERIAL PRIMARY KEY,
  source_url      TEXT NOT NULL UNIQUE,      -- the page to watch (also the idempotency key)
  display_name    TEXT,                      -- friendly label for the UI
  affected_fields JSONB,                     -- [{asset, field}] that depend on this URL; null for the test entry
  current_hash    TEXT,                      -- nullable — detector fills on first run
  last_checked_at TIMESTAMPTZ,               -- nullable — null until first run
  is_test         BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW()
)`;

const CREATE_REVIEW_QUEUE = `CREATE TABLE IF NOT EXISTS spec_review_queue (
  id          BIGSERIAL PRIMARY KEY,
  watch_id    BIGINT REFERENCES spec_watch_list(id),
  source_url  TEXT,                          -- denormalized from the watch entry for convenience
  old_hash    TEXT,
  new_hash    TEXT,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | reviewed | dismissed
  is_test     BOOLEAN NOT NULL DEFAULT false,  -- inherited from the watch entry; bars test flags from any propagate step
  created_at  TIMESTAMPTZ DEFAULT NOW()
)`;

const CREATE_QUEUE_STATUS_IDX =
  'CREATE INDEX IF NOT EXISTS idx_spec_review_queue_status ON spec_review_queue (status, detected_at)';

// --- Seed config ---
// Litmus pages are cited in hand-written spec_notes (NOTE_SOURCE_LINKS in
// destinations/googleDocs.js), not in spec_source — so their affected_fields are
// derived by matching the note text, keyed on the same distinctive substring the
// renderer uses.
const LITMUS = [
  {
    url: 'https://www.litmus.com/blog/how-to-write-the-perfect-subject-line-infographic',
    display: 'Litmus – subject line',
    noteMatch: 'Mobile inboxes cut around 40',
  },
  {
    url: 'https://www.litmus.com/blog/the-ultimate-guide-to-preview-text-support',
    display: 'Litmus – preheader',
    noteMatch: 'characters of preheader',
  },
];

const TEST_ENTRY = {
  url: 'https://quillio.co/admin/test-spec',
  display: 'TEST PAGE',
};

// URL -> platform display name, mirroring specSourceName() in googleDocs.js so
// the watch-list labels match what the app already shows. Falls back to hostname.
function platformName(url) {
  const s = String(url || '').toLowerCase();
  if (s.includes('linkedin')) return 'LinkedIn';
  if (s.includes('facebook') || s.includes('meta') || s.includes('fb.com')) return 'Meta';
  if (s.includes('x.com') || s.includes('twitter')) return 'X';
  if (s.includes('google') || s.includes('dv360') || s.includes('doubleclick')) return 'Google';
  if (s.includes('instagram')) return 'Instagram';
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// DISTINCT (asset, field) pairs across ALL tenants for a given predicate. The
// spec library is per-tenant, but the URLs are shared, so DISTINCT collapses the
// per-tenant duplicates into the global set of affected fields.
async function affectedFieldsWhere(client, whereSql, param) {
  const res = await client.query(
    `SELECT DISTINCT at.name AS asset, cf.field_name AS field
       FROM copy_fields cf
       JOIN asset_types at ON at.id = cf.asset_type_id
      WHERE ${whereSql}
      ORDER BY at.name, cf.field_name`,
    [param]
  );
  return res.rows.map((r) => ({ asset: r.asset, field: r.field }));
}

// Insert one watch entry, idempotent on source_url. affected is an array (stored
// as JSONB) or null. Returns true if a new row was inserted.
async function upsertWatch(client, { url, display, affected, isTest }) {
  const res = await client.query(
    `INSERT INTO spec_watch_list (source_url, display_name, affected_fields, is_test)
       VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (source_url) DO NOTHING
     RETURNING id`,
    [url, display, affected == null ? null : JSON.stringify(affected), !!isTest]
  );
  return res.rowCount > 0;
}

async function seedWatchList(client) {
  let inserted = 0;

  // 1. Real platform URLs: the DISTINCT spec_source on enforced fields (Meta,
  //    LinkedIn, X, Google). Excludes the 'quillio_default' placeholder.
  const platforms = await client.query(
    `SELECT DISTINCT spec_source
       FROM copy_fields
      WHERE spec_type = 'enforced'
        AND spec_source IS NOT NULL
        AND spec_source <> 'quillio_default'
      ORDER BY spec_source`
  );
  for (const row of platforms.rows) {
    const url = row.spec_source;
    const affected = await affectedFieldsWhere(client, 'cf.spec_source = $1', url);
    if (await upsertWatch(client, { url, display: platformName(url), affected, isTest: false })) inserted++;
  }
  console.log(`[migrate-spec-tables] platform watch entries from enforced spec_source: ${platforms.rowCount} distinct URL(s)`);

  // 2. Litmus pages: affected_fields derived from the cited spec_note text.
  for (const l of LITMUS) {
    const affected = await affectedFieldsWhere(client, "cf.spec_note LIKE '%' || $1 || '%'", l.noteMatch);
    if (await upsertWatch(client, { url: l.url, display: l.display, affected, isTest: false })) inserted++;
  }

  // 3. One test entry (is_test=true) — placeholder URL; the real test page is a
  //    later chunk. affected_fields stays null so it never touches real specs.
  if (await upsertWatch(client, { url: TEST_ENTRY.url, display: TEST_ENTRY.display, affected: null, isTest: true })) inserted++;

  return inserted;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate-spec-tables] DATABASE_URL not set — nothing to do.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-spec-tables] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    await client.query(CREATE_WATCH_LIST);
    console.log('[migrate-spec-tables] created table: spec_watch_list');
    await client.query(CREATE_REVIEW_QUEUE);
    console.log('[migrate-spec-tables] created table: spec_review_queue');
    await client.query(CREATE_QUEUE_STATUS_IDX);
    console.log('[migrate-spec-tables] created index: idx_spec_review_queue_status');

    const inserted = await seedWatchList(client);
    console.log(`[migrate-spec-tables] seed: ${inserted} new watch row(s) inserted (0 on a re-run)`);

    // Confirmation: total count + the full list (display, url, is_test, #fields).
    const all = await client.query(
      `SELECT source_url, display_name, is_test,
              COALESCE(jsonb_array_length(affected_fields), 0) AS field_count
         FROM spec_watch_list
        ORDER BY is_test, display_name NULLS LAST, source_url`
    );
    console.log(`[migrate-spec-tables] spec_watch_list now has ${all.rowCount} row(s):`);
    for (const r of all.rows) {
      console.log(
        `  - ${r.is_test ? '[TEST] ' : ''}${r.display_name || '(no name)'} — ${r.source_url} (${r.field_count} field${r.field_count === 1 ? '' : 's'})`
      );
    }

    const q = await client.query('SELECT COUNT(*)::int AS n FROM spec_review_queue');
    console.log(`[migrate-spec-tables] spec_review_queue row(s): ${q.rows[0].n} (expected 0 this chunk)`);

    console.log('[migrate-spec-tables] done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate-spec-tables] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
