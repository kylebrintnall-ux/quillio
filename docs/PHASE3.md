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

- Read master asset library from Asset & Field Library v3 Sheet on install
- Seed `asset_types` and `copy_fields` tables for new tenant
- Three-tier editability:
  - Tier 1 — Platform spec fields locked by default (character counts) with override warning
  - Tier 2 — Asset names and groupings editable freely
  - Tier 3 — Custom assets added by tenant are fully owned by them
- `is_active` flag — deactivate assets without deleting
- `spec_source` and `spec_version` columns on `copy_fields` for future LiveSpecs (Phase 7)
- Demo falls back to Sheet as before via feature flag
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
- `ASSET_SHEET_ID` → `asset_types` table per tenant
- `DRIVE_FOLDER_ID` → `tenants.default_folder_id`
