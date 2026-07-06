'use strict';

// Doc-header-template work, step 4 — re-read an edited doc's header and confirm
// the round-trip. Given a doc id/URL, it:
//   1. fetches the doc and parses the header (above HEADER_BOUNDARY_MARKER) into
//      the block schema, and prints that schema as JSON;
//   2. re-renders the parsed schema into a NEW doc via renderHeader() (the same
//      two-phase table handling as createDocument) and prints its link — so you
//      can open the original and the round-trip side by side and confirm they
//      match.
//
// Usage:
//   railway run node scripts/readHeaderDoc.js <docId-or-URL>
//
// Test with BOTH a table-style and a text/heading-style header: generate a sample
// (npm run gd3 / gd3 text), edit its header in Google Docs, then run this on that
// doc.

const config = require('../src/config');
const { getClients } = require('../src/google');
const { readHeaderSchema } = require('../src/destinations/docHeaderReader');
const { DocBuilder } = require('../src/destinations/docBuilder');
const { findHeaderTable } = require('../src/destinations/docHeaderTable');
const { isValidHeaderSchema } = require('../src/destinations/docHeaderSchema');

// Accept a raw id or any Docs URL.
function extractDocId(arg) {
  const s = String(arg || '');
  const m = s.match(/\/document\/d\/([a-zA-Z0-9_-]+)/) || s.match(/^([a-zA-Z0-9_-]{20,})$/);
  return m ? m[1] : null;
}

// Render a schema's header into a fresh doc (header only — no body), mirroring
// createDocument's header branch, so the round-trip is visually comparable.
async function renderHeaderToNewDoc(clients, schema, name) {
  const { drive, docs } = clients;
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.document',
      parents: [config.DRIVE_FOLDER_ID],
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });
  const docId = created.data.id;

  const b = new DocBuilder();
  if (isValidHeaderSchema(schema)) b.renderHeader(schema);
  else b.text('(empty header schema)');

  if (b.hasHeaderTable()) {
    await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: b.headerTableInsertRequests() } });
    let d = (await docs.documents.get({ documentId: docId })).data;
    let tableEl = findHeaderTable(d);
    await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: b.headerTableFillRequests(tableEl) } });
    d = (await docs.documents.get({ documentId: docId })).data;
    tableEl = findHeaderTable(d);
    // header only — nothing below the table
  } else {
    await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: b.buildRequests() } });
  }
  return created.data.webViewLink;
}

async function main() {
  const docId = extractDocId(process.argv[2]);
  if (!docId) {
    console.error('[gen4] usage: readHeaderDoc.js <docId-or-URL>');
    process.exit(1);
  }

  const clients = await getClients();

  const schema = await readHeaderSchema(docId, clients);
  console.log('\n[gen4] parsed header schema:');
  console.log(JSON.stringify(schema, null, 2));
  console.log(`\n[gen4] block types: [${schema.blocks.map((b) => b.type).join(', ')}]`);

  const url = await renderHeaderToNewDoc(clients, schema, 'Quillio — Header Round-Trip');
  console.log(`\n[gen4] round-trip re-render (compare against the original):\n${url}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[gen4] FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
