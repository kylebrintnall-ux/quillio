# Quillio Roadmap

*Last updated: June 2026*

-----

## ✅ V1 — SHIPPED

- `/quillio` Slack slash command → Gemini parses brief → formatted Google Doc → Slack notification
- Generate First Draft with `:quillio:` magic quill emoji
- Dynamic folder detection from Drive link in brief
- Reference links extracted and included in doc
- Title Case doc titles
- Response posts to originating channel
- Semantic asset matching — full variation library (LI, basho, DEM, etc.)
- Modular destination architecture (Google Docs adapter)
- 8-bit magic quill animated emoji

**Pending V1 cleanup:**

- Sheet row reorder (Offer Body / CTA pairing) — 2 min manual fix
- Re-enable Slack signature verification on both endpoints
- Upload `:quillio-scroll:` and `:quillio-victory:` emojis + wire into Claude Code

-----

## 🔜 Phase 2 — Smart Context Ingestion

The core insight: writers shouldn't have to summarize the brief. Quillio should read everything the PM posted.

- **Channel history reading** — `/quillio` with no text reads the last 10 messages in the channel. Scopes needed: `channels:history`, `groups:history`, `im:history`
- **Slack Canvas ingestion** — extracts and reads full Canvas content from any linked Canvas URL. Scope needed: `canvases:read`
- **Nested link following** — reads links within a Canvas (Drive docs, external URLs, PDFs)
- **PDF text extraction** — `pdf-parse` npm package, truncates at 3,000 words for Gemini context
- **External URL fetching** — strips HTML, extracts plain text, truncates at 2,000 words
- **Second Gemini synthesis pass** — enriches `summary` and `writerPrompt` using all gathered context. Assets list from first parse stays unchanged

**The use case this unlocks:** PM posts full campaign brief with links in `#agentforce-q3`. Writer types `/quillio` in that channel. Quillio reads everything and builds the doc. Zero retyping.

-----

## 🔜 Phase 3 — Review Loop & Collaboration

- Manager notification when doc is ready (@mention or DM)
- Designer notification when copy is approved
- Reference attachments passed through to design handoff
- Comment/feedback loop in Slack thread tied to the doc

-----

## 🔜 Phase 4 — Surgical Updates

- `/quillio update [doc-link] headline: Your new headline here` — swaps a single field without rebuilding the entire doc
- Selective asset regeneration — regenerate one field, not the whole draft
- Version history tracking per doc

-----

## 🔜 Phase 5 — Design Sync

The killer enterprise feature.

- Approved copy pushes to named Figma and/or Canva text layers
- Human approval gate before any design push
- Copy and design stay in sync — no handoff errors, no stale assets
- Two-act flow: write → approve → push

-----

## 🔜 Phase 6 — Web App + Multi-Tenant + LiveSpecs

### Web App

- Full onboarding wizard
- Connect Google Drive via OAuth
- Pick target folders per project
- Manage asset libraries in UI
- Notion and OneDrive destination adapters
- Stripe billing, proper multi-tenant architecture per workspace

### Asset Library — Customer Configuration

Three ways to set up your asset library:

**Option A — Default template** (fastest, 60 seconds)
Pick a template that matches your team's work. Pre-populated with platform-verified specs.

**Option B — Build in UI**
Clean table interface — Asset Type, Channel, Fields, Character Limits, Tone Notes. Add rows, edit inline, drag to reorder.

**Option C — Import**

- Paste a spec doc or brief template → Gemini reads it and auto-generates the library
- Share a Google Sheet URL → Quillio reads the schema and imports
- 10-minute onboarding, not a 10-day IT project

### Default Template Library

Templates based on actual platform specs, not arbitrary numbers:

| Template | Asset Types Included |
| --- | --- |
| B2B Demand Gen | LinkedIn, Dynamic Email, Display Banner, Sales Basho, Form Confirm |
| B2C E-commerce | Meta, Instagram Stories, Promo Email, SMS, Google Shopping |
| Content Marketing | Blog, Organic Social, Newsletter, YouTube |
| Event Marketing | Event landing page, Invite email, Social countdown, Post-event follow-up |
| Product Launch | Press release, Launch email, Paid social set, App store copy |
| Agency (Custom) | Blank canvas — build from scratch |

-----

## 🔜 Phase 7 — Quillio LiveSpecs

**The differentiator no other tool has.**

Platform ad specs change. Meta updates limits. LinkedIn retires formats. Google tweaks character counts. Most teams are working from stale spreadsheets. Quillio LiveSpecs means every template is always current — automatically.

### How it works

1. Spec monitoring service polls official platform spec pages on a schedule
1. Compares against stored values, flags changes
1. Quick human review before publishing (prevents bad data propagating)
1. Confirmed updates push to all affected templates instantly
1. Teams get Slack notification when specs affecting their assets change

### Notification example

> *"📋 Quillio spec update: Meta Primary Text limit changed from 125 → 90 characters. Your Meta templates have been updated. 3 docs in recent campaigns may be affected."*

### Current verified specs (June 2026)

**LinkedIn — Single Image Ad**

| Field | Hard Limit | Recommended |
| --- | --- | --- |
| Introductory Text | 600 | 150 |
| Headline | 200 | 70 |
| Description | 100 | 70 |
| Carousel Headline | 45 | 45 |
| Message Ad Subject | 60 | 60 |
| Message Ad Body | 500 | 200 |

**Meta — Facebook & Instagram Feed**

| Field | Hard Limit | Visible Before Truncation |
| --- | --- | --- |
| Primary Text | 2,200 | 125 |
| Headline | 40 | 27–40 |
| Description | 30 | 30 |

**Twitter / X — Promoted Ads**

| Field | Limit |
| --- | --- |
| Post Copy | 280 (links use 23 chars) |
| Effective copy limit with link | 257 |
| Website Card Headline | 70 |

**Google — Responsive Display Ads**

| Field | Limit |
| --- | --- |
| Short Headline (up to 5) | 30 each |
| Long Headline (1) | 90 |
| Description (up to 5) | 90 each |
| Business Name | 25 |

**Google — Responsive Search Ads**

| Field | Limit |
| --- | --- |
| Headline (up to 15) | 30 each |
| Description (up to 4) | 90 each |
| Display Path (2 fields) | 15 each |

### Why this is a moat

Once teams rely on Quillio as their spec source of truth, switching cost is high. Their entire workflow is built around your character limits. And you're the only tool keeping them current automatically.

-----

## ⭐ Guiding Principle — Setup Must Become Frictionless

*The single most important product insight from building V1.*

Everything that made V1 hard to stand up — service-account sharing, env vars, folder permissions, Railway config, Slack scopes, OAuth tokens — is invisible plumbing that **no real user should ever touch.** V1 required deep technical back-and-forth to configure. That's acceptable for the builder; it's fatal for adoption.

For anyone else to use and set up Quillio easily, onboarding has to collapse to roughly:

1. **Connect your Google account** (one-click OAuth — no service account emails, no manual folder sharing)
1. **Connect Slack** (one-click "Add to Slack")
1. **Pick or import your asset library** (default template, UI builder, or paste-a-doc import)
1. **Pick your folders** (visual picker, not pasted IDs)
1. **Done** — fire `/quillio`

No copying service-account emails. No env vars. No editing config files. No Railway. If setup takes more than ~5 minutes or requires reading documentation, it's too much friction for a marketing team to adopt.

This principle governs every Phase 6+ decision. The technical complexity that exists today must be *absorbed by the product*, not exposed to the user. The recoverable folder-access flow (guiding a user to share rather than failing) is a small first step in this direction; the OAuth-per-folder web app is the real solution.

**Test for any setup step:** "Would a non-technical senior copywriter do this without help?" If no, automate it away.

-----

## Product Vision

**Right now:** A Slack bot that turns briefs into docs.

**Phase 2–4:** The intelligent creative ops layer for a marketing team.

**Phase 5–6:** The infrastructure that keeps copy and design in sync across every channel.

**Phase 7:** The living source of truth for platform specs across the entire marketing industry.

-----

*Built during surgery recovery on an iPad. Shipped June 8, 2026.*
