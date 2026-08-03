'use strict';

// REVIEW A BUILT TEMPLATE DOCUMENT (document templates, rework step three).
//
// This is NOT services/copyReview.js for matrices. copyReview asks Gemini to
// judge craft and anchors each note to the text it is about. Neither half
// transfers:
//
//   THE ANCHOR DOES NOT WORK HERE. The anchoring probe settled it — a Drive
//   comment quoting text inside a TABLE CELL does not resolve. All six probe
//   cases came back with Google rendering "Original content deleted": the
//   comment exists, carries its text, and points nowhere. Every cell of a
//   template document is a table cell, so there is no anchored path to degrade
//   from. Comments here are unanchored and NAME THEIR FIELD, which makes
//   marker_name load-bearing: it is the only thing tying a note back to a cell.
//   That is not a workaround. A matrix is already a lookup table with a Field
//   column, so naming the row is how a human refers to it too.
//
//   THE JUDGEMENT IS DELIBERATELY ABSENT. Every note below is MEASURABLE —
//   over a character limit, over a word limit, or still showing a {{marker}}
//   that was meant to be drafted. No model is called. Craft feedback on a
//   matrix is a real question (what IS the equivalent of "cut the throat-clear"
//   when the cell is a form label?) and it is not answered by shipping the copy
//   doc's prompt at it and seeing what comes out.
//
// So a comment here is always something a reader can verify by counting. If a
// note is wrong, the arithmetic is wrong, and that is a bug rather than a
// difference of opinion.

const { getDestination } = require('../destinations');
const { overLimit } = require('./gemini');

// Length in the field's own unit, for the note text. Deliberately the same shape
// as the check: a note that says "71 characters" when the check counted words
// would be worse than no note.
function measure(text, fieldType) {
  const s = String(text || '').trim();
  if (String(fieldType || '') === 'words') {
    const n = s ? s.split(/\s+/).length : 0;
    return { n, unit: n === 1 ? 'word' : 'words' };
  }
  return { n: s.length, unit: s.length === 1 ? 'character' : 'characters' };
}

// The notes for one read-back row, or [] when nothing is measurably wrong.
//
// ONLY is_copy ROWS ARE JUDGED. A metadata cell still reading {{Form ID}} is the
// correct finished state — commenting on it would train the reader to dismiss
// the whole set, which is how a review queue stops being read.
function notesForRow(row) {
  if (!row || !row.is_copy) return [];
  const name = row.marker_name;
  const out = [];

  // 1. Marked as copy, never drafted. The cell looks "unfinished" in the
  //    document in exactly the way a metadata cell looks "finished", and only
  //    the stored is_copy flag tells them apart — so this note carries the one
  //    fact the document cannot show.
  if (row.showingMarker) {
    out.push(`${name} — still showing its {{marker}}. This field is marked as copy, so it was meant to be drafted and was not.`);
    return out; // Nothing to measure; the cell holds a marker, not copy.
  }

  // 2. Empty. Distinct from the above: the marker was consumed but nothing
  //    replaced it, which is the one state that looks like a writer's blank line.
  if (row.empty) {
    out.push(`${name} — empty. The marker is gone but no copy was written, so this cell cannot be told apart from one somebody cleared by hand.`);
    return out;
  }

  // 3. Over its limit, counted in its own unit. overLimit is the drafter's own
  //    check, imported rather than reimplemented — a review that disagreed with
  //    the drafter about what "over" means would be the worse of the two bugs.
  if (overLimit(row.text, row.char_max, row.field_type)) {
    const { n, unit } = measure(row.text, row.field_type);
    out.push(`${name} — over its limit: ${n} ${unit} against a limit of ${row.char_max}.`);
    return out; // Cannot also be under its minimum.
  }

  // 4. UNDER its minimum. Exactly as measurable as being over, and it was
  //    missing: a 50-120 word field coming back at 12 words is a one-line email
  //    where a structured one was specified, and nothing said so.
  //
  //    Only when char_min > 0. A floor of 0 is "no floor", the same sentinel
  //    char_max 0 uses for "no limit", so a field without one is never short.
  //    In practice these are the word fields — lengthClause already treats the
  //    floor as half the point there ("50-125 words says this is a structured
  //    email, where 'up to 125' would read as shorter is safer") — but the check
  //    is written on char_min itself, not on the unit, so a character field that
  //    grows a floor is covered without a second rule.
  const min = Number(row.char_min) > 0 ? Number(row.char_min) : null;
  if (min) {
    const { n, unit } = measure(row.text, row.field_type);
    if (n < min) out.push(`${name} — under its minimum: ${n} ${unit} against a minimum of ${min}.`);
  }

  return out;
}

// Every note for a read-back, in row order. Pure.
function reviewNotes(rows) {
  const out = [];
  for (const r of rows || []) for (const text of notesForRow(r)) out.push({ marker_name: r.marker_name, text });
  return out;
}

// POST the notes as unanchored comments.
//
// Re-running --review must not double the queue, so a note whose exact text is
// already live on the document is skipped. Matching on exact text is crude but
// it is the honest bound: these notes are generated deterministically from the
// cell, so the same fault produces the same sentence, and a CHANGED fault (71
// characters became 78) correctly reads as a new note rather than the same one.
//
// Resolved comments are NOT counted as live — a reader who ticked one off has
// said "handled", and if the fault is still there on the next run they should
// hear about it again.
async function postTemplateReview(docId, rows, clients) {
  const dest = getDestination();
  const notes = reviewNotes(rows);

  let live = [];
  try {
    live = await dest.listReviewComments(docId, clients);
  } catch (err) {
    // A listing failure must not block the review — worst case a note is posted
    // twice, which is visible and harmless. Silently posting nothing is neither.
    console.warn(`[templateReview] could not list existing comments (${err.message}) — posting without dedupe`);
  }
  const already = new Set(live.filter((c) => !c.resolved).map((c) => c.content));

  const posted = [];
  const duplicates = [];
  const failed = [];
  for (const n of notes) {
    if (already.has(n.text)) {
      duplicates.push(n);
      continue;
    }
    const id = await dest.addUnanchoredComment(docId, n.text, clients);
    if (id) posted.push({ ...n, id });
    else failed.push(n);
  }

  console.log(
    `[templateReview] ${docId} — ${notes.length} note(s): ${posted.length} posted, ` +
      `${duplicates.length} already live, ${failed.length} failed`
  );
  return { notes, posted, duplicates, failed };
}

module.exports = { reviewNotes, notesForRow, measure, postTemplateReview };
