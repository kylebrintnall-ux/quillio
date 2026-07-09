'use strict';

// Slack /quillio-review trigger (copy-review feature, 8c). Resolves the doc from
// the channel's project context (or a pasted Drive link), posts a live message
// with the review GIF, runs the review, then updates that message in place
// (chat.update) with the copy-done GIF + digest + qualitative status + doc link.
// Never leaves the review GIF spinning: failures update to a graceful error.

const config = require('../config');
const { resolveTenant } = require('../db');
const { getProjectByChannel } = require('../db/projects');
const { getClientsForTenant } = require('../google');
const { postLive, updateLive } = require('../services/slack');
const { runCopyReview } = require('../services/copyReview');

const GIF_REVIEW = `${config.PUBLIC_BASE_URL}/assets/gifs/quillio-review.gif`;
const GIF_DONE = `${config.PUBLIC_BASE_URL}/assets/gifs/quillio-copy-done.gif`;

// Pull a Google Docs id out of a pasted link (or a bare id), or null.
function docIdFromText(text) {
  const s = String(text || '');
  const m = s.match(/\/document\/d\/([a-zA-Z0-9_-]+)/) || s.match(/\b([a-zA-Z0-9_-]{25,})\b/);
  return m ? m[1] : null;
}

function gifBlocks(gifUrl, alt, lines) {
  return [
    { type: 'image', image_url: gifUrl, alt_text: alt },
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
  ];
}

// Run the review from a /quillio-review slash command. `text` is the command
// text (may carry a Drive link), `channelId`/`workspaceId` from the payload.
async function runSlackReview({ text, channelId, workspaceId }) {
  const token = config.SLACK_BOT_TOKEN;
  const { tenant } = await resolveTenant(workspaceId);
  const tenantId = tenant && tenant.id;

  // Resolve the doc: an explicit link wins; otherwise the channel's latest project.
  let docId = docIdFromText(text);
  let docUrl = docId ? `https://docs.google.com/document/d/${docId}/edit` : null;
  if (!docId) {
    const project = await getProjectByChannel(tenantId, channelId).catch(() => null);
    if (project && project.copy_doc_id) {
      docId = project.copy_doc_id;
      docUrl = project.copy_doc_url || `https://docs.google.com/document/d/${docId}/edit`;
    }
  }

  if (!docId) {
    await postLive(
      channelId,
      'Nothing to review yet.',
      [{ type: 'section', text: { type: 'mrkdwn', text: "I couldn't find a copy doc here. Run this in a project's channel, or paste a Drive doc link: `/quillio-review <link>`." } }],
      token
    );
    return;
  }

  // Post the in-progress message (capture ts to update in place).
  const posted = await postLive(channelId, 'Reviewing your copy…', gifBlocks(GIF_REVIEW, 'Reviewing', ['*Reviewing your copy…*']), token);

  try {
    const clients = await getClientsForTenant(tenantId);
    const result = await runCopyReview(docId, tenantId, clients);

    if (!result.hadCopy) {
      await updateLive(
        posted.channel,
        posted.ts,
        'Nothing to review yet.',
        [{ type: 'section', text: { type: 'mrkdwn', text: `*Nothing to review yet* — this doc has no drafted copy. Generate a first draft, then run \`/quillio-review\`.` } }],
        token
      );
      return;
    }

    const lines = [
      `*${result.status}*`,
      result.digest,
      docUrl ? `<${docUrl}|Open the doc>` : '',
    ].filter(Boolean);
    await updateLive(posted.channel, posted.ts, result.status, gifBlocks(GIF_DONE, 'Review complete', lines), token);
  } catch (err) {
    console.error('[slack] review failed:', err.message);
    await updateLive(
      posted.channel,
      posted.ts,
      'Review didn’t finish.',
      [{ type: 'section', text: { type: 'mrkdwn', text: `⚠️ *Review didn't finish* — ${err.message}. Try again in a moment.` } }],
      token
    ).catch(() => {});
  }
}

module.exports = { runSlackReview, docIdFromText };
