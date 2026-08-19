'use strict';

// The served HTML shells (app / onboarding / settings) and the build stamp that
// versions every asset URL inside them.
//
// WHY THIS EXISTS. `/assets` and `/fonts` are served `immutable, max-age=7d`
// (server.js). `immutable` tells the browser the file at that URL will never
// change, so it does not even revalidate — and every asset lived at a fixed URL.
// Replacing an asset in place therefore reached nobody who had already loaded the
// app, for up to a week. That is not hypothetical: the recropped nav logo shipped
// and every returning browser kept rendering the old 1024x1024 file, whose
// transparent margin is baked into the image, so the header spacing fix appeared
// not to have landed. The CSS half arrived immediately (the shell is `no-store`)
// and the asset half did not, which is the confusing part.
//
// The fix is a versioned URL, not a shorter cache: `?v=<build>` on every asset
// reference, so a deploy changes the URL and the long immutable cache stays
// correct. Headers are deliberately untouched.
//
// SUBSTITUTION IS A WHOLE-FILE STRING REPLACE, which is what makes this work for
// the references in inline <style> and in JavaScript string literals as well as
// in src attributes — six of the twenty in app.html are in JS (the STEP_GIFS
// array and two innerHTML templates), and a markup-aware transform would have
// missed them.
//
// ONBOARDING AND SETTINGS USED sendFile, which streams the raw bytes and would
// have shipped the literal text `__BUILD__` in every URL — busting the cache once
// and then never again, while looking like it worked. They read through here now.

const fs = require('fs');
const path = require('path');

// Fixed for the life of the process, so a dev/self-hosted run still varies per
// restart. Base 36 to keep the URL short.
const BOOT_STAMP = Date.now().toString(36);

// The deploy identity. Railway sets RAILWAY_GIT_COMMIT_SHA; SOURCE_VERSION is the
// Heroku-style equivalent some hosts set.
//
// THE FALLBACK MUST VARY. It used to be the literal 'dev', which is a CONSTANT —
// so off Railway the whole mechanism was inert and an asset change never reached
// a browser that had cached it, with nothing to indicate that. `dev-<boot>`
// changes on every restart: more churn than a commit sha, and correct, which is
// the right way round for an environment nobody is deploying from.
function buildId() {
  const sha = (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_VERSION || '').slice(0, 7);
  return sha || `dev-${BOOT_STAMP}`;
}

// Read once, stamp per request. The reads are cached because these files are
// large and unchanging within a deploy; the stamp is not, so buildId() stays the
// single source of the version even if it ever becomes dynamic. Page shells and
// the nav fragment share the cache.
const RAW = new Map();

// THE SHARED NAV. app.html and settings.html carried the same eleven lines of
// nav markup, differing in one bit: which of the three links has `active`. They
// now carry a single token instead — `__NAV:brief__` / `__NAV:settings__` — and
// the markup lives once, in public/partials/nav.html.
//
// WHY A TOKEN PLUS A FILE, rather than either alone. The token is the same
// mechanism `__BUILD__` already uses, so the substitution rule for these shells
// stays "one whole-file string replace" and nothing new has to be learned to
// read it. The markup stays in its own .html file rather than a string constant
// here so it is still HTML to an editor, still greppable as markup, and still
// picks up `__BUILD__` on its logo URL — the nav is spliced in FIRST and the
// build stamp runs over the result, so the fragment needs no stamping rule of
// its own.
//
// THE TRADEOFF: substitution is textual and whole-file, so a page containing the
// literal `__NAV:...__` anywhere — including inside a JS string — would be
// rewritten. That is the same hazard `__BUILD__` has always carried, and the
// same mitigation applies: the token is deliberately unwriteable by accident.
// The other cost is that nothing checks at load time that a page's token names a
// section the fragment offers, so `renderNav` throws rather than silently
// serving a nav with no link highlighted (see below).
//
// WHAT THE PAGE KNOWS: its own section name, and nothing else. Not the element
// ids, not the class names, not how many links there are, not that `active` is
// how the state is spelled. The fragment maps section -> link; adding a link or
// renaming `active` touches one file and no page.
//
// ONBOARDING AND ADMIN ARE NOT IN THIS. onboarding.html's nav is anchors to real
// routes with a different link set (App / Settings) and no click handlers;
// admin.html has no nav at all. Neither is this component wearing a different
// skin, so neither is forced into it.
//
// The fragment carries no explanatory comment of its own on purpose: its bytes
// are the served bytes, and a comment there would ship to every browser.
const NAV_PARTIAL = path.join(__dirname, '..', '..', 'public', 'partials', 'nav.html');

// `class="nav-link__ACTIVE:brief__"` becomes `class="nav-link active"` on the
// brief page and `class="nav-link"` everywhere else. One regex, so this function
// does not hold a list of the sections that exist — the fragment is the only
// place that names them.
const ACTIVE_SLOT = /__ACTIVE:([a-z-]+)__/g;
const NAV_TOKEN = /__NAV:([a-z-]+)__/g;

function navPartial() {
  if (!RAW.has(NAV_PARTIAL)) RAW.set(NAV_PARTIAL, fs.readFileSync(NAV_PARTIAL, 'utf8'));
  return RAW.get(NAV_PARTIAL);
}

// A section the fragment does not offer is a typo that would otherwise ship a
// nav with nothing highlighted and no error anywhere. It is deterministic, not
// data-dependent, so throwing surfaces it on the first request in dev and CI
// rather than as a cosmetic mystery in production.
function renderNav(section) {
  // Trailing newline dropped: the token sits alone on its line in the page, so
  // the page's own newline terminates the block. This is what keeps the served
  // bytes identical to the inline markup it replaced.
  const raw = navPartial().replace(/\n$/, '');
  let matched = false;
  const out = raw.replace(ACTIVE_SLOT, (_, slot) => {
    if (slot !== section) return '';
    matched = true;
    return ' active';
  });
  if (!matched) throw new Error(`renderShell: nav section '${section}' is not in ${NAV_PARTIAL}`);
  return out;
}

function renderShell(file) {
  if (!RAW.has(file)) RAW.set(file, fs.readFileSync(file, 'utf8'));
  // Nav first, build stamp second: the nav's logo URL carries `__BUILD__` too.
  const withNav = RAW.get(file).replace(NAV_TOKEN, (_, section) => renderNav(section));
  return withNav.split('__BUILD__').join(buildId());
}

module.exports = { renderShell, renderNav, buildId, BOOT_STAMP };
