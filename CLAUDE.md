# CLAUDE.md

Guidance for AI assistants (and humans) working in this repository.

Everything here is meant to be verifiable against the code. If a claim in this
file disagrees with the source, the source wins — fix this file.

## What this is

Quillio is a Node.js + Express service that turns a free-form campaign brief
into a formatted Google Doc. It has **two product surfaces**, both driving the
same core pipeline:

- **Slack** — the slash commands `/quillio [brief]` and `/quillio-review`, plus
  interactive buttons and a modal.
- **Web** — a browser app at `/app`, with sign-in, onboarding, settings, and an
  admin area. Served as self-contained HTML files from `public/`.

It deploys on Railway.

## The one architectural rule that matters

**Acknowledge Slack first, then do the work.** Slack slash commands require an
HTTP response within 3 seconds, but the full pipeline (Gemini → Postgres → Docs →
Slack) takes 7+ seconds. `src/server.js` sends the `200` ack **before** calling
`runBriefWorkflow()`, which then runs fire-and-forget.

Do **not** add `await` before the workflow call in a slash-command handler, and
do not move heavy work ahead of the `res` call. This applies to all three Slack
endpoints: `/slack/command`, `/slack/review`, and `/slack/interactions` (both
the `block_actions` and the `view_submission` branches).

The web surface has the same problem and solves it differently: `routes/app.js`
starts an in-memory **job** (`startJob`) and returns a `jobId` immediately; the
browser polls `/api/{brief,draft,review}/:jobId/status`. Jobs are per-tenant and
a cross-tenant read returns 404, not 403.

## Architecture

```
src/
  server.js          Express app: wiring, session, Slack signature verification,
                     the 3 Slack POST endpoints, GET / (landing) + /health, and
                     the global error handler. Mounts every router below.
  config.js          Env vars + baked-in IDs/URLs (all env-overridable).
  google.js          Auth → memoized Drive/Docs clients. getClients() (shared env
                     creds) and getClientsForTenant({ tenantId, userId }) — writes
                     run as the ACTING USER's OAuth identity, falling back to the
                     tenant's (deprecated) token, then env.
  db.js              Postgres pool + tenant/token/voice/header/naming accessors.
                     resolveTenant() returns { tenant, tokens, source, user } from
                     either Postgres or synthesized env vars. `user` is the ACTING
                     user; per-user credentials win over the tenant's.
  emoji.js           Custom :quillio-*: emoji with Unicode fallbacks.
  workflow.js        Compatibility shim — re-exports adapters/slackWorkflow.js.

  core/
    pipeline.js      Platform-agnostic pipeline. NO Slack imports. Brief parsing,
                     reference ingestion (Drive/Slides, external URLs, PDFs,
                     Slack canvases, uploaded files), Gemini enrichment, folder
                     routing, generateDoc/generateDraft, tenantAssetsToSpecs.

  adapters/          Platform adapters — the only places that know their platform.
    slackWorkflow.js Slack brief + draft lifecycle (runBriefWorkflow,
                     runGenerateDraft). The only Slack-messaging orchestrator.
    slackReview.js   /quillio-review trigger: resolve doc → live message → review.
    web.js           Browser adapter. Zero Slack imports (a smoke test enforces
                     this). Returns plain data; does no messaging.

  routes/            Express routers (the web/HTTP surface).
    oauth.js         Slack install (/oauth/slack[/callback], /welcome) and Google
                     sign-in (/oauth/google[/callback]).
    onboarding.js    /onboarding + /api/onboarding/* (assets, folder, voice,
                     complete).
    app.js           /app + /api/brief, /api/draft, /api/review, /api/upload,
                     /api/projects[/:id[/content]] + the job-status pollers.
    settings.js      /settings + /api/settings/* (voice, workspace, folder) and
                     /api/auth/signout.
    headerTemplate.js /api/header[/extract] + /api/naming — doc-header and
                     file-naming onboarding.
    admin.js         /admin + /admin/api/* (LiveSpecs watch list, detection run,
                     review queue, approve-preview/commit). requireAdmin-gated.

  middleware/
    auth.js          requireAuth. Demo mode (no DATABASE_URL) attaches a demo
                     user; authenticated mode requires a session.
    requireAdmin.js  users.is_admin gate. Responds 404 (never 403) on any failure.
    rateLimit.js     Per-IP, per-hour limiters (brief/draft/upload/voice/oauth,
                     plus a much more generous slackLimiter).

  db/
    assets.js        Per-tenant asset library (asset_types + copy_fields).
                     getTenantAssets() is the sole spec source.
    projects.js      Project history rows.
    users.js         Web sign-in users (Google identity) + per-user credentials:
                     user_tokens (user_id, service) and user_slack_links
                     (slack_team_id, slack_user_id) UNIQUE → user_id.
    specWatch.js     LiveSpecs watch list / review queue reads.

  utils/
    normalize.js     Asset-name normalization (case, dash variants, spacing).
    errors.js        clientErrorMessage() — safe, generic client-facing errors.
    variants.js      Numbered-stack / solo-label copy-variation detection.

  services/
    gemini.js        All Gemini REST calls (parse, enrich, draft, variations,
                     voice guide, vision, header extract, copy review).
    slack.js         Block Kit builders + Slack Web API helpers.
    copyReview.js    Copy-review orchestration → anchored Doc comments.
    specDetector.js  LiveSpecs change detection (fetch → normalize → hash).
    specReview.js    The ONLY place that writes copy_fields. Gated + two-step.

  destinations/      Output adapters — where the brief gets written.
    index.js         Registry; getDestination() selects via config.DESTINATION.
    googleDocs.js    The Google Docs adapter (the only one today).
    docBuilder.js    Accumulates Docs batchUpdate requests (text + styling).
    docHeaderSchema.js / docHeaderTable.js / docHeaderSample.js /
    docHeaderReader.js   Per-tenant doc-header template: schema, table
                     primitive, editable sample doc, and read-back.
    docNaming.js     Per-tenant file-naming pattern (static + dynamic segments).

  data/
    defaultAssets.js Bundled default asset library, seeded per tenant on install.

public/              Self-contained HTML pages (no frameworks, no external
                     scripts). app.html, onboarding.html, settings.html,
                     admin.html + fonts/, assets/ (GIFs, logos, images).
scripts/             One-off migrations, seeds, and query/debug utilities.
test/smoke.test.js   The test suite (see "Running & checking").
```

**One brief can produce more than one document.** A brief can NAME a document
template (`doc_templates.name`), and it is built alongside the copy doc in the
same campaign folder. The two are different deliverables: the copy doc holds the
copy assets; the template holds its own fields, confirmed on upload
(`template_markers`) and drafted straight into its own cells by stored
coordinate. Nothing about a template passes through the asset library.

The build path is `pipeline.buildTemplateDocument` — copy the template with
`drive.files.copy`, draft every marker ticked `is_copy` through the same batched
Gemini call the copy doc's assets use, and write the results in ONE
`batchUpdate` in reverse document order. Template documents are built BEFORE the
copy doc, deliberately — the copy doc will carry links to them.
`projects.copy_doc_id` still means the copy doc and still keys idempotency; the
template document is recorded in `projects.template_doc_id` / `template_doc_url`.

**A template can only be named once per brief.** `projects` carries one
`template_doc_id`/`url` pair, so a second copy has nowhere to be recorded.
`pipeline.resolveTemplatePlan` refuses by name with the count in the message
rather than building something it cannot track. Two DIFFERENT templates in one
brief both build and both appear on the surfaces, but only the first lands on
the project row — that is when a join table stops being premature.

**Names are unique per tenant across BOTH namespaces.**
`scripts/migrateAddTemplateUniqueness.js` adds a unique index on
`doc_templates (tenant_id, quillio_normalize_name(name))` — the same functional
index, and the same `quillio_normalize_name`, that
`migrateAddAssetUniqueness.js` defines (a smoke test asserts the two files
define it character for character). No index can span two tables, so an asset
name colliding with a template name is refused at parse time by
`pipeline.assertNoNameCollision`, which names both and tells you to rename one.

**The old attach/map path is gone** (see "Removed features").

Data flow for `/quillio [brief]`:

1. `server.js` verifies the Slack signature, then acks Slack instantly.
2. `adapters/slackWorkflow.runBriefWorkflow`:
   - `resolveTenant(teamId, slackUserId)` → the tenant whose library, voice
     guide, folder, and Google OAuth user apply.
   - `pipeline.parseBrief` → campaign title, summary, writer prompt, assets,
     TEMPLATES (named document templates), folder id, reference links. Two
     vocabularies, refused against each other before the model sees either.
   - `pipeline.fetchAllReferences` + `enrichWithReferences` → a second Gemini
     pass over the ingested reference material.
   - `pipeline.generateDoc` → `getTenantAssets(tenantId)` (Postgres, the sole
     spec source) → `tenantAssetsToSpecs` → create the project folder →
     `buildTemplateDocument` for each NAMED template → `createDocument(...)` for
     the copy doc → save a project row.
   - `slack.postResult` → Block Kit message with buttons.
3. "Generate First Draft" → `pipeline.generateDraft` →
   `getDestination().generateDraft(...)`, which re-reads the doc, drafts copy
   per field via Gemini, inserts it under each label, and confirms.

The web path (`adapters/web.js`) runs the same `core/pipeline.js` steps and
returns data instead of posting messages.

## Key conventions

- **CommonJS** (`require`/`module.exports`), `'use strict'` at the top of every
  file. Node 18+ (uses global `fetch`). CI runs Node 20.
- **Platform isolation.** `core/pipeline.js` and `adapters/web.js` must never
  import anything Slack. All Slack messaging lives in `adapters/slackWorkflow.js`,
  `adapters/slackReview.js`, and `services/slack.js`. A smoke test enforces the
  web adapter's isolation.
- **No persisted doc state.** The button handler reconstructs what it needs by
  re-parsing the generated Doc (`parseDoc` in `destinations/googleDocs.js`). The
  only state passed through Slack is the doc id in the button `value` (the
  Regenerate modal additionally carries `{ docId, channel, messageTs }` in
  `private_metadata`). If you add fields to the doc, keep the parser in sync:
  asset names are `HEADING_3`, the two top sections are `HEADING_2`, field labels
  are bold and end with `[limit]`, and drafts go in the blank line right after
  each label. `fieldHint` deliberately emits **one** paragraph — `parseDoc`
  treats a second paragraph after a label as drafted copy.
- **Destinations are pluggable**, but the contract is bigger than create+draft.
  `core/pipeline.js` and `services/copyReview.js` never call a Google API
  directly — they go through `getDestination()`. The **consumed** surface today
  is:

  | Member | Consumed by |
  | --- | --- |
  | `name` | `destinations/index.js` registry key |
  | `createDocument({ brief, campaignTitle, summary, writerPrompt, assetSpecs, folderId, referenceLinks, referenceInsights, headerSchema, namingPattern, clients })` → `{ id, url, title }` | `pipeline.generateDoc` |
  | `generateDraft(id, direction, clients, voiceGuide, lookupDirection, scopedFields, append)` → `{ title, fieldCount, url }` | `pipeline.generateDraft` |
  | `createFromTemplate({ sourceDocId, name, folderId, values, markers, clients })` → `{ id, url, title, filled, unfilled }` | `pipeline.generateDoc` (custom document types) |
  | `writeTemplateCells(id, { markers, values }, clients)` → `{ written, skipped, healed, missing }` | `pipeline.buildTemplateDocument`, `regenerateTemplateFields` |
  | `readTemplateCells(id, { markers }, clients)` → `{ rows, missing, title }` | `pipeline.readTemplateDocument` |
  | `addUnanchoredComment(docId, content, clients)` | `services/templateReview` |
  | `getDocContent(id, clients)` | `pipeline.getProjectContent`, `copyReview` |
  | `listReviewComments(docId, clients)` | `copyReview` |
  | `addReviewComment(docId, { quote, content }, clients)` | `copyReview` |
  | `deleteReviewComment(docId, commentId, clients)` | `copyReview` |
  | `REVIEW_PREFIX` | `copyReview` (comment ownership) |

  `googleDocs.js` also exports `fieldLabel`, `fieldHint`, `parseDoc`,
  `appendBody`, and `buildVariantBlock` — **unit tests only**, not part of the
  destination interface. The header comment in `destinations/index.js` still
  describes only the original two methods; the table above is the real surface.
  A new adapter must implement all seven consumed members before the review
  path will work against it, and `createFromTemplate` on top of those before a
  tenant's own template document can be built.
- **Google Docs styling** is done in `destinations/docBuilder.js`: build the full
  text once, insert at index 1, then apply paragraph/text styles over recorded
  ranges. There is no native horizontal-rule insert in the Docs API — an HR is an
  empty paragraph with a bottom border. Tables are the exception and are
  necessarily two-phase (`docHeaderTable.js` explains why).
- **Allowed assets** are the single source of truth in `config.ALLOWED_ASSETS`.
  Gemini output is filtered against it defensively in `services/gemini.js`.
- **Errors.** Async Slack work is caught in `server.js` / the adapters and
  reported back via `response_url` or `chat.update`; it never crashes the
  request. Web routes return `{ success:false, error }` through
  `utils/errors.clientErrorMessage` — stack traces are logged server-side only.
  `server.js` ends with a 4-arg global error handler; it must stay last.
- Secrets and deployment-specific IDs live in `config.js` with env overrides —
  don't hardcode new ones elsewhere.

## Spec metadata renders — it is not data-only

`copy_fields.spec_type` and `copy_fields.spec_source` are **rendered in the
generated doc**, not inert columns. In `destinations/googleDocs.js`:

- `specTypeLine(specType, sourceName)` turns `spec_type` into the italic tier
  sentence under a field label — "Platform limit (LinkedIn). Stay within this
  count." for `enforced`, "Recommended by …" for `recommended`, and nothing for
  `house_default`/null.
- `specSourceName(specSource)` maps `spec_source` to a display platform name.
  `quillio_default` and anything unrecognized return `null` — the raw
  `spec_source` string is **never** printed.
- `fieldHint(field)` composes `spec_note` + the tier line into one paragraph and
  returns `{ text, links }`, where `links` carries the **clickable citation**:
  the platform name is hyperlinked to the field's `spec_source` URL. A separate
  `NOTE_SOURCE_LINKS` table hyperlinks hand-written note credits (e.g. "Litmus").

So changing `spec_type` or `spec_source` changes what writers see in the doc.
Treat both as user-visible.

## Accounts vs. tenants — what is per-user and what is shared

A **tenant** is the shared workspace. A **user** is a person (`users`, keyed on
`google_id`/`email`, pointing at one `tenant_id`). The dividing line:

| Per **user** | Per **tenant** (shared, and meant to be) |
| --- | --- |
| Google refresh token — `user_tokens (user_id, service)` | Asset library (`asset_types` / `copy_fields`) |
| Slack identity — `user_slack_links (slack_team_id, slack_user_id)` UNIQUE → `user_id` | Voice guide (`voice_guide`) |
| Slack *user* token (`slack_user`) | Default Drive folder (`tenants.default_folder_id`) |
| `projects.created_by` | Doc-header schema + naming pattern (`templates`) |
| | Slack *bot* token (`slack_bot`) — one bot install per workspace |

Credentials are per-user because they used to not be: the Google token lived on
`tenant_tokens (tenant_id, 'google')` and the Slack link was a single
`(slack_team_id, slack_user_id)` pair on the **tenants row**, so a second person
on a tenant overwrote the first — every Drive write then ran as the newest
signer, and the first person's `/quillio` started failing the unlinked check.

Resolution order, both surfaces:

- **Slack** — `resolveTenant(teamId, slackUserId)` → `user_slack_links` → user →
  that user's tenant. An unknown identity still gets the unlinked refusal.
- **Web** — `resolveTenant(tenantId, null, sessionUserId)`; the acting user is
  the session user, passed explicitly by `routes/app.js` / `routes/settings.js`.

Both return `user` on the context. Adapters read `user.id` and pass
`{ tenantId, userId }` to `getClientsForTenant`, so a write always runs as the
person who asked for it, and record it as `projects.created_by`.

**The old columns still exist and are still read.** `tenant_tokens` rows and
`tenants.slack_team_id/slack_user_id` are a deprecated *fallback* — nothing
writes them for `google` any more, but a deploy that lands before
`scripts/migrateBackfillUserCredentials.js` runs must not refuse every existing
Slack user. Do not drop them until the backfill has run everywhere.

**Either deploy order is safe, and must stay that way.** Railway auto-deploys
`main` on merge, so this code runs against an unmigrated database first. Every
read and write against `user_tokens` / `user_slack_links` / `projects.created_by`
catches Postgres `42P01` (undefined_table) / `42703` (undefined_column) and
degrades to the pre-migration behavior — `db.js` exports `isUndefinedTable`,
`isUndefinedColumn` and `warnMissingSchema` for exactly this. Concretely:
`getUserBySlackIdentity` → null (so `resolveTenant` uses the legacy tenant-row
link), `saveUserToken` → false (so the OAuth callback writes the tenant token
instead of failing sign-in), `linkSlackIdentityToUser` → the legacy tenant-row
write *still surfacing 23505 as a conflict*, and `saveProject` retries its INSERT
without `created_by`. The catches match only those two SQLSTATEs — a permissions
or connectivity failure still throws. If you add a column or table here, add the
same tolerance and a test in the "deploy-before-migration" block.

Migrations: `scripts/migrateAddUserCredentials.js` (schema) then
`scripts/migrateBackfillUserCredentials.js` (data; dry-run by default, `--commit`
to write). The backfill only moves a tenant's credentials when that tenant has
**exactly one** user — 0 or 2+ are reported and skipped, never guessed.

## Removed features — do not try to use them

Commit `2ac1408` deleted the unshipped **approval workflow** and the **Figma
OAuth flow**:

- `src/handlers/approval.js` — gone. There is no `src/handlers/` directory.
- `src/services/figma.js` — gone, along with the `/auth/figma*` routes.
- Dead exports in `db/projects.js`, `db/users.js`, `googleDocs.js`, `emoji.js`,
  `routes/oauth.js`, `server.js`, and `services/slack.js` went with them.

Leftovers that still exist but are **wired to nothing**: `config.FIGMA_CLIENT_ID`
/ `FIGMA_CLIENT_SECRET` / `FIGMA_REDIRECT_URI`, and `db.js`'s `saveFigmaTokens`
/ `getFigmaTokens`. Their presence is not evidence a Figma flow exists.

The document-template rework (step four) deleted the **attach/map path**, which
reached a template THROUGH an asset type:

- `src/destinations/markerMatch.js` and `scripts/reportAutoMatch.js` — gone.
- `POST /api/settings/library/asset/:id/template` (attach/detach) and
  `POST /api/settings/library/asset/:id/markers` (field→marker mapping) — gone,
  with the settings UI that drove them.
- `db/assets.js` `setAssetTemplate` / `setAssetFieldMarkers` /
  `getAssetTemplateBindings` — gone.
- `pipeline.partitionSpecsByTemplate`, `templateValuesFor`,
  `syncTemplateDocuments`; `googleDocs.fillTemplateMarkers` (the two-replacement
  re-sync trick); `db/projects.setProjectTemplateFill` — gone.

It was wrong in a specific way: an attached asset rendered in the copy doc AND
filled the matrix, so form and confirmation copy came out of one brief in two
documents. A brief names the template now.

Leftovers that still exist but are **wired to nothing**: the columns
`asset_types.doc_template_id`, `copy_fields.template_marker_key` /
`template_marker_name`, and `projects.template_fill`. They are read by no code
path. Dropping them is a separate irreversible migration and was deliberately
not done in the commit that stopped using them — do not treat their presence as
evidence the attach/map path exists.

(Unrelated naming collision: `routes/admin.js`'s `approve-preview` /
`approve-commit` and `services/specReview.js` are the **LiveSpecs** spec-approval
flow, which is live. That is not the removed approval workflow.)

## Environment variables

Required: `GEMINI_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `SLACK_WEBHOOK_URL`,
`PORT`, `DATABASE_URL` (Postgres holds the asset library — the sole spec source,
so it's required to build docs).

Optional: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`
(OAuth2 for Drive/Docs writes — the personal-Gmail path), `GOOGLE_REDIRECT_URI`,
`GOOGLE_TIMEOUT_MS`, `DESTINATION`, `GEMINI_MODEL`, `DRIVE_FOLDER_ID`,
`SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_USER_TOKEN`,
`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI`,
`SLACK_REVIEW_EMOJI`, `SLACK_USE_CUSTOM_EMOJI`, `SESSION_SECRET`,
`PUBLIC_BASE_URL`. See `.env.example` and `README.md`.

Note: `SLACK_SIGNING_SECRET` is listed as optional above because the app boots
without it, but the Slack endpoints **fail closed** — `verifySlack` rejects every
request when it's unset. Slack does not work without it.

## Running & checking

```bash
npm install
node --check src/**/*.js          # quick syntax check
node --env-file=.env src/server.js
npm test                          # node --test → test/smoke.test.js
```

**There is a test suite.** `test/smoke.test.js` is ~3,300 lines and currently
runs **173 tests** in about a second, with no credentials or network — it
exercises wiring, parsing, rendering, and regression guards. `.github/workflows/ci.yml`
runs `npm ci && npm test` on every push and pull request. Run it before you
commit, and add cases there when you change behavior.

**`public/*.html` is effectively untested.** The suite reads those files as
**strings** and asserts that certain ids, URLs, and CSS references are present —
there is no jsdom, no headless browser, no JS execution. A frontend change can
pass CI and still be broken in the browser. For anything in `public/app.html`
(2,800+ lines of inline markup, CSS, and vanilla JS), **the device is the test**:
load the page and click through it.

## Deploy

Railway via Nixpacks; `npm start` is the start command (also in `railway.json`
and `Procfile`). `PORT` is injected by Railway. `railway.cron.json` is a separate
Railway service that runs `node scripts/runDetection.js` weekly (the LiveSpecs
detector). See README for the full Slack + Railway setup.

### Running migrations — read this before running one

Migrations and seeds in `scripts/` are standalone Node scripts. Run them **in the
Railway console** as plain Node:

```bash
node scripts/migrateAddSpecTables.js
```

**Never `railway run node scripts/…`.** The Railway console already has
`DATABASE_URL` preloaded in its environment; `railway run` re-resolves the
environment and is not the path these scripts expect. Use plain `node`.

Most migrations are written to be idempotent (`CREATE TABLE IF NOT EXISTS`,
guarded seeds), but read the script's header before re-running one.

**Applied to production.** The document-template work's migrations have all run
and came back clean, so nothing on that path is waiting on a schema change:

| Script | Result |
| --- | --- |
| `migrateAddTemplateUniqueness.js` | index created |
| `migrateAddProjectTemplateDraft.js` | `doc_template_id`, `brief_summary`, `brief_writer_prompt` added |
| `auditDriveUrls.js` (read-only) | 0 rows across all four url columns |

A matrix has since been built and drafted end to end on tenant `T0B8LPRDKHR`.

The code's pre-migration tolerances still stand and are still correct — a
project row created *before* `migrateAddProjectTemplateDraft` has NULL in those
three columns, so `resolveProjectTemplate` still returns `unlinked` for it and
still names the script. That is a row-age condition now, not a deployment one.

## The review overlay's wording lives in two places — keep them in step

The web review overlay renders `{ hadCopy, status, digest }`. Two functions
produce that shape for two different documents, and **they duplicate the
wording rather than sharing it**:

| | Produces the shape for | Lives in |
| --- | --- | --- |
| `qualitativeStatus` + `buildDigest` | the **copy doc** | `services/copyReview.js` |
| `reviewProjectTemplate` | a **template document** | `core/pipeline.js` |

Duplicated between them: the flagged/reviewed ratio thresholds **0.25 and 0.6**,
and the four sentences they select — "Nothing to review yet." / "Looking strong.
✨" / "A few things to tighten." / "Worth another pass." / "Some rework to do." —
plus the digest's "Reviewed N fields: X clean, Y with a note" shape.

**Changing one means changing the other.** Nothing enforces it: the two are
reached by different code paths and neither test reads the other's strings, so a
reworded copy-doc digest will silently leave the template document speaking the
old language on the same overlay.

It was left duplicated on purpose. Sharing it would mean either exporting two
private helpers from `copyReview.js`, or having `core/pipeline.js` require
`services/copyReview` — a dependency it does not have today — for four strings.
**A third document type is the moment to extract them**, into something both
sides import; until then the cost of the indirection is higher than the cost of
this note.

## Gotchas

- The service account is a separate Google identity — it can only access Drive
  resources shared with its `client_email`. Most Drive/Docs "permission" errors
  trace back to a folder not shared with it.
- **Two write paths for Drive/Docs, decided by `GOOGLE_REFRESH_TOKEN`:**
  - *OAuth2 (token set):* writes run as a real Gmail user via OAuth2. This is
    the fix for the service account's `storageQuotaExceeded` — service accounts
    have ~no personal Drive quota, so docs they *own* fail to create.
    `DRIVE_FOLDER_ID` is a normal My Drive folder owned by that user.
  - *Service account (token unset):* `DRIVE_FOLDER_ID` must be on a **Shared
    Drive** (files owned by the drive, not the SA, so no quota hit), with the SA
    added as a member. `drive.files.create` already passes
    `supportsAllDrives: true`.
  - Per-tenant OAuth (`getClientsForTenant`) is a third path layered on top:
    each tenant can have its own Google refresh token in Postgres.
- Slack button `value` is capped (~2000 chars) — keep it to the doc id only;
  rely on doc re-parsing for everything else.
- Folder routing **never trusts Gemini's `folderId`** — it truncates long Drive
  ids. `pipeline.extractBriefFolderId` re-reads the raw brief text with a
  deterministic regex and overrides it.
- `requireAdmin` returns **404, not 403**, on every failure — deliberately, so
  the route's existence isn't confirmed to a non-admin. Don't "fix" it to 403.
- `GET /admin/test-spec` is deliberately **public**: the detector fetches it over
  HTTP with no session. It serves only fake seed data.
- Web jobs are in-memory. A restart loses them, and the client gets a 404 from
  the status poller — that's the expected path, not a bug.
- Do not commit `.env` or the service-account JSON (see `.gitignore`).

## Asset library (Postgres)

Asset specs live in **Postgres** — `asset_types` + `copy_fields`, per tenant,
read via `db/assets.js` `getTenantAssets`. This is the single source of truth;
the Google Sheet (and `services/sheets.js`) has been **fully retired** — that
file no longer exists. A new tenant is seeded from the bundled default library
(`src/data/defaultAssets.js`) on install. **Postgres is mandatory** —
`pipeline.generateDoc` throws if a tenant has no asset library (no DB / unseeded).

Stale-comment warning: several files still mention "the Sheet" in comments
(`services/gemini.js`, `destinations/googleDocs.js`, `destinations/docBuilder.js`,
`core/pipeline.js`, `config.js`, `google.js`). Those are historical notes about
where a value *used* to come from, or about Postgres columns the Sheet once had.
There is no Sheet read path in the code.

Fields are read **dynamically** from the tenant's library —
`pipeline.tenantAssetsToSpecs` converts rows into the grouped spec shape, draft
copy is generated per field by name, and `parseDoc` recovers fields from the doc
via the bold-label-ending-in-`[limit]` pattern. **Nothing hardcodes field names
or field counts**, so adding, renaming, or reordering fields means editing the
`asset_types` / `copy_fields` rows (or the default library + reseed) — no code
change.

**Names are unique per tenant, and Postgres enforces it.**
`scripts/migrateAddAssetUniqueness.js` adds two unique indexes —
`asset_types (tenant_id, name)` and `copy_fields (asset_type_id, field_name)` —
**folded through the same normalizer `src/utils/normalize.js` applies**, via an
IMMUTABLE `quillio_normalize_name(text)`. Functional, not raw-text, on purpose:
`Nurture Email` and `nurture  email` are two rows to raw text and ONE asset to
`tenantAssetsToSpecs`, so a raw-text UNIQUE would permit exactly the duplicates
that break it. That normalizer is now the ONLY one — `db/assets.js` `normName`
and the local copy inside `gemini.js` `parseBrief` were folded into it. If you
change `normalize()`, the migration's derived character classes must change with
it; a smoke test recomputes them and fails if they drift.

The Dynamic Email block is ordered: Subject Line 1, Subject Line 2,
Pre-header, Headline (Offer 1) [50], Offer Body 1, CTA Text (Offer 1),
Headline (Offer 2) [50], Offer Body 2, CTA Text (Offer 2).

## Craft and brand voice (`craft.md` + `voice.md`)

Two repo-root markdown files, both loaded once at startup by `gemini.js` and
injected into every draft and review prompt as two clearly labeled blocks:

| File | Answers | Replaceable by a tenant? |
| --- | --- | --- |
| `craft.md` | **How good copy works** — universal craft: headline/body/CTA principles, the approved CTA library, character discipline, the universally weak phrasing to cut (filler, throat-clears, hedges), and the per-medium sections | **Never.** It always loads, for every tenant. |
| `voice.md` | **How this company sounds** — brand voice attributes, this brand's own vocabulary (the questionnaire's "Words That Work" / "Do Not Use" shape), mechanics | Yes. A tenant's saved guide in Postgres replaces it entirely. |

The split exists because a tenant's onboarding-generated guide is brand-only: if
it replaced one combined file (as it used to), completing onboarding silently
dropped the CTA library, character discipline, and all per-medium guidance from
every prompt. `buildCraftContext()` always reads `craft.md`;
`buildBrandContext()` reads the tenant guide, else `voice.md`; `brandVoiceLines()`
emits both. In the prompt hierarchy, craft governs **structure**, brand wins on
**voice** conflicts, field Tone Notes win for their field, and character limits
always win.

Per-asset creative direction still comes from Postgres `asset_direction`. HTML
comments are stripped; a file with only headings/comments (an unfilled
placeholder) injects nothing. Edits to either repo file take effect on
restart/deploy.

**Editing `craft.md` — mind the structural coupling.** To save tokens,
`gemini.js` slices it per asset: everything *except* the
`## … Writing Across Mediums` section is treated as universal craft and always
injected; that section's `### ` subsections are the per-medium parts, and only
the one matching the asset is injected. (Copy review spans several assets, so it
gets the *union* of their mediums.) Two things the parser keys off: (1) a
level-2 heading whose text contains **"Writing Across Mediums"**, and (2) its
`### ` subsection titles, matched by keyword in `mediumKeywordsForAsset`
(`paid social`, `organic social`, `google display`, `email`, `sales`,
`confirmation`). If you rename that heading or those subsections, update
`mediumKeywordsForAsset` too — otherwise it safely falls back to injecting the
whole file (more tokens, no lost guidance). Keep the CTA library and the
words-to-cut list *outside* the mediums section so they stay universal. The same slicing is applied to a tenant
guide that happens to carry its own mediums section; a typical one has none and
passes through whole.

## What goes on the LiveSpecs watch list — and what doesn't

`spec_watch_list` feeds the detector (`services/specDetector.js`), which fetches a
page, normalizes it and compares a hash. It exists for pages that publish
**platform limits**: Meta's ads guide, LinkedIn's ad specs, X's creative specs,
Google Ads' responsive display specs, Litmus's truncation numbers. Those pages
change when the platform changes a limit, which is exactly the event worth waking
someone up for.

**Research citations do not go on the watch list.** Constant Contact's newsletter
length study, Gong's cold-email analysis, academic papers — these are cited in
`copy_fields.spec_source` and rendered in the doc, but they are never watched. Two
reasons, and the second is the one that bites:

1. A published finding does not change. The study measured what it measured; if
   someone runs a better one it will be at a different URL, and noticing that is a
   human judgement, not a hash comparison.
2. The detector is a fetch-hash-compare over rendered content, so it fires on any
   layout tweak, nav change or A/B test the publisher ships. A marketing blog
   redesigns far more often than a platform changes a character limit — the queue
   would fill with diffs that mean nothing, and a review queue nobody trusts is
   worse than no review queue.

So: if the page states a limit the platform enforces, watch it. If the page reports
what someone measured, cite it and leave it alone.

### Every watch entry asserts an anchor before it compares hashes

`fetchText` only throws on a non-2xx or a timeout, so a **200 that isn't the page**
— a soft-404, an auth interstitial, a JS shell with nothing rendered server-side —
used to flow straight down the success path. Its normalized text hashes to
something stable and the entry reported "unchanged" every week, confidently and
forever. On a *first* run it was worse: `sha256('')` became the legitimate
baseline and every later run agreed with it.

So `spec_watch_list` carries three columns
(`scripts/migrateAddSpecAnchors.js` — **not yet run in production**):

| Column | Means |
| --- | --- |
| `expected_content` | the string that must be present for the fetch to count as a read. NULL = unanchored |
| `anchor_scope` | `normalized` (default) or `raw` — WHICH body to search |
| `consecutive_failures` | reset to 0 by every successful read |

`checkAnchor` runs **before any comparison branch**, and a miss is status
`'failed'` — distinct from `'error'`, which means the page could not be reached.
A failed read never advances `current_hash` and never flags. A source-order test
guards the position, because moving the check below `if (!row.current_hash)`
restores the empty-baseline bug while every behavioural test still passes.

Scope is per row because both choices are wrong for some page: `normalize()`
strips `<script>` **and its contents**, so an anchor living in a JSON island
vanishes from a perfectly healthy page — and raw HTML carries every nav label, so
a generic anchor survives on an error page sharing the site's chrome.

**Unanchored is neither a pass nor a failure.** The entry is still fetched,
hashed and compared; the run reports `anchored: false` per result and counts
`summary.unanchored`, which is a separate axis from `status` (an entry can be
unanchored *and* unchanged, and both facts matter). Every existing row is in that
state until the migration seeds it.

### What is anchored, what isn't, and why — the state after --verify

The candidates were chosen without seeing the pages (this repo denies egress to
those hosts) and then measured with
`node scripts/migrateAddSpecAnchors.js --verify` from somewhere with egress.
Four survived. The other three are each a **decision**, recorded on the candidate
row in the migration so nobody re-proposes a rejected string:

| Row | State | |
| --- | --- | --- |
| LinkedIn single-image | seeded | `Introductory text`, 2x |
| X creative specs | seeded | `post copy:`, 9x — see the colon note below |
| Google responsive display | seeded | `Responsive display ads`, 5x |
| Test page | seeded | `Quillio Test Spec`, 1x |
| Meta ads guide | **unanchored by decision** | see below |
| Litmus subject line | **unanchored by decision** | see below |
| Litmus preview text | **unanchored by decision** | see below |

**X, and the colon.** Its first candidate, `Creative ad specifications`, came
from the URL slug rather than the page — the heading reads "Creative ad specs" —
which is the plausible-but-absent anchor `--verify` exists to catch. The seeded
anchor is the spec label attached to the limit we store, the analogue of
LinkedIn's `Introductory text`. Nine occurrences is not a mark against it: what
disqualifies a phrase is being **site chrome that survives an error page**, and a
spec label is the opposite of chrome. The trailing colon was **checked, not
assumed** — X puts it inside the bold, so `normalize()` leaves it adjacent. The
same anchor against `<strong>Post copy</strong>:` would normalize to
`Post copy :` and fail on a healthy page; if X ever moves the colon outside,
drop it. `Creative ad specs` stays on the row as a **recorded fallback**, not
seeded, and `--verify` measures it automatically if the stored anchor ever stops
matching.

**Meta.** The candidate was a raw-body check for the canonical URL fragment. It
was rejected because it asserts the *document was served*, not that the *content
rendered* — so it would pass on exactly the broken page the feature exists to
catch. An anchor that cannot fail is worse than none: it reports a guarantee it
is not providing. The row is **not removed** either; it carries 10 pairs in
`affected_fields`, which is the write gate, and deleting it leaves those fields
gated by nothing — the same trade as the LinkedIn Carousel gap. **Whether that
row belongs on the watch list at all is an open decision**, not one taken here:
Meta was retiered enforced → recommended, and this list is for pages publishing
enforced limits.

**Both Litmus rows.** Not a search for a better phrase — a blog post does not
change, it *ages*, so hash-diffing it measures the wrong variable and a working
anchor would only make that wrong measurement fire reliably. Anchoring them is
**blocked on the platform-enforced vs observed-practice split** (a `source_kind`
on the watch row), which is agreed and unbuilt. It is not blocked on finding a
string.

**Reading the verify output.** The detector matches exactly and
case-sensitively; the report adds a case-insensitive and a whitespace-flexible
count purely as diagnostics, because the two ways a well-chosen anchor silently
misses are a capital letter and a tag boundary. The gap a tag opens is before
*attached punctuation*, not between words, so a word-level check reports "absent"
on a page that plainly renders the label — that is why the flexible variant
allows whitespace anywhere inside the anchor.

### `unconfirmed` is the other silent, terminal status — and it has its own counter

A hash that moves is refetched once and only flagged if it reproduces. A change
that doesn't reproduce is `unconfirmed`: no flag, and `current_hash` is left
where it was. That is right for one-off noise and **wrong forever** for a page
that genuinely changed *and* varies per request — it reports `unconfirmed` every
week and never surfaces the change. Until `migrateAddUnconfirmedTracking.js`,
the branch also cleared `last_error` and reset `consecutive_failures`, so such an
entry read as perfectly healthy.

| Column | |
| --- | --- |
| `consecutive_unconfirmed` | runs in a row with no usable comparison |
| `last_unconfirmed_reason` | `page varies per request`, or `refetch failed: <reason>` |

**Two counters, not one, because the reset rules differ.** An `unconfirmed` run
is evidence the URL and anchor are fine — we read the page, twice — so it
**clears** `consecutive_failures`; sharing one field would make it increment what
it ought to clear. A `failed` or `error` week says nothing about whether the page
holds still, so it leaves `consecutive_unconfirmed` **untouched** — neither
incrementing nor resetting. An entry that goes unconfirmed twice, errors for
three weeks, then unconfirmed again reads 3, and 3 is the true answer.

`UNCONFIRMED_STREAK_ALERT = 3`: one is the confirm step working as designed, two
is two bad Mondays, three is a month with no usable comparison. At the threshold
the entry is counted in `summary.stuck` and its health row turns red. The streak
is **shown from 1 upward** — the alert is what waits for 3, so a row climbing
1 → 2 is visible on the way rather than appearing fully formed after a month.

`summary.stuck`, like `summary.unanchored`, is a separate axis and not a status:
an entry is `unconfirmed` *this run* and stuck *for a month*, and both matter.

The health table's error column is now **Problem** and renders whichever applies
— `last_error`, else the streak and its reason. One column because a reader asks
it one question; two counters because the code branches on them.

### Changing `normalize()` re-baselines every affected page — plan for it

`normalize()` hashes the whole page, so any change to it changes the hash of
every page it affects. On the next run those entries report `changed`, the
refetch **confirms** (the new normalizer is deterministic, so it reproduces
perfectly), and the queue fills with review flags for spec changes that did not
happen. This applies to the selector-scoped work, and equally to the one-line
fixes that look free — e.g. stripping `<!--…-->` properly before the tag strip.

Two ways to handle it, neither of which is "just ship it":

1. **Suppress flags on the first run after the change** — re-hash and store
   without comparing, so the new normalizer establishes its own baselines.
2. **Re-baseline every row deliberately** — clear `current_hash` for the
   affected entries before deploying, so they take the `baseline` branch, which
   already writes without flagging.

(2) is less code and reuses a path that exists; (1) is safer if the change lands
in a deploy nobody is watching. Either way it is a decision to take *with* the
normalizer change, not after seven false flags.

### `affected_fields` is a snapshot, and nothing refreshes it

`spec_watch_list.affected_fields` was computed **once**, when
`scripts/migrateAddSpecTables.js` ran — `affectedFieldsWhere()` took the DISTINCT
`(asset, field)` pairs across all tenants whose `spec_source` is that platform
URL, and stored them as JSONB. Nothing recomputes it. There is no code path that
updates it when the asset library changes.

It is also the **write gate**. `services/specReview.js` `guardEdits` refuses any
edit whose `(asset, field)` pair is not in that array, so this frozen snapshot
decides what LiveSpecs is allowed to touch. Two consequences, and neither
announces itself:

- A field **added** to a watched asset after that migration ran is outside the
  gate. The detector still fires on the page, but the new field cannot be
  approved through the queue — silently, with nothing naming it.
- A field whose asset is later **retired** stays inside the gate.

Neither is firing today. The six asset types retired in `f3683f4` are all
`house_default` / `quillio_default`, so no field of theirs was ever in any watch
entry's `affected_fields` — that is the shape of the data, not a guard in the
code.

**If you change the library in a way that touches a tiered field — adding one to
a watched asset, retiring one — re-derive `affected_fields` for the affected
watch rows.** `scripts/rederiveAffectedFields.js --only=<id>` does one entry
(dry-run by default). It re-derives a **platform** entry from
`cf.spec_source = source_url`, plus `AND at.is_active`, which
`affectedFieldsWhere()` does not carry — that function predates `b2e13f2`, and
without the predicate the script would write pairs `specReview` cannot reach.
It refuses an empty derivation (that means the entry's URL is stale, not its pair
list), the `is_test` row, and the two note-derived Litmus rows, whose rule is
matched on `spec_note` text and is not implemented there.

There is deliberately **no `--all`**. On the July 2026 data, re-deriving the
LinkedIn entry would *lose* its six carousel pairs and the X entry would *gain*
`Organic Social — Twitter/X / Post Copy`; both are decisions to take with
dry-run numbers in hand, not side effects of a loop.

**Re-deriving repairs one entry at one moment — it does not fix the class.** The
snapshot re-freezes the instant it writes. And the worst case is not repaired at
all: a field **added** to a watched asset after the snapshot is outside the gate,
produces no error (nothing attempts a write, so the zero-row guard never fires),
and is invisible to `scripts/auditWatchList.js`, which checks that every pair IN
an entry resolves, not that every field that SHOULD be in one is there. Nothing
in this codebase detects it.

### The durable fix is an open decision — two options, both with a real cost

Not chosen yet. Framed here so it is inherited rather than rediscovered.

| | What it means | What it costs |
| --- | --- | --- |
| **Resolve by asset id** | `affected_fields` stores ids, not names, so a rename cannot orphan an entry | `affected_fields` is **global** (no `tenant_id`, deliberately — platform specs are universal) while `asset_types.id` is **per tenant**. There is no single id for an asset name, so this needs the watch list to go per-tenant, or id arrays, or a canonical asset registry — a schema change with its own migration. It also touches two documented invariants: the write's deliberate absence of a tenant predicate, and `db/assets.js`'s seeded/read-only rule, which is derived from the NAME precisely because the name is what LiveSpecs reaches by. |
| **Derive the gate live** | `guardEdits` computes the allowed pairs at write time instead of reading stored JSONB | Kills all four staleness modes outright, including the added-field one nothing detects. But the gate stops being a stable, auditable list and becomes **only as trustworthy as `spec_source`** — editing a `spec_source` would silently widen what LiveSpecs may write, where today widening it takes a deliberate re-derive. |

Whichever is chosen, `rederiveAffectedFields.js` becomes redundant rather than
wrong; it is a repair for the state we are in, not a design.

### Known gap: LinkedIn Carousel is watched by nobody

`business.linkedin.com/advertise/ads/sponsored-content/carousel-ads/specs` is
cited by six **enforced** `copy_fields` rows (`migrateSpecIntegrityFixes.js`
repointed them there, correctly — the single-image page does not carry the
carousel's numbers) and it is on **no** `spec_watch_list` row. So a change to
LinkedIn's carousel limits is never detected.

Nothing is broken today: those six pairs are still inside the LinkedIn
single-image entry's frozen `affected_fields`, so they resolve and can still be
approved — through a flag raised by the wrong page. Re-deriving that entry would
drop them and turn a wrong gate into no gate, which is why `--only` exists and
why the carousel entry should be **added** before that entry is ever re-derived.

## Vision & roadmap

`ROADMAP.md` and `docs/` hold product intent and historical build plans. They
describe **intent, including work that was never built or was later removed** —
they are not a description of the current code. Use them for the "why"; verify
the "what" against the source. The live character limits actually enforced come
from the Postgres asset library, not from any table in a doc file.
