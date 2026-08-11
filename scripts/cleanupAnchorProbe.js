'use strict';

// CLEAN UP THE ANCHOR PROBE'S ARTEFACTS.
//
// scripts/probeNamedRangeAnchor.js deliberately does not clean up after itself, so
// its output can be read by eye. This removes what it left:
//
//   - the named range "quillio_anchor_probe"  (documents.batchUpdate deleteNamedRange)
//   - every comment whose content starts with "ANCHOR PROBE"  (drive.comments.delete)
//
// DRY RUN BY DEFAULT. It prints exactly what it would remove and changes nothing.
// Pass --commit to actually delete.
//
// THE SAFETY PROPERTY IS AN ALLOWLIST, NOT A LIST OF EXCEPTIONS. A comment is
// deleted only if its content STARTS WITH "ANCHOR PROBE". Everything else is
// preserved because it does not match, not because it was individually excluded —
// which is what makes "don't delete the sample comment" and "don't touch the
// Quillio review comments" true by construction rather than by remembering.
//
// Both are ALSO asserted explicitly, and the assertion aborts the run rather than
// skipping the item. A guard that silently drops a protected item from the delete
// set would hide the fact that the selection rule had started matching things it
// should not; on a destructive script that difference matters more than the tidy
// outcome. REVIEW_PREFIX is IMPORTED from the destination rather than retyped here,
// so it cannot drift from the string the product actually writes.
//
// NOTE ON THE PREFIX AND THIS READER. services/copyReview reads comments through
// googleDocs.listReviewComments, which STRIPS REVIEW_PREFIX on the way out. This
// script uses drive.comments.list directly, so content arrives RAW and still
// carries the prefix — which is why comparing against REVIEW_PREFIX here is correct
// and would be wrong in code that went through the destination.
//
// Needs real credentials and a database. NOT part of `npm test`.
// Run it in the RAILWAY CONSOLE as plain node — never `railway run`:
//
//   node scripts/cleanupAnchorProbe.js <docId-or-URL> --user=<id|email>
//   node scripts/cleanupAnchorProbe.js <docId-or-URL> --user=<id|email> --commit
//
// Options:
//   --user=<id|email>  act as this user (same tenant-scoped resolution as the probe)
//   --tenant=<id>      default T0B8LPRDKHR
//   --commit           actually delete. Without it, nothing is changed.

const { getPool, resolveTenant } = require('../src/db');
const { getClientsForTenant, resolveGoogleRefreshToken } = require('../src/google');
const { REVIEW_PREFIX } = require('../src/destinations/googleDocs');

const PROBE_PREFIX = 'ANCHOR PROBE';
const RANGE_NAME = 'quillio_anchor_probe';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const TENANT = flag('tenant', 'T0B8LPRDKHR');
const USER = flag('user', null);
const COMMIT = args.includes('--commit');

const rule = (s) => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);
const docIdFrom = (s) => {
  const m =
    String(s || '').match(/\/document\/d\/([a-zA-Z0-9_-]+)/) ||
    String(s || '').match(/^([a-zA-Z0-9_-]{20,})$/);
  return m ? m[1] : null;
};
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Same tenant-scoped resolution as probeNamedRangeAnchor.js — users.email is
// globally UNIQUE and users.id a global BIGSERIAL, so a cross-tenant match is
// refused by name rather than quietly used.
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

(async () => {
  const docId = docIdFrom(args.find((a) => !a.startsWith('--')));
  if (!docId) {
    console.error('\nUsage: node scripts/cleanupAnchorProbe.js <docId-or-URL> --user=<id|email> [--commit]');
    process.exit(1);
  }

  const pool = getPool();
  const acting = await resolveActingUser(pool, TENANT, USER);
  const ctx = await resolveTenant(TENANT, null, acting && acting.id);
  const tenantId = (ctx && ctx.tenant && (ctx.tenant.id || ctx.tenant.tenant_id)) || TENANT;
  const actingUserId = (ctx && ctx.user && ctx.user.id) || (acting && acting.id) || null;
  const { source } = await resolveGoogleRefreshToken({ tenantId, userId: actingUserId });

  rule(COMMIT ? 'CLEANUP — COMMIT MODE (this will delete)' : 'CLEANUP — DRY RUN (nothing will change)');
  console.log(`  document : ${docId}`);
  console.log(`  identity : ${source.toUpperCase()}${acting ? ` — user ${acting.id} <${acting.email}>` : ''}`);
  if (source !== 'user') console.log('  NOTE: no --user, so this is the deprecated tenant-level credential.');

  const clients = await getClientsForTenant({ tenantId, userId: actingUserId });
  const { drive, docs } = clients;

  // --- What is there -----------------------------------------------------------
  const doc = (await docs.documents.get({ documentId: docId })).data;
  const namedRanges = doc.namedRanges || {};
  const entry = namedRanges[RANGE_NAME] || null;
  const rangeIds = entry ? (entry.namedRanges || []).map((r) => r.namedRangeId) : [];

  const comments = [];
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
    for (const c of res.data.comments || []) comments.push(c);
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);

  // --- Classify ----------------------------------------------------------------
  const toDelete = [];
  const alreadyGone = [];
  const preserved = [];
  for (const c of comments) {
    const content = String(c.content || '');
    if (content.startsWith(PROBE_PREFIX)) {
      (c.deleted ? alreadyGone : toDelete).push(c);
    } else {
      preserved.push(c);
    }
  }

  // --- The guard. Aborts; never silently skips. --------------------------------
  //
  // IT TESTS CONTAINMENT, NOT PREFIX, AND THAT IS THE ENTIRE POINT. The first
  // version asked whether a delete candidate STARTED WITH the review prefix, or was
  // EXACTLY "sample comment" — and both are impossible for a string that already
  // starts with "ANCHOR PROBE". The guard could never fire. It read as a safety net
  // and was decoration, which is worse than having none, because the next person
  // trusts it. A stub run with a comment reading "ANCHOR PROBE sample comment"
  // sailed straight through it and was deleted.
  //
  // Containment can fire, so it is a real check on the SELECTION RULE rather than a
  // restatement of it: if PROBE_PREFIX is ever loosened, or a probe comment is ever
  // written that quotes protected text, this stops the run and a human decides.
  // Over-triggering costs one aborted cleanup; under-triggering costs somebody's
  // comment. On a destructive script that is not a close call.
  for (const c of toDelete) {
    const content = String(c.content || '');
    if (content.includes(REVIEW_PREFIX)) {
      throw new Error(
        `REFUSING to delete comment ${c.id}: it matched the probe rule but CONTAINS the Quillio review prefix. Nothing was deleted.`
      );
    }
    if (/sample comment/i.test(content)) {
      throw new Error(
        `REFUSING to delete comment ${c.id}: it matched the probe rule but CONTAINS "sample comment". Nothing was deleted.`
      );
    }
  }

  rule('NAMED RANGE');
  if (!entry) {
    console.log(`  "${RANGE_NAME}" — not present. Nothing to delete.`);
  } else {
    console.log(`  "${RANGE_NAME}" — ${rangeIds.length} range(s):`);
    for (const r of entry.namedRanges || []) {
      const spans = (r.ranges || []).map((x) => `[${x.startIndex}, ${x.endIndex})`).join(' ');
      console.log(`    ${r.namedRangeId}  ${spans}`);
    }
    console.log(`\n  Deleting BY NAME removes all ${rangeIds.length} of them (that is the request shape asked for).`);
  }

  rule(`COMMENTS TO DELETE — ${toDelete.length} matching content.startsWith(${JSON.stringify(PROBE_PREFIX)})`);
  for (const c of toDelete) {
    console.log(`  ${c.id}  ${JSON.stringify(oneLine(c.content).slice(0, 90))}`);
    if (c.anchor) console.log(`        anchor: ${JSON.stringify(c.anchor)}`);
  }
  if (toDelete.length !== 4) {
    console.log(`\n  NOTE: expected 4 (the probe posts four). Found ${toDelete.length}.`);
    console.log('  More than 4 means the probe was run more than once; fewer means some were');
    console.log('  already removed, or a post was rejected at creation time.');
  }
  if (alreadyGone.length) {
    console.log(`\n  ${alreadyGone.length} probe comment(s) already deleted — skipped:`);
    for (const c of alreadyGone) console.log(`    ${c.id}`);
  }

  rule(`PRESERVED — ${preserved.length} comment(s) this script will not touch`);
  for (const c of preserved) {
    const content = String(c.content || '');
    const why = content.startsWith(REVIEW_PREFIX)
      ? 'Quillio review comment'
      : /^\s*sample comment\s*$/i.test(content)
        ? 'the "sample comment"'
        : 'does not match the probe prefix';
    console.log(`  ${c.id}  [${why}]  ${JSON.stringify(oneLine(content).slice(0, 70))}`);
  }

  // --- Act ---------------------------------------------------------------------
  if (!COMMIT) {
    rule('DRY RUN — nothing was changed');
    console.log(`  Would delete ${toDelete.length} comment(s)` + (entry ? ` and the "${RANGE_NAME}" named range.` : ' (no named range present).'));
    console.log('\n  Re-run with --commit to apply:');
    console.log(`      node scripts/cleanupAnchorProbe.js ${docId} --user=${USER || '<id|email>'} --commit`);
    process.exit(0);
  }

  rule('DELETING');
  // Comments first: a comment anchored to the range is tidier to remove while the
  // range it points at still exists.
  let deleted = 0;
  for (const c of toDelete) {
    try {
      await drive.comments.delete({ fileId: docId, commentId: c.id, supportsAllDrives: true });
      deleted += 1;
      console.log(`  deleted comment ${c.id}`);
    } catch (err) {
      console.log(`  FAILED to delete comment ${c.id}: ${(err && err.message) || err}`);
    }
  }

  let rangeDeleted = false;
  if (entry) {
    try {
      const bu = await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: { requests: [{ deleteNamedRange: { name: RANGE_NAME } }] },
      });
      rangeDeleted = true;
      console.log(`  deleted named range "${RANGE_NAME}"`);
      console.log(`  batchUpdate reply: ${JSON.stringify(bu.data.replies || [])}`);
    } catch (err) {
      console.log(`  FAILED to delete named range: ${(err && err.message) || err}`);
    }
  }

  // --- Verify ------------------------------------------------------------------
  rule('VERIFY (re-read after deleting)');
  const after = (await docs.documents.get({ documentId: docId })).data;
  const stillNamed = Object.keys(after.namedRanges || {});
  console.log(`  named ranges now: ${stillNamed.length ? JSON.stringify(stillNamed) : '(none)'}`);
  console.log(`  "${RANGE_NAME}" still present: ${Object.prototype.hasOwnProperty.call(after.namedRanges || {}, RANGE_NAME)}`);

  const liveRes = await drive.comments.list({
    fileId: docId,
    fields: '*',
    pageSize: 100,
    includeDeleted: false,
    supportsAllDrives: true,
  });
  const live = liveRes.data.comments || [];
  const probeLeft = live.filter((c) => String(c.content || '').startsWith(PROBE_PREFIX));
  console.log(`  live comments now: ${live.length}`);
  console.log(`  probe comments remaining: ${probeLeft.length}`);
  for (const c of live) console.log(`    ${c.id}  ${JSON.stringify(oneLine(c.content).slice(0, 70))}`);

  console.log(`\nDone. ${deleted} comment(s) deleted, named range ${rangeDeleted ? 'deleted' : 'not deleted'}.`);
  process.exit(0);
})().catch((err) => {
  if (isInvalidGrant(err)) {
    console.error('\nINVALID_GRANT — the refresh token used is dead. Re-run with --user=<id|email>.');
    process.exit(2);
  }
  console.error('\nCLEANUP FAILED:', (err && err.message) || err);
  if (err && err.response && err.response.data) {
    console.error('response body:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
