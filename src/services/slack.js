'use strict';

const config = require('../config');

// Posts a JSON payload to a Slack URL (incoming webhook or response_url).
async function postToSlack(url, payload) {
  if (!url) {
    throw new Error('No Slack URL available (set SLACK_WEBHOOK_URL).');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Slack post failed ${res.status}: ${body}`);
  }
  return { status: res.status, body };
}

// Block Kit message posted after the doc is built: title, asset list, and
// Open in Drive / Generate First Draft / Skip buttons.
function buildResultBlocks({ title, webViewLink, assets, docId }) {
  const assetList = assets.length
    ? assets.map((a) => `• ${a}`).join('\n')
    : '_No assets matched — included all specs._';

  return {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '📄 Your doc is ready', emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${title}*` },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Assets:*\n${assetList}` },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open in Drive', emoji: true },
            url: webViewLink,
            action_id: 'open_in_drive',
          },
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: 'Generate First Draft', emoji: true },
            action_id: 'generate_first_draft',
            value: docId,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Skip', emoji: true },
            action_id: 'skip',
            value: docId,
          },
        ],
      },
    ],
  };
}

// Posts the doc-ready Block Kit message. With a slash-command response_url it
// posts into the originating channel (replacing the "building…" ack); without
// one it falls back to the configured webhook.
async function postResult(result, responseUrl) {
  const message = buildResultBlocks(result);
  const target = responseUrl ? 'response_url' : 'webhook (fallback — no response_url!)';
  console.log('[slack] postResult -> ' + target);

  const url = responseUrl || config.SLACK_WEBHOOK_URL;
  const payload = responseUrl
    ? { response_type: 'in_channel', replace_original: true, ...message }
    : message;

  try {
    const res = await postToSlack(url, payload);
    console.log('[slack] postResult OK — Slack status ' + res.status + ', body: ' + res.body);
    return res;
  } catch (err) {
    console.error('[slack] postResult FAILED: ' + err.message);
    throw err;
  }
}

// Plain confirmation back to the channel via the interaction's response_url
// (falls back to the configured webhook).
async function postText(text, responseUrl) {
  const url = responseUrl || config.SLACK_WEBHOOK_URL;
  await postToSlack(url, { response_type: 'in_channel', text });
}

// Replaces the original interactive message in place via its response_url.
// Used to give live feedback after a button tap (progress → final result).
// Pass opts.webViewLink to include an "Open in Drive" button on the message.
// Falls back to a fresh webhook post if no response_url is available.
async function updateMessage(text, responseUrl, opts = {}) {
  const body = { text };
  if (opts.webViewLink) {
    body.blocks = [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open in Drive', emoji: true },
            url: opts.webViewLink,
            action_id: 'open_in_drive',
          },
        ],
      },
    ];
  }

  const tag = opts.label ? `updateMessage[${opts.label}]` : 'updateMessage';
  const mode = opts.newMessage ? 'new message' : 'replace_original';
  const target = responseUrl ? `response_url (${mode})` : 'webhook (fallback — no response_url!)';
  console.log(`[slack] ${tag} -> ${target}`);

  const url = responseUrl || config.SLACK_WEBHOOK_URL;
  // opts.newMessage posts a fresh in-channel message instead of replacing the
  // original. Slack won't reliably re-render a replace_original after the same
  // response_url has already been used (e.g. for the progress update), so the
  // final completion is posted as a new message.
  const payload = responseUrl
    ? opts.newMessage
      ? { response_type: 'in_channel', replace_original: false, ...body }
      : { replace_original: true, ...body }
    : body;

  try {
    const res = await postToSlack(url, payload);
    console.log(`[slack] ${tag} OK — Slack status ${res.status}, body: ${res.body}`);
    return res;
  } catch (err) {
    console.error(`[slack] ${tag} FAILED: ${err.message}`);
    throw err;
  }
}

module.exports = { postToSlack, buildResultBlocks, postResult, postText, updateMessage };
