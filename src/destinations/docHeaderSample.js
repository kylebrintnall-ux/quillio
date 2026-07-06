'use strict';

// Onboarding header-sample generator (doc-header-template work, step 3).
//
// Produces a STANDALONE sample Google Doc a user opens and edits to shape their
// copy-doc header (PHASE4_BUILD_PLAN_EXTENSIONS.md §2: "generate a sample -> let
// the user adjust -> lock it in"). It is deliberately separate from the normal
// createDocument() pipeline — this touches no real campaign, and createDocument
// is unchanged.
//
// Layout of the generated doc:
//   [ header rendered from a block schema via DocBuilder.renderHeader() ]
//   [ BOUNDARY MARKER — a visible line telling the user to edit ABOVE it ]
//   [ short sample body so the doc reads like a real copy doc ]
//
// THE BOUNDARY MARKER (Step 4's re-read depends on this — read carefully):
//   The marker is a single paragraph whose exact text is HEADER_BOUNDARY_MARKER
//   (exported below). It is the ONE stable, unambiguous anchor separating the
//   editable header from the sample body:
//     • Everything BEFORE the marker paragraph = the header the user edited
//       (what Step 4 re-reads and re-extracts into a schema).
//     • The marker paragraph and everything AFTER it = boundary + sample body
//       (ignored by the re-read).
//   Step 4 locates it by scanning the doc's paragraphs for the first one whose
//   trimmed text equals HEADER_BOUNDARY_MARKER. The string is intentionally
//   distinctive (U+23AF line extensions + a fixed sentence) and sits BELOW the
//   header, so a user shaping their header above it is unlikely to alter it.
//   The marker is also styled (centered, bold, grey via DocBuilder.boundaryMarker)
//   so it reads as a system divider — but re-read keys on the TEXT, not the style.

const config = require('../config');
const { getClients } = require('../google');
const { DocBuilder } = require('./docBuilder');
const { findHeaderTable } = require('./docHeaderTable');
const { isValidHeaderSchema } = require('./docHeaderSchema');

// The stable boundary string. Do NOT change casually — Step 4's re-read matches
// it exactly. U+23AF (HORIZONTAL LINE EXTENSION) runs draw a clean unbroken rule.
const HEADER_BOUNDARY_MARKER =
  '⎯⎯⎯⎯⎯ HEADER ENDS · edit above this line — your copy appears below ⎯⎯⎯⎯⎯';

const SAMPLE_DOC_NAME = 'Quillio — Header Setup Sample';

// Append the boundary marker + a short representative body onto `b`. Kept as its
// own function so the ordering (marker first, then sample) is testable without
// hitting Google.
function appendMarkerAndSample(b) {
  b.boundaryMarker(HEADER_BOUNDARY_MARKER);
  b.blankLine();
  b.italic(
    'Below is a sample of how your copy doc will look. Edit your header above ' +
      'the line; this preview is illustrative only.'
  );
  b.blankLine();
  b.heading('Campaign Summary');
  b.italic('A short campaign summary will appear here.');
  b.heading('Writer Direction');
  b.italic('Creative direction for your writers will appear here.');
  return b;
}

// Generate the standalone onboarding sample doc for a tenant.
//   headerSchema — a block schema (docHeaderSchema.js) to render as the draft
//     header. For now callers pass a seeded schema; Step 5 will supply a
//     Gemini-extracted one. If absent/invalid, a minimal default header is used
//     so the doc still generates.
//   folderId — where to create the doc (defaults to config.DRIVE_FOLDER_ID).
//   clients — optional { drive, docs } (a tenant's OAuth user); else shared.
//   docName — optional override for the doc title.
// Returns { id, url } — the webViewLink to open and edit.
async function generateHeaderSampleDoc({ headerSchema, folderId, clients, docName } = {}) {
  const { drive, docs } = clients || (await getClients());
  const name = docName || SAMPLE_DOC_NAME;

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.document',
      parents: [folderId || config.DRIVE_FOLDER_ID],
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });
  const docId = created.data.id;

  // Build the draft header (mirrors createDocument's header handling, but this is
  // a separate onboarding path — createDocument itself is untouched).
  const b = new DocBuilder();
  if (isValidHeaderSchema(headerSchema)) {
    b.renderHeader(headerSchema);
  } else {
    b.title('Your header');
    b.horizontalRule();
  }

  if (b.hasHeaderTable()) {
    // Two-phase table header: insert the table, re-read to locate/fill it, then
    // render the marker + sample body below the filled table.
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: b.headerTableInsertRequests() },
    });

    let reread = (await docs.documents.get({ documentId: docId })).data;
    let tableEl = findHeaderTable(reread);
    if (!tableEl) throw new Error('sample header table not found after insert');
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: b.headerTableFillRequests(tableEl) },
    });

    reread = (await docs.documents.get({ documentId: docId })).data;
    tableEl = findHeaderTable(reread);
    const below = new DocBuilder(tableEl.endIndex);
    appendMarkerAndSample(below);
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: below.buildRequests() },
    });
  } else {
    // Text-only header — header + marker + sample fold into one batchUpdate.
    appendMarkerAndSample(b);
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: { requests: b.buildRequests() },
    });
  }

  console.log(`[docHeaderSample] sample doc created: ${docId}`);
  return { id: docId, url: created.data.webViewLink };
}

module.exports = {
  HEADER_BOUNDARY_MARKER,
  SAMPLE_DOC_NAME,
  appendMarkerAndSample,
  generateHeaderSampleDoc,
};
