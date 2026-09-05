'use strict';

// September 2026 — the marketing email subject-line ceiling, 130 → 70.
//
// Moves already-seeded tenants onto the value src/data/defaultAssets.js now holds.
// Eight (asset, field) pairs: Subject Line 1 and Subject Line 2 on Demand Gen
// Nurture Email, Event Invitation Email, Event Reminder Email and Event Follow-Up
// / Recap Email. On the two production tenants that is 16 rows.
//
// SALES BASHO EMAIL DOES NOT MOVE, and this file refuses to run if it would —
// twice, once against the seed and once against the resolved row set. See THE
// ASYMMETRY below for why that is a decision rather than a scope note.
//
// ─── WHERE 130 CAME FROM ────────────────────────────────────────────────────
// scripts/migrateSpecIntegrityFixes.js, the SUBJECT_BANDS table. Verbatim:
//
//     They all shared 50–75, which is one band pretending to fit two jobs. Cold
//     B2B outreach performs best at roughly 2–4 words, so a Basho subject caps at
//     40; opt-in nurture and event mail keep earning clicks well past 130
//     characters, so those cap at 130.
//
// No citation, no date, no page. Nothing else in the tree records an origin, and
// git cannot go further back — the visible history is 51 commits and 130 first
// appears at the root commit, so `git log -S` finds only that. This is as far as
// the provenance goes, and the answer is that there is none.
//
// ─── THAT IS THE SAME FILE, THE SAME COMMIT AND THE SAME METHOD ─────────────
// migrateSpecIntegrityFixes.js is the migration that produced EVERY WRONG META
// NUMBER IN THE LIBRARY. Its stated purpose was correcting numbers that "did not
// match the platforms' own published specs", and it corrected Meta without ever
// fetching Meta: it wrote a card headline of 40 where Meta's page says 20, took a
// correct 18 and made it 20, and asserted a 30 that appears on no Meta page at
// all. Every cell was reasoned, internally consistent, peer-reviewable and wrong.
// That incident is why CLAUDE.md's most expensive rule exists — fetch the page,
// paste the text, in the same change.
//
// Its Meta entries were STRIPPED rather than corrected (a superseded migration's
// tables are writes, and leaving them would silently revert the fix on a re-run),
// and its header carries the correction saying so. A smoke test asserts
// CHAR_FIXES.length === 15 with no facebook.com anywhere in it.
//
// THE SUBJECT-LINE HALF OF THAT FILE WAS NEVER REVISITED. It was produced by the
// same hand in the same pass by the same method, and it has been standing ever
// since. This migration is the second half of a correction that was left
// unfinished.
//
// ─── THE ASYMMETRY, AND WHY BASHO SURVIVES IT ───────────────────────────────
// Both numbers came out of that one paragraph. Only one shows its work:
//
//   40   "cold B2B outreach performs best at roughly 2–4 words" — a stated
//        derivation. Two to four words is about 40 characters. The reasoning is
//        checkable even though the page behind it is not named, and it agrees
//        with the Gong finding already cited on that asset's Body Copy.
//   130  "keep earning clicks well past 130 characters" — an assertion with
//        nothing behind it. It does not derive 130 from anything; it restates it.
//
// So this change corrects the number that showed no work and leaves the one that
// did. Flattening both to 70 was considered and declined: it would have collapsed
// the `cold` class's subject band onto `marketing`, leaving EMAIL_CLASSES holding
// a distinction it no longer expressed, and it would have overwritten the one
// argued decision in that block on no better evidence than the argument it was
// replacing. The classes still differ, by 30 rather than 90.
//
// ─── WHY 130 WAS WRONG ──────────────────────────────────────────────────────
// The field permitted 130 characters while its own note said the inbox cuts at
// 40:
//
//     Mobile inboxes cut around 40 characters — front-load the first 40. (Litmus)
//
// Ninety characters a writer was allowed to write that no reader on a phone would
// ever see. A technical maximum standing where a working range belonged — the
// same shape as LinkedIn Intro Text seeded at 600 and corrected to 150, and the
// same shape as the LinkedIn carousel 600 that turned out to appear on no page.
//
// 70 leaves room for a subject that reads fully on desktop while keeping the field
// close enough to the truncation point that the bracket itself argues for brevity.
//
// ─── 70 IS NOT A FETCH AND MUST NOT PRETEND TO BE ───────────────────────────
// These ten fields are spec_type 'house_default' on the 'quillio_default'
// sentinel. NO PLATFORM PUBLISHES A SUBJECT-LINE LIMIT — email clients truncate
// for display rather than enforcing at send, so there is no page to fetch and no
// publisher to cite. 70 is Kyle's judgement as the writer of this library.
//
// Therefore this migration writes char_max AND NOTHING ELSE. It does not add a
// spec_source, does not stamp spec_verified_at, does not change spec_type, and
// does not touch char_min. A house number that acquired a citation would be the
// migrateSpecIntegrityFixes defect with a fresh coat on: a value that looks
// authoritative because it is in the shape of an authority.
//
// It also does not touch char_min_override / char_max_override / spec_note_override.
// A tenant who set their own subject ceiling keeps it — the reads resolve
// COALESCE(override, base) and this writes the base, which is exactly what the
// override columns exist for.
//
// ─── THE NOTE STAYS, DELIBERATELY ───────────────────────────────────────────
// EMAIL_SUBJECT_NOTE is unchanged, and that is a decision rather than an omission.
// It reads BETTER at 70 than it did at 130: the 40 now sits inside the bracket's
// range rather than far below it, so it reads as a target within a real span
// instead of a warning about a ceiling twice its size. And rewording it toward the
// imperative is a MEASURED regression — PINTEREST_TITLE_NOTE in
// src/data/defaultAssets.js records turning a statement of consequence into a
// front-load instruction taking WITHIN-40 from 3/10 to 0/10 and collapsing spread
// from 64 to 13. This note is already the statement form.
//
// ─── WHAT THIS DOES NOT TOUCH ───────────────────────────────────────────────
//   • Sales Basho Email, on either field. Refused twice.
//   • Preheader, on any asset. Its char_min of 85 against a note saying 35–40
//     renders is a separate decision and is not this change's to take.
//   • char_min on the subject lines. It is 0 and stays 0 — 40 is where mobile
//     truncates, not a floor a writer must reach.
//   • Every non-email asset. Campaign Landing Page / Hero Subheadline also holds
//     130 and is matched by neither the asset list nor the field list here.
//   • spec_watch_list. No citation moved, so affected_fields is unaffected and
//     scripts/rederiveAffectedFields.js is NOT part of this change.
//
// ─── SEED === MIGRATION, CHECKED RATHER THAN ASSERTED ───────────────────────
// checkSeedAgreement() runs BEFORE DATABASE_URL is read. It requires that the seed
// already holds 70/0 on all eight pairs, that their tier and source are untouched,
// that Sales Basho Email still holds 40, and that this file's asset list is
// exactly the set of email assets the seed puts at 70 — so a fifth marketing asset
// added later fails the check rather than being silently skipped. A mismatch is a
// refusal, not a warning.
//
// GUARDED ON THE VALUE BEING REPLACED, per CLAUDE.md's house rule for any
// migration that writes a spec value: only rows still holding exactly char_max 130
// and char_min 0 are written. Anything else is printed and skipped, so a row some
// other migration already moved is not blindly taken back.
//
// IDEMPOTENT: a second run finds every row at 70, writes nothing, reports 0 changed.
//
// DRY RUN BY DEFAULT — applies inside a transaction and ROLLBACKs. --commit writes.
//
// Run in the Railway console as plain node — NEVER `railway run`:
//   node scripts/migrateEmailSubjectCeiling.js            # dry run
//   node scripts/migrateEmailSubjectCeiling.js --commit   # write

const TAG = '[email-subject-ceiling]';
const COMMIT = process.argv.includes('--commit');

const { DEFAULT_ASSETS } = require('../src/data/defaultAssets');

// The value being replaced, and the value replacing it. Both literals: this SETS a
// number rather than stripping or deriving one, so the new value is written down
// here and checked against the seed rather than read out of it at run time.
const OLD_MAX = 130;
const NEW_MAX = 70;
// The floor, asserted on both sides and never written. A row whose char_min is not
// 0 is not in the state this migration was written against.
const EXPECT_MIN = 0;

// The four assets in the `marketing` email class. Byte-identical to
// EMAIL_CLASSES.marketing.assets in src/data/defaultAssets.js; checkSeedAgreement
// proves it below rather than trusting this comment.
const ASSETS = [
  'Demand Gen Nurture Email',
  'Event Invitation Email',
  'Event Reminder Email',
  'Event Follow-Up / Recap Email',
];

// The class-governed subject fields. Preheader is class-governed too and is
// deliberately absent — see WHAT THIS DOES NOT TOUCH.
const FIELDS = ['Subject Line 1', 'Subject Line 2'];

// The asset that must NOT move, named as data so the refusal can print it.
const EXCLUDED_ASSET = 'Sales Basho Email';
const EXCLUDED_MAX = 40;

// The tier and source these fields carry, asserted unchanged on both sides. A
// subject line has no publisher; if either of these has moved, something outside
// this change has given a house number a claim it should not have.
const EXPECT_SPEC_TYPE = 'house_default';
const EXPECT_SPEC_SOURCE = 'quillio_default';

// ─── THE REFUSAL ────────────────────────────────────────────────────────────
// Runs before DATABASE_URL. Checks the property this file's correctness rests on:
// a tenant seeded from defaultAssets.js today and a tenant migrated by this script
// hold the same number, tier and source.
function checkSeedAgreement() {
  const problems = [];

  const seedField = (assetName, fieldName) => {
    const a = DEFAULT_ASSETS.find((x) => x.name === assetName);
    if (!a) return { missing: `no asset "${assetName}" in DEFAULT_ASSETS — renamed, or the name here is wrong` };
    const f = (a.fields || []).find((x) => x.field_name === fieldName);
    if (!f) return { missing: `"${assetName}" has no field "${fieldName}"` };
    return { field: f };
  };

  for (const asset of ASSETS) {
    for (const fieldName of FIELDS) {
      const { field, missing } = seedField(asset, fieldName);
      if (missing) {
        problems.push(missing);
        continue;
      }
      if (field.char_max !== NEW_MAX) {
        problems.push(
          `${asset}/${fieldName}: the seed holds char_max ${field.char_max}, this file writes ${NEW_MAX}. `
          + 'The seed half of this change has not landed (or has moved again), so a newly seeded tenant '
          + 'and a migrated tenant would hold different ceilings.'
        );
      }
      if (field.char_min !== EXPECT_MIN) {
        problems.push(
          `${asset}/${fieldName}: the seed holds char_min ${field.char_min}, expected ${EXPECT_MIN}. `
          + 'A floor on a subject line is a separate decision and this migration does not write one.'
        );
      }
      if (field.spec_type !== EXPECT_SPEC_TYPE) {
        problems.push(
          `${asset}/${fieldName}: the seed tier is "${field.spec_type}", expected "${EXPECT_SPEC_TYPE}". `
          + 'This migration writes a HOUSE number and must not run against a field that has acquired a tier.'
        );
      }
      if (field.spec_source !== EXPECT_SPEC_SOURCE) {
        problems.push(
          `${asset}/${fieldName}: the seed cites "${field.spec_source}", expected the `
          + `"${EXPECT_SPEC_SOURCE}" sentinel. 70 is a house judgement and this field now claims a source.`
        );
      }
    }
  }

  // SALES BASHO MUST STILL BE AT 40. If the seed has flattened it, the decision
  // this file is built on has been reversed somewhere else and the header is lying.
  for (const fieldName of FIELDS) {
    const { field, missing } = seedField(EXCLUDED_ASSET, fieldName);
    if (missing) {
      problems.push(`${missing} — the excluded asset must exist for its exclusion to mean anything`);
      continue;
    }
    if (field.char_max !== EXCLUDED_MAX) {
      problems.push(
        `${EXCLUDED_ASSET}/${fieldName}: the seed holds char_max ${field.char_max}, expected `
        + `${EXCLUDED_MAX}. This migration's whole argument is that the cold class does NOT move; `
        + 'if the seed has moved it, that decision was taken elsewhere and this file is stale.'
      );
    }
  }

  // THE ASSET LIST IS THE SET, NOT A SUBSET. Every email asset the seed puts at
  // NEW_MAX must be in ASSETS, so a fifth marketing asset added later fails here
  // rather than being silently left behind at 130 in every migrated tenant.
  const seedAtNew = [];
  for (const a of DEFAULT_ASSETS) {
    for (const f of a.fields || []) {
      if (FIELDS.includes(f.field_name) && f.char_max === NEW_MAX) {
        if (!seedAtNew.includes(a.name)) seedAtNew.push(a.name);
      }
    }
  }
  for (const name of seedAtNew) {
    if (!ASSETS.includes(name)) {
      problems.push(
        `"${name}" carries a subject line at ${NEW_MAX} in the seed but is not in this file's ASSETS. `
        + 'A migrated tenant would keep the old ceiling on it. Add it here, or explain the exclusion.'
      );
    }
  }

  return problems.length ? { ok: false, problems } : { ok: true, problems: [], pairs: ASSETS.length * FIELDS.length };
}

// A unix-socket connection is local by construction and never speaks SSL.
function sslFor(url) {
  if (/host=%2F|host=\//.test(url)) return false;
  if (/localhost|127\.0\.0\.1|sslmode=disable/.test(url)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  // THE SEED CHECK RUNS FIRST, before DATABASE_URL is even read. A file whose
  // numbers disagree with the seed has nothing safe to say to a database.
  const agree = checkSeedAgreement();
  if (!agree.ok) {
    console.error(`\n${TAG} REFUSING: seed and migration would produce different rows.`);
    for (const p of agree.problems) console.error(`      • ${p}`);
    process.exit(1);
  }
  console.log(`${TAG} seed agreement: OK for all ${agree.pairs} (asset, field) pair(s)`);
  console.log(`${TAG} ${EXCLUDED_ASSET} confirmed still at ${EXCLUDED_MAX} in the seed — it does not move`);
  console.log(`${TAG} writing char_max ${OLD_MAX} -> ${NEW_MAX}; char_min, spec_type, spec_source, `
    + 'spec_verified_at and every override column are NOT written');

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(`${TAG} DATABASE_URL not set — nothing to do.`);
    process.exit(1);
  }
  let Client;
  try {
    ({ Client } = require('pg'));
  } catch (err) {
    console.error(`${TAG} could not load "pg" — is it installed? ${err.message}`);
    process.exit(1);
  }

  const client = new Client({ connectionString, ssl: sslFor(connectionString) });
  await client.connect();
  console.log(`\n${TAG} mode: ${COMMIT ? 'COMMIT (writes)' : 'DRY RUN (rolls back — pass --commit to write)'}`);

  // So a failure BEFORE the transaction opens does not print a rollback that never
  // happened.
  let inTxn = false;
  try {
    await client.query('BEGIN');
    inTxn = true;

    // ─── THE SECOND BASHO REFUSAL, against the DATABASE rather than the seed ──
    // ASSETS cannot reach Sales Basho Email today, because the write below matches
    // on that list by name. This asks the question anyway, of the rows themselves,
    // so that editing ASSETS can never quietly acquire it — the refusal is not
    // meant to be true by construction of a list somebody can change.
    const bashoReach = await client.query(
      `SELECT at.tenant_id, cf.field_name, cf.char_max
         FROM copy_fields cf
         JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE at.name = ANY($1::text[])
          AND cf.field_name = ANY($2::text[])
          AND at.name = $3
        ORDER BY at.tenant_id, cf.field_name`,
      [ASSETS, FIELDS, EXCLUDED_ASSET]
    );
    if (bashoReach.rowCount > 0) {
      throw new Error(
        `${EXCLUDED_ASSET} is reachable by this migration's asset list — ${bashoReach.rowCount} row(s) `
        + 'would be written. The cold class does not move; see THE ASYMMETRY in the header.'
      );
    }
    console.log(`${TAG} ${EXCLUDED_ASSET} unreachable by the resolved asset list — 0 row(s) at risk`);

    let written = 0;
    let already = 0;
    let skipped = 0;

    for (const asset of ASSETS) {
      console.log(`\n${'─'.repeat(74)}\n${asset}\n${'─'.repeat(74)}`);

      // READ FIRST, ROW BY ROW. Cross-tenant by name, the same match
      // services/specReview.js uses. Read rather than blind-updated because THE OLD
      // VALUE HAS TO BE PRINTED BEFORE IT IS REPLACED, and the dry run is the only
      // place it can be seen before that happens.
      const rows = await client.query(
        `SELECT cf.id, at.tenant_id, cf.field_name, cf.char_min, cf.char_max,
                cf.spec_type, cf.spec_source, cf.spec_verified_at,
                cf.char_min_override, cf.char_max_override
           FROM copy_fields cf
           JOIN asset_types at ON at.id = cf.asset_type_id
          WHERE at.name = $1
            AND cf.field_name = ANY($2::text[])
          ORDER BY at.tenant_id, cf.field_name`,
        [asset, FIELDS]
      );
      if (rows.rowCount === 0) {
        console.log(`${TAG}   no tenant has this asset — nothing to write`);
        continue;
      }

      for (const row of rows.rows) {
        const where = `${row.tenant_id}  ${row.field_name}`;
        const ovr = row.char_max_override != null ? `  [tenant override ${row.char_max_override} — unaffected]` : '';

        if (Number(row.char_max) === NEW_MAX) {
          already += 1;
          console.log(`${TAG}   ${where}  already ${NEW_MAX} — skipped${ovr}`);
          continue;
        }

        // GUARDED ON THE VALUE BEING REPLACED. A row holding anything other than
        // exactly OLD_MAX/EXPECT_MIN is not the row this migration was written
        // against — it may be one another migration moved, and a blind rewrite
        // would silently take that back.
        if (Number(row.char_max) !== OLD_MAX || Number(row.char_min) !== EXPECT_MIN) {
          skipped += 1;
          console.log(
            `${TAG}   ${where}  SKIPPED — holds char_min ${row.char_min} / char_max ${row.char_max}, `
            + `expected ${EXPECT_MIN} / ${OLD_MAX}${ovr}`
          );
          continue;
        }
        // A tier or source that has moved means this is no longer a house number,
        // and this migration has no business writing it.
        if (row.spec_type !== EXPECT_SPEC_TYPE || row.spec_source !== EXPECT_SPEC_SOURCE) {
          skipped += 1;
          console.log(
            `${TAG}   ${where}  SKIPPED — tier "${row.spec_type}" / source "${row.spec_source}", `
            + `expected "${EXPECT_SPEC_TYPE}" / "${EXPECT_SPEC_SOURCE}"${ovr}`
          );
          continue;
        }

        written += 1;
        console.log(`${TAG}   ${where}  OLD char_max ${row.char_max}  ->  NEW ${NEW_MAX}`
          + `   (char_min ${row.char_min} unchanged, tier ${row.spec_type}, `
          + `verified_at ${row.spec_verified_at === null ? 'NULL' : String(row.spec_verified_at)} unchanged)${ovr}`);

        // BY ROW ID, not by name. The read above resolved which rows, so the write
        // cannot reach one the read did not see. char_max ONLY — every other column
        // on this row is left exactly as it is.
        await client.query('UPDATE copy_fields SET char_max = $2 WHERE id = $1', [row.id, NEW_MAX]);
      }
    }

    // Read the outcome back rather than trusting rowCounts, and read BASHO back in
    // the same query so the report states what did not move as well as what did.
    console.log(`\n${'─'.repeat(74)}\nAFTER\n${'─'.repeat(74)}`);
    const after = await client.query(
      `SELECT at.name AS asset, cf.field_name, cf.char_min, cf.char_max,
              cf.spec_type, cf.spec_source,
              COUNT(*)::int AS tenants,
              COUNT(*) FILTER (WHERE cf.spec_verified_at IS NOT NULL)::int AS verified
         FROM copy_fields cf
         JOIN asset_types at ON at.id = cf.asset_type_id
        WHERE at.name = ANY($1::text[])
          AND cf.field_name = ANY($2::text[])
        GROUP BY 1,2,3,4,5,6
        ORDER BY 1,2`,
      [ASSETS.concat([EXCLUDED_ASSET]), FIELDS]
    );
    for (const r of after.rows) {
      const mark = r.asset === EXCLUDED_ASSET ? '  <- cold class, unchanged' : '';
      console.log(
        `${TAG}   ${String(r.asset).padEnd(30)} ${String(r.field_name).padEnd(15)} `
        + `[${r.char_min}-${r.char_max}]  x${r.tenants}  ${r.spec_type} / ${r.spec_source}  `
        + `verified_at set on ${r.verified}${mark}`
      );
    }

    console.log(`\n${'═'.repeat(74)}`);
    console.log(`${TAG} ${written} row(s) written · ${already} already at ${NEW_MAX} · ${skipped} skipped`);
    console.log(`${'═'.repeat(74)}`);
    console.log(`${TAG} Expected on a first run against two tenants: 16 written, 0 already, 0 skipped.`);
    console.log(`${TAG} READ THE OLD VALUES ABOVE BEFORE COMMITTING.`);
    console.log(`${TAG} No spec_type, spec_source or spec_verified_at was written. No override column`);
    console.log(`${TAG} was written. No Preheader row was read. ${EXCLUDED_ASSET} did not move.`);
    console.log(`${TAG} No watch row was touched — affected_fields is unaffected and`);
    console.log(`${TAG} scripts/rederiveAffectedFields.js is NOT part of this change.`);

    if (COMMIT) {
      await client.query('COMMIT');
      inTxn = false;
      console.log(`\n${TAG} COMMITTED.`);
      console.log(`${TAG} Documents already built keep the old bracket: these fields are`);
      console.log(`${TAG} house_default, and services/specSweep.js corrects 'enforced' only.`);
      console.log(`${TAG} That is deliberate — a house number is not a platform's to correct.`);
    } else {
      await client.query('ROLLBACK');
      inTxn = false;
      console.log(`\n${TAG} DRY RUN — rolled back. Pass --commit to write.`);
    }
  } catch (err) {
    if (inTxn) await client.query('ROLLBACK').catch(() => {});
    console.error(`\n${TAG} FAILED${inTxn ? ' (rolled back)' : ' (before any transaction opened)'}: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} ${err.message}`);
    process.exit(1);
  });
}

// Required by smoke tests. Guarded above so requiring this file runs nothing.
module.exports = {
  ASSETS,
  FIELDS,
  OLD_MAX,
  NEW_MAX,
  EXPECT_MIN,
  EXCLUDED_ASSET,
  EXCLUDED_MAX,
  EXPECT_SPEC_TYPE,
  EXPECT_SPEC_SOURCE,
  checkSeedAgreement,
};
