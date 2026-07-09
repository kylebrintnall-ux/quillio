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

// Inline custom emoji (shown next to the text) instead of a large image block.
const REVIEW_EMOJI = config.SLACK_REVIEW_EMOJI;

// Pull a Google Docs id out of a pasted link (or a bare id), or null. Handles
// Slack's URL wrapping — it sends a pasted URL as <url> or <url|label>, so the
// raw slash-command text is e.g. "<https://docs.google.com/document/d/ID/edit?usp=drivesdk>".
// Also covers Docs/Sheets/Slides (/d/ID) and Drive (file/d/ID, open?id=ID) forms.
function docIdFromText(text) {
  let s = String(text || '').trim();
  // Unwrap Slack's <url> / <url|label> so the id regexes see a clean URL.
  const angle = s.match(/<([^|>]+)(?:\|[^>]*)?>/);
  if (angle) s = angle[1];
  const m =
    s.match(/\/d\/([a-zA-Z0-9_-]{20,})/) || // .../document|spreadsheets|presentation|file/d/<ID>/...
    s.match(/[?&]id=([a-zA-Z0-9_-]{20,})/) || // .../open?id=<ID>
    s.match(/\b([a-zA-Z0-9_-]{25,})\b/); // bare id pasted on its own
  return m ? m[1] : null;
}

// One section block with the inline emoji next to the text.
function emojiBlocks(lines) {
  return [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }];
}

// Run the review from a /quillio-review slash command. `text` is the command
// text (may carry a Drive link), `channelId`/`workspaceId` from the payload.
async function runSlackReview({ text, channelId, workspaceId }) {
  const token = config.SLACK_BOT_TOKEN;
  console.log(`[slack] /quillio-review received — channel=${channelId} text=${JSON.stringify(text || '')}`);
  const { tenant } = await resolveTenant(workspaceId);
  const tenantId = tenant && tenant.id;

  // Resolve the doc: an explicit link wins; otherwise the channel's latest project.
  const linkId = docIdFromText(text);
  let docId = linkId;
  let docUrl = docId ? `https://docs.google.com/document/d/${docId}/edit` : null;
  if (!docId) {
    const project = await getProjectByChannel(tenantId, channelId).catch(() => null);
    if (project && project.copy_doc_id) {
      docId = project.copy_doc_id;
      docUrl = project.copy_doc_url || `https://docs.google.com/document/d/${docId}/edit`;
    }
  }
  console.log(`[slack] /quillio-review resolved docId=${docId || '(none)'} source=${linkId ? 'pasted-link' : docId ? 'channel-project' : 'none'}`);

  if (!docId) {
    await postLive(
      channelId,
      'Nothing to review yet.',
      emojiBlocks(["I couldn't find a copy doc here. Run this in a project's channel, or paste a Drive doc link: `/quillio-review <link>`."]),
      token
    ).catch((e) => console.error('[slack] review no-doc post failed:', e.message));
    return;
  }

  // Post the in-progress message (capture ts to update in place). Guarded so a
  // post failure (e.g. the bot isn't in this channel) is LOGGED with context
  // rather than bubbling up as an invisible rejection.
  let posted;
  try {
    posted = await postLive(channelId, 'Reviewing your copy…', emojiBlocks([`${REVIEW_EMOJI} *Reviewing your copy…*`]), token);
  } catch (e) {
    console.error(`[slack] review in-progress post failed (channel=${channelId}):`, e.message);
    return;
  }

  try {
    const clients = await getClientsForTenant(tenantId);
    const result = await runCopyReview(docId, tenantId, clients);

    if (!result.hadCopy) {
      await updateLive(
        posted.channel,
        posted.ts,
        'Nothing to review yet.',
        emojiBlocks([`${REVIEW_EMOJI} *Nothing to review yet* — this doc has no drafted copy. Generate a first draft, then run \`/quillio-review\`.`]),
        token
      );
      return;
    }

    const lines = [
      `${REVIEW_EMOJI} *${result.status}*`,
      result.digest,
      docUrl ? `<${docUrl}|Open the doc>` : '',
    ].filter(Boolean);
    await updateLive(posted.channel, posted.ts, result.status, emojiBlocks(lines), token);
  } catch (err) {
    console.error('[slack] review failed:', err.message);
    await updateLive(
      posted.channel,
      posted.ts,
      'Review didn’t finish.',
      emojiBlocks([`⚠️ *Review didn't finish* — ${err.message}. Try again in a moment.`]),
      token
    ).catch(() => {});
  }
}

module.exports = { runSlackReview, docIdFromText };
