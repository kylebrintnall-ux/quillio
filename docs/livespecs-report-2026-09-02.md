# LiveSpecs — a full account

Written 2026-09-03 against `main` at `7412f07`. Read-only: nothing in this pass
edited code, ran a migration, touched a watch row, or wrote to the database.

**Two standing limits on everything below.** This session cannot see the
production Postgres and has no egress to any spec host. So every figure here is
either (a) derived from the repository — the bundled seed, a migration's
constants, the code — and labelled as such, (b) a reading taken from a Railway
console run and recorded in the session that produced this report, and labelled
as such, or (c) **unread**, and named as unread rather than inferred. Where the
repository and the database can legitimately disagree — and they can, in ways
this report gets to in Part 8 — the report says which one it is quoting.

The live state supplied for this report, from the operator's console:

> 14 watch rows, 12 fetched and healthy, 2 observed_practice and never fetched,
> 1 test row (among the 12). 34 seeded assets. Four Google rows flagged and
> confirmed on 2026-09-02 on a Help Center build-number change; flags #12–#15
> are pending and are false positives.

---

## PART 1 — WHAT IT IS

### In plain English

Quillio writes marketing copy into Google Docs. Every field in one of those
documents carries a character limit in square brackets — `Intro Text [150]`,
`Headline 1 [30]` — and that number is not decoration. It is passed to the
model as a constraint, it is what the trim ladder enforces, and a writer reads
it and writes to it. A great many of those numbers are not Quillio's opinion.
They are LinkedIn's, Meta's, Google's, X's and Pinterest's, copied out of those
companies' published spec pages.

Published spec pages change. Nobody tells you when.

**LiveSpecs is the answer to "how would we know".** It is a weekly job that
fetches every page the library cites, reduces it to visible text, hashes it, and
compares that hash to the one it stored last week. When a page changes it does
not update anything — it raises a flag for a human. A person opens the flag in
an admin console, sees which fields depend on that page and what they currently
hold, optionally asks the model to read the new page and suggest a number, types
what they decide, sees a diff of exactly which tenant rows will move, confirms,
and only then does a number in `copy_fields` change. That write is logged with
who did it, when, from which page, and what the old value was.

A second job — the **sweep** — then walks the documents that were already built
with the old number, corrects the bracket in place, and writes the tenant a
notification saying what moved and that their copy might now be too long. It
does not touch a word anybody wrote.

### The problem it solves

Without it, a spec correction is a thing somebody has to *remember* to go
looking for. The failure is not that Quillio would produce a bad document
loudly; it is that Quillio would produce a confident-looking document with a
stale number in it, with a live hyperlink to a page that no longer says that,
and nothing anywhere would ever raise it again. That is the shape of failure
this codebase's own history is full of — `migrateSpecIntegrityFixes.js` wrote
*every wrong Meta number in the library* through careful reasoning that never
fetched the page — and it is why the rule that governs the whole subsystem is
**fetch the page, quote the text, in the same change**.

### What the product claim rests on it for

The document a writer opens says, under a field label:

> *Platform limit (LinkedIn). Stay within this count. Verified against
> LinkedIn's spec page on 2026-08-28.*

with **LinkedIn** hyperlinked to the exact page. That is three separate claims —
this is a hard limit, this is who published it, a human read that page on that
date — and the product is asserting all three on the customer's behalf. The
settings panel adds a fourth, which is a statement about the machine:

> We watch that page for edits — not the number. Last checked 2026-08-19: no
> change.

LiveSpecs is what makes the fourth sentence true and what keeps the first three
from quietly ageing. Take it away and the document still renders every one of
those sentences; they just stop being backed by anything.

### Inventory

#### Tables

| Table | Scope | What it holds |
| --- | --- | --- |
| `spec_watch_list` | **global** (no `tenant_id` — platform specs are universal) | one row per watched page: the URL, a display name, the write gate, the stored hash, health counters |
| `spec_review_queue` | global | one row per detected change — a *flag*. `pending` / `reviewed` / `dismissed` |
| `spec_change_log` | global | the audit trail: one row per approved attribute write |
| `spec_test_page` | global, singleton `id=1` | the editable fake spec page the test watch row fetches |
| `spec_sweep_state` | global, singleton `id=1` | the sweep's watermark — how far through `spec_change_log` it has got |
| `copy_fields` | **per tenant** | the spec columns themselves (below) |
| `projects.field_manifest` | per tenant | which (asset, instance, field, charMax) a built document contains — the index the sweep needs to know which docs to open |
| `notifications` | per tenant | where a `spec_change` notice lands |

`spec_watch_list` columns, and the migration that added each:

| Column | Added by | Means |
| --- | --- | --- |
| `id`, `source_url` (UNIQUE), `display_name`, `affected_fields` (JSONB), `current_hash`, `last_checked_at`, `is_test`, `created_at` | `migrateAddSpecTables.js` | the original row |
| `last_error` | `migrateAddDetector.js` | last failure text |
| `expected_content`, `anchor_scope`, `consecutive_failures` | `migrateAddSpecAnchors.js` | the anchor assertion |
| `consecutive_unconfirmed`, `last_unconfirmed_reason` | `migrateAddUnconfirmedTracking.js` | the second streak |
| `source_kind` | `migrateAddSourceKind.js` | `platform_enforced` \| `observed_practice` |
| `content_stop_marker` | `migrateAddContentStopMarker.js` | per-row truncation point |
| `first_baselined_at`, `last_changed_at`, `change_count` | `migrateAddWatchRunHistory.js` | run history that **accumulates** rather than resetting |

`copy_fields` spec columns:

| Column | Added by | Means |
| --- | --- | --- |
| `spec_source` | `migrateAddSpecColumns.js` | the cited URL, or the `quillio_default` sentinel |
| `spec_version` | `migrateAddSpecColumns.js` | written `'1.0'` at seed and **moved by nothing** — deliberately dropped from `getTenantLibrary`'s SELECT so it cannot render |
| `spec_note` | `migrateAddCopyFieldSpecNote.js` | hand-written writing guidance |
| `spec_type` | `migrateAddCopyFieldSpecType.js` | `enforced` \| `recommended` \| `house_default` \| null |
| `spec_verified_at` | `migrateAddSpecChangeLog.js` | the date a human read the cited page |
| `char_min_override`, `char_max_override`, `spec_note_override` | `migrateAddHouseDefaultOverrides.js` | the tenant's own value; base columns keep the seed's |

`spec_change_log`: `id, flag_id, asset_type, field_name, field_attr ('char_max' | 'spec_note'), old_value, new_value, tenant_count, source_url, changed_by, changed_at`.

#### Modules — who owns what

| File | Owns |
| --- | --- |
| `src/services/specDetector.js` | the whole detection path: `normalize`, `truncateAtMarker`, `hashableText`, `hashText`, `checkAnchor`, `fetchText`, the eight-branch run loop, and every write to `spec_watch_list` / `spec_review_queue` |
| `src/services/specReview.js` | **the only place that writes `copy_fields`.** `getFlagForReview`, `getSuggestions`, `buildPreview`, `commitReview`, `dismiss`, plus the pure `tenantValueBreakdown` / `changedRows` |
| `src/services/specSweep.js` | the correction sweep: scope rules (`CORRECTABLE_TIERS`, override skip), the watermark, per-tenant document correction, notification dispatch |
| `src/db/specWatch.js` | reads for both global tables — `getWatchList` (six-tier column fallback), `getReviewQueue`, `getDetectionHealth`, `getWatchStateBySource` (the tenant-safe subset), `get/setTestPageContent` |
| `src/db/specSweep.js` | the sweep's reads/writes — `getSweepState`, `setSweepState`, `getChangesSince`, `getLibraryRows`, `getSweepableProjects`, `hasSpecNotification`, `updateManifestMax` |
| `src/utils/specSource.js` | `specSourceName` (URL → platform display name; the *only* implementation) and `specPlacementName` (Meta's placement slug) |
| `src/utils/specFreshness.js` | the two currency sentences and the eight-state machine that composes them, shared by the document and the settings panel |
| `src/utils/specNotice.js` | the `spec_change` notification wording and its routing link |
| `src/destinations/googleDocs.js` | what actually renders: `specTypeLine`, `fieldHint`, `fieldBracket`/`fieldLabel`, `stripReaderOnlyLines`, `SPEC_SOURCE_DETAIL`, `NOTE_SOURCE_LINKS`, `MIN_COLLAPSE_RUN`, `provenanceKey`, `correctFieldBrackets`, and `parseDoc`'s bracket/provenance ranges |
| `src/db/assets.js` | `getTenantAssets` — resolves `COALESCE(<col>_override, <col>)`; `isSeededAssetName`, `isTenantEditableTier` |
| `src/routes/admin.js` | the nine HTTP endpoints below |
| `src/routes/settings.js` | joins `spec_source` → watch state and attaches `freshness` per field |
| `src/middleware/requireAdmin.js` | `users.is_admin`, **404 on every failure**, never 403 |
| `src/data/defaultAssets.js` | the bundled library — 34 assets, 231 fields, every tier and citation |
| `public/admin.html` | the review console (437 lines) |
| `public/settings.html` | `libFreshnessNode`, `libTierNode`, the run-based dedup |

#### Cron

Two separate Railway services, because a Railway service runs exactly one start
command:

| File | Command | Schedule |
| --- | --- | --- |
| `railway.cron.json` | `node scripts/runDetection.js` | `0 15 * * 1` — Mondays 15:00 UTC |
| `railway.spec-sweep.cron.json` | `node scripts/runSpecSweep.js --commit` | `0 18 * * 1` — Mondays 18:00 UTC |

They are deliberately not chained. `runSpecSweep.js`'s header says why: the
detector only queues work for a human, so a sweep run immediately after it would
sweep last week's approvals and then idle. The three-hour gap is so their logs
do not interleave.

#### Admin surface

All `requireAdmin`-gated except one:

| Route | Does |
| --- | --- |
| `GET /admin` | the console |
| `GET /admin/api/watch-list` | raw watch rows |
| `GET /admin/api/health` | `getDetectionHealth` + `unconfirmedAlertAt` (the threshold rides the payload so page and detector cannot drift) |
| `GET /admin/api/review-queue` | all flags |
| `GET /admin/api/flag/:id` | one flag + every affected pair's current values and divergence |
| `GET /admin/api/flag/:id/suggestions` | re-fetch the page, ask Gemini per field. Writes nothing |
| `POST /admin/api/dismiss` | flag → `dismissed`. Never touches `copy_fields` |
| `POST /admin/api/approve-preview` | the diff. Writes nothing |
| `POST /admin/api/approve-commit` | **the only write path** |
| `POST /admin/api/run-detection` | manual run |
| `GET /admin/test-spec` | **public on purpose** — the detector fetches it over HTTP with no session. Serves only fake seed data |

#### Scripts

62 of the 132 files in `scripts/` touch spec data. The ones that matter:

*Runners* — `runDetection.js`, `runSpecSweep.js` (dry run by default).

*Read-only diagnostics* — `checkSpecHealth.js` (fetches; ten checks; exits 1 if a
human is needed), `auditWatchList.js` (four stored-state checks), `probeSpecPage.js`
(candidate-page probe; imports nothing from `src/db`), `exportActiveSpecs.js`
(CSV/JSON of active verified specs), `exportSpecsAudit.js`, `suggestFlag.js`,
`queryAssetSpecs.js`, `queryAssetTypes.js`.

*Repair* — `rederiveAffectedFields.js` (`--only=<id>`, dry run by default, no
`--all`), `reopenFlag1.js`, `setTestSpec.js`, `cleanupAnchorProbe.js`.

*Schema* — `migrateAddSpecTables`, `migrateAddSpecColumns`, `migrateAddDetector`,
`migrateAddSpecAnchors`, `migrateAddUnconfirmedTracking`, `migrateAddSourceKind`,
`migrateAddContentStopMarker`, `migrateAddWatchRunHistory`, `migrateAddSpecChangeLog`,
`migrateAddHouseDefaultOverrides`, `migrateAddProjectFieldManifest`,
`migrateAddSpecSweepState`.

*Data — value and tier* — `migrateAddCopyFieldSpecType(+Fixes)`,
`migrateSpecIntegrityFixes`, `migrateFixMetaSpecs`, `migrateFixLinkedInIntroText`,
`migrateFixLinkedInCarouselIntro`, `migrateAssetSpecFixes`,
`migrateOrganicAndGraphicHeadlineSpecs`, `migrateEmailClassesAndCitedBands`,
`migrateCiteColdEmailBand`, `migrateEmailBodyWordCounts`,
`migrateBackfillSeededSpecType`, `migrateClearRedundantOverrides`.

*Data — citation and watch rows* — `migrateFixGoogleSpecSource`,
`migrateMetaPlacementCitations`, `migrateSplitMetaWatchRows`,
`migrateAddLinkedInCarouselWatch`, and the five anchor-replacement migrations
`migrateFixMetaImageAnchor`, `migrateFixXAnchor`, `migrateFixGoogleDisplayAnchor`,
`migrateFixLinkedInCarouselAnchor`, `migrateFixLinkedInSingleImageAnchor`.

*Data — verification dates* — `migrateBackfillSpecVerifiedAt` (25 pairs,
2026-08-20), `migrateVerifySoleWitnessSpecs` (10 pairs, 2026-08-25).

*Data — new assets, each creating or reusing a watch row* —
`migrateAddGoogleSearchAsset`, `migrateAddGoogleVideoAssets` (two rows),
`migrateAddPinterestSpecs`, `migrateAddPinterestAdFormats`, `migrateAddXPollAd`,
`migrateAddLinkedInConversationAd`, `migrateAddXConversationButtonAd`,
`migrateAddXSpotlightAndLive`.

*Shared migration libraries* — `scripts/lib/anchorChoice.js` (candidate ranking,
section span, sole-witness arithmetic; the per-page *evidence* deliberately stays
in each migration), `scripts/lib/wholeNumber.js` (a stored limit is a whole
number, not a digit substring).

---

## PART 2 — THE DETECTION PATH, END TO END

### The trigger

Monday 15:00 UTC, Railway starts a container whose only job is
`node scripts/runDetection.js`. That script requires `DATABASE_URL`, calls
`runDetection()` in process, prints the summary and the per-row lines, prints the
review queue, and exits. `POST /admin/api/run-detection` calls the identical
function.

`runDetection()` opens with a pool check and then `getWatchList()` — ordered
`is_test, display_name NULLS LAST, id`, so real rows come first and the test row
last. That read is itself defensive: `db/specWatch.js` tries six column sets
newest-first and drops a tier on a Postgres `42703`, so a deploy that lands
before a migration reads fewer columns rather than failing. Critically, a
degraded tier returns a row that **lacks the key** rather than one holding null —
`hasAnchorColumns(row)` is `hasOwnProperty('consecutive_failures')` — because
"column absent" and "column present and NULL" are different states and only the
first means *do not write here*.

The summary object is pre-seeded with every status at zero:

```js
const summary = {
  total: rows.length,
  baseline: 0, unchanged: 0, changed: 0, unconfirmed: 0,
  failed: 0, error: 0,
  unanchored: 0, stuck: 0, not_watched: 0,
};
```

`unanchored` and `stuck` are **axes, not statuses** — a row can be unanchored and
unchanged at once, or unconfirmed this week and stuck for a month. The
pre-seeding is so a clean run reports `0` rather than omitting the key.

### The four reductions, in order

Order is load-bearing and each step is asserted by a test.

**1. `normalize(html)`** — drop `<script>`/`<style>` *and their contents*, strip
all remaining tags, remove per-request digit tokens, collapse whitespace, trim:

```js
function normalize(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(PER_REQUEST_TOKEN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
```

`PER_REQUEST_TOKEN` is `/\d{12,}/g`. Twelve is not sized off the token it was
written for; it is sized off **the library's own range**. The largest number
`defaultAssets.js` holds anywhere, prose included, is 8000 (LinkedIn Conversation
Ad's Message Text and its three Option Responses). Twelve digits is eight orders
clear of that, so the rule cannot consume a number this system watches for. The
constant is exported purely so a test can assert the boundary from both sides —
11 digits kept, 12 stripped — which is what makes it hard to quietly "tidy" into
`\d{4,}`.

It exists because `support.google.com` serves a hidden per-request id as a text
node inside a `display:none` div. The tag strip removed the div and left the
digits, so every fetch hashed differently and the Google row reported
`unconfirmed` for five weeks without ever surfacing anything.

**2. `truncateAtMarker(text, marker)`** — everything before the marker's first
occurrence, or `null` if a configured marker is absent:

```js
function truncateAtMarker(text, marker) {
  const m = typeof marker === 'string' ? marker.trim() : '';
  if (!m) return String(text || '');
  const at = String(text || '').indexOf(m);
  if (at < 0) return null;
  return String(text || '').slice(0, at).trim();
}
```

The two Meta rows carry `"View available calls to action"`. Meta's per-format
pages **permute their call-to-action list on every request** — same items, same
count, ~480–530 characters of churn against pages of 4,200–5,600. That is not a
number, so the digit rule cannot touch it, and sorting the text would destroy
ordering semantics for every other row. Every spec number on those pages appears
before that phrase.

It is **per-row data, not a rule in `normalize()`**, and that is the whole
argument: on the row it applies to the row that owns it and is NULL everywhere
else, so no other entry's hashable text moves by a byte and nothing re-baselines.
The same proposal was *rejected* for Google, where it would have been code.

A set-but-absent marker returns `null` and routes to `failed`, never a fallback
to the full text — falling back would silently reintroduce the shuffle with
nothing naming the cause, which is the five-week Google outage rebuilt.

**3. `hashableText(row, html)`** — the one sanctioned composition:

```js
function hashableText(row, html) {
  return truncateAtMarker(normalize(html), row && row.content_stop_marker);
}
```

It exists because the run loop fetches **twice** and a truncation applied to only
one of them would make the two disagree every run — `unconfirmed` forever, caused
by the fix. A test asserts the run loop calls `normalize()` directly zero times.

**4. `checkAnchor(row, raw, normalized)`** — is this the page we meant?

```js
function checkAnchor(row, raw, normalized) {
  const anchor = row && typeof row.expected_content === 'string' ? row.expected_content.trim() : '';
  if (!anchor) return { ok: true, anchored: false, anchor: null };
  const scope = row.anchor_scope === 'raw' ? 'raw' : 'normalized';
  const hay = scope === 'raw' ? String(raw || '') : String(normalized || '');
  return { ok: hay.includes(anchor), anchored: true, anchor, scope };
}
```

`fetchText` throws only on non-2xx or timeout, so a 200 serving a soft-404, an
auth interstitial or an empty JS shell flows straight down the success path,
hashes to something stable, and reports `unchanged` forever. On a *first* run it
is worse: `sha256('')` becomes the legitimate baseline and every later run agrees
with it.

Scope is per row because both choices are wrong for some page — `normalize()`
strips `<script>` contents, so an anchor in a JSON island vanishes from a healthy
page; raw HTML carries every nav label, so a generic anchor survives on an error
page sharing the site's chrome.

**The anchor is checked against the truncated text**, not the whole page. An
anchor living past the stop marker would assert that content we then throw away
rendered — the "anchor that cannot fail" this project already rejected once.

Then `hashText` is `sha256(normalized)` hex.

### The branches

For each row, in source order.

---

**`not_watched`** — first, before any network.

```js
if (isObservedPractice(row)) {
  summary.not_watched += 1;
  results.push({ ..., status: 'not_watched', last_checked_at: null, ... });
  console.log(`[detector] ${row.display_name}: not_watched (observed practice — ages, does not change)`);
  continue;
}
```

**Written:** nothing. Not even `last_checked_at`, which would have the health
page reporting "checked 2 minutes ago" about a page nobody requested.

**Human sees:** on the admin health table, Type shows a second line "observed
practice"; Last checked reads `not checked`; Baselined and Anchor read `n/a`;
Problem reads "observed practice — not hash-watched / ages rather than changes;
can never raise a flag". The summary line adds "Not hash-watched: 2
observed-practice sources — dated guidance, never flagged". On the tenant
settings panel the field reads *"Measured practice, not a platform limit — the
page does not change, it ages."*

**Why:** on 2026-08-05 a single run produced 6 pending flags, all Litmus, both
pages having changed twice in that one run. A queue that fills with noise teaches
a reviewer to dismiss Litmus flags, and a reviewer who has learned that will
eventually dismiss a real one. Those 6 were dismissed in the same transaction as
the reclassification.

The default is the other way — anything not explicitly `'observed_practice'` is
watched, including a row from a database where the column does not exist. The
pre-migration behaviour is the one every row has today, and defaulting the other
way would silently stop watching the whole list on a deploy that lands first.

---

**`unanchored`** — an axis, incremented before the fetch:

```js
if (!anchored) summary.unanchored += 1;
```

read off the **row**, not off `anchorInfo`, because an entry whose fetch threw is
not thereby unanchored — whether an anchor is configured is true or false before
the run starts. Observed-practice rows are excluded, because calling a row that
is never fetched "unanchored" would inflate the number that measures a real gap.

**Written:** nothing on this axis alone. **Human sees:** "Anchors: 12 of 12
asserted" on the console summary; on settings, *"We cannot confirm these checks
are reading the right page."* Live reading: `unanchored: 0`.

---

**`failed` (stop marker)** — checked **before** the anchor:

```js
if (normalized === null) {
  error = `content stop marker not found: ${JSON.stringify(row.content_stop_marker)}`;
  failures = await bumpFailure(pool, row, error);
  status = 'failed';
}
```

The order matters: `normalized === null` means we do not yet know what region of
the page we are looking at, so there is nothing meaningful to run an anchor
against, and `checkAnchor` on a null haystack would name the *anchor* as the
thing that missed. Naming the wrong string is worse than naming none.

---

**`failed` (anchor)**:

```js
const anchorInfo = checkAnchor(row, html, normalized);
if (!anchorInfo.ok) {
  error = `anchor not found in ${anchorInfo.scope} content: ${JSON.stringify(anchorInfo.anchor)}`;
  failures = await bumpFailure(pool, row, error);
  status = 'failed';
}
```

**Written** (`bumpFailure`): `last_checked_at = NOW()`, `last_error`,
`consecutive_failures = COALESCE(consecutive_failures,0) + 1`. **Never**
`current_hash` — the last good baseline survives however long the failure lasts,
so a recovery compares against the right thing. No flag.

The counter is the point: "failed once" (a bad morning) and "failed for six
weeks" (the anchor is wrong, the page is gone) look identical in one run's
output, and only the second needs a human. The error names the string verbatim
and quoted, because "the page changed shape" and "the anchor was always wrong"
are indistinguishable from a bare *anchor not found*.

**Human sees:** an `err-row` on the health table with the full error in the
Problem column, and "N failed runs in a row" next to the Anchor cell. On
settings, from two failures or any error: *"The last few checks could not read
this page."* — and deliberately with **no date**, because `bumpFailure` stamps
`last_checked_at` on a failure too, so a date there would name when we last
*tried* and read as when we last *succeeded*.

---

**`baseline`**:

```js
} else if (!row.current_hash) {
  await pool.query(
    `UPDATE spec_watch_list SET current_hash = $1, last_checked_at = NOW(), last_error = NULL${resetStreaks(row)}${stampFirstBaseline(row)} WHERE id = $2`,
    [newHash, row.id]);
  status = 'baseline';
}
```

`stampFirstBaseline` is `first_baselined_at = COALESCE(first_baselined_at, NOW())`
— a re-baseline after a repoint keeps its *original* date, because "when did this
row first start watching anything" is the stable fact and a column that drifts
under a repoint is the confidently-wrong-date failure `checkSpecHealth` already
declined to build.

**Human sees:** on settings, *"Watching starts at the next check."*

---

**`unchanged`**:

```js
} else if (row.current_hash === newHash) {
  await pool.query(
    `UPDATE spec_watch_list SET last_checked_at = NOW(), last_error = NULL${resetStreaks(row)} WHERE id = $1`,
    [row.id]);
  status = 'unchanged';
}
```

`resetStreaks` clears both counters. **Human sees:** the health row is quiet;
settings renders *"We watch that page for edits — not the number. Last checked
2026-08-19: no change."* The withdrawal comes **first** and the date second, so
the sentence reads as a limit on what we know rather than as a badge. A clean
state gets no accent; only a non-clean one is marked.

---

**The refetch-and-confirm step.** A moved hash is not flagged on first
observation:

```js
await sleep(REFETCH_DELAY_MS);
const confirmText = hashableText(row, await fetchText(row.source_url));
confirmHash = confirmText === null ? null : hashText(confirmText);
```

`REFETCH_DELAY_MS` reads with `Number.isFinite`, not `|| 1500`, so `SPEC_REFETCH_DELAY_MS=0`
means 0 — the obvious value when you want a run to go fast, and the one `||`
silently turns back into the default.

**What it protects against:** transient per-request noise — dynamic widgets,
counters, nonces that survive the tag strip and change every fetch. A genuine
spec edit is stable and reproduces.

**What it does not protect against, and the report says so because the health
check's own output does:** a value that rotates *hourly*, per session or per CDN
edge. Two fetches 1.5s apart agree, the row reports **`changed`** and
**confirms**, and it arrives in the queue looking exactly like a real spec
change. That is the failure shape of the 2026-09-02 Google flags.

Two ways not to confirm are kept apart, because a streak counter is only
actionable if the run says which: `'page varies per request'` and
`'refetch failed: <reason>'`.

---

**`changed`**:

```js
if (confirmHash && confirmHash === newHash) {
  await recordChange(pool, row, newHash);
  status = 'changed';
}
```

`recordChange` is a transaction — insert the flag, then advance the hash — so we
never insert a flag but fail to move the hash, which would re-flag the same
change every run:

```sql
INSERT INTO spec_review_queue (watch_id, source_url, old_hash, new_hash, detected_at, status, is_test)
  VALUES ($1, $2, $3, $4, NOW(), 'pending', $5)
UPDATE spec_watch_list SET current_hash = $1, last_checked_at = NOW(), last_error = NULL,
  consecutive_failures = 0, consecutive_unconfirmed = 0, last_unconfirmed_reason = NULL,
  last_changed_at = NOW(), change_count = COALESCE(change_count, 0) + 1 WHERE id = $2
```

`is_test` is inherited onto the flag row, which is what keeps test-page changes
structurally isolated.

There is deliberately **no second anchor check** on this branch, and the source
says not to add one: `confirmHash === newHash` means the refetch produced text
identical to the first fetch, which `checkAnchor` already verified. A
`checkAnchor` call here could never fail — dead code that reads like a safeguard.

**Human sees:** the flag appears in the admin queue with truncated old/new
hashes and Approve / Dismiss buttons. Every field citing that page now renders,
in **settings**: *"This page changed on 2026-09-02 and is waiting on review —
this number may be out of date."* That is the one withdrawal carrying a real
event date (`spec_review_queue.detected_at`). **The generated document says
nothing** — a document is a file, frozen at creation.

`pending` outranks the mechanical faults in the freshness state machine, which is
a judgement: `failing`/`unstable`/`unanchored` say *we cannot tell you anything*
about the mechanism; `pending` says *we saw this page change* about the number,
and the reader is deciding whether to trust a limit.

---

**`unconfirmed`**:

```js
unconfirmedReason = refetchError ? `refetch failed: ${refetchError}` : 'page varies per request';
streak = await bumpUnconfirmed(pool, row, unconfirmedReason);
status = 'unconfirmed';
```

`bumpUnconfirmed` **clears** `last_error` and `consecutive_failures` — we read the
page, twice, so the URL and anchor are demonstrably fine — while incrementing
`consecutive_unconfirmed` and storing the reason. `current_hash` is untouched, so
the baseline never advances to a value we could not reproduce.

**Two counters, not one, because the reset rules differ.** An unconfirmed run
clears the failure count; a failed or errored run leaves the unconfirmed streak
*untouched* — neither incrementing nor resetting, because a week we could not
read says nothing about whether the page holds still. A row that goes unconfirmed
twice, errors three weeks, then goes unconfirmed again reads 3, and 3 is the true
answer.

This is the one status that is repeatable, silent and terminal at once: a page
that genuinely changed *and* varies per request reports it every week forever.

---

**`error`** — the outer catch:

```js
error = err.message || String(err);
failures = await bumpFailure(pool, row, error);
status = 'error';
```

Same write as an anchor miss, same non-touching of `current_hash`. A single bad
URL never stops the run.

---

**`stuck`** — an axis, from `UNCONFIRMED_STREAK_ALERT = 3`:

```js
if (streakAfter >= UNCONFIRMED_STREAK_ALERT) summary.stuck += 1;
```

One is the confirm step working as designed; two is two bad Mondays; three is a
month with no usable comparison. The streak is **reported from 1 upward** and
only the alert waits for 3, so a row climbing 1 → 2 is visible on the way rather
than appearing fully formed after a month.

**Human sees:** the health summary gains "Stuck: N entries with no usable
comparison for 3+ runs"; the row turns red and Problem reads "unconfirmed 3 runs
in a row — NOT BEING WATCHED" with the stored reason beneath. On settings:
*"This page reads differently every time, so we cannot tell whether the spec
moved."* Live reading: `stuck: 0`.

### Reporting

Two subtleties in the reported values. The failure count reports what it **is**
after the run, not only what the run wrote — `if (failures === null && hasAnchorColumns(row)) failures = 0`
— because reporting null-on-success beside a streak that reports 0 would invite a
reader to infer a difference that is not there. And `last_checked_at` is stamped
**after** the work, not at the top of the loop, because a run with a refetch
spends 1.5s in the middle and the run output and health page were disagreeing by
seconds about the same event.

---

## PART 3 — THE REVIEW AND WRITE PATH

### What happens to a flag

A `pending` row in `spec_review_queue`. It carries the two hashes, the URL, the
detection time and `is_test`. It carries **no diff of the page** — LiveSpecs
never stores page text, only hashes — so the review is not "read what changed",
it is "go and look at the page, and tell us what it says now".

### The console

`public/admin.html` renders the queue as cards, real entries and test entries in
separate lists. Each card has **Dismiss** and **Approve**. Approve opens an
overlay populated from `GET /admin/api/flag/:id`, which returns one entry per
`(asset, field)` pair in the watch row's `affected_fields`, each with:

- `tenant_count`
- `current_char_max` / `current_spec_note` — `distinctValue`, which joins
  disagreeing tenants as `"150 | 200"`
- `char_max_divergence` / `spec_note_divergence` — the `tenantValueBreakdown`

**The form is populated *from* `affected_fields`.** A field that is not in that
array is not offered, which is the first and most consequential gate — see Part 8.

`tenantValueBreakdown` turns the joined string into something an admin can act
on: which value most rows hold (`expected`), how many rows hold it, and every
other value with the tenant ids holding it. A joined string is not a fact you can
act on; it does not say how many tenants sit on each value or which ones. Ties
break on first-seen, which is the lowest `tenant_id` because `currentValues`
orders by it — deterministic, so the same state always previews the same way.

`currentValues` carries `AND at.is_active`, and this is the **only** read in the
file that joins `asset_types`, so all four callers inherit it. Deactivating is how
this schema removes an asset type; counting a dead row would inflate `tenant_count`
and pad the divergence breakdown with tenants who are not affected. Inert today
— nothing retired so far has a tiered field — so it is the guard for the next
retirement, not a fix for a live miscount.

### The extraction pre-fill

`GET /admin/api/flag/:id/suggestions` → `specReview.getSuggestions`:

```js
pageText = normalize(await fetchText(flag.source_url));
const raw = await extractSpecValues({ pageText, fields });
```

The Gemini prompt is explicit — *"use ONLY numbers actually present in the page
text… Do NOT guess or invent numbers"* — and asks for a `suggested_char_max`, a
verbatim `snippet` under 160 chars, and a `confidence`. Results map back by `ref`
(index), never by field name, so a name repeated across assets cannot cross-wire.
Every value is sanitised to a positive integer ≤ 100000 or null.

**It writes nothing, and it is a suggestion.** A test flag returns
`{ ok: false }`; a fetch or model failure degrades to `{ suggestions: [], note }`
and the admin types by hand.

### The diff

`POST /admin/api/approve-preview` → `buildPreview`. It runs the full guard, then
re-reads current values and emits one change per attribute:

```js
changes.push({ asset, field, attr: 'char_max', old: distinctValue(rows,'char_max'),
               new: String(e.charMax), tenant_count: rows.length,
               divergence: tenantValueBreakdown(rows, 'char_max') });
```

plus a preview-level roll-up (`diverged`, `divergent_field_count`) and a
`console.warn` naming every divergent field, its expected value and which tenants
hold something else. **It writes nothing.**

### The selective approve

The admin ticks fields and types values per field. `collectEdits` in the console
sends only what was filled. Every edit is independently validated.

### The transactional write

`POST /admin/api/approve-commit` → `commitReview(flagId, edits, req.user.id)`.
One `pg` client, one `BEGIN`. Per field: capture `before` *inside* the
transaction, build the SET clause, run the UPDATE, check the row count, log,
then flip the flag, then `COMMIT`. Any throw rolls the whole thing back.

```sql
UPDATE copy_fields cf
   SET char_max = $1, spec_verified_at = NOW()
  FROM asset_types at
 WHERE cf.asset_type_id = at.id
   AND at.name = $2
   AND cf.field_name = $3
   AND at.is_active
 RETURNING at.tenant_id
```

### What `commitReview` writes

- `copy_fields.char_max` and/or `copy_fields.spec_note`, **for every tenant at
  once** — one platform changing a limit for everyone is the designed behaviour,
  which is why there is deliberately no tenant predicate.
- `copy_fields.spec_verified_at = NOW()`, **always**, on every matched row, even
  when only a note moved. The write is a human having read the page.
- One `spec_change_log` row per changed attribute.
- `spec_review_queue.status = 'reviewed'`.

### What it deliberately does not write

- **`char_min`.** No path in the review flow sets a floor.
- **`spec_source`.** Repointing a citation is a migration, never an approval.
- **`spec_type`.** A retier is a migration.
- **`spec_version`.** The SET clause does not name it. It holds `'1.0'` on every
  row and always will — which is why it was dropped from `getTenantLibrary`'s
  SELECT rather than stamped: a name asserting a history the system does not keep
  is worse than no column.
- **The override columns.** `char_max_override` / `spec_note_override` are the
  tenant's, and the base/override split exists precisely so a cross-tenant write
  cannot drag an overriding tenant along.
- **Anything on `spec_watch_list`.** An approval does not re-derive
  `affected_fields`, re-anchor, or re-baseline.

### What `dismiss` does

```sql
UPDATE spec_review_queue SET status = 'dismissed' WHERE id = $1 AND status = 'pending' RETURNING id
```

That is the entire function. It never touches `copy_fields`, it is allowed for
any flag including a test flag, and it is guarded on `status = 'pending'` so a
double-dismiss reports "not found or not pending" rather than silently
succeeding. The detector has already advanced `current_hash`, so a dismissed
flag does not re-raise next week.

### The audit trail

`spec_change_log`: `flag_id`, `asset_type`, `field_name`, `field_attr`,
`old_value` (the joined distinct across tenants), `new_value`, `tenant_count`,
`source_url`, `changed_by` (the signed-in admin's `users.id`), `changed_at`.

Two things it deliberately is not. It is **not per tenant** — `old_value` is a
summary across every tenant row, which is exactly why `db/specSweep.getLibraryRows`
re-reads each tenant's own row rather than trusting the log. And it records
**approvals only**: a dismissal writes no row and carries no actor. There is no
`dismissed_by`, no `dismissed_at`, no `reviewed_at`.

Alongside the table, two `console` records that are not in any table: a
`[specReview] preview` warning naming every divergent field before the write, and
a `[specReview] commit` warning naming every row whose value actually changed,
with `[diverged]` on the ones that held something different from everyone else.
The commit response carries the same as structured data — `overwritten`,
`overwritten_count`, `diverged_overwritten_count`.

`changedRows` reports only rows whose **value** moved. The write also stamps
`spec_verified_at` on every matched row, and calling a re-stamp an overwrite
would bury the real ones in noise.

### Every guard on the write path

| # | Guard | Where | Refuses |
| --- | --- | --- | --- |
| 1 | `requireAdmin` | `middleware/requireAdmin.js` | anyone without `users.is_admin = true`. **404, never 403** — a 403 confirms the route exists |
| 2 | flag exists | `guardEdits` → `loadFlag` | `'flag not found'` |
| 3 | **`is_test` hard block** | `guardEdits` | `'test flags cannot be approved -- dismiss only'`. A test flag can never write `copy_fields` |
| 4 | status is `pending` | `guardEdits` | `'flag is already reviewed'` / `dismissed` — no double-write, no reviving a dismissal |
| 5 | non-empty edit list | `guardEdits` | `'no fields selected for update'` |
| 6 | asset + field present | `guardEdits` | `'an edit is missing asset/field'` |
| 7 | **affected-pair check** | `guardEdits` → `affectedPairSet` | `'"X / Y" is not an affected field of this flag'`. Matched on the *pair*, because a field name repeats across assets |
| 8 | `char_max` shape | `validateEdit` | non-integer, ≤ 0, or > 100000 |
| 9 | `spec_note` shape | `validateEdit` | empty after trim, or > 2000 chars |
| 10 | at least one attribute | `validateEdit` | `'no new value provided'` |
| 11 | **guards run twice** | `buildPreview` *and* `commitReview` | a client that skips the preview, or state that moved between the two steps |
| 12 | **zero-row guard** | `commitReview` | `SpecWriteRefusal` — the whole transaction rolls back |
| 13 | `AND at.is_active` | the UPDATE | a deactivated asset's rows |
| 14 | transaction | `commitReview` | any partial write; one throw rolls back values, log rows and the status flip together |

Guard 12 is the one worth quoting, because the first eleven ask whether an edit
is *allowed* and this one asks whether it *landed* — a different question, and
the one that was going unasked:

```js
if (tenantCount === 0) {
  throw new SpecWriteRefusal(
    `"${e.asset} / ${e.field}" matched no live copy_fields row, so NOTHING was written and ` +
    `flag #${flag.id} is still pending. That pair is listed in this watch entry's ` +
    'affected_fields, which was computed once when scripts/migrateAddSpecTables.js seeded ' +
    'the watch list and is never recomputed — so since then the asset has been renamed, or ' +
    'every row behind it has been deactivated. …');
}
```

Without it: `spec_change_log` gets a row saying a spec changed for zero tenants,
the flag flips to `reviewed` so the queue stops showing it, and the response says
"Written." The admin is told a platform's new limit is in place. It is not, and
nothing will say so again.

The refusal class exists so `commitReview`'s catch can pass this message through
**verbatim** — it is addressed to the admin and names what to do — while any
other error keeps the generic `'write failed -- rolled back, nothing changed'`,
because a driver or constraint message is not something to put in front of a
user.

### The sweep — what happens after the write

`spec_change_log` is the sweep's input queue. `getChangesSince` reads rows newer
than the watermark, **`WHERE field_attr = 'char_max'` only** (a note change is
rendered by the italic line, which no existing document reproduces from stored
state), ordered `(changed_at, id)` — a tuple, because one approval writes several
rows sharing a timestamp to the microsecond.

The scope rules:

```js
const CORRECTABLE_TIERS = new Set(['enforced']);

function evaluateRow(row) {
  if (!CORRECTABLE_TIERS.has(String(row.specType || ''))) return { eligible: false, reason: `tier_${row.specType || 'null'}` };
  if (row.charMaxOverride != null) return { eligible: false, reason: 'tenant_override' };
  return { eligible: true, reason: null, effectiveMax: row.charMaxOverride != null ? row.charMaxOverride : row.charMax };
}
```

Three decisions in ten lines, each of them the recurring rule:

- **An allowlist of one, not `!== 'house_default'`.** A fourth tier would only
  ever be added to carry some new authority; fail closed on the authority axis.
- **`char_max_override IS NOT NULL`, not `spec_overridden`.** `spec_overridden` is
  a three-column OR, so a tenant who rewrote only the *note* reads as overridden
  while their maximum is still the base spec and their bracket still shows the old
  number. The coarse flag would leave exactly those tenants stale forever.
- **`char_min` is separate again.** A tenant who set their own floor keeps it,
  because the replacement bracket is composed from the minimum the **document**
  already carries.

Projects are filtered by **exclusion** (`EXCLUDED_STATUSES = ['finished','closed']`),
never enumeration: a status invented next year is swept by default, which is the
direction that fails loudly.

And the document is the final authority. `correctFieldBrackets` refuses a field
whose bracket does not read the value the change is moving away from
(`reason: 'not_at_old_value'`), whether because the sweep already corrected it or
because a writer edited it by hand. That is also what makes a re-run idempotent.

The watermark advances only over a change that **fully** finished, and the first
one that did not stops it — every later change is left for next run even if it
would have succeeded. Skipping ahead would mean those documents are never
corrected and that notification is never written, by a background job with nobody
watching.

A revoked Google token is expected rather than exceptional: `isInvalidGrant`
skips that tenant by name, marks the change incomplete so the watermark holds,
and keeps sweeping everyone else — which is what makes the corrections arrive on
their own once the person signs in again.

---

## PART 4 — THE DATA

### Provenance of the figures in this part

The 34 assets, 231 fields, tier counts and `spec_source` census below are
**computed in this session from `src/data/defaultAssets.js` at `7412f07`** — the
bundled library a new tenant is seeded from. They are the repository's account.

The watch-row table's URLs, display names, stop markers and source kinds are read
from the migrations that create and repoint those rows. The **anchor strings are
each migration's preferred candidate**; five rows have their anchor chosen at run
time by `scripts/lib/anchorChoice.js` against the live page, and **no file in
this repo records that those five migrations have been committed in production**.
The stored anchors are therefore **unread**.

`affected_fields` counts are **derived today from the seed**, i.e. what
`rederiveAffectedFields.js` would produce. The **stored** values are snapshots
taken when each row was created and are recomputed by nothing — for at least
three rows they are known to be smaller than the derived figure (Part 8). The
stored values are **unread**.

### The 14 watch rows

| # | Display name | URL | Anchor (preferred candidate) | Scope | Stop marker | Source kind | Derived pairs |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Meta – image | `facebook.com/business/ads-guide/update/image/facebook-feed` | `File Type: JPG or PNG Ratio: 4:5 Resolution: 1440 x 1800 pixels Text` | normalized | `View available calls to action` | platform_enforced | 2 |
| 2 | Meta – carousel | `…/ads-guide/update/carousel/facebook-feed` | `Description` | normalized | `View available calls to action` | platform_enforced | 7 |
| 3 | LinkedIn – single image | `business.linkedin.com/advertise/ads/sponsored-content/single-image-ads-specs` | `Text Recommendations` | normalized | — | platform_enforced | 3 |
| 4 | LinkedIn – carousel | `…/sponsored-content/carousel-ads/specs` | `Text Recommendations` | normalized | — | platform_enforced | 6 |
| 5 | LinkedIn – conversation ads | `…/sponsored-messaging/conversation-ads/specs` | `Message Text:` | normalized | — | platform_enforced | 11 |
| 6 | X | `business.x.com/en/help/campaign-setup/creative-ad-specifications` | `of your posts beyond your followers to your desired target audience` | normalized | — | platform_enforced | 8 |
| 7 | Google – responsive search | `support.google.com/google-ads/answer/7684791` | `responsive search ads have character limits` | normalized | — | platform_enforced | 7 |
| 8 | Google – responsive display | `support.google.com/google-ads/answer/17090561` | `Type Maximum length Quantity Required` | normalized | — | platform_enforced | 4 |
| 9 | Google – Performance Max | `support.google.com/google-ads/answer/17091269` | `exactly matches your domain name or legally verified business name` | normalized | — | platform_enforced | 9 |
| 10 | Google – Demand Gen video | `support.google.com/google-ads/answer/17091270` | `Final URL Any` | normalized | — | platform_enforced | 4 |
| 11 | Pinterest – product specs | `help.pinterest.com/en/business/article/pinterest-product-specs` | `size (9:16 ratio) Aspect ratio Aspect ratio is 9:16, but there are no` | normalized | — | platform_enforced | 19 |
| 12 | TEST PAGE | `quillio.co/admin/test-spec` | `Quillio Test Spec` | normalized | — | platform_enforced (`is_test`) | null — **load-bearing**, it is what stops a test flag naming a real field |
| 13 | Litmus – subject line | `litmus.com/blog/how-to-write-the-perfect-subject-line-infographic` | none | — | — | **observed_practice** | 10 (note-derived) |
| 14 | Litmus – preheader | `litmus.com/blog/the-ultimate-guide-to-preview-text-support` | none | — | — | **observed_practice** | 5 (note-derived) |

Rows 1–12 are fetched: **12 fetched, 2 never fetched**, matching the live
reading. The two Litmus rows are matched by `spec_note` **text**, not by
`spec_source` — their fields all carry `quillio_default` — which is why
`rederiveAffectedFields.js` refuses them by name: applying the URL rule would
derive empty and silently wipe 15 pairs of gate.

Rows 13–14 keep six permanently meaningless columns (`current_hash`,
`last_checked_at`, `consecutive_failures`, `consecutive_unconfirmed`,
`expected_content`, `anchor_scope`) rather than being deleted, because
`affected_fields` — the write gate — lives on the row, and deleting it leaves
those 15 pairs gated by nothing. The health page renders those columns as `n/a`
so they are not read as current.

**Two research citations are on no watch row at all** — Constant Contact and
Gong, one `recommended` field each. That is the rule working: a published finding
does not change, it ages, and hash-diffing a marketing blog fills the queue with
layout tweaks.

Two anchors worth their own line, because each records a rule:

- **Row 1's** anchor was `Primary Text`, which appears on `/image`, `/video` and
  `/collection` alike. A redirect between siblings passed the anchor, the numbers
  would change, and the row would flag `changed` — a wrong answer wearing the
  right status. `/image` and `/video` are byte-identical on Text Recommendations,
  so nothing in the measured output told them apart. The File Type line is where
  the two pages actually differ (JPG or PNG against MP4/MOV/GIF), and
  `migrateFixMetaImageAnchor.js` fetches **both** pages on every run and refuses
  to write if the new anchor turns up on the video page.
- **Row 10's** anchor was `Headlines 2 lines 40 characters per line` — clean,
  unique, and drawn from the **in-feed video** table, a format the same migration
  goes out of its way not to seed. It is kept in the candidate list as a recorded
  rejection so every run prints it being refused; a rejection recorded only in a
  commit message gets re-proposed by the next person who notices how clean it is.

### The 34 assets

| Group | Asset | Fields |
| --- | --- | --- |
| Paid Social | LinkedIn Single Image Ad | 6 |
| | LinkedIn Carousel Ad | 9 |
| | LinkedIn Conversation Ad | 11 |
| | Meta Single Image Ad | 6 |
| | Meta Carousel Ad | 10 |
| | Twitter/X Ad | 5 |
| | Twitter/X Poll Ad | 5 |
| | Pinterest Pin | 2 |
| | Pinterest Idea Ad | 2 |
| | Pinterest Showcase Ad | 4 |
| | Pinterest Quiz Ad | 11 |
| | Google Demand Gen Video Ad | 4 |
| Display | Display Banner — Standard | 4 |
| | Google Responsive Display Ad | 7 |
| Paid Search | Google Responsive Search Ad | 10 |
| | Google Performance Max | 9 |
| Email | Demand Gen Nurture Email | 9 |
| | Event Invitation Email | 7 |
| | Event Reminder Email | 7 |
| | Event Follow-Up / Recap Email | 6 |
| | Sales Basho Email | 6 |
| Events | Event Landing Page | 24 |
| | On-Site Signage — General | 4 |
| | On-Site Signage — Session Title Card | 4 |
| | On-Site Signage — Directional | 2 |
| Web | Campaign Landing Page | 16 |
| Organic Social | Organic Social — LinkedIn | 5 |
| | Organic Social — Instagram | 5 |
| | Organic Social — Twitter/X | 3 |
| Direct Mail | Direct Mail — Box / Mailer | 5 |
| | Direct Mail — Note Card / Rep Letter | 6 |
| | Direct Mail — Insert | 3 |
| Sales Enablement | One-Pager | 9 |
| | Battle Card | 5 |
| | **34 assets** | **231 fields** |

### The tier census

| Tier | Fields | Share |
| --- | --- | --- |
| `house_default` | 149 | 64.5% |
| `enforced` | 71 | 30.7% |
| `recommended` | 11 | 4.8% |
| null (tenant-authored) | 0 in the seed — created only by `createAssetType` | — |

**82 of 231 seeded fields carry a citation. 149 carry the `quillio_default`
sentinel** and are the tenant's to set in Settings.

### The `spec_source` census

| Fields | Tier | URL |
| --- | --- | --- |
| 149 | house_default | `quillio_default` (sentinel — never printed) |
| 19 | enforced | `help.pinterest.com/en/business/article/pinterest-product-specs` |
| 11 | enforced | `business.linkedin.com/…/conversation-ads/specs` |
| 9 | enforced | `support.google.com/google-ads/answer/17091269` |
| 8 | enforced | `business.x.com/en/help/campaign-setup/creative-ad-specifications` |
| 7 | recommended | `facebook.com/business/ads-guide/update/carousel/facebook-feed` |
| 7 | enforced | `support.google.com/google-ads/answer/7684791` |
| 6 | enforced | `business.linkedin.com/…/carousel-ads/specs` |
| 4 | enforced | `support.google.com/google-ads/answer/17091270` |
| 4 | enforced | `support.google.com/google-ads/answer/17090561` |
| 3 | enforced | `business.linkedin.com/…/single-image-ads-specs` |
| 2 | recommended | `facebook.com/business/ads-guide/update/image/facebook-feed` |
| 1 | recommended | `constantcontact.com/blog/best-length-email-newsletter/` — **not watched** |
| 1 | recommended | `gong.io/blog/do-execs-really-reply-to-cold-email…` — **not watched** |

80 of the 82 cited fields sit behind a watch row. The two that do not are the two
that should not.

### Where the numbers came from, and which migration quotes which page

Every one of these carries the fetched text in its header, which is what the
fetch rule requires:

| Migration | Page | Reading |
| --- | --- | --- |
| `migrateFixMetaSpecs.js` | Meta `/image`, `/video`, `/carousel`, `/collection` | all four quoted; a test asserts the quotes are present rather than trusting the comment |
| `migrateFixLinkedInIntroText.js` | LinkedIn single image | `"Introductory text: 255 characters"` — the correction that exposed the 600 that appears on no page |
| `migrateFixLinkedInCarouselIntro.js` | LinkedIn carousel | quoted |
| `migrateAddGoogleSearchAsset.js` | `answer/7684791` | 2026-08-21 |
| `migrateAddGoogleVideoAssets.js` | `answer/17091269`, `answer/17091270` | 2026-08-21, six quoted sentences for PMax, one table for Demand Gen |
| `migrateAddPinterestSpecs.js` | Pinterest product specs | 2026-08-21 |
| `migrateAddPinterestAdFormats.js` | same page, three formats | 2026-08-25, `&nbsp;` entities quoted as literal characters |
| `migrateAddXPollAd.js` | X creative specs | 2026-08-25 |
| `migrateAddXConversationButtonAd.js` | X creative specs | 2026-08-26 |
| `migrateAddXSpotlightAndLive.js` | X creative specs | 2026-08-28, read on the device by the operator |
| `migrateAddLinkedInConversationAd.js` | LinkedIn conversation ads | 2026-08-29, three of eleven fields quoted |
| `migrateBackfillSpecVerifiedAt.js` | six pages | **2026-08-20**, 25 pairs |
| `migrateVerifySoleWitnessSpecs.js` | four pages | **2026-08-25**, 10 pairs, each with an `expected` value the run refuses to stamp past |

`migrateSpecIntegrityFixes.js` is the counter-example the rule was learned from,
and it is still in the tree with Meta's entries **removed rather than corrected**
— a superseded migration's tables are writes, and leaving them would silently
revert the fix on a re-run. A test asserts `CHAR_FIXES.length === 15` and that no
`facebook.com` appears anywhere in it.

`migrateVerifySoleWitnessSpecs.js` is worth naming for its `NOT_READ` list: the
five tiered fields on the same four pages that were *not* read are held as data,
not prose, so the run can **prove** it did not touch them.

---

## PART 5 — WHAT REACHES THE DOCUMENT

This is the other half of the claim, and it is where a stale number would
actually hurt somebody.

### The path

`getTenantAssets(tenantId)` reads `copy_fields` resolving
`COALESCE(<col>_override, <col>)` per field →
`pipeline.tenantAssetsToSpecs` → `destinations/googleDocs.createDocument` →
`appendBody`, which per field emits a **bold label** and then, if there is
anything to say, **one italic paragraph**.

### The bracket

```js
function fieldBracket(field) {
  const min = Number(field.charMin) || 0;
  const max = Number(field.charMax) || 0;
  const unit = isWordField(field) ? WORD_UNIT_SUFFIX : '';
  if (min > 0 && max > 0) return `[${min}-${max}${unit}]`;
  if (max > 0) return `[${max}${unit}]`;
  return '';
}
```

Split out of `fieldLabel` **because the sweep rewrites this substring in place**.
`specSweep` corrects a limit by replacing exactly the bracket inside an existing
bold label — it never rewrites the label — so it composes the replacement the
same way the label was composed. Two copies of these three lines is exactly the
drift this codebase records elsewhere: the day someone changes the dash to an en
dash, every swept document stops matching the documents that were built.

The unit suffix is not decoration. There is no persisted doc state — draft,
regenerate and review all reconstruct fields by re-parsing the Doc — so if the
label did not say "words", the unit would be lost the moment the doc was written
and every downstream prompt would go back to counting characters.

### The tier line

```js
if (specType === 'enforced') {
  const attribution = `Platform limit (${sourceName}).`;
  return { text: `${attribution} Stay within this count.`, attributionLen: attribution.length, nameStart: 'Platform limit ('.length, nameLen: sourceName.length };
}
```

`recommended` renders `Recommended by ${sourceName}${scope}.` followed by either
the study's own finding or *"Not a hard limit — adjust for your brand and goal."*
`house_default` renders one sentence naming nobody. A null tier renders
**nothing**.

`attributionLen` is where the per-field claim ends: the attribution names the
source and carries the hyperlink, so it is a claim about *this* field; the tail
is the same sentence on every field of that tier in the library.

### The verification sentence

`fieldHint` delegates to `specFreshness.verifiedSentence`, which is the **one**
composer:

```js
function verifiedSentence(specVerifiedAt, specSource) {
  if (!specVerifiedAt) return '';
  const sourceName = specSourceName(specSource);
  if (!sourceName) return '';
  const day = isoDay(specVerifiedAt);
  if (!day) return '';
  return `Verified against ${sourceName}'s spec page on ${day}.`;
}
```

"Verified" is the right word here and **only** here. The rule against it —
say *checked* — exists because the weekly detector compares a hash and never
re-reads a number. This sentence is about a human who did read the page.

Every failure lands on the same silent path: no date, an unparseable date, or a
source resolving to no name all return `''`. *"Verified against null's spec page
on Invalid Date."* is what those guards make unreachable.

The clause rides `tier.nameStart >= 0` — the same condition that decides whether
the platform name gets hyperlinked — so a `house_default` line, which names
nobody, cannot acquire a dangling verification sentence with no referent in its
own paragraph.

### The hyperlink

`fieldHint` returns `{ text, links }` where each link is a sub-range within that
one paragraph. Offsets are tracked **structurally** — `specTypeLine` reports
`nameStart`, and `fieldHint` adds the note prefix plus the joining space — never
re-searched from the flat text. A note-embedded credit like `(Litmus)` is
hyperlinked from `NOTE_SOURCE_LINKS`, keyed on a distinctive substring of the
note, first match only, and scanned over the **note only** — never the composed
text and never any parenthesised word.

### What the reader actually sees

Rendered in this session through the real `fieldLabel` and `fieldHint`, with a
verification date of 2026-08-28 supplied:

```
LinkedIn Single Image Ad / Intro Text
  LABEL  Intro Text [150]
  HINT   In-feed preview truncates near 150. Platform limit (LinkedIn). Stay
         within this count. Verified against LinkedIn's spec page on 2026-08-28.
  LINK   "LinkedIn" (chars 52–60) → business.linkedin.com/…/single-image-ads-specs

Meta Carousel Ad / Card 1 Headline
  LABEL  Card 1 Headline [20]
  HINT   Meta publishes one Headline recommendation for carousel; it applies to
         each card. Recommended by Meta (Facebook Feed). Not a hard limit —
         adjust for your brand and goal. Verified against Meta's spec page on
         2026-08-28.
  LINK   "Meta" (chars 97–101) → facebook.com/…/carousel/facebook-feed

Demand Gen Nurture Email / Subject Line 1
  LABEL  Subject Line 1 [130]
  HINT   Mobile inboxes cut around 40 characters — front-load the first 40.
         (Litmus) House default — set your own in Settings.
  LINK   "Litmus" (chars 68–74) → litmus.com/blog/how-to-write-the-perfect-subject-line-infographic

Google Responsive Search Ad / Headline 1
  LABEL  Headline 1 [30]
  HINT   Platform limit (Google). Stay within this count. Verified against
         Google's spec page on 2026-08-28.
  LINK   "Google" (chars 16–22) → support.google.com/google-ads/answer/7684791
```

### The run collapse

Three or more adjacent fields sharing a `provenanceKey` — tier, cited page,
verification date — drop the boilerplate half. The attribution and its link stay
on **every** field:

```
Card 1 Headline [20]
  Meta publishes one Headline recommendation for carousel; it applies to
  each card. Recommended by Meta (Facebook Feed).
```

`MIN_COLLAPSE_RUN = 3` is an argument, not a measurement, and the constant says
so: the seed holds runs of 1, 2, 4, 5 and 6 and **not one of exactly 3**, so 3
and 4 render identical documents today.

The collapsed enforced case truncates to the attribution — `Platform limit (Google).`
— rather than emitting nothing, and that is not a style choice. `parseDoc` takes
the **first italic paragraph after a label** as that field's `notes`. A field
rendering no hint line absorbs a writer's copy as notes instead: a line opening
with an italicised word is italic to the parser, the copy becomes permanent
guidance, `insertIndex` advances past it, Regenerate never deletes it, and the
next draft lands below it. Silent, and it survives regeneration. **"Render
nothing" is not an available option for any field a writer drafts into.**

### What the model sees, and what it does not

`parseDoc` recovers the italic line into `field.notes`, which is prompt input.
`stripReaderOnlyLines` removes what addresses the *reader of the document* rather
than the *writer of the copy* — the house-default Settings pointer, the
recommended attribution, "Not a hard limit", and all three provenance wordings:

| Rendered | Reaches the drafting prompt |
| --- | --- |
| `Platform limit (LinkedIn). Stay within this count. Verified against …` | `Platform limit (LinkedIn). Stay within this count.` |
| `Recommended by Meta (Facebook Feed). Not a hard limit — … Verified against …` | `""` |
| `… (Litmus) House default — set your own in Settings.` | `… (Litmus)` |

The strip carries `CHECKED_LINE_SUPERSEDED` — a wording nothing writes any more —
because **the strip runs over a document, and a document is a file**. The
composer only has to know the current wording; anything that reads a document
back has to know all of them. `VERIFIED_LINE` replaced `CHECKED_LINE` 75 minutes
after it landed, both on `main`, and every document built in that window shipped
the old sentence into its own `Field guidance:` until the strip was widened.

### What the sweep writes back

`correctFieldBrackets` replaces the bracket span and, in the **same
`batchUpdate`**, replaces the provenance sentence with `Limit corrected YYYY-MM-DD.`
Docs applies a batch atomically, so there is no window in which a document says
both things. It replaces **only the sentence, never the paragraph**, because the
paragraph carries the citation hyperlink — a corrected field that loses its
citation while gaining a "corrected" sentence has less provenance than it started
with. A field carrying no such clause gets its bracket fixed and nothing else,
and a hand-edited hint line no longer matches the pattern, so the sweep leaves a
writer's words alone.

### What it is asserting

A Quillio document asserts, per cited field, that this number is a platform's
published limit or a named publisher's recommendation, that it came from this
exact page, and that a person read that page on that date. It does **not** assert
that anyone has re-read it since. That distinction — the frozen human event
versus the moving machine state — is the entire design of `specFreshness.js`, and
the moving half is deliberately kept off the document and onto the settings panel,
because a date written into a file is frozen at creation and a badge that ages is
worse than no badge.

---

## PART 6 — TEST AND VERIFICATION COVERAGE

**Measured in this session:** `npm ci && npm test` at `7412f07` → **782 tests,
782 pass, 0 fail, 9.7s**, with no credentials and no network. `test/smoke.test.js`
is 23,167 lines. Of the 782, **196 test names mention a LiveSpecs concept**;
about 124 are unambiguously LiveSpecs-owned.

### Pinned by a test

**Detection mechanics.** `checkAnchor` on both scopes and on no anchor; a 200
missing its anchor is `failed`, not `unchanged`; an empty page cannot become the
baseline; a changed hash still needs its anchor before it can flag; a good read
clears the failure counter; an unreachable page counts toward failures; an
unanchored entry is still watched and counted; unanchored is an axis, not a
status. **A source-order test asserts the anchor check precedes every comparison
branch** — moving it below `if (!row.current_hash)` restores the empty-baseline
bug while every behavioural test still passes.

**The digit threshold, from both sides.** 11 digits kept, 12 stripped. The
constant is exported specifically so this assertion exists.

**The stop marker.** `truncateAtMarker`'s boundary; that the run loop calls
`normalize()` **directly zero times**, so the next person adding a fetch cannot
route around `hashableText`.

**The two streaks.** A week we could not read leaves the unconfirmed streak
alone; an unconfirmed run clears the failure count; `SPEC_REFETCH_DELAY_MS=0`
means 0; the refetch is implicitly anchored (a test that exists to say *do not
add a second check*).

**`source_kind`.** Not fetched, not hashed, not compared; can never produce a
flag; `not_watched` is a status the run states rather than a row that vanishes;
not counted as unanchored; anything that is not `observed_practice` is watched.

**Schema tolerance.** `getWatchList` degrades one migration at a time; it does
**not** swallow a broken table; the detector leaves a missing column out of every
write; pre-migration failures still record.

**The write path.** The divergence breakdown names value, count and tenants; the
overwrite log reports only rows whose value changes; a pair that resolves writes,
logs and flips the flag; LiveSpecs reads and writes both skip deactivated rows;
`commitReview` stamps `spec_verified_at = NOW()` in one UPDATE per field.

**The sweep.** The tier gate is an allowlist of exactly one; `char_max_override`
skips and a note-only override does not; projects are filtered by exclusion; a
null manifest is skipped and counted; the watermark stops at the first unfinished
change and never skips it; the watermark is a tuple; a revoked credential skips
the tenant, not the run; notifications are one per change per tenant and never
duplicated; the edit never uses `replaceAllText`; multiple edits are ordered back
to front; the label is never rewritten, only the bracket span; the bracket is
composed in one place shared with `fieldLabel`; the bracket and the provenance
clause move in one batch; the superseded wording is recognised; a second
correction replaces the date rather than stacking; drafted copy is untouched; a
malformed `correctedOn` throws before the document is opened; the match key
carries no literal control byte.

**Freshness.** The state machine's order; the unconfirmed threshold is the
detector's and not a second copy; the second line withdraws and is never a badge;
the verified sentence is the document's, byte for byte; a house default renders
nothing; verification survives a stuck detector; the tenant view carries no error
text, no hash and no test row; the settings route asks for it and cannot fail the
read; it is documented as **not** a health display where the code is; the run
dedup collapses correctly, replayed over the real seed.

**Data integrity.** The seed equals what the migration chain produces, **in both
directions**; every tiered field cites its own asset's page and renders it
hyperlinked; the migration SQL mirrors `normalize()` step for step; one
normalizer, not three; `checkSpecHealth` is read-only by construction and
measures what the detector hashes; `probeSpecPage` never touches the database;
`exportActiveSpecs` is read-only and imports the platform mapping rather than
copying it; the rule against watching research citations is written down.

**Anchor selection.** Per-migration: a digit-free loser is not accused of
carrying digits; digit-free is a *precondition* of eligibility under the newer
policy; the header evidence gate is satisfied by the shipped constants (the
section markers really are substrings of quoted page text); the incumbent is
refused as a *label*, not for being 2×; the Meta image anchor discriminates and
the old one does not; `anchorChoice` has one implementation and its policy
divergence is **declared with no default**, so a new file cannot silently inherit
a rule nobody chose for it.

### Checked by a human once

- **Every number in the library.** All 82 tiered values were read against their
  cited pages on 2026-08-20 (25 pairs), 2026-08-25 (10 sole-witness pairs), and
  at each asset-creating migration's own `VERIFIED_ON`. These are readings, not
  properties — nothing re-performs them.
- **Every anchor.** `--verify` measures a candidate against the live page. That
  run happened once per migration, from a console with egress.
- **Whether a page varies between fetches.** Each asset migration fetches twice
  and refuses if the two disagree. Once.
- **`checkSpecHealth.js`.** Ten checks including four the stored state cannot
  answer — does the hashed text still contain the row's own `char_max` values, is
  the anchor present today, does the page vary, is a cited URL watched by anybody.
  **Manual and read-only by design**, so the dependency is on somebody running it.
  The last reading recorded in the repository is the 2026-08-23 run summary in
  `CLAUDE.md`, which came from `runDetection`, not from `checkSpecHealth`.
- **`auditWatchList.js`.** Four stored-state checks: the renamed asset, pages that
  normalized to nothing, colliding hashes, every pair resolved.
- **The 2026-09-02 Google finding.** A console fetch of all four pages showed the
  identical six-character tail and identified `73067` as a Help Center build
  number, not an article id.

### Never checked

- **That an `enforced` limit is actually enforced at ingest.** The nine LinkedIn
  `enforced` fields sit under a heading reading "Text Recommendations", and eight
  were tiered by one uncited hand-written array of which ten entries have since
  been found wrong. Settling it means pasting 200 characters into a Campaign
  Manager headline field and watching what happens. Nobody on the project has a
  LinkedIn ads account.
- **That a stored number still matches its page, on any schedule.** The detector
  compares a hash; it never re-reads a value. This is the load-bearing distinction
  behind "checked, not verified".
- **Any rendered document, by a browser or a human, as part of CI.** The suite
  reads `public/*.html` as strings. `checkContrast.js` measures one property of
  one panel and is not in `npm test`.
- **A live end-to-end run of detect → flag → approve → sweep → corrected
  document.** Every stage is tested against stubs and each has run in production
  separately; the whole chain has not been exercised in one pass on record.
- **Whether the five anchor-replacement migrations committed in production.** No
  file records it and this session cannot read the database.

### Could not be checked from here

- Everything in the production database: stored anchors, stored
  `affected_fields`, stored hashes, `spec_verified_at` coverage, `spec_change_log`
  contents, `spec_sweep_state`.
- Everything on a live page. This repo denies egress to every spec host; several
  migration headers record measuring the same 403 to CONNECT.

---

## PART 7 — WHAT IS STRONG

### The write path would survive an adversarial reading

Fourteen independent guards, three of them structural rather than validating.

`is_test` is not a convention — it is inherited onto the flag row at insert and
hard-blocks approval, and the test row's `affected_fields` is NULL, so even if the
block were removed there would be no pair to name. Two independent mechanisms
saying the same thing.

The **two-step flow is genuinely two steps**: `buildPreview` and `commitReview`
both call `guardEdits`, so a client that skips the preview, or state that moved
between the two, is caught at the write. The preview writes nothing at all — not
a draft row, not a lock.

The **zero-row guard** is the one that shows the reasoning is real rather than
ceremonial. The first eleven guards ask *is this allowed*; this one asks *did it
land*, and the refusal message names the cause, names the repair script, and
names the function inside it. Nobody adds that guard without having thought about
what silence costs.

And the whole thing is one transaction. Values, `spec_verified_at`, the log rows
and the status flip commit together or not at all.

### Fail-closed is applied consistently on the authority axis, in four places

`TENANT_EDITABLE_TIERS = { null, 'house_default' }` (an allowlist, decided from
the **stored** tier inside a `FOR UPDATE` lock, never from the submission).
`CORRECTABLE_TIERS = new Set(['enforced'])`. `anchorChoice`'s policy parameter
**has no default** and throws if omitted. A missing or unlocatable anchor section
makes nothing eligible. Four different authors' worth of decisions, all landing
on the same side, all with the reason written next to them.

### `hashableText` is the design decision that paid off

The Google digit fix went inside `normalize()`, so both the read and the refetch
inherited it — by luck, not by design. When the Meta stop marker arrived, the
same fix applied at the call site would have made the two fetches disagree every
run: `unconfirmed` forever, caused by the fix for `unconfirmed` forever. Somebody
noticed the shape, extracted one composer, and added a test asserting the loop
calls `normalize()` **zero** times directly. That test is the guard rail, and it
is the sort that is worth more than the code it protects.

### The two-counter split is right and was not obvious

`consecutive_failures` and `consecutive_unconfirmed` could plausibly have been
one. They cannot be, because their reset rules differ in opposite directions: an
unconfirmed run is *evidence the URL and anchor are fine* (we read the page,
twice), so it must clear the failure count; a failed week says nothing about
whether the page holds still, so it must neither increment nor reset the
unconfirmed streak. Sharing one field would have made each increment what it
ought to clear. The comment states the worked example — unconfirmed twice, error
three weeks, unconfirmed again reads 3, and 3 is the true answer.

### `source_kind` was a real cost avoided, and it was measured

Six Litmus flags in one run. Both pages having changed twice **in that one run**.
The reasoning is not "these will be noisy"; it is that a blog post does not
change, it *ages*, so hash-diffing measures the wrong variable, and no anchor
improves that — a working anchor would only make a wrong measurement fire
reliably. Anchoring them is blocked on the split, not on finding a string. The
15 gated pairs are preserved by keeping the rows rather than deleting them.

### The anchor rule matured under pressure, three times

It started as *present, and unique*. Meta's `Primary Text` added *discriminates
between sibling pages*. Google Demand Gen's `Headlines 2 lines 40 characters per
line` added *drawn from the section that publishes the watched fields* — the same
question asked **within** a page rather than between pages.

The third refinement is the impressive one, because the rejected candidate was
the *best-looking string on the page*: clean, unique, digit-free, and describing a
format the migration deliberately does not seed. And the ranking that came out of
it is not a guess about publishers — *which limit is safe to hold* is answered by
reading `spec_watch_list` and `copy_fields`: a limit published on other watched
pages whose anchors do not hold it is safe, and a limit this row is the sole
witness to is not. That is a fact about the database, checkable today. The
argument is explicitly marked as one that must be **redone, not inherited**,
because it depends on which pages are watched right now.

### Rejections are kept as data, not deleted

`migrateAddGoogleVideoAssets` still carries the in-feed string, so every run
prints it being refused and says why. `migrateFixLinkedInSingleImageAnchor` keeps
the incumbent with `refusedByDesign: true`, along with the file's own **original
and incorrect** reason for refusing it beside the real one. A rejection recorded
only in a commit message gets re-proposed by the next person who notices how
clean the string is.

### The provenance sentences are honest about what they claim

Two facts, two kinds, two surfaces, one module. The frozen human event goes in
the file; the moving machine state goes only where it is re-read. The word
"verified" is confined to the one sentence where a human actually did the thing.
The machine line **withdraws** rather than reassuring — the content is "we watch
that page for edits, not the number" and the date is incidental — and
`specFreshness.js` says outright that writing it the other way round, with a tick,
would reproduce the defect the document sentence had in its first version.

Two of the eight states carry no date, and the reason is a fact about the code:
`bumpFailure` stamps `last_checked_at` on a failed read, so "we haven't read this
since <date>" would name the last time we *tried*.

### The sweep's watermark is the right shape

Advance only over a change that fully finished; stop at the first that did not;
leave the rest for next run even if they would have succeeded. The cost is
re-processing changes that already succeeded, which is free because every step is
idempotent — a corrected bracket no longer reads the old value, and
`hasSpecNotification` stops a duplicate notice. The alternative, skipping ahead,
means documents that are never corrected and a notification never written, by a
job with nobody watching.

And it deliberately does not correct copy. A field whose limit dropped may now
hold a line that is too long; telling the writer so is the point. Rewriting it
would make Quillio the author of copy a person signed off on and shipped.

### The subsystem documents its own failures rather than its successes

`checkSpecHealth.js` prints three limitations on every run, in its own output,
including the one it cannot see: a value that rotates hourly or per CDN edge
produces a **confirmed flag**, not an unconfirmed row, and would be reviewed as a
real spec change. `specFreshness.js` states that it is not a health display and
names the Meta index defect that proves it. `migrateAddPinterestAdFormats.js`
prints the exact `rederiveAffectedFields` command its own success creates the need
for, with the row's real id looked up in the same transaction. Systems that name
their own blind spots in their own output are rare, and it is why this report
could be written without a database.

---

## PART 8 — WHAT IS WEAK

Ranked by whether it can put a wrong number in a customer document.

### Broken now

**1. The four Google rows flag on every Help Center deploy, and the flags are
indistinguishable from real spec changes.** *Can it produce a wrong number? Not
directly — but it is the mechanism by which a real one would be missed.*

Measured 2026-09-02: all four Google rows flagged in one run and **confirmed** on
refetch, each page's normalized length moving by exactly six characters. The
cause is `73067`, a Help Center build number in shared chrome, byte-identical
across all four pages. It moves **per deploy**, not per request, which is why two
fetches seconds apart agreed. That is the opposite failure shape from the
zwieback token the digit rule exists for, and no amount of refetching surfaces it.

The threshold stays at twelve, correctly: reaching a five-digit run means a
five-digit threshold, one order of magnitude off the library's own 8000.

The live consequence: flags #12–#15 are pending. While they are,
`freshnessState` returns `pending` for every field citing those four pages —
**24 seeded fields per tenant** (9 Performance Max, 7 Responsive Search, 4
Responsive Display, 4 Demand Gen video) — and the settings panel tells the tenant
*"This page changed on 2026-09-02 and is waiting on review — this number may be
out of date."* about numbers that did not change. Dismissing clears it; the next
Help Center deploy brings it back.

Four false flags per deploy is precisely how a review queue teaches its reader to
stop reading it, which is the cost `source_kind` was introduced to avoid once
already. Two candidate fixes are named in `specDetector.js` and **neither is
decided**: an element-scoped strip (code, global blast radius) or a per-row
`content_stop_marker` (data, scoped, the shape the Meta rows already use). The
second is the shape this codebase has already argued for once and is the smaller
change; a marker would have to sit before the shared chrome on all four pages,
which is a measurement nobody in this session can take.

**2. A new tenant's documents make no verification claim at all.** *Not a wrong
number — a missing claim, and an inconsistency between customers.*

`insertDefaultLibrary` writes eleven or twelve columns and `spec_verified_at` is
not among them:

```sql
INSERT INTO copy_fields
  (asset_type_id, field_name, char_min, char_max, field_type, sort_order,
   spec_source, spec_version, group_label, spec_note, spec_type, fact_kind)
```

and **0 of 231 fields in `defaultAssets.js` carries a `spec_verified_at` value**.
So a tenant onboarded today gets NULL on every field, `verifiedSentence` returns
`''`, and their documents render `Platform limit (LinkedIn). Stay within this
count.` with no verification sentence — while the existing tenants, who went
through `migrateBackfillSpecVerifiedAt` and `migrateVerifySoleWitnessSpecs`,
render the full three-clause form on the same field.

Nothing pins this: `spec_verified_at` appears twelve times in `test/smoke.test.js`
and not once asserting the seed carries dates. The value is a fact about the
**number**, not about the tenant — the reading on 2026-08-20 is as true for a
tenant created tomorrow as for one created in July — so carrying the dates in the
seed would be honest under `migrateBackfillSpecVerifiedAt`'s own test ("did
somebody do the thing this date says they did"). Whether production has onboarded
a tenant since the backfills is **unread**, so this may be latent rather than
live. The repair is a seed field plus a test; the judgement about which date
belongs on which field is already recorded in the two backfill migrations.

**3. `affected_fields` is stale on at least three rows, and the failure is
silent.** *It cannot write a wrong number — it prevents a right one.*

The write gate was computed once by `migrateAddSpecTables.js` and is recomputed by
nothing. Three later migrations added assets to pages that already had a watch
row and say so in their own headers:

| Migration | Fields added to an existing row's page | Derived total today |
| --- | --- | --- |
| `migrateAddPinterestAdFormats` | 17 | 19 |
| `migrateAddXPollAd` | 5 | 8 |
| `migrateAddLinkedInConversationAd` | — (its own new row) | 11 |

So for Pinterest: the page changes, the detector flags it correctly, the admin
opens the flag, and **17 of the 19 fields are not offered** because the form is
populated from `affected_fields`. Post them anyway and `guardEdits` answers "not
an affected field of this flag". Pinterest Pin updates and the three new formats
keep the old number, diverging permanently.

**Nothing detects it.** `checkSpecHealth`'s coverage check fires only for a cited
URL with *no* watch row, and this URL has one; its `numbers` check derives what to
look for *from* `affected_fields`, so the new values are not in it either.
`auditWatchList` checks that every pair *in* the array still resolves, never that
a pair that should be there is missing.

The repair exists and is printed by each migration's own successful commit —
`node scripts/rederiveAffectedFields.js --only=<id>`, dry run by default.
**Whether it has been run is a production fact this session cannot read.** Also
unread: whether the LinkedIn single-image row has been re-derived to drop the six
carousel pairs, which `CLAUDE.md` records as safe to do now that row #12 exists.

**4. `affected_fields` re-freezes the instant it is written, and the added-field
case is undetectable by construction.** *The class, as opposed to the instances.*

Re-deriving repairs one entry at one moment. The two durable fixes are recorded
as an open decision with real costs on both sides: resolving by asset id needs the
watch list to go per-tenant or a canonical registry (`affected_fields` is global
and `asset_types.id` is per tenant); deriving the gate live kills all four
staleness modes but makes the gate only as trustworthy as `spec_source`, so
editing a citation would silently widen what LiveSpecs may write. Neither is
chosen. Framing it as a decision rather than a bug is right; leaving it undecided
is the cost.

**5. Two stale comments, of the kind `CLAUDE.md`'s own preamble is about.**
*Untidy in effect, but they are the exact species this file legislates against.*

- `src/routes/admin.js:130` — `// POST /admin/api/run-detection — … Manual
  trigger only (no cron).` `railway.cron.json` has run it weekly since the cron
  service existed. `specDetector.js`'s own header carries the correction of this
  identical sentence; the route's copy was not updated with it.
- `src/utils/specFreshness.js:191` and `src/routes/settings.js:219` both say
  "146 of 173 seeded fields". The seed is now **149 of 231**. The claim was true
  when written; the library has grown by 58 fields since.

### Will break under conditions that do not exist yet

**6. A placement qualifier on an `enforced` field leaks a routing slug into a
drafting prompt.** Measured through the real strip: `recommended` + placement is
taken whole by `RECOMMENDED_ATTRIBUTION` and reaches the prompt as `""`;
`enforced` + placement reaches it as `Platform limit (Google) (Search). Stay
within this count.` All nine Meta-cited fields are `recommended`, so nothing leaks
today. Google, LinkedIn, X and Pinterest are all `enforced`. A test asserts no
`enforced` field carries a placement URL, so the day one does it goes red here
rather than in a document. The guard is in place; the hazard is one migration away.

**7. An `enforced` value could be wrong in a direction that costs a rejected
creative.** The nine LinkedIn `enforced` fields may not be enforced. Both pages
put those numbers under "Text Recommendations" — the same evidence that retiered
Meta's ten — and eight of the nine were tiered by an uncited hand-written array
of which ten entries are now known wrong. This is genuinely open in both
directions and the asymmetry favours leaving it: over-claiming costs a writer a
shorter headline, retiering wrongly tells them 70 is soft, they write 90, and
LinkedIn rejects at upload. Settling it needs a Campaign Manager account, per
field *shape*, which nobody on the project has.

**8. A typo at the approve form rewrites customer documents.** `validateEdit`
accepts any positive integer up to 100000. There is no bound relative to the
current value, none relative to the model's suggestion, and none relative to the
other tenants' values. A `700` typed for `70` commits, `spec_change_log` records
it, and three hours later the sweep opens every unfinished document containing
that field and rewrites the bracket. The defences are the preview, the divergence
breakdown and a human's attention — real, but all at the same layer. The cheap
mitigation nobody has built is a preview-level warning when a new value differs
from the current one by more than some ratio.

**9. A name differing only by case, dash variant or spacing is invisible to
LiveSpecs.** `currentValues` matches `at.name = $1` on **raw** text, while the
library's uniqueness indexes and `tenantAssetsToSpecs` match through
`quillio_normalize_name`. So a stored name that is one asset to the app is a miss
to LiveSpecs — the zero-row guard catches it at write time and refuses, so it
cannot write wrongly, but the flag cannot be approved either.
`auditWatchList.js`'s header names this; nothing fixes it.

**10. The sweep's tier is read as it stands now, not as it stood at approval.**
Deliberate and argued — "may this tenant's document be corrected today" — but it
means a field retiered from `enforced` to `house_default` between approval and
sweep silently drops out of the queue with no record, and the documents built
with the old number keep it. Correct today, worth knowing the day a retier
happens near a sweep.

**11. Three X assets exist as migrations and not in the seed.** `Twitter/X
Spotlight Takeover`, `Twitter/X Live` and `Twitter/X Conversation Button Ad` are
in `scripts/` and absent from `defaultAssets.js`. If those migrations have run,
existing tenants hold assets a new tenant would never get. `ab1870a`'s commit
message says "NOT YET RUN" for two of them, and
`migrateAddXConversationButtonAd.js` names the three pieces of follow-up work
explicitly — the seed entry, `config.ALLOWED_ASSETS`, and the medium routing table
— so the gap is deliberate and pending rather than forgotten. Whether the
migrations have run is **unread**.

**12. `migrateAddLinkedInConversationAd` is not in the seed-parity test.** The
`CREATORS` array in `test/smoke.test.js` lists five asset-creating migrations and
omits three. LinkedIn Conversation Ad *is* in the seed, and its eleven fields do
agree byte for byte — verified by hand in this session — but nothing pins it.
That is precisely the test the array exists to be: "a migration that seeds
char_max 800 while the seed says 500 passes both chain tests: same tier, same URL,
different number."

### Merely untidy

This category is short, which is the honest report.

**13. Dismissals are not attributed.** `dismiss` writes one column and
`spec_review_queue` carries no `dismissed_by` or `dismissed_at`. Approvals record
who, when and from where; the decision *not* to act records nothing. On a queue
that will fill with four false Google flags per Help Center deploy, "who
dismissed this and when" is a question somebody will eventually ask.

**14. `getSuggestions` uses `normalize`, not `hashableText`.** So for the two
Meta rows the extraction sees the whole page including the shuffled
call-to-action list, where the detector sees only the truncated region. Arguably
right — extraction wants the whole page — but it is an undocumented asymmetry
between two functions in one file that both reduce the same page, and this
codebase's own history has that shape ending badly.

**15. `spec_version` is dead weight.** `'1.0'` on every row, moved by nothing,
correctly dropped from `getTenantLibrary`'s SELECT so it cannot render.
Eighteen references across nine files do not justify a migration of their own;
it goes when one is being written anyway. Already reasoned and recorded.

**16. Five anchor-replacement migrations record no "has run" state in the tree.**
`migrateMetaPlacementCitations`, `migrateAddLinkedInCarouselWatch` and the
house-default work all carry an explicit "IT HAS RUN IN PRODUCTION (`--commit`)"
paragraph with the row counts. The five anchor fixes do not, so what a watch row's
`expected_content` currently holds is not answerable from the repository —
which is why Part 4's anchor column is labelled as candidates rather than as
stored values.

---

## PART 9 — WHAT IT WOULD TAKE TO TRUST IT UNATTENDED

The goal: writers never think about specs, and Kyle sees only exceptions.

Two of those three words are already true. Writers do not think about specs — the
number is in the bracket, the provenance is in the italic line, the citation is
one click away, and the sweep corrects a document without anybody asking. What is
not true is **"only exceptions"**. Today the queue produces exceptions that are
not exceptions, and there is a class of real exception it cannot produce at all.

Six things stand between here and there.

### 1. Stop the four Google rows flagging on every Help Center deploy

**This is the blocker, not one of several.** Everything downstream assumes a flag
means something. Four false flags per deploy trains the one reviewer to skim, and
a reviewer who has learned to skim will eventually skim past the LinkedIn
carousel headline moving from 45 to 40.

The two candidates are already named and neither is decided. The per-row
`content_stop_marker` is the smaller change and the one whose shape this codebase
has already argued through for Meta: it is data, it is scoped to the rows that
need it, and every other row's hashable text stays byte-identical so nothing
re-baselines. It needs one measurement — a fetch of all four pages, finding a
phrase that sits after every watched limit and before the shared chrome carrying
`73067`, present on all four. That measurement cannot be taken from this session.

**Cost:** one console session with egress to find and verify the marker; a
migration in the shape of `migrateSplitMetaWatchRows` to write it on four rows,
dry-run first; a deliberate re-baseline of those four (they will all report
`changed` once, correctly — that is the normalizer-change sequencing this
codebase already documents). Half a day, plus the four pending flags dismissed.

An element-scoped strip in `normalize()` is the alternative and is global: every
row re-baselines, which is seven rows of one-off `changed` to sequence. Worth it
only if the same chrome turns out to affect non-Google rows.

### 2. Close the `affected_fields` gate, as a class rather than three instances

Re-deriving the three known-stale rows is an afternoon and buys correctness
today, not tomorrow — the snapshot re-freezes on write, and the case nothing can
detect (a field *added* to a watched asset) comes straight back with the next
asset migration.

Unattended operation needs the class closed. Of the two options recorded,
**deriving the gate live** is the one that actually reaches the goal: it kills all
four staleness modes including the undetectable one, and it turns `guardEdits`
from a lookup into a query. Its cost is real and correctly stated — the gate stops
being a stable auditable list and becomes as trustworthy as `spec_source`, so
editing a citation would silently widen what LiveSpecs may write, where today
widening it takes a deliberate re-derive.

That cost is payable, because the thing it gives up is already gone: the stored
list is not a trustworthy audit artefact if nobody can tell whether it is current.
A live derivation plus a `spec_change_log`-style record of *what the gate resolved
to at write time* keeps the audit property and drops the staleness.

**Cost:** rewrite `guardEdits` to derive from
`cf.spec_source = <row.source_url> AND at.is_active`, keep the note-derived rule
for the two Litmus rows, log the resolved pair set on the change row, delete the
column or leave it inert, and re-point the tests. Two or three days including the
Litmus special case. `rederiveAffectedFields.js` becomes redundant rather than
wrong.

### 3. Schedule `checkSpecHealth.js`, and give it somewhere to shout

This is the largest gap between what the system reports and what is true, and it
is the cheapest to close.

Every state the admin page and the settings panel render is derived from **stored
state**. None of it reads the cited page. A row watching the wrong page reports
clean forever, and that is not hypothetical — Meta's two assets watched a
2,208-character nav page with no character limit on it, weekly, with total
confidence, for months. `checkSpecHealth` is the only thing that asks the
structural questions, it already exits 1 when a human is needed, and its own
header says where it should go: a few hours **before** the Monday detection run,
so a broken row is known before the run that would misreport it.

It is manual today, which means the verification dates in every customer document
rest on somebody remembering.

**Cost:** a third `railway.<name>.cron.json` at, say, `0 12 * * 1`; a non-zero exit
has to reach a person, which means a Slack post or an email from the runner —
there is no notification path for an ops script today, and that is the actual
work. One to two days. Its read-only property must survive: the script asserts it
in its own test, and scheduling must not be the excuse to let it write.

### 4. Make a real exception louder than a routine one

Today every flag is one card, and the queue is chronological. Once (1) is fixed
the noise drops, but nothing yet distinguishes "Pinterest's page moved by six
characters" from "a watched `char_max` no longer appears anywhere on its page".
`checkSpecHealth` already computes the second — its `numbers` check asks whether
the hashed text still contains the row's own values.

Folding that signal into the flag, so the queue can say *this page changed and
the limit we store is no longer on it*, is what turns the queue from a list into
an exception report.

**Cost:** run the numbers check at flag time (the page is already fetched twice
by then), store the result on the flag row, render it. Two or three days, and it
needs its own migration column. It also inherits `checkSpecHealth`'s stated limit:
numbers-present is a floor, not a census, since short numbers appear incidentally
in dates and pixel sizes.

### 5. Notify on a flag, and on a stuck row

There is no push. A pending flag is visible on `/admin` to somebody who opens
`/admin`, and on the settings panel to a tenant who happens to be looking at that
field. The `notifications` table exists, the sweep already writes to it, and
`utils/specNotice.js` already composes a tenant-facing sentence for a spec change.
Nothing writes an **admin**-facing notice for a flag raised, a row stuck three
runs, or a row failing twice.

Unattended means the system reaches out. Right now it waits.

**Cost:** a notice type and a delivery channel — Slack is the obvious one, the
bot token is already there for the brief workflow. Two to three days including
the "don't repeat yourself weekly" logic that `hasSpecNotification` already
demonstrates for the sweep.

### 6. Prove the chain end to end, once, on purpose

Every stage is tested against stubs and each has run in production separately.
The whole chain — edit the test page, run detection, approve a value, watch the
sweep correct a real document and write a real notification — is not on record as
a single pass.

The apparatus for it exists: `setTestSpec.js` edits the page, the test row is a
real watch row, and `runSpecSweep.js` is dry-run by default. The obstacle is that
the test flag **cannot be approved** — guard 3 — so the chain cannot be exercised
end to end without approving a real flag against a real page.

That is a correct design and it means the rehearsal has to be done differently: a
second `is_test` row pointing at a second fake page, with a real (non-test) flag
and a small `affected_fields` naming a throwaway asset on a scratch tenant. Doing
it once, and writing down what the document looked like before and after, is what
would let somebody trust the sweep to open a customer's document unattended.

**Cost:** a day of setup on a scratch tenant, and a decision about whether the
scaffolding stays.

### What would still not be true

Even with all six, **nothing re-reads a number on a schedule.** The detector
compares a hash; `checkSpecHealth` asks whether a stored number still appears
somewhere on the page, which is a floor and not a census. The claim the product
would then be able to make is: *every limit is cited; every cited page is watched
weekly with the fetch asserted to have read the right page and the right section
of it; any detected change reaches a human before a number moves; any number that
moves is corrected in the documents already built and their owners are told; and
a person read each of these pages on the date the document names.*

That is a strong claim and it is the true one. It is not "these numbers are
current". The gap between those two sentences is a human opening a page, and no
amount of engineering closes it — which is why the one honest thing this system
does everywhere, and must keep doing, is say *checked*, not *verified*.

---

*Read-only pass. `main` at `7412f07`. Test suite run in this session:
782 tests, 782 pass, 0 fail. Production database and all spec hosts unread.*
