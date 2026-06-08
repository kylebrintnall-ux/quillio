'use strict';

const { parseBrief } = require('./services/gemini');
const { getAssetSpecs } = require('./services/sheets');
const { getDestination } = require('./destinations');
const { postResult, updateMessage } = require('./services/slack');

// The full 7s+ workflow. Runs AFTER Slack has been acknowledged — never call
// this before the slash command's 200 response has been sent.
async function runBriefWorkflow(brief) {
  // 1. Parse the brief into summary / writerPrompt / assets.
  const { summary, writerPrompt, assets } = await parseBrief(brief);
  console.log('[workflow] Gemini returned assets:', JSON.stringify(assets));

  // 2. Read + filter the asset specs.
  const assetSpecs = await getAssetSpecs(assets);

  // 3. Build the formatted document via the configured destination adapter.
  const { id, url, title } = await getDestination().createDocument({
    brief,
    summary,
    writerPrompt,
    assetSpecs,
  });

  // 4. Post the Block Kit result message to Slack.
  await postResult({
    title,
    webViewLink: url,
    assets: assetSpecs.map((a) => a.assetType),
    docId: id,
  });
}

// Handles the "Generate First Draft" button. Updates the original message in
// place: first an immediate "working on it" so the tap feels responsive, then
// the final confirmation when the draft is done.
async function runGenerateDraft(docId, responseUrl) {
  await updateMessage(
    '✍️ Generating your first draft… this takes about 60 seconds.',
    responseUrl
  );

  const { title, fieldCount, url } = await getDestination().generateDraft(docId);

  await updateMessage(
    `✅ First draft generated for *${title}* — ${fieldCount} field${
      fieldCount === 1 ? '' : 's'
    } filled in.`,
    responseUrl,
    { webViewLink: url }
  );
}

module.exports = { runBriefWorkflow, runGenerateDraft };
