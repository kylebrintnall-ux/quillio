'use strict';

// The shape a TENANT may submit when creating an asset type, and the only place
// that decides it. Pure — no database, no Express — so the rules are testable
// without either. Mirrors destinations/docHeaderSchema.js normalizeHeaderSchema:
// the route calls this, and the route calls it AGAIN on save, so a client can
// never persist a shape it was not offered.
//
// THE ALLOWLIST IS THE POINT. Every value on the returned object is copied
// across by name from an explicit list. The input is never spread, never
// Object.assign'd, and never iterated — so a key nobody wrote here cannot reach
// Postgres no matter what the request body contains.
//
// spec_type and spec_source are NOT on that list, and this is not a validation
// choice that could be relaxed later. They are rendered in the generated doc as
// claims of authority: specTypeLine (destinations/googleDocs.js:307-338) turns
// 'enforced' into "Platform limit (LinkedIn). Stay within this count.", and
// fieldHint (:357-380) hyperlinks the platform name to the spec_source URL. A
// tenant able to set them could publish a number they invented as LinkedIn's
// enforced limit with a live link to linkedin.com underneath it. specSourceName
// (:232) matches on SUBSTRING, so a leaked value would not even need to be a
// real Quillio source to render a real platform name. Absent beats validated:
// there is no code path here that reads them.
//
// spec_note IS writable, deliberately. gemini.js:922 and :1012 both read
// `notes || builtInFieldGuidance(fieldName)`, and `notes` is the italic line
// parseDoc recovers from the doc — which is fieldHint()'s output. So a tenant's
// note reaches the drafter as per-field guidance and outranks the built-in. For
// a custom field spec_type is null, so the tier line is empty and the note
// renders alone. It is the tenant's only channel for telling the drafter how to
// write their own field.

const { normalize } = require('./normalize');

// Ceilings.
//
// FIELDS_PER_ASSET: the largest bundled asset is Event Landing Page at 24
// fields. A pasted house landing page is the case this exists for and could
// plausibly be larger, so 60 leaves real headroom. Field count costs one
// prompt's size, not one call per field — generateAssetDrafts makes a single
// call per asset — so the cost of a big asset is bounded and linear.
//
// ASSETS_PER_TENANT: the bundled library is 30. 100 leaves room for 70 custom
// types, far past any plausible library, while bounding the parse prompt — every
// ACTIVE asset name is interpolated into it (core/pipeline resolveAssetVocabulary).
const MAX_FIELDS_PER_ASSET = 60;
const MAX_ASSETS_PER_TENANT = 100;

const MAX_NAME = 120;
const MAX_GROUP = 60;
const MAX_DIRECTION = 2000;
const MAX_SPEC_NOTE = 2000;
// Borrowed from services/specReview.js validateEdit, so the two writers agree on
// what a plausible character limit is.
const MAX_CHAR_LIMIT = 100000;

// An asset name ending in " 12" or " 12 — Something" is how googleDocs writes a
// REPEATED asset's heading (INSTANCE_HEADING_RE, googleDocs.js:165). A tenant
// asset actually named that way can be read back as instance 12 of another
// asset, which attributes its fields to the wrong asset on every re-read. The
// reader has a sibling rule that makes this safe in most documents, but the
// cheap fix is to never create the collision.
const INSTANCE_SUFFIX_RE = /^(.+?) (\d+)(?: — (.+))?$/;

// A field label ending in a bracket collides with the doc round trip: fieldLabel
// appends "[50]" and parseDoc strips a trailing bracket to recover the limits
// (googleDocs.js:402-408, :778), so "Headline [v2]" reads back as "Headline"
// with charMax 2.
const TRAILING_BRACKET_RE = /\[[^\]]*\]\s*$/;

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// A non-negative integer, or null when the value is absent/blank. Rejects
// anything non-integral rather than coercing, so "12abc" is an error and not 12.
function intOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v !== 'string') return NaN;
  return /^\d+$/.test(v.trim()) ? parseInt(v.trim(), 10) : NaN;
}

// An existing copy_fields id, as it comes back from getTenantLibrary (a bigint
// serialized to a string). Anything that is not a bare run of digits is not an
// id we issued, and is treated as a NEW field rather than trusted — a caller
// cannot smuggle an expression into the WHERE clause, and cannot claim a row by
// guessing at its shape.
const FIELD_ID_RE = /^\d+$/;

// THE ASSET SHELL — name, group, direction. Shared by create and edit so the two
// cannot drift on what a valid name is. `selfName` is the asset's CURRENT name on
// an edit: keeping your own name must not read as a duplicate of yourself.
function normalizeShell(input, errors, { existingNames = [], selfName = null } = {}) {
  const name = str(input.name);
  const self = selfName ? normalize(selfName) : null;
  if (!name) errors.push('Give the asset type a name.');
  else if (name.length > MAX_NAME) errors.push(`Asset name must be ${MAX_NAME} characters or fewer.`);
  else if (INSTANCE_SUFFIX_RE.test(name)) {
    errors.push(
      `"${name}" ends in a number, which is how Quillio labels a repeated asset in a doc. Try a name without a trailing number.`
    );
  } else if (existingNames.some((n) => normalize(n) === normalize(name) && normalize(n) !== self)) {
    errors.push(`You already have an asset type called "${name}".`);
  }

  const group = str(input.group);
  if (group.length > MAX_GROUP) errors.push(`Group must be ${MAX_GROUP} characters or fewer.`);

  const direction = str(input.asset_direction);
  if (direction.length > MAX_DIRECTION) {
    errors.push(`Creative direction must be ${MAX_DIRECTION} characters or fewer.`);
  }
  return { name, group: group || null, asset_direction: direction || null };
}

// THE FIELD LIST — and THE ALLOWLIST, which is the point of this whole module.
// Shared by create and edit, so an update cannot accept a column a create refuses.
//
// `withIds` is the only difference between the two: an edit carries an existing
// copy_fields id per row (or none, for a field being added), and that id is how
// a rename is applied to the right row. Everything else is identical, byte for
// byte, because it is the same code.
function normalizeFields(rawInput, errors, { withIds = false } = {}) {
  const rawFields = Array.isArray(rawInput) ? rawInput : [];
  if (rawFields.length === 0) errors.push('Add at least one copy field.');
  if (rawFields.length > MAX_FIELDS_PER_ASSET) {
    errors.push(`An asset type can have at most ${MAX_FIELDS_PER_ASSET} fields (this one has ${rawFields.length}).`);
  }

  const fields = [];
  const seen = new Map(); // normalized field name -> original, for the duplicate message
  const seenIds = new Set();
  rawFields.slice(0, MAX_FIELDS_PER_ASSET).forEach((rf, i) => {
    const f = rf && typeof rf === 'object' ? rf : {};
    const where = `Field ${i + 1}`;

    const fieldName = str(f.field_name);
    if (!fieldName) {
      errors.push(`${where}: give the field a name.`);
    } else if (fieldName.length > MAX_NAME) {
      errors.push(`${where}: name must be ${MAX_NAME} characters or fewer.`);
    } else if (TRAILING_BRACKET_RE.test(fieldName)) {
      errors.push(`${where}: a field name can't end in [brackets] — Quillio adds those for the limit.`);
    } else {
      const key = normalize(fieldName);
      if (seen.has(key)) errors.push(`${where}: "${fieldName}" duplicates "${seen.get(key)}".`);
      else seen.set(key, fieldName);
    }

    // char_max 0 means NO LIMIT, and that is a real state: fieldLabel renders no
    // bracket at all when it is 0 (googleDocs.js:408) and parseDoc reads a
    // bracket-less label back correctly (:778-792). specReview's validateEdit
    // requires a positive integer because it is EDITING a platform limit, where
    // zero would be meaningless; a tenant's own field can legitimately have none.
    const charMin = intOrNull(f.char_min);
    const charMax = intOrNull(f.char_max);
    if (Number.isNaN(charMin) || (charMin !== null && charMin > MAX_CHAR_LIMIT)) {
      errors.push(`${where}: minimum must be a whole number between 0 and ${MAX_CHAR_LIMIT}.`);
    }
    if (Number.isNaN(charMax) || (charMax !== null && charMax > MAX_CHAR_LIMIT)) {
      errors.push(`${where}: limit must be a whole number between 0 and ${MAX_CHAR_LIMIT}.`);
    }
    const min = Number.isNaN(charMin) ? 0 : charMin || 0;
    const max = Number.isNaN(charMax) ? 0 : charMax || 0;
    if (min > 0 && max > 0 && min > max) {
      errors.push(`${where}: minimum (${min}) is above the limit (${max}).`);
    }

    // The unit the limits are counted in. rowToSpecGroup coerces anything that
    // isn't 'words' to 'text' (core/pipeline.js:753), so accepting a third value
    // would store something the pipeline silently rewrites.
    const rawType = str(f.field_type) || 'text';
    if (rawType !== 'text' && rawType !== 'words') {
      errors.push(`${where}: unit must be "text" or "words".`);
    }

    const specNote = str(f.spec_note);
    if (specNote.length > MAX_SPEC_NOTE) {
      errors.push(`${where}: note must be ${MAX_SPEC_NOTE} characters or fewer.`);
    }

    // THE ALLOWLIST. Built key by key. Nothing from `f` reaches this object
    // except the values named here — spec_type and spec_source have no branch
    // that can set them, on create OR on update, so they are NULL by
    // construction on a created field and UNTOUCHED on an edited one.
    const out = {
      field_name: fieldName,
      char_min: min,
      char_max: max,
      field_type: rawType === 'words' ? 'words' : 'text',
      // Position is the ORDER SUBMITTED, never a number the client sends. That is
      // what makes reordering a matter of moving rows in the list rather than
      // trusting an index, and it is why a tampered sort_order cannot collide two
      // fields onto one position.
      sort_order: i + 1,
      spec_note: specNote || null,
    };
    if (withIds) {
      const id = str(f.id);
      if (id && FIELD_ID_RE.test(id)) {
        if (seenIds.has(id)) errors.push(`${where}: the same field appears twice.`);
        seenIds.add(id);
        out.id = id;
      }
      // No id (or a shape we never issued) → a NEW field. It is inserted, not
      // matched: the alternative is trusting a client-supplied row identity.
    }
    fields.push(out);
  });
  return fields;
}

// Validate + normalize one submitted asset for CREATE. Returns { errors: [], asset } —
// `asset` is only meaningful when errors is empty.
//
// `existingNames` is every asset name already in this tenant's library (active
// or not), so a duplicate is a readable error instead of a Postgres 23505 from
// asset_types_tenant_name_norm_uniq. The index is still the authority; this is
// the message, not the guarantee.
function normalizeNewAsset(raw, { existingNames = [], existingAssetCount = 0 } = {}) {
  const errors = [];
  const input = raw && typeof raw === 'object' ? raw : {};

  if (existingAssetCount >= MAX_ASSETS_PER_TENANT) {
    errors.push(`This workspace already has ${existingAssetCount} asset types (limit ${MAX_ASSETS_PER_TENANT}).`);
    return { errors, asset: null };
  }

  const shell = normalizeShell(input, errors, { existingNames });
  const fields = normalizeFields(input.fields, errors);

  if (errors.length > 0) return { errors, asset: null };
  return { errors: [], asset: { ...shell, fields } };
}

// Validate + normalize an EDIT of an asset the tenant already owns.
//
// The only differences from a create: fields carry ids (see normalizeFields), the
// tenant is not blocked by the per-tenant asset ceiling (an edit adds no asset),
// and `selfName` lets the asset keep its own name without colliding with itself.
//
// Whether the asset may be edited AT ALL is not decided here — that is
// db/assets.updateAssetType's job, because it is a fact about the stored row
// (whose tenant, seeded or not), not about the submitted shape.
function normalizeAssetEdit(raw, { existingNames = [], selfName = null } = {}) {
  const errors = [];
  const input = raw && typeof raw === 'object' ? raw : {};
  const shell = normalizeShell(input, errors, { existingNames, selfName });
  const fields = normalizeFields(input.fields, errors, { withIds: true });
  if (errors.length > 0) return { errors, asset: null };
  return { errors: [], asset: { ...shell, fields } };
}

// THE HOUSE-DEFAULT SUBMISSION — the reduced shape a tenant may post against a
// SEEDED asset. A far smaller allowlist than the two above, and smaller on
// purpose: the only things a tenant decides about a bundled asset are the three
// values on a house_default field.
//
// NOT ON THIS LIST, and there is no branch that can set them: the asset's name,
// group and creative direction; any field's name, field_type or sort_order; and
// spec_type / spec_source / spec_version as everywhere else. A seeded asset's
// STRUCTURE is what services/specReview.js reaches by, so it stays exactly as
// read-only as it was — this only unlocks the numbers.
//
// EVERY ROW MUST CARRY AN ID. There is no insert here: a row without one names
// nothing and is refused rather than silently dropped, because a form that
// appears to add a field and does not is worse than one that says it cannot.
// Whether a row's TIER permits the write is decided later, from the STORED
// spec_type, inside db/assets.updateAssetType's row lock — never from here and
// never from the request.
//
// char_min AGAINST char_max IS NOT CHECKED HERE, and that is deliberate. This
// function is pure, so it can only compare the two numbers when both arrive —
// which the form used to guarantee and no longer does: a control sends its own
// value alone, so a minimum can arrive to be measured against a limit that is
// only in the stored row. `applyHouseDefaultOverrides` owns the rule now, where
// the row is in hand and every submission shape reaches the same test.
//
// The check used to live here as well. Keeping it would have left one rule in
// two places for the sake of a round trip inside a transaction that is already
// open — and, worse, two different sentences for one condition: a positional
// "Field 3: …" when both halves were touched, and the field's own name when one
// was. The tenant who edited more got the vaguer error.
//
// Each value is still range-checked on its own below. That is a property of one
// number and needs nothing but the request.
//
// `reset: true` means "put this field back on Quillio's default". It is
// exclusive: any value sent alongside it is ignored, because a request that both
// sets and resets a field has no coherent reading and picking one would be a
// guess about which half the user meant.
function normalizeHouseDefaults(raw) {
  const errors = [];
  const input = raw && typeof raw === 'object' ? raw : {};
  const rawFields = Array.isArray(input.fields) ? input.fields : [];
  if (rawFields.length === 0) errors.push('Nothing to save.');
  if (rawFields.length > MAX_FIELDS_PER_ASSET) {
    errors.push(`An asset type can have at most ${MAX_FIELDS_PER_ASSET} fields (this one has ${rawFields.length}).`);
  }

  const fields = [];
  const seenIds = new Set();
  rawFields.slice(0, MAX_FIELDS_PER_ASSET).forEach((rf, i) => {
    const f = rf && typeof rf === 'object' ? rf : {};
    const where = `Field ${i + 1}`;

    const id = str(f.id);
    if (!id || !FIELD_ID_RE.test(id)) {
      errors.push(`${where}: this field can't be identified, so it wasn't saved.`);
      return;
    }
    if (seenIds.has(id)) {
      errors.push(`${where}: the same field appears twice.`);
      return;
    }
    seenIds.add(id);

    if (f.reset === true) {
      fields.push({ id, reset: true });
      return;
    }

    // Built key by key, and a key is present ONLY when the request carried it.
    // `undefined` is "not offered, leave it alone"; an explicit null is the
    // tenant clearing that one value back to the seed's.
    const out = { id };

    if (f.char_min !== undefined) {
      const v = f.char_min === null ? null : intOrNull(f.char_min);
      if (Number.isNaN(v) || (v !== null && (v < 0 || v > MAX_CHAR_LIMIT))) {
        errors.push(`${where}: minimum must be a whole number between 0 and ${MAX_CHAR_LIMIT}.`);
      } else {
        out.char_min = v;
      }
    }
    if (f.char_max !== undefined) {
      const v = f.char_max === null ? null : intOrNull(f.char_max);
      if (Number.isNaN(v) || (v !== null && (v < 0 || v > MAX_CHAR_LIMIT))) {
        errors.push(`${where}: limit must be a whole number between 0 and ${MAX_CHAR_LIMIT}.`);
      } else {
        out.char_max = v;
      }
    }
    if (f.spec_note !== undefined) {
      // '' survives as '' — it is the tenant DELETING the note, which is a
      // different instruction from "leave the seed's note alone".
      const note = f.spec_note === null ? null : str(f.spec_note);
      if (note !== null && note.length > MAX_SPEC_NOTE) {
        errors.push(`${where}: note must be ${MAX_SPEC_NOTE} characters or fewer.`);
      } else {
        out.spec_note = note;
      }
    }

    // A row that named a field and offered nothing to change is not an error —
    // the form posts every row it rendered — it simply has nothing to apply.
    fields.push(out);
  });

  if (errors.length > 0) return { errors, fields: null };
  return { errors: [], fields };
}

module.exports = {
  normalizeNewAsset,
  normalizeAssetEdit,
  // The reduced shape for a SEEDED asset's house_default values. Shares nothing
  // with the two above deliberately: they build a whole asset, this one builds
  // three values per field and cannot express anything else.
  normalizeHouseDefaults,
  MAX_FIELDS_PER_ASSET,
  MAX_ASSETS_PER_TENANT,
  MAX_CHAR_LIMIT,
  MAX_NAME,
  MAX_SPEC_NOTE,
  INSTANCE_SUFFIX_RE,
  FIELD_ID_RE,
};
