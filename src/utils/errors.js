'use strict';

// Map an internal error to a safe, generic client-facing message. The real error
// is always logged server-side by the caller; this only controls what the
// browser sees, so DB internals (SQLSTATE, constraint/table names) and Google
// API detail never leak. Specific user-facing validation messages (e.g.
// "briefText is required") are returned directly by the routes and never pass
// through here.
function clientErrorMessage(err) {
  if (!err) return 'Something went wrong';

  // Postgres (pg) errors carry a 5-char SQLSTATE `code` plus driver-only fields.
  if (
    (typeof err.code === 'string' && /^[0-9A-Za-z]{5}$/.test(err.code)) ||
    err.severity ||
    err.routine ||
    err.schema ||
    err.table
  ) {
    return 'A database error occurred';
  }

  // Google API errors (googleapis / gaxios).
  const name = String(err.name || '');
  const msg = String(err.message || '');
  if (
    name === 'GaxiosError' ||
    err.config ||
    err.response ||
    /googleapis|gaxios|\bgoogle\b|docs\.google|drive\.google|storageQuota|insufficientPermissions|invalid_grant/i.test(
      msg
    )
  ) {
    return 'A Google API error occurred';
  }

  return 'Something went wrong';
}

module.exports = { clientErrorMessage };
