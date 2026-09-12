# Surfaces + background — handoff (pass 2)

Scope: the sky gradient, the paper texture, and the surface treatment that
replaces the light rounded cards. Follows the bird system, which is already on
`rebrand/cleanup`.

Target: `kylebrintnall-ux/quillio`, branch `rebrand/cleanup`, written against
`36fc8d7`.

Read `DEPLOY-STEPS.md` first for the repo's two standing rules: assets live
under `public/assets/`, and every asset URL needs `?v=__BUILD__`.

---

## 0. Read this before touching any token

**This is not a token-value swap.** The app's palette and the rebrand's palette
use the same names for different jobs:

| Token | App today | Used for | Rebrand |
| --- | --- | --- | --- |
| `--ink` | `#1A1A2E` | dark text **on light cards** (~30 rules) | `#0A2233`, only as text **on cream fills** |
| `--gold` | `#C9A84C` | button fills, `.riff-btn` | `#F5C518`, hover state + accents |
| `--cream` | `#F5F0E8` | occasional light text | `#FCF6E3`, the primary text colour |
| `--sky` | `#4DD9D9` | the teal that reads as "old app" | retired |

The rebrand **inverts the surfaces**: cards go from opaque light to transparent
over a blue sky, so text goes from dark to cream. Redefining `--ink` in place
therefore turns ~30 rules into dark text on dark glass — every title, field
name and card name in the app, invisible at once, in one commit.

**Do this instead.** Add the rebrand palette under new names, migrate rules to
them step by step, and delete the old tokens only when nothing references them:

\`\`\`css
:root {
  --q-cream: #FCF6E3;
  --q-cream-85: rgba(252,246,227,.85);
  --q-cream-75: rgba(252,246,227,.75);
  --q-cream-55: rgba(252,246,227,.55);
  --q-cream-35: rgba(252,246,227,.35);
  --q-fill: #FDF6DC;     /* cream button fill */
  --q-ink: #0A2233;      /* text on --q-fill only */
  --q-gold: #F5C518;
  --q-plum: #3D3566;
  --q-glass: rgba(21,44,112,.55);
}
\`\`\`

Every step below is independently shippable. Stop after any one and the app
still renders.

## 1. Fonts

No new font work. The app already has `@font-face { font-family: 'StarCrush' }`
in all three shells, loading `/fonts/Star_Crush.otf`, and uses
`'StarCrush', serif` throughout — same family name the rebrand spec uses. Body
text is already `Zen Kaku Gothic New`.

Do **not** add a second `@font-face`. The spec sheet's `--display` /
`--body` variables are conveniences; map them to what's already there:

\`\`\`css
--q-display: 'StarCrush', serif;
--q-body: 'Zen Kaku Gothic New', sans-serif;
\`\`\`

## 2. The sky gradient

Replace `.sky-bg`'s current background. This is the single highest-impact
change — the teal is what reads as "old app."

\`\`\`css
.sky-bg {
  background: linear-gradient(180deg,
    #2E5FD6 0%,  #3068E0 30%, #3272E9 50%, #357EEF 65%, #3C8BF4 78%,
    #539CF5 87%, #84B6F6 93%, #B3D0F9 97%, #DEEBFC 100%);
}
\`\`\`

The stop positions matter more than the hues: the blue holds deep through 78%
of the height and only opens up in the last fifth, so the pale band meets the
grass instead of washing out the middle of the page. Nine stops, not two.

Leave `.sky-bg`'s positioning alone — it's already `position: fixed`.

## 3. The paper texture

`texture.jpg` is **not yet committed.** Upload it to
`public/assets/images/texture.jpg` first (600px tile, ~soft grain).

\`\`\`css
.clouds-wrap::before {
  content: ''; position: absolute; inset: 0;
  background: url('/assets/images/texture.jpg?v=__BUILD__') center / 600px auto repeat;
  mix-blend-mode: soft-light;
  opacity: .28;
}
\`\`\`

`soft-light` at 28% is the whole effect — it should be almost subliminal. If it
reads as visible noise, the blend mode got dropped, not the opacity.

This is the rule the bird pass deliberately skipped, so `::before` on
`.clouds-wrap` is currently free. `::after` is the ground band — don't touch it.

## 4. Content surfaces

The rebrand's content cards are **transparent with a 1px cream border and no
radius**. Not frosted glass — that's step 5.

\`\`\`css
.glass-panel,
.project-card {
  background: transparent;
  border: 1px solid var(--q-cream);
  border-radius: 0;
  box-shadow: none;
}
.glass-panel { padding: 18px; }
.project-card { padding: 14px 16px; margin-bottom: 12px; }

/* repeating rows read as dotted, so the outer panel stays the only solid box */
.doc-row       { background: none; border: none; border-radius: 0; padding: 0;
                 margin-bottom: 12px; color: var(--q-cream); }
.doc-row-body  { border: 1px dotted var(--q-cream); padding: 12px 14px; }
.asset-card    { background: none; border: none; border-radius: 0; padding: 0; }
.asset-card-name { border: 1px dotted var(--q-cream); padding: 13px 14px; }
.asset-field   { border-top: 1px dotted var(--q-cream-55); padding: 11px 0; }
.asset-field:first-of-type { border-top: none; }
\`\`\`

**Every `border-radius` and `box-shadow` in the app has to go**, except the
functional controls listed in step 7. The current 18px radii and
`0 3px 12px rgba(...)` shadows are half of the old look. Grep for both and
audit each hit.

## 5. Floating surfaces

Only these four get the tinted glass. The tint is deep sky blue so cream text
still holds contrast when the surface sits over the pale bottom of the
gradient:

\`\`\`css
.modal-sheet, .toast, .notif-panel, .status-dropdown {
  background: rgba(21,44,112,.55);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  border: 1px solid var(--q-cream);
  border-radius: 0;
  color: var(--q-cream);
}
.modal-sheet { backdrop-filter: blur(22px) saturate(1.1); }
.toast       { backdrop-filter: blur(18px); }
.modal-overlay {
  background: rgba(21,44,112,.28);
  backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
}
\`\`\`

## 6. Text colour — the careful step

This is the `--ink` audit. Every rule that currently reads `color: var(--ink)`
or a `rgba(26,26,46,...)` literal is dark text that was sitting on a light
card. On a transparent card over blue it must become cream.

Roughly: `--ink` → `--q-cream`, `rgba(26,26,46,0.72)` → `--q-cream-75`,
`rgba(26,26,46,0.5)` → `--q-cream-55`. But **check each one against what's
actually behind it** — a handful sit on cream button fills and must stay dark
(`--q-ink`). `grep -n 'var(--ink)\\|rgba(26,26,46' public/*.html` is the work
list; there are about 30 in `app.html` and a similar count in `settings.html`.

Contrast floor: 4.5:1 for body text, 3:1 for headline-scale. Full-opacity cream
on the blue clears both. Alpha-muted cream below `--q-cream-55` does not — use
it for hairlines and dividers, never for type.

## 7. Buttons

Already agreed and already in the spec sheet: solid cream fill, dark navy text,
gold on hover. Zero radius.

\`\`\`css
.cta-primary   { background: var(--q-fill);  color: var(--q-ink);
                 border: 1px solid var(--q-cream); border-radius: 0; padding: 15px; }
.cta-secondary { background: var(--q-cream); color: var(--q-ink);
                 border: 1px solid var(--q-cream); border-radius: 0; padding: 13px; }
.cta-primary:hover:not(:disabled),
.cta-secondary:hover:not(:disabled),
.modal-btn:hover:not(:disabled) {
  background: var(--q-gold); border-color: var(--q-gold); color: var(--q-ink);
}
\`\`\`

Primary and secondary differ only in fill warmth and padding — deliberately a
small step, not two different shapes.

**Radius exceptions — these keep their radius**, because the shape carries
meaning: `.toggle` (pill track), `.status-dot-preview` and `.field-check`
(`border-radius: 50%`), `.nav-bell-count` (badge).

The nav is separate: links are text-only, cream, gold on hover, separated by a
`/` glyph — no pills, no filled active state. `.nav-link.active` is
`color: var(--q-gold); background: none`.

## 8. Progress bars

Segmented, not continuous — 20 discrete segments in an outlined track:

\`\`\`css
.progress-track { background: transparent; border: 1px solid var(--q-cream);
                  border-radius: 0; padding: 4px; display: flex; gap: 4px; height: 36px; }
.progress-seg   { flex: 1; background: transparent; border-radius: 0; }
.progress-seg.filled { background: var(--q-fill); }
\`\`\`

## What to check when it's done

- Nothing dark-on-dark. Tab through every screen; the fastest tell is a card
  title that's gone missing rather than obviously wrong.
- No `border-radius` or `box-shadow` outside the step-7 exceptions.
- The texture is barely perceptible. If you can see grain, check `soft-light`.
- The gradient still reads deep at the top of a long scrolled page — `.sky-bg`
  is fixed, so it shouldn't move at all.
- Cream text over the pale bottom of the gradient, and over the glass surfaces
  where they overlap it. That's the worst-case contrast pairing in the design.

## Not in this pass

The 14 desktop screens, onboarding, and the landing page. The landing page is
the `LANDING_HTML` template literal in `src/server.js` — still on `--navy:
#1C1F3B` / `--sky: #4DD9D9` with 10px radius buttons, and edited in the server
file rather than as a shell.
