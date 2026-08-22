# CLAUDE.md

Guidance for AI assistants (and humans) working in this repository.

Everything here is meant to be verifiable against the code. If a claim in this
file disagrees with the source, the source wins — fix this file.

**AND WHEN A MECHANISM IS REPLACED, THE PROSE DESCRIBING IT HAS TO BE CHECKED,
NOT ONLY THE CODE THAT CALLED IT.** A rename breaks a caller loudly; it leaves
the paragraph explaining the old thing sitting there, correct-looking and false.

The instance, August 2026: a section here was named after `getCheckedSourceDates`
and every clause in it described what that function decided. The function had
been **deleted** two commits earlier when the design moved from a weekly-moving
date to a human verification event. Nothing broke. The section simply taught the
next reader a mechanism that does not exist, in a file whose whole value is that
it can be believed without re-deriving it.

That is the **stale strip constant one surface over** — same rule, and the same
reason it is silent. `VERIFIED_LINE` replaced `CHECKED_LINE` and the strip kept
running, removing a wording nothing wrote any more and missing the one still in
circulation. Code that reads something written earlier, and prose that describes
something built earlier, both outlive the thing they were written against, and
neither of them errors when it stops being true.

So a commit that replaces a mechanism greps this file for its name before it
lands. `git log -S` on the identifier is the cheap version.

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

## The one decision rule that recurs

**WHEN ONE FAILURE IS VISIBLE AND THE OTHER IS NOT, TAKE THE VISIBLE ONE.**

This file states it in four places and, until now, never said it was one rule —
so anyone meeting a fifth case had to notice the pattern rather than apply it.

| The decision | Made it visible | Made it invisible |
| --- | --- | --- |
| **The tier gate** is an allowlist `{ null, 'house_default' }`, not two `!==` checks | a locked field a tenant wanted is a support message | a fourth tier let through by default carries authority nobody granted |
| **The sweep's authority check** (`CORRECTABLE_TIERS`, `src/services/specSweep.js`) fails closed on the same axis | a document not corrected is a stale number somebody can still read | a document corrected on an authority the tier never carried |
| **The `''` guard** is narrow — over an absent base note only | nothing: there was no note to restore | a general fold silently restores a note the tenant deleted on purpose |
| **Clearing a redundant override** rather than keeping it | the tenant watches the number move and the "Yours" chip disappear | a field nobody pinned stays pinned, and no correction ever reaches it |

**What makes it a rule rather than a preference.** Recoverability is not about
which error is more LIKELY. It is about whether anyone will ever find out. A
wrong number a tenant watches change is a support message. A wrong number
nothing surfaces is permanent — and every one of the four above had an
invisible side whose cost does not decay, because nothing in the system ever
raises it again.

That is why "which is more probable" is the wrong question to open with. Two of
these four were decided against the more likely outcome: a tenant re-typing
Quillio's own number is rarer than the form having typed it, and a fourth
`spec_type` may never be added at all.

**THE DEPENDENCY, and it is the part a future case must check rather than
inherit.** The override-clearing argument works because the chip and the number
are *already rendered on the panel the tenant is looking at*. That is a property
of the surface, not of the reasoning. A decision with no visible surface does not
get to call its failure recoverable — the same choice would then be between two
invisible outcomes, which this rule says nothing about. Ask what the tenant would
SEE before deciding which side is the safe one.

Related but distinct: `requireAdmin` answering 404 rather than 403 is a
*confidentiality* choice (it refuses to confirm the route exists), not this one.
Do not merge them.

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
  pendingBriefs.js   Parsed briefs waiting on a human to confirm their asset
                     plan — the store, the pause rule and the plan validator
                     behind parse-then-confirm on BOTH surfaces.
  liveMessage.js     The two guards protecting the ONE Slack message a run owns
                     (delivery claim + release, keyed per run).
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
    app.js           /app + /api/brief[/confirm], /api/draft, /api/review,
                     /api/upload, /api/projects[/:id[/content]],
                     PATCH /api/projects/:id/status + the job-status pollers.
    settings.js      /settings + /api/settings/* (voice, workspace, folder) and
                     /api/auth/signout.
    headerTemplate.js /api/header[/extract] + /api/naming — doc-header and
                     file-naming onboarding.
    notifications.js /api/notifications (read) + /api/notifications/read
                     (mark read). Scoped from req.user only. See "Notifications".
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
    docTemplates.js  Tenant-uploaded template documents (save one, list a
                     tenant's, read one back). Deliberately thin.
    templateMarkers.js The confirmed fields of a template document — a name, a
                     limit, a unit, a note, plus the CELL it lives in.
    notifications.js Notification writes/reads + per-user read state.
                     Catches 42P01 and degrades to "no notifications".
    specWatch.js     LiveSpecs watch list / review queue reads.

  utils/
    normalize.js     Asset-name normalization (case, dash variants, spacing).
                     The ONLY normalizer — the migration's indexes derive from it.
    errors.js        clientErrorMessage() — safe, generic client-facing errors.
    variants.js      Numbered-stack / solo-label copy-variation detection.
    assetInput.js    The shape a TENANT may submit when creating an asset type,
                     and the only place that decides it. Pure.
    assetMatch.js    What we say when parseBrief could not map an asset name.
                     Shared by both surfaces so the wordings cannot drift.
    briefFacts.js    Does the brief state a fact this campaign cannot invent?
                     One class today (`datetime`). Holds the field note AND the
                     surface notice, so the two cannot drift.
    draftNotice.js   The sentence a finished draft is described with, plus its
                     structured link target. See "Notifications" below.
    instanceKey.js   Instance ordinals for the two composite identity keys
                     (ctxKey and copyReview's fieldKey).
    shellHtml.js     Reads + stamps the served HTML shells; `__BUILD__` is
                     replaced with the deploy commit so asset URLs version.

  services/
    gemini.js        All Gemini REST calls (parse, enrich, draft, variations,
                     voice guide, vision, header extract, copy review).
    slack.js         Block Kit builders + Slack Web API helpers.
    copyReview.js    Copy-review orchestration → UNANCHORED Doc comments, each
                     carrying its own locator. See "Review comments are
                     UNANCHORED" below — nothing here is anchored, or can be.
    templateReview.js Review a built TEMPLATE document. Not copyReview: neither
                     half of that transfers to a matrix.
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
                     admin.html + fonts/, assets/ (GIFs, logos, images), and
                     partials/nav.html — the one copy of the app/settings nav,
                     spliced in by renderShell at a `__NAV:<section>__` token.
                     Only fonts/ and assets/ are served statically.
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

  A field's provenance boilerplate collapses over a **run of three or more**
  adjacent fields with identical tier, cited page and verification date; the
  attribution and its citation link stay on every field. Three because a PAIR does
  not read as a group — the collapsed field sits between a full line belonging to
  a different field and whatever follows, so it reads as missing something rather
  than as the second of two. The seed holds runs of 1, 2, 4, 5 and 6 and **not one
  of exactly 3**, so 3 and 4 render identical documents today; the constant is an
  argument, not a measurement, and `MIN_COLLAPSE_RUN` says so.

  **AND THE HINT LINE IS LOAD-BEARING, WHICH IS NOT OBVIOUS FROM WHAT IT SAYS.**
  `parseDoc` takes the FIRST italic paragraph after a label as that field's
  `notes`, and the hint claims that slot. A field rendering NO hint line absorbs a
  writer's copy as notes instead — `runStyle` classifies a paragraph by its first
  non-empty run, so a line opening with an italicised word ("*Introducing* our
  new…") is italic to the parser. The copy then becomes permanent guidance:
  `insertIndex` advances past it, `deleteEnd` stays null, Regenerate never deletes
  it, and the next draft lands below it. Silent, and it survives regeneration.

  So **"render nothing" is not an available option for any field a writer drafts
  into**, whatever the argument for it. A shorter line is; an absent one is not.
  This is why the provenance run-collapse truncates the tier line to its
  attribution rather than emitting an empty hint. The exposed case exists today on
  tenant-authored fields with no `spec_note` — that population must not grow, and
  a test walks the seed to make sure it does not.
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
  | `addReviewComment(docId, { content }, clients)` | `copyReview` |
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
`FOR UPDATE` lock, never from the submission. (One instance of "The one decision
rule that recurs" — a locked field is a support message, an unearned authority is
not.)

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
restore a note the tenant removed — the twelve Litmus email fields are
`house_default` **and** carry a seeded note, so that is where it would land.

**One narrow exception, and it is not a fold.** Where the stored base `spec_note`
is NULL there is no note to delete, so `''` and NULL say the same thing and
`applyHouseDefaultOverrides` stores NULL. That cannot restore anything, because
there is nothing there. It is the *effect* being compared, not the value — the
same test `migrateClearRedundantOverrides` applies to all three columns. The
narrowness is "The one decision rule that recurs": a general fold's failure is a
restored note nobody asked for and nobody is told about, and this one has no
failure at all.

**And the reason any of this matters is not "the tenant's value".** An override is
a value **no future write can move**: every correction writes the BASE column by
asset name with no tenant predicate, and the reads resolve `COALESCE(override,
base)`. So a corrected spec — Meta's carousel headline, LinkedIn's carousel intro
text, both fixed this month — reaches every tenant *except* the ones holding an
override on that field, and nothing anywhere surfaces it. Correct for a number a
tenant chose. Pure loss for one written as collateral.

`scripts/migrateClearRedundantOverrides.js` clears an override whose EFFECT is
identical to its base, per column. That a deliberate re-type of Quillio's own
number is indistinguishable from collateral is stated in its header rather than
argued away — the rule that decides it is "The one decision rule that recurs",
and the visible side is that a tenant who loses a pin watches the number move and
the "Yours" chip disappear on the panel they are already looking at.

**It has RUN in production (`--commit`), and the result closes the question the
judgement was about.** One row, one column: `T0B8LPRDKHR` / LinkedIn Single Image
Ad / Graphic Headline, the phantom `spec_note_override = ''` cleared, and its
40/60 char overrides kept as genuine. `rows still holding an override: 1
(expected 1)`. **No other row in the database held an override at all** — so the
"clear versus keep" call, which was decided on the asymmetry of two failures
rather than on likelihood, turned out to touch exactly the one value that was
provably collateral and nothing a tenant had chosen. That is a good outcome and
it is not evidence the reasoning was unnecessary: the same rule would have been
needed if the count had been fifty.

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

### FETCH THE SOURCE PAGE IN THE SAME CHANGE. PASTE THE TEXT IN THE MIGRATION.

**No spec value is corrected without fetching the page it is cited to, in the same
change, with the fetched text quoted in the migration's header.** Not "check the
source", not "verify the number" — fetch it, and paste what it says, so the next
reader can check the claim without leaving the file.

This is the most expensive rule in this document to have learned, and it was
learned from one incident that produced *every wrong Meta number in the library*.

**`scripts/migrateSpecIntegrityFixes.js` (July 2026) was a migration whose stated
purpose was correcting numbers that "did not match the platforms' own published
specs".** It corrected Meta without ever fetching Meta. What it wrote:

| It claimed | Meta's page actually says |
| --- | --- |
| "Meta publishes 125 / 40 / 30" | 125/40 is the **Collection** format's pair. Single-image publishes 50-150 / 27, carousel publishes 80 / 20 / 18. **30 appears on no Meta page at all.** |
| "card headline 45 → 40 (45 is LinkedIn's carousel number, not Meta's)" | Right that 45 was foreign. Wrong about the replacement: the page says **20**. It corrected Meta by comparing against **LinkedIn**. |
| "card description 18 → 20 (18 matches no published Meta figure)" | The carousel page says **18**. It took a correct value and made it wrong, and wrote down a justification the page contradicts. |

Every cell is a *reasoned* number. Not one was *read*. The reasoning was careful,
internally consistent, peer-reviewable, and wrong — which is precisely why "be
careful" is not the rule and "fetch it" is.

**The citation is part of the value.** Both Meta assets cited
`.../ads-guide/update`, the ads-guide **index**: 2,208 normalized characters of
nav, marketing copy, a signup form and a language footer, containing no character
limit and stating outright that the guide "provides information on … character
limits and more" — the page telling you the specs are elsewhere. A number and a
link that cannot confirm it are one defect, not two, so **a value correction and
its citation ship together.** Correcting one and not the other leaves the document
self-contradicting for the length of the window.

**Removing the hazard is part of the fix.** A superseded migration's tables are
*writes*. Leaving Meta's entries in `RETIER` / `CHAR_FIXES` / `SOURCE_URLS` would
have silently reverted the correction on any re-run, so they were **removed rather
than corrected**, with the reason recorded in the file and asserted by a test
(`fix.CHAR_FIXES.length === 15`, no `facebook.com` anywhere in it). The same class
of hazard as the frozen `affected_fields` snapshot: a stale table nobody expects
to be authoritative, quietly still being authoritative.

`scripts/migrateFixMetaSpecs.js` is the shape to copy — the fetched text for all
four format pages sits in its header, and a test asserts those quotes are actually
present rather than trusting the comment to have been written.

**THE SAME STANDARD APPLIES TO A TEST THAT PINS A SPEC VALUE.** A test asserting a
number must cite the page text that number came from, in the same commit. Without
the citation it is not coverage — it is **a guard protecting whatever was there**,
and it fails the one person doing the right thing.

The instance, found August 2026 while correcting LinkedIn. `test/smoke.test.js`
asserted:

```js
assert.strictEqual(carousel.char_max, 600, 'LinkedIn Carousel Intro Text char_max stays 600');
```

600 appears on **neither** LinkedIn specs page. It entered as a bare assertion in
`migrateFixLinkedInIntroText.js` — "the others MUST stay 600 / null", no source —
and the test then pinned it. So anyone who opened the carousel page, read
"Introductory text: 255 characters" and corrected the value **would have been met
by a red test**, and the failure would have read *you broke the spec* rather than
*the spec was wrong*. The test was the last line of defence for the defect.

This is worse than an uncited migration, because a migration runs once and a test
runs on every commit forever. It converts an unverified claim into an
institutional one.

So: a test that pins a limit carries the quote beside it, or asserts the quote is
present in the migration that set it (`assert.match(src, /Introductory text: 255
characters/)`). A test that merely restates the seed is fine — that is a
consistency check between two files, and it should say so rather than look like a
statement about the platform. What is not fine is an assertion about the outside
world with nothing behind it.

The second half of the lesson is what to do when the value moves: the flipped
assertion **kept** the part that was right. `migrateFixLinkedInIntroText` was
correct that the two Intro Text fields are different fields with different
numbers, so `assert.notStrictEqual(carousel.char_max, sia.char_max)` replaced the
literal. Correcting a wrong pin is not a reason to delete the property it was
guarding.

**What this does NOT license:** inventing a number when the page has none.
`Meta Single Image Ad / Description` was stored at 30 and `/image` publishes no
Description recommendation, so the field kept its 30 and lost its **claim** —
demoted to `house_default` with the `quillio_default` sentinel, rendering "House
default — set your own in Settings." with no source named and no link. Deleting
the field would have removed a deliverable writers fill; assigning it a
sourced-looking number would have been the original defect with a fresh coat on.
The honest move when a page is silent is to say the number is yours.

### REPOINTING `spec_source` LEAVES THE OLD GATE HOLDING PAIRS IT NO LONGER DESCRIBES

The other half of a spec correction, and the half with no symptom. Changing a
field's `spec_source` is a one-line write that nothing else follows. In
particular it does **not** touch `spec_watch_list.affected_fields`, which is a
snapshot computed once by `migrateAddSpecTables.js` and recomputed by nothing —
so the OLD page's watch entry keeps listing the field, and its flags keep being
approvable for a field that is no longer cited to it.

**No test and no detection run will surface this.** `guardEdits` asks only
whether a pair is *in* the array; it never asks whether the array still describes
the page. `scripts/auditWatchList.js` checks that every pair in an entry still
*resolves* to a live row — which it does, because the field exists, it just cites
somewhere else now. The approve form renders, the write commits, the flag flips
to `reviewed`. Everything reports success.

**The case, and it is live.** `migrateSpecIntegrityFixes.js` repointed LinkedIn
Carousel's six enforced fields from the single-image page to the carousel specs
page in July, correctly — the single-image page does not carry the carousel's
numbers. It did not re-derive anything. Those six pairs are still in the
single-image entry's `affected_fields` today, so for a month they have been
approvable **through a flag raised by the wrong page**, and the page that
actually publishes their numbers was on no watch row at all until
`scripts/migrateAddLinkedInCarouselWatch.js`.

Meta's `Description` left its gate today only because the split re-derived from
`spec_source` at run time. Nothing in the system would otherwise have noticed
that a `house_default` field with a `quillio_default` sentinel was still sitting
in a platform page's write gate.

**So a change that repoints `spec_source` owns the gate too.** Either re-derive
the affected entries in the same change (`scripts/rederiveAffectedFields.js
--only=<id>`, dry-run by default), or write down that you did not and why. The
ordering is a real decision rather than a formality: re-deriving the old entry
DROPS those pairs, so if the new page has no watch row yet, the fields go from
gated-by-the-wrong-page to gated-by-nothing. Add the new row, let it produce one
clean comparison, then re-derive the old one.

There is deliberately no `--all` on that script — see the note under
"`affected_fields` is a snapshot" for why a loop over every entry would silently
gain and lose pairs nobody priced.

### How current a limit is: two facts, two surfaces, one module

A limit carries two different claims about its own currency, and they are
different KINDS of claim. `src/utils/specFreshness.js` composes both, so the
document and the settings panel cannot come to say different things.

| | | Where it renders |
| --- | --- | --- |
| **The human event** | `copy_fields.spec_verified_at` — a person opened the cited page and confirmed this number. Fixed, historical, true when written and true forever. | The generated **document**, because a document is a file and a date written into one is frozen at creation. Also the settings panel. |
| **The machine state** | `spec_watch_list` — when the detector last fetched that page and what it found. **Moves weekly.** | **Settings → Asset library only.** A surface that re-reads it every time somebody opens it. Never a document. |

`verifiedSentence` is the one composer of "Verified against LinkedIn's spec page
on 2026-08-20."; `destinations/googleDocs.js` delegates to it.

**"Verified" is right in that sentence and only there.** The rule against the word
— say *checked* — exists because the weekly detector compares a hash and never
re-reads a number, so "verified" would claim something the machine does not do.
That sentence is about a human who did read the page.

**The machine line WITHDRAWS; it is not a badge.** "We watch that page for edits —
not the number. Last checked 2026-08-19: no change." The first clause is the
content and the date is incidental — written the other way round, with a tick
beside it, it becomes the freshness badge the document sentence was in its first
version. A clean state gets no accent at all; only a non-clean one is marked.

Two of the eight states carry **no date**, and that is a fact about the detector
rather than a style choice: `bumpFailure` stamps `last_checked_at` on a FAILED
read too, so "we haven't been able to read this page since …" would name the last
time we *tried* and read as the last time we *succeeded*.

`spec_watch_list` has no `tenant_id` — platform specs are universal — so the
tenant view is a **detail** boundary, not an authorization one. What does not
cross: `last_error`'s text, hashes, `affected_fields`, and the `is_test` row.

### IT IS NOT A HEALTH DISPLAY, and that rests on the health check being RUN

**Every state on that screen is derived from STORED state. None of it reads the
cited page.** So a row watching the WRONG PAGE reports clean there forever.

That is the Meta-index defect exactly. That row reported `unchanged` every week,
with `last_error` null and both counters at zero, while watching a page with no
character limit on it — 2,208 characters of nav, marketing copy and a signup
form. It would have rendered "no change" with total confidence, on every one of
those weeks, about a page that could never have flagged.

What closes the gap is `scripts/checkSpecHealth.js` — it asks the structural
questions stored state cannot: does the hashed text contain the row's own
`char_max` values, is the anchor present in the hashed region today, does the
page vary between fetches, is a cited URL watched by anybody. **It is manual and
read-only by design, so the dependency is on somebody running it**, and the
fields carrying a verification date rest on that having been done.

**A status rendering on a screen does not make that dependency weaker.** It makes
it easier to forget, which is why the limit is written into
`src/utils/specFreshness.js` itself and asserted by a test, not left here alone.

Run it when a watch row is added, when a `spec_source` is repointed, and
periodically otherwise. If it is ever scheduled, a red run is the signal to
investigate — the date stays weekly and honest, and the structural check becomes
regular. Moving the date's source to the health check is the wrong fix and was
declined: it would have to write, which destroys the read-only property its own
test asserts, and a manual date is a worse date than a weekly one.

### OPEN QUESTION: are LinkedIn's nine `enforced` fields actually enforced?

**This is a question with two live answers, not a correction waiting to be made.**
Writing it as a pending retier would prejudge it — which is the same failure as
the original assignment, better documented. It is equally possible that LinkedIn
rejects above these numbers at ingest, the tier is correct, and the interesting
finding becomes why its pages call them recommendations.

The nine: `LinkedIn Single Image Ad` Intro Text 150 / Headline 70 / LAN
Description 70, and `LinkedIn Carousel Ad` Intro Text 255 / Card 1–5 Headline 45.
All render "Platform limit (LinkedIn). Stay within this count."

**Why it is open.** Both pages put those numbers under a heading reading **"Text
Recommendations"** — the same evidence that retiered Meta's ten in July. And
eight of the nine were tiered by the *same hand-written array* as Meta's, in one
commit, with no citation: `migrateAddCopyFieldSpecType.js`'s `const ENFORCED`,
23 pairs, of which **10 have since been found wrong**. `migrateSpecIntegrityFixes`
retiered Meta only — `grep LinkedIn` returns SOURCE_FIXES and FIELD_NOTES entries
and *zero* tier entries, so LinkedIn was never examined rather than examined and
kept. (The ninth, LAN Description, was promoted separately by
`migrateAddCopyFieldSpecTypeFixes.js`, which at least names its claim — "LinkedIn
Audience Network description, 70-char cap" — though it quotes no page.)

**Why a heading is not enough to act on.** The tier's own definition is
behavioural: "platform hard cap — over it the asset breaks / is rejected". A
platform can publish a number as a recommendation and still reject above it.
Meta's retier had more than a heading — it had the technical ceilings (255 for
headlines, far larger for primary text) that made "advisory" demonstrable. There
is no equivalent figure for LinkedIn; the 600 that might have served as one
turned out to correspond to nothing on any page.

**The cost of being wrong is asymmetric, and it favours leaving it.** Over-claiming
today costs a writer some craft — a shorter headline than they needed. Retiering
wrongly tells them 70 is "not a hard limit — adjust for your brand and goal", they
write 90, and LinkedIn rejects the creative at upload. Nothing here is a wrong
*number*; all nine limits are confirmed against their pages.

#### What bounds the decision — established by reading the code, and not obvious from outside

- **`spec_type` branches on exactly two things.** The rendered tier sentence
  (`googleDocs.specTypeLine`, and through `fieldHint` the drafting prompt), and
  Settings editability (`db/assets.isTenantEditableTier` → `routes/settings.js`).
  Nothing else in `src/` reads it.
- **A retier does not change what lands in a document.** `overLimit`,
  `trimCeiling`, the rescue ladder and the corrective rewrite all key on
  `charMax` and `fieldType` only. There is no hard trim for `enforced` and no
  soft one for `recommended` — the ladder is identical. (The `unenforced` flag in
  `generateAssetDrafts` means "the rescue failed and we kept it anyway"; it is
  unrelated to `spec_type` despite the name.)
- **A retier does not hand these numbers to tenants.** `TENANT_EDITABLE_TIERS` is
  an allowlist — `{ null, 'house_default' }` — so `enforced` → `recommended`
  leaves them exactly as uneditable as they are now.

#### IT IS A PROMPT CHANGE, NOT A WORDING CHANGE — and that needs its own measurement

The surprise, measured through the real `fieldHint` + `stripReaderOnlyLines`:

| tier | reaches the drafting prompt |
| --- | --- |
| `enforced` | `"Platform limit (LinkedIn). Stay within this count."` |
| `recommended` | `""` — stripped entirely |

The enforced sentence **survives** the strip; the recommended one is removed by
`RECOMMENDED_ATTRIBUTION` and `READER_ONLY_LINES` together. So retiering would
take **six of the nine** (the note-less ones) from one guidance sentence to none.

Both directions are arguable and neither has been measured. The limit still
reaches the model from `charMax` regardless of tier, and this file already flags
the enforced line as **redundant** with the "character limit 70 — stay within this
limit" bullet on ~9 fields — these fields — predicting flatness as a possible
cost. So removing it might improve the copy or might weaken adherence.

**Treat that as a separate question from the ingest one.** Even if LinkedIn turns
out not to enforce, the prompt effect deserves a before/after of its own rather
than riding along with a provenance correction.

#### What would settle the ingest question

**Campaign Manager, by hand** — open the creative editor, paste 200 characters
into a Headline field capped at 70, and observe: hard stop, a warning that permits
saving, or silent acceptance. That is a direct observation of ingest behaviour
rather than an inference from a heading, and it is the same test Google's
Responsive Display fields would pass (those are genuinely rejected at ingest,
which is what a correct `enforced` looks like).

Do it for one field of **each shape** rather than generalising from one — an
Audience Network description may enforce differently from an in-feed headline.

This needs a LinkedIn ads account, which nobody on the project had when this was
written. **It is recorded as the resolution, not as a next step** — it is here for
whoever has that access, whenever they turn up. The LinkedIn Marketing API's
advertising write scopes are believed to sit behind partner approval, so the API
is not a cheaper route; verify that before assuming it either way.

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
- **Only the VALUES the tenant touched are sent**, and only from a row they
  touched. Posting every rendered row wrote an override to every house_default
  field of the asset — each equal to the seed's own value, so nothing looked
  different — and silently detached all of them from future seed updates. That is
  the failure the override columns exist to prevent, arriving through the front
  door. The server already reads an absent value as "leave it alone"; this is the
  client keeping its side.

  **The row-level fix left the same defect one level down, and it took a database
  query to find.** `dirty` was per ROW, so a row posted all three of its values
  because one of them changed: editing a limit pinned the minimum and the note
  too. On a field the seed gives no note, the note collateral was `''` — from a
  collapsed textarea nobody opened — which is not NULL, so `spec_overridden`
  began reporting true and the doc began saying "yours, set in Settings" over a
  number nobody had set. Found on `T0B8LPRDKHR` / LinkedIn Single Image Ad /
  Graphic Headline: char overrides 40/60 genuine, `spec_note_override = ''`
  phantom. The flag is per value now (`touched`), and
  `scripts/migrateClearRedundantOverrides.js` clears what was already written.

  **The pair check moved to the server as a consequence, and moved WHOLE.**
  `normalizeHouseDefaults` is pure, so it could only compare `char_min` against
  `char_max` when both arrived — which the old form guaranteed. Now one can arrive
  alone, so `applyHouseDefaultOverrides` checks the pair against the values in
  force, resolving an explicit null to the SEED because that is what clearing an
  override does. The validator's copy was **deleted rather than kept**: two copies
  meant two sentences for one condition — a positional `Field 3: …` when both
  halves were touched, the field's own name when one was — so the tenant who
  edited more got the vaguer error. Each value's own range check stays in the
  validator, where it needs nothing but the request. Do not "fix" a future version
  of this form by sending both halves again: sending the untouched half is the
  defect.
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

## Notifications — the store behind "tell somebody later"

`notifications` + `notification_reads` (`scripts/migrateAddNotifications.js`,
**applied to production 2026-08-18**). Written by the web draft path, read by
`/api/notifications`. **Nothing renders it yet** — rows accumulate with no
surface reading them, which is the intended state, not a gap.

**Why it exists.** A web draft runs 30-90s behind an in-memory job the browser
polls every 3s. On completion the only thing that ever happened was a
**two-second toast in the tab that started it**. Close the tab, background it
past the timers, or restart the server, and the draft still finishes and still
writes the Doc — and the person is told nothing, ever. The Slack surface has
posted a completion card since it was built; this is the web equivalent, stored
rather than pushed.

### Read state is PER USER, but the notification is PER TENANT

One row per tenant EVENT in `notifications`; read state per person in
`notification_reads`, where **absence IS unread**. The alternative — one
notification row per user with `read_at` on it — is one table and a simpler
query, and was rejected for a reason that is a fact about this codebase rather
than a preference:

**The write path cannot reliably enumerate a tenant's users.** Fanning out needs
`SELECT id FROM users WHERE tenant_id = $1` at draft-completion time, and in demo
mode `middleware/auth.js` attaches `{ id: null }` while `resolveTenant` returns
`user: null` — so there is no key to write against, and a demo draft would
produce **zero** notifications, silently, inside the very catch that keeps a
notification failure from failing a draft. The tenant is always available; the
user is not.

Two more, both supporting: the product's visibility model is **already
tenant-scoped** (`getProjects(tenantId)` hands every project in the workspace to
everyone in it, so "a draft finished" is a workspace fact); and one event staying
one row means the copies cannot drift and somebody who joins later still sees the
history.

So **"when it was read" lives on `notification_reads.read_at`, not on the
notification** — a notification has no single read time. `ON CONFLICT DO NOTHING`
is what makes it the FIRST read rather than the last time somebody scrolled past.

### The wording is shared, the glyph is not

`utils/draftNotice.js` composes the sentence in one place. It is the **Slack
card's** sentence, because that is the one that NAMES THE DOCUMENT — a
notification is read away from the screen that produced it, so "1 of 40 fields
drafted" with no title says nothing about which run. The phrasing inside is
identical to `app.html`'s `draftedLabel`.

**The glyph is deliberately absent.** `app.html` prefixes ✓/⚠ and Slack its own
emoji; both are decoration the surface chooses, and `type` (`draft_complete` /
`draft_incomplete`) already carries the distinction structurally, so a renderer
picks its own mark without parsing the message.

**The `short` test is now in THREE places** — `app.html` `draftIsShort`,
`slackWorkflow`'s `short`, and here — all of them
`fieldsAttempted > 0 && fieldCount < fieldsAttempted`. Nothing enforces the
agreement. A notification calling a complete run incomplete would contradict the
toast the same person just saw, so if that test changes, change all three. Same
standing hazard as the review overlay's duplicated wording.

### Two rules the writer follows

**A notification failure must never fail a draft.** The project lookup and the
insert are both inside one catch that logs with a stack and swallows. A completed
draft with no notification is acceptable; a draft that failed because of a
notification write is not. It is awaited rather than fired and forgotten, so an
error lands in that catch instead of as an unhandled rejection.

**`runWebDraft`'s return value is unchanged, byte for byte.** A smoke test asserts
that return literal — "the two values have to survive the trip: adapter → route →
browser" — and it caught a first version of this change that had restructured it
into a named variable. The notifier takes the same values separately, ABOVE the
return.

### The route

Its own router, not a growth of `routes/app.js`. `GET /api/notifications` returns
unread-first, newest-next, with `unreadCount` off a window function evaluated
**before** the `LIMIT` — so it is the tenant's true total, not the page's, and
there is no separate count endpoint. `POST /api/notifications/read` takes
`{ ids }` and its INSERT..SELECT filters on `tenant_id`, so an id from another
tenant is skipped rather than marked.

**Every scope comes from `req.user`.** `app.html` carries a hardcoded
`WORKSPACE_ID` the server correctly ignores; this route did not become the first
to trust it.

### What has and has not been exercised in production

`draft_complete` **has** — row 1 on tenant `T0B8LPRDKHR`, from a real brief, with
the project id and doc kind in its link. `draft_incomplete` **has not**: it needs
a genuine partial failure, and is verified only against a local database. Same
function and same insert, so the risk is low, but it is untested in the wild.

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

**There is a test suite.** `test/smoke.test.js` is ~17,500 lines and currently
runs **635 tests** in about ten seconds, with no credentials or network — it
exercises wiring, parsing, rendering, and regression guards. `.github/workflows/ci.yml`
runs `npm ci && npm test` on every push and pull request. Run it before you
commit, and add cases there when you change behavior.

**`public/*.html` is effectively untested.** The suite reads those files as
**strings** and asserts that certain ids, URLs, and CSS references are present —
there is no jsdom, no headless browser, no JS execution. A frontend change can
pass CI and still be broken in the browser. For anything in `public/app.html`
(4,100+ lines of inline markup, CSS, and vanilla JS), **the device is the test**:
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

**And a fourth, from the outage work's pass, which is the cheapest instance of
the rule on record.** `.notice` carries `margin-top` and no `margin-bottom` —
correct for as long as every notice was the LAST element on its panel, which all
three of the pre-existing ones are. `copydone-shortfall` is the first with
content directly beneath it, and at 390px its bottom edge landed on the "Assets"
label at **exactly 0px**. Nothing in the source is wrong; the rule is right,
present, and shared. It took one measurement in a browser. The fix is scoped to
the id, so the three older notices do not move.

None of these was reachable by a source scan, because none was a question
about what the source SAYS:

| The defect | What a string test can see | What it took |
| --- | --- | --- |
| posts every row | nothing — the bug is a missing condition | run the save and read the DB |
| dimmed reads as enabled | the CSS rule is present and correct | look at it at 390px |
| inert control reads as broken | the `disabled` attribute is set | look at it |
| 11px label fails AA | the colour is declared and looks reasonable | screenshot it and read the PIXEL |

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

### DIMMING CANNOT CARRY HIERARCHY ON THESE SURFACES — size has to

The fourth row of that table, from the project-detail pass (August 2026), and the
one with the longest reach: it is a constraint on every future visual decision
about `.glass-panel`, not a defect that was fixed and closed.

**The declared alpha is not the rendered colour.** A `.glass-panel` is
`backdrop-filter: blur(16px)` over a gradient sky, and the asset header band adds
its own 97%-opaque fill on top. What a low-alpha `--ink` composites to on that
stack cannot be read off the CSS, and it lands far lighter than the declaration
suggests. Both 11px labels the project-detail pass introduced were under the
4.5:1 AA floor and neither looked wrong in the source.

Measured at 390x844/3x by screenshotting the element and sampling its pixels —
darkest 1% for the glyph, 90th percentile for the surface behind it:

| alpha | `.asset-card-count` on the band | `.doc-row-kind` on the panel |
| --- | --- | --- |
| 0.42 | | **2.45:1** |
| 0.45 | **2.74:1** | |
| 0.55 | 3.63:1 | **3.38:1** |
| 0.65 | 4.95:1 | 4.45:1 |
| 0.70 | 5.78:1 | |
| 0.75 | 6.73:1 | 5.88:1 |

**So the practical floor for 11px ink on these panels is about 0.7**, and
`.section-label`'s existing **0.75** is the known-safe value to reach for. Below
that the text fails AA while still looking like a deliberate muted label.

**The consequence, stated as a rule because it will come up again: "muted label"
is not a tool available at this size on a backdrop-filter panel.** Both offending
values were chosen to say *subordinate* — a count secondary to the asset name, an
eyebrow secondary to its heading — and on any flat surface dimming would have said
it fine. Here it says *illegible*. Hierarchy has to come from **size** (the
eyebrow's 11px against its heading's 13px says the same thing and costs nothing),
or from weight, tracking or case. Not from alpha. Anything planned for these
panels should assume that constraint rather than discover it.

**BETTER IS NOT PASSING, and this is how the finding was nearly lost.** The
eyebrow was already failing at 0.42 before that pass touched it. Restyling it to
Star Crush moved it to 3.38:1 — a real improvement, against a floor of 4.5 — and
it was reported as fixed on the strength of having been *changed*. A partial fix
on a threshold reads as done to everyone including the person who made it. The
only thing that caught it was measuring the number rather than the delta.

**How to measure it: `scripts/checkContrast.js`.** It renders a committed fixture
with the page's own stylesheet at 390x844/3x, screenshots each text element and
takes the WCAG ratio from the pixels — darkest 1% as the glyph, 90th percentile
as the surface. That is the only method that sees through `backdrop-filter`.
Read-only, manual, and NOT in `npm test`: the suite runs with no credentials, no
network and no browser in about ten seconds, and this needs one.

    npm i --no-save playwright-core
    node scripts/checkContrast.js
    node scripts/checkContrast.js --probe=.lib-sub                    # alpha ladder
    node scripts/checkContrast.js --color=.lib-tier.enforced=#6b3a00  # a candidate
    node scripts/checkContrast.js --all                               # what it did NOT measure

It exists because every visual number this project ever acted on came from a
throwaway script and none of them can be re-derived. **A measurement nobody else
can reproduce is an assertion.**

**ALPHA IS NOT ALWAYS THE LEVER, and the probe is what tells you.** Three of the
library panel's failures were HUE problems: the enforced tier chip at `#8a4b00`
tops out at **3.14:1 at alpha 0.85** — no opacity reaches 4.5. The worst offender
was `.lib-resetbtn` at **1.10:1**, `var(--sky-btm)` (`#4DD9D9`), a dark-surface
token used on a near-white card. It is the control that CLEARS AN OVERRIDE, and
it was invisible the whole time the form was writing overrides nobody chose.

**AND A CONTAINER'S CEILING CAN BE SET BY ITS CHILD.** Probing `.lib-sub`
plateaued at 3.78:1 however dark its own text went, because the darkest ink in
the row belonged to the `.lib-tier` chip inside it. So the chip's colour had to
land before any of the alpha changes could. Nothing in the stylesheet says that —
the probe reports the WORST matching instance, which is what surfaced it, and
which is also why a per-selector number is a lower bound rather than a summary.

### The 46 unmeasured rules — recorded so they stay visible

`settings.html` declares **78** rules carrying both a small font-size and a
colour. The fixture measures **31** of them (all now above 4.5:1), one is a
container with no text of its own, and **46 are not measured at all**. The script
prints those three numbers on every run and `--all` lists the gap, so it cannot
quietly become a clean sweep.

The gap is not one thing:

| | | Closing it costs |
| --- | --- | --- |
| Other panels of the same page — templates (`.tpl-*`), doc header (`.hdr-*`), naming (`.naming-*`), custom fields (`.cf-*`), the hub cards | ~35 | more fixture markup, kept in step with the page |
| A DARK surface — `.nav-link`, `.terminal`, `.toast` are white-on-dark and the ratio runs the other way | ~6 | a second fixture; the existing one would measure them against the wrong ground |
| Error and success states — `.tpl-warn`, `.lib-newerr`, `.error`, `.banner` | 4 | markup for states the fixture does not currently reach |
| `.lib-funit::after` | 1 | **a tool limit**: it measures elements, and a pseudo-element is not one |

**Not closed now, deliberately.** Each panel is fixture markup that has to be
maintained alongside the page, and that cost only pays back if somebody runs the
tool. The library panel is where the work was and it is clean. `app.html`,
`onboarding.html` and `admin.html` have **no fixture at all** and are not in the
78 — that is a larger number again, and the honest statement is that this page is
measured and the others are not.

### A TOOL THAT MEASURES ONE PROPERTY MAKES THE OTHERS FEEL COVERED

The most important line in this section, and it is about the tool rather than
about contrast.

`checkContrast` reports one property of a rendered page. Somebody who reads
"every measured element meets its floor" is entitled to think the page was
checked — and it was not. **The contrast numbers being green says nothing about
whether a card is too long, whether a hierarchy reads upside down, whether an
alarm repeats until it is ignored, or whether a control is where a thumb can
reach it.**

That is not hypothetical either. The device pass that produced these numbers
found two things in the same run, and the harness would have found neither:

- the freshness block rendered **three times identically** on one card, and in
  the flagged state said "this number may be out of date" three times about one
  fact. A repetition problem, invisible to a per-element ratio.
- fixing the freshness lines to 0.75 in isolation left them **louder than the
  tier chip above them**, so the provenance footnote outranked the
  classification. Both elements measured; the INVERSION between them did not.

**This is a different failure from the four species above.** Those are
measurements that are WRONG in a way that looks like a result. This one is a
measurement that is RIGHT and NARROW, read as broad — which is harder to catch,
because there is nothing to disbelieve. The fix is not a better tool; it is
saying what the tool covers every time its output is quoted, which is why the
commit that introduced it says "every measured element on the library panel meets
its floor" and explicitly not "the app is accessible".

**Vertical rhythm, repetition and hierarchy are still the device.** Nothing in
this repo measures them and nothing here is planned to.

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

## Review comments are UNANCHORED — the explanation lives in the source

Nothing Quillio posts to a Google Doc is anchored, and nothing can be: Drive
publishes no text-anchor format for native Docs. Every review comment used to
render as **"Original content deleted"** because `addReviewComment` sent
`quotedFileContent` with no `anchor`.

**The full account is in the code, and deliberately only there** — the previous
version of this file carried a second copy, which is the exact failure mode that
produced the bug (a comment claiming anchoring was "verified" while the source did
something else). Read, in this order:

- `destinations/googleDocs.js`, the `--- Copy-review comments ---` header — the
  cause, and how a false "(verified)" survived.
- `services/copyReview.js`, "The comment LOCATOR" — what carries the location now,
  and why matching is looser than what it displays.
- `services/copyReview.js` `orphanSweepIds` — which comments get swept, and why a
  human's comment can never be one of them.

Two things that are NOT in the source, because neither belongs to one file:

- **The drift matrix.** A posted comment's locator can go stale two ways: the
  field's limit changes (`Headline [50]` → `[55]`) or the asset heading is renamed.
  Measured across whole-doc and scoped review, with review state present and lost:
  **all six cases end with exactly one comment.** The limit change is matched
  (matching ignores the bracket); the rename is swept and replaced. If you change
  the locator format or the sweep, re-run that matrix — a duplicate that survives
  every pass is the failure this design is built to avoid, and it is invisible
  until a tenant has a doc full of them.
- **None of it is browser-verified.** Whether the banner actually stops appearing
  is a claim about Google's renderer, and per "Running & checking" only the device
  settles that. Post a review on a real doc and look at it.

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

## The phrase table decides which asset a brief reaches — and it was inverted

`services/gemini.js` `ASSET_PHRASE_HINTS` maps the words a brief uses to the
asset names the model may return. It is hand-written intent, filtered per tenant
by `target`, and it is the closest thing the parse has to a routing table.

**A bare "landing page" pointed at Event Landing Page**, while Campaign Landing
Page was reachable only by the literal phrase "campaign page". The generic phrase
aimed at the specialised asset and the general asset needed a password. A product
launch asking for "a landing page" therefore came back with the EVENT asset — 24
fields including `Stat 1`–`Stat 3` and four benefit blocks — and **nothing
flagged it**, because a mapped asset is not an unmatched one. `unmatchedAssets`
only ever holds what failed to map; a wrong match is invisible to it, and no gate
downstream compares the asset returned against the words that produced it
(`tenantAssetsToSpecs` and `sanitizeAssetPlan` both check the name against the
LIBRARY, never against the BRIEF).

Now inverted: the bare phrase takes Campaign Landing Page, and Event Landing Page
requires an event signal — a date, a venue, a registration ask — which an event
brief always carries and a launch brief never does.

### The measured before/after — n=1 per cell, and that bounds the claim

Run in the Railway console against the real model, one brief per cell:

| Brief | Before the inversion | After |
| --- | --- | --- |
| `a landing page and a nurture email` | **Event Landing Page** | **Campaign Landing Page** |
| the event guard rail (a named event, a date, a venue) | Event Landing Page + Event Reminder Email | **unchanged — still both** |

So the fix works and the guard rail holds: making the bare phrase route to the
campaign asset did not cost the event asset its own briefs, which was the whole
risk of the change.

**What this supports and what it does not.** It supports *the route was the
cause* — that is what the pairing is for, and the guard rail is what rules out
"the model simply stopped choosing the event asset". It does **not** price how
often the model substitutes in general. One brief per cell is one observation;
this file's own record has an aggregate at n=5 reverse itself on a second run
(see "THE READER MISREADS A COUNT TOO"). Do not quote a substitution rate off
this table, because there isn't one in it.

`scripts/checkParsePlans.js` carries the eight matching cases these came from,
each with **pre-registered** RIGHT / WRONG / DEFENSIBLE verdicts, plus the
control (the same brief with the one literal phrase that always routed correctly)
and the guard rail. `--selftest` drives the whole harness on a stub — no key, no
network — and asserts a thrown parse is recorded as a DEAD CELL rather than an
empty result.

### OPEN QUESTION: "a couple of paid posts" invented two LinkedIn ads

Surfaced by the `bare-organic` case, which was watching something else entirely.
The brief said *"Some organic social to support the launch, plus a couple of paid
posts."* The parse returned **2 × LinkedIn Single Image Ad**. No probe expected
it and the classifier flagged it `UNEXPECTED`, which is exactly what that verdict
exists for — a list that absorbs its own surprises has stopped being a
pre-registration.

**It is the landing-page shape again, in a route that has no hint line.** "Paid
posts" names no platform and no format, and five paid social assets answer to it
(LinkedIn single image and carousel, Meta single image and carousel, Twitter/X).
The model picked one silently and picked a count of two out of "a couple". So the
inversion fix addressed one instance of the class; the class is a property of
*any* generic phrase over a set of siblings, and a phrase with no route at all is
not safer — it is the same silent pick with nothing written down about it.

Recorded as an OPEN QUESTION rather than a fix, deliberately. The obvious move —
add a "paid posts" hint line — is the same move that produced the landing-page
bug: a generic phrase wired to one specialised asset. Whatever is done here needs
the phrase-retention work behind it (the brief's own words are not kept beside
the asset the model chose, so there is nothing to show a writer), and it needs
more than one observation. `bare-organic` is in the harness and will keep
reporting it.

### The three DEFENSIBLE outcomes are ONE LIBRARY GAP, not a routing problem

Worth separating, because the run's verdict column makes them look like three
route decisions to argue about and they are not:

| Probe | Landed on |
| --- | --- |
| `ambiguous-landing` → "an announcement email" | Demand Gen Nurture Email |
| `literal-campaign-page` → "an announcement email" | Demand Gen Nurture Email |
| `bare-email` → "an email" | Demand Gen Nurture Email |

All three trace to the same fact: **there is no product-announcement email asset
in the library.** Demand Gen Nurture Email is a two-offer promotional shape —
`Headline (Offer 1)` / `Offer Body 1` / `CTA Text (Offer 1)` and the same again
for a second, deliberately lighter offer — and a launch announcement has one
message and no second offer. The model is not choosing badly; it is choosing the
nearest thing that exists.

So no route change fixes these. Rewriting the `"email"` hint moves which
specialised email shape a bare ask lands on, and every one of the five is
specialised — unlike the landing pages, there is no more-general sibling being
shadowed, which is why that route was left alone. This is a question about what
the library contains, and it belongs with the coverage gaps rather than with the
phrase table.

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

### LIVE CONTRADICTION in craft.md — §1.4 overrides §2's internal-punctuation rule

§2 now says a headline "may take a colon, an em dash or a question mark where the
mark earns its place". §1.4, three sections above it and in the ALWAYS-injected
universal block, says:

> **One idea per line.** Especially in short formats. Don't cram.

A colon or an em dash almost always joins two ideas. So the universal principle
argues against the specific permission, in the same prompt, every time.

**This is recorded as unresolved, not as resolved.** The permission was approved
knowing the tension existed; what was not known then is that §1.4 states it
directly. No rewording of the §2 block can fix it, because the conflict is with a
rule in another section that is right on its own terms — "don't cram" is good
advice for a 30-character headline. Whoever picks this up should decide between
them rather than assume the later, more specific rule wins: nothing in the prompt
establishes precedence, and the measured behaviour is 0/12 adoption, which is
what §1.4 would predict.

Related and separate: §2.55 was reworded so it would stop arguing with the same
permission ("a mark that makes a line turn is not a setup"). That fixed the
setup-and-punchline collision. It did not touch §1.4.

### SECOND LIVE CONTRADICTION — §7's Google Search section asks for 15 headlines

`craft.md`'s `### Google Search` section ends "write all 15 headlines to give the
algorithm room". `Google Responsive Search Ad` has **three** headline fields.

**What changed is the WEIGHT, not the words.** That section has existed since
`craft.md`'s first commit and, until August 2026, **nothing could ever select
it** — `mediumKeywordsForAsset` had no branch that returned `google search`,
because no asset in the library was a search ad. It reached a prompt only through
the "unknown medium → inject them all" fallback, as one section of eight.
Seeding the asset added the branch, so it is now the **only** medium section a
search-ad prompt carries.

**Why it is not simply reworded here.** Editing `craft.md` changes what every
prompt produces, and this file's own record is that an example's grammar gets
reproduced and that a prompt change needs its own before/after rather than
riding along with something else. A seed commit is the wrong place to find out.

**It is also not obviously wrong.** Google really does accept 15 and really does
reward more of them; the seed carries 3 because that is Google's stated MINIMUM
and because fifteen empty fields is a wall in front of a writer, with Riffs
covering the gap. So the sentence is right about the platform and wrong about
this document, which is exactly the §1.4-versus-§2 shape: two rules each correct
on their own terms, meeting in one prompt.

**What to measure if you pick it up:** whether the drafter treats three fields as
a shortfall — hedged, near-identical headlines that read like three of fifteen —
or writes three strong ones. `scripts/notesAB.js` is the harness shape, and the
pre-registered failure is uniformity across the three headlines, so `shapes` and
`openings` are the columns to watch rather than spread.

### Available and unplumbed — campaign signal the drafter never sees

Measured 2026-08-05. A field-draft prompt is 15,405 characters: 66% `craft.md`
(never varies), 24% `voice.md` or the tenant guide (varies per TENANT, never per
campaign), 2% the campaign. Three campaign-specific things already exist and do
not reach the drafter. **The raw brief is being worked; the other two are logged
here and deliberately not started.**

**1. The raw brief — DONE.** It now reaches the drafter. `projects.brief_raw`
(`scripts/migrateAddProjectBriefRaw.js`) stores the client's words verbatim at
brief time; `pipeline.generateDraft` reads them back through the
`getProjectByAnyDocId` lookup it already makes for the template half, and threads
them to both draft prompts and to the batch rescue. See below for the two
decisions inside it.

**2. Reference insights — the STATS now reach the drafter; the key messages
deliberately do not.** See "Reference insights" below. The framing this list had
was WRONG in a way worth keeping visible: it said none of the ingested material
informed the copy. In fact `enrichWithReferences` rewrites `summary` and
`writerPrompt` from the reference content and both adapters overwrite the
originals, so the model's *read* of the references has always reached the
drafter. What was stranded was the extracted figures.

**3. `funnelStage` — the slot is still empty; the drafter now INFERS instead.**
The prompt builder still emits `funnel: …` per field and `core/pipeline.js`
still sets `funnelStage: ''`. No column was added and none should be added on
spec — see "Funnel stage" below for what was done instead and why the stored
version was declined.

`notes: ''` on the same two lines is NOT in this category — the copy-doc path
fills it from the doc's italic line at draft time.

### Funnel stage: inferred, not stored — and the two prompts now share one definition

`services/gemini.js` `FUNNEL_STAGE_INFERENCE` is the single definition of top-
and bottom-of-funnel. Three call sites splat it: both draft builders and
`buildVariantReviewPrompt`. A smoke test asserts the literal appears in the
source exactly **once** and that all three reach for the constant, because two
prompts carrying their own wording leaves a future reader with two answers and no
way to tell which is current.

**The finding that motivated it.** The review prompt had told the model to infer
the funnel stage from "the asset type + brief" since it was written. The draft
prompts never did. Since the raw brief arrived, the prompt that says the stage is
unknowable holds *exactly the evidence* the prompt that says it is knowable is
told to read. That is a disagreement between two prompts in one system, not a
missing feature.

**The consequence clause is per-prompt, and only the definition is shared.**
`FUNNEL_STAGE_FOR_REVIEW` is "Funnel stage shapes which doorway fits";
`FUNNEL_STAGE_FOR_DRAFT` is "Funnel stage shapes what this copy has to do."
Doorways exist only on the review/variations path, and a dangling term in a
prompt that has no such concept is worse than no clause at all. What must never
drift is the definition, and that is the part that is shared.

**A stored value still wins.** `funnelStage ? 'Funnel stage: …' : <inference>` —
nothing populates it today, but a column or a per-brief value would, and an
inference must not talk over a value somebody set.

**The stored column was declined, not deferred.** It is strictly more work than
either of the two changes beside it: `parseBrief`'s JSON contract is the one call
whose failure mode is the whole brief refusing to parse, and the value would need
a column, a migration and threading through both surfaces — to supply something
the model can already infer from inputs it now holds. If the inference proves
unreliable, that measurement tells us what the column is worth buying.

### Reference insights: the stats are the drafter's, the key messages are the reader's

`referenceInsights` is `[{ source, type, stats, keyMessages }]`, one object per
source, produced by the enrich pass (≤3 stats of <10 words, ≤2 key messages of
<12 words). A 20:1 compression of up to 6000 chars per source. `type` is the
**transport** (`drive`/`external`/`pdf`/…) — nothing anywhere records a source's
**purpose**, and that asymmetry decides the split below.

**`stats` reach both draft prompts.** `referenceStatsBlock` renders them with
their source attached, and `parseDoc` recovers them from the doc.

**`keyMessages` do not, and this is DECLINED rather than not-yet-done.** Two
items of under 12 words summarising a source is that source's positioning at
headline length, handed to a model whose job is to write a headline — and for a
competitor page, that is the competitor's own copy. The drafter cannot tell one
source's kind from another's, because `type` is the file format. The
counter-argument ("the enrich pass already took the competitive framing") is the
argument *against*: the enrich pass had the full source text and an explicit
instruction to pull competitor-category framing, and its considered extract is
the one `Competitive Framing:` line in the writer direction. That is a
**controlled** channel — one sentence, labelled as positioning. `keyMessages`
beside it is the **uncontrolled** version of the same material with nothing
marking it as somebody else's. They stay in the doc, where the human reading them
is informed rather than primed. Reopening this needs a way to record a
reference's PURPOSE, not a change of mind about volume.

**The block is framed as ATTRIBUTION, never as truth**, and the exact wording
matters: "FIGURES REPORTED IN THE LINKED MATERIAL — taken from the reference
documents the client linked. They are REPORTED, not verified: nothing in this
system has checked them against their source. Use one only where it earns its
place. Do NOT invent a figure, do NOT round or sharpen one of these into a number
no source stated, and do NOT combine two of them into a single figure." A test
asserts the word **verbatim** never appears in it. The enrich prompt does say
"verbatim from source only" — but that is an instruction to a model, and no
instruction in this system has ever had a compliance rate of 1.0. Asserting a
guarantee nothing provides is worst on this class of output, where being wrong is
a false factual claim in published copy rather than a weak headline.

### THE SOURCE NAME IS WITHHELD FROM THE PROMPT — measured, not precautionary

`source` arrives on every row and is **never rendered**. The first version sent
`- <figure> — <source>` and produced a failure worse than the invention it was
written to prevent.

**What `statsAB` found on Demand Gen Nurture Email.** The model turned the source
NAME into a lead magnet the client was offering. Five of five Offer 2 bodies
pitched "B2B Content Ops Benchmark 2026"; four of five Offer 2 headlines were
"Get the 2026 Content Ops Benchmark"; the CTA moved to "Get the Report" four
times in five. Quillio does not have that report — it is somebody else's citation
— so the copy offered a prospect a document that does not exist. Separately, a
source hostname appeared by name in three drafts of customer-facing copy.

**Every rule involved was correct on its own terms, and that is what decides the
fix.** `craft.md` is always injected. Its CTA section states "The CTA must match
the destination", its approved library contains a destination category named
"Gated content (whitepaper, report, guide)" whose entries include the literal
string "Get the Report", and it says a secondary offer should "read as lighter".
Demand Gen Nurture Email has fields NAMED `Headline (Offer 2)` / `Offer Body 2` /
`CTA Text (Offer 2)`, so the prompt asks outright what the second, lighter offer
is — and a named report was the only object in the prompt that could be one.

**So wording cannot carry this**, for three reasons and not one:

- A prohibition has to name what it prohibits, and this file's own measured
  history is that a named shape gets reproduced.
- **The careful clause already lost once.** "…and only as that source's claim"
  was written to constrain how a figure was *asserted*; read as copy direction it
  says attribute this in the copy, and that is the hostname leak. It was removed
  with the source name.
- A new prohibition would have to beat an always-injected rule that is right.
  Plenty of campaigns really do offer a report, so the gated-content category
  cannot be deleted. The one comparable case on record — §1.4 against the §2
  punctuation permission — measured 0/12.

Withholding differs in **kind**: there is no object in the prompt, so there is
nothing to reason about and no compliance rate to fall below 1.0.

**Per-field gating was considered and refused.** It keeps the object and aims it.
The failure appeared in a **twenty-character** field (`CTA Text (Offer 2)`), so it
is not about length or room. Offer-shaped fields are common across the library and
nothing records which they are — and Event Landing Page has literal
`Stat 1`/`Stat 2`/`Stat 3` fields, which want a figure more than anything in the
product and would be the last ones anybody would gate.

**Nothing the drafter needs was lost.** The figure is what fills `craft.md`'s
specificity slot, and the LinkedIn Single Image Ad arm — zero invention, zero
fabricated offers — is the evidence that the numbers alone are the gain. The
human's attribution is untouched: it lives in the doc's Reference Insights
section as "From: <source> (<type>)", which is where it is read and where a wrong
figure can be deleted before Generate First Draft.

**PROVENANCE GAP, and it is an ARTEFACT rather than a decision.** The raw
reference content is fetched, capped at `REF_CONTENT_MAX` (6000/source), used for
the single enrich call, and **never persisted**. Nothing chose that; nothing
needed it after the call, so nothing kept it. The consequence now matters: by
draft time there is no text left to check a figure against, so no validator is
possible even in principle, and a figure that reaches published copy cannot be
traced past the source's *name*. The source name is the whole of the provenance.

What keeping it would cost: a column (or Drive-side blob) holding up to 6000
chars per source per project, written at brief time. That is not large. The real
cost is the decision underneath it — retaining a customer's linked material as
Quillio data, which is a privacy and retention question rather than a schema one,
and is why this is logged rather than built. **The cheaper half is worth
considering on its own**: storing each stat's *offset* or its surrounding
sentence at enrich time would make a figure checkable against a source a human
can open, without retaining the source.

**Why the doc, not the project row — the opposite call to `brief_raw`.** Neither
reason that put the brief on the project row applies here: a stat is already a
model extraction of ≤10 words rendered as its own bullet, and a bullet list
round-trips through Docs exactly, where a multi-paragraph brief does not and
would have needed a parser change. What decides it is the fabrication risk. A
figure is reported and unverifiable, so the only check that exists is the human
looking at the page — and reading them back out of the doc means **a wrong number
can be deleted from Reference Insights before Generate First Draft is pressed,
and it will not reach the prompt.** On the project row it would be unreachable.

`parseDoc` therefore returns `referenceStats` and `enrichedFromReferences`
alongside `{ summary, writerPrompt, assets }`. Both keys are additive; every
existing consumer destructures the original three.

**The one case where the flag understates.** `enrichedFromReferences` is the
presence of the Reference Insights section. If the enrich pass succeeds but
returns zero insights (references read, none produced — `pipeline.js` already
warns about exactly this), no section renders, the flag is false, and the prompt
keeps its pre-change wording. That is the status quo, not a regression. On a
total enrich failure the flag is *correct*, because the catch returns the brief
unchanged and the summary was never enriched.

**Not wired: `generateFieldVariations`.** The riff path gets no stats, the same
way it gets no per-field guidance. That gap is documented above and unchanged.

**Not wired: the template document.** `resolveProjectTemplate`'s `spec` is
`{ summary, writerPrompt }` off the project row, so the template draft path has
**never** received `brief_raw` either — it is a brief-free path already, and the
stats follow the brief. This is not a new asymmetry.

### The brief lives on the project row, NOT in the doc — and what that gave up

`projects.brief_raw`, a third column beside `brief_summary` and
`brief_writer_prompt`, which `migrateAddProjectTemplateDraft` added for the same
reason: the draft path is handed a document id and a tenant and needs campaign
context without reading it back out of the copy doc.

**The alternative was rendering the brief into the doc and recovering it in
`parseDoc`.** Rejected on fidelity — a Docs round-trip is a lossy channel
(formatting, line breaks) for the one value whose exactness is the entire product
claim, and `parseDoc` takes only the FIRST paragraph after a `HEADING_2`, so
multi-paragraph briefs would have needed a parser change shared by the draft and
regenerate paths.

**THE TRADE, recorded as a decision rather than an oversight: a writer can no
longer correct the brief in the doc and redraft against the correction.** Option
A would have allowed that, and it is a real feature — the doc is the working
surface, and "fix the brief, press regenerate" is a coherent thing to want.
Fidelity of the original won: the claim is *send the brief you already have, in
your own words*, and words that have been through a document round-trip are not
reliably the words that were sent. If revisability is wanted later, the answer is
a way to EDIT `brief_raw`, not to move it into the doc.

**Three sources, and the prompt says which outranks which.** `briefBlock`
(`services/gemini.js`) labels the brief AUTHORITATIVE and states the precedence
outright — "where it and the summary below differ, follow the brief". `summary`
and `writerPrompt` stay, because they do work the brief does not: one states the
ask when a brief buries it, the other is `parseBrief`'s extraction of creative
direction as a *directive*. They are relabelled by what they are rather than
presented as a third equal description. Both draft builders use the identical
block, so a field rescued out of a failed batch is not told a different story.

**The precedence sentence is CONDITIONAL, because unconditionally it is false.**
`briefBlock(brief, enriched)` and `derivedCampaignLines(summary, writerPrompt,
enriched)` move together on one flag. When a brief carried references,
`enrichWithReferences` **rewrites** `summary` and `writerPrompt` from the
reference content and both adapters overwrite the originals — so on that path the
summary is a read of the brief *and* the linked material and can legitimately
carry a statistic, a persona or a competitive frame the brief does not contain.
"Where it and the summary below differ, follow the brief" then instructs the
model to discard exactly the material that was fetched at real cost to produce
it. The enriched wording keeps the brief authoritative on **what the campaign is
and how it is worded** while telling the model the specifics below came from
sources it cannot see, and to keep them.

The model is **told** which case it is in rather than left to infer it: inferring
would mean guessing whether an unfamiliar specific came from an unseen source or
from nowhere, and "from nowhere" is the failure this whole block exists to
prevent. The unenriched branch is **byte-identical** to what shipped, which is
why the sentence is swapped by rewriting the group rather than appending to it.
`briefBlock(x)` and `briefBlock(x, false)` are asserted equal.

**Truncation is tail-first, capped at `MAX_BRIEF_CHARS` (6000), and announced.**
The head is kept because a brief front-loads; cutting the middle would splice two
halves into a sentence nobody wrote. The model is told the brief was cut, so a
severed sentence is not read as the end of the ask. **The cap is applied at
prompt-build time, never on write** — `brief_raw` keeps whatever was sent, so
raising the cap later is a code change rather than data already discarded.

Absent is the whole degradation: a pre-migration row, a project saved before the
column, a doc with no project row, no tenant, or an unmigrated database all leave
`brief` null, `briefBlock` emits nothing, and the prompt is what it was before.

### An example in craft.md is copied as SYNTAX, not just as a theme

The most concrete evidence in this repo about how examples behave, measured
2026-08-05 across two independent runs:

- `craft.md` §1.7 — "Specifics beat generalities. **'Save 4 hours a week'** beats
  'save time.'"
- `craft.md` §2.54 — "Numbers and specifics earn attention (**'3 ways,' 'in 10
  minutes'**)"

Both examples are *number + time unit*. §2.54's is specifically
**`in [number] [unit]`**.

The brief said **"in about a minute"**. The string "60 seconds" appears zero
times in the brief, the writer prompt, `craft.md` and `voice.md`. Ten of twelve
generated headlines ended **"in 60 seconds"** — the same preposition, the same
slot, the same unit class as §2.54's example, and a *more specific* number than
the brief supplied.

So the model did not take "be specific". It took the sentence pattern, discarded
the brief's own phrasing, and invented a figure to fill the slot. Two examples in
two sections agreeing on a shape was enough to make that shape near-universal.

**Before adding an example to `craft.md`, assume its grammar will be reproduced,
not just its point.** If that would be a bad house style, describe the quality
instead of demonstrating it — and if a rule cannot be stated without an example,
that is a signal about the rule.

#### FORM versus FACT — the rule that generalises all of it

"Avoid examples" is wrong and untestable. The measured distinction is what the
example DEMONSTRATES, and it is testable on any future edit:

| | | Cost of reproduction |
| --- | --- | --- |
| **FORM** | a transformation, a structure, a punctuation contrast | **zero.** Reproducing it asserts nothing |
| **FACT** | a quantity, duration, date, price, or named deliverable | **a false claim** the model cannot know is false |

The asymmetry is the evidence, and it is why this is a rule rather than a habit.
`craft.md`'s FORM examples — `"We built this" not "this was built."` and the
terminal-punctuation contrast — have been in the file since its first commit and
have produced **nothing**. Every one of its FACT examples produced a false claim
in a measured run:

| Removed | Section | What it produced |
| --- | --- | --- |
| `"Save 4 hours a week"` | §1.7 | the invented `"in 60 seconds"` |
| `"3 ways," "in 10 minutes"` | §2.54 | `"in 60 seconds"`; `"3 practical frameworks"`; **`"Starting in 10 minutes"` about a real event with no stated time** |
| `"Get the 2026 Benchmark"` | §2 by-length, ×3 | `"Get the 2026 Content Ops Benchmark"` in 4 of 5 drafts — a document no client has |
| `"Get the Guide"` | §4 gloss | `"Get the Guide"` in 4 of 5 drafts **with no reference material in the prompt** |

**`"Get the 2026 Benchmark"` invalidates the account of run 1 that this file
carried for four rounds.** The fabricated lead magnet was attributed to the
reference block's source name plus the CTA library's gated-content category. It
was neither: a fully-formed fake-offer headline, carrying the current year, was
sitting in the ALWAYS-INJECTED block from the first commit and appearing in every
prompt twice. The source name only filled a slot in a shape `craft.md` already
supplied — so withholding it removed a filler, not the mechanism.

**The CTA library is NOT an illustration and is not covered by this.** It is a
menu: every entry sits under a heading naming the DESTINATION it is valid for, so
reaching one means first asserting that destination exists. The §4 gloss was the
unconditioned one — a named artefact presented as the winner of a general
contrast — which is why the gloss went and the library stayed. Evidence: the
literal string `"Get the Guide"` appeared in the file exactly once, at the gloss,
and is absent from the library row (`Download the Guide · Get the Report · …`).

A tripwire test holds the five strings out. It is labelled a tripwire, not
coverage: it cannot tell a good example from a bad one, it only stops these five
returning.

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

**AND ON THE COPY DOC IT NEVER FIRED AT ALL, BECAUSE `notes` NEVER ARRIVED.**
`parseDoc` recovered each field's italic line into `notes` and `generateDraft`'s
`assetTargets` rebuilt the field without it, so the composer got `undefined` on
every copy-doc draft — no tenant `spec_note`, no seeded note, no tier line. Only
`builtInFieldGuidance` ever ran, because it keys on the field NAME. Fixed August
2026; the paragraphs above describe what the code intended, this one what it did.

**How it survived: the A/B that proved the mechanism called `generateAssetDrafts`
DIRECTLY with notes.** The measurement was clean and the wire between it and
production was not. So beside "drive a measurement script with a stub" now sits:
**check the measurement calls the entry point production calls.** A regression
test drives `generateDraft` itself with a stubbed transport and reads the prompt,
because no structural test can see a field rebuilt without a key.

**What restoring it switched on: 25 of 173 seeded fields.** 12 × the Litmus
"front-load the first 40" line on every email Subject Line and Preheader, 5 × the
LinkedIn Carousel Lead-Gen-Form caveat, plus the Organic Social hook note, the
Offer Body 1 split note and the Sales Basho first-touch note. 128 fields carry a
house-default line only and strip to nothing, so they stay silent.

### The strip is ONE RULE APPLIED TWICE — reader of the doc, or writer of the copy

`stripReaderOnlyLines` (was `stripHouseDefaultLine`) removes a sentence when it
addresses the **reader of the document** rather than the **writer of the copy**:

| Removed | Why |
| --- | --- |
| `House default — set your own in Settings.` (both wordings) | a UI pointer |
| `Not a hard limit — adjust for your brand and goal.` | advice to a human deciding whether to respect a number — read as writing guidance it **contradicts the ceiling in the same bullet** |
| `Recommended by <source>.` | a source NAME in a drafting prompt, whose cost this project has already measured |

The contradiction is the one that mattered. Composed, the bullet read:

    - "Headline" — character limit 40 — stay within this limit; guidance:
      Recommended by Meta. Not a hard limit — adjust for your brand and goal.

on **10 fields** (Meta Single ×3, Meta Carousel ×7), telling the model the one
constraint this file says always wins is negotiable.

**The research FINDING survives** — "Longer bodies click less." is writing
guidance; the attribution around it goes. If a finding is worth sending it belongs
in `spec_note`, the writing-guidance channel; `spec_type` is the provenance
channel, and keeping them apart is the rule.

**A RENAMED OR REPLACED STRIP CONSTANT MUST BE CHECKED AGAINST EVERY WORDING
STILL IN CIRCULATION.** The strip runs over a DOCUMENT, and a document is a file:
nothing reaches inside it again, so every sentence this codebase has ever composed
is still out there in whatever documents were built while it was live. The
composer only has to know the current wording. Anything that READS a document back
has to know all of them.

The instance, and it is the second time in a week that a rename broke a strip rule
silently — both times with reader-facing text reaching the model.
`VERIFIED_LINE` replaced `CHECKED_LINE` when the provenance sentence was reworded
(`1e37918` → `b018606`, 75 minutes apart on 2026-08-20, both on `main`, which
Railway auto-deploys). The strip stopped removing the old wording that same
minute, so every document built in that window has been shipping "Source unchanged
as of 2026-08-20." into its own `Field guidance:` ever since. Nothing errored;
nothing could.

`stripReaderOnlyLines` now removes all three provenance wordings, and
`PROVENANCE_AT_END` matches all three. The superseded one is **read here and
written nowhere** — which reads as dead code to anyone who greps for it, so the
constant carries the commit range and the reason it may not be deleted.

**IT HAS RUN IN PRODUCTION (`--commit`).** `scripts/migrateMetaPlacementCitations.js`
moved **18 `copy_fields` rows** — the nine cited Meta fields across two tenants —
and **2 `spec_watch_list` rows** onto the `/facebook-feed` URLs, in one
transaction. Both write-time refusals passed: no field left citing a bare URL,
and no cited Meta URL unwatched. `checkSpecHealth` afterwards reports all nine
watch rows healthy with both Meta rows on their placement URLs, and a brief built
since renders "Recommended by Meta (Facebook Feed)."

The watch rows moved WITH the citation rather than being added and retired,
because the bare and `/facebook-feed` URLs hash identically after the content
stop marker (`e5792dad455fcade` / `8fd92feee0d3025d`). `current_hash` and
`affected_fields` were untouched, so there was no unbaselined window and no
re-derivation.

**THE PLACEMENT QUALIFIER IS SAFE ON `recommended` AND IS A TRAP ON `enforced`.**
Written down before it fires rather than after, because the gap between the two
is one migration wide.

A Meta spec URL now names its placement — "Recommended by Meta (Facebook Feed)."
— because the ads guide serves different numbers per placement from the same
format page (150 on Facebook Feed, 44 on Instagram Reels). Measured through the
real strip:

| tier | reaches the drafting prompt |
| --- | --- |
| `recommended` + placement | `""` — `RECOMMENDED_ATTRIBUTION` takes the whole attribution, qualifier included |
| `enforced` + placement | `"Platform limit (Google) (Search). Stay within this count."` |

All nine Meta-cited fields are `recommended`, so nothing leaks today. **Google,
LinkedIn and X are all `enforced`**, and the first placement-specific URL on any
of them sends a bare parenthetical into a drafting prompt — a routing slug the
model has no use for, attached to the one tier line this file already flags as
redundant with the character-limit bullet beside it. A test asserts no `enforced`
field carries a placement URL, so the day one does, it goes red here rather than
in a document.

**`enforced` is deliberately NOT stripped, and it IS redundant.** "Platform limit
(LinkedIn). Stay within this count." sits beside "character limit 70 — stay within
this limit" in the same bullet, on ~9 fields. Not wrong — it is the one tier line
that agrees with the prompt — so it is logged rather than fixed. **If a
before/after ever shows flatness on LinkedIn, X or Google Display assets, a
duplicated constraint is a candidate cause and this is where to look.**

**`getDocContent` strips identically now.** It had set `field.notes` raw. Nothing
renders it — `routes/app.js` and `app.html` never read it, `copyReview` builds
prompts from `copy` — but an undocumented asymmetry one call site from shipping a
Settings pointer into a review prompt is the shape of every silent failure here.

**The template path was never affected.** `core/pipeline.js` passes
`notes: m.spec_note` raw from the marker, so it has always had per-field guidance
and has no composed tier line to strip.

**`scripts/notesAB.js` measures whether any of it helps**, and adds an OPENINGS
metric beside `distinct` and `shapes`: how many samples share their first four
words. "Front-load the first 40" acts on the opening, so five lines that begin
identically and diverge after read as **5/5 distinct AND 5/5 shapes** — verified
against a stub, where the openings column read 1/5 while both others read 5/5.
Range, mode and opening are three different properties and the first two cannot
see the third.

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

### An outage drafted 1 of 40 and both surfaces called it ready

August 2026, production: a prepaid Gemini balance ran out mid-brief. Every call
came back 429, every field came back blank, and the two things the system said
were each wrong in their own way.

| What it said | Why it was wrong |
| --- | --- |
| `First draft ready — *Title* (1 field drafted).` | a true number under a false claim, with **no denominator** — so a run that lost 39 of 40 fields is indistinguishable from a one-field brief |
| `All field drafts failed (Gemini timeout or error).` | named the two causes it was **not**, and implied a retry that was guaranteed to fail identically |

**The denominator was never computed.** `fieldCount` is `inserts.length` — what
was WRITTEN — and nothing beside it ever counted what was TRIED.
`googleDocs.generateDraft` now returns `fieldsAttempted` and `failureReason`
alongside it, and a short run loses the success headline on both surfaces:
`⚠️ Draft incomplete — *Title* (1 of 40 fields drafted). <cause>` on Slack,
`⚠ Draft incomplete — 1 of 40 fields drafted` in the web toast with the cause in
an amber `copydone-shortfall` notice. **A complete run is byte-identical to what
it always was** — the denominator appears only when it is not the whole story.

**THE CAUSES WERE NEVER REACHABLE, AND THAT IS THE PART WORTH KNOWING.**
`generateAssetDrafts` catches BOTH the batch call and the per-field rescue, so
it never throws on a model failure — during the outage it returned a full set of
empty drafts and `googleDocs`'s per-asset catch never fired once. Every asset
logged `done: … (0 fields)`. So the class now rides out on the draft ENTRY
(`entry.failure`), and `generateDraft` reads it **before** the
`.filter((r) => … && r.copy)` that drops every blank — read it after and there
is nothing left to read.

**The class is attached in `callGemini`, not derived from the message later.**
Four downstream places would otherwise need a regex over Google's wording. The
attach point is also the only place still holding the HTTP status and the
structured body.

**The hard case is 429, and it is the case that happened.** Google returns it
for a per-minute rate limit (wait) *and* a spent quota (pay), with
`RESOURCE_EXHAUSTED` on both. `exhaustedKind` reads the QuotaFailure violation's
`quotaId`: every violation on a per-minute/second clock → `rate_limit`,
otherwise → `quota`. **An unparseable or detail-free body reads as `quota`,
deliberately** — telling someone to check billing when it was a blip costs one
look at a dashboard; telling them to wait when the balance is gone costs every
retry after that, which is exactly what happened.

`GEMINI_FAILURE_SENTENCES` is the **one** wording, rendered by both surfaces —
the review-overlay duplication is the lesson not to repeat. `worstGeminiKind`
reduces a run's classes by a fixed priority rather than by frequency: a spent
balance shows up as timeouts and 5xx on the way down, and counting would let
thirty symptoms outvote the one cause that explains them.

**FAIL-FAST IS HELD, NOT REJECTED — and the number it would be decided on is
`1 + 2N` per asset, not `1 + N`.** Written down because it is the input to that
decision whenever it is taken, and it was recomputed once already after being
got wrong.

Per asset, on a run where every call fails: **1** batch call, **N** single-field
rescues, and up to **N** corrective rewrites. The third is the one that is easy
to miss — `generateFieldDraft` issues a SECOND `callGemini` when its first call
SUCCEEDS and returns copy over the field's ceiling. Character fields only:
`trimCeiling` is null on a word field, so nothing there triggers a rewrite. On
the seeded library most fields are character fields, so `2N` is the right
planning figure rather than a worst case.

A six-asset brief at ~7 fields each is therefore **≈90 calls that cannot
succeed**, not the ≈48 that `1 + N` gives.

Held on purpose: a circuit
breaker keyed on one class of one response is the kind of thing that trips on a
transient and turns a recoverable run into an empty document, and there is
exactly **one** recorded outage to design it against. The cost of waiting is
latency and log noise on an already-failed run; the cost of getting it wrong is a
run that would have succeeded. Revisit on the second occurrence, with two
observations rather than one.

### Nothing is written for a failed field — because blank is the only "still to do"

The reason no placeholder, marker, or apology goes into the doc on a field that
failed to draft, stated on its own because it will look like an omission to
whoever meets it next.

`parseDoc` recovers a field's draft from **the blank paragraph right after its
bold label**, and reads any second paragraph there as drafted copy. That single
convention is what makes the whole no-persisted-doc-state design work: it is how
Regenerate knows what exists, how a scoped redraft finds its target, and how the
web's `computeBlankFields` decides which chips are still empty.

So writing *anything* into a failed field's slot marks it **done**. A
`[draft failed]` line would survive the next Regenerate untouched, count toward
`fieldCount`, and show up on the copy-done screen as a field that has copy. The
blank is not an absence of a report — it **is** the report, in the one vocabulary
every consumer already reads. The report of the failure belongs on the surfaces,
which is what the entry above is about.

The corollary, for anything added here later: a doc-level notice must go in its
own paragraph away from a field label, or `parseDoc` will read it as somebody's
copy. This is the same constraint that keeps `fieldHint` to exactly one
paragraph.

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

### Measuring a prompt change: report the SPREAD, not the hit rate

**A compliance count cannot tell redundancy leaving from range leaving.** Both
look like "less variance in the output", both are what an added instruction
produces, and only one of them is a win. Two runs on this system establish it,
and they point opposite ways:

| | The change | What compliance said | What actually happened |
| --- | --- | --- | --- |
| `scripts/cohesionAB.js` | rescue gains siblings | every field in band, before and after | bodies dropped 89→69 and 42→31 words because they stopped re-establishing the premise. **Redundancy left — a gain** |
| `scripts/floorAB.js` | `char_min` reaches the prompt | Subhead **5/5 in band in BOTH arms** | spread collapsed 54-85 → 66-75, and the punchiest line in the run was the 54 that no longer appears. **Range left — a cost** |

The Subhead is the case to remember: by hit rate the floor changed **nothing at
all**, and it still cost the best line. No count would ever have surfaced that.
Only reading the copy did.

So any A/B on this system reports the **spread and the extremes**, and whoever
runs it reads the copy at both ends. A hit rate is a safety check, not a result.
Both scripts print every sample for this reason, and `cohesionAB` labels its
lexical-overlap number a hint precisely because it was blind to the only thing
that changed (2.81 in both arms).

This outranks any individual prompt rule: it is how you find out whether the next
one paid for itself.

#### The rule is narrower than "read the copy" — name the failure FIRST

**Name the failure you are watching for BEFORE the run, then read the copy for
the ones you did not name.** Both halves are load-bearing, and the third instance
is what forced the narrowing.

| Run | The count said | What was actually true |
| --- | --- | --- |
| `cohesionAB` | every field in band, before and after | redundancy left — **a gain** |
| `floorAB` | Subhead **5/5 in band in BOTH arms** | range left, and the best line went — **a cost** |
| `statsAB` run 1 | 13 invented figures | **most of the 13 was the counter's own arithmetic**, and a *different* fabrication sat unflagged in five of five bodies |
| `statsAB` run 2 | Headline (Offer 1) spread **12 → 19** | two of five lines were **byte-identical**. The metric moved the reassuring way while the copy got more repetitive |

The first two missed a **verdict** — the change happened, the count could not say
which way it went. The third is worse in kind: the number was **actively
misleading about which risk had materialised**. It reported a fabrication problem
that was largely its own bug (2026 came from the source name the prompt itself
carried; 6 was the digit form of the brief's spelled "six") while the copy
offered a prospect a document that does not exist — in five of five Offer 2
bodies, in a column no numeric check can have.

**A corrected counter does not close this.** "Get the 2026 Content Ops Benchmark"
contains no invented number at all; every digit in it was supplied. A *perfect*
numeric counter reports that line clean. The failure was not in the figures, it
was in what the copy claimed the client could give the reader — and that question
has no numeric form.

So pre-registering the failure is what earns the right to trust a green column:
it says which question the number answers. Everything else is still found by
reading, and the fields to read are the ones whose NAMES ask for something the
brief did not supply.

##### The fourth instance is the sharpest: a metric that pointed the WRONG WAY

The first three cases were a count being *blind*. Run 2's spread was **actively
reassuring while the thing it was watching got worse**, and that is a different
and worse failure.

`Headline (Offer 1)`, five samples, figures supplied: spread **12 → 19** —
wider, which every rule in this file reads as range being preserved — while
`Get 4.5 hours back every week` came back **byte-identical twice** at
temperature 0.8.

Both facts are true, and the explanation is that the distribution **split**:
some samples lock onto the figure's template and the rest range further, which
widens min–max while concentrating probability mass. **Spread measures RANGE.
Templating is a property of MODE. A range metric cannot see a mode forming** —
so it did not merely fail to help, it pointed at the answer we wanted.

A blind metric invites you to look elsewhere. A metric pointing the wrong way
tells you to stop looking. That is why `statsAB` now reports, **alongside spread
and never instead of it**:

| | |
| --- | --- |
| `distinct` | unique strings. Two identical lines at temperature 0.8 is itself the signal |
| `shapes` | unique strings with every number masked to `#`, so "Get 4.5 hours back every week" and "Get 71 hours back every week" are ONE shape |

`shapes` is the one that matters and `distinct` cannot replace it: a frame reused
with a *different* figure each time reads as 5/5 distinct and is exactly the "in
60 seconds" failure. In the stub verification the two disagreed on the same
data — `distinct 2/3`, `shapes 1/3` — which is the case the second metric exists
for.

**Spread is not retired.** `floorAB` measured a real cost with it (the 54-char
Subhead that disappeared), and that finding stands. The rule is that spread
answers "did the range move" and nothing else, so a run watching for
**uniformity** needs a mode metric beside it or it will be told the opposite of
what happened.

##### A NEW METRIC'S FIRST RUN ESTABLISHES A BASELINE AND ANSWERS NOTHING

The fifth instance, and the case is a **wrong prediction of mine** — recorded
because it is more useful to the next reader than a correct one would be.

Run 2 showed `Headline (Offer 1)` byte-identical twice. I proposed two mechanisms
(character budget vs the Email-only proof rule), built a 2×2 to separate them,
and put 70/30 on the proof rule. Run 3 came back **outcome four: neither**. Event
Reminder AFTER 5/5 clean, Meta AFTER 5/5 clean at a *tighter* 40-char budget than
the field that collapsed, and LinkedIn's headline collapsing in the **BEFORE**
arm with no figures in the prompt at all. At n=5 the whole thing was noise.

**The error was not overconfidence, it was sequencing.** `distinct`/`shapes` did
not exist when run 2 produced the observation, so "2 of 5 byte-identical" had
**no baseline** — no BEFORE-arm figure for that field, none for any other field,
nothing to say what this model's duplication rate is at temperature 0.8 when
nothing is wrong. I proposed the metric and the mechanism in the same breath and
then reasoned as though the metric had already reported.

So: **a mode metric needs a control arm exactly as much as a range metric does.**
The first run of any new metric is a baseline run and settles nothing; the
earliest a mechanism claim can be made is the second. The correct output of run 2
was "we cannot know until this has run on both arms", not two priced fixes.

The grid was still worth building — it ruled a hypothesis out cleanly, which is
what it was for. What it ruled out happened to be mine.

##### THE DENOMINATOR MOVED: an aggregate over a changed field set

The next entry, and the first where the metric measured the right thing and
still lied — because the population it divided by was not the same population.

`eventTimeAB`, silent-brief arm, before and after the note:

| | invented | fields | what the ratio suggests |
| --- | --- | --- | --- |
| no date field | 10/30 | 6 | |
| field + note | 9/35 | 7 | "barely moved" |

Read as a rate that is 33% → 26%, which reads as a weak result. Read per field
it is two separate outcomes pointing opposite ways:

- **The transcription field went 5/5 → 0/5.** Every `Date / Location Line` came
  back a placeholder — `[Date] at [Time] — Live on Zoom`, `Live online — [Insert
  Date and Time]`. It had been fabricating two different times and an invented
  timezone. **Nobody specified a bracket convention**; being told the line waits
  was enough to produce the honest form, which is the strongest evidence in this
  file that stating an absence beats prohibiting an act.
- **The generative fields did not move at all.** All 9 remaining inventions are
  Subject Line, Headline or Body Copy — "today", "tomorrow", "in 1 hour". The
  note is field-scoped guidance and reaches one field's `Field guidance:` line,
  so it could not have touched them.

**The aggregate averaged a fixed field with six unchanged ones and a seventh
appeared in the denominator.** A per-field count would have shown a clean fix and
an untouched problem side by side; the ratio showed a mediocre one.

So the rule gains a clause: **when a change alters the field SET, an aggregate
over fields is not comparable across arms.** Report per field, or report over the
fields that existed in both arms. This is distinct from the four cases above —
those were metrics watching the wrong property. This one watched the right
property and divided by the wrong population, which is harder to notice because
the number looks well-formed.

##### A COUNT MISSING A GAIN — and the rule generalises in BOTH directions

The last entry, and the first where **every column read clean and the change was
real and good**. `notesAB`, Subject Line 1, per-field guidance arriving for the
first time:

| | spread | distinct | shapes | openings |
| --- | --- | --- | --- | --- |
| BEFORE | 6 | 4/5 | 4/5 | 4/5 |
| AFTER | 19 | 5/5 | 5/5 | 4/5 |

Nothing collapsed. The pre-registered failure — "front-load the first 40"
converging five openings — did not happen, and the `openings` column built for it
answered no. All correct, and all beside the point.

**What actually happened was visible only in the copy.** Median length went
**55 → 44**, and the AFTER lines are 39/41/44/48/58 — four of five at or near the
40-character mobile cut, where NONE of the BEFORE lines were. The note did not
flatten the field; it moved the field inside the constraint the note describes,
which is the thing the field is FOR.

**No column measured the note's own claim.** So `notesAB` now pulls the number out
of the note — "front-load the first 40", "~35–40 characters" — and reports how
many samples fall inside it, in BOTH arms. Verified against the observed lengths:
`WITHIN 1/5 → 4/5`. That would have led the read instead of following it.

**THE RULE, RESTATED.** Four earlier instances were counts missing a COST, and it
would be easy to read this file as "a count hides regressions". It does not: a
count cannot tell you whether the copy got **better or worse**. It is not
directional. The only instrument that has ever answered that question in this
project is reading the copy.

**THE TRADE, recorded because it is real.** BEFORE's best line — "Six templates
for one campaign brief is five too many", 53 characters — is better than anything
in AFTER. The guidance trades wit for visibility. That is the correct trade for a
subject line, AND it is a judgement a writer should make knowingly: the note now
renders in the doc beside the field, so the constraint is visible rather than
silent, and a writer who wants the 53-character line can take it.

All 25 notes stay. They act on the constraint they name without costing variety,
which is the opposite of what the `char_min` floor did.

##### THE READER MISREADS A COUNT TOO — an aggregate acted on at n=5

Six entries in, and the first where the count was not the problem. `eventTimeAB`,
re-run through the real path, against the run that decided the design:

| | first run | re-run | replicated? |
| --- | --- | --- | --- |
| A present-no-note vs A absent, AGGREGATE | 15/35 vs 9/30 | 8/35 vs 12/30 | **no — it reversed** |
| the Date / Location Line itself, FIELD level | 5/5 fabricated | 4/5 fabricated | **yes** |

"An empty transcription slot is a blank the model always fills" was written into a
migration header, a seed comment and this file on the strength of the aggregate.
At n=5 the aggregate was noise, and it reversed on the second run. The FIELD-level
claim — the empty slot itself fabricates — held both times, and that is the one
the design actually rests on.

**The lesson is not about the metric.** The per-field breakdown was in the output
of the first run; nothing was hidden. A number that had never been reproduced was
read as a result, by a human, and built on. Every earlier entry here is a count
failing to see something. This one is the reader taking a single unreplicated
figure as established — which is the same error as the `distinct`/`shapes`
baseline entry, arriving from the other direction.

So: **an aggregate at n=5 is a hypothesis, and the per-field number underneath it
is the finding.** If a design decision rests on a ratio, the ratio needs a second
run before the decision does.

##### AN ASSERTION THAT QUIETLY RELOCATES — the third species, and it is in the TESTS

Every entry above is about a MEASUREMENT going wrong. This one is about an
ASSERTION going wrong, in the same family and by a mechanism neither of the other
two shares:

| | Failure | How you find out |
| --- | --- | --- |
| a count | measures the wrong property, or divides by the wrong population | read the copy |
| a control arm | leaks the treatment and reports a mixture as a comparison | drive it with a stub |
| **an assertion** | **checks a different region of the file and passes** | **nothing. It is green** |
| **a test RIG** | **omits a field the code under test reads, so the path under test does nothing and reports success** | **nothing. It is green** |

**The fourth species, August 2026: `test/lib/docSim.js`.** Its `toJson` emitted
paragraph elements with no `startIndex`. `paragraphCharIndex` walks the elements
and takes each one's own `startIndex` — deliberately, because a paragraph is not
guaranteed to be one run — so it returned null, every in-paragraph range
(`labelBracketRange`, `noteProvenanceRange`) read as "do not touch this
paragraph", and a replay of the spec sweep would have corrected **nothing** and
passed. Real Docs always supplies those indices; the model did not, and the gap
was invisible because "do not touch" is a legitimate answer.

**The common property across all four is the one worth carrying: the measurement
was wrong in a way that LOOKED LIKE A RESULT.** Not an error, not a crash, not a
red test — a number, a green suite, or an empty diff that a reader is entitled to
believe. That is why "be careful" does not work on any of them and each needed its
own structural fix: fetch the page, drive the arms with a stub, assert the
anchors, and — for a rig — give it the fields the code under test actually reads,
with the reason recorded in the RIG rather than in the test that needed it.

The instance: `test/smoke.test.js` sliced a region with
`draft.slice(draft.indexOf(a), draft.indexOf('const { title, fieldCount, url }'))`
and asserted the word `append` did not appear in it. The outage work added two
keys to that destructuring pattern. `indexOf` returned **-1**, `slice` read -1 as
*one character from the end*, and the region silently grew to the whole function —
which contains the copy-doc call the test existed to exclude. It stayed green
until the code inside the newly-swallowed region happened to change.

**The mechanism is that `-1` is a valid `slice` argument.** A missing END anchor
grows the region to almost everything; a missing START anchor collapses it to
`''`, and every `assert.ok(!/x/.test(region))` in the file passes trivially
against an empty string. Both directions fail open. Some slices here carry an
`assert.ok(fn.length > 500, 'found X')` sanity check, which catches the second
case and not the first — and 192 `.indexOf(` calls in that file do not carry one.

**How to write one that cannot do this: assert the anchors, do not assume them.**
`sliceBetween(src, startAnchor, endAnchor)` at the top of `test/smoke.test.js`
asserts each anchor was found and that the end follows the start, then slices. It
has its own test, which pins the two silent-pass behaviours above as the reason
it exists. The rule for anything new: **an `indexOf` used as a slice bound is an
assertion — write it as one.**

**The 134 existing sites were NOT swept, and a tripwire is what makes the sweep
unnecessary.** `test/indexof-slice-baseline.json` freezes them; a test scans this
file and fails if the multiset grows. The set may **shrink** freely — converting
a site is always welcome. Editing an anchor string in an existing site reads as a
new member, which is intended friction: convert that site while you are in it
rather than re-freezing the file, because re-freezing turns a tripwire into a
rubber stamp.

**The scanner is heuristic and the heuristic is made SAFE rather than trusted**,
which is the part worth copying. It masks the contents of every comment, string,
template and regex, preserving length so a site can be *detected* on the masked
text and *reported* from the original. Regex-versus-division is the standard
lookback guess. A desync there would make the tripwire silently under-report —
which is the exact failure this whole entry is about — so the test **compiles the
masked output** (`new vm.Script`) before believing it: blanking contents leaves
valid JavaScript, losing track of where a literal ends does not. Plus six
synthetic fixtures, including the one that actually bit: an apostrophe in a
trailing comment (`// the field's own note`) opened a phantom string and
desynchronised the first version across the whole file, which is why the first
count read 104 and the correct one is 134.

The generalisation worth carrying: a structural test asserts something about a
REGION, and the region is as much part of the claim as the pattern is. A test
that names its subject only by two string literals it never checks is one rename
away from being about something else.

##### BRIEF FIDELITY IS NOT FACTUAL ACCURACY, and no detector here can tell them apart

The re-run's no-note cell put "in about a minute" in four fields — both Subject
Lines, the Headline and the Preheader — as the event's start time. It is the
BRIEF'S OWN PHRASE, verbatim, where it describes how fast the **demo** is.

Every check in `eventTimeAB` scores that clean and files it under "matched the
brief". Deciding it is true of the product and false of the start time requires
knowing what the phrase REFERS to, which a substring comparison cannot ask and a
longer pattern list makes worse — the phrase is already an exact match.

So the column is renamed to what it measures — **BORROWED: a temporal phrase that
also occurs in the brief** — and is documented in the script as **not a
correctness signal**. Every borrowed phrase is printed for reading. A
"from the brief" tally that silently includes false claims is worse than no tally,
because it reads as a clean bill.

**A related detector bug, found in the same run and fixed:** the month pattern was
`(?:jan|feb|mar|…)[a-z]*`, which matched **marketing, marked, marketers, decision,
decline, deck, separate, novel, junior, augment and march**. "marketing" appears
in every brief this project has measured with, and because invention is scored by
absence from the brief, every one of those false hits landed in the borrowed
column rather than the invented one — inflating the tally that was already the
least trustworthy. Now a full month name, or an abbreviation adjacent to a day.

##### ONE CELL WHERE ZERO VARIANCE IS THE GOAL

`Date / Location Line`, brief STATES the time: byte-identical five times —
"Thursday, August 24 at 12 PM PT | Moscone West". Every other variance metric in
this file treats collapse as a cost; on a **transcription** field it is the win.
There is one true answer and five renderings of it would be the defect.

`eventTimeAB` reports that field separately and reads it inverted: on a
`fact_kind` field whose fact the brief supplied, **expect 1 distinct and treat 5
as the failure**. Any future metric run across fields has to exclude these or it
will report the correct behaviour as flatness.

**And it did not hold on the second run: 3 distinct of 5.** Two drafts varied the
PUNCTUATION of a supplied value — "Thursday August 24" without the comma, an em
dash where the others used a pipe. Trivial in effect and the facts were right
every time, so nothing a reader would notice.

It is logged rather than fixed because of what it IS rather than what it costs: a
transcription field paraphrasing instead of copying, which is the one thing that
field should never do. The gap between reformatting a date and altering one is a
matter of degree in the model's behaviour and a matter of kind in the output. If a
future run shows a supplied value coming back with a different NUMBER rather than
a different comma, this is the entry that predicted it.

**The note wording is settled by the same run.** Three wordings, second time of
asking, silent brief, invented times: `line` **4/35**, `single` 8/35, `campaign`
11/35 — and `campaign` is worst for the second run running, so the grammar-scoping
hypothesis is dead twice rather than once. `line` also produced **5 of 5 clean
placeholders** on the field itself, clearing the 2/5 bar it had to beat.

##### A TEST DOUBLE THAT IMPLEMENTS ONLY THE HAPPY PATH IS BLIND WHEN IT MATTERS

`scripts/lib/realDraftPath.js` wrapped `fetch` and returned
`{ ok: res.ok, json: async () => json }`. `callGemini` reads a FAILED response
with `res.text()` (`services/gemini.js:495`), which that object did not have. So
the first non-2xx of the run — a rate limit, thirty-odd calls into a
thirty-five-call pass — surfaced as **`res.text is not a function`** instead of
`Gemini API error 429`, every field of the asset failed batch AND rescue, and the
cell reported a clean `0/0`.

Two defects, one cause: the shim implemented the SUCCESS path because that is the
path a working run takes, and it called `res.json()` unconditionally, consuming
the error body before anything could read it.

**The fix is `res.clone()` for the capture and the REAL response returned
untouched**, which removes the class rather than patching the instance — the
production code now gets a genuine `Response` with every method it may reach for.

**It could not fire in production**: real `fetch` returns a real `Response`. The
bug was entirely in the measurement rig. But it is the same shape as the note that
never reached the drafter — *the wire between the measurement and the thing being
measured is code too* — and it argues for the same discipline: a harness needs its
failure path exercised, not just its success path.

**And the harness now REFUSES a dead cell.** A run that produced no copy is
recorded as an error rather than as an empty result, and a cell with any dead run
exits non-zero. `0/0` is not a measurement; it is a cell that did not happen, and
reporting it as a zero is the contaminated-arm failure the wire check exists to
prevent.

##### GRAMMAR-SCOPING: A WRONG HYPOTHESIS, WITH THE NUMBER

The note names a LINE — "this line waits for them" — and the theory was that its
grammar is what confines it to one field, so a wording naming no line would
generalise to the generative fields. Measured, silent brief, invented times:

| wording | invented | |
| --- | --- | --- |
| `line` (shipped, names a line) | **6/35** | |
| `single` (one fact, names no line) | 10/35 | |
| `campaign` (names no line at all) | **15/35** | **worse than the shipped version** |

Naming no line did not generalise the note. It degraded it. The theory is dead,
and the direction is the opposite of the prediction.

**And 6/35 is not a success either.** The vague-safe column went 4 → 8, and all
five Subject Line 1 drafts in the `line` cell open "Starting soon" or "We start
soon". That is the pre-registered flatness, arriving exactly where it was
predicted: invention traded for uniformity, with the count reading it as an
improvement. It is the `char_min` floor result a third time.

**SO THE NOTE SHIPS AS A FIELD INSTRUMENT AND NOTHING MORE**, and the limit is
stated rather than left to be rediscovered: it takes the empty
`Date / Location Line` from 4/5 fabricated to **2/5, not to zero**, and it does
nothing for the Subject Line, Headline or Preheader.

The mechanism, which is why no wording fixed it: the generative fields invent a
time because `Event Reminder Email`'s `asset_direction` asks for "urgency without
panic" and, with no real time, a fake one is the most available form of urgency.
A sentence about the absence does not remove that pressure — and `campaign` at
15/35 is what you would predict if naming the hole makes the model reach harder
for a substitute. **The asset direction is correct guidance and must not be
touched**; the problem is the missing fact, not the instruction to be urgent.

Shipping 2/5 is a deliberate partial fix on the `is_copy` precedent: a visible
slot holding a placeholder tells the writer a fact is missing, and no slot tells
them nothing.

**AND THE SAME CONDITION NOW REACHES THE WRITER, which is the half the note could
never do.** The note addresses the DRAFTER and is invisible until somebody opens
the document. `missingDateTimeNotice` (`src/utils/briefFacts.js`, beside the note
so the two wordings cannot drift) says it to the person who can actually fix it,
on the Slack card and the web result screen: *"The brief does not state a date or
time for this event. Add them to the Date / Location Line before sending."*

Three things about it worth keeping:

- **The field name is read off the row the trigger fired on**, never hardcoded —
  it is the bold label the writer will see in the document, so a tenant renaming
  the field fixes the sentence with no code change, and a tenant with no such
  field never sees it because there is no row to read. A test asserts the string
  `Date / Location` appears nowhere in that function's code.
- **Both come off ONE loop.** The names are collected in the same pass that
  attaches the note, so a field that got a note is exactly a field named in the
  notice. A second pass over the specs would let the two disagree on any future
  change to the condition.
- **Its own slot on both surfaces, never composed.** A third Slack `context`
  block and a third notice host on the web. A brief can hit the per-asset
  ceiling, miss an asset name, be missing a date, any combination or none — three
  independent conditions, so three blocks. One sentence carrying two of them
  would make either imply the other.

Measured at 390px: the fact notice and the unmatched notice together are **142px
with a 14px gap**, both above the CTA bar, no button covered and no horizontal
overflow. That was the open question about stacking advisories, and the answer is
that it reads fine.

**It does not change the 2/5.** This is a second reader for the same finding, not
a stronger fix — the generative fields still invent a time, for the reason above.

`statsAB` now carries two tripwires, and they are labelled as tripwires:

- **A — source leak.** Any distinctive token of a source name in the output.
  The source is no longer sent, so this **must read 0 forever**; it is a
  regression alarm, not coverage. It would have caught both first-run failures.
- **B — artefact noun** (report, benchmark, whitepaper, guide, …). A **hint with
  deliberate false positives**: "Get the Guide" is an approved `craft.md` CTA and
  appeared legitimately. It prints every candidate line, because the question it
  raises — *does the client actually have this?* — can only be answered by a
  human who knows.

The counter's allowlist was wrong in **both** directions and both are fixed:
`2026` and `6` were false positives, while `3` and `2` were silently whitelisted
out of "Q3" and "B2B", so a real invention of "3 ways" would have passed clean.
Junk in an allowlist is worse than junk in a count — one is visible noise, the
other is a hole. That is "The one decision rule that recurs" arriving in a
measurement rather than in a gate: noise is read and dismissed, a hole is never
read at all. Spelled-out inventions remain invisible, so the column is a
**floor on invention, not a census**.

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
| ~~Meta ads guide~~ | **SUPERSEDED — see below** | the row no longer exists |
| Litmus subject line | **unanchored by decision** | see below |
| Litmus preview text | **unanchored by decision** | see below |

**LinkedIn carousel** was added later (`migrateAddLinkedInCarouselWatch`, anchor
`Card headline`) and **Meta's single row became two** (`migrateSplitMetaWatchRows`,
anchors `Primary Text` and `Description`). Seven hash-watched rows now, and
`summary.unanchored` reads **0** — every one of them is anchored.

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

**Meta — AND THIS PARAGRAPH DESCRIBED A ROW THAT NO LONGER EXISTS.** Left in
place, corrected rather than deleted, because the correction is the point.

What it used to say, and what was true when written: the ads-guide INDEX row's
only candidate was a raw-body check for the canonical URL fragment, rejected
because it asserts the *document was served* rather than that the *content
rendered* — so it would pass on exactly the broken page the feature exists to
catch. An anchor that cannot fail is worse than none.

**`scripts/migrateSplitMetaWatchRows.js` replaced that row with two**, both
anchored, and `scripts/migrateMetaPlacementCitations.js` then moved them to the
`/facebook-feed` URLs without touching `expected_content`:

| Row | Anchor | Why that string |
| --- | --- | --- |
| `Meta – image` | `Primary Text` | Meta's own label for a limit we store — content, not chrome, since a 404 on this host still carries Facebook nav |
| `Meta – carousel` | `Description` | 1x on carousel, **0x on image, video and collection** — the only label that differs between the format pages, so it catches a redirect between siblings |

**THE KNOWN LIMIT ON THE IMAGE ROW IS STILL OPEN, and it is the reason to point
the probe at it.** `Primary Text` appears on `/video` and `/collection` too, so a
redirect from `/image` to a sibling passes the anchor. The numbers would change
and the row would flag `changed` rather than `failed` — a wrong answer wearing
the right status. `/image` and `/video` are byte-identical on Text
Recommendations ("50-150" and "27" on both), so nothing in the measured output
tells them apart. The carousel row has no such gap; `Description` was chosen
precisely to close it.

**HOW THIS SECTION WENT STALE IS THE INSTRUCTIVE PART.** Two migrations replaced
the mechanism and neither touched the prose describing it, so a table reading
"Meta ads guide — unanchored by decision" sat here for four days after Meta
became two anchored rows. It was then read as current and acted on: a review
concluded Meta's rows had no anchor to re-derive and were the weakest on the
board, which was exactly backwards. That is the preamble's rule firing on the
file that states it — **a commit replacing a mechanism greps this file for its
name before it lands.**

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

`copy_fields.spec_verified_at` **was** the trap, and this paragraph used to say
so — written by `specReview.commitReview` on an approved edit and SELECTed by
nothing, reaching no doc, no settings panel and no admin view. That is no longer
true: the freshness work added it to `getTenantLibrary`, `rowToSpecGroup` carries
it as `specVerifiedAt`, and `verifiedSentence` renders it into the document and
the settings panel. It is now a column that says what it means.

### A COLUMN WRITTEN ONCE AT SEED IS A CONSTANT, and calling it a version invents a history

**`copy_fields.spec_version` is the trap now, and it is the sharper one.** Second
instance of the same species, which is what makes it a rule rather than a note.

It is written at seed time as the literal `'1.0'`, copied forward by the two
field-inserting migrations (defaulting to `'1.0'`), and **moved by nothing** — not
`specReview.commitReview`, whose SET clause is `char_max`, `spec_note` and
`spec_verified_at = NOW()` and nothing else; not any migration; not a tenant, who
is refused it in three separate places. Every row in production holds `'1.0'` and
always will.

**A name that asserts a history the system does not keep is worse than no
column.** `spec_verified_at` was invisible, so it merely failed to inform.
`spec_version` reads like a moving value, so a reader who finds it believes there
is a sequence behind it. That is the LinkedIn 600 shape: a value that looks
authoritative because it is in the shape of an authority.

**It was DROPPED FROM THE SELECT rather than stamped**, and the reasoning
generalises. A version earns its place when it is a compact handle for a state
you cannot otherwise reconstruct, and every part of this one is reconstructable:
`spec_change_log` holds old/new/when/who/which-page per approved edit,
`projects.field_manifest` holds the effective limits at document creation, and
the document itself carries "Verified against X's spec page on DATE." Stamping it
would add a label carrying no information those three do not already hold. It
would also have no coherent per-row meaning — what does `1.0 → 1.1` signify on a
field one tenant has overridden and another has not?

The **column** stays until a migration is being written for another reason;
eighteen references across nine files do not justify one of their own. What
closed today is the accidental-render path: `getTenantLibrary` no longer reads it
into the shape the doc and the settings panel are built from, so it cannot become
visible by way of a template change.

The accurate description of what the system does: every limit is cited to its
source; platform spec pages are checked weekly for changes, with **every one of
the seven hash-watched rows** anchored so the fetch is asserted to have read the
right page; any detected change goes to a human before a stored number moves; and
email guidance is dated observed practice that is never hash-watched.

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

### CLOSED: LinkedIn Carousel now has its own watch row

`business.linkedin.com/advertise/ads/sponsored-content/carousel-ads/specs` is
cited by six **enforced** `copy_fields` rows (`migrateSpecIntegrityFixes.js`
repointed them there, correctly — the single-image page does not carry the
carousel's numbers) and was on **no** `spec_watch_list` row, so a change to
LinkedIn's carousel limits was never detected.

`scripts/migrateAddLinkedInCarouselWatch.js` has run in production. Row **#12**
exists, anchored on `Card headline`, six pairs derived, baselined and confirmed
`unchanged` across two runs. The list is **nine rows**, `unanchored` reads **0**,
and the health check reports every watched row healthy.

**The ordering that mattered is now spent, and this is why it was insisted on.**
Re-deriving the single-image entry BEFORE this row existed would have dropped
those six pairs and turned a gate-by-the-wrong-page into a gate-by-nothing. The
new row has produced its clean comparison, so the single-image entry can now be
re-derived (`scripts/rederiveAffectedFields.js --only=<id>`, dry-run first)
whenever somebody wants to — it will drop the six carousel pairs, which is
correct, because they are gated by row #12 now.

## Vision & roadmap

`ROADMAP.md` and `docs/` hold product intent and historical build plans. They
describe **intent, including work that was never built or was later removed** —
they are not a description of the current code. Use them for the "why"; verify
the "what" against the source. The live character limits actually enforced come
from the Postgres asset library, not from any table in a doc file.

### Measuring these two changes — the scripts exist, the runs have not happened

`scripts/funnelAB.js` and `scripts/statsAB.js`, built to the same shape as
`cohesionAB` / `floorAB`: real model calls, no writes, safe in production, and
every sample printed with the extremes marked. **Neither has been run** — this
repo has no `GEMINI_API_KEY`, and both refuse to start without one. Nothing below
is a result; they are the questions each run is set up to answer.

**`funnelAB`** puts one brief through a TOP-of-funnel asset (`Organic Social —
LinkedIn`, a cold scroller) and a BOTTOM-of-funnel one (`Event Reminder Email`,
a reader who already registered), each with and without the inference block. The
prediction being tested is directional and per-asset: the top-of-funnel copy
should stop assuming trust, the bottom-of-funnel copy should stop re-selling a
decision already made. "The copy changed" is not the finding — any instruction
achieves that.

**`statsAB`** supplies two figures whose numbers appear nowhere in the brief, and
counts three things per arm: figure-led openings, use of a supplied figure, and
**numbers that are in neither the brief nor the stats**. The third is the one
that matters. `craft.md` demonstrates a number-led opening twice and the measured
consequence was ten invented "60 seconds"; two real figures beside those two
examples is the same setup with live ammunition. A rise in the invented column is
a reason to reword the block whatever else improved, because an invented figure
in published copy is a false factual claim rather than a weak headline. Spelled
numbers are not detected, so that column is a **floor on invention, not a census**.

**`funnelInference` exists for the A/B and for nothing else.** Default on; `false`
reproduces the pre-change prompt byte for byte through the same call. `floorAB`
needed no such flag only because `char_min: 0` happened to be a real production
value that did the job; there is no lucky equivalent here, and the alternative
was editing the builder or checking out old code at measurement time.

**The stubbed-transport pass earned its keep before either real run.** Driving
`funnelAB` with a fake `fetch` showed the BEFORE arm emitting the inference block
on calls 4 and 5: `generateAssetDrafts`'s rescue reaches `generateFieldDraft`
separately and was not threading the flag, so any field the batch dropped came
back with the block while the arm still called itself a control. A run would have
reported a mixture as a clean comparison. **Drive a measurement script with a
stub before trusting a number out of it** — the arms are code too, and a
contaminated control fails silently and looks exactly like a result.
