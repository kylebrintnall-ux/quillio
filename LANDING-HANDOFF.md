# Landing page — handoff (pass 3a)

Scope: the public landing page at `GET /`. One file, one constant.

Target: `kylebrintnall-ux/quillio`, branch `rebrand/cleanup`.

Design reference: frames **L1** (mobile) and **L2** (desktop) in the spec
sheet. Copy is unchanged from the current page — do not rewrite it.

---

## Where it lives

Not in `public/`. It's the `LANDING_HTML` template literal in
`src/server.js` (around line 200), served by:

\`\`\`js
app.get('/', (req, res) => res.status(200).type('html').send(LANDING_HTML));
\`\`\`

## The one non-obvious constraint

**`LANDING_HTML` never goes through `renderShell`,** so `__BUILD__` is not
substituted here. Writing `?v=__BUILD__` on this page ships the literal string
— it busts the cache exactly once and then never again, while looking like it
works.

It is already a template literal, so interpolate the real build id. Add at the
top of `src/server.js`:

\`\`\`js
const { buildId } = require('./utils/shellHtml');
\`\`\`

and use `?v=${buildId()}` in every asset URL below. `buildId()` is fixed for
the life of the process, and `LANDING_HTML` is evaluated once at module load,
so calling it inside the literal is correct.

## What changes

| | Now | After |
| --- | --- | --- |
| Background | flat `--navy: #1C1F3B` | nine-stop sky gradient + paper texture + ground band |
| Buttons | `--sky: #4DD9D9`, `border-radius: 10px` | cream fill, navy text, gold hover, zero radius |
| Wordmark | `clamp(56px, 18vw, 104px)` cream | unchanged sizing, `--q-cream` |
| Birds | none | ambient crossings + tree perches |

The page carries its own `<style>` — it does not share the shells' CSS — so
the tokens, gradient, texture and ground band are repeated here. That's
inherent to it being a standalone constant, not duplication to factor out.

## Drop-in replacement

Replace the whole `LANDING_HTML` value with this. Note the two `${buildId()}`
interpolations and that nothing else in the file uses `${`.

\`\`\`js
const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Quillio</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@300;400;500;700&display=swap" rel="stylesheet">
  <style>
    @font-face {
      font-family: 'StarCrush';
      src: url('/fonts/Star_Crush.otf?v=${buildId()}') format('opentype');
      font-display: swap;
    }
    :root {
      --q-cream: #FCF6E3;
      --q-cream-85: rgba(252,246,227,.85);
      --q-cream-75: rgba(252,246,227,.75);
      --q-fill: #FDF6DC;
      --q-ink: #0A2233;
      --q-gold: #F5C518;
      --q-display: 'StarCrush', serif;
      --q-body: 'Zen Kaku Gothic New', sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; height: auto; min-height: 100%; overflow-x: hidden; }
    body { font-family: var(--q-body); color: var(--q-cream); -webkit-font-smoothing: antialiased; }
    a { color: var(--q-cream); }
    a:hover { color: var(--q-gold); }

    .sky-bg {
      position: fixed; inset: 0; z-index: 0;
      background: linear-gradient(180deg,
        #2E5FD6 0%,  #3068E0 30%, #3272E9 50%, #357EEF 65%, #3C8BF4 78%,
        #539CF5 87%, #84B6F6 93%, #B3D0F9 97%, #DEEBFC 100%);
    }
    .clouds-wrap { position: fixed; inset: 0; z-index: 1; pointer-events: none; overflow: hidden; }
    .clouds-wrap::before {
      content: ''; position: absolute; inset: 0;
      background: url('/assets/images/texture.jpg?v=${buildId()}') center / 600px auto repeat;
      mix-blend-mode: soft-light; opacity: .28;
    }
    .clouds-wrap::after {
      content: ''; position: absolute; left: 0; right: 0; bottom: 0;
      height: 84px; image-rendering: pixelated;
      background:
        url('/assets/images/tree-right-solid.png?v=${buildId()}') bottom 0 center / 124px 84px no-repeat,
        url('/assets/images/grass-tile-solid.png?v=${buildId()}') bottom left / 256px 44px repeat-x;
    }

    .lp {
      position: relative; z-index: 2; min-height: 100vh;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      text-align: center; padding: 0 28px 150px;
    }
    .lp-quill { image-rendering: pixelated; display: block; margin: 0 auto 2px; }
    .lp-wordmark {
      font-family: var(--q-display); font-weight: normal;
      font-size: clamp(56px, 18vw, 104px); line-height: 1;
      color: var(--q-cream); margin: 0 0 12px;
    }
    .lp-tagline {
      font-family: var(--q-body); font-size: 16px; line-height: 1.6;
      color: var(--q-cream-85); margin: 0 0 32px; max-width: 24ch;
    }
    .lp-actions {
      display: flex; flex-direction: column; justify-content: center;
      gap: 10px; width: 100%; max-width: 290px;
    }
    .cta-primary, .cta-secondary {
      display: block; text-align: center; text-decoration: none;
      border: 1px solid var(--q-cream); border-radius: 0;
      font-family: var(--q-display); color: var(--q-ink); cursor: pointer;
    }
    .cta-primary   { background: var(--q-fill);  font-size: 14px; padding: 15px; }
    .cta-secondary { background: var(--q-cream); font-size: 12px; padding: 13px; }
    .cta-primary:hover, .cta-secondary:hover {
      background: var(--q-gold); border-color: var(--q-gold); color: var(--q-ink);
    }
    .lp-helper {
      font-family: var(--q-body); font-size: 12px;
      color: var(--q-cream-75); margin: 20px 0 0;
    }
    a:focus-visible { outline: 2px solid var(--q-gold); outline-offset: 2px; }

    @media (min-width: 768px) {
      .clouds-wrap::after {
        height: 168px;
        background:
          url('/assets/images/tree-left-solid.png?v=${buildId()}')  bottom 0 left  16px / 248px 168px no-repeat,
          url('/assets/images/tree-right-solid.png?v=${buildId()}') bottom 0 right 16px / 248px 168px no-repeat,
          url('/assets/images/grass-tile-solid.png?v=${buildId()}') bottom left / 512px 88px repeat-x;
      }
      .lp { padding: 0 48px 190px; }
      .lp-quill { width: 128px; height: 128px; margin-bottom: -6px; }
      .lp-wordmark { margin-bottom: 6px; }
      /* one line: the sentence is short and the room is there — wrapping it is
         what makes the desktop column read as a stack of fragments */
      .lp-tagline { font-size: 20px; max-width: none; margin-bottom: 26px; }
      .lp-actions { flex-direction: row; max-width: none; gap: 14px; }
      .cta-primary, .cta-secondary { font-size: 15px; padding: 17px 38px; }
      .lp-helper { margin-top: 14px; }
    }
  </style>
</head>
<body>
  <div class="sky-bg"></div>
  <div class="clouds-wrap"></div>
  <main class="lp">
    <img class="lp-quill" src="/assets/gifs/quillio_magic_v27.gif?v=${buildId()}" width="96" height="96" alt="Quillio">
    <h1 class="lp-wordmark">Quillio</h1>
    <p class="lp-tagline">Creative brief intelligence for copywriters.</p>
    <div class="lp-actions">
      <a class="cta-primary" href="/onboarding">Create account</a>
      <a class="cta-secondary" href="/oauth/google">Sign in</a>
    </div>
    <p class="lp-helper">New to Quillio? Set up in about 2 minutes.</p>
  </main>
  <script>window.QUILLIO_BIRDS_MANUAL = true;</script>
  <script src="/assets/js/bird-system.js?v=${buildId()}"></script>
  <script>
    QuillioBirds.init({ frame: 'body', assetBase: '/assets/gifs/', skyLayer: '.clouds-wrap' });
  </script>
</body>
</html>`;
\`\`\`

## Notes on specific choices

- **`.lp` uses `min-height: 100vh`, not `100%`.** There's no shell wrapper here
  to inherit a height from.
- **No `docIcon` in the bird config.** The landing page has no completion
  screen, so the drop-in never fires. Omitting it is correct, not an oversight.
- **`.cta-primary:hover` declares `color`.** These CTAs are anchors, and
  `a:hover { color: var(--q-gold) }` outspecifies the base class — without an
  explicit colour you get gold text on a gold fill, i.e. an invisible primary
  CTA. The same latent bug exists on `app.html`'s `.cta-primary:hover:not(:disabled)`
  and `.modal-btn:hover:not(:disabled)`; both should get `color: var(--q-ink)`
  even though they're currently only used on `<button>`.
- **The wordmark keeps its existing `clamp()`.** Sizing was already right; only
  the colour token changed.
- **Desktop is not the mobile column scaled up.** The quill goes to 128px, the
  tagline holds one line (`max-width: none`), the gap under it opens to 52px,
  and the four elements sit tight together — 6px under the wordmark, 26px under the tagline — so the group reads as one mark rather than four stacked lines. Both CTAs equalise at 15px. Left as the mobile proportions, the two-line
  tagline and mobile-sized quill make the centred column read as a stack of
  unrelated fragments.
- **Ground band repeats the shells' values verbatim.** If those change later,
  this needs the same edit — there's no shared stylesheet to update.

## Verify

- `/` renders the gradient, texture, trees and grass, with birds appearing
  within ~45s.
- View-source: every asset URL reads `?v=<7-char sha>`, never `?v=__BUILD__`
  and never `?v=${buildId()}`.
- Hover both CTAs — gold fill, dark navy text, still legible.
- Both links still navigate: `/onboarding` and `/oauth/google`.
- 768px and above: actions sit side by side, mirrored tree pair.
- Content clears the ground band at 320px width and at 1440px.
