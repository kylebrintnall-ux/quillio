'use strict';

// READ-ONLY CHECK — does the word-limit marker (googleDocs.js's HEADING_5
// paragraph, added when generateAssetDrafts flags a word field `unenforced`)
// sit correctly in a REAL document, and does it leave field-label parsing
// alone?
//
// Two questions, both answered from the RAW document plus the REAL parser —
// never a reimplementation of either:
//
//   1. Every HEADING_5 paragraph: report its text, its start/end index,
//      whether it is bold, and the paragraph immediately before and after it.
//      A marker that landed correctly is preceded by the field's own (non-
//      bold) copy and followed by the next field's bold label, an asset
//      heading, or nothing (end of document/section) — never by more
//      unstyled text, which would mean it landed INSIDE a field's copy.
//
//   2. Every bold paragraph in the document: its text and its parsed field
//      name / bracket values, read off the REAL `getDocContent` (the same
//      function generateDraft, copyReview, and sibling-context all read
//      through) rather than a second copy of its bracket regex. If the
//      marker had broken field-label parsing, this is where it would show —
//      a field the real parser no longer recognizes, or one whose charMin/
//      charMax/fieldType came out wrong.
//
// READ-ONLY, STRUCTURALLY. `docs.documents.get` and nothing else — there is
// no batchUpdate anywhere in this file, and the stub below THROWS if the real
// getDocContent reaches for a second call. There is no --commit flag and no
// write path to add one to.
//
// WHY IT CALLS THE REAL READER INSTEAD OF RE-IMPLEMENTING THE RULE. A
// measurement that reimplements the thing it measures measures the
// reimplementation (CLAUDE.md: "check the measurement calls the entry point
// production calls"). The document is fetched ONCE and the identical `doc`
// object is handed to the real `getDocContent`, exactly as
// scripts/auditFieldLabelShape.js does. Two small local helpers
// (`runStyle` / `paragraphText`, googleDocs.js:775/783) are copied verbatim
// so the raw walk below can ask the same "is this bold / what does this
// paragraph say" question of paragraphs the real reader skips ENTIRELY
// (HEADING_5, by design — that is the feature being checked) — they are not
// used to re-derive field boundaries or bracket values, which stay the real
// reader's job alone.
//
// The walk and the verdict are pure functions of a `doc` object (no network,
// no credentials) and are exported for exactly the reason
// auditFieldLabelShape.js exports its own: so they can be — and were,
// before this was ever pointed at production — checked against a synthetic
// document.
//
// CREDENTIALS AND TENANT. Resolved the same way scripts/auditFieldLabelShape.js
// resolves an acting identity: --user=<id|email>, matched against users on the
// given tenant, else the tenant's most recently stored per-user Google
// credential (the run says which it picked and warns if it fell back to a
// deprecated tenant-level or shared env token).
//
// Needs real credentials and a database. NOT part of `npm test`.
// Run it in the RAILWAY CONSOLE as plain node — never `railway run`:
//
//   node scripts/verify-word-marker.js <tenantId> <docId>
//   node scripts/verify-word-marker.js <tenantId> <docId> --user=kyle.brintnall@gmail.com

const {
  getPool,
  resolveTenant,
  isUndefinedTable,
} = require('../src/db');
const { getClientsForTenant, resolveGoogleRefreshToken } = require('../src/google');
const { getDestination } = require('../src/destinations');

const rawArgs = process.argv.slice(2);
const flagArgs = rawArgs.filter((a) => a.startsWith('--'));
const positional = rawArgs.filter((a) => !a.startsWith('--'));
const flag = (name) => {
  const hit = flagArgs.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const TENANT_ID = positional[0] || null;
const DOC_ID = positional[1] || null;
const WANT_USER = flag('user');

const rule = (s) => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);
const sub = (s) => console.log(`\n${s}\n${'-'.repeat(78)}`);
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
const q = (s) => JSON.stringify(s); // verbatim + unambiguous about whitespace
const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// LOCAL COPIES of two unexported helpers (googleDocs.js:775 and :783).
// Verbatim, and used ONLY to answer "is this paragraph bold" / "what does it
// say" for the raw walk below — never to re-derive a field boundary or a
// bracket value, which stay the real getDocContent's job throughout.
// ---------------------------------------------------------------------------
function runStyle(paragraph) {
  const el = (paragraph.elements || []).find(
    (e) => e.textRun && e.textRun.content && e.textRun.content.trim()
  );
  const ts = (el && el.textRun && el.textRun.textStyle) || {};
  return { bold: !!ts.bold, italic: !!ts.italic };
}
function paragraphText(paragraph) {
  return (paragraph.elements || [])
    .map((e) => (e.textRun ? e.textRun.content : ''))
    .join('')
    .replace(/\n+$/, '');
}

// One neighbor's description for the before/after report: its text, whether
// it's bold, and its structural style if it carries one.
function describeNeighbor(item) {
  if (!item) return { present: false, text: null, bold: false, named: null };
  if (!item.paragraph) return { present: true, text: '(non-paragraph content — table or similar)', bold: false, named: null };
  const p = item.paragraph;
  const named = (p.paragraphStyle && p.paragraphStyle.namedStyleType) || null;
  const { bold } = runStyle(p);
  return { present: true, text: paragraphText(p).trim(), bold, named };
}

// ---------------------------------------------------------------------------
// PURE — no I/O. Walk a `doc` object (documents.get's `.data`) and return
// every HEADING_5 paragraph (with its neighbors) and every bold paragraph.
// ---------------------------------------------------------------------------
function rawWalk(doc) {
  const body = (doc.body && doc.body.content) || [];
  const heading5s = [];
  const boldParas = [];
  for (let i = 0; i < body.length; i += 1) {
    const item = body[i];
    if (!item.paragraph) continue;
    const p = item.paragraph;
    const named = (p.paragraphStyle && p.paragraphStyle.namedStyleType) || null;
    const text = paragraphText(p).trim();
    const { bold } = runStyle(p);

    if (named === 'HEADING_5') {
      heading5s.push({
        text,
        startIndex: item.startIndex,
        endIndex: item.endIndex,
        bold,
        before: describeNeighbor(body[i - 1]),
        after: describeNeighbor(body[i + 1]),
      });
    }
    if (bold && text) {
      boldParas.push({ text, startIndex: item.startIndex, endIndex: item.endIndex });
    }
  }
  return { heading5s, boldParas };
}

// PURE. Every bold paragraph found by rawWalk, matched against the REAL
// parser's own field list (by `label`, the bold paragraph verbatim — see
// getDocContent's own comment). Anything unmatched is what a broken parse
// would look like.
function crossReferenceBold(boldParas, realFields) {
  const matched = [];
  const unrecognized = [];
  for (const b of boldParas) {
    const f = realFields.find((rf) => rf.label === b.text);
    if (f) matched.push({ ...b, field: f });
    else unrecognized.push(b);
  }
  return { matched, unrecognized };
}

// PURE. Expected: preceded by non-bold copy (or nothing — start of doc/
// section); followed by a bold field label, an asset heading (HEADING_3), or
// nothing (end of document/section).
function verdictFor(heading5s) {
  const results = heading5s.map((m) => {
    const beforeOk = !m.before.present || (!m.before.bold && !!m.before.text);
    const afterOk = !m.after.present || m.after.bold || m.after.named === 'HEADING_3';
    return { text: m.text, beforeOk, afterOk, ok: beforeOk && afterOk };
  });
  return { results, flagged: results.filter((r) => !r.ok).length };
}

// Same one-read guard as scripts/auditFieldLabelShape.js's stubClients: the
// doc is fetched once by main(), and this is what makes "one Google read"
// a property of the code rather than a promise in a comment.
function stubClients(doc, docId, counter) {
  return {
    docs: {
      documents: {
        get: async ({ documentId }) => {
          counter.calls += 1;
          if (counter.calls > 1) {
            throw new Error(
              `getDocContent called documents.get ${counter.calls}x for ${docId} — this script assumes one read.`
            );
          }
          if (documentId !== docId) {
            throw new Error(`getDocContent asked for ${documentId}, expected ${docId}.`);
          }
          return { data: doc };
        },
      },
    },
    // Deliberately no `drive`. getDocContent must not need one; if it grows a
    // Drive call this throws a TypeError naming the line, which is the report
    // we want rather than a silent extra request.
  };
}

async function readDoc(clients, docId, attempt = 0) {
  try {
    return (await clients.docs.documents.get({ documentId: docId })).data;
  } catch (err) {
    const status = (err && (err.code || err.status)) || 0;
    const transient = status === 429 || (status >= 500 && status < 600);
    if (transient && attempt < 2) {
      await sleep(1000 * (attempt + 1));
      return readDoc(clients, docId, attempt + 1);
    }
    throw err;
  }
}

// Every user on this tenant holding a Google credential, most recently stored
// first — same query and same column note as auditFieldLabelShape.js.
async function googleUsers(pool, tenantId) {
  try {
    const r = await pool.query(
      `SELECT u.id, u.email, ut.updated_at
         FROM users u
         JOIN user_tokens ut ON ut.user_id = u.id AND ut.service = 'google'
        WHERE u.tenant_id = $1
        ORDER BY ut.updated_at DESC NULLS LAST, u.id`,
      [tenantId]
    );
    return r.rows || [];
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
    return [];
  }
}

// --user=<id|email>, SCOPED to the given tenant (unlike
// auditFieldLabelShape.js's resolveUserAnywhere, which searches every tenant
// because it walks several — this script is handed one tenant up front, so a
// user who does not belong to it is a usage error, not an ambiguity to
// resolve).
async function resolveUserOnTenant(pool, tenantId, raw) {
  const want = String(raw || '').trim();
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
    throw new Error(`--user=${want} is on tenant ${row.tenant_id}, not the requested tenant ${tenantId}.`);
  }
  return { id: row.id, email: row.email };
}

async function main() {
  if (!TENANT_ID || !DOC_ID) {
    console.error('Usage: node scripts/verify-word-marker.js <tenantId> <docId> [--user=<id|email>]');
    process.exit(1);
  }

  const pool = getPool();
  if (!pool) {
    console.error('DATABASE_URL is not set. This script resolves the tenant\'s Google credential from Postgres.');
    process.exit(1);
  }

  const dest = getDestination();
  if (dest.name !== 'google-docs') {
    console.error(`DESTINATION resolves to '${dest.name}', not 'google-docs'. The parser under test is`);
    console.error('the Google Docs adapter; refusing to check a different one.');
    process.exit(1);
  }

  // --- identity ---------------------------------------------------------
  rule('READING AS');
  let acting = null;
  let how = null;
  if (WANT_USER) {
    acting = await resolveUserOnTenant(pool, TENANT_ID, WANT_USER);
    how = '--user';
  } else {
    const candidates = await googleUsers(pool, TENANT_ID);
    if (candidates.length) {
      acting = { id: candidates[0].id, email: candidates[0].email };
      how = `auto — most recently stored of ${candidates.length} Google credential(s) on this tenant`;
    }
  }
  const ctx = await resolveTenant(TENANT_ID, null, acting && acting.id);
  const realTenantId = (ctx && ctx.tenant && (ctx.tenant.id || ctx.tenant.tenant_id)) || TENANT_ID;
  const actingUserId = (ctx && ctx.user && ctx.user.id) || (acting && acting.id) || null;
  const { source } = await resolveGoogleRefreshToken({ tenantId: realTenantId, userId: actingUserId });

  console.log(`  tenant ${realTenantId}  identity: ${source.toUpperCase()}` +
    (acting ? ` — user ${acting.id} <${acting.email}> (${how})` : ''));
  if (source !== 'user') {
    console.log(`  NOTE: not a per-user credential. ` +
      (source === 'tenant'
        ? 'This is the DEPRECATED tenant-level token — confirm it is still live.'
        : 'Falling back to the shared env credential.'));
    console.log('  Pass --user=<email> for someone on this tenant to read as them instead.');
  }
  const clients = await getClientsForTenant({ tenantId: realTenantId, userId: actingUserId });

  // --- fetch once, hand the same object to the real reader ---------------
  rule(`DOCUMENT ${DOC_ID} — one documents.get, no write of any kind`);
  const doc = await readDoc(clients, DOC_ID);
  console.log(`  title: ${q(doc.title || '')}`);

  const counter = { calls: 0 };
  const content = await dest.getDocContent(DOC_ID, stubClients(doc, DOC_ID, counter));
  const realFields = []; // every field the REAL parser recognized
  for (const a of content.assets || []) {
    for (const f of a.fields || []) realFields.push({ ...f, assetHeading: a.name, instance: a.instance });
  }

  // --- raw walk + cross-reference (pure, exported, unit-testable) --------
  const { heading5s, boldParas } = rawWalk(doc);
  const { matched, unrecognized } = crossReferenceBold(boldParas, realFields);

  // --- section: every bold paragraph, parsed via the REAL reader ---------
  sub(`EVERY BOLD PARAGRAPH (${boldParas.length}) — name/brackets from the real getDocContent, not a reimplementation`);
  console.log(`  ${pad('PARAGRAPH TEXT', 42)} ${pad('FIELD NAME', 24)} ${pad('MIN', 5)} ${pad('MAX', 5)} TYPE`);
  console.log('  ' + '-'.repeat(100));
  for (const b of boldParas) {
    const m = matched.find((x) => x.text === b.text && x.startIndex === b.startIndex);
    if (m) {
      console.log(
        `  ${pad(clip(b.text, 40), 42)} ${pad(clip(m.field.fieldName, 22), 24)} ${pad(m.field.charMin || '-', 5)} ${pad(m.field.charMax || '-', 5)} ${m.field.fieldType}`
      );
    } else {
      console.log(`  ${pad(clip(b.text, 40), 42)} *** NOT RECOGNIZED AS A FIELD BY getDocContent ***`);
    }
  }
  if (unrecognized.length) {
    console.log(`\n  ${unrecognized.length} bold paragraph(s) above are not in the real parser's field list.`);
    console.log('  That is the shape a broken parse would take — read the paragraph text above and');
    console.log('  the HEADING_5 section below together before concluding anything is wrong, since a');
    console.log('  bold paragraph outside any asset section is expected to be unrecognized too.');
  }

  // --- section: every HEADING_5, with neighbors ---------------------------
  sub(`EVERY HEADING_5 PARAGRAPH (${heading5s.length})`);
  if (!heading5s.length) {
    console.log('  None found in this document.');
  }
  heading5s.forEach((m, i) => {
    console.log(`\n  ${i + 1}. ${q(m.text)}`);
    console.log(`     range [${m.startIndex}, ${m.endIndex})  ·  bold: ${m.bold}`);
    console.log(
      `     BEFORE: ${m.before.present ? `${q(clip(m.before.text, 70))}${m.before.bold ? '  [BOLD]' : ''}${m.before.named ? `  [${m.before.named}]` : ''}` : '(nothing — start of document)'}`
    );
    console.log(
      `     AFTER : ${m.after.present ? `${q(clip(m.after.text, 70))}${m.after.bold ? '  [BOLD]' : ''}${m.after.named ? `  [${m.after.named}]` : ''}` : '(nothing — end of document)'}`
    );
  });

  // --- verdict --------------------------------------------------------------
  rule('VERDICT — is every marker positioned correctly?');
  console.log('  Expected: preceded by non-bold copy (or nothing); followed by a bold field');
  console.log('  label, an asset heading (HEADING_3), or nothing (end of document/section).\n');

  const { results, flagged } = verdictFor(heading5s);
  results.forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.ok ? 'OK  ' : 'FLAG'}  ${q(clip(r.text, 60))}`);
    if (!r.beforeOk) console.log(`        preceding paragraph is not non-bold copy: ${q(clip(heading5s[i].before.text, 60))} bold=${heading5s[i].before.bold}`);
    if (!r.afterOk) console.log(`        following paragraph is neither a bold label nor an asset heading: ${q(clip(heading5s[i].after.text, 60))} bold=${heading5s[i].after.bold} style=${heading5s[i].after.named || 'NORMAL_TEXT'}`);
  });

  console.log('');
  if (!heading5s.length) {
    console.log('  No HEADING_5 paragraphs in this document — nothing to verify (no word field is over its limit here).');
  } else if (flagged === 0) {
    console.log(`  All ${heading5s.length} marker(s) are positioned correctly.`);
  } else {
    console.log(`  ${flagged} of ${heading5s.length} marker(s) FLAGGED — see above.`);
  }
  if (unrecognized.length) {
    console.log(`  ${unrecognized.length} bold paragraph(s) were not recognized as fields — see the bold-paragraph section above.`);
  }

  console.log('\nDone. Nothing was written to this document.');
  process.exit(flagged > 0 || unrecognized.length > 0 ? 2 : 0);
}

// Pure halves exported so the walk and the verdict can be driven against a
// synthetic document with no credentials and no network — the same reason
// scripts/auditFieldLabelShape.js exports its own. Guarded by require.main so
// importing the file cannot start a Drive-reading run.
module.exports = {
  rawWalk,
  crossReferenceBold,
  verdictFor,
  runStyle,
  paragraphText,
  describeNeighbor,
};

if (require.main === module) {
  main().catch((err) => {
    const data = (err && err.response && err.response.data) || {};
    if (String(data.error || '') === 'invalid_grant' || /invalid_grant/i.test(String((err && err.message) || ''))) {
      console.error('\nINVALID_GRANT — the refresh token used is dead.');
      console.error('Re-run with --user=<id|email> for someone on this tenant to use a per-user credential.');
      process.exit(2);
    }
    console.error('\nFAILED:', (err && err.message) || err);
    console.error('\nNeeds real credentials and a database. Run it in the Railway console.');
    process.exit(1);
  });
}
