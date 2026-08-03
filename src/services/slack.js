'use strict';

const config = require('../config');
const { emoji } = require('../emoji');
const { mayWrite } = require('../liveMessage');

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

// The card's asset list, one bullet per asset TYPE. A doc can now hold several
// instances of one asset, and listing the same name three times reads like a bug;
// repeats collapse to "• Name ×3" instead. A single instance keeps its bare name,
// so every card written before instances existed is unchanged.
//
// Grouped by name in FIRST-APPEARANCE order, not by contiguous run: two separate
// plan entries naming one asset are still one line, which is what a reader
// scanning "what's in this doc" wants. Independent of the clamp notice below —
// the list says what the doc contains, the notice says what was cut, and a
// clamped build shows both.
function formatAssetList(assets) {
  const counts = new Map();
  for (const name of assets || []) {
    const key = String(name);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([name, n]) => (n > 1 ? `• ${name} ×${n}` : `• ${name}`)).join('\n');
}

// Block Kit message posted after the doc is built: title, asset list, an optional
// advisory notice, the Campaign folder / Copy doc hyperlinks, an optional
// "Saved to <folder>" line, and two buttons (Generate First Draft / Skip for now).
// folderUrl/folderName are optional — the folder link renders only when a project
// folder was made. `notice` is optional advisory context (see below).
function buildResultBlocks({ title, webViewLink, assets, docId, folderUrl, folderName, notice, unmatchedNotice, templateDocs = [] }) {
  // Punctuation rule for every user-facing string in the Slack surface:
  // in-progress → ellipsis, terminal sentence → period, HEADER BLOCK → period
  // (it is a line of copy the reader reads as a sentence, not a control),
  // BUTTON LABEL → nothing (it is a control, and a period on a button is wrong).
  // TEMPLATE-ONLY: the brief named a document template and no assets, so there is
  // no copy doc. The template document IS the deliverable, there is nothing to
  // draft, and the card must not offer a button that would act on nothing.
  const templateOnly = !webViewLink;
  const assetList = assets.length ? formatAssetList(assets) : '_No assets matched — included all specs._';

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji('quillio-doc-done')} Your ${templateOnly ? 'document' : 'doc'} is ready.`,
        emoji: true,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${title}*` },
    },
  ];
  // The asset list is about the COPY DOC. With no copy doc there are no assets
  // and printing "No assets matched — included all specs" would be a lie about a
  // document that does not exist.
  if (!templateOnly) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Assets:*\n${assetList}` } });
  }

  // An advisory line under the asset list — today, "built 3 of the 5 you asked
  // for" when a per-asset count hit the Slack ceiling. The build SUCCEEDED, so
  // this is context, not an error: the writer needs to know the doc holds fewer
  // versions than the brief asked for, without the card reading as a failure.
  if (notice) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: notice }] });
  }

  // The other advisory line: an asset the brief named that didn't map to any
  // supported type. Its own context block, not folded into `notice`, because the
  // two are independent — a brief can hit the per-asset ceiling, miss a name,
  // both, or neither, and merging them would make either one imply the other.
  // Like `notice` this is CONTEXT, not an error: the doc above was built.
  if (unmatchedNotice) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: unmatchedNotice }] });
  }

  // Folder + doc links as Slack hyperlinks, below the asset list. The doc link
  // replaces the old "Open in Drive" button; the folder link only renders when a
  // project folder was actually created.
  const links = [];
  if (folderUrl) links.push(`${emoji('quillio-folder')} <${folderUrl}|Campaign folder>`);
  // THE COPY DOC STAYS PRIMARY — first in the list, and the button below still
  // acts on it. A template document is an additional artifact, not a competing
  // one, and a writer who opens the wrong one first loses the brief context.
  if (webViewLink) links.push(`${emoji('quillio-doc-done')} <${webViewLink}|Copy doc>`);
  for (const t of templateDocs || []) {
    if (t && t.url) links.push(`${emoji('quillio-doc-done')} <${t.url}|${t.templateName || 'Template document'}>`);
  }
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: links.join('\n') } });

  // A template document that failed to build. Its own context line, like the
  // other two advisories: the copy doc above WAS built, so this is context, not
  // an error card — but it must not be silent, because the writer is expecting a
  // second document and would otherwise just not find one.
  const failed = (templateDocs || []).filter((t) => t && t.error);
  if (failed.length) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            `Couldn't build ${failed.map((t) => `*${t.templateName || 'a template document'}*`).join(', ')}. ` +
            (templateOnly
              ? 'Nothing else was requested, so nothing was built.'
              : 'The copy doc is ready; check the template document in Settings.'),
        },
      ],
    });
  }

  // "Saved to <folder>" confirmation, below the links (only for brief-linked folders).
  if (folderName) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${emoji('quillio-folder')} Saved to ${folderName}.` },
    });
  }

  // NO BUTTONS ON A TEMPLATE-ONLY CARD. Both act on the copy doc id, and the
  // template document was already drafted when it was built — there is no second
  // step to offer.
  if (templateOnly) return { blocks };

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

// THE DRIVE BUTTONS, shared by every confirmation card.
//
// The FOLDER comes first, and it is the one labelled for the run as a whole. A
// run can now produce more than one document (custom document types), so a
// single button opening one of them picks a winner arbitrarily — and even with
// one document the folder is the better landing place, because it shows
// everything the run produced rather than one artifact of it.
//
// The copy doc keeps its own button. It is what a writer usually wants next, and
// the folder is one extra click away from it.
//
// With no folder url — creation failed, or a project that predates folders —
// this collapses to exactly the single button it was before, labelled the way it
// always was. A card is never rendered with a button that goes nowhere.
//
// Labels take no terminal punctuation: they are controls, not sentences. They
// deliberately match the doc-ready card's link text ("Campaign folder", "Copy
// doc") so the two cards name the same things the same way.
function driveButtons(webViewLink, folderUrl) {
  const buttons = [];
  if (folderUrl) {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Campaign folder', emoji: true },
      url: folderUrl,
      action_id: 'open_campaign_folder',
    });
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Copy doc', emoji: true },
      url: webViewLink,
      action_id: 'open_in_drive',
    });
  } else if (webViewLink) {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Open in Drive', emoji: true },
      url: webViewLink,
      action_id: 'open_in_drive',
    });
  }
  return buttons;
}

// Block Kit for a confirmation: a section + the Drive buttons.
function openInDriveBlocks(text, webViewLink, folderUrl) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    { type: 'actions', elements: driveButtons(webViewLink, folderUrl) },
  ];
}

// Copy-complete card: the Drive buttons + Regenerate.
function copyCompleteBlocks(text, webViewLink, docId, folderUrl) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: [
        ...driveButtons(webViewLink, folderUrl),
        { type: 'button', text: { type: 'plain_text', text: 'Regenerate', emoji: true }, action_id: 'regenerate_draft', value: docId },
      ],
    },
  ];
}

// One line per plan entry for the confirmation card: "• 3 × Event Invitation Email
// — Austin, Denver, Chicago". Counts are shown even at 1 so the card reads as a
// tally rather than a list, which is the whole point of showing it.
function planLines(plan) {
  return (plan || [])
    .map((e) => {
      const count = Number(e && e.count) || 1;
      const labels = Array.isArray(e && e.labels) ? e.labels.filter(Boolean) : [];
      const uniq = [...new Set(labels)];
      const tail = uniq.length ? ` — ${uniq.join(', ')}` : '';
      return `• *${count} ×* ${e.asset}${tail}`;
    })
    .join('\n');
}

// The plan-confirmation card: what Quillio read out of the brief, and three ways
// forward. Shown ONLY when the plan has something worth correcting (a repeat or a
// label) — a one-of-each brief never sees it.
//
// Only the pendingId rides in the button values. Slack caps an action value near
// 2000 chars, and a plan with labels can exceed that easily, so the plan itself
// stays server-side in pendingBriefs and the buttons carry the key to it.
//
// The card states that nothing exists yet, because the doc-ready card that
// normally lands here looks similar and the difference matters.
function buildPlanCardBlocks({ pendingId, campaignTitle, plan, unmatchedNotice }) {
  const total = (plan || []).reduce((n, e) => n + (Number(e && e.count) || 1), 0);
  const title = String(campaignTitle || 'Your campaign');
  const text = `${emoji('quillio-scroll')} Here's how I read that brief — ${title}`;
  return {
    text,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: "Here's how I read that brief.", emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `*${title}*` } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${total} version${total === 1 ? '' : 's'} to write:*\n${planLines(plan)}`,
        },
      },
      // An asset the brief named that didn't map to any supported type. Shown
      // HERE, above the buttons, because this card is the last point before
      // anything is built — seeing it now is what lets the user cancel and
      // rename rather than discover the gap in a finished doc. Omitted entirely
      // when everything matched, so the card is unchanged for those briefs.
      ...(unmatchedNotice
        ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: unmatchedNotice }] }]
        : []),
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Nothing has been created yet. Build it, change the counts, or cancel.',
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            style: 'primary',
            text: { type: 'plain_text', text: 'Build the doc', emoji: true },
            action_id: 'plan_build',
            value: pendingId,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Edit counts', emoji: true },
            action_id: 'plan_edit',
            value: pendingId,
          },
          // No `style` — deliberately plain, not danger. Nothing has been created
          // at this point (the context line above says so), so cancelling destroys
          // nothing and a red button would overstate the stakes of the safest
          // choice on the card.
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Cancel', emoji: true },
            action_id: 'plan_cancel',
            value: pendingId,
          },
        ],
      },
    ],
  };
}

// The "Edit counts" modal: one text input per plan entry, pre-filled with the
// parsed count. Opened from the Edit button's FRESH trigger_id — the slash command's
// own trigger_id is long expired by the time parsing finishes, which is why the
// plan arrives as a card rather than a modal in the first place.
//
// plain_text_input rather than number_input: it renders on every Slack client and
// the value is clamped server-side by sanitizeAssetPlan regardless, so the stricter
// widget would buy nothing but a compatibility risk.
//
// The asset NAME is not editable and does not ride in the submission — block ids are
// positional (count_0, count_1, …) and resolved against the stored plan, so a
// submission can only ever change counts, never introduce an asset.
function buildPlanEditModalView(privateMetadata, plan) {
  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: 'How many versions of each? Leave a row alone to keep it as-is.' },
    },
  ];
  (plan || []).forEach((e, i) => {
    const labels = Array.isArray(e.labels) ? e.labels.filter(Boolean) : [];
    const uniq = [...new Set(labels)];
    blocks.push({
      type: 'input',
      block_id: `count_${i}`,
      label: { type: 'plain_text', text: String(e.asset).slice(0, 150), emoji: true },
      hint: uniq.length
        ? { type: 'plain_text', text: uniq.join(', ').slice(0, 150) }
        : undefined,
      element: {
        type: 'plain_text_input',
        action_id: 'count_input',
        initial_value: String(Number(e.count) || 1),
        max_length: 3,
      },
    });
  });
  return {
    type: 'modal',
    callback_id: 'plan_modal',
    private_metadata: privateMetadata || '',
    title: { type: 'plain_text', text: 'Edit the plan', emoji: true },
    submit: { type: 'plain_text', text: 'Build the doc', emoji: true },
    close: { type: 'plain_text', text: 'Back', emoji: true },
    blocks,
  };
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

// a long generation finishes after the interaction's response_url has lapsed.
// Requires SLACK_BOT_TOKEN (chat:write); the bot must be able to post to the
// channel (member, or chat:write.public). Returns Slack's JSON response.
async function postChatMessage({ channel, text, webViewLink, folderUrl, token }) {
  const botToken = token || config.SLACK_BOT_TOKEN;
  if (!botToken) throw new Error('SLACK_BOT_TOKEN is not set.');
  if (!channel) throw new Error('No channel id for chat.postMessage.');

  const message = { channel, text };
  if (webViewLink) message.blocks = openInDriveBlocks(text, webViewLink, folderUrl);

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
  // Explicit blocks win (the plan-confirmation card needs its buttons to survive
  // the response_url path, which is the only path when a workspace has no bot
  // token). webViewLink remains the shorthand for the Open-in-Drive card.
  if (opts.blocks) {
    body.blocks = opts.blocks;
  } else if (opts.webViewLink) {
    body.blocks = openInDriveBlocks(text, opts.webViewLink, opts.folderUrl);
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

// Can chat.postMessage / chat.update actually run for this caller?
//
// slackApi above falls back to config.SLACK_BOT_TOKEN when a caller passes no
// token, so a tenant having no `slack_bot` row in Postgres does NOT mean live
// editing is impossible — an env-configured workspace has a working token the
// whole time. Callers must ask THIS function rather than testing
// `tokens.slack_bot` themselves, because the two answers diverging is a real bug
// with a visible symptom: a caller that decides "no live message" while
// updateLive would have succeeded posts its final card as a NEW message and
// leaves the "Building…" one orphaned above it.
function canUseBotToken(token) {
  return !!(token || config.SLACK_BOT_TOKEN);
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
// `runSeq` (optional) is the caller's run sequence from liveMessage.beginRun. A
// write from a run that has since been superseded is DROPPED rather than sent:
// with the whole flow collapsed onto one ts, a late write does not add a stray
// message any more, it destroys the finished card. Omitting runSeq is allowed and
// unguarded, so a path that has not been taught about it behaves exactly as before.
async function updateLive(channel, ts, text, blocks, token, runSeq) {
  if (!mayWrite(channel, ts, runSeq)) {
    console.warn(`[slack] chat.update SKIPPED — run ${runSeq} superseded on ${channel}/${ts}`);
    return { ok: true, skipped: true };
  }
  return slackApi('chat.update', blocks ? { channel, ts, text, blocks } : { channel, ts, text }, token);
}

// The message shown when a Slack user runs Quillio without having linked their
// own account (Stage 2 of the Slack-user link). Only the user sees it.
const UNLINKED_REFUSAL_TEXT =
  "You haven't connected Quillio to your account yet. Visit " +
  'https://quillio.co/settings → Workspace → Connect Slack to link your ' +
  'account, then try again.';

// Post the "you're not linked" refusal to just the invoking user (ephemeral).
// Prefers the response_url (slash commands / block-action interactions carry
// one and it needs no token); falls back to chat.postEphemeral for the
// view_submission (Regenerate modal) path, which has no response_url. All
// failures are swallowed with a warning — refusing must never crash the request.
async function refuseUnlinkedSlack({ responseUrl, channel, slackUserId } = {}) {
  try {
    if (responseUrl) {
      await postToSlack(responseUrl, {
        response_type: 'ephemeral',
        text: UNLINKED_REFUSAL_TEXT,
      });
      return;
    }
    if (channel && slackUserId && config.SLACK_BOT_TOKEN) {
      await slackApi('chat.postEphemeral', {
        channel,
        user: slackUserId,
        text: UNLINKED_REFUSAL_TEXT,
      });
      return;
    }
    console.warn('[slack] refuseUnlinkedSlack: no response_url and no channel/user/token — cannot notify user');
  } catch (e) {
    console.error('[slack] refuseUnlinkedSlack failed:', e.message);
  }
}

// Post an ephemeral message visible only to `user` in `channel` (mrkdwn `text`).
// Best-effort: needs a bot token + channel + user; failures are logged, never
// thrown — an ephemeral notice must not crash the request.
async function postEphemeral({ channel, user, text } = {}) {
  try {
    if (channel && user && config.SLACK_BOT_TOKEN) {
      await slackApi('chat.postEphemeral', { channel, user, text });
      return;
    }
    console.warn('[slack] postEphemeral: missing channel/user/token — cannot post');
  } catch (e) {
    console.error('[slack] postEphemeral failed:', e.message);
  }
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
  driveButtons,
  postResult,
  updateMessage,
  postChatMessage,
  postFolderAccessHelp,
  logBotIdentity,
  buildFolderAccessBlocks,
  postLive,
  updateLive,
  canUseBotToken,
  refuseUnlinkedSlack,
  postEphemeral,
  copyCompleteBlocks,
  buildRegenerateModalView,
  buildPlanCardBlocks,
  buildPlanEditModalView,
  planLines,
  openModal,
};
