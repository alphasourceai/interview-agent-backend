// routes/authPing.js
const express = require('express');
const router = express.Router();

const { requireAuth, withClientScope } = require('../src/middleware/auth');

// Simple health
router.get('/ping', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// What the FE expects
router.get('/me', requireAuth, withClientScope, (req, res) => {
  res.json({
    ok: true,
    user: req.user || null,
    client: req.client || null,
    scope: req.clientScope || null,
  });
});

module.exports = router;
