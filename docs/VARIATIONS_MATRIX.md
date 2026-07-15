# Variations Matrix — Design Plan

Status: **DESIGN — not built.** This is the next evolution of the variations
system (Phases 1–3, shipped). It replaces the per-field Amount slider + Variety
pills with a single, deeper control: the **variations matrix**.

This doc is the spec to build against. It captures the design and, critically,
pins down the open threads that must be decided before each piece is built.

**Platform note:** Quillio is developed and tested on mobile (iPhone), but the
primary users are mostly on DESKTOP. So the matrix is designed mobile-first
(hardest case, smallest screen) but has real room to spread out on desktop — the
density that feels tight on a phone relaxes on a wide screen (e.g. two columns of
angle rows, or count + intensity sitting inline rather than stacked). Build
mobile-first; let it breathe on desktop.

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

### The matrix itself — add-a-row dropdown model

The seven **angles** (renamed from "doorways" — internal shorthand):

  Pain · Outcome · Proof · Question · Contrast · Identity · Reframe

**The matrix does NOT show seven always-visible rows.** That was an earlier idea,
rejected for density — seven rows each with two controls is too heavy, especially
on mobile (where Quillio is developed; see platform note). Instead, the matrix
**starts empty and grows to fit the intent** — the "ramp not trapdoor" principle
finally landing cleanly.

**How it works:**
- The panel opens with ONE blank row showing "+ Add angle" text inside it, ready
  to fill.
- Tap it → a DROPDOWN lets the writer pick which angle (Pain, Outcome, etc.). That
  becomes a configured row.
- Want another angle? Add another row, pick a different angle. The writer builds up
  exactly the angles they want — nothing more.

**Each configured row has:**
1. An **angle dropdown** (which angle this row is)
2. A **count** (how many of this angle)
3. An **intensity control** — the notched slide-rule with three stops:
   **Safe / Bold / Wild** (NOT pills — the slide-rule, per the design decision
   below). How hard to push this angle.
4. A **remove** control (✕) to delete the row.

Collapsed, a row reads roughly: `[Pain ▾]  [count]  [Safe|Bold|Wild slider]  ✕`

**Same angle allowed twice.** The dropdown does NOT grey out already-used angles.
A writer can add "Pain at Safe" AND "Pain at Wild" as two separate rows — that's
how per-angle intensity works (same door, different push). Repeats are intentional.

**Why this beats seven-always-visible rows:**
- Resting state is one row / an add button — calm on mobile, not a wall of steppers.
- The count-ceiling worry softens — building up 15 options means deliberately
  adding rows, not fat-fingering a slider to 15.
- Density scales with intent — a writer who wants one wild reframe adds one row; a
  writer who wants a big spread adds several.

**Intensity replaces the old whole-batch distance idea.** The shipped system had
one Variety setting (Stay close / Explore / Roam wide) applied to the entire
batch. Intensity is now PER ROW — you can keep Pain safe while pushing Reframe to
the edge, in the same generation.

**Why a notched slide-rule for intensity, not pills and not a free slider:** For
the old *distance* dimension we deliberately chose three discrete pills over a
slider, because a continuous distance value was ambiguous ("what does 60% far
mean?"). Intensity reverses that call ON PURPOSE — intensity is a natural gradient
(like the temperature meter in Google AI Studio; "a bit more intense" is a real
felt quantity in a way "a bit more different angle" was not). But a fully free
slider brings back the "what does halfway produce?" ambiguity. The notched
slide-rule is the middle path: it FEELS like a continuous dial but SNAPS to three
legible, named values (Safe / Bold / Wild). Best of both.

Most rows rest at count 0; a writer only touches the angles they want.

- **Count ceiling — see open thread.** Some writers want 1–2 variations; others
  want 10–15 across angles. Leaning toward a high-but-real ceiling (e.g. per-angle
  cap so a fat-fingered stepper can't fire an enormous generation), not truly
  uncapped. Decide before building the matrix UI.
- **Repeats are intentional.** "3 Reframe at Wild" is valid — three wild reframe
  executions, different wording, same angle. The writer's choice, not a clustering
  failure. (Contrast with the shipped system, where repeats past 7 doorways were a
  *problem* to prevent. Here the writer owns it.)
- The button + a live summary always show the truth: e.g. "Generate 6 · 3 Pain
  (Safe), 2 Reframe (Wild), 1 Contrast (Bold)."

### Angle-awareness per field type

The matrix applies to **every** copy field type — headline, subhead, body, CTA,
hook — with the generator respecting that asset's best-practices and voice.md,
exactly as generation already does. `assignDoorways()` already keys off field
type; the machinery exists. The matrix is a UI over it.

BUT the *meaning* of an angle changes with copy length — see Open Thread 2.

### Append model (resolves "generate more without losing the keepers")

Each matrix run **appends**. The writer opens the matrix, sets angles + counts +
intensities, generates → a batch stacks under the field. They open the matrix
again, set it however they like, generate → that batch appends **below** the
existing ones.

- **No reconciliation.** The matrix does not remember or dedupe against what's
  already stacked. It runs and tacks on. Want fresh angles? Set different ones.
  Want more of the same? Set the same. The writer's matrix input is the whole
  intent, every run.
- **The original line is the SEED.** The variations aren't copies or tweaks of the
  original copy — they're genuinely different angles. But they all grow OUT of
  that one original line as the starting point. The original is the root; each
  batch below is what sprouted from it.
- **Each batch restarts numbering at 1.** Because each "riff" is a fresh burst of
  alternatives grown from the same seed, every batch is its own self-contained set
  (1, 2, 3), all tracing back to the original line above. Down the field you see:
  the original line, then a batch (1, 2, 3), then another batch (1, 2, 3), etc.
  NOTE: this REVERSES the "numbering continues 4,5,6" idea in the earlier draft of
  this doc — the seed-and-burst mental model makes restart-at-1 the right call.
- **Batch separation (DECIDED): a faint label per batch — "Riff 1", "Riff 2", …**
  Each batch sits under its own faint label so repeated 1,2,3 / 1,2,3 reads as two
  distinct riffs, not a numbering error. Every batch — INCLUDING a single-option
  batch — sits under its own "Riff N" label and carries doorway tags consistently.
  This also fixes the earlier inconsistency where the first riff produced a lone
  UNLABELED "1." while later riffs produced labeled "1. (Contrast)". From now on
  ALL riffed options carry their doorway tag and sit under a Riff N label,
  regardless of batch size.
- **Resolving down stays manual, in the doc.** The writer deletes what they don't
  want, keeps what they do, whenever they want. The doc is where the writer
  resolves; the app feeds options in.

This is a real architectural change — see Open Thread 1.

---

## OPEN THREADS — decide before building

### Thread 1 — Regenerate (replace) vs Riff (append): TWO distinct actions

**The architectural break.** Current regeneration is **destructive-replace**:
`generateDraft` runs the two-phase write — `parseDoc` finds the field's copy
range, Phase 1 deletes it bottom-to-top, Phase 2 re-inserts. Re-regen deletes the
whole stack and writes new. This assumes every generation *supersedes* the last.

The append model needs an **additive** write: leave everything in place, insert a
new batch below the existing copy. That's a genuinely different operation from the
delete→insert path. **This is STEP 1 (the write path) — built first, in isolation,
no UI.**

**Numbering (decided): each batch restarts at 1.** Because batches are seed-and-
burst (see Append model above), the append write numbers each new batch from 1,
not continuing from the previous batch's max. The original seed line is left
byte-identical.

Starting-state handling (all keep the existing content byte-identical — the append
write NEVER renumbers or mutates existing lines):
- Field has existing copy (bare line, solo labeled, or a prior batch) → new batch
  inserts BELOW it, numbered 1, 2, 3.
- Field is empty / undrafted → new batch inserts as 1, 2, 3 (behaves like a first
  draft).

So a field with a stack now has TWO generative actions:
- **Regenerate** — replace what's there (existing destructive behavior)
- **Riff with variations** — append a new matrix run below what's there

**Decision needed (STEP 2 — UI, later):**
- These CANNOT be the same button — one destroys, one adds. They must be visually
  distinct so a writer never nukes a stack they were building, or appends when
  they meant to replace.
- Where does each live in the field card? What do they look like?
- Does "Regenerate" still open the direction modal? Does "Riff" open the matrix?
  (Leaning: Regenerate → direction modal as today; Riff → matrix.)

**Implementation (STEP 1):** the append write needs a new path in
`googleDocs.generateDraft` (extend with an `append` flag, not a sibling function —
~90% shared path) that inserts-after rather than delete-then-insert. The insert
index is the end of the field's current copy block. No delete phase — append
fields are pushed with `deleteEnd: null` so they structurally cannot enter the
deletions list (the guarantee is enforced by the data, not a suppression flag).

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
