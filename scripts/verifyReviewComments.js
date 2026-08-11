'use strict';

// THE UNANCHORED-COMMENT VERIFICATION RUN.
//
// Answers, against REAL Drive on a REAL copy doc, the four questions the comment
// rework cannot answer from a stub:
//
//   1. Do the comments render in the Docs panel with their text visible, or do any
//      still say "Original content deleted"?   <- HUMAN EYE ONLY. This script sets
//      it up and prints the URL; it cannot see a rendered panel.
//   2. What does `anchor` come back as on listReviewComments? Expected '' on every
//      row, because nothing sends one.
//   3. Does a SECOND whole-doc pass with no edits in between add or delete
//      anything? Expected added=0 removed=0 swept=0, comment count unchanged.
//   4. Does a SCOPED review on one field leave the other fields' comments alone?
//      Expected: every other comment id identical before and after.
//
// WHY THIS EXISTS RATHER THAN A CURL AT /health. It runs INSIDE the deployed
// container, so it reads RAILWAY_GIT_COMMIT_SHA directly. That is the same value
// /health serves, obtained without going through Cloudflare at all — no cache to
// be stale. Check it against the merge commit before believing anything below.
//
// IT MUTATES. A review pass posts and deletes real comments on the document you
// name. That is the thing under test, so it cannot be avoided — but it is why the
// doc id is required rather than guessed, and why --yes is required to proceed.
//
// Needs real credentials. NOT part of `npm test` (the suite runs with none).
// Run it in the RAILWAY CONSOLE as plain node — never `railway run` (CLAUDE.md,
// "Running migrations"):
//
//   node scripts/verifyReviewComments.js --list
//   node scripts/verifyReviewComments.js <docId-or-URL> --user=kyle.brintnall@gmail.com --yes
//
// Options:
//   --tenant=<id>   default T0B8LPRDKHR
//   --user=<id|email>  ACT AS THIS USER. See below — you almost always want this.
//   --field="Name"  scope step 4 to this field name (default: the first with copy)
//   --list          list recent projects for the tenant, and every user with a
//                   stored Google credential, then exit. Read-only.
//
// --user IS THE DIFFERENCE BETWEEN A LIVE CREDENTIAL AND A DEAD ONE.
//
// Quillio resolves a Google refresh token in the order user_tokens -> tenant_tokens
// -> env (src/google.js resolveGoogleRefreshToken), and the user_tokens lookup is
// GUARDED BY `if (userId)`. This script used to call resolveTenant(TENANT, null,
// null); the third argument is actingUserId, so `user` came back null BY
// CONSTRUCTION and the user_tokens lookup was never reached. Every run therefore
// used the DEPRECATED tenant-level credential.
//
// On T0B8LPRDKHR that credential was issued 2026-07-28 and is dead (invalid_grant),
// while the per-user credential for kyle.brintnall@gmail.com was refreshed
// 2026-08-11 and is live. The script reported a generic Google failure and nothing
// pointed at the difference, which is the confusion this flag exists to end.
//
// Omitting --user still works and still uses the tenant credential — but it now
// says so, loudly, and names the users it could have acted as instead.

const {
  resolveTenant,
  getProjects,
  getPool,
  isUndefinedTable,
} = (() => {
  const db = require('../src/db');
  const projects = require('../src/db/projects');
  return {
    resolveTenant: db.resolveTenant,
    getProjects: projects.getProjects,
    getPool: db.getPool,
    isUndefinedTable: db.isUndefinedTable,
  };
})();
const { getClientsForTenant, resolveGoogleRefreshToken } = require('../src/google');
const { getDestination } = require('../src/destinations');
const { runCopyReview, locatorOf, hasLocatorShape } = require('../src/services/copyReview');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const TENANT = flag('tenant', 'T0B8LPRDKHR');
const FIELD = flag('field', null);
const USER = flag('user', null);
const LIST = args.includes('--list');
const YES = args.includes('--yes');

const line = (s) => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);
const docIdFrom = (s) => {
  const m = String(s || '').match(/\/document\/d\/([a-zA-Z0-9_-]+)/) || String(s || '').match(/^([a-zA-Z0-9_-]{20,})$/);
  return m ? m[1] : null;
};

// --- Identity ----------------------------------------------------------------

// Resolve --user (an id or an email) to a user id, SCOPED TO THE TENANT.
//
// Scoped deliberately: `users.email` is globally UNIQUE and `users.id` is a global
// BIGSERIAL, so both would happily resolve somebody on another tenant — and this
// script's whole job is to write into one tenant's document as one of ITS people.
// A cross-tenant id is refused by name rather than quietly used.
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

// Every user on the tenant with a stored Google credential, and when it was
// stored. `updated_at` is written ONLY when a token is SAVED — nothing writes back
// after a refresh (there is no `tokens` listener in src/google.js) — so it reads
// as "issued", not "last used successfully". That is exactly the number you want
// when deciding whether a dead token is a one-off revocation or a 7-day expiry.
//
// NOTE THE COLUMN. The refresh token lives in `access_token`; `refresh_token` is
// unused for Google (only the removed Figma path ever wrote its equivalent).
// Selecting `refresh_token` here would report NULL for a perfectly good token.
async function googleCredentials(pool, tenantId) {
  if (!pool) return { users: [], tenant: null };
  const out = { users: [], tenant: null };
  try {
    const r = await pool.query(
      `SELECT u.id, u.email, ut.updated_at, length(ut.access_token) AS token_len
         FROM users u
         LEFT JOIN user_tokens ut ON ut.user_id = u.id AND ut.service = 'google'
        WHERE u.tenant_id = $1
        ORDER BY ut.updated_at DESC NULLS LAST, u.id`,
      [tenantId]
    );
    out.users = r.rows || [];
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
    console.warn('  (user_tokens table absent — pre-migration database)');
  }
  const t = await pool.query(
    `SELECT updated_at, length(access_token) AS token_len
       FROM tenant_tokens WHERE tenant_id = $1 AND service = 'google'`,
    [tenantId]
  );
  out.tenant = (t.rows && t.rows[0]) || null;
  return out;
}

const stamp = (v) => (v ? new Date(v).toISOString() : '(never)');

// What the catch at the bottom needs to name the dead credential. Module-scoped
// because the throw can come from anywhere inside the run, and a catch that says
// "a Google error happened" without saying WHICH identity it used is the exact
// report that sent the last diagnosis down the wrong path.
const FAILING_IDENTITY = { source: null, userId: null, email: null, creds: { users: [], tenant: null } };

// Is this the dead-refresh-token failure, however it is wrapped?
//
// google-auth-library surfaces it as a GaxiosError whose response body is
// { error: 'invalid_grant', ... }, but the shape varies by version and by whether
// the throw came from the token endpoint or from the API call that triggered the
// refresh. Checking the structured body AND the message text covers both without
// depending on either.
function isInvalidGrant(err) {
  if (!err) return false;
  const data = (err.response && err.response.data) || {};
  if (String(data.error || '') === 'invalid_grant') return true;
  return /invalid_grant/i.test(String(err.message || '')) || /invalid_grant/i.test(String(data.error_description || ''));
}

// runCopyReview REPORTS its plan through one log line and returns only a digest,
// so the add/delete counts are read off that line rather than inferred from the
// comment count — which cannot tell a delete-and-repost from a no-op.
//   added   = reconcile toAdd.length      removed = reconcile toDelete.length
//   swept   = orphan sweep deletions      kept    = matched and left in place
function captureReviewCounts(fn) {
  const real = console.log;
  let captured = null;
  console.log = (...a) => {
    const s = a.map(String).join(' ');
    if (s.startsWith('[review] doc=')) captured = s;
    real(...a);
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = real;
    })
    .then((result) => {
      const num = (k) => {
        const m = captured && captured.match(new RegExp(`${k}=(\\d+)`));
        return m ? Number(m[1]) : null;
      };
      return { result, raw: captured, kept: num('kept'), added: num('added'), removed: num('removed'), swept: num('swept') };
    });
}

async function snapshot(dest, docId, clients, label) {
  const live = await dest.listReviewComments(docId, clients);
  console.log(`\n  ${label}: ${live.length} Quillio comment(s)`);
  for (const c of live) {
    const loc = locatorOf(c.content);
    console.log(
      `    id=${c.id}\n` +
        `      anchor=${JSON.stringify(c.anchor)}${c.anchor ? '   <-- NOT EMPTY, report this' : ''}\n` +
        `      quote=${JSON.stringify((c.quote || '').slice(0, 40))}${c.quote ? '   <-- legacy comment (posted pre-fix)' : ''}\n` +
        `      locator=${JSON.stringify(loc)}  shaped=${hasLocatorShape(c.content)}  resolved=${c.resolved}`
    );
  }
  return live;
}

(async () => {
  const pool = getPool();

  // Resolve the ACTING USER first — it is the third argument to resolveTenant, and
  // passing null there is what made every previous run use the tenant credential.
  const acting = await resolveActingUser(pool, TENANT, USER);
  const ctx = await resolveTenant(TENANT, null, acting && acting.id);
  if (!ctx || !ctx.tenant) throw new Error(`tenant ${TENANT} did not resolve`);
  const tenantId = ctx.tenant.id || ctx.tenant.tenant_id || TENANT;
  const actingUserId = (ctx.user && ctx.user.id) || (acting && acting.id) || null;

  line('DEPLOYED BUILD — read from the container, not through Cloudflare');
  console.log(`  RAILWAY_GIT_COMMIT_SHA = ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}`);
  console.log(`  short                  = ${(process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'unknown'}`);
  console.log(`  tenant                 = ${tenantId}`);
  console.log(
    `  acting user            = ${acting ? `${acting.id} <${acting.email}>` : 'NONE (no --user)'}`
  );
  console.log('\n  STOP if that short sha is not the merge commit. Everything below would be');
  console.log('  measuring the old build.');

  // WHICH CREDENTIAL WILL ACTUALLY BE USED. Asked of the same function
  // getClientsForTenant asks, so this cannot disagree with the run that follows.
  const creds = await googleCredentials(pool, tenantId);
  const { source } = await resolveGoogleRefreshToken({ tenantId, userId: actingUserId });

  line('GOOGLE CREDENTIAL');
  console.log(`  will resolve to: ${source.toUpperCase()}`);
  console.log(`\n  tenant_tokens (deprecated): ${creds.tenant ? `stored ${stamp(creds.tenant.updated_at)} (${creds.tenant.token_len} chars)` : '(none)'}`);
  console.log('  user_tokens:');
  if (!creds.users.length) console.log('    (no users on this tenant)');
  for (const u of creds.users) {
    console.log(
      `    user ${u.id} <${u.email}> — ${u.token_len ? `stored ${stamp(u.updated_at)} (${u.token_len} chars)` : 'NO google token'}` +
        (String(u.id) === String(actingUserId) ? '   <-- ACTING AS THIS USER' : '')
    );
  }

  if (source !== 'user') {
    const candidates = creds.users.filter((u) => u.token_len);
    console.log('\n  ' + '!'.repeat(72));
    console.log('  WARNING: using the DEPRECATED tenant-level Google credential.');
    console.log('  Nothing is wrong with the code — user_tokens is only consulted when an');
    console.log('  acting user is supplied, and none was. src/google.js');
    console.log('  resolveGoogleRefreshToken guards that lookup with `if (userId)`.');
    if (candidates.length) {
      console.log('\n  A per-user credential IS available and was NOT tried. Re-run with:');
      for (const u of candidates) {
        console.log(`      node scripts/verifyReviewComments.js <docId> --user=${u.email} --yes`);
      }
    } else {
      console.log('\n  No per-user Google credential exists on this tenant either — sign in');
      console.log('  once at /oauth/google to mint one (access_type=offline, prompt=consent).');
    }
    console.log('  ' + '!'.repeat(72));
  }

  if (LIST) {
    line(`RECENT PROJECTS for ${tenantId} (read-only)`);
    for (const p of (await getProjects(tenantId)).slice(0, 15)) {
      console.log(`  ${p.created_at ? String(p.created_at).slice(0, 16) : '?'}  ${p.copy_doc_id || '(no copy doc)'}  ${p.campaign_title || ''}`);
    }
    process.exit(0);
  }

  const docId = docIdFrom(args.find((a) => !a.startsWith('--')));
  if (!docId) {
    console.error('\nPass a copy-doc id or URL. Use --list to find one.');
    process.exit(1);
  }
  if (!YES) {
    console.error(`\nThis POSTS AND DELETES real comments on ${docId}. Re-run with --yes to proceed.`);
    process.exit(1);
  }

  // ARMED BEFORE THE CALL, NOT AFTER. getClientsForTenant is itself a place
  // invalid_grant can be thrown, so populating this afterwards left the report
  // saying "identity attempted: UNKNOWN" on the one failure it exists to explain.
  FAILING_IDENTITY.source = source;
  FAILING_IDENTITY.userId = actingUserId;
  FAILING_IDENTITY.email = acting && acting.email;
  FAILING_IDENTITY.creds = creds;

  const clients = await getClientsForTenant({ tenantId, userId: actingUserId });
  const dest = getDestination();
  const url = `https://docs.google.com/document/d/${docId}/edit`;

  line('BEFORE — what is already on the document');
  const before = await snapshot(dest, docId, clients, 'existing');

  line('PASS 1 — whole-doc review');
  const p1 = await captureReviewCounts(() => runCopyReview(docId, tenantId, clients));
  console.log(`\n  digest: ${p1.result.digest}`);
  console.log(`  counts: added(toAdd)=${p1.added} removed(toDelete)=${p1.removed} swept=${p1.swept} kept=${p1.kept}`);
  const after1 = await snapshot(dest, docId, clients, 'after pass 1');

  line('QUESTION 2 — the anchor field');
  const anchors = after1.map((c) => c.anchor);
  const nonEmpty = anchors.filter((a) => a !== '');
  console.log(`  ${after1.length} comment(s); ${nonEmpty.length} with a non-empty anchor.`);
  console.log(nonEmpty.length === 0
    ? '  EXPECTED: every anchor is "". Nothing sends one.'
    : `  UNEXPECTED — report these verbatim: ${JSON.stringify(nonEmpty)}`);

  line('QUESTION 3 — second pass, NO edits in between (idempotency vs real Drive)');
  const p2 = await captureReviewCounts(() => runCopyReview(docId, tenantId, clients));
  console.log(`\n  counts: added(toAdd)=${p2.added} removed(toDelete)=${p2.removed} swept=${p2.swept} kept=${p2.kept}`);
  const after2 = await snapshot(dest, docId, clients, 'after pass 2');
  console.log(`\n  comment count: ${after1.length} -> ${after2.length}`);
  console.log(`  ids identical: ${JSON.stringify(after1.map((c) => c.id).sort()) === JSON.stringify(after2.map((c) => c.id).sort())}`);
  console.log('  EXPECTED: added=0 removed=0 swept=0, count unchanged, ids identical.');
  console.log('  A delete-and-repost (removed=N added=N, ids CHANGED, count same) is the');
  console.log('  state-loss path — it means doc_reviews did not persist. Report it as such.');

  line('QUESTION 4 — scoped review on ONE field');
  const content = await dest.getDocContent(docId, clients);
  let target = null;
  for (const a of content.assets || []) {
    for (const f of a.fields || []) {
      if (!String(f.copy || '').trim()) continue;
      if (FIELD && f.fieldName !== FIELD) continue;
      if (!target) target = { assetType: a.name, fieldName: f.fieldName, instance: a.instance || 0 };
    }
  }
  if (!target) {
    console.log('  no field with copy found — cannot scope. Skipping.');
  } else {
    console.log(`  scoping to: ${target.assetType} / ${target.fieldName} (instance ${target.instance})`);
    const p3 = await captureReviewCounts(() => runCopyReview(docId, tenantId, clients, [target]));
    console.log(`\n  counts: added(toAdd)=${p3.added} removed(toDelete)=${p3.removed} swept=${p3.swept} kept=${p3.kept}`);
    const after3 = await snapshot(dest, docId, clients, 'after scoped pass');

    const scopedLoc = null; // the scoped field's own comment may legitimately change
    const others = (list) => list.filter((c) => !String(locatorOf(c.content) || '').startsWith(`${target.fieldName} `)).map((c) => c.id).sort();
    const survived = JSON.stringify(others(after2)) === JSON.stringify(others(after3));
    console.log(`\n  other fields' comment ids untouched: ${survived}${survived ? '' : '   <-- REPORT THIS'}`);
    console.log(`  before: ${JSON.stringify(others(after2))}`);
    console.log(`  after:  ${JSON.stringify(others(after3))}`);
    void scopedLoc;
  }

  line('QUESTION 1 — THE ONE THIS SCRIPT CANNOT ANSWER');
  console.log(`  Open: ${url}`);
  console.log('  In the comment panel, for EACH Quillio comment, report:');
  console.log('    (a) is the comment text visible, or does it say "Original content deleted"?');
  console.log('    (b) does it sit in the margin unattached (expected — nothing is anchored),');
  console.log('        rather than beside a highlighted span?');
  console.log('  (b) is the DESIGN. Only (a) says whether the fix worked.');
  process.exit(0);
})().catch((err) => {
  // INVALID_GRANT GETS ITS OWN REPORT, because the generic one is what wasted the
  // last round: "A Google API error occurred" (utils/errors.clientErrorMessage
  // flattens it for the web, and the raw message is barely better) is true of a
  // dead refresh token, a missing scope and a deleted file alike. Nothing in
  // src/ detects this class — `invalid_grant` appears there exactly once, inside
  // that flattening regex — so the diagnosis has to be printed here.
  if (isInvalidGrant(err)) {
    const { source, userId, email, creds } = FAILING_IDENTITY;
    const cred =
      source === 'user'
        ? (creds.users || []).find((u) => String(u.id) === String(userId))
        : creds.tenant;
    console.error(`\n${'='.repeat(78)}`);
    console.error('INVALID_GRANT — the refresh token that was used is dead.');
    console.error('='.repeat(78));
    console.error(`  identity attempted : ${String(source || 'unknown').toUpperCase()}`);
    if (source === 'user') console.error(`  user               : ${userId} <${email || '?'}>`);
    else if (source === 'tenant') console.error(`  row                : tenant_tokens (tenant_id=${TENANT}, service='google')`);
    console.error(`  credential stored  : ${cred ? stamp(cred.updated_at) : '(not readable)'}`);
    console.error('                       (written when the token was SAVED — nothing writes');
    console.error('                        back on refresh, so this is "issued", not "last used")');
    console.error('\n  The stored date above is what separates the two causes:');
    console.error('    ~7 days old   -> the OAuth consent screen is in TESTING. Recurring.');
    console.error('                     Publish it (Console -> OAuth consent screen) or expect');
    console.error('                     this again in a week. See README.md "Keep the consent');
    console.error('                     screen out of Testing long-term".');
    console.error('    older, sudden -> access revoked, or the client secret was rotated.');
    if (source !== 'user') {
      const alt = (creds.users || []).filter((u) => u.token_len);
      if (alt.length) {
        console.error('\n  A per-user credential exists and was NOT tried. Re-run with:');
        for (const u of alt) console.error(`      --user=${u.email}   (stored ${stamp(u.updated_at)})`);
      }
    }
    console.error(`\n  raw: ${(err && err.message) || err}`);
    process.exit(2);
  }
  console.error('\nVERIFY FAILED:', (err && err.message) || err);
  console.error('\nNeeds real credentials and a database. Run it in the Railway console.');
  process.exit(1);
});
