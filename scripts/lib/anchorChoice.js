'use strict';

// Anchor selection for the spec-watch migrations — the logic four files carried
// a copy of each.
//
// WHAT LIVES HERE: the mechanics that are the same whatever page is being
// watched — how a candidate is measured against the text, how the section span
// is located, how candidates are ranked, why a loser lost, and the sole-witness
// arithmetic.
//
// WHAT DOES NOT, AND MUST NOT: QUOTES, SECTION and CANDIDATES. Those are the
// per-page EVIDENCE — the sentences somebody read on a specific page on a
// specific day, and the strings proposed for that page with the reasoning for
// each. Moving them here would put four pages' evidence in one file with nothing
// tying any of it to the page it came from, which is the opposite of what the
// quote rule is for.
//
// ─── WHY IT WAS EXTRACTED ───────────────────────────────────────────────────
// Flagged twice: once when the third copy appeared, and again when the
// whole-number counting defect (scripts/lib/wholeNumber.js) had to be fixed in
// all four files at once. Four copies of one decision is four places for the
// next fix to be applied in three.
//
// ─── THE ONE DIFFERENCE THAT IS KEPT, AND WHY IT IS A PARAMETER ────────────
// The four files did NOT all rank candidates the same way, and the difference is
// deliberate rather than drift:
//
//   POLICY.NO_STORED_LIMIT   scripts/migrateFixXAnchor.js. A candidate is
//   (the older rule)         "clean" when it holds no value THIS ROW STORES.
//                            Eligibility is unique + in-section, so a
//                            digit-bearing candidate can still be SELECTED —
//                            option 2 — with its cost printed.
//
//   POLICY.DIGIT_FREE        the three later files. "Clean" means the candidate
//   (the better rule)        contains NO DIGIT AT ALL, and that is a
//                            PRECONDITION of eligibility, so option 2 cannot be
//                            selected at all.
//
// DIGIT_FREE IS STRICTLY STRONGER and it is why those three dodged the
// whole-number bug entirely: their eligibility ran off a /\d+/ match rather than
// off `holds`, so a substring mis-report could not change what they chose. Only
// X's `clean` was load-bearing on `holds`, and X is the file where that bug had
// teeth.
//
// SO WHY NOT DELETE THE OLD RULE AND HARMONISE X UP? Because the four
// migrations have all RUN, and a shared module that silently re-ranks a
// committed row is a refactor that changes production behaviour while claiming
// not to. Measured against a page shaped like X's real one, X's chosen anchor
// ("of your posts beyond your followers to your desired target audience") is
// itself digit-free, so the CHOICE would not move today — but the REJECTION
// REASONS would (its second candidate would report CONTAINS DIGITS rather than
// ranked-below), and what a future re-run would do if X's page changed would
// move with it. That is a decision for whoever owns that row, not a side effect
// of tidying.
//
// THE PARAMETER HAS NO DEFAULT, AND THAT IS THE POINT. A default is exactly the
// mechanism by which a new file would silently inherit a rule nobody chose for
// it — which is the harmonisation this parameter exists to prevent, arriving
// through the back door. Omitting it throws. Fail closed on the axis that
// carries authority, the same shape as db/assets.js TENANT_EDITABLE_TIERS.
//
// FOR A NEW ROW, USE POLICY.DIGIT_FREE. X is the only caller of the older rule
// and should stay the only one; if it is ever migrated across, that is its own
// change with its own before/after.

const { hasWholeNumber } = require('./wholeNumber');

const POLICY = {
  DIGIT_FREE: 'digit-free',
  NO_STORED_LIMIT: 'holds-no-stored-limit',
};

// --- measuring a needle against the text -----------------------------------
// count() and occurrences() are the GUARDED versions the three later files
// carried. scripts/migrateFixXAnchor.js had them without the empty-needle
// guards; adopting the guarded form cannot change its behaviour, because every
// needle it passes is a non-empty literal — asserted by a test rather than
// assumed.

function count(hay, needle) {
  if (!needle) return 0;
  return String(hay).split(needle).length - 1;
}

// Every occurrence of a needle, as a character offset and as a percentage of the
// document. The percentage is what makes "five times" legible: five hits spread
// from 3% to 88% is a heading repeated per section.
function occurrences(hay, needle) {
  const out = [];
  if (!needle) return out;
  let i = String(hay).indexOf(needle);
  while (i >= 0) {
    out.push({ at: i, pct: hay.length ? Math.round((i / hay.length) * 1000) / 10 : 0 });
    i = String(hay).indexOf(needle, i + needle.length);
  }
  return out;
}

function hasDigit(s) {
  return /\d/.test(String(s));
}

// THE SECTION SPAN — [start, end) of the block that publishes the fields a row
// watches, located by two markers.
//
// The `!section.from || !section.to` half of the guard came from the three later
// files; X had only `!section`. Same reasoning as count(): X's SECTION is a
// literal carrying both, so the stronger guard cannot change its answer.
function sectionSpan(text, section) {
  if (!section || !section.from || !section.to) return null;
  const start = text.indexOf(section.from);
  if (start < 0) return null;
  const end = text.indexOf(section.to, start);
  if (end < 0) return null;
  return { start, end: end + section.to.length };
}

// --- why a loser lost -------------------------------------------------------
// The strings are identical across the four files except for ONE clause, which
// is per-page prose rather than logic: the sentence explaining why a clean,
// unique, OUT-OF-SECTION candidate is refused anyway. LinkedIn's two files add
// "on a page this size uniqueness is nearly free" because on a 40k-character
// page that is the fact a reader needs. That clause is passed in.
const OUT_OF_SECTION_CLEAN_DEFAULT =
  'OUT OF SECTION — clean and unique, and REFUSED anyway: it proves a page rendered, not '
  + 'that the watched section did';

function rejectionReason(c, span, chosen, opts) {
  const outOfSectionClean = (opts && opts.outOfSectionClean) || OUT_OF_SECTION_CLEAN_DEFAULT;
  // refusedByDesign is checked FIRST and unconditionally. X's candidates carry
  // no such flag (0 occurrences in that file), so including the branch cannot
  // change its output — its "refused by design" candidate is refused by the
  // section test instead, and says so.
  if (c.refusedByDesign) return 'REFUSED BY DESIGN — recorded here to be shown losing, never eligible';
  if (c.count === 0) return 'ABSENT — an anchor that never matches reports `failed` every week';
  if (!c.unique) return `${c.count}x — not unique, so it says nothing about WHICH section rendered`;
  if (!span) return 'NO SECTION SPAN — the markers are not on this page, so nothing is in-section';
  if (!c.inSection) return c.clean ? outOfSectionClean : 'OUT OF SECTION';
  // THE DIGITS BRANCH IS REACHED ONLY UNDER DIGIT_FREE, because only that policy
  // computes `digits`. Under NO_STORED_LIMIT `c.digits` is undefined and the
  // branch is skipped, which is what preserves X's wording exactly.
  if (c.digits && c.digits.length) {
    return `in-section and unique, but CONTAINS DIGITS (${c.digits.join(', ')})`
      + `${c.holds.length ? ` including stored limit(s) ${c.holds.join(', ')}` : ''}`
      + ' — a number in an anchor turns a spec revision into a broken-page report';
  }
  if (chosen && chosen.clean && !c.clean) {
    // X names the values, because under its policy this is the option-2 case and
    // WHICH limit is held is the whole cost. Under DIGIT_FREE the digits branch
    // above has already said so, so this is the plain ranked-below sentence.
    return c.holds && c.holds.length && !c.digits
      ? `in-section, holds ${c.holds.join(', ')} — a clean in-section candidate ranked above it`
      : 'a clean in-section candidate ranked above it';
  }
  return 'in-section and eligible — a candidate ranked above it';
}

// --- the choice -------------------------------------------------------------
// Pure, so a test drives the same code the migration does.
//
// `holds` uses hasWholeNumber, NOT a substring test: an anchor containing "1280"
// does not hold 280. That was the defect fixed across all four copies, and
// having one copy is why the next one will be fixed once.
function chooseAnchor(text, candidates, limits, section, opts) {
  const policy = opts && opts.policy;
  if (policy !== POLICY.DIGIT_FREE && policy !== POLICY.NO_STORED_LIMIT) {
    throw new Error(
      `anchorChoice: opts.policy must be POLICY.DIGIT_FREE or POLICY.NO_STORED_LIMIT, got `
      + `${JSON.stringify(policy)}. There is deliberately no default — a default is how a new row `
      + 'would inherit a ranking rule nobody chose for it. Use POLICY.DIGIT_FREE unless you are '
      + 'scripts/migrateFixXAnchor.js.'
    );
  }
  const digitFree = policy === POLICY.DIGIT_FREE;
  const span = sectionSpan(text, section);
  const seen = candidates.map((c) => {
    const n = count(text, c.text);
    const at = text.indexOf(c.text);
    const holds = limits.filter((v) => hasWholeNumber(c.text, v));
    const unique = n === 1;
    const inSection = !!span && at >= 0 && at >= span.start && at + c.text.length <= span.end;
    const base = { ...c, count: n, at, holds, unique, inSection };
    if (!digitFree) {
      return { ...base, clean: unique && holds.length === 0, eligible: unique && inSection };
    }
    const digits = String(c.text).match(/\d+/g) || [];
    return {
      ...base,
      pct: text.length && at >= 0 ? Math.round((at / text.length) * 1000) / 10 : null,
      digits,
      clean: unique && digits.length === 0,
      eligible: !c.refusedByDesign && unique && inSection && digits.length === 0,
    };
  });
  // Under DIGIT_FREE eligibility already requires clean, so the two-step find
  // collapses to one; kept as one expression so both policies read the same.
  const chosen = seen.find((c) => c.eligible && c.clean) || seen.find((c) => c.eligible) || null;
  for (const c of seen) {
    c.reason = c === chosen ? null : rejectionReason(c, span, chosen, opts);
  }
  const tier = !chosen ? null
    : digitFree ? '1 — clean (digit-free) and in-section'
      : chosen.clean ? '1 — clean and in-section'
        : `2 — in-section, HOLDS ${chosen.holds.join(', ')}`;
  return { chosen, seen, span, tier };
}

// --- the stored limits ------------------------------------------------------
// Byte-identical in all four files before extraction.
//
// UNNEST OF TWO PARALLEL ARRAYS, joined as a set — NOT a multidimensional ANY.
// `(at.name, cf.field_name) = ANY($1::text[][])` does not work: the elements of
// a text[][] are TEXT SCALARS, not sub-arrays, so the comparison is record = text
// and Postgres answers `operator does not exist: record = text`.
const LIMITS_SQL = `
  SELECT at.name AS asset, cf.field_name AS field, cf.char_min, cf.char_max, cf.spec_type
    FROM unnest($1::text[], $2::text[]) AS want(asset, field)
    JOIN asset_types at ON at.name = want.asset AND at.is_active
    JOIN copy_fields cf ON cf.asset_type_id = at.id AND cf.field_name = want.field
   ORDER BY at.name, cf.field_name`;

// `runner` is anything with .query(text, params) — the client here, a stub there.
async function resolveStoredLimits(runner, pairs) {
  const list = Array.isArray(pairs) ? pairs : [];
  const res = await runner.query(LIMITS_SQL, [
    list.map((p) => p.asset),
    list.map((p) => p.field),
  ]);
  const rows = (res && res.rows) || [];
  // char_max 0 is NO LIMIT everywhere else in this codebase, so it is not a
  // value an anchor could hold and does not belong in the arithmetic.
  const limits = [...new Set(rows.map((r) => String(r.char_max)).filter((v) => v && v !== '0'))]
    .sort((x, y) => Number(x) - Number(y));
  return { rows, limits };
}

// --- the sole-witness arithmetic -------------------------------------------
// DATA ONLY. Each migration prints its own commentary, because the sentence that
// matters differs per row — Google's is about being the only page publishing a
// display limit, LinkedIn's is about 70 and 150 being round numbers X and Meta
// happen to share. That prose is an argument about a specific platform and does
// not generalise; the counting does.
//
// A FIFTH COPY OF THE SUBSTRING DEFECT LIVED HERE, in all four files, and was
// missed when the other four were fixed: `String(r.watch_anchor).includes(v)`
// decides whether another row's anchor "holds" this value, and therefore whether
// this row is reported as the SOLE WITNESS. It is hasWholeNumber now.
//
// NO BEHAVIOUR CHANGE FOR THE FOUR, measured rather than asserted: only two
// seeded anchors carry digits at all, and neither produces a disagreement for
// any limit those four rows store. The hazard was real for others — that Meta
// anchor's "1440 x 1800" contains 18, 40 and 80 as substrings, and all three are
// stored limits elsewhere in the library, so a future Meta anchor migration
// would have been told it was not the sole witness when it was.
const SOLE_WITNESS_SQL = `
  SELECT cf.spec_source,
         COUNT(*)::int AS fields,
         MAX(w.id) AS watch_id,
         MAX(w.expected_content) AS watch_anchor
    FROM copy_fields cf
    LEFT JOIN spec_watch_list w ON w.source_url = cf.spec_source
   WHERE cf.char_max = $1
   GROUP BY cf.spec_source
   ORDER BY 2 DESC`;

// Returns [{ value, rows, others, sole }] — one entry per limit, in the order
// given. `rows` is the raw grouping so the caller can print it; `others` is the
// count of OTHER watched rows that would report a move on this value; `sole` is
// the verdict.
async function soleWitnessData(client, rowId, limits) {
  const out = [];
  for (const v of limits) {
    const res = await client.query(SOLE_WITNESS_SQL, [Number(v)]);
    const rows = (res && res.rows) || [];
    const others = rows.filter((r) => r.watch_id && r.watch_id !== rowId
      && !(r.watch_anchor && hasWholeNumber(r.watch_anchor, v)));
    out.push({
      value: v,
      rows,
      totalFields: rows.reduce((n, r) => n + r.fields, 0),
      others: others.length,
      sole: others.length === 0,
    });
  }
  return out;
}

// The shared half of the printing: the header, the per-source lines and the
// verdict. The commentary that follows a non-sole verdict is the caller's.
function printSoleWitness(entry, rowId, log = console.log) {
  log(`\n   ${entry.value} is stored by ${entry.totalFields} copy_fields row(s):`);
  for (const r of entry.rows) {
    const watched = r.watch_id ? `watch #${r.watch_id}` : 'NOT WATCHED';
    const holds = r.watch_anchor && hasWholeNumber(r.watch_anchor, entry.value)
      ? '  <- its anchor HOLDS this value' : '';
    const self = r.watch_id === rowId ? '  (this row)' : '';
    log(`      x${String(r.fields).padStart(3)}  ${watched.padEnd(14)} ${r.spec_source}${self}${holds}`);
  }
  log(`      => ${entry.sole
    ? 'NO other watched row would report a move on this value. THIS ROW IS THE SOLE WITNESS.'
    : `${entry.others} other watched row(s) would also report a move on this VALUE.`}`);
}

function soleWitnessHeader(log = console.log) {
  log(`\n${'─'.repeat(74)}\nSOLE WITNESS — who else would see a move on each stored limit\n${'─'.repeat(74)}`);
}

module.exports = {
  POLICY,
  count,
  occurrences,
  hasDigit,
  sectionSpan,
  rejectionReason,
  chooseAnchor,
  LIMITS_SQL,
  resolveStoredLimits,
  SOLE_WITNESS_SQL,
  soleWitnessData,
  printSoleWitness,
  soleWitnessHeader,
  OUT_OF_SECTION_CLEAN_DEFAULT,
};
