'use strict';

// Email body copy moves from CHARACTER limits to WORD ranges, and the five email
// assets' asset_direction is trimmed of the craft that now lives in craft.md once.
//
// WHY THE UNIT MATTERS. Characters are the right unit where truncation is literal:
// a subject line, an ad headline and a preheader are all cut at a real character
// position, so a character count IS the constraint. Body copy has no truncation
// point. What it has is an attention budget, and every study of that budget
// measures it in words — Boomerang's analysis of 40M emails puts 50–125 words at
// the highest response rate, 75–100 as the sweet spot, and emails past 200 words
// below 40%. Rendering "[500]" on a body field asked the writer to count the one
// thing nobody measures.
//
// The unit is USER-VISIBLE and it is LOAD-BEARING. copy_fields.field_type becomes
// 'words', which makes the doc label render "Offer Body 1 [50-125 words]" instead
// of "[500]" — and that label is the only place the unit survives, because nothing
// about a field is persisted (CLAUDE.md: "No persisted doc state"). Every later
// draft, regenerate and review re-parses the Doc, reads the unit back out of the
// bracket, and tells Gemini to count words. Change the label format and the unit
// is lost.
//
// WHAT IT DOES
//   1. WORD_FIELDS — six email body fields get field_type 'words' plus a word
//      range, by email type:
//        marketing / nurture  50–125   opt-in, branded, aiming for a CLICK
//        cold outreach        50–100   plain text, 1:1 feel, aiming for a REPLY
//        follow-up            25–75    the reader already decided; reinforce or recap
//   2. DIRECTIONS — the five email assets' asset_direction is trimmed to what is
//      genuinely asset-specific. One ask per email, proof before pitch, specific
//      over general, the wall of text / over-apologizer / multi-ask failure modes,
//      and cold-vs-marketing are now in craft.md's Email and Sales sections, which
//      load for EVERY asset. Restating them per asset spent prompt tokens saying
//      the same thing five times, and let the five copies drift.
//
// WHAT IT DELIBERATELY DOES NOT TOUCH
//   Subject lines, preheaders, headlines, CTAs and every ad field stay in
//   characters — their limits are literal truncation points. Non-email long-form
//   (Event Landing Page body, One-Pager, Direct Mail Insert body) also stays in
//   characters for now: the same argument probably applies to them, but the
//   research quoted above is about EMAIL response rates specifically, and none of
//   those assets has a comparable published number. Worth revisiting with data
//   rather than by analogy.
//
// SCOPE: every tenant, matched by (asset_types.name, copy_fields.field_name) — the
// same cross-tenant, match-by-name pattern services/specReview.js uses.
//
// IDEMPOTENT: every statement is conditioned on the row not already holding the new
// value, so a second run reports 0 changed and writes nothing.
//
// DRY RUN BY DEFAULT — runs inside a transaction and ROLLBACKs, printing exactly
// what it would change. Pass --commit to write.
//
// Run in the Railway console (plain node — never `railway run`):
//   node scripts/migrateEmailBodyWordCounts.js            # dry run
//   node scripts/migrateEmailBodyWordCounts.js --commit   # write
//
// SEQUENCING: safe in either order relative to the deploy. src/data/defaultAssets.js
// seeds these same values byte-identically, so a tenant seeded after the deploy is
// already correct and this migration finds nothing to do for it.
//
// ONE ORDERING NOTE: a doc BUILT BEFORE this runs carries "[500]" in its label and
// will keep being drafted and reviewed in characters, because the doc is the source
// of truth for its own fields. That is correct — the doc's own spec should not
// change under a writer mid-project. New docs get word ranges.

const TAG = '[migrate-email-words]';
const COMMIT = process.argv.includes('--commit');

// --- 1. Body fields → word ranges ---------------------------------------------
// [assetName, fieldName, minWords, maxWords]. Kept BYTE-IDENTICAL to WORD_FIELDS +
// the RAW rows in src/data/defaultAssets.js; a smoke test asserts both directions.
const WORD_FIELDS = [
  // Marketing / nurture, 50–125 words.
  ['Demand Gen Nurture Email', 'Offer Body 1', 50, 125],
  ['Demand Gen Nurture Email', 'Offer Body 2', 50, 125],
  // An invitation is making a case to attend — it is marketing, not a reminder.
  ['Event Invitation Email', 'Event Description', 50, 125],
  // Cold outreach, 50–100 words.
  ['Sales Basho Email', 'Body Copy', 50, 100],
  // Follow-up, 25–75 words. The reader already decided; these reinforce or recap.
  ['Event Reminder Email', 'Body Copy', 25, 75],
  ['Event Follow-Up / Recap Email', 'Body Copy', 25, 75],
];

// --- 2. Trimmed asset_direction -----------------------------------------------
// [assetName, newDirection]. Kept BYTE-IDENTICAL to DIRECTIONS in
// src/data/defaultAssets.js.
//
// What came out, and where it went:
//   • "No clickbait", "Earn the click"            → craft.md § Email
//   • "One clear ask"                             → craft.md § Email (one ask per email)
//   • "Short sentences and short paragraphs"      → craft.md § Email (structure)
//   • "Write as a human, not a brand", "No marketing speak",
//     "Feels like it came from a real person, not a campaign"
//                                                 → craft.md § Sales (cold vs marketing)
// Sales Basho keeps ONE line, because "Dear [First Name]" is the only thing in its
// old direction that is a house convention rather than general craft.
const DIRECTIONS = [
  ['Demand Gen Nurture Email', 'Curiosity or tension in the subject — they are mid-sequence, not meeting you.'],
  ['Event Invitation Email', 'Make the value of attending undeniable. Date and CTA above the fold.'],
  ['Event Reminder Email', 'Urgency without panic. They already said yes — reinforce, do not re-sell.'],
  ['Event Follow-Up / Recap Email', 'Gratitude first, value second, next step third.'],
  ['Sales Basho Email', 'Open with Dear [First Name].'],
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

    // --- 1. Unit + range, in one statement per field so a partial state is
    //        impossible: a row can never end up with a word RANGE still typed as
    //        characters, which would render "[50-125]" and be read as 125 chars.
    let converted = 0;
    for (const [asset, field, min, max] of WORD_FIELDS) {
      const r = await client.query(
        `UPDATE copy_fields cf
            SET field_type = 'words', char_min = $3, char_max = $4
           FROM asset_types at
          WHERE cf.asset_type_id = at.id
            AND at.name = $1 AND cf.field_name = $2
            AND (cf.field_type IS DISTINCT FROM 'words'
                 OR cf.char_min IS DISTINCT FROM $3
                 OR cf.char_max IS DISTINCT FROM $4)`,
        [asset, field, min, max]
      );
      if (r.rowCount) console.log(`${TAG}   ${asset} / ${field} → [${min}-${max} words]: ${r.rowCount} row(s)`);
      converted += r.rowCount;
    }
    console.log(`${TAG} converted ${converted} body field(s) to word ranges`);

    // --- 2. Trimmed directions.
    let directions = 0;
    for (const [asset, direction] of DIRECTIONS) {
      const r = await client.query(
        `UPDATE asset_types
            SET asset_direction = $2
          WHERE name = $1
            AND asset_direction IS DISTINCT FROM $2`,
        [asset, direction]
      );
      if (r.rowCount) console.log(`${TAG}   direction ${asset}: ${r.rowCount} row(s)`);
      directions += r.rowCount;
    }
    console.log(`${TAG} trimmed ${directions} asset_direction value(s)`);

    // Post-state: what the unit split looks like across the whole library.
    const after = await client.query(
      `SELECT COALESCE(field_type, '(null)') AS t, COUNT(*)::int AS n
         FROM copy_fields GROUP BY 1 ORDER BY 1`
    );
    console.log(`${TAG} copy_fields by field_type after:`);
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

module.exports = { WORD_FIELDS, DIRECTIONS };
