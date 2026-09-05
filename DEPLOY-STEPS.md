# Pushing the rebrand live — step by step

Target: `kylebrintnall-ux/quillio`, rebrand branch. Railway builds on push
(`NIXPACKS`, `npm start`), so the deploy itself is just the merge.

Three facts about this repo shape every step below:

1. **Only `/fonts` and `/assets` are served statically.** `src/server.js` mounts
   those two directories and nothing else — `public/` as a whole is not public.
   Anything the browser must fetch goes under `public/assets/`.
2. **Those mounts are `immutable, max-age=7d`.** Replacing a file in place
   reaches nobody who already loaded the app, for up to a week. Every asset URL
   must carry `?v=__BUILD__`.
3. **`__BUILD__` is substituted at request time** by `renderShell` in
   `src/utils/shellHtml.js`, via a whole-file string replace — so it works inside
   inline `<style>` and JS string literals, not just `src` attributes.

Skipping #3 is the failure mode that looks like success: the CSS lands
immediately (shells are `no-store`) and the images don't.

---

## Step 1 — Branch

```bash
git checkout main
git pull
git checkout -b rebrand        # or: git checkout rebrand
```

If the rebrand branch already exists and has diverged from `main`, tell me — the
handoff is written as a diff against `main` and will fight a diverged branch.

## Step 2 — Copy the assets in

From your GIF folder and this project's `assets/` directory:

```
public/assets/gifs/
  bird-fly.gif          258x234    6 frames   0.54s   loops
  bird-landing.gif      528x288   11 frames   3.77s   loops
  bird-idle.gif         528x288   16 frames   7.68s   loops
  bird-takeoff.gif      528x288    8 frames   1.36s   NO loop
  doc-dropin.gif        132x66    34 frames   3.45s   loops (cut in code)

public/assets/images/
  tree-left-solid.png   124x84
  tree-right-solid.png  124x84
  grass-tile-solid.png  256x44
  texture.jpg           600px tile

public/assets/js/
  bird-system.js
```

`bird-system.js` goes under `public/assets/js/` deliberately — that's inside an
existing static mount, so no new `express.static` line is needed. It'll be
served at `/assets/js/bird-system.js`.

**Copy the bytes. Do not re-encode.** These are pixel art at exact canvas
sizes. Any optimiser — imagemin, Squoosh, an editor's "save for web", a CI
image step — will resample them and destroy the art. Verify after copying:

```bash
cd public/assets
identify gifs/bird-landing.gif | head -1     # must say 528x288
identify images/tree-left-solid.png          # must say 124x84
```

If `identify` isn't available, checksum against the source folder instead:

```bash
shasum gifs/*.gif images/*.png
```

## Step 3 — Verify the assets serve

Before touching any markup, confirm the mount works:

```bash
npm install
node --env-file=.env src/server.js
```

Then in a browser: `http://localhost:3000/assets/gifs/bird-fly.gif` and
`http://localhost:3000/assets/js/bird-system.js`. Both should load. A 404 here
means the file landed outside the mounted directories.

## Step 4 — Apply the shell changes

Follow `BIRD-SYSTEM-HANDOFF.md` §3 for each of the three shells:

- `public/app.html`
- `public/settings.html`
- `public/onboarding.html`

Three edits per file: delete `populateClouds` and its call, add the ground-band
CSS to `.clouds-wrap`, load the controller. **Every asset URL in that CSS needs
`?v=__BUILD__` appended** — the handoff's CSS block shows the paths but you must
add the stamp:

```css
url('/assets/images/tree-right-solid.png?v=__BUILD__') bottom 0 center / 124px 84px no-repeat,
url('/assets/images/grass-tile-solid.png?v=__BUILD__') bottom left / 256px 44px repeat-x;
```

And on the script tag:

```html
<script>window.QUILLIO_BIRDS_MANUAL = true;</script>
<script src="/assets/js/bird-system.js?v=__BUILD__"></script>
<script>
  QuillioBirds.init({
    frame: 'body',
    assetBase: '/assets/gifs/',
    skyLayer: '.clouds-wrap',
    docIcon: '#screen-output .header-gif'
  });
</script>
```

`bird-system.js` appends `assetBase + filename` with no stamp of its own, so the
five bird GIFs it loads are **not** cache-busted. That's fine on first deploy.
If you ever replace a bird sprite, pass the stamp through:
`assetBase: '/assets/gifs/'` → and add `?v=__BUILD__` handling, or just rename
the file.

## Step 5 — Check the two things I couldn't verify

Both fail silently if wrong.

- **The desktop breakpoint.** The handoff guesses `900px`. Grep the real value:
  `grep -n 'min-width' public/app.html | head`. Use whatever the app already
  uses for its desktop layout.
- **The completion-screen icon hook.** The handoff passes
  `#screen-output .header-gif`. Confirm it exists:
  `grep -n 'header-gif' public/app.html`. If the completion icon has a
  different id or class, pass the real selector as `docIcon`.

## Step 6 — Test locally

With the server running, open `http://localhost:3000/app` and watch for:

- A bird crossing the sky within ~45s, small and semi-transparent.
- A bird flying in, landing in a tree, idling, then flying out — no blink or
  jump at any of the four sprite swaps.
- Never more than two birds at once.
- Trees and grass at the same visual density (both fully opaque).

Then check the guards:

- **Reduced motion.** DevTools → Rendering → Emulate `prefers-reduced-motion:
  reduce`. No birds should spawn at all.
- **Tab switching.** Switch away and back. No pile-up of birds on return.
- **Resize.** Cross the desktop breakpoint. Trees should resize and birds should
  re-perch at the new canopy height.

If nothing appears at all, the cause is almost always `frame` — it must be
`'body'` (or the app's scroll container), not the default `.phone`, which
matches nothing in the real app.

## Step 7 — Commit and push

```bash
git add public/assets public/app.html public/settings.html public/onboarding.html
git commit -m "Bird system: replace cloud generator with pixel-art bird sprites"
git push -u origin rebrand
```

## Step 8 — Deploy and verify

Railway builds on push. To point a Railway environment at the rebrand branch:
**Service → Settings → Source → Branch**, or create a separate environment so
`main` keeps serving production.

Once it's built, confirm what's actually live:

```bash
curl https://<your-railway-domain>/health
# → {"ok":true,"commit":"abc1234"}
```

That `commit` is `RAILWAY_GIT_COMMIT_SHA`, which is also the `__BUILD__` stamp.
Match it against your pushed sha. If it's stale, the deploy didn't take and the
old assets are still cached — no amount of hard-refreshing the browser will fix
that.

Then view-source the app and check the asset URLs read
`?v=abc1234`, not `?v=__BUILD__`. The literal token means the page bypassed
`renderShell` — that's the `sendFile` bug the comments in `shellHtml.js` warn
about.

---

## Rollback

```bash
git revert HEAD
git push
```

Assets are additive and unreferenced after a revert, so they can stay. The
`immutable` cache means a browser that already fetched them keeps them, which
makes re-landing the change fast.

## Not in this pass

This covers the bird system only — the scope you picked. Still to port: the
button treatment, the frosted glass, the gradient and texture, the segmented
progress bars, and the 14 desktop screens.

One thing to know when you get there: the landing page is **not** a file in
`public/`. It's the `LANDING_HTML` template literal inside `src/server.js`
(around line 200), served by `app.get('/')`. It currently uses the old palette
(`--navy: #1C1F3B`, `--sky: #4DD9D9`) and `border-radius: 10px` buttons, so it
will need editing in place in the server file, not as a shell.
