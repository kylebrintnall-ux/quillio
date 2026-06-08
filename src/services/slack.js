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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Slack post failed ${res.status}: ${text}`);
  }
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

async function postResult(result) {
  await postToSlack(config.SLACK_WEBHOOK_URL, buildResultBlocks(result));
}

// Plain confirmation back to the channel via the interaction's response_url
// (falls back to the configured webhook).
async function postText(text, responseUrl) {
  const url = responseUrl || config.SLACK_WEBHOOK_URL;
  await postToSlack(url, { response_type: 'in_channel', text });
}

// Replaces the original interactive message in place via its response_url.
// Used to give live feedback after a button tap (progress → final result).
// Falls back to a fresh webhook post if no response_url is available.
async function updateMessage(text, responseUrl) {
  if (!responseUrl) {
    return postToSlack(config.SLACK_WEBHOOK_URL, { text });
  }
  await postToSlack(responseUrl, { replace_original: true, text });
}

module.exports = { postToSlack, buildResultBlocks, postResult, postText, updateMessage };
