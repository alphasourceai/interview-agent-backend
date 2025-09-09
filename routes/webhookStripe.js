// routes/webhookStripe.js
const express = require('express');
const router = express.Router();

// Stripe webhook endpoint (placeholder).
// Extend later with signature verification, event handling, etc.
router.post('/', (_req, res) => {
  res.status(200).send('ok');
});

module.exports = router;
