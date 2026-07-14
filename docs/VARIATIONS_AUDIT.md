# Variations & Selective-Regeneration Plan — Code Audit

Audit of `docs/VARIATIONS_PLAN.md` against the codebase, done **before** any
Phase 1 build. Goal: confirm every "verified in code" claim the plan leans on is
still true, and confirm nothing has been built ahead of the plan's `planning`
status. Verdict: **the plan is accurate.** Findings and a few small notes below.

## Touchpoints verified (all confirmed accurate)

| Plan claim | Code | Status |
| --- | --- | --- |
| Web regen entry points `regenerateProjectDraft`, `submitRegen`, `draftFetch(docId, direction)` → `runJob('/api/draft', …)` | `public/app.html:1287,1472,1918` + `runJob` at `:1246` | ✅ |
| Route `POST /api/draft` → `startJob` → `runWebDraft(docId, tenantContext, direction)` | `src/routes/app.js:221,232,234` | ✅ |
| Adapter `runWebDraft` → `pipeline.generateDraft(docId, direction, clients, tenantId)` | `src/adapters/web.js:144,147` | ✅ |
| Pipeline `generateDraft(docId, direction, clients, tenantId)` → destination `generateDraft(id, direction, clients, voiceGuide, lookupDirection)` | `src/core/pipeline.js:839,852` | ✅ |
| `parseDoc` recovers per field `fieldName`, `charMin/charMax`, `insertIndex` (blank line after label/notes), `deleteEnd` advancing across **every** non-empty copy paragraph | `src/destinations/googleDocs.js:463–510` (insertIndex `:481/:500`, deleteEnd advance `:507–509`) | ✅ |
| Two-phase write: delete existing ranges bottom-to-top, re-parse, then insert; first drafts skip Phase 1 (`deleteEnd == null`) | `googleDocs.js:597–668` (deletions `:609–611`, re-parse `:626`, inserts `:638–661`) | ✅ |
| Draft copy via `generateAssetDrafts` (batched per asset) with per-field fallback to `generateFieldDraft` | `googleDocs.js:555`; fallback `gemini.js:693` inside `generateAssetDrafts` | ✅ |
| `getDocContent` copy = plain paragraphs after a bold label, up to next label | `googleDocs.js:685`, accumulation at `:789` (`copy = copy ? copy+'\n'+text : text`) | ✅ |
| Field identity `(assetType, fieldName)` lowercased — `ctxKey` / `fieldKey` | `googleDocs.js:517`, `copyReview.js:36` | ✅ |

## Plan-specific risk claims verified

1. **Markers won't be mistaken for labels/notes (risk #3).** Inserted copy is
   explicitly styled `{ bold:false, italic:false }` right after insertion
   (`googleDocs.js:654–660`). `parseDoc` keys field labels on **bold**
   (`:463`) and per-field notes on the **italic** line before any copy
   (`:497`). Non-bold, non-italic marker lines (`1. …`, `2. (Pain) …`) fall
   through to the "ordinary copy" branch (`:507`). **Confirmed.**

2. **Multi-variant `deleteEnd` spans all variant lines (§2 / risk #2).**
   `parseDoc` advances `deleteEnd` to the end of *every* non-empty paragraph
   under a label (`:507–509`), so a re-regen of a stacked field deletes all
   variant lines cleanly via the single `deleteContentRange`
   (`:618–619`). **Confirmed.**

3. **`getDocContent` folds a stacked field into one `copy` block (§2 contract).**
   The accumulator joins every non-empty paragraph with `\n` (`:789`) — no
   schema change needed to hold a multi-variant block. **Confirmed.**

4. **`generateFieldDraft` already accepts the params scoped regen needs (§1
   decision).** Its destructured args are a **superset** of the plan's list:
   `assetType, channel, fieldName, charMax, toneNotes, notes, funnelStage,
   assetDirection, summary, writerPrompt, direction, voiceGuide`
   (`gemini.js:515–528`), and it builds a plain prompt array — so the
   sibling-context addition is a few lines with no new API surface. **Confirmed.**

## Nothing built ahead of plan (planning status accurate)

- No `fields`/scoped-`targets` param anywhere in the draft chain: `/api/draft`,
  `runWebDraft`, `pipeline.generateDraft`, and `googleDocs.generateDraft` all
  still take only `(docId/id, direction, …)`. The only `targets` token in the
  draft code is the unrelated local `assetTargets` (`googleDocs.js:529`).
- No `count` / `distance` / `doorway` / `generateFieldVariations`. Grep hits for
  those words are all incidental (audience "targets", char "count", CSS
  `font-variant-numeric`).
- No field-selection state in `public/app.html`; `collectCopyFields`
  (`copyReview.js:41`) still includes **every** field with non-empty copy — it
  has no multi-variant detection/skip yet, exactly as expected pre-Phase-2.

## Small notes for the Phase 1 build (not blockers)

1. **Naming collision to avoid.** The plan names the new scoping param `targets`,
   but `googleDocs.generateDraft` already has a local `assetTargets`
   (`:529`). Pick a distinct name (e.g. `scopedFields` / `targetFields`) to keep
   the two unambiguous.

2. **Per-field args when calling `generateFieldDraft` directly.** Today only
   `generateAssetDrafts` reaches `generateFieldDraft` (as its fallback), and it's
   fed asset-level `channel`/`toneNotes`. When Phase 1 calls `generateFieldDraft`
   directly from `generateDraft`, note that `parseDoc` recovers per-field `notes`
   and `charMin/charMax` but captures `channel`/`toneNotes` only at the **asset**
   level and does **not** recover `funnelStage`. `generateFieldDraft` treats all
   of these as optional, so supplying what the doc exposes (asset channel/tone +
   field notes/charMax) is sufficient — just don't expect a per-field
   `funnelStage` from the doc.

3. **Regression guard is well-founded.** Because untouched fields never enter
   `deletions`/`inserts` (both derived from the `drafted` set), filtering the
   target set is genuinely enough to leave other ranges byte-identical — the
   plan's "key insight" holds against the code.

**Bottom line:** the plan builds on the code as it actually is. Phase 1 can
proceed as written, with the naming and per-field-args notes above folded in.
