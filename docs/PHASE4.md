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

## BRAND KIT SETUP (optional, enhances template generation)

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
