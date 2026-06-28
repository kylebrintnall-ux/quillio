# PHASE 5 — CAMPAIGN MODE

## OVERVIEW

Campaign Mode is the strategic layer above individual projects. Where a project
is one brief producing one set of assets, a campaign is a strategic umbrella
containing multiple projects that all ladder up to a single overarching message
or goal.

The home screen gains a mode toggle: Project (single brief, fast, current
default) and Campaign (strategic, multi-asset, sequential). Campaign Mode shifts
the UI to feel more tactical and command-center-like — darker, more structured,
while keeping the pixel art aesthetic.

## WHAT A CAMPAIGN IS

- A strategic umbrella with a single overarching message or goal
- Multiple projects underneath it — each with their own assets, docs, and copy
- A shared `campaign.md` defining the campaign voice, tone, messaging
  architecture, key proof points, and audience — a subset of `voice.md` but
  specific to this initiative
- A campaigns folder in Drive containing all project subfolders
- A unified timeline — assets roll out sequentially or in parallel depending on
  campaign type
- A campaign record in Postgres linking all child projects

## CAMPAIGN.MD CONTAINS

- Campaign name and strategic objective
- Core message and single overarching idea
- Target audience for this campaign specifically
- Key proof points and supporting messages
- Tone modifiers — how this campaign's voice differs from the brand baseline
- Asset sequence — what launches when
- Dependencies — e.g. email 2 assumes email 1 has been sent

## CAMPAIGN INPUT FLOW

User opens Campaign Mode and fills in a campaign brief — bigger and more
strategic than a project brief:

- Campaign name and objective
- Core message / main idea
- Target audience
- Key proof points
- Asset groups needed — e.g. awareness wave (LinkedIn ads, social), nurture wave
  (email sequence), conversion wave (landing page, display)
- Launch sequence and timing

Quillio creates:

- `campaign.md` stored in Postgres per campaign
- Campaigns folder in Drive
- Multiple project subfolders — one per asset group or launch wave
- Multiple copy docs — each briefed from the campaign context for coherence
- A campaign record in Postgres with links to all child projects

## COHERENCE ACROSS ASSETS

The `campaign.md` context is injected into every brief within the campaign —
campaign summary, core message, tone modifiers, and approved copy from prior
assets if they exist. Every asset knows the full strategic picture so copy stays
on-strategy across emails, ads, landing pages, and social.

For sequential assets (e.g. email nurture series), each subsequent brief is fed
the approved copy from previous assets to ensure continuity of voice and message
progression.

## DATA MODEL

- `campaigns` table: id, tenant_id, name, objective, core_message, campaign_md,
  drive_folder_id, created_at
- `projects` table gains `campaign_id` foreign key — projects can belong to a
  campaign or be standalone
- `campaign_assets` table: campaign_id, asset_type, sequence_order, status,
  project_id

## UI

- Home screen: toggle between Project Mode and Campaign Mode
- Campaign Mode visual language: darker sky gradient, more structured layout,
  command-center feel, pixel aesthetic preserved
- Campaigns tab replaces or sits alongside Projects tab showing all campaigns
  with child project status
- Campaign detail view: shows all child projects, their status, asset completion,
  and timeline

## PHASE 5 BUILD ORDER

1. Data model — campaigns table, campaign_id on projects, campaign_assets table
2. Campaign input flow — campaign brief form in web app
3. campaign.md generation — Gemini generates from campaign brief, stored in
   Postgres
4. Multi-project creation — generate all child project docs from campaign context
   simultaneously
5. Coherence injection — campaign.md fed into every child brief
6. Sequential asset awareness — approved copy from prior assets fed into
   subsequent briefs
7. Campaign Mode UI — home screen toggle, darker visual language, campaigns tab
8. Dynamic time-based theme integration — campaign mode uses night/dusk palette
   by default
