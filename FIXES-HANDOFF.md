# Fixes pass — handoff

Scope: nine fixes from a live review of `rebrand/cleanup`. Every value below is
lifted from the spec sheet — none of it is a new design decision.

Target: `kylebrintnall-ux/quillio`, branch `rebrand/cleanup`.

Standing rules from `DEPLOY-STEPS.md` still apply: assets live under
`public/assets/`, and every asset URL in a shell needs `?v=__BUILD__`
(`${buildId()}` in `src/server.js`, which never passes through `renderShell`).

Nine independent steps. Commit each separately — several touch the same files,
and if one reads wrong you want to revert just that one.

---

## 1. Nav: drop the quill, go transparent

The nav is a solid navy band with a quill glyph beside the wordmark. Both go.

- Delete the `.nav-quill-img` `<img>` from `public/partials/nav.html` and from
  `public/onboarding.html`'s own inline copy of the nav.
- Delete the now-unused `.nav-quill-img` rule from `app.html`, `settings.html`
  and `onboarding.html`.
- The wordmark stands alone. Spec markup is exactly:
  `<button class="nav-logo"><span class="nav-wordmark">Quillio</span></button>`

\`\`\`css
nav { position: relative; z-index: 2; display: flex; align-items: center;
      justify-content: space-between; height: 58px; padding: 0 20px;
      background: transparent; border: none; box-shadow: none; }
\`\`\`

Find whatever currently paints that navy — it may be on `nav` itself or on a
wrapper — and clear it along with any `border-bottom`. The nav sits directly on
the sky gradient.

## 2. Brief headline

"What are we writing?" → **"Build a document."** (with the period).

`grep -rn 'are we writing' public/ src/` didn't find it from the outside, so
it's likely assembled in JS or uses a typographic apostrophe. Search for it and
change it wherever it lives.

## 3. Build screen: attach and run buttons

Both still carry old rounded/gradient styling.

\`\`\`css
.attach-btn { width: 48px; height: 48px; flex: 0 0 48px; background: transparent;
              border: 1px solid var(--q-cream); border-radius: 0; color: var(--q-cream);
              font-family: var(--q-display); font-size: 22px; line-height: 1; cursor: pointer; }
.attach-btn:hover { background: rgba(252,246,227,.1); }

.run-btn { flex: 1; background: var(--q-fill); border: 1px solid var(--q-cream);
           border-radius: 0; box-shadow: none; padding: 12px 16px; cursor: pointer; }
.run-btn::after { content: none; }          /* the old style's glow pseudo-element */
.run-btn-text { font-family: var(--q-display); font-size: 15px; color: var(--q-ink); }
.run-btn:hover:not(:disabled) { background: var(--q-gold); border-color: var(--q-gold); }

.card-footer { border: none; display: flex; gap: 10px; padding: 16px 0 0; }
.glass-card  { background: none; border: none; border-radius: 0; }
\`\`\`

`.run-btn::after { content: none }` is the one that's easy to miss — the old
treatment used a pseudo-element for its glow, so clearing the background alone
leaves it behind.

## 4. Doc titles: no boxes

The project-detail and output headers are wrapped in bordered boxes. The spec
has the title sitting bare on the sky:

\`\`\`css
.output-header.glass-panel { background: transparent; border: none; padding: 0; margin-bottom: 16px; }
\`\`\`

`.output-header` itself is a flex row holding the title and its GIF — it needs
no surface of its own.

## 5. Project-detail scroll GIF

The project-detail header currently shows only the "in progress" state. It
should show the static scroll:

\`\`\`html
<img class="header-gif" src="/assets/images/scroll-static.png?v=__BUILD__" width="60" height="63" alt="">
\`\`\`

`scroll-static.png` is a single-frame PNG, not a GIF — the project-detail
header is a resting state, so it shouldn't animate. **This asset is not yet in
the repo**; it needs uploading to `public/assets/images/` first.

For contrast, the two screens that DO animate keep their GIFs:
`#screen-output` → `quillio-doc-done.gif`, `#screen-copydone` →
`quillio-copy-done.gif`.

## 6. Notification panel: less translucent

At `rgba(21,44,112,.55)` the panel is unreadable over a busy background. The
spec uses a denser tint for this one surface, because unlike the modal it has
no dimmed overlay behind it to separate it from the page:

\`\`\`css
.notif-panel { background: rgba(16,34,88,.9);
               backdrop-filter: blur(22px); -webkit-backdrop-filter: blur(22px);
               border: 1px solid var(--q-cream); border-radius: 0; }
\`\`\`

Leave `.modal-sheet`, `.toast` and `.status-dropdown` at `.55` — they're either
over an overlay or small enough to read fine.

## 7. Section body text: full cream

"Writer direction" and the prose below it are muted to the point of being hard
to read. On the project-detail screen both the labels and the body text are
full-opacity cream in the spec:

\`\`\`css
.section-label { font-family: var(--q-display); font-size: 14px; color: var(--q-cream);
                 letter-spacing: 2px; text-transform: uppercase; margin: 18px 0 8px; }
.section-body  { font-family: var(--q-body); font-size: 14px; line-height: 1.7;
                 color: var(--q-cream); text-align: left; margin: 0 0 8px; }
\`\`\`

`--q-cream`, not `--q-cream-75`. Muted cream is for hairlines and metadata, not
for anything anyone has to read.

## 8. Field selection and checkmark

A gold filled block and a gold checkmark both read as warnings on a design that
uses gold for its accent. The spec carries selection with the border and a
faint wash instead:

\`\`\`css
/* selection = border goes solid + a faint wash + an inset bar. Not a fill. */
.asset-field.selected { border-top-style: solid; border-top-color: var(--q-cream);
                        background: rgba(252,246,227,.09);
                        box-shadow: inset 2px 0 0 var(--q-cream);
                        padding-left: 12px; padding-right: 12px; }
.asset-field.selected .field-name { color: var(--q-cream); }

/* checkmark: cream block, dark glyph — the same logic as the buttons */
.field-check { width: 18px; height: 18px; border-radius: 0;
               background: var(--q-cream); color: var(--q-ink);
               font-family: var(--q-display); font-size: 12px;
               display: inline-flex; align-items: center; justify-content: center; }
\`\`\`

Gold stays reserved for hover and for the one genuinely-emphatic badge
(`.asset-card-badge.drafted`).

## 9. Settings: voice guide and messages

The voice guide panel and the settings message states are still old-style.

\`\`\`css
.terminal { border: 1px solid var(--q-cream); background: rgba(21,44,112,.42);
            backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
            color: var(--q-cream-85); font-family: var(--q-body);
            font-size: 13px; line-height: 1.7; border-radius: 0; padding: 16px 18px; }
.terminal .t-h { font-family: var(--q-display); font-size: 15px; color: var(--q-cream); margin: 14px 0 4px; }
.terminal .t-h:first-child { margin-top: 0; }
.terminal .t-ul { margin: 4px 0 10px; padding-left: 20px; }

/* messages: cream only, pixel glyphs, no hue */
.banner, .error, .note { font-family: var(--q-body); font-size: 13px; line-height: 1.5;
                         padding: 10px 12px; margin-top: 14px; display: flex; gap: 10px;
                         align-items: flex-start; border-radius: 0; background: transparent; }
.banner { border: 1px solid var(--q-cream); color: var(--q-cream); }
.banner::before { content: '\\2713'; flex: 0 0 16px; width: 16px; height: 16px;
                  border: 1px solid var(--q-cream); font-family: var(--q-display);
                  font-size: 11px; line-height: 16px; text-align: center; }
.error  { border: 1px solid var(--q-cream); color: var(--q-cream); }
.error::before  { content: '!'; flex: 0 0 16px; width: 16px; height: 16px;
                  border: 1px solid var(--q-cream); font-family: var(--q-display);
                  font-size: 11px; line-height: 16px; text-align: center; }
.note   { border: 1px dotted var(--q-cream-75); color: var(--q-cream-75); }
.empty  { border: 1px dotted var(--q-cream); color: var(--q-cream-75);
          font-family: var(--q-body); font-size: 14px; text-align: center;
          padding: 30px 20px; background: transparent; border-radius: 0; }

.progress { font-family: var(--q-body); font-size: 13px; color: var(--q-cream-75); margin-bottom: 10px; }
.spinner  { display: inline-block; width: 32px; height: 32px;
            background: url('/assets/gifs/quillio_magic_v27.gif?v=__BUILD__') center / contain no-repeat;
            image-rendering: pixelated; vertical-align: -10px; margin-right: 8px; }
\`\`\`

Note `.terminal` is the one *content* surface that carries glass rather than a
plain border — it's the voice guide's document body, and the tint separates it
from the prose around it. `.banner`/`.error` differ only by glyph, never by
colour: no red, no green.

## Verify

- Nav reads cream against the gradient with the navy band gone, at both
  breakpoints and on all three shells.
- No box around any doc title; the header GIF still sits beside it.
- Attach and run buttons match the CTAs elsewhere; no glow remnant on hover.
- Notification panel is readable with content behind it.
- "Writer direction" and its prose are full cream.
- Select a field: border solid, faint wash, inset bar, no gold block. The
  checkmark is a cream square with a dark tick.
- `grep -n 'border-radius' public/*.html public/partials/*.html` — every
  remaining hit is either `0` or in the undesigned feature set we're leaving
  alone (matrix, riff builder, sliders, chips, hub cards in `app.html`).
