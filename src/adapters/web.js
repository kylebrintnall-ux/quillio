'use strict';

// Web adapter (Phase 3 / Week 8). Drives the same core/pipeline.js as the Slack
// adapter, but for browser requests — so it returns plain data objects and does
// NO messaging. There are intentionally zero Slack imports in this file (a smoke
// test enforces it); the only platform-specific input is the resolved tenant
// context, used read-only for token-gated reference fetching.
//
// tenantContext is the { tenant, tokens, source } shape resolveTenant returns.

const pipeline = require('../core/pipeline');
const { getClientsForTenant } = require('../google');
const { saveProject } = require('../db/projects');

// Pull a Drive folder id out of its webViewLink (…/folders/<id>). Returns null
// when there's no URL or no match — saveProject just stores a null folder id.
function folderIdFromUrl(url) {
  const m = /\/folders\/([^/?#]+)/.exec(url || '');
  return m ? m[1] : null;
}

// Run a brief end to end and return structured data for the browser. Mirrors
// the Slack adapter's pipeline sequence (parse → enrich → build) minus all the
// chat.update lifecycle. Throws on failure so the route can shape the error
// response; never leaks anything to the caller beyond the thrown message.
async function runWebBrief(briefText, tenantContext = {}, fileRefs = []) {
  const tokens = tenantContext.tokens || {};
  const tenantId = tenantContext.tenant && tenantContext.tenant.id;
  // Drive/Docs writes run as this tenant's Google OAuth user when they've
  // connected one (else the shared env path). Reference reads stay on the SA
  // path inside fetchAllReferences — the drive.file scope can't read arbitrary
  // pre-existing Drive files, only ones this app created.
  const clients = await getClientsForTenant(tenantId);

  // 1. Parse the brief into title / summary / writerPrompt / assets (+ links).
  const parsedBrief = await pipeline.parseBrief(briefText);
  const { campaignTitle, assets, unmatchedAssets, referenceLinks } = parsedBrief;
  let { summary, writerPrompt } = parsedBrief; // may be enriched below
  let referenceInsights = [];

  // If the brief named assets but none matched the library, surface exactly
  // what couldn't be matched instead of silently building the full set. (A
  // vague brief with no assets at all still falls through to "all assets".)
  if (assets.length === 0 && unmatchedAssets.length > 0) {
    throw new Error(
      `Couldn't match these to your asset library: ${unmatchedAssets.join(
        ', '
      )}. Add them to your library or try different asset names.`
    );
  }

  // 2. Enrich from linked references + attached files (best-effort — any failure
  //    leaves the parsed brief unchanged, exactly like the Slack adapter). Temp
  //    upload files are always cleaned up, success or failure.
  try {
    const { refs, counts } = await pipeline.fetchAllReferences(referenceLinks, tokens.slack_user);

    // Attached files (web uploads): read from temp paths, extract, then delete
    // the temp files immediately regardless of outcome.
    let uploadRefs = [];
    if (Array.isArray(fileRefs) && fileRefs.length > 0) {
      try {
        uploadRefs = await pipeline.processAttachedFiles(fileRefs);
      } finally {
        await pipeline.cleanupAttachedFiles(fileRefs);
      }
    }

    const allRefs = uploadRefs.length > 0 ? [...refs, ...uploadRefs] : refs;
    if (allRefs.length > 0) {
      const enriched = await pipeline.enrichWithReferences({ summary, writerPrompt }, allRefs);
      summary = enriched.summary;
      writerPrompt = enriched.writerPrompt;
      referenceInsights = Array.isArray(enriched.referenceInsights) ? enriched.referenceInsights : [];
      console.log(
        `[web] enriched brief from ${counts.drive} Drive + ${counts.external} external + ${counts.pdf} PDF + ${counts.canvas} canvas + ${uploadRefs.length} upload reference(s)`
      );
    }
  } catch (err) {
    console.error('[web] reference enrichment skipped:', err.message);
    // Ensure temp uploads are removed even if processing threw before its finally.
    await pipeline.cleanupAttachedFiles(fileRefs);
  }

  // 3. Folder routing: honor a Drive folder URL embedded in the brief; null
  //    falls through to the default folder inside generateDoc.
  const effectiveFolderId = pipeline.extractBriefFolderId(briefText);

  // 4. Build the document.
  console.log(
    `[web] pre-generateDoc references → links=${(referenceLinks || []).length} insights=${(referenceInsights || []).length}`
  );
  const { doc, assetSpecs, projectFolderUrl } = await pipeline.generateDoc(
    { brief: briefText, campaignTitle, summary, writerPrompt, assets, referenceLinks, referenceInsights },
    effectiveFolderId,
    clients,
    tenantId
  );

  // 5. Persist the project to history (best-effort). A DB hiccup — or simply no
  //    DATABASE_URL on the demo — must never fail an otherwise-good brief, so
  //    any error is swallowed and the brief response is unaffected.
  let projectId = null;
  try {
    const tenant = tenantContext.tenant || {};
    const saved = await saveProject(tenant.id, {
      name: campaignTitle,
      drive_folder_id: folderIdFromUrl(projectFolderUrl),
      drive_folder_url: projectFolderUrl,
      copy_doc_id: doc.id,
      copy_doc_url: doc.url,
      status: 'not_started',
    });
    if (saved) projectId = saved.id;
  } catch (err) {
    console.error('[web] saveProject skipped:', err.message);
  }

  return {
    projectId,
    docUrl: doc.url,
    folderUrl: projectFolderUrl,
    campaignTitle,
    assets: assetSpecs.map((a) => a.assetType),
    // Richer per-asset detail for the web UI: name + each field's char spec.
    // Keeps `assets` (names only) above for backward compatibility.
    assetBlocks: assetSpecs.map((a) => ({
      name: a.assetType,
      asset_direction: a.asset_direction || null,
      fields: (a.fields || []).map((f) => ({
        fieldName: f.fieldName,
        charMin: f.charMin,
        charMax: f.charMax,
      })),
    })),
    summary,
    writerDirection: writerPrompt,
    referenceInsights,
  };
}

// Generate (or, with `direction`, regenerate) the draft for an existing doc.
// tenantContext is accepted for a consistent signature (and future per-tenant
// config); generateDraft re-reads the doc itself, so no tokens are needed today.
// `direction` is optional user revision feedback threaded into the prompt.
async function runWebDraft(docId, tenantContext = {}, direction) {
  const tenantId = tenantContext.tenant && tenantContext.tenant.id;
  const clients = await getClientsForTenant(tenantId);
  const { title, fieldCount, url } = await pipeline.generateDraft(docId, direction, clients, tenantId);
  return { docId, title, fieldCount, url };
}

// Read a project's doc into the structured, copy-bearing shape the project view
// renders. The Docs read runs as the tenant's Google OAuth user when connected,
// else the shared env path. Throws on read failure so the route shows a fallback.
async function runWebProjectContent(docId, tenantContext = {}) {
  const clients = await getClientsForTenant(tenantContext.tenant && tenantContext.tenant.id);
  return pipeline.getProjectContent(docId, clients);
}

module.exports = { runWebBrief, runWebDraft, runWebProjectContent };
