'use strict';

const config = require('../config');
const { emoji } = require('../emoji');

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

// Block Kit message posted after the doc is built: title, asset list, the
// Campaign folder / Copy doc hyperlinks, an optional "Saved to <folder>" line,
// and two buttons (Generate First Draft / Skip for now). folderUrl/folderName
// are optional — the folder link renders only when a project folder was made.
function buildResultBlocks({ title, webViewLink, assets, docId, folderUrl, folderName }) {
  const assetList = assets.length
    ? assets.map((a) => `• ${a}`).join('\n')
    : '_No assets matched — included all specs._';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${emoji('quillio-doc-done')} Your doc is ready`, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${title}*` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Assets:*\n${assetList}` },
    },
  ];

  // Folder + doc links as Slack hyperlinks, below the asset list. The doc link
  // replaces the old "Open in Drive" button; the folder link only renders when a
  // project folder was actually created.
  const links = [];
  if (folderUrl) links.push(`${emoji('quillio-folder')} <${folderUrl}|Campaign folder>`);
  links.push(`${emoji('quillio-doc-done')} <${webViewLink}|Copy doc>`);
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: links.join('\n') } });

  // "Saved to <folder>" confirmation, below the links (only for brief-linked folders).
  if (folderName) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${emoji('quillio-folder')} Saved to ${folderName}` },
    });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        style: 'primary',
        text: { type: 'plain_text', text: 'Generate First Draft', emoji: true },
        action_id: 'generate_first_draft',
        value: docId,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Skip for now', emoji: true },
        action_id: 'skip',
        value: docId,
      },
    ],
  });

  return { blocks };
}

// Posts the doc-ready Block Kit message. With a slash-command response_url it
// posts into the originating channel (replacing the "building…" ack); without
// one it falls back to the configured webhook.
async function postResult(result, responseUrl) {
  const message = buildResultBlocks(result);
  const target = responseUrl ? 'response_url' : 'webhook (fallback — no response_url!)';
  console.log('[slack] postResult -> ' + target);

  const url = responseUrl || config.SLACK_WEBHOOK_URL;
  // IMPORTANT: do NOT include response_type here. Sending response_type
  // ('in_channel') together with replace_original makes Slack broadcast a NEW
  // message instead of replacing the "building…" ack — leaving the ack stranded.
  // replace_original alone replaces the ack in place and preserves its
  // (in-channel) visibility.
  const payload = responseUrl
    ? { replace_original: true, ...message }
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

// Block Kit for a confirmation: a section + an "Open in Drive" link button.
function openInDriveBlocks(text, webViewLink) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open in Drive', emoji: true },
          url: webViewLink,
          action_id: 'open_in_drive',
        },
      ],
    },
  ];
}

// --- Submit for Review / approval flow blocks (Phase 3) ---

// Copy-complete card with Open in Drive + Submit for Review + Regenerate.
function copyCompleteBlocks(text, webViewLink, docId) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Open in Drive', emoji: true }, url: webViewLink, action_id: 'open_in_drive' },
        { type: 'button', text: { type: 'plain_text', text: 'Submit for Review', emoji: true }, action_id: 'submit_for_review', value: docId },
        { type: 'button', text: { type: 'plain_text', text: 'Regenerate', emoji: true }, action_id: 'regenerate_draft', value: docId },
      ],
    },
  ];
}

// Build the "Regenerate Draft" modal view. privateMetadata is a JSON string
// ({ docId, channel, messageTs }) — carried through the modal so the
// view_submission handler knows which doc to regenerate and where to post the
// result. No internal IDs are ever shown to the user; they ride in
// private_metadata only. The direction input is optional — an empty submission
// regenerates with no direction (identical to a first draft).
function buildRegenerateModalView(privateMetadata) {
  return {
    type: 'modal',
    callback_id: 'regenerate_modal',
    private_metadata: privateMetadata || '',
    title: { type: 'plain_text', text: 'Regenerate Draft', emoji: true },
    submit: { type: 'plain_text', text: 'Regenerate', emoji: true },
    close: { type: 'plain_text', text: 'Cancel', emoji: true },
    blocks: [
      {
        type: 'input',
        block_id: 'direction_block',
        optional: true,
        label: { type: 'plain_text', text: 'What should change?', emoji: true },
        element: {
          type: 'plain_text_input',
          action_id: 'direction_input',
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: 'Give Quillio direction. Be specific — tone, angle, what to cut, what to emphasize.',
          },
        },
      },
    ],
  };
}

// Open a Slack modal via views.open. triggerId is short-lived (~3s), so call
// this promptly after acking the button click. Defaults to the env bot token,
// matching the rest of the interactions handler.
async function openModal(triggerId, view, token) {
  return slackApi('views.open', { trigger_id: triggerId, view }, token);
}

// Reviewer DM: Review Copy (link) + Approve + Request Changes (action buttons).
function reviewRequestBlocks({ campaignTitle, assetList, docUrl, projectRef }) {
  const line = assetList ? `*${campaignTitle}* — ${assetList}` : `*${campaignTitle}*`;
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `${emoji('quillio')} Copy ready for your review\n\n${line}` } },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Review Copy', emoji: true }, url: docUrl, action_id: 'review_copy' },
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve', emoji: true }, action_id: 'approve', value: projectRef },
        { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Request Changes', emoji: true }, action_id: 'request_changes', value: projectRef },
      ],
    },
  ];
}

// Designer DM after approval: View Doc (link) + Populate Figma.
function designerHandoffBlocks({ docUrl, projectRef }) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `${emoji('quillio')} Copy approved — ready for handoff` } },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'View Doc', emoji: true }, url: docUrl, action_id: 'open_in_drive' },
        { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Populate Figma', emoji: true }, action_id: 'populate_figma', value: projectRef },
      ],
    },
  ];
}

// Copywriter DM after a change request: Open Doc (link) + Resubmit when ready.
function changesRequestedBlocks({ reviewerName, docUrl, projectRef }) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `${emoji('quillio')} Changes requested — ${reviewerName} left feedback in the doc.` } },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Open Doc', emoji: true }, url: docUrl, action_id: 'open_in_drive' },
        { type: 'button', text: { type: 'plain_text', text: 'Resubmit when ready', emoji: true }, action_id: 'resubmit', value: projectRef },
      ],
    },
  ];
}

// a long generation finishes after the interaction's response_url has lapsed.
// Requires SLACK_BOT_TOKEN (chat:write); the bot must be able to post to the
// channel (member, or chat:write.public). Returns Slack's JSON response.
async function postChatMessage({ channel, text, webViewLink, token }) {
  const botToken = token || config.SLACK_BOT_TOKEN;
  if (!botToken) throw new Error('SLACK_BOT_TOKEN is not set.');
  if (!channel) throw new Error('No channel id for chat.postMessage.');

  const message = { channel, text };
  if (webViewLink) message.blocks = openInDriveBlocks(text, webViewLink);

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(message),
  });
  const data = await res.json();
  console.log(
    `[slack] chat.postMessage ok=${data.ok}${data.error ? ' error=' + data.error : ''}${
      data.ts ? ' ts=' + data.ts : ''
    }`
  );
  if (!data.ok) throw new Error('chat.postMessage failed: ' + data.error);
  return data;
}

// Replaces the original interactive message in place via its response_url.
// Used to give live feedback after a button tap (progress → final result).
// Pass opts.webViewLink to include an "Open in Drive" button on the message.
// Falls back to a fresh webhook post if no response_url is available.
async function updateMessage(text, responseUrl, opts = {}) {
  const body = { text };
  if (opts.webViewLink) {
    body.blocks = openInDriveBlocks(text, opts.webViewLink);
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

// Build a button value carrying the brief (+ optional folderId), truncating
// the brief if needed to stay under Slack's ~2000-char action value cap.
function recoveryValue(obj) {
  let v = JSON.stringify(obj);
  if (v.length > 1900) {
    const overhead = JSON.stringify({ ...obj, brief: '' }).length;
    const room = Math.max(0, 1900 - overhead);
    v = JSON.stringify({ ...obj, brief: String(obj.brief || '').slice(0, room) });
  }
  return v;
}

// Text + blocks for the recoverable folder-access error: the SA email and two
// buttons (Build in Default Folder, I've Shared It — Retry). The button values
// carry the brief (+ folderId) so the request can be reconstructed.
function buildFolderAccessBlocks({ email, folderId, brief }) {
  const text =
    `⚠️ I can't access that Drive folder (\`${folderId}\`).\n\n` +
    `To use it, share it with *${email}* as **Editor**, then click ` +
    `*I've Shared It — Retry* — or build in the default folder.`;
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Build in Default Folder', emoji: true },
          action_id: 'build_default',
          value: recoveryValue({ brief }),
        },
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: "I've Shared It — Retry", emoji: true },
          action_id: 'retry_folder',
          value: recoveryValue({ brief, folderId }),
        },
      ],
    },
  ];
  return { text, blocks };
}

// Recoverable folder-access error via response_url (fallback when there's no
// live chat message to edit).
async function postFolderAccessHelp({ email, folderId, brief, responseUrl }) {
  const { text, blocks } = buildFolderAccessBlocks({ email, folderId, brief });
  const url = responseUrl || config.SLACK_WEBHOOK_URL;
  console.log('[slack] postFolderAccessHelp -> ' + (responseUrl ? 'response_url' : 'webhook'));
  const res = await postToSlack(url, { replace_original: true, text, blocks });
  console.log('[slack] postFolderAccessHelp status ' + res.status);
  return res;
}

// --- Slack Web API helpers (chat.postMessage / chat.update) ---
// These post/edit a real message by ts, the only reliable way to transform a
// status message into its result in place (response_url replace_original can't
// edit the slash HTTP-ack message or a previously-posted response_url message).

async function slackApi(method, payload, token) {
  const botToken = token || config.SLACK_BOT_TOKEN;
  if (!botToken) throw new Error('SLACK_BOT_TOKEN is not set.');
  const res = await fetch('https://slack.com/api/' + method, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  console.log(
    `[slack] ${method} ok=${data.ok}${data.error ? ' error=' + data.error : ''}${
      data.ts ? ' ts=' + data.ts : ''
    }`
  );
  if (!data.ok) throw new Error(`${method} failed: ${data.error}`);
  return data;
}

// Post a "live" (editable) message; returns { channel, ts }.
async function postLive(channel, text, blocks, token) {
  const data = await slackApi(
    'chat.postMessage',
    blocks ? { channel, text, blocks } : { channel, text },
    token
  );
  return { channel: data.channel, ts: data.ts };
}

// Edit a live message in place by ts.
async function updateLive(channel, ts, text, blocks, token) {
  return slackApi('chat.update', blocks ? { channel, ts, text, blocks } : { channel, ts, text }, token);
}

// Diagnostic: log the bot user the SLACK_BOT_TOKEN actually belongs to. The
// name shown on chat.postMessage/chat.update messages is this bot user — the
// code never sets a username. If this logs "launchpen", Railway's token is the
// wrong app's; point SLACK_BOT_TOKEN at the Quillio app's bot token.
async function logBotIdentity() {
  if (!config.SLACK_BOT_TOKEN) {
    console.log('[slack] SLACK_BOT_TOKEN not set — chat.postMessage/update disabled');
    return;
  }
  try {
    const data = await slackApi('auth.test', {});
    console.log(
      `[slack] bot identity — user="${data.user}" bot_id=${data.bot_id || '?'} team="${data.team}"`
    );
  } catch (e) {
    console.error('[slack] auth.test failed:', e.message);
  }
}

module.exports = {
  postToSlack,
  buildResultBlocks,
  openInDriveBlocks,
  postResult,
  postText,
  updateMessage,
  postChatMessage,
  postFolderAccessHelp,
  logBotIdentity,
  buildFolderAccessBlocks,
  postLive,
  updateLive,
  copyCompleteBlocks,
  buildRegenerateModalView,
  openModal,
  reviewRequestBlocks,
  designerHandoffBlocks,
  changesRequestedBlocks,
};
