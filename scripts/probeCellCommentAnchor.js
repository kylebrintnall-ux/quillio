'use strict';

// THE TABLE-CELL COMMENT ANCHOR PROBE.
//
// Copy review anchors its comments with Drive's comments.create +
// quotedFileContent (src/destinations/googleDocs.js:1476-1495). Drive resolves
// that quote to a location in the document ITSELF — it is not a Docs positional
// anchor, and Quillio never tells it where to look. The header comment above
// that code says the behaviour is verified, and it is: for PARAGRAPH text, which
// is all a copy doc has ever contained.
//
// A document template is a table. Nobody has tried a table cell, and the answer
// decides whether review-in-the-template is a feature being built or a
// limitation to design around — so it is worth one script and an afternoon
// rather than finding out after the reader, the drafter and the UI depend on it.
//
// FIVE QUESTIONS, each answered by CREATING a comment and then LISTING IT BACK.
// The create response is not evidence: it returns an id whether or not Drive
// managed to anchor anything. Only the list response says what Drive actually
// did with the quote.
//
//   1. plain cell        — does a cell quote anchor at all?
//   2. after a rewrite   — the real case. Draft, review, regenerate, review
//                          again: does the old comment survive its text being
//                          replaced, and does a new one anchor to the new text?
//   3. identical cells   — two cells holding the same string. Which one wins,
//                          or does it fail? copyReview already guards duplicate
//                          quotes for paragraphs (copyReview.js:266-279); this
//                          says whether that guard is sufficient here.
//   4. a long cell       — a 120-word body paragraph. Is quote length a limit?
//   5. a merged cell     — a real matrix has them, and the anchor region of a
//                          merged cell is not obviously the same shape.
//
// WHAT COUNTS AS ANCHORED. Drive returns two separate things and they are not
// the same claim:
//   • `anchor`             — a region descriptor. Present = Drive located the
//                            text and pinned the comment to it.
//   • `quotedFileContent`  — the quoted string, echoed back. Present WITHOUT an
//                            anchor means the comment displays the quote but
//                            floats: it is in the file's comment list, not
//                            beside the copy.
// Both are reported separately, because "the quote came back" is the result
// that would be easiest to mistake for success.
//
// It needs REAL GOOGLE CREDENTIALS and is not part of `npm test` — the suite
// runs with none, deliberately. Run it once, anywhere the app's own credentials
// are configured (a Railway console is simplest):
//
//   node scripts/probeCellCommentAnchor.js
//
// It creates ONE file in Drive (an import of test/fixtures/copy-matrix.docx —
// the same fixture the .docx fidelity probe uses, chosen because it already
// carries three tables, uneven columns and BOTH kinds of merged cell) and
// deletes it again unless --keep is passed.

const fs = require('fs');
const path = require('path');
const { getClients } = require('../src/google');
const { importDocxTemplate } = require('../src/destinations/docTemplateImport');

const FIXTURE = path.join(__dirname, '..', 'test', 'fixtures', 'copy-matrix.docx');
const KEEP = process.argv.includes('--keep');

const line = (s) => console.log('\n' + '='.repeat(78) + '\n' + s + '\n' + '='.repeat(78));
const PREFIX = '🪶 Quillio anchor probe — ';

// A 120-word body paragraph, for case 4. Counted, not estimated.
const LONG_COPY = (
  'Two days in one room with the people who actually run the systems you are ' +
  'trying to fix, and none of the hallway networking that usually fills the ' +
  'gaps between sessions. Every talk is a working session with a named outcome, ' +
  'and every speaker has shipped the thing they are describing rather than ' +
  'advised somebody else to ship it. You will leave with a plan your team can ' +
  'start on Monday, written down, reviewed by somebody who has done it before, ' +
  'and small enough that it survives contact with the rest of your quarter. ' +
  'Bring the problem you have been putting off since spring, bring whoever owns ' +
  'the budget for it, and expect to leave with the answer written down.'
).trim();

// --- document walking -------------------------------------------------------

// Every table cell in the body, flattened, with the coordinate and the character
// range its content occupies. The range is what a write needs; the coordinate is
// what a stored marker position would be.
function cells(doc) {
  const out = [];
  let tableIndex = 0;
  for (const el of (doc.body && doc.body.content) || []) {
    if (!el.table) continue;
    const t = tableIndex++;
    (el.table.tableRows || []).forEach((row, r) => {
      (row.tableCells || []).forEach((cell, c) => {
        const content = cell.content || [];
        if (!content.length) return;
        const style = cell.tableCellStyle || {};
        const text = content
          .map((e) => ((e.paragraph && e.paragraph.elements) || []).map((x) => (x.textRun && x.textRun.content) || '').join(''))
          .join('')
          .replace(/\n+$/, '');
        out.push({
          tableIndex: t,
          row: r,
          column: c,
          rowSpan: style.rowSpan || 1,
          columnSpan: style.columnSpan || 1,
          merged: (style.rowSpan || 1) > 1 || (style.columnSpan || 1) > 1,
          start: content[0].startIndex,
          end: content[content.length - 1].endIndex,
          text,
        });
      });
    });
  }
  return out;
}

const where = (c) =>
  `table ${c.tableIndex + 1}, row ${c.row + 1}, col ${c.column + 1}` +
  (c.merged ? ` (merged ${c.rowSpan}x${c.columnSpan})` : '');

// Replace ONE cell's content. Re-reads the document first so the range is
// current — a probe can afford a round trip per write, and it removes every
// index-shifting question from the results.
//
// The delete stops one character SHORT of the content end: a Docs paragraph must
// keep its trailing newline, and deleting it is an error rather than an empty
// cell.
async function writeCell(clients, docId, coord, text) {
  const doc = (await clients.docs.documents.get({ documentId: docId })).data;
  const cell = cells(doc).find(
    (c) => c.tableIndex === coord.tableIndex && c.row === coord.row && c.column === coord.column
  );
  if (!cell) throw new Error(`cell not found: ${where(coord)}`);

  const requests = [];
  if (cell.end - 1 > cell.start) {
    requests.push({ deleteContentRange: { range: { startIndex: cell.start, endIndex: cell.end - 1 } } });
  }
  requests.push({ insertText: { location: { index: cell.start }, text } });
  await clients.docs.documents.batchUpdate({ documentId: docId, requestBody: { requests } });
  return text;
}

// --- comments ---------------------------------------------------------------

// EXACTLY what addReviewComment does (googleDocs.js:1481-1489), copied rather
// than called so the probe cannot be fooled by a future change to that function
// — and so this file touches nothing in the review path.
async function addComment(clients, docId, quote, content) {
  const res = await clients.drive.comments.create({
    fileId: docId,
    fields: 'id',
    supportsAllDrives: true,
    requestBody: {
      content: PREFIX + content,
      quotedFileContent: { mimeType: 'text/plain', value: quote },
    },
  });
  return (res.data && res.data.id) || null;
}

// The list read, asking for MORE than the production one does: `anchor` is the
// field that says whether Drive pinned the comment to a location, and
// listReviewComments never requests it (googleDocs.js:1453).
async function listComments(clients, docId) {
  const res = await clients.drive.comments.list({
    fileId: docId,
    fields: 'comments(id, content, anchor, deleted, resolved, quotedFileContent(value, mimeType))',
    pageSize: 100,
    includeDeleted: false,
    supportsAllDrives: true,
  });
  return (res.data.comments || []).filter((c) => !c.deleted);
}

function verdict(c) {
  if (!c) return { label: 'GONE', detail: 'the comment is not in the list at all' };
  const anchored = typeof c.anchor === 'string' && c.anchor.trim().length > 0;
  const quoted = !!(c.quotedFileContent && c.quotedFileContent.value);
  if (anchored) return { label: 'ANCHORED', detail: `anchor=${JSON.stringify(c.anchor).slice(0, 120)}` };
  if (quoted) {
    return {
      label: 'NOT ANCHORED (quote echoed)',
      detail: 'the quote came back but there is no anchor — the comment floats in the file\'s comment list rather than sitting beside the copy',
    };
  }
  return { label: 'NOT ANCHORED', detail: 'no anchor and no quoted content' };
}

function report(name, c, sent) {
  const v = verdict(c);
  console.log(`  ${name}`);
  console.log(`    verdict:  ${v.label}`);
  console.log(`    ${v.detail}`);
  if (c) {
    const got = (c.quotedFileContent && c.quotedFileContent.value) || '';
    console.log(`    quote sent (${sent.length} chars): ${JSON.stringify(sent.slice(0, 70))}${sent.length > 70 ? '…' : ''}`);
    console.log(`    quote returned (${got.length} chars): ${JSON.stringify(got.slice(0, 70))}${got.length > 70 ? '…' : ''}`);
    console.log(`    identical: ${got === sent}`);
  }
  return v.label;
}

(async () => {
  if (!fs.existsSync(FIXTURE)) {
    console.error(`Fixture missing: ${FIXTURE}\nRun: node scripts/makeTemplateFixture.js`);
    process.exit(1);
  }
  const clients = await getClients();

  line('IMPORTING test/fixtures/copy-matrix.docx');
  const imported = await importDocxTemplate({
    clients,
    stream: fs.createReadStream(FIXTURE),
    name: 'Quillio cell-comment anchor probe',
  });
  const docId = imported.docId;
  console.log(`  ${imported.docUrl}`);

  const doc = (await clients.docs.documents.get({ documentId: docId })).data;
  const all = cells(doc);
  const plain = all.filter((c) => !c.merged && c.text.trim());
  const merged = all.filter((c) => c.merged);
  console.log(`  ${all.length} cell(s) — ${plain.length} plain with text, ${merged.length} merged`);

  // Cells are chosen from what the CONVERTED document actually has, never
  // hardcoded — the .docx fidelity probe already showed the converter can change
  // how merges are represented, and a probe that addressed fixed coordinates
  // would report a missing cell as a failed anchor.
  const pick = (n) => plain[n % plain.length];
  const CASE1 = pick(1);
  const CASE3A = pick(2);
  const CASE3B = pick(3);
  const CASE4 = pick(4);
  const CASE5 = merged[0] || null;

  const results = {};

  line('1. A PLAIN TABLE CELL');
  const q1 = await writeCell(clients, docId, CASE1, 'Save my spot');
  console.log(`  wrote ${JSON.stringify(q1)} into ${where(CASE1)}`);
  const id1 = await addComment(clients, docId, q1, 'Case 1 — plain cell.');
  console.log(`  comments.create returned id=${id1} (not evidence — listing it back)\n`);
  let live = await listComments(clients, docId);
  results.case1 = report('quoting that cell:', live.find((c) => c.id === id1), q1);

  line('2. AFTER THE CELL IS REWRITTEN — draft, review, regenerate, review again');
  const q2 = await writeCell(clients, docId, CASE1, 'Claim your seat');
  console.log(`  replaced the cell's content with ${JSON.stringify(q2)}\n`);
  live = await listComments(clients, docId);
  const survivor = live.find((c) => c.id === id1);
  results.case2old = report('the ORIGINAL comment, after its text was replaced:', survivor, q1);
  const id2 = await addComment(clients, docId, q2, 'Case 2 — after rewrite.');
  live = await listComments(clients, docId);
  results.case2new = report('\n  a NEW comment on the new text:', live.find((c) => c.id === id2), q2);

  line('3. TWO CELLS HOLDING IDENTICAL TEXT');
  const dupe = 'Register now';
  await writeCell(clients, docId, CASE3A, dupe);
  await writeCell(clients, docId, CASE3B, dupe);
  console.log(`  wrote ${JSON.stringify(dupe)} into BOTH ${where(CASE3A)} and ${where(CASE3B)}\n`);
  const id3 = await addComment(clients, docId, dupe, 'Case 3 — duplicate text.');
  live = await listComments(clients, docId);
  results.case3 = report('quoting a string that appears twice:', live.find((c) => c.id === id3), dupe);
  console.log(
    `\n  NOTE: Drive cannot report WHICH occurrence it chose — the anchor is opaque.\n` +
      `  Whatever this says, copyReview's activeQuotes guard (copyReview.js:266-279)\n` +
      `  is what keeps two fields from both claiming one quote; this only says whether\n` +
      `  a duplicated quote anchors at all.`
  );

  line('4. A LONG CELL — a 120-word body paragraph');
  const words = LONG_COPY.trim().split(/\s+/).length;
  const q4 = await writeCell(clients, docId, CASE4, LONG_COPY);
  console.log(`  wrote ${words} words (${LONG_COPY.length} chars) into ${where(CASE4)}\n`);
  const id4 = await addComment(clients, docId, q4, 'Case 4 — long cell.');
  live = await listComments(clients, docId);
  results.case4 = report('quoting the whole paragraph:', live.find((c) => c.id === id4), q4);

  line('5. A MERGED CELL');
  if (!CASE5) {
    console.log('  the converted document reported NO merged cells — nothing to test.');
    console.log('  (run scripts/probeDocxImport.js: it names each merge the converter kept.)');
    results.case5 = 'SKIPPED';
  } else {
    const q5 = await writeCell(clients, docId, CASE5, 'Two days, one room');
    console.log(`  wrote ${JSON.stringify(q5)} into ${where(CASE5)}\n`);
    const id5 = await addComment(clients, docId, q5, 'Case 5 — merged cell.');
    live = await listComments(clients, docId);
    results.case5 = report('quoting a merged cell:', live.find((c) => c.id === id5), q5);
  }

  line('WHAT THIS MEANS FOR REVIEW ON A TEMPLATE DOCUMENT');
  for (const [k, v] of Object.entries(results)) console.log(`  ${k.padEnd(12)} ${v}`);
  const anchored = (v) => String(v).startsWith('ANCHORED');
  if (anchored(results.case1) && anchored(results.case2new)) {
    console.log(
      `\n  Cell quotes anchor. Review works on a template document the way it works\n` +
        `  on a copy doc, and copyReview needs no change beyond being pointed at the\n` +
        `  template's document id.`
    );
    if (!anchored(results.case2old)) {
      console.log(
        `  The comment on REPLACED text did not survive as anchored — expected, and\n` +
          `  already handled: copyReview deletes its previous comments before posting\n` +
          `  the currently-warranted set (REVIEW_PREFIX ownership, googleDocs.js:1434).`
      );
    }
  } else {
    console.log(
      `\n  Cell quotes DO NOT anchor. Review on a template cannot put a note beside\n` +
        `  the copy. The options are: unanchored comments carrying the field name in\n` +
        `  their text (still readable, worse to act on), or the review lives outside\n` +
        `  the document. Decide that before building the template reader.`
    );
  }

  if (!KEEP) {
    await clients.drive.files.delete({ fileId: docId, supportsAllDrives: true });
    console.log('\n(probe document deleted — pass --keep to inspect it in Drive)');
  } else {
    console.log(`\n(kept: ${imported.docUrl})`);
  }
  process.exit(0);
})().catch((err) => {
  console.error('\nPROBE FAILED:', err && err.message ? err.message : err);
  console.error('\nThis needs real Google credentials (GOOGLE_SERVICE_ACCOUNT_JSON, or');
  console.error('GOOGLE_CLIENT_ID/SECRET + GOOGLE_REFRESH_TOKEN). It is not part of npm test.');
  process.exit(1);
});
