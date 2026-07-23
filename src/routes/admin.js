'use strict';

// Admin area (LiveSpecs admin, Step 1). Everything here is gated by requireAdmin
// (users.is_admin = true; 404 for everyone else). For now this is a single stub
// route that only proves the gate works — no dashboard, tables, or detection
// logic yet. Later LiveSpecs admin features hang off this router.

const express = require('express');
const { requireAdmin } = require('../middleware/requireAdmin');

const router = express.Router();

// GET /admin — minimal proof the gate works. Admins get "admin ok"; everyone
// else is stopped by requireAdmin with a bare 404 before reaching this handler.
router.get('/admin', requireAdmin, (req, res) => {
  res.status(200).type('text').send('admin ok');
});

module.exports = router;
