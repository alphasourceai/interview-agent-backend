// routes/authPing.js
const express = require('express');
const router = express.Router();

// import from the actual files in src/middleware
const { requireAuth } = require('../src/middleware/requireAuth');
const { withClientScope } = require('../src/middleware/withClientScope');

router.get('/ping', requireAuth, withClientScope, (req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    user: req.user || null,
    client: req.client || null,
    scope: req.clientScope || null,
  });
});

module.exports = router;

