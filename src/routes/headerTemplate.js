'use strict';

// Doc-header template onboarding API (doc-header-template work, step 6a).
//
// Backend for the "show Quillio an example of your doc header" onboarding flow
// (PHASE4_BUILD_PLAN_EXTENSIONS.md §2). Three endpoints, all reusing Steps 2–5:
//   POST /api/header/extract  — multipart screenshot -> extracted block schema
//                               (Gemini vision + normalize). Does NOT save.
//   GET  /api/header          — the tenant's currently stored header schema (or null)
//   POST /api/header          — validate + save an (edited) schema as the tenant standard
//
// The live preview + editable field list are rendered client-side from the
// schema (step 6b) — no server round-trip — so there is no preview endpoint.

const express = require('express');
const multer = require('multer');

const { requireAuth } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimit');
const { extractHeaderSchema } = require('../services/gemini');
const {
  normalizeHeaderSchema,
  isValidHeaderSchema,
} = require('../destinations/docHeaderSchema');
const { getHeaderSchema, saveHeaderSchema } = require('../db');

const DEFAULT_WORKSPACE_ID = 'T0B8LPRDKHR';

// The screenshot is read into memory (we only need its bytes as base64 for
// Gemini) — no temp file. Single image, 10MB cap, JPEG/PNG/WebP only.
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const screenshotMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    cb(null, IMAGE_MIME.has(file.mimetype) || /\.(jpe?g|png|webp)$/i.test(file.originalname));
  },
}).single('screenshot');

const router = express.Router();

function tenantOf(req) {
  return (req.user && req.user.tenant_id) || DEFAULT_WORKSPACE_ID;
}

// POST /api/header/extract — screenshot -> extracted schema (not saved).
router.post('/api/header/extract', uploadLimiter, requireAuth, (req, res) => {
  screenshotMw(req, res, async (err) => {
    if (err) return res.status(400).json({ success: false, error: err.message });
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ success: false, error: 'No screenshot uploaded (field "screenshot").' });
    }
    try {
      const base64 = req.file.buffer.toString('base64');
      const raw = await extractHeaderSchema(base64, req.file.mimetype || 'image/png');
      if (!raw) {
        return res
          .status(502)
          .json({ success: false, error: 'Could not read a header from that image. Try a clearer screenshot.' });
      }
      const schema = normalizeHeaderSchema(raw);
      if (!isValidHeaderSchema(schema)) {
        return res
          .status(422)
          .json({ success: false, error: 'No header structure found in that image.' });
      }
      console.log(`[web] /api/header/extract → ${schema.blocks.length} block(s)`);
      return res.status(200).json({ success: true, schema });
    } catch (e) {
      console.error('[web] /api/header/extract failed:', e.message);
      return res.status(500).json({ success: false, error: 'Extraction failed.' });
    }
  });
});

// GET /api/header — the tenant's stored header schema, or null.
router.get('/api/header', requireAuth, async (req, res) => {
  try {
    const schema = await getHeaderSchema(tenantOf(req));
    return res.status(200).json({ success: true, schema: schema || null });
  } catch (e) {
    console.error('[web] GET /api/header failed:', e.message);
    return res.status(500).json({ success: false, error: 'Could not load header.' });
  }
});

// POST /api/header — validate + save the (edited) schema as the tenant standard.
// Body: { schema }. The schema is normalized defensively before saving so the
// client can never persist a malformed shape.
router.post('/api/header', requireAuth, express.json({ limit: '256kb' }), async (req, res) => {
  const incoming = req.body && req.body.schema;
  const schema = normalizeHeaderSchema(incoming);
  if (!isValidHeaderSchema(schema)) {
    return res.status(400).json({ success: false, error: 'Header has no usable blocks.' });
  }
  try {
    const ok = await saveHeaderSchema(tenantOf(req), schema, 'Default');
    if (!ok) return res.status(503).json({ success: false, error: 'No database configured — cannot save.' });
    console.log(`[web] POST /api/header → saved ${schema.blocks.length} block(s)`);
    return res.status(200).json({ success: true, schema });
  } catch (e) {
    console.error('[web] POST /api/header failed:', e.message);
    return res.status(500).json({ success: false, error: 'Could not save header.' });
  }
});

module.exports = router;
