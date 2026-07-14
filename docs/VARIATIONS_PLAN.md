# Selective Regeneration & Conceptual Variations — Build Plan

Status: **SHIPPED.** Phase 1 (selective regeneration) and Phases 2 + 3 (variation
count + conceptual distance) are live on `main`. **Phases 2 and 3 were built and
shipped together, not sequentially** — see **§ As built** immediately below for how
the shipped code differs from the plan. The phase descriptions further down are
kept as the design record; where they and § As built disagree, **§ As built wins.**

Commit map:
- **Phase 1** — selective regeneration — `dd1ca27` (core), `953ca21`
  (`scopedFields` rename + single dynamic primary button), `a885a59`
  (`generateFieldDraft` import fix), `9e6b85e` (structural import guard test).
- **Phase 2 + 3** — variation count + doorways, **merged into one build** —
  `696bc40`, plus subsequent UI fixes: loading state (`dcbe790`), control-strip
  styling/slider (`78556f2`), regen-modal copy (`150dad5`), control placement
  (`1798c2a`).

Owner doc for the feature. Read alongside `CLAUDE.md`, `ROADMAP.md`, and the code.

---

## 0. Feature summary

Regenerate today rebuilds the **entire** doc. This feature makes regeneration
**surgical** and **creative**:

1. **Selective regeneration** — the writer selects specific fields; only those
   regenerate, everything else is untouched.
2. **Variation count** — the writer requests N variations of a field; they
   **stack in the Google Doc** under that field as lightly-marked options.
3. **Conceptual distance** — variations are genuinely different **angles**
   ("doorways") on the same value prop, not N rewordings, each **labeled** with
   its angle.

**Philosophy.** The doc is where the writer resolves options (delete, blend,
tweak). The app generates scoped options **into the doc** — no picker UI.
Quillio supplies diverse thinking; the writer owns the final shape. The
multi-variant state is **transient**: the writer deletes down to a keeper.

---

## § As built — reconciliation with the shipped code

Authoritative record of what actually shipped. Where this disagrees with the
phase plans below, this section wins.

### Phases 2 and 3 were merged into one build (`696bc40`)

The plan (§5) recommended shipping Phase 2 first, then Phase 3. We did **not** —
they shipped together. **Rationale:** Phase 2 alone would have shipped *dark code*
— a count control that defaults to 1 with no diversity mechanism behind it. The
first time a writer set count > 1 they'd get near-clones (LLMs cluster without
forced-distinct angles), meeting weak variation quality before the differentiator
existed. Merging means the first `count > 1` a writer ever sees is already
genuinely diverse.

### Doorway assignment is deterministic — the LLM does not choose

`assignDoorways(fieldName, distance, count)` in `src/services/gemini.js` picks the
N doorways **in JS**, from the distance band of a per-field-type ranking (a pure,
deterministic function — no randomness). `buildVariationsPrompt` then **names the
exact doorway for each numbered row** ("1. (Pain) — … 2. (Proof) — …"). The model
is never asked to "give me N different versions" — that is precisely what makes
LLMs cluster. Structural assignment is what guarantees diversity. New generator:
`generateFieldVariations(...) → [{ doorway, copy }]`, each ceiling-enforced; the
returned `doorway` is the **assigned** one (authoritative for the doc label), not
whatever the model echoes back. On a missing/oversized row it falls back to the
single-field generator with the doorway injected as direction.

The seven doorways: **Pain · Outcome · Contrast · Question · Proof · Identity ·
Reframe.** Distance bands over the field's ranking: **Stay close** → `rank[0]`;
**Explore** → `rank[1..3]`; **Roam wide** → `rank[4..6]` (always ends in Reframe).

### Distance is measured against the VALUE PROP FROM THE BRIEF

Not against voice.md, and not against the previous draft. **voice.md governs
tone/craft only — it never varies**; doorways change the *angle* only. On
regeneration, **Roam wide** additionally means "go somewhere the current copy did
not" — the current copy is passed in and the prompt is told to avoid its angle.

### Stay close at count > 1 → one doorway, N distinct executions

All N variations use the **same** obvious doorway (`rank[0]`) with N genuinely
different *executions* of that one angle — **not** spread across neighboring
doorways. This preserves the Close / Explore / Wide ladder (spreading close across
neighbors would blur it into Explore).

### Doc marker rules — the solo-doorway rule

Two independent markers, decided at doc-write time by `buildVariantBlock` in
`src/destinations/googleDocs.js`: a **number** appears iff `count > 1`; a
**(Doorway) label** appears iff `distance != "close"`.

| distance | count | doc output | shape |
| --- | --- | --- | --- |
| close | 1 | `Your storefront is a sales floor…` | bare — identical to a Phase-1 draft |
| explore / wide | 1 | `(Reframe) Your storefront is a sales floor…` | **labeled, no number** (already resolved) |
| close | >1 | `1. …` `2. …` | numbered, **no labels** (one obvious door, N executions) |
| explore / wide | >1 | `1. (Pain) …` `2. (Proof) …` | numbered **and** labeled |

So a **solo** variation at Explore/Roam-wide carries its doorway tag *without* a
number (there's nothing to resolve between); at Stay close + count 1 there's **no
label at all** — it's just the obvious angle, no meaningful door to name. Numbered
`1. (Pain) …` labels appear only at `count > 1`. Markers are inserted
`bold:false, italic:false`, so `parseDoc` reads them as ordinary copy.

### Review skip — numbered stacks only

The copy review skips a field only when it holds an **unresolved numbered stack**
(`count > 1`). A **solo labeled variation is already resolved and stays
reviewable** — its leading `(Doorway)` tag is stripped before the length/voice
check so the review sees just the sentence. Detection lives in
**`src/utils/variants.js`**: `isNumberedStack` (≥2 numbered lines), `soloDoorway`,
`stripSoloLabel`. `copyReview.collectCopyFields` skips numbered stacks and strips
solo labels; the digest notes how many fields are unresolved. Once the writer
deletes down to one line, the field is reviewable again.

### Payload — `scopedFields`, not `fields`/`targets`

The shipped param is `scopedFields: [{ assetType, fieldName, count?, distance? }]`
(the plan drafted it as `fields`/`targets`; renamed to avoid colliding with the
local `assetTargets` in `generateDraft`). `count` clamps to 1–4, `distance`
whitelists `close|explore|wide`; absent/at-default = exactly Phase 1. Threaded
route → adapter → pipeline → destination, each hop keeping it optional.

### Per-field controls (per field, not per-regen)

Count (a **1–4 slider**) and distance (**three pills**) are set **per field**, in
the shared field renderer, revealed when a field is selected. A writer may want
the **headline to Roam wide while the CTA Stays close** in the same regen. The
regen modal's copy shifts to craft-notes guidance ("angle is already set by your
distance") when any selected field asks for variations, so typed direction doesn't
compete with the assigned doorways (`150dad5`).

### Loading state — progress bar removed, phrases restored (`dcbe790`)

The generation **progress bar was removed** (`startDraftBar`, `estimateDraftSec`,
the per-asset "Drafting [asset]…" label) and replaced with the restored **44-line
`GEN_PHRASES`** set, **shuffled on each run**. **Rationale:** the bar mislabeled
assets on a scoped op (it walked the whole-doc asset list regardless of what was
scoped) and never completed before the copy arrived — it made a completion promise
Gemini latency can't keep, especially on a scoped single-field regen. The phrases
make no promise; they just signal "working." **The brief screen's bar is
untouched** — it has genuine sequential stages (parse → specs → Drive), so a bar
is honest there.

### Still unbuilt

**Phase 3+ variant-aware review** (§ below) remains a future item — not built.

---

## 1. How the current system works (so we build on it, not around it)

Touchpoints, verified in code:

- **Web draft/regen entry:** `public/app.html` → `runReviewIntoModal` sibling
  paths. Whole-doc regen is `regenerateProjectDraft` (project view) and
  `submitRegen` (Copy Done), both via `draftFetch(docId, direction)` →
  `runJob('/api/draft', { docId, direction })`.
- **Route:** `src/routes/app.js` `POST /api/draft` → `startJob` →
  `runWebDraft(docId, tenantContext, direction)`.
- **Adapter:** `src/adapters/web.js` `runWebDraft` → `pipeline.generateDraft`.
- **Pipeline:** `src/core/pipeline.js` `generateDraft(docId, direction, clients,
  tenantId)` — resolves voice guide + asset-direction lookup, delegates to the
  destination.
- **Destination (the doc mechanics):** `src/destinations/googleDocs.js`
  `generateDraft(id, direction, clients, voiceGuide, lookupDirection)`:
  1. `parseDoc(doc)` recovers, per field: `fieldName`, `charMin/charMax`,
     `insertIndex` (blank line after the label/notes), and `deleteEnd` (end of
     the field's already-drafted copy; **advances across every non-empty copy
     paragraph** under the label → multi-line copy is fully captured).
  2. Generates copy per asset via `gemini.generateAssetDrafts` (one cohesive
     batched call per asset; per-field fallback to `generateFieldDraft`).
  3. **Two-phase write:** Phase 1 deletes existing copy ranges bottom-to-top,
     re-parses for fresh indices; Phase 2 inserts new copy under each label and
     sets it non-bold. First drafts skip Phase 1 (`deleteEnd == null`).
- **Read-back:** `getDocContent(id)` returns `{ title, summary, writerDirection,
  assets:[{ name, fields:[{ fieldName, charMax, copy, … }] }] }`. Copy = the
  plain paragraphs after a bold label, up to the next label. Used by the copy
  **review** (`copyReview.js`) and the app's field display.
- **Field identity everywhere:** `(assetType, fieldName)`, lowercased —
  `ctxKey` in googleDocs, `fieldKey` in copyReview.

**Key insight:** the doc write is *already* per-field surgical (each field owns
its `insertIndex`/`deleteEnd`; deletes/inserts are scoped to those ranges).
Selective regen is therefore mostly **filtering the target set** — untouched
fields never enter the delete/insert lists, so they stay byte-identical.

---

## 2. Conflicts / risks to decide BEFORE building

Flagged now, per the build rules:

1. **Cohesion trade-off (Phase 1).** `generateAssetDrafts` batches a whole
   asset in one call for cross-field cohesion. A scoped regen of 2 fields in a
   10-field asset can't use that batch as-is. **Decision (signed off):** scoped
   regen drafts selected fields with the per-field generator
   (`generateFieldDraft`, which already exists and takes `direction`, `charMax`,
   `assetDirection`, `summary`, `writerPrompt`, `voiceGuide` and enforces the
   limit). We accept slightly reduced cross-field cohesion for the regenerated
   fields in exchange for true scoping — the writer is already deliberately
   breaking batch cohesion and is the cohesion check as they work the doc.
   (Whole-doc regen keeps the cohesive batch path unchanged.)
   - **Sibling context (fold into Phase 1 — cheap).** To recover most of the
     cohesion without batch generation, pass the **current copy of the field's
     sibling fields** (the other fields of the same asset) into the scoped
     prompt as read-only context: *"This field sits alongside — Headline: '…';
     CTA: '…'. Fit with them; do not rewrite them."* `parseDoc`/the doc read
     already expose every sibling field's current copy at scope time, and
     `generateFieldDraft` builds a plain prompt array, so this is a few lines and
     no new API surface. Siblings are **context only** — never regenerated,
     never written.

2. **`getDocContent` on a multi-variant field (Phase 2).** After stacking N
   options, a field's "copy" is a multi-line block. **Contract we adopt:**
   `getDocContent` treats the whole block as that field's `copy` (no schema
   change). Consequences while variants exist (transient state):
   - The **review** sees the block as one copy → may comment oddly / on the
     markers. Acceptable; the writer resolves down before relying on review.
   - **Char counts** in the app show the combined length. Acceptable; degrade
     gracefully (we may show "N options" instead of a number — see Phase 2).
   - On the next scoped regen of that field, `deleteEnd` already spans all the
     variant lines (verified), so they're cleanly replaced. ✅

3. **Marker lines must not be mistaken for labels/notes.** `parseDoc` keys
   labels on **bold**; option markers (`1. …`, `2. (Pain) …`) are inserted
   **non-bold, non-italic**, so they parse as ordinary copy, not new fields or
   notes. Verify in Phase 2 tests.

4. **Duplicate field names within one asset.** Selection/scoping keys on
   `(assetType, fieldName)`. Today field names within an asset are unique (e.g.
   "Subject Line 1", "Subject Line 2"). If a future library had duplicates,
   scoping would be ambiguous. **Assumption:** field names are unique within an
   asset; add a guard/log if a collision is ever seen.

5. **Slack path unaffected.** Selective/variation regen is a **web-UI** feature
   (`/api/draft` gains optional params). Slack `/quillio` regen stays whole-doc.
   The new params are optional and default to today's behavior.

6. **Empty-range styling bug (historical).** Never insert an empty variant.
   Markers guarantee each inserted line is non-empty; keep the existing
   defensive skips.

---

## 3. Data-flow changes (threaded through all phases)

Add an **optional** scoping/variation payload to the draft job, defaulting to
today's whole-doc behavior when absent:

```
POST /api/draft {
  docId, direction,
  // NEW (all optional):
  fields: [ { assetType, fieldName, count?, distance? } ]   // scoped targets
}
```

- Absent / empty `fields` → **whole-doc regen exactly as today** (no
  regression).
- `count` (Phase 2, default 1), `distance` (Phase 3: `'close' | 'explore' |
  'wide'`, default `'close'`).

Thread `fields` through: `runWebDraft(docId, tenantContext, direction, targets)`
→ `pipeline.generateDraft(docId, direction, clients, tenantId, targets)` →
`getDestination().generateDraft(id, direction, clients, voiceGuide,
lookupDirection, targets)`. Every hop keeps the param **optional**.

---

## Phase 1 — Selective regeneration (surgical core)

**Goal:** select fields → regenerate only those → everything else untouched.
Self-contained and valuable alone.

### Backend
- `googleDocs.generateDraft` accepts optional `targets` (list of
  `{assetType, fieldName}`). When present:
  - Build `assetTargets` filtered to the selected `(assetType, fieldName)` set.
  - Draft selected fields with `generateFieldDraft` (per field, with
    `direction`), not the whole-asset batch.
  - Phase 1/Phase 2 delete+insert run **only** over selected fields. Unselected
    fields never enter `deletions`/`inserts` → their ranges are byte-identical.
- `pipeline.generateDraft` + `runWebDraft` + `/api/draft` thread `targets`
  through (optional).

### Frontend (shared code path — project view AND Copy Done)
- Make the field rows in the shared field renderer **multi-selectable**: tap to
  toggle a `selected` state; clear visual selected state in the design system
  (glass card selected border + gold accent + a check). Selection lives in
  transient client state keyed by `(assetType, fieldName)`.
- When ≥1 field is selected, the Regenerate button label becomes
  **"Regenerate Selected (N)"**; tapping opens the **existing** regenerate modal
  (direction input) — same modal, now scoped. On submit, send `fields`.
- With **0** selected, Regenerate is unchanged (whole-doc, no `fields`).
- After completion, refresh field display + counts **in place** (same in-place
  refresh pattern as the Review-button fix — re-fetch `/content` with the
  cache-bust nonce; no navigate-away).

### Tests
- `generateDraft` with `targets` produces delete/insert requests **only** for
  targeted fields (unit: assert the request set touches only those ranges).
- Empty/absent `targets` → identical request set to today (regression guard).
- Route/adapter/pipeline pass `fields` through; selection→label wiring asserted
  in `app.html`.

### Verify (manual)
Generate a doc → select 2 of ~20 fields → Regenerate with direction → only those
2 changed in the doc and app; header, other assets, untouched fields
byte-identical.

---

## Phase 2 — Variation count (options stacked in the doc)

**Goal:** request N variations of a selected field; they stack under the field,
lightly marked.

### Frontend
- Each **selected** field gets a small count control (1–4, default 1), design-
  system styled, mobile-friendly. `count = 1` behaves exactly like Phase 1.
- Send per-field `count` in the `fields` payload.

### Backend
- For a field with `count > 1`, generate **N distinct** copies of that field.
  (Phase 2 uses the existing generator with distinctness pressure; **true**
  diversity is Phase 3.)
- **Doc write:** stack the N variants under the field's label as one insert
  block, each on its own marked line/section:
  - Short fields (subject/headline/CTA): `1. …` / `2. …` / `3. …` — N short
    lines.
  - Long fields (body/social): `1.` header then the version, blank line, `2.` …
    — N full versions clearly separated.
  - All inserted **non-bold/non-italic** so `parseDoc` treats them as copy.
- Re-regen of a multi-variant field replaces all variant lines cleanly
  (existing `deleteEnd` span — verify with a test).

### Downstream compatibility (the important part)
- `getDocContent`: multi-variant field's `copy` = the whole marked block (no
  schema change). Document this contract in code. Detect the multi-variant state
  by the option markers (`^\d+\.\s` lines, ≥2) so downstream can branch on it.
- App field view: show the block; where a single char count is meaningless,
  show "N options" instead of a number (degrade gracefully). Field state
  reflects **whatever is in the doc** after the writer resolves.
- **Review SKIPS multi-variant fields (decided).** Reviewing an unresolved
  stack of options against char limits + voice produces confusing noise, so
  `copyReview.collectCopyFields` **excludes** fields detected as multi-variant.
  Optionally the digest/status notes it (e.g. *"3 fields have unresolved
  variations — resolve to one to review them"*). Those fields are reviewed
  normally once the writer deletes down to a single copy. (This skip is the
  interim behavior; the Phase 3+ "variant-aware review" below eventually
  replaces it — but only after Phase 3's labeled doorways exist to evaluate.)
- Char-counts degrade gracefully while variants exist; correctness returns once
  the writer deletes down to one.

### Tests
- N-variant insert produces N marked, non-empty, non-bold lines under the label.
- `parseDoc`/`getDocContent` round-trip: a stacked field parses as one copy
  block; a subsequent scoped regen's `deleteEnd` covers all variant lines.
- `collectCopyFields` **excludes** a detected multi-variant field and **includes**
  it again once resolved to a single line.
- `count = 1` path identical to Phase 1.

### Verify (manual)
Request 3 variations of a subject line → 3 marked options under that field →
delete down to one in the doc → app + review reflect the single resolved copy.

---

## Phase 3 — Conceptual distance (the differentiator)

**Goal:** variations that are different **angles**, not rewordings — via a
3-level distance control, each variation **labeled** by its doorway.

### Doorways (angles), defined in the prompt design
Pain (lead with the ache) · Outcome (the after-state) · Contrast (old vs. new) ·
Question (provocative question) · Proof (specific/number) · Identity (speak to
who they are) · Reframe (challenge the category assumption).

### Distance control (three discrete levels — not a slider)
- **Stay close** — refine within the current framing/angle.
- **Explore** — adjacent angles, moderate reframing.
- **Roam wide** — distinctly different doorways, including reframes.

Added to the selection UI; sent as per-field `distance` (default `'close'`).

### Mechanical diversity (critical)
When `count > 1` at **Explore/Roam-wide**, the generation prompt **assigns each
variation a different doorway explicitly** — never "give me N different
versions" (LLMs cluster; forced-distinct angles is what guarantees diversity).
At **Stay close**, all N refine the *current* angle. New gemini function, e.g.
`generateFieldVariations({ field, charMax, count, distance, doorways, summary,
writerPrompt, briefContext, voiceGuide, direction })`, returning
`[{ doorway, copy }]`, each respecting `charMax` and the brand voice.

### Doc labeling
Each variant is labeled with its doorway: `1. (Pain) …`, `2. (Reframe) …` — so
the writer sees different **thinking**, not just different copy. The doorway is
part of the option marker and is deleted when the writer resolves to a keeper.

### Constraints
- Voice/tone register stays governed by **voice.md** — doorways change the
  **angle**, not the brand voice. (Tone chips are a possible *future* axis, not
  this phase.)
- Whole-doc Regenerate and `count = 1` selective regen are **unaffected** —
  conceptual distance only applies to `count > 1`, default `'close'`.

### Tests
- At Explore/Roam-wide, N variants carry **N distinct doorway labels** (assert
  distinctness); at Stay-close, no cross-angle spread (labels absent or all the
  current angle).
- Prompt-construction unit test: the doorway assignment is explicit per variant.

### Verify (manual)
4 variations of a headline at **Roam wide** → 4 options labeled with **different**
doorways, genuinely different approaches → same request at **Stay close** →
refinements of the current angle.

---

## Phase 3+ — Variant-aware review (FUTURE — capture only, do NOT build)

Recorded now so it isn't lost; **not part of the current build**. Depends on
Phase 3's doorway-labeled variations existing.

**Goal:** once a multi-variant field carries labeled doorways, a future review
enhancement **evaluates the unresolved variants** and offers a second opinion at
the choosing moment — e.g. *"Option 2 (Outcome) fits the voice guide best;
Option 3's Question angle leans hypey."* The writer still makes the call.

- Runs **only** on multi-variant fields (the ones Phase 2's review currently
  skips), reading each variant's doorway label + copy.
- Judges each variant against voice.md + the brief audience (same references as
  the main review), and recommends a strongest option **with reasons** — advice,
  not an auto-pick.
- **This replaces the Phase 2 "skip multi-variant fields" behavior** — but only
  *after* Phase 3 ships, because it needs the labeled doorways to evaluate
  against. Until then, skipping is correct.
- Single-copy (resolved) fields continue through the normal review/reconcile
  path unchanged.

---

## 4. Build order & rules

- Build **Phase 1 only** on go-ahead; one phase per approval; no building ahead.
- Each phase leaves the app **fully working**: P1 valuable alone (surgical
  regen), P2 alone (options in doc), P3 is the creative layer on top.
- Reuse existing patterns: the **shared project/Copy-Done code path**, the
  **regenerate modal**, the **design system** (glass / StarCrush / gold), and
  **in-place state refresh** after operations (cache-bust nonce).
- **Tests per phase; the full suite stays green.**
- New API params are **optional and backward-compatible** — absent = today's
  whole-doc behavior. Slack path unchanged.

## 5. Phasing note — DECISION: merged (superseded)

This section originally recommended shipping Phase 2 separately from Phase 3. That
recommendation was **not** taken. Because Phase 2 without Phase 3 produces N
options that **cluster** (LLMs converge without forced-distinct angles) — a count
control with no diversity behind it is dark code — **Phases 2 and 3 were built and
shipped together** in `696bc40`. The first `count > 1` a writer ever sees is
already genuinely diverse. See **§ As built** for the shipped behavior.
