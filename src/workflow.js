'use strict';

const config = require('./config');
const { parseBrief } = require('./services/gemini');
const { getAssetSpecs } = require('./services/sheets');
const { getDestination } = require('./destinations');
const { postResult, updateMessage, postChatMessage } = require('./services/slack');

// The full 7s+ workflow. Runs AFTER Slack has been acknowledged — never call
// this before the slash command's 200 response has been sent. The entire body
// is wrapped so any failure surfaces in the logs with a full stack trace
// instead of dying silently; it re-throws so the caller can notify Slack.
async function runBriefWorkflow(brief, responseUrl) {
  // Confirms the pipeline is actually invoked after the ack (before any I/O).
  console.log('[workflow] runBriefWorkflow START — brief chars:', (brief || '').length);

  try {
    // 1. Parse the brief into title / summary / writerPrompt / assets (+ folder & links).
    const { campaignTitle, summary, writerPrompt, assets, folderId, referenceLinks } =
      await parseBrief(brief);
    console.log('[workflow] Gemini parse OK — assets:', JSON.stringify(assets));
    console.log('[workflow] campaignTitle:', JSON.stringify(campaignTitle));
    console.log('[workflow] folderId:', folderId, '| referenceLinks:', JSON.stringify(referenceLinks));

    // 2. Read + filter the asset specs. Log the Sheet ID so a permission/403 on
    //    the v2 Sheet is obvious in the logs.
    console.log('[workflow] reading Sheet', config.SHEET_ID, '…');
    const assetSpecs = await getAssetSpecs(assets);
    console.log(
      '[workflow] Sheet read OK —',
      assetSpecs.length,
      'asset group(s):',
      JSON.stringify(assetSpecs.map((a) => a.assetType))
    );

    // 3. Build the formatted document via the configured destination adapter.
    //    Use the folder extracted from the brief if present, else the env default.
    const { id, url, title } = await getDestination().createDocument({
      brief,
      campaignTitle,
      summary,
      writerPrompt,
      assetSpecs,
      folderId,
      referenceLinks,
    });
    console.log('[workflow] doc created:', id);

    // 4. Post the Block Kit result back to the channel the command came from
    //    (via response_url), falling back to the configured webhook.
    await postResult(
      {
        title,
        webViewLink: url,
        assets: assetSpecs.map((a) => a.assetType),
        docId: id,
      },
      responseUrl
    );
    console.log('[workflow] runBriefWorkflow DONE — doc', id);
  } catch (err) {
    console.error('[workflow] runBriefWorkflow FAILED:', err && err.stack ? err.stack : err);
    throw err;
  }
}

// Handles the "Generate First Draft" button. Updates the original message in
// place: first an immediate "working on it" so the tap feels responsive, then
// the final confirmation when the draft is done.
async function runGenerateDraft(docId, responseUrl, channelId) {
  console.log(
    '[workflow] runGenerateDraft START — response_url present:',
    !!responseUrl,
    '| channel:',
    channelId || '(none)'
  );

  // Progress: fire immediately on the response_url (well within its window).
  await updateMessage(
    ':quillio: Generating your first draft… this takes about 60 seconds.',
    responseUrl,
    { label: 'draft-progress' }
  );

  const { title, fieldCount, url } = await getDestination().generateDraft(docId);
  console.log('[workflow] generateDraft returned — posting completion message');

  const completionText = `✓ First draft ready — *${title}* (${fieldCount} field${
    fieldCount === 1 ? '' : 's'
  } drafted).`;

  // Completion: post via chat.postMessage (no expiry) so it lands even after a
  // long (multi-asset) generation outlives the response_url. Fall back to a
  // fresh response_url message if the bot token / channel isn't available.
  try {
    await postChatMessage({ channel: channelId, text: completionText, webViewLink: url });
  } catch (err) {
    console.error(
      '[workflow] chat.postMessage completion failed, falling back to response_url:',
      err.message
    );
    await updateMessage(completionText, responseUrl, {
      webViewLink: url,
      label: 'draft-complete',
      newMessage: true,
    });
  }
  console.log('[workflow] runGenerateDraft DONE');
}

module.exports = { runBriefWorkflow, runGenerateDraft };
