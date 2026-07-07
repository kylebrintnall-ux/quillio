'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');

const config = require('./config');
const { getPool } = require('./db');
const { runBriefWorkflow, runGenerateDraft } = require('./workflow');
const {
  handleSubmitForReview,
  handleApprove,
  handleRequestChanges,
  handleResubmit,
} = require('./handlers/approval');
const oauthRoutes = require('./routes/oauth');
const appRoutes = require('./routes/app');
const onboardingRoutes = require('./routes/onboarding');
const {
  updateMessage,
  updateLive,
  openInDriveBlocks,
  logBotIdentity,
  buildRegenerateModalView,
  openModal,
} = require('./services/slack');
const { oauthLimiter } = require('./middleware/rateLimit');

const app = express();

// Capture the raw body so we can verify Slack signatures.
const rawBodySaver = (req, res, buf) => {
  req.rawBody = buf ? buf.toString('utf8') : '';
};
app.use(express.urlencoded({ extended: true, verify: rawBodySaver }));
app.use(express.json({ verify: rawBodySaver }));

// Web sessions (Sign in with Google). Persisted in Postgres via connect-pg-simple
// when DATABASE_URL is set (session table auto-created); otherwise the default
// in-memory store (fine for the keyless demo — sessions just don't survive a
// restart). The secret is never logged; a random per-boot fallback is used when
// SESSION_SECRET is unset.
const sessionStore = (() => {
  const pool = getPool();
  if (!pool) {
    console.warn('[session] DATABASE_URL not set — using in-memory session store (demo).');
    return undefined;
  }
  const PgSession = require('connect-pg-simple')(session);
  return new PgSession({ pool, createTableIfMissing: true });
})();

// Railway terminates TLS at a proxy in front of the app. Without trusting it,
// Express sees the proxied request as HTTP and won't set Secure cookies — so
// the session cookie never persists across the OAuth redirect on HTTPS.
app.set('trust proxy', 1);

app.use(
  session({
    store: sessionStore,
    secret: config.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

// Slack OAuth install flow (/oauth/slack, /oauth/slack/callback, /welcome) +
// Google OAuth / sign-in (/oauth/google[, /callback]) + Figma OAuth
// (/auth/figma[, /callback], Phase 4). Separate from the slash-command/
// interactions handlers below. Rate-limit the OAuth surfaces (20/hr/IP) —
// /welcome is not under these prefixes so it stays unlimited.
app.use('/oauth', oauthLimiter);
app.use('/auth', oauthLimiter);
app.use(oauthRoutes);

// Static design-system assets (v8 design system): the StarCrush display font,
// progress/header GIFs, and the pixel-quill logo. Scoped to ONLY the asset
// directories under public/ — NOT the whole public/ dir — so the page files
// (app.html, settings.html, onboarding.html) stay behind their existing
// auth-gated sendFile routes. These files are non-sensitive brand assets, so
// they're served unauthenticated and cached aggressively.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const staticOpts = { immutable: true, maxAge: '7d' };
app.use('/fonts', express.static(path.join(PUBLIC_DIR, 'fonts'), staticOpts));
app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), staticOpts));

// Onboarding flow (/onboarding + /api/onboarding/*). Auth-gated per route.
app.use(onboardingRoutes);

// Settings page (/settings + /api/settings/* + /api/auth/signout). Auth-gated.
app.use(require('./routes/settings'));

// Doc-header template onboarding API (/api/header/*). Auth-gated per route.
app.use(require('./routes/headerTemplate'));

// Web app surface (/app + /api/brief + /api/draft). Non-Slack product surface;
// runs the same core pipeline via the web adapter. Mounted before the
// slash-command/interactions handlers; touches none of them.
app.use(appRoutes);

// Slack request signature verification (enforced). Fails CLOSED: if no signing
// secret is configured we can't verify, so we reject rather than silently
// letting requests through. Requires SLACK_SIGNING_SECRET to be set.
function verifySlack(req) {
  if (!config.SLACK_SIGNING_SECRET) {
    console.error('SLACK_SIGNING_SECRET is not set — rejecting unverifiable Slack request.');
    return false;
  }

  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (!timestamp || !signature) return false;

  // Reject requests older than 5 minutes (replay protection).
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;

  const base = `v0:${timestamp}:${req.rawBody || ''}`;
  const hmac = crypto
    .createHmac('sha256', config.SLACK_SIGNING_SECRET)
    .update(base)
    .digest('hex');
  const expected = `v0=${hmac}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// Normalize Slack file objects into the attachment shape fetchAllReferences
// expects: [{ url, filename, mimetype }]. `files` may be an array (Events API)
// or a JSON string; anything else (e.g. a slash command, which carries no files)
// yields []. Prefers url_private_download for the authorized fetch.
function parseSlackFiles(files) {
  let arr = files;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((f) => ({
      url: f && (f.url_private_download || f.url_private),
      filename: (f && (f.name || f.title)) || 'attachment',
      mimetype: (f && f.mimetype) || '',
    }))
    .filter((f) => f.url);
}

// Pulls a Slack url_verification challenge out of the request body, whether it
// arrives as a top-level JSON body or wrapped in the form-encoded `payload`.
// Returns the challenge string, or null if this isn't a verification request.
function extractChallenge(body) {
  if (body && body.type === 'url_verification' && body.challenge) {
    return body.challenge;
  }
  if (body && typeof body.payload === 'string') {
    try {
      const parsed = JSON.parse(body.payload);
      if (parsed.type === 'url_verification' && parsed.challenge) {
        return parsed.challenge;
      }
    } catch {
      /* not a verification payload */
    }
  }
  return null;
}

// GET / — public landing page (no auth). Self-contained HTML; no frameworks.
// Brand assets load from the v8 static mounts (/fonts, /assets) configured above.
const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Quillio</title>
  <style>
    @font-face {
      font-family: 'Star Crush';
      src: url('/fonts/Star_Crush.otf') format('opentype');
      font-display: swap;
    }
    :root {
      --navy: #1C1F3B;
      --sky: #4DD9D9;
      --cream: #F5F0E8;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      background: var(--navy);
      color: var(--cream);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      text-align: center;
    }
    .hero { max-width: 480px; width: 100%; }
    .quill { width: 96px; height: auto; margin: 0 auto 8px; display: block; }
    .wordmark {
      font-family: 'Star Crush', 'Georgia', serif;
      font-size: clamp(56px, 18vw, 104px);
      line-height: 1;
      color: var(--cream);
      margin: 0 0 12px;
      letter-spacing: 0.02em;
    }
    .tagline {
      font-size: clamp(15px, 4.5vw, 18px);
      color: var(--cream);
      opacity: 0.85;
      margin: 0 0 32px;
    }
    .actions {
      display: flex;
      gap: 12px;
      justify-content: center;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-block;
      font-size: 16px;
      font-weight: 600;
      text-decoration: none;
      padding: 12px 24px;
      border-radius: 10px;
      border: 2px solid var(--sky);
      transition: opacity 0.15s ease;
    }
    .btn:hover { opacity: 0.85; }
    .btn-primary { background: var(--sky); color: var(--navy); }
    .btn-secondary { background: transparent; color: var(--sky); }
    @media (max-width: 380px) {
      .actions { flex-direction: column; }
      .btn { width: 100%; }
    }
  </style>
</head>
<body>
  <main class="hero">
    <img class="quill" src="/assets/gifs/quillio_magic_v27.gif" alt="Quillio" />
    <h1 class="wordmark">Quillio</h1>
    <p class="tagline">Creative brief intelligence for copywriters.</p>
    <div class="actions">
      <a class="btn btn-primary" href="/app">Go to app</a>
      <a class="btn btn-secondary" href="/onboarding">Sign in</a>
    </div>
  </main>
</body>
</html>`;
app.get('/', (req, res) => res.status(200).type('html').send(LANDING_HTML));
app.get('/health', (req, res) => res.status(200).json({ ok: true }));

// NOTE: the legacy, UNAUTHENTICATED POST /api/voice-guide/generate endpoint was
// removed here (security audit HIGH 1). It accepted a client-supplied tenantId
// and let anyone overwrite any tenant's voice guide + drive unauthenticated
// Gemini/Drive usage. Voice-guide generation now lives behind requireAuth in
// /api/settings/voice/generate and /api/onboarding/voice (tenant from session).

// --- Slash command: /quillio [brief] ---
//
// CRITICAL: Slack requires a response within 3 seconds, but the workflow takes
// 7s+. We send the 200 acknowledgment FIRST, then run the workflow
// asynchronously after the response has been flushed.
app.post('/slack/command', (req, res) => {
  if (!verifySlack(req)) {
    return res.status(401).send('Invalid signature.');
  }

  const brief = (req.body.text || '').trim();

  if (!brief) {
    return res.status(200).json({
      response_type: 'ephemeral',
      text: 'Usage: `/quillio [campaign brief]`',
    });
  }

  // 1. Immediate acknowledgment — empty 200 within Slack's 3s window. The
  //    "building…" message is posted by runBriefWorkflow via chat.postMessage
  //    (channel_id below) so it can be edited in place into the doc-ready card.
  res.status(200).end();

  // 2. Fire-and-forget the real workflow. Errors are reported back to Slack but
  //    never block or crash the request.
  const responseUrl = req.body.response_url;
  const channelId = req.body.channel_id;
  const workspaceId = req.body.team_id;
  // File-attachment plumbing: slash commands don't carry files, but if a future
  // Events API handler supplies a files array ([{ url, filename, mimetype }]),
  // it threads straight through to fetchAllReferences as upload references.
  const attachments = parseSlackFiles(req.body.files);
  runBriefWorkflow(brief, responseUrl, { channelId, workspaceId, attachments }).catch(async (err) => {
    console.error('runBriefWorkflow failed:', err);
    try {
      await updateMessage(`⚠️ Quillio hit an error: ${err.message}`, responseUrl);
    } catch (e) {
      console.error('Failed to report error to Slack:', e);
    }
  });
});

// --- Interactive button clicks (Generate First Draft / Skip) ---
app.post('/slack/interactions', (req, res) => {
  // URL verification handshake. Slack sends this as a top-level JSON body
  // ({ type: 'url_verification', challenge }); some setups wrap it in `payload`.
  // Answer it before signature checks / payload parsing so the Request URL can
  // be saved. Echo the challenge straight back.
  const challenge = extractChallenge(req.body);
  if (challenge) {
    return res.status(200).json({ challenge });
  }

  if (!verifySlack(req)) {
    return res.status(401).send('Invalid signature.');
  }

  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch {
    return res.status(400).send('Bad payload.');
  }

  // --- Modal submission (Regenerate Draft) ---
  // view_submission payloads carry no `actions`; handle them before the
  // block_actions chain. Ack with an empty 200 (closes the modal) within Slack's
  // 3s window, then fire-and-forget the regeneration.
  if (payload.type === 'view_submission') {
    res.status(200).send('');
    const view = payload.view || {};
    if (view.callback_id !== 'regenerate_modal') return;

    let meta = {};
    try {
      meta = JSON.parse(view.private_metadata || '{}');
    } catch {
      /* fall through with empty meta — handled below */
    }
    const { docId, channel, messageTs } = meta;
    if (!docId) {
      console.error('[interactions] regenerate_modal submission missing docId');
      return;
    }
    // Optional input → may be undefined/empty; empty regenerates with no direction.
    const direction =
      (view.state &&
        view.state.values &&
        view.state.values.direction_block &&
        view.state.values.direction_block.direction_input &&
        view.state.values.direction_block.direction_input.value) ||
      undefined;
    const workspaceId = payload.team && payload.team.id;

    runGenerateDraft(docId, null, channel, messageTs, workspaceId, direction).catch(async (err) => {
      console.error('runGenerateDraft (regenerate) failed:', err);
      try {
        if (channel && messageTs) {
          await updateLive(channel, messageTs, `⚠️ Regeneration failed: ${err.message}`);
        }
      } catch (e) {
        console.error('Failed to report regenerate error to Slack:', e);
      }
    });
    return;
  }

  // Acknowledge immediately so the buttons don't time out.
  res.status(200).send('');

  const action = payload.actions && payload.actions[0];
  if (!action) return;

  const responseUrl = payload.response_url;
  // The clicked message — we edit it in place via chat.update (channel + ts).
  const channelId = payload.channel && payload.channel.id;
  const messageTs = payload.message && payload.message.ts;
  const workspaceId = payload.team && payload.team.id;
  const canLive = !!config.SLACK_BOT_TOKEN && channelId && messageTs;

  if (action.action_id === 'generate_first_draft') {
    const docId = action.value;
    runGenerateDraft(docId, responseUrl, channelId, messageTs, workspaceId).catch(async (err) => {
      console.error('runGenerateDraft failed:', err);
      try {
        await updateMessage(`⚠️ Draft generation failed: ${err.message}`, responseUrl);
      } catch (e) {
        console.error('Failed to report error to Slack:', e);
      }
    });
  } else if (action.action_id === 'regenerate_draft') {
    // Open the Regenerate modal. docId/channel/messageTs ride in private_metadata
    // (never shown to the user) so the view_submission handler can post the
    // result back to this same message. trigger_id expires in ~3s — fire now.
    const meta = JSON.stringify({ docId: action.value, channel: channelId, messageTs });
    openModal(payload.trigger_id, buildRegenerateModalView(meta)).catch((err) =>
      console.error('regenerate_draft openModal failed:', err)
    );
  } else if (action.action_id === 'skip') {
    // Replace the buttons with a skipped-state confirmation (keep an Open in
    // Drive link). Edit the clicked message in place when possible.
    const url = `https://docs.google.com/document/d/${action.value}/edit`;
    const text = '✓ Draft skipped — doc is ready to write in.';
    const done = canLive
      ? updateLive(channelId, messageTs, text, openInDriveBlocks(text, url))
      : updateMessage(text, responseUrl, { webViewLink: url });
    done.catch((err) => console.error('skip update failed:', err.message));
  } else if (action.action_id === 'build_default' || action.action_id === 'retry_folder') {
    // Folder-access recovery (Issue 3): re-run the original brief, editing the
    // clicked message in place (building → doc-ready). Build in Default ignores
    // the brief's folder; Retry pins the same folder again.
    let ctx = {};
    try {
      ctx = JSON.parse(action.value || '{}');
    } catch {
      /* fall through with empty context */
    }
    const opts =
      action.action_id === 'build_default'
        ? { forceDefaultFolder: true }
        : { folderIdOverride: ctx.folderId };
    if (canLive) opts.live = { channel: channelId, ts: messageTs };
    opts.workspaceId = workspaceId;

    runBriefWorkflow(ctx.brief || '', responseUrl, opts).catch(async (err) => {
      console.error('folder-recovery rerun failed:', err);
      try {
        await updateMessage(`⚠️ Quillio hit an error: ${err.message}`, responseUrl);
      } catch (e) {
        console.error('Failed to report error to Slack:', e);
      }
    });
  } else if (action.action_id === 'submit_for_review') {
    // Approval workflow (handlers/approval.js). Each handler reads the full
    // payload (channel/message/user/value) itself, so pass payload, not value.
    // Fire-and-forget — the 200 ack above already closed the 3s window.
    handleSubmitForReview(payload).catch((err) =>
      console.error('submit_for_review failed:', err)
    );
  } else if (action.action_id === 'approve') {
    handleApprove(payload).catch((err) => console.error('approve failed:', err));
  } else if (action.action_id === 'request_changes') {
    handleRequestChanges(payload).catch((err) =>
      console.error('request_changes failed:', err)
    );
  } else if (action.action_id === 'resubmit') {
    handleResubmit(payload).catch((err) => console.error('resubmit failed:', err));
  }
  // 'open_in_drive' / 'review_copy' are link buttons — no server-side work.
  // 'populate_figma' is Phase 4 — intentionally unwired.
});

// Global error handler (must be LAST, with 4 args). Catches anything thrown in a
// sync handler or passed to next(err) — most importantly body-parser/multer
// parse errors that individual routes don't see. Logs the full error
// server-side; the client gets a clean JSON body with NO stack trace, and a
// generic message in production.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error] unhandled:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  const status = err && Number.isInteger(err.status || err.statusCode) ? err.status || err.statusCode : 500;
  const isProd = process.env.NODE_ENV === 'production';
  return res.status(status).json({
    success: false,
    error: isProd ? 'Something went wrong' : (err && err.message) || 'Something went wrong',
  });
});

app.listen(config.PORT, () => {
  console.log(`Quillio listening on port ${config.PORT}`);
  // Log which app/bot the SLACK_BOT_TOKEN belongs to (best-effort).
  logBotIdentity().catch(() => {});
});

module.exports = app;
