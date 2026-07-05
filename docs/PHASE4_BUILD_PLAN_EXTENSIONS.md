# Phase 4 Build Plan — Extensions Addendum

*Captured from the July 2026 design session, continuing past the core Phase 4 plan. These are refinements and new features surfaced after the base build plan was settled. They extend the plan; they do not change its core sequence. Same architectural constraints apply throughout (text into Figma only via plugin; Slack/web buttons open files and trigger, they don't reach into external systems directly). Read alongside PHASE4_BUILD_PLAN.md and PHASE4_ADDENDUM.md.*

---

## 1. The template as the pipeline's configuration unit

The biggest conceptual shift from this session: **a "template" in Quillio is not just a Figma file — it is the complete definition of how a project's copy and design are produced, formatted, and named.** One template selection drives everything downstream.

A template carries four things:

1. **Asset scope** — which asset types are in play (both the Figma design frames and the copy doc sections). A "Digital Demand Gen" template might contain only LinkedIn, Meta, display, and nurture email; a "Full Campaign" template contains everything.
2. **Brand** — the visual styling, via `design.md` applied through the plugin's Brand mode (already in the base plan, Stage 6).
3. **Doc-header structure** — how the top of the copy doc is laid out (see §2).
4. **File naming convention** — how the copy doc and Figma file are named (see §2, §3).

All four can be set **by example** rather than by form — upload a screenshot / show a filename, and Quillio infers the pattern. `design.md` was the first instance of this convention-by-example philosophy; doc structure and naming extend it.

### Mechanics
- The `templates` table (already planned, one-to-many) holds each template's `figma_file_key` plus its doc-header schema and naming pattern.
- A project references a `template_id`. File creation duplicates *that* template's Figma file; copy-doc generation uses *that* template's doc schema and asset scope.
- **Selecting** an existing template is pure server-side. **Creating** a new custom template (choosing which asset types it contains) is a Figma-write operation → reuses the plugin's Compose engine, producing a reusable template rather than a one-off project file.
- Template selection/creation lives in the Quillio web app. Whichever template is selected is what the app pulls from when creating the project's Figma file *and* copy doc.

### Template drives copy-doc scope (decision needed)
Today the copy doc is scoped by brief-parse (Quillio reads the brief, picks asset types). Template-driven scope is a different input. The relationship must be decided deliberately:
- **Template as filter (recommended):** template defines the universe of possible assets; brief-parse selects within it.
- Template as default: template pre-selects, brief-parse can add/remove.
- Template overrides parse: template's asset list *is* the scope.

This touches the existing copy pipeline, so it's a deliberate build with the parse-vs-template relationship settled first.

---

## 2. Convention-by-example: doc setup + naming

Onboarding should be **observational, not configurational** — the user shows Quillio an example and it infers the pattern.

### Doc-header structure from a screenshot
- User uploads a screenshot of the top of their existing copy docs (e.g. the "MC Creative" header table: two-column bordered layout with Project / Writer / Date / Version on the left, Product / Project owner / Last edit by on the right).
- Gemini vision (`describeImage()`) extracts the field set, labels, order, formatting, and table structure → stored as the template's doc-header schema.
- Each field is classified by fill type:
  - **Auto-fillable from Quillio data** (Project/campaign, Writer, Date, Version)
  - **Static/branding** (the team wordmark)
  - **Left blank for the human** (fields Quillio doesn't own — Product, Project owner, Last edit by — labels reproduced, values empty)
- Honest scope: Quillio matches the *structure* exactly and fills what it legitimately has; it does not invent values for fields it doesn't own.

### File naming from a typed pattern
- A typed input field, not a screenshot (more reliable for token mapping). User enters e.g. `[Team]_[Project]_[Date]_v[N]`.
- Quillio maps each token to a data field and shows "here's what fills each slot" for confirmation. Inference plus a confirmation step, not blind inference.

### The sample-review-edit-lock loop (the key interaction)
The correct pattern is: generate a sample → let the user adjust until it feels right → lock it in. The critical design decision is *how they adjust*, because freeform tweaking has no clean way for the app to interpret intent.

**Resolution: don't make them describe changes in freeform — let them edit the extracted structure directly.**
1. Upload doc-header screenshot.
2. Quillio extracts structure, presents it as an **editable field list** + live preview (not a flat image).
3. User renames / reorders / adds / removes / formats fields directly. The preview re-renders from their edits.
4. Type the file-naming pattern; confirm which data fills each token.
5. Preview looks right → lock to the template.
6. Every project on that template now generates the copy doc in that format, named that way.

The thing they edit *is* the stored schema, so there's no inference gap in the correction step. Screenshot gets ~90% there automatically; the editable field list fixes the last 10% precisely.

---

## 3. Consistent, paired file naming

Lock in as a convention now (fold into base-plan Stage 2, file creation — trivial and every project should follow it from the start):

- Copy doc: `Quillio — [Campaign Name] — Copy`
- Figma file: `Quillio — [Campaign Name] — Design`

Same base name, clear suffix, so the two artifacts pair visually wherever they appear (Drive, Slack, web app card). When a template carries a custom naming convention (§2), that convention governs instead — the default above applies when none is set.

---

## 4. Draft review feature (voice.md + craft)

A **writer-triggered** review pass that gives the writer a second set of eyes without rewriting — advisory, keeping the writer as author. Consistent with the whole product thesis.

### What it does
- Writer finishes a draft (or gets it to a good place) and triggers a review.
- Quillio evaluates the copy against two lenses:
  - **Voice fit** — against the user's `voice.md` (brand/voice guide; the Voice Guide concept already in the stack, IBM Plex Mono terminal editor, has a home for this).
  - **Craft** — general grammar, clarity, tightness.
- Quillio leaves **anchored comments** in the copy doc — specific, actionable, positioned at the relevant text — not a vague summary.
- The writer reads and decides what to act on. Quillio suggests; the writer edits.

### Decisions settled
- **Comments, not suggested edits.** Google Docs supports both comments (margin notes) and suggestions (tracked-change proposals). Comments are the author-respecting choice and truer to the thesis. Stay comments-only, at least to start.
- **Writer-triggered, not automatic.** A deliberate "review this now" action, not an unprompted pass on every edit.

### Triggers
- **"Review Draft" button on the project card** (the card is the project context).
- **Slack command / action** (resolves via the `thread_ts` mapping — same pattern as handoff).

### To verify before building
- That Google Docs API comment-insertion works cleanly server-side. Likely yes (comments are a supported Docs API surface), but verify — the Drive MCP had a related limit (couldn't edit Sheets cell values), so confirm rather than assume.
- The review pass must produce *positioned, specific* feedback anchored to the actual text, not a summary.

### Where it lands
Its own feature, parallel to the design pipeline (operates purely on the copy doc, no Figma). Natural Phase 5-ish addition — deepens the copy side rather than extending design handoff. Reinforces the product identity: the copy doc is Quillio's central artifact (as Figma owns the design file), and a review layer on that doc makes it even more clearly Quillio's home turf.

---

## 5. Slack lifecycle: threaded replies + live status dashboard

A refinement to the existing Phase 3 Slack flow. Touches existing code, so it's a deliberate refactor — worth doing **early**, before layering handoff/review buttons on top, so those buttons land on the threaded structure rather than being retrofitted. Also reinforces the data model: the parent message's `ts` *is* the `thread_ts` anchor already persisted, tying the whole project lifecycle to one spine.

### From mutating message → threaded replies
- **Current:** one channel message whose content changes in place (`chat.update`) as the pipeline progresses. Earlier states are overwritten and lost; silent updates often don't re-notify.
- **New:** the trigger posts a parent channel message; each stage (doc ready, first draft ready, handoff-available, review-run) posts as a **reply in that message's thread**. Durable history, each reply re-notifies, and actions anchor to the specific stage they belong to.

Why threaded wins: preserves the full timeline, re-notifies at each stage, anchors the "Open Design" and "Review Draft" actions to the right moment, and keeps the channel scannable (one parent per project).

### The hybrid parent message = live project dashboard
The parent message retains durable project details **and** shows live status:
- **Durable summary:** project name, asset list, folder link, copy doc link.
- **Live status panel:** per-asset completion — checkmark for complete, in-progress marker for still being written.
- **Overall stage indicator** (e.g. "Drafting" / "Ready for Handoff").
- Thread below holds stage history and the action buttons.

### Completion state = same check as the handoff guard
The per-asset checkmarks are driven by the **same content-based completion check** the handoff guard uses: an asset is "complete" when all its required copy fields (from the Postgres `copy_fields` spec) are non-empty in the doc. One source of truth, two surfaces (handoff modal + Slack dashboard). Decide if "all required fields filled" is the right definition of complete, or if an explicit writer signal is wanted.

### Update model — honest about "real time"
Slack messages don't self-update, and Quillio isn't notified on Google Doc keystrokes, so true keystroke-level real-time isn't realistic without expensive polling.
- **Recommended: event-driven + manual refresh.** Checkmarks update automatically on any pipeline event (doc created, draft generated, review run, handoff) *and* via a "Refresh Status" button. Accurate at every interaction point without a polling loop.
- **Possible later enhancement:** scoped polling of active projects for near-real-time, if it proves worth the API cost and rate-limit exposure. Back off when idle.
- Presenting it as "live" is fine as long as it's accurate at every interaction point; the writer rarely needs mid-keystroke updates — they need it right when they come back to check.

---

## Summary of where these land

| Extension | Nature | When |
|---|---|---|
| Paired file naming (`— Copy` / `— Design`) | Convention | Fold into base Stage 2 now |
| Template selection drives file creation | Uses planned `template_id` | Base Stage 2 (web app exposes choice) |
| Slack threading + hybrid dashboard | Refactor of Phase 3 Slack | Early — before handoff/review buttons |
| Custom template creation (subset of assets) | Reuses Compose engine | After single-template Lone Wolf works |
| Convention-by-example doc setup + editable-field-list loop | New, touches copy pipeline + vision | Deliberate follow-on |
| Template-driven copy-doc scoping | Touches copy pipeline; decision needed | Deliberate follow-on |
| Draft review (voice.md + craft, anchored comments) | New, copy-doc only; verify Docs comment API | Phase 5-ish |

**Unifying idea:** the template is the configuration unit (asset scope + brand + doc structure + naming), much of it settable by example; the copy doc is Quillio's central artifact, now with a review layer; and the Slack parent message becomes a live, always-accurate project dashboard anchored to the persisted `thread_ts`.
