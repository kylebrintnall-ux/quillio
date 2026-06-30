# Quillio — Full Product Vision Summary
*For roadmap logging — compiled from product strategy session, June 2026*

---

## What Quillio Actually Is

Quillio is not a copy generation tool. It is a creative production operating system — a persistent sync layer that owns the full chain from brief intake to final approved asset, living natively in Slack. The document output, whether Google Docs today or Word, Notion, or Confluence tomorrow, is the delivery mechanism. The pipeline is the product.

---

## Core Differentiation From Gemini and Google Workspace AI

Google's Gemini integration in Docs, Sheets, and Drive has become a legitimate competitive surface. "Help me create" can now pull from Drive and Gmail to generate formatted first drafts. "Match the format" can take a template and refill it from sourced content. This is uncomfortably close to the surface-level description of what Quillio does.

However, the differentiation is structural and durable for several reasons:

**Slack as the insertion point.** Gemini requires you to go to Google. You open a Doc, open a side panel, type a prompt. The assumption is work starts in a document. For creative teams, work starts in Slack — a brief drops in a channel, a PM pings, a Creative Manager assigns a campaign. Quillio lives at the actual origin of creative work, not downstream of it.

**The approval and routing chain.** Gemini generates a draft and produces a document. Quillio routes it, assigns it, tracks it, threads it back to the conversation where the request originated, notifies the right people at the right stages, and gates progress behind human approval. That is a fundamentally different product category even when the output document looks similar on the surface.

**Owning both artifacts.** Quillio writes the copy doc AND generates the Figma file. No other tool in the market has that dual ownership. This is the foundation of every advanced feature described below. It is not replicable by Gemini, a Figma plugin, or a Google Docs add-on acting independently.

**Access model as ethical design.** Quillio restricts access to copywriters and creative managers, not general marketing managers or PMMs. This is not a limitation — it is the product's explicit stance on human agency in creative work. As Google makes it easier for anyone to generate copy, Quillio's restriction becomes more valuable, not less. It prevents non-writers from bypassing the creative team while giving copywriters a genuinely powerful production tool.

---

## Platform Agnosticism

Google Docs is the first integration, not the product's identity. The pipeline — brief intake in Slack, structured parsing, AI generation with creative direction, formatted document, approval workflow, designer handoff — is document-platform-agnostic. The document destination at the end of the chain is interchangeable.

Expansion path after Google Docs by priority:
- **Microsoft 365 / Word + SharePoint** — largest enterprise install base globally, dominant in finance, healthcare, government, professional services
- **Confluence (Atlassian)** — standard in engineering and product orgs, nearly universal where Jira is used
- **Notion** — strong in creative and startup environments
- **Quip** — Salesforce-owned, active inside Salesforce customers and internally, natural native integration story
- **Coda** — growing in ops-heavy marketing teams
- **ClickUp Docs** — marketing teams consolidating from project management into documents

The Slack intake layer and approval chain remain identical regardless of document destination. This makes Quillio the connective tissue above whatever document platform a team uses, not a Google-specific tool. For Salesforce specifically, which almost certainly has mixed document infrastructure across teams, this is a significantly easier internal sell.

---

## The Figma Integration Architecture

### design.md — What It Is and What It Isn't

design.md is a one-time onboarding mechanism. It performs a specific job at setup and then steps back. It is not a recurring input, not a per-project configuration, and not something the copywriter thinks about during daily work. Once it has done its job, the master template carries everything forward.

Its job is to capture brand DNA at onboarding and use that to generate or configure a master Figma template file. After that, it sits quietly as a reference document unless the brand refreshes or the team wants to regenerate the master template from scratch.

### How design.md Populates — Two Paths

**Generative path (small business, solo operator, new brand):**
The user provides brand inputs — website URL, product screenshots, existing campaign assets, brand guide PDFs, graphic elements. design.md extracts visual language from those: color palette, typography, spatial density, whether the brand is dense or airy, visual tone. This context informs both how copy is written and how the master Figma template is structured. Quillio infers the brand because the brand doesn't yet exist in a documented, portable form.

**Ingestive path (enterprise, established brand):**
An organization like Salesforce already has authoritative brand documentation — a Figma design system, brand guidelines PDFs, tone of voice documents, a messaging framework, approved campaign assets. Quillio should not try to regenerate what already exists. Instead it ingests those documents and maps them into design.md format. The output is the same structured reference file — the input method is different. Enterprise onboarding is ingestive, not generative. design.md in this context is less a generation artifact and more a structured record of what was ingested and how it maps to Quillio's architecture.

The same logic applies to voice.md. A small business might need Quillio to extract brand voice from whatever copy examples they provide. An enterprise uploads their existing tone of voice documentation and messaging framework. Quillio structures it into voice.md format. The brand already did this work. Quillio adopts it.

### Master Template Generation — The One Generative Event

design.md informs the generation of one master Figma file containing all 30 asset type templates. This happens once at setup. It is a single generative event, not something that repeats per project or per campaign.

For the generative path, Quillio produces brand-aware templates as a starting point. For the ingestive enterprise path, Quillio maps the existing design system onto its 30 asset type taxonomy, connecting existing layers and structures to Quillio's naming conventions.

In both cases, the next step is human refinement. The designer opens the master file and finishes it — adjusting colors, typography, spacing, visual direction. They are not building from scratch. They are finishing something that is already structurally correct and directionally on-brand. When the designer and Creative Manager sign off, that master file becomes the approved creative system for the team.

Every brief, every campaign, every project from that point forward generates its Figma output by drawing from those approved master templates. design.md's active job is done. The master file is the source of truth indefinitely.

This makes design.md essentially a design system generator for teams that need one, and a design system connector for teams that already have one. One setup event, indefinite leverage.

### Enterprise Master Template Considerations

For large organizations the master template may need to operate at team level rather than org level. At Salesforce there is the global Salesforce brand, then Agentforce as a sub-brand, then Agentforce Service as a more specific context. One team's master template is distinct from another team's even within the same Slack workspace. This maps cleanly to the existing tenant architecture — the org installs the app once, individual teams configure their own brand context within their tenant.

### Text Layer Naming Convention as Integration Spec

The load-bearing piece of the Figma integration is consistent, predictable text layer naming conventions across all templates: headline, subhead, body, CTA, legal, and so on. As long as those layer names follow the established taxonomy, designers have complete freedom everywhere else. They can bring their own visual direction, add motion, change the entire aesthetic. None of it touches the text layer structure. Quillio always knows where to write regardless of what surrounds those layers.

This creates a clean separation of concerns that mirrors real role structure:
- Quillio owns content architecture
- Designer owns visual execution
- Neither steps on the other

For enterprise teams with existing Figma design systems, the layer mapping step is where design.md does its critical work — identifying existing text layers and mapping them to Quillio's taxonomy. This step requires designer review to confirm or correct the mapping. That review step needs to be as lightweight as possible to avoid becoming an adoption blocker. Large design systems with inconsistent historical layer naming are the known friction point here.

Teams without existing systems simply adopt the naming conventions Quillio establishes at master template generation. Designers working in those templates from day one name layers correctly as a matter of workflow.

### Filename Parsing

Quillio can interpret Figma filenames to identify asset type and copy constraints without requiring manual input. Standard ad unit dimensions are a finite, known set — 300x600 is always a half-page banner, 728x90 is always a leaderboard, 300x250 is always a medium rectangle. When dimensions appear in a filename Quillio already knows the asset type, applicable copy constraints, character limits, and expected text layer count.

The variation space is trainable because patterns are consistent even when formatting is not:
- Dimension formatting: 300x600, 300X600, 300-by-600, 300_600px, 300x600px_v2
- Campaign name formatting: state-of-marketing, state_of_marketing, StateOfMarketing, SOM
- Version suffixes: _FINAL, _v3, _R2, _approved

This is the same fuzzy matching and intent extraction logic already built into the brief parser, applied to a filename string instead of a paragraph. The logic is already proven — it is an extension of existing architecture, not a new capability to build from scratch.

### One-Click Approval Trigger

When a Creative Manager approves copy in the approval workflow, that single action triggers Quillio to reconcile the copy doc and the Figma file. This is not general file interpretation — Quillio created both artifacts and already holds full metadata for both. It knows the asset types, layer names, copy doc structure, character limits, and campaign context. The reconciliation is execution on context Quillio already has, not discovery.

The approval action was already in the workflow. Quillio simply does more with that signal. No new step for the Creative Manager, no new behavior to learn.

---

## Bidirectional Copy-Design Sync — The Killer Feature

### The Problem It Solves

Every current tool assumes copy flows one direction — writer to designer, done. Reality is messier. Designers routinely edit copy inside Figma for layout reasons. A headline breaks a text layer at a certain length so they trim it inline. That change is now invisible to the copywriter, inconsistent with the approved doc, and undetectable by anyone without manually auditing both artifacts. This is a chronic, universal pain point in creative production that currently has no systematic solution.

### How It Works

Quillio watches both the copy doc and the Figma file continuously after creation. When either artifact changes it surfaces the delta to the appropriate person in Slack with a one-click sync action available.

**Copy doc changes → designer notification:**
A Slack message to the designer identifying which assets are affected and offering one-click sync to Figma. The designer never needs to open the copy doc or find the right layer manually.

**Figma copy changes → copywriter notification:**
A Slack message to the copywriter identifying what was changed in Figma versus the approved doc. The Creative Manager is also notified since approved copy being edited after sign-off is a brand integrity and compliance issue in larger organizations. One-click sync available to reconcile in either direction.

Neither the designer nor the copywriter needs to open the other's artifact at any point. The inconsistency surfaces in Slack. The resolution happens in Slack. One click.

### Why This Is Structurally Unique

No other tool can do this because no other tool owns both artifacts. Quillio wrote the copy doc. Quillio generated the Figma file. It knows authoritatively at all times whether they are in sync — not by parsing or guessing but because it created both from the same source of truth.

This also creates a passive audit trail for post-approval copy changes without requiring any formal process to be built around it. The audit happens as a natural byproduct of Quillio watching what it created. Leadership and Creative Managers gain visibility into production integrity without any new process to enforce.

### The Broader Implication

Most tools are generation tools — they perform an action and exit. Quillio becomes a persistent operational layer for the entire life of a campaign. This is subscription-worthy product behavior. It reframes the value from "tool that writes copy" to "system that keeps creative production coherent from brief to final asset."

---

## Onboarding and Setup Architecture

### Two Surfaces, Two Jobs

The Slack app is the operational surface. Daily work — brief intake, copy generation, approvals, notifications, sync actions — all happens in Slack. Nobody configures Quillio in Slack.

The Quillio web app is the setup surface. All configuration — roles, brand context, voice.md, design.md, master template review — happens in the web app, done once by the Creative Manager at setup. Nobody does daily work in the web app.

This separation keeps the Slack experience clean and the setup process thorough without the two surfaces competing with each other.

### The Setup Flow End to End

**Step 1 — Slack App Install**
IT or workspace admin approves and installs the Slack app. One-time, minimal ongoing involvement. IT does not configure Quillio — they gate access to the workspace.

**Step 2 — Creative Manager Completes Team Setup in Web App**
- Assigns roles — identifies who are copywriters, Creative Managers, and designers within this tenant
- Uploads existing brand voice documentation — tone of voice doc, messaging framework, approved copy examples — which Quillio structures into voice.md
- Uploads brand guidelines and connects or uploads existing Figma design system — which Quillio ingests into design.md and maps to text layer taxonomy
- Reviews and confirms layer mapping with designer input
- Sets approval workflow preferences — routing rules, notification preferences, escalation behavior

**Step 3 — Designer Finalizes Master Template in Figma**
Designer opens the generated or mapped master Figma file and applies final visual direction. For teams on the generative path this is finishing a brand-aware draft. For teams on the ingestive enterprise path this is confirming that existing templates are correctly wired to Quillio's naming conventions.

**Step 4 — Creative Manager Signs Off**
Master template is approved. Setup is complete. This is the moment the system becomes live.

**Step 5 — All Future Work Runs Through Slack**
Every brief, every campaign, every project draws from the approved master templates and configured brand context. Setup is not revisited unless the brand refreshes or the team wants to reconfigure.

### Enterprise-Specific Considerations

For large organizations the onboarding philosophy shifts from generative to ingestive throughout. The brand already exists. Voice already exists. Design systems already exist. Quillio's job at onboarding is to structure and connect what exists, not to create from scratch.

Tenant-level configuration within a shared Slack workspace is the appropriate model for large orgs. The global organization installs the app once. Individual teams — each potentially representing a different sub-brand, product line, or regional variant — configure their own tenant with their own voice.md, design.md, and master template. At Salesforce this might mean the Agentforce Service PMM team has a distinct tenant configuration from the Commerce Cloud team even though they share the same Slack workspace.

The known friction point in enterprise onboarding is the text layer mapping step for teams with large, legacy Figma design systems where layer naming has been inconsistent over time. This step requires designer review and should be designed to be as lightweight as possible — surfacing suggested mappings for the designer to confirm or correct rather than requiring them to build the mapping from scratch.

---

## The Closed Loop

Quillio initiates from a brief in Slack. It structures the brief, generates copy with creative direction informed by asset type and brand context from voice.md, produces a formatted copy doc, draws from the approved master template to generate a Figma file with correctly named text layers and known dimensions, routes the work through a Creative Manager approval chain, notifies the designer, and then monitors both artifacts indefinitely for drift — surfacing any inconsistency and resolving it with one click in Slack.

The copywriter never leaves Slack for the core workflow. The designer never manually hunts for updated copy. The Creative Manager never loses visibility into whether approved copy has been changed. The whole chain is owned, watched, and maintained by a single system built on a master template that was configured once and leveraged indefinitely.

---

## Competitive Positioning Summary

| Capability | Gemini + Drive | Figma Plugin | Quillio |
|---|---|---|---|
| Brief intake in Slack | ✗ | ✗ | ✓ |
| Asset-type-aware copy generation | ✗ | ✗ | ✓ |
| Approval workflow routing | ✗ | ✗ | ✓ |
| Figma file generation from master template | ✗ | Partial | ✓ |
| Text layer sync | ✗ | ✗ | ✓ |
| Bidirectional drift detection | ✗ | ✗ | ✓ |
| Platform agnostic doc output | ✗ | ✗ | ✓ (roadmap) |
| Access restricted to creative roles | ✗ | ✗ | ✓ |
| Enterprise brand ingestion at onboarding | ✗ | ✗ | ✓ |
| Tenant-level brand configuration | ✗ | ✗ | ✓ |

---

## Roadmap Implications

**Phase 4 (Figma integration):** Neutral template rebuild, text layer naming conventions, design.md architecture, both generative and ingestive onboarding paths, filename parsing logic, master template generation and designer refinement flow. Foundation for everything above.

**Phase 5 (Campaign Mode):** Multi-asset coherence, sequential asset awareness. Natural home for the one-click approval trigger and initial copy-to-Figma sync logic.

**Phase 6 (Bidirectional Sync):** Continuous drift detection between copy doc and Figma file, role-appropriate Slack notifications, one-click resolution. The feature that locks in long-term retention and differentiates Quillio permanently from generation-only tools.

**Enterprise Onboarding (parallel track within Phase 4):** Ingestive path for existing Figma design systems, voice.md population from uploaded brand documentation, tenant-level configuration within shared Slack workspaces, designer-reviewed layer mapping interface.

**Platform Expansion (parallel track post-Phase 4):** Microsoft 365 connector, then Confluence, then Notion, then Quip. Slack intake and approval chain unchanged — swap only the document destination.
