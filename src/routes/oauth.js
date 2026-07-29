'use strict';

// Slack OAuth install flow (Phase 3). Lets a workspace install Quillio by
// granting access, then stores the issued bot + user tokens per tenant. Does
// not touch the slash-command / interactions handlers. All DB writes degrade
// gracefully when DATABASE_URL is unset (see db.js).

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { createTenantIfMissing, saveTenantToken, getPool, getTenantByWorkspace } = require('../db');
const { seedTenantAssets } = require('../db/assets');
const {
  findUserByGoogleId,
  findUserById,
  createUser,
  saveUserToken,
  linkSlackIdentityToUser,
} = require('../db/users');

// Post-OAuth landing destinations we accept via ?redirect=… (whitelist).
const ALLOWED_REDIRECTS = ['onboarding', 'settings'];
function pickRedirect(value) {
  return ALLOWED_REDIRECTS.includes(value) ? value : null;
}

const router = express.Router();

// Only the scopes the code actually uses, so the consent screen matches
// reality and manifest.json can mirror it exactly:
//   commands          — the /quillio + /quillio-review slash commands
//   chat:write        — chat.postMessage (services/slack.js)
//   chat:write.public — post to channels the bot hasn't been invited to
// channels:history / users:read / im:write were requested here for a while
// with no caller; nothing in src/ hits conversations.history, users.info or
// conversations.open, so they're gone.
const BOT_SCOPES = 'commands,chat:write,chat:write.public';
// files:read + canvases:read back fetchSlackCanvasContent (core/pipeline.js),
// which reads Slack Canvas links out of a brief via files.info. Kept — the
// user token is preferred there because the bot identity gets `not_visible`
// on user-owned canvases.
const USER_SCOPES = 'canvases:read,files:read';

// Google OAuth. drive.file = files this app creates; documents = read/write
// those docs (no access to pre-existing Drive files). userinfo.email/profile
// power "Sign in with Google" (identity for the users table + session).
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

// CSRF state store. Cookies don't survive the cross-site OAuth redirect in
// Safari/iPad (ITP), so we keep issued state values in-process with a short TTL
// instead. (Single-process scope — fine for the demo; the durable version would
// store this in Postgres/Redis once we're multi-instance.)
const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const pendingStates = new Map(); // state -> { ts, data }

// Remember a freshly-issued state (with optional associated data, e.g. the
// workspace id for the Google flow), pruning anything expired so the Map can't
// grow unbounded.
function rememberState(state, data) {
  const now = Date.now();
  for (const [s, entry] of pendingStates) {
    if (now - entry.ts > STATE_TTL_MS) pendingStates.delete(s);
  }
  pendingStates.set(state, { ts: now, data: data || null });
}

// Validate + consume a state on callback: it must be one we issued, unexpired,
// and is deleted after this single use. Returns the stored entry (truthy) when
// valid, or false otherwise — so `if (!consumeState(...))` still guards, and
// callers that stored data can read entry.data.
function consumeState(state) {
  if (!state) return false;
  const entry = pendingStates.get(state);
  if (entry === undefined) return false;
  pendingStates.delete(state); // one-time use
  if (Date.now() - entry.ts > STATE_TTL_MS) return false;
  return entry;
}

// Non-destructive read of a pending state — same validity checks as consumeState
// but WITHOUT the delete/one-time-use. Lets the declined/error path learn `mode`
// without consuming a state the normal flow may still need. Returns the entry, or
// null if unknown/expired.
function peekState(state) {
  if (!state) return null;
  const entry = pendingStates.get(state);
  if (entry === undefined) return null;
  if (Date.now() - entry.ts > STATE_TTL_MS) return null;
  return entry;
}

// Self-contained page returned to a POPUP-mode Slack callback: message the opener
// with the result, then close. The <p> line is the fallback shown if the inline
// script is blocked. `status` is 'connected' | 'conflict' | 'failed'.
//
// 'conflict' is its own status on purpose: that Slack account is already linked
// to a different Quillio user, so reporting "connected" would leave the person
// believing /quillio runs as them while it keeps resolving to someone else.
const SLACK_POPUP_LINES = {
  connected: 'Slack connected — you can close this window.',
  conflict:
    'That Slack account is already connected to a different Quillio user, ' +
    'so it was not linked. Sign in as that user, or connect a different Slack account.',
  failed: 'Slack connection failed — you can close this window.',
};
function slackPopupResult(status) {
  const safe = Object.prototype.hasOwnProperty.call(SLACK_POPUP_LINES, status) ? status : 'failed';
  const line = SLACK_POPUP_LINES[safe];
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Quillio</title></head>' +
    '<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">' +
    '<p>' + line + '</p>' +
    '<script>(function(){' +
    'try{if(window.opener){window.opener.postMessage({type:"slack",status:"' + safe + '"},location.origin);}}catch(e){}' +
    'try{window.close();}catch(e){}' +
    '})();</script>' +
    '</body></html>'
  );
}

// Step 1 — start the install: issue a CSRF state, store it, redirect to Slack.
router.get('/oauth/slack', (req, res) => {
  if (!config.SLACK_CLIENT_ID || !config.SLACK_REDIRECT_URI) {
    console.error('[oauth] SLACK_CLIENT_ID / SLACK_REDIRECT_URI not configured');
    return res.redirect('/welcome?error=install_failed');
  }

  // `redirect=onboarding|settings` returns the user there after install.
  // `mode=popup` carries through that this install runs inside a popup window, so
  // the callback replies with a self-closing page instead of redirecting.
  const redirectTo = pickRedirect(req.query.redirect);
  const mode = req.query.mode === 'popup' ? 'popup' : null;
  const state = crypto.randomBytes(16).toString('hex');
  rememberState(state, { redirectTo, mode });

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
  let popupMode = false; // set once state is read; lets the decline/catch reply in-popup too
  try {
    // User declined, or Slack returned an error. Slack still returns our `state`
    // here, so peek (non-destructively) to see if this was a popup install and, if
    // so, reply in-popup rather than redirect and strand an orphaned window.
    if (req.query.error) {
      console.warn('[oauth] authorize declined/error:', req.query.error);
      const declined = peekState(req.query.state);
      if (declined && declined.data && declined.data.mode === 'popup') {
        consumeState(req.query.state); // done with it — clean up the popup path
        return res.set('Content-Type', 'text/html; charset=utf-8').send(slackPopupResult('failed'));
      }
      return res.redirect('/welcome?error=access_denied');
    }

    // CSRF: the state in the URL must be one we issued, unexpired, unused.
    const stateEntry = consumeState(req.query.state);
    if (!stateEntry) {
      // No state → we can't know if this was a popup (mode lived in the state), so
      // fall back to the classic redirect.
      console.error('[oauth] state missing/expired/mismatch — aborting install');
      return res.redirect('/welcome?error=install_failed');
    }
    const slackRedirectTo = stateEntry.data && stateEntry.data.redirectTo;
    popupMode = !!(stateEntry.data && stateEntry.data.mode === 'popup');
    // Popup-mode failures reply in the popup; non-popup keeps today's redirect.
    const failInstall = () =>
      popupMode ? res.set('Content-Type', 'text/html; charset=utf-8').send(slackPopupResult('failed')) : res.redirect('/welcome?error=install_failed');

    const code = req.query.code;
    if (!code) {
      console.error('[oauth] callback missing code');
      return failInstall();
    }
    if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET || !config.SLACK_REDIRECT_URI) {
      console.error('[oauth] Slack OAuth env not configured');
      return failInstall();
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
      return failInstall();
    }

    const teamId = data.team && data.team.id;
    const teamName = data.team && data.team.name;
    const botToken = data.access_token;
    const userToken = data.authed_user && data.authed_user.access_token;

    if (!teamId) {
      console.error('[oauth] no team id in oauth response');
      return failInstall();
    }

    // Create the tenant and store the issued tokens (best-effort — these no-op
    // and log if there's no database configured).
    await createTenantIfMissing(teamId, teamName);
    if (botToken) await saveTenantToken(teamId, 'slack_bot', botToken);
    if (userToken) await saveTenantToken(teamId, 'slack_user', userToken);

    // Slack-user link: when a SIGNED-IN Quillio user connects Slack, record
    // their Slack identity (team + user id) against THEIR USER ROW, so /quillio
    // can resolve (team_id + user_id) → user → that user's tenant. Keyed on the
    // identity, so every person on a tenant can hold their own link.
    //
    // A failure here is NOT swallowed. Previously a conflict was logged and the
    // install still reported success, leaving the person looking at "Slack
    // connected" while their commands resolved to a different tenant. Now it
    // surfaces (see the slackLinkFailure branch below the seeding).
    const slackUserId = data.authed_user && data.authed_user.id;
    let slackLinkFailure = null; // null | 'already_linked' | 'link_failed'
    if (req.session && req.session.userId && slackUserId) {
      try {
        const linkUser = await findUserById(req.session.userId);
        if (linkUser && linkUser.id) {
          const link = await linkSlackIdentityToUser(linkUser.id, teamId, slackUserId);
          if (link.ok) {
            console.log(
              `[oauth] slack link OK — user ${linkUser.id} (tenant ${linkUser.tenant_id}) ← team ${teamId} user ${slackUserId}`
            );
            // The Slack USER token belongs to the person who granted it, not to
            // the workspace. Store it on them so a second installer can't
            // replace the first's. The tenant-level copy written above stays as
            // the fallback for installs with nobody signed in.
            if (userToken) {
              try {
                await saveUserToken(linkUser.id, 'slack_user', userToken);
              } catch (e) {
                console.error('[oauth] per-user slack token save failed (continuing):', e.message);
              }
            }
          } else if (link.conflict) {
            slackLinkFailure = 'already_linked';
            console.warn(
              `[oauth] slack link REFUSED — team ${teamId} user ${slackUserId} is already linked to another Quillio user`
            );
          } else {
            slackLinkFailure = 'link_failed';
            console.error('[oauth] slack link did not run (no database?)');
          }
        }
      } catch (e) {
        slackLinkFailure = 'link_failed';
        console.error('[oauth] slack link failed:', e.message);
      }
    }

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

    // The bot install succeeded but this person's identity was NOT linked, so
    // their slash commands will not resolve to them. Say so instead of showing a
    // success screen they'd have no reason to doubt.
    if (slackLinkFailure) {
      if (popupMode) {
        return res
          .set('Content-Type', 'text/html; charset=utf-8')
          .send(slackPopupResult(slackLinkFailure === 'already_linked' ? 'conflict' : 'failed'));
      }
      if (slackRedirectTo === 'settings') return res.redirect(`/settings?slack=error&reason=${slackLinkFailure}`);
      if (slackRedirectTo === 'onboarding') return res.redirect(`/onboarding?slack=error&reason=${slackLinkFailure}`);
      return res.redirect(`/welcome?error=${slackLinkFailure}`);
    }

    // Popup mode: reply in the popup and let it signal the opener — checked BEFORE
    // the redirect branches so a popup install never navigates the top window.
    if (popupMode) return res.set('Content-Type', 'text/html; charset=utf-8').send(slackPopupResult('connected'));
    // Onboarding flow returns to Step 5 / Settings returns to /settings, each
    // with a connected flag; standalone installs land on the welcome page.
    if (slackRedirectTo === 'settings') return res.redirect('/settings?slack=connected');
    if (slackRedirectTo === 'onboarding') return res.redirect('/onboarding?slack=connected');
    return res.redirect('/welcome');
  } catch (err) {
    // Never leak a stack trace to the browser — log it, show a generic page.
    console.error('[oauth] callback error:', err && err.stack ? err.stack : err);
    if (popupMode) return res.set('Content-Type', 'text/html; charset=utf-8').send(slackPopupResult('failed'));
    return res.redirect('/welcome?error=install_failed');
  }
});

// Step 1 (Google) — start connecting a Google account: issue a CSRF state
// carrying the tenant's workspace id, then redirect to Google's consent screen.
router.get('/oauth/google', (req, res) => {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_REDIRECT_URI) {
    console.error('[oauth] GOOGLE_CLIENT_ID / GOOGLE_REDIRECT_URI not configured');
    return res.redirect('/app?error=google_failed');
  }

  // `redirect=onboarding|settings` returns the user there after sign-in.
  // NOTE: we intentionally do NOT accept a client-supplied workspaceId here
  // (audit HIGH 4) — a self-asserted workspace let a new user join an arbitrary
  // tenant. New users are assigned the default tenant; real workspace linking
  // will be wired separately.
  const redirectTo = pickRedirect(req.query.redirect);
  const state = crypto.randomBytes(16).toString('hex');
  rememberState(state, { redirectTo });

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', config.GOOGLE_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPES);
  url.searchParams.set('access_type', 'offline'); // ask for a refresh token
  url.searchParams.set('prompt', 'consent'); // force a refresh token every time
  url.searchParams.set('state', state);
  return res.redirect(url.toString());
});

// Step 2 (Google) — Google redirects back with ?code & ?state. Verify the
// state, exchange the code for a refresh token, and store it for the tenant.
router.get('/oauth/google/callback', async (req, res) => {
  try {
    if (req.query.error) {
      console.warn('[oauth] google authorize declined/error:', req.query.error);
      return res.redirect('/app?error=google_failed');
    }

    const entry = consumeState(req.query.state);
    if (!entry) {
      console.error('[oauth] google state missing/expired/mismatch — aborting');
      return res.redirect('/app?error=google_failed');
    }
    const code = req.query.code;
    if (!code) {
      console.error('[oauth] google callback missing code');
      return res.redirect('/app?error=google_failed');
    }
    if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET || !config.GOOGLE_REDIRECT_URI) {
      console.error('[oauth] Google OAuth env not configured');
      return res.redirect('/app?error=google_failed');
    }

    // Exchange the authorization code for tokens.
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.GOOGLE_CLIENT_ID,
        client_secret: config.GOOGLE_CLIENT_SECRET,
        code: String(code),
        redirect_uri: config.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const data = await resp.json();
    const accessToken = data && data.access_token;
    const refreshToken = data && data.refresh_token;
    if (!resp.ok || !accessToken) {
      // Log the error code/status only — never the token payload.
      console.error('[oauth] google token exchange failed:', data && data.error ? data.error : resp.status);
      return res.redirect('/app?error=google_failed');
    }

    // Fetch the Google profile so we can identify / create the user.
    const profile = await fetchGoogleProfile(accessToken);
    if (!profile || !profile.email) {
      console.error('[oauth] google userinfo failed — no email');
      return res.redirect('/app?error=google_failed');
    }

    // Find or create the user. A brand-new person gets their OWN tenant (a fresh
    // UUID) instead of the shared demo workspace; a returning user keeps theirs.
    let user = await findUserByGoogleId(profile.id);
    let isNew = false;
    let userTenantId = user && user.tenant_id;
    if (!user) {
      isNew = true;
      // Create the new tenant FIRST, so the token save below attaches to a tenant
      // that already exists (FK). workspace_id stays NULL (no Slack workspace
      // linked yet), onboarding not complete. Inline equivalent of
      // createTenantIfMissing, which forces workspace_id = id and so can't null it.
      userTenantId = crypto.randomUUID();
      const p = getPool();
      if (p) {
        await p.query(
          `INSERT INTO tenants (id, workspace_id, workspace_name, plan, onboarding_complete)
             VALUES ($1, NULL, NULL, 'free', false)
           ON CONFLICT (id) DO NOTHING`,
          [userTenantId]
        );
      }
      user = await createUser({
        email: profile.email,
        googleId: profile.id,
        displayName: profile.name,
        avatarUrl: profile.picture,
        tenantId: userTenantId,
        role: 'owner',
      });

      // Seed the new tenant's default asset library (best-effort, idempotent —
      // mirrors the Slack install path). Without this a brand-new Google account
      // has no asset_types/copy_fields and the first brief fails the Postgres
      // asset-library check. Never block sign-in if seeding fails.
      try {
        await seedTenantAssets(userTenantId);
      } catch (e) {
        console.error('[oauth] seedTenantAssets failed (continuing):', e.message);
      }
    }

    // Store the Google refresh token on the USER, not the tenant. It is that
    // person's own Drive identity: written to tenant_tokens it upserted on
    // (tenant_id, 'google'), so the second person to sign in replaced the
    // first's and every later Drive write for the whole team ran as them.
    // Best-effort, no-ops without a DB. Never logged.
    //
    // The tenant-level row is deliberately no longer written here. Existing ones
    // are left in place and still read as a fallback (see google.js
    // resolveGoogleRefreshToken) until scripts/migrateBackfillUserCredentials.js
    // moves them onto their owner.
    if (refreshToken && user && user.id) {
      const saved = await saveUserToken(user.id, 'google', refreshToken);
      // PRE-MIGRATION FALLBACK ONLY: saveUserToken returns false when
      // user_tokens doesn't exist yet (this code can deploy before the
      // migration runs). Without this the token would be stored nowhere and the
      // person's Drive writes would silently fall back to the env identity, so
      // keep the old tenant-level write until the table is there. The read path
      // already prefers the user's token, so nothing changes once it is.
      if (!saved && userTenantId) await saveTenantToken(userTenantId, 'google', refreshToken);
    }

    if (req.session && user && user.id) req.session.userId = user.id;

    console.log(`[oauth] google sign-in OK — tenant ${userTenantId} new=${isNew}`);

    // Settings returns to /settings; onboarding continues at step 2; otherwise
    // route on SETUP STATE, not just record existence: a tenant with
    // onboarding_complete=true → the app; anyone still incomplete (brand-new OR
    // a returning user who abandoned setup) → /onboarding to finish. Best-effort:
    // a lookup miss/error defaults to incomplete → onboarding (never strand a
    // user in the app half-set-up). isNew stays for the log line only.
    const redirectTo = entry.data && entry.data.redirectTo;
    if (redirectTo === 'settings') return res.redirect('/settings?connected=google');
    if (redirectTo === 'onboarding') return res.redirect('/onboarding?step=2');
    let onboardingComplete = false;
    try {
      const t = await getTenantByWorkspace(userTenantId);
      onboardingComplete = !!(t && t.onboarding_complete);
    } catch (e) {
      console.warn('[oauth] onboarding_complete lookup failed — treating as incomplete:', e.message);
    }
    return res.redirect(onboardingComplete ? '/app?connected=google' : '/onboarding');
  } catch (err) {
    // Never leak a stack trace to the browser — log it, redirect generically.
    console.error('[oauth] google callback error:', err && err.stack ? err.stack : err);
    return res.redirect('/app?error=google_failed');
  }
});

// Fetch the signed-in user's Google profile { id, email, name, picture }.
// Best-effort: returns null on any failure (callers handle it). Never logs the
// access token.
async function fetchGoogleProfile(accessToken) {
  try {
    const resp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      console.error('[oauth] userinfo request failed:', resp.status);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.error('[oauth] userinfo error:', err.message);
    return null;
  }
}

// Placeholder post-install page.
router.get('/welcome', (req, res) => {
  // Only ever reflect a sanitized known error code (no user-controlled HTML).
  const code = String(req.query.error || '').replace(/[^a-z_]/gi, '');
  // Known codes get a message that says what to actually do; anything else keeps
  // the generic line. Only ever reflects the sanitized code, never raw input.
  const EXPLAINED = {
    already_linked:
      `<h1>That Slack account is already connected</h1>` +
      `<p>It belongs to a different Quillio user, so it wasn't linked to your account and ` +
      `<code>/quillio</code> won't run as you. Sign in as that user, or connect a different Slack account.</p>`,
    link_failed:
      `<h1>Slack wasn't connected</h1>` +
      `<p>Quillio is installed, but your Slack account couldn't be linked to your Quillio user, ` +
      `so <code>/quillio</code> won't run as you. Please try connecting again.</p>`,
  };
  const body = code
    ? EXPLAINED[code] ||
      `<h1>Install didn't finish</h1><p>Something went wrong (<code>${code}</code>). Please try again.</p>`
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
