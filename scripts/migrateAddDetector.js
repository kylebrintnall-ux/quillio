'use strict';

// Migration + seed — LiveSpecs detector support (chunk 2). Adds the editable
// test-page store and the watch-row error column the detector needs, and points
// the is_test watch entry at the real test-page URL. Standalone and idempotent
// (IF NOT EXISTS / ON CONFLICT / guarded UPDATE), safe to re-run.
// Run on Railway with: railway run node scripts/migrateAddDetector.js
//
// SCOPE (chunk 2): schema + seed only. No cron, no writes to copy_fields. The
// detector itself is app code (src/services/specDetector.js), triggered manually
// via POST /admin/api/run-detection.

// Singleton table (id is pinned to 1) holding the editable fake spec the
// detector fetches to prove itself end to end.
const CREATE_TEST_PAGE = `CREATE TABLE IF NOT EXISTS spec_test_page (
  id         SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  content    TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
)`;

// Seed content — fake spec numbers, the kind of visible text a real spec page
// carries. Only inserted if the singleton row doesn't already exist.
const TEST_CONTENT = 'Headline: 60 characters\nBody: 200 characters\nCTA: 25 characters';
const SEED_TEST_PAGE =
  'INSERT INTO spec_test_page (id, content) VALUES (1, $1) ON CONFLICT (id) DO NOTHING';

// last_error lets a failed fetch be recorded on the watch row without ever
// looking like a content change (see the detector's error branch).
const ADD_LAST_ERROR =
  'ALTER TABLE spec_watch_list ADD COLUMN IF NOT EXISTS last_error TEXT';

// The real URL the test page is served at. Chunk 1 already seeded the is_test
// row with this exact value, so this UPDATE is normally a no-op — it's here so
// the migration is self-contained and correct even if that ever drifts. Scoped
// to is_test=true so it can never touch a real platform row.
const TEST_URL = 'https://quillio.co/admin/test-spec';
const REPOINT_TEST_WATCH =
  'UPDATE spec_watch_list SET source_url = $1 WHERE is_test = true';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate-detector] DATABASE_URL not set — nothing to do.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-detector] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    await client.query(CREATE_TEST_PAGE);
    console.log('[migrate-detector] created table: spec_test_page (singleton)');

    const seeded = await client.query(SEED_TEST_PAGE, [TEST_CONTENT]);
    console.log(
      `[migrate-detector] seed test page: ${seeded.rowCount === 1 ? 'inserted default content' : 'already present (left as-is)'}`
    );

    await client.query(ADD_LAST_ERROR);
    console.log('[migrate-detector] added column: spec_watch_list.last_error');

    const repoint = await client.query(REPOINT_TEST_WATCH, [TEST_URL]);
    console.log(`[migrate-detector] test watch entry → ${TEST_URL} (${repoint.rowCount} is_test row updated)`);

    // Confirmation: show the stored test content + the is_test watch row.
    const tp = await client.query('SELECT content FROM spec_test_page WHERE id = 1');
    console.log('[migrate-detector] spec_test_page content is now:');
    console.log('    ' + JSON.stringify(tp.rows[0] && tp.rows[0].content));
    const w = await client.query(
      'SELECT display_name, source_url, current_hash, last_error FROM spec_watch_list WHERE is_test = true'
    );
    for (const r of w.rows) {
      console.log(
        `[migrate-detector] is_test watch: ${r.display_name} — ${r.source_url} (current_hash=${r.current_hash || 'NULL'}, last_error=${r.last_error || 'NULL'})`
      );
    }

    console.log('[migrate-detector] done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate-detector] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
