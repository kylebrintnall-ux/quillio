'use strict';

// Which platform published a limit, from the URL it is cited to.
//
// LIVES HERE RATHER THAN IN THE RENDER LAYER because three things outside that
// layer now need it and none of them is rendering a document: the sweep's
// notification names the platform, scripts/checkSpecHealth reads it, and the
// settings library says which page a number was verified against. A second copy
// of this mapping is how those surfaces come to disagree about who published a
// limit — which is the same class of drift the one-normalizer rule exists for.
//
// destinations/googleDocs.js re-exports it, so every existing caller and test is
// unchanged and there is still exactly one implementation.
//
// Pure and dependency-free ON PURPOSE. The settings route needs it, and reaching
// it through destinations/googleDocs would pull googleapis into a page render and
// hardcode one destination into a router.

// Map a field's spec_source to a human-readable platform name, or null when
// there's no real source. 'quillio_default' — the sentinel every house_default
// field carries — and anything unrecognized return null. The raw spec_source
// string is NEVER surfaced (we must never print 'quillio_default' or a bogus
// source name).
function specSourceName(specSource) {
  const s = String(specSource || '').toLowerCase();
  if (!s || s === 'quillio_default') return null;
  if (s.includes('linkedin')) return 'LinkedIn';
  if (s.includes('meta') || s.includes('facebook') || s.includes('fb.com')) return 'Meta';
  if (s.includes('twitter') || s.includes('x.com')) return 'X';
  if (s.includes('google') || s.includes('dv360') || s.includes('doubleclick')) return 'Google';
  if (s.includes('instagram')) return 'Instagram';
  if (s.includes('constantcontact')) return 'Constant Contact';
  // 'gong.io', not 'gong' — a bare substring would match any URL that happens to
  // contain those three letters.
  if (s.includes('gong.io')) return 'Gong';
  return null; // unrecognized → no source name (never print the raw value)
}

module.exports = { specSourceName };
