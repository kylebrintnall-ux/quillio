'use strict';

// Ops entry point and cron start command for the spec correction sweep.
//
// Runs the sweep IN-PROCESS (no HTTP, no admin session), the same way
// scripts/runDetection.js runs the detector — so the console command and the
// scheduled service are the same code path.
//
// DRY RUN BY DEFAULT, --commit WRITES. Every migration in this directory works
// that way and this does something more consequential than a migration: it edits
// documents a customer is working in. A dry run resolves every change, every
// tenant and every project and reports exactly what it would touch, without
// opening a single document.
//
//   node scripts/runSpecSweep.js            # dry run
//   node scripts/runSpecSweep.js --commit   # correct documents and notify
//
// Requires DATABASE_URL. Run it in the Railway console as plain node — NEVER
// `railway run` (CLAUDE.md).
//
// SCHEDULING. railway.spec-sweep.cron.json is a SEPARATE Railway service, because
// railway.cron.json already carries one `startCommand` and a Railway service runs
// exactly one. The detector and the sweep are also deliberately not chained: the
// detector only writes to the review queue and a human approves what it finds, so
// running the sweep straight after it would sweep changes approved a week ago and
// then sit idle — the two answer to different clocks. The sweep is scheduled a few
// hours after the detector purely so their logs do not interleave.

const { runSpecSweep } = require('../src/services/specSweep');

const COMMIT = process.argv.includes('--commit');
const TAG = '[run-spec-sweep]';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(`${TAG} DATABASE_URL not set — nothing to do.`);
    process.exit(1);
  }

  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (edits documents, writes notifications)' : 'DRY RUN (no writes — pass --commit)'}`);

  const r = await runSpecSweep({ dryRun: !COMMIT });
  if (!r.ran) {
    console.error(`${TAG} did not run: ${r.reason}`);
    process.exit(1);
  }

  for (const c of r.changes) {
    console.log(
      `  change #${c.changeId} ${c.assetType} / ${c.fieldName}: ` +
        `${c.oldValue} -> ${c.newValue}${c.complete ? '' : '  [INCOMPLETE]'}` +
        (c.note ? `  (${c.note})` : '')
    );
    for (const t of c.tenants) {
      console.log(
        `    tenant ${t.tenantId}: ` +
          (t.eligible
            ? `${t.documentsCorrected} corrected, ${t.documentsFailed} failed, notified=${t.notified}`
            : `skipped (${t.reason})`)
      );
    }
  }

  console.log(
    `${TAG} ${r.documentsCorrected} document(s) corrected, ${r.notifications} notification(s), ` +
      `${r.skippedNoManifest} project(s) skipped for a null manifest (pre-manifest rows; this ` +
      'number falls to zero on its own as those projects finish)'
  );

  // A partial run is not a crash — the corrections that landed are real and the
  // watermark held — but it must not report success to the scheduler, or a
  // credential that has been dead for a month looks like a month of clean runs.
  if (r.status === 'partial') {
    console.error(`${TAG} PARTIAL: stopped at change ${r.stoppedAtChange}. The watermark did not pass it; the next run retries from there.`);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`${TAG} FAILED:`, err && err.stack ? err.stack : err);
  process.exit(1);
});
