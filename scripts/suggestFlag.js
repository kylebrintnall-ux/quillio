'use strict';

// Ops helper (LiveSpecs chunk 3b) — print what the extractor SUGGESTS for a
// flag, so it can be eyeballed from the Railway console instead of the browser.
// READ-ONLY: calls getSuggestions, which never writes copy_fields or anything
// else. Requires DATABASE_URL (and GEMINI_API_KEY for the extraction pass).
//
// Run: railway run node scripts/suggestFlag.js [flagId]   (flagId defaults to 1)

const { getSuggestions } = require('../src/services/specReview');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[suggest-flag] DATABASE_URL not set — nothing to do.');
    process.exit(1);
  }

  const flagId = process.argv[2] || '1';
  console.log(`[suggest-flag] reading source page + extracting for flag #${flagId} …`);

  const r = await getSuggestions(flagId);
  if (!r.ok) {
    console.log(`[suggest-flag] refused: ${r.error}`);
    process.exit(0);
  }
  if (r.note) console.log(`[suggest-flag] note: ${r.note}`);

  const sugg = r.suggestions || [];
  console.log(`[suggest-flag] ${sugg.length} field(s):`);
  for (const s of sugg) {
    console.log(`  - ${s.asset} / ${s.field}`);
    console.log(
      `      current=${s.current_char_max || '(unknown)'}  suggested=${s.suggested_char_max == null ? 'NONE' : s.suggested_char_max}  confidence=${s.confidence}`
    );
    console.log(`      snippet: ${s.snippet ? JSON.stringify(s.snippet) : '(none)'}`);
  }

  console.log('[suggest-flag] done');
  process.exit(0);
}

main().catch((err) => {
  console.error('[suggest-flag] FAILED:', err.message);
  process.exit(1);
});
