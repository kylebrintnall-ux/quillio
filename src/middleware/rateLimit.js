'use strict';

// Basic per-IP rate limiting for the most abusable endpoints (Gemini cost, disk
// writes, OAuth). In-memory store — fine for a single instance; a multi-instance
// deploy would swap in a shared store. The app sets `trust proxy`, so req.ip is
// the real client behind Railway's edge proxy rather than the proxy itself.

const rateLimit = require('express-rate-limit');

const HOUR_MS = 60 * 60 * 1000;

// A 1-hour, per-IP limiter that returns a clean JSON 429 (never plaintext / a
// stack trace).
function perHour(limit) {
  return rateLimit({
    windowMs: HOUR_MS,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests — please try again later.' },
  });
}

module.exports = {
  briefLimiter: perHour(20),
  draftLimiter: perHour(30),
  uploadLimiter: perHour(20),
  voiceLimiter: perHour(10),
  oauthLimiter: perHour(20),
  // Slack surfaces (/slack/command, /slack/review, /slack/interactions).
  // Deliberately far more generous than the user-facing limiters above: real
  // Slack traffic arrives from a shared pool of Slack egress IPs, so a single
  // req.ip fronts every workspace's slash commands AND every button click, and
  // Slack re-delivers a request it considers failed (up to 3 retries) — a tight
  // limit would turn one slow response into a self-inflicted outage. 600/hr/IP
  // is ~10 requests/minute sustained, orders of magnitude above realistic
  // command + interaction volume, while still capping an unauthenticated flood
  // before it reaches HMAC verification.
  slackLimiter: perHour(600),
};
