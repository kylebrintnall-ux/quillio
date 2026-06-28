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

### CORE MODEL: CUSTOM MASTER TEMPLATE

The foundation of Quillio's design integration is the tenant's own custom master
template — a Figma file the designer builds once and Quillio reuses for every
project.

Two modes:

- **Writing only (default)** — copy docs only, no Figma, no design setup
  required. Works for solo copywriters, freelancers, anyone who just needs the
  copy workflow.
- **Writing + Design (opt in, Pro tier)** — unlocks Figma template generation,
  brand kit setup, and copy population on approval.

### FIRST TIME SETUP — ONE TIME ONLY

1. Quillio generates a neutral master template Figma file with all 30 asset types
   as frames
   - Correct 2026 platform dimensions per asset type
   - Named text layers: `[Headline]`, `[Body]`, `[CTA]`, `[CTA Button]`,
     `[Logo]`, `[Background]`, etc.
   - Placeholder copy fills each text layer realistically ("Your headline goes
     here")
   - Neutral grey layout — no brand applied
   - Frame naming convention: asset type + dimensions e.g. `LinkedIn_1200x628`
   - First page is a "Read Me First" page with clear designer instructions
2. Designer opens the neutral template and designs it properly
   - Applies brand colors, fonts, logo, imagery zones
   - Builds real visual layouts — hierarchy, spacing, composition
   - Designs all 30 frames to production quality
   - Saves as their custom master template
3. User saves the custom master template file key in Quillio Settings → Design
   - This becomes the tenant's permanent starting point for every project
   - Stored as `figma_master_template_key` in the `tenants` table

### READ ME FIRST PAGE (first page in the neutral master template Figma file)

Clear instructions for the designer:

- What this file is and how Quillio uses it
- That they should design all 30 frames to production quality before connecting
  it to Quillio
- That text layers named `[Headline]`, `[Body]`, `[CTA]`, etc. are the live copy
  zones — do not rename or delete them
- That `[Logo]`, `[Background]`, and `[Image]` layers are also live — Quillio will
  place assets there
- That once they save this file as their master template and add the file key to
  Quillio Settings → Design, every future project will duplicate from this file
- That they only need to do this once — all future projects pull from this
  template automatically
- A checklist:
  1. Design all 30 frames — apply your brand colors, fonts, logo, imagery zones
  2. Do not rename or delete any text layers named with `[brackets]`
  3. Copy this file's key from the Figma URL
  4. Paste it into Quillio → Settings → Design → Master Template
  5. Every future project will duplicate from this file automatically

### BRAND KIT SETUP (optional, enhances template generation)

User uploads brand materials directly in app — no Drive folder required upfront:

- Drag and drop or file picker: screenshots, brand guidelines PDF, logo files
  (SVG/PNG), reference imagery
- Quillio creates `/Quillio Brand Kit/` folder in Drive automatically and uploads
  all assets there
- Gemini vision extracts: primary colors, secondary colors, accent, CTA color,
  typography style, visual style description, button style, spacing feel
- Quillio prompts for anything it couldn't extract: "I found your primary color
  and logo. What's your CTA button color?"
- Generates `design.md` per tenant — stored in Postgres alongside `voice.md`
- Logo file IDs stored in Postgres for placement in Figma frames

`design.md` contains:

- Brand name
- Primary, secondary, accent, CTA, background colors (hex)
- Headline font, body font
- Visual style description
- Button style and border radius
- Image direction
- Logo Drive file IDs (light and dark versions)

### EVERY PROJECT AFTER SETUP

When a brief runs with design mode enabled:

1. Copy doc created as normal
2. Quillio duplicates the tenant's custom master template (not the neutral one)
3. Activates only the frames needed for this brief — archives the rest
4. Approved copy populates into named text layers on approval
5. Logo placed in `[Logo]` layers from Drive brand kit folder
6. Designer notified: "Copy approved. Figma file ready." with both doc and Figma
   links

What Quillio automates:

- Creating the project Figma file from the custom master template
- Activating only the right frames for this brief
- Populating approved copy into text layers on approval
- Placing logo from brand kit
- Notifying the designer when ready

What the designer still owns:

- The master template design — built once, reused forever
- Per-project imagery and visual refinement
- Final design decisions and creative judgment

### NEUTRAL MASTER TEMPLATE — FRAME AND TEXT LAYER SPEC

Paid social and display frames:

- Text layers: `[Headline]` and `[CTA Button]` only
- Headline in large display type, realistically sized for the format
- CTA as a styled button component
- Image zone marked as `[Background]`
- `[Logo]` placement in corner
- Placeholder: "Your headline goes here" / "Learn More"

Email frames (600px wide):

- Realistic email structure: header, hero, body, CTA, footer
- Text layers: `[Subject Line]`, `[Preheader]`, `[Headline]`, `[Body]`,
  `[CTA Text]`, `[Footer]`
- Placeholder copy fills each zone naturally

Landing page frames (1440px wide):

- Hero zone, section zones, form zone, footer
- Text layers per zone: `[Hero Headline]`, `[Hero Subhead]`, `[Hero CTA]`,
  `[Section Headline]`, `[Section Body]`, `[Form Headline]`, `[Form CTA]`

On-site signage (1920x1080):

- Large display headline, minimal copy
- Text layers: `[Headline]`, `[Body]`, `[Session Details]` where relevant

Direct mail:

- Realistic mailer structure
- Text layers: `[Outer Headline]`, `[Inner Headline]`, `[Body]`, `[Offer]`,
  `[CTA]`

One-pager and battle card:

- Document-style layout
- Text layers per section matching the copy doc fields

### ONBOARDING — DESIGN SETUP STEP

Add a design setup step to the onboarding flow after the voice guide step and
before Connect Slack:

Step title: "Set up your design template (optional)"

Content:

- Explain that Quillio can generate a branded Figma file for every project
- Two options:
  - "Generate my template" — creates the neutral master template, saves the file
    key to the tenant, shows a link to open it in Figma with the instruction to
    design it before their first project
  - "Skip for now" — can be completed later in Settings → Design
- Clear message shown after generating: "Design your template once. Quillio uses
  it for every project after that."
- After generating, show the Read Me First checklist directly in the onboarding
  step so the designer knows exactly what to do next

### TIERING

- **Free/Basic:** writing only, copy docs
- **Pro:** writing + design kit + Figma template generation + copy population
- **Team:** everything + approval workflow + designer notifications + collaborator
  management

### PHASE 4 BUILD ORDER

1. Rebuild neutral master template in Figma — all 30 frames, realistic layouts,
   correct text layer naming, Read Me First page
2. Save master template file key in Quillio (`quillio_master_template_key` in
   `tenants` table)
3. Figma OAuth integration — read/write access per tenant
4. Brand kit onboarding step — file upload, Gemini extraction, `design.md`
   generation
5. Settings → Design tab — master template file key input, brand kit management
6. Onboarding design setup step — generate neutral template, show checklist
7. Brief-time Figma file creation — duplicate custom master template, activate
   correct frames
8. Copy population on approval — write approved copy into named text layers
9. Logo placement — pull from brand kit Drive folder
10. Designer notification — doc link + Figma link after population
11. /quillio-handoff — manually trigger copy population into an existing Figma file

## PHASE 3 ADDITIONS

### File attachment as reference input

Web app:

- `+` button next to brief input opens file picker
- Supported: PDF, DOCX, JPG, PNG
- PDF — extract text via pdf-parse (already in pipeline)
- DOCX — extract text via mammoth
- Images — pass to Gemini vision as base64; extract text if present; describe visual tone, aesthetic, color, style for mood boards
- All file content treated identically to reference links once ingested
- Appears in Reference Insights section of the doc with source type: upload

Slack:

- Detect file attachments in `/quillio` message or thread
- Download via `files.info` + authorized fetch (same pattern as canvas ingestion)
- Same ingestion pipeline as web app

Gemini vision for images:

- Gemini 2.5 Flash accepts image inputs natively
- For text-heavy images: extract text
- For mood boards / visual references: describe color palette, visual tone, style, emotional direction — feeds into writer direction as creative context
