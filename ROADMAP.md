# Quillio Product Roadmap

**Last updated:** June 10, 2026
**Author:** Kyle Brintnall
**Status:** Phase 2 complete — Phase 3 planning

---

## What Quillio Is

Quillio is a creative operations platform that eliminates manual setup time in the copy production workflow. It takes a freeform brief, parses it with AI, reads linked reference documents, generates a fully structured copy document, and — when copy is approved — populates the designer's Figma or Canva file automatically across every size variant.

**The full pipeline vision:**

```
Brief in
    ↓
Quillio parses brief + reads references
    ↓                        ↓
Copy doc generated      Figma/Canva file created
(Google Doc/Notion)     from brand template + design.md
    ↓                        ↓
Copy approved           Designer refines layouts
    ↓                        ↓
        Copy populates design file automatically
                    ↓
        Final review — copy + design together
                    ↓
        Export + zip — production-ready files
                    ↓
        /quillio-launch → ads go live in platform
```

**Core value proposition:** Brief to market in one connected pipeline. Nothing like this exists today.

**Target audience:** Copywriters — agency, in-house, freelance, and enterprise. Any creative team that produces copy for designed assets. Not exclusively B2B.

---

## Current State — June 2026

### V1 — Complete and demo-ready

Full Slack-native pipeline working end to end:

- `/quillio` slash command in Slack
- Gemini 2.5-flash parses freeform brief text
- Matches assets to a structured Asset & Field Library
- Generates a fully formatted Google Doc with all copy fields
- Single message lifecycle (chat.update architecture)
- Custom emoji set: scroll, doc-done, quill, copy-done
- Smart title generation, voice.md, concurrency caps
- Signature verification, graceful error handling
- Correct Quillio bot identity confirmed

### Phase 2 — Reference Ingestion — Complete ✅

When a brief links reference documents, Quillio reads them and feeds their content to a second Gemini pass that writes a richer Campaign Summary, Writer Direction, and Reference Insights section.

**All slices shipped:**

| Slice | Description | Commit |
|-------|-------------|--------|
| Slice 1 | Google Drive link ingestion | 91a23d0 |
| Slice 2 | External URL fetching | 0afe748 |
| Slice 3 | PDF ingestion via pdf-parse@1.1.1 | 772546d |
| Slice 4 | Slack Canvas via user token + files.info | confirmed |

**Supporting fixes shipped:**

| Fix | Description | Commit |
|-----|-------------|--------|
| Enrichment prompt tuning | Senior B2B copywriter persona, 8 extraction rules | 32aac99 |
| JSON coercion fix | toReadableText() for structured writerPrompt | 045c389 |
| Reference Insights section | Per-source stats, key messages, source labeling | d31b970 |
| Proof Points removed | Consolidated into Reference Insights | 24f38b8 |
| Doc compression + bullets | Compact headers, BULLET_DISC rendering | 1bcafa0 |
| sanitizeText() | Strips PDF control characters from referenceContext | d001008 |
| Drive truncation | Increased 3000 → 6000 chars | 02ba1c8 |
| PDF title extraction | Three-source fallback with cleanFilenameTitle() | ad4b253 |
| Gemini parse fix | referenceLinks extracts all URLs including Slack | 7b3f59c |
| Canvas type labeling | Per-source type stamped by fetcher, not Gemini | confirmed |

**Doc output structure (current):**

1. Campaign Summary — 3 sentences max, theme + audience + core message
2. Writer Direction — Audience / Pain Points (bullets) / Voice / Competitive Framing / Do Not Use
3. Reference Insights — per-source stats and key messages with source type labels
4. Reference Materials — extracted links
5. Asset sections — all copy fields with character counts

**Hard-won lessons from Canvas ingestion:**

1. `canvases.sections.lookup` only finds header-delimited sections — useless for paragraph-only canvases. No valid `section_type` enum exists for body text. Dead end.
2. Bot token cannot read user-owned canvases regardless of channel sharing. Not a permissions issue — a fundamental identity issue.
3. **The fix:** user token (`xoxp-`). Canvas calls ride the user's permissions, not the bot's. Same pattern as enterprise assistants.
4. **The right read path:** `files.info` on the canvas ID returns title + private download URL. Fetching that URL (authorized) returns full canvas content.
5. **Critical scope gotcha:** adding a scope does NOT upgrade an already-issued token. After adding `canvases:read` + `files:read` to User Token Scopes, you must reinstall the app AND paste the freshly-minted `xoxp-` token into `SLACK_USER_TOKEN` in Railway.

**Required env vars (current, single-tenant):**

```
SLACK_BOT_TOKEN          — bot token (xoxb-)
SLACK_USER_TOKEN         — user token (xoxp-) — required for canvas
SLACK_SIGNING_SECRET
GEMINI_API_KEY
GOOGLE_REFRESH_TOKEN
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
```

---

## Phase 3 — Platform Foundation

### OAuth + Multi-Tenant Architecture + Database

**Why this is the gate for everything else:**

Every integration beyond what exists today — Figma, Notion, OneDrive, multi-workspace Slack, Canva — requires per-customer credentials granted via OAuth. The current architecture uses hardcoded env vars (single-tenant). That works for a personal demo tool but cannot ship as a product.

The canvas debugging made this concrete: add a scope → reinstall → hand-paste a token into Railway. A real customer cannot do that. OAuth at install makes it one click.

Phase 3 is the foundation. Everything in Phase 4 and beyond is built on top of it.

### Database — Replace Google Sheets with Railway Postgres

**Why Postgres over Sheets:**
Sheets works for a single-tenant personal tool. It breaks as soon as a second person installs Quillio — everyone reads and writes the same Sheet. Postgres is already on Railway (one-click add), multi-tenant by design, and stays with the app through every phase.

**Core schema:**

```sql
-- One row per workspace install
tenants (
  id, workspace_id, workspace_name,
  plan, installed_at, updated_at
)

-- All OAuth tokens, per tenant, per service
tenant_tokens (
  tenant_id, service,        -- service: slack_bot | slack_user | google | figma | notion | onedrive
  access_token, refresh_token, expires_at, updated_at
)

-- Asset types — replaces Asset & Field Library Sheet
asset_types (
  id, tenant_id, name, description,
  is_active, sort_order
)

-- Copy fields per asset type — replaces field columns in Sheet
copy_fields (
  id, asset_type_id, field_name,
  char_min, char_max, field_type, sort_order
)

-- Prompts per field — replaces Prompt Library Sheet
prompt_templates (
  id, tenant_id, asset_type_id, field_name,
  prompt_text, updated_at
)

-- Personas — replaces Persona Bank Sheet
personas (
  id, tenant_id, name, role, industry,
  pain_points, voice_notes, is_active
)

-- Projects — the connective tissue for everything
projects (
  id, tenant_id, name, drive_folder_id,
  notion_page_id, slack_channel_id,
  figma_file_key, status, created_at, updated_at
)

-- Assets within a project
project_assets (
  id, project_id, asset_type_id,
  copy_doc_id, copy_doc_url,
  figma_frame_prefix, status,
  assigned_to, approved_at, version
)

-- Figma/Canva frame mappings
design_mappings (
  id, tenant_id, tool,           -- tool: figma | canva | adobe_express
  asset_type_id, frame_prefix,
  field_name, layer_name
)
```

**What moves from env vars to database:**

| Current env var | Replaced by |
|-----------------|-------------|
| `SLACK_BOT_TOKEN` | `tenant_tokens` row, service='slack_bot' |
| `SLACK_USER_TOKEN` | `tenant_tokens` row, service='slack_user' |
| `GOOGLE_REFRESH_TOKEN` | `tenant_tokens` row, service='google' |
| `SLACK_SIGNING_SECRET` | Stays as env var — app-level, not per-tenant |
| `GEMINI_API_KEY` | Stays as env var — developer-owned |
| `GOOGLE_CLIENT_ID/SECRET` | Stays as env var — developer-owned OAuth credentials |

### OAuth Flows

**Slack OAuth (install flow):**

- `/oauth/slack/callback` endpoint
- Exchanges code for bot token + user token in one install
- User token grants `canvases:read`, `files:read`, `channels:history`
- Stores both tokens in `tenant_tokens`
- "Add to Slack" button on Quillio website triggers this
- Eliminates: manual token pasting, reinstall-to-upgrade friction

**Google OAuth:**

- `/oauth/google/callback` endpoint
- Exchanges code for access + refresh tokens
- Replaces `GOOGLE_REFRESH_TOKEN` env var
- Retires service account for Sheet reads — same OAuth identity handles everything
- Eliminates: "share the Sheet/folder with the service account" requirement

**Figma OAuth:**

- `/oauth/figma/callback` endpoint
- Required before Figma read/write per tenant

**Notion, OneDrive, Canva:**

- Same pattern — OAuth callback, store in `tenant_tokens`

### Stupid-Simple Install Flow

The entire onboarding should be five clicks:

1. Go to quillio.app
2. Click **Add to Slack**
3. Authorize Slack OAuth — grants bot + user token, all scopes, in one step
4. Click **Connect Google** — grants Drive/Docs access
5. Choose: use default asset library or import your own

**Done.** `/quillio` works in your workspace. No JSON. No env vars. No service accounts. No Sheet sharing.

### Asset Library — Three Setup Tiers

**Tier 1 — Default template**
Install Quillio, get a pre-loaded set of standard asset types: LinkedIn ad, Meta ad, Display banner, Email, etc. with sensible default field definitions and prompts. Works immediately with zero configuration.

**Tier 2 — Import existing**
Upload an existing copy doc or Sheet. Quillio reads the structure, infers asset types and field names, seeds the tenant's database rows from it. Meets teams where they already are.

**Tier 3 — Web app configuration**
Full UI at quillio.app/settings to add/edit/remove asset types, customize field definitions, edit prompts, manage personas. Changes save to Postgres, take effect immediately.

### The Project Object

Everything in Phase 4 and beyond — folder routing, versioning, approval, status tracking, team assignment — needs a shared concept of a **Project**.

A Project is: a campaign name + a destination folder + a set of assets + a status + a team. When `/quillio` runs and confirms the folder, it creates or joins a Project. All docs, design files, and exports for that campaign live under it.

This is the concept that makes the web app worth using — the Project status board is the home screen.

### Folder Destination Routing

How Quillio knows where to put the doc — four sources in priority order:

1. **Explicit folder link in the brief** — always wins
2. **Channel context inference** — scan back N messages for a Drive folder URL posted by a PM or strategist; confirm before generating
3. **Confirmation step** — Quillio posts before generating:

   > *📁 Dropping this in: Campaign Assets > Q3 Always On > Copy*
   > *[Looks right] [Change folder] [Use my Drive]*

4. **Default fallback** — tenant's configured default folder; never dumps to root Drive

Channel history scan requires `channels:history` scope — same scope that unlocks channel brief inference. One scope addition, two features.

---

## Phase 4 — Design Handoff

### 4a — Copy → Design File Population

**The use case:** Copy is approved. Designer has the layout in Figma or Canva. One command populates every text layer across every size variant automatically.

**Slash command:** `/quillio-handoff [doc-link] [figma-link]`
Or triggered via "Send to Design" button on the copy-complete Slack message.

**Layer naming convention (the design system agreement):**

Text layers:

- `[Headline]` → headline field
- `[Body]` → body copy field
- `[CTA]` → CTA text field
- `[Subheadline]` → subheadline field
- `[Preheader]` → preheader (email)
- `[Subject]` → subject line (email)

Frame names (asset type + size):

- `LinkedIn_1200x627`
- `Meta_1080x1080`
- `Display_300x250`
- `Display_728x90`

This convention becomes part of the Quillio design system. Teams configure their own naming in the web app — the `design_mappings` table stores per-tenant conventions.

**Multi-size variant matching:**
The `design_mappings` table maps asset types to frame prefixes. Quillio finds every frame starting with `Display_` and applies display copy to all of them — one asset type, all sizes, one operation.

**Handoff flow:**

1. Parse approved copy doc — extract field values by asset type
2. Read design file — traverse frame tree, identify text layer node IDs
3. Build copy map: `{ nodeId: copyValue }` for every matched layer
4. Write copy to design file
5. Post confirmation to Slack: "Populated 6 frames across 3 asset types"

### 4b — Approval Workflow

Copy needs to be locked before Figma handoff runs. Options:

- "Mark as approved" button in the copy-complete Slack message
- Specific comment trigger in the Google Doc
- Web app approval UI with field-by-field sign-off

**Legal/compliance flagging:** If copy contains a percentage or specific metric, add a flag to the doc and a warning in Slack — "This claim requires source citation before legal review."

---

## Phase 5 — Parallel Design File Generation

### design.md alongside voice.md

voice.md defines the brand's copy rules. design.md defines the brand's visual system — color tokens, typography, component library, spacing rules, logo usage, approved imagery style.

When `/quillio` runs, **in parallel with the copy doc** it creates a design file with:

- Frames for every requested asset type at every standard size — from the asset size database
- Brand colors, fonts, and spacing applied from design.md
- Placeholder copy in the correct text layers
- File saved to the same project folder as the copy doc

The copy doc and design file are created simultaneously. When copy is approved, handoff populates the already-structured design file.

### Design Tool Support

Same adapter pattern — one core handoff interface, per-tool adapters:

```
core handoff interface
    ↓
┌─────────┬─────────┬──────────────┬──────────────┬─────────┐
│  Figma  │  Canva  │ Adobe Express│  Adobe CC    │ Penpot  │
│ adapter │ adapter │   adapter    │   adapter    │ adapter │
└─────────┴─────────┴──────────────┴──────────────┴─────────┘
```

**Figma** — power-user tool, Figma REST API, full read/write
**Canva** — broadest user base, already connected in Claude, template-based creation maps perfectly to asset size database
**Adobe Express** — Adobe's enterprise footprint, API available
**Adobe Creative Cloud** — InDesign for print/long-form, Photoshop/Illustrator for production
**Penpot** — open source, growing fast, self-hosted option for enterprise

Tenant connects whichever tools they use in web app settings. Quillio routes to the right adapter automatically.

---

## Phase 6 — Export and Packaging

**The use case:** Design is final, copy is locked. One command produces a production-ready asset package.

Quillio calls the design tool's export API for every frame, downloads files, zips them into a structured package organized by asset type and size, and posts to Slack or saves to the project folder.

**Export structure:**

```
Q3_Always_On_Export/
  LinkedIn/
    LinkedIn_1200x627.png
    LinkedIn_1200x627@2x.png
  Meta/
    Meta_1080x1080.png
    Meta_1080x1920.png
  Display/
    Display_300x250.png
    Display_728x90.png
    Display_160x600.png
    Display_320x50.png
  Email/
    Email_header.png
```

**Slash command:** `/quillio-export [figma-link]`
Or triggered via "Export Assets" button in Slack after approval.

---

## Phase 7 — Launch

**The use case:** Assets are exported and approved. One command pushes them live to ad platforms.

Quillio reads the approved copy doc, takes the exported creative files, and pushes them to the ad platform via API. Campaign structure, targeting, and budget are either pulled from the brief or confirmed via a Slack modal before launch.

**Platform APIs:**

- **Meta Marketing API** — campaigns, ad sets, ads, creative upload (first priority)
- **Google Ads API** — display and search campaign creation
- **LinkedIn Campaign Manager API** — sponsored content

**Slash command:** `/quillio-launch`

This turns Quillio from a production tool into a deployment tool. The gap between "assets ready" and "ads live" collapses to one command.

---

## Phase 8 — Integration Expansion

Building on Phase 3 OAuth, each follows the same fetch → sanitize → enrich pattern from Phase 2.

### Storage / Output Destinations

The output destination is pluggable — tenant configures in web app settings:

- ✅ Google Drive / Google Docs (current)
- ⬜ Notion — same API as reference reading
- ⬜ OneDrive / SharePoint — Microsoft Graph API
- ⬜ Download as DOCX — no integration required, always available as fallback

### Reference Source Integrations

- ✅ Google Drive (Phase 2)
- ✅ External URLs (Phase 2)
- ✅ PDFs (Phase 2)
- ✅ Slack Canvas (Phase 2)
- ⬜ Notion pages — public integration OAuth, well documented
- ⬜ Confluence — REST API, common in enterprise
- ⬜ OneDrive / SharePoint — Microsoft Graph API
- ⬜ Channel history brief inference — scan channel for brief content, generate without typing

---

## Standalone Web App

Once Phase 3 exists, the standalone app is another front door to the same core pipeline.

**Architecture:**

```
shared core (parse / enrich / build)
    ↓
┌─────────────────┬──────────────────┐
│  Slack adapter  │   Web adapter    │
│  (existing)     │   (new)          │
└─────────────────┴──────────────────┘
         ↓
  shared tenant token store (Postgres)
```

**Web app surfaces:**

- Brief input form (replaces slash command)
- Reference link management
- Doc preview before committing to Drive
- Integration connection panel
- Asset library configuration
- Project status board — all campaigns, asset status, approvals
- Copy approval workflow
- Figma frame mapper — connect a file, assign frames to asset types
- Analytics — briefs processed, time to approval, most-used assets

---

## Missing Features — Honest Audit

Features not yet in the roadmap that belong there:

**Copy versioning**
Track v1, v2, v3 per asset — linked in the Slack thread. Figma handoff always pulls from the approved version. Without this, someone can accidentally push draft copy to Figma.

**Team collaboration**
Brief reviewed by ACD before copy generates. Two copywriters split assets on the same campaign. Basic assignment: "Kyle owns email, Sarah owns paid social." Lives in the Project object.

**Brief templates**
Recurring campaign types — demand gen, event, product launch — have predictable structures. Pick a template, fill variables, submit. Quillio gets cleaner input, output is more consistent.

**Asset status tracking**
Status board per campaign: LinkedIn done, Meta in review, email in draft. Especially valuable for larger teams. Lives in the web app.

**Analytics**
Briefs processed, average time to approved copy, most-used asset types, which reference source types produce the best enrichment. Table stakes for enterprise procurement conversations.

**Notification routing**
Configurable per tenant — post to `#copy-ready` channel, or DM the requestor, or the channel where the brief was submitted.

---

## August 2026 Demo Target

**What to have ready when returning to work:**

| Item | Status |
|------|--------|
| V1 pipeline demo | ✅ Ready now |
| Phase 2 reference ingestion demo | ✅ Ready now |
| Canvas ingestion demo | ✅ Ready now |
| Phase 3 OAuth + database spec | ✅ Documented |
| Phase 4 Figma handoff spec | ✅ Documented |
| Phase 5-7 vision spec | ✅ Documented |
| Quillio website | ⬜ To build |
| Demo script | ⬜ To write |
| Positioning one-pager | ⬜ To write |

**The 30-second demo story:**

> "I built a creative operations platform that eliminates manual setup time in copy production. You drop a brief in Slack, it reads your reference docs — Drive files, PDFs, Slack canvases — and generates a fully structured copy doc in under 30 seconds. When copy is approved, one command populates the designer's Figma file across every size variant automatically. I built it to solve a problem our team has every single campaign."

**The extended story (skip-level version):**

> "The vision is brief to market in one pipeline. The brief comes in, Quillio generates the copy doc and the Figma file in parallel. Copy gets written and approved. One command populates the design. Another exports production-ready files. And when you're ready, one more command launches the ads directly into Meta, Google, and LinkedIn. Nothing like this exists as a connected pipeline. I've built the copy and reference ingestion layers. The design handoff and launch layers are specced and ready to build."

---

## Technical Reference

**Stack:** Node/Express, Railway, GitHub (kylebrintnall-ux/quillio), Gemini 2.5-flash

**Slack app:** ID `A0B8LQLMMKM`, workspace "Quillio Inc." (formerly LaunchPen demo)
**Channels:** `#copy-requests`, `#copy-ready`
**Slash command:** `/quillio`

**Required scopes:**

Bot token scopes:

- `chat:write`, `chat:write.public`, `commands`

User token scopes:

- `canvases:read`, `files:read`
- Future: `channels:history` (folder inference + channel brief)

**Key asset IDs:**

- Asset & Field Library Sheet: `1skbkkKlHMDUzeG8_bFpcSjrvweumivePuSOvr5qIfqk`
- Prompt Library Sheet: `1zviNQmy0lbY5voOu-yEpsRAASJevHFlKw4MfvvGy7TM`
- Persona Bank Sheet: `17yfGrvBBuqSSLA6vweubEJJMp3aJ0GJM2oYuqHuMhxE`
- Drive campaign folder: `1gdf5-R3J8IGY1I5pJJj2O-KFOju0UsqU`
- V2 Asset Sheet: `1sdYw1NQ27OYeCaVCHRN50xVVbQoTnDvn5cZXag34Aw4`
- Sample campaign brief doc: `1JQBT6pPFGN6OcZqU4r_DdCyhKojqRXSXdRd7Nopm8pE`

**Phase 3 stack additions:**

- Railway Postgres (one-click add in Railway dashboard)
- express-session + connect-pg-simple
- Raw fetch for OAuth token exchange (no abstraction library)

---

## Open Decisions

| Decision | Options | Recommendation |
|----------|---------|----------------|
| Phase 3 start date | Now vs August return | August — finish recovery first |
| Figma handoff trigger | Slack button vs slash command | Slack button on copy-complete message |
| Design tool priority | Figma vs Canva first | Canva — broader user base, already connected |
| Standalone app timing | Before vs after Figma handoff | After Phase 4 — same OAuth foundation |
| Brief template format | Doc upload vs web UI builder | Doc upload first, UI builder Phase 3 |
| Ad platform launch order | Meta vs Google vs LinkedIn first | Meta first — best API documentation |
