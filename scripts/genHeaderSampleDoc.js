'use strict';

// Doc-header-template work, step 3 — generate a standalone onboarding sample doc
// (header + boundary marker + sample body) and print its link, so we can open it
// and confirm the marker is clear and the header is editable.
//
// Uses a seeded draft schema (Gemini will produce this later, Step 5). This does
// NOT touch the normal createDocument pipeline or any tenant's stored schema.
//
// Usage:
//   railway run node scripts/genHeaderSampleDoc.js            (table draft header)
//   railway run node scripts/genHeaderSampleDoc.js text       (heading+text header)
//
// The doc lands in the configured DRIVE_FOLDER_ID.

const config = require('../src/config');
const { getClients } = require('../src/google');
const { generateHeaderSampleDoc, HEADER_BOUNDARY_MARKER } = require('../src/destinations/docHeaderSample');
const { seedSchema } = require('../src/destinations/docHeaderSchema');

async function main() {
  const which = (process.argv[2] || 'table').toLowerCase();
  const schema = seedSchema(which);
  if (!schema) {
    console.error(`[gen3] unknown schema "${process.argv[2]}". Use: table | text`);
    process.exit(1);
  }

  const clients = await getClients();
  const { id, url } = await generateHeaderSampleDoc({
    headerSchema: schema,
    folderId: config.DRIVE_FOLDER_ID,
    clients,
  });

  console.log(`\n[gen3] boundary marker text: "${HEADER_BOUNDARY_MARKER}"`);
  console.log(`[gen3] sample doc (${which} header):\n${url}`);
  console.log(`\n[gen3] doc id:  ${id}`);
  console.log(`[gen3] after editing the header, run:\n  npm run gd4 ${id}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[gen3] FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
