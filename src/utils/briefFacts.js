'use strict';

// DOES THE BRIEF STATE A FACT THIS CAMPAIGN CANNOT INVENT?
//
// One class today: `datetime` — a date, a clock time, or a venue. Named so the
// enumeration can arrive later or never; nothing here assumes seven more.
//
// WHY THIS EXISTS. Event Reminder Email had nowhere to put the time, and drafts
// invented arrival times that disagreed with each other by 24 hours. Giving it a
// `Date / Location Line` fixed the case where the brief SUPPLIES the time (0 of
// 30 invented, 21 of 30 transcribed — the model does not override an available
// fact, it transcribes it) and made the SILENT case worse (15 of 35 invented,
// against 9 of 35 with no such field, with the field itself fabricating 5 of 5
// including a timezone nobody mentioned).
//
// An empty transcription slot is a blank the model will always fill. So the
// field is correct in the presence of the fact and needs a per-campaign signal
// in its absence — and the signal has to reach the FIELD, because a line above
// six generative fields will not stop a field whose entire purpose is to carry
// a time from carrying one.
//
// ONE DEFINITION, SHARED. `scripts/eventTimeAB.js` measures the output with the
// same patterns this reads the brief with. Two copies would let the measurement
// and the behaviour drift apart silently, which is the failure
// FUNNEL_STAGE_INFERENCE exists to prevent.
//
// A FLOOR, NOT A CENSUS, and the gaps are named so a `false` is not read as
// certainty. It misses spelled clock times ("half past noon"), loose ranges
// ("later this week"), and a venue named without any of the words below. The
// consequence of a miss is the SAFE direction: we say the brief is silent when
// it was not, the note appears beside a field the writer can see, and they
// delete it. The opposite error — declaring a date present when it is not —
// needs a positive match, which is why every pattern here is specific.

// Temporal expressions. Shared with scripts/eventTimeAB.js, which runs them over
// the OUTPUT to catch invention; here they run over the BRIEF to decide whether
// invention is even possible.
const TEMPORAL = [
  [/\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/i, 'weekday'],
  [/\b(?:jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i, 'month + day'],
  [/\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i, 'day + month'],
  [/\b\d{1,2}\s*(?::\s*\d{2})?\s*(?:am|pm)\b/i, 'clock time'],
  [/\b\d{1,2}:\d{2}\b/, 'clock time'],
  [/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/, 'numeric date'],
  [/\b\d{4}-\d{2}-\d{2}\b/, 'ISO date'],
  [/\b(?:noon|midnight)\b/i, 'clock time'],
  [/\b(?:today|tomorrow|tonight)\b/i, 'relative day'],
];

// Venue/location. Deliberately narrow: a brief naming a city in passing ("teams
// in Denver") is not a venue, so this wants an explicit locative or a
// venue-shaped noun rather than any capitalised place name.
const LOCATION = [
  // THE VENUE NOUN IS CASE-FLEXIBLE, and it was a bug that it was not. This
  // pattern carries no /i flag — [A-Z] is doing real work, requiring a proper
  // noun — so a lowercase-only alternation never matched "Moscone Center", which
  // is how a venue is actually written. It matched "moscone center" and nothing
  // a real brief contains.
  //
  // Diagnosed wrong the first time, recorded because the wrong diagnosis is the
  // instructive part: this looked like greedy capture eating the venue noun, and
  // it was simply case. Backtracking handles the greed fine.
  [/\b(?:at|in)\s+(?:the\s+)?[A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*?\s+(?:[Cc]entre|[Cc]enter|[Hh]all|[Hh]otel|[Tt]heatre|[Tt]heater|[Aa]rena|[Ss]tadium|[Cc]ampus|[Rr]oom|[Ss]uite|[Bb]allroom|[Pp]avilion)\b/, 'named venue'],
  [/\b(?:venue|location|address)\s*[:—-]/i, 'labelled venue'],
  [/\b(?:room|hall|suite|booth|stand)\s+\w+/i, 'room or booth'],
  [/\b(?:zoom|webex|google meet|microsoft teams|livestream|virtual|online)\b/i, 'virtual venue'],
];

// What the brief supplies, as { datetime, location, matches }. `matches` carries
// what fired, so a caller can log WHY rather than only what — a silent boolean is
// how a detector like this stops being trusted.
function briefFacts(brief) {
  const text = String(brief == null ? '' : brief);
  const matches = [];
  let datetime = false;
  let location = false;

  for (const [re, kind] of TEMPORAL) {
    const m = text.match(re);
    if (m) { datetime = true; matches.push({ kind, text: m[0] }); }
  }
  for (const [re, kind] of LOCATION) {
    const m = text.match(re);
    if (m) { location = true; matches.push({ kind, text: m[0].trim() }); }
  }
  return { datetime, location, matches };
}

// Does the brief supply a DATE OR TIME? Nothing else.
//
// THIS USED TO BE `f.datetime || f.location`, AND THE OR WAS A HOLE. The
// reasoning was that the field is "Date / Location Line", so a brief giving only
// the venue still has something for it. That is true about the FIELD and false
// about the FAILURE: a venue does not stop the model inventing a time. Measured —
//
//   brief: "Reminder. Join us on Zoom."   ->  OR said true
//                                         ->  no note attached
//                                         ->  the field is empty and fabricates
//
// which is exactly the case the note exists for, suppressed by the note's own
// trigger. Webinar briefs naming a platform and no time are common, so it was
// reachable rather than theoretical.
//
// The wording moved with it — MISSING_DATETIME_NOTE no longer says "or venue",
// because on this trigger a venue-only brief now GETS the note and claiming the
// venue is missing would be false. Trigger and sentence have to agree, and one
// fewer clause is one fewer place for them to drift.
function briefStatesDateTime(brief) {
  return briefFacts(brief).datetime;
}

// The location half, exported for the work that will need it. NOT wired to
// anything: `fact_kind = 'location'` fields are deliberately out of scope until
// the patterns above are strong enough — they miss "at Moscone West" and
// "at the Hilton", which is the common shape of a venue. See ROADMAP.md.
function briefStatesLocation(brief) {
  return briefFacts(brief).location;
}

// THE NOTE, AND IT IS ONE SENTENCE FOR TWO READERS ON PURPOSE.
//
// The writer and the drafter read the SAME string — it renders as the field's
// italic line in the doc and reaches both draft prompts as that field's
// `Field guidance:`. Two clauses aimed at different audiences is precisely how
// "…and only as that source's claim" became an instruction to attribute a source
// in customer-facing copy.
//
// So it states a FACT ABOUT THE WORLD and instructs neither party:
//   • the writer reads "the brief didn't give me this, so it is mine to fill";
//   • the drafter reads "the value is not available", and has nothing to write.
// "Add it here" was rejected for the obvious reason — read as copy direction it
// says add one, which is the invention.
//
// NOT AN ERROR. A brief that has not fixed the time yet is ordinary, and a
// reminder drafted before the time is confirmed is an ordinary thing to do. The
// wording carries no fault.
//
// NO EXAMPLE OF A WELL-FORMED DATE, deliberately. Four false claims in this
// system trace to fact-shaped example strings in craft.md; "e.g. Thursday August
// 24 at 12 PM PT" here would be the fifth, in a new place, in a note attached to
// the one field whose whole job is to carry a real date.
const MISSING_DATETIME_NOTE =
  'The brief does not state a date or time — this line waits for them.';

module.exports = {
  briefFacts,
  briefStatesDateTime,
  briefStatesLocation,
  MISSING_DATETIME_NOTE,
  TEMPORAL,
  LOCATION,
};
