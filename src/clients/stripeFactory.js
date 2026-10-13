'use strict';
const { isGuardedPricingDev, hold } = require('../config/guardedPricingDev');

// Bind the vendor at the consumer's import boundary, as the original imports
// did. This preserves dependency injection and avoids retaining a stale SDK.
module.exports = function stripeFactory() {
  const Stripe = require('stripe');
  function GuardedStripe(...args) {
    const sdk = new Stripe(...args);
    if (!isGuardedPricingDev()) return sdk;
    // Sole exception: local HMAC/signature validation, never provider I/O.
    const webhooks = new Proxy({}, { get(_target, key) {
      if (key === 'constructEvent') return sdk.webhooks.constructEvent.bind(sdk.webhooks);
      throw hold();
    } });
    return new Proxy({}, { get(_target, key) {
      if (key === 'webhooks') return webhooks;
      throw hold();
    } });
  }
  Object.setPrototypeOf(GuardedStripe, Stripe);
  GuardedStripe.prototype = Stripe.prototype;
  return GuardedStripe;
};
