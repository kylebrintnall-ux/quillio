# Variations Matrix — Design Plan

Status: **DESIGN — not built.** This is the next evolution of the variations
system (Phases 1–3, shipped). It replaces the per-field Amount slider + Variety
pills with a single, deeper control: the **variations matrix**.

This doc is the spec to build against. It captures the design and, critically,
pins down the four open threads that must be decided before any code is written.

---

## Why this exists

The shipped control (Amount 1–4 + Variety: Stay close / Explore / Roam wide) is
good for one intent — "give me a few more angles, don't make me think." But it
can't serve a writer who knows exactly what they want: "give me 2 Pain, 1 Proof,
and 3 Reframe." The distance bands assign doorways deterministically and hide the
taxonomy; the writer never chooses angles directly.

There are really **three escalating writer intents**:

1. **"Just give me a few options."** Doesn't care about angles. Wants a number.
2. **"Give me a few *different* options."** Cares they're varied, doesn't want to
   name how. Wants a number + a sense of spread.
3. **"Give me 2 Pain and a Reframe."** Knows the angles. Wants direct control.

The shipped control serves 1 and 2. The matrix serves 3 — and, with a smart
default, can serve all three without dropping intent-1 writers into a wall of
steppers.

**Key insight — the escalation cliff.** The failure mode to avoid: making one
always-visible control that forces intent-3 complexity onto an intent-1 writer.
The fix is a **ramp, not a trapdoor** — depth reveals itself only when the writer
reaches for it. See "Entry point" below.

---

## The design

### Entry point (resolves the escalation cliff)

The matrix is NOT shown by default on every field. A selected field shows a
button — **"Riff with variations"** — and only tapping it opens the matrix. The
calm resting state is just the field + the button. Nobody is dropped into seven
steppers; the depth is one deliberate tap away.

This means the matrix IS the variations control — Amount and Variety do not
coexist with it. Once you open the matrix, it encodes both (which angles =
variety; total count = amount). Keeping the pills alongside would be the same
redundancy that made "Distance" confusing.

### The matrix itself

Seven **angles** (renamed from "doorways" — internal shorthand; the writer picks
angles):

  Pain · Outcome · Proof · Question · Contrast · Identity · Reframe

Each angle is a row with a count stepper (0–N). The writer sets how many of each.
Most rows rest at 0; a writer only touches the angles they want.

- **Range is uncapped** (or a high ceiling — see open thread). Some writers want
  1–2 variations; others want 10–15 across angles. The tool doesn't impose an
  arbitrary limit; the writer decides.
- **Repeats are intentional.** "3 Reframe" is valid — three reframe executions,
  different wording, same door. This is the writer's choice, not a clustering
  failure. (Contrast with the shipped system, where repeats past 7 doorways were
  a *problem* to prevent. Here, the writer owns the decision.)
- The button + a live summary always show the truth: "Generate 6 angles · Pain,
  Contrast×2, Reframe×3."

### Angle-awareness per field type

The matrix applies to **every** copy field type — headline, subhead, body, CTA,
hook — with the generator respecting that asset's best-practices and voice.md,
exactly as generation already does. `assignDoorways()` already keys off field
type; the machinery exists. The matrix is a UI over it.

BUT the *meaning* of an angle changes with copy length — see Open Thread 2.

### Append model (resolves "generate more without losing the keepers")

Each matrix run **appends**. The writer opens the matrix, sets angles + counts,
generates → a set stacks under the field. They open the matrix again, set it
however they like (same, different, doesn't matter), generate → that set appends
**below** the existing ones.

- **No reconciliation.** The matrix does not remember or dedupe against what's
  already stacked. It runs and tacks on. Want fresh angles? Set different ones.
  Want more of the same? Set the same. The tool doesn't decide — the writer's
  matrix input is the whole intent, every run.
- **Numbering continues** — 7, 8, 9… down the growing stack.
- **Resolving down stays manual, in the doc.** The writer deletes what they don't
  want and keeps what they do, whenever they want. Consistent with the core
  philosophy: the doc is where the writer resolves; the app feeds options in.

This is a real architectural change — see Open Thread 1.

---

## OPEN THREADS — decide before building

### Thread 1 — Regenerate (replace) vs Riff (append): TWO distinct actions

**The architectural break.** Current regeneration is **destructive-replace**:
`generateDraft` runs the two-phase write — `parseDoc` finds the field's copy
range, Phase 1 deletes it bottom-to-top, Phase 2 re-inserts. Re-regen deletes the
whole stack and writes new. This assumes every generation *supersedes* the last.

The append model needs an **additive** write: leave everything in place, insert a
new set below the existing copy, continue numbering. That's a genuinely different
operation from the delete→insert path.

So a field with a stack now has TWO generative actions:
- **Regenerate** — replace what's there (existing destructive behavior)
- **Riff with variations** — append a new matrix run below what's there

**Decision needed:**
- These CANNOT be the same button — one destroys, one adds. They must be visually
  distinct so a writer never nukes a stack they were building, or appends when
  they meant to replace.
- Where does each live in the field card? What do they look like?
- Does "Regenerate" still open the direction modal? Does "Riff" open the matrix?
  (Leaning: Regenerate → direction modal as today; Riff → matrix.)
- Implementation: the append write needs a new path in `googleDocs.generateDraft`
  (or a sibling function) that inserts-after rather than delete-then-insert. The
  insert index is the end of the field's current copy block; no delete phase.

### Thread 2 — Short-copy vs long-copy angle semantics

Doorways were designed for short, single-idea copy. A **headline IS one angle** —
"Stop writing tickets, start launching promotions" is entirely Contrast.

But a **body paragraph is several angles in sequence.** The shipped Post Copy
opens Pain (engineering ticket = lost revenue) → Outcome (control back) → Reframe
(focus on customers). One paragraph, three doors, in order. "Give me a Pain
version of this paragraph" is strange — a good paragraph already *uses* Pain as a
beat.

So for long copy, an angle means **which angle it LEADS WITH / opens on**, not
which angle it *is*. A "Pain-led" body paragraph opens on the problem; the rest
can travel through other territory. That's a real, useful variation — the opening
move changes how a paragraph lands — but it's a *different mechanic* than the
headline case, and the current prompt doesn't distinguish them.

**Decision needed:**
- The prompt must branch on field length: short field → angle IS the copy;
  long field → angle LEADS the copy. The signal is the field's char ceiling
  (`charMax`), already recovered by `parseDoc`.
- Where's the threshold? (Headline/hook/CTA = "is"; body = "leads"; subhead
  likely "is" but sits on the line.) Probably keyed off charMax, not field name,
  so it generalizes.
- `buildVariationsPrompt` needs the branch and the two prompt framings.

### Thread 3 — Char count on a tall stack

A headline field is `[70]`. Twelve stacked options isn't 70 characters — it's
twelve lines each aiming for 70. `getDocContent` already folds a stack into one
`\n`-joined block, so the count currently reads the combined length, which is
meaningless on a deep stack ("684 / 70").

**Decision needed:**
- What does the count show on a multi-option field? Options: (a) hide the count
  while a stack is unresolved; (b) show per-option counts; (c) show "12 options"
  instead of a char count (mirrors the existing "N options" chip). Leaning (c) —
  the chip already exists for exactly this.
- Not a blocker; a display-clarity decision.

### Thread 4 — Review on a growing stack

The shipped variant-aware review engages unresolved numbered stacks (one comment
per option where material). But an **append-heavy stack that keeps growing** —
does the review engage it, skip it, or wait until the writer signals "done adding"?

- Reviewing a 15-option stack means up to 15 comments — even with the materiality
  bar, that's a lot, and the writer may still be adding.
- Is there a "done riffing" signal that flips a stack from in-progress to
  reviewable? Or does the review just engage whatever's there when asked, and the
  writer chooses when to run it?

**Decision needed:**
- Leaning: the review engages whatever's stacked when the writer runs it — no
  special "done" state. The writer controls timing by choosing when to review.
  But confirm the materiality bar holds on a large stack (does it stay quiet on
  clean options, or does volume tempt it to comment on more?).

---

## What's reusable from the shipped system

- `assignDoorways()` — angle assignment logic, keys off field type. The matrix
  lets the writer override it directly, but the fit-guide/ranking stays relevant
  for the short-vs-long framing.
- `src/utils/variants.js` — `isNumberedStack`, `parseNumberedStack`,
  `soloDoorway`, `stripSoloLabel`. Stack parsing already exists.
- `DOORWAY_FIT_GUIDE` / `DOORWAY_RANKINGS` — which angles suit which contexts.
- The variant-aware review (`reviewVariationStack`, `buildVariantReviewPrompt`) —
  applies to matrix-generated stacks unchanged, modulo Thread 4.
- `getDocContent` folding a stack into one block — already handles multi-option
  fields (Thread 3 is about *display*, not parsing).

## What's genuinely new

- Append write path (Thread 1) — insert-after, no delete phase. The biggest new
  piece.
- Dual field actions — Regenerate (replace) + Riff (append), visually distinct.
- The matrix UI — seven angle rows with steppers, behind the "Riff with
  variations" entry button.
- Length-aware angle framing in the generation prompt (Thread 2).

---

## Build sequencing (proposed)

Do NOT build all at once. Suggested order, one approval per step:

1. **The append write path** — the architectural core. Prove insert-after works
   and stacks cleanly below existing copy, numbering continues, other fields
   byte-identical. No UI yet; test via a scoped call. This is the risky part;
   isolate it.
2. **Regenerate vs Riff as two distinct actions** — wire the append path to a
   "Riff" action separate from destructive Regenerate.
3. **The matrix UI** — entry button → seven-angle stepper matrix → feeds the
   append path.
4. **Length-aware angle framing** (Thread 2) — the prompt branch for short vs
   long copy.
5. **Display + review polish** (Threads 3 & 4) — char-count-on-stack, confirm
   review materiality on large stacks.

Each step is independently testable and independently valuable. Step 1 is the one
to scrutinize hardest — it changes the write architecture.
