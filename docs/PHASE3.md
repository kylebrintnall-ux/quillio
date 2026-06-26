# Quillio Phase 3 — Full Build Plan

> **This is the authoritative Phase 3 plan.** Hand it to Claude Code as context
> at the start of any session. `ROADMAP.md` covers the whole product vision;
> this file is the week-by-week Phase 3 execution plan.

## Objective

Make Quillio installable by any workspace with their own credentials, asset
library, and Drive configuration. Deliver a web app (quillio.app) as a full
product surface alongside the Slack integration.

## Already complete

- Railway Postgres provisioned + 12-table schema migrated
- Pipeline refactored (`core/pipeline.js` + `adapters/slackWorkflow.js`)
- Tenant resolver built + default tenant seeded (`T0B8LPRDKHR` / Quillio Inc.)
- Slack OAuth install flow (`src/routes/oauth.js`)
- Google OAuth decision — folder URL in brief drives routing, service account handles writes
- Bug fix — Drive folder URLs excluded from reference ingestion
- Bug fix — `:quillio-folder:` wired correctly in `slackWorkflow.js`
- Emoji fallback config in `slackWorkflow.js`

## Week 6 — Thread tenant resolver into pipeline

Goal: The database actually does work at runtime for real tenants.

- Wire `resolveTenant(workspaceId)` into `slackWorkflow.js`
- Replace all direct `process.env` token reads with resolver output
- Env var fallback stays intact for demo workspace
- Pipeline behavior unchanged — only token source changes
- Smoke test: demo still works, new tenant resolves from Postgres

## Week 7 — Asset library per tenant

Goal: New tenants get the full 30-asset default library in Postgres on install.

- Seed the master asset library from the bundled default library (`src/data/defaultAssets.js`) on install
- Seed `asset_types` and `copy_fields` tables for new tenant
- Three-tier editability:
  - Tier 1 — Platform spec fields locked by default (character counts) with override warning
  - Tier 2 — Asset names and groupings editable freely
  - Tier 3 — Custom assets added by tenant are fully owned by them
- `is_active` flag — deactivate assets without deleting
- `spec_source` and `spec_version` columns on `copy_fields` for future LiveSpecs (Phase 7)
- Postgres is the single source of truth for asset specs — the Google Sheet has been fully retired (no fallback; Postgres is mandatory to build docs)
- Smoke test: new tenant install triggers asset seeding, 30 types present in Postgres

## Week 8 — Web app foundation (quillio.app/app)

Goal: A non-Slack user can run the full Quillio pipeline from a browser.

- Express serves React frontend (or plain HTML — decision for Claude Code)
- Brief input form:
  - Campaign name field
  - Brief text area
  - Reference links — Drive, PDF, URL, Canvas, Slides
  - Asset type selector — choose from tenant's active library
  - Drive folder field — where should the doc go
  - Submit button
- Pipeline integration — same `core/pipeline.js` as Slack adapter
- Progress state UI — visual feedback while pipeline runs
- Output view — structured doc sections displayed in browser
- Export to Drive button
- New adapter: `src/adapters/web.js` — calls `pipeline.js`, zero Slack code

## Week 9 — Web app doc editor

Goal: Writers can read, edit, and finalize copy directly in the browser.

- All asset sections and copy fields displayed and editable inline
- Live character count per field as writer types
- Field status indicators — empty, in progress, complete
- Save changes back to Google Doc in real time
- Generate First Draft button — triggers `pipeline.generateDraft()`
- Regenerate individual field — re-run Gemini for a single field only
- Submit for Review button — triggers approval workflow

## Week 10 — Web app project history

Goal: Writers can find and reopen any past Quillio project.

- Project list view per tenant — all campaigns, newest first
- Status per project — draft, in review, approved
- Click any project to reopen the doc editor
- Search and filter by campaign name or date
- Project data reads from `projects` table in Postgres

## Week 11 — Web app install + onboarding

Goal: quillio.app is the front door for new installs.

- Homepage — product positioning, Add to Slack button
- Add to Slack button triggers existing OAuth flow
- Post-install onboarding steps:
  - Connect Google (service account instructions + folder share step)
  - Voice guide — six-question flow, review before saving
  - Asset library — confirm default 30 types or customize
  - Emoji pack — download button for all Quillio custom emoji with upload instructions for Slack
- Success state — you're ready, here's how to use `/quillio`

## Week 12 — Web app settings panel (quillio.app/settings)

Goal: Tenants can configure and customize their Quillio instance.

- Asset Library tab:
  - List all active asset types
  - Edit name, fields, character counts
  - Add new custom asset type
  - Deactivate asset (hidden from `/quillio`, not deleted)
  - Warning when overriding Tier 1 platform spec fields
- Voice Guide tab:
  - View current voice.md
  - Edit inline
  - Regenerate via six-question flow
- Prompt Library tab:
  - View per-field Gemini prompts
  - Edit prompt per field
  - Reset to default
- Integrations tab:
  - Google — service account email, default Drive folder
  - Slack — workspace info, reinstall link
  - Figma — Phase 4 placeholder
- Team tab:
  - Add team members
  - Assign roles — reviewer, designer, copy channel, design channel
- Billing tab — placeholder for Phase 5

## Week 13 — Approval workflow

Goal: The full Submit → Review → Approve / Request Changes → Resubmit loop works
from both Slack and web app.

- Wire `action_id`s to handlers in `server.js` (`handlers/approval.js` already built)
- Populate `workflow_roles` in Postgres for DM routing
- Submit for Review — notifies assigned reviewer via Slack DM
- Approve — updates project status in Postgres, posts confirmation
- Request Changes — posts feedback, returns to writer
- Resubmit — notifies reviewer again
- Status synced between Slack and web app in real time

## Week 14 — Slack app config for public distribution

Goal: Quillio is installable by anyone from the Slack App Directory.

- Enable public distribution in Slack app settings
- Add OAuth redirect URL pointing to quillio.app
- Add privacy policy URL
- Add Terms of Service URL
- Add support URL
- Upload app icon (minimum 512x512)
- Add screenshots for App Directory listing
- Update slash command URL to quillio.app
- Update event subscriptions request URL to quillio.app
- Bot scopes confirmed: commands, chat:write, chat:write.public, channels:history, users:read, im:write
- User scopes confirmed: canvases:read, files:read

## Week 15 — End-to-end multi-tenant test

Goal: A brand new workspace installs Quillio and gets a fully working instance
with zero manual configuration.

- Install via quillio.app Add to Slack button
- Complete onboarding — voice guide, asset library, Drive folder
- Run `/quillio` with a real brief in new workspace
- Verify doc created in correct Drive folder
- Verify asset library correct for tenant
- Verify approval workflow routes correctly
- Verify web app shows project in history
- Verify all emoji fallbacks working
- Zero env var changes required for new tenant

## Asset library architecture

Database tables already in place:

- `asset_types` — name, group, is_active, sort_order, tenant_id
- `copy_fields` — field_name, char_min, char_max, field_type, sort_order, asset_type_id, spec_source, spec_version
- `prompt_templates` — prompt_text per field per tenant

Three-tier editability:

- Tier 1 — Platform spec fields, locked by default, override warning shown
- Tier 2 — Names and groupings, freely editable
- Tier 3 — Custom tenant-added assets, fully owned

Future LiveSpecs (Phase 7) — `spec_source` and `spec_version` columns track which
fields are system-managed for automatic platform spec updates.

## Parked — post Phase 3

- Google OAuth per tenant (revisit for enterprise)
- Emoji auto-upload during install (waiting on full GIF set; `emoji.add` is not
  available to bot tokens on standard workspaces — Enterprise Grid `admin.emoji.add` only)
- Google app verification for public OAuth
- quillio.app domain purchase and DNS configuration
- LiveSpecs real-time platform spec syncing (Phase 7)

## Environment variables

Developer-owned forever (never move to DB):

- `SLACK_SIGNING_SECRET`
- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GEMINI_API_KEY`
- `DATABASE_URL`

Tenant-owned (live in Postgres after Phase 3):

- `SLACK_BOT_TOKEN` → `tenant_tokens` service='slack_bot'
- `SLACK_USER_TOKEN` → `tenant_tokens` service='slack_user'
- `GOOGLE_REFRESH_TOKEN` → `tenant_tokens` service='google'
- `ASSET_SHEET_ID` → `asset_types` + `copy_fields` per tenant (Google Sheet fully retired; Postgres is the single source of truth)
- `DRIVE_FOLDER_ID` → `tenants.default_folder_id`

## APPROVAL WORKFLOW MODEL

Roles:

- Copywriter — creates the brief, generates and refines copy
- Creative Manager — primary approver, always first reviewer, fixed per workspace, can override stalled reviews
- Collaborators — optional per-project stakeholders (one or more; could be PMM, campaigns, events, or any non-creative sign-off role — never hardcoded to a specific title). Added at brief time, not in Settings.
- Designer — notified after approval, receives copy doc + Figma link
- Project Manager — notified at key workflow moments for visibility (optional role)

Approval chain:

1. Copywriter finishes copy → clicks "Submit for Review"
2. Creative Manager notified → reviews copy in Google Doc → three options:
   - "Request Changes" → back to copywriter with feedback
   - "Approve — needs collaborator sign-off" → routes to all Collaborators simultaneously
   - "Approve — send to design" → triggers Figma update + notifies Designer
3. Collaborator review stage (when collaborators are required):
   - All Collaborators notified simultaneously with doc link
   - Each Collaborator reviews by adding comments directly in the Google Doc
   - Each Collaborator then goes to Slack and clicks "Done Reviewing" or "Request Changes"
   - Quillio tracks which Collaborators have responded and which have not
   - Workflow stays in "pending collaborator review" state until ALL Collaborators have responded
   - If a Collaborator has not responded after 24 hours → automated follow-up nudge sent via Slack DM or email
   - Creative Manager can override and force-approve if a Collaborator is unavailable (safety valve to prevent projects getting permanently stuck)
4. Once all Collaborators have responded:
   - All approved → automatically routes to design, everyone notified (Copywriter, Creative Manager, Designer, Project Manager)
   - Any requested changes → Copywriter notified with all feedback consolidated, Creative Manager + Designer + Project Manager also notified for visibility
5. Designer receives notification: copy doc link + Figma link — "Copy approved. Design updated."

Notification tiers (user controls which tier they're on):

- Tier 1 (default) — status change only, no automation, user handles sharing manually
- Tier 2 (opt in) — email notification to approver with comment-enabled doc link
- Tier 3 (opt in, team only) — Slack DM to approver

Figma trigger:

- Creative Manager or final Collaborator approval triggers Figma copy population
- Designer is notified after, not before — they receive the result, not a request to act
- Designer gets: copy doc link + Figma file link

Doc sharing on submission:

- When submitted for review, Google Doc sharing is automatically set to "Anyone with link can comment"
- This ensures all reviewers can open and comment without permission issues

Settings fields needed:

- Creative Manager — Slack user ID or email, fixed per workspace
- Designer — Slack user ID or email, fixed per workspace
- Project Manager — Slack user ID or email, optional, fixed per workspace
- Default approver email — for web app / solo / freelance users (Tier 2 email flow)

Per-project at brief time:

- Optional collaborators field — add one or more people who need to sign off beyond the creative manager
- Designer override — if a different designer is on this project
- Project Manager override — if a different PM is on this project

Solo / freelancer approval flow:

- No Slack required
- Tier 1: update project status to "Submitted for Review" manually, share doc yourself
- Tier 2: set a default approver email in onboarding, submitting triggers automatic email with comment-enabled doc link
- Status tracking in Projects tab regardless of tier

## PHASE 4 — FIGMA INTEGRATION SPEC

Core concept:

When a brief is kicked off, Quillio creates three linked artifacts simultaneously:

1. Copy doc — Google Doc with all asset copy fields
2. Figma file — duplicated from master template, with correct frames for requested assets
3. Project record in Postgres — copy_doc_id + figma_file_key linked together

The Figma file and copy doc are connected from day one. Copy populates into Figma on approval.

Master Figma template:

- One master template file with all 30 asset types as frames
- Frame naming convention: asset type + dimensions e.g. LinkedIn_1200x628, Meta_1080x1080
- Text layer naming convention: [Headline], [Body], [CTA], [Intro], etc.
- On brief submission: duplicate template, activate only the frames for requested assets, archive the rest
- Figma file key saved to projects.figma_file_key in Postgres

Copy population on approval:

- Approved copy fields mapped to Figma text layers by field name
- Quillio Figma API writes copy into each text layer
- Character count compliance verified before writing
- Designer notified with both doc and Figma links after population

Figma handoff command (Phase 4):

- /quillio-handoff [figma-link] — manually trigger copy population into an existing Figma file
- Useful when Figma file already exists and was not created by Quillio

Database columns already ready:

- projects.figma_file_key
- projects.deck_id
- design_mappings table — tool, asset_type_id, frame_prefix, field_name, layer_name

Build order for Phase 4:

1. Quillio master Figma template — 30 frames, verified 2026 specs, correct layer naming
2. Figma OAuth integration — read/write access per tenant
3. Brief-time Figma file creation — duplicate template, activate correct frames
4. /quillio-handoff — copy population into existing Figma files
5. Approval-triggered population — automatic on Creative Manager or final Collaborator approval
6. Designer notification — copy doc link + Figma link after population
