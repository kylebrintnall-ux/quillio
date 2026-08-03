'use strict';

// Migration — UNIQUE INDEX on document template names, per tenant, plus the
// CROSS-NAMESPACE collision report (document templates, rework step four).
//
//   doc_templates (tenant_id, normalized name)
//
// WHY NOW. Step four makes a template a first-class thing a brief NAMES. Until
// this commit a template name was never matched against anything — it was
// picked from a list in Settings by its id — so two templates called the same
// thing were untidy but harmless. The moment a brief resolves a name to a
// template, two rows answering to one name means the brief silently gets
// whichever the query returned first, and which one that is depends on nothing
// a person can see.
//
// FUNCTIONAL, NOT RAW-TEXT — the same reasoning as
// scripts/migrateAddAssetUniqueness.js, and the same helper. The lookup folds
// names with src/utils/normalize.js, so a raw-text UNIQUE would accept exactly
// the duplicates that break it: "Form & Confirmation" and "form &  confirmation"
// are two rows to raw text and ONE template to the parse. This reuses
// quillio_normalize_name(text) — CREATE OR REPLACE, byte-identical to the
// definition in the asset migration, so running either first is fine and running
// both is idempotent.
//
// THE SECOND CHECK HAS NO INDEX. An asset type and a document template can also
// collide with EACH OTHER — "Form and Confirmation Page" as an asset and
// "Form & Confirmation Page" as a template are one string to a brief, and they
// are different deliverables. No unique index can span two tables, so
// core/pipeline.js assertNoNameCollision refuses at parse time. This script
// REPORTS those pairs so they can be renamed before anyone hits the refusal in
// the middle of a brief; it does not and cannot enforce them.
//
// REPORTS BEFORE IT ENFORCES. Dry run (the default) lists every conflict, per
// tenant, with both rows. --commit refuses outright if a WITHIN-TABLE conflict
// exists — it does not auto-resolve, because which template survives is a
// judgement about a tenant's data this script has no basis to make. A
// cross-namespace pair is reported but does NOT refuse: the index does not
// depend on it, and the parse-time check already covers it safely.
// Everything runs in ONE transaction, so a refusal leaves nothing behind.
//
//   node scripts/migrateAddTemplateUniqueness.js            # dry run — writes nothing
//   node scripts/migrateAddTemplateUniqueness.js --commit   # create the index
//
// Run it in the Railway console as plain `node` (never `railway run node …`).

const TAG = '[template-uniqueness]';
const COMMIT = process.argv.includes('--commit');

// --- The normalizer, as SQL --------------------------------------------------
//
// BYTE-IDENTICAL to scripts/migrateAddAssetUniqueness.js. Two migrations
// defining quillio_normalize_name differently would be worse than either one
// alone: whichever ran last would silently redefine the function the other's
// index was built on, and a functional index whose function changed underneath
// it is corrupt without saying so. A smoke test asserts the two files agree
// character for character.
const WS = '\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
const DASH = '\\u2010-\\u2015\\u2212';

const NORMALIZE_SQL = `
  btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(coalesce($1, '')), '[${DASH}]', '-', 'g'),
        '[${WS}]*-[${WS}]*', '-', 'g'),
      '[${WS}]+', ' ', 'g'),
    ' ')`;

const CREATE_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION quillio_normalize_name(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$ SELECT${NORMALIZE_SQL} $fn$`;

// coalesce() on tenant_id for the same reason the asset index has it: the column
// is NULLABLE and a unique index treats NULLs as DISTINCT, so without the
// sentinel two orphan templates sharing a name slip through. '' is not a
// reachable tenants.id.
const INDEX = {
  name: 'doc_templates_tenant_name_norm_uniq',
  sql: `CREATE UNIQUE INDEX IF NOT EXISTS doc_templates_tenant_name_norm_uniq
          ON doc_templates (coalesce(tenant_id, ''), quillio_normalize_name(name))`,
};

// Duplicate template names within one tenant, under the normalized form.
const TEMPLATE_CONFLICT_SQL = `
  SELECT coalesce(dt.tenant_id, '(null tenant)') AS tenant_id,
         quillio_normalize_name(dt.name)         AS normalized,
         count(*)                                AS n,
         json_agg(json_build_object(
           'id', dt.id, 'name', dt.name, 'source_doc_id', dt.source_doc_id,
           'created_at', dt.created_at) ORDER BY dt.id) AS rows
    FROM doc_templates dt
   GROUP BY coalesce(dt.tenant_id, ''), coalesce(dt.tenant_id, '(null tenant)'),
            quillio_normalize_name(dt.name)
  HAVING count(*) > 1
   ORDER BY 1, 2`;

// A template name and an asset name that fold to the same string, in one tenant.
// Reported, never enforced — no index spans two tables, and the parse-time check
// in core/pipeline.js assertNoNameCollision is what actually refuses.
const CROSS_CONFLICT_SQL = `
  SELECT coalesce(dt.tenant_id, '(null tenant)') AS tenant_id,
         quillio_normalize_name(dt.name)         AS normalized,
         dt.id                                   AS template_id,
         dt.name                                 AS template_name,
         at.id                                   AS asset_id,
         at.name                                 AS asset_name,
         at.is_active                            AS asset_active
    FROM doc_templates dt
    JOIN asset_types at
      ON coalesce(at.tenant_id, '') = coalesce(dt.tenant_id, '')
     AND quillio_normalize_name(at.name) = quillio_normalize_name(dt.name)
   ORDER BY 1, 2`;

function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

function reportTemplateConflicts(groups) {
  console.log(`\n${TAG} doc_templates — ${groups.length} conflicting name(s):`);
  for (const g of groups) {
    console.log(`\n  tenant ${g.tenant_id} · normalizes to "${g.normalized}" · ${g.n} rows`);
    for (const r of g.rows) {
      console.log(
        `    id=${r.id}  name=${JSON.stringify(r.name)}  source_doc_id=${r.source_doc_id || '(none)'}  created=${r.created_at}`
      );
    }
  }
}

function reportCrossConflicts(rows) {
  console.log(
    `\n${TAG} CROSS-NAMESPACE — ${rows.length} name(s) claimed by BOTH a template and an asset type:`
  );
  for (const r of rows) {
    console.log(`\n  tenant ${r.tenant_id} · both normalize to "${r.normalized}"`);
    console.log(`    template   id=${r.template_id}  name=${JSON.stringify(r.template_name)}`);
    console.log(`    asset type id=${r.asset_id}  name=${JSON.stringify(r.asset_name)}  active=${r.asset_active}`);
  }
  console.log(
    `\n${TAG} These are NOT blocked by the index — no index spans two tables. A brief naming`
  );
  console.log(`${TAG} one of them is refused at parse time (assertNoNameCollision) rather than`);
  console.log(`${TAG} guessing, so nothing builds wrong; but every brief naming it fails until`);
  console.log(`${TAG} one side is renamed in Settings.`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error(`${TAG} DATABASE_URL is not set in this environment.`);
    process.exit(1);
  }

  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error(`${TAG} could not load "pg" — is it installed? ${err.message}`);
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: sslFor(process.env.DATABASE_URL),
  });

  let refused = false;
  try {
    await client.connect();
    console.log(
      `${TAG} mode: ${COMMIT ? 'COMMIT (creates the index)' : 'DRY RUN (rolls back — pass --commit to apply)'}`
    );

    // One transaction, helper function included, so a dry run leaves no trace
    // and a refusal leaves no half-built index.
    await client.query('BEGIN');

    const reg = await client.query('SELECT to_regclass($1) AS oid', ['doc_templates']);
    if (!reg.rows[0].oid) {
      throw new Error('table "doc_templates" does not exist — run scripts/migrateAddDocTemplates.js first');
    }
    const assetsReg = await client.query('SELECT to_regclass($1) AS oid', ['asset_types']);

    await client.query(CREATE_FUNCTION_SQL);
    console.log(`${TAG} defined quillio_normalize_name(text) (IMMUTABLE)`);

    const counts = await client.query(
      "SELECT count(*)::int AS n, count(DISTINCT coalesce(tenant_id, ''))::int AS tenants FROM doc_templates"
    );
    console.log(
      `${TAG} scanning ${counts.rows[0].n} doc_templates row(s) across ${counts.rows[0].tenants} tenant(s)`
    );

    const conflicts = (await client.query(TEMPLATE_CONFLICT_SQL)).rows;
    // The cross check needs asset_types; skip rather than fail on a database
    // that somehow has one table and not the other.
    const cross = assetsReg.rows[0].oid ? (await client.query(CROSS_CONFLICT_SQL)).rows : [];

    const nulls = await client.query('SELECT count(*)::int AS n FROM doc_templates WHERE tenant_id IS NULL');
    if (nulls.rows[0].n > 0) {
      console.log(
        `\n${TAG} NOTE: ${nulls.rows[0].n} doc_templates row(s) with NULL tenant_id. ` +
          'The index groups these under a sentinel so they constrain each other.'
      );
    }

    if (conflicts.length) reportTemplateConflicts(conflicts);
    if (cross.length) reportCrossConflicts(cross);
    if (conflicts.length === 0 && cross.length === 0) {
      console.log(`\n${TAG} no conflicts — every template name is unique, and none collides with an asset type.`);
    }

    if (conflicts.length > 0) {
      console.error(
        `\n${TAG} REFUSING TO CREATE THE INDEX — ${conflicts.length} duplicate name(s) above must be resolved by hand.` +
          '\n' + TAG + ' Nothing was written. Rename or delete one of each pair in Settings, then re-run.'
      );
      await client.query('ROLLBACK');
      refused = true;
    } else if (!COMMIT) {
      console.log(`${TAG} DRY RUN — rolling back. Re-run with --commit to create:`);
      console.log(`${TAG}   ${INDEX.name}`);
      await client.query('ROLLBACK');
    } else {
      await client.query(INDEX.sql);
      console.log(`${TAG} created index ${INDEX.name}`);
      await client.query('COMMIT');
      console.log(`${TAG} COMMITTED — template names are now unique per tenant under the normalized form.`);
      if (cross.length) {
        console.log(
          `${TAG} The ${cross.length} cross-namespace name(s) above are still live. Rename one side of each.`
        );
      }
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`${TAG} FAILED (rolled back, nothing changed): ${err.message}`);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
  process.exit(refused ? 2 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { NORMALIZE_SQL, CREATE_FUNCTION_SQL, INDEX, WS, DASH };
