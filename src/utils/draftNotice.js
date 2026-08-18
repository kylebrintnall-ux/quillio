'use strict';

// The sentence a finished draft is described with, and the routing target that
// goes with it — composed in ONE place so the notification cannot drift from the
// two surfaces that already say this.
//
// THE THREE SURFACES, AND THE WORDING THEY ALREADY USE:
//
//   public/app.html  draftedLabel(n, attempted)
//     '✓ First draft ready — N fields drafted'
//     '⚠ Draft incomplete — N of M fields drafted'
//
//   src/adapters/slackWorkflow.js  runGenerateDraft
//     '<emoji> First draft ready — *Title* (N fields drafted).'
//     '⚠️ Draft incomplete — *Title* (N of M fields drafted). <cause>'
//
//   here, for the stored notification
//     'First draft ready — Title (N fields drafted).'
//     'Draft incomplete — Title (N of M fields drafted). <cause>'
//
// The sentence is the Slack card's, because that is the one that names the
// DOCUMENT — a notification is read away from the screen that produced it, so
// "1 of 40 fields drafted" with no title attached says nothing about which run.
// The phrasing inside it is identical to app.html's.
//
// THE GLYPH IS DELIBERATELY ABSENT. app.html prefixes ✓ / ⚠ and Slack prefixes
// its own emoji; both are decoration chosen by the surface, and `type` already
// carries the distinction structurally (draft_complete vs draft_incomplete), so
// a renderer can pick its own mark without parsing the message. Baking one in
// would make the stored row assert a presentation it cannot know.
//
// SHORT IS THE SAME TEST ALL THREE USE. app.html draftIsShort and
// slackWorkflow's `short` are both
//   fieldsAttempted > 0 && fieldCount < fieldsAttempted
// and this is the third copy of it. It has to be: a notification that called a
// complete run incomplete (or the reverse) would contradict the toast the same
// person just saw. Nothing enforces the agreement — if that test changes,
// change it in all three, which is the same standing hazard CLAUDE.md records
// for the review overlay's wording.
//
// THE TEMPLATE DOCUMENT FALLS THROUGH THE SUCCESS BRANCH BY CONSTRUCTION, not by
// a special case: adapters/web.js's template path returns no fieldsAttempted, so
// `short` is false and the sentence is the complete one — exactly what
// draftedLabel(n, null) does in app.html.

const TYPE_COMPLETE = 'draft_complete';
const TYPE_INCOMPLETE = 'draft_incomplete';

// Both event kinds this module produces, so a consumer can name them without
// re-typing the strings.
const DRAFT_TYPES = [TYPE_COMPLETE, TYPE_INCOMPLETE];

// Which of a project's documents a notification points at. Mirrors
// routes/app.js docKindOf: only the literal 'template' selects the template
// document, and everything else is the copy doc — which is what every caller
// meant before a brief could produce two.
function docKindOf(raw) {
  return raw === 'template' ? 'template' : 'copy';
}

// Build the notification for a finished draft.
//
// Returns { type, message, link } — never null, because a draft that finished is
// always worth recording, including a draft that finished badly.
//
// `link` is the argument pair app.html's openProject(project, kind) already
// takes, so a UI routes on fields rather than parsing the message. projectId is
// null when the draft's document has no project row (no database, or a document
// created outside a saved run); the link then carries only the screen, and a
// renderer that finds no projectId can fall back to the projects list.
function draftNotification({
  title,
  fieldCount,
  fieldsAttempted,
  failureReason,
  docKind,
  projectId,
} = {}) {
  const name = String(title || 'your document');
  const n = Number.isFinite(fieldCount) ? fieldCount : 0;
  const attempted = Number.isFinite(fieldsAttempted) ? fieldsAttempted : null;
  const short = attempted != null && attempted > 0 && n < attempted;

  // The cause sentence is already a complete, human sentence when it is present
  // (services/gemini.js GEMINI_FAILURE_SENTENCES) — the same string Slack and the
  // web notice render. Appended, never reworded.
  const cause = short && failureReason ? ` ${failureReason}` : '';

  const message = short
    ? `Draft incomplete — ${name} (${n} of ${attempted} fields drafted).${cause}`
    : `First draft ready — ${name} (${n} field${n === 1 ? '' : 's'} drafted).`;

  return {
    type: short ? TYPE_INCOMPLETE : TYPE_COMPLETE,
    message,
    link: {
      screen: 'project',
      projectId: projectId == null ? null : Number(projectId),
      doc: docKindOf(docKind),
    },
  };
}

module.exports = {
  draftNotification,
  DRAFT_TYPES,
  TYPE_COMPLETE,
  TYPE_INCOMPLETE,
};
