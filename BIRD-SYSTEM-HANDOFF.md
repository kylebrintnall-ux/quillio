# Bird system — handoff

Scope: the ambient/dynamic bird system only. Not the button treatment, the
frosted glass, the gradient, or the desktop screens — those are separate
passes against the same spec sheet.

Target: `kylebrintnall-ux/quillio`, rebrand branch. Written as a diff against
`main`.

**Step-by-step deploy instructions: `DEPLOY-STEPS.md`.** Read that first — it
carries the repo's cache-busting and static-mount rules, which this document's
code blocks do not repeat.

Source of truth for behaviour: `bird-system.js` in this project. It is plain
ES5, no build step, no dependencies. Copy it as-is; do not rewrite it.

---

## 1. What exists today

All three shells carry the same background layer:

| File | `.sky-bg` / `.clouds-wrap` CSS | `populateClouds` | Call site |
| --- | --- | --- | --- |
| `public/app.html` | 318, 322 | 4465 | 4488 |
| `public/settings.html` | 236, 237 | 2788 | 2811 |
| `public/onboarding.html` | 32, 33 | 826 | 849 |

Each is:

```
.clouds-wrap { position: fixed; inset: 0; z-index: 1; pointer-events: none; overflow: hidden; }
```

with markup `<div class="sky-bg"></div><div class="clouds-wrap"></div>` and a
JS pass that fills the wrap with cloud elements.

`populateClouds` is what the bird system replaces. Clouds are not part of the
rebrand — the sky is clear.

## 2. Files to add

Eleven new assets. All are pixel art: they must be committed byte-identical,
never re-encoded, resampled, or run through an image optimiser. Anything that
touches the pixel grid destroys them.

**`public/assets/gifs/`**

| File | Canvas | Frames | Duration | Loops |
| --- | --- | --- | --- | --- |
| `bird-fly.gif` | 258×234 | 6 | 0.54s | yes |
| `bird-landing.gif` | 528×288 | 11 | 3.77s | yes |
| `bird-idle.gif` | 528×288 | 16 | 7.68s | yes |
| `bird-takeoff.gif` | 528×288 | 8 | 1.36s | **no** |
| `doc-dropin.gif` | 132×66 | 34 | 3.45s | yes (cut in code) |

**`public/assets/images/`**

| File | Size | Notes |
| --- | --- | --- |
| `tree-left-solid.png` | 124×84 | alpha snapped to 255/0 |
| `tree-right-solid.png` | 124×84 | alpha snapped to 255/0 |
| `grass-tile-solid.png` | 256×44 | repeats on x |
| `texture.jpg` | — | paper grain, 600px tile |

The `-solid` suffix is meaningful: the original art was authored at alpha 214
(84%), which composited grey-blue over the gradient. These are the corrected
files. The originals are also in this project if you need to compare.

**`public/assets/js/`** — `bird-system.js`. It goes inside the existing
`/assets` static mount so no new `express.static` line is needed; only `/fonts`
and `/assets` are served, not `public/` as a whole.

## 3. Diff per file

Apply the same three changes to `app.html`, `settings.html`, and
`onboarding.html`.

### 3a. Replace the cloud generator

Delete `function populateClouds(wrap) { … }` and its
`document.querySelectorAll('.clouds-wrap').forEach(populateClouds);` call.

### 3b. Add the ground band

`.clouds-wrap` gets an `::after` carrying the grass and trees. Mobile is a
single centred tree; desktop is a mirrored pair inset 16px. Both breakpoints
render the art at an integer pixel scale — mobile at 1×, desktop at 2× — so
the grass and tree pixel grids agree.

```css
.clouds-wrap::before {           /* paper texture, above sky, below ground */
  content: ''; position: absolute; inset: 0;
  background: url('/assets/images/texture.jpg') center / 600px auto repeat;
  mix-blend-mode: soft-light; opacity: .28;
}
.clouds-wrap::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: 0;
  height: 84px; image-rendering: pixelated;
  background:
    url('/assets/images/tree-right-solid.png') bottom 0 center / 124px 84px no-repeat,
    url('/assets/images/grass-tile-solid.png') bottom left / 256px 44px repeat-x;
}
@media (min-width: 900px) {      /* match the app's own desktop breakpoint */
  .clouds-wrap::after {
    height: 168px;
    background:
      url('/assets/images/tree-left-solid.png')  bottom 0 left  16px / 248px 168px no-repeat,
      url('/assets/images/tree-right-solid.png') bottom 0 right 16px / 248px 168px no-repeat,
      url('/assets/images/grass-tile-solid.png') bottom left / 512px 88px repeat-x;
  }
}
```

`overflow: hidden` on `.clouds-wrap` stays — crossings need to be clipped at
the viewport edge.

### 3c. Load the controller

Every asset URL below needs `?v=__BUILD__` appended — see `DEPLOY-STEPS.md` §4.

```html
<script>window.QUILLIO_BIRDS_MANUAL = true;</script>
<script src="/assets/js/bird-system.js?v=__BUILD__"></script>
<script>
  QuillioBirds.init({
    frame: 'body',                      // one scene per viewport, not per mockup
    assetBase: '/assets/gifs/',
    skyLayer: '.clouds-wrap',
    docIcon: '#screen-output .header-gif'
  });
</script>
```

**`frame` is the one option that must change.** In the spec sheet every
`.phone` div is its own viewport, so the default selector is `.phone`. In the
real app the viewport is the document — pass `'body'` (or the app's scroll
container) so you get one scene, not none.

`QUILLIO_BIRDS_MANUAL` suppresses the auto-init that the spec sheet relies on,
so your config is the only one that runs.

## 4. How the controller behaves

Two tiers, deliberately different so they read as different distances.

**Ambient crossings.** `bird-fly` at 0.13× native, opacity 0.45–0.6, 22–30s to
cross the viewport width. Fired on a random 25–45s interval in one of two sky
lanes. These are the distant birds.

**Tree birds.** A full arc in one direction: fly in from an edge at 0.1575×,
hand off to `bird-landing`, settle, idle 9–16s, `bird-takeoff`, hand back to
`bird-fly`, continue out the far side. Perched scale 0.252×, full opacity,
10–14s per viewport width. Fired on a random 30–55s interval.

Never more than two birds at once, and never two launching within 7s of each
other. Both rules are enforced by one actor budget per scene.

**Document complete.** `doc-dropin` plays once over the completion screen's
scroll icon, then the static `quillio-doc-done.gif` takes over and persists
for the session. Scoped to `#screen-output .header-gif` — check that selector
against the real app; if the completion icon has a different hook, pass it as
`docIcon`.

Behaviour guarantees already in the file: bails out entirely under
`prefers-reduced-motion: reduce`, pauses on `visibilitychange`, pauses when
the scene scrolls out of view, `pointer-events: none` and `aria-hidden` on
every sprite.

## 5. Things that will break if changed

These are not style preferences — they are the constraints the sprites were
authored against.

- **The shared foot anchor.** `bird-landing`, `bird-idle` and `bird-takeoff`
  put the bird's feet at (345, 251) in the 528×288 canvas — 65.34% across,
  87.15% down — in landing's last frame, every idle frame, and takeoff's
  first. Render all three at the same size and position and the swaps are
  invisible. Crop, pad or re-centre any one of them and the bird jumps at
  every transition.
- **Fresh elements per clip.** A GIF cannot be restarted from JS. Setting
  `src` to the same value does nothing; appending a `#fragment` does nothing.
  Every clip change creates a new `<img>`. This matters most for
  `bird-takeoff`, which has no loop block — once played, that element is dead.
- **Swap after paint, not on a timer.** The outgoing element is removed only
  after the incoming one has loaded and painted (two rAFs). Dropping it on a
  `setTimeout(0)` leaves a one-frame hole at every swap, which reads as the
  bird blinking.
- **Animate `left`/`top`, not `transform`.** A transform promotes the element
  to a composited layer, and Chrome stops advancing the GIF there — the bird
  freezes on one frame mid-flight. `transform` is used only for the static
  `scaleX(-1)` mirror.
- **Integer scale multiples, measured centres.** The handoff points come from
  the opaque bounding box of frame 0 of each sprite: landing's bird centre is
  at (0.279, 0.179) of its canvas, fly's at (0.440, 0.434) — not dead centre.
  These are `ENTRY_X`/`ENTRY_Y` and `FLY_CX`/`FLY_CY` in the file.
- **`bird-fly` has no travel baked in.** It is a wingbeat in place; travel is
  the element's own animation. A GIF with travel baked in stops at its canvas
  edge, which looks like the bird vanishing mid-screen.

## 6. Known open item

On a narrow viewport the `doc-dropin` arrival starts roughly 190px beyond the
right edge, because the clip needs 330px to the right of the icon and 126px
above it at 3× and a phone-width viewport has neither. The bird flies in from
off-screen and becomes visible partway through the descent. This was the
accepted tradeoff — the alternative was shrinking the resolved scroll icon
below its designed 60×63. Desktop has the room and plays the full arc.

If you want the whole arc visible on mobile, the fix is layout, not code:
give the completion header 126px of clearance above the icon.
