'use strict';

// Slack OAuth install flow (Phase 3). Lets a workspace install Quillio by
// granting access, then stores the issued bot + user tokens per tenant. Does
// not touch the slash-command / interactions handlers. All DB writes degrade
// gracefully when DATABASE_URL is unset (see db.js).

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { createTenantIfMissing, saveTenantToken } = require('../db');
const { seedTenantAssets } = require('../db/assets');

const router = express.Router();

const BOT_SCOPES = 'commands,chat:write,chat:write.public,channels:history,users:read,im:write';
const USER_SCOPES = 'canvases:read,files:read';

// CSRF state store. Cookies don't survive the cross-site OAuth redirect in
// Safari/iPad (ITP), so we keep issued state values in-process with a short TTL
// instead. (Single-process scope — fine for the demo; the durable version would
// store this in Postgres/Redis once we're multi-instance.)
const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const pendingStates = new Map(); // state -> created timestamp (ms)

// Remember a freshly-issued state, pruning anything expired so the Map can't
// grow unbounded.
function rememberState(state) {
  const now = Date.now();
  for (const [s, ts] of pendingStates) {
    if (now - ts > STATE_TTL_MS) pendingStates.delete(s);
  }
  pendingStates.set(state, now);
}

// Validate + consume a state on callback: it must be one we issued, unexpired,
// and is deleted after this single use. Returns true only if valid.
function consumeState(state) {
  if (!state) return false;
  const ts = pendingStates.get(state);
  if (ts === undefined) return false;
  pendingStates.delete(state); // one-time use
  return Date.now() - ts <= STATE_TTL_MS;
}

// Step 1 — start the install: issue a CSRF state, store it, redirect to Slack.
router.get('/oauth/slack', (req, res) => {
  if (!config.SLACK_CLIENT_ID || !config.SLACK_REDIRECT_URI) {
    console.error('[oauth] SLACK_CLIENT_ID / SLACK_REDIRECT_URI not configured');
    return res.redirect('/welcome?error=install_failed');
  }

  const state = crypto.randomBytes(16).toString('hex');
  rememberState(state);

  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', config.SLACK_CLIENT_ID);
  url.searchParams.set('scope', BOT_SCOPES);
  url.searchParams.set('user_scope', USER_SCOPES);
  url.searchParams.set('redirect_uri', config.SLACK_REDIRECT_URI);
  url.searchParams.set('state', state);
  return res.redirect(url.toString());
});

// Step 2 — Slack redirects back with ?code & ?state. Verify, exchange, store.
router.get('/oauth/slack/callback', async (req, res) => {
  try {
    // User declined, or Slack returned an error.
    if (req.query.error) {
      console.warn('[oauth] authorize declined/error:', req.query.error);
      return res.redirect('/welcome?error=access_denied');
    }

    // CSRF: the state in the URL must be one we issued, unexpired, unused.
    if (!consumeState(req.query.state)) {
      console.error('[oauth] state missing/expired/mismatch — aborting install');
      return res.redirect('/welcome?error=install_failed');
    }

    const code = req.query.code;
    if (!code) {
      console.error('[oauth] callback missing code');
      return res.redirect('/welcome?error=install_failed');
    }
    if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET || !config.SLACK_REDIRECT_URI) {
      console.error('[oauth] Slack OAuth env not configured');
      return res.redirect('/welcome?error=install_failed');
    }

    // Exchange the code for tokens.
    const resp = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.SLACK_CLIENT_ID,
        client_secret: config.SLACK_CLIENT_SECRET,
        code: String(code),
        redirect_uri: config.SLACK_REDIRECT_URI,
      }),
    });
    const data = await resp.json();
    if (!data.ok) {
      console.error('[oauth] oauth.v2.access failed:', data.error);
      return res.redirect('/welcome?error=install_failed');
    }

    const teamId = data.team && data.team.id;
    const teamName = data.team && data.team.name;
    const botToken = data.access_token;
    const userToken = data.authed_user && data.authed_user.access_token;

    if (!teamId) {
      console.error('[oauth] no team id in oauth response');
      return res.redirect('/welcome?error=install_failed');
    }

    // Create the tenant and store the issued tokens (best-effort — these no-op
    // and log if there's no database configured).
    await createTenantIfMissing(teamId, teamName);
    if (botToken) await saveTenantToken(teamId, 'slack_bot', botToken);
    if (userToken) await saveTenantToken(teamId, 'slack_user', userToken);

    // Seed the default asset library for this tenant (best-effort, idempotent —
    // no-ops without a DB, skips if already seeded). Never block the install if
    // seeding fails; the tenant can still use the Sheet-backed pipeline.
    try {
      await seedTenantAssets(teamId);
    } catch (e) {
      console.error('[oauth] seedTenantAssets failed (continuing):', e.message);
    }

    console.log(
      `[oauth] install OK — team ${teamId} (${teamName || '?'}) bot=${!!botToken} user=${!!userToken}`
    );
    return res.redirect('/welcome');
  } catch (err) {
    // Never leak a stack trace to the browser — log it, show a generic page.
    console.error('[oauth] callback error:', err && err.stack ? err.stack : err);
    return res.redirect('/welcome?error=install_failed');
  }
});

// Placeholder post-install page.
router.get('/welcome', (req, res) => {
  // Only ever reflect a sanitized known error code (no user-controlled HTML).
  const code = String(req.query.error || '').replace(/[^a-z_]/gi, '');
  const body = code
    ? `<h1>Install didn't finish</h1><p>Something went wrong (<code>${code}</code>). Please try again.</p>`
    : `<h1>You're connected 🎉</h1><p>Quillio is installed in your workspace. Head back to Slack and try <code>/quillio</code>.</p>`;
  res
    .status(200)
    .type('html')
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Quillio</title></head>` +
        `<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem;">${body}</body></html>`
    );
});

module.exports = router;
