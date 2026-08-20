'use strict';

// The sentence a corrected spec is described with, and the routing target that
// goes with it — composed in ONE place, for the same reason utils/draftNotice.js
// is: a notification is read away from the screen that produced it, so it has to
// name what changed without relying on anything around it.
//
// WHAT THIS IS NOT. It is not a report that copy was rewritten. The sweep
// corrects the LIMIT in a field label and never touches a word a writer wrote —
// so on a limit that DROPPED, the honest thing to say is that their copy may now
// be too long, and to leave the decision with them. That sentence is the entire
// reason the feature notifies rather than silently editing.
//
// THE GLYPH IS ABSENT HERE TOO, exactly as in draftNotice: `type` carries the
// distinction structurally and each surface picks its own mark.

const TYPE_SPEC_CHANGE = 'spec_change';

// The screen a spec notification opens. The existing target names a project
// (`{ screen: 'project', projectId, doc }`); this one names a FIELD IN THE
// LIBRARY, which is a different destination with different coordinates, so it
// gets its own screen name rather than overloading the project one with nullable
// extra keys. A renderer switches on `screen` and an unknown screen falls back —
// see public/partials/nav.html activate().
const SCREEN_SPEC = 'spec';

// Characters or words, matching the unit the bracket itself carries
// (destinations/googleDocs.js WORD_UNIT_SUFFIX). A limit stated without its unit
// is a number the writer cannot check their line against.
function unitWord(fieldType, n) {
  if (String(fieldType || '') === 'words') return n === 1 ? 'word' : 'words';
  return n === 1 ? 'character' : 'characters';
}

// How many documents were corrected, said in a way that does not claim more than
// happened. Zero is a real and common outcome — the limit still changed, and the
// tenant's NEXT document will carry the new number — so it is reported rather
// than suppressed.
function documentsClause(count) {
  if (count === 1) return '1 of your documents was updated.';
  if (count > 1) return `${count} of your documents were updated.`;
  return 'No existing documents needed updating.';
}

// Build the notification for one approved spec change, for one tenant.
//
// `platform` is the display name from destinations/googleDocs.js specSourceName —
// never a raw URL, and never the literal spec_source string. A change whose
// source this system cannot name is described without a publisher rather than
// with a hostname, which is the same rule the doc's citation line follows.
function specChangeNotification({
  platform,
  assetType,
  fieldName,
  fieldType,
  oldMax,
  newMax,
  documentsUpdated,
  changeId,
} = {}) {
  const from = Number(oldMax) || 0;
  const to = Number(newMax) || 0;
  const count = Number(documentsUpdated) || 0;
  const who = platform ? `${platform} changed` : 'A platform limit changed';
  const unit = unitWord(fieldType, to);

  // "tightened" vs a bare "changed" is the difference between a notice and a
  // warning, and only one of the two directions can leave a writer with copy that
  // no longer fits.
  const tightened = to > 0 && from > 0 && to < from;
  const consequence = tightened
    ? ' Copy already written to the old limit may now be too long — Quillio did not change it.'
    : '';

  const message =
    `${who} the limit on ${fieldName} (${assetType}) from ${from} to ${to} ${unit}. ` +
    `${documentsClause(count)}${consequence}`;

  return {
    type: TYPE_SPEC_CHANGE,
    message,
    // The library is addressed by NAME, not by id. copy_fields.id and
    // asset_types.id are per tenant, and this notification is written per tenant
    // from a spec_change_log row that carries neither — it carries asset_type and
    // field_name, which are the same coordinates the sweep matched on and the
    // same ones the library screen renders. Names also survive the row being
    // reseeded, which an id does not.
    link: {
      screen: SCREEN_SPEC,
      asset: assetType == null ? null : String(assetType),
      field: fieldName == null ? null : String(fieldName),
      // IDENTITY, NOT ROUTING. The sweep's watermark holds at a change that did
      // not finish, so the next run re-processes it — and every tenant that
      // already succeeded would be notified a second time about the same change.
      // `notifications` has no natural key for that, so the change id rides here
      // and db/specSweep.hasSpecNotification reads it back. A renderer ignores
      // keys it does not know, which is what makes this safe to carry.
      changeId: changeId == null ? null : Number(changeId),
    },
  };
}

module.exports = {
  specChangeNotification,
  TYPE_SPEC_CHANGE,
  SCREEN_SPEC,
  // Exported for the unit tests that pin the two directions apart.
  documentsClause,
  unitWord,
};
