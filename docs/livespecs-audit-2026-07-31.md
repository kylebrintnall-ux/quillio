# LiveSpecs subsystem audit — 2026-07-31

Scope: `src/services/specDetector.js`, `src/services/specReview.js`, `src/db/specWatch.js`,
`src/routes/admin.js`, `public/admin.html`, `scripts/runDetection.js`, `railway.cron.json`,
and the migrations that create and seed the LiveSpecs tables.

Every claim below is read off the source. Where CLAUDE.md, a README, or a file's own header
comment says something the code does not do, that disagreement is reported as a finding rather
than repeated as fact.

**No code was changed by this audit.** The only file added is this report.

---

## Method and limitations — read this before trusting section 1

Two things could not be done from the audit environment, and both bound what section 1 can
assert:

1. **No database.** `DATABASE_URL` is unset here, so `spec_watch_list` could not be read. The
   watch-list rows in section 1 are **reconstructed from the seed code and the migration chain**
   (`scripts/migrateAddSpecTables.js` seed logic + the spec_source state each prior migration
   leaves behind), not read from production. Every reconstructed claim is paired with the SQL to
   confirm it. Where the reconstruction is load-bearing for a finding, that is stated.
2. **No outbound access to the watched hosts.** This environment's egress allowlist rejects
   every watched host at the proxy. A probe using the detector's own `fetchText` settings (same
   User-Agent, same 10s timeout) returned `403` with a 100-ish byte proxy body for all nine URLs
   tried — that 403 is **this environment's proxy, not the origin server**, and must not be read
   as evidence about the pages themselves. Page content was therefore verified indirectly via
   web search of each URL. Liveness and HTTP status **at the origin** remain unverified.

The probe was still informative, and one of its results is a finding in its own right — see
section 2, "Two different URLs, one hash".

The repo's test suite was run to establish a baseline: **346 tests, all passing** (`npm test`,
after `npm ci`). Zero of them exercise `specDetector.js` (section 9).

---

## 1. Watch list integrity

### What actually determines the watch list

`spec_watch_list` is populated once, by `scripts/migrateAddSpecTables.js:107-138`, from three
sources:

| # | Source | Code |
| --- | --- | --- |
| 1 | `SELECT DISTINCT spec_source FROM copy_fields WHERE spec_type = 'enforced' AND spec_source <> 'quillio_default'` | `migrateAddSpecTables.js:112-124` |
| 2 | Two hard-coded Litmus URLs, affected fields derived by `spec_note LIKE '%<match>%'` | `migrateAddSpecTables.js:45-56, 128-131` |
| 3 | One `is_test` row, `affected_fields = NULL` | `migrateAddSpecTables.js:58-61, 135` |

Two properties of that seed matter more than its contents:

- **Insert is `ON CONFLICT (source_url) DO NOTHING`** (`migrateAddSpecTables.js:100`). It never
  updates an existing row, so `affected_fields` is **frozen at first seed** and re-running the
  migration cannot repair it.
- **Nothing else in the codebase ever writes `affected_fields`.** Grep for `spec_watch_list`
  returns exactly four writers: the seed above, `migrateAddDetector.js:38` (repoints the test
  URL), `migrateFixGoogleSpecSource.js:69-76` (repoints one `source_url` + resets its hash), and
  the detector's own hash/`last_checked_at`/`last_error` updates. **No code path recomputes
  `affected_fields` from `copy_fields`.**

That is the root cause of every mismatch below: `copy_fields.spec_source` has been rewritten
three times since the seed, and the watch list did not follow.

### Reconstructed rows

Seed-time state came from `scripts/migrateSetEnforcedSpecSource.js:30-33`, which grouped all 25
then-enforced pairs onto **four** platform URLs (one per platform — LinkedIn's carousel fields
were pointed at the *single image* page). `scripts/migrateFixGoogleSpecSource.js` later repointed
the Google row's `source_url`. `scripts/migrateSpecIntegrityFixes.js` then rewrote
`copy_fields.spec_source` per **asset** (`:124-134`) and renamed one asset (`:137, 202-206`) —
**without touching `spec_watch_list`**.

| # | `source_url` | `affected_fields` (frozen at seed) | Tier of those fields **today** | Page really documents them? |
| --- | --- | --- | --- | --- |
| 1 | `https://www.facebook.com/business/ads-guide/update` | Meta Single Image Ad: Primary Text, Headline, Description; Meta Carousel Ad: Primary Text, Card 1–5 Headline, Card Description (10 pairs) | **`recommended`** — all ten retiered by `migrateSpecIntegrityFixes.js:61-72` | **Yes.** Meta's ads guide states 125 / 40 / 30. |
| 2 | `https://business.linkedin.com/advertise/ads/sponsored-content/single-image-ads-specs` | LinkedIn Single Image Ad: Intro Text, Headline, LAN Description; **LinkedIn Carousel Ad: Intro Text, Card 1–5 Headline** (9 pairs) | `enforced` | **Partly — MISMATCH.** The single-image page documents intro text 150 / headline 70 / description 70. It does **not** carry the carousel's numbers (card headline 45, intro 255) — which is exactly why `migrateSpecIntegrityFixes.js:24-25, 129-130` moved those fields' citation to the carousel page. The watch row still binds them to the single-image page. |
| 3 | `https://business.x.com/en/help/campaign-setup/creative-ad-specifications` | Twitter/X Ad: Ad Copy, Headline (2 pairs) | `enforced` | **Yes.** X's creative ad specs page states the 280-character cap and card title/description guidance. |
| 4 | `https://support.google.com/google-ads/answer/17090561` | **`Google DV360 / Responsive Display`**: Short Headline, Long Headline, Description, Business Name (4 pairs) | `enforced` | **Page: yes** (Responsive display ads specs states 30 / 90 / 90 / 25). **Binding: BROKEN** — the asset was renamed to `Google Responsive Display Ad` (`migrateSpecIntegrityFixes.js:137`) and the watch row still names the old one. See "The Google rename" below. |
| 5 | `https://www.litmus.com/blog/how-to-write-the-perfect-subject-line-infographic` | Subject Line 1 + Subject Line 2 on the five email assets (10 pairs), matched via `spec_note LIKE '%Mobile inboxes cut around 40%'` | `house_default` (neither set in `defaultAssets.js:574-620`) | **Yes**, for the note's claim (~35–40 chars visible on mobile). But see the rule violation below. |
| 6 | `https://www.litmus.com/blog/the-ultimate-guide-to-preview-text-support` | Preheader on the five email assets (5 pairs), via `LIKE '%characters of preheader%'` | `house_default` | **Yes**, same caveat. |
| 7 | `https://quillio.co/admin/test-spec` | `NULL` (`is_test = true`) | n/a | n/a — serves `spec_test_page` content (`routes/admin.js:94-107`). |

Confirm the reconstruction with:

```sql
SELECT id, source_url, display_name, is_test,
       jsonb_array_length(affected_fields) AS n_fields, affected_fields
  FROM spec_watch_list ORDER BY is_test, id;

-- the drift itself: cited-but-unwatched URLs
SELECT DISTINCT cf.spec_source
  FROM copy_fields cf
 WHERE cf.spec_source <> 'quillio_default'
   AND cf.spec_source NOT IN (SELECT source_url FROM spec_watch_list);
```

### Mismatch 1 — the Google rename orphans every affected field · **BROKEN**

`affected_fields` stores the asset by **name**. `services/specReview.js:74-84` resolves it by
name:

```js
'SELECT at.tenant_id, cf.char_max, cf.spec_note FROM copy_fields cf '
+ 'JOIN asset_types at ON at.id = cf.asset_type_id WHERE at.name = $1 AND cf.field_name = $2'
```

The Google asset was renamed `Google DV360 / Responsive Display` → `Google Responsive Display Ad`
(`migrateSpecIntegrityFixes.js:137, 202-206`). The watch row's `affected_fields` still says the
old name. Consequences, all silent:

- `getFlagForReview` (`specReview.js:196-230`) returns those four fields with `tenant_count: 0`
  and empty current values.
- `guardEdits` (`specReview.js:235-265`) validates the pair against `affected_fields` **only** —
  it never checks the pair exists in `copy_fields`. The edit passes.
- `commitReview`'s UPDATE (`specReview.js:377-386`) matches zero rows, `tenantCount = 0`.
- An audit row is still inserted with `tenant_count = 0` (`specReview.js:419-434`), the flag is
  still flipped to `'reviewed'` (`:450`), and the transaction commits.
- The UI reports **"Written. 0 tenant row(s) updated across 1 field(s); flag marked reviewed;
  logged."** (`public/admin.html:345`) and auto-closes after 1.4s (`:365`).

So the one Google spec change LiveSpecs exists to catch can be reviewed, approved, confirmed,
logged and marked handled while changing nothing. The `0` is on screen, but nothing treats it as
an error. **Conditional on production having run the rename migration** — verify with:

```sql
SELECT w.source_url, p->>'asset' AS asset,
       EXISTS (SELECT 1 FROM asset_types at WHERE at.name = p->>'asset') AS asset_exists
  FROM spec_watch_list w, jsonb_array_elements(w.affected_fields) p;
```

### Mismatch 2 — LinkedIn Carousel is watched against the wrong page, and its real page is not watched at all · **RISK**

`https://business.linkedin.com/advertise/ads/sponsored-content/carousel-ads/specs` is cited by
six `copy_fields` rows (`defaultAssets.js:690-691`) and appears in **no** watch row. Both
directions fail:

- A change to the carousel card-headline limit on the carousel page → no fetch, no hash, no flag.
- A change to the single-image page → a flag whose approve form offers the six **carousel**
  fields, inviting an admin to write carousel limits from a page that does not state them.

### Mismatch 3 — `Organic Social — Twitter/X || Post Copy` is unreachable · **RISK**

Promoted to `enforced` citing the X page (`migrateSpecIntegrityFixes.js:77, 265-280`;
`defaultAssets.js:619, 695`) after the watch list was seeded. The X watch row's `affected_fields`
lists only `Twitter/X Ad` pairs, and `guardEdits` refuses anything outside that list
(`specReview.js:253-255`). The field can never be updated through the flag flow.

### Mismatch 4 — the Meta row now contradicts the list's own inclusion rule · **RISK**

The rule is "URLs cited by `enforced` fields" (`migrateAddSpecTables.js:110-119`). All ten Meta
fields are now `recommended`. The row is harmless (the page is a real platform page) but the list
is no longer derivable from the data it claims to be derived from, and no code detects that.

### Mismatch 5 — the two Litmus rows contradict the documented rule · **RISK (doc vs code)**

CLAUDE.md's "What goes on the LiveSpecs watch list — and what doesn't" (line 471 ff.) says the
list is for pages publishing **platform limits**, naming "Litmus's truncation numbers" as
qualifying, and says "Research citations do not go on the watch list… A published finding does
not change… the queue would fill with diffs that mean nothing."

Both Litmus rows are marketing-blog posts — one an infographic last updated 2021 — reporting what
someone measured. They are the exact failure mode the rule describes, and they are on the list
(`migrateAddSpecTables.js:45-56`). Meanwhile the two genuine research citations the rule was
written about (Constant Contact, Gong — `defaultAssets.js:707-712`) are correctly excluded, but
only incidentally: they sit on `recommended` fields and the seed query selects `enforced` only.
The exclusion is a side effect of the tier filter, not an implementation of the stated rule.

A smoke test asserts the rule is **written down** (`test/smoke.test.js:7552-7555`) — it asserts
prose in CLAUDE.md, not that the watch list obeys it.

### Section 1 verdict — **BROKEN**

Of six real watch rows: one is orphaned by a rename (writes silently no-op), one binds fields to
a page that does not document them while that page's real source goes unwatched, one enforced
field is unreachable, one contradicts the list's inclusion rule, and two contradict the
documented exclusion rule. The mechanical cause is single and fixable: `affected_fields` is a
frozen snapshot with no recompute path.

---

## 2. Fetch failure handling

### The path

`runDetection` (`specDetector.js:99-184`) loops watch rows. Per row:

```
fetchText(url)                       :112   → throws on timeout or non-2xx
hashText(normalize(html))            :113
  current_hash NULL   → baseline     :115-121   UPDATE hash, clear last_error, NO flag
  hash equal          → unchanged    :122-128   bump last_checked_at, clear last_error
  hash differs        → confirm      :129-155   see §4
catch (err)           → error        :156-168   record last_error, NO flag, hash untouched
```

`fetchText` (`specDetector.js:56-69`) is the whole of the input validation:

```js
const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': … } });
if (!res.ok) throw new Error(`status ${res.status}`);
return await res.text();
```

### Per-case answers

| Case | Recorded as | Detail |
| --- | --- | --- |
| **HTTP 404** | `error` | `!res.ok` throws `status 404`; `last_error = 'status 404'`, `last_checked_at` bumped, `current_hash` untouched, no flag (`:156-168`). **Correct.** |
| **HTTP 403** | `error` | Identical, `status 403`. **Correct.** |
| **Timeout (>10s)** | `error` | `AbortController` fires at `FETCH_TIMEOUT_MS = 10000` (`:28, 58`); `last_error` = the abort message. No retry anywhere. **Correct.** |
| **200 + auth interstitial** | **`unchanged` / `changed` / `baseline` — treated as content** | `res.ok` is true, so the interstitial's text is normalized and hashed like a spec page. |
| **200 + JS shell, no real content** | **same, and worse** | The tag strip leaves the empty string; `hashText('')` = `e3b0c442…` (the sha256 of empty). Verified against the repo's own functions. |

### Is there any assertion that fetched content is the expected content?

**No.** Any 2xx proceeds to hashing. There is no `Content-Type` check, no minimum-length check, no
keyword assertion ("does this page still contain the word *characters*?"), and no check of the
**final** URL after redirects — Node's `fetch` defaults to `redirect: 'follow'`, so a spec page
that 301s to a generic "specs have moved" landing page returns 200 and that landing page becomes
the watched content permanently.

### Two different URLs, one hash — observed, not theorised

The egress probe returned a **200-shaped body pattern** worth recording even though the status was
403: the two LinkedIn URLs produced byte-identical normalized text and therefore the **identical
hash** (`569f080027f16cc3`), as did the two Litmus URLs (`e0912f288e4219bb`). Host-level
interstitials collapse distinct pages to one value. Had those been served with status 200 —
which is exactly how consent walls, geo-blocks and bot challenges are usually served — the
detector would have baselined two different watch rows to the same meaningless hash and reported
both as healthy.

### The failure mode that matters most: baseline poisoning · **RISK**

`if (!row.current_hash)` (`:115`) accepts whatever came back as truth, with no flag and no
warning. If a URL's first-ever check lands on a challenge page, the challenge page becomes the
baseline; the real spec page then reads as a **confirmed change** later, and a genuine spec edit
in between is invisible. `migrateFixGoogleSpecSource.js:71` deliberately resets `current_hash` to
NULL, so this branch is not hypothetical — it runs whenever a URL is repointed.

### Section 2 verdict — **RISK**

Error handling for the cases it recognises (non-2xx, timeout) is correct and conservative: it
never flags, never advances the hash, never lets a failure look like a change. The gap is that
it only recognises **transport** failure. Every content-level failure — interstitial, JS shell,
redirect to a different page, empty body — arrives as a 200 and is indistinguishable from a spec
page.

---

## 3. Normalization

Verbatim (`specDetector.js:40-47`):

```js
function normalize(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
```

Then `hashText` = sha256 hex of that string (`:50-52`).

**Whole-page, not selector-scoped.** There is no DOM parse, no main/article extraction, no
element or class filtering. Removed: `<script>`/`<style>` blocks *with* their contents, all
remaining tags, and whitespace runs. Retained: **every visible text node on the page** — nav,
header, footer, cookie banner, promo bar, sidebar, related-articles list, comment counts, dates,
and any HTML entity (`&copy;` survives as literal text, unescaped).

Measured against the real functions:

| Mutation | Hash changes? |
| --- | --- |
| Nav link added | **yes** |
| Footer year `2026` → `2027` | **yes** |
| A/B-tested banner inserted | **yes** |
| Inline `<script>` body changed | no (stripped) |
| Whitespace / newline reflow | no (collapsed) |
| Auth interstitial vs. real page | yes — but both hash to *something*, so both look valid |
| JS shell (no text) | hashes to sha256 of `''` — identical for every such page |

So all three cases the question names — nav change, footer year, A/B banner — **alter the hash and
produce a flag** (subject to §4 reproducing them, which a server-rendered year or a sticky A/B
bucket will). This is the exact behaviour CLAUDE.md gives as the reason research blogs must not be
watched ("fires on any layout tweak, nav change or A/B test the publisher ships") — and it applies
equally to the platform pages, which also have navs, footers and promo bars.

`scripts/reopenFlag1.js:3-5` names flag #1 as "the Google false positive", so this has already
happened in production at least once.

### Section 3 verdict — **RISK**

Correct and dependency-free for what it does, and deliberately documented as a middle ground. But
it is a whole-page hash: the signal-to-noise ratio is set by the publisher's chrome, not by the
spec table. There is no scoping mechanism (no per-row CSS selector, no text-window column) to
narrow it.

---

## 4. Confirm-on-refetch

**A second fetch inside a single run** — not a comparison across two scheduled runs. Full path
(`specDetector.js:129-155`):

```js
} else {
  let confirmHash = null;
  try {
    await sleep(REFETCH_DELAY_MS);                                   // :135
    confirmHash = hashText(normalize(await fetchText(row.source_url))); // :136
  } catch (e) {
    confirmHash = null;                                              // :137-140
  }

  if (confirmHash && confirmHash === newHash) {
    await recordChange(pool, row, newHash);                          // :144
    status = 'changed';
  } else {
    await pool.query(
      'UPDATE spec_watch_list SET last_checked_at = NOW(), last_error = NULL WHERE id = $1',
      [row.id]);                                                     // :149-152
    status = 'unconfirmed';
  }
}
```

`REFETCH_DELAY_MS = Number(process.env.SPEC_REFETCH_DELAY_MS) || 1500` (`:31`).

The comparison is **fetch-2 vs fetch-1**, both from the same run, not against `current_hash`.
`recordChange` (`:74-94`) then inserts the flag and advances the hash in one transaction, so a
flag can never be inserted without the hash moving. That part is well built.

Three consequences of the design:

1. **A page that varies per request is permanently blind · RISK.** If a nonce or timestamp
   survives the tag strip, `confirmHash !== newHash` on every run, forever. The row reports
   `unconfirmed` every time, never flags, and **a genuine spec edit on that page is never
   detected**. The header comment names Google's help pages as such a page (`:9-11`) — and Google
   is the row that already produced the known false positive. Nothing counts consecutive
   `unconfirmed` results, nothing escalates, nothing surfaces it.
2. **`unconfirmed` is not persisted at all · RISK.** The branch writes `last_checked_at` and
   **clears** `last_error`. No column, no counter, no queue row. It exists only in the HTTP
   response of a manual run and in one `console.log` line (`:180`) — see §8.
3. **A failed refetch is laundered into silence · RISK.** If fetch 1 succeeds and fetch 2 fails
   (rate limit, transient 503), the `catch` swallows it, and the `unconfirmed` branch then sets
   `last_error = NULL`. A real fetch failure leaves no trace anywhere.

### Section 4 verdict — **RISK**

The mechanism does what it advertises for one-shot noise, and the transaction around the flag is
correct. It has no memory: it cannot distinguish "noisy once" from "never confirmable", and the
second is total, silent blindness on that URL.

---

## 5. Write path (approve-with-diff)

### End to end

```
public/admin.html:249  Suggest values  → GET  /admin/api/flag/:id/suggestions   (read-only, §7)
public/admin.html:307  Preview changes → POST /admin/api/approve-preview        (writes NOTHING)
public/admin.html:344  Confirm write   → POST /admin/api/approve-commit         (the only writer)
```

`routes/admin.js:184-213` — both endpoints are `requireAdmin`-gated; `changedBy = req.user.id`
(`:205`).

`buildPreview` (`specReview.js:268-334`): re-runs `guardEdits`, reads current per-tenant values,
returns per-attribute `{old, new, tenant_count, divergence}` plus a roll-up. No writes, confirmed
by inspection — the only side effect is a `console.warn` (`:310-322`).

`commitReview` (`specReview.js:338-478`), **one transaction** (`BEGIN :344` … `COMMIT :452`,
`ROLLBACK` on any throw `:472`):

| Step | Table | Line | Tenant scope |
| --- | --- | --- | --- |
| Re-guard (test-flag block, pending check, affected-pair check, validation) | reads | `:346` | — |
| Snapshot `before` | `copy_fields` (read) | `:356` | all tenants |
| Value write + `spec_verified_at = NOW()` | **`copy_fields`** | `:377-386` | **ALL tenants — no tenant predicate** |
| Audit row per changed attribute | **`spec_change_log`** | `:419-434` | — |
| Flag status → `reviewed` | **`spec_review_queue`** | `:450` | — |

The UPDATE:

```sql
UPDATE copy_fields cf SET <attrs>, spec_verified_at = NOW()
  FROM asset_types at
 WHERE cf.asset_type_id = at.id AND at.name = $n AND cf.field_name = $m
RETURNING at.tenant_id
```

Matched by **name**, globally. One admin approval rewrites every tenant's row. This is deliberate
and documented in three places (`specReview.js:389-396`, `db/assets.js:309-337`,
`test/smoke.test.js:9478-9485`), the divergence reporting exists precisely to make it visible
(`specReview.js:121-178`, surfaced at `admin.html:288-300, 352-362`), and a tenant is blocked from
renaming a seeded asset out from under it (`db/assets.js:385-388`). Also absent from the
predicate: `asset_types.is_active` — an archived asset is still rewritten.

### Is prior value retained? · **RISK**

**Partially, and not enough to restore from.**

- `spec_change_log.old_value` gets `distinctValue(before, attr)` (`:424, 432`) — a **joined
  string**, e.g. `"150 | 200"` when tenants disagreed. Which tenant held which is not recoverable
  from it.
- The per-tenant detail **is** computed — `changedRows` produces `{tenant_id, attr, old_value,
  new_value, diverged}` (`:397-403`) — but it is only returned in the HTTP response
  (`:436-446`) and printed to `console.warn` (`:405-415`). **It is never persisted.**

So after a divergent approval, restoring each tenant's prior value requires the Railway log
stream. Once logs rotate, it is gone.

### Is there a revert path? · **RISK**

**No.** Grep for `spec_change_log` across `src/`, `public/`, `scripts/` returns only the two
INSERTs in `specReview.js` and the DDL in `migrateAddSpecChangeLog.js`. **Nothing reads the table**
— no endpoint, no UI, no script. Its own migration calls it "the basis for a future rollback"
(`migrateAddSpecChangeLog.js:13`); that future has not arrived. There is no revert endpoint, no
undo button, and no script. Recovery is hand-written SQL.

### Is `specReview.js` still the only writer to `copy_fields`? · **NO — the claim is false**

CLAUDE.md ("`specReview.js` — The ONLY place that writes `copy_fields`"),
`specReview.js:3-4`, `routes/admin.js:197`, and `migrateAddSpecChangeLog.js:8-9` all state this.
An exhaustive grep for writes finds **five in `src/`**:

| Writer | Line | Statement | Reachable from |
| --- | --- | --- | --- |
| `services/specReview.js` | `377` | `UPDATE copy_fields` | admin approve-commit |
| `db/assets.js` `seedTenantAssets` | `68` | `INSERT INTO copy_fields` | Slack + Google install (`routes/oauth.js:275, 429`) |
| `db/assets.js` `createAssetType` | `280` | `INSERT INTO copy_fields` | `POST /api/settings/library/asset` (`routes/settings.js:251`) |
| `db/assets.js` `updateAssetType` | `409`, `427` | `UPDATE` / `INSERT` | `routes/settings.js:338` |
| `db/assets.js` `updateAssetType` | `446` | `DELETE FROM copy_fields` | `routes/settings.js:338` |

The tenant-facing writers set `char_max` and `spec_note` — the **same two attributes** LiveSpecs
writes. They are constrained in ways that make the *spirit* of the claim mostly hold: they are
tenant-scoped, they cannot touch a seeded asset (`db/assets.js:385-388`), and `spec_type` /
`spec_source` / `spec_version` are absent from every statement by construction
(`db/assets.js:278-279, 406-408`; asserted by `test/smoke.test.js:8478, 9514`). Twenty-plus
migration scripts in `scripts/` also write `copy_fields` directly.

The accurate statement is: **`specReview.js` is the only writer of `spec_type`, `spec_source` and
`spec_verified_at`, and the only writer that crosses tenant boundaries.** The claim as written is
not true, and a reader auditing spec provenance who trusts it will miss `db/assets.js`.

### Two smaller notes

- **No row locking on the snapshot.** `currentValues` inside the transaction (`:356`) has no `FOR
  UPDATE`. Under READ COMMITTED, two concurrent approvals can produce a `before` snapshot that
  does not match what the UPDATE overwrites, making the audit row wrong. Low likelihood
  (single-admin flow), non-zero.
- **`guardEdits` never checks the pair exists.** See §1, Mismatch 1 — this is what turns a stale
  `affected_fields` into a silent no-op write.

### Section 5 verdict — **RISK**

The transaction boundary, the two-step confirm, the test-flag block, the affected-pair gate and
the divergence reporting are genuinely well built. The gaps are on the recovery side: per-tenant
prior values are not persisted, no revert path exists, and the "only writer" claim that a reader
would rely on to reason about all this is false.

---

## 6. Spec version stamping

**No.** Nothing records which spec version or spec value a generated document was produced
against.

Evidence:

- **Generation path.** `core/pipeline.js:1058-1071` is the only project write. It saves `name`,
  `drive_folder_id`, `drive_folder_url`, `copy_doc_id`, `copy_doc_url`, `status`,
  `slack_channel_id`, `slack_thread_ts`, `created_by`. No spec fields.
- **Schema.** `db/projects.js:65-70` inserts exactly those ten columns; the table definition
  (`scripts/migrateDb.js:130-149`) has no spec column. Its `version INTEGER DEFAULT 1` is a
  project-revision counter, unrelated to specs and never incremented by any code.
- **`copy_fields.spec_version` exists but is inert.** Seeded to `'1.0'`
  (`defaultAssets.js:727`), read back by `db/assets.js:120-137`, asserted `'1.0'` by
  `test/smoke.test.js:545`. **`commitReview` does not touch it** (`specReview.js:361-371` sets
  `char_max`, `spec_note`, `spec_verified_at` only). It stays `'1.0'` forever, through any number
  of approved limit changes. It is not a version; it is a constant.
- **`spec_verified_at`** records *when a field was last approved* — not what any document used.

The only trace is indirect and unqueryable: the limits are rendered into the Doc body as `[N]`
label suffixes at generation time (`destinations/googleDocs.js` `fieldLabel`), so an old Doc still
shows the old number as text. Recovering "which spec was this built against" means opening the
Doc and reading it.

Practical consequence: after an approval, no query can answer "which projects were generated
against the old limit" — so nothing can be flagged for re-review when a platform limit tightens.

### Section 6 verdict — **RISK**

---

## 7. Extraction

### The prompt, verbatim

`services/gemini.js:2136-2155`, assembled with `.join('\n')`:

```
You are auditing an advertising/email platform spec page for CHARACTER LIMITS.
Below is the visible text of the page, then a list of copy fields (each with a ref number).
For EACH listed field, find the character limit the page states for it, if any.
Return STRICT JSON — an array with one object per field:
  { "ref": <the field's ref number>,
    "suggested_char_max": <integer, or null if the page does not clearly state one>,
    "snippet": <a short verbatim quote (<=160 chars) from the page supporting the number, else "">,
    "confidence": "high" | "medium" | "low" }
Rules: use ONLY numbers actually present in the page text. If a field is not clearly
addressed, set suggested_char_max=null, snippet="", confidence="low". Do NOT guess or
invent numbers. Match platform wording to the field by meaning (e.g. page "Headline"
wording may map to field "Short Headline").

FIELDS:
ref 0: asset="<asset>" field="<field>" current_char_max=<value or (unknown)>
…

PAGE TEXT:
<normalized page text, sliced to 12000 chars>
```

Field lines built at `:2129-2134`; `SPEC_EXTRACT_MAX = 12000` at `:2122`, applied at `:2125`.
Model config: `temperature 0.1`, `maxOutputTokens 2048`, `responseMimeType 'application/json'`
(`:2161-2165`).

### Response handling

```js
try { const out = await callGemini({…}); parsed = extractJsonArray(out); }
catch (err) { console.error('[gemini] extractSpecValues failed:', err.message); return []; }   // :2168-2171
if (!Array.isArray(parsed)) return [];                                                          // :2172

return parsed.map((r) => {
  if (!r || typeof r !== 'object') return null;
  const ref = Number(r.ref);
  const n = Number(r.suggested_char_max);
  return {
    ref: Number.isInteger(ref) ? ref : null,
    suggested_char_max: Number.isInteger(n) && n > 0 && n <= 100000 ? n : null,
    snippet: r.snippet ? String(r.snippet).slice(0, 200) : '',
    confidence: ['high','medium','low'].includes(r.confidence) ? r.confidence : 'low',
  };
}).filter((r) => r && r.ref !== null);                                                          // :2174-2187
```

Caller `getSuggestions` (`specReview.js:487-526`): refuses no-DB, missing flag, and **test flags**
(`:492`); refetches and normalizes the page (`:505`, degrading to `{ok:true, suggestions:[], note:
'could not fetch page: …'}` on failure `:506-508`); binds results back by **index ref**
(`:511-524`) so repeated field names across assets cannot cross-wire.

### When the model declines

`suggested_char_max: null`, `snippet: ''`, `confidence: 'low'` — the row survives (only a bad
`ref` is dropped). `getSuggestions` maps it to `suggested_char_max: null`. The UI writes
**"no confident value found on the page"** next to the field, leaves the input empty and
**disabled**, and the summary reads "No confident suggestions… Enter values manually."
(`admin.html:266-277`). Nothing is pre-filled, nothing is written. **Correct degradation.**

### When the value fails to parse as a number

`Number(r.suggested_char_max)` → `NaN` → fails `Number.isInteger` → **`null`**, i.e. identical to
a decline. Verified behaviour:

| Model returns | Result |
| --- | --- |
| `40` | `40` |
| `"40"` (string) | `40` — `Number("40")` coerces |
| `"40 characters"` | `null` |
| `39.5` | `null` |
| `0`, `-5` | `null` (`n > 0`) |
| `200000` | `null` (`n <= 100000`) |
| `null` / missing | `null` |

Nothing throws; there is no distinct "unparseable" state. The admin sees "no confident value
found" whether the model declined or emitted garbage — a small loss of signal, not a safety issue,
since the value is a suggestion into a disabled input and `validateEdit` (`specReview.js:42-70`)
re-validates server-side and `commitReview` re-validates again.

### Two real weaknesses

- **Silent truncation at 12,000 chars · RISK.** `slice(0, SPEC_EXTRACT_MAX)` (`:2125`) is applied
  with no warning to the caller or the UI. A platform spec table below that cut — plausible on a
  long, nav-heavy help page after a whole-page strip that keeps all chrome (§3) — is simply
  absent from the prompt, and the model correctly reports "not stated". The admin is told the page
  does not state a limit when in fact the page was cut before the table.
- **Duplicate refs silently collapse.** `byRef.set(s.ref, s)` (`specReview.js:512-513`) — last
  write wins, no detection.

### Section 7 verdict — **OK** (prompt discipline, sanitization and decline handling are sound),
with the truncation blind spot as a **RISK**.

---

## 8. Cron and dashboard

### `railway.cron.json`, in full

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "NIXPACKS" },
  "deploy": {
    "startCommand": "node scripts/runDetection.js",
    "cronSchedule": "0 15 * * 1",
    "restartPolicyType": "NEVER"
  }
}
```

`0 15 * * 1` = **Mondays 15:00 UTC**, weekly. Matches CLAUDE.md's "weekly". The main service uses
`railway.json` (`startCommand: npm start`).

**The file name is not a default config path · RISK.** Railway reads `railway.json` /
`railway.toml`; `railway.cron.json` only takes effect if a **second Railway service** is
configured to point its config path at it. Nothing in the repo can confirm that binding, and
nothing at runtime checks it. If the second service was never created or its config path drifted,
this file is inert and the repo looks correctly configured anyway.

**Four in-code comments contradict this file** — see §9.

### What the dashboard reads

`public/admin.html` calls exactly three read endpoints: `/admin/api/health` (`:130`),
`/admin/api/review-queue` (`:160`), and per-flag detail. Health resolves to
`db/specWatch.js:67-93`:

| Display | Source | Line |
| --- | --- | --- |
| "Last detection run" | `SELECT MAX(last_checked_at) FROM spec_watch_list` | `specWatch.js:78-79`; rendered `admin.html:135` |
| "Last run result: N watched · N with error(s) · N pending flag(s)" | counts derived client-side from the watch rows + `spec_review_queue WHERE status='pending'` | `specWatch.js:72-76`; `admin.html:133-136` |
| "Next scheduled run" | **hard-coded in the browser** — `nextMondayCron()` computes next Monday 15:00 UTC from a literal | `admin.html:119-125, 137` |
| Per-URL row: last checked / baselined / last error / pending | `last_checked_at`, `!!current_hash`, `last_error`, pending count | `specWatch.js:81-90`; `admin.html:143-152` |

There is **no runs table**. No row records that a run started, finished, or what each URL's status
was. `unchanged`, `baseline`, `unconfirmed` and `changed` exist only in `runDetection`'s return
value and one `console.log` per row (`specDetector.js:180`) — the return value is shown **only**
after a manual button press (`admin.html:376`) and is discarded on reload.

### "If the cron fails to run at all, would the dashboard show anything different?"

**Almost nothing.**

| | Cron never runs | Cron runs, finds no changes |
| --- | --- | --- |
| "Last detection run" | stale — `7d ago`, `21d ago` | recent |
| "Next scheduled run" | **identical** — computed client-side from a literal, never from reality | identical |
| "Last run result" line | **identical** — derived from watch-row state, not from a run | identical |
| Per-URL "Last checked" | stale by the same amount | recent |
| Baselined / Last error / Pending | **identical** | identical |
| Any warning, colour, or alert | **none** | none |

The only difference is a relative timestamp the reader must notice and interpret. There is no
staleness threshold, no "overdue" styling, no alert. A dead cron renders as a normal, healthy
page. Worse:

- **`lastRun` advances even when every fetch fails.** The error branch writes `last_checked_at`
  (`specDetector.js:160-163`), so "Last detection run: 2h ago" is compatible with 100% failure.
  Only the separate "N with error(s)" count reveals it.
- **`restartPolicyType: "NEVER"`** means a crashed cron container is not retried — and since the
  crash is never recorded in Postgres, it leaves no trace on the dashboard at all.
- **`unconfirmed` is invisible** (§4). A URL stuck permanently unconfirmable shows
  `last_checked_at` recent, `baselined: yes`, `last_error: —` — indistinguishable from healthy.

### Section 8 verdict — **RISK**

The health module reads real state and the schedule string matches the cron file. But the
dashboard cannot show the one thing it appears to show — whether the last run actually ran and
what it found — because no run is ever recorded, the "next run" is a browser-side literal, and
silence renders identically to success.

---

## 9. Drift and dead code

### Claims in CLAUDE.md / README the code does not support

| # | Claim | Reality | Mark |
| --- | --- | --- | --- |
| 1 | `services/specReview.js` — "The ONLY place that writes `copy_fields`" (CLAUDE.md architecture map; repeated at `specReview.js:3-4`, `routes/admin.js:197`, `migrateAddSpecChangeLog.js:8-9`) | Five writers in `src/`; `db/assets.js` writes `char_max` and `spec_note` from the settings and install paths (`:68, 280, 409, 427, 446`). True only of `spec_type` / `spec_source` / `spec_verified_at` and of cross-tenant writes. | **RISK** |
| 2 | "Research citations do not go on the watch list… A published finding does not change" (CLAUDE.md §"What goes on the LiveSpecs watch list") | Two Litmus blog posts are seeded onto the list (`migrateAddSpecTables.js:45-56`), one an infographic last updated 2021. The rule's own reasoning applies to them exactly. | **RISK** |
| 3 | Same section: the list "exists for pages that publish platform limits" — implying the list tracks enforced specs | The list is a frozen snapshot. Ten of its fields are now `recommended`, one enforced field is missing, one asset name is stale, and one cited platform page is absent entirely (§1). No code recomputes it. | **RISK** |
| 4 | "`railway.cron.json` is a separate Railway service that runs `node scripts/runDetection.js` weekly… See README for the full Slack + Railway setup" | The cron file exists and the schedule matches, but **README.md contains no mention of LiveSpecs, the detector, or the cron** (grep for `detector|detection|cron|LiveSpecs` → no hits). The pointer leads nowhere. | **RISK** |
| 5 | Four in-code headers state the detector is **manual only, no cron**: `specDetector.js:5`, `routes/admin.js:126`, `scripts/runDetection.js:6`, `scripts/migrateAddDetector.js:9` | `railway.cron.json` schedules it weekly, and CLAUDE.md documents that. The comments are stale in the opposite direction from the docs. | **RISK** |
| 6 | `migrateAddSpecChangeLog.js:13` — the log is "the basis for a future rollback" | Nothing reads `spec_change_log`. No rollback exists. | **RISK** |
| 7 | `destinations/index.js` header + CLAUDE.md — `spec_watch_list.affected_fields` "…that depend on this URL" (`migrateAddSpecTables.js:18`) | It is what depended on the URL *at seed time*. Present tense is wrong and is what makes the staleness invisible. | **RISK** |
| 8 | (Non-LiveSpecs, observed while establishing a baseline) CLAUDE.md: "`test/smoke.test.js` is ~3,300 lines and currently runs **173 tests**" | 346 tests, ~9,500 lines. Noted for accuracy; outside this audit's scope to fix. | note |

### Unreachable / unused LiveSpecs code paths

| Path | Line | Status |
| --- | --- | --- |
| `GET /admin/api/watch-list` | `routes/admin.js:51-59` | Reachable over HTTP, **called by nothing** — `admin.html` never requests it (its only calls are health, review-queue, flag, suggestions, dismiss, approve-preview, approve-commit, run-detection). |
| `POST /admin/api/test-spec` | `routes/admin.js:111-123` | Reachable, **no UI** — `admin.html` has no test-page editor. The test harness is drivable only from the Railway console via `scripts/setTestSpec.js`. |
| `spec_change_log` (whole table) | written `specReview.js:419-434` | **Write-only.** No reader anywhere. |
| `copy_fields.spec_version` | `defaultAssets.js:727` | Seeded `'1.0'`, read, rendered nowhere, never updated. Inert (§6). |
| `hashText` export | `specDetector.js:186` | Exported; no consumer in `src/`, `scripts/` or tests. |
| `runDetection` no-DB branch | `specDetector.js:101` | Returns `{ran:false}`; the route wraps it as `success:true` (`routes/admin.js:130`), so the UI prints `Done: undefined` — `summary` is `{}`. Cosmetic. |
| Test-flag approve form | `specReview.js:196-230` | Reachable for `is_test` flags, but `affected_fields` is NULL → empty form; `guardEdits:238` blocks any write, and the UI hides the button (`admin.html:181`). Harmless triple-guard. |
| `scripts/reopenFlag1.js` | whole file | One-off targeting flag id 1 by hard-coded constant. Spent. |

### Zero test coverage of the detector · **RISK**

`test/smoke.test.js` (346 tests) contains **no reference** to `specDetector`, `runDetection`,
`hashText`, `normalize`-for-hashing, or `REFETCH`. The only LiveSpecs tests are two pure-function
tests over `specReview`'s `tenantValueBreakdown` / `changedRows` (`:7794, 7830`), a SQL-shape
assertion (`:9478-9485`), and a test asserting a **paragraph in CLAUDE.md** exists (`:7552`).
Every branch in §2, §3 and §4 — baseline, unchanged, changed, unconfirmed, error — is untested.

### Section 9 verdict — **RISK**

---

## 10. Secrets

Traced every log statement and outbound call in the LiveSpecs path.

| Question | Finding | Mark |
| --- | --- | --- |
| Does any path log fetched page content? | **No.** The detector logs only `display_name`, status and an error message (`specDetector.js:165, 180`). `specReview.js` logs asset/field names, spec values and tenant ids (`:310-322, 405-415, 457-462`) — business data, never page bodies. `scripts/suggestFlag.js` prints model snippets (≤200 chars, admin-run console tool). | **OK** |
| Are URLs with tokens logged? | **No.** All seven watch URLs are public documentation pages with no query strings. `source_url` is logged and persisted, which is correct and non-sensitive. | **OK** |
| Are credentials logged? | **No.** `callGemini` puts `GEMINI_API_KEY` in the query string (`gemini.js:225`) but **never logs the URL**. Its throw sites carry status + response body (`:246-249`) and a timeout message (`:238-240`) — no URL, no key. `extractSpecValues`'s catch logs `err.message` only (`:2169`). No `DATABASE_URL`, OAuth token, or Slack secret appears anywhere in the LiveSpecs path. | **OK** |
| Is `last_error` a leak vector? | `err.message` is persisted to `spec_watch_list.last_error` and rendered to admins (`admin.html:149`). Values are `status 404`, `status 403`, `fetch failed`, or an abort message. Bounded and non-sensitive. | **OK** |

### Two data-flow notes (not leaks, worth stating)

- **Fetched third-party page text is sent to Google Gemini.** `getSuggestions` → `extractSpecValues`
  ships up to 12,000 chars of the fetched page to the Gemini API (`specReview.js:505-510`,
  `gemini.js:2125`). Intended, admin-triggered, and the pages are public — but it is an external
  transmission of fetched content and should be understood as one.
- **`GET /admin/test-spec` is public, unauthenticated, and un-rate-limited.**
  (`routes/admin.js:94-107`.) The public-ness is deliberate and correct (the detector fetches it
  without a session), and content is HTML-escaped (`:36-41`) and admin-authored fake data. But the
  admin router is mounted with **no rate limiter** (`server.js:113`; limiters are applied only to
  `/oauth`, `/auth`, and the Slack routes at `:82-83, 300-357`), so this endpoint issues one
  unauthenticated Postgres read per request with no throttle.

### Section 10 verdict — **OK**

---

## Summary — RISK and BROKEN items, ordered by blast radius

| # | Item | Where | Impact | Mark |
| --- | --- | --- | --- | --- |
| 1 | **Google watch row is orphaned by an asset rename** — `affected_fields` names `Google DV360 / Responsive Display`, renamed to `Google Responsive Display Ad`. Approve → 0 rows updated, audit row written, flag marked `reviewed`, UI reports success. | `migrateSpecIntegrityFixes.js:137,202-206` vs `specReview.js:74-84,377-386,450`; `admin.html:345` | A confirmed Google spec change can be fully "handled" while no tenant's limit moves. Silent. | **BROKEN** |
| 2 | **`affected_fields` is a frozen snapshot with no recompute path** — the mechanism behind items 1, 3, 4, 5. `ON CONFLICT DO NOTHING`; nothing rebuilds it from `copy_fields`. | `migrateAddSpecTables.js:96-105`; no writer anywhere | Every future spec_source/rename migration silently widens the drift. | **BROKEN** |
| 3 | **LinkedIn Carousel: watched against the wrong page; its real page unwatched** — 6 fields cite the carousel specs URL, which is on no watch row; they hang off the single-image row instead. | `defaultAssets.js:690-691`; `migrateAddSpecTables.js:112-124` | Carousel limit changes never detected; single-image changes invite writing carousel limits from a page that lacks them. | **RISK** |
| 4 | **A permanently unconfirmable page is permanently blind** — `unconfirmed` never escalates, is never persisted, and clears `last_error`. | `specDetector.js:129-155` | A page with per-request variation (the header names Google's) never flags a real spec edit, and looks healthy on the dashboard. | **RISK** |
| 5 | **Any 200 is treated as content** — no Content-Type, length, keyword or final-URL check; redirects followed silently; a JS shell hashes to sha256(''). | `specDetector.js:56-69,113-121` | Interstitials/challenge pages become the baseline; recovery later reads as a "change"; distinct URLs can share a hash. | **RISK** |
| 6 | **No revert path and no per-tenant prior values persisted** — `spec_change_log.old_value` is a joined string; the per-tenant detail exists only in the HTTP response and server logs. Nothing ever reads the table. | `specReview.js:397-434`; `migrateAddSpecChangeLog.js:13` | A bad cross-tenant approval is unrecoverable from the database once logs rotate. | **RISK** |
| 7 | **"specReview is the ONLY writer of `copy_fields`" is false** — `db/assets.js` writes `char_max`/`spec_note` from install and settings paths. | CLAUDE.md; `specReview.js:3`; `routes/admin.js:197` vs `db/assets.js:68,280,409,427,446` | Anyone reasoning about spec provenance from the docs will miss two live write paths. | **RISK** |
| 8 | **No spec version stamping on generated documents** — projects record nothing; `spec_version` is a never-updated constant. | `pipeline.js:1058-1071`; `db/projects.js:65-70`; `specReview.js:361-371` | After a limit change, nothing can identify which documents were built against the old value. | **RISK** |
| 9 | **A dead cron is indistinguishable from a quiet successful run** — no runs table; "next run" is a browser literal; `lastRun` advances even when every fetch fails; no staleness warning. | `specWatch.js:67-93`; `admin.html:119-137`; `railway.cron.json:9` | Total detector failure can persist unnoticed for weeks. | **RISK** |
| 10 | **`railway.cron.json` is a non-default config path** — inert unless a second Railway service points at it; unverifiable from the repo, and four code comments still say "no cron". | `railway.cron.json`; `specDetector.js:5`; `routes/admin.js:126`; `runDetection.js:6`; `migrateAddDetector.js:9` | The scheduler may not exist at all while the repo reads as configured. | **RISK** |
| 11 | **Whole-page hashing** — nav, footer year and A/B banners all change the hash (verified against the real functions); no selector scoping. | `specDetector.js:40-52` | Recurring false positives; flag #1 was already one. Review fatigue erodes the queue's value. | **RISK** |
| 12 | **Zero test coverage of the detector** — 346 tests, none touching `specDetector.js`. | `test/smoke.test.js` | Every branch in §2–§4 can regress silently. | **RISK** |
| 13 | **Litmus rows violate the documented watch-list rule**; the Meta row no longer satisfies the list's own inclusion rule. | `migrateAddSpecTables.js:45-56`; CLAUDE.md §"What goes on the LiveSpecs watch list" | Noise in the queue the rule was written to prevent. | **RISK** |
| 14 | **`Organic Social — Twitter/X || Post Copy` unreachable** — enforced and citing a watched URL, but absent from that row's `affected_fields`. | `migrateSpecIntegrityFixes.js:77`; `specReview.js:253-255` | That field can never be updated through the flag flow. | **RISK** |
| 15 | **Extraction truncates the page at 12,000 chars silently** — no warning to caller or UI. | `gemini.js:2122,2125` | "Page does not state a limit" may mean "the table was cut off". | **RISK** |
| 16 | **Admin router has no rate limiter**; `GET /admin/test-spec` is public and hits Postgres per request. | `server.js:113`; `routes/admin.js:94-107` | Unauthenticated, unthrottled DB read. Low severity. | **RISK** |
| 17 | **README documents none of LiveSpecs** while CLAUDE.md points to it for the cron setup. | README.md; CLAUDE.md "Deploy" | Onboarding dead end. | **RISK** |
| 18 | **No row locking on the pre-write snapshot** — `currentValues` inside the txn has no `FOR UPDATE`. | `specReview.js:356` | Concurrent approvals can produce an inaccurate audit row. Low likelihood. | **RISK** |

### Sections marked OK

- **§7 Extraction** — prompt discipline ("use ONLY numbers actually present"), strict sanitization,
  index-based `ref` binding that cannot cross-wire repeated field names, and a decline path that
  degrades to "enter values manually" without pre-filling anything. (Item 15 is a bounded caveat.)
- **§10 Secrets** — no fetched content, tokenized URL, or credential is logged anywhere in the
  LiveSpecs path; the Gemini API key never reaches a log line.

### What is genuinely well built (stated so the risk list is not read as a verdict on the whole)

The write path's safety construction is strong: a two-step preview/commit where the preview is
provably read-only, an `is_test` hard block, an affected-pair allowlist, server-side re-validation
on both steps, a single transaction spanning value + stamp + audit + flag flip, and — unusually —
explicit per-tenant divergence reporting surfaced in the UI *before* and *after* the write. The
detector's failure branch is equally conservative: a fetch failure never flags and never advances
the baseline, so a broken fetch cannot masquerade as a spec change. The problems found are
concentrated in what happens *around* those cores — the staleness of the watch list, the absence
of any run record, and the absence of a way back.
