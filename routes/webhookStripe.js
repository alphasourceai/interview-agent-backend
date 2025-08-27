const express = require('express');
module.exports = function webhookStripeRouter() {
  const router = express.Router();
  router.post('/', (_req, res) => res.status(200).send('ok'));
  return router;
};
