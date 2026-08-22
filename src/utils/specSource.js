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
  // Matches BOTH help.pinterest.com (what the library cites) and
  // business.pinterest.com (the best-practices page it deliberately does not).
  // That is correct: this function maps a URL to the platform that published it,
  // and both pages are Pinterest's. WHICH Pinterest page a number came from is a
  // question for the citation, not for the display name.
  if (s.includes('pinterest')) return 'Pinterest';
  if (s.includes('constantcontact')) return 'Constant Contact';
  // 'gong.io', not 'gong' — a bare substring would match any URL that happens to
  // contain those three letters.
  if (s.includes('gong.io')) return 'Gong';
  return null; // unrecognized → no source name (never print the raw value)
}

// WHICH PLACEMENT a spec page describes, when the URL says so.
//
// Meta's ads guide serves DIFFERENT NUMBERS per placement from the same format
// page. The bare .../ads-guide/update/image is Facebook Feed's view — measured
// identical to .../image/facebook-feed after the content stop marker, same hash
// — and the other placements publish their own:
//
//   facebook-feed          Primary Text 50-150,  Headline 27
//   instagram-feed         Primary Text 125,     Headline 40
//   instagram-story        Primary Text 125,     no headline
//   instagram-reels        Primary Text 44,      no headline
//   facebook-marketplace   Primary Text 125,     Headline 40, Description 30
//
// So a citation to a bare format URL is not wrong, it is UNDERSPECIFIED: the
// page it points at serves one placement's numbers by default and names no
// placement anywhere. Naming it is what makes the citation checkable, and it is
// the same rule as naming the platform in the verification sentence — "the
// source page" survives being pointed at the wrong page, "Facebook Feed" does
// not.
//
// DERIVED FROM THE URL, NOT ENUMERATED, so a future placement URL carries its own
// name without anyone remembering to add a table row.
//
// AND ONLY FROM A URL SHAPE WE RECOGNISE. `specSourceName` never prints a raw
// spec_source and this must not either — but a segment of a path this function
// has already matched against a known pattern is not a raw value, it is the
// placement in Meta's own vocabulary. Anything that does not match returns null
// and the caller renders no qualifier at all, which is every source in the
// library today.
//
// KNOWN LIMIT: this names the URL SLUG, which is Meta's routing name and not
// necessarily the heading their page displays. "instagram-story" renders
// "Instagram Story" whatever the page calls it. That is a pointer to the page
// rather than a quotation from it, and the page is one click away.
const META_PLACEMENT_URL = /\/ads-guide\/update\/[a-z0-9-]+\/([a-z0-9-]+)\/?$/i;

// Words whose casing a generic title-case would get wrong.
const PLACEMENT_WORDS = { facebook: 'Facebook', instagram: 'Instagram' };

function specPlacementName(specSource) {
  const m = META_PLACEMENT_URL.exec(String(specSource || ''));
  if (!m) return null;
  const words = m[1].split('-').filter(Boolean);
  if (!words.length) return null;
  return words
    .map((w) => PLACEMENT_WORDS[w] || (w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

module.exports = { specSourceName, specPlacementName };
