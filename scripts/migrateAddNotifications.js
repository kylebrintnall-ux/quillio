'use strict';

// Migration — notifications: something the product wants to tell a user, stored
// so it survives the tab being closed.
//
// WHY THIS EXISTS. A web-originated draft runs 30-90s behind an in-memory job
// (routes/app.js JOBS) that the browser polls every 3s. When it finishes, the
// only thing that happens is a 2-second toast in the tab that started it
// (app.html showToast). Close the tab, background it past the timers, or restart
// the server, and the draft still completes and still writes the Google Doc —
// and the person is told NOTHING, ever. The Slack surface has always posted a
// completion card; the web surface has had no equivalent. This is the store
// behind one.
//
// GENERIC FROM THE START, because more than one event will use it. `type` is the
// event kind, `message` is the sentence, `link` is a structured routing target,
// `project_id` is an optional reference to what it concerns. Nothing here is
// draft-specific.
//
// ============================================================================
// READ STATE: A TENANT-LEVEL ROW PLUS A SEPARATE READS TABLE
// ============================================================================
//
// The two candidates were (a) one notification row per USER, with read_at on the
// row, and (b) one row per tenant EVENT with reads in their own table. (a) is
// one table and a trivial read query, and at a scale where most tenants hold one
// person it is genuinely tempting. It was rejected on three grounds, the first
// of which is a fact about this codebase rather than a preference:
//
//  1. THE WRITE PATH CANNOT RELIABLY ENUMERATE THE USERS. (a) requires fanning
//     out to `SELECT id FROM users WHERE tenant_id = $1` at draft-completion
//     time. In demo mode middleware/auth.js attaches `{ id: null }` and
//     db.js resolveTenant returns `user: null`, so there is no key to write
//     against and a demo draft would produce ZERO notifications — silently,
//     inside the catch that keeps a notification failure from failing a draft.
//     (b) needs only the tenant, which that path always has.
//
//  2. THE PRODUCT'S VISIBILITY MODEL IS ALREADY TENANT-SCOPED. db/projects.js
//     getProjects(tenantId) returns every project in the workspace to everyone
//     in it; routes/app.js scopes every read from req.user.tenant_id. "A draft
//     finished" is a fact about the workspace, and modelling it per person would
//     be the first place in this codebase where those two diverge.
//
//  3. ONE EVENT IS ONE ROW. (a) copies the type, message and link target N times
//     to store one timestamp per person, so the copies can drift, and somebody
//     who joins the tenant tomorrow sees no history at all.
//
// The cost of (b) is a LEFT JOIN on an indexed primary key over a per-tenant
// list that the read endpoint already caps with LIMIT. That is not a scale
// concern at any size this product reaches.
//
// SO "WHEN IT WAS READ" LIVES ON notification_reads.read_at, NOT ON THE
// NOTIFICATION. A notification has no single read time — it has one per person
// who has read it, and none for everyone who has not.
//
// ON CONFLICT DO NOTHING on that table is what makes read_at the FIRST time the
// person read it rather than the last time they scrolled past it, which is the
// meaning the column name claims.
//
// A USER WITH NO ROW CANNOT RECORD A READ, and that degrades honestly: demo mode
// has no users row, so notification_reads stays empty and everything reads as
// unread. Nothing breaks, nothing lies.
//
// Two tables and two indexes, no backfill, no existing data touched. Safe to run
// before or after the code deploy — db/notifications.js catches 42P01 and
// degrades to "no notifications", so a deploy landing first writes nothing and
// reads an empty list, per CLAUDE.md's "either deploy order is safe".
//
// Idempotent (IF NOT EXISTS). Dry run by default; --commit writes.
//
// Run it in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateAddNotifications.js            # dry run
//   node scripts/migrateAddNotifications.js --commit   # write

const { Pool } = require('pg');

const TAG = '[notifications]';
const COMMIT = process.argv.includes('--commit');

const STATEMENTS = [
  [
    'notifications',
    // tenant_id is TEXT REFERENCES tenants(id) exactly as projects.tenant_id is,
    // so a tenant that can save a project can raise a notification. It is NOT
    // NULL where projects.tenant_id is nullable, and that difference is
    // deliberate: the read endpoint filters on tenant, so a null-tenant row is
    // unreadable by construction — an orphan nobody would ever find. Failing the
    // insert is better than storing one.
    //
    // type is TEXT, not an enum. Every other closed vocabulary here is TEXT with
    // a comment (projects.status, spec_review_queue.status,
    // spec_watch_list.source_kind), and an enum would need a migration to add
    // each new event kind — which is the opposite of what "generic from the
    // start" is for.
    //
    // link is JSONB and nullable: a structured routing target so the UI never
    // parses a string to decide where to go. Today's writer stores
    //   {"screen":"project","projectId":<id>,"doc":"copy"|"template"}
    // which is the argument pair app.html's openProject(project, kind) already
    // takes. Nullable because an event type may have nowhere to send anyone.
    //
    // project_id is ON DELETE SET NULL rather than a plain FK: nothing in this
    // codebase deletes a project (setProjectStatus 'closed' is the retire path,
    // and it never deletes), but a notification must not be the reason a delete
    // is refused if one is ever added. The message stands on its own without it.
    `CREATE TABLE IF NOT EXISTS notifications (
       id         BIGSERIAL PRIMARY KEY,
       tenant_id  TEXT NOT NULL REFERENCES tenants(id),
       type       TEXT NOT NULL,
       message    TEXT NOT NULL,
       link       JSONB,
       project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  ],
  [
    'index ix_notifications_tenant_created',
    // The read endpoint's driving index: every read is "this tenant's, newest
    // first". DESC matches the ORDER BY so the scan needs no sort.
    `CREATE INDEX IF NOT EXISTS ix_notifications_tenant_created
       ON notifications (tenant_id, created_at DESC)`,
  ],
  [
    'notification_reads',
    // One row per (notification, person who has read it). Absence IS unread —
    // there is no false-valued row and nothing to backfill when somebody joins.
    //
    // The composite PRIMARY KEY does three jobs: it makes a double mark-read an
    // idempotent no-op via ON CONFLICT DO NOTHING, it keeps read_at meaning the
    // FIRST read, and its leading column (notification_id) serves the read
    // query's join, which is driven from notifications — so no extra index is
    // needed here and none is created.
    //
    // ON DELETE CASCADE both ways: a read is meaningless without its
    // notification, and a departed user's read state is not worth keeping.
    `CREATE TABLE IF NOT EXISTS notification_reads (
       notification_id BIGINT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
       user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (notification_id, user_id)
     )`,
  ],
  [
    'index ix_notification_reads_user',
    // Not for the read endpoint (the PK covers that join). This one answers
    // "everything this person has read", which is what a per-user cleanup or a
    // future digest would ask, and what a user delete cascades through.
    `CREATE INDEX IF NOT EXISTS ix_notification_reads_user
       ON notification_reads (user_id)`,
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
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name IN ('notifications', 'notification_reads')
        ORDER BY table_name, ordinal_position`
    );
    console.log(`\n${TAG} columns:`);
    for (const r of cols.rows) {
      console.log(
        `  ${r.table_name.padEnd(19)} ${r.column_name.padEnd(16)} ` +
          `${r.data_type.padEnd(26)} null=${r.is_nullable}`
      );
    }

    const counts = await client.query(
      `SELECT (SELECT count(*)::int FROM notifications)      AS notifications,
              (SELECT count(*)::int FROM notification_reads) AS reads,
              (SELECT count(*)::int FROM tenants)            AS tenants,
              (SELECT count(*)::int FROM users)              AS users`
    );
    const c = counts.rows[0];
    console.log(
      `\n${TAG} ${c.notifications} notification(s), ${c.reads} read row(s), ` +
        `across ${c.tenants} tenant(s) and ${c.users} user(s)`
    );
    console.log(
      `${TAG} absence of a notification_reads row IS unread — there is nothing to\n` +
        `${TAG} backfill, and a person who joins later sees the tenant's history unread.`
    );

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`\n${TAG} COMMITTED.`);
    } else {
      await client.query('ROLLBACK');
      console.log(`\n${TAG} ROLLED BACK (dry run) — no changes were written. Re-run with --commit to apply.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`\n${TAG} ROLLED BACK — nothing was written.`);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run only when invoked directly. Requiring this module (the smoke test does)
// must NOT connect to a database.
if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { STATEMENTS };
