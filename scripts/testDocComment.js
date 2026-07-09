'use strict';

// Copy-review investigation — SMALL TEST (findings only, not wired into the app).
//
// On a real generated copy doc, add a Drive comment "at" a SHORT single-line
// field (a headline/subject) and one "at" a LONGER body paragraph, then report
// what the API returns. Open the doc afterward to SEE where each lands — that's
// the empirical answer to whether field-level (paragraph) anchoring works for
// our doc structure.
//
// Comments live on the DRIVE API (v3), not the Docs API. We set quotedFileContent
// (the text region the comment refers to) — the closest the public API offers to
// anchoring — and report the created resource. Google does NOT publicly document
// a Docs text-anchor format, so this test tells us empirically whether the comment
// attaches to the field line or falls back to a general (unanchored) comment.
//
// Usage:
//   railway run node scripts/testDocComment.js [docId-or-URL]
//     (no id → most recent Google Doc in DRIVE_FOLDER_ID that isn't a header test)

const config = require('../src/config');
const { getClients } = require('../src/google');

function extractDocId(arg) {
  const s = String(arg || '');
  const m = s.match(/\/document\/d\/([a-zA-Z0-9_-]+)/) || s.match(/^([a-zA-Z0-9_-]{20,})$/);
  return m ? m[1] : null;
}

async function latestCopyDoc(drive) {
  const res = await drive.files.list({
    q: `'${config.DRIVE_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.document' and trashed = false`,
    orderBy: 'modifiedTime desc',
    pageSize: 25,
    fields: 'files(id, name, modifiedTime)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = (res.data.files || []).filter((f) => !/^(Header |Quillio — Header)/.test(f.name || ''));
  return files[0] || null;
}

// Reconstruct field copy the way getDocContent does: a bold label paragraph, then
// the following non-empty regular paragraph is that field's drafted copy.
function paragraphText(p) {
  return (p.elements || []).map((e) => (e.textRun ? e.textRun.content : '')).join('').replace(/\n+$/, '');
}
function isBold(p) {
  const el = (p.elements || []).find((e) => e.textRun && e.textRun.content && e.textRun.content.trim());
  return !!(el && el.textRun.textStyle && el.textRun.textStyle.bold);
}

function collectCopyParagraphs(doc) {
  const out = [];
  let lastLabel = null;
  for (const item of doc.body.content || []) {
    if (!item.paragraph) continue;
    const p = item.paragraph;
    const named = p.paragraphStyle && p.paragraphStyle.namedStyleType;
    const text = paragraphText(p).trim();
    if (!text) { continue; }
    if (named && /HEADING/.test(named)) { lastLabel = null; continue; }
    if (isBold(p)) { lastLabel = text; continue; } // a field label
    // A non-bold, non-heading paragraph with text right after a label = drafted copy.
    if (lastLabel) {
      out.push({ label: lastLabel, text: text, startIndex: item.startIndex, endIndex: item.endIndex });
      lastLabel = null;
    }
  }
  return out;
}

async function addComment(drive, fileId, label, para) {
  const res = await drive.comments.create({
    fileId,
    fields: 'id, anchor, content, quotedFileContent, resolved',
    supportsAllDrives: true,
    requestBody: {
      content: `REVIEW TEST → ${label}: consider tightening this line.`,
      quotedFileContent: { mimeType: 'text/plain', value: para.text },
    },
  });
  return res.data;
}

async function main() {
  const { drive } = await getClients();
  let docId = extractDocId(process.argv[2]);
  let name = docId;
  if (!docId) {
    const f = await latestCopyDoc(drive);
    if (!f) { console.error('[comment-test] no copy doc found — pass a docId/URL.'); process.exit(1); }
    docId = f.id; name = f.name;
    console.log(`[comment-test] using latest copy doc: "${f.name}"`);
  }

  const { docs } = await getClients();
  const doc = (await docs.documents.get({ documentId: docId })).data;
  const paras = collectCopyParagraphs(doc);
  if (!paras.length) { console.error('[comment-test] no drafted copy paragraphs found — run Generate First Draft first.'); process.exit(1); }

  const short = paras.slice().sort((a, b) => a.text.length - b.text.length)[0];
  const long = paras.slice().sort((a, b) => b.text.length - a.text.length)[0];

  console.log(`\n[comment-test] SHORT field: "${short.label}" -> "${short.text}" (${short.text.length} chars)`);
  const c1 = await addComment(drive, docId, short.label, short);
  console.log('  created comment:', JSON.stringify(c1));

  console.log(`\n[comment-test] LONG paragraph: "${long.label}" -> ${long.text.length} chars`);
  const c2 = await addComment(drive, docId, long.label, long);
  console.log('  created comment:', JSON.stringify(c2));

  console.log(`\n[comment-test] Open the doc and report WHERE each comment appears:`);
  console.log(`  https://docs.google.com/document/d/${docId}/edit`);
  console.log('  - Is the SHORT-field comment anchored to that headline line, or general/unanchored?');
  console.log('  - Is the LONG-paragraph comment anchored to that paragraph?');
  process.exit(0);
}

main().catch((err) => {
  console.error('[comment-test] FAILED:', err && err.message ? err.message : err);
  if (err && err.errors) console.error(JSON.stringify(err.errors));
  process.exit(1);
});
