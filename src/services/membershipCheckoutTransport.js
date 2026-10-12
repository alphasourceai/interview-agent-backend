'use strict';

// stripe-node16.12 forcibly retries ECONNRESET/EPIPE once even with maxRetries0.
// Normalize only those transport failures so its ordinary zero-retry branch
// holds the permanently dispatched operation instead. No SDK patch/key read.
const guarded = new WeakSet();
function createMembershipCheckoutTransport(transport) {
  if (typeof transport?.makeRequest !== 'function' || typeof transport.getClientName !== 'function') {
    const error = new Error('membership_checkout_transport_not_configured');
    error.code = error.message; throw error;
  }
  const client = Object.freeze({
    getClientName: () => transport.getClientName(),
    async makeRequest(...args) {
      try { return await transport.makeRequest(...args); }
      catch (error) {
        if (['ECONNRESET', 'EPIPE'].includes(error?.code)) {
          const held = new Error('membership_checkout_transport_aborted');
          held.code = 'MEMBERSHIP_CHECKOUT_TRANSPORT_ABORTED'; throw held;
        }
        throw error;
      }
    }
  });
  guarded.add(client); return client;
}
const isMembershipCheckoutTransport = client => guarded.has(client);
module.exports = { createMembershipCheckoutTransport, isMembershipCheckoutTransport };
