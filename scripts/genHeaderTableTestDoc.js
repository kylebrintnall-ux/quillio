'use strict';

// Generate a real Google Doc with the hardcoded SAMPLE_HEADER_SCHEMA header table
// at the TOP, followed by the normal title / Campaign Summary / Writer Direction
// body — so we can eyeball the rendered table and iterate on borders, column
// widths, and formatting. Prints the doc URL.
//
// This is a dev/test harness for the header-table primitive (doc-header-template
// work, step 1). It does NOT touch the production pipeline — no schema extraction,
// storage, or UI, and createDocument is unchanged.
//
// Usage:  railway run node scripts/genHeaderTableTestDoc.js
//   (needs the same Google client credentials the app already uses; writes into
//    the configured DRIVE_FOLDER_ID. Locally you can run with the app's env.)
//
// Doc tables are two-phase (insert → re-read → style+fill), so this makes a few
// batchUpdate calls with a document re-read between them (see docHeaderTable.js).

const config = require('../src/config');
const { getClients } = require('../src/google');
const { DocBuilder } = require('../src/destinations/docBuilder');
const { SAMPLE_HEADER_SCHEMA, findHeaderTable } = require('../src/destinations/docHeaderTable');

async function main() {
  const { drive, docs } = await getClients();

  // 1. Create a blank doc in the configured folder.
  const created = await drive.files.create({
    requestBody: {
      name: 'Header Table Test — ' + new Date().toISOString().slice(0, 16).replace('T', ' '),
      mimeType: 'application/vnd.google-apps.document',
      parents: [config.DRIVE_FOLDER_ID],
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });
  const docId = created.data.id;
  console.log('[gen] blank doc created:', docId);

  const b = new DocBuilder();
  b.headerTable(SAMPLE_HEADER_SCHEMA);

  // 2. Phase 1 — insert the empty table.
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests: b.headerTableInsertRequests() },
  });
  console.log('[gen] table inserted');

  // 3. Re-read to locate the table + its cells.
  let doc = (await docs.documents.get({ documentId: docId })).data;
  let tableEl = findHeaderTable(doc);
  if (!tableEl) throw new Error('header table not found after insert');

  // 4. Phase 2 — style the table + fill cells (reverse order).
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests: b.headerTableFillRequests(tableEl) },
  });
  console.log('[gen] table styled + filled');

  // 5. Re-read for the (now larger) table end, then render the normal body AFTER
  //    it — additive: this is the same title/summary/direction structure the real
  //    pipeline produces, just placed below the header table.
  doc = (await docs.documents.get({ documentId: docId })).data;
  tableEl = findHeaderTable(doc);
  const bodyStart = tableEl.endIndex;

  const body = new DocBuilder(bodyStart);
  body.title('2026-07-05 — Sample Campaign');
  body.horizontalRule();
  body.heading('Campaign Summary');
  body.italic('A short campaign summary goes here.');
  body.heading('Writer Direction');
  body.italic('Data-driven and punchy. Speak directly to support and CX leaders.');

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests: body.buildRequests() },
  });
  console.log('[gen] body rendered below the header table');

  console.log('\nHeader-table test doc:\n' + created.data.webViewLink + '\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('[gen] FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
