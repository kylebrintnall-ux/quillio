'use strict';

// Slack OAuth install flow (Phase 3). Lets a workspace install Quillio by
// granting access, then stores the issued bot + user tokens per tenant. Does
// not touch the slash-command / interactions handlers. All DB writes degrade
// gracefully when DATABASE_URL is unset (see db.js).

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { createTenantIfMissing, saveTenantToken } = require('../db');

const router = express.Router();

const STATE_COOKIE = 'quillio_oauth_state';
const BOT_SCOPES = 'commands,chat:write,chat:write.public,channels:history,users:read,im:write';
const USER_SCOPES = 'canvases:read,files:read';
const STATE_COOKIE_BASE = `${STATE_COOKIE}=`;

// Read a named cookie from the request (avoids a cookie-parser dependency).
function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

// Step 1 — start the install: set a CSRF state cookie, redirect to Slack.
router.get('/oauth/slack', (req, res) => {
  if (!config.SLACK_CLIENT_ID || !config.SLACK_REDIRECT_URI) {
    console.error('[oauth] SLACK_CLIENT_ID / SLACK_REDIRECT_URI not configured');
    return res.redirect('/welcome?error=install_failed');
  }

  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader(
    'Set-Cookie',
    `${STATE_COOKIE_BASE}${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`
  );

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

    // CSRF: the state in the URL must match the cookie we set in step 1.
    const cookieState = readCookie(req, STATE_COOKIE);
    if (!req.query.state || !cookieState || req.query.state !== cookieState) {
      console.error('[oauth] state mismatch — possible CSRF; aborting install');
      return res.redirect('/welcome?error=install_failed');
    }
    // One-time use: clear the state cookie now that it's been consumed.
    res.setHeader(
      'Set-Cookie',
      `${STATE_COOKIE_BASE}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
    );

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
