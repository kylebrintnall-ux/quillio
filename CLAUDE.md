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

- `specTypeLine(specType, sourceName, detail, overridden)` turns `spec_type` into
  the italic tier sentence under a field label — "Platform limit (LinkedIn). Stay
  within this count." for `enforced`, "Recommended by …" for `recommended`,
  "House default — set your own in Settings." for `house_default` (or
  "House default — yours, set in Settings." once the tenant has), and **nothing
  for null**.
- **`house_default` and null are no longer the same thing.** They rendered
  identically for as long as neither could be acted on; the house-default editing
  work made the difference load-bearing, because null is what every
  tenant-authored field carries (`createAssetType` never writes `spec_type`) and a
  custom field has no house default to be told to go and set.
  `scripts/migrateBackfillSeededSpecType.js` exists to stop a long-lived tenant's
  bundled fields sitting on the wrong side of it — see "House defaults" below.
- `specSourceName(specSource)` maps `spec_source` to a display platform name.
  `quillio_default` and anything unrecognized return `null` — the raw
  `spec_source` string is **never** printed.
- `fieldHint(field)` composes `spec_note` + the tier line into one paragraph and
  returns `{ text, links }`, where `links` carries the **clickable citation**:
  the platform name is hyperlinked to the field's `spec_source` URL. A separate
  `NOTE_SOURCE_LINKS` table hyperlinks hand-written note credits (e.g. "Litmus").

So changing `spec_type` or `spec_source` changes what writers see in the doc.
Treat both as user-visible.

**The house-default sentence is stripped before drafting.** `parseDoc` recovers
the italic line into `field.notes`, which is prompt input and nothing else — it
becomes the field's `Field guidance:`. "Set your own in Settings" addresses the
tenant, not the writer, and on 144 seeded fields it would be the only guidance
most of them carry. `stripHouseDefaultLine` removes both wordings at the point of
recovery, in the same module that composes them, so the doc shows the line and no
prompt ever contains it. The enforced/recommended lines are **not** stripped:
those are real constraints on the writing.

## House defaults are the tenant's — what that unlocked, and what it did not

`db/assets.isSeededAssetName` says which **assets** are structurally off-limits;
`isTenantEditableTier` says which of their **fields** a tenant may put their own
number on. Both are needed, and they answer different questions:

| | Bundled (seeded) asset | Tenant-authored asset |
| --- | --- | --- |
| name, group, creative direction | locked | editable |
| field list (add / remove / rename / reorder) | locked | editable |
| `field_type` (chars vs words) | locked | editable |
| `spec_type` / `spec_source` / `spec_version` | locked | never settable by anyone |
| `char_min` / `char_max` / `spec_note` on an **`enforced`** or **`recommended`** field | locked | n/a |
| `char_min` / `char_max` / `spec_note` on a **`house_default`** or **null-tier** field | **the tenant's** | editable |

The structural half stays locked for the reason it always was:
`services/specReview.js` updates `copy_fields` by asset NAME with no tenant
filter, so a renamed seeded asset silently stops receiving platform-limit updates
while its doc keeps rendering "Platform limit (LinkedIn)" beside a stale number
with a live citation link. That is a fact about the NAME and the FIELD LIST. It
says nothing about a house-default number, which no platform publishes.

**The tier gate is an allowlist — `{ null, 'house_default' }` — not two `!==`
checks.** An unrecognised tier is locked, because a fourth tier would only ever
be added to carry some authority. Failing closed on the authority axis is the
point. It is decided from the **stored** `spec_type` inside `updateAssetType`'s
`FOR UPDATE` lock, never from the submission.

`updateAssetType(tenantId, id, asset, { mode })` takes `'full'` (the default —
unchanged refusal for a seeded asset) or `'houseDefaultsOnly'`. The reduced mode
against a tenant-authored asset is **also** refused (`reason: 'not_seeded'`):
silently dropping every rename and delete in the request and reporting success is
worse than saying no.

### The tenant's value lives in an OVERRIDE column, and this is the load-bearing part

`copy_fields.char_min_override` / `char_max_override` / `spec_note_override`
(`scripts/migrateAddHouseDefaultOverrides.js`). The **base** columns keep holding
the seed's value; the reads resolve `COALESCE(<col>_override, <col>)`.

This exists because a tenant's edit written in place would be erased by the next
seed-alignment migration. They match by asset name across every tenant with **no
tenant predicate and no value guard** — `migrateAssetSpecFixes.js:251`,
`migrateOrganicAndGraphicHeadlineSpecs.js:67`. The three carrying
`IS DISTINCT FROM` guards are no protection: that is an *idempotency* guard, so it
skips rows already holding the target value and rewrites precisely the rows whose
value differs — which is every row a tenant edited. `specReview.commitReview` is
the same story with a live trigger, and the two Litmus watch rows'
`affected_fields` already cover 15 `house_default` fields.

With overrides, **every past and future writer stays correct without knowing this
feature exists.** The alternative considered was a `spec_overridden_at` stamp plus
`AND cf.spec_overridden_at IS NULL` in every future value migration; that puts the
protection in a WHERE clause somebody has to remember to write, which is the same
class of silent failure as `affected_fields` going stale.

Three values that are **not** null and must stay that way: `char_min_override = 0`
means "no minimum", `spec_note_override = ''` means "the tenant deleted the note",
and `NULL` on any of them means "no override". Folding `''` to NULL would silently
restore a note the tenant removed.

`spec_overridden` is a three-column OR, **not** "does the effective value differ
from the seed" — a tenant who deliberately re-typed Quillio's own number has
overridden it, and a later seed change must not drag them along.

**`specReview.currentValues` reads the BASE column, and that is correct** — the
LiveSpecs preview is about the spec `commitReview` is going to write, which is the
base row. The consequence to know: for a tenant who has overridden a field, the
admin's before/after and its `tenantValueBreakdown` describe a number that tenant's
docs are not rendering. Nearly moot today (LiveSpecs only ever flags
`enforced`/`recommended` rows in practice), and left alone rather than "fixed":
making the preview show effective values would misdescribe the write.

### House rule for any future migration that writes a spec VALUE

Guard on the value you expect to replace, the way
`scripts/migrateFixLinkedInIntroText.js:48` does:

```sql
AND cf.char_max = 600
AND cf.spec_note IS NULL
```

It touches only rows still holding the exact old value. The override columns
already make this unnecessary for a tenant's own numbers — that is the point of
them — so this is belt and braces, and it costs one clause. It also protects the
case overrides do not: a row some *other* migration moved, which a blind rewrite
would silently take back.

### Where it surfaces

- **The doc.** The italic line under a `house_default` field says so. Deliberately
  not an onboarding step: onboarding is where people are lost, and a wall of spec
  fields in front of someone who has not seen the product work assumes they have
  house numbers written down. They meet it at the moment they disagree with a
  number, which is when a setting actually gets adopted.
- **Settings → Asset library.** A bundled asset with at least one house_default
  field gets a **Set limits** button (`houseEditable` from the server) opening the
  reduced form in its own card. Locked rows are **present but carry no controls** —
  they render their value the way the read-only card does. The row stays (the
  paid-social assets are mixed, and a form showing half a field list reads as
  broken); the *inputs* go. Drawn as disabled inputs at 0.6 opacity they still read
  as enabled on a phone, so the first thing a tenant did on an enforced field was
  tap a control that could never accept anything. `field_type` on an *editable* row
  does render **disabled rather than omitted**, styled inert (no chevron, flat
  fill): the server ignores it on this path, and a control that accepts input the
  server discards is the failure this panel keeps refusing.
- **Only rows the tenant TOUCHED are sent.** The form posts a row only once its
  inputs have fired, and drops the request entirely when nothing changed. Posting
  every rendered row wrote an override to every house_default field of the asset —
  each equal to the seed's own value, so nothing looked different — and silently
  detached all of them from future seed updates. That is the failure the override
  columns exist to prevent, arriving through the front door. The server already
  reads an absent value as "leave it alone"; this is the client keeping its side.
- **`counts.editable` did not change meaning.** It still counts assets that open
  the *full* form. The new state travels in `counts.houseEditable`. A stale client
  reads the old key to mean what it always meant.

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

### The case that justifies that rule — not a hypothetical

The house-default form (`libOpenHouseForm`, `settings.html`) shipped a defect
that **passed 558 green tests** and was caught in the first minute of a browser
pass. It posted every row it rendered, so changing ONE number wrote an override
to every `house_default` field of the asset. Each override equalled the seed's
own value, so nothing on screen looked wrong — the card grew three "Yours" chips
instead of one — while all three fields silently detached from every future seed
update. The server said `3 changed` for a one-field edit. That is the exact
failure the override columns exist to prevent, arriving through the front door.

Two more from the same pass: locked rows drawn as disabled inputs at 0.55
opacity read as **enabled** on a phone, and the disabled unit `<select>` read as
a dropdown failing to open.

None of the three was reachable by a source scan, because none was a question
about what the source SAYS:

| The defect | What a string test can see | What it took |
| --- | --- | --- |
| posts every row | nothing — the bug is a missing condition | run the save and read the DB |
| dimmed reads as enabled | the CSS rule is present and correct | look at it at 390px |
| inert control reads as broken | the `disabled` attribute is set | look at it |

So the rule is not "browsers catch more". It is that a source scan can only
answer *is this line present*, and the three questions worth asking about a form
are **what does it send**, **what does it look like**, and **what does the
database hold afterwards**. Ask those three, in a browser, against a real
Postgres. `git log` for the device-pass commit has the exact setup — the schema
scripts, the seed, a `connect-pg-simple` session row and a signed cookie — which
takes about five minutes to stand up and is worth it for anything that writes.

A structural test added AFTER a browser finds something is a tripwire, not
coverage. Label it as one where you write it, so the next reader does not mistake
a green suite for a working page.

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

**The house-default work's migrations have run** (2026-08-05):

| Script | Result |
| --- | --- |
| `migrateAddHouseDefaultOverrides.js` | 3 columns added, 437 `copy_fields` rows, 0 overrides set |
| `migrateBackfillSeededSpecType.js` | nothing to do — 47 NULL `spec_type` rows, **all on tenant-authored assets**, correctly left alone |

The backfill finding zero bundled rows to tier is the good outcome, and it
settles a question the squashed history could not: production ran
`migrateAddCopyFieldSpecType` **after** the three field-inserting migrations
(`migrateAssetSpecFixes`, `migrateAddSubheadField`, `migrateAddGraphicCopyGroup`),
so the drift the script exists for never occurred here. The 47 remaining NULLs
are tenant-authored fields, which are NULL **by construction** — `createAssetType`
never writes `spec_type` — and must stay that way: a custom field has no house
default to be told to go and set. Re-running the script is a no-op and will keep
reporting those 47.

The script is worth keeping rather than deleting: it is the repair for a state
another tenant's database could still be in, and the guard if the three inserting
migrations are ever re-run against a database that has since been backfilled.

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

`getTenantAssets` returns the **effective** value per field —
`COALESCE(<col>_override, <col>)` — so a tenant's own house-default number is what
reaches the doc. See "House defaults are the tenant's" above for why the override
lives in its own column.

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

**The craft slice is per ASSET, never per FIELD.** `buildCraftContext(assetType)`
takes one argument and `mediumKeywordsForAsset` matches on the asset name alone,
so a LinkedIn Single Image Ad's Headline and its Intro Text get the **identical**
9,547-character block — and in the batch prompt they are in ONE call with ONE
copy of it. Verified, because it is a tempting and wrong explanation for any
"field X gets different guidance from field Y" observation: no slicing difference
can exist between two fields of the same asset. What genuinely differs per field
is the `Field guidance:` line (`fieldGuidanceFor`) and the field's own name.

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

### Per-field guidance: composed, not chosen — and absent from riffs

`gemini.js` `fieldGuidanceFor(fieldName, notes)` builds the `Field guidance:` line
both draft prompts emit. It **space-joins** the field's own note and
`builtInFieldGuidance(fieldName)`, note first — it does not pick one.

`notes` is not the `spec_note`. For a **template marker** it is
(`core/pipeline.js` passes `m.spec_note`), but for the **copy doc** it is the
italic line `parseDoc` recovers, which `fieldHint` composes as `spec_note` **plus
the `spec_type` tier sentence**. That is why this was `notes || builtIn…` and
wrong: a tenant writing a note, a migration adding one, or a re-tier to
enforced/recommended each silently deleted the built-in rule from every prompt
for that field. The two built-ins are Graphic Headline (sentence case) and
Subhead (do not echo the headline) — mechanics, invisible in the doc when they
stop being sent, and nothing errors. It never fired only because all 20 seeded
instances are `house_default` with a NULL note.

**Known gap — a copy-doc draft kept OVER its limit is invisible.**
`generateAssetDrafts` marks a field `unenforced` when the single-field rescue
fails or returns long: the draft is kept and written, but its limit was never
enforced. `core/pipeline.js` reads that flag and puts it in the **template**
path's summary ("N of the drafted are OVER LIMIT — the rescue failed").
`destinations/googleDocs.js` never reads it at all, so on the **copy doc** the
same condition reaches nobody — not the Slack card, not the web overlay, not the
project row. Same condition, surfaced on one document and silent on the other.
Not fixed; recorded so the asymmetry is not mistaken for the copy-doc path being
unable to produce it.

### The batch-failure rescue gets siblings — FIXED, with an ordering limit

`generateAssetDrafts` writes every field of an asset in ONE call so they can
reference each other. When that response fails to parse, `parsed` becomes `{}`
and every field falls through to `generateFieldDraft`, sequentially. That call
used to be passed no `siblings` at all, so a nine-field asset came back as nine
independently written lines — and nothing downstream could tell: every field
present, every field within its limit, `fieldCount` identical, completion card
identical, `[gemini] BATCH_PARSE_FAIL` in the log the only trace.

The rescue now builds siblings **per field, inside the loop**, from two sources:
`out` for fields already finished this pass, and `byKey` for fields not yet
reached. That second source is why it matters beyond parse failures — one field
missing or over-limit inside an otherwise-GOOD batch takes the same path and now
sees **all** its siblings.

**Measured with `scripts/cohesionAB.js`** (forces a batch failure, drafts the
same asset both ways, prints the copy side by side). What it showed:

- **BEFORE: five of nine fields said the same thing.** Both subject lines, the
  preheader and both headlines all reached for the strongest framing, because
  none of them knew another field had already taken it. That is the
  characteristic shape of independent drafts, not a length or quality problem.
- **AFTER: the fields divide the work.** Subject Line 1 states the problem,
  Subject Line 2 takes the benefit angle instead of restating it, and the
  Preheader *continues* the subject rather than paraphrasing it.

**The limit, and it is ordered.** On a TOTAL parse failure `byKey` is empty, so
only completed fields contribute: field 1 sees nothing, field 9 sees eight. The
symptom has a fingerprint — AFTER's *first* field reverts to the same generic
line the BEFORE arm produced over and over. In the recorded run AFTER's Subject
Line 1 ("Stop rewriting the same brief into six templates") differs from BEFORE's
Headline (Offer 1) by a single word. Later fields gain more than earlier ones and
the first field gains nothing. Fixing that would mean a second pass over the
early fields — more calls, for the rarest case; not done.

**What that measurement is, and is not.** `cohesionAB` forces a TOTAL parse
failure, which is both the RARE case and the only partially-fixed one. The common
case — one field missing or over-limit inside an otherwise-good batch — has a
full `byKey`, so the rescued field sees **all** its siblings and is not subject to
the ordering limit at all. **The recorded result is therefore a lower bound**, and
the case that actually happens more often is better than what the output shows.

**Division of labour is improved, not complete.** In the same run, AFTER's Subject
Line 2 ("Get hours of your week back…") and Headline (Offer 1) ("Get hours back
with…") still take the same benefit angle. Enough context to stop five fields
converging on one framing was not enough to stop two.

**Sibling context cannot help a 20–25 character field.** The CTAs came back
byte-identical in both arms. There are only so many ways to write a 20-character
CTA, and the constraint decides it before context can.

**The overlap metric was blind to the entire change**: mean shared content words
per field pair was 2.81 in both arms. Cohesion is not word reuse — a set coheres
by dividing the work, which is a *structural* property invisible to a lexical
count. `cohesionAB.js` prints the number labelled as a hint precisely because of
this; if you reach for a similar metric, expect it to miss.

Still true, and still the reason not to reach for the obvious repair first: **do
not add a tolerant parse.** `extractJsonArray`'s first-`[`-to-last-`]` trick has
no working object analogue for this shape — first-`{` to last-`}` on `{}{"a":1}`
returns the whole malformed string and fails identically. That repair needs
different logic ("the first non-empty JSON value in the response") and a real
sample from `BATCH_PARSE_FAIL` to write it against.

### Stating the floor works — measured, and the prediction was backwards

`scripts/floorAB.js`, run against production. Both arms go through the same code
path; the only difference is whether `char_min` reaches the prompt.

| | BEFORE (ceiling only) | AFTER (floor stated) |
| --- | --- | --- |
| Preheader `[85-100]` | 83, 60, 88, 82, 91 — median **83**, in-band **2/5** | 88, 87, 89, 92, 87 — median **88**, in-band **5/5** |
| Subhead `[40-90]` | 54, 85, 71, 69, 69 — median **69**, in-band 5/5 | 70, 70, 67, 75, 66 — median **70**, in-band 5/5 |

**The reasoning that predicted this was wrong, and the correction is the useful
part.** The expectation was that the Preheader would barely move — its 100
ceiling was already pushing it up — and that the Subhead would move, because
40-90 leaves room to be short. The opposite happened.

The `even a few characters short` clause did its damage **where the band left
LEAST room**, not most. Fifteen characters separate an 85 floor from a 100
ceiling, and the prompt spent its closing clause recommending the model spend
them. The Subhead's floor was never binding: the model writes a subhead around 69
unprompted, which is mid-band. **A nudge's cost is proportional to how little
slack the band has, not how much.**

**The side effect is the one to watch: the Subhead's SPREAD collapsed**, 54-85
(31 characters) to 66-75 (9). Stating both ends cut the distribution by two
thirds. In-band went 5/5 → 5/5 — nothing was fixed — and the punchiest line in
the run was the 54-character one that no longer appears.

So a band buys predictability and spends variance, and it spends it even on a
field that was already compliant. Worth holding in mind before adding a further
instruction that pushes the same way: **uniformity is the default failure mode of
an accumulating prompt**, and each individual rule looks free.

**This is the same measurement as the cohesion run's "economy", read from the
other side — and that is the thing to internalise.** Giving the rescue siblings
shortened Offer Body 1 from 89 words to 69 and Offer Body 2 from 42 to 31, which
was recorded above as a win: with the subject and preheader visible the bodies
stop re-establishing the premise. Stating the Subhead's floor cut its range by
two thirds, which is a loss. Both are the same event — more instruction or more
context, less variance in the output — and the sign is decided entirely by
**what the removed variance was made of**. Redundancy going is a gain; range
going is a cost. Nothing in either measurement distinguishes them, and no
in-band/out-of-band count ever will: the Subhead scored 5/5 before and after.
Only reading the copy told us the best line was the one that disappeared.

The practical consequence: **an A/B that reports compliance is not measuring the
thing that matters.** When adding an instruction, look at the spread and at the
extremes, not the hit rate — and read the line you lost.

**Known gap — `generateFieldVariations` receives no per-field guidance at all.**
Not the tenant's `spec_note`, not the built-in rule, not the tier line: `notes`
is absent from its signature, from `buildVariationsPrompt`, and from the
`googleDocs.js` call site. So **every riff/doorway prompt goes out with none of
it** — a riffed Graphic Headline has never been told about sentence case, and a
tenant's writing note reaches the first draft but not a single variation.

Deliberately **not** fixed alongside the compose change. Closing it alters what
every riff produces for every tenant, which needs its own commit and its own
before/after — where the compose fix was a provable no-op on current data. It is
a real gap, not a design choice; treat it as work waiting, not as settled.

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

### `source_kind`: not every cited source is hash-watchable

`spec_watch_list.source_kind` is `platform_enforced` (the default, and every
platform spec page) or `observed_practice`. An observed_practice row is **not
fetched, not hashed, not compared** — the detector reports it as `not_watched`,
a status counted in the run summary, and it can never produce a flag.

The two Litmus blog posts are the only observed_practice rows
(`scripts/migrateAddSourceKind.js`). **There is no authoritative email spec.**
Nobody enforces subject-line length — clients truncate — so email guidance is
observed best practice from a dated source, and hash-diffing a blog post measures
the wrong variable: the post does not change, it **ages**, while client behaviour
moves independently of it. On 2026-08-05 a single run produced 6 pending flags,
all Litmus, both pages having changed twice in that one run. A queue that fills
with noise teaches a reviewer to dismiss Litmus flags, and a reviewer who has
learned that will eventually dismiss a real one. Those 6 were dismissed in the
same transaction as the reclassification.

`not_watched` is a **status**, not a silent skip, for the same reason
`unanchored` is counted: a row absent from the run output is indistinguishable
from a row that fell off the list. It is also excluded from `summary.unanchored`
and from every hash-watch count on the health page — a row that is never fetched
cannot be "unanchored", and counting it would inflate a number that measures a
real gap on the rows it applies to.

**Six columns on an observed_practice row are permanently meaningless** —
`current_hash`, `last_checked_at`, `consecutive_failures`,
`consecutive_unconfirmed`, `expected_content`, `anchor_scope`. They are left as
they are rather than cleared, and the rows stay on a table they barely use,
because `affected_fields` — **the write gate** `specReview.guardEdits` reads —
lives on the row. Deleting the row leaves those 15 pairs gated by nothing, which
is the LinkedIn Carousel trade exactly. The admin health page renders those
columns as `n/a` / `not checked` for such a row so they are not read as current.

### "Checked", not "verified" — the distinction is load-bearing

The weekly run detects that a **source page changed**. It never re-reads the
number and never compares it to what is stored. **Nothing in this system verifies
a stored limit against its source on a schedule.**

So: say *checked*, everywhere, including for platform_enforced rows. "Verified"
reads better and claims something the mechanism does not do. If you find
"verified" in a user-facing string, that is a regression, not a style choice.

`copy_fields.spec_verified_at` is the trap. It is written by
`specReview.commitReview` (`spec_verified_at = NOW()`) on an approved edit and is
**SELECTed by nothing** — `getTenantAssets` lists its columns explicitly and that
is not among them. It reaches no doc, no settings panel, no admin view. Its
existence is not evidence that a verification date is shown anywhere.

The accurate description of what the system does: every limit is cited to its
source; platform spec pages are checked weekly for changes, with anchors on four
of the seven rows asserting the fetch read the right page; any detected change
goes to a human before a stored number moves; and email guidance is dated
observed practice that is never hash-watched.

### The 15 email fields have no AUTOMATED update path — accepted 2026-08-05

A consequence Kyle accepted when approving `source_kind`, recorded so it is not
rediscovered as a bug. The 15 `copy_fields` cited to Litmus (10 Subject Line
pairs + 5 Preheader, across the five seeded email assets):

- **No LiveSpecs path.** `guardEdits` only ever runs against a flag, and an
  observed_practice row never produces one. The gate survives in form and becomes
  unreachable.

That is the intended behaviour, not a gap to close: observed practice should
change when a human re-reads the source and decides it has moved, not when a
publisher ships a layout tweak. It is written down because "nothing updates these
fields" looks like a defect to anyone who meets it without this paragraph.

**There IS a tenant path now, and this paragraph used to deny it.** All 15 are
`spec_type = 'house_default'` — the Litmus URL is on `spec_note`, not
`spec_source`, which is `quillio_default` — so the house-default work makes them
settable in Settings like any other house default. That is consistent rather than
contradictory: nobody enforces subject-line length, so the number was always a
Quillio recommendation a tenant could reasonably disagree with. What stays true is
that nothing changes them *automatically*. A tenant setting their own writes an
override and leaves the base row for the hand-written migration to move.

**Watch this pair if `affected_fields` is ever re-derived.** Those 15 pairs sit in
the two Litmus watch rows' `affected_fields` (derived from `spec_note` text, see
`migrateAddSpecTables.js:129`), so `guardEdits` would permit `commitReview` to
write them — cross-tenant, no tenant predicate — if those rows ever produced a
flag again. They cannot today, because `source_kind = observed_practice` is
checked before any fetch. The override columns make that survivable rather than
merely unlikely: `commitReview` writes the base column, a tenant's value is in the
override, and the tenant's number wins either way.

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
