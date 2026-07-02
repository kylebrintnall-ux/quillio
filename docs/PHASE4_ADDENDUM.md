# Phase 4 Addendum — Figma Integration Architecture Decisions

*Captured from design session, July 2026. This addendum refines and extends the original PHASE4.md spec with decisions made during detailed walkthrough of onboarding, account tiers, and the Slack handoff mechanism.*

---

## 1. Account Tier Model (Prototype Scope Decision)

Three tiers exist conceptually, but **prototype build scope is Lone Wolf only.** Team tier is explicitly deferred until the Lone Wolf pipeline is proven end to end.

### Solo Copywriter
- Writing only. No design responsibility.
- Flow: Brief in → copy doc out. Full stop.
- **No Figma integration offered at all.** This tier should never see a "Connect Figma" prompt during onboarding — it has no use for it.

### Lone Wolf *(prototype build target)*
- One person owns both copy and design (e.g., sole marketer at a small business).
- Flow: Brief in → copy doc AND Figma file out, both populated, both in the same Drive project folder.
- This is the tier where Figma OAuth, template creation, and population logic all matter.
- No approval workflow — completion is self-determined, not routed to anyone else.
- **Slack brief intake remains available to this tier**, since a Lone Wolf user may still operate inside an organization's existing Slack workspace even without needing the approval chain. Slack notifications tied to *review state* are not applicable here since there's no reviewer — but Slack-based *design handoff* triggering (see Section 4) still applies, since Figma population is relevant to this tier regardless of intake channel.

### Team *(deferred)*
- Introduces the approval chain: Copywriter → Creative Manager → optional Collaborator → Designer notification.
- Requires Settings fields for Creative Manager / Designer per project.
- Requires Slack notifications tied to approval state changes.
- **Explicitly not part of current build scope.** Do not architect approval-chain UI or notification logic until Lone Wolf pipeline is working.

### Cross-cutting principle
Approval state (once built for Team tier) should live in Postgres and the web app as the source of truth. Slack is a notification layer bolted on top, not the mechanism itself. This matters because a contractor/freelancer temporarily inside a client's Slack workspace cannot install a Slack app there (requires admin permissions) — so the core workflow must function fully via web app + email links, with Slack as an optional convenience notifier, never a hard dependency.

---

## 2. Figma Onboarding Flow

### New workspace connecting Figma via OAuth
1. User connects Figma account.
2. Quillio generates a **neutral master template** — Lorem Ipsum placeholder copy in all correct field positions, blank visual placeholder shapes (circle/square) representing where imagery will go, at correct dimensions per the 30 asset type specs.
   - **Important:** the current hand-built master template (file key `YtLxCXlWrN0AXtxlNY7ucU`) is now fully branded with Quillio's own design system and is **not** representative of what a new user's auto-generated template should look like. That file is Quillio's own marketing asset, not the onboarding template pattern.
3. User is told: this file is now the permanent source template that all future project generations will draw from. Editing it (colors, layout, positioning) is expected and encouraged as their brand evolves — the master always stays live and editable, not locked after creation.

### Branding step (optional, not gating)
4. User is prompted to optionally upload screenshots, logos, existing brand material, or photography.
5. If provided, Quillio generates `design.md` (structured brand DNA — colors as hex, type as family/weight/size per role, spacing tokens).
6. User can choose to apply `design.md` to their master template as a starting point for restyling.
7. **This step must not gate first use.** A user should be able to run their first real project on the neutral Lorem Ipsum template before ever touching branding. Branding is an enhancement path, not a prerequisite.

### Multiple templates (deferred feature, not initial scope)
- Decision: **default state is exactly one template per workspace.** Multi-template support (e.g., separate templates for enterprise B2B vs. consumer campaigns) is a real future need but should be **progressive disclosure** — a "Create New Template" option visible in Settings, discovered when needed, not surfaced during onboarding.
- Data model implication: even though most workspaces will only ever use one template, the schema must support one-to-many from the start (a `templates` table, not a single `figma_file_key` column on the workspace). Retrofitting this later would be significantly more painful than building it correctly now.
- Sketch: `templates` table — `id`, `workspace_id`, `name`, `figma_file_key`, `created_at`, `is_default`. Projects reference `template_id`.

### Suggested additions worth considering (not yet decided)
- **Skip-branding path** — covered above, now a stated principle.
- **Template validation** — a "Validate Template" action in Settings that checks all expected named layers (`[Headline]`, `[Subhead]`, `[CTA Button]`, etc.) still exist across all frames, catching accidental renames/deletions before they cause a silent population failure mid-project.
- **Template changelog** — even for solo/Lone Wolf use, a lightweight record of when the master template was last edited could help explain "why does this new asset look different from the last one" without needing full version history.

---

## 3. Project Generation Flow (Lone Wolf)

1. User submits a brief (via web app or Slack `/quillio`).
2. Quillio generates the copy doc as it does today.
3. Quillio **also** duplicates the relevant frames from the master Figma template into a new project-specific Figma file.
4. Both the copy doc and the new Figma file land in the same Drive project folder.
5. Copy doc generation and Figma file generation happen together at brief-kickoff time — the Figma file exists early (with placeholder/neutral content matching the master) even before copy is finished; population happens at handoff (Section 4), not at creation.

---

## 4. Design Handoff Mechanism (Web App + Slack)

### Web app path
- When a user sets a project's status to **Finished** via the status dropdown (existing UI, see project card), a **"Hand Off to Design"** button appears on that project card.
- One click populates the Figma file's named text layers from the copy doc's finished fields.
- Context is unambiguous here — the card *is* the project, no lookup needed.

### Slack path
**Problem identified:** a bare Slack command has no inherent project context — Quillio can't know which of a user's many projects a `/quillio-handoff`-style command refers to unless something disambiguates it.

**Solution: thread-based context via an in-message button (not a typed command).**

- The existing doc-ready Slack message and the first-draft-ready Slack message both get an appended **"Hand Off to Design"** button (using the same `views.open` / block-actions interactive-message pattern already used for the kick-off modal).
- Clicking the button carries Slack's message/thread context automatically, which Quillio resolves to a `project_id` via the stored mapping (`project_id → slack_thread_ts`, already implied by existing notification infrastructure).
- This eliminates the need for the user to remember or type any command — the instruction and the action live in the same place, at the moment it becomes relevant.
- **Fallback for edge cases:** if a button somehow isn't available (unlikely given Slack's reliability here, but worth noting), a typed reply-in-thread command remains the documented fallback, resolved the same way via thread context.

### Guard conditions on the Hand Off button (critical — do not skip)

**Full completion check:** Before populating, check actual field content per required asset type in Postgres — not just the project's overall status label. A project could be marked "Finished" prematurely by a human, or still show "In Progress" while copy is actually done. Trust the content, not the label.

**Partial completion — modal, not a hard block:**
- If some asset types have finished copy and others don't, do **not** block the handoff outright.
- Show a modal (web app or Slack) listing each asset type with its status: e.g. "LinkedIn Ad: Ready" / "Nurture Email: Incomplete."
- Two choices presented: **"Hand Off What's Ready"** or **"Wait for Everything."**
- Rationale: real creative work is often uneven — one asset may be finalized while another is still being revised under deadline pressure. Blocking the whole handoff until every asset is done would slow teams down exactly when speed matters most.

**Repeatable, idempotent handoff:**
- The "Hand Off to Design" button **does not disappear or get consumed** after a partial handoff.
- When remaining copy is finished later, clicking the button again populates only the **newly-completed** asset types — it must not duplicate or overwrite already-populated frames.
- Implementation implication: the population script must check current Figma layer state (or maintain a Postgres record of which asset types have already been populated for this project) and only write what's new. This makes the population logic idempotent per asset type, not a single one-shot operation per project.

**Zero-completion error state:**
- If the button is clicked with no finished copy at all (accidental click), respond with an **ephemeral** Slack message (visible only to the clicker, not posted to the whole thread): *"No copy to hand off yet — this project doesn't have finished copy in the doc. Finish writing, then try again."*
- Ephemeral response is deliberate: an accidental click is a private mistake, not something that should clutter shared thread history or draw attention to the person who clicked prematurely.

---

## 5. Beyond Figma (Noted, Not Current Scope)

- **Canva integration** is the next design-tool target after Figma, following the same architectural pattern (OAuth → template creation → population).
- Long-term principle: Quillio should support whatever word-processing and design tooling a team already uses, rather than forcing a single stack. Figma and Canva are the first two proof points of this principle, not the ceiling of it.

---

## 6. Related Backend Work (Cross-Reference)

The **Subhead field addition** (asset spec library, Postgres schema, Gemini prompt, Google Doc template, Figma layer naming convention) is a prerequisite for population to work correctly on paid social, organic social, and display asset types, since Subhead did not previously exist as a generated field despite being added ad hoc to the Figma template during design review.

**Status: shipped (July 2026).** Subhead is now a real field across the affected assets, grouped with the other on-graphic copy under a "Graphic Copy" sub-heading:
- Asset library / seed (`src/data/defaultAssets.js`) + idempotent migration for already-seeded tenants (`scripts/migrateAddSubheadField.js`, and the grouping/limit follow-ups `migrateAddGraphicCopyGroup.js` / `migrateOrganicAndGraphicHeadlineSpecs.js`).
- Postgres: `copy_fields.group_label` added; the on-graphic fields (Graphic Headline, Subhead, CTA on paid/display; Graphic Headline + Subhead on organic) render together and map as a unit.
- Gemini prompt: Subhead carries built-in guidance (support the headline, don't repeat it); Graphic Headline drafts in sentence case.
- Google Doc: Subhead renders under an indented "Graphic Copy" sub-heading; the re-parser skips the sub-heading so Generate First Draft still recovers every field.
- Figma layer naming: `[Subhead]` documented in `PHASE4.md` for the population step.
