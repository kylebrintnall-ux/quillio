# Phase 4 Build Plan — Figma Integration (Lone Wolf)

*Sequenced build plan derived from the July 2026 architecture sessions. This is the ordered path from the current state to a working Figma integration for the Lone Wolf tier. Claude Code should read this and PHASE4_ADDENDUM.md before writing any Phase 4 code. Prompts are sent one at a time, in order; do not skip ahead.*

---

> **⚠️ CORRECTION — verified July 2026 against Figma's live developer docs + OAuth scope list.**
> **The Figma REST API cannot create or duplicate files.** Every file scope is read-only
> except comments (`file_content:read`, `file_metadata:read`, `file_comments:write`,
> `projects:read`) — there is **no** create-file or duplicate-file endpoint. The
> `POST /v1/files/:key/duplicate` call this plan assumed **does not exist**. Only the
> **Figma Plugin API** (running inside an open Figma editor) can create or modify files.
>
> **Invalidated below (search `⚠️ INVALID`):**
> - **Stage 1.5** — REST-duplicate the master template → not possible as written.
> - **Stage 2.1** — server-side auto-create the project Figma file at brief time → not possible as written.
> - The **Division of labor** bullet listing "project Figma file creation" as a server-side/REST job.
>
> **Corrected constraint:** file creation must move **into the Quillio Figma plugin** — the
> plugin *composes* a new project file from the master template inside Figma (an extension of
> the Compose mode already planned in Stage 3), since only the Plugin API can create files.
> Stages **1.1–1.4 remain valid** (schema, OAuth, token storage, refresh) — a stored token
> still authorizes REST *reads* + comment writes, and the plugin runs in the user's own
> session. **Redesigning how/when project files get created (plugin-driven, not REST) is a
> design change to be worked out at the start of the next session** — do not build 1.5 / 2.1
> against the phantom endpoint.

---

## The settled architecture (read first)

**The immovable constraint:** Text can only be written into a Figma file by a plugin running inside an open Figma editor. Nothing external — not Slack, not the Railway backend — can reach in and write to a file. Everything below is designed around that fact.

**The named-layer convention is load-bearing.** Every asset frame has named text layers (`[Graphic Headline]`, `[Subhead]`, `[CTA Button]`, etc.). The plugin finds and fills layers *by name*, wherever the designer has moved them. This is what lets population survive design work.

**Division of labor:**

- **Server-side (Railway / REST):** OAuth, folder creation, ~~project Figma file creation at brief time~~ (**⚠️ INVALID** — REST can't create files; this moves into the plugin, see the correction banner), project record-keeping, design.md generation, serving approved copy to the plugin, finished-asset export into the Drive campaign folder at handoff.
- **Plugin (inside Figma), three modes:**
  - **Compose** — trim the file to only the needed asset frames, clean and ready.
  - **Brand** *(optional)* — apply design.md styling to the master template.
  - **Populate** — fill named layers with approved copy, idempotent, non-destructive to design work.

**Triggers:** A hyperlink in the Slack doc-ready message and a dedicated button in the web app *open the Figma file*. They cannot populate directly (Slack can't reach into Figma). The real Compose / Brand / Populate buttons live in the plugin panel inside Figma.

**File creation and population are decoupled.** The file exists early and empty (neutral placeholders) so design can begin. Copy populates later, separately, when it's written and approved — flowing into named layers around the design work without disturbing it.

**Scope:** Lone Wolf only (one person owns copy and design; no approval step). Team tier (manager approves in Slack, gating population) is deferred.

**Deliberately rejected:** Headless-browser Figma automation to force touchless population. Unsupported, fragile, breaks on Figma updates, terms-grey, maintenance sinkhole.

**Filed for later:** Canva Enterprise autofill (server-side touchless, but Enterprise-gated) and rendering APIs like Bannerbear/Placid (touchless for any user, but flat-render output, not editable files) — both are post-Figma expansion tiers, not prototype scope.

---

## Assets already in place

- **Neutral master template** built and live: file key `3KqH3AUiS35z4oo6Ysvt0V`. Correct asset list from Postgres, graphic-copy fields only, variants grouped, landing pages sectioned, unfolded direct-mail box, no text overlaps.
- **Subhead field** already added to the copy doc pipeline (prerequisite complete).
- **Persistence bug fixed:** projects created via `/quillio` now write a projects row via the shared pipeline, with `slack_channel_id` / `slack_thread_ts` linkage. Verified end to end — Slack-created projects appear in the web app. This is the data foundation the Hand Off action resolves against.

---

## Stage 0 — Manual setup (no code)

**0.1 Register the Figma app.**
Go to figma.com/developers → My apps → Create a new app (name: Quillio). Set OAuth redirect URL to `https://quillio.co/auth/figma/callback`. Copy the Client ID and Client Secret. Add to Railway as `FIGMA_CLIENT_ID` and `FIGMA_CLIENT_SECRET`. (Five-minute form, no review needed for credentials.)

**0.2 Set neutral template sharing.**
Open the neutral master template (`3KqH3AUiS35z4oo6Ysvt0V`) in Figma and set sharing to "Anyone with the link can view." This exposes only that one file (Lorem Ipsum placeholders — nothing sensitive), not your account. It's the source the duplication call reads.

*(No personal Figma API key is needed anywhere. OAuth Client ID + Secret covers the REST side; the plugin inherits the user's own Figma session.)*

---

## Stage 1 — Server-side foundation (REST OAuth + schema)

**1.1 Schema changes.**
Add Figma token columns to `tenant_tokens`: `figma_access_token`, `figma_refresh_token`, `figma_token_expires_at`. Create the `templates` table: `id`, `workspace_id` (tenant), `name`, `figma_file_key`, `is_default`, `created_at` — one-to-many from the start even though most tenants use one template (per addendum §2). Add `template_id` FK and `figma_project_file_key` to the `projects` table. Migration script validated locally before Railway run, matching the `scripts/migrate*.js` pattern.

**1.2 Figma OAuth — redirect route.**
Build `/auth/figma` that redirects to Figma's OAuth authorization URL with the current granular scopes `current_user:read file_content:read file_metadata:read file_comments:write projects:read` (space-separated; Figma deprecated the old `files:read` / `files:write` scopes), the Client ID, redirect URI, and a state parameter. Manual fetch, no passport.js — same pattern as Google/Slack OAuth.

**1.3 Figma OAuth — callback route.**
Build `/auth/figma/callback` that exchanges the code for access + refresh tokens and stores them in `tenant_tokens`. Apply `.trim()` to all env var reads (the trailing-whitespace defense from Phase 3). Trigger 1.4 on success.

**1.4 Token refresh utility.**
A helper that checks `figma_token_expires_at` before any Figma REST call and refreshes if needed. Applied to all Figma REST calls going forward.

**1.5 Master template duplication + folder. — ⚠️ INVALID AS WRITTEN (see correction banner).**
The `POST /v1/files/:key/duplicate` endpoint below **does not exist** — the Figma REST API cannot create or duplicate files. This stage must be redesigned so duplication/creation happens **inside the Quillio plugin** (compose from the shared master template `3KqH3AUiS35z4oo6Ysvt0V`), not server-side. The `templates` row (schema from 1.1) is still the right place to record the resulting `figma_file_key`; only the *mechanism* changes. Redesign at the start of the next session — do not implement the REST call below.
~~On successful OAuth, using the user's access token: create a "Design Templates" project folder in the user's Figma team, duplicate the neutral master (`3KqH3AUiS35z4oo6Ysvt0V`) into it via `POST /v1/files/:key/duplicate`, and store the returned file key in the `templates` table as `is_default = true`. Name it e.g. "Quillio — [Workspace] Master Template." This is their permanent, editable master (addendum §2).~~

**1.6 Connect Figma UI — onboarding + Settings.**
A "Connect Figma" button visible only to Lone Wolf tier. Shows connection status after OAuth. **Must not gate first use.** Add a Figma section to Settings → Workspace showing connected status, the template file name with a link, a disconnect option, and a "Validate Template" action that checks all expected named layers still exist across frames (addendum §2).

---

## Stage 2 — Project Figma file creation at brief time — ⚠️ INVALID AS WRITTEN (see correction banner)

**2.1 Auto-create the project Figma file. — ⚠️ INVALID AS WRITTEN.**
Server-side duplication is **not possible** — the Figma REST API cannot create files, so the pipeline cannot auto-create the project Figma file at brief time. This has to be reworked so file creation is **plugin-driven** (the plugin composes the project file from the master when the user opens Figma). What stays valid: persisting the resulting key on the `projects` row (`figma_project_file_key`, schema from 1.1) once the plugin has created the file, and running for both Slack and web briefs. Redesign the trigger/mechanism at the start of the next session.
~~In the shared `core/pipeline.js` (same place project persistence now lives), after the copy doc is created: duplicate the tenant's master template into the "Design Templates" folder as a new project-specific file, store its key on the `projects` row (`figma_project_file_key`). This runs for **both** Slack and web briefs — the data fix means both paths reach this code. The file starts with the full template; the plugin trims it to needed assets on first open (Compose mode). Best-effort / swallowed on error, matching the doc-persistence pattern.~~

**2.2 Cross-link the artifacts.**
Store both locations against `project_id` (copy doc in Drive, Figma file in Figma). Surface both together in the Slack doc-ready message and the web app project card. Add a link to the Figma file into the Drive campaign folder so the campaign is one click apart across systems. *(Live Figma file stays in Figma — it can't physically live in Drive. Finished exports land in Drive at handoff; see Stage 5.)*

---

## Stage 3 — The Quillio Figma plugin (compose + populate)

*A separate plugin project. It needs no Figma credentials — it runs in the user's session. It talks only to the Railway backend for copy, specs, and design.md.*

**3.1 Plugin scaffold + backend read endpoints.**
Scaffold the plugin (manifest, UI panel, code). Build the Railway endpoints the plugin calls: given the open file's key (`figma.fileKey`), return the project's needed asset types and current approved copy fields. The open file *is* the project context — no manual project selection (same principle as Slack thread context).

**3.2 Compose mode.**
Plugin action that reads which asset types the brief needs (from Railway) and deletes the frames not needed, leaving a clean file with only the right assets. Runs on the designer's first open. Idempotent — safe to run again.

**3.3 Populate mode.**
Plugin action that pulls approved copy from Railway and writes it into named layers **by name**, wherever the designer moved them. Idempotent per asset type: only writes newly-completed fields, never overwrites populated frames, never disturbs design work. Handles missing/renamed layers gracefully (this is what "Validate Template" guards against). Runs on demand, repeatedly, as copy finishes (addendum §4).

---

## Stage 4 — Handoff triggers (Slack link + web app button)

**4.1 Web app "Open Design" button.**
On the project card, a button that opens the project Figma file (with the plugin available). Appears once the Figma file exists.

**4.2 Slack hyperlinked "Open Design."**
Append a hyperlink to the existing doc-ready and first-draft-ready Slack messages that opens the project Figma file. Resolves the file via the `project_id → figma_project_file_key` mapping (and `slack_thread_ts` for context — now reliably persisted). Uses the existing block-actions / message pattern.

**4.3 Completion-state surfacing.**
Before the user opens the file to populate, show per-asset readiness (Ready / Incomplete) based on actual field content in Postgres — not the project's status label. The partial-completion choice ("Populate What's Ready" vs "Wait") lives in the plugin's Populate mode UI, driven by this state (addendum §4). Zero-completion accidental clicks get the ephemeral Slack message, not a thread post.

---

## Stage 5 — Finished-asset export to Drive

**5.1 Export final assets into the Drive campaign folder.**
When design is finished, export flattened PNG/PDF of the final frames and drop them into the same Drive campaign folder as the copy doc — so the campaign folder holds the complete package (copy + final design exports) even though the editable source stays in Figma. Same pattern extends to Notion/OneDrive later: live file in the design tool, finished exports + copy in the storage system, Quillio tying them together by campaign.

---

## Stage 6 — Branding layer (optional, non-gating)

**6.1 design.md generation.**
Server-side. On optional brand-material upload (logos, screenshots, photography), use Gemini vision (the existing `describeImage()` from Phase 3) to extract structured brand DNA into `design.md`: colors as hex, type as family/weight/size per role, spacing tokens, logo references. Reliable, automatic, no Figma involved.

**6.2 Brand mode (plugin).**
An optional third plugin action that reads design.md from Railway and restyles the master template — colors, spacing, sizing, standard/Google fonts. **Applied once to the master**, so all future project files inherit it via composition; re-run only when the brand evolves (addendum §2, "master stays live and editable").

**Caveats to set in onboarding:**
- Custom/licensed brand fonts must be installed in the user's Figma environment for the plugin to apply them (the Star Crush lesson). Colors/spacing/sizing/standard fonts apply reliably.
- Branding is a strong *starting point*, not a finished brand system — the human designer still owns the design. This is consistent with the human-authorship thesis.
- **Never gates first use.** A user can run their first real project on the neutral template before ever branding.

---

## Build order summary

| Stage | What | Where |
|------|------|-------|
| 0 | Register Figma app; set template sharing | Manual |
| 1 | Schema, OAuth, token refresh, ~~template duplication~~ (⚠️ plugin-side, not REST), connect UI | Server-side |
| 2 | ~~Auto-create project Figma file at brief time~~ (⚠️ INVALID — plugin-driven, see banner); cross-link | Server-side (shared pipeline) |
| 3 | Plugin scaffold; Compose + Populate modes | Plugin + backend |
| 4 | Open-Design triggers (Slack link, web button); completion state | Server-side + plugin |
| 5 | Finished-asset export to Drive | Server-side |
| 6 | design.md generation; Brand mode (optional) | Server-side + plugin |

**Dependencies:** Stage 0 unblocks everything. Stage 1 is the server foundation. Stage 2 depends on 1 and on the (now-fixed) shared-pipeline persistence. Stage 3 (plugin) can begin in parallel with 1–2 since it's a separate project, but its Compose/Populate need the backend read endpoints (3.1). Stage 4 needs 2 and 3. Stage 5 needs the finished file. Stage 6 is optional and can come last.

**Deferred to Team tier:** approval chain, manager "Copy Approved" Slack action gating population, per-project Creative Manager / Designer settings.

**Deferred to later phases / upmarket:** Canva Enterprise autofill (touchless for Enterprise), rendering-API tier (touchless flat-render for any user).
