'use strict';

// Migration — per-user credentials (accounts/tenants split, step 2: DATA).
//
// Carries the existing TENANT-level credentials forward onto the single user
// who actually owns them. Run scripts/migrateAddUserCredentials.js first (this
// script refuses to run if the new tables are missing).
//
// For each tenant:
//   tenant_tokens(service='google')     → user_tokens(user_id, 'google')
//   tenant_tokens(service='slack_user') → user_tokens(user_id, 'slack_user')
//   tenants.slack_team_id + slack_user_id → user_slack_links(user_id, team, user)
//
// WHICH user? The tenant's users row — but only when there is EXACTLY ONE.
//   0 users  → SKIPPED and reported. A tenant with no users row (a bare Slack
//              workspace install that nobody ever signed into) has no person to
//              attach its credentials to. Its tenant_tokens rows are left
//              untouched and the read path still falls back to them.
//   >1 users → SKIPPED and reported. Which of them owns the token is not
//              knowable from the data, and guessing would hand one person's
//              Google identity to another. Resolve by hand, then re-run.
//
// NOTHING IS DELETED OR OVERWRITTEN. tenant_tokens rows and the tenants.slack_*
// columns are left exactly as they are (the read path still uses them as a
// deprecated fallback), and a user_tokens / user_slack_links row that already
// exists is never rewritten — so the script is safe to re-run.
//
// Dry run by default (applies inside a transaction, prints the would-be state,
// then ROLLBACKs). --commit writes.
//
//   node scripts/migrateBackfillUserCredentials.js            # dry run — no writes
//   node scripts/migrateBackfillUserCredentials.js --commit   # write

const TAG = '[backfill-user-creds]';
const COMMIT = process.argv.includes('--commit');

// Services carried from tenant_tokens to user_tokens. slack_bot is deliberately
// NOT here: a bot token is issued to the workspace, not to a person, and stays
// tenant-scoped.
const USER_SERVICES = ['google', 'slack_user'];

function sslFor(url) {
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

// Fail early with a clear message if step 1 hasn't been run.
async function assertSchema(client) {
  const missing = [];
  for (const t of ['user_tokens', 'user_slack_links']) {
    const res = await client.query('SELECT to_regclass($1) AS oid', [t]);
    if (!res.rows[0].oid) missing.push(t);
  }
  const col = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'projects' AND column_name = 'created_by'`
  );
  if (col.rowCount === 0) missing.push('projects.created_by');
  if (missing.length) {
    throw new Error(
      `missing schema: ${missing.join(', ')} — run scripts/migrateAddUserCredentials.js first`
    );
  }
}

// Every tenant that carries something worth moving: a tenant-level user token
// and/or a Slack link on the tenants row.
const SELECT_TENANTS = `
  SELECT t.id,
         t.workspace_id,
         t.workspace_name,
         t.slack_team_id,
         t.slack_user_id
    FROM tenants t
   WHERE EXISTS (
           SELECT 1 FROM tenant_tokens tt
            WHERE tt.tenant_id = t.id
              AND tt.service = ANY($1::text[])
              AND tt.access_token IS NOT NULL
         )
      OR (t.slack_team_id IS NOT NULL AND t.slack_user_id IS NOT NULL)
   ORDER BY t.id`;

async function usersOf(client, tenantId) {
  const res = await client.query(
    'SELECT id, email FROM users WHERE tenant_id = $1 ORDER BY id',
    [tenantId]
  );
  return res.rows;
}

function label(t) {
  return `${t.id}${t.workspace_name ? ` (${t.workspace_name})` : ''}`;
}

async function run(client, report) {
  const tenants = (await client.query(SELECT_TENANTS, [USER_SERVICES])).rows;
  console.log(`${TAG} tenants carrying tenant-level user credentials: ${tenants.length}`);
  console.log('');

  for (const t of tenants) {
    const users = await usersOf(client, t.id);
    console.log(`${TAG} tenant ${label(t)}`);
    console.log(`         users on this tenant: ${users.length}${users.length ? ' → ' + users.map((u) => `#${u.id} ${u.email}`).join(', ') : ''}`);

    if (users.length === 0) {
      console.log('         SKIPPED — no users row; nothing to attach these credentials to.');
      console.log('                   tenant_tokens left in place (still read as a fallback).');
      report.skippedNoUser.push(label(t));
      console.log('');
      continue;
    }
    if (users.length > 1) {
      console.log(`         SKIPPED — ${users.length} users share this tenant; owner is ambiguous.`);
      console.log('                   Resolve by hand, then re-run. Nothing written.');
      report.skippedAmbiguous.push(label(t));
      console.log('');
      continue;
    }

    const user = users[0];

    // --- tokens ---
    for (const service of USER_SERVICES) {
      const src = await client.query(
        `SELECT access_token, refresh_token, expires_at FROM tenant_tokens
          WHERE tenant_id = $1 AND service = $2 AND access_token IS NOT NULL LIMIT 1`,
        [t.id, service]
      );
      if (src.rowCount === 0) continue;

      // Never overwrite a token the user already holds.
      const ins = await client.query(
        `INSERT INTO user_tokens (user_id, service, access_token, refresh_token, expires_at, updated_at)
              VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (user_id, service) DO NOTHING
           RETURNING user_id`,
        [user.id, service, src.rows[0].access_token, src.rows[0].refresh_token, src.rows[0].expires_at]
      );
      if (ins.rowCount === 1) {
        console.log(`         token ${service} → user #${user.id} (copied; tenant_tokens row kept)`);
        report.tokensMoved++;
      } else {
        console.log(`         token ${service} → user #${user.id} already present, left alone`);
        report.tokensAlreadyPresent++;
      }
    }

    // --- slack link ---
    if (t.slack_team_id && t.slack_user_id) {
      const holder = await client.query(
        'SELECT user_id FROM user_slack_links WHERE slack_team_id = $1 AND slack_user_id = $2',
        [t.slack_team_id, t.slack_user_id]
      );
      if (holder.rowCount === 0) {
        await client.query(
          `INSERT INTO user_slack_links (user_id, slack_team_id, slack_user_id)
                VALUES ($1, $2, $3)`,
          [user.id, t.slack_team_id, t.slack_user_id]
        );
        console.log(
          `         slack link ${t.slack_team_id}/${t.slack_user_id} → user #${user.id} (tenants.slack_* kept)`
        );
        report.linksMoved++;
      } else if (String(holder.rows[0].user_id) === String(user.id)) {
        console.log(`         slack link ${t.slack_team_id}/${t.slack_user_id} already on user #${user.id}, left alone`);
        report.linksAlreadyPresent++;
      } else {
        console.log(
          `         SLACK LINK CONFLICT — ${t.slack_team_id}/${t.slack_user_id} is already ` +
            `held by user #${holder.rows[0].user_id}, not #${user.id}. Left alone; resolve by hand.`
        );
        report.linkConflicts.push(`${label(t)} → ${t.slack_team_id}/${t.slack_user_id}`);
      }
    }
    console.log('');
  }
}

function printReport(report) {
  console.log(`${TAG} ---------------- SUMMARY ----------------`);
  console.log(`${TAG} tokens moved to a user:        ${report.tokensMoved}`);
  console.log(`${TAG} tokens already on a user:      ${report.tokensAlreadyPresent}`);
  console.log(`${TAG} slack links moved to a user:   ${report.linksMoved}`);
  console.log(`${TAG} slack links already on a user: ${report.linksAlreadyPresent}`);
  console.log(`${TAG} skipped, tenant has NO users:  ${report.skippedNoUser.length}`);
  for (const s of report.skippedNoUser) console.log(`${TAG}     - ${s}`);
  console.log(`${TAG} skipped, >1 user (ambiguous):  ${report.skippedAmbiguous.length}`);
  for (const s of report.skippedAmbiguous) console.log(`${TAG}     - ${s}`);
  console.log(`${TAG} slack link conflicts:          ${report.linkConflicts.length}`);
  for (const s of report.linkConflicts) console.log(`${TAG}     - ${s}`);
  console.log(`${TAG} -----------------------------------------`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`${TAG} DATABASE_URL is not set in this environment.`);
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error(`${TAG} could not load "pg": ` + err.message);
    process.exit(1);
  }

  console.log(
    `${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`
  );
  console.log('');

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  const report = {
    tokensMoved: 0,
    tokensAlreadyPresent: 0,
    linksMoved: 0,
    linksAlreadyPresent: 0,
    skippedNoUser: [],
    skippedAmbiguous: [],
    linkConflicts: [],
  };

  try {
    await client.connect();
    await assertSchema(client);

    await client.query('BEGIN');
    try {
      await run(client, report);
      printReport(report);
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
    }
  } catch (err) {
    console.error(`${TAG} FAILED: ` + (err && err.message ? err.message : err));
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main();
