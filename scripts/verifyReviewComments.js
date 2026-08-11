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
//   node scripts/verifyReviewComments.js <docId-or-URL> --yes
//
// Options:
//   --tenant=<id>   default T0B8LPRDKHR
//   --field="Name"  scope step 4 to this field name (default: the first with copy)
//   --list          list recent projects for the tenant and exit. Read-only.

const { resolveTenant, getProjects } = (() => {
  const db = require('../src/db');
  const projects = require('../src/db/projects');
  return { resolveTenant: db.resolveTenant, getProjects: projects.getProjects };
})();
const { getClientsForTenant } = require('../src/google');
const { getDestination } = require('../src/destinations');
const { runCopyReview, locatorOf, hasLocatorShape } = require('../src/services/copyReview');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const TENANT = flag('tenant', 'T0B8LPRDKHR');
const FIELD = flag('field', null);
const LIST = args.includes('--list');
const YES = args.includes('--yes');

const line = (s) => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);
const docIdFrom = (s) => {
  const m = String(s || '').match(/\/document\/d\/([a-zA-Z0-9_-]+)/) || String(s || '').match(/^([a-zA-Z0-9_-]{20,})$/);
  return m ? m[1] : null;
};

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
  const ctx = await resolveTenant(TENANT, null, null);
  if (!ctx || !ctx.tenant) throw new Error(`tenant ${TENANT} did not resolve`);
  const tenantId = ctx.tenant.id || ctx.tenant.tenant_id || TENANT;

  line('DEPLOYED BUILD — read from the container, not through Cloudflare');
  console.log(`  RAILWAY_GIT_COMMIT_SHA = ${process.env.RAILWAY_GIT_COMMIT_SHA || '(unset)'}`);
  console.log(`  short                  = ${(process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || 'unknown'}`);
  console.log(`  tenant                 = ${tenantId} (acting user: ${(ctx.user && ctx.user.id) || 'none — falling back'})`);
  console.log('\n  STOP if that short sha is not the merge commit. Everything below would be');
  console.log('  measuring the old build.');

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

  const clients = await getClientsForTenant({ tenantId, userId: (ctx.user && ctx.user.id) || null });
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
  console.error('\nVERIFY FAILED:', (err && err.message) || err);
  console.error('\nNeeds real credentials and a database. Run it in the Railway console.');
  process.exit(1);
});
