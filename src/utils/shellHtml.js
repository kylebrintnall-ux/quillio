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

// Read once, stamp per request. The read is cached because these files are large
// and unchanging within a deploy; the stamp is not, so buildId() stays the single
// source of the version even if it ever becomes dynamic.
const RAW = new Map();
function renderShell(file) {
  if (!RAW.has(file)) RAW.set(file, fs.readFileSync(file, 'utf8'));
  return RAW.get(file).split('__BUILD__').join(buildId());
}

module.exports = { renderShell, buildId, BOOT_STAMP };
