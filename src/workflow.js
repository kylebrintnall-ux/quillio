'use strict';

const { parseBrief } = require('./services/gemini');
const { getAssetSpecs } = require('./services/sheets');
const { createBriefDoc, generateFirstDraft } = require('./services/docs');
const { postResult, postText } = require('./services/slack');

// The full 7s+ workflow. Runs AFTER Slack has been acknowledged — never call
// this before the slash command's 200 response has been sent.
async function runBriefWorkflow(brief) {
  // 1. Parse the brief into summary / writerPrompt / assets.
  const { summary, writerPrompt, assets } = await parseBrief(brief);

  // 2. Read + filter the asset specs.
  const assetSpecs = await getAssetSpecs(assets);

  // 3. Build the formatted Google Doc.
  const { docId, webViewLink, title } = await createBriefDoc({
    brief,
    summary,
    writerPrompt,
    assetSpecs,
  });

  // 4. Post the Block Kit result message to Slack.
  await postResult({
    title,
    webViewLink,
    assets: assetSpecs.map((a) => a.assetType),
    docId,
  });
}

// Handles the "Generate First Draft" button.
async function runGenerateDraft(docId, responseUrl) {
  const { title, fieldCount } = await generateFirstDraft(docId);
  await postText(
    `✍️ First draft generated for *${title}* — ${fieldCount} field${
      fieldCount === 1 ? '' : 's'
    } filled in.`,
    responseUrl
  );
}

module.exports = { runBriefWorkflow, runGenerateDraft };
