'use strict';

// Data fix — the Google spec_source pointed at the wrong doc. answer/7684791 is
// "About responsive search ads" (RSA), but it was set on the Google DV360 /
// Responsive Display fields. The character limits in the library (30/90/90/25)
// are already the correct Responsive DISPLAY values — only the source URL was
// wrong. This repoints it at answer/17090561 ("Responsive display ads specs and
// format requirements"), the real Display specs page.
//
// Changes ONLY spec_source (provenance) — no char_max / spec_note value changes,
// nothing writer-facing. In one transaction it:
//   1. updates copy_fields.spec_source on the 4 Google Display enforced fields
//      (all tenants), old -> new;
//   2. repoints the spec_watch_list entry and RESETS its hash so the next
//      detection run re-baselines the new page instead of firing a spurious
//      "changed" flag;
//   3. dismisses the stale pending flag(s) on that watch (hashes were from the
//      old RSA page, now meaningless).
//
// Idempotent (guarded on the old URL); a re-run after the fix changes 0 rows.
// The code constants (defaultAssets.js ENFORCED_SOURCE_URLS.Google and
// migrateSetEnforcedSpecSource.js PLATFORM_URLS.Google) are updated to the new
// URL in the same change, kept byte-identical (a smoke test asserts it).
//
// Run on Railway with: railway run node scripts/migrateFixGoogleSpecSource.js

const OLD_URL = 'https://support.google.com/google-ads/answer/7684791';
const NEW_URL = 'https://support.google.com/google-ads/answer/17090561';
const ASSET = 'Google DV360 / Responsive Display';
const FIELDS = ['Short Headline', 'Long Headline', 'Description', 'Business Name'];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[fix-google-source] DATABASE_URL not set — nothing to do.');
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error('[fix-google-source] could not load "pg" — is it installed? ' + err.message);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    await client.query('BEGIN');

    // 1. Repoint spec_source on the 4 Google Display enforced fields (all tenants).
    const cf = await client.query(
      `UPDATE copy_fields cf
          SET spec_source = $1
         FROM asset_types at
        WHERE cf.asset_type_id = at.id
          AND at.name = $2
          AND cf.field_name = ANY($3)
          AND cf.spec_source = $4`,
      [NEW_URL, ASSET, FIELDS, OLD_URL]
    );
    console.log(`[fix-google-source] copy_fields.spec_source updated: ${cf.rowCount} row(s) (expected 8 = 4 fields x 2 tenants)`);

    // 2. Repoint the watch entry + reset its hash so the next run re-baselines.
    const w = await client.query(
      `UPDATE spec_watch_list
          SET source_url = $1, current_hash = NULL, last_checked_at = NULL, last_error = NULL
        WHERE source_url = $2
      RETURNING id`,
      [NEW_URL, OLD_URL]
    );
    console.log(`[fix-google-source] spec_watch_list repointed + hash reset: ${w.rowCount} row(s) (expected 1)`);

    // 3. Dismiss stale pending flag(s) on that watch entry (old-page hashes).
    let dismissed = 0;
    if (w.rowCount === 1) {
      const watchId = w.rows[0].id;
      const d = await client.query(
        "UPDATE spec_review_queue SET status = 'dismissed' WHERE watch_id = $1 AND status = 'pending' RETURNING id",
        [watchId]
      );
      dismissed = d.rowCount;
    }
    console.log(`[fix-google-source] stale pending flag(s) dismissed: ${dismissed}`);

    await client.query('COMMIT');

    // Confirmation: show the watch entry's new state.
    const check = await client.query(
      'SELECT id, display_name, source_url, current_hash FROM spec_watch_list WHERE source_url = $1',
      [NEW_URL]
    );
    for (const r of check.rows) {
      console.log(
        `[fix-google-source] watch #${r.id} "${r.display_name}" -> ${r.source_url} (current_hash=${r.current_hash || 'NULL — will re-baseline'})`
      );
    }

    console.log('[fix-google-source] done — run detection to baseline the new page (no flag expected).');
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[fix-google-source] FAILED (rolled back):', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
