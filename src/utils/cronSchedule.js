'use strict';

// The detector's weekly schedule, and whether the last slot in it actually ran.
//
// ONE CRON FORM ONLY: "minute hour * * weekday" — what railway.cron.json uses.
// Anything else parses to null and the admin page shows the raw expression. A
// next-run time out of a parser that half-understands cron would be a confident
// wrong answer on the one panel meant to be believed at a glance.
//
// UTC throughout, because Railway evaluates cron in UTC. Date arithmetic goes
// through setUTCDate, so there is no daylight-saving edge to fall off.
//
// WHERE THE SCHEDULE COMES FROM, and why that is allowed to be read by the web
// service. CLAUDE.md's rule is that a health signal about a scheduled job must be
// emitted BY that job, not by a sibling that shares its code and not its
// environment — which is why the agentic reader's on/off state is recorded by the
// run, never computed by the page. The schedule is a sibling's claim too: the web
// service reads a config file describing a different service. So it is never
// shown on its own. assessSlot checks it against runs THE JOB RECORDED, and a
// declared slot with no recorded run reads as `missed` rather than being taken
// on trust.

const fs = require('fs');
const path = require('path');

const CRON_FILE = path.join(__dirname, '..', '..', 'railway.cron.json');

function parseWeekly(expr) {
  const m = String(expr || '').trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\d)$/);
  if (!m) return null;
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  const dow = Number(m[3]);
  // 7 is Sunday in some cron dialects and invalid in others. Refused, not guessed.
  if (minute > 59 || hour > 23 || dow > 6) return null;
  return { minute, hour, dow };
}

// The most recent slot at or before `from`.
function lastSlotAtOrBefore(expr, from = new Date()) {
  const s = parseWeekly(expr);
  if (!s) return null;
  const d = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), s.hour, s.minute, 0, 0)
  );
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - s.dow + 7) % 7));
  if (d > from) d.setUTCDate(d.getUTCDate() - 7);
  return d;
}

// The first slot strictly after `from`.
function nextSlotAfter(expr, from = new Date()) {
  const last = lastSlotAtOrBefore(expr, from);
  if (!last) return null;
  const next = new Date(last.getTime());
  next.setUTCDate(next.getUTCDate() + 7);
  return next;
}

// A scheduled run may start a little early by clock skew and late by queueing.
// The late side is generous on purpose: Railway has been seen starting this
// cron a couple of minutes after the slot, and a false `missed` is noise that
// teaches the reader to ignore the badge.
const SLOT_EARLY_MS = 5 * 60 * 1000;
const SLOT_LATE_MS = 60 * 60 * 1000;

// Did the declared slot produce a run the job itself recorded?
//
//   ran           a run marked `scheduled` started inside the window
//   ran_unmarked  a `script` (or `unknown`) run did — probably the cron, but it
//                 did not declare itself, so the start command is likely missing
//                 --scheduled. Distinct on purpose: folding it into `ran` would
//                 hide exactly that misconfiguration.
//   pending       the window has not closed yet
//   missed        the window closed and nothing ran in it
//   unknown       cannot assess — no parseable schedule, or the run log did not
//                 exist yet at that slot. NEVER reported as ran or missed: a
//                 check that could not be evaluated must not read as one that
//                 passed, or as one that failed.
//
// `runsInWindow` is every recorded run whose started_at falls in the window;
// `logStartedAt` is the earliest started_at in the whole log (null if empty).
function assessSlot({ slot, runsInWindow, logStartedAt, now = new Date() }) {
  if (!slot) return { state: 'unknown', reason: 'the schedule could not be parsed' };
  const slotMs = slot.getTime();
  const runs = Array.isArray(runsInWindow) ? runsInWindow : [];
  const pick = (want) =>
    runs.find((r) => want.includes(r.trigger)) || null;

  const scheduled = pick(['scheduled']);
  if (scheduled) return { state: 'ran', run: scheduled };
  const unmarked = pick(['script', 'unknown']);
  if (unmarked) return { state: 'ran_unmarked', run: unmarked };

  if (now.getTime() < slotMs + SLOT_LATE_MS) return { state: 'pending' };
  if (!logStartedAt || new Date(logStartedAt).getTime() > slotMs + SLOT_LATE_MS) {
    return { state: 'unknown', reason: 'the run log did not exist yet at that slot' };
  }
  return { state: 'missed' };
}

// The schedule the repo declares for the detector service, or null.
function readDetectorCron() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CRON_FILE, 'utf8'));
    const expr = cfg && cfg.deploy && cfg.deploy.cronSchedule;
    return typeof expr === 'string' && expr.trim() ? expr.trim() : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  parseWeekly,
  lastSlotAtOrBefore,
  nextSlotAfter,
  assessSlot,
  readDetectorCron,
  SLOT_EARLY_MS,
  SLOT_LATE_MS,
};
