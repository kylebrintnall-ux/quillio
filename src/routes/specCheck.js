'use strict';

// SPEC CHECK — POST /api/spec-check { question } -> the answer.
//
// ITS OWN ROUTER, NOT A GROWTH OF routes/app.js, on the precedent
// routes/notifications.js set. app.js is the brief/draft/review lifecycle and
// its job store; this is one read-only lookup that shares none of that.
//
// ─── SYNCHRONOUS, DELIBERATELY ──────────────────────────────────────────────
//
// No job, no poller. The in-memory job store in routes/app.js exists because a
// brief runs 30-90s and a draft ~60s — past the point where Railway's edge proxy
// closes a connection holding no response bytes. This is ONE Gemini call at
// temperature 0.1 over a ~1,100-token vocabulary, answering in a couple of
// seconds. Wrapping that in a job would buy a second round trip, a polling loop,
// and the job store's own 404-after-restart failure mode, in exchange for
// nothing.
//
// If the model is slow, callGemini already aborts at its own timeout and the
// error lands in the catch below as a readable sentence.
//
// ─── SCOPE IS ENFORCED BY THE SHAPE, NOT BY THE PROMPT ──────────────────────
//
// Every string in this response is either read out of copy_fields or a fixed
// literal in services/specLookup.js. There is NO key a model's prose can travel
// in. So the narrow-scope requirement does not rest on the out_of_scope
// classification holding: a model that decides to write a headline instead of
// routing a question has nowhere to put it. The classification is what makes the
// refusal read well; the shape is what makes it true.

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { specCheckLimiter } = require('../middleware/rateLimit');
const { clientErrorMessage } = require('../utils/errors');
const { answerSpecQuestion } = require('../services/specLookup');

const router = express.Router();

// The longest question worth sending. A lookup question is a sentence; anything
// past this is a brief pasted into the wrong box, and truncating it silently
// would send a fragment to the model and answer a question nobody asked.
const MAX_QUESTION_CHARS = 300;

router.post('/api/spec-check', specCheckLimiter, requireAuth, async (req, res) => {
  const body = req.body || {};
  const question = String(body.question == null ? '' : body.question).trim();
  const tenantId = (req.user && req.user.tenant_id) || null;

  if (!question) {
    return res.status(400).json({ success: false, error: 'A question is required.' });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return res.status(400).json({
      success: false,
      error: `That's longer than a spec question — keep it under ${MAX_QUESTION_CHARS} characters.`,
    });
  }

  try {
    const answer = await answerSpecQuestion({ tenantId, question });
    // Log the SHAPE of the outcome, never the question — a brief pasted in here
    // is a client's campaign, and this route's log is not the place for it.
    console.log(
      `[spec-check] tenant=${tenantId} status=${answer.status} results=${(answer.results || []).length}`
    );
    return res.status(200).json({ success: true, ...answer });
  } catch (err) {
    // A THROW HERE IS A TRANSPORT FAILURE, NOT AN UNANSWERABLE QUESTION.
    // answerSpecQuestion returns a miss for anything it cannot resolve, so
    // reaching this catch means the model or the database could not be reached —
    // which is the one case that genuinely is an error rather than an answer.
    console.error('[spec-check] failed:', err && err.stack ? err.stack : err);
    return res.status(500).json({ success: false, error: clientErrorMessage(err) });
  }
});

module.exports = router;
