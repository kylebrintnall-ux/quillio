'use strict';

// The spec correction sweep.
//
// WHAT IT DOES. On a schedule: find platform-enforced character limits that
// changed since it last ran, find the unfinished documents built with the old
// number, correct the bracket in those documents' field labels, and write one
// notification per spec change per tenant saying what changed and how many of
// their documents were updated.
//
// WHAT IT DELIBERATELY DOES NOT DO: touch the copy. A field whose limit dropped
// may now hold a line that is too long, and telling the writer so is the entire
// point of the notification. Rewriting it would make Quillio the author of copy a
// person signed off on and shipped.
//
// ============================================================================
// SCOPE — the part with the most ways to be wrong
// ============================================================================
//
// ONLY `spec_type = 'enforced'`. A house_default is Quillio's suggestion and a
// recommended limit is a publisher's advice; Settings grants tenants the right to
// set their own number on the house defaults (see CLAUDE.md, "House defaults are
// the tenant's"), and a background job that corrected those would take back a
// permission the product deliberately gives. Enforced is the only tier that is a
// fact about a platform rather than an opinion about writing.
//
// THE GATE IS AN ALLOWLIST OF ONE, not `!== 'house_default'`. A fourth tier would
// only ever be added to carry some new kind of authority, and failing closed on
// the authority axis is the same call db/assets.js isTenantEditableTier already
// makes for the mirror-image decision.
//
// A TENANT WITH `char_max_override` IS SKIPPED ENTIRELY, even on an enforced
// field. Their document deliberately does not reflect the base spec, and the
// override columns exist precisely so that a later write to the base row does not
// drag them along (CLAUDE.md: "The tenant's value lives in an OVERRIDE column").
// A sweep that corrected them would be the same silent value migration those
// columns were added to defeat, arriving weekly.
//
// AND THE TEST IS `char_max_override IS NOT NULL`, NOT `spec_overridden`.
// `spec_overridden` is a THREE-column OR — char_min, char_max, spec_note — so a
// tenant who only rewrote the guidance NOTE reads as overridden while their
// maximum is still the base spec and their bracket still shows the platform's old
// number. Using the coarse flag would leave exactly those tenants stale forever,
// silently, which is the failure mode this sweep exists to fix. `char_min` is
// treated separately again: a tenant who set their own FLOOR keeps it, because
// the replacement bracket is composed from the minimum the DOCUMENT already
// carries and only the maximum moves.
//
// HOW THE EFFECTIVE VALUE IS DETERMINED PER TENANT. Not from spec_change_log —
// that table is written cross-tenant with no tenant predicate and its `old_value`
// is a single "distinct value" summary of every tenant row, so it cannot answer
// what any particular tenant's number was. Instead: db/specSweep.getLibraryRows
// reads every tenant's own copy_fields row joined to its asset_types row, and the
// effective maximum is `COALESCE(char_max_override, char_max)` — character for
// character the COALESCE db/assets.js getTenantAssets applies (OVERRIDE_COLS),
// which is what produced the number in the bracket in the first place. Matching
// of asset and field names goes through src/utils/normalize.js, the ONE
// normalizer, rather than through SQL.
//
// AND THE DOCUMENT IS STILL THE FINAL AUTHORITY. The manifest says which
// documents to open; the bracket in the document decides whether to edit. A field
// whose bracket does not read the old value is left alone, whether because the
// sweep already corrected it, or because a writer edited it by hand. That is also
// what makes a re-run idempotent.
//
// ============================================================================
// THE WATERMARK, AND WHAT A PARTIAL FAILURE DOES TO IT
// ============================================================================
//
// Changes are processed oldest first, and the watermark advances to the last
// change that FULLY succeeded — where "fully" means every tenant and every
// document for that change either completed or was deliberately skipped. The
// moment one change ends with a real failure (a document that would not write, a
// tenant whose credential is dead), the sweep stops advancing and the run ends
// with `status: 'partial'`.
//
// It stops advancing rather than skipping ahead, and that asymmetry is the whole
// safety property: a watermark that jumped over an incomplete change would mean
// those documents are never corrected and that notification is never written, by
// a background job with nobody watching. Stopping means the next run starts at
// the same change and tries again. The cost is re-processing the changes after it
// that had already succeeded — which is free, because every step is idempotent:
// a corrected bracket no longer reads the old value, and a re-written
// notification is a new row only if the sweep gets far enough to write it.
//
// A REVOKED GOOGLE TOKEN IS EXPECTED, NOT EXCEPTIONAL. The sweep runs with no
// interactive session, so a tenant whose refresh token was revoked fails with
// invalid_grant and will keep failing until that person signs in again — retrying
// is pointless and aborting the run would let one dead credential stop every
// other tenant's corrections. Such a tenant is skipped, reported by name, and
// counted; the change is marked incomplete so the watermark holds, which is what
// makes the corrections arrive on their own once the token is restored.

const { getDestination } = require('../destinations');
const { getClientsForTenant } = require('../google');
const { normalize } = require('../utils/normalize');
const { specChangeNotification } = require('../utils/specNotice');
const { createNotification } = require('../db/notifications');
const {
  getSweepState,
  setSweepState,
  getChangesSince,
  getLibraryRows,
  getSweepableProjects,
  hasSpecNotification,
  updateManifestMax,
} = require('../db/specSweep');

const TAG = '[specSweep]';

// The one tier the sweep may act on. See the header.
const CORRECTABLE_TIERS = new Set(['enforced']);

// Google's answer when a refresh token has been revoked or expired. Copied in
// shape from scripts/verifyReviewComments.js, which defines the same predicate —
// the response body's shape varies by googleapis version and by whether the
// failure came from the token endpoint or the API call, so all three places are
// checked rather than just `err.message`.
function isInvalidGrant(err) {
  if (!err) return false;
  const data = (err.response && err.response.data) || {};
  if (String(data.error || '') === 'invalid_grant') return true;
  return (
    /invalid_grant/i.test(String(err.message || '')) ||
    /invalid_grant/i.test(String(data.error_description || ''))
  );
}

// The composite key an (asset, field) pair is matched on, both sides through
// src/utils/normalize.js — the ONE normalizer, so a change to it moves the sweep
// and the unique indexes together.
//
// THE SEPARATOR IS \u0000 AND IT IS NOT DECORATION. normalize() collapses
// whitespace but keeps it, so a space separator is ambiguous: ("Nurture Email",
// "Subject") and ("Nurture", "Email Subject") both key to "nurture email subject"
// and one change would correct the other's field. NUL is the one character
// normalize() can never emit.
//
// Written as an ESCAPE, never as a literal byte. It was a literal at first, which
// parses identically and passes every test — and makes git classify the file as
// BINARY, so it has no reviewable diff, and any tool that strips control
// characters would silently re-introduce the collision above.
const KEY_SEP = '\u0000';
const key = (asset, field) => `${normalize(asset)}${KEY_SEP}${normalize(field)}`;

// Index every tenant's library row by (asset, field), so one change can be
// resolved against every tenant in one lookup.
function indexLibrary(rows) {
  const byPair = new Map();
  for (const r of rows) {
    if (!r.isActive) continue;
    const k = key(r.assetName, r.fieldName);
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(r);
  }
  return byPair;
}

// Does this tenant's row let the sweep correct it, and what is its effective max?
//
// Returns { eligible, reason, effectiveMax }. The reasons are reported rather
// than swallowed, because "nothing was corrected" and "nothing was correctable"
// are different answers and only one of them is a bug.
function evaluateRow(row) {
  if (!CORRECTABLE_TIERS.has(String(row.specType || ''))) {
    return { eligible: false, reason: `tier_${row.specType || 'null'}` };
  }
  if (row.charMaxOverride != null) {
    return { eligible: false, reason: 'tenant_override' };
  }
  return {
    eligible: true,
    reason: null,
    // The same COALESCE getTenantAssets applies. With the override ruled out
    // above this is always char_max, and it is written as the COALESCE anyway so
    // the resolution rule is stated where it is used rather than implied.
    effectiveMax: row.charMaxOverride != null ? row.charMaxOverride : row.charMax,
  };
}

// Which fields of one project's manifest this change touches.
//
// Matched on asset and field NAME only — never on the manifest's recorded
// charMax. The manifest is an INDEX of which documents contain a field; the
// document's own bracket is what decides whether to edit. Gating on the recorded
// number instead would break the moment the sweep corrected a document without
// rewriting its manifest, and would make a second change to the same field match
// nothing.
function manifestHits(manifest, change) {
  const fields = (manifest && Array.isArray(manifest.fields) && manifest.fields) || [];
  const k = key(change.assetType, change.fieldName);
  return fields.filter((f) => key(f.assetType, f.fieldName) === k);
}

// Correct one project's document. Returns { corrected, skipped } or throws.
async function correctProject(destination, project, hits, change, effectiveMax) {
  const clients = await getClientsForTenant({
    tenantId: project.tenantId,
    // The person who created the document. A sweep has no interactive session, so
    // there is no "current user" — writing as the creator is both the closest
    // thing to correct and the identity whose Drive the document already lives
    // in. Null falls back to the tenant credential, then to env, which is
    // resolveGoogleRefreshToken's existing ladder.
    userId: project.createdBy,
  });

  const corrections = hits.map((h) => ({
    assetType: h.assetType,
    instance: Number(h.instance) || 0,
    fieldName: h.fieldName,
    expectMax: effectiveMax,
    newMax: Number(change.newValue),
  }));

  const result = await destination.correctFieldBrackets(project.copyDocId, corrections, clients);

  for (const a of result.applied) {
    await updateManifestMax(project.id, {
      assetType: a.assetType,
      instance: a.instance,
      fieldName: a.fieldName,
      newMax: a.newMax,
    });
  }
  return result;
}

// Run the sweep.
//
// `dryRun` does everything except write — no document edit, no notification, no
// watermark move — and reports exactly what it would have done. It is the default
// for the ops script, matching the migrations.
async function runSpecSweep({ dryRun = false, limit = 500 } = {}) {
  const state = await getSweepState();
  if (!state.ready) {
    console.warn(`${TAG} not ready: ${state.reason}. Run scripts/migrateAddSpecSweepState.js.`);
    return { ran: false, reason: state.reason };
  }

  const changes = await getChangesSince(state.lastChangedAt, state.lastChangeId, limit);
  if (changes.length === 0) {
    if (!dryRun) await setSweepState({ status: 'clean', note: 'no new changes' });
    console.log(`${TAG} no spec changes since the watermark — nothing to do.`);
    return { ran: true, dryRun, changes: [], documentsCorrected: 0, notifications: 0, status: 'clean' };
  }

  const destination = getDestination();
  const library = indexLibrary(await getLibraryRows());
  const { projects, skippedNoManifest } = await getSweepableProjects();

  const byTenant = new Map();
  for (const p of projects) {
    if (!byTenant.has(p.tenantId)) byTenant.set(p.tenantId, []);
    byTenant.get(p.tenantId).push(p);
  }

  const report = [];
  let watermark = null;
  let stopped = null;
  let documentsCorrected = 0;
  let notificationsWritten = 0;

  for (const change of changes) {
    const entry = {
      changeId: change.id,
      assetType: change.assetType,
      fieldName: change.fieldName,
      oldValue: change.oldValue,
      newValue: change.newValue,
      tenants: [],
      complete: true,
    };

    const rows = library.get(key(change.assetType, change.fieldName)) || [];
    if (rows.length === 0) entry.note = 'no active library row for this pair on any tenant';

    for (const row of rows) {
      const verdict = evaluateRow(row);
      const t = {
        tenantId: row.tenantId,
        eligible: verdict.eligible,
        reason: verdict.reason,
        documentsCorrected: 0,
        documentsFailed: 0,
        notified: false,
      };
      if (!verdict.eligible) {
        entry.tenants.push(t);
        continue;
      }

      // A change whose new value is not a usable number cannot correct anything.
      const newMax = Number(change.newValue);
      if (!Number.isFinite(newMax) || newMax <= 0) {
        t.eligible = false;
        t.reason = 'unusable_new_value';
        entry.tenants.push(t);
        continue;
      }

      let tenantDead = false;
      for (const project of byTenant.get(row.tenantId) || []) {
        const hits = manifestHits(project.manifest, change);
        if (hits.length === 0) continue;
        if (dryRun) {
          // Counted in BOTH places, so the per-tenant lines and the summary
          // agree. They did not at first, and a report whose own two halves
          // disagree is worse than no report — the reader cannot tell which
          // number is the bug.
          t.documentsCorrected += 1; // would correct — the document is not opened
          documentsCorrected += 1;
          continue;
        }
        try {
          const res = await correctProject(destination, project, hits, change, verdict.effectiveMax);
          if (res.applied.length > 0) {
            t.documentsCorrected += 1;
            documentsCorrected += 1;
          }
        } catch (err) {
          if (isInvalidGrant(err)) {
            // Expected, permanent until that person signs in again, and not a
            // reason to stop. Break out of this tenant's documents — every one of
            // them resolves the same dead credential — but keep sweeping the rest.
            t.reason = 'invalid_grant';
            t.documentsFailed += 1;
            tenantDead = true;
            entry.complete = false;
            console.warn(
              `${TAG} tenant ${row.tenantId}: Google credential revoked (invalid_grant) — ` +
                'skipping this tenant. Corrections resume once that user signs in again.'
            );
            break;
          }
          // One document failing must not stop the sweep. It does, however, mean
          // this change is not finished, so the watermark will not pass it.
          t.documentsFailed += 1;
          entry.complete = false;
          console.error(
            `${TAG} project ${project.id} (${project.copyDocId}) failed: ` +
              (err && err.stack ? err.stack : err)
          );
        }
      }
      if (tenantDead) {
        entry.tenants.push(t);
        continue;
      }

      // One notification per change per tenant, never one per document — and
      // never twice for the same change. The watermark holds at an incomplete
      // change so the next run retries it, which means every tenant that already
      // succeeded comes back through here; without this check a document that
      // failed once would cost every OTHER tenant a duplicate notification every
      // week until it was fixed.
      const already = !dryRun && (await hasSpecNotification(row.tenantId, change.id));
      if (already) {
        t.notified = 'already';
      } else if (!dryRun) {
        const notice = specChangeNotification({
          platform: destination.specSourceName
            ? destination.specSourceName(change.sourceUrl || row.specSource)
            : null,
          assetType: row.assetName,
          fieldName: row.fieldName,
          fieldType: row.fieldType,
          oldMax: verdict.effectiveMax,
          newMax,
          documentsUpdated: t.documentsCorrected,
          changeId: change.id,
        });
        try {
          const written = await createNotification({
            tenantId: row.tenantId,
            type: notice.type,
            message: notice.message,
            link: notice.link,
          });
          t.notified = !!written;
          if (written) notificationsWritten += 1;
        } catch (err) {
          // A notification failure must not fail the correction that already
          // landed — the same rule the web draft path follows. It DOES mark the
          // change incomplete, so the next run retries and the tenant is told.
          entry.complete = false;
          console.error(`${TAG} notification failed for ${row.tenantId}:`, err && err.stack ? err.stack : err);
        }
      } else {
        t.notified = true; // would notify
      }
      entry.tenants.push(t);
    }

    report.push(entry);

    // The watermark only ever moves over a change that finished. The first one
    // that did not stops it, and every later change is left for the next run even
    // if it would have succeeded — see the header for why skipping ahead is the
    // one thing this must not do.
    if (entry.complete && !stopped) {
      watermark = { changedAt: change.changedAt, changeId: change.id };
    } else if (!entry.complete) {
      stopped = entry.changeId;
    }
  }

  const status = stopped ? 'partial' : 'clean';
  const note = stopped
    ? `stopped at change ${stopped}; ${changes.length} change(s) examined`
    : `${changes.length} change(s) swept`;

  if (!dryRun) {
    await setSweepState({
      changedAt: watermark ? watermark.changedAt : null,
      changeId: watermark ? watermark.changeId : null,
      status,
      note,
    });
  }

  console.log(
    `${TAG} ${dryRun ? 'DRY RUN — ' : ''}${changes.length} change(s), ` +
      `${documentsCorrected} document(s) corrected, ${notificationsWritten} notification(s), ` +
      `${skippedNoManifest} project(s) skipped for a null manifest, status=${status}`
  );

  return {
    ran: true,
    dryRun,
    status,
    changes: report,
    documentsCorrected,
    notifications: notificationsWritten,
    skippedNoManifest,
    stoppedAtChange: stopped,
    watermark,
  };
}

module.exports = { runSpecSweep, isInvalidGrant, evaluateRow, manifestHits, CORRECTABLE_TIERS };
