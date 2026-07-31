'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');

const config = require('./config');
const { getPool } = require('./db');
const {
  runBriefWorkflow,
  runGenerateDraft,
  resumeBriefWorkflow,
  cancelBriefWorkflow,
  peekPendingPlan,
} = require('./workflow');
const { claimDelivery, releaseDelivery, deliveryKey } = require('./liveMessage');
const { emoji } = require('./emoji');
const oauthRoutes = require('./routes/oauth');
const appRoutes = require('./routes/app');
const onboardingRoutes = require('./routes/onboarding');
const { runSlackReview } = require('./adapters/slackReview');
const {
  updateMessage,
  updateLive,
  openInDriveBlocks,
  logBotIdentity,
  buildRegenerateModalView,
  buildPlanEditModalView,
  openModal,
} = require('./services/slack');
const { oauthLimiter, slackLimiter } = require('./middleware/rateLimit');

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
// Google OAuth / sign-in (/oauth/google[, /callback]). Separate from the
// slash-command/interactions handlers below. Rate-limit the OAuth surfaces
// (20/hr/IP) — /welcome is not under these prefixes so it stays unlimited.
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

// Admin area (/admin). Gated by requireAdmin (users.is_admin); non-admins get a
// bare 404. Stub only for now — proves the gate before any dashboard is built.
app.use(require('./routes/admin'));

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
    .helper {
      font-size: 13px;
      color: var(--cream);
      opacity: 0.7;
      margin: 16px 0 0;
    }
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
      <a class="btn btn-primary" href="/onboarding">Create account</a>
      <a class="btn btn-secondary" href="/oauth/google">Sign in</a>
    </div>
    <p class="helper">New to Quillio? Set up in about 2 minutes.</p>
  </main>
</body>
</html>`;
app.get('/', (req, res) => res.status(200).type('html').send(LANDING_HTML));
// /health also reports the deployed commit (Railway injects RAILWAY_GIT_COMMIT_SHA)
// so we can tell exactly what's live vs. what a stale shell is serving. no-store so
// the reading itself is never cached.
app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_VERSION || '';
  res.status(200).json({ ok: true, commit: sha ? sha.slice(0, 7) : 'unknown' });
});

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
app.post('/slack/command', slackLimiter, (req, res) => {
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
  const slackUserId = req.body.user_id;
  // File-attachment plumbing: slash commands don't carry files, but if a future
  // Events API handler supplies a files array ([{ url, filename, mimetype }]),
  // it threads straight through to fetchAllReferences as upload references.
  const attachments = parseSlackFiles(req.body.files);
  runBriefWorkflow(brief, responseUrl, { channelId, workspaceId, slackUserId, attachments }).catch(async (err) => {
    console.error('runBriefWorkflow failed:', err);
    try {
      await updateMessage(`⚠️ Quillio hit an error: ${err.message}`, responseUrl);
    } catch (e) {
      console.error('Failed to report error to Slack:', e);
    }
  });
});

// --- Slash command: /quillio-review [optional Drive link] ---
// Ack-first (Slack's 3s window), then run the review fire-and-forget. The runner
// posts a live "Reviewing…" message and updates it in place on completion.
app.post('/slack/review', slackLimiter, (req, res) => {
  if (!verifySlack(req)) {
    return res.status(401).send('Invalid signature.');
  }
  res.status(200).end();

  runSlackReview({
    text: (req.body.text || '').trim(),
    channelId: req.body.channel_id,
    workspaceId: req.body.team_id,
    slackUserId: req.body.user_id,
  }).catch((err) => console.error('[slack] /quillio-review failed:', err));
});

// --- Interactive button clicks (Generate First Draft / Skip) ---
app.post('/slack/interactions', slackLimiter, (req, res) => {
  // Signature check FIRST — nothing from the body is read, echoed, or acted on
  // until the request is proven to come from Slack. (Slack signs the
  // url_verification handshake too, so answering it after this check is still
  // correct; echoing it before would reflect arbitrary attacker-supplied text
  // to any unauthenticated caller.)
  if (!verifySlack(req)) {
    return res.status(401).send('Invalid signature.');
  }

  // URL verification handshake. Slack sends this as a top-level JSON body
  // ({ type: 'url_verification', challenge }); some setups wrap it in `payload`.
  // Answer it before payload parsing so the Request URL can be saved. Echo the
  // challenge straight back.
  const challenge = extractChallenge(req.body);
  if (challenge) {
    return res.status(200).json({ challenge });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.payload);
  } catch {
    return res.status(400).send('Bad payload.');
  }

  // Slack sets this when it is REDELIVERING something it believes failed — up to
  // three times. This handler acks in milliseconds and then works for 7+ seconds,
  // so an ack lost in transit is redelivered while the original run is still going
  // or has already finished. Either way the work was accepted; running it again
  // rebuilds the doc and writes progress text over a card that was already
  // terminal. claimDelivery uses this to tell a redelivery apart from a deliberate
  // second click, which produces an identical payload WITHOUT the header.
  const isRetry = !!req.get('X-Slack-Retry-Num');
  if (isRetry) {
    console.log(`[interactions] redelivery #${req.get('X-Slack-Retry-Num')} (${req.get('X-Slack-Retry-Reason') || 'no reason given'})`);
  }

  // --- Modal submission (Regenerate Draft) ---
  // view_submission payloads carry no `actions`; handle them before the
  // block_actions chain. Ack with an empty 200 (closes the modal) within Slack's
  // 3s window, then fire-and-forget the regeneration.
  if (payload.type === 'view_submission') {
    res.status(200).send('');
    const view = payload.view || {};

    // --- Modal submission (Edit the plan) ---
    // The plan-confirmation card's "Edit counts" modal. private_metadata carries
    // { pendingId, channel, messageTs } exactly the way the regenerate modal below
    // carries { docId, channel, messageTs } — no internal id is ever shown.
    //
    // Block ids are POSITIONAL (count_0, count_1, …) and resolved against the
    // stored plan, so a submission can only change counts: it cannot name an asset,
    // and a tampered payload can only produce numbers that resumeBriefWorkflow then
    // validates and clamps against the tenant's real library.
    if (view.callback_id === 'plan_modal') {
      let meta = {};
      try {
        meta = JSON.parse(view.private_metadata || '{}');
      } catch {
        /* fall through with empty meta */
      }
      const { pendingId, channel, messageTs } = meta;
      if (!pendingId) {
        console.error('[interactions] plan_modal submission missing pendingId');
        return;
      }
      const workspaceId = payload.team && payload.team.id;
      const slackUserId = payload.user && payload.user.id;
      const stored = peekPendingPlan(pendingId, workspaceId);
      if (!stored) {
        // Expired or lost to a restart between opening the modal and submitting it.
        // resumeBriefWorkflow says so on the card rather than failing silently.
        resumeBriefWorkflow(pendingId, null, { workspaceId, slackUserId, channel, messageTs }).catch((err) =>
          console.error('plan_modal (expired) failed:', err)
        );
        return;
      }
      const planKey = deliveryKey('plan_modal', channel, messageTs, pendingId);
      if (!claimDelivery(planKey, isRetry)) {
        console.log('[interactions] plan_modal: duplicate delivery ignored');
        return;
      }
      const values = (view.state && view.state.values) || {};
      const edited = stored.map((entry, i) => {
        const block = values[`count_${i}`];
        const raw = block && block.count_input && block.count_input.value;
        const n = parseInt(raw, 10);
        return { asset: entry.asset, count: Number.isFinite(n) ? n : entry.count, labels: entry.labels || [] };
      });
      resumeBriefWorkflow(pendingId, edited, { workspaceId, slackUserId, channel, messageTs })
        .catch((err) => console.error('plan_modal resume failed:', err))
        .finally(() => releaseDelivery(planKey));
      return;
    }

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
    const slackUserId = payload.user && payload.user.id;

    // A view_submission is redelivered on a lost ack the same way a block_action
    // is, and it targets the same message ts.
    const regenKey = deliveryKey('regenerate_modal', channel, messageTs, docId);
    if (!claimDelivery(regenKey, isRetry)) {
      console.log('[interactions] regenerate_modal: duplicate delivery ignored');
      return;
    }
    runGenerateDraft(docId, null, channel, messageTs, workspaceId, direction, slackUserId)
      .catch(async (err) => {
        console.error('runGenerateDraft (regenerate) failed:', err);
        try {
          if (channel && messageTs) {
            await updateLive(channel, messageTs, `⚠️ Regeneration failed: ${err.message}`);
          }
        } catch (e) {
          console.error('Failed to report regenerate error to Slack:', e);
        }
      })
      .finally(() => releaseDelivery(regenKey));
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
  const slackUserId = payload.user && payload.user.id;
  const canLive = !!config.SLACK_BOT_TOKEN && channelId && messageTs;

  if (action.action_id === 'plan_build') {
    // Build the plan exactly as parsed. Only the pendingId came from the button —
    // the plan is read from the server-side store, so nothing a client could edit
    // reaches generateDoc on this path.
    //
    // Claimed first: this handler acks in milliseconds and then works for 7+
    // seconds, so a lost ack (or a double-tap on a phone) arrives as a second
    // identical payload. The pending record is dropped only AFTER the build
    // succeeds, so without this the retry finds it, writes "Building your
    // document…" over whatever is on the message, and builds a second doc.
    const key = deliveryKey('plan_build', channelId, messageTs, action.value);
    if (!claimDelivery(key, isRetry)) {
      console.log('[interactions] plan_build: duplicate delivery ignored');
      return;
    }
    resumeBriefWorkflow(action.value, null, {
      workspaceId,
      slackUserId,
      channel: channelId,
      messageTs,
      responseUrl,
    })
      .catch(async (err) => {
        console.error('plan_build failed:', err);
        try {
          await updateMessage(`⚠️ Quillio hit an error: ${err.message}`, responseUrl);
        } catch (e) {
          console.error('Failed to report plan_build error to Slack:', e);
        }
      })
      // Released so a DELIBERATE second Build (after a failure) still works; a
      // retry lands during the run, when the key is still held.
      .finally(() => releaseDelivery(key));
  } else if (action.action_id === 'plan_edit') {
    // Open the count-editing modal on this click's FRESH trigger_id (~3s to use it,
    // which is why the plan arrived as a card and not a modal). The ownership check
    // is against the WORKSPACE and synchronous for the same reason — a resolveTenant
    // round-trip first could blow the window.
    const pendingId = action.value;
    const plan = peekPendingPlan(pendingId, workspaceId);
    if (!plan) {
      const gone =
        `${emoji('quillio-scroll')} That plan is no longer available — Quillio restarted or it sat for more than ` +
        '30 minutes. Nothing was created. Run `/quillio` again with the same brief.';
      const done = canLive ? updateLive(channelId, messageTs, gone) : updateMessage(gone, responseUrl);
      done.catch((err) => console.error('plan_edit expired notice failed:', err.message));
    } else {
      const meta = JSON.stringify({ pendingId, channel: channelId, messageTs });
      openModal(payload.trigger_id, buildPlanEditModalView(meta, plan)).catch((err) =>
        console.error('plan_edit openModal failed:', err)
      );
    }
  } else if (action.action_id === 'plan_cancel') {
    cancelBriefWorkflow(action.value, {
      workspaceId,
      channel: channelId,
      messageTs,
      responseUrl,
    }).catch((err) => console.error('plan_cancel failed:', err.message));
  } else if (action.action_id === 'generate_first_draft') {
    const docId = action.value;
    // Same exposure as plan_build: a drafting run is the slowest thing Quillio
    // does, which is exactly when a redelivery fires.
    const key = deliveryKey('generate_first_draft', channelId, messageTs, docId);
    if (!claimDelivery(key, isRetry)) {
      console.log('[interactions] generate_first_draft: duplicate delivery ignored');
      return;
    }
    runGenerateDraft(docId, responseUrl, channelId, messageTs, workspaceId, undefined, slackUserId)
      .catch(async (err) => {
        console.error('runGenerateDraft failed:', err);
        try {
          await updateMessage(`⚠️ Draft generation failed: ${err.message}`, responseUrl);
        } catch (e) {
          console.error('Failed to report error to Slack:', e);
        }
      })
      .finally(() => releaseDelivery(key));
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
    opts.slackUserId = slackUserId;

    runBriefWorkflow(ctx.brief || '', responseUrl, opts).catch(async (err) => {
      console.error('folder-recovery rerun failed:', err);
      try {
        await updateMessage(`⚠️ Quillio hit an error: ${err.message}`, responseUrl);
      } catch (e) {
        console.error('Failed to report error to Slack:', e);
      }
    });
  }
  // 'open_in_drive' is a link button — no server-side work. Any other
  // action_id (including buttons on old messages whose handlers have since been
  // removed) falls through here: the 200 ack above already went out, so a stale
  // click is a no-op rather than an error.
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
