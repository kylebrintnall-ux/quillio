'use strict';

// READ-ONLY MEASUREMENT — what does the field-label rule actually match today?
//
// THE QUESTION. `runStyle` reads the first non-blank run's bold flag, and both
// readers start a new field on `if (bold && text)` with no requirement that the
// paragraph look like a label (destinations/googleDocs.js — parseDoc's branch and
// getDocContent's branch). So any bold paragraph under an asset heading becomes a
// field. This script measures what that rule matches across every project
// document that exists, and how many of those matches carry a trailing bracket of
// the shape the generator writes.
//
// IT PROPOSES NOTHING AND CHANGES NOTHING. There is no fix in this file and no
// recommendation in its output. It prints counts and the paragraphs behind them.
//
// READ-ONLY, STRUCTURALLY:
//   - Postgres: SELECTs only. No transaction, no DDL, no UPDATE/INSERT/DELETE.
//   - Google:   `docs.documents.get` and nothing else. There is no batchUpdate,
//               no files.create, no comments call anywhere in this file. One
//               successful read per document (a 429/5xx is retried twice, so a
//               flaky document costs up to three READS and still zero writes),
//               and the stub below THROWS if the production reader reaches for a
//               call of its own — so the claim is enforced, not asserted.
//   - Disk:     nothing, unless --json=<path> is passed explicitly.
//
// WHY IT CALLS THE REAL READER INSTEAD OF RE-IMPLEMENTING THE RULE. A measurement
// that reimplements the thing it measures measures the reimplementation
// (CLAUDE.md: "check the measurement calls the entry point production calls").
// So each document is fetched ONCE and the identical `doc` object is handed to the
// real `getDocContent`, whose `field.label` is documented as the bold paragraph
// VERBATIM. Those labels are the population — they are the current rule's own
// answer, not this script's opinion of it.
//
// The second question — a paragraph with a bracket that is NOT bold, which the
// current rule is already missing — cannot be answered from the reader's output,
// because a paragraph it never treated as a label does not appear there. That one
// needs a walk of the raw body, which means a local copy of `runStyle` /
// `paragraphText` (neither is exported). A copy can drift from its original, so it
// is not trusted: the walk ALSO re-derives the label list, and the run refuses to
// report if that list disagrees with the real reader's, in order or in content.
// The copy is a checked assumption rather than an assumed one.
//
// WHICH DOCUMENTS. `projects.copy_doc_id` — the copy doc, which is the only thing
// parseDoc and getDocContent are ever pointed at (routes/app.js:633 sends
// template_doc_id down getProjectTemplateContent → readTemplateCells instead).
// Template documents are counted and named as excluded rather than silently
// dropped; --include-templates measures them too so the exclusion is falsifiable.
//
// TENANTS. Discovered from the data (every tenant with at least one project) and
// printed, rather than hardcoded — so the set being measured is visible and can be
// checked. --tenant=<id> (repeatable) restricts it.
//
// CREDENTIALS. Resolved per tenant exactly the way scripts/inspectRealAnchor.js
// does: --user=<id|email> (repeatable, matched to whichever tenant the user
// belongs to) → resolveTenant → getClientsForTenant, so the read runs as that
// person's own Google identity. A tenant with no --user gets its most recently
// stored per-user Google credential, and the run says which it picked. The
// deprecated tenant-level credential is used only as a last resort and is called
// out when it is (on T0B8LPRDKHR it is dead — invalid_grant).
//
// A DOCUMENT THAT COULD NOT BE READ IS AN ERROR, NOT A ZERO. It is listed, and the
// process exits non-zero. A doc counted as "0 labels" because the fetch failed
// would be a contaminated cell reported as a measurement (CLAUDE.md).
//
// Needs real credentials and a database. NOT part of `npm test`.
// Run it in the RAILWAY CONSOLE as plain node — never `railway run`:
//
//   node scripts/auditFieldLabelShape.js --user=kyle.brintnall@gmail.com
//
// Options:
//   --user=<id|email>     act as this user (repeatable; resolved to their tenant)
//   --tenant=<id>         restrict to this tenant (repeatable; default: all)
//   --include-templates   also walk projects.template_doc_id (see above)
//   --limit=<n>           stop after n documents (a smoke run, not a measurement)
//   --sleep=<ms>          pause between document reads (default 150)
//   --json=<path>         ALSO write the full structured result to this path
//                         (the only write this script can perform; off by default)

const path = require('path');
const {
  getPool,
  resolveTenant,
  isUndefinedTable,
  isUndefinedColumn,
} = require('../src/db');
const { getClientsForTenant, resolveGoogleRefreshToken } = require('../src/google');
const { getDestination } = require('../src/destinations');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const flagAll = (name) =>
  args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3)).filter(Boolean);

const WANT_TENANTS = flagAll('tenant');
const WANT_USERS = flagAll('user');
const INCLUDE_TEMPLATES = args.includes('--include-templates');
const LIMIT = Number(flag('limit', 0)) || 0;
const SLEEP_MS = Number(flag('sleep', '150'));
const JSON_OUT = flag('json', null);

const rule = (s) => console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);
const sub = (s) => console.log(`\n${s}\n${'-'.repeat(78)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The two shape tests
// ---------------------------------------------------------------------------

// EXACTLY what googleDocs.fieldLabel writes:
//   `${fieldName} [${min}-${max}${unit}]`  |  `${fieldName} [${max}${unit}]`
// with WORD_UNIT_SUFFIX = ' words', a single literal space before the bracket,
// and NO bracket at all when charMax === 0 (that third form is the whole reason
// section A below is not empty by construction).
const GENERATOR_SHAPE = /^(.+) \[(\d+)(?:-(\d+))?( words)?\]$/;

// The parser's OWN recovery regex, character for character
// (googleDocs.js parseDoc:962 and getDocContent:1687). Anything it matches, the
// reader treats as having a bracket — including brackets with no digits in them.
const PARSER_BRACKET = /^(.*?)\s*\[([^\]]*)\]\s*$/;

// Which bucket does a detected label fall into? One of:
//   generator   — byte-shape identical to what fieldLabel emits
//   digits      — a trailing bracket the parser recovers numbers from, but not
//                 the generator's shape (spacing, extra text, a stray unit…)
//   no_digits   — a trailing bracket with no number in it at all
//   none        — no trailing bracket; the parser reads the whole line as the name
function bracketClass(text) {
  if (GENERATOR_SHAPE.test(text)) return 'generator';
  const m = text.match(PARSER_BRACKET);
  if (!m) return 'none';
  return /\d/.test(m[2]) ? 'digits' : 'no_digits';
}

// ---------------------------------------------------------------------------
// LOCAL COPIES of two unexported helpers (googleDocs.js:764 and :772).
//
// Verbatim. They exist here only so the raw-body walk below can ask the same
// question of a paragraph that the production reader asks. They are NOT trusted:
// mirrorWalk re-derives the label list with them and the run aborts if that list
// differs from the real reader's. If you change either function in googleDocs.js
// and not here, the cross-check is what tells you.
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

// How much of the paragraph is bold, as a fact about the runs. `runStyle` reads
// only the FIRST non-blank run, so a paragraph opening with a bold phrase and
// continuing in plain text answers `bold: true` on the strength of that one run.
// Reported per label because it is free to compute and it distinguishes a written
// label (bold throughout) from a paragraph that merely starts bold. It is an
// observation about the population, not a candidate rule.
function boldCensus(paragraph) {
  const runs = (paragraph.elements || []).filter(
    (e) => e.textRun && e.textRun.content && e.textRun.content.trim()
  );
  const bold = runs.filter((e) => e.textRun.textStyle && e.textRun.textStyle.bold === true);
  return { totalRuns: runs.length, boldRuns: bold.length, allBold: runs.length > 0 && bold.length === runs.length };
}

// ---------------------------------------------------------------------------
// The raw-body walk.
//
// Branch for branch, in order, the traversal in getDocContent (googleDocs.js:1604
// onward). It reproduces WHERE a label can be detected, so that a paragraph the
// reader passed over can be reported with what it was taken for instead.
//
// Reference Insights / Reference Materials need no branch of their own here for
// the same reason getDocContent has none: appendBody writes both ABOVE the
// horizontal rule and every asset heading, so `current` is still null when their
// paragraphs come round and `if (!current) continue` drops them.
// ---------------------------------------------------------------------------
function mirrorWalk(doc) {
  const labels = []; // every paragraph the current rule treats as a field label
  const missedBrackets = []; // bracket-shaped, NOT bold, in label position
  const outsideAsset = []; // bracket-shaped, before any asset heading (context only)

  let current = null;
  let field = null;
  let expecting = null;

  for (const item of doc.body.content || []) {
    if (!item.paragraph) continue;
    const p = item.paragraph;
    const named = (p.paragraphStyle && p.paragraphStyle.namedStyleType) || undefined;
    const text = paragraphText(p).trim();
    const { bold, italic } = runStyle(p);

    if (named === 'HEADING_2' && text === 'Campaign Summary') { expecting = 'summary'; field = null; continue; }
    if (named === 'HEADING_2' && text === 'Writer Direction') { expecting = 'writerDirection'; field = null; continue; }
    if (expecting === 'summary') { if (text) expecting = null; continue; }
    if (expecting === 'writerDirection') { if (text) expecting = null; continue; }

    if (named === 'HEADING_3') { current = { heading: text, fields: 0 }; field = null; continue; }
    if (named === 'HEADING_4') { field = null; continue; }
    if (named === 'HEADING_6') continue;

    if (!current) {
      // Not a label position under any reading — recorded only so a bracket-shaped
      // paragraph up here is visibly accounted for rather than silently absent.
      if (text && bracketClass(text) !== 'none') {
        outsideAsset.push({ text, named: named || null, bold, italic });
      }
      continue;
    }

    // The asset-direction line. It precedes the bold branch in the real reader, so
    // a bold+italic first paragraph of an asset is direction, never a field.
    if (italic && text && current.fields === 0 && !field) { continue; }

    if (bold && text) {
      current.fields += 1;
      field = { copy: '', notes: '' };
      labels.push({
        text,
        assetHeading: current.heading,
        bracket: bracketClass(text),
        ...boldCensus(p),
      });
      continue;
    }

    // Everything below here the reader did NOT take as a label. A bracket-shaped
    // paragraph reaching this point is one the current rule is missing, and what
    // it WAS taken for is the useful half of the report.
    const takenAs =
      field && italic && text && !field.copy && !field.notes ? 'per-field notes'
        : field && text ? 'drafted copy'
          : 'nothing (skipped)';

    if (text && bracketClass(text) !== 'none' && !bold) {
      missedBrackets.push({
        text,
        assetHeading: current.heading,
        bracket: bracketClass(text),
        italic,
        named: named || null,
        takenAs,
      });
    }

    if (field && italic && text && !field.copy && !field.notes) { field.notes = text; continue; }
    if (field && text) { field.copy = field.copy ? `${field.copy}\n${text}` : text; }
  }

  return { labels, missedBrackets, outsideAsset };
}

// ---------------------------------------------------------------------------
// Identity — same shape as scripts/inspectRealAnchor.js
// ---------------------------------------------------------------------------

// Resolve a --user (id or email) to { id, email, tenantId }. Unscoped on purpose
// HERE, unlike inspectRealAnchor: this script walks several tenants and matches
// each user to the tenant they belong to, rather than being told the tenant up
// front. The refusal that replaces the scope check is below — two users landing
// on one tenant is an ambiguity, not a preference.
async function resolveUserAnywhere(pool, raw) {
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
  return { id: row.id, email: row.email, tenantId: row.tenant_id };
}

// Every user on a tenant holding a Google credential, most recently stored first.
// NOTE THE COLUMN: the refresh token lives in `access_token` — `refresh_token` is
// unused for Google (verifyReviewComments.js:130 explains why).
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

// ---------------------------------------------------------------------------
// Population
// ---------------------------------------------------------------------------

// Per-tenant project counts. `template_doc_id` arrives in
// migrateAddProjectTemplateDoc.js, so tolerate 42703 the way db.js does
// everywhere else and report the honest zero.
async function tenantCensus(pool) {
  const WITH_TPL = `SELECT tenant_id,
                           count(*)::int                                              AS projects,
                           count(*) FILTER (WHERE copy_doc_id IS NOT NULL)::int       AS copy_docs,
                           count(*) FILTER (WHERE template_doc_id IS NOT NULL)::int   AS template_docs
                      FROM projects GROUP BY tenant_id ORDER BY tenant_id`;
  const NO_TPL = `SELECT tenant_id,
                         count(*)::int                                         AS projects,
                         count(*) FILTER (WHERE copy_doc_id IS NOT NULL)::int  AS copy_docs,
                         0                                                     AS template_docs
                    FROM projects GROUP BY tenant_id ORDER BY tenant_id`;
  try {
    return (await pool.query(WITH_TPL)).rows;
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    console.warn('  (projects.template_doc_id absent — pre-migration database; template counts read 0)');
    return (await pool.query(NO_TPL)).rows;
  }
}

// Every document to walk, in tenant then creation order. Closed projects INCLUDED
// — a closed project's document still exists in Drive and is still read by the
// project view, so excluding it would undercount the population a rule change
// lands on.
async function documentsFor(pool, tenantIds) {
  const cols = INCLUDE_TEMPLATES
    ? `id, tenant_id, name, status, created_at, copy_doc_id, template_doc_id`
    : `id, tenant_id, name, status, created_at, copy_doc_id, NULL::text AS template_doc_id`;
  let rows;
  try {
    rows = (
      await pool.query(
        `SELECT ${cols} FROM projects
          WHERE tenant_id = ANY($1::text[])
          ORDER BY tenant_id, created_at`,
        [tenantIds]
      )
    ).rows;
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    console.warn('  (projects.template_doc_id absent — copy docs only)');
    rows = (
      await pool.query(
        `SELECT id, tenant_id, name, status, created_at, copy_doc_id, NULL::text AS template_doc_id
           FROM projects WHERE tenant_id = ANY($1::text[]) ORDER BY tenant_id, created_at`,
        [tenantIds]
      )
    ).rows;
  }

  // One entry per DOCUMENT, deduped by doc id. saveProject is idempotent on
  // copy_doc_id so a repeat is not expected; deduping means a surprise is a
  // footnote rather than a doubled count.
  const seen = new Map();
  for (const r of rows) {
    for (const [kind, docId] of [['copy', r.copy_doc_id], ['template', r.template_doc_id]]) {
      if (!docId) continue;
      if (kind === 'template' && !INCLUDE_TEMPLATES) continue;
      if (seen.has(docId)) { seen.get(docId).alsoProjects.push(r.id); continue; }
      seen.set(docId, {
        docId, kind, tenantId: r.tenant_id, projectId: r.id,
        projectName: r.name || '(unnamed)', status: r.status || null,
        createdAt: r.created_at, alsoProjects: [],
      });
    }
  }
  return [...seen.values()];
}

// Every field name the tenant's library has ever carried, active or retired, with
// its effective char_max. Used for ONE column: a detected label with no bracket
// that matches a library field whose char_max is 0 is a label the generator wrote
// bracket-less on purpose (fieldLabel's third form) — a different thing from a
// bold paragraph matching nothing in the library.
//
// EVIDENCE, NOT PROOF, and the direction of the error is worth knowing: documents
// are historical and fields get renamed and deleted, so a label written by a
// generator whose field has since been renamed reads as "not in library" here.
// The unmatched count is therefore an UPPER bound on writer-authored bold text.
async function libraryFields(pool, tenantId) {
  const WITH_OVERRIDE = `SELECT cf.field_name, COALESCE(cf.char_max_override, cf.char_max) AS char_max
                           FROM copy_fields cf JOIN asset_types at ON at.id = cf.asset_type_id
                          WHERE at.tenant_id = $1`;
  const NO_OVERRIDE = `SELECT cf.field_name, cf.char_max
                         FROM copy_fields cf JOIN asset_types at ON at.id = cf.asset_type_id
                        WHERE at.tenant_id = $1`;
  let rows;
  try {
    rows = (await pool.query(WITH_OVERRIDE, [tenantId])).rows;
  } catch (err) {
    if (!isUndefinedColumn(err)) throw err;
    rows = (await pool.query(NO_OVERRIDE, [tenantId])).rows;
  }
  const byName = new Map();
  for (const r of rows) {
    const key = String(r.field_name || '').trim().toLowerCase();
    if (!key) continue;
    const prev = byName.get(key);
    // Keep the widest char_max seen for a name: a name shared across assets with
    // one zero and one non-zero must not report as "always bracket-less".
    byName.set(key, prev == null ? Number(r.char_max) || 0 : Math.max(prev, Number(r.char_max) || 0));
  }
  return byName;
}

// ---------------------------------------------------------------------------
// One document
// ---------------------------------------------------------------------------

// Fetch once, then hand the SAME object to the real reader. The stub is not a
// convenience — it is what makes "one Google call per document" a property of the
// code rather than a promise in a comment, and it fails loudly if getDocContent
// ever reaches for something else.
function stubClients(doc, docId, counter) {
  return {
    docs: {
      documents: {
        get: async ({ documentId }) => {
          counter.calls += 1;
          if (counter.calls > 1) {
            throw new Error(
              `getDocContent called documents.get ${counter.calls}x for ${docId} — this script assumes one read per document.`
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
    // Drive call this throws a TypeError naming the line, which is the report we
    // want rather than a silent extra request.
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

async function measureDocument(dest, clients, entry, library) {
  const doc = await readDoc(clients, entry.docId);

  // The current rule's own answer. `field.label` is documented as the bold
  // paragraph VERBATIM (googleDocs.js:1702) — bracket, unit and all.
  const counter = { calls: 0 };
  const content = await dest.getDocContent(entry.docId, stubClients(doc, entry.docId, counter));
  const readerLabels = [];
  for (const a of content.assets || []) {
    for (const f of a.fields || []) readerLabels.push(f.label);
  }

  // The raw walk, and the check that keeps its copied helpers honest.
  const walk = mirrorWalk(doc);
  const walkLabels = walk.labels.map((l) => l.text);
  const desync =
    walkLabels.length !== readerLabels.length ||
    walkLabels.some((t, i) => t !== readerLabels[i]);

  const labels = walk.labels.map((l) => {
    const nameOnly = l.bracket === 'none' ? l.text : (l.text.match(PARSER_BRACKET) || [null, l.text])[1].trim();
    const libMax = library ? library.get(nameOnly.toLowerCase()) : undefined;
    return {
      ...l,
      docId: entry.docId,
      docTitle: content.title || '',
      docKind: entry.kind,
      tenantId: entry.tenantId,
      projectId: entry.projectId,
      projectName: entry.projectName,
      nameOnly,
      inLibrary: libMax !== undefined,
      libraryCharMax: libMax === undefined ? null : libMax,
    };
  });

  const decorate = (rows) =>
    rows.map((r) => ({
      ...r,
      docId: entry.docId,
      docTitle: content.title || '',
      tenantId: entry.tenantId,
      projectId: entry.projectId,
      projectName: entry.projectName,
    }));

  return {
    title: content.title || '',
    assetCount: (content.assets || []).length,
    labels,
    missedBrackets: decorate(walk.missedBrackets),
    outsideAsset: decorate(walk.outsideAsset),
    desync: desync ? { readerLabels, walkLabels } : null,
  };
}

// ---------------------------------------------------------------------------

const q = (s) => JSON.stringify(s); // verbatim + unambiguous about whitespace
const pad = (s, n) => String(s).padEnd(n);

async function main() {
  const pool = getPool();
  if (!pool) {
    console.error('DATABASE_URL is not set. This script reads the project list from Postgres.');
    process.exit(1);
  }

  const dest = getDestination();
  if (dest.name !== 'google-docs') {
    console.error(`DESTINATION resolves to '${dest.name}', not 'google-docs'. The rule under test is`);
    console.error('the Google Docs parser; refusing to measure a different adapter.');
    process.exit(1);
  }

  // --- tenants ---------------------------------------------------------------
  const census = await tenantCensus(pool);
  const allTenantIds = census.map((r) => r.tenant_id);
  const tenantIds = WANT_TENANTS.length ? WANT_TENANTS : allTenantIds;
  for (const t of WANT_TENANTS) {
    if (!allTenantIds.includes(t)) console.warn(`  WARNING: --tenant=${t} has no projects rows.`);
  }

  rule('TENANTS — discovered from projects, not hardcoded');
  console.log(`  ${pad('tenant', 16)} ${pad('projects', 10)} ${pad('copy docs', 11)} template docs`);
  for (const r of census) {
    const mark = tenantIds.includes(r.tenant_id) ? ' ' : '  (not selected)';
    console.log(
      `  ${pad(r.tenant_id, 16)} ${pad(r.projects, 10)} ${pad(r.copy_docs, 11)} ${pad(r.template_docs, 5)}${mark}`
    );
  }
  if (!INCLUDE_TEMPLATES) {
    console.log('\n  Template documents are EXCLUDED. parseDoc and getDocContent are never pointed');
    console.log('  at one — routes/app.js:633 sends template_doc_id to getProjectTemplateContent →');
    console.log('  readTemplateCells, a different reader with no bold-paragraph rule in it.');
    console.log('  Pass --include-templates to measure them anyway and check that claim.');
  }

  // --- identities ------------------------------------------------------------
  const requested = new Map(); // tenantId -> { id, email }
  for (const raw of WANT_USERS) {
    const u = await resolveUserAnywhere(pool, raw);
    if (requested.has(u.tenantId)) {
      throw new Error(
        `--user=${raw} is user ${u.id} <${u.email}> on tenant ${u.tenantId}, which already has ` +
          `--user ${requested.get(u.tenantId).email}. Two acting users for one tenant is ambiguous; pick one.`
      );
    }
    requested.set(u.tenantId, { id: u.id, email: u.email });
    if (!tenantIds.includes(u.tenantId)) {
      console.warn(`  WARNING: --user=${raw} is on tenant ${u.tenantId}, which is not being walked.`);
    }
  }

  rule('READING AS');
  const clientsByTenant = new Map();
  for (const tenantId of tenantIds) {
    let acting = requested.get(tenantId) || null;
    let how = acting ? '--user' : null;
    if (!acting) {
      const candidates = await googleUsers(pool, tenantId);
      if (candidates.length) {
        acting = { id: candidates[0].id, email: candidates[0].email };
        how = `auto — most recently stored of ${candidates.length} Google credential(s) on this tenant`;
      }
    }
    const ctx = await resolveTenant(tenantId, null, acting && acting.id);
    const realTenantId = (ctx && ctx.tenant && (ctx.tenant.id || ctx.tenant.tenant_id)) || tenantId;
    const actingUserId = (ctx && ctx.user && ctx.user.id) || (acting && acting.id) || null;
    const { source } = await resolveGoogleRefreshToken({ tenantId: realTenantId, userId: actingUserId });

    console.log(`  ${pad(tenantId, 16)} identity: ${source.toUpperCase()}` +
      (acting ? ` — user ${acting.id} <${acting.email}> (${how})` : ''));
    if (source !== 'user') {
      console.log(`  ${pad('', 16)} NOTE: not a per-user credential. ` +
        (source === 'tenant'
          ? 'This is the DEPRECATED tenant-level token; on T0B8LPRDKHR it is dead (invalid_grant).'
          : 'Falling back to the shared env credential.'));
      console.log(`  ${pad('', 16)} Pass --user=<email> for someone on this tenant to read as them.`);
    }
    clientsByTenant.set(tenantId, await getClientsForTenant({ tenantId: realTenantId, userId: actingUserId }));
  }

  // --- walk ------------------------------------------------------------------
  let entries = await documentsFor(pool, tenantIds);
  if (LIMIT) {
    console.log(`\n  --limit=${LIMIT} — walking ${Math.min(LIMIT, entries.length)} of ${entries.length} documents.`);
    console.log('  A limited run is a smoke test. The totals below are NOT the measurement.');
    entries = entries.slice(0, LIMIT);
  }

  const libraries = new Map();
  for (const tenantId of tenantIds) libraries.set(tenantId, await libraryFields(pool, tenantId));

  rule(`WALKING ${entries.length} DOCUMENT(S) — documents.get only, no write of any kind`);

  const allLabels = [];
  const allMissed = [];
  const allOutside = [];
  const failures = [];
  const desyncs = [];
  const perDoc = [];

  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const clients = clientsByTenant.get(e.tenantId);
    const tag = `[${String(i + 1).padStart(3)}/${entries.length}] ${e.tenantId} ${e.docId}`;
    try {
      const m = await measureDocument(dest, clients, e, libraries.get(e.tenantId));
      allLabels.push(...m.labels);
      allMissed.push(...m.missedBrackets);
      allOutside.push(...m.outsideAsset);
      if (m.desync) desyncs.push({ ...e, ...m.desync });
      const noBracket = m.labels.filter((l) => l.bracket === 'none').length;
      perDoc.push({ ...e, title: m.title, assets: m.assetCount, labels: m.labels.length, noBracket, missed: m.missedBrackets.length });
      console.log(
        `${tag}  ${pad(String(m.assetCount) + ' assets', 11)} ${pad(String(m.labels.length) + ' labels', 12)} ` +
          `${pad(String(noBracket) + ' no-bracket', 15)} ${m.missedBrackets.length} missed  ${String(m.title).slice(0, 30)}`
      );
    } catch (err) {
      const msg = (err && err.message) || String(err);
      failures.push({ ...e, error: msg });
      console.log(`${tag}  READ FAILED — ${msg}`);
    }
    if (SLEEP_MS > 0 && i < entries.length - 1) await sleep(SLEEP_MS);
  }

  // --- a desync invalidates the run -----------------------------------------
  if (desyncs.length) {
    rule('MIRROR DESYNC — the local walk disagrees with the real reader. RUN VOID.');
    console.log('  The copies of runStyle/paragraphText in this script no longer reproduce');
    console.log('  getDocContent\'s traversal, so the "bracket but not bold" list below cannot be');
    console.log('  trusted and the label list may be wrong too. Re-sync the copies against');
    console.log('  src/destinations/googleDocs.js before believing any number here.\n');
    for (const d of desyncs) {
      console.log(`  ${d.tenantId} ${d.docId} (project ${d.projectId})`);
      console.log(`    reader: ${JSON.stringify(d.readerLabels)}`);
      console.log(`    walk  : ${JSON.stringify(d.walkLabels)}`);
    }
    process.exit(3);
  }

  // --- totals ----------------------------------------------------------------
  const by = (k) => allLabels.filter((l) => l.bracket === k);
  const generator = by('generator');
  const digits = by('digits');
  const noDigits = by('no_digits');
  const none = by('none');
  const withBracket = generator.length + digits.length + noDigits.length;

  rule('TOTALS');
  console.log(`  documents read successfully : ${perDoc.length}`);
  console.log(`  documents that FAILED to read: ${failures.length}${failures.length ? '  ← see below; these are not zeros' : ''}`);
  console.log(`  paragraphs the current rule treats as a field label : ${allLabels.length}`);
  console.log('');
  console.log(`    WITH a trailing bracket : ${withBracket}`);
  console.log(`      of the generator's exact shape  ("Name [50]" / "Name [40-90]" / "Name [50-125 words]") : ${generator.length}`);
  console.log(`      a trailing bracket with digits, but NOT that shape                                    : ${digits.length}`);
  console.log(`      a trailing bracket with no digits in it                                               : ${noDigits.length}`);
  console.log(`    WITHOUT a trailing bracket : ${none.length}`);
  console.log('');
  console.log(`  bracket-shaped paragraphs that are NOT bold (the rule already misses these) : ${allMissed.length}`);
  if (allOutside.length) {
    console.log(`  bracket-shaped paragraphs above the first asset heading (never a label position, context only) : ${allOutside.length}`);
  }

  const zeroInBracket = generator.filter((l) => /\[0(?:-|\s|\])/.test(l.text));
  if (zeroInBracket.length) {
    console.log(`\n  NOTE: ${zeroInBracket.length} generator-shaped label(s) carry a 0 in the bracket. fieldLabel`);
    console.log('  never writes one (it omits the bracket when charMax is 0), so these were edited.');
  }

  sub('THE NO-BRACKET LABELS, SPLIT BY WHETHER THE LIBRARY KNOWS THE NAME');
  console.log('  fieldLabel writes NO bracket when charMax is 0, so a bracket-less label is not by');
  console.log('  itself evidence of hand-typed bold text. A name the tenant library still carries');
  console.log('  with char_max 0 is a label the generator wrote that way on purpose.');
  console.log('  EVIDENCE, NOT PROOF: documents are historical and fields get renamed, so a');
  console.log('  generated label whose field was later renamed reads as unmatched. The unmatched');
  console.log('  count is an UPPER bound on writer-authored bold text.\n');
  const noneKnownZero = none.filter((l) => l.inLibrary && l.libraryCharMax === 0);
  const noneKnownNonZero = none.filter((l) => l.inLibrary && l.libraryCharMax !== 0);
  const noneUnknown = none.filter((l) => !l.inLibrary);
  console.log(`    name in the library, char_max 0  (generator writes these bracket-less) : ${noneKnownZero.length}`);
  console.log(`    name in the library, char_max > 0 (bracket expected but absent)        : ${noneKnownNonZero.length}`);
  console.log(`    name NOT in the library at all                                         : ${noneUnknown.length}`);

  sub('BOLD RUN CENSUS ACROSS ALL DETECTED LABELS (an observation, not a rule)');
  const allBold = allLabels.filter((l) => l.allBold).length;
  console.log(`    every non-blank run bold : ${allBold}`);
  console.log(`    only some runs bold      : ${allLabels.length - allBold}`);
  console.log('    runStyle reads the FIRST non-blank run only, so the second group are paragraphs');
  console.log('    that merely START bold.');

  // --- per-document ----------------------------------------------------------
  rule('PER DOCUMENT');
  console.log(`  ${pad('tenant', 14)} ${pad('doc id', 46)} ${pad('assets', 7)} ${pad('labels', 7)} ${pad('no-brkt', 8)} missed`);
  for (const d of perDoc) {
    console.log(
      `  ${pad(d.tenantId, 14)} ${pad(d.docId, 46)} ${pad(d.assets, 7)} ${pad(d.labels, 7)} ${pad(d.noBracket, 8)} ${d.missed}` +
        `\n  ${pad('', 14)} project ${d.projectId} ${q(d.projectName)}${d.status ? ` [${d.status}]` : ''} — ${q(d.title)}`
    );
  }

  // --- section A -------------------------------------------------------------
  const showLabel = (l, i) => {
    console.log(`\n  ${i + 1}. ${q(l.text)}`);
    console.log(`     tenant ${l.tenantId}  project ${l.projectId} ${q(l.projectName)}`);
    console.log(`     doc ${l.docId} ${q(l.docTitle)}`);
    console.log(`     under asset heading ${q(l.assetHeading)}`);
    console.log(
      `     bold runs ${l.boldRuns}/${l.totalRuns}${l.allBold ? ' (all)' : ' (partial)'}` +
        `  ·  name as parsed ${q(l.nameOnly)}` +
        `  ·  library: ${l.inLibrary ? `known, char_max ${l.libraryCharMax}` : 'no such field name'}`
    );
  };

  rule(`A — DETECTED LABELS WITH NO TRAILING BRACKET (${none.length})`);
  console.log('  These are what a rule requiring a trailing bracket would stop treating as labels.');
  if (!none.length) console.log('\n  None.');
  none.forEach(showLabel);

  // --- section B -------------------------------------------------------------
  const notExact = [...digits, ...noDigits];
  rule(`B — DETECTED LABELS WITH A BRACKET THAT IS NOT THE GENERATOR'S SHAPE (${notExact.length})`);
  console.log("  A bracket, but not one fieldLabel could have written. Whether a stricter rule");
  console.log('  keeps these depends on whether it matches the generator\'s shape or any bracket —');
  console.log('  they are the gap between those two readings.');
  if (!notExact.length) console.log('\n  None.');
  notExact.forEach(showLabel);

  // --- section C -------------------------------------------------------------
  rule(`C — BRACKET-SHAPED BUT NOT BOLD (${allMissed.length}) — the rule already misses these`);
  console.log('  Paragraphs in a label position carrying a trailing bracket whose first non-blank');
  console.log('  run is not bold. "Taken as" is what the current reader did with each instead.');
  if (!allMissed.length) console.log('\n  None.');
  allMissed.forEach((m, i) => {
    console.log(`\n  ${i + 1}. ${q(m.text)}`);
    console.log(`     tenant ${m.tenantId}  project ${m.projectId} ${q(m.projectName)}`);
    console.log(`     doc ${m.docId} ${q(m.docTitle)}`);
    console.log(`     under asset heading ${q(m.assetHeading)}`);
    console.log(`     bracket: ${m.bracket}  ·  italic: ${m.italic}  ·  style: ${m.named || 'NORMAL_TEXT'}  ·  taken as: ${m.takenAs}`);
  });

  if (allOutside.length) {
    rule(`C2 — BRACKET-SHAPED ABOVE THE FIRST ASSET HEADING (${allOutside.length}) — context only`);
    console.log('  Not a label position under the current rule or any stricter one — the reader');
    console.log('  drops these at `if (!current) continue`. Listed so they are accounted for.');
    allOutside.forEach((m, i) => {
      console.log(`\n  ${i + 1}. ${q(m.text)}  [tenant ${m.tenantId}, doc ${m.docId}, bold ${m.bold}, style ${m.named || 'NORMAL_TEXT'}]`);
    });
  }

  // --- failures --------------------------------------------------------------
  if (failures.length) {
    rule(`DOCUMENTS THAT COULD NOT BE READ (${failures.length}) — NOT counted as zero`);
    console.log('  Every count above is over the documents that were read. These were not, so the');
    console.log('  totals are a measurement of a SMALLER population than the one that exists.\n');
    for (const f of failures) {
      console.log(`  ${f.tenantId} ${f.docId} — project ${f.projectId} ${q(f.projectName)}`);
      console.log(`    ${f.error}`);
    }
  }

  if (JSON_OUT) {
    const fs = require('fs');
    const out = {
      generatedAt: new Date().toISOString(),
      tenants: tenantIds,
      includeTemplates: INCLUDE_TEMPLATES,
      limit: LIMIT || null,
      totals: {
        documentsRead: perDoc.length,
        documentsFailed: failures.length,
        labels: allLabels.length,
        generator: generator.length,
        bracketDigitsNotGenerator: digits.length,
        bracketNoDigits: noDigits.length,
        noBracket: none.length,
        missedBrackets: allMissed.length,
      },
      perDoc, labels: allLabels, missedBrackets: allMissed, outsideAsset: allOutside, failures,
    };
    fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify(out, null, 2));
    console.log(`\n  Full structured result written to ${path.resolve(JSON_OUT)}`);
  }

  console.log('\nDone. Nothing was written to any document or to Postgres.');
  if (failures.length) {
    console.log('Exiting non-zero: a document that could not be read is an error, not a zero.');
    process.exit(2);
  }
  process.exit(0);
}

// The pure halves are exported so the mirror walk and the shape tests can be
// driven against a synthetic document with no credentials and no network — which
// is how the walk was checked against the real getDocContent before this script
// was ever pointed at production. Guarded by require.main so importing the file
// cannot start a Drive-reading run.
module.exports = {
  bracketClass,
  mirrorWalk,
  runStyle,
  paragraphText,
  boldCensus,
  GENERATOR_SHAPE,
  PARSER_BRACKET,
};

if (require.main === module) {
  main().catch((err) => {
    const data = (err && err.response && err.response.data) || {};
    if (String(data.error || '') === 'invalid_grant' || /invalid_grant/i.test(String((err && err.message) || ''))) {
      console.error('\nINVALID_GRANT — the refresh token used is dead.');
      console.error('Re-run with --user=<id|email> for someone on that tenant to use a per-user');
      console.error('credential. scripts/verifyReviewComments.js --list names every user holding one.');
      process.exit(2);
    }
    console.error('\nAUDIT FAILED:', (err && err.message) || err);
    console.error('\nNeeds real credentials and a database. Run it in the Railway console.');
    process.exit(1);
  });
}
