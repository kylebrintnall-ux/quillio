'use strict';

// Ops helper (LiveSpecs chunk 2) — set the editable test-page content so the
// next detector run sees a change. Console-friendly equivalent of
// POST /admin/api/test-spec. Requires DATABASE_URL.
//
// Pass the new content as ONE quoted argument. A literal "\n" in the argument
// becomes a real newline (handy on one line):
//   railway run node scripts/setTestSpec.js "Headline: 80 characters\nBody: 200 characters\nCTA: 25 characters"
//
// (Whitespace is collapsed before hashing, so newlines vs spaces don't change
// the detection result — they only affect how the stored page reads.)
//
// Only touches spec_test_page. Never writes copy_fields.

const { setTestPageContent } = require('../src/db/specWatch');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[set-test-spec] DATABASE_URL not set — nothing to do.');
    process.exit(1);
  }

  const raw = process.argv[2];
  if (typeof raw !== 'string' || raw.length === 0) {
    console.error('[set-test-spec] usage: node scripts/setTestSpec.js "<content>"');
    process.exit(1);
  }

  const content = raw.replace(/\\n/g, '\n');
  await setTestPageContent(content);
  console.log('[set-test-spec] test page content set to:');
  console.log('    ' + JSON.stringify(content));
  console.log('[set-test-spec] run scripts/runDetection.js to detect the change.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[set-test-spec] FAILED:', err.message);
  process.exit(1);
});
