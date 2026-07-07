'use strict';

// Doc-header-template work, step 5 — extract a header schema from a screenshot
// and close the loop: screenshot in -> block schema -> editable sample doc out.
//
// Zero-typing on mobile: drop a screenshot of a header into your Drive folder
// (share screenshot -> Google Drive -> the configured folder), then run gd5. It
// finds the most recently modified IMAGE in the folder, sends it to Gemini
// vision (extractHeaderSchema), normalizes the result, prints the schema, and
// renders an editable sample doc from it (Step 3) so you can eyeball the loop.
//
// Usage:
//   railway run node scripts/extractHeaderFromImage.js            (latest image in folder)
//   railway run node scripts/extractHeaderFromImage.js <fileId>   (a specific Drive image)
//
// No UI, no storage wiring yet — this is the extraction step only.

const config = require('../src/config');
const { getClients } = require('../src/google');
const { extractHeaderSchema } = require('../src/services/gemini');
const { normalizeHeaderSchema, isValidHeaderSchema } = require('../src/destinations/docHeaderSchema');
const { generateHeaderSampleDoc } = require('../src/destinations/docHeaderSample');

// Most recently modified image file in the configured folder, or null.
async function findLatestImage(drive) {
  const res = await drive.files.list({
    q: `'${config.DRIVE_FOLDER_ID}' in parents and mimeType contains 'image/' and trashed = false`,
    orderBy: 'modifiedTime desc',
    pageSize: 1,
    fields: 'files(id, name, mimeType, modifiedTime)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files && res.data.files[0]) || null;
}

// Download an image file's bytes as base64 + its mimeType.
async function downloadImage(drive, fileId) {
  const meta = await drive.files.get({ fileId, fields: 'name, mimeType', supportsAllDrives: true });
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  const base64 = Buffer.from(res.data).toString('base64');
  return { base64, mimeType: meta.data.mimeType || 'image/png', name: meta.data.name };
}

// Print the target folder (name + link) so it's obvious where to drop the
// screenshot — best-effort, never blocks the run.
async function logTargetFolder(drive) {
  const id = config.DRIVE_FOLDER_ID;
  let name = '';
  try {
    const meta = await drive.files.get({ fileId: id, fields: 'name', supportsAllDrives: true });
    name = meta.data.name || '';
  } catch {
    /* ignore — still print the link */
  }
  console.log(`[gen5] target folder${name ? ` "${name}"` : ''}:`);
  console.log(`       https://drive.google.com/drive/folders/${id}`);
  console.log('       (drop your header screenshot here: share screenshot -> Google Drive -> this folder)');
}

async function main() {
  const clients = await getClients();
  const { drive } = clients;

  await logTargetFolder(drive);

  let fileId = process.argv[2];
  let name = fileId;
  if (!fileId) {
    const img = await findLatestImage(drive);
    if (!img) {
      console.error('\n[gen5] no image found in that folder yet — drop a screenshot in (link above) and re-run.');
      process.exit(1);
    }
    fileId = img.id;
    name = img.name;
    console.log(`[gen5] using latest image in folder: "${img.name}" (${img.mimeType})`);
  }

  const { base64, mimeType } = await downloadImage(drive, fileId);
  console.log(`[gen5] extracting header from "${name}" (${mimeType}, ${Math.round(base64.length * 0.75 / 1024)}KB)...`);

  const raw = await extractHeaderSchema(base64, mimeType);
  if (!raw) {
    console.error('[gen5] extraction returned nothing (no GEMINI_API_KEY, timeout, or unparseable).');
    process.exit(1);
  }
  const schema = normalizeHeaderSchema(raw);

  console.log('\n[gen5] extracted header schema:');
  console.log(JSON.stringify(schema, null, 2));
  console.log(`\n[gen5] block types: [${schema.blocks.map((b) => b.type).join(', ')}]`);

  if (!isValidHeaderSchema(schema)) {
    console.error('\n[gen5] extracted schema has no usable blocks — nothing to render.');
    process.exit(1);
  }

  // Close the loop: render an editable sample doc from the extracted schema.
  const { url } = await generateHeaderSampleDoc({
    headerSchema: schema,
    folderId: config.DRIVE_FOLDER_ID,
    clients,
  });
  console.log(`\n[gen5] editable sample doc from the extracted header:\n${url}`);
  console.log('[gen5] open it, compare to your screenshot, then edit + npm run gd4 to re-read.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('[gen5] FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
