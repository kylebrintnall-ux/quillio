'use strict';

const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

const config = require('./config');
const { getClients } = require('./google');
const { getPool } = require('./db');
const { runBriefWorkflow, runGenerateDraft } = require('./workflow');
const { generateVoiceGuide } = require('./services/gemini');
const { saveVoiceGuide } = require('./db');
const oauthRoutes = require('./routes/oauth');
const appRoutes = require('./routes/app');
const onboardingRoutes = require('./routes/onboarding');
const { updateMessage, updateLive, openInDriveBlocks, logBotIdentity } = require('./services/slack');

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
// slash-command/interactions handlers below.
app.use(oauthRoutes);

// Onboarding flow (/onboarding + /api/onboarding/*). Auth-gated per route.
app.use(onboardingRoutes);

// Settings page (/settings + /api/settings/* + /api/auth/signout). Auth-gated.
app.use(require('./routes/settings'));

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

app.get('/', (req, res) => res.status(200).send('Quillio is running.'));
app.get('/health', (req, res) => res.status(200).json({ ok: true }));

// --- Voice guide onboarding ---
// Takes the six onboarding answers, generates a voice guide via Gemini, persists
// it (Postgres voice_guide row + voice.md in the tenant's Drive folder), and
// returns the markdown to the client for review/editing before final save.
// Persistence is best-effort: a Postgres or Drive failure is logged but still
// returns the generated markdown so the client can review it.
app.post('/api/voice-guide/generate', async (req, res) => {
  const body = req.body || {};
  const tenantId = body.tenantId || 'default';
  try {
    const markdown = await generateVoiceGuide({
      brandPersonality: body.brandPersonality,
      toneGuidance: body.toneGuidance,
      wordsToAvoid: body.wordsToAvoid,
      wordsToUse: body.wordsToUse,
      audienceLanguage: body.audienceLanguage,
      toneReference: body.toneReference,
    });

    // Persist to Postgres (best-effort).
    try {
      await saveVoiceGuide(tenantId, markdown);
    } catch (e) {
      console.error('[voice-guide] Postgres save failed:', e.message);
    }

    // Save as voice.md in the tenant's Drive folder (best-effort).
    try {
      const { drive } = await getClients();
      await drive.files.create({
        requestBody: { name: 'voice.md', mimeType: 'text/plain', parents: [config.DRIVE_FOLDER_ID] },
        media: { mimeType: 'text/plain', body: markdown },
        supportsAllDrives: true,
      });
    } catch (e) {
      console.error('[voice-guide] Drive save failed:', e.message);
    }

    return res.status(200).json({ markdown });
  } catch (err) {
    console.error('[voice-guide] generate failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

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
  runBriefWorkflow(brief, responseUrl, { channelId, workspaceId }).catch(async (err) => {
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
  }
  // 'open_in_drive' is a link button — no server-side work.
});

app.listen(config.PORT, () => {
  console.log(`Quillio listening on port ${config.PORT}`);
  // Log which app/bot the SLACK_BOT_TOKEN belongs to (best-effort).
  logBotIdentity().catch(() => {});
});

module.exports = app;
