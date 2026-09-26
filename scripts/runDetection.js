'use strict';

// Ops helper (LiveSpecs chunk 2) — manually run the spec-change detector and
// print the result. Runs the detector IN-PROCESS (no HTTP, no admin session),
// the same way the migrations run — so it's the console-friendly equivalent of
// POST /admin/api/run-detection. This is ALSO the cron service's start command:
// railway.cron.json runs `node scripts/runDetection.js` weekly on `0 15 * * 1`
// (Mondays 15:00 UTC). The line here used to claim "manual trigger only; no
// cron", which predated that service.
// Requires DATABASE_URL. Run in the Railway console:
//   node scripts/runDetection.js
//
// Never writes copy_fields — the detector only touches spec_watch_list,
// spec_review_queue and detection_runs (its own run log).
//
// --scheduled LABELS THE RUN; it changes nothing about what the run does.
// railway.cron.json passes it, so the weekly run records itself as 'scheduled' in
// the run log. Without it the run is recorded as 'script' — which is the cron OR
// a console run, and deliberately not claimed as either. That matters if the
// Railway service's start command is ever set in the dashboard instead of read
// from railway.cron.json: the flag would stop arriving, and the console would say
// "ran but not marked scheduled" rather than silently calling the weekly run a
// console run. Same pattern as the sweep cron's --commit, which a hand-run in the
// console also does not pass.
const SCHEDULED = process.argv.includes('--scheduled');

const { runDetection } = require('../src/services/specDetector');
const { getReviewQueue } = require('../src/db/specWatch');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[run-detection] DATABASE_URL not set — nothing to do.');
    process.exit(1);
  }

  const r = await runDetection({ trigger: SCHEDULED ? 'scheduled' : 'script' });
  if (!r.ran) {
    console.error('[run-detection] did not run:', r.reason || 'unknown');
    process.exit(1);
  }

  console.log('[run-detection] summary:', JSON.stringify(r.summary));
  // null when the run log is not migrated yet, or its INSERT failed — the run
  // itself stands either way.
  console.log(`[run-detection] run log: ${r.runId != null ? `recorded as #${r.runId}` : 'NOT recorded (see warnings above)'}`);
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
