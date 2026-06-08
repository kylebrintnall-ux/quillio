'use strict';

const crypto = require('crypto');
const express = require('express');

const config = require('./config');
const { runBriefWorkflow, runGenerateDraft } = require('./workflow');
const { postText } = require('./services/slack');

const app = express();

// Capture the raw body so we can verify Slack signatures.
const rawBodySaver = (req, res, buf) => {
  req.rawBody = buf ? buf.toString('utf8') : '';
};
app.use(express.urlencoded({ extended: true, verify: rawBodySaver }));
app.use(express.json({ verify: rawBodySaver }));

// Optional Slack signature verification. No-op if SLACK_SIGNING_SECRET unset.
function verifySlack(req) {
  if (!config.SLACK_SIGNING_SECRET) return true;

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

app.get('/', (req, res) => res.status(200).send('Quillio is running.'));
app.get('/health', (req, res) => res.status(200).json({ ok: true }));

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

  // 1. Immediate acknowledgment — this must go out before any heavy work.
  res.status(200).json({
    response_type: 'in_channel',
    text: 'Brief received — building your doc now.',
  });

  // 2. Fire-and-forget the real workflow. Errors are reported back to Slack
  //    but never block or crash the request.
  const responseUrl = req.body.response_url;
  runBriefWorkflow(brief).catch(async (err) => {
    console.error('runBriefWorkflow failed:', err);
    try {
      await postText(`⚠️ Quillio hit an error: ${err.message}`, responseUrl);
    } catch (e) {
      console.error('Failed to report error to Slack:', e);
    }
  });
});

// --- Interactive button clicks (Generate First Draft / Skip) ---
app.post('/slack/interactions', (req, res) => {
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

  if (action.action_id === 'generate_first_draft') {
    const docId = action.value;
    runGenerateDraft(docId, responseUrl).catch(async (err) => {
      console.error('runGenerateDraft failed:', err);
      try {
        await postText(`⚠️ Draft generation failed: ${err.message}`, responseUrl);
      } catch (e) {
        console.error('Failed to report error to Slack:', e);
      }
    });
  }
  // 'skip' and 'open_in_drive' require no server-side work.
});

app.listen(config.PORT, () => {
  console.log(`Quillio listening on port ${config.PORT}`);
});

module.exports = app;
