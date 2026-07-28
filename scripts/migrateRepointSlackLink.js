'use strict';

// Tenant consolidation — TRANSACTION 1 ONLY: repoint the Slack link.
//
// One human exists as two tenants. The Slack (team, user) link — the pair
// resolveTenant() matches on (src/db.js:76-82) — sits on the per-user UUID
// tenant, so /quillio resolves there, while web sign-in lands on the workspace
// tenant. This moves ONLY that link so both surfaces resolve to the same tenant.
//
// Order matters: uq_tenants_slack_link (scripts/migrateDb.js:31-33) is a PARTIAL
// UNIQUE index on (slack_team_id, slack_user_id) where both are NOT NULL, and it
// is not deferrable — it is checked per statement. So the pair must be cleared on
// the source tenant BEFORE it is set on the target, or the second UPDATE fails
// with 23505.
//
// SCOPE: the tenants table only. This script does NOT move projects, tokens,
// asset_types, voice_guide or templates — that is a separate transaction.
//
// Dry run by default (applies inside a transaction, prints the would-be state,
// then ROLLBACKs). --commit writes. Every UPDATE asserts rowCount === 1 and any
// deviation rolls the whole thing back.
//
//   node scripts/migrateRepointSlackLink.js            # dry run — no writes
//   node scripts/migrateRepointSlackLink.js --commit   # write
//
// The tenant ids are overridable for testing:
//   FROM_TENANT=… TO_TENANT=… node scripts/migrateRepointSlackLink.js

const TAG = '[repoint-slack-link]';

// Source: the per-user tenant currently holding the Slack link.
const FROM_TENANT = (process.env.FROM_TENANT || '4baa922e-933d-43cc-b0b5-128137c4c356').trim();
// Target: the tenant everything is being consolidated into.
const TO_TENANT = (process.env.TO_TENANT || 'T0B8LPRDKHR').trim();

const COMMIT = process.argv.includes('--commit');

function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

const SELECT_TENANTS = `SELECT id, workspace_id, workspace_name, slack_team_id, slack_user_id,
                               plan, onboarding_complete
                          FROM tenants
                         WHERE id = $1 OR id = $2`;

// Read both tenant rows, always returned as { from, to } (either may be null).
async function readPair(runner) {
  const res = await runner.query(SELECT_TENANTS, [FROM_TENANT, TO_TENANT]);
  const byId = new Map(res.rows.map((r) => [r.id, r]));
  return { from: byId.get(FROM_TENANT) || null, to: byId.get(TO_TENANT) || null };
}

function fmtRow(role, id, row) {
  if (!row) return `  ${role} ${id} — NO SUCH TENANT ROW`;
  return (
    `  ${role} ${row.id}\n` +
    `      workspace_id=${row.workspace_id || 'NULL'} workspace_name=${row.workspace_name || 'NULL'}\n` +
    `      slack_team_id=${row.slack_team_id || 'NULL'} slack_user_id=${row.slack_user_id || 'NULL'}\n` +
    `      plan=${row.plan || 'NULL'} onboarding_complete=${row.onboarding_complete}`
  );
}

function printPair(label, pair) {
  console.log(`${TAG} ${label}:`);
  console.log(fmtRow('FROM', FROM_TENANT, pair.from));
  console.log(fmtRow('TO  ', TO_TENANT, pair.to));
}

// Abort the transaction on any unexpected row count — never guess which rows to
// rewrite. Throwing lands in the catch below, which ROLLBACKs.
function assertRowCount(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: expected rowCount ${expected}, got ${actual} — aborting`);
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`${TAG} DATABASE_URL is not set in this environment.`);
    process.exit(1);
  }
  if (FROM_TENANT === TO_TENANT) {
    console.error(`${TAG} FROM_TENANT and TO_TENANT are the same id — nothing to repoint.`);
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error(`${TAG} could not load "pg": ` + err.message);
    process.exit(1);
  }

  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);
  console.log(`${TAG} from: ${FROM_TENANT}`);
  console.log(`${TAG} to:   ${TO_TENANT}`);

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  try {
    await client.connect();

    // --- BEFORE ---
    const before = await readPair(client);
    printPair('BEFORE', before);

    // --- Pre-flight: refuse to write unless the situation is exactly what we expect ---
    if (!before.from) {
      console.error(`${TAG} ABORTED: no tenants row with id ${FROM_TENANT}. Nothing written.`);
      process.exitCode = 1;
      return;
    }
    if (!before.to) {
      console.error(`${TAG} ABORTED: no tenants row with id ${TO_TENANT}. Nothing written.`);
      process.exitCode = 1;
      return;
    }

    const teamId = before.from.slack_team_id;
    const userId = before.from.slack_user_id;

    // Already done? (link on the target, source cleared) — report and exit clean.
    if (!teamId && !userId) {
      if (before.to.slack_team_id && before.to.slack_user_id) {
        console.log(`${TAG} nothing to do — ${FROM_TENANT} holds no link and ${TO_TENANT} already carries one.`);
        return;
      }
      console.error(
        `${TAG} ABORTED: ${FROM_TENANT} has no Slack link to move ` +
          `(slack_team_id/slack_user_id are NULL) and ${TO_TENANT} has none either. Nothing written.`
      );
      process.exitCode = 1;
      return;
    }
    // A half-set link is not something to guess at — the partial index only
    // constrains rows where BOTH columns are set.
    if (!teamId || !userId) {
      console.error(
        `${TAG} ABORTED: ${FROM_TENANT} has a partial link ` +
          `(slack_team_id=${teamId || 'NULL'}, slack_user_id=${userId || 'NULL'}). Resolve it by hand. Nothing written.`
      );
      process.exitCode = 1;
      return;
    }
    // Never overwrite a link the target already holds.
    if (before.to.slack_team_id || before.to.slack_user_id) {
      console.error(
        `${TAG} ABORTED: ${TO_TENANT} already carries a Slack link ` +
          `(team=${before.to.slack_team_id || 'NULL'}, user=${before.to.slack_user_id || 'NULL'}). ` +
          'Resolve which link is correct before re-running. Nothing written.'
      );
      process.exitCode = 1;
      return;
    }

    console.log(`${TAG} moving link team=${teamId} user=${userId} → ${TO_TENANT}`);

    // --- The transaction ---
    await client.query('BEGIN');
    try {
      // 1. Clear the pair on the source FIRST — uq_tenants_slack_link is checked
      //    per statement, so setting it on the target while the source still
      //    holds it is a 23505. The WHERE re-states the values we read, so a
      //    concurrent change makes this match 0 rows and abort rather than
      //    clobber someone else's link.
      const cleared = await client.query(
        `UPDATE tenants SET slack_team_id = NULL, slack_user_id = NULL
           WHERE id = $1 AND slack_team_id = $2 AND slack_user_id = $3`,
        [FROM_TENANT, teamId, userId]
      );
      assertRowCount(cleared.rowCount, 1, `clear link on ${FROM_TENANT}`);
      console.log(`${TAG} step 1/2 OK — cleared link on ${FROM_TENANT} (rowCount=1)`);

      // 2. Set the same pair on the target. Guarded on both columns still being
      //    NULL so this can only ever fill an empty link.
      const set = await client.query(
        `UPDATE tenants SET slack_team_id = $2, slack_user_id = $3
           WHERE id = $1 AND slack_team_id IS NULL AND slack_user_id IS NULL`,
        [TO_TENANT, teamId, userId]
      );
      assertRowCount(set.rowCount, 1, `set link on ${TO_TENANT}`);
      console.log(`${TAG} step 2/2 OK — set link on ${TO_TENANT} (rowCount=1)`);

      // 3. Invariant: across the WHOLE table exactly one tenant holds this pair,
      //    and it is the target. This is what uq_tenants_slack_link guarantees —
      //    verified explicitly rather than assumed.
      const holders = await client.query(
        'SELECT id FROM tenants WHERE slack_team_id = $1 AND slack_user_id = $2',
        [teamId, userId]
      );
      assertRowCount(holders.rowCount, 1, 'tenants holding the (team, user) pair');
      if (holders.rows[0].id !== TO_TENANT) {
        throw new Error(`pair is held by ${holders.rows[0].id}, expected ${TO_TENANT} — aborting`);
      }
      console.log(`${TAG} invariant OK — exactly 1 tenant holds the pair, and it is ${TO_TENANT}`);

      // --- AFTER (still inside the transaction) ---
      printPair(COMMIT ? 'AFTER (uncommitted)' : 'AFTER (dry run — will be rolled back)', await readPair(client));

      if (COMMIT) {
        await client.query('COMMIT');
        console.log(`${TAG} COMMITTED`);
      } else {
        await client.query('ROLLBACK');
        console.log(`${TAG} ROLLED BACK (dry run) — no changes were written. Re-run with --commit to apply.`);
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`${TAG} FAILED (rolled back): ` + err.message);
      process.exitCode = 1;
      // Fall through to the final read so the operator sees the real end state.
    }

    // --- FINAL (fresh read after the transaction ended, whatever happened) ---
    printPair('FINAL (on disk)', await readPair(client));
    if (process.exitCode !== 1) {
      console.log(`${TAG} done`);
    }
  } catch (err) {
    console.error(`${TAG} FAILED: ` + (err && err.message ? err.message : err));
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main();
