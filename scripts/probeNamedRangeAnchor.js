'use strict';

// THROWAWAY PROBE: can an API-created range be used as a comment anchor?
//
// GROUND TRUTH THIS IS BUILT ON. A comment a human anchored by hand in the Docs UI
// carries `anchor` as a BARE OPAQUE STRING — "kix.s8gpyzlgs28b". Not JSON, not
// offsets, not a revision id. That is the same identifier namespace as the heading
// fragments in Docs URLs, which points at an internal range object that already
// exists in the document rather than at a coordinate. And Google returned
// "r creative flow" as quotedFileContent for a highlight of "creative flow" —
// WIDER than the selection — which says quotedFileContent is DERIVED from the
// anchor rather than being the positioning mechanism.
//
// So: if the anchor names a range object, can we make one via the API and point a
// comment at it? A named range is the only range object the Docs API lets us
// create and get an id back for. This probe tests whether that id is accepted.
//
// FOUR STRATEGIES, one variable. Same target range, same comment content, only the
// `anchor` value differs:
//
//   1  the namedRangeId exactly as documents.batchUpdate returned it
//   2  the same id prefixed with "kix."   (the namespace the real anchor used)
//   3  NO anchor at all                   — the control
//   4  "kix.doesnotexist"                 — does Drive VALIDATE anchors, or does
//                                           it accept any string it is handed?
//
// Strategy 4 is the one that decides how to read the other three. If a garbage
// anchor is echoed back happily, then "the anchor came back" proves nothing at all,
// and only a populated quotedFileContent is evidence.
//
// THE SIGNAL IS quotedFileContent, NOT the echo. This probe sends NO quote. So a
// quotedFileContent that comes back POPULATED was derived by Google from the
// anchor — which means the anchor resolved to a real region. That is the finding.
// An echoed anchor with no quote means Drive stored a string and did nothing with
// it.
//
// WHAT IT WRITES, and it does not clean up (by instruction):
//   - ONE named range over the target text (documents.batchUpdate)
//   - FOUR comments (drive.comments.create)
// It never deletes anything and never edits the body text.
//
// THE PROBE COMMENTS DELIBERATELY DO NOT CARRY REVIEW_PREFIX. If they did,
// listReviewComments would claim them as Quillio review comments and the orphan
// sweep in services/copyReview.js would delete them on the next review run — they
// match no review unit. They are prefixed "ANCHOR PROBE" precisely so that nothing
// in the product recognises them.
//
// Needs real credentials and a database. NOT part of `npm test`.
// Run it in the RAILWAY CONSOLE as plain node — never `railway run`:
//
//   node scripts/probeNamedRangeAnchor.js <docId-or-URL> --user=<id|email> --yes
//
// Options:
//   --user=<id|email>  act as this user (same tenant-scoped resolution as
//                      scripts/inspectRealAnchor.js). Use it.
//   --tenant=<id>      default T0B8LPRDKHR
//   --target="text"    anchor to this exact string instead of auto-picking
//   --yes              required — this writes to the document

const { getPool, resolveTenant } = require('../src/db');
const { getClientsForTenant, resolveGoogleRefreshToken } = require('../src/google');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const TENANT = flag('tenant', 'T0B8LPRDKHR');
const USER = flag('user', null);
const TARGET = flag('target', null);
const YES = args.includes('--yes');

const rule = (s) => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);
const docIdFrom = (s) => {
  const m =
    String(s || '').match(/\/document\/d\/([a-zA-Z0-9_-]+)/) ||
    String(s || '').match(/^([a-zA-Z0-9_-]{20,})$/);
  return m ? m[1] : null;
};

// Same tenant-scoped resolution as inspectRealAnchor.js — users.email is globally
// UNIQUE and users.id a global BIGSERIAL, so a cross-tenant match is refused.
async function resolveActingUser(pool, tenantId, raw) {
  const want = String(raw || '').trim();
  if (!want) return null;
  if (!pool) throw new Error('--user needs DATABASE_URL (no pool).');
  const byId = /^\d+$/.test(want);
  const res = await pool.query(
    byId
      ? 'SELECT id, email, tenant_id FROM users WHERE id = $1'
      : 'SELECT id, email, tenant_id FROM users WHERE lower(email) = lower($1)',
    [want]
  );
  const row = res.rows && res.rows[0];
  if (!row) throw new Error(`--user=${want} matched no row in users (searched by ${byId ? 'id' : 'email'}).`);
  if (String(row.tenant_id) !== String(tenantId)) {
    throw new Error(`--user=${want} is user ${row.id} <${row.email}> on tenant ${row.tenant_id}, not ${tenantId}. Refusing.`);
  }
  return { id: row.id, email: row.email };
}

function isInvalidGrant(err) {
  if (!err) return false;
  const data = (err.response && err.response.data) || {};
  if (String(data.error || '') === 'invalid_grant') return true;
  return /invalid_grant/i.test(String(err.message || '')) || /invalid_grant/i.test(String(data.error_description || ''));
}

// Every textRun in the body, WITH THE INDICES THE API GAVE THEM.
//
// INDEX DISCIPLINE — the same one generateDraft uses, and it is worth stating
// because it is the part a probe like this gets wrong. Indices are never counted
// from scratch: parseDoc reads `item.endIndex` straight off the structural element
// (googleDocs.js: `insertIndex: item.endIndex`), and this does the same one level
// down, off `paragraph.elements[].startIndex`.
//
// Docs indices are UTF-16 CODE UNITS. A JavaScript string is also UTF-16, and both
// `String.indexOf` and `String.length` count code units — so `runStart +
// content.indexOf(target)` is exact even with emoji or accents in the paragraph,
// PROVIDED nothing iterates by code point. Nothing here does.
//
// Runs, not paragraphs, because Docs splits a paragraph into a new textRun at every
// formatting boundary — invisibly. Anchoring inside ONE run is what makes the
// arithmetic above true; a target spanning two runs would need its own range math
// and is rejected below rather than guessed at.
function textRuns(doc) {
  const runs = [];
  for (const item of (doc.body && doc.body.content) || []) {
    if (!item.paragraph) continue;
    for (const el of item.paragraph.elements || []) {
      if (!el.textRun || typeof el.textRun.content !== 'string') continue;
      runs.push({ start: el.startIndex, end: el.endIndex, text: el.textRun.content });
    }
  }
  return runs;
}

// Pick a short, DISTINCTIVE target that lies inside a single run.
//
// Distinctive means it occurs exactly ONCE in the whole document. If it occurred
// twice we could not tell by eye which occurrence a comment landed on, and the
// eyeball check is the point of the run.
function pickTarget(runs, explicit) {
  const wholeDoc = runs.map((r) => r.text).join('');
  const occurrences = (s) => wholeDoc.split(s).length - 1;

  if (explicit) {
    const run = runs.find((r) => r.text.includes(explicit));
    if (!run) throw new Error(`--target=${JSON.stringify(explicit)} was not found inside any single textRun.`);
    const n = occurrences(explicit);
    if (n !== 1) throw new Error(`--target appears ${n} times in the document; it must be unique.`);
    return { run, target: explicit };
  }

  for (const run of runs) {
    const clean = run.text.replace(/\n+$/, '');
    const words = clean.trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) continue;
    for (let take = Math.min(4, words.length); take >= 2; take -= 1) {
      const candidate = words.slice(0, take).join(' ');
      if (candidate.length < 8 || candidate.length > 40) continue;
      if (!run.text.includes(candidate)) continue;
      if (occurrences(candidate) === 1) return { run, target: candidate };
    }
  }
  throw new Error('No unique 2-4 word target found in a single run. Pass --target="…".');
}

(async () => {
  const docId = docIdFrom(args.find((a) => !a.startsWith('--')));
  if (!docId) {
    console.error('\nUsage: node scripts/probeNamedRangeAnchor.js <docId-or-URL> --user=<id|email> --yes');
    process.exit(1);
  }

  const pool = getPool();
  const acting = await resolveActingUser(pool, TENANT, USER);
  const ctx = await resolveTenant(TENANT, null, acting && acting.id);
  const tenantId = (ctx && ctx.tenant && (ctx.tenant.id || ctx.tenant.tenant_id)) || TENANT;
  const actingUserId = (ctx && ctx.user && ctx.user.id) || (acting && acting.id) || null;
  const { source } = await resolveGoogleRefreshToken({ tenantId, userId: actingUserId });

  rule('ACTING AS');
  console.log(`  document : ${docId}`);
  console.log(`  identity : ${source.toUpperCase()}${acting ? ` — user ${acting.id} <${acting.email}>` : ''}`);
  if (source !== 'user') console.log('  NOTE: no --user, so this is the deprecated tenant-level credential.');

  if (!YES) {
    console.error('\nThis WRITES to the document: one named range and four comments.');
    console.error('It does not clean up. Re-run with --yes to proceed.');
    process.exit(1);
  }

  const clients = await getClientsForTenant({ tenantId, userId: actingUserId });
  const { drive, docs } = clients;

  // --- 1. Find the target and compute its range -------------------------------
  const before = (await docs.documents.get({ documentId: docId })).data;
  const runs = textRuns(before);
  const { run, target } = pickTarget(runs, TARGET);
  const offset = run.text.indexOf(target);
  const startIndex = run.start + offset;
  const endIndex = startIndex + target.length;

  rule('TARGET RANGE');
  console.log(`  target text     : ${JSON.stringify(target)}`);
  console.log(`  run startIndex  : ${run.start}   (from the API, not counted)`);
  console.log(`  offset in run   : ${offset}      (UTF-16 code units)`);
  console.log(`  startIndex      : ${startIndex}`);
  console.log(`  endIndex        : ${endIndex}    (exclusive; length ${target.length})`);
  console.log(`  text at range   : ${JSON.stringify(run.text.slice(offset, offset + target.length))}`);
  console.log('\n  Compare that last line against each quotedFileContent below. The hand-made');
  console.log('  anchor came back one character WIDER than its selection, so an exact match');
  console.log('  is not the test — a POPULATED quote is.');

  const beforeNames = Object.keys(before.namedRanges || {});
  console.log(`\n  named ranges already in the document: ${beforeNames.length ? JSON.stringify(beforeNames) : '(none)'}`);

  // --- 2. Create the named range ----------------------------------------------
  rule('CREATE NAMED RANGE (documents.batchUpdate)');
  const RANGE_NAME = 'quillio_anchor_probe';
  const bu = await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [{ createNamedRange: { name: RANGE_NAME, range: { startIndex, endIndex } } }],
    },
  });
  console.log(JSON.stringify(bu.data, null, 2));
  const namedRangeId =
    bu.data && bu.data.replies && bu.data.replies[0] && bu.data.replies[0].createNamedRange
      ? bu.data.replies[0].createNamedRange.namedRangeId
      : null;
  if (!namedRangeId) throw new Error('createNamedRange returned no namedRangeId — cannot continue.');
  console.log(`\n  namedRangeId : ${namedRangeId}`);
  console.log(`  with kix.    : kix.${namedRangeId}`);

  // --- 3. Post the four comments ----------------------------------------------
  //
  // NO REVIEW_PREFIX — see the header. Each post is independent: if Drive rejects
  // an anchor outright (which is itself the finding for strategy 4) the remaining
  // strategies must still run.
  const STRATEGIES = [
    { n: 1, label: 'raw namedRangeId', anchor: namedRangeId },
    { n: 2, label: 'kix.-prefixed namedRangeId', anchor: `kix.${namedRangeId}` },
    { n: 3, label: 'NO anchor (control)', anchor: null },
    { n: 4, label: 'invalid anchor', anchor: 'kix.doesnotexist' },
  ];

  rule('POST FOUR COMMENTS (drive.comments.create)');
  const posted = [];
  for (const s of STRATEGIES) {
    const requestBody = { content: `ANCHOR PROBE — strategy ${s.n} (${s.label})` };
    if (s.anchor !== null) requestBody.anchor = s.anchor;
    console.log(`\n--- strategy ${s.n}: ${s.label}`);
    console.log(`    anchor sent: ${s.anchor === null ? '(none — key omitted)' : JSON.stringify(s.anchor)}`);
    try {
      const res = await drive.comments.create({
        fileId: docId,
        fields: '*',
        supportsAllDrives: true,
        requestBody,
      });
      posted.push({ ...s, id: res.data.id, createRaw: res.data, error: null });
      console.log('    create response (raw):');
      console.log(JSON.stringify(res.data, null, 2));
    } catch (err) {
      posted.push({ ...s, id: null, createRaw: null, error: (err && err.message) || String(err) });
      console.log(`    CREATE FAILED: ${(err && err.message) || err}`);
      console.log('    (a rejection here IS a result — it means Drive validates this anchor)');
    }
  }

  // --- 4. Read every comment back ---------------------------------------------
  rule('COMMENTS READ BACK — raw JSON, fields: "*", nothing filtered or parsed');
  const all = [];
  let pageToken = null;
  do {
    const res = await drive.comments.list({
      fileId: docId,
      fields: '*',
      pageSize: 100,
      includeDeleted: true,
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
    });
    for (const c of res.data.comments || []) all.push(c);
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);

  for (const c of all) {
    console.log(`\n${'-'.repeat(78)}`);
    console.log(JSON.stringify(c, null, 2));
  }

  // --- 5. The table the decision is made from ----------------------------------
  rule('RESULT BY STRATEGY');
  console.log('  A POPULATED quotedFileContent is the signal: no quote was sent, so anything');
  console.log('  there was derived by Google FROM THE ANCHOR — i.e. the anchor resolved.\n');
  for (const s of posted) {
    const live = all.find((c) => c.id === s.id);
    const echoed = live && Object.prototype.hasOwnProperty.call(live, 'anchor') ? live.anchor : null;
    const q = live && live.quotedFileContent ? live.quotedFileContent.value : null;
    console.log(`  strategy ${s.n} — ${s.label}`);
    if (s.error) {
      console.log(`    POST REJECTED: ${s.error}`);
      continue;
    }
    console.log(`    comment id        : ${s.id}`);
    console.log(`    anchor sent       : ${s.anchor === null ? '(none)' : JSON.stringify(s.anchor)}`);
    console.log(`    anchor echoed     : ${echoed === null ? '(absent from the resource)' : JSON.stringify(echoed)}`);
    console.log(
      `    anchor round-trip : ${
        s.anchor === null ? 'n/a — nothing was sent (control)' : echoed === s.anchor ? 'IDENTICAL' : 'DIFFERS or absent'
      }`
    );
    console.log(`    quotedFileContent : ${q === null ? 'EMPTY — anchor did not resolve' : `POPULATED -> ${JSON.stringify(q)}`}`);
  }

  // --- 6. Did the named range survive? -----------------------------------------
  rule('NAMED RANGES AFTER (documents.get)');
  const after = (await docs.documents.get({ documentId: docId })).data;
  console.log(JSON.stringify(after.namedRanges || {}, null, 2));
  console.log(`\n  revisionId before : ${before.revisionId}`);
  console.log(`  revisionId after  : ${after.revisionId}`);

  console.log('\nDone. Nothing was cleaned up, by instruction.');
  console.log(`Look at the document by eye: https://docs.google.com/document/d/${docId}/edit`);
  console.log('Which strategies rendered as real anchored comments in the margin?');
  process.exit(0);
})().catch((err) => {
  if (isInvalidGrant(err)) {
    console.error('\nINVALID_GRANT — the refresh token used is dead. Re-run with --user=<id|email>.');
    process.exit(2);
  }
  console.error('\nPROBE FAILED:', (err && err.message) || err);
  if (err && err.response && err.response.data) {
    console.error('response body:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
