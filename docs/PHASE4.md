# PHASE 4 — FIGMA INTEGRATION SPEC

## CORE MODEL: CUSTOM MASTER TEMPLATE

The foundation of Quillio's design integration is the tenant's own custom master
template — a Figma file the designer builds once and Quillio reuses for every
project.

Two modes:

- **Writing only (default)** — copy docs only, no Figma, no design setup
  required. Works for solo copywriters, freelancers, anyone who just needs the
  copy workflow.
- **Writing + Design (opt in, Pro tier)** — unlocks Figma template generation,
  brand kit setup, and copy population on approval.

## FIRST TIME SETUP — ONE TIME ONLY

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

## READ ME FIRST PAGE (first page in the neutral master template Figma file)

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

## design.md — BRAND DNA AT ONBOARDING

`design.md` is a **one-time onboarding mechanism**. It captures brand DNA at
setup, informs generation or configuration of the master template, then steps
back. It is not a recurring input, not a per-project configuration, and not
something the copywriter touches during daily work. Once the master template is
approved, the template carries everything forward — `design.md` sits quietly as a
reference unless the brand refreshes or the team regenerates the master template
from scratch.

### Two paths to populate design.md

**Generative path (small business, solo operator, new brand):**

- User uploads brand inputs directly in app — no Drive folder required upfront:
  website URL, product screenshots, existing campaign assets, brand guidelines
  PDF, logo files (SVG/PNG), reference imagery.
- Quillio creates a `/Quillio Brand Kit/` folder in Drive automatically and
  uploads all assets there.
- Gemini vision extracts visual language: primary/secondary/accent/CTA colors,
  typography style, spatial density (dense vs airy), button style, spacing feel,
  visual tone.
- Quillio prompts for anything it couldn't extract: "I found your primary color
  and logo. What's your CTA button color?"
- Quillio infers the brand because the brand doesn't yet exist in a documented,
  portable form.

**Ingestive path (enterprise, established brand system):**

- The organization already has authoritative brand documentation — a Figma design
  system, brand guideline PDFs, tone-of-voice docs, a messaging framework,
  approved campaign assets.
- Quillio does **not** regenerate what already exists. It ingests those documents
  and maps them into `design.md` format.
- The output is the same structured reference file — only the input method
  differs. Enterprise onboarding is **ingestive, not generative**. Here
  `design.md` is less a generation artifact and more a structured record of what
  was ingested and how it maps to Quillio's architecture.

The same logic applies to `voice.md`: a small business has Quillio extract brand
voice from whatever copy examples they provide; an enterprise uploads existing
tone-of-voice documentation and messaging framework, and Quillio structures it
into `voice.md`. The brand already did the work — Quillio adopts it.

`design.md` contains:

- Brand name
- Primary, secondary, accent, CTA, background colors (hex)
- Headline font, body font
- Visual style description (including spatial density: dense vs airy)
- Button style and border radius
- Image direction
- Logo Drive file IDs (light and dark versions)
- For the ingestive path: the mapping of existing design-system layers to
  Quillio's text layer taxonomy

`design.md` is stored in Postgres per tenant alongside `voice.md`; logo file IDs
are stored for placement in Figma frames.

### Master template generation — the one generative event

`design.md` informs the generation of **one** master Figma file with all 30 asset
type templates. This happens **once at setup** — a single generative event, not
something that repeats per project or per campaign.

- **Generative path:** Quillio produces brand-aware templates as a starting point.
- **Ingestive path:** Quillio maps the existing design system onto its 30 asset
  type taxonomy, connecting existing layers and structures to Quillio's naming
  conventions.

In both cases the next step is **human refinement**. The designer opens the
master file and finishes it — adjusting colors, typography, spacing, visual
direction. They are not building from scratch; they are finishing something
already structurally correct and directionally on-brand. When the designer and
Creative Manager sign off, that master file becomes the approved creative system
for the team. Every project from that point draws from those approved templates.
`design.md`'s active job is done; the master file is the source of truth
indefinitely.

This makes `design.md` a **design system generator** for teams that need one and
a **design system connector** for teams that already have one. One setup event,
indefinite leverage.

### Tenant-level brand configuration

For large organizations the master template may operate at **team level** rather
than org level. At Salesforce there is the global Salesforce brand, then
Agentforce as a sub-brand, then Agentforce Service as a more specific context.
One team's master template is distinct from another's even within the same Slack
workspace. This maps cleanly to the existing tenant architecture — the org
installs the app once, and individual teams configure their own brand context
(`voice.md`, `design.md`, master template) within their tenant. The Agentforce
Service team can have a distinct tenant configuration from the Commerce Cloud
team while sharing one Slack workspace.

## EVERY PROJECT AFTER SETUP

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

## NEUTRAL MASTER TEMPLATE — FRAME AND TEXT LAYER SPEC

Paid social and display frames:

- On-graphic text layers — the **Graphic Copy** group: `[Graphic Headline]`,
  `[Subhead]`, and `[CTA Button]` (organic social has `[Graphic Headline]` +
  `[Subhead]`, no CTA). In the copy doc these render together under an indented
  "Graphic Copy" sub-heading and carry `group_label = 'Graphic Copy'` in
  `copy_fields`; the layer names must match the field names exactly so the Phase 4
  population step maps the group as a unit.
- `[Graphic Headline]` is the headline baked onto the creative; the platform's
  clickable `[Headline]` (LinkedIn/Meta post headline) is a separate top-level
  field, not part of the graphic.
- `[Subhead]` is the secondary supporting line beneath the graphic headline (paid
  social 40–90 chars; display 20–40) — supports the headline, never repeats it.
- Static display banners are entirely on-graphic (one merged `[Graphic Headline]`,
  no separate platform headline); responsive display (DV360) keeps its assembled
  fields — Short/Long Headline, Description, Business Name — top-level.
- Headline in large display type; CTA as a styled button component
- Image zone marked as `[Background]`; `[Logo]` placement in corner
- Placeholder: "Your headline goes here" / "A supporting line that adds context" /
  "Learn More"

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

## TEXT LAYER NAMING CONVENTION — THE INTEGRATION SPEC

The load-bearing piece of the Figma integration is consistent, predictable text
layer naming across all templates: `[Headline]`, `[Subhead]`, `[Body]`, `[CTA]`,
`[Legal]`, and so on. As long as those layer names follow the established
taxonomy, designers have **complete freedom everywhere else** — they can bring
their own visual direction, add motion, change the entire aesthetic. None of it
touches the text layer structure. Quillio always knows where to write regardless
of what surrounds those layers.

This is a clean separation of concerns that mirrors real role structure:

- Quillio owns content architecture
- Designer owns visual execution
- Neither steps on the other

For enterprise teams with existing Figma design systems, the **layer mapping**
step is where `design.md` does its critical work — identifying existing text
layers and mapping them to Quillio's taxonomy. This step **requires designer
review** to confirm or correct the mapping, and must be as lightweight as
possible to avoid becoming an adoption blocker: surface suggested mappings for the
designer to confirm or correct rather than requiring them to build the mapping
from scratch. Large design systems with inconsistent historical layer naming are
the known friction point.

Teams without existing systems simply adopt the naming conventions Quillio
establishes at master template generation — designers working in those templates
from day one name layers correctly as a matter of workflow.

## FILENAME PARSING

Quillio can interpret Figma filenames to identify asset type and copy constraints
without manual input. Standard ad unit dimensions are a finite, known set —
`300x600` is always a half-page banner, `728x90` is always a leaderboard,
`300x250` is always a medium rectangle. When dimensions appear in a filename
Quillio already knows the asset type, applicable copy constraints, character
limits, and expected text layer count.

The variation space is trainable because patterns are consistent even when
formatting is not:

- Dimension formatting: `300x600`, `300X600`, `300-by-600`, `300_600px`,
  `300x600px_v2`
- Campaign name formatting: `state-of-marketing`, `state_of_marketing`,
  `StateOfMarketing`, `SOM`
- Version suffixes: `_FINAL`, `_v3`, `_R2`, `_approved`

This is the same fuzzy matching and intent extraction already built into the
brief parser, applied to a filename string instead of a paragraph — an extension
of existing architecture, not a new capability to build from scratch.

## ONBOARDING — DESIGN SETUP STEP

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

## TIERING

- **Free/Basic:** writing only, copy docs
- **Pro:** writing + design kit + Figma template generation + copy population
- **Team:** everything + approval workflow + designer notifications + collaborator
  management

## PHASE 4 BUILD ORDER

1. Rebuild neutral master template in Figma — all 30 frames, realistic layouts,
   correct text layer naming, Read Me First page
2. Save master template file key in Quillio (`figma_master_template_key` in
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

### Parallel track within Phase 4 — Enterprise onboarding (ingestive path)

Runs alongside the build order above for teams that already have a brand system:

1. Ingest existing Figma design systems and map layers to Quillio's text layer
   taxonomy
2. Populate `voice.md` from uploaded brand documentation — tone-of-voice docs,
   messaging framework, approved copy examples
3. Tenant-level configuration within shared Slack workspaces — distinct brand
   context (`voice.md`, `design.md`, master template) per team
4. Designer-reviewed layer mapping interface — surface suggested mappings for
   confirmation rather than manual construction

## COMPETITIVE POSITIONING

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

## DYNAMIC TIME-BASED THEMES

The sky gradient background shifts based on time of day, making the app feel
alive. Four themes using the existing pixel art aesthetic:

- **Dawn (5am–9am)** — soft pink and orange gradient sky, pixel sun rising,
  morning clouds
- **Day (9am–5pm)** — current sky blue gradient (`#4DD9D9` → teal), white pixel
  clouds (default)
- **Dusk (5pm–8pm)** — amber and purple gradient, pixel sun setting, longer cloud
  shadows
- **Night (8pm–5am)** — deep navy to black gradient, pixel moon, pixel stars,
  darker clouds

Implementation:

- CSS custom properties (`--sky-top`, `--sky-bottom`, `--cloud-opacity` etc)
  swapped per theme
- JS checks current time on load and applies a theme class to the body
- Theme assets: pixel moon GIF, pixel stars, pixel sun for dawn/dusk
- Settings toggle: Auto (follows device time, default) or Manual (user picks
  theme)
- Manual preference saved to Postgres per user
