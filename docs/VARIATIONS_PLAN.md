# Selective Regeneration & Conceptual Variations — Build Plan

Status: **planning** (build phase-by-phase on approval; do not build ahead).
Owner doc for the feature described in the feature brief. Read alongside
`CLAUDE.md`, `ROADMAP.md`, and the code touchpoints listed below.

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

## 5. Phasing note (recommendation)

Phase 2 shipped *without* Phase 3 will produce N options that tend to **cluster**
(LLMs converge without forced-distinct angles) — mechanically correct but
underwhelming. Recommendation: keep the phases separate for build safety, but
treat **Phase 2's `count > 1` as a mechanics milestone** and keep the **default
count = 1** in the UI until Phase 3 lands, so users don't meet weak variation
quality before the differentiator exists. Phase 3 is what makes the feature
actually good.
