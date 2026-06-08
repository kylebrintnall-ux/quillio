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
  google.js          Service-account auth → memoized Drive/Docs/Sheets clients.
  workflow.js        Orchestrates the async pipeline (parse → specs → doc → post)
                     and the "Generate First Draft" action.
  services/
    gemini.js        Gemini REST calls: parseBrief() + generateFieldDraft().
    sheets.js        Reads the spec Sheet, groups rows by Asset Type, filters.
    docBuilder.js    Accumulates Docs batchUpdate requests (text + styling).
    docs.js          Creates the doc; parses it back to insert drafts statelessly.
    slack.js         Block Kit message + Slack POST helpers.
```

Data flow for `/quillio [brief]`:

1. `server.js` acks Slack instantly.
2. `workflow.runBriefWorkflow`:
   - `gemini.parseBrief` → `{ summary, writerPrompt, assets }` (assets
     constrained to the fixed allowed list).
   - `sheets.getAssetSpecs(assets)` → grouped specs (all assets if the filter is
     empty / matches nothing).
   - `docs.createBriefDoc` → creates + formats the doc in the Drive folder.
   - `slack.postResult` → Block Kit message with Open in Drive / Generate First
     Draft / Skip buttons.
3. "Generate First Draft" → `docs.generateFirstDraft(docId)` re-reads the doc,
   drafts copy per field via Gemini, inserts it under each label, confirms.

## Key conventions

- **CommonJS** (`require`/`module.exports`), `'use strict'` at the top of every
  file. Node 18+ (uses global `fetch`).
- **No persisted state.** The button handler reconstructs everything it needs by
  re-parsing the generated Doc (`docs.parseDoc`). The only state passed through
  Slack is `docId` in the button `value`. If you add fields to the doc, keep the
  parser in sync: asset names are `HEADING_3`, the two top sections are
  `HEADING_2`, field labels are bold and end with `[limit]`, and drafts are
  inserted into the blank line right after each label.
- **Google Docs styling** is done in `docBuilder.js`: build the full text once,
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
`PORT`. Optional: `GEMINI_MODEL`, `SHEET_ID`, `DRIVE_FOLDER_ID`,
`SLACK_SIGNING_SECRET`. See `.env.example` and `README.md` for details,
including how to create the service account and share the Sheet/folder with it.

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

- The service account is a separate Google identity. The Sheet must be shared
  with its `client_email` (Viewer). Most "permission" errors trace back to this.
- **The docs folder (`DRIVE_FOLDER_ID`) must be on a Shared Drive**, with the
  service account added as a member (Content Manager). Service accounts have ~no
  personal storage quota, so a doc the SA *owns* fails to create with
  `storageQuotaExceeded`. Shared Drive files are owned by the drive, not the SA.
  `drive.files.create` already passes `supportsAllDrives: true`.
- Slack button `value` is capped (~2000 chars) — keep it to `docId` only; rely
  on doc re-parsing for everything else.
- Do not commit `.env` or the service-account JSON (see `.gitignore`).
```
