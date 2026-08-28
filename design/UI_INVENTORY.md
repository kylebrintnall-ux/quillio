# Quillio — UI Inventory

A record of the current state of every visual element in the web app. Read from
source on 2026-08-28 at commit `HEAD` of `claude/web-app-ui-inventory-nnhhav`.

**Nothing here is an evaluation.** Values are recorded literally as written in the
CSS — `0.5` is not normalised to `50%`, `#fff` is not expanded to `#ffffff`,
`.05` is not rewritten as `0.05`, and shorthand is not decomposed. Where a
property is not declared on a rule, the cell reads `—`; that means *not declared
on this selector*, not *has no value at render time* (inheritance and cascade are
not resolved here).

## Surfaces walked

| Surface | File | Style block | Markup | Script |
| --- | --- | --- | --- | --- |
| Landing page (`GET /`) | `src/server.js` `LANDING_HTML` | 205–273 | 274–287 | none |
| App | `public/app.html` | 10–1129 | 1131–1462 | 1463–4494 |
| Settings | `public/settings.html` | 10–713 | 715–1038 | 1039–3285 |
| Onboarding | `public/onboarding.html` | 10–202 | 204–373 | 374–851 |
| Admin (LiveSpecs) | `public/admin.html` | 10–64 | 66–85 | 86–435 |
| Nav partial | `public/partials/nav.html` | 23–72 | 1–22 | 73–306 |

`public/partials/nav.html` is spliced into `app.html` and `settings.html` by
`renderShell` at the `__NAV:<section>__` token (`src/utils/shellHtml.js`). It
carries markup plus its own `<style>` for the bell and notification panel only;
the `nav`, `.nav-logo`, `.nav-link`, `.nav-wordmark` rules that style the rest of
it live in each host page's own stylesheet. `onboarding.html` does **not** use the
partial — it has its own hand-written `<nav>`.

Fonts referenced: `'Zen Kaku Gothic New', sans-serif` (Google Fonts link in each
head), `'StarCrush', serif` (`@font-face`, `/fonts/Star_Crush.otf?v=__BUILD__`) in
app/settings/onboarding, and `'Star Crush', 'Georgia', serif` (`@font-face`,
`/fonts/Star_Crush.otf`, **no `?v=` query, and a space in the family name**) on the
landing page only.

## Cascade note

`app.html` and `settings.html` each declare `:root` **twice** and redefine base
element rules twice. The second block is labelled "v8 DESIGN SYSTEM … Appended
last so it overrides the legacy base styles above." Both the legacy and v8 values
are recorded below, marked `(legacy)` and `(v8)`, because both are literally
present in the file.

---

## 1. Design tokens (`:root`)

| Surface | Token | Value |
| --- | --- | --- |
| Landing | `--navy` | `#1C1F3B` |
| Landing | `--sky` | `#4DD9D9` |
| Landing | `--cream` | `#F5F0E8` |
| App (legacy) | `--accent` | `#4DD9D9` |
| App (legacy) | `--ink` | `#111` |
| App (legacy) | `--muted` | `#666` |
| App (legacy) | `--line` | `#e3e3e3` |
| App (legacy) | `--bg` | `#fff` |
| App (legacy) | `--soft` | `#f6f6f6` |
| App (v8) | `--sky-top` | `#1E78BE` |
| App (v8) | `--sky-mid` | `#2FA8DC` |
| App (v8) | `--sky-btm` | `#4DD9D9` |
| App (v8) | `--gold` | `#C9A84C` |
| App (v8) | `--gold-hover` | `#DDB95A` |
| App (v8) | `--white` | `#FFFFFF` |
| App (v8) | `--ink` | `#1A1A2E` (comment: "v8 navy — overrides the legacy #111 ink token") |
| Settings (legacy) | `--accent` | `#4DD9D9` |
| Settings (legacy) | `--ink` | `#111` |
| Settings (legacy) | `--muted` | `#5a5a5a` |
| Settings (legacy) | `--line` | `#e3e3e3` |
| Settings (legacy) | `--bg` | `#fff` |
| Settings (legacy) | `--soft` | `#f6f6f6` |
| Settings (legacy) | `--navy` | `#1C1F3B` |
| Settings (legacy) | `--cream` | `#F5F0E8` |
| Settings (v8) | `--sky-top` / `--sky-mid` / `--sky-btm` | `#1E78BE` / `#2FA8DC` / `#4DD9D9` |
| Settings (v8) | `--gold` / `--gold-hover` | `#C9A84C` / `#DDB95A` |
| Settings (v8) | `--white` / `--ink` | `#FFFFFF` / `#1A1A2E` |
| Onboarding | `--sky-top` / `--sky-mid` / `--sky-btm` | `#1E78BE` / `#2FA8DC` / `#4DD9D9` |
| Onboarding | `--gold` / `--gold-hover` | `#C9A84C` / `#DDB95A` |
| Onboarding | `--white` / `--ink` | `#FFFFFF` / `#1A1A2E` |
| Admin | `--navy` / `--sky` / `--cream` | `#1C1F3B` / `#4DD9D9` / `#F5F0E8` |
| Admin | `--warn` / `--danger` / `--ok` | `#E8A33D` / `#E86A6A` / `#5FB98E` |

**Referenced but never defined:** `var(--fg)` is used 8 times in
`settings.html` (`.tpl-nameinput`, `.tpl-rename:hover`, `.cf-open`,
`.cf-open:hover`, `.cf-name`, `.cf-limit`, `.cf-unit`, `.cf-meta b`). No `--fg`
declaration exists in any file. `.hdr-iconbtn:hover` uses `var(--ink, #1a1a2e)`
with a fallback; `--ink` *is* defined, so the fallback is unreached.

`.file-tag` in the app's legacy block uses `var(--card, #f6f6f6)`; `--card` is
never defined, so the fallback applies.

---

## 2. Page scaffolding and background

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `*` (all five surfaces) | universal | — | — | — | — | — | — | — | — | — |
| `html, body` (app/settings/onboarding, legacy) | — | — | — | — | — | — | — | — | `0` | `0` |
| `html, body` (landing) | — | — | — | — | — | — | — | — | — | `0` |
| `body` (landing) | `<body>` server.js 274 | `var(--cream)` | `var(--navy)` | — | — | `'Zen Kaku Gothic New', sans-serif` | — | — | `24px` | — |
| `body` (app, legacy) | `<body>` app 1131 | `var(--ink)` | `var(--bg)` | — | — | `'Zen Kaku Gothic New', sans-serif` | — | — | — | — |
| `body` (app, v8) | same element | `var(--ink)` | `var(--ink)` | — | — | `'Zen Kaku Gothic New', sans-serif` | — | — | — | — |
| `body` (settings, legacy) | `<body>` settings 715 | `var(--ink)` | `var(--bg)` | — | — | `'Zen Kaku Gothic New', sans-serif` | — | — | — | — |
| `body` (settings, v8) | same element | `var(--ink)` | `var(--ink)` | — | — | `'Zen Kaku Gothic New', sans-serif` | — | — | — | — |
| `body` (onboarding) | `<body>` onboarding 204 | `var(--ink)` | `var(--ink)` | — | — | `'Zen Kaku Gothic New', sans-serif` | — | — | `0` | `0` |
| `body` (admin) | `<body>` admin 66 | `var(--cream)` | `var(--navy)` | — | — | `'Zen Kaku Gothic New', sans-serif` | — | — | `24px` | `0` |
| `.sky-bg` | `<div>` app 1132, settings 716, onboarding 205 | — | `linear-gradient(180deg, #1E78BE 0%, #2FA8DC 35%, #3BBDE0 60%, #4DD9D9 100%)` | — | — | — | — | — | — | — |
| `.clouds-wrap` | `<div>` app 1133, settings 717, onboarding 206 | — | — | — | — | — | — | — | — | — |
| `main` (app, legacy) | `<main>` app 1135 | — | — | — | — | — | — | — | `16px` | `0 auto` |
| `main` (app, v8) | same | — | — | — | — | — | — | — | `32px 26px 40px` | `0 auto` |
| `main` (app, ≥768px) | same | — | — | — | — | — | — | — | — | — |
| `main` (settings, legacy) | `<main>` settings 720 | — | — | — | — | — | — | — | `24px 16px 56px` | `0 auto` |
| `main` (settings, v8) | same | — | — | — | — | — | — | — | `24px 26px 60px` | `0 auto` |
| `main` (onboarding) | `<main>` onboarding 217 | — | — | — | — | — | — | — | `32px 26px 56px` | `0 auto` |
| `.hero` (landing) | `<main class="hero">` server.js 275 | — | — | — | — | — | — | — | — | — |
| `.screen` / `.screen.active` | `<section>` app, 8 screens | — | — | — | — | — | — | — | — | — |
| `.panel` / `.panel.active` | `<section>` settings, 6 panels | — | — | — | — | — | — | — | — | — |
| `.step` / `.step.active` | `<section>` onboarding, 6 steps | — | — | — | — | — | — | — | — | — |
| `.layout` (settings legacy) | `<div class="layout hidden">` settings 757 | — | — | — | — | — | — | — | — | — |
| `.content` (settings) | `<div class="content">` settings 769 | — | — | — | — | — | — | — | — | — |
| `.hidden` | utility, all surfaces | — | — | — | — | — | — | — | — | — |
| `.full` (app, onboarding) | button modifier | — | — | — | — | — | — | — | — | — |
| `.break` (settings, onboarding) | text modifier | — | — | — | — | — | — | — | — | — |
| `.muted` (onboarding) | `<p class="muted">` ×9 | `rgba(26,26,46,0.6)` | — | — | — | — | — | — | — | — |
| `.muted` (settings legacy) | class modifier | `var(--muted)` | — | — | — | — | — | — | — | — |

`main` max-widths, recorded because they are the layout envelope: app legacy
`680px`, app v8 `520px`, app ≥768px `900px`; settings legacy `860px`, v8 `520px`,
≥768px `900px`; onboarding `520px`, ≥768px `900px`; landing `.hero` `480px`.

---

## 3. Navigation

### 3.1 Nav bar shell

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `nav` (app, legacy) | `<nav>` from nav partial | — | — | `border-bottom: 1px solid var(--line)` | — | — | — | — | `14px 16px` | — |
| `nav` (app, v8) | same | — | `rgba(26,26,46,0.9)` | `border-bottom: 1px solid rgba(77,217,217,0.15)` | — | — | — | — | `0 12px 0 18px` | — |
| `nav` (settings, legacy) | `<nav>` from nav partial | — | — | `border-bottom: 1px solid var(--line)` | — | `'Zen Kaku Gothic New', sans-serif` | — | — | `14px 16px` | — |
| `nav` (settings, v8) | same | — | `rgba(26,26,46,0.9)` | `border-bottom: 1px solid rgba(77,217,217,0.15)` | — | `'Zen Kaku Gothic New', sans-serif` | — | — | `0 12px 0 18px` | — |
| `nav` (onboarding) | `<nav>` onboarding 207 | — | `rgba(26,26,46,0.9)` | `border-bottom: 1px solid rgba(77,217,217,0.15)` | — | — | — | — | `0 12px 0 18px` | — |

`nav` height is `58px` on all three v8 navs. `backdrop-filter: blur(16px)` on all three.

### 3.2 Nav contents

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.nav-logo` (app / settings) | `<button id="nav-brand">` nav partial 2 | — | `none` | `none` | — | — | — | — | `0` | — |
| `.nav-logo` (onboarding) | `<a href="/app">` onboarding 208 | — | `none` | `none` | — | — | — | — | `0` | — |
| `.nav-quill-img` | `<img>` nav partial 3 / onboarding 209 | — | — | — | — | — | — | — | — | — |
| `.nav-wordmark` | `<span>` nav partial 4 / onboarding 210 | `var(--white)` | — | — | — | `'StarCrush', serif` | `21px` | — | — | — |
| `.nav-links` | `<div>` nav partial 6 / onboarding 212 | — | — | — | — | — | — | — | — | — |
| `.nav-link` | `<button>`×3 nav partial 7–9; `<a>`×2 onboarding 213–214 | `rgba(255,255,255,0.4)` | `none` | `none` | `8px` | `'StarCrush', serif` | `12px` | — | `7px 9px` | — |
| `.nav-link:hover` | same | `#fff` | `rgba(255,255,255,0.08)` | — | — | — | — | — | — | — |
| `.nav-link.active` (app, settings) | same | `var(--sky-btm)` | `rgba(77,217,217,0.12)` | — | — | — | — | — | — | — |
| `nav .brand` (app/settings legacy) | — no markup found | — | — | — | — | `'Zen Kaku Gothic New', sans-serif` (settings only) | `18px` | `700` | — | — |
| `nav .links` (legacy) | — no markup found | — | — | — | — | — | — | — | — | — |
| `nav .navlink` (legacy) | — no markup found | `var(--muted)` | `none` | `none` | — | `'Zen Kaku Gothic New', sans-serif` (settings only) | `15px` | `600` | `0` | — |
| `nav .navlink:hover` | — | `var(--ink)` | — | — | — | — | — | — | — | — |
| `nav .navlink.active` (settings only) | — | `var(--ink)` | — | — | — | — | — | — | — | — |

`nav .brand`, `nav .links`, `nav .navlink` are the pre-partial nav rules. The
current nav markup uses `.nav-logo` / `.nav-links` / `.nav-link`; no element
carrying `.brand` or `.navlink` was found in any surface.

### 3.3 Settings hub / tabs / back (secondary navigation)

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.hub` | `<section id="settings-hub">` settings 724 | — | — | — | — | — | — | — | — | `margin-bottom: 24px` |
| `.hub-card` | `<button>`×6 settings 725–753 | — | `rgba(255,255,255,0.35)` | `1.5px solid rgba(255,255,255,0.55)` | `16px` | — | — | — | `22px 16px` | — |
| `.hub-card:hover` | same | — | `rgba(255,255,255,0.55)` | — | — | — | — | — | — | — |
| `.hub-icon` | `<span>` inside each hub card | — | `var(--cream)` | — | `12px` | `'Zen Kaku Gothic New', sans-serif` | — | — | — | — |
| `.hub-icon svg` | inline `<svg>` ×6 | — | — | — | — | — | — | — | — | — |
| `.hub-name` | `<span>` ×6 | `var(--ink)` | — | — | — | `'StarCrush', serif` | `15px` | — | — | — |
| `.hub-desc` | `<span>` ×6 | `rgba(26,26,46,0.68)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | — | — |
| `.settings-back` | `<button id="settings-back">` settings 757 | `var(--ink)` | `none` | `none` | — | `'StarCrush', serif` | `12px` | — | `0 0 4px` | `margin-bottom: 12px` |
| `.settings-back:hover` | same | `var(--sky-btm)` | — | — | — | — | — | — | — | — |
| `.sidebar` (legacy / v8) | `<div class="sidebar">` settings 759 | — | — | — | — | — | — | — | — | v8 `margin-bottom: 24px` |
| `.tab` (legacy) | `<button class="tab">` ×6 settings 760–765 | `var(--muted)` | `var(--bg)` | `1px solid var(--line)` | `999px` | `'Zen Kaku Gothic New', sans-serif` | — | `600` | `8px 16px` | — |
| `.tab` (v8) | same | `rgba(26,26,46,0.6)` | `rgba(255,255,255,0.18)` | `1.5px solid rgba(255,255,255,0.35)` | `100px` | `'StarCrush', serif` | `11px` | `normal` | `9px 18px` | — |
| `.tab.active` (legacy) | same | `#fff` | `var(--ink)` | `border-color: var(--ink)` | — | — | — | — | — | — |
| `.tab.active` (v8) | same | `var(--white)` | `var(--ink)` | `border-color: var(--ink)` | — | — | — | — | — | — |

### 3.4 Back links / step dots

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.back-link` | `<button id="project-back">` app 1353 | `rgba(26,26,46,0.7)` | `none` | `none` | — | `'StarCrush', serif` | `12px` | — | `6px 0` | `margin-bottom: 12px` |
| `.back-link:hover` | same | `var(--ink)` | — | — | — | — | — | — | — | — |
| `.stepdots` | `<div id="dots">` onboarding 218 | — | — | — | — | — | — | — | — | `margin-bottom: 22px` |
| `.stepdots span` | `<span>` generated per step | — | `rgba(255,255,255,0.4)` | — | `3px` | — | — | — | — | — |
| `.stepdots span.on` | same, completed step | — | `var(--sky-btm)` | — | — | — | — | — | — | — |

---

## 4. Headings

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.wordmark` | `<h1>` landing, server.js 277 | `var(--cream)` | — | — | — | `'Star Crush', 'Georgia', serif` | `clamp(56px, 18vw, 104px)` | — | — | `0 0 12px` |
| `h1` (app, legacy) | — no `<h1>` outside `.brief-headline` | — | — | — | — | — | `24px` | — | — | `12px 0 16px` |
| `h2` (app, legacy) | — no bare `<h2>` in app markup (all `<h2>` carry `.output-title`) | `var(--muted)` | — | — | — | — | `15px` | — | — | `24px 0 8px` |
| `.brief-headline` | `<h1>` app 1145 | `var(--ink)` | — | — | — | `'StarCrush', serif` | `36px` | — | — | `0 0 10px` |
| `.brief-headline span` | `<span>`×2 inside it | — | — | — | — | — | — | — | — | — |
| `.output-title` | `<h2>` app 1185, 1206, 1230, 1293, 1360 | `var(--ink)` | — | — | — | `'StarCrush', serif` | `24px` | — | — | `0` |
| `.section-label` | `<div>` app 1189, 1210, 1213, 1247, 1250; `el('div','section-label')` app 3281, 3285, 4081, 4084 | `var(--ink)` (`opacity: 0.75`) | — | — | — | `'StarCrush', serif` | `13px` | — | — | `margin-bottom: 8px` |
| `.assets-label` | `<div>` app 1216, 1241, 1258, 1372; `el('div','assets-label')` app 4095 | `var(--ink)` (`opacity: 0.75`) | — | — | — | `'StarCrush', serif` | `13px` | — | — | `margin-bottom: 14px` |
| `.projects-title` | `<div>` app 1329 | `var(--ink)` | — | — | — | `'StarCrush', serif` | `26px` | — | — | `margin-bottom: 16px` |
| `.settings-title` | `<div>` settings 721 | `var(--ink)` | — | — | — | `'StarCrush', serif` | `26px` | — | — | `margin-bottom: 20px` |
| `h1` (settings, legacy) | `<h1>` settings 772, 815, 888, 903, 927, 944 | — | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `24px` | — | — | `4px 0 16px` |
| `.panel h1` (settings, v8) | same six `<h1>` | `var(--ink)` | — | — | — | `'StarCrush', serif` | `19px` | `normal` | — | `0 0 14px` |
| `h2` (settings, legacy) | `<h2>` settings 821, 837, 856, 953, 977, 994 | `var(--muted)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `15px` | — | — | `24px 0 8px` |
| `h2` (settings, v8) | same | `rgba(26,26,46,0.72)` | — | — | — | `'StarCrush', serif` | `14px` | — | — | `22px 0 10px` |
| `.lib-new h2` | `<h2>` in `el('div','lib-new')` box, settings 1594/1829 | — | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `15px` | — | — | `0 0 4px` |
| `h1` (onboarding) | `<h1>` ×6, one per step | `var(--ink)` | — | — | — | `'StarCrush', serif` | `30px` (≥560px: `34px`) | — | — | `6px 0 12px` |
| `h2` (onboarding) | `<h2>` onboarding 301, 362 | `rgba(26,26,46,0.5)` | — | — | — | `'StarCrush', serif` | `11px` | — | — | `24px 0 8px` |
| `.group h3` (onboarding) | `<h3>` in JS-built asset group | `rgba(26,26,46,0.5)` | — | — | — | `'StarCrush', serif` | `11px` | — | — | `12px 0 4px` |
| `h1` (admin) | `<h1>` admin 67 | — | — | — | — | — | `22px` | — | — | `0 0 4px` |
| `h2` (admin) | `<h2>` admin 70, 79, 81 | — (`opacity:.7`) | — | — | — | — | `15px` | — | — | `28px 0 10px` |
| `.title` (admin) | `<div class="title">` / `<span class="title">` in JS rows | — | — | — | — | — | `16px` | `700` | — | — |
| `.asset h3` (app legacy) | — no markup found | — | — | — | — | — | `16px` | — | — | `0 0 8px` |
| `.eyebrow` (settings legacy) | `<div class="eyebrow">` settings 773, 887, 902, 945 | `#1a9a9a` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | `700` | — | `margin-bottom: 4px` |
| `.eyebrow` (settings v8) | same elements | — | — | — | — | — | — | — | — | — |
| `.eyebrow` (onboarding) | `<div class="eyebrow">` onboarding 279 | `rgba(26,26,46,0.55)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11px` | `600` | — | `margin-bottom: 6px` |
| `.naming-preview-label` | `<div>` settings 1002, 1019 | `rgba(26,26,46,0.72)` | — | — | — | `'StarCrush', serif` | `14px` | — | — | `0 0 8px` |
| `.hdr-block .bh .bt` | `<span class="bt">` from `el('span','bt')` settings 3088, 3119 | `var(--muted)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | — | — |
| `.lib-grouplabel` | `<li>` from `el('li','lib-grouplabel')` settings 1324 | `rgba(26,26,46,0.75)` | — | `border-top: none` | — | `'Zen Kaku Gothic New', sans-serif` | `10.5px` | `700` | `0` | `11px 0 0` |
| `.lib-grouplabel:first-child` | same | — | — | — | — | — | — | — | — | `margin-top: 2px` |
| `.pv-heading` | `<div>` from `el('div','pv-heading')` settings 3194 | — | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `20px` | `700` | — | `0 0 6px` |
| `.pv-wordmark` | `<span>` from `el('span','pv-wordmark')` settings 3181 | — | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `18px` | `700` | — | — |
| `.modal-title` | `<div>` app 1432, 1444 | `var(--ink)` | — | — | — | `'StarCrush', serif` | `18px` | — | — | `margin-bottom: 16px` |
| `.review-status` | `<div>` in `body.innerHTML` app 2778, 2789 | `var(--ink)` | — | — | — | `'StarCrush', serif` | `17px` | — | — | `2px 0 8px` |
| `.picker-group-label` | `<div>` from `el('div','picker-group-label')` app 2660 | `var(--ink)` (`opacity: 0.6`) | — | — | — | `'StarCrush', serif` | `11px` | — | — | `margin-bottom: 8px` |
| `.riff-divider-label` | `<span>` from `el('span','riff-divider-label')` app 2207 | `rgba(26,26,46,0.45)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `10.5px` | `700` | — | — |

---

## 5. Body text

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.tagline` | `<p>` landing server.js 278 | `var(--cream)` (`opacity: 0.85`) | — | — | — | — | `clamp(15px, 4.5vw, 18px)` | — | — | `0 0 32px` |
| `.helper` | `<p>` landing server.js 283 | `var(--cream)` (`opacity: 0.7`) | — | — | — | — | `13px` | — | — | `16px 0 0` |
| `.brief-sub` | `<p>` app 1146 | `rgba(26,26,46,0.68)` | — | — | — | — | `15px` | `400` | — | `0 0 26px` |
| `.section-body` | `<p>` app 1193, 1212, 1215, 1251, 1254; `el('div','section-body')` app 3282, 3286, 4082, 4085 | `rgba(26,26,46,0.78)` | — | — | — | — | `14px` | — | — | `0 0 24px` |
| `.picker-lede` | `<p>` app 1187 | `var(--ink)` | — | — | — | — | `14px` | — | — | `0 0 22px` |
| `.field-select-hint` | `<p>` app 1208, 1242, 1259, 1373; `el('div','field-select-hint')` app 2743; `el('p','field-select-hint')` app 4174 | `var(--ink)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `14px` | — | — | `0 0 14px` |
| `.glass-panel.list .field-select-hint` | same, inside a merged list panel | — | — | — | — | — | — | — | — | `margin-bottom: 12px` |
| `.copydone-sub` | declared; no markup found | `rgba(26,26,46,0.7)` | — | — | — | — | `14px` | — | — | `0 0 20px` |
| `.summary, .direction` (app legacy) | declared; no markup found | — | — | — | — | — | — | — | — | — |
| `p` (settings legacy) | `<p>` throughout | — | — | — | — | — | — | — | — | `8px 0` |
| `p` (onboarding) | `<p>` throughout | `rgba(26,26,46,0.78)` | — | — | — | — | — | — | — | `8px 0` |
| `.hdr-lede` | `<p class="hdr-lede">` settings 888, 903, 946, 995 | `rgba(26,26,46,0.82)` | `rgba(255,255,255,0.22)` | `none` + `border-left: 3px solid rgba(201,168,76,0.6)` | `0 10px 10px 0` | `'Zen Kaku Gothic New', sans-serif` | `14.5px` | — | `4px 16px` | `0 0 18px` |
| `.hdr-hint` | `<div class="hdr-hint">` settings 987 | `rgba(26,26,46,0.55)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | — | `0` |
| `.hdr-upload-title` | `<div>` settings 985 | `var(--ink)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `14px` | `600` | — | — |
| `.lib-hint` | `<p class="lib-hint">` settings 904; `el('p','lib-hint')` settings 1456, 1596, 1831, 1844, 1878, 1885, 2006 | `rgba(26,26,46,0.75)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11.5px` | — | — | `4px 0 0` |
| `.lib-notewhy` | `el('p','lib-notewhy')` settings 1891 | `rgba(26,26,46,0.75)` | `rgba(255,255,255,0.3)` | — | `9px` | `'Zen Kaku Gothic New', sans-serif` | `11.5px` | — | `8px 10px` | `10px 0 0` |
| `.lib-kept` | `el('p','lib-kept')` settings 1895 | `rgba(26,26,46,0.72)` | `rgba(255,255,255,0.42)` | `border-left: 2px solid rgba(26,26,46,0.28)` | `0 9px 9px 0` | `'Zen Kaku Gothic New', sans-serif` | `11.5px` | — | `7px 10px` | `8px 0 0` |
| `.lib-basehint` | `el('span','lib-basehint')` settings 1542, 1552 | `rgba(26,26,46,0.75)` | — | — | — | — | `11.5px` | — | — | — |
| `.lib-fstaticnote` | `el('p','lib-fstaticnote')` settings 1455 | `rgba(26,26,46,0.75)` | — | — | — | — | `12.5px` | — | — | `4px 0 0` |
| `.cf-lede` | `el('p','cf-lede')` settings 2274, 2280, 2285 | `var(--muted)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | — | `0 0 12px` |
| `.tpl-dropsub` | `<span>` settings 910 | `rgba(26,26,46,0.75)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11.5px` | — | — | `margin-top: 6px` |
| `.tpl-namehint` | `<div>` settings 917 | `var(--muted)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | — | `margin-top: 4px` |
| `.tpl-usedby` | `el('div','tpl-usedby')` settings 2194 | `var(--muted)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | — | `margin-top: 2px` |
| `.tpl-meta` | `el('div','tpl-meta')` settings 2197 | `rgba(26,26,46,0.75)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11.5px` | — | — | `margin-top: 4px` |
| `.fineprint` | `<p>` onboarding 355 | `rgba(26,26,46,0.6)` | — | — | — | — | `13px` | — | — | `margin-top: 10px` |
| `.signin-existing` | `<p class="muted signin-existing">` onboarding 234 | — | — | — | — | — | `14px` | — | — | `margin-top: 14px` |
| `.sample` | `<div id="sample">` onboarding 363 | `var(--ink)` | `rgba(255,255,255,0.45)` | `1.5px solid rgba(255,255,255,0.6)` | `14px` | — | `15px` | — | `16px` | — |
| `.sub` (admin) | `<p class="sub">` admin 68 | — (`opacity:.65`) | — | — | — | — | `13px` | — | — | `0 0 20px` |
| `.meta` (admin) | `el('div',{class:'meta'})` admin JS 147, 148 | — (`opacity:.7`) | — | — | — | — | `12.5px` | — | — | `6px 0` |
| `.hash` (admin) | `el('div',{class:'meta hash'})` admin JS 148 | — | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | — | — |
| `.note` (admin) | `el('div'/'p'/'span',{class:'note'})` admin JS ×12 | — (`opacity:.7`) | — | — | — | — | `12.5px` | — | — | — |
| `.summary` (admin) | `<div id="healthSummary" class="summary">` admin 71 | — | — | — | — | — | `13.5px` | — | — | `0 0 12px` |
| `.summary > div` (admin) | children of the above | — | — | — | — | — | — | — | — | `3px 0` |
| `.asset-direction` (app legacy) | `el('div','asset-direction')` app 2301 | `#737373` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | — | `2px 0 8px` |
| `.asset-direction` (app v8) | same element | `rgba(26,26,46,0.48)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | — | `0 0 12px` |
| `.glass-panel.list .asset-card-header + .asset-direction` | same, first child after a header band | — | — | — | — | — | — | — | — | `margin-top: 12px` |
| `.field-copy` (app legacy) | `el('div','field-copy')` app 2199, 2201 | `var(--ink)` | — | — | — | — | `14px` | — | `4px 0 2px` | — |
| `.field-copy` (app v8) | same | `rgba(26,26,46,0.82)` | — | — | — | — | `13px` | — | — | — |
| `.field-copy.empty` (legacy) | same, no copy | `var(--muted)` | — | — | — | — | — | — | — | — |
| `.field-copy .riff-line` | `el('div','riff-line')` app 2210 | — | — | — | — | — | — | — | — | — |
| `.review-digest` | `<div>` app 2789, 2799 | `rgba(26,26,46,0.72)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `13.5px` | — | — | — |
| `.review-note` | `<div>` app 2784, 2790 | `rgba(26,26,46,0.72)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | — | — |
| `.gen-message` | `<div id="gen-message">` app 1287 | `var(--ink)` | — | — | — | `'StarCrush', serif` | `18px` | — | `0 16px` | — |
| `code` (settings) | `<code>` settings 904 | — | `rgba(26,26,46,0.08)` | — | `5px` | `'Zen Kaku Gothic New', sans-serif` | `0.92em` | — | `1px 6px` | — |
| `code` (onboarding) | `<code>` onboarding 331, 359, 364 | — | `rgba(26,26,46,0.08)` | — | `5px` | `'Zen Kaku Gothic New', sans-serif` | `0.92em` | — | `1px 6px` | — |

---

## 6. Links

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `a` (settings) | `<a>` in JS-inserted text | `#1a9a9a` | — | — | — | — | — | — | — | — |
| `a` (onboarding) | `<a href="#" id="folder-change">` onboarding 254, plus sign-in link | `#0d6b6b` | — | — | — | — | — | — | — | — |
| `.lib-fresh-v a` | `<a>` inside the freshness block, settings JS 1165 region | `inherit` (`text-decoration: underline`) | — | — | — | — | — | — | — | — |
| `.tpl-open` | `<a class="tpl-open">` settings JS 2138 region | `rgba(26,26,46,0.7)` (`text-decoration: underline`) | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | `600` | — | — |
| `.tpl-rename` | `el('button','tpl-rename')` settings 2146 | `var(--muted)` (`text-decoration: underline`) | `none` | `0` | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | `0 0 0 8px` | — |
| `.tpl-rename:hover` | same | `var(--fg)` (undefined) | — | — | — | — | — | — | — | — |
| `.lib-resetbtn` | `el('button','lib-resetbtn')` settings 1543 | `#0a5c5c` (`text-decoration: underline`) | `none` | `none` | — | `inherit` | `11.5px` | `600` | `0` | — |
| `.lib-resetbtn:empty` — see `.lib-reset:empty` | container hidden when empty | — | — | — | — | — | — | — | — | — |
| `a` (landing) — see `.btn` | `<a class="btn …">` server.js 280–281 | — | — | — | — | — | — | — | — | — |
| `.nav-logo` as `<a>` | onboarding 208 (`text-decoration: none`) | — | `none` | `none` | — | — | — | — | `0` | — |

---

## 7. Buttons

### 7.1 Landing

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.btn` | `<a>`×2 server.js 280–281 | — | — | `2px solid var(--sky)` | `10px` | — | `16px` | `600` | `12px 24px` | — |
| `.btn-primary` | `<a>` server.js 280 | `var(--navy)` | `var(--sky)` | — | — | — | — | — | — | — |
| `.btn-secondary` | `<a>` server.js 281 | `var(--sky)` | `transparent` | — | — | — | — | — | — | — |
| `.btn:hover` | both | — | — | — | — | — | — | — | — | — |
| `.actions` | `<div>` server.js 279 | — | — | — | — | — | — | — | — | — |
| `.btn` (≤380px) | both | — | — | — | — | — | — | — | — | — |

### 7.2 App — legacy base button

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `button` (app legacy) | every `<button>` on the app | `#fff` | `var(--ink)` | `none` | `8px` | `font: inherit` | — | `600` | `12px 18px` | — |
| `button:active` | same | — | — | — | — | — | — | — | — | — |
| `button:disabled` | same | — | — | — | — | — | — | — | — | — |
| `button.primary` | declared; no markup found in app | — | `var(--ink)` | — | — | — | — | — | — | — |
| `button.secondary` | declared; no markup found in app | `var(--ink)` | `var(--soft)` | `1px solid var(--line)` | — | — | — | — | — | — |

### 7.3 App — v8 buttons

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.run-btn` | `<button id="run-btn">` app 1152 | — | `var(--gold)` | `none` | `12px` | — | — | — | `13px 16px` | — |
| `.run-btn::after` | pseudo, overlay sheen | — | `linear-gradient(180deg, rgba(255,255,255,0.16) 0%, transparent 55%)` | — | — | — | — | — | — | — |
| `.run-btn-text` | `<span>` inside it | `var(--ink)` | — | — | — | `'StarCrush', serif` | `13px` | — | — | — |
| `.run-btn:active` / `:disabled` | same | — | — | — | — | — | — | — | — | — |
| `.attach-btn` (legacy) | `<button id="attach-btn">` app 1150 | `var(--ink)` | `#fff` | `1px solid var(--line)` | `8px` | `font: inherit` | `14px` | — | `6px 12px` | — |
| `.attach-btn` (v8) | same | `rgba(26,26,46,0.55)` | `rgba(255,255,255,0.2)` | `1px solid rgba(255,255,255,0.38)` | `10px` | — | `22px` | `300` | `0` | — |
| `.attach-btn:hover` (legacy) | same | `var(--accent)` | — | `border-color: var(--accent)` | — | — | — | — | — | — |
| `.attach-btn:hover` (v8) | same | `rgba(26,26,46,0.8)` | `rgba(255,255,255,0.32)` | — | — | — | — | — | — | — |
| `.cta-primary` | `<button>` app 1170, 1199, 1222, 1271, 1320, 1321, 1385, 1388 | `var(--ink)` | `var(--gold)` | `none` | `14px` | `'StarCrush', serif` | `13px` | — | `17px` | — |
| `.cta-primary:active` | same | — | — | — | — | — | — | — | — | — |
| `.cta-primary:disabled` | same | `rgba(26,26,46,0.45)` | `#B7C2C6` | — | — | — | — | — | — | — |
| `.cta-secondary` | `<button>` app 1171, 1200, 1223, 1276, 1277, 1322, 1323, 1397, 1401, 1406 | `var(--ink)` | `rgba(255,255,255,0.28)` | `1.5px solid rgba(255,255,255,0.5)` | `14px` | `'StarCrush', serif` | `13px` | — | `15px` | — |
| `.cta-secondary:active` | same | — | — | — | — | — | — | — | — | — |
| `.project-actions-secondary .cta-secondary` | app 1397–1406 | — | — | — | — | — | — | — | `13px 10px` | — |
| `.riff-btn` | `el('button','riff-btn','Generate options')` app 2170 | `var(--ink)` | `var(--gold)` | `none` | `100px` | `'StarCrush', serif` | `13px` | — | `13px 30px` | — |
| `.riff-btn:hover` / `:active` | same | — | — | — | — | — | — | — | — | — |
| `.riff-btn:disabled` | same | — | — | — | — | — | — | — | — | — |
| `.field-expand` | `el('button','field-expand')` app 2398 | `var(--ink)` | `rgba(201,168,76,0.12)` | `1.5px solid rgba(201,168,76,0.55)` | `100px` | `'Zen Kaku Gothic New', sans-serif` | `12px` | `700` | `6px 12px` | `margin-top: 10px` |
| `.field-expand:active` | same | — | `rgba(201,168,76,0.22)` | — | — | — | — | — | — | — |
| `.field-expand .chev` | `el('span','chev','▸')` app 2400 | `#8A6A15` | — | — | — | — | — | `700` | — | — |
| `.matrix-step` | `el('button','matrix-step','−'/'+')` app 2102–2103 | `var(--ink)` | `none` | `none` | `8px` | `'Zen Kaku Gothic New', sans-serif` | `17px` | `700` | `0` | — |
| `.matrix-step:active` | same | — | `rgba(26,26,46,0.08)` | — | — | — | — | — | — | — |
| `.matrix-x` | `el('button','matrix-x','✕')` app 2152 | `rgba(26,26,46,0.5)` | `none` | `none` | `8px` | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | — | — |
| `.matrix-x:active` | same | `var(--ink)` | `rgba(26,26,46,0.08)` | — | — | — | — | — | — | — |
| `.matrix-add` | `el('button','matrix-add','+ Add angle')` app 2051 | `var(--ink)` | `rgba(201,168,76,0.10)` | `1.5px dashed rgba(201,168,76,0.6)` | `12px` | `'Zen Kaku Gothic New', sans-serif` | `13px` | `700` | `10px 15px` | — |
| `.matrix-add:active` | same | — | `rgba(201,168,76,0.22)` | — | — | — | — | — | — | — |
| `.matrix-angle` | `el('button','matrix-angle')` app 2082 | `var(--ink)` | `rgba(255,255,255,0.82)` | `1.5px solid rgba(26,26,46,0.14)` | `10px` | `'StarCrush', serif` | `14px` | — | `11px 13px` | — |
| `.matrix-angle:active` | same | — | `#fff` | — | — | — | — | — | — | — |
| `button.asset-card-header` | `el('button','asset-card-header')` app 2271 (when `opts.collapsible`) | `inherit` | — | `border-left: none; border-right: none` | `0` | `font: inherit` | — | — | — | — |
| `button.asset-card-header:active` | same | — | `rgba(201,168,76,0.14)` | — | — | — | — | — | — | — |
| `.card-close` (legacy) | declared; no markup found | `var(--muted)` | `none` | `none` | `6px` | — | `20px` | — | `2px 6px` | — |
| `.card-close:hover` | — | `#8a1f1f` | `var(--soft)` | — | — | — | — | — | — | — |
| `.project-card .open-link` (legacy) | declared; no markup found | `var(--ink)` | `var(--soft)` | `1px solid var(--line)` | `8px` | — | `14px` | `600` | `8px 12px` | — |

### 7.4 App — modal buttons

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.modal-btn` | `<button>` app 1434, 1446, 1459 | `var(--ink)` | `var(--gold)` | `none` | `14px` | `'StarCrush', serif` | `13px` | — | `18px` | — |
| `.modal-btn:active` / `:disabled` | same | — | — | — | — | — | — | — | — | — |
| `.modal-cancel` | `<button>` app 1435, 1447 | `rgba(26,26,46,0.5)` | `transparent` | `none` | — | `'StarCrush', serif` | `12px` | — | `14px` | `margin-top: 10px` |

### 7.5 Settings buttons

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `button.btn` (legacy) | `<button class="btn">` throughout settings | `#fff` | `var(--ink)` | `none` | `8px` | `'Zen Kaku Gothic New', sans-serif` / `font: inherit` | — | `600` | `11px 16px` | — |
| `button.btn` (v8) | same | `var(--ink)` | `var(--gold)` | `none` | `12px` | `'StarCrush', serif` | `12px` | — | `14px 18px` | — |
| `button.btn:active` | same | — | — | — | — | — | — | — | — | — |
| `button.btn:disabled` | same | — | — | — | — | — | — | — | — | — |
| `button.btn.secondary` (legacy) | `<button class="btn secondary">` ×~15 | `var(--ink)` | `var(--soft)` | `1px solid var(--line)` | — | — | — | — | — | — |
| `button.btn.secondary` (v8) | same | `var(--ink)` | `rgba(255,255,255,0.25)` | `1.5px solid rgba(255,255,255,0.45)` | — | — | — | — | — | — |
| `button.btn.danger` (legacy) | `<button class="btn danger" id="signout-btn">` settings 939 | `#8a1f1f` | `#fdf0f0` | `1px solid #e7b3b3` | — | — | — | — | — | — |
| `button.btn.danger` (v8) | same | `#C0392B` | `rgba(192,57,43,0.08)` | `1.5px solid rgba(192,57,43,0.25)` | — | — | — | — | — | — |
| `#voice-view .btnrow .btn` | `<button class="btn secondary">` settings 789–791 | — | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `10px` | — | `11px 8px` | — |
| `.btnrow` (legacy / v8) | `<div class="btnrow">` throughout | — | — | — | — | — | — | — | — | `margin-top: 14px` |
| `.hdr-iconbtn` | `el('button','hdr-iconbtn')` settings 3067, 3079 | `var(--muted)` | `transparent` | `1px solid var(--line)` | `6px` | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | — | — |
| `.hdr-iconbtn:hover` | same | `var(--ink, #1a1a2e)` | — | `border-color: var(--accent)` | — | — | — | — | — | — |
| `.lib-editbtn` | `el('button','lib-editbtn')` settings 1304 | `rgba(26,26,46,0.7)` | `rgba(255,255,255,0.5)` | `1.5px solid rgba(255,255,255,0.7)` | `999px` | `'Zen Kaku Gothic New', sans-serif` | `12px` | `600` | `5px 12px` | `margin-top: -2px` |
| `.lib-editbtn:hover` | same | `var(--ink)` | — | `border-color: rgba(26,26,46,0.3)` | — | — | — | — | — | — |
| `.lib-fdel` | `el('button','lib-fdel','×')` settings 1740 | `rgba(26,26,46,0.4)` | `none` | `none` | — | `'Zen Kaku Gothic New', sans-serif` | `20px` | — | `6px 10px` | — |
| `.lib-fdel:hover` | same | `#8a1f1f` | — | — | — | — | — | — | — | — |
| `.lib-fnotebtn` | `el('button','lib-fnotebtn','+ Add a writing note')` settings 1512, 1786 | `rgba(26,26,46,0.75)` | `rgba(255,255,255,0.28)` | `1.5px dashed rgba(26,26,46,0.22)` | `9px` | `'Zen Kaku Gothic New', sans-serif` | `12px` | `600` | `9px 10px` | `margin-top: 6px` |
| `.lib-fnotebtn:hover` | same | `var(--ink)` | — | `border-color: rgba(26,26,46,0.4)` | — | — | — | — | — | — |
| `.lib-newbtn` | `<div class="lib-newbtn">` settings 892 (wrapper) | — | — | — | — | — | — | — | — | `14px 0 4px` |
| `.cf-open` | `el('button','cf-open')` settings 2214, 2375 | `var(--fg)` (undefined) | `none` | `1px solid var(--line)` | `6px` | `'Zen Kaku Gothic New', sans-serif` / `font: inherit` | `12px` | — | `3px 9px` | `margin-left: 8px` |
| `.cf-open:hover` | same | — | — | `border-color: var(--fg)` (undefined) | — | — | — | — | — | — |
| `.hdr-addfield` | `<div class="btnrow hdr-addfield">` settings 981, 1022 | — | — | — | — | — | — | — | — | `margin-top: 6px` |

### 7.6 Onboarding buttons

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `button` | every `<button>` in onboarding | `var(--ink)` | `var(--gold)` | `none` | `12px` | `'StarCrush', serif` | `12px` | — | `14px 18px` | — |
| `button:active` | same | — | — | — | — | — | — | — | — | — |
| `button:disabled` | same | — | — | — | — | — | — | — | — | — |
| `button.secondary` | `<button class="secondary">` onboarding 249, 290, 305, 311, 366 | `var(--ink)` | `rgba(255,255,255,0.25)` | `1.5px solid rgba(255,255,255,0.45)` | — | — | — | — | — | — |
| `button.ghost` | `<button class="ghost" id="slack-skip">` onboarding 353 | `rgba(26,26,46,0.6)` | `none` | `none` | — | — | — | — | `12px 0` | — |
| `.gbtn` | `<button class="gbtn full" id="signin-btn">` onboarding 225 | `var(--ink)` | `var(--white)` | `none` | — | — | — | — | — | — |
| `.gbtn .g` | `<span class="g">G</span>` onboarding 225 | `#06302f` | `var(--sky-btm)` | — | `50%` | `'Zen Kaku Gothic New', sans-serif` | `12px` | `700` | — | — |
| `.row` | `<div class="row">` ×10 | — | — | — | — | — | — | — | — | `margin-top: 20px` |
| `.regen button` | `<button class="secondary" id="voice-regen">` onboarding 311 | — | — | — | — | — | — | — | — | `margin-top: 10px` |

### 7.7 Admin buttons

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `button` | `<button>` admin 74–75 + JS 150, 151, 204, 311 | `var(--sky)` | `transparent` | `2px solid var(--sky)` | `8px` | `font: inherit` | — | `600` | `8px 14px` | — |
| `button.primary` | admin 74, JS 150, 204, 311 | `var(--navy)` | `var(--sky)` | — | — | — | — | — | — | — |
| `button.danger` | declared; no markup found | `var(--danger)` | — | `border-color: var(--danger)` | — | — | — | — | — | — |
| `button.warn` | JS 151 (`Dismiss`) | `var(--warn)` | — | `border-color: var(--warn)` | — | — | — | — | — | — |
| `button:disabled` | same | — | — | — | — | — | — | — | — | — |
| `.bar` | `<div class="bar">` admin 73 | — | — | — | — | — | — | — | — | `margin-bottom: 8px` |
| `.actions` (admin) | `el('div',{class:'actions'})` admin JS 149, 202, 310 | — | — | — | — | — | — | — | — | `margin-top: 10px` |

---

## 8. Form inputs (text, search, number, file)

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `input[type=text], input[type=number]` (admin) | inputs in the approve panel, admin JS ~180 | `var(--cream)` | `rgba(0,0,0,.25)` | `1px solid rgba(255,255,255,.2)` | `6px` | `font: inherit` | — | — | `5px 8px` | — |
| `input:disabled` (admin) | same, unchecked field rows | — | — | — | — | — | — | — | — | — |
| `input[type="text"], textarea` (settings legacy) | `#folder-input` settings 828, `#tpl-name` 915, JS-built inputs | — | — | `1px solid var(--line)` | `8px` | `'Zen Kaku Gothic New', sans-serif` / `font: inherit` | — | — | `11px 12px` | — |
| `input[type="text"], textarea` (settings v8) | same | `var(--ink)` | `rgba(255,255,255,0.5)` | `1.5px solid rgba(255,255,255,0.6)` | `12px` | — | — | — | `12px 14px` | — |
| `input:focus, textarea:focus` (settings legacy) | same | — | — | `border-color: var(--accent)` (+ `outline: 2px solid var(--accent)`) | — | — | — | — | — | — |
| `input:focus, textarea:focus` (settings v8) | same | — | — | `border-color: rgba(255,255,255,0.95)` (+ `outline: none`) | — | — | — | — | — | — |
| `input[type="text"], textarea` (onboarding) | `#folder-url` 247, `#voice-input` 288, `#voice-direction` 310 | `var(--ink)` | `rgba(255,255,255,0.5)` | `1.5px solid rgba(255,255,255,0.6)` | `12px` | `'Zen Kaku Gothic New', sans-serif` | `15px` | — | `12px 14px` | — |
| `input:focus, textarea:focus` (onboarding) | same | — | — | `border-color: rgba(255,255,255,0.95)` | — | — | — | — | — | — |
| `::placeholder` (onboarding) | all inputs | `rgba(26,26,46,0.4)` | — | — | — | — | — | — | — | — |
| `.picker-search` | `<input type="search">` app 1192 | `var(--ink)` | `rgba(255,255,255,0.52)` | `1.5px solid rgba(255,255,255,0.7)` | `14px` | `'Zen Kaku Gothic New', sans-serif` | `15px` | — | `14px 16px` | `0 0 16px` |
| `.picker-search::placeholder` | same | `rgba(26,26,46,0.4)` | — | — | — | — | — | — | — | — |
| `.search-input` | `<input type="text" id="history-search">` app 1332 | `var(--ink)` | `transparent` | `none` | — | `'Zen Kaku Gothic New', sans-serif` | `15px` | — | — | — |
| `.search-input::placeholder` | same | `rgba(26,26,46,0.38)` | — | — | — | — | — | — | — | — |
| `.confirm-count` | `<input>` built app 1270–1275 | `var(--ink)` | `rgba(255,255,255,0.7)` | `1.5px solid rgba(255,255,255,0.9)` | `10px` | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | `5px 8px` | `margin-left: auto` |
| `.hdr-field input, .hdr-block > input` | `<input>` in `el('div','hdr-field')` rows, settings 3071 / 3090 | — | — | `1px solid var(--line)` | `7px` | `'Zen Kaku Gothic New', sans-serif` / `font: inherit` | — | — | `7px 9px` | — |
| `.tpl-nameinput` | `<input type="text" id="tpl-name">` settings 915 | `var(--fg)` (undefined) | `var(--bg)` | `1px solid var(--line)` | `6px` | `'Zen Kaku Gothic New', sans-serif` / `font: inherit` | `14px` | — | `8px 10px` | — |
| `.cf-name` | `<input class="cf-name">` settings JS ~2313 | `var(--fg)` (undefined) | `var(--bg)` | `1px solid var(--line)` | `6px` | `'Zen Kaku Gothic New', sans-serif` / `font: inherit` | `13px` | — | `6px 8px` | — |
| `.cf-limit` | `<input class="cf-limit">` settings JS ~2330 | `var(--fg)` (undefined) | `var(--bg)` | `1px solid var(--line)` | `6px` | `'Zen Kaku Gothic New', sans-serif` / `font: inherit` | `13px` | — | `6px 8px` | — |
| `.lib-frow input[type="text"], .lib-frow input[type="number"], .lib-frow select, .lib-frow textarea` | inputs inside `el('div','lib-frow')`, settings 1407 / 1724 | `var(--ink)` | `rgba(255,255,255,0.5)` | `1.5px solid rgba(255,255,255,0.6)` | `9px` | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | `8px 9px` | — |
| `.lib-fctl input[type="number"]` | min/max inputs in a field row | — | — | — | — | — | — | — | — | — |
| `.lib-frow .lib-fname` | field-name `<input>` in a create/edit row | — | — | — | — | `'Zen Kaku Gothic New', sans-serif` | — | `600` | — | — |
| `.lib-new input[type="text"], .lib-new textarea` | inputs inside `el('div','lib-new')` | — | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `14px` | — | — | — |
| `.naming-seg select, .naming-seg input` | settings 2873 / 2886 / 2891 | — | `#fff` | `1px solid var(--line)` | `8px` | `'Zen Kaku Gothic New', sans-serif` / `font: inherit` | — | — | `8px 9px` | — |
| `#file-input` | `<input type="file" hidden>` app 1151 | — | — | — | — | — | — | — | — | — |
| `#tpl-file` | `<input type="file" class="hidden">` settings 911 | — | — | — | — | — | — | — | — | — |
| `#hdr-file` | `<input type="file" class="hidden">` settings 971 | — | — | — | — | — | — | — | — | — |

Labels that frame the inputs:

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `label` (settings legacy) | `<label>` settings 827, 914, 962 … | — | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `14px` | `600` | — | `14px 0 6px` |
| `label` (settings v8) | same | `var(--ink)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `13px` | `500` | — | — |
| `label` (onboarding) | `<label>` onboarding 246, 287, 309 | `rgba(26,26,46,0.75)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | `600` | — | `16px 0 6px` |
| `.lib-new label` | `<label>` inside the create-asset box | `rgba(26,26,46,0.65)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | `600` | — | `12px 0 4px` |
| `.tpl-namerow label` | `<label for="tpl-name">` settings 914 | `var(--muted)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | — | `margin-bottom: 4px` |
| `.lib-fnotelab` | `el('span','lib-fnotelab')` settings 1510, 1780 | `rgba(26,26,46,0.75)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11px` | `700` | — | `margin-bottom: 4px` |

---

## 9. Textareas

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `textarea` (app legacy) | any `<textarea>` in the app | — | — | `1px solid var(--line)` | `8px` | `font: inherit` | — | — | `12px` | — |
| `textarea:focus` (app legacy) | same | — | — | `border-color: var(--accent)` (+ `outline: 2px solid var(--accent)`) | — | — | — | — | — | — |
| `.glass-textarea` | `<textarea id="brief">` app 1148 | `var(--ink)` | `transparent` | `none` | — | `'Zen Kaku Gothic New', sans-serif` | `15px` | `400` | `18px 18px 14px` | — |
| `.glass-textarea:focus` | same | — | — | `none` | — | — | — | — | — | — |
| `.glass-textarea::placeholder` | same | `rgba(26,26,46,0.4)` | — | — | — | — | `14px` | — | — | — |
| `.regen-input` (app legacy) | selector declared; the live direction inputs are the modal textareas | — | — | `1px solid var(--line)` | `8px` | `font: inherit` | — | — | `10px` | — |
| `.regen-input` (app v8) | same selector | `var(--ink)` | `rgba(255,255,255,0.5)` | `1.5px solid rgba(255,255,255,0.6)` | `14px` | `'Zen Kaku Gothic New', sans-serif` | `15px` | — | `14px 16px` | — |
| `.regen-input:focus` | same | — | — | `border-color: rgba(255,255,255,0.9)` | — | — | — | — | — | — |
| `.regen-input::placeholder` | same | `rgba(26,26,46,0.4)` | — | — | — | — | — | — | — | — |
| `.modal-textarea` | `<textarea>` app 1433, 1445 | `var(--ink)` | `rgba(255,255,255,0.25)` | `none`, then `1.5px solid rgba(255,255,255,0.45)` (both declared in the one rule) | `14px` | `'Zen Kaku Gothic New', sans-serif` | `15px` | — | `14px 16px` | `margin-bottom: 14px` |
| `.modal-textarea::placeholder` | same | `rgba(26,26,46,0.4)` | — | — | — | — | — | — | — | — |
| `textarea.terminal` (settings legacy) | `<textarea class="terminal" id="voice-editor">` settings 794 | `var(--cream)` | `var(--navy)` | — | `8px` | `'Zen Kaku Gothic New', sans-serif` | `14px` | — | `24px` | — |
| `textarea.terminal` (settings v8) | same | `rgba(255,255,255,0.85)` | `rgba(26,26,46,0.9)` | `1.5px solid rgba(77,217,217,0.2)` | `14px` | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | `20px` | — |
| `textarea.terminal:focus` | same | — | — | `border-color: rgba(77,217,217,0.45)` (+ `outline: none`) | — | — | — | — | — | — |
| `textarea` (onboarding) | `#voice-input` 288, `#voice-direction` 310, `#voice-edit` 303 | `var(--ink)` | `rgba(255,255,255,0.5)` | `1.5px solid rgba(255,255,255,0.6)` | `12px` | `'Zen Kaku Gothic New', sans-serif` | `15px` | — | `12px 14px` | — |
| `#voice-edit` (onboarding) | `<textarea id="voice-edit" class="hidden">` onboarding 303 | `rgba(255,255,255,0.85)` | `rgba(26,26,46,0.9)` | `1.5px solid rgba(77,217,217,0.2)` | `14px` | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | — | — |
| `#voice-edit:focus` | same | — | — | `border-color: rgba(77,217,217,0.45)` | — | — | — | — | — | — |
| `.regen textarea` (onboarding) | `#voice-direction` onboarding 310 | — | — | — | — | — | — | — | — | — |
| `.lib-paste` | paste-a-field-list textarea, settings JS | — | — | — | — | — | — | — | — | — |
| `.lib-fnote` | writing-note textarea, settings JS | — | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12.5px !important` | — | — | — |
| `.lib-new textarea` | textareas inside the create box | — | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | — | — |

Heights, recorded because they are the visible shape: `.glass-textarea`
`min-height:176px` / `max-height:416px`; `textarea` (app legacy) `min-height:160px`;
`.regen-input` legacy `min-height:64px`, v8 `min-height:80px`; `.modal-textarea`
`min-height:120px`; `textarea.terminal` legacy `min-height:320px`, v8
`min-height:420px`; `#voice-edit` `min-height:320px`; `textarea` (onboarding)
`min-height:96px`; `.regen textarea` `min-height:60px`; `.lib-paste`
`min-height:172px`; `.lib-fnote` `min-height:54px`.

---

## 10. Selects

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.status-select` | declared in app CSS; no markup found | `var(--ink)` | `#fff` | `1px solid var(--line)` | `6px` | `font: inherit` | `13px` | — | `5px 7px` | — |
| `.hdr-field select` | `<select>` in a `.hdr-field` row, settings 3071 / 3090 | — | `#fff` | `1px solid var(--line)` | `7px` | `'Zen Kaku Gothic New', sans-serif` / `font: inherit` | — | — | `7px 6px` | — |
| `.cf-unit` | `<select class="cf-unit">` settings JS ~2338 | `var(--fg)` (undefined) | `var(--bg)` | `1px solid var(--line)` | `6px` | `'Zen Kaku Gothic New', sans-serif` / `font: inherit` | `12px` | — | `6px 4px` | — |
| `.lib-funit` | `el('span','lib-funit')` settings 1757 (wrapper) | — | — | — | — | — | — | — | — | — |
| `.lib-funit::after` | pseudo caret `▾` | `rgba(26,26,46,0.55)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11px` | — | — | — |
| `.lib-funit select` | `<select>` inside that wrapper | — | `rgba(255,255,255,0.78)` | `border-color: rgba(26,26,46,0.18)` | — | `'Zen Kaku Gothic New', sans-serif` | — | `600` | `padding-right: 22px` | — |
| `.lib-funit.locked::after` | pseudo, on a locked row — `display: none` | — | — | — | — | — | — | — | — | — |
| `.lib-funit.locked select` | `el('span','lib-funit locked')` settings 1482 | `rgba(26,26,46,0.55)` | `rgba(26,26,46,0.05)` | `border-color: transparent` | — | — | — | — | `padding-right: 12px` | — |
| `.naming-seg select` | `el('select','naming-type'/'naming-val')` settings 2873 / 2886 | — | `#fff` | `1px solid var(--line)` | `8px` | `'Zen Kaku Gothic New', sans-serif` / `font: inherit` | — | — | `8px 9px` | — |
| `.naming-seg .naming-type` / `.naming-seg .naming-val` | the two selects / the text input in a segment row | — | — | — | — | — | — | — | — | — |
| `.lib-frow select` | shares the `.lib-frow input…select…textarea` rule | `var(--ink)` | `rgba(255,255,255,0.5)` | `1.5px solid rgba(255,255,255,0.6)` | `9px` | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | `8px 9px` | — |

---

## 11. Checkboxes, toggles, sliders

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.closed-toggle` (app legacy) | `<label class="closed-toggle">` app 1345 | `var(--muted)` | — | — | — | — | `14px` | — | — | `margin-top: 18px` |
| `.closed-toggle` (app v8) | same | `rgba(26,26,46,0.62)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | — | `margin-top: 16px` |
| `#show-closed` | `<input type="checkbox">` app 1345 | — | — | — | — | — | — | — | — | — |
| `.picker-row` | `<label>` built app 1200–1201 | — | `rgba(255,255,255,0.5)` | `1.5px solid rgba(255,255,255,0.75)` | `12px` | — | — | — | `13px 15px` | `margin-bottom: 8px` |
| `.picker-row:active` | same | — | `rgba(201,168,76,0.10)` | — | — | — | — | — | — | — |
| `.picker-row.checked` | box checked, app 2670 | — | `rgba(201,168,76,0.16)` | `border-color: rgba(201,168,76,0.7)` | — | — | — | — | — | — |
| `.picker-row input` | `<input type="checkbox">` app 1202 | — | — | — | — | — | — | — | — | `0` |
| `.picker-row-name` | `el('span','picker-row-name')` app 2674 | `var(--ink)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `14.5px` | — | — | — |
| `.cf-tick` | `el('label','cf-tick')` settings 2303 | — | — | — | — | — | — | — | `padding-top: 6px` | — |
| `.cf-tick input` | `<input type="checkbox">` inside it | — | — | — | — | — | — | — | — | — |
| `.toggle` (onboarding) | `<label class="toggle">` built in JS | — | — | — | — | — | — | — | — | — |
| `.toggle input` | `<input type="checkbox">` inside it | — | — | — | — | — | — | — | — | — |
| `.track` | `<span class="track">` | — | `rgba(26,26,46,0.2)` | — | `999px` | — | — | — | — | — |
| `.track::before` | pseudo thumb | — | `#fff` | — | `50%` | — | — | — | — | — |
| `.toggle input:checked + .track` | on | — | `var(--sky-btm)` | — | — | — | — | — | — | — |
| `.toggle input:checked + .track::before` | on | — | — | — | — | — | — | — | — | — |
| `.lib-toggle` | `el('label','lib-toggle')` settings 1230 | — | — | — | — | — | — | — | — | `margin-top: 1px` |
| `.lib-toggle input` | `<input type="checkbox">` inside it | — | — | — | — | — | — | — | — | — |
| `.lib-track` | `el('span','lib-track')` settings 1236 | — | `rgba(26,26,46,0.2)` | — | `999px` | — | — | — | — | — |
| `.lib-track::before` | pseudo thumb | — | `#fff` | — | `50%` | `'Zen Kaku Gothic New', sans-serif` | — | — | — | — |
| `.lib-toggle input:checked + .lib-track` | on | — | `var(--sky-btm)` | — | — | — | — | — | — | — |
| `.lib-toggle input:disabled + .lib-track` | mid-save (`opacity: 0.5`, `cursor: progress`) | — | — | — | — | — | — | — | — | — |
| `.var-range` | `<input type="range" class="var-range">` app 662–664 | — | `rgba(26,26,46,0.14)` | — | `100px` | — | — | — | — | `6px 0 2px` |
| `.var-range::-webkit-slider-thumb` | pseudo | — | `var(--gold)` | `2px solid #fff` | `50%` | — | — | — | — | — |
| `.var-range::-moz-range-thumb` | pseudo | — | `var(--gold)` | `2px solid #fff` | `50%` | — | — | — | — | — |
| `.var-range::-moz-range-track` | pseudo | — | `rgba(26,26,46,0.14)` | — | `100px` | — | — | — | — | — |
| `.var-range:active::-webkit-slider-thumb` | pseudo | — | — | — | — | — | — | — | — | — |
| `.field-check` | `el('span','field-check','✓')` app 2368 | `#1A1A2E` | `var(--gold)` | — | `50%` | — | `12px` | `700` | — | — |

Geometry: onboarding `.toggle` `44px × 26px`, thumb `20px`, travel
`translateX(18px)`; settings `.lib-toggle` `40px × 24px`, thumb `18px`, travel
`translateX(16px)`; `.var-range` track `5px` high, thumb `22px`;
`.picker-row input` `20px × 20px` with `accent-color: var(--gold)`;
`.cf-tick input` `16px × 16px`; `.field-check` `18px × 18px`.

---

## 12. Cards and list rows

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.asset` (app legacy) | declared; no markup found | — | — | `1px solid var(--line)` | `8px` | — | — | — | `12px 14px` | `10px 0` |
| `.asset h3` (app legacy) | declared; no markup found | — | — | — | — | — | `16px` | — | — | `0 0 8px` |
| `.field` (app legacy) | declared; no markup found | — | — | `border-top: 1px dashed var(--line)` | — | — | `14px` | — | `5px 0` | — |
| `.field .name` / `.field .limit` (legacy) | declared; no markup found | `var(--ink)` / `var(--muted)` | — | — | — | — | — | — | — | — |
| `.field .count` / `.field .count.over` (legacy) | declared; no markup found | — / `#c0392b` | — | — | — | — | — | — / `600` | — | — |
| `.asset-card` | `el('div','asset-card')` app 2261, 2729 | — | `rgba(255,255,255,0.52)` | `1.5px solid rgba(255,255,255,0.7)` | `16px` | — | — | — | `18px 18px 12px` | `margin-bottom: 12px` |
| `.glass-panel.list .asset-card` | same, inside a merged list panel | — | `none` | `none` | `0` | — | — | — | `padding-top: 0; padding-bottom: 8px; padding-left: 0; padding-right: 0` | `0` |
| `.glass-panel.list .asset-card + .asset-card` | consecutive cards | — | — | — | — | — | — | — | — | `margin-top: 14px` |
| `.asset-card.reveal` | after `classList.add('reveal')` app 2433, 3254 | — | — | — | — | — | — | — | — | — |
| `.glass-panel.list .asset-card.collapsed` | collapsed card in a list | — | — | — | — | — | — | — | `padding-bottom: 0` | — |
| `.asset-card.collapsed > .asset-direction`, `.asset-card.collapsed > .asset-field` | children of a collapsed card — `display: none` | — | — | — | — | — | — | — | — | — |
| `.asset-card-header` | `el('div' or 'button', 'asset-card-header')` app 2271, 2730 | — | — | — | — | — | — | — | — | `margin-bottom: 5px` |
| `.glass-panel.list .asset-card-header` | same, inside a merged list panel | — | `rgba(214,236,246,0.97)` | `border-top: 1px solid rgba(255,255,255,0.95)`; `border-bottom: 1px solid rgba(255,255,255,0.85)` | — | — | — | — | `10px 18px 9px` | `0 -18px 4px` |
| `.asset-card-name` | `el('span','asset-card-name')` app 2275, 2731 | `var(--ink)` | — | — | — | `'StarCrush', serif` | `13px` | — | — | — |
| `.glass-panel.list .asset-card-name` | same, in a list | — | — | — | — | — | `15px` | — | — | — |
| `.asset-card-count` | `el('span','asset-card-count')` app 2286 | `rgba(26,26,46,0.7)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11px` | `600` | — | — |
| `.asset-card-chev` | `el('span','asset-card-chev','▸')` app 2288 | `rgba(26,26,46,0.5)` | — | — | — | — | `13px` | — | — | — |
| `.asset-field` | `el('div','asset-field has-copy')` app 2312, `el('div','asset-field')` 2348 | — | — | `border-top: 1px solid rgba(26,26,46,0.06)` | — | — | — | — | `10px 0` | — |
| `.glass-panel.list .asset-card-header + .asset-field` | first row after a band | — | — | — | — | — | — | — | `padding-top: 16px` | — |
| `.asset-field.selectable` | when `opts.selectable`, app 2367 | — | — | — | `10px` | — | — | — | `padding-left: 10px; padding-right: 10px` | `0 -10px` |
| `.asset-field.selectable:active` | same | — | `rgba(201,168,76,0.08)` | — | — | — | — | — | — | — |
| `.asset-field.selected` | app 2410 / 2413 | — | `rgba(201,168,76,0.14)` | `box-shadow: inset 0 0 0 1.5px rgba(201,168,76,0.85)` | — | — | — | — | — | — |
| `.asset-field.selected .field-name` | same | `var(--ink)` | — | — | — | — | — | `600` | — | — |
| `.asset-field.selectable.has-copy` | both | — | — | — | — | — | — | — | `padding-top: 12px` | — |
| `.field-name` | `el('span','field-name')` app 2313, 2349 | `rgba(26,26,46,0.72)` | — | — | — | `'StarCrush', serif` | `13px` | — | — | — |
| `.field-count` | `el('span','field-count')` app 2341, 2353 | `rgba(26,26,46,0.32)` | `rgba(26,26,46,0.05)` | — | `6px` | `'Zen Kaku Gothic New', sans-serif` | `12px` | `600` | `2px 8px` | — |
| `.field-char` | `el('span','field-char')` app 2333 | `rgba(26,26,46,0.35)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11px` | — | — | — |
| `.field-char.over` | app 2337–2338 | `#c0392b` | — | — | — | — | — | `600` | — | — |
| `.field-char.placeholder` | `el('span','field-char placeholder','Not yet drafted')` app 2351 | — | — | — | — | — | — | — | — | — |
| `.field-meta` | `el('div','field-meta')` app 2315 | — | — | — | — | — | — | — | — | — |
| `.doc-row` | `el('button' or 'div', 'doc-row')` app 2563, 4026 | `var(--ink)` | `rgba(255,255,255,0.52)` | `1.5px solid rgba(255,255,255,0.7)` | `16px` | `'Zen Kaku Gothic New', sans-serif` | — | — | `14px 16px` | `margin-bottom: 10px` |
| `.glass-panel.list .doc-row` | same, in a merged list panel | — | `none` | `none` | `0` | — | — | — | `padding-top: 12px; padding-bottom: 12px; padding-left: 0; padding-right: 0` | `0` |
| `.glass-panel.list .doc-row + .doc-row` | consecutive rows | — | — | `border-top: 1px solid rgba(255,255,255,0.6)` | — | — | — | — | — | — |
| `.glass-panel.list .field-select-hint + div > .doc-row:first-child` | first row after the hint | — | — | `border-top: 1px solid rgba(255,255,255,0.6)` | — | — | — | — | — | — |
| `.doc-row:active` | same | — | `rgba(201,168,76,0.10)` | `border-color: rgba(201,168,76,0.55)` | — | — | — | — | — | — |
| `.doc-row.failed` | `r.built === false`, app 2563 | — | `rgba(192,57,43,0.05)` | `border-color: rgba(192,57,43,0.35)` | — | — | — | — | — | — |
| `.doc-row .doc-row-body` | `el('div','doc-row-body')` app 2565, 4028 | — | — | — | — | — | — | — | — | — |
| `.doc-row .doc-row-kind` | `el('span','doc-row-kind')` app 2566, 4029 | `var(--ink)` (`opacity: 0.75`) | — | — | — | `'StarCrush', serif` | `11px` | `400` | — | `margin-bottom: 3px` |
| `.doc-row .doc-row-name` | `el('span','doc-row-name')` app 2567, 4030 | — | — | — | — | `'StarCrush', serif` | `14px` | — | — | — |
| `.doc-row .doc-row-note` | `el('span','doc-row-note')` app 2569 | `rgba(26,26,46,0.5)` | — | — | — | — | `12px` | — | — | `margin-top: 4px` |
| `.doc-row.failed .doc-row-note` | failed row | `#a5382a` | — | — | — | — | — | — | — | — |
| `.doc-row .doc-row-go` | `el('span','doc-row-go','›')` app 2574, 4032 | `rgba(26,26,46,0.35)` | — | — | — | — | `18px` | — | — | — |
| `.project-card` (app legacy) | `el('div','project-card')` app 3544 | — | — | `1px solid var(--line)` | `8px` | — | — | — | `14px` | `10px 0` |
| `.project-card` (app v8) | same | — | `rgba(255,255,255,0.5)` | `1.5px solid rgba(255,255,255,0.68)` | `16px` | — | — | — | `16px 18px` | `margin-bottom: 10px` |
| `.project-card:hover` (legacy) | same | — | — | `border-color: var(--accent)` | — | — | — | — | — | — |
| `.project-card.closed` | closed project — legacy `opacity: 0.6`, v8 `opacity: 0.55` | — | — | — | — | — | — | — | — | — |
| `.project-card-top` | `el('div','project-card-top')` app 3546 | — | — | — | — | — | — | — | — | `margin-bottom: 6px` |
| `.project-card-name` | `el('span','project-card-name')` app 3547 | `var(--ink)` | — | — | — | `'StarCrush', serif` | `13px` | — | — | — |
| `.project-card-meta` | `el('div','project-card-meta')` app 3556 | — | — | — | — | — | — | — | — | — |
| `.meta-date, .meta-assets` | `el('span','meta-date')` app 3558; **no `.meta-assets` markup found** | `rgba(26,26,46,0.5)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | `500` | — | — |
| `.meta-divider` | declared; **no markup found** | — | `rgba(26,26,46,0.3)` | — | `50%` | — | — | — | — | — |
| `.project-card .meta` / `.pname` / `.pdate` / `.right` / `.open-link` (legacy) | declared; no markup found | — / — / `var(--muted)` / — / `var(--ink)` | — / — / — / — / `var(--soft)` | — / — / — / — / `1px solid var(--line)` | — / — / — / — / `8px` | — | — / `16px` / `13px` / — / `14px` | — / `600` / — / — / `600` | — / — / — / — / `8px 12px` | — |
| `.card` (settings legacy) | `<div class="card">` settings 822, 838, 848, 857, 867, 874, 929, 932, 935 | — | — | `1px solid var(--line)` | `8px` | — | — | — | `14px 16px` | `12px 0` |
| `.card` (settings v8) | same | — | `rgba(255,255,255,0.5)` | `1.5px solid rgba(255,255,255,0.68)` | `14px` | — | — | — | `14px 18px` | `8px 0` |
| `.card .row` | `<div class="row">` inside a card | — | — | — | — | `'Zen Kaku Gothic New', sans-serif` | — | — | — | — |
| `.card .k` (legacy / v8) | `<span class="k">` / `<div class="k">` | v8 `var(--ink)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | v8 `14px` | legacy `600`, v8 `500` | — | — |
| `.card .v` (legacy / v8) | `<span class="v">` / `<div class="v">` | legacy `var(--muted)`, v8 `rgba(26,26,46,0.5)` | — | — | — | v8 `'Zen Kaku Gothic New', sans-serif` | v8 `12px` | — | — | — |
| `.conn-row` / `.conn-logo` / `.conn-meta` | settings 839 / 840 / 841, 849 / 850 / 851, 858 / 859 / 860, 868 / 869 / 870, 875 / 876 / 877 | — | — | — | — | — | — | — | — | — |
| `.conn-row .k` | `<div class="k">` in a conn row | — | — | — | — | `'StarCrush', serif` | — | — | — | — |
| `.lib-asset` | `el('div','lib-asset')` settings 1216 | — | `rgba(255,255,255,0.5)` | `1.5px solid rgba(255,255,255,0.68)` | `14px` | — | — | — | `12px 16px` | `10px 0` |
| `.lib-asset.off` | `a.is_active` false — `opacity: 0.6` | — | — | `border-style: dashed` | — | — | — | — | — | — |
| `.lib-head` / `.lib-headtext` | settings 1221 / 1224 | — | — | — | — | — | — | — | — | — |
| `.lib-name` | `el('span','lib-name')` settings 1225 | `var(--ink)` | — | — | — | `'StarCrush', serif` | `15px` | `normal` | — | — |
| `.lib-group` | `el('span','lib-group')` settings 1226 | `rgba(26,26,46,0.75)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11px` | — | — | — |
| `.lib-dir` | `el('div','lib-dir')` settings 1316 | `rgba(26,26,46,0.75)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | — | `margin-top: 4px` |
| `.lib-fields` | `el('ul','lib-fields')` settings 1317 | — | — | — | — | — | — | — | `0` | `8px 0 0` |
| `.lib-field` | `el('li','lib-field')` settings 1329 | — | — | `border-top: 1px solid rgba(255,255,255,0.55)` | — | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | `5px 0` | — |
| `.lib-field:first-child` | first row | — | — | `border-top: none` | — | — | — | — | — | — |
| `.lib-field.grouped` | field carrying `group_label` | — | — | — | — | — | — | — | — | `margin-left: 14px` |
| `.lib-grouplabel + .lib-field` | first row under a group label | — | — | `border-top: none` | — | — | — | — | `padding-top: 3px` | — |
| `.lib-fname` | `el('span','lib-fname')` settings 1332 | `var(--ink)` | — | — | — | — | — | — | — | — |
| `.lib-fname.static` | `el('span','lib-fname static')` settings 1430 | — | — | — | — | — | `14px` | `600` | `6px 0` | `margin-right: 8px` |
| `.lib-limit` | `el('span','lib-limit')` settings 1334, 1453 | `rgba(26,26,46,0.75)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | — | — |
| `.lib-sub` | `el('div','lib-sub')` settings 1343 | `rgba(26,26,46,0.75)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11px` | — | — | `margin-top: 2px` |
| `.lib-frow` | `el('div','lib-frow')` settings 1407, 1724 | — | — | `border-top: 1px solid rgba(255,255,255,0.55)` | — | — | — | — | `padding-top: 10px` | `margin-top: 10px` |
| `.lib-frow:first-child` | first row | — | — | `border-top: none` | — | — | — | — | — | — |
| `.lib-frow.locked` | non-editable row — `opacity: 0.6` | — | — | — | — | — | — | — | — | — |
| `.lib-frow.dirty` | row the user edited | — | `rgba(255,255,255,0.22)` | `border-left: 2px solid rgba(26,26,46,0.3)` | `0 9px 9px 0` | — | — | — | `padding-left: 8px` | `margin-left: -10px` |
| `.lib-fhead` / `.lib-fctl` | settings 1429 / 1736, 1469 / 1747 | — | — | — | — | — | — | — | — | `.lib-fctl margin-top: 6px` |
| `.lib-fstatic` | `el('div','lib-fstatic')` settings 1452 | — | — | — | — | — | — | — | `2px 0 0` | — |
| `.lib-sep` | `el('span','lib-sep','to')` settings 1495, 1768 | `rgba(26,26,46,0.45)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | — | — |
| `.lib-reset` | `el('div','lib-reset')` settings 1533; `:empty` → `display: none` | — | — | — | — | — | — | — | — | `margin-top: 6px` |
| `.lib-fnotewrap` | settings 1509, 1779 | — | — | — | — | — | — | — | — | `margin-top: 6px` |
| `.lib-new` | `el('div','lib-new')` settings 1594, 1829 | — | `rgba(255,255,255,0.5)` | `1.5px solid rgba(255,255,255,0.68)` | `14px` | — | — | — | `16px 18px` | `12px 0` |
| `.tpl-card` | `el('div','tpl-card')` settings 2131 | — | `rgba(255,255,255,0.5)` | `1.5px solid rgba(255,255,255,0.68)` | `14px` | — | — | — | `14px 16px` | `14px 0` |
| `.tpl-head` / `.tpl-name` | settings 2132 / 2133 | — / `var(--ink)` | — | — | — | — / `'StarCrush', serif` | — / `15px` | — / `normal` | — | — |
| `.tpl-marks` | `el('ul','tpl-marks')` settings 2219 | — | — | — | — | — | — | — | `0` | `10px 0 0` |
| `.tpl-mark` | `el('li','tpl-mark')` settings 2221 | — | — | `border-top: 1px solid rgba(255,255,255,0.55)` | — | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | `6px 0` | — |
| `.tpl-mark:first-child` | first | — | — | `border-top: none` | — | — | — | — | — | — |
| `.tpl-token` | `el('span','tpl-token')` settings 2223 | `var(--ink)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12.5px` | — | — | — |
| `.tpl-count` | `el('span','tpl-count')` settings 2224 | `rgba(26,26,46,0.75)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11px` | — | — | `margin-left: 6px` |
| `.tpl-where` | `el('span','tpl-where')` settings 2228 | `rgba(26,26,46,0.75)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11px` | — | — | `margin-top: 2px` |
| `.cf-row` | `el('div','cf-row')` settings 2301 | — | — | `border-bottom: 1px solid var(--line)` | — | — | — | — | `9px 0` | — |
| `.cf-row:last-of-type` | last row | — | — | `border-bottom: 0` | — | — | — | — | — | — |
| `.cf-row.off .cf-name`, `.cf-row.off .cf-limit` | `is_copy` unticked — `opacity: 0.45` | — | — | — | — | — | — | — | — | — |
| `.cf-main` | `el('div','cf-main')` settings 2311 | — | — | — | — | — | — | — | — | — |
| `.cf-marker` | `el('span','cf-marker')` settings 2312 | `var(--muted)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11px` | — | — | `margin-bottom: 3px` |
| `.cf-meta` | `el('div','cf-meta')` settings 2345 | `var(--muted)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11px` | — | `padding-left: 26px` | — |
| `.cf-meta b` | `<b>` inside it | `var(--fg)` (undefined) | — | — | — | `'Zen Kaku Gothic New', sans-serif` | — | `500` | — | — |
| `.card` (admin) | `el('div',{class:'card'})` admin JS 142 | — | `rgba(255,255,255,.05)` | `1px solid rgba(255,255,255,.12)` | `12px` | — | — | — | `16px` | `margin-bottom: 12px` |
| `.card.test` (admin) | `f.is_test` true | — | — | `border-style: dashed` (`opacity:.9`) | — | — | — | — | — | — |
| `.row` (admin) | `el('div',{class:'row'})` admin JS 143 | — | — | — | — | — | — | — | — | — |
| `.asset-row` (onboarding) | `className = 'asset-row'` in JS | `var(--ink)` | — | `border-top: 1px solid rgba(26,26,46,0.1)` | — | — | `15px` | — | `10px 0` | — |
| `.group` (onboarding) | `className = 'group'` in JS | — | `rgba(255,255,255,0.45)` | `1.5px solid rgba(255,255,255,0.6)` | `14px` | — | — | — | `6px 16px 12px` | `12px 0` |
| `.tool` (onboarding) | `<div class="tool">` onboarding 325, 337 | — | `rgba(255,255,255,0.35)` | `1.5px solid rgba(255,255,255,0.55)` | `14px` | — | — | — | `16px` | — |
| `.tool.soon` | `<div class="tool soon">` onboarding 337 — `opacity: 0.55` | — | — | — | — | — | — | — | — | — |
| `.tool-left` / `.tool-logo` | onboarding 326 / 327, 338 / 339 | — | — | — | — | — | — | — | — | — |
| `.tool-name` | `<div>` onboarding 328, 340 | `var(--ink)` | — | — | — | `'StarCrush', serif` | `15px` | — | — | — |
| `.tool-bullets` | `<ul>` onboarding 331, 343 | — | — | — | — | — | — | — | `0` | `0` |
| `.tool-bullets li` | `<li>` ×6 | `var(--ink)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | `padding-left: 16px` | — |
| `.tool-bullets li::before` | pseudo marker, `5px × 5px` | — | `var(--sky-btm)` | — | `1px` | — | — | — | — | — |
| `.tools` | `<div class="tools">` onboarding 324 | — | — | — | — | — | — | — | — | `20px auto 4px` |
| `.matrix` / `.matrix-row` | `el('div','matrix')` app 2039 / `el('div','matrix-row')` 2076 | — | — / `rgba(255,255,255,0.14)` | — / `1.5px solid rgba(255,255,255,0.4)` | — / `14px` | — | — | — | — / `13px` | — |
| `.matrix-controls` / `.matrix-intensity` / `.matrix-ticks` | app 2099 / 2123 / 2129 | — | — | — | — | — | — | — | — | — |
| `.matrix-count` | `el('div','matrix-count')` app 2101 | — | `rgba(255,255,255,0.82)` | `1.5px solid rgba(26,26,46,0.14)` | `10px` | — | — | — | `2px` | — |
| `.matrix-count-val` | `el('span','matrix-count-val')` app 2105 | `var(--ink)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `14px` | `700` | — | — |
| `.matrix-tick` | `el('span','matrix-tick')` app 2131 | `rgba(26,26,46,0.55)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `10.5px` | `600` | — | — |
| `.matrix-tick.on` | selected stop, app 2132 / 2141 | `var(--ink)` | — | — | — | — | — | `700` | — | — |
| `.matrix-angle-label` | `el('span','matrix-angle-label')` app 2084 | — no rule declared | — | — | — | — | — | — | — | — |
| `.riff-row` | `el('div','riff-row')` app 2169 | — | — | — | — | — | — | — | — | `margin-top: 16px` |
| `.riff-divider` | `el('div','riff-divider')` app 2206 | — | — | — | — | — | — | — | — | `10px 0 4px` |
| `.riff-divider::before`, `.riff-divider::after` | pseudo rules, `1px` high | — | `rgba(26,26,46,0.12)` | — | — | — | — | — | — | — |
| `.picker-group` | `el('div','picker-group')` app 2659 | — | — | — | — | — | — | — | — | `margin-bottom: 18px` |
| `.var-controls` | `el('div','var-controls')` app 2026 | — | — | `border-top: 1px dashed rgba(201,168,76,0.4)` | — | — | — | — | `padding-top: 10px` | `margin-top: 10px` |
| `.asset-field.expanded .var-controls` | expanded field — `display: flex` | — | — | — | — | — | — | — | — | — |

---

## 13. Containers and panels

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.glass-card` | `<div class="glass-card">` app 1147 — the only consumer | — | `rgba(255,255,255,0.30)` | `1.5px solid rgba(255,255,255,0.38)` | `18px` | — | — | — | — | — |
| `.card-footer` | `<div class="card-footer">` app 1149 | — | — | `border-top: 1px solid rgba(255,255,255,0.22)` | — | — | — | — | `10px 14px 12px` | — |
| `.glass-panel` | `<div class="glass-panel …">` app 1229, 1240, 1246, 1257, 1292, 1359, 1371; `el('div','glass-panel run')` 1832, 4079; `el('div','glass-panel list')` 4094 | — | `rgba(255,255,255,0.52)` | `1.5px solid rgba(255,255,255,0.7)` | `16px` | — | — | — | — | — |
| `.glass-panel.run` | run variant | — | — | — | — | — | — | — | `16px 18px` | `margin-bottom: 14px` |
| `.glass-panel.run > *:last-child` | last child | — | — | — | — | — | — | — | — | `margin-bottom: 0` |
| `.glass-panel.list` | list variant | — | — | — | — | — | — | — | `16px 18px 6px` | `margin-bottom: 14px` |
| `.output-header` | `<div class="output-header">` app 1184, 1205, and `output-header glass-panel` 1229, 1292, 1359 | — | — | — | — | — | — | — | — | `margin-bottom: 22px` |
| `.output-header.glass-panel` | app 1229, 1292, 1359 | — | — | — | — | — | — | — | `14px 16px` | `margin-bottom: 16px` |
| `#screen-project .output-header.glass-panel` | app 1359 | — | — | — | — | — | — | — | `14px 18px` | — |
| `.progress-panel` | `<div class="progress-panel">` app 1163 | — | `rgba(26,26,46,0.9)` | `1.5px solid rgba(77,217,217,0.25)` | `16px` | — | — | — | `16px 18px 18px` | `0 auto` |
| `.projects-search-wrap` | `<div>` app 1330 | — | — | — | — | — | — | — | — | `margin-bottom: 14px` |
| `.projects-search` | `<div class="projects-search">` app 1331 | — | `rgba(255,255,255,0.18)` | `1.5px solid rgba(255,255,255,0.38)` | `14px` | — | — | — | `12px 16px` | `margin-bottom: 10px` |
| `.project-actions` | `<div class="project-actions">` app 1384 | — | — | — | — | — | — | — | — | `0 0 16px` |
| `.project-actions-secondary` | `<div>` app 1396 | — | — | — | — | — | — | — | — | — |
| `.output-ctas` | `<div class="output-ctas">` app 1198, 1221, 1270, 1319 | — | `linear-gradient(0deg, rgba(77,217,217,0.97) 60%, transparent)` | — | — | — | — | — | `14px 26px 28px` | `0 auto` |
| `.review-panel` | `body.className = 'review-panel'` app 2772; `<div class="review-panel" id="project-review-modal-body">` app 1458 (with inline `background:none; border:none; margin:0; padding:0`) | — | `rgba(255,255,255,0.5)` | `1.5px solid rgba(255,255,255,0.68)` | `16px` | — | — | — | `18px` | `margin-top: 16px` |
| `.actions` (app legacy) | declared; the live CTA container is `.output-ctas` | — | — | — | — | — | — | — | — | `margin-top: 20px` |
| `.regen` (app) | declared; `.regen` markup lives in onboarding | — | — | — | — | — | — | — | — | `margin-top: 16px` |
| `.brief-attach` (app legacy) | declared; no markup found | — | — | — | — | — | — | — | — | `8px 0 0` |
| `.titlerow` (app legacy) | declared; no markup found | — | — | — | — | — | — | — | — | — |
| `.hdr-upload-card` | `<div class="hdr-upload-card">` settings 984 | — | `rgba(255,255,255,0.5)` | `1.5px solid rgba(255,255,255,0.68)` | `14px` | — | — | — | `16px 18px` | `8px 0` |
| `.hdr-upload-card .btn` | button inside it | — | — | — | — | — | — | — | — | `0` |
| `.hdr-block` | `el('div','hdr-block')` settings 3117 | — | `rgba(255,255,255,0.5)` | `1.5px solid rgba(255,255,255,0.68)` | `14px` | — | — | — | `14px` | `0 0 10px` |
| `.hdr-block .bh` / `.hdr-block .bh .ba` | `el('div','bh')` 3118 / `el('div','ba')` 3120 | — | — | — | — | `'Zen Kaku Gothic New', sans-serif` (`.bh`) | — | — | — | `.bh margin-bottom: 8px` |
| `.hdr-field` | `el('div','hdr-field')` settings 3071, 3090 | — | — | — | — | — | — | — | — | `6px 0` |
| `.hdr-cols` | `<div class="hdr-cols">` in the header editor | — | — | — | — | — | — | — | — | — |
| `.hdr-preview` | `<div id="hdr-current-preview" class="hdr-preview">` settings 954, `<div id="hdr-preview">` 978 | — | `#fff` | `1px solid var(--line)` | `10px` | — | — | — | `18px` | — |
| `.hdr-divider` | `<div class="hdr-divider">` settings 993 | — | `rgba(255,255,255,0.4)` | — | — | — | — | — | — | `28px 0 20px` |
| `.naming-preview` | `<div id="naming-locked-preview">` 1003, `<div id="naming-preview">` 1020 | `var(--ink)` | `#fff` | `1.5px solid rgba(255,255,255,0.68)` | `12px` | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | `12px 14px` | `0 0 16px` |
| `.naming-seg` | `el('div','naming-seg')` settings 2866 | — | `rgba(255,255,255,0.5)` | `1.5px solid rgba(255,255,255,0.68)` | `12px` | — | — | — | `8px 10px` | `0 0 8px` |
| `.naming-seg.dragging` | drag in progress — `opacity: 0.65` | — | — | — | — | — | — | — | — | — |
| `.cf-panel` | `el('div','cf-panel')` settings 2254 | — | — | `1px solid var(--line)` | `8px` | — | — | — | `14px` | `margin-top: 12px` |
| `.cf-actions` | `el('div','cf-actions')` settings 2372 | — | — | — | — | — | — | — | — | `margin-top: 14px` |
| `.tpl-upload` | `<div class="tpl-upload">` settings 907 | — | — | — | — | — | — | — | — | `6px 0 4px` |
| `.tpl-drop` | `<label class="tpl-drop" for="tpl-file">` settings 908 | — | `rgba(255,255,255,0.3)` | `1.5px dashed rgba(26,26,46,0.25)` | `14px` | — | — | — | `22px 18px` | — |
| `.tpl-drop:hover` | same | — | `rgba(255,255,255,0.42)` | `border-color: rgba(26,26,46,0.45)` | — | — | — | — | — | — |
| `.tpl-droptitle` | `<span class="tpl-droptitle">` settings 909 | `var(--ink)` | — | — | — | `'StarCrush', serif` | `15px` | — | — | — |
| `.tpl-namerow` | `<div class="tpl-namerow">` settings 913; `el('div','tpl-namerow')` 2158 | — | — | — | — | — | — | — | — | `margin-top: 12px` |
| `.terminal` (settings legacy) | `<div class="terminal" id="voice-terminal">` settings 793 | `var(--cream)` | `var(--navy)` | — | `8px` | `'Zen Kaku Gothic New', sans-serif` | `14px` | — | `24px` | — |
| `.terminal` (settings v8) | same | `rgba(255,255,255,0.85)` | `rgba(26,26,46,0.88)` | `1.5px solid rgba(77,217,217,0.2)` | `16px` | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | `20px` | — |
| `.terminal .t-h` (legacy / v8) | `<div class="t-h">` from the markdown renderer | `var(--accent)` / `var(--sky-btm)` | — | — | — | legacy `'Zen Kaku Gothic New', sans-serif`, v8 `'StarCrush', serif` | v8 `15px` | legacy `600`, v8 `normal` | — | `14px 0 4px` |
| `.terminal .t-p` (legacy / v8) | `<div class="t-p">` | v8 `rgba(255,255,255,0.75)` | — | — | — | — | — | — | — | `6px 0` |
| `.terminal .t-ul` / `.terminal .t-ul li` | `<ul class="t-ul">` / `<li>` | v8 li `rgba(255,255,255,0.75)` | — | — | — | — | — | — | `padding-left: 20px` | `4px 0 10px` / `2px 0` |
| `.terminal strong` (v8) | `<strong>` inside | `rgba(255,255,255,0.95)` | — | — | — | — | — | — | — | — |
| `.preview` (onboarding) | `<div class="preview md" id="voice-preview">` onboarding 302 | `rgba(255,255,255,0.85)` | `rgba(26,26,46,0.88)` | `1.5px solid rgba(77,217,217,0.2)` | `16px` | — | `14px` | — | `20px` | — |
| `.preview.md` | same, markdown-rendered | — | — | — | — | — | — | — | — | — |
| `.md .md-h` | `<div class="md-h">` from the onboarding markdown renderer | `var(--sky-btm)` | — | — | — | `'StarCrush', serif` | `15px` | `normal` | — | `14px 0 4px` |
| `.md .md-ul` / `.md .md-ul li` | `<ul class="md-ul">` / `<li>` | li `rgba(255,255,255,0.78)` | — | — | — | — | — | — | `padding-left: 20px` | `4px 0 10px` / `2px 0` |
| `.md .md-p` | `<div class="md-p">` | `rgba(255,255,255,0.78)` | — | — | — | — | — | — | — | `6px 0` |
| `.md strong` | `<strong>` inside | `rgba(255,255,255,0.95)` | — | — | — | — | — | — | — | — |
| `.regen` (onboarding) | `<div class="regen">` onboarding 308 | — | — | `border-top: 1px solid rgba(255,255,255,0.4)` | — | — | — | — | `padding-top: 16px` | `margin-top: 18px` |
| `#panel` (admin) | `<div id="panel">` admin 84 | — | `var(--navy)` | `1px solid rgba(255,255,255,.2)` | `14px` | — | — | — | `22px` | `0 auto` |
| `.actions` (landing) | `<div class="actions">` server.js 279 | — | — | — | — | — | — | — | — | — |

---

## 14. Tables

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `table` (admin) | `<table>` built in admin JS (health table, approve grid, diff grid) | — | — | `border-collapse: collapse` | — | — | `13px` | — | — | `margin-top: 8px` |
| `th, td` (admin) | cells of those tables | — | — | `border-bottom: 1px solid rgba(255,255,255,.1)` | — | — | — | — | `6px 8px` | — |
| `th` (admin) | header cells | — (`opacity:.6`) | — | — | — | — | — | `600` | — | — |
| `tr.err-row td` (admin) | `el('tr',{class:'err-row'})` admin JS 86 | — | `rgba(232,106,106,.12)` | — | — | — | — | — | — | — |
| `tr.err-row td:first-child` | same | — | — | `border-left: 3px solid var(--danger)` | — | — | — | — | — | — |
| `.pv-table` | `el('table','pv-table')` settings 3176 | — | — | `border-collapse: collapse` | — | — | — | — | — | — |
| `.pv-table td` | `<td>` inside it | — | — | `1px solid #808080` | — | — | — | — | `6px 8px` | — |
| `.pv-line` | `el('div','pv-line')` settings 3167, 3197 | — | — | — | — | — | — | — | — | `3px 0` |
| `.pv-line .lbl` | `el('span','lbl')` settings 3170 | `#444` | — | — | — | — | — | — | — | — |
| `.pv-hr` | `el('hr','pv-hr')` settings 3195 | — | — | `0` + `border-top: 1px solid #bbb` | — | — | — | — | — | `10px 0` |
| `.pv-empty` | `el('span','pv-empty')` settings 3183, `el('div','pv-empty')` 3201 | `#999` | — | — | — | — | — | — | — | — |

---

## 15. Chips and filters

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.filter-row` | `<div class="filter-row" id="history-filters">` app 1334 | — | — | — | — | — | — | — | `padding-bottom: 2px` | — |
| `.filter-row::-webkit-scrollbar` | pseudo — `display: none` | — | — | — | — | — | — | — | — | — |
| `.filter-chip` | `<span class="filter-chip">` app 1335–1338 | `rgba(26,26,46,0.65)` | `rgba(255,255,255,0.18)` | `1.5px solid rgba(255,255,255,0.35)` | `100px` | `'StarCrush', serif` | `10px` | — | `7px 14px` | — |
| `.filter-chip.active` | app 1335 initial + `classList.add('active')` app 3533 | `var(--white)` | `var(--ink)` | `border-color: var(--ink)` | — | — | — | — | — | — |
| `.file-tag` (app legacy) | `<span class="file-tag">` app 229 | — | `var(--card, #f6f6f6)` | `1px solid var(--line)` | `999px` | — | `13px` | — | `5px 8px 5px 10px` | — |
| `.file-tag` (app v8) | same | `var(--ink)` | `rgba(255,255,255,0.42)` | `1.5px solid rgba(255,255,255,0.5)` | `999px` | — | `13px` | — | `6px 10px` | — |
| `.file-tag .ext` | `<span class="ext">` app 231 | `rgba(26,26,46,0.55)` | — | — | — | `'StarCrush', serif` | `9px` | — | — | — |
| `.file-tag .name` | `<span class="name">` app 234 | — | — | — | — | — | — | — | — | — |
| `.file-tag .rm` (legacy) | `<button class="rm">` app 237 | `var(--muted)` | `none` | `none` | — | — | `15px` | — | `0 2px` | `0` |
| `.file-tag .rm` (v8) | same | `rgba(26,26,46,0.5)` | `none` | `none` | — | — | `15px` | — | `0 2px` | `0` |
| `.file-tag .rm:hover` | same | `#c0392b` | — | — | — | — | — | — | — | — |
| `.file-tags` (legacy / v8) | `<div id="file-tags" class="file-tags">` app 1155 | — | — | — | — | — | — | — | — | `margin-top: 10px` / `margin-top: 12px` |
| `.pill` (settings legacy) | `<span class="pill">Solo (Beta)</span>` settings 936 | — | `var(--soft)` | `1px solid var(--line)` | `999px` | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | `3px 10px` | — |
| `.pill` (settings v8) | same | `rgba(26,26,46,0.75)` | `rgba(26,26,46,0.08)` | `none` | `100px` | `'Zen Kaku Gothic New', sans-serif` | `11px` | `600` | `4px 12px` | — |
| `.pill` (onboarding) | `<span class="pill" id="user-email">` onboarding 242 | `rgba(26,26,46,0.6)` | `rgba(26,26,46,0.08)` | `none` | `100px` | — | `13px` | `600` | `4px 12px` | — |
| `.field-options` | `el('span','field-options')` app 2322 | `#7A5E12` | `rgba(201,168,76,0.22)` | — | `6px` | `'Zen Kaku Gothic New', sans-serif` | `11px` | `700` | `2px 8px` | — |
| `.doorway-chip` | `el('span','doorway-chip')` app 2327 | `#1A1A2E` | `rgba(201,168,76,0.9)` | — | `5px` | `'Zen Kaku Gothic New', sans-serif` | `10.5px` | `700` | `2px 7px` | `margin-right: auto` |
| `.lib-tier` | `el('span','lib-tier ' + f.spec_type)` settings 1186 | — | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11px` | `600` | — | — |
| `.lib-tier.enforced` | `spec_type === 'enforced'` | `#6b3a00` | — | — | — | — | — | — | — | — |
| `.lib-tier.recommended` | `spec_type === 'recommended'` | `#12506a` | — | — | — | — | — | — | — | — |
| `.lib-tier.house_default` | `spec_type === 'house_default'` | `rgba(26,26,46,0.75)` | — | — | — | — | — | — | — | — |
| `.lib-tier.mine` | `el('span','lib-tier mine','Yours')` settings 1341 | `#1f4d31` | — | — | — | — | — | — | — | — |
| `.cf-count` | `el('span','cf-count')` settings 2294 | `var(--muted)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | — | — |
| `.tool-badge` | `<span class="tool-badge …">` onboarding 329, 341 | — | — | — | `999px` | `'Zen Kaku Gothic New', sans-serif` | `10px` | — | `2px 8px` | — |
| `.tool-badge.now` | onboarding 329 | `#06302f` | `var(--sky-btm)` | — | — | — | — | — | — | — |
| `.tool-badge.soon` | onboarding 341 | `rgba(26,26,46,0.6)` | `rgba(26,26,46,0.1)` | — | — | — | — | — | — | — |

---

## 16. Badges and status indicators

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.status` (app legacy) | declared; no markup found | `var(--muted)` | `var(--soft)` | `1px solid var(--line)` | `999px` | — | `12px` | `600` | `3px 10px` | — |
| `.status.not_started` (legacy) | declared; no markup found | `#555` | `#ededed` | `border-color: #dcdcdc` | — | — | — | — | — | — |
| `.status.in_progress` (legacy) | declared; no markup found | `#5a4b00` | `#fff4cc` | `border-color: #f0e0a0` | — | — | — | — | — | — |
| `.status.finished` (legacy) | declared; no markup found | `#0a5d2a` | `#d8f5e0` | `border-color: #b3e6c4` | — | — | — | — | — | — |
| `.status.closed` (legacy) | declared; no markup found | `#888` | `#f2f2f2` | `border-color: #e3e3e3` | — | — | — | — | — | — |
| `.project-card-status` | `el('span','project-card-status …')` app 3548; `<span id="project-status">` app 1361; re-set app 2157, 2163, 2422 | — | — | `2px solid transparent` (+`box-shadow: 2px 2px 0 rgba(0,0,0,0.12)`) | `3px` | `'StarCrush', serif` | `10px` | — | `5px 0` | — |
| `#screen-project .project-card-status` | app 1361 — `cursor: default` | — | — | — | — | — | — | — | — | — |
| `.status-active` | `PILL_CLASS` → finished | `#0A5C32` | `#C6F0D8` | `border-color: #2ECC71` (+`box-shadow: 2px 2px 0 rgba(10,92,50,0.2)`) | — | — | — | — | — | — |
| `.status-draft` | `PILL_CLASS` → in progress | `#7A5500` | `#FFF0B3` | `border-color: #C9A84C` (+`box-shadow: 2px 2px 0 rgba(122,85,0,0.2)`) | — | — | — | — | — | — |
| `.status-notstarted` | default fallback in `PILL_CLASS` lookups | `rgba(26,26,46,0.5)` | `rgba(255,255,255,0.5)` | `border-color: rgba(26,26,46,0.2)` (+`box-shadow: 2px 2px 0 rgba(26,26,46,0.1)`) | — | — | — | — | — | — |
| `.status-dot-preview` | `<span class="status-dot-preview">` app 2113–2115, with inline `background`/`border` per item | — | inline `#2ECC71` / `#C9A84C` / `rgba(255,255,255,0.6)` | inline `1px solid #0A5C32` / `1px solid #7A5500` / `1px solid rgba(26,26,46,0.3)` | `2px` | — | — | — | — | — |
| `.asset-card-badge` | `el('span','asset-card-badge')` app 2277 | `rgba(26,26,46,0.5)` | `rgba(26,26,46,0.06)` | — | `100px` | `'Zen Kaku Gothic New', sans-serif` | `10px` | `600` | `2px 9px` | — |
| `.asset-card-badge.drafted` | `opts.drafted` true, app 2277 | `#0A5C32` | `#C6F0D8` | — | — | — | — | — | — | — |
| `.asset .badge` (app legacy) | declared; no markup found | `var(--muted)` | — | — | — | — | `12px` | `600` | — | — |
| `.asset.drafted .badge` (legacy) | declared; no markup found | `#06302f` | `var(--accent)` | — | `999px` | — | — | — | `2px 8px` | — |
| `.draft-status` | declared; no markup found in app | `#0A5C32` | `#C6F0D8` | `1.5px solid #2ECC71` | `100px` | `'Zen Kaku Gothic New', sans-serif` | `13px` | `600` | `6px 14px` | `margin-bottom: 16px` |
| `.badge` (admin) | `el('span',{class:'badge '+(is_test?'test':'real')})` admin JS 89, 145 | — | — | — | `999px` | — | `11px` | `700` | `2px 8px` | — |
| `.badge.test` (admin) | `w.is_test` / `f.is_test` true | `var(--navy)` | `var(--warn)` | — | — | — | — | — | — | — |
| `.badge.real` (admin) | otherwise | `var(--navy)` | `var(--sky)` | — | — | — | — | — | — | — |
| `.badge-soon` (settings legacy) | `<span class="badge-soon">Coming soon</span>` settings 852, 871, 878 | `var(--muted)` | — | `1px solid var(--line)` | `999px` | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | `2px 8px` | — |
| `.badge-soon` (settings v8) | same | `rgba(26,26,46,0.75)` | `rgba(26,26,46,0.06)` | `none` | — | `'Zen Kaku Gothic New', sans-serif` | `11px` | — | — | — |
| `.diff-old` (admin) | `el('span',{class:'diff-old'})` admin JS 302 | `var(--danger)` | — | — | — | — | — | — | — | — |
| `.diff-new` (admin) | `el('span',{class:'diff-new'})` admin JS 302 | `var(--ok)` | — | — | — | — | — | `700` | — | — |
| `.diverge` (admin) | `el('div',{class:'diverge'})` admin JS 260 | `var(--warn)` | — | — | — | — | `12.5px` | — | — | `margin-top: 4px` |
| `.diverge ul` / `.diverge li` | inside it | — | — | — | — | — | — | — | `padding-left: 16px` | `3px 0 0` / `1px 0` |
| `.cf-guess` | `el('span','cf-guess')` settings 2356 | `#8a6d3b` | — | — | — | — | — | — | — | — |
| `.ok` (onboarding) | `<span class="ok">✓</span>` onboarding 241 | `#0A5C32` | — | — | — | — | `20px` | `700` | — | — |
| `.lib-fresh` | `el('div','lib-fresh')` settings 1163 | `rgba(26,26,46,0.75)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11px` | — | — | `margin-top: 4px` |
| `.lib-fresh-v` / `.lib-fresh-v a` | `el('div','lib-fresh-v')` settings 1165 | a: `inherit` | — | — | — | — | — | — | — | — |
| `.lib-fresh-m` | `el('div','lib-fresh-m')` settings 1179 | — no own rule | — | — | — | — | — | — | — | — |
| `.lib-fresh.flagged .lib-fresh-m` | `fr.state !== 'clean'` | `#6b3a00` | — | — | — | — | — | — | — | — |
| `.lib-fresh.flagged .lib-fresh-m::before` | pseudo, `content: '⚠ '` | — | — | — | — | — | — | — | — | — |
| `.np-dyn` | `el('span','np-dyn')` settings 2946 | `#1a9a9a` | — | — | — | — | — | — | — | — |
| `.np-empty` | `el('span','np-empty')` settings 2944 | `#999` | — | — | — | — | — | — | — | — |
| `.notif-mark` | `<span class="notif-mark">` nav partial JS (`✓` / `⚠` / `⚙`) | `#4DD9D9` | — | — | — | — | — | — | — | `margin-right: 5px` |
| `.notif-item.warn .notif-mark` | `n.type === 'draft_incomplete'` | `#E8B84B` | — | — | — | — | — | — | — | — |
| `.notif-item.spec .notif-mark` | `n.type === 'spec_change'` | `#B8A6F0` | — | — | — | — | — | — | — | — |
| `.nav-bell-count` | `<span id="nav-bell-count">` nav partial 12 | `#fff` | `#E4572E` | — | `8px` | `'Zen Kaku Gothic New', sans-serif` | `10px` | `700` | `0 3px` | — |
| `.nav-bell-count.on` | `unread > 0` | — | — | — | — | — | — | — | — | — |

---

## 17. Icons and images

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.quill` (landing) | `<img class="quill">` server.js 276 — `/assets/gifs/quillio_magic_v27.gif` | — | — | — | — | — | — | — | — | `0 auto 8px` |
| `.nav-quill-img` | `<img>` nav partial 3, onboarding 209 — `28px × 28px`, `image-rendering: auto` | — | — | — | — | — | — | — | — | — |
| `.progress-gif` | `<img id="progress-gif">` app 1162 — `130px × 130px`, `image-rendering: pixelated` | — | — | — | — | — | — | — | — | `margin-bottom: 28px` |
| `.gen-gif` | `<img class="gen-gif">` app 1286 — `150px × 150px`, `image-rendering: pixelated` | — | — | — | — | — | — | — | — | `margin-bottom: 28px` |
| `.header-gif` | `<img class="header-gif">` app 1231, 1294 — `52px × 52px`, `image-rendering: pixelated` | — | — | — | — | — | — | — | — | `margin-top: -2px` |
| `.review-gif` | `<img class="review-gif">` app 2778, 2788 — `96px × 96px`, `image-rendering: pixelated` | — | — | — | — | — | — | — | — | `0 auto 10px` |
| `.hub-icon svg` | inline `<svg>` in each hub card — `40px × 40px`, `image-rendering: pixelated` | — | — | — | — | — | — | — | — | — |
| `.conn-logo` | `<img class="conn-logo">` settings 840, 850, 859, 870, 876 — `30px × 30px`, `image-rendering: pixelated` | — | — | — | — | — | — | — | — | — |
| `.tool-logo` | `<img class="tool-logo">` onboarding 327, 339 — `44px × 44px`, `image-rendering: pixelated` | — | — | — | — | — | — | — | — | — |
| `.nav-bell` | `<button id="nav-bell">` nav partial 11 — `30px × 30px` | `rgba(255,255,255,0.4)` | `none` | `none` | `8px` | — | — | — | `0` | — |
| `.nav-bell:hover` | same | `#fff` | `rgba(255,255,255,0.08)` | — | — | — | — | — | — | — |
| `.nav-bell.open` | panel open | `#4DD9D9` | `rgba(77,217,217,0.12)` | — | — | — | — | — | — | — |
| `.nav-bell svg` | inline pixel bell `<svg>`, `16 × 16` — `fill: currentColor` | — | — | — | — | — | — | — | — | — |
| `.nav-bell-wrap` | `<div class="nav-bell-wrap">` nav partial 10 | — | — | — | — | — | — | — | — | `margin-left: 4px` |
| `.matrix-angle-caret` | `el('span','matrix-angle-caret')` app 2086 — `12px × 8px` SVG data-URI, stroke `%23C9A84C` | — | `url("data:image/svg+xml,…")` | — | — | — | — | — | — | — |
| `.naming-drag` | `el('div','naming-drag','⠿')` settings 2869 — `26px × 30px` | `rgba(26,26,46,0.4)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `16px` | — | — | — |
| `.note .dot` (app / settings / onboarding) | `<span class="dot">` inside `.note` / `.loading` blocks — `16px × 16px` | — | — | `2px solid var(--accent)` (settings/app) / `2px solid var(--sky-btm)` (onboarding) with `border-top-color: transparent` | `50%` | — | — | — | — | — |
| `.loading .dot` | `<span class="dot">` app 1341, 1410 — `16px × 16px` | — | — | `2px solid var(--accent)`, `border-top-color: transparent` | `50%` | — | — | — | — | — |
| `.steps li .dot` | declared; no markup found — `18px × 18px` | — | — | `2px solid var(--line)` | `50%` | — | — | — | — | — |
| `.spinner` (onboarding) | `<div class="spinner">` onboarding 296 — `30px × 30px` | — | — | `3px solid rgba(255,255,255,0.25)`, `border-top-color: var(--sky-btm)` | `50%` | — | — | — | — | — |
| `.gbtn .g` | `<span class="g">G</span>` onboarding 225 — `18px × 18px` | `#06302f` | `var(--sky-btm)` | — | `50%` | `'Zen Kaku Gothic New', sans-serif` | `12px` | `700` | — | — |
| `.modal-handle` | `<div class="modal-handle">` app 1431, 1443, 1457 — `36px × 4px` | — | `rgba(255,255,255,0.4)` | — | `2px` | — | — | — | — | `0 auto 20px` |
| cloud `<svg>` | built by `populateClouds`, appended to `.clouds-wrap` — `image-rendering: pixelated`, per-cloud `opacity` `0.14`–`0.17` | — | rect fills `#B8E4F8` (y ≥ 10, `opacity` `0.5`) and `white` (y < 10, `opacity` `1`) | — | — | — | — | — | — | — |

---

## 18. Modals and overlays

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.modal-overlay` | `<div class="modal-overlay">` app 1429, 1441, 1455 | — | `rgba(26,26,46,0.6)` | — | — | — | — | — | — | — |
| `.modal-overlay.open` | after `classList.add('open')` app 3387, 4209, 4308 | — | — | — | — | — | — | — | — | — |
| `.modal-sheet` | `<div class="modal-sheet">` app 1430, 1442, 1456 | — | `linear-gradient(180deg, #2FA8DC, #4DD9D9)` | `border-top: 1.5px solid rgba(255,255,255,0.4)` | `24px 24px 0 0` | — | — | — | `24px 26px 48px` | — |
| `.modal-overlay.open .modal-sheet` | open state — `transform: translateY(0)` | — | — | — | — | — | — | — | — | — |
| `.angle-menu` | `el('div','angle-menu')` app 1937 | — | `rgba(26,26,46,0.96)` | `1.5px solid rgba(77,217,217,0.2)` | `12px` | — | — | — | — | — |
| `.angle-menu.open` | `classList.add('open')` app 1977 | — | — | — | — | — | — | — | — | — |
| `.angle-menu-item` | `el('div','angle-menu-item')` app 1939 | — | — | — | — | — | — | — | `8px 16px` | — |
| `.angle-menu-item + .angle-menu-item` | consecutive items | — | — | `border-top: 1px solid rgba(255,255,255,0.06)` | — | — | — | — | — | — |
| `.angle-menu-item:hover` / `:active` | same | — | `rgba(255,255,255,0.08)` / `rgba(255,255,255,0.14)` | — | — | — | — | — | — | — |
| `.angle-menu-item.on` | current angle, app 1957 | — | `rgba(201,168,76,0.16)` | — | — | — | — | — | — | — |
| `.angle-menu-name` | `el('span','angle-menu-name')` app 1941 | `var(--white)` | — | — | — | `'StarCrush', serif` | `12.5px` | — | — | — |
| `.angle-menu-desc` | `el('span','angle-menu-desc')` app 1942 | `rgba(255,255,255,0.55)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11px` | — | — | — |
| `body.angle-menu-lock` | `<body>` while the menu is open, app 1998 | — | — | — | — | — | — | — | — | — |
| `.status-dropdown` | `el('div')` + `className = 'status-dropdown'` app 2109–2110 | — | `rgba(26,26,46,0.95)` | `1.5px solid rgba(77,217,217,0.2)` | `10px` | — | — | — | — | — |
| `.status-dropdown.open` | `classList.add('open')` app 3592 | — | — | — | — | — | — | — | — | — |
| `.status-dropdown-item` | `<div class="status-dropdown-item">` app 2113–2116 | `rgba(255,255,255,0.8)` | — | — | — | `'StarCrush', serif` | `11px` | — | `12px 14px` | — |
| `.status-dropdown-item:hover` / `:active` | same | — | `rgba(255,255,255,0.08)` / `rgba(255,255,255,0.14)` | — | — | — | — | — | — | — |
| `.status-dropdown-remove` | `<div class="status-dropdown-item status-dropdown-remove">` app 2116 | `#E8908A` | — | `border-top: 1px solid rgba(255,255,255,0.1)` | — | — | — | — | — | — |
| `.notif-panel` | `<div class="notif-panel" id="notif-panel">` nav partial 16 | — | `rgba(26,26,46,0.97)` | `1px solid rgba(77,217,217,0.18)` | `12px` | `'Zen Kaku Gothic New', sans-serif` | — | — | — | — |
| `.notif-panel.open` | `openPanel()` | — | — | — | — | — | — | — | — | — |
| `.notif-head` | `<div class="notif-head">Notifications</div>` nav partial 17 | `rgba(255,255,255,0.45)` | — | `border-bottom: 1px solid rgba(255,255,255,0.08)` | — | — | `11px` | — | `10px 14px` | — |
| `.notif-list` | `<div class="notif-list" id="notif-list">` nav partial 18 | — | — | — | — | — | — | — | — | — |
| `.notif-item` | `<button>` per notification, nav partial `render()` | `rgba(255,255,255,0.55)` | `none` | `none`; `border-left: 3px solid transparent`; `border-bottom: 1px solid rgba(255,255,255,0.06)` | — | `inherit` | `13px` | — | `11px 14px 11px 12px` | — |
| `.notif-item:last-child` | last | — | — | `border-bottom: none` | — | — | — | — | — | — |
| `.notif-item:hover` | same | — | `rgba(255,255,255,0.06)` | — | — | — | — | — | — | — |
| `.notif-item.unread` | `isUnread(n)` true | `#fff` | `rgba(77,217,217,0.07)` | `border-left-color: #4DD9D9` | — | — | — | — | — | — |
| `.notif-msg` | `<span class="notif-msg">` | — | — | — | — | — | — | — | — | — |
| `.notif-when` | `<span class="notif-when">` | `rgba(255,255,255,0.35)` | — | — | — | — | `11px` | — | — | `margin-top: 3px` |
| `#overlay` (admin) | `<div id="overlay">` admin 84 | — | `rgba(0,0,0,.6)` | — | — | — | — | — | `24px` | — |

---

## 19. Toasts and notifications

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.toast` (app) | `<div class="toast" id="toast">` app 1419 | `#fff` | `rgba(26,26,46,0.92)` | `1.5px solid rgba(77,217,217,0.35)` | `12px` | `'Zen Kaku Gothic New', sans-serif` | `13px` | `500` | `12px 18px` | — |
| `.toast.show` (app) | `classList.add('show')` app 3233 | — | — | — | — | — | — | — | — | — |
| `.toast` (settings) | `<div class="toast" id="hdr-toast">` settings 1037 | `#fff` | `rgba(26,26,46,0.92)` | `1.5px solid rgba(77,217,217,0.35)` | `12px` | `'Zen Kaku Gothic New', sans-serif` | `13px` | `500` | `13px 20px` | — |
| `.toast.show` (settings) | `classList.add('show')` settings JS | — | — | — | — | — | — | — | — | — |
| `.toast.locked` (settings) | lock-in confirmations, settings 2403 / 2954 / 3000 | — | — | `border-color: rgba(201,168,76,0.6)`; `border-left: 3px solid var(--gold)` | — | — | — | — | — | — |
| `.toast.locked .tk` | `el('span','tk','Quillio')` settings 2403, 2954, 3000 | `var(--gold)` | — | — | — | `'StarCrush', serif` | — | `normal` | — | `margin-right: 7px` |
| `#stale-shell-banner` | `<div id="stale-shell-banner">` app 1423 — **all styling is inline**, no CSS rule | `#fff` | `#C0392B` | — | — | `'Zen Kaku Gothic New', sans-serif` | `13px` | `600` | `11px 14px` | — |
| `.banner` (settings legacy) | `<div class="banner hidden">` settings 776, 816 | `#0a5d2a` | `#d8f5e0` | `1px solid #b3e6c4` | `8px` | `'Zen Kaku Gothic New', sans-serif` | `14px` | — | `10px 12px` | `0 0 12px` |
| `.banner` (settings v8) | same | `#0A5C32` | `#C6F0D8` | `1.5px solid #2ECC71` | `12px` | — | — | — | — | — |
| `.notice` (app) | `<div class="notice hidden">` app 1195, 1218, 1262, 1267, 1300 | `#6b520f` | `#fdf8ec` | `1px solid #e3cf94` | `8px` | — | `14px` | — | `10px 12px` | `margin-top: 14px` |
| `#copydone-shortfall` | `<div id="copydone-shortfall" class="notice hidden">` app 1300 | — | — | — | — | — | — | — | — | `margin-bottom: 14px` |
| `.msg` (admin) | `el('div',{class:'msg'})` admin JS 215, 234 | — | — | — | `8px` | — | `13.5px` | — | `10px 12px` | `10px 0` |
| `.msg.err` (admin) | admin JS 49, 130, 219, 274, 277 | — | `rgba(232,106,106,.15)` | `1px solid var(--danger)` | — | — | — | — | — | — |
| `.msg.ok` (admin) | admin JS 234, 314 | — | `rgba(95,185,142,.15)` | `1px solid var(--ok)` | — | — | — | — | — | — |
| `.msg.warn` (admin) | admin JS 288 (tenant divergence) | — | `rgba(224,168,74,.15)` | `1px solid var(--warn)` | — | — | — | — | — | — |
| `.notif-*` | see §18 — the notification panel is a nav-anchored overlay | — | — | — | — | — | — | — | — | — |

---

## 20. Progress and loading states

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.progress-panel` | `<div class="progress-panel">` app 1163 | — | `rgba(26,26,46,0.9)` | `1.5px solid rgba(77,217,217,0.25)` | `16px` | — | — | — | `16px 18px 18px` | `0 auto` |
| `.progress-estimate` | `<div id="brief-progress-estimate">` app 1164 | `var(--sky-btm)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | `500` | — | `margin-bottom: 12px` |
| `.progress-track` | `<div id="brief-progress-track">` app 1165 | — | `rgba(0,0,0,0.28)` | `1.5px solid rgba(77,217,217,0.2)` | `6px` | — | — | — | `3px` | — |
| `.progress-seg` | `s.className = 'progress-seg'` app 322–323 | — | `rgba(255,255,255,0.08)` | — | `2px` | — | — | — | — | — |
| `.progress-seg.filled` | `classList.toggle('filled', i < n)` app 1792 | — | `var(--sky-btm)` | — | — | — | — | — | — | — |
| `.progress-track.pulsing .progress-seg.filled` | `classList.add('pulsing')` app 1852 | — | — | — | — | — | — | — | — | — |
| `.progress-label` | `<div id="brief-progress-label">` app 1166 | `rgba(255,255,255,0.92)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `14px` | `600` | — | `margin-top: 14px` |
| `.progress-sublabel` | `<div id="brief-progress-sublabel">` app 1167 | `rgba(255,255,255,0.55)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | `400` | — | `margin-top: 4px` |
| `.note` (app) | `<div id="copydone-fallback" class="note hidden">` app 1296 | `var(--muted)` | `var(--soft)` | `1px solid var(--line)` | `8px` | — | `14px` | — | `10px 12px` | `margin-top: 14px` |
| `.note` (settings legacy) | `<div class="note">` settings 774, 810, 817, 890, 891, 906, 913, 921, 948, 968, 997 + `el('div','note')` 2258 | `var(--muted)` | — | — | — | — | — | — | — | `12px 0` |
| `.note` (settings v8) | same | `rgba(26,26,46,0.65)` | — | — | — | — | — | — | — | — |
| `.note` (onboarding) | `<div class="note">` onboarding 257, 269 | `rgba(26,26,46,0.65)` | — | — | — | — | `14px` | — | — | `margin-top: 14px` |
| `.loading` | `<div id="history-loading" class="loading hidden">` app 1341, `<div id="project-loading">` app 1410 | `var(--muted)` | — | — | — | — | — | — | — | `margin-top: 20px` |
| `#screen-history .loading`, `#screen-project .loading` | same elements | `rgba(26,26,46,0.7)` | — | — | — | — | — | — | — | — |
| `.progress` (settings legacy) | `<div class="progress" id="voice-progress">` settings 799 | `var(--muted)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | — | `margin-bottom: 4px` |
| `.progress` (settings v8) | same | `rgba(26,26,46,0.6)` | — | — | — | — | — | — | — | — |
| `.progress` (onboarding) | `<div class="progress" id="voice-progress">` onboarding 286 | `rgba(26,26,46,0.6)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | — | `margin-bottom: 6px` |
| `#voice-generating` (onboarding) | `<div id="voice-generating" class="hidden">` onboarding 295 | `rgba(255,255,255,0.85)` | — | — | — | — | — | — | `36px 0` | — |
| `.spinner` (onboarding) | `<div class="spinner">` onboarding 296 | — | — | `3px solid rgba(255,255,255,0.25)` + `border-top-color: var(--sky-btm)` | `50%` | — | — | — | — | — |
| `.genmsg` (onboarding) | `<div class="genmsg" id="voice-genmsg">` onboarding 297 | — | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | — | — |
| `.steps` / `.steps li` | declared in app CSS; **no markup found** | li `var(--muted)` | — | li `border-bottom: 1px solid var(--line)` | — | — | — | — | `0` / `10px 0` | `20px 0` |
| `.steps li.working` / `.steps li.done` | declared; no markup found | `var(--ink)` | — | — | — | — | — | `600` / — | — | — |
| `.steps li.done .dot` | declared; no markup found | — | `var(--accent)` | `border-color: var(--accent)` | — | — | — | — | — | — |
| `@keyframes spin` | app, settings, onboarding | — | — | — | — | — | — | — | — | — |
| `@keyframes popIn` | app — `.progress-gif`, `.gen-gif`, `.header-gif`, `.review-gif` | — | — | — | — | — | — | — | — | — |
| `@keyframes cardIn` | app — `.asset-card.reveal` | — | — | — | — | — | — | — | — | — |
| `@keyframes segPulse` | app — `.progress-track.pulsing .progress-seg.filled` | — | — | — | — | — | — | — | — | — |
| `@keyframes libHit` | settings — `.lib-field.lib-hit`; `0%,55%` `background: rgba(184,166,240,0.45)` with `box-shadow: 0 0 0 6px rgba(184,166,240,0.45)`, `100%` `transparent` | — | — | — | `6px` (on `.lib-field.lib-hit`) | — | — | — | — | — |
| `@keyframes driftL` / `driftR` | injected by `populateClouds` into `<head>` at runtime | — | — | — | — | — | — | — | — | — |

`@media (prefers-reduced-motion: reduce)` blocks exist in app (`.note .dot`,
`.steps li.working .dot`, `.loading .dot`, `.gen-message` transition), settings
(`.note .dot`, `.lib-field.lib-hit` → `animation: none; background:
rgba(184,166,240,0.35)`) and onboarding (`.note .dot`, `.spinner`).

---

## 21. Empty states

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.empty` (app legacy) | `<div id="picker-empty" class="empty hidden">` app 1194, `<div id="history-empty">` 1343, `<div id="project-fallback">` 1412 | `var(--muted)` | — | `1px dashed var(--line)` | `8px` | — | — | — | `24px` | `margin-top: 24px` |
| `#screen-history .empty`, `#screen-project .empty` (app v8) | app 1343, 1412 | `rgba(26,26,46,0.65)` | `rgba(255,255,255,0.3)` | `border-color: rgba(255,255,255,0.5)` | — | — | — | — | — | — |
| `.empty` (settings legacy) | `<div id="voice-empty" class="empty hidden">` settings 779, `<div class="empty">` 961, 1011 | `var(--muted)` | — | `1px dashed var(--line)` | `8px` | — | — | — | `24px` | `margin-top: 16px` |
| `.empty` (settings v8) | same | `rgba(26,26,46,0.65)` | `rgba(255,255,255,0.3)` | `1.5px dashed rgba(255,255,255,0.6)` | `14px` | — | — | — | — | — |
| `.empty` (admin) | `el('p',{class:'empty',text:'None pending.'})` admin JS 138 | — (`opacity:.55`, `font-style: italic`) | — | — | — | — | — | — | — | — |
| `.notif-empty` | `<div class="notif-empty" id="notif-empty">Nothing yet.</div>` nav partial 19 | `rgba(255,255,255,0.4)` | — | — | — | — | `13px` | — | `16px 14px` | — |
| `.notif-empty.on` | `state.items.length === 0` | — | — | — | — | — | — | — | — | — |
| `.tpl-empty` | `el('p','tpl-empty')` settings 2205 | `rgba(26,26,46,0.6)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12.5px` | — | — | `margin-top: 8px` |
| `.naming-empty` | `el('div','naming-empty')` settings 2859 | `rgba(26,26,46,0.6)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `13px` | — | — | `4px 0 12px` |
| `.pv-empty` | `el('span'/'div','pv-empty')` settings 3183, 3201 | `#999` | — | — | — | — | — | — | — | — |
| `.field-copy.empty` (app legacy) | declared; no markup found | `var(--muted)` (`font-style: italic`) | — | — | — | — | — | — | — | — |
| `.field-no-riff` | `el('span','field-no-riff')` app 2392 | `rgba(26,26,46,0.45)` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11.5px` | — | — | `margin-top: 10px` |

---

## 22. Error states

| Selector | Tag / where | color | background | border | radius | font-family | font-size | weight | padding | margin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `.error` (app) | `<div class="error hidden">` app 1157, 1169, 1196, 1219, 1268, 1317, 1342, 1413; `#screen-progress .error` | `#8a1f1f` | `#fdf0f0` | `1px solid #e7b3b3` | `8px` | — | `14px` | — | `10px 12px` | `margin-top: 14px` |
| `.error` (settings legacy) | `<div class="error hidden">` settings 775, 818, 889, 905, 928, 947, 996 + `el('div','error hidden')` 2256 | `#8a1f1f` | `#fdf0f0` | `1px solid #e7b3b3` | `8px` | `'Zen Kaku Gothic New', sans-serif` | `14px` | — | `10px 12px` | `margin-top: 12px` |
| `.error` (settings v8) | same | — | — | — | `12px` | — | — | — | — | — |
| `.error` (onboarding) | `<div class="error hidden">` onboarding 258, 274, 314 | `#8a1f1f` | `#fdf0f0` | `1.5px solid #e7b3b3` | `12px` | — | `14px` | — | `10px 12px` | `margin-top: 14px` |
| `.doc-row.failed` | `r.built === false`, app 2563 | — | `rgba(192,57,43,0.05)` | `border-color: rgba(192,57,43,0.35)` | — | — | — | — | — | — |
| `.doc-row.failed .doc-row-note` | same | `#a5382a` | — | — | — | — | — | — | — | — |
| `.review-panel.error` | `body.className = 'review-panel error'` app 2797 | — | — | `border-color: rgba(192,57,43,0.35)` | — | — | — | — | — | — |
| `.review-panel.error .review-digest` | same | `#C0392B` | — | — | — | — | — | — | — | — |
| `.field-char.over` | over `charMax`, or a word field under `charMin`, app 2337–2338 | `#c0392b` | — | — | — | — | — | `600` | — | — |
| `.field .count.over` (legacy) | declared; no markup found | `#c0392b` | — | — | — | — | — | `600` | — | — |
| `.lib-rowerr` | `el('div','lib-rowerr')` settings 1240 | `#8a1f1f` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `11.5px` | — | — | `margin-top: 6px` |
| `.lib-newerr` | `el('div','lib-newerr')` settings 1611, 1980 | `#8a1f1f` | — | — | — | `'Zen Kaku Gothic New', sans-serif` | `12.5px` | — | — | `margin-top: 10px` |
| `.lib-newerr ul` | `<ul>` inside it | — | — | — | — | — | — | — | `padding-left: 18px` | `4px 0 0` |
| `.tpl-warn` | `el('div','tpl-warn')` settings 2417 | `#8a1f1f` | `rgba(255,255,255,0.42)` | `border-left: 2px solid #8a1f1f` | `0 9px 9px 0` | `'Zen Kaku Gothic New', sans-serif` | `12px` | — | `7px 10px` | `margin-top: 10px` |
| `.file-tag .rm:hover` | remove-attachment control | `#c0392b` | — | — | — | — | — | — | — | — |
| `.lib-fdel:hover` | remove-field control | `#8a1f1f` | — | — | — | — | — | — | — | — |
| `.card-close:hover` (legacy) | declared; no markup found | `#8a1f1f` | `var(--soft)` | — | — | — | — | — | — | — |
| `.msg.err` (admin) | admin JS 49, 130, 219, 274, 277 | — | `rgba(232,106,106,.15)` | `1px solid var(--danger)` | `8px` | — | `13.5px` | — | `10px 12px` | `10px 0` |
| `tr.err-row td` (admin) | `w.last_error \|\| fails > 1 \|\| isStuck`, admin JS 86 | — | `rgba(232,106,106,.12)` | `td:first-child border-left: 3px solid var(--danger)` | — | — | — | — | — | — |
| `.diff-old` (admin) | old value in a diff row | `var(--danger)` | — | — | — | — | — | — | — | — |
| `.status-dropdown-remove` | "Remove from list" item, app 2116 | `#E8908A` | — | `border-top: 1px solid rgba(255,255,255,0.1)` | — | — | — | — | — | — |
| `#stale-shell-banner` | app 1423, inline styles only | `#fff` | `#C0392B` | — | — | `'Zen Kaku Gothic New', sans-serif` | `13px` | `600` | `11px 14px` | — |
| `button.btn.danger` (settings) | `<button class="btn danger" id="signout-btn">` settings 939 | legacy `#8a1f1f` / v8 `#C0392B` | legacy `#fdf0f0` / v8 `rgba(192,57,43,0.08)` | legacy `1px solid #e7b3b3` / v8 `1.5px solid rgba(192,57,43,0.25)` | `8px` | — | — | — | — | — |
| `button.danger` (admin) | declared; no markup found | `var(--danger)` | — | `border-color: var(--danger)` | — | — | — | — | — | — |

---

## 23. Disabled and inert states

| Selector | Tag / where | Declared |
| --- | --- | --- |
| `button:disabled` (app legacy) | every app `<button>` | `opacity: 0.55; cursor: default` |
| `.run-btn:disabled` | app 1152 | `opacity: 0.55; cursor: default` |
| `.cta-primary:disabled` | app 1199 (`#picker-build-btn` ships `disabled`), others set in JS | `opacity: 1; background: #B7C2C6; color: rgba(26,26,46,0.45); box-shadow: none; cursor: default` |
| `.riff-btn:disabled` | app 2170 | `opacity: 0.45; cursor: default; box-shadow: none` |
| `.modal-btn:disabled` | app 1434, 1446, 1459 | `opacity: 0.6; cursor: default` |
| `button.btn:disabled` (settings) | every settings `.btn` | `opacity: 0.55; cursor: default` |
| `button:disabled` (onboarding) | every onboarding `<button>` | `opacity: 0.55; cursor: default; box-shadow: none` |
| `button:disabled` (admin) | every admin `<button>` | `opacity: .4; cursor: not-allowed` |
| `input:disabled` (admin) | unchecked field rows in the approve panel | `opacity: .35` |
| `.lib-toggle input:disabled + .lib-track` | while a toggle write is in flight | `opacity: 0.5; cursor: progress` |
| `.lib-frow.locked` | a non-editable field row in the house-defaults form | `opacity: 0.6` |
| `.lib-funit.locked select` | unit control on an editable-but-locked row | `background: rgba(26,26,46,0.05); border-color: transparent; color: rgba(26,26,46,0.55); cursor: default; padding-right: 12px` |
| `.lib-funit.locked::after` | its caret | `display: none` |
| `.lib-asset.off` | `a.is_active === false` | `opacity: 0.6; border-style: dashed` |
| `.cf-row.off .cf-name`, `.cf-row.off .cf-limit` | marker not ticked `is_copy` | `opacity: 0.45` |
| `.soon` (settings legacy) | `<div class="card soon">` settings 848, 867, 874 | `opacity: 0.5` |
| `.soon` (settings v8) | same | `opacity: 0.55; background: rgba(255,255,255,0.22); border-color: rgba(255,255,255,0.3)` |
| `.soon .row` (settings) | rows inside a "coming soon" card | `cursor: not-allowed` |
| `.tool.soon` (onboarding) | onboarding 337 | `opacity: 0.55` |
| `.project-card.closed` | closed project | legacy `opacity: 0.6`, v8 `opacity: 0.55` |
| `.naming-seg.dragging` | segment being dragged | `opacity: 0.65; box-shadow: 0 8px 24px rgba(0,0,0,0.22)` |
| `.card.test` (admin) | test watch row | `border-style: dashed; opacity: .9` |
| `.doc-row.failed` | template refused / failed to build | `cursor: default` + the error colours above |
| `#screen-project .project-card-status` | the project-detail status pill | `cursor: default` |

---

## 24. Conditionally rendered elements

Everything below is absent from the DOM, or carries `hidden` / `display: none`,
until the named condition holds. Grouped by surface.

### 24.1 App — screens

| Element | Rendered when |
| --- | --- |
| `#screen-brief.active` | initial state, and after `showScreen('brief')` |
| `#screen-progress.active` | a brief job has been started and is polling |
| `#screen-picker.active` | `data.needsAssetPick` is true — the brief named no assets at all (app 2832–2836). Checked **before** `needsConfirmation` |
| `#screen-confirm.active` | `data.needsConfirmation` is true — the parsed plan has a count > 1 or a labelled instance (app 2839–2843) |
| `#screen-output.active` | neither of the two above; the run produced documents |
| `#screen-generating.active` | a draft / regenerate / riff call is in flight |
| `#screen-copydone.active` | a draft returned and the copy doc was re-read |
| `#screen-history.active` | Projects nav item |
| `#screen-project.active` | a project card or a notification target was opened |

### 24.2 App — elements inside a screen

| Element | Rendered when |
| --- | --- |
| `#brief-error`, `#progress-error`, `#picker-error`, `#confirm-error`, `#output-error`, `#copydone-error`, `#history-error`, `#project-error` (`.error`) | `showError` sets text; cleared to `hidden` by `clearError` |
| `#file-tags` `.file-tag` chips | one per attached file; the container is empty until a file is picked |
| `.file-tag .ext` | always inside a tag — carries the uppercased extension |
| `#progress-check-projects` (`.cta-primary`) | `offerCheckProjects` true (app 1874) — the job outlived the poller |
| `#progress-back` (`.cta-secondary`) | shown on a progress error path; `hidden` by default (app 1821) |
| `.progress-track.pulsing` | the estimate has been exhausted and the bar is capped below full (app 1852) |
| `#picker-empty` (`.empty`) | the search filter matched no asset — `shown.length === 0` (app 2646) |
| `#picker-unmatched` (`.notice`) | `interp.unmatchedNotice` is non-empty (app 2629) |
| `#confirm-unmatched` (`.notice`) | `interp.unmatchedNotice` is non-empty (app 2723) |
| `#out-unmatched` (`.notice`) | `data.unmatchedNotice` — the brief named an asset the library has no type for (app 2509) |
| `#out-missing-fact` (`.notice`) | `data.missingFactNotice` — a `fact_kind` field whose fact the brief never supplied (app 2515) |
| `#copydone-shortfall` (`.notice`) | `short && data.failureReason` — `fieldsAttempted > 0 && fieldCount < fieldsAttempted` (app 3096); cleared on every reload (app 3306) |
| `#copydone-fallback` (`.note`) | the copy doc could not be re-read, so the screen falls back to "Open in Drive" (app 3301) |
| `#out-assets-label`, `#out-assets-hint`, `#open-doc-btn` | `hasCopyDoc` — `!!state.docId` (app 2524–2527). Hidden on a template-only brief |
| `#open-btn`, `#copydone-open-btn` (`Campaign folder`) | `!!state.folderUrl` (app 3461) |
| `.doc-row` | one per document the run produced; a brief that made one document renders one row |
| `.doc-row.failed` + `.doc-row-note` | `r.built === false` — a template refused or failed to build (app 2563) |
| `.doc-row-note` | the row carries a note (`r.note`) — app 2569 |
| `.doc-row-go` (`›`) | only on a built row — `r.built` true (app 2574) |
| `.asset-card-badge.drafted` | `opts.drafted` true (app 2277) |
| `.asset-card-count`, `.asset-card-chev` | `opts.collapsible` — the header is rendered as a `<button>` (app 2271, 2286, 2288) |
| `.asset-card.collapsed` | `opts.collapsed` at build time, or after tapping the header band (app 2289, 2292) |
| `.asset-direction` | the asset row carries `asset_direction` (app 2301) |
| `.asset-field.has-copy` | the field has drafted copy |
| `.field-char.placeholder` ("Not yet drafted") | `showPlaceholder` and the field has no copy (app 2351) |
| `.field-char.over` | `n > f.charMax`, or a word field with `n > 0 && n < f.charMin` (app 2337–2338) |
| `.field-count` | the field has a limit to show (app 2341, 2353) |
| `.field-options` ("N options") | the field has more than one riff option (app 2322) |
| `.doorway-chip` | the option carries a doorway label (app 2327) |
| `.asset-field.selectable` | `opts.selectable` (app 2367) |
| `.field-check` (`✓`) | the field is `.selected` — CSS `display: none` → `flex` |
| `.field-expand` | the field is `.selected` — CSS `display: none` → `inline-flex` |
| `.var-controls` | the field is `.expanded` — CSS `display: none` → `flex` |
| `.field-no-riff` | `hasCopy && opts.riff && !roomBelow` — a marker with no room beneath it (app 2392); visible only while `.selected` |
| `.riff-row` / `.riff-btn` | `hasCopy && opts.riff && roomBelow` (app 2834) |
| `.riff-divider` / `.riff-divider-label` | the field copy holds more than one riff line (app 2206) |
| `.matrix-row` | one per angle row the writer has added |
| `.matrix-tick.on` | the tick index equals the slider value (app 2132, 2141) |
| `.angle-menu.open` | an angle trigger was tapped (app 1977) |
| `.angle-menu-item.on` | the item's `data-angle` equals the row's current angle (app 1957) |
| `body.angle-menu-lock` | while an angle menu is open (app 1998) |
| `.asset-card.reveal` | applied after render to animate cards in (app 2433, 3254) |
| `.filter-chip.active` | the chip's `data-filter` is the current filter (app 3533) |
| `.project-card.closed` | the project's status is `closed` |
| `#history-loading`, `#project-loading` (`.loading`) | while the projects list / project content is being fetched |
| `#history-empty` (`.empty`) | the tenant has no projects |
| `#project-fallback` (`.empty`) | project content could not be read |
| `.status-dropdown.open` | a status pill was tapped (app 3592) |
| `#project-docs` (`.glass-panel list`) | `onIndex` — the project has more than one document and none is currently open (app 4016) |
| `#project-review-btn` | `drafted` — there is copy to review (app 3705) |
| `#project-primary-btn` | `docId` is set (app 3700) |
| `#project-template-btn` | `!onIndex && p.template_doc_url` (app 3892) |
| `#project-doc-btn` | `!onIndex && p.copy_doc_url` (app 3895) |
| `#project-open-btn` | `p.drive_folder_url` (app 3898, 4061) |
| `#project-back` label "← Back to documents" | `!onIndex && kinds.length > 1` — otherwise "← Back to projects" (app 4022) |
| `.modal-overlay.open` (`#regen-modal`, `#project-regen-modal`, `#project-review-modal`) | Regenerate / Review tapped (app 3387, 4308, 4209) |
| `#project-review-modal-open` (`.modal-btn`) | the review produced a document to open |
| `.review-panel.error` | the review call failed (app 2797) |
| `.toast.show` | `showToast()` (app 3233); auto-dismisses |
| `#stale-shell-banner` | `live && live !== 'unknown' && APP_BUILD !== '__BUILD__' && live !== APP_BUILD` — the running shell is older than the deployed commit (app 2938–2946) |
| `.cta-primary:disabled` state on `#picker-build-btn` | ships `disabled`; enabled once at least one asset is ticked |
| cloud `<svg>`s inside `.clouds-wrap` | injected at load by `populateClouds` (app 4488) — 6+ per page from `cloudConfigs` |

### 24.3 Settings

| Element | Rendered when |
| --- | --- |
| `#settings-hub` (`.hub`) | default landing; hidden once a section is opened |
| `.layout` | a section has been opened (ships with `hidden`) |
| `.panel.active` | its tab / hub card is the current section |
| `#voice-empty` (`.empty`) | the tenant has no voice guide |
| `#voice-view` | a voice guide exists |
| `#voice-questions` | the questionnaire is running |
| `#voice-generating` (`.note`) | the guide is being generated |
| `#voice-editor` (`textarea.terminal`) | Edit was pressed on the voice view |
| `#voice-banner`, `#ws-banner` (`.banner`) | a save succeeded |
| `#voice-error`, `#ws-error`, `#lib-error`, `#tpl-error`, `#acct-error`, `#hdr-error`, `#naming-error` (`.error`) | the matching request failed |
| `#voice-loading`, `#ws-loading`, `#lib-loading`, `#tpl-loading`, `#hdr-loading`, `#naming-loading` (`.note`) | while that section is fetching |
| `#lib-summary` (`.note`) | the library load returned counts |
| `#folder-edit` / `#folder-view` | Edit / Cancel on the default-folder card |
| `.card.soon` + `.badge-soon` | the connector is not yet available (Teams, Notion, OneDrive) — static markup |
| `#tpl-unavailable` (`.note`) | `data.available === false` — no database connection (settings 2432) |
| `#tpl-chosen` (`.note`), `#tpl-upload-btn`, `#tpl-namerow` | a file has been chosen — `!!tplFile` (settings 2444–2446) |
| `.tpl-warn` | the template holds a malformed marker (settings 2417) |
| `.tpl-empty` | the template yielded no markers (settings 2205) |
| `.tpl-count` (`×N`) | `m.count > 1` (settings 2224) |
| `.tpl-where` | the marker records where it was found |
| `.cf-panel` | "Confirm the fields" was opened |
| `.cf-row.off` | the marker is not ticked `is_copy` |
| `.cf-guess` | no label was read from that row (settings 2356) |
| `.lib-asset.off` | `a.is_active === false` (settings 1216) |
| `.lib-group` | the asset row carries a `group` (settings 1226) |
| `.lib-dir` | the asset carries `asset_direction` (settings 1316) |
| `.lib-editbtn` | label is `Edit` when `a.editable`, else `Set limits` (settings 1304) |
| `.lib-grouplabel` | the field carries a `group_label` (settings 1324); `.lib-field.grouped` on the fields beneath it |
| `.lib-tier.enforced` / `.recommended` / `.house_default` | the field's `spec_type` (settings 1186) |
| `.lib-tier.mine` ("Yours") | `f.spec_overridden` (settings 1341) |
| `.lib-fresh` | freshness data exists for the field; `.lib-fresh.flagged` when `fr.state !== 'clean'` (settings 1163) |
| `.lib-fresh-m` | the machine line is present (settings 1179) |
| `.lib-field.lib-hit` | a `spec_change` notification named this field — 2.4s highlight |
| `.lib-new` | the create/edit asset form was opened |
| `.lib-frow.locked` | the field's tier is outside `{ null, 'house_default' }` |
| `.lib-frow.dirty` | the user edited that row and the paste box would otherwise overwrite it |
| `.lib-fstatic` / `.lib-fstaticnote` | a locked row — renders values as text instead of inputs (settings 1452, 1455) |
| `.lib-fnotewrap` / `.lib-fnotebtn` | mutually exclusive — `noteWrap` shown when open, `noteBtn` when closed (settings 1515, 1789) |
| `.lib-reset` / `.lib-resetbtn` / `.lib-basehint` | the field carries an override (settings 1533–1552); `.lib-reset:empty` hides the empty container |
| `.lib-notewhy` / the paste-help head | `n === 0` hides them (settings 1903–1904) |
| `.lib-kept` | the reconciler protected at least one edit — `parts.length > 0` (settings 1920) |
| `.lib-rowerr` | a toggle write failed |
| `.lib-newerr` | the create/edit form failed validation |
| rename warning (`.lib-hint`) | the asset name was changed — `changed` (settings 1850) |
| `#hdr-current` / `#hdr-empty` | a header schema exists / does not |
| `#hdr-extracting` (`.note`) | a screenshot is being read |
| `#hdr-editor-wrap` | the header editor was opened |
| `#naming-section` | the naming step is reached |
| `#naming-locked` / `#naming-empty` / `#naming-editor` | a pattern exists / none exists / the editor is open |
| `.naming-empty` | the pattern has no segments (settings 2859) |
| `.np-empty` ("(file name)") | the preview has no segments (settings 2944) |
| `.np-dyn` | the segment is `type === 'dynamic'` (settings 2946) |
| `.naming-seg.dragging` | a segment is being dragged |
| `.toast.show` | a save confirmation; `.toast.locked` + `.tk` on lock-in confirmations (settings 2403, 2954, 3000) |
| `.pv-empty` | a preview table cell or the whole preview is empty (settings 3183, 3201) |

### 24.4 Onboarding

| Element | Rendered when |
| --- | --- |
| `.step.active` (`#step-1` … `#step-6`) | the current step index |
| `.stepdots span.on` | that step is complete |
| `#folder-saved` | a default folder has been saved |
| `#step2-msg` (`.note`), `#step2-error`, `#step3-error`, `#step4-error` (`.error`) | the matching request succeeded / failed |
| `#assets-loading` (`.note`) | the asset library is being fetched |
| `.group` / `.asset-row` / `.toggle` | one group per asset group, one row per asset — built in JS after the fetch |
| `#voice-loading` (`.note`) | the voice step is fetching |
| `#voice-questions` | the questionnaire is running |
| `#voice-generating` + `.spinner` + `.genmsg` | the guide is generating |
| `#voice-review` + `.preview.md` | a guide came back |
| `#voice-edit` (`textarea`) | Edit was pressed |
| `.md-h` / `.md-ul` / `.md-p` / `strong` | emitted by the markdown renderer per block type |
| `.tool.soon` + `.tool-badge.soon` | the tool is not yet available (Teams) — static markup |

### 24.5 Nav partial (app + settings)

| Element | Rendered when |
| --- | --- |
| `.nav-bell-count.on` | `state.unread > 0`; text is `99+` above 99 |
| `.nav-bell.open` | the panel is open |
| `.notif-panel.open` | the bell was clicked |
| `.notif-item` | one per notification returned by `/api/notifications` |
| `.notif-item.unread` | `!n.readAt && !markedRead(n.id)`, or the row was unread when the panel was opened |
| `.notif-item.warn` | `n.type === 'draft_incomplete'` — mark `⚠` |
| `.notif-item.spec` | `n.type === 'spec_change'` — mark `⚙` |
| `.notif-mark` `✓` | any other type |
| `.notif-when` | `n.createdAt` parses to a time |
| `.notif-empty.on` | `state.items.length === 0` |

### 24.6 Admin

| Element | Rendered when |
| --- | --- |
| `.card` per flag | one per pending flag; `#realList` and `#testList` are separate hosts |
| `.card.test` + `.badge.test` | `f.is_test` / `w.is_test` true |
| `.badge.real` | otherwise |
| `button.primary` "Approve…" | `!isTest` — test flags can only be dismissed (admin JS 150) |
| `.empty` ("None pending.") | `list.length === 0` (admin JS 138) |
| `tr.err-row` | `!observed && (w.last_error \|\| fails > 1 \|\| isStuck)` (admin JS 86) |
| `.note` "observed practice" | `source_kind === 'observed_practice'` (admin JS 90) |
| `.note` "N failed runs in a row" | `fails > 0` (admin JS 98) |
| `.note` "ages rather than changes; can never raise a flag" | observed-practice rows (admin JS 110) |
| `.note` unconfirmed reason | `w.unconfirmed_reason` set (admin JS 115) |
| `#overlay` + `#panel` | an approve flow was opened; `closeOverlay()` hides it |
| `.msg` | "Reading the source page…" while suggesting (admin JS 215) |
| `.msg.ok` | the suggest filled values, or the write succeeded (admin JS 234, 314) |
| `.msg.err` | health load / list load / suggest / preview failed, or no field was checked (admin JS 49, 130, 219, 274, 277) |
| `.msg.warn` + `.diverge` | tenant rows hold differing values for a field about to be overwritten (admin JS 288, 260) |
| `.diff-old` / `.diff-new` | rendered per changed field in the preview diff (admin JS 302) |

### 24.7 Landing

The landing page has no conditional elements — `LANDING_HTML` is a static string
with no script.

---

## 25. Colour inventory

Every colour literal that appears in a **CSS declaration** across the six
style blocks, with a count of how many places it appears. CSS comments are
excluded (several hex values appear only inside explanatory comments — see the
note under the table). Values are listed exactly as written, so `#fff` and
`#FFFFFF`, `rgba(255,255,255,.2)` and `rgba(255,255,255,0.2)`, and `#c0392b`
and `#C0392B` are separate rows. Whitespace inside `rgb()`/`rgba()` has been
removed for grouping only.

**186 distinct literals, 550 occurrences.**

| Colour | Total | Per surface |
| --- | --- | --- |
| `#fff` | 24 | settings 10, app 9, nav 3, onboarding 2 |
| `rgba(255,255,255,0.5)` | 20 | settings 10, app 9, onboarding 1 |
| `rgba(26,26,46,0.75)` | 20 | settings 19, onboarding 1 |
| `#4DD9D9` | 14 | app 4, settings 3, nav 3, onboarding 2, landing 1, admin 1 |
| `rgba(26,26,46,0.6)` | 12 | onboarding 6, settings 4, app 2 |
| `rgba(255,255,255,0.4)` | 11 | app 4, onboarding 3, settings 2, nav 2 |
| `rgba(26,26,46,0.5)` | 11 | app 8, onboarding 2, settings 1 |
| `#8a1f1f` | 10 | settings 7, app 2, onboarding 1 |
| `rgba(255,255,255,0.68)` | 10 | settings 8, app 2 |
| `rgba(255,255,255,0.55)` | 9 | settings 5, app 2, onboarding 1, nav 1 |
| `rgba(255,255,255,0.08)` | 8 | app 4, nav 2, settings 1, onboarding 1 |
| `rgba(255,255,255,0.6)` | 8 | settings 3, onboarding 3, app 2 |
| `rgba(26,26,46,0.4)` | 8 | app 4, settings 3, onboarding 1 |
| `#2FA8DC` | 7 | app 3, settings 2, onboarding 2 |
| `rgba(255,255,255,0.45)` | 7 | onboarding 3, app 2, settings 1, nav 1 |
| `rgba(26,26,46,0.55)` | 7 | app 3, settings 3, onboarding 1 |
| `rgba(26,26,46,0.65)` | 7 | app 3, settings 3, onboarding 1 |
| `rgba(26,26,46,0.7)` | 7 | app 5, settings 2 |
| `rgba(26,26,46,0.9)` | 7 | app 2, settings 2, onboarding 2, nav 1 |
| `rgba(77,217,217,0.2)` | 7 | app 3, settings 2, onboarding 2 |
| `#1E78BE` | 6 | app 2, settings 2, onboarding 2 |
| `rgba(255,255,255,0.3)` | 6 | settings 4, app 2 |
| `rgba(255,255,255,0.7)` | 6 | app 5, settings 1 |
| `rgba(255,255,255,0.85)` | 6 | onboarding 3, settings 2, app 1 |
| `rgba(26,26,46,0.08)` | 6 | app 2, settings 2, onboarding 2 |
| `rgba(26,26,46,0.72)` | 6 | app 3, settings 3 |
| `#0A5C32` | 5 | app 3, settings 1, onboarding 1 |
| `#1A1A2E` | 5 | app 3, settings 1, onboarding 1 |
| `rgba(255,255,255,0.22)` | 5 | settings 3, app 2 |
| `rgba(255,255,255,0.35)` | 5 | settings 2, app 1, onboarding 1, nav 1 |
| `rgba(255,255,255,0.95)` | 5 | settings 2, onboarding 2, app 1 |
| `rgba(26,26,46,0.06)` | 5 | app 3, settings 2 |
| `rgba(26,26,46,0.45)` | 5 | app 3, settings 2 |
| `#c0392b` | 4 | app 4 |
| `#C6F0D8` | 4 | app 3, settings 1 |
| `#C9A84C` | 4 | app 2, settings 1, onboarding 1 |
| `#e7b3b3` | 4 | settings 2, app 1, onboarding 1 |
| `#fdf0f0` | 4 | settings 2, app 1, onboarding 1 |
| `rgba(255,255,255,0.25)` | 4 | onboarding 2, app 1, settings 1 |
| `rgba(255,255,255,0.42)` | 4 | settings 3, app 1 |
| `rgba(255,255,255,0.52)` | 4 | app 4 |
| `rgba(26,26,46,0.1)` | 4 | app 2, onboarding 2 |
| `rgba(26,26,46,0.14)` | 4 | app 4 |
| `#06302f` | 3 | onboarding 2, app 1 |
| `#1a9a9a` | 3 | settings 3 |
| `#1C1F3B` | 3 | landing 1, settings 1, admin 1 |
| `#2ECC71` | 3 | app 2, settings 1 |
| `#3BBDE0` | 3 | app 1, settings 1, onboarding 1 |
| `#DDB95A` | 3 | app 1, settings 1, onboarding 1 |
| `#e3e3e3` | 3 | app 2, settings 1 |
| `#F5F0E8` | 3 | landing 1, settings 1, admin 1 |
| `#f6f6f6` | 3 | app 2, settings 1 |
| `#FFFFFF` | 3 | app 1, settings 1, onboarding 1 |
| `rgba(201,168,76,0.10)` | 3 | app 3 |
| `rgba(201,168,76,0.22)` | 3 | app 3 |
| `rgba(201,168,76,0.35)` | 3 | app 3 |
| `rgba(201,168,76,0.6)` | 3 | settings 2, app 1 |
| `rgba(255,255,255,0.06)` | 3 | nav 2, app 1 |
| `rgba(255,255,255,0.14)` | 3 | app 3 |
| `rgba(255,255,255,0.18)` | 3 | app 2, settings 1 |
| `rgba(255,255,255,0.38)` | 3 | app 3 |
| `rgba(255,255,255,0.75)` | 3 | settings 2, app 1 |
| `rgba(255,255,255,0.78)` | 3 | onboarding 2, settings 1 |
| `rgba(26,26,46,0.12)` | 3 | app 1, settings 1, onboarding 1 |
| `rgba(26,26,46,0.2)` | 3 | app 1, settings 1, onboarding 1 |
| `rgba(26,26,46,0.28)` | 3 | app 2, settings 1 |
| `rgba(26,26,46,0.3)` | 3 | settings 2, app 1 |
| `rgba(77,217,217,0.12)` | 3 | app 1, settings 1, nav 1 |
| `rgba(77,217,217,0.15)` | 3 | app 1, settings 1, onboarding 1 |
| `#0a5d2a` | 2 | app 1, settings 1 |
| `#111` | 2 | app 1, settings 1 |
| `#6b3a00` | 2 | settings 2 |
| `#999` | 2 | settings 2 |
| `#b3e6c4` | 2 | app 1, settings 1 |
| `#C0392B` | 2 | app 1, settings 1 |
| `#d8f5e0` | 2 | app 1, settings 1 |
| `rgba(0,0,0,0.3)` | 2 | app 2 |
| `rgba(0,0,0,0.35)` | 2 | app 1, nav 1 |
| `rgba(184,166,240,0.45)` | 2 | settings 2 |
| `rgba(192,57,43,0.35)` | 2 | app 2 |
| `rgba(201,168,76,0.14)` | 2 | app 2 |
| `rgba(201,168,76,0.16)` | 2 | app 2 |
| `rgba(201,168,76,0.3)` | 2 | settings 1, onboarding 1 |
| `rgba(201,168,76,0.55)` | 2 | app 2 |
| `rgba(255,255,255,.2)` | 2 | admin 2 |
| `rgba(255,255,255,0.28)` | 2 | app 1, settings 1 |
| `rgba(255,255,255,0.32)` | 2 | app 2 |
| `rgba(255,255,255,0.82)` | 2 | app 2 |
| `rgba(255,255,255,0.9)` | 2 | app 2 |
| `rgba(26,26,46,0.05)` | 2 | app 1, settings 1 |
| `rgba(26,26,46,0.10)` | 2 | app 2 |
| `rgba(26,26,46,0.35)` | 2 | app 2 |
| `rgba(26,26,46,0.68)` | 2 | app 1, settings 1 |
| `rgba(26,26,46,0.78)` | 2 | app 1, onboarding 1 |
| `rgba(26,26,46,0.82)` | 2 | app 1, settings 1 |
| `rgba(26,26,46,0.88)` | 2 | settings 1, onboarding 1 |
| `rgba(26,26,46,0.92)` | 2 | app 1, settings 1 |
| `rgba(77,217,217,0.35)` | 2 | app 1, settings 1 |
| `rgba(77,217,217,0.45)` | 2 | settings 1, onboarding 1 |
| `#0a5c5c` | 1 | settings 1 |
| `#0d6b6b` | 1 | onboarding 1 |
| `#12506a` | 1 | settings 1 |
| `#1a1a2e` | 1 | settings 1 |
| `#1f4d31` | 1 | settings 1 |
| `#444` | 1 | settings 1 |
| `#555` | 1 | app 1 |
| `#5a4b00` | 1 | app 1 |
| `#5a5a5a` | 1 | settings 1 |
| `#5FB98E` | 1 | admin 1 |
| `#666` | 1 | app 1 |
| `#6b520f` | 1 | app 1 |
| `#737373` | 1 | app 1 |
| `#7A5500` | 1 | app 1 |
| `#7A5E12` | 1 | app 1 |
| `#808080` | 1 | settings 1 |
| `#888` | 1 | app 1 |
| `#8A6A15` | 1 | app 1 |
| `#8a6d3b` | 1 | settings 1 |
| `#a5382a` | 1 | app 1 |
| `#B7C2C6` | 1 | app 1 |
| `#B8A6F0` | 1 | nav 1 |
| `#bbb` | 1 | settings 1 |
| `#dcdcdc` | 1 | app 1 |
| `#e3cf94` | 1 | app 1 |
| `#E4572E` | 1 | nav 1 |
| `#E86A6A` | 1 | admin 1 |
| `#E8908A` | 1 | app 1 |
| `#E8A33D` | 1 | admin 1 |
| `#E8B84B` | 1 | nav 1 |
| `#ededed` | 1 | app 1 |
| `#f0e0a0` | 1 | app 1 |
| `#f2f2f2` | 1 | app 1 |
| `#fdf8ec` | 1 | app 1 |
| `#FFF0B3` | 1 | app 1 |
| `#fff4cc` | 1 | app 1 |
| `%23C9A84C` | 1 | app 1 |
| `rgba(0,0,0,.25)` | 1 | admin 1 |
| `rgba(0,0,0,.6)` | 1 | admin 1 |
| `rgba(0,0,0,0.12)` | 1 | app 1 |
| `rgba(0,0,0,0.22)` | 1 | settings 1 |
| `rgba(0,0,0,0.28)` | 1 | app 1 |
| `rgba(0,0,0,0.32)` | 1 | settings 1 |
| `rgba(10,92,50,0.2)` | 1 | app 1 |
| `rgba(122,85,0,0.2)` | 1 | app 1 |
| `rgba(184,166,240,0.35)` | 1 | settings 1 |
| `rgba(192,57,43,0.05)` | 1 | app 1 |
| `rgba(192,57,43,0.08)` | 1 | settings 1 |
| `rgba(192,57,43,0.25)` | 1 | settings 1 |
| `rgba(201,168,76,0.08)` | 1 | app 1 |
| `rgba(201,168,76,0.12)` | 1 | app 1 |
| `rgba(201,168,76,0.38)` | 1 | app 1 |
| `rgba(201,168,76,0.4)` | 1 | app 1 |
| `rgba(201,168,76,0.45)` | 1 | app 1 |
| `rgba(201,168,76,0.7)` | 1 | app 1 |
| `rgba(201,168,76,0.85)` | 1 | app 1 |
| `rgba(201,168,76,0.9)` | 1 | app 1 |
| `rgba(214,236,246,0.97)` | 1 | app 1 |
| `rgba(224,168,74,.15)` | 1 | admin 1 |
| `rgba(232,106,106,.12)` | 1 | admin 1 |
| `rgba(232,106,106,.15)` | 1 | admin 1 |
| `rgba(255,255,255,.05)` | 1 | admin 1 |
| `rgba(255,255,255,.1)` | 1 | admin 1 |
| `rgba(255,255,255,.12)` | 1 | admin 1 |
| `rgba(255,255,255,0.1)` | 1 | app 1 |
| `rgba(255,255,255,0.16)` | 1 | app 1 |
| `rgba(255,255,255,0.2)` | 1 | app 1 |
| `rgba(255,255,255,0.30)` | 1 | app 1 |
| `rgba(255,255,255,0.8)` | 1 | app 1 |
| `rgba(255,255,255,0.92)` | 1 | app 1 |
| `rgba(26,26,46,0.18)` | 1 | settings 1 |
| `rgba(26,26,46,0.22)` | 1 | settings 1 |
| `rgba(26,26,46,0.25)` | 1 | settings 1 |
| `rgba(26,26,46,0.32)` | 1 | app 1 |
| `rgba(26,26,46,0.38)` | 1 | app 1 |
| `rgba(26,26,46,0.48)` | 1 | app 1 |
| `rgba(26,26,46,0.62)` | 1 | app 1 |
| `rgba(26,26,46,0.8)` | 1 | app 1 |
| `rgba(26,26,46,0.95)` | 1 | app 1 |
| `rgba(26,26,46,0.96)` | 1 | app 1 |
| `rgba(26,26,46,0.97)` | 1 | nav 1 |
| `rgba(77,217,217,0.07)` | 1 | nav 1 |
| `rgba(77,217,217,0.18)` | 1 | nav 1 |
| `rgba(77,217,217,0.25)` | 1 | app 1 |
| `rgba(77,217,217,0.55)` | 1 | app 1 |
| `rgba(77,217,217,0.97)` | 1 | app 1 |
| `rgba(95,185,142,.15)` | 1 | admin 1 |

### 25.1 Keyword and non-literal colour values in the CSS

| Value | Occurrences | Where |
| --- | --- | --- |
| `transparent` | 43 | all six style blocks — spinner `border-top-color`, `.btn-secondary` background, `.cta-secondary` on landing, `.project-card-status` border, `.lib-funit.locked select` border-color, gradient stops, `@keyframes libHit` end state, etc. |
| `inherit` | 24 | `font: inherit` on buttons/inputs, `color: inherit` on `button.asset-card-header`, `font-family: inherit` on `.notif-item` and `.lib-resetbtn`, `.lib-fresh-v a { color: inherit }` |
| `currentColor` | 1 | `.nav-bell svg { fill: currentColor }` (nav partial) |
| `none` (as a background value) | many | `background: none` on ghost/icon buttons throughout |

The `.matrix-angle-caret` background is an inline SVG data-URI whose stroke is
`%23C9A84C` — the URL-encoded form of `#C9A84C`. It is counted in the table above
under `%23C9A84C`.

### 25.2 Colour values that appear only in CSS comments

These are written in the stylesheets but are not declarations. They are recorded
because a search for a hex value will find them.

| Value | Count | Where |
| --- | --- | --- |
| `#8a4b00` | 2 | settings — the superseded `.lib-tier.enforced` amber, quoted in the contrast-measurement comments |
| `#1E6F8E` | 1 | settings — the superseded `.lib-tier.recommended` blue |
| `#2f6b46` | 1 | settings — the superseded `.lib-tier.mine` green |
| `rgb(129,142,156)` | 1 | app — a measured composite, in the `.asset-card-count` note |
| `rgb(212,237,246)` | 1 | app — the measured header-band surface, same note |
| `rgba(...,.78)` | 1 | app — a shorthand reference to `.section-body` in the `.glass-panel` note |

### 25.3 Colour values declared outside a `<style>` block

Inline `style` attributes and inline SVG `fill` attributes. Not part of §25.

| Value | Count | Where |
| --- | --- | --- |
| `#4DD9D9` | 14 | `settings.html` hub-card SVG `fill` |
| `#1C1F3B` | 11 | `settings.html` hub-card SVG `fill` |
| `#C9A84C` | 5 | `settings.html` hub-card SVG `fill` (4) + `app.html` `.status-dot-preview` inline `background` (1) |
| `#FFFFFF` | 3 | `settings.html` hub-card SVG `fill` |
| `#F5F0E8` | 3 | `settings.html` hub-card SVG `fill` |
| `#B8E4F8` | 3 | cloud rect `fill`, set in JS (`app`, `settings`, `onboarding` — one each) |
| `#C0392B` | 1 | `app.html` `#stale-shell-banner` inline `background` |
| `#fff` | 1 | `app.html` `#stale-shell-banner` inline `color` |
| `#2ECC71` | 1 | `app.html` `.status-dot-preview` inline `background` |
| `#0A5C32` | 1 | `app.html` `.status-dot-preview` inline `border` |
| `#7A5500` | 1 | `app.html` `.status-dot-preview` inline `border` |
| `rgba(26,26,46,0.14)` | 2 | `app.html` inline styles |
| `rgba(26,26,46,0.3)` | 1 | `app.html` `.status-dot-preview` inline `border` |
| `rgba(255,255,255,0.6)` | 1 | `app.html` `.status-dot-preview` inline `background` |
| `rgba(0,0,0,0.25)` | 1 | `app.html` `#stale-shell-banner` inline `box-shadow` |
| `white` | — | cloud rect `fill` for rows above the shading line, set in JS |

---

## 26. Selectors declared with no matching markup

Rules present in a stylesheet for which no element carrying that class was found
in the surface's static markup or its JavaScript. Recorded as a fact about the
current source, not as a judgement.

### app.html

`nav .brand`, `nav .links`, `nav .navlink`, `nav .navlink:hover`,
`nav .navlink:active`, `h1` (legacy — the only `<h1>` carries `.brief-headline`),
`button.primary`, `button.secondary`, `.brief-attach`, `.summary`, `.direction`,
`.asset`, `.asset h3`, `.asset .badge`, `.asset.drafted .badge`, `.field`,
`.field .name`, `.field .limit`, `.field .count`, `.field .count.over`,
`.actions` (the live CTA container is `.output-ctas`), `.regen`, `.regen-input`
(as a standalone element — the modal textareas carry `.modal-textarea`),
`.field-copy.empty`, `.status` and its four modifiers (`.not_started`,
`.in_progress`, `.finished`, `.closed`), `.status-select`, `.card-close`,
`.card-close:hover`, `.project-card .meta`, `.project-card .pname`,
`.project-card .pdate`, `.project-card .right`, `.project-card .open-link`,
`.steps`, `.steps li` and its `.working` / `.done` modifiers, `.titlerow`,
`.copydone-sub`, `.draft-status`, `.meta-assets`, `.meta-divider`,
`.matrix-angle-label` (the element is created at app 2084 but no rule declares it).

### settings.html

`nav .brand`, `nav .links`, `nav .navlink`, `nav .navlink:hover`,
`nav .navlink.active` — the nav partial uses `.nav-logo` / `.nav-link`.
`.hdr-cols` (declared at settings 164–165; no element carries the class).

Two related facts rather than orphans: the v8 `.eyebrow` rule is
`display: none`, so the four `.eyebrow` elements that do exist (settings 771,
886, 901, 944) render nothing; and `el('div','v','Horizontal rule')` (settings
3129) sits inside a `.hdr-block`, not a `.card`, so the `.card .v` rule does not
reach it and it has no rule of its own.

`.hdr-block > input` **is** used — `hdrInp` appends an `<input>` directly to a
heading block's card (settings 3126).

### admin.html

`button.danger`. Every other declared rule has matching markup.

### onboarding.html / nav.html / landing

No declared-but-unused selectors were found.

---

## 27. Notes on the record

- **Two stylesheets in one file.** `app.html` and `settings.html` each contain a
  legacy block and a v8 block that redeclare `:root`, `body`, `nav`, `main`,
  `h1`, `h2`, `label`, `input`, `textarea`, `button.btn`, `.card`, `.tab`,
  `.pill`, `.terminal`, `.badge-soon`, `.note`, `.banner`, `.error`, `.empty`,
  `.progress`, `.attach-btn`, `.file-tag`, `.project-card`, `.asset-direction`,
  `.field-copy`, `.regen-input`, `.closed-toggle` and `.sidebar`. Both sets of
  values are recorded above.
- **`--ink` changes meaning between the two blocks** in `app.html` and
  `settings.html`: `#111` in the legacy `:root`, `#1A1A2E` in the v8 `:root`.
  Every `var(--ink)` in this document resolves to the v8 value at render time.
- **`--muted`** is `#666` in `app.html` and `#5a5a5a` in `settings.html`.
- **`var(--fg)`** is referenced 8 times in `settings.html` and is never defined.
- **`var(--card, #f6f6f6)`** in `app.html` `.file-tag` (legacy) references an
  undefined `--card`.
- **`.hdr-lede`, `.toast.locked`, `.toast.locked .tk`** in `settings.html` use
  `var(--gold)`, which is defined only in the v8 `:root` in the same file.
- **`__BUILD__`** appears in every asset URL (`?v=__BUILD__`) and is replaced with
  the deploy commit by `renderShell` (`src/utils/shellHtml.js`). The landing
  page's font URL has no `?v=` query.
- **`__NAV:<section>__`** in `app.html` (line 1134) and `settings.html` (line
  718) is the splice point for `public/partials/nav.html`; `__ACTIVE:<id>__` in
  the partial becomes ` active` on the matching `.nav-link`.
- Font files are served from `/fonts/`; images, logos and GIFs from
  `/assets/images/`, `/assets/logos/`, `/assets/gifs/`. Only `public/fonts/` and
  `public/assets/` are served statically.
