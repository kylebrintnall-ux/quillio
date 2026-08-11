# Quillio Product Roadmap

**Last updated:** June 15, 2026
**Author:** Kyle Brintnall
**Status:** Phase 2 complete — Phase 3 planning

> **Phase 3 execution plan:** the authoritative, week-by-week Phase 3 build plan
> lives in [`docs/PHASE3.md`](docs/PHASE3.md). The Phase 3 section below is the
> high-level overview; `docs/PHASE3.md` is the source of truth for the build.

-----

## What Quillio Is

Quillio is a creative operations platform that connects the entire creative production chain — from brief to live ads — automatically. It eliminates the manual handoffs that lose information, create version confusion, and slow every campaign down.

**Core value proposition:** Quillio doesn't write your copy. It makes sure you're set up to write it better than you ever have.

**What Quillio owns:** The copy document. A purpose-built copy production format with fields not paragraphs, character counts built in, approval states per field, and version history. Like Figma owns the design file, Quillio owns the copy file.

**The chain today (manual, broken):**

```
PM writes brief in Slack
    ↓ copywriter manually reads and interprets
Copywriter sets up copy doc from scratch
    ↓ copywriter manually pastes reference content
Copy written in doc
    ↓ copywriter pings manager in Slack
Manager reviews, leaves comments in doc
    ↓ copywriter pings designer in Slack
Designer manually copies fields into Figma
    ↓ designer manually exports each size
Files dumped in a shared Drive folder
    ↓ someone manually uploads to ad platform
Ads go live
```

**The chain with Quillio (automated):**

```
Brief submitted (Slack / Teams / web app)
    ↓ automated
Project folder created in Drive
Copy doc + deck skeleton generated in parallel
    ↓ automated notification to channel
Copy written — Quillio available for feedback
    ↓ writer-initiated
@Quillio in doc or /quillio-feedback for ACD review
    ↓ automated notification
Manager approves in Slack
    ↓ automated — copy populates Figma + deck
Designer refines and exports
    ↓ automated packaging
Assets exported and zipped
    ↓ automated
Ads launched to platform
```

**The stakeholder value:** The deck and project folder exist from day one. Stakeholders see the shape and scope of work immediately and watch it fill in as the team executes. No status meetings. No surprise scope gaps. No manual handoffs losing information.

**Target audience:** Copywriters, creative teams, product marketers, and campaign managers. Any team that produces copy for designed assets. Not exclusively B2B.

-----

## Current State — June 2026

### V1 — Complete and demo-ready ✅

- `/quillio` slash command in Slack
- Gemini 2.5-flash parses freeform brief text
- Matches assets to Asset & Field Library (30 asset types)
- Generates fully formatted Google Doc with all copy fields
- Single message lifecycle (chat.update architecture)
- Custom emoji set: scroll, doc-done, quill, copy-done
- Smart title generation, voice.md, concurrency caps
- Signature verification, graceful error handling
- Dynamic progress message tiered by asset count
- Folder routing from brief text
- Docs land in Quillio Campaigns folder

### Phase 2 — Reference Ingestion — Complete ✅

**All slices shipped:**

| Slice | Description | Commit |
|-------|-------------|--------|
| Slice 1 | Google Drive / Docs ingestion | 91a23d0 |
| Slice 2 | External URL fetching | 0afe748 |
| Slice 3 | PDF ingestion via pdf-parse@1.1.1 | 772546d |
| Slice 4 | Slack Canvas via user token + files.info | confirmed |
| Slice 5 | Google Slides ingestion + nested URL extraction + second-pass fetch | 86e0add |

**Supporting fixes shipped:**

| Fix | Commit |
|-----|--------|
| Enrichment prompt tuning — 8 extraction rules | 32aac99 |
| Reference Insights section | d31b970 |
| Doc compression + bullet formatting | 1bcafa0 |
| sanitizeText() — strips PDF control characters | d001008 |
| Drive truncation 3000 → 6000 chars | 02ba1c8 |
| Asset library v3 — 30 asset types | confirmed |
| Character count parsing — integers to Gemini + doc | ac8cfe6 |
| Dynamic progress message tiered by asset count | b67a35e |
| Asset matching — exact names, single source of truth | dface01 |
| Folder routing from brief text | 4af01c1 |
| Quillio Campaigns folder as canonical location | 084d647 |
| Slides deck — nested URL extraction + second-pass fetch | confirmed |

**Doc output structure (current):**

1. Campaign Summary — 3 sentences
2. Writer Direction — Audience / Pain Points / Voice / Competitive Framing / Do Not Use
3. Reference Insights — per-source stats and key messages with source type labels
4. Reference Materials — extracted links
5. Asset sections — all copy fields with character counts

**Canvas ingestion — hard-won lessons:**

1. `canvases.sections.lookup` only finds header-delimited sections — useless for paragraph-only canvases
2. Bot token cannot read user-owned canvases — fundamental identity issue
3. Fix: user token (`xoxp-`) — canvas calls ride user's permissions
4. Right read path: `files.info` → private download URL → full content
5. Critical: adding a scope does NOT upgrade existing token. Must reinstall AND paste new `xoxp-` token

**Asset library (Postgres):**

- 30 asset types: Paid Social, Display, Email, Events, Web, Direct Mail, Organic Social, Sales Enablement
- Source of truth: Postgres `asset_types` + `copy_fields`, per tenant (seeded from `src/data/defaultAssets.js`). The original Google Sheet (`1NVDCcjPO2ZG1Vmt40WTwTYmXTl27dBiwrinHHKK9tCU`) has been fully retired.
- Quillio Campaigns folder: `1u12O9tkm0lZI8BAIfWErXAo88NWIOM0U`

**Current env vars (single-tenant):**

```
SLACK_BOT_TOKEN          — bot token (xoxb-)
SLACK_USER_TOKEN         — user token (xoxp-) — canvas
SLACK_SIGNING_SECRET
SLACK_CLIENT_ID          — Phase 3 OAuth
SLACK_CLIENT_SECRET      — Phase 3 OAuth
GEMINI_API_KEY
GOOGLE_REFRESH_TOKEN
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
DRIVE_FOLDER_ID
DATABASE_URL             — Postgres (asset library — the sole spec source)
```

-----

## August 2026 Demo Plan

**What to have ready:**

| Item | Status |
|------|--------|
| V1 + Phase 2 pipeline demo | ✅ Ready |
| 30 asset types confirmed working | ✅ Ready |
| Canvas + Slides ingestion confirmed | ✅ Ready |
| Folder routing confirmed | ✅ Ready |
| Quillio website | ⬜ In design |
| Demo video — 90 seconds | ⬜ To record |
| Positioning one-pager | ⬜ To write |
| Demo script | ⬜ To write |
| Terms of service + privacy policy | ⬜ Required |

**Three conversations to have in August:**

1. **ACD:** "Would you actually use this? What's missing?"
2. **Designer:** "Can we agree on a Figma layer naming convention?"
3. **Skip-level:** "Is this worth pursuing internally at Salesforce?"

**The 30-second story:**

> "During recovery leave I built a creative operations platform that automates the copy production chain. Brief comes in via Slack, Quillio reads your reference docs — Drive files, PDFs, Slack canvases, strategy decks — and generates a structured copy doc in under 30 seconds. When copy is approved, one command populates the designer's Figma file automatically. Brief to live. One connected chain."

**The stakeholder version:**

> "The brief comes in, the copy doc and project folder are created in parallel. Stakeholders see the shape and scope of work immediately and watch it fill in as the team executes. No status meetings. No surprise scope gaps. No manual handoffs."

-----

## Phase 3 — Platform Foundation

> Authoritative week-by-week plan: [`docs/PHASE3.md`](docs/PHASE3.md).

### OAuth + Multi-Tenant + Database + Web App

**Why this is the gate for everything:**
Current architecture uses hardcoded env vars. Single tenant, single workspace. Phase 3 makes Quillio installable by anyone, anywhere, on any platform combination.

### 3a — Database (Railway Postgres)

Replace three Google Sheets with Postgres. One-click add in Railway dashboard.

**Core schema:**

```sql
tenants (
  id, workspace_id, workspace_name,
  plan, installed_at, onboarding_complete,
  default_folder_id, default_doc_platform,
  default_design_platform
)

tenant_tokens (
  tenant_id, service,
  -- slack_bot | slack_user | google | figma |
  -- notion | onedrive | canva | teams
  access_token, refresh_token, expires_at
)

asset_types (
  id, tenant_id, name, group,
  is_active, sort_order
)

copy_fields (
  id, asset_type_id, field_name,
  char_min, char_max, field_type, sort_order
)

prompt_templates (
  id, tenant_id, asset_type_id,
  field_name, prompt_text
)

personas (
  id, tenant_id, name, role,
  industry, pain_points, voice_notes
)

voice_guide (
  tenant_id, brand_personality,
  tone_guidance, words_to_use,
  words_to_avoid, audience_language,
  tone_reference, raw_markdown
)

projects (
  id, tenant_id, name,
  drive_folder_id, drive_folder_url,
  copy_doc_id, copy_doc_url,
  deck_id, deck_url,
  figma_file_key, notion_page_id,
  slack_channel_id, slack_thread_ts,
  status, version, created_at
)

project_assets (
  id, project_id, asset_type_id,
  copy_doc_id, figma_frame_prefix,
  status, assigned_to, approved_at, version
)

workflow_roles (
  tenant_id, role,
  -- reviewer | designer | copy_channel | design_channel
  slack_user_id, slack_channel_id
)

design_mappings (
  id, tenant_id, tool,
  asset_type_id, frame_prefix,
  field_name, layer_name
)

deck_templates (
  id, tenant_id, deck_type,
  slides_template_id, layout_map
)
```

**What moves from env vars to database:**

| Env var | Replaced by |
|---------|-------------|
| `SLACK_BOT_TOKEN` | tenant_tokens, service='slack_bot' |
| `SLACK_USER_TOKEN` | tenant_tokens, service='slack_user' |
| `GOOGLE_REFRESH_TOKEN` | tenant_tokens, service='google' |
| `ASSET_SHEET_ID` | asset_types + copy_fields per tenant (Sheet fully retired) |
| `DRIVE_FOLDER_ID` | tenants.default_folder_id |

**Developer-owned — stay as env vars forever:**

```
SLACK_SIGNING_SECRET, SLACK_CLIENT_ID/SECRET
GOOGLE_CLIENT_ID/SECRET
FIGMA_CLIENT_ID/SECRET
GEMINI_API_KEY
DATABASE_URL
```

### 3b — Architecture Refactor

```
/core
  pipeline.js — parse, enrich, generate (no platform code)

/adapters
  slack.js — existing, refactored to call pipeline
  web.js — new, Phase 3
  teams.js — Phase 6

/integrations
  google.js — Drive, Docs
  figma.js — Phase 4
  notion.js — Phase 5
  canva.js — Phase 5

/db
  tenants.js, tokens.js, assets.js, projects.js
```

**Feature flag during migration:**

```javascript
if (tenant exists in Postgres) {
  use tenant config from database
} else {
  fall back to env vars (tokens/folders only)
}
```

Demo never breaks during migration.

> **Migration complete.** The Google Sheet has been fully retired — asset specs
> now come exclusively from Postgres (`asset_types` + `copy_fields`), and
> `generateDoc` throws if a tenant has no library. There is no Sheet fallback;
> Postgres is mandatory. Tenant tokens/folders still fall back to env vars for
> the demo workspace.

### 3c — OAuth Flows

**Slack OAuth:**

- "Add to Slack" → quillio.app/oauth/slack/callback
- Returns bot + user token in one install
- User token grants canvases:read, files:read, channels:history
- Both stored in tenant_tokens

**Google OAuth:**

- "Connect Google" → quillio.app/oauth/google/callback
- Replaces GOOGLE_REFRESH_TOKEN env var
- Retires service account — same identity handles everything
- Token refresh handled automatically

**Figma OAuth:** Phase 4
**Notion, Canva, OneDrive:** Phase 5+
**Microsoft (Teams):** Phase 6

### 3d — Stupid-Simple Install — 4 Clicks

```
1. quillio.app → "Add to Slack"
2. Authorize Slack OAuth
3. "Connect Google"
4. Choose asset library
Done — /quillio works in your workspace
```

No JSON. No env vars. No service accounts. No Sheet sharing.

### 3e — Web App

**Two surfaces:**

**quillio.app — Homepage + install**

- Product story, feature overview
- "Add to Slack" button
- "Sign up for web" option
- Pricing

**quillio.app/app — Brief input + doc editor**

Mode A — Export to Drive:
Brief → Quillio generates doc → saves to Drive/Notion/OneDrive

Mode B — Native doc editor:
Brief → Quillio generates doc → opens inline in Quillio
Writer works in the app
When done: export to Drive, Notion, OneDrive, or download DOCX

The native editor is where @Quillio feedback and `/quillio-check` live most naturally — no switching between Slack and Google Docs.

**quillio.app/settings — Admin panel:**

- Asset Library — add/edit/remove asset types and fields
- Prompt Library — customize per-field prompts
- Personas — manage audience personas
- Voice Guide — edit or regenerate voice guide
- Integrations — connected services + connect new
- Team — members, roles, reviewer, designer assignments
- Billing — plan, usage, invoices
- Danger Zone — delete account + data export

### 3f — Voice Guide Onboarding Flow

Instead of uploading a flat file, onboarding walks through building it:

```
Step 1 — Brand personality
"How would you describe your brand voice in three words?"

Step 2 — Tone guidance
"What tone should copy always have?"
[confident / empathetic / direct / playful /
 authoritative — multi-select + custom]

Step 3 — Do Not Use
"Words or phrases your brand never uses?"
[tag input]

Step 4 — Words that work
"Words or phrases that feel distinctly on-brand?"
[tag input]

Step 5 — Audience language
"How does your audience describe their problems?"

Step 6 — Tone reference
"Name a publication, brand, or person whose tone
you admire."

Step 7 — Review + save
Full editable preview of generated voice guide
Always editable in settings after
Always exportable as markdown
```

### 3g — Project Folder Creation

When a brief comes in, Quillio creates the full project structure:

```
/Quillio Campaigns
  /Q3 Always On — Agentforce Service
    📄 Q3 Always On — Copy Doc
    📄 Q3 Always On — Promo Deck (skeleton)
    📁 Assets (empty, ready for exports)
```

Folder named after the campaign. Copy doc inside it. Deck skeleton inside it. Assets folder ready for exports.

After creation, Quillio posts in the Slack channel:

```
:quillio: Project folder created — Q3 Always On

📁 Campaign folder → [link]
📄 Copy doc → [link]
📄 Deck skeleton → [link]

Copy has begun.
```

**Configuration:**

- Set default parent folder once in web app settings, OR
- Include folder link in brief text (already built), OR
- `/quillio` creates subfolder inside the specified parent automatically

### 3h — Approval Workflow

```
Copywriter clicks "Submit for Review"
    ↓
Manager receives DM:
":quillio: Copy ready for your review
[campaign] — [assets]
[Review Copy]"  ← opens copy doc
    ↓
Manager reviews, leaves comments, returns to Slack
Taps [Approve] or [Request Changes]
    ↓
IF APPROVED:
→ Copywriter DM: ":doc-done: Copy approved"
→ Designer DM: "Copy approved — ready for handoff
  [View Doc] [Populate Figma]"
→ Copy auto-populates into deck
→ Project status → "copy_approved"

IF REQUEST CHANGES:
→ Copywriter DM: "Changes requested —
  [manager] left feedback in the doc
  [Open Doc] [Resubmit when ready]"
→ Version increments: v1 → v2 → v3
→ Loop repeats
```

### 3i — Slack App Configuration for Phase 3

Required changes in api.slack.com/apps:

- Enable public distribution
- Add OAuth redirect: `https://quillio.app/oauth/slack/callback`
- Add bot scopes: `channels:history`, `users:read`, `im:write`
- Configure event subscriptions URL
- Update slash command URL to quillio.app
- Add privacy policy, ToS, support URLs
- Upload app icon and screenshots

### 3j — Phase 3 Build Order

**Week 1:** Railway Postgres + schema
**Week 2:** Extract core pipeline — verify demo still works
**Week 3:** Tenant resolver + seed default tenant from env vars
**Week 4:** Slack OAuth — new workspaces can install
**Week 5:** Google OAuth — new tenants connect their own Google
**Week 6:** Web app install page + basic brief input form
**Week 7:** Voice guide onboarding flow
**Week 8:** Web app settings panel
**Week 9:** Project folder creation
**Week 10:** Approval workflow

### 3k — Sign Up and Onboarding

**Sign up:** Slack-first. Slack OAuth IS the account. No separate form.
Web-first option: "Continue with Google" for Teams users and freelancers.

**Onboarding steps (4 clicks):**

1. Slack workspace confirmed
2. Connect Google Drive
3. Asset library — default (30 types) or import Sheet
4. Team setup (optional) — add reviewer, add designer
   Done — /quillio works

-----

## Phase 4 — Design Handoff + Deck Generation

### 4a — Figma Reference Ingestion

When a brief links a Figma file, Quillio reads the frame names, layer names, and existing text content and feeds it into enrichment. Quillio understands what assets the designer is building and writes copy that fits them.

Reference Insights shows:

```
From: Q3 Always On Campaign (figma)
Frames: LinkedIn_1200x628 / Meta_1080x1080 / Display_300x250
Text layers: [Headline] / [Body] / [CTA]
Existing copy: "Resolve cases end-to-end" / "Get a Demo"
```

Requires: `FIGMA_ACCESS_TOKEN` env var (personal access token for single-tenant demo, Figma OAuth for Phase 3+)

### 4b — Figma Layer Naming Convention

**Text layers:**

```
[Headline] [Body] [CTA] [Subheadline] [Preheader]
[Subject-A] [Subject-B] [Design Zone]
```

**Frame naming:**

```
LinkedIn_1200x628    Meta_1080x1080      Display_300x250
Email-Nurture_       LP-Event_1440x900   LI-Carousel_1080x1080
```

Configured per-tenant in `design_mappings` table via web app frame mapper.

### 4c — Figma Master Template

One Quillio master Figma template file with all 30 asset types, all sizes, all text layers named correctly.

**All 30 frames with verified 2026 specs:**

PAID SOCIAL:

- LinkedIn_1200x628 — 1200×628px
- LinkedIn_1200x1200 — 1200×1200px
- LinkedIn-Carousel_1080x1080 — 1080×1080px
- Meta_1080x1080 — 1080×1080px
- Meta_1080x1350 — 1080×1350px
- Meta-Stories_1080x1920 — 1080×1920px
- Meta-Carousel_1080x1080 — 1080×1080px
- Twitter_1600x900 — 1600×900px

DISPLAY:

- Display_300x250 — 300×250px
- Display_728x90 — 728×90px
- Display_160x600 — 160×600px
- Display_320x50 — 320×50px
- Display_300x600 — 300×600px

EMAIL:

- Email-Nurture_600x800 — 600×800px
- Email-Event-Invite_600x800 — 600×800px
- Email-Event-Reminder_600x600 — 600×600px
- Email-Event-Followup_600x800 — 600×800px
- Email-Basho_600x400 — 600×400px

EVENTS:

- LP-Event_1440x900 — 1440×900px
- LP-Event_390x844 — 390×844px (mobile)
- Signage-General_2160x3840 — 2160×3840px
- Signage-Session_1920x1080 — 1920×1080px
- Signage-Directional_2160x1080 — 2160×1080px

WEB:

- LP-Campaign_1440x900 — 1440×900px
- LP-Campaign_390x844 — 390×844px (mobile)
- LP-Confirm_1440x900 — 1440×900px

DIRECT MAIL:

- DM-Box-Front_2400x1800 — 2400×1800px
- DM-Box-Back_2400x1800 — 2400×1800px
- DM-Letter_2550x3300 — 2550×3300px
- DM-Insert_2550x1650 — 2550×1650px

SALES ENABLEMENT:

- Sales-OnePager_2550x3300 — 2550×3300px
- Sales-BattleCard_2550x1650 — 2550×1650px

ORGANIC SOCIAL:

- Organic-LinkedIn_1200x628 — 1200×628px
- Organic-Instagram_1080x1080 — 1080×1080px
- Organic-Twitter_1600x900 — 1600×900px

**Template approach:** Quillio duplicates the master template and removes irrelevant frames per brief. Designer opens a perfectly scaffolded file with exactly the right frames already set up.

### 4d — Copy → Figma Population

`/quillio-handoff` — run in the original brief channel.

Flow:

1. Looks up Project by channel + thread_ts
2. Reads approved copy doc — extracts field values by asset type
3. Reads Figma file — traverses frames, finds text layers by naming convention
4. Builds copy map: `{ nodeId: copyValue }`
5. Writes to Figma
6. Posts in original thread (visible to all):

```
:doc-done: Copy populated in Figma — Q3 Always On
• LinkedIn_1200x628 — 3 fields
• Email-Nurture_ — 9 fields
• LP-Event_ — 12 fields
[Open Figma File]
```

**Multi-size:** frame prefix match applies copy to all sizes. `LinkedIn_*` frames all receive LinkedIn copy.

**Slash command visibility:** Slash command ack is ephemeral (visible to typist only). Completion message is `chat.postMessage` — visible to whole channel. Posts in original brief thread via `thread_ts`.

### 4e — Deck Generation (Living Artifact)

The deck exists from day one and fills itself in as the chain progresses.

**Stage 1 — Brief submitted (instant):**
Deck skeleton with placeholder zones per asset.
Copy zone: [Copy pending] / Design zone: [Design pending]

**Stage 2 — Copy approved:**
Copy zones auto-populate from approved doc.

**Stage 3 — Figma complete:**
Design zones auto-populate from Figma frames.
Deck routes for final promo approval.

**Deck types:**

- Promo Approval Deck — one slide per asset, copy + design
- Event Deck — Dreamforce/Connections overview
- Campaign Overview Deck — strategy + assets + timeline
- Brainstorm / Working Deck — territories + open questions

**Asset-aware layouts:**

| Asset type | Layout |
|------------|--------|
| Email, Landing Page, One-Pager | Copy left/top, design right/bottom |
| LinkedIn/Meta Single Image | Graphic dominant, copy as caption |
| Carousel | Grid — each card shows graphic + headline |
| Battle Card, Basho Email | Text only, two-column |
| Direct Mail | Split — front/back/flap |
| On-Site Signage | Large type treatment |

**Slash commands:**

```
/quillio-deck [brief] — standalone deck generation
/quillio-figma [brief] — designer generates Figma template
/quillio-export — exports frames, places in deck, packages files
```

**Stakeholder value:** The deck is the contract between requester and creative team. Scope misalignment surfaces day one. Status is self-serve — open the deck.

### 4f — Quillio Feedback (ACD on demand)

**Two modes — both writer-initiated, never passive:**

**Mode 1 — `/quillio-feedback` (full doc ACD pass)**
Writer submits when ready. Quillio reads entire doc, checks every field against:

- voice.md rules and Do Not Use list
- Brief Writer Direction (audience, tone, key messages)
- Asset character count specs
- Available proof points from Reference Insights

Posts inline comments in the Google Doc at three levels:

```
🚫 VIOLATION — must fix
"'Transform' is on the Do Not Use list."

⚠️ WARNING — should review
"This claim needs a stat. Available from brief:
40% handle time reduction."

💡 WORKING WELL — keep this
"Strong opening. VP skepticism angle lands well."
```

**Mode 2 — `/quillio-check` (focused question)**
Writer asks about one specific field or copy block.
Quillio gives a direct opinion with reasoning.
Slack reply only — fast and conversational.
Like asking a colleague for a quick read.

**Note:** Real-time as-you-write checking (Mode 3) deliberately excluded — interrupts flow, treats writer like they need supervision. Senior writers write freely, then check.

**@Quillio in Google Doc:**
Writer can @mention Quillio directly in a Google Doc comment:

Scenario 1 — with selected text:

> *Writer highlights headline, comments: "@Quillio is this on brief?"*
> Quillio reads the selected range, evaluates against all context, replies in that comment thread with specific feedback.

Scenario 2 — no selection:

> *Writer comments: "@Quillio review everything"*
> Quillio reads full doc, posts individual inline comments throughout.

Because Quillio has the full campaign context — brief, reference docs, Writer Direction, voice guide, proof points — feedback is specific to this campaign, not generic. The writer doesn't re-explain context. They just ask.

**Technical path:**
Google Docs API `comments.list` + Google Drive webhooks for @mention detection. Quillio responds via `comments.insert` on the same thread.

**Comment adapter — platform-agnostic:**

```
Quillio evaluates copy (identical regardless of platform)
    ↓
Comment formatter
    ↓
┌─────────────┬──────────────┬─────────────┐
│ Google Docs │    Notion    │  Word/Graph │
│  adapter    │   adapter    │   adapter   │
└─────────────┴──────────────┴─────────────┘
```

Any trigger (Slack/Teams/web) works with any doc platform. Combinations: Slack + Notion, Teams + Google Docs, web + OneDrive — all valid.

### 4g — Creative Intelligence Features

Features that make writers more capable, not more supervised:

**Brief Interrogator**
After parsing, Quillio surfaces questions the brief didn't answer:

> *"This brief doesn't specify a primary CTA goal — demo request or content download? That affects the headline angle significantly."*

**Territory Generator**
Before copy is written, generates 3 creative territory options — not copy, just angles:

```
Territory A — The Skeptic's Reframe
Lead with acknowledging the AI disappointment cycle.

Territory B — The Operator's Math
Lead with the business case. 40% handle time reduction.

Territory C — The Human Angle
Lead with agent burnout and what it costs teams.
```

Writer picks a territory or rejects all three. Creative decision stays with the writer.

**Voice Mirror**
After copy is written, flags violations — not corrections:

> *"'Seamlessly' appears in Offer Body 1 — on Do Not Use list."*
> *"Subject Line 1 is 72 chars — 12 over 60-char mobile optimal."*
> Writer fixes it. Quillio never rewrites for them.

**Proof Point Prompt**
When Quillio detects a vague claim, surfaces available stats:

> *"You wrote 'resolve cases faster.' Available stats: '40% handle time reduction' or '68% Tier-1 resolution.' Either would make this specific."*

**Brief-to-Copy Traceability**
Every copy field links to the specific brief element that informed it. Hover over the LinkedIn headline:

> *"This angle comes from: 'Agentforce resolves cases — they don't just deflect them' (Q3 Strategy Deck, Slide 4)"*

-----

## Phase 5 — Integration Expansion + Generative Deck

### Generative Deck

`/quillio-brainstorm [brief]`

```
→ Slide 1: Campaign brief summary
→ Slide 2: Audience + pain points
→ Slide 3-5: Creative territories with sample headlines
→ Slide 6: Reference/inspiration
→ Slide 7: Open questions for the team
```

Teams walk into the brainstorm with a starting point instead of a blank page.

### Output Destination Integrations

Pluggable output adapter — tenant configures in settings:

- ✅ Google Drive / Google Docs (current)
- ⬜ Notion page
- ⬜ OneDrive / Word doc
- ⬜ Download as DOCX (always available as fallback)

### Reference Source Integrations

- ✅ Google Drive (Phase 2)
- ✅ External URLs (Phase 2)
- ✅ PDFs (Phase 2)
- ✅ Slack Canvas (Phase 2)
- ✅ Google Slides (Phase 2)
- ⬜ Notion pages
- ⬜ Confluence
- ⬜ OneDrive / SharePoint
- ⬜ Channel history brief inference

### Design Tool Integrations

```
/core/handoff-interface.js
    ↓
┌─────────┬─────────┬──────────────┬──────────────┬─────────┐
│  Figma  │  Canva  │ Adobe Express│  Adobe CC    │ Penpot  │
└─────────┴─────────┴──────────────┴──────────────┴─────────┘
```

-----

## Phase 6 — Export, Launch, Platform Expansion

### Export and Packaging

`/quillio-export` — exports all Figma frames, zips by asset type:

```
Q3_Always_On_Export/
  LinkedIn/ — 1200x628.png, @2x
  Meta/ — 1080x1080.png, 1080x1920.png
  Display/ — 300x250.png, 728x90.png
  Email/ — header.png
```

### Ad Platform Launch

`/quillio-launch` — pushes approved assets live:

- Meta Marketing API (first priority)
- Google Ads API
- LinkedIn Campaign Manager API

Campaign structure, targeting, budget confirmed via Slack modal before launch.

### Platform Adapters

**Microsoft Teams:**

- Microsoft Bot Framework
- Adaptive Cards (Block Kit equivalent)
- Azure Bot registration
- Microsoft identity platform OAuth
- 320M daily active users

**Google Chat:**

- Lowest effort — Google OAuth already built
- New message format only
- Same Drive/Docs integration carries over

**Webex:** Phase 7 — healthcare, finance, government

**Platform adapter note:**
The doc feedback feature requires a comment adapter per doc platform. The Slack/Teams trigger layer and the doc comment layer are independent. Any trigger works with any doc platform. Tenant settings record which combinations are connected.

-----

## Standalone Web App

```
/core/pipeline.js (shared)
    ↓
┌─────────────────┬──────────────────┐
│  Slack adapter  │   Web adapter    │
└─────────────────┴──────────────────┘
         ↓
  shared Postgres database
```

**Web app vs Slack app:**

|                 | Slack | Web |
|-----------------|-------|-----|
| Brief input | `/quillio` | Text field + drag/drop refs |
| Doc preview | No | Yes — before saving |
| Native doc editor | No | Yes |
| Project dashboard | No | Yes |
| @Quillio feedback | Via Google Doc | Native in editor |
| Settings | quillio.app/settings | Built in |
| Best for | Speed, flow | Visibility, control |

-----

## Business Model

**Pricing:**

| Tier | Target | Price |
|------|--------|-------|
| Free | Individual copywriters | 10 briefs/month |
| Pro | Small teams, agencies | $29/month unlimited |
| Team | In-house creative teams | $99/month up to 10 seats |
| Enterprise | Large orgs | Custom, SSO, admin controls |

**Distribution:**

- Slack App Directory listing
- quillio.app — "Add to Slack" + web sign up
- Microsoft Teams App Store (Phase 6)

**Missing before any revenue:**

- Terms of service + privacy policy
- Stripe integration
- Usage tracking and plan limits
- Account deletion + data export (GDPR)
- Support infrastructure

-----

## Missing Features — Honest Audit

**Copy versioning** — v1/v2/v3 per asset linked in Slack thread
**Brief templates** — recurring campaign types as reusable starting points
**Analytics** — briefs processed, time to approval, most-used asset types
**Notification routing** — configurable per tenant
**Email notifications** — for users not in Slack
**Multi-workspace** — one account, multiple Slack workspaces
**Admin vs member roles** — settings access control
**Token encryption at rest** — tokens in Postgres cannot be plaintext
**Automated testing** — smoke/wiring suite + CI in place; grow pure-logic + integration coverage
**Job queue** — BullMQ for pipeline resilience under load
**Demo video** — 90-second screen recording, most important sales asset

### Location as a fact kind — out of scope, and the detector is why

`copy_fields.fact_kind = 'location'` exists and is wired to nothing.
`On-Site Signage — Session Title Card / Track / Room Label` and
`On-Site Signage — Directional / Location Label` carry it. Both were first tiered
`'datetime'` by `migrateAddReminderDateLine.js` and moved by
`migrateFixLocationFactKind.js`: all four flagged fields transcribe a supplied
fact rather than generating one, which was right, but a track label carries a ROOM
and the note `datetime` gates says "The brief does not state a date or time".

**THE DETECTOR IS THE BLOCKER, and the misses are the useful part.** Measured
against `briefFacts`:

| brief fragment | detected |
| --- | --- |
| `"at Moscone West"` | **NO** — the venue in this project's own test fixture |
| `"at the Hilton"` | **NO** |
| `"at the Moscone Center"` | yes (after a case fix — see below) |
| `"Venue: Moscone West"` | yes — labelled |
| `"in Room 210"` | yes |
| `"Join us on Zoom"` | yes |

It catches LABELLED venues, rooms and virtual venues, and misses **proper-noun
venues**, which is the common shape. That is a weakness on the ordinary case, not
on an edge one, and it is why location is not shippable behind a warning: a
warning that fires only when the writer already used the word "Venue:" is a
warning for the briefs that were fine.

**A bug fixed on the way past, and the wrong diagnosis is the instructive half.**
`"at the Moscone Center"` failed while `"at the Moscone center"` matched. I called
it greedy capture eating the venue noun; it was CASE. The pattern carries no `/i`
— `[A-Z]` is doing real work requiring a proper noun — so a lowercase-only
alternation never matched a venue as anyone writes one. Backtracking handles the
greed fine. The nouns are now case-flexible explicitly.

**Nothing else is needed to start**: `briefStatesLocation` is exported and works.
What is missing is a detector worth gating a warning on, and a measured location
invention — no On-Site Signage asset has ever appeared in an A/B, so the harm is
assumed rather than observed. Both are prerequisites, and the second is cheaper.

### Slack and web disagree about which advisories a user sees — and nobody chose that

Both surfaces build an advisory line when a brief is thin. They do not show the
same ones:

| Advisory | Slack | Web |
| --- | --- | --- |
| `notice` — per-asset ceiling clamp ("Built 3 of 5 …") | rendered, own context block (`services/slack.js:84`) | **not rendered at all** — no `data.notice` anywhere in `app.html` |
| `unmatchedNotice` — a named asset that did not map | rendered, own context block (`:93`) | rendered in three places (`out-`, `picker-`, `confirm-unmatched`) |

The clamp notice is built on the web path and thrown away. A web user whose brief
asked for five of an asset and got three is told nothing; the same brief through
Slack says so.

**This is drift, not a decision.** Nothing in the code or the comments argues for
the difference, and the honest options are to match Slack or to accept the gap on
purpose — right now it is neither, which is the state worth recording.

**It is coupled to the missing-datetime notice, and the coupling is the reason
this is written down now.** Measured at 390px with a real browser: two stacked
advisories are 149px and read fine; three are 213px of cream boxes sitting
directly above the primary CTA on a build that SUCCEEDED, and that reads as a wall
of warnings. Today the web can show at most one, so adding the datetime line takes
it to two — fine. Fixing this asymmetry as well takes it to three, which is the
point at which they should collapse into one "a few things to check" block with
bullets rather than three boxes.

So: fixing the asymmetry is cheap on its own and cheap alongside the datetime
line, but doing both without collapsing them is the thing not to do.

### Transcription fields — seven fields whose job is to CARRY a fact, in a pipeline with no concept of one

**Deliberately not folded into the Event Reminder date-field fix.** That fix
gives one asset somewhere to put the time. This is the structural finding
underneath it, and it is larger.

Every field in the asset library is drafted by one generative path:
`generateAssetDrafts` writes copy that did not exist, against a character band,
judged on craft. **Seven fields are not doing that job.** Their content already
exists somewhere, and the model's task is to FIND it and SET IT OUT —
transcription plus formatting, not generation:

| Asset | Field | Carries |
| --- | --- | --- |
| Event Invitation Email | `Date / Location Line` [0-80] | date, time, timezone, venue — **four facts in one field** |
| Event Reminder Email | `Date / Location Line` [0-80] | the same four (added Aug 2026) |
| Event Landing Page | `Stat 1/2/3` [0-60] + Labels | figures |
| On-Site Signage — Session Title Card | `Speaker Name(s)` [0-60] | named people |
| On-Site Signage — Session Title Card | `Speaker Title / Company` [0-80] | named people, named employers |
| On-Site Signage — Directional | `Location Label` [0-30] | a place |
| One-Pager | `Proof Point / Stat` [0-80] | a figure |
| Battle Card | `Proof Points` [0-200] | figures, usually a competitor's |

**The seed shows the mismatch in one detail: every one of them carries a
character band.** A band is a *creative* constraint — it tells a writer how much
room they have to invent. A transcription field does not want a band, it wants
the facts. `Date / Location Line` asking for four facts in ≤80 characters is the
clearest case: a formatting budget being read as a writing brief.

**Why this is the failure mode it is.** A generative field that invents is doing
its job badly. A transcription field that invents is doing a *different job* —
and nothing in the pipeline distinguishes them, so a field whose only correct
output is the truth gets drafted by a prompt optimised for persuasion. Every
craft.md specificity rule then applies to it, correctly, and produces a confident
false fact.

**The data path is not what is missing.** The raw brief reaches the drafter
verbatim — a stated date, time and venue are in the prompt today, verified by
building one. So a structured input surface (event metadata as data) is the
obvious repair and also the most expensive: the brief is free text on BOTH
surfaces, so it needs new input UI, a parse contract, or both.

**The open question, and it deserves its own report rather than a decision from
this note:** whether a transcription field should be drafted by the model at all.
Candidates — a per-field flag in the asset library (`is_transcription`); a
separate prompt path handed the facts and asked only to format; or leaving it
generative and gating on whether the brief supplied the facts. Very different
costs, and only the third is cheap.

### Stat provenance — make a reference figure checkable without retaining the source

A figure extracted from a linked reference now reaches the drafter and can reach
published copy. It is **reported, never verified**, and today the whole of its
provenance is the source's *name*: the raw reference content is capped at 6000
chars per source, used once for the enrich call, and never persisted, so by draft
time there is nothing left to check it against. No validator is possible even in
principle.

The obvious repair — retain the fetched content — is a **privacy and retention
decision**, not a schema one: it means holding a customer's linked material as
Quillio data. That is why it is not built.

**The cheaper half is the better answer, and it is this item.** At enrich time,
store each stat's *surrounding sentence* or its *offset* in the source — a few
hundred bytes per figure instead of 6000 per source. A human can then open the
source themselves and land on the sentence the number came from. The figure
becomes checkable; the source is never retained.

It is worth more than the expensive version on its own terms: a stored copy of
the source would let a machine compare strings, but the claim a figure makes is a
claim about a *document a person can open*, and a pointer into that document is
what settles it. The expensive version also ages — a retained blob and a live URL
disagree the moment the page changes, and the pointer at least fails visibly.

Scope: a column or JSONB on the project row, written where `enrichWithReferences`
already has both the extract and the source text in hand. Nothing else moves.

-----

## Website

**Brand system:**

- Star Crush — all display headlines, buttons, nav
- IBM Plex Sans — body copy and UI labels only
- Sky blue `#4DD9D9` — primary accent
- Warm gold `#C9A84C` — CTAs
- Pixel sky — ambient background, lazy cloud animation
- White/glass — all UI mockups and cards
- Pixel art GIFs — quill, scroll, folder as section illustrations

**Homepage sections:**

1. Hero — dark, "No more blank pages. No more bad briefs."
2. Slack UI — animated, white/glass Slack window
3. How It Works — 4 steps with animated Slack moments + GIFs
4. Integrations — animated Figma handoff + pixel art logo grid
5. Pricing — three white/glass cards
6. Bottom CTA

**Integration grid:**

- Live: Slack, Google Drive, Google Docs, Figma
- Coming soon: Canva, Notion, Microsoft Teams, OneDrive, Adobe Express, Google Chat

-----

## Technical Reference

**Stack:** Node/Express, Railway, GitHub (kylebrintnall-ux/quillio), Gemini 2.5-flash
**Slack app:** ID `A0B8LQLMMKM`, workspace "Quillio Inc."

**Key asset IDs:**

- Asset library: Postgres `asset_types` + `copy_fields` per tenant (the original Sheet `1NVDCcjPO2ZG1Vmt40WTwTYmXTl27dBiwrinHHKK9tCU` is fully retired)
- Quillio Campaigns folder: `1u12O9tkm0lZI8BAIfWErXAo88NWIOM0U`
- Sample campaign brief doc: `1JQBT6pPFGN6OcZqU4r_DdCyhKojqRXSXdRd7Nopm8pE`
- Sample strategy deck (PPTX): Agentforce-Q3-Strategy-Deck-Quillio-Test.pptx

**Phase 3 stack additions:**

- Railway Postgres
- express-session + connect-pg-simple
- Raw fetch for OAuth token exchange

-----

## Open Decisions

| Decision | Recommendation |
|----------|----------------|
| Phase 3 start | August return |
| Database | Railway Postgres |
| Web framework | Plain HTML + Express for install page |
| Figma handoff trigger | Button on copy-complete message |
| Design tool priority | Figma first, then Canva |
| Standalone app timing | After Phase 4 |
| Teams adapter | Phase 6 |
| Native Quillio doc | Explore in Phase 4 |
| Ad platform launch order | Meta first |
| quillio.app domain | Secure before August |
| Brief template format | Sheet import first, web UI later |
| @Quillio in doc | Phase 4 alongside feedback feature |
| Territory Generator | Phase 4 — buildable on existing Gemini pipeline |
| Voice guide onboarding | Phase 3 — part of web app onboarding flow |
