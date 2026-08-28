# Quillio — Colour Map

The distinct colour literals in the app's CSS, grouped by perceptual similarity.
**This assigns no replacements and proposes no palette.** It is the input to that
decision, not the decision.

## What is counted

Every colour literal appearing in a CSS **declaration** inside the six `<style>`
blocks (`app.html`, `settings.html`, `onboarding.html`, `admin.html`,
`partials/nav.html`, and `LANDING_HTML` in `src/server.js`). Comments are
stripped first. Literals are listed exactly as written, so `#fff` and `#FFFFFF`,
and `rgba(255,255,255,.2)` and `rgba(255,255,255,0.2)`, are separate rows.

Two columns of counts, because this branch changed one of them:

| | Distinct literals | Occurrences |
| --- | --- | --- |
| Before this branch (inventory §25) | 186 | 550 |
| After the dead-rule deletions | 177 | 524 |

The 9 literals that fell to zero are all from rules deleted as unreachable
(the `.status.*` badge family, and `--ink: #111`). They are kept in the tables
below with a current count of **0**, so this map still accounts for every literal
the inventory recorded:

`#111` · `#555` · `#5a4b00` · `#888` · `#dcdcdc` · `#ededed` · `#f0e0a0` · `#f2f2f2` · `#fff4cc`

## How the grouping works

Each literal is reduced to its base sRGB triple and converted to **OKLCh**
(perceptual lightness, chroma, hue). Grouping is by that triple first — a colour
used at eleven alphas is one colour, not eleven — and the triples are then sorted
into families by hue and lightness. Alpha is carried as a variant axis, not as a
separate colour.

Four base colours dominate and are given their own sections; everything else
follows in perceptual families. `L`/`C`/`H` are OKLCh values for the base triple.

### Distribution at a glance

| Section | Family | Base colours | Literals | Occurrences |
| --- | --- | --- | --- | --- |
| A1 | White | 1 | 38 | 182 |
| A2 | Ink navy | 1 | 39 | 154 |
| A3 | Sky cyan | 1 | 11 | 36 |
| A4 | Gold | 1 | 18 | 33 |
| B1 | Neutral — white / near-white | 9 | 9 | 18 |
| B2 | Neutral — light grey | 4 | 4 | 5 |
| B3 | Neutral — mid grey | 6 | 6 | 6 |
| B4 | Neutral — dark grey | 1 | 1 | 2 |
| B5 | Neutral — near-black | 1 | 8 | 10 |
| B6 | Red | 3 | 5 | 8 |
| B7 | Warm red / brown | 5 | 10 | 25 |
| B8 | Amber / gold / olive | 14 | 15 | 17 |
| B9 | Green | 8 | 10 | 22 |
| B10 | Teal | 4 | 4 | 8 |
| B11 | Blue | 4 | 4 | 17 |
| B12 | Indigo / violet | 2 | 4 | 7 |

---

## A1 · White

`#fff` / `#FFFFFF` / `rgba(255,255,255,a)`

**base `rgb(255, 255, 255)`** — L 1.000 · C 0.000 · H — (achromatic) — 38 literals, 182 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#fff` | opaque | 24 | 23 | settings 10, app 9, nav 3, onboarding 2 |
| `rgba(255,255,255,0.5)` | 0.5 | 20 | 19 | settings 10, app 9, onboarding 1 |
| `rgba(255,255,255,0.4)` | 0.4 | 11 | 11 | app 4, onboarding 3, settings 2, nav 2 |
| `rgba(255,255,255,0.68)` | 0.68 | 10 | 10 | settings 8, app 2 |
| `rgba(255,255,255,0.55)` | 0.55 | 9 | 9 | settings 5, app 2, onboarding 1, nav 1 |
| `rgba(255,255,255,0.08)` | 0.08 | 8 | 8 | app 4, nav 2, settings 1, onboarding 1 |
| `rgba(255,255,255,0.6)` | 0.6 | 8 | 7 | settings 3, onboarding 3, app 2 |
| `rgba(255,255,255,0.45)` | 0.45 | 7 | 7 | onboarding 3, app 2, settings 1, nav 1 |
| `rgba(255,255,255,0.3)` | 0.3 | 6 | 6 | settings 4, app 2 |
| `rgba(255,255,255,0.7)` | 0.7 | 6 | 6 | app 5, settings 1 |
| `rgba(255,255,255,0.85)` | 0.85 | 6 | 6 | onboarding 3, settings 2, app 1 |
| `rgba(255,255,255,0.22)` | 0.22 | 5 | 5 | settings 3, app 2 |
| `rgba(255,255,255,0.35)` | 0.35 | 5 | 5 | settings 2, app 1, onboarding 1, nav 1 |
| `rgba(255,255,255,0.95)` | 0.95 | 5 | 5 | settings 2, onboarding 2, app 1 |
| `rgba(255,255,255,0.25)` | 0.25 | 4 | 4 | onboarding 2, app 1, settings 1 |
| `rgba(255,255,255,0.42)` | 0.42 | 4 | 4 | settings 3, app 1 |
| `rgba(255,255,255,0.52)` | 0.52 | 4 | 4 | app 4 |
| `#FFFFFF` | opaque | 3 | 3 | app 1, settings 1, onboarding 1 |
| `rgba(255,255,255,0.06)` | 0.06 | 3 | 3 | nav 2, app 1 |
| `rgba(255,255,255,0.14)` | 0.14 | 3 | 3 | app 3 |
| `rgba(255,255,255,0.18)` | 0.18 | 3 | 3 | app 2, settings 1 |
| `rgba(255,255,255,0.38)` | 0.38 | 3 | 3 | app 3 |
| `rgba(255,255,255,0.75)` | 0.75 | 3 | 3 | settings 2, app 1 |
| `rgba(255,255,255,0.78)` | 0.78 | 3 | 3 | onboarding 2, settings 1 |
| `rgba(255,255,255,.2)` | 0.2 | 2 | 2 | admin 2 |
| `rgba(255,255,255,0.28)` | 0.28 | 2 | 2 | app 1, settings 1 |
| `rgba(255,255,255,0.32)` | 0.32 | 2 | 2 | app 2 |
| `rgba(255,255,255,0.82)` | 0.82 | 2 | 2 | app 2 |
| `rgba(255,255,255,0.9)` | 0.9 | 2 | 1 | app 2 |
| `rgba(255,255,255,.05)` | 0.05 | 1 | 1 | admin 1 |
| `rgba(255,255,255,.1)` | 0.1 | 1 | 1 | admin 1 |
| `rgba(255,255,255,.12)` | 0.12 | 1 | 1 | admin 1 |
| `rgba(255,255,255,0.1)` | 0.1 | 1 | 1 | app 1 |
| `rgba(255,255,255,0.16)` | 0.16 | 1 | 1 | app 1 |
| `rgba(255,255,255,0.2)` | 0.2 | 1 | 1 | app 1 |
| `rgba(255,255,255,0.30)` | 0.3 | 1 | 1 | app 1 |
| `rgba(255,255,255,0.8)` | 0.8 | 1 | 1 | app 1 |
| `rgba(255,255,255,0.92)` | 0.92 | 1 | 1 | app 1 |

## A2 · Ink navy

`#1A1A2E` / `rgba(26,26,46,a)` — the `--ink` token

**base `rgb(26, 26, 46)`** — L 0.228 · C 0.038 · H 282.9° — 39 literals, 154 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `rgba(26,26,46,0.75)` | 0.75 | 20 | 20 | settings 19, onboarding 1 |
| `rgba(26,26,46,0.6)` | 0.6 | 12 | 12 | onboarding 6, settings 4, app 2 |
| `rgba(26,26,46,0.5)` | 0.5 | 11 | 11 | app 8, onboarding 2, settings 1 |
| `rgba(26,26,46,0.4)` | 0.4 | 8 | 7 | app 4, settings 3, onboarding 1 |
| `rgba(26,26,46,0.55)` | 0.55 | 7 | 7 | app 3, settings 3, onboarding 1 |
| `rgba(26,26,46,0.65)` | 0.65 | 7 | 7 | app 3, settings 3, onboarding 1 |
| `rgba(26,26,46,0.7)` | 0.7 | 7 | 6 | app 5, settings 2 |
| `rgba(26,26,46,0.9)` | 0.9 | 7 | 7 | app 2, settings 2, onboarding 2, nav 1 |
| `rgba(26,26,46,0.08)` | 0.08 | 6 | 6 | app 2, settings 2, onboarding 2 |
| `rgba(26,26,46,0.72)` | 0.72 | 6 | 6 | app 3, settings 3 |
| `#1A1A2E` | opaque | 5 | 5 | app 3, settings 1, onboarding 1 |
| `rgba(26,26,46,0.06)` | 0.06 | 5 | 5 | app 3, settings 2 |
| `rgba(26,26,46,0.45)` | 0.45 | 5 | 5 | app 3, settings 2 |
| `rgba(26,26,46,0.1)` | 0.1 | 4 | 4 | app 2, onboarding 2 |
| `rgba(26,26,46,0.14)` | 0.14 | 4 | 4 | app 4 |
| `rgba(26,26,46,0.12)` | 0.12 | 3 | 3 | app 1, settings 1, onboarding 1 |
| `rgba(26,26,46,0.2)` | 0.2 | 3 | 3 | app 1, settings 1, onboarding 1 |
| `rgba(26,26,46,0.28)` | 0.28 | 3 | 3 | app 2, settings 1 |
| `rgba(26,26,46,0.3)` | 0.3 | 3 | 2 | settings 2, app 1 |
| `rgba(26,26,46,0.05)` | 0.05 | 2 | 2 | app 1, settings 1 |
| `rgba(26,26,46,0.10)` | 0.1 | 2 | 2 | app 2 |
| `rgba(26,26,46,0.35)` | 0.35 | 2 | 2 | app 2 |
| `rgba(26,26,46,0.68)` | 0.68 | 2 | 2 | app 1, settings 1 |
| `rgba(26,26,46,0.78)` | 0.78 | 2 | 2 | app 1, onboarding 1 |
| `rgba(26,26,46,0.82)` | 0.82 | 2 | 2 | app 1, settings 1 |
| `rgba(26,26,46,0.88)` | 0.88 | 2 | 2 | settings 1, onboarding 1 |
| `rgba(26,26,46,0.92)` | 0.92 | 2 | 2 | app 1, settings 1 |
| `#1a1a2e` | opaque | 1 | 1 | settings 1 |
| `rgba(26,26,46,0.18)` | 0.18 | 1 | 1 | settings 1 |
| `rgba(26,26,46,0.22)` | 0.22 | 1 | 1 | settings 1 |
| `rgba(26,26,46,0.25)` | 0.25 | 1 | 1 | settings 1 |
| `rgba(26,26,46,0.32)` | 0.32 | 1 | 1 | app 1 |
| `rgba(26,26,46,0.38)` | 0.38 | 1 | 1 | app 1 |
| `rgba(26,26,46,0.48)` | 0.48 | 1 | 1 | app 1 |
| `rgba(26,26,46,0.62)` | 0.62 | 1 | 1 | app 1 |
| `rgba(26,26,46,0.8)` | 0.8 | 1 | 1 | app 1 |
| `rgba(26,26,46,0.95)` | 0.95 | 1 | 1 | app 1 |
| `rgba(26,26,46,0.96)` | 0.96 | 1 | 1 | app 1 |
| `rgba(26,26,46,0.97)` | 0.97 | 1 | 1 | nav 1 |

## A3 · Sky cyan

`#4DD9D9` / `rgba(77,217,217,a)` — `--sky-btm` / `--accent`

**base `rgb(77, 217, 217)`** — L 0.812 · C 0.118 · H 195.1° — 11 literals, 36 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#4DD9D9` | opaque | 14 | 14 | app 4, settings 3, nav 3, onboarding 2, admin 1, landing 1 |
| `rgba(77,217,217,0.2)` | 0.2 | 7 | 7 | app 3, settings 2, onboarding 2 |
| `rgba(77,217,217,0.12)` | 0.12 | 3 | 3 | app 1, settings 1, nav 1 |
| `rgba(77,217,217,0.15)` | 0.15 | 3 | 3 | app 1, settings 1, onboarding 1 |
| `rgba(77,217,217,0.35)` | 0.35 | 2 | 2 | app 1, settings 1 |
| `rgba(77,217,217,0.45)` | 0.45 | 2 | 2 | settings 1, onboarding 1 |
| `rgba(77,217,217,0.07)` | 0.07 | 1 | 1 | nav 1 |
| `rgba(77,217,217,0.18)` | 0.18 | 1 | 1 | nav 1 |
| `rgba(77,217,217,0.25)` | 0.25 | 1 | 1 | app 1 |
| `rgba(77,217,217,0.55)` | 0.55 | 1 | 1 | app 1 |
| `rgba(77,217,217,0.97)` | 0.97 | 1 | 1 | app 1 |

## A4 · Gold

`#C9A84C` / `rgba(201,168,76,a)` — the `--gold` token

**base `rgb(201, 168, 76)`** — L 0.743 · C 0.117 · H 89.5° — 18 literals, 33 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#C9A84C` | opaque | 4 | 4 | app 2, settings 1, onboarding 1 |
| `rgba(201,168,76,0.10)` | 0.1 | 3 | 3 | app 3 |
| `rgba(201,168,76,0.22)` | 0.22 | 3 | 3 | app 3 |
| `rgba(201,168,76,0.35)` | 0.35 | 3 | 3 | app 3 |
| `rgba(201,168,76,0.6)` | 0.6 | 3 | 3 | settings 2, app 1 |
| `rgba(201,168,76,0.14)` | 0.14 | 2 | 2 | app 2 |
| `rgba(201,168,76,0.16)` | 0.16 | 2 | 2 | app 2 |
| `rgba(201,168,76,0.3)` | 0.3 | 2 | 2 | settings 1, onboarding 1 |
| `rgba(201,168,76,0.55)` | 0.55 | 2 | 2 | app 2 |
| `%23C9A84C` | opaque | 1 | 1 | app 1 |
| `rgba(201,168,76,0.08)` | 0.08 | 1 | 1 | app 1 |
| `rgba(201,168,76,0.12)` | 0.12 | 1 | 1 | app 1 |
| `rgba(201,168,76,0.38)` | 0.38 | 1 | 1 | app 1 |
| `rgba(201,168,76,0.4)` | 0.4 | 1 | 1 | app 1 |
| `rgba(201,168,76,0.45)` | 0.45 | 1 | 1 | app 1 |
| `rgba(201,168,76,0.7)` | 0.7 | 1 | 1 | app 1 |
| `rgba(201,168,76,0.85)` | 0.85 | 1 | 1 | app 1 |
| `rgba(201,168,76,0.9)` | 0.9 | 1 | 1 | app 1 |

## B1 · Neutral — white / near-white

**base `rgb(253, 240, 240)`** — L 0.965 · C 0.014 · H 17.4° — 1 literal, 4 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#fdf0f0` | opaque | 4 | 4 | settings 2, app 1, onboarding 1 |

**base `rgb(227, 227, 227)`** — L 0.916 · C 0.000 · H — (achromatic) — 1 literal, 3 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#e3e3e3` | opaque | 3 | 2 | app 2, settings 1 |

**base `rgb(246, 246, 246)`** — L 0.973 · C 0.000 · H — (achromatic) — 1 literal, 3 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#f6f6f6` | opaque | 3 | 4 | app 2, settings 1 |

**base `rgb(245, 240, 232)`** — L 0.957 · C 0.012 · H 79.8° — 1 literal, 3 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#F5F0E8` | opaque | 3 | 3 | settings 1, admin 1, landing 1 |

**base `rgb(253, 248, 236)`** — L 0.980 · C 0.017 · H 88.0° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#fdf8ec` | opaque | 1 | 1 | app 1 |

**base `rgb(237, 237, 237)`** — L 0.946 · C 0.000 · H — (achromatic) — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#ededed` | opaque | 1 | **0** | app 1 |

**base `rgb(220, 220, 220)`** — L 0.894 · C 0.000 · H — (achromatic) — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#dcdcdc` | opaque | 1 | **0** | app 1 |

**base `rgb(242, 242, 242)`** — L 0.961 · C 0.000 · H — (achromatic) — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#f2f2f2` | opaque | 1 | **0** | app 1 |

**base `rgb(214, 236, 246)`** — L 0.930 · C 0.027 · H 226.8° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `rgba(214,236,246,0.97)` | 0.97 | 1 | 1 | app 1 |

## B2 · Neutral — light grey

**base `rgb(153, 153, 153)`** — L 0.683 · C 0.000 · H — (achromatic) — 1 literal, 2 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#999` | opaque | 2 | 2 | settings 2 |

**base `rgb(136, 136, 136)`** — L 0.627 · C 0.000 · H — (achromatic) — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#888` | opaque | 1 | **0** | app 1 |

**base `rgb(183, 194, 198)`** — L 0.807 · C 0.013 · H 221.5° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#B7C2C6` | opaque | 1 | 1 | app 1 |

**base `rgb(187, 187, 187)`** — L 0.792 · C 0.000 · H — (achromatic) — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#bbb` | opaque | 1 | 1 | settings 1 |

## B3 · Neutral — mid grey

**base `rgb(102, 102, 102)`** — L 0.510 · C 0.000 · H — (achromatic) — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#666` | opaque | 1 | 1 | app 1 |

**base `rgb(115, 115, 115)`** — L 0.556 · C 0.000 · H — (achromatic) — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#737373` | opaque | 1 | 1 | app 1 |

**base `rgb(85, 85, 85)`** — L 0.450 · C 0.000 · H — (achromatic) — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#555` | opaque | 1 | **0** | app 1 |

**base `rgb(90, 90, 90)`** — L 0.468 · C 0.000 · H — (achromatic) — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#5a5a5a` | opaque | 1 | 1 | settings 1 |

**base `rgb(68, 68, 68)`** — L 0.387 · C 0.000 · H — (achromatic) — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#444` | opaque | 1 | 1 | settings 1 |

**base `rgb(128, 128, 128)`** — L 0.600 · C 0.000 · H — (achromatic) — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#808080` | opaque | 1 | 1 | settings 1 |

## B4 · Neutral — dark grey

**base `rgb(17, 17, 17)`** — L 0.178 · C 0.000 · H — (achromatic) — 1 literal, 2 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#111` | opaque | 2 | **0** | app 1, settings 1 |

## B5 · Neutral — near-black

**base `rgb(0, 0, 0)`** — L 0.000 · C 0.000 · H — (achromatic) — 8 literals, 10 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `rgba(0,0,0,0.3)` | 0.3 | 2 | 2 | app 2 |
| `rgba(0,0,0,0.35)` | 0.35 | 2 | 2 | app 1, nav 1 |
| `rgba(0,0,0,.25)` | 0.25 | 1 | 1 | admin 1 |
| `rgba(0,0,0,.6)` | 0.6 | 1 | 1 | admin 1 |
| `rgba(0,0,0,0.12)` | 0.12 | 1 | 1 | app 1 |
| `rgba(0,0,0,0.22)` | 0.22 | 1 | 1 | settings 1 |
| `rgba(0,0,0,0.28)` | 0.28 | 1 | 1 | app 1 |
| `rgba(0,0,0,0.32)` | 0.32 | 1 | 1 | settings 1 |

## B6 · Red

**base `rgb(231, 179, 179)`** — L 0.814 · C 0.061 · H 18.5° — 1 literal, 4 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#e7b3b3` | opaque | 4 | 4 | settings 2, app 1, onboarding 1 |

**base `rgb(232, 106, 106)`** — L 0.677 · C 0.157 · H 22.2° — 3 literals, 3 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#E86A6A` | opaque | 1 | 1 | admin 1 |
| `rgba(232,106,106,.12)` | 0.12 | 1 | 1 | admin 1 |
| `rgba(232,106,106,.15)` | 0.15 | 1 | 1 | admin 1 |

**base `rgb(232, 144, 138)`** — L 0.743 · C 0.108 · H 24.2° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#E8908A` | opaque | 1 | 1 | app 1 |

## B7 · Warm red / brown

**base `rgb(192, 57, 43)`** — L 0.543 · C 0.174 · H 29.7° — 6 literals, 11 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#c0392b` | opaque | 4 | 3 | app 4 |
| `#C0392B` | opaque | 2 | 2 | app 1, settings 1 |
| `rgba(192,57,43,0.35)` | 0.35 | 2 | 2 | app 2 |
| `rgba(192,57,43,0.05)` | 0.05 | 1 | 1 | app 1 |
| `rgba(192,57,43,0.08)` | 0.08 | 1 | 1 | settings 1 |
| `rgba(192,57,43,0.25)` | 0.25 | 1 | 1 | settings 1 |

**base `rgb(138, 31, 31)`** — L 0.419 · C 0.143 · H 25.9° — 1 literal, 10 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#8a1f1f` | opaque | 10 | 9 | settings 7, app 2, onboarding 1 |

**base `rgb(107, 58, 0)`** — L 0.401 · C 0.093 · H 61.2° — 1 literal, 2 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#6b3a00` | opaque | 2 | 2 | settings 2 |

**base `rgb(165, 56, 42)`** — L 0.496 · C 0.146 · H 30.3° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#a5382a` | opaque | 1 | 1 | app 1 |

**base `rgb(228, 87, 46)`** — L 0.637 · C 0.184 · H 36.5° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#E4572E` | opaque | 1 | 1 | nav 1 |

## B8 · Amber / gold / olive

**base `rgb(221, 185, 90)`** — L 0.799 · C 0.121 · H 88.7° — 1 literal, 3 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#DDB95A` | opaque | 3 | 3 | app 1, settings 1, onboarding 1 |

**base `rgb(122, 85, 0)`** — L 0.477 · C 0.099 · H 79.4° — 2 literals, 2 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#7A5500` | opaque | 1 | 1 | app 1 |
| `rgba(122,85,0,0.2)` | 0.2 | 1 | 1 | app 1 |

**base `rgb(227, 207, 148)`** — L 0.857 · C 0.079 · H 91.5° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#e3cf94` | opaque | 1 | 1 | app 1 |

**base `rgb(107, 82, 15)`** — L 0.453 · C 0.086 · H 86.3° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#6b520f` | opaque | 1 | 1 | app 1 |

**base `rgb(90, 75, 0)`** — L 0.416 · C 0.086 · H 95.8° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#5a4b00` | opaque | 1 | **0** | app 1 |

**base `rgb(255, 244, 204)`** — L 0.966 · C 0.053 · H 94.4° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#fff4cc` | opaque | 1 | **0** | app 1 |

**base `rgb(240, 224, 160)`** — L 0.905 · C 0.084 · H 95.8° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#f0e0a0` | opaque | 1 | **0** | app 1 |

**base `rgb(138, 106, 21)`** — L 0.542 · C 0.104 · H 86.0° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#8A6A15` | opaque | 1 | 1 | app 1 |

**base `rgb(122, 94, 18)`** — L 0.497 · C 0.095 · H 86.5° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#7A5E12` | opaque | 1 | 1 | app 1 |

**base `rgb(255, 240, 179)`** — L 0.953 · C 0.079 · H 95.9° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#FFF0B3` | opaque | 1 | 1 | app 1 |

**base `rgb(138, 109, 59)`** — L 0.552 · C 0.077 · H 79.7° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#8a6d3b` | opaque | 1 | 1 | settings 1 |

**base `rgb(232, 163, 61)`** — L 0.765 · C 0.140 · H 72.9° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#E8A33D` | opaque | 1 | 1 | admin 1 |

**base `rgb(224, 168, 74)`** — L 0.767 · C 0.128 · H 77.6° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `rgba(224,168,74,.15)` | 0.15 | 1 | 1 | admin 1 |

**base `rgb(232, 184, 75)`** — L 0.806 · C 0.136 · H 84.7° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#E8B84B` | opaque | 1 | 1 | nav 1 |

## B9 · Green

**base `rgb(10, 92, 50)`** — L 0.419 · C 0.101 · H 154.0° — 2 literals, 6 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#0A5C32` | opaque | 5 | 4 | app 3, settings 1, onboarding 1 |
| `rgba(10,92,50,0.2)` | 0.2 | 1 | 1 | app 1 |

**base `rgb(198, 240, 216)`** — L 0.919 · C 0.054 · H 160.1° — 1 literal, 4 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#C6F0D8` | opaque | 4 | 3 | app 3, settings 1 |

**base `rgb(46, 204, 113)`** — L 0.746 · C 0.181 · H 152.3° — 1 literal, 3 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#2ECC71` | opaque | 3 | 2 | app 2, settings 1 |

**base `rgb(10, 93, 42)`** — L 0.420 · C 0.110 · H 150.1° — 1 literal, 2 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#0a5d2a` | opaque | 2 | 1 | app 1, settings 1 |

**base `rgb(216, 245, 224)`** — L 0.943 · C 0.041 · H 154.1° — 1 literal, 2 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#d8f5e0` | opaque | 2 | 1 | app 1, settings 1 |

**base `rgb(179, 230, 196)`** — L 0.880 · C 0.070 · H 155.5° — 1 literal, 2 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#b3e6c4` | opaque | 2 | 1 | app 1, settings 1 |

**base `rgb(95, 185, 142)`** — L 0.718 · C 0.108 · H 161.2° — 2 literals, 2 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#5FB98E` | opaque | 1 | 1 | admin 1 |
| `rgba(95,185,142,.15)` | 0.15 | 1 | 1 | admin 1 |

**base `rgb(31, 77, 49)`** — L 0.379 · C 0.070 · H 154.4° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#1f4d31` | opaque | 1 | 1 | settings 1 |

## B10 · Teal

**base `rgb(6, 48, 47)`** — L 0.282 · C 0.044 · H 192.6° — 1 literal, 3 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#06302f` | opaque | 3 | 2 | onboarding 2, app 1 |

**base `rgb(26, 154, 154)`** — L 0.624 · C 0.102 · H 194.9° — 1 literal, 3 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#1a9a9a` | opaque | 3 | 3 | settings 3 |

**base `rgb(10, 92, 92)`** — L 0.431 · C 0.071 · H 194.9° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#0a5c5c` | opaque | 1 | 1 | settings 1 |

**base `rgb(13, 107, 107)`** — L 0.479 · C 0.079 · H 194.8° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#0d6b6b` | opaque | 1 | 1 | onboarding 1 |

## B11 · Blue

**base `rgb(47, 168, 220)`** — L 0.690 · C 0.127 · H 232.0° — 1 literal, 7 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#2FA8DC` | opaque | 7 | 7 | app 3, settings 2, onboarding 2 |

**base `rgb(30, 120, 190)`** — L 0.557 · C 0.135 · H 247.6° — 1 literal, 6 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#1E78BE` | opaque | 6 | 6 | app 2, settings 2, onboarding 2 |

**base `rgb(59, 189, 224)`** — L 0.744 · C 0.120 · H 220.1° — 1 literal, 3 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#3BBDE0` | opaque | 3 | 3 | app 1, settings 1, onboarding 1 |

**base `rgb(18, 80, 106)`** — L 0.406 · C 0.074 · H 231.3° — 1 literal, 1 occurrence

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#12506a` | opaque | 1 | 1 | settings 1 |

## B12 · Indigo / violet

**base `rgb(184, 166, 240)`** — L 0.768 · C 0.106 · H 295.0° — 3 literals, 4 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `rgba(184,166,240,0.45)` | 0.45 | 2 | 2 | settings 2 |
| `#B8A6F0` | opaque | 1 | 1 | nav 1 |
| `rgba(184,166,240,0.35)` | 0.35 | 1 | 1 | settings 1 |

**base `rgb(28, 31, 59)`** — L 0.252 · C 0.053 · H 277.3° — 1 literal, 3 occurrences

| Literal | Alpha | Before | Now | Surfaces |
| --- | --- | --- | --- | --- |
| `#1C1F3B` | opaque | 3 | 3 | settings 1, admin 1, landing 1 |

---

## Notes

- **`%23C9A84C`** is the URL-encoded `#C9A84C` inside the `.matrix-angle-caret`
  SVG data-URI in `app.html`. It is the same colour as the `--gold` token and is
  grouped with it, but a find-and-replace over hex literals will not catch it.
- **Keyword values are not in these tables.** `transparent` (43), `inherit` (24)
  and `currentColor` (1) are colour values in the CSS but carry no hue.
- **Colours declared outside a `<style>` block are not counted here** — the
  hub-card SVG `fill` attributes in `settings.html`, the inline styles on
  `#stale-shell-banner` and `.status-dot-preview` in `app.html`, and the
  `#B8E4F8` cloud fill set in JavaScript. Inventory §25.3 lists them.
- **Occurrence counts are per declaration, not per rendered pixel.** A literal
  used once in a rule that matches 200 elements counts as 1.
