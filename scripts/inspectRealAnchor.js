'use strict';

// GROUND TRUTH: what does Google actually store in a comment's `anchor` on a
// native Google Doc?
//
// This script answers nothing on its own. It lists every comment on a document
// and prints each one's raw JSON exactly as Drive returned it. The interpretation
// is yours, from real output, on a comment a human anchored by hand in the Docs UI.
//
// IT IS READ-ONLY, STRUCTURALLY. The only Drive call it makes is
// `drive.comments.list`. There is no create, no update, no delete, and no
// batchUpdate anywhere in this file. It cannot modify the document it inspects.
//
// WHY `fields: '*'` AND NOT A FIELD LIST. Every other reader in this codebase
// enumerates the fields it wants, which is correct when you know what you need.
// Here we explicitly do not: the whole point is to discover a format nobody has
// seen, and an enumerated list can only ever return fields somebody already
// thought of. `*` is the widest the Drive API offers, and it is the only honest
// choice for a question of this shape. It returns `anchor`, `quotedFileContent`,
// `replies`, and anything else the resource carries — including fields that are
// not in the documentation.
//
// NOTHING IS FILTERED, TRUNCATED, OR PARSED. Every comment is printed, including
// deleted and resolved ones (`includeDeleted: true`), in full, in the order Drive
// returned it. `anchor` is a STRING that happens to contain JSON; this script
// does NOT parse it, because a parse is an interpretation and a wrong parse would
// corrupt the very thing being measured. It is printed twice — inside the JSON
// block exactly as returned (authoritative, with JSON escaping), and again on its
// own line with the escaping removed, purely so it can be copy-pasted. Same bytes,
// two presentations.
//
// Needs real credentials and a database. NOT part of `npm test`.
// Run it in the RAILWAY CONSOLE as plain node — never `railway run`:
//
//   node scripts/inspectRealAnchor.js <docId-or-URL> --user=kyle.brintnall@gmail.com
//
// Options:
//   --user=<id|email>  act as this user's Google identity. STRONGLY RECOMMENDED —
//                      without it the deprecated tenant-level credential is used,
//                      which on T0B8LPRDKHR is dead (invalid_grant). Same flag and
//                      same semantics as scripts/verifyReviewComments.js.
//   --tenant=<id>      default T0B8LPRDKHR
//   --no-revision      skip the document's current revisionId (see the note on
//                      that section below)

const { getPool, resolveTenant } = require('../src/db');
const { getClientsForTenant, resolveGoogleRefreshToken } = require('../src/google');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const TENANT = flag('tenant', 'T0B8LPRDKHR');
const USER = flag('user', null);
const NO_REVISION = args.includes('--no-revision');

const rule = (s) => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);
const docIdFrom = (s) => {
  const m =
    String(s || '').match(/\/document\/d\/([a-zA-Z0-9_-]+)/) ||
    String(s || '').match(/^([a-zA-Z0-9_-]{20,})$/);
  return m ? m[1] : null;
};

// Resolve --user to a user id, SCOPED TO THE TENANT. `users.email` is globally
// UNIQUE and `users.id` is a global BIGSERIAL, so an unscoped lookup would happily
// resolve somebody on another tenant; a cross-tenant match is refused by name.
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
    throw new Error(
      `--user=${want} is user ${row.id} <${row.email}> on tenant ${row.tenant_id}, not ${tenantId}. Refusing.`
    );
  }
  return { id: row.id, email: row.email };
}

function isInvalidGrant(err) {
  if (!err) return false;
  const data = (err.response && err.response.data) || {};
  if (String(data.error || '') === 'invalid_grant') return true;
  return /invalid_grant/i.test(String(err.message || '')) || /invalid_grant/i.test(String(data.error_description || ''));
}

(async () => {
  const docId = docIdFrom(args.find((a) => !a.startsWith('--')));
  if (!docId) {
    console.error('\nUsage: node scripts/inspectRealAnchor.js <docId-or-URL> [--user=<id|email>]');
    console.error('Pass the id or the full /document/d/<id>/edit URL.');
    process.exit(1);
  }

  const pool = getPool();
  const acting = await resolveActingUser(pool, TENANT, USER);
  const ctx = await resolveTenant(TENANT, null, acting && acting.id);
  const tenantId = (ctx && ctx.tenant && (ctx.tenant.id || ctx.tenant.tenant_id)) || TENANT;
  const actingUserId = (ctx && ctx.user && ctx.user.id) || (acting && acting.id) || null;
  const { source } = await resolveGoogleRefreshToken({ tenantId, userId: actingUserId });

  rule('READING AS');
  console.log(`  document : ${docId}`);
  console.log(`  tenant   : ${tenantId}`);
  console.log(`  identity : ${source.toUpperCase()}${acting ? ` — user ${acting.id} <${acting.email}>` : ''}`);
  if (source !== 'user') {
    console.log('\n  NOTE: no acting user, so this is the DEPRECATED tenant-level credential.');
    console.log('  If it fails with invalid_grant, re-run with --user=<email>.');
  }
  console.log('\n  READ-ONLY: the only Drive call below is comments.list.');

  const clients = await getClientsForTenant({ tenantId, userId: actingUserId });
  const { drive } = clients;

  // Page through EVERY comment. fields '*' — see the header.
  const comments = [];
  let pageToken = null;
  let pages = 0;
  do {
    const res = await drive.comments.list({
      fileId: docId,
      fields: '*',
      pageSize: 100,
      includeDeleted: true,
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
    });
    pages += 1;
    for (const c of res.data.comments || []) comments.push(c);
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);

  rule(`RAW COMMENTS — ${comments.length} total, across ${pages} page(s)`);
  if (comments.length === 0) {
    console.log('  Drive returned NO comments for this document.');
    console.log('  If you just added one by hand, check that it saved, and that this');
    console.log('  identity can see the document.');
  }

  comments.forEach((c, i) => {
    console.log(`\n${'-'.repeat(78)}`);
    console.log(`COMMENT ${i + 1} of ${comments.length}`);
    console.log('-'.repeat(78));
    // Verbatim, in full. No field selection, no truncation, no parsing.
    console.log(JSON.stringify(c, null, 2));

    // The same `anchor` bytes again with JSON escaping removed, so the value can
    // be copy-pasted without unescaping it by hand. The block above is
    // authoritative; this is a presentation of the identical string. Not parsed.
    if (Object.prototype.hasOwnProperty.call(c, 'anchor')) {
      console.log('\n  anchor, unescaped (same bytes as above, NOT parsed):');
      console.log(`  ${c.anchor}`);
    } else {
      console.log('\n  (this comment resource has no `anchor` key at all)');
    }
  });

  // KEY PRESENCE ONLY — which comments carry an `anchor` key and which do not.
  // This is a census of keys, not a reading of their values; nothing here says
  // what an anchor means or whether it resolves.
  rule('KEY-PRESENCE CENSUS (facts about keys, not an interpretation of values)');
  for (const c of comments) {
    const hasAnchor = Object.prototype.hasOwnProperty.call(c, 'anchor');
    const hasQuote = Object.prototype.hasOwnProperty.call(c, 'quotedFileContent');
    console.log(
      `  id=${c.id}  anchor:${hasAnchor ? 'PRESENT' : 'absent '}  ` +
        `quotedFileContent:${hasQuote ? 'PRESENT' : 'absent '}  ` +
        `deleted:${c.deleted === true}  resolved:${c.resolved === true}  ` +
        `author:${(c.author && (c.author.displayName || c.author.emailAddress)) || '?'}`
    );
  }
  const allKeys = new Set();
  for (const c of comments) for (const k of Object.keys(c)) allKeys.add(k);
  console.log(`\n  every key seen across all comments: ${JSON.stringify([...allKeys].sort())}`);

  // Read-only context, deliberately AFTER the comment data and clearly separate so
  // it cannot be mistaken for part of it. If an anchor turns out to reference a
  // revision, this is the number to compare it against — having it now saves a
  // second trip. documents.get is a read; skip it with --no-revision.
  if (!NO_REVISION) {
    rule('DOCUMENT REVISION (read-only context — NOT part of the comment data)');
    try {
      const doc = await clients.docs.documents.get({ documentId: docId });
      console.log(`  documents.get revisionId : ${doc.data.revisionId}`);
      console.log(`  title                    : ${doc.data.title}`);
    } catch (err) {
      console.log(`  (documents.get failed: ${(err && err.message) || err})`);
    }
    try {
      const f = await drive.files.get({ fileId: docId, fields: '*', supportsAllDrives: true });
      console.log(`  files.get headRevisionId : ${f.data.headRevisionId === undefined ? '(field not returned)' : JSON.stringify(f.data.headRevisionId)}`);
      console.log(`  files.get mimeType       : ${f.data.mimeType}`);
    } catch (err) {
      console.log(`  (files.get failed: ${(err && err.message) || err})`);
    }
  }

  console.log('\nDone. Nothing was written.');
  process.exit(0);
})().catch((err) => {
  if (isInvalidGrant(err)) {
    console.error('\nINVALID_GRANT — the refresh token used is dead.');
    console.error('Re-run with --user=<id|email> to use a per-user credential, or see');
    console.error('scripts/verifyReviewComments.js, which reports which credential failed');
    console.error('and when it was issued.');
    process.exit(2);
  }
  console.error('\nINSPECT FAILED:', (err && err.message) || err);
  console.error('\nNeeds real credentials and a database. Run it in the Railway console.');
  process.exit(1);
});
