'use strict';

// Cite the cold-outreach body band. Sales Basho Email / Body Copy keeps its 50–100
// words and moves from an uncited 'house_default' to 'recommended', citing Gong.
//
// The NUMBER does not change. This migration only changes what the doc CLAIMS about
// where it came from — which is the whole point, because an uncited number renders
// no tier line at all and therefore asserts nothing.
//
// WHY IT WAS UNCITED UNTIL NOW. The previous pass left it house_default because no
// Gong page could be verified: every gong.io URL returns HTTP 403 to that
// environment's fetcher, and the sample sizes in circulation (25M / 28M / 85M)
// attach to different Gong studies. The specific page and its exact wording were
// supplied afterwards, so the claim now has a page behind it.
//
// THE TIER LINE NAMES THE MEASURED OUTCOME, and states NO sample size:
//
//   "Recommended by Gong (cold outreach reply rates, not marketing clicks).
//    Drops sharply past 100 words."
//
//   • No sample size, because the cited page does not give one. Quoting 28M — or
//     any of the other figures floating around — would be attributing a number to
//     a page that does not contain it, which is the failure mode this library has
//     spent several passes correcting.
//   • "not marketing clicks" is not padding. The other research citation in the
//     library (Constant Contact, on Demand Gen / Offer Body 1) is a CLICK rate on
//     opted-in marketing email. Two length numbers, two different outcomes, two
//     different audiences. A writer who carries one across to the other's asset has
//     applied a real number to the wrong job, and the scope clause is what stops
//     that being an easy mistake.
//
// THE spec_note SCOPES IT TO THE FIRST TOUCH. Gong's number is about the opener —
// earning a reply from someone who did not ask to hear from you. Gong's guidance
// for follow-ups in the same sequence runs longer, so without the note the band
// reads as a rule for every email in the sequence, which is not what was measured.
//
// SCOPE: every tenant, matched by (asset_types.name, copy_fields.field_name) — the
// same cross-tenant, match-by-name pattern services/specReview.js uses.
//
// IDEMPOTENT: the statement is conditioned on the row not already holding these
// values, so a second run reports 0 changed and writes nothing.
//
// DRY RUN BY DEFAULT — runs inside a transaction and ROLLBACKs. Pass --commit.
//
// Run in the Railway console (plain node — never `railway run`):
//   node scripts/migrateCiteColdEmailBand.js            # dry run
//   node scripts/migrateCiteColdEmailBand.js --commit   # write
//
// SEQUENCING: run AFTER scripts/migrateEmailBodyWordCounts.js, which is what makes
// this field a WORD range in the first place. This migration does not set
// field_type, so on a tenant that skipped that one it would leave a 50–100 range
// still typed as characters — rendering "[50-100]" and read by the drafter, the
// reviewer and the writer as 100 characters. Ordering is checked below rather than
// left to the operator: it refuses to run if the field is not already 'words'.

const TAG = '[migrate-cite-cold-email]';
const COMMIT = process.argv.includes('--commit');

const ASSET = 'Sales Basho Email';
const FIELD = 'Body Copy';

// Kept BYTE-IDENTICAL to BASHO_BODY_NOTE in src/data/defaultAssets.js; a smoke test
// asserts it.
const BASHO_BODY_NOTE =
  "Applies to the FIRST touch; Gong's guidance for follow-ups in the same sequence runs longer.";

const SOURCE_URL =
  'https://www.gong.io/blog/do-execs-really-reply-to-cold-email-here-s-what-the-data-says';

// The band is UNCHANGED — restated here so the UPDATE is a complete description of
// the row's intended state rather than a partial patch onto whatever is there.
const BAND = [50, 100];

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

    // ORDERING GUARD. This migration cites a WORD band; if the field is still typed
    // as characters, migrateEmailBodyWordCounts has not run and citing now would
    // publish "[50-100]" as a character limit with Gong's name attached to it.
    // Refuse rather than write something wrong and correct-looking.
    const units = await client.query(
      `SELECT DISTINCT COALESCE(cf.field_type, '(null)') AS t
         FROM copy_fields cf JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE at.name = $1 AND cf.field_name = $2`,
      [ASSET, FIELD]
    );
    if (units.rowCount === 0) {
      throw new Error(`no "${ASSET} / ${FIELD}" rows found — is the library seeded?`);
    }
    const wrong = units.rows.filter((r) => r.t !== 'words').map((r) => r.t);
    if (wrong.length > 0) {
      throw new Error(
        `"${ASSET} / ${FIELD}" is field_type ${wrong.join(', ')}, not 'words'. ` +
          'Run scripts/migrateEmailBodyWordCounts.js first — citing a word band on a ' +
          'character-typed field would render "[50-100]" as a character limit.'
      );
    }

    // Band, tier, source and note in ONE statement, so a row can never hold the
    // citation without the note that scopes it to the first touch.
    const r = await client.query(
      `UPDATE copy_fields cf
          SET char_min = $3, char_max = $4, spec_type = 'recommended',
              spec_source = $5, spec_note = $6
         FROM asset_types at
        WHERE cf.asset_type_id = at.id
          AND at.name = $1 AND cf.field_name = $2
          AND (cf.char_min IS DISTINCT FROM $3
               OR cf.char_max IS DISTINCT FROM $4
               OR cf.spec_type IS DISTINCT FROM 'recommended'
               OR cf.spec_source IS DISTINCT FROM $5
               OR cf.spec_note IS DISTINCT FROM $6)`,
      [ASSET, FIELD, BAND[0], BAND[1], SOURCE_URL, BASHO_BODY_NOTE]
    );
    console.log(
      `${TAG} cited ${ASSET} / ${FIELD} → [${BAND[0]}-${BAND[1]} words] recommended ${SOURCE_URL}: ${r.rowCount} row(s)`
    );

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

module.exports = { ASSET, FIELD, BAND, SOURCE_URL, BASHO_BODY_NOTE };
