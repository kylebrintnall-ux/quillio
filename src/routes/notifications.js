'use strict';

// Notifications API — the tenant's stored notifications, and marking them read.
//
// DATA AND API ONLY. Nothing renders this yet; no page fetches it. It exists so
// a web draft that finishes after the tab is closed leaves a trace somebody can
// be shown later, and so the surface that shows it is a separate piece of work
// rather than a prerequisite.
//
// ITS OWN ROUTER, NOT A GROWTH OF routes/app.js. That file is 650 lines and
// already carries the in-memory job store, the upload sanitizers and the whole
// brief/draft/review surface. One router per product area is the convention here
// (oauth, onboarding, settings, headerTemplate, admin), and this is an area.
//
// EVERY SCOPE COMES FROM req.user, NEVER FROM THE CLIENT. app.html carries a
// hardcoded `var WORKSPACE_ID = 'T0B8LPRDKHR'` that it sends on every request and
// that the server correctly ignores today — no route reads a client-supplied
// workspaceId, and this one does not become the first. The tenant is
// req.user.tenant_id and the reader is req.user.id, both put there by
// requireAuth.
//
// NO SEPARATE UNREAD-COUNT ENDPOINT. The read endpoint returns `unreadCount`
// off a window function in the same query, computed before the LIMIT, so it is
// the tenant's true unread total rather than the count on this page. A second
// endpoint would be a second round trip for a number already in hand.

const express = require('express');

const { requireAuth } = require('../middleware/auth');
const { listNotifications, markNotificationsRead, MAX_LIMIT } = require('../db/notifications');
const { clientErrorMessage } = require('../utils/errors');

const router = express.Router();

// The demo tenant — the same constant every other web router falls back to when
// a session carries no tenant (demo mode attaches one with no database behind
// it).
const DEFAULT_WORKSPACE_ID = 'T0B8LPRDKHR';

function tenantOf(req) {
  return (req.user && req.user.tenant_id) || DEFAULT_WORKSPACE_ID;
}

// The acting user, or null. Demo mode has no users row, so read state cannot be
// recorded for it — listNotifications returns everything unread, which is the
// honest answer rather than an error.
function readerOf(req) {
  return (req.user && req.user.id) || null;
}

// GET /api/notifications — this tenant's notifications, unread first then newest
// first, each carrying this user's own read state.
//
// ?limit is clamped in the data layer (1..MAX_LIMIT, default 50); an
// absent or junk value takes the default rather than erroring, because a bad
// query string should not blank a panel.
router.get('/api/notifications', requireAuth, async (req, res) => {
  // Mutable per-user state — never cache. Otherwise an edge cache can serve one
  // person's read state to another, or a stale unread count after a mark-read.
  res.set('Cache-Control', 'no-store');
  try {
    const { notifications, unreadCount } = await listNotifications(
      tenantOf(req),
      readerOf(req),
      req.query.limit
    );
    return res.status(200).json({ success: true, notifications, unreadCount });
  } catch (err) {
    console.error('[web] GET /api/notifications failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

// POST /api/notifications/read — mark one or more notifications read for the
// signed-in user. Body: { ids: [1, 2, 3] }.
//
// The ids are the ONLY thing taken from the client, and they are not trusted to
// name rows this tenant owns: the data layer's insert filters on tenant_id, so
// an id from another tenant is skipped rather than marked. That is why the
// response reports `marked` (how many rows were newly written) rather than
// echoing the request — a caller learns nothing about whether an id it does not
// own exists.
//
// Marking something already read is a no-op that still answers 200. It is an
// idempotent operation and a UI may well fire it twice.
router.post('/api/notifications/read', requireAuth, async (req, res) => {
  const ids = (req.body || {}).ids;
  if (!Array.isArray(ids)) {
    return res.status(400).json({ success: false, error: 'ids must be an array' });
  }
  if (ids.length > MAX_LIMIT) {
    return res.status(400).json({ success: false, error: `At most ${MAX_LIMIT} ids per request` });
  }
  const userId = readerOf(req);
  if (!userId) {
    // No users row to attribute the read to (demo mode). Reporting success with
    // 0 marked is the truth: nothing failed, and nothing was recorded.
    return res.status(200).json({ success: true, marked: 0 });
  }
  try {
    const marked = await markNotificationsRead(tenantOf(req), userId, ids);
    console.log(`[web] POST /api/notifications/read → marked ${marked} of ${ids.length}`);
    return res.status(200).json({ success: true, marked });
  } catch (err) {
    console.error('[web] POST /api/notifications/read failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

module.exports = router;
