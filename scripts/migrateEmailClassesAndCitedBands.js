'use strict';

// Two changes to the same email rows, in one migration because splitting them would
// mean two passes over the same fields.
//
// 1. EMAIL CLASSES. The subject and preheader bands are now derived from a single
//    EMAIL_CLASSES constant in src/data/defaultAssets.js rather than repeated on
//    each of the five email assets. This migration writes the SAME values those
//    assets already hold — it exists so a tenant whose rows drifted (or who was
//    seeded before the earlier corrections) converges on the class, and so the
//    class has a migration to point at. Expect 0 changed rows on a current tenant.
//
//    The class governs INBOX-FACING fields only: subject line, preheader, CTA
//    count. Body length is deliberately NOT derived from it — see the constant.
//
// 2. CITED BODY BAND. Demand Gen Nurture / Offer Body 1 becomes 50–200 words,
//    tiered 'recommended', citing Constant Contact. That page reports ~20 lines of
//    text — about 200 words — as the highest click-through length.
//
//    The tier line names the POPULATION, not just the source: "Recommended by
//    Constant Contact (2.1M customers, small-business campaigns). Longer bodies
//    click less." Small-business campaign data is not B2B nurture data, and a
//    writer deciding whether to apply the number needs to know that before they
//    trust it. 2.1 million CUSTOMERS, not emails — a per-customer figure says
//    nothing about how many campaigns are behind it.
//
// WHAT STAYS UNCITED, AND WHY
//   • Offer Body 2 (25–60 words) — no source measured a secondary offer block.
//   • Event Invitation / Reminder / Follow-Up bodies — nobody measured these.
//   • Sales Basho / Body Copy (50–100 words) — Gong is widely reported as finding
//     100 words or fewer and 3–4 sentences produce the highest reply rates, but no
//     Gong page could be verified from here: every gong.io URL returns HTTP 403 to
//     this environment's fetcher. Reported figures also disagree on the sample
//     (25M / 28M / 85M appear in different write-ups). Rather than cite a page
//     nobody has read, the band stays 'house_default' and uncited. The number is
//     unchanged either way — only the claim about where it comes from is withheld.
//
// SCOPE: every tenant, matched by (asset_types.name, copy_fields.field_name) — the
// same cross-tenant, match-by-name pattern services/specReview.js uses.
//
// IDEMPOTENT: every statement is conditioned on the row not already holding the new
// value, so a second run reports 0 changed and writes nothing.
//
// DRY RUN BY DEFAULT — runs inside a transaction and ROLLBACKs. Pass --commit.
//
// Run in the Railway console (plain node — never `railway run`):
//   node scripts/migrateEmailClassesAndCitedBands.js            # dry run
//   node scripts/migrateEmailClassesAndCitedBands.js --commit   # write

const TAG = '[migrate-email-classes]';
const COMMIT = process.argv.includes('--commit');

// --- 1. Email classes ---------------------------------------------------------
// Kept BYTE-IDENTICAL to EMAIL_CLASSES in src/data/defaultAssets.js; a smoke test
// asserts both directions. The shape is duplicated rather than imported because a
// migration must keep working against the schema it was written for, even after
// the seed moves on — that is the whole point of having both.
const EMAIL_CLASSES = {
  marketing: {
    subject: [0, 130],
    preheader: [85, 100],
    assets: [
      'Demand Gen Nurture Email',
      'Event Invitation Email',
      'Event Reminder Email',
      'Event Follow-Up / Recap Email',
    ],
  },
  cold: {
    subject: [0, 40],
    preheader: [85, 100],
    assets: ['Sales Basho Email'],
  },
};

// Expand the classes into the [asset, field, min, max] rows to write.
const CLASS_FIELDS = [];
for (const cls of Object.values(EMAIL_CLASSES)) {
  for (const asset of cls.assets) {
    CLASS_FIELDS.push([asset, 'Subject Line 1', cls.subject[0], cls.subject[1]]);
    CLASS_FIELDS.push([asset, 'Subject Line 2', cls.subject[0], cls.subject[1]]);
    CLASS_FIELDS.push([asset, 'Preheader', cls.preheader[0], cls.preheader[1]]);
  }
}

// --- 2. The cited body band ---------------------------------------------------
// [asset, field, minWords, maxWords, specType, specSource].
const CITED_BANDS = [
  [
    'Demand Gen Nurture Email',
    'Offer Body 1',
    50,
    200,
    'recommended',
    'https://www.constantcontact.com/blog/best-length-email-newsletter/',
  ],
];

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
    ssl: { rejectUnauthorized: false },
  });

  console.log(`${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  try {
    await client.connect();
    await client.query('BEGIN');

    // --- 1. Converge the inbox-facing fields on their class.
    let classRows = 0;
    for (const [asset, field, min, max] of CLASS_FIELDS) {
      const r = await client.query(
        `UPDATE copy_fields cf
            SET char_min = $3, char_max = $4
           FROM asset_types at
          WHERE cf.asset_type_id = at.id
            AND at.name = $1 AND cf.field_name = $2
            AND (cf.char_min IS DISTINCT FROM $3 OR cf.char_max IS DISTINCT FROM $4)`,
        [asset, field, min, max]
      );
      if (r.rowCount) console.log(`${TAG}   class ${asset} / ${field} → [${min}-${max}]: ${r.rowCount} row(s)`);
      classRows += r.rowCount;
    }
    console.log(`${TAG} converged ${classRows} inbox-facing field(s) on their class (0 expected on a current tenant)`);

    // --- 2. The cited band, its tier and its source, in ONE statement so a row can
    //        never end up with the new band and the old tier — which would render a
    //        200-word ceiling with no indication of where it came from.
    let cited = 0;
    for (const [asset, field, min, max, tier, source] of CITED_BANDS) {
      const r = await client.query(
        `UPDATE copy_fields cf
            SET char_min = $3, char_max = $4, spec_type = $5, spec_source = $6
           FROM asset_types at
          WHERE cf.asset_type_id = at.id
            AND at.name = $1 AND cf.field_name = $2
            AND (cf.char_min IS DISTINCT FROM $3
                 OR cf.char_max IS DISTINCT FROM $4
                 OR cf.spec_type IS DISTINCT FROM $5
                 OR cf.spec_source IS DISTINCT FROM $6)`,
        [asset, field, min, max, tier, source]
      );
      if (r.rowCount) {
        console.log(`${TAG}   cite ${asset} / ${field} → [${min}-${max} words] ${tier} ${source}: ${r.rowCount} row(s)`);
      }
      cited += r.rowCount;
    }
    console.log(`${TAG} cited ${cited} body band(s)`);

    const after = await client.query(
      `SELECT COALESCE(spec_type, '(null)') AS t, COUNT(*)::int AS n
         FROM copy_fields GROUP BY 1 ORDER BY 1`
    );
    console.log(`${TAG} copy_fields by spec_type after:`);
    for (const row of after.rows) console.log(`${TAG}   ${row.t}: ${row.n}`);

    if (COMMIT) {
      await client.query('COMMIT');
      console.log(`${TAG} COMMITTED`);
    } else {
      await client.query('ROLLBACK');
      console.log(`${TAG} ROLLED BACK (dry run) — no changes were written. Re-run with --commit to apply.`);
    }
    console.log(`${TAG} done`);
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`${TAG} FAILED: ${err.message}`);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

// Run only when invoked directly. Requiring this module (the smoke test does, to
// prove the seed and the migration agree) must NOT connect to a database.
if (require.main === module) {
  main();
}

module.exports = { EMAIL_CLASSES, CLASS_FIELDS, CITED_BANDS };
