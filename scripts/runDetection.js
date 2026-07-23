'use strict';

// Ops helper (LiveSpecs chunk 2) — manually run the spec-change detector and
// print the result. Runs the detector IN-PROCESS (no HTTP, no admin session),
// the same way the migrations run — so it's the console-friendly equivalent of
// POST /admin/api/run-detection. Manual trigger only; no cron.
// Requires DATABASE_URL. Run: railway run node scripts/runDetection.js
//
// Never writes copy_fields — the detector only touches spec_watch_list and
// spec_review_queue.

const { runDetection } = require('../src/services/specDetector');
const { getReviewQueue } = require('../src/db/specWatch');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[run-detection] DATABASE_URL not set — nothing to do.');
    process.exit(1);
  }

  const r = await runDetection();
  if (!r.ran) {
    console.error('[run-detection] did not run:', r.reason || 'unknown');
    process.exit(1);
  }

  console.log('[run-detection] summary:', JSON.stringify(r.summary));
  for (const x of r.results) {
    console.log(
      `  - ${x.is_test ? '[TEST] ' : ''}${x.display_name}: ${x.status}${x.error ? ` (${x.error})` : ''}`
    );
  }

  const q = await getReviewQueue();
  console.log(`[run-detection] review queue now has ${q.length} row(s):`);
  for (const row of q) {
    console.log(
      `  - #${row.id} ${row.is_test ? '[TEST] ' : ''}${row.status} — ${row.source_url} ` +
        `(old=${String(row.old_hash || '').slice(0, 8)} new=${String(row.new_hash || '').slice(0, 8)})`
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[run-detection] FAILED:', err.message);
  process.exit(1);
});
