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
- **Brand voice** lives in `voice.md` at the repo root, loaded once at startup
  by `gemini.js` and injected into every draft prompt as the overall brand
  identity (the Sheet's Tone Notes remain field-specific direction). HTML
  comments are stripped; an unfilled placeholder (headings/comments only) injects
  nothing. Edits take effect on restart/deploy.
  - **Editing `voice.md` — mind the structural coupling.** To save tokens,
    `gemini.js` slices the file per asset: everything *except* the
    `## … Writing Across Mediums` section is treated as universal craft and
    always injected; that section's `### ` subsections are the per-medium parts,
    and only the one matching the asset is injected. Two things the parser keys
    off: (1) a level-2 heading whose text contains **"Writing Across Mediums"**,
    and (2) its `### ` subsection titles, matched by keyword in
    `mediumKeywordsForAsset` (`paid social`, `organic social`, `google display`,
    `email`, `sales`, `confirmation`). If you rename that heading or those
    subsections, update `mediumKeywordsForAsset` too — otherwise it safely falls
    back to injecting the whole file (more tokens, no lost guidance). Keep the
    CTA library and banned-words list *outside* the mediums section so they stay
    universal.
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

Live Sheet (`ASSET_SHEET_ID` default): `1NVDCcjPO2ZG1Vmt40WTwTYmXTl27dBiwrinHHKK9tCU`
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

## Vision & roadmap

The product vision, the phased roadmap (V1 → Phase 7 LiveSpecs), the
"setup must become frictionless" guiding principle, and the current verified
platform-spec character limits all live in **`ROADMAP.md`** at the repo root —
that's the single source of truth. In short: Quillio turns a one-line brief
into spec-correct copy without leaving Slack, and the long-term goal (Phase 7
LiveSpecs) is to become the industry source of truth for platform copy specs.

When building features, check `ROADMAP.md` for intent, and treat its
"Current verified specs" tables as the reference for character limits (the live
limits actually enforced come from the asset spec Sheet).

