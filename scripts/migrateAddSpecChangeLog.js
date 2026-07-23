'use strict';

// Migration — LiveSpecs chunk 3a. The audit trail for spec writes, plus a
// verified-at stamp on copy_fields. Standalone and idempotent (IF NOT EXISTS),
// safe to re-run. Run on Railway with:
//   railway run node scripts/migrateAddSpecChangeLog.js
//
// SCOPE: schema only. No data writes here — copy_fields is only ever written by
// the confirmed approve path in src/services/specReview.js.

// Audit trail: one row per (field, attribute) actually written on a confirmed
// approve. This is the record of what changed, from what to what, by whom, and
// how many tenant rows — the basis for a future rollback.
const CREATE_CHANGE_LOG = `CREATE TABLE IF NOT EXISTS spec_change_log (
  id           BIGSERIAL PRIMARY KEY,
  flag_id      BIGINT REFERENCES spec_review_queue(id),
  asset_type   TEXT NOT NULL,
  field_name   TEXT NOT NULL,
  field_attr   TEXT NOT NULL,           -- 'char_max' | 'spec_note'
  old_value    TEXT,
  new_value    TEXT,
  tenant_count INT,
  source_url   TEXT,
  changed_by   BIGINT REFERENCES users(id),
  changed_at   TIMESTAMPTZ DEFAULT NOW()
)`;

const CREATE_LOG_FLAG_IDX =
  'CREATE INDEX IF NOT EXISTS idx_spec_change_log_flag ON spec_change_log (flag_id)';

// Per-field "last verified against source" stamp. Nullable — only set when an
// admin confirms a write for that field (in the same transaction as the value
// change), across all tenant rows for the pair.
const ADD_VERIFIED_AT =
  'ALTER TABLE copy_fields ADD COLUMN IF NOT EXISTS spec_verified_at TIMESTAMP';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate-change-log] DATABASE_URL not set — nothing to do.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[migrate-change-log] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    await client.query(CREATE_CHANGE_LOG);
    console.log('[migrate-change-log] created table: spec_change_log');
    await client.query(CREATE_LOG_FLAG_IDX);
    console.log('[migrate-change-log] created index: idx_spec_change_log_flag');
    await client.query(ADD_VERIFIED_AT);
    console.log('[migrate-change-log] added column: copy_fields.spec_verified_at (nullable)');

    // Confirmation: no field is verified yet (stamp only happens on approve→write).
    const verified = await client.query(
      'SELECT COUNT(*)::int AS n FROM copy_fields WHERE spec_verified_at IS NOT NULL'
    );
    console.log(`[migrate-change-log] copy_fields with spec_verified_at set: ${verified.rows[0].n} (expected 0)`);
    const logCount = await client.query('SELECT COUNT(*)::int AS n FROM spec_change_log');
    console.log(`[migrate-change-log] spec_change_log rows: ${logCount.rows[0].n} (expected 0)`);

    console.log('[migrate-change-log] done');
    process.exit(0);
  } catch (err) {
    console.error('[migrate-change-log] FAILED:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
