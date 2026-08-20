'use strict';

// Notification accessors — the store behind "tell somebody something later".
//
// SHAPE. One row per TENANT EVENT in `notifications`; read state lives per
// person in `notification_reads`, whose absence IS unread. The reasoning for
// that split (rather than one row per user with read_at on it) is written out in
// scripts/migrateAddNotifications.js and not repeated here — the short version
// is that the write path does not reliably know the tenant's users, because demo
// mode has no users row at all.
//
// PRE-MIGRATION TOLERANCE. Every function here catches 42P01 (undefined_table)
// and degrades to the pre-migration behaviour: createNotification returns null,
// listNotifications returns an empty page, markRead returns 0. Railway
// auto-deploys main on merge, so this code runs against an unmigrated database
// first and must not break a draft or a page load when it does. The catch
// matches ONLY that SQLSTATE — a permissions or connectivity failure still
// throws, exactly as db.js's other tolerances do.

const { getPool, isUndefinedTable, warnMissingSchema } = require('../db');

const MIGRATION = 'scripts/migrateAddNotifications.js';

// The read endpoint's page size. A cap rather than a preference: this list is
// read on every poll of whatever surface ends up showing it, and an unbounded
// "everything this tenant ever did" grows without limit. 50 is well past what a
// panel shows and cheap on the (tenant_id, created_at DESC) index.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// How far back a notification is shown. Older rows STAY IN THE TABLE — this is a
// filter, not a retention policy, and nothing here deletes.
//
// IT LIVES IN THE WHERE CLAUSE, WHICH IS THE WHOLE POINT. `unread_total` is a
// window function over the result set, so a predicate in WHERE is applied before
// the count is taken and the list and the count cannot disagree by construction.
// Filtering after the query — here in JS, or in each caller — would leave a count
// that includes rows the panel does not show, which is the one bug this store's
// no-separate-count-endpoint design exists to prevent.
//
// AND THE CUTOFF IS THE DATABASE'S CLOCK, NOT THE PROCESS'S. `NOW()` is the
// transaction timestamp, so it is fixed for the statement and there is exactly
// one clock deciding it. A cutoff computed in JavaScript would be one clock PER
// APP INSTANCE, and Railway can run more than one: a row within a second of the
// boundary would then be present or absent depending on which instance answered
// the poll, appearing and disappearing while nothing about it changed. Reading
// the boundary off the row's own database is what makes crossing it a
// one-directional event rather than a race.
const WINDOW_DAYS = 7;

// Write one notification. Returns the saved row, or null when there is no
// database or the table does not exist yet.
//
// tenantId is REQUIRED and the column is NOT NULL: reads filter on tenant, so a
// tenant-less row could never be found by anyone. Refusing here rather than
// storing an orphan.
async function createNotification({ tenantId, type, message, link, projectId } = {}) {
  const pool = getPool();
  if (!pool) {
    console.warn('[db/notifications] DATABASE_URL not set — skipping createNotification');
    return null;
  }
  if (!tenantId || !type || !message) {
    console.warn('[db/notifications] createNotification needs tenantId, type and message');
    return null;
  }
  try {
    const res = await pool.query(
      `INSERT INTO notifications (tenant_id, type, message, link, project_id)
         VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id, tenant_id, type, message, link, project_id, created_at`,
      [tenantId, type, message, link == null ? null : JSON.stringify(link), projectId || null]
    );
    return res.rows[0] || null;
  } catch (err) {
    if (isUndefinedTable(err)) {
      warnMissingSchema('notifications', MIGRATION);
      return null;
    }
    throw err;
  }
}

// A tenant's notifications, UNREAD FIRST then newest first, with this user's own
// read state attached.
//
// `userId` may be null (demo mode has no users row). Then the LEFT JOIN matches
// nothing, every row comes back unread, and the count is the whole page — which
// is the honest answer for a caller with no identity to record reads against.
//
// THE UNREAD COUNT RIDES ALONG rather than living on its own endpoint. The
// window function is evaluated BEFORE the LIMIT, so `unreadCount` counts the
// tenant's unread rows in full, not the ones on this page. A separate
// /unread-count endpoint would be a second round trip for a number this query
// already has in hand.
//
// ANYTHING OLDER THAN WINDOW_DAYS IS INVISIBLE HERE — absent from the rows AND
// uncounted, because the age predicate sits in WHERE and the count is taken over
// what WHERE returned. The row is untouched; only this read stops returning it.
// A tenant whose notifications are all older than the window gets
// `{ notifications: [], unreadCount: 0 }`, which is the same shape as a tenant
// with none at all — deliberately, since "nothing to show you" is one state.
async function listNotifications(tenantId, userId, limit = DEFAULT_LIMIT) {
  const empty = { notifications: [], unreadCount: 0 };
  const pool = getPool();
  if (!pool || !tenantId) return empty;
  const cap = Math.max(1, Math.min(MAX_LIMIT, parseInt(limit, 10) || DEFAULT_LIMIT));
  try {
    const res = await pool.query(
      `SELECT n.id,
              n.type,
              n.message,
              n.link,
              n.project_id,
              n.created_at,
              r.read_at,
              COUNT(*) FILTER (WHERE r.read_at IS NULL) OVER () AS unread_total
         FROM notifications n
         LEFT JOIN notification_reads r
                ON r.notification_id = n.id
               AND r.user_id = $2
        WHERE n.tenant_id = $1
          AND n.created_at > NOW() - make_interval(days => $4)
        ORDER BY (r.read_at IS NOT NULL), n.created_at DESC, n.id DESC
        LIMIT $3`,
      [tenantId, userId || null, cap, WINDOW_DAYS]
    );
    const rows = res.rows || [];
    return {
      notifications: rows.map((r) => ({
        id: Number(r.id),
        type: r.type,
        message: r.message,
        link: r.link || null,
        projectId: r.project_id == null ? null : Number(r.project_id),
        createdAt: r.created_at,
        readAt: r.read_at || null,
      })),
      // Off the window function, so it is the tenant's true unread total even
      // when the page is capped. Zero rows means zero unread.
      unreadCount: rows.length ? Number(rows[0].unread_total) : 0,
    };
  } catch (err) {
    if (isUndefinedTable(err)) {
      warnMissingSchema('notifications', MIGRATION);
      return empty;
    }
    throw err;
  }
}

// Mark the named notifications read for one user. Returns how many rows were
// newly marked (an already-read one counts 0 — the insert is a no-op).
//
// TENANT-SCOPED IN THE INSERT ITSELF. The SELECT that feeds the insert filters
// on tenant_id, so an id belonging to another tenant is silently skipped rather
// than marked. The caller passes a tenant from the session, so this cannot be
// used to touch a stranger's row by guessing an id.
//
// ON CONFLICT DO NOTHING keeps read_at as the FIRST read rather than the latest,
// and makes a repeated call idempotent.
//
// NO AGE PREDICATE HERE, ON PURPOSE. listNotifications' window decides what is
// SHOWN; this records that somebody read what they were shown. A panel left open
// across the boundary would post an id that has just aged out, and refusing it
// would turn a race into a failed write for no gain — the row is invisible
// either way, so marking it read is harmless and honest. Adding the predicate
// would also make a read silently do nothing at exactly the moment the two
// clocks disagree, which is worse than the no-op it replaces.
async function markNotificationsRead(tenantId, userId, ids) {
  const pool = getPool();
  if (!pool || !tenantId || !userId) return 0;
  const clean = (Array.isArray(ids) ? ids : [])
    .map((n) => parseInt(n, 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, MAX_LIMIT);
  if (clean.length === 0) return 0;
  try {
    const res = await pool.query(
      `INSERT INTO notification_reads (notification_id, user_id)
       SELECT n.id, $2
         FROM notifications n
        WHERE n.tenant_id = $1
          AND n.id = ANY($3::bigint[])
       ON CONFLICT (notification_id, user_id) DO NOTHING`,
      [tenantId, userId, clean]
    );
    return res.rowCount || 0;
  } catch (err) {
    if (isUndefinedTable(err)) {
      warnMissingSchema('notifications', MIGRATION);
      return 0;
    }
    throw err;
  }
}

module.exports = {
  createNotification,
  listNotifications,
  markNotificationsRead,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  WINDOW_DAYS,
};
