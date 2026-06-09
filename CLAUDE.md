# CLAUDE.md

Guidance for AI assistants (and humans) working in this repository.

## What this is

Quillio is a Node.js + Express service that powers a Slack slash command
(`/quillio [brief]`). It turns a free-form campaign brief into a formatted
Google Doc and posts the result back to Slack with interactive buttons. It
deploys on Railway.

## The one architectural rule that matters

**Acknowledge Slack first, then do the work.** Slack slash commands require an
HTTP response within 3 seconds, but the full pipeline (Gemini → Sheets → Docs →
Slack) takes 7+ seconds. `src/server.js` sends the `200` ack **before** calling
`runBriefWorkflow()`, which then runs fire-and-forget. This early-return pattern
is why the app exists in Node instead of Google Apps Script (Apps Script's
`doPost` can't respond and keep working).

Do **not** add `await` before the workflow call in the slash-command handler,
and do not move heavy work ahead of the `res` call. The same ack-first pattern
applies to `/slack/interactions`.

## Architecture

```
src/
  server.js          Express app. Two POST endpoints (/slack/command,
                     /slack/interactions) + /health. Ack-first; optional
                     Slack signature verification.
  config.js          Env vars + baked-in IDs/URLs (all env-overridable).
  google.js          Auth → memoized Drive/Docs/Sheets clients. Sheets is always
                     the service account; Drive/Docs writes use OAuth2 when
                     GOOGLE_REFRESH_TOKEN is set, else the service account.
  workflow.js        Orchestrates the async pipeline (parse → specs →
                     destination → post). Destination-agnostic.
  services/
    gemini.js        Gemini REST calls: parseBrief() + generateFieldDraft().
    sheets.js        Reads the spec Sheet, groups rows by Asset Type, filters.
    slack.js         Block Kit message + Slack POST helpers.
  destinations/      Output adapters — where the brief gets written.
    index.js         Registry; getDestination() selects via config.DESTINATION.
    googleDocs.js    Google Docs adapter: createDocument() + generateDraft().
    docBuilder.js    Accumulates Docs batchUpdate requests (text + styling).
```

Data flow for `/quillio [brief]`:

1. `server.js` acks Slack instantly.
2. `workflow.runBriefWorkflow`:
   - `gemini.parseBrief` → `{ summary, writerPrompt, assets }` (assets
     constrained to the fixed allowed list).
   - `sheets.getAssetSpecs(assets)` → grouped specs (all assets if the filter is
     empty / matches nothing).
   - `getDestination().createDocument(...)` → `{ id, url, title }` (creates +
     formats the doc via the active destination adapter).
   - `slack.postResult` → Block Kit message with Open in Drive / Generate First
     Draft / Skip buttons.
3. "Generate First Draft" → `getDestination().generateDraft(id)` re-reads the
   doc, drafts copy per field via Gemini, inserts it under each label, confirms.

## Key conventions

- **CommonJS** (`require`/`module.exports`), `'use strict'` at the top of every
  file. Node 18+ (uses global `fetch`).
- **No persisted state.** The button handler reconstructs everything it needs by
  re-parsing the generated Doc (`parseDoc` in `destinations/googleDocs.js`). The
  only state passed through Slack is the doc id in the button `value`. If you add
  fields to the doc, keep the parser in sync: asset names are `HEADING_3`, the
  two top sections are `HEADING_2`, field labels are bold and end with `[limit]`,
  and drafts are inserted into the blank line right after each label.
- **Destinations are pluggable.** `workflow.js` never calls a Google API
  directly — it goes through `getDestination()`. A destination adapter exports
  `{ name, createDocument({ brief, summary, writerPrompt, assetSpecs }) → { id, url, title }, generateDraft(id) → { title, fieldCount } }`.
  Add Notion/OneDrive by dropping a new file in `destinations/`, registering it
  in `index.js`, and selecting it via `DESTINATION`.
- **Google Docs styling** is done in `destinations/docBuilder.js`: build the full text once,
  insert at index 1, then apply paragraph/text styles over recorded ranges.
  There is no native horizontal-rule insert in the Docs API — an HR is an empty
  paragraph with a bottom border.
- **Allowed assets** are the single source of truth in `config.ALLOWED_ASSETS`.
  Gemini output is filtered against it defensively.
- **Errors** in async work are caught in `server.js` and reported back to Slack
  via `response_url`; they never crash the request.
- Secrets and deployment-specific IDs live in `config.js` with env overrides —
  don't hardcode new ones elsewhere.

## Environment variables

Required: `GEMINI_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `SLACK_WEBHOOK_URL`,
`PORT`. Optional: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REFRESH_TOKEN` (OAuth2 for Drive/Docs writes — the personal-Gmail
path), `DESTINATION`, `GEMINI_MODEL`, `SHEET_ID`, `DRIVE_FOLDER_ID`,
`SLACK_SIGNING_SECRET`. See `.env.example` and `README.md` for details,
including how to mint the OAuth2 refresh token and share the Sheet.

## Running & checking

```bash
npm install
node --check src/**/*.js          # quick syntax check
node --env-file=.env src/server.js
```

There is no automated test suite yet. To smoke-test without real credentials,
boot the server with dummy env vars and confirm `/slack/command` returns the ack
in well under 3 seconds (the downstream workflow will fail, which is expected).

## Deploy

Railway via Nixpacks; `npm start` is the start command (also in `railway.json`
and `Procfile`). `PORT` is injected by Railway. See README for the full Slack +
Railway setup.

## Gotchas

- The service account is a separate Google identity. The Sheet must always be
  shared with its `client_email` (Viewer). Most "permission" errors trace back
  to this.
- **Two write paths for Drive/Docs, decided by `GOOGLE_REFRESH_TOKEN`:**
  - *OAuth2 (token set):* writes run as a real Gmail user via OAuth2. This is
    the fix for the service account's `storageQuotaExceeded` — service accounts
    have ~no personal Drive quota, so docs they *own* fail to create.
    `DRIVE_FOLDER_ID` is a normal My Drive folder owned by that user.
  - *Service account (token unset):* `DRIVE_FOLDER_ID` must be on a **Shared
    Drive** (files owned by the drive, not the SA, so no quota hit), with the SA
    added as a member. `drive.files.create` already passes
    `supportsAllDrives: true`.
- Slack button `value` is capped (~2000 chars) — keep it to the doc id only;
  rely on doc re-parsing for everything else.
- Do not commit `.env` or the service-account JSON (see `.gitignore`).

## Asset spec Sheet

Live Sheet (`SHEET_ID` default): `1sdYw1NQ27OYeCaVCHRN50xVVbQoTnDvn5cZXag34Aw4`
(the "Agentforce Copy System — Asset & Prompt Library", v2). The old v1 Sheet
`1skbkkKlHMDUzeG8_bFpcSjrvweumivePuSOvr5qIfqk` is retired.

Fields are read **dynamically** from the Sheet — `sheets.getAssetSpecs` groups
rows by `Asset Type` in row order, draft copy is generated per field by name,
and `parseDoc` recovers fields from the doc via the bold-label-ending-in-
`[limit]` pattern. **Nothing hardcodes field names or field counts**, so adding,
renaming, or reordering fields in the Sheet needs no code change — just edit the
Sheet (it's read live on every `/quillio`).

The Dynamic Email block (v2) is ordered: Subject Line 1, Subject Line 2,
Pre-header, Headline (Offer 1) [50], Offer Body 1, CTA Text (Offer 1),
Headline (Offer 2) [50], Offer Body 2, CTA Text (Offer 2). (v1's single
"Headline" was split into per-offer "Headline (Offer 1)" / "Headline (Offer 2)".)

## Vision

Quillio turns a one-line campaign brief into ready-to-use, spec-correct marketing
copy without leaving Slack. The long-term goal (see Phase 7) is to become the
industry source of truth for platform copy specs — so a marketer never again
ships copy that's the wrong length for the channel.

## Product roadmap

### Shipped — V1
- Slack `/quillio` command → Gemini brief parsing → Google Doc creation → Slack notification
- Generate First Draft with `:quillio:` custom emoji
- Dynamic folder detection from a Drive link in the brief
- Reference links extracted and included in the doc
- Title Case doc titles
- Response posts to the originating channel (via slash-command `response_url`)
- Semantic asset matching with a full informal-variation library
- Modular destination architecture (`src/destinations/`)

### Phase 2 — Smart Context Ingestion
- Channel history reading — `/quillio` with no text reads the last 10 messages in the channel
- Slack Canvas ingestion — read full Canvas content from linked URLs (`canvases:read` scope)
- PDF text extraction via `pdf-parse`
- External URL fetching and text extraction
- Second Gemini synthesis pass to enrich `summary` and `writerPrompt` from all reference context

### Phase 3 — Review Loop
- Manager and designer notifications
- Comment / feedback loop in the Slack thread

### Phase 4 — Surgical Updates
- `/quillio update [doc-link] field: new copy` — swaps a single field without rebuilding the doc

### Phase 5 — Design Sync
- Approved copy pushes to Figma / Canva text layers
- Human approval gate before any design push

### Phase 6 — Web App + Multi-Tenant
- OAuth Google Drive connection per customer
- Asset-library configuration via UI, import (paste a spec doc → Gemini parses it), or default templates
- Default templates based on actual platform specs
- Notion and OneDrive destination adapters
- Stripe billing

### Phase 7 — LiveSpecs
- Automated spec-monitoring service polling official platform pages
- Push confirmed spec changes to all affected templates
- Slack notifications to affected teams when specs change
- Goal: become the source of truth for platform copy specs across the marketing industry

## Platform specs baseline (June 2026)

Reference character limits. Treat these as the defaults that ship with templates
(Phase 6) and that LiveSpecs (Phase 7) keeps current. `(xN)` = number of
variants the platform accepts for that field.

| Platform | Field | Limit |
| --- | --- | --- |
| LinkedIn | Intro text | 150 recommended (600 max) |
| LinkedIn | Headline | 70 |
| LinkedIn | Description | 100 |
| Meta | Primary text | 125 visible (2200 max) |
| Meta | Headline | 40 |
| Meta | Description | 30 |
| Twitter/X | Post copy | 280 (links use 23 chars → 257 effective) |
| Google Display RDA | Short headline | 30 (x5) |
| Google Display RDA | Long headline | 90 |
| Google Display RDA | Description | 90 (x5) |
| Google Search RSA | Headline | 30 (x15) |
| Google Search RSA | Description | 90 (x4) |

