'use strict';
// Dedicated read-only port. No shared Checkout SDK mutation or default key.
const { createMembershipCheckoutTransport } = require('./membershipCheckoutTransport');
const guarded = new WeakSet();
const pathAllowed = p => /^\/v1\/(account|balance)$/.test(p)
  || /^\/v1\/checkout\/sessions\/cs_(test|live)_[A-Za-z0-9_]+(?:\/line_items)?$/.test(p)
  || /^\/v1\/payment_intents\/pi_[A-Za-z0-9_]+$/.test(p)
  || /^\/v1\/charges\/ch_[A-Za-z0-9_]+$/.test(p)
  || /^\/v1\/invoices\/in_[A-Za-z0-9_]+(?:\/lines)?$/.test(p);
function createMembershipFinancialFactsTransport(transport, { host = 'api.stripe.com', port = 443, protocol = 'https' } = {}) {
  if (!(host === 'api.stripe.com' && port === 443 && protocol === 'https')
    && !(host === '127.0.0.1' && Number.isSafeInteger(port) && port > 0 && port <= 65535 && protocol === 'http')) {
    throw new Error('membership_financial_transport_endpoint_denied');
  }
  const normalized = createMembershipCheckoutTransport(transport);
  const client = Object.freeze({ getClientName: () => normalized.getClientName(), async makeRequest(...args) {
    const [actualHost, actualPort, path, method, headers, body, actualProtocol] = args;
    const pathname = typeof path === 'string' ? path.split('?')[0] : '';
    const query = new URLSearchParams(typeof path === 'string' ? path.split('?').slice(1).join('?') : '');
    const entries = [...query.entries()], isList = /\/(line_items|lines)$/.test(pathname);
    const allowedQuery = isList ? entries.length === 2 && query.get('limit') === '100'
      && query.get('expand[0]') === 'data.price.product' : entries.length === 0;
    if (actualHost !== host || Number(actualPort) !== port || actualProtocol !== protocol
      || method !== 'GET' || !pathAllowed(pathname) || !allowedQuery || (body !== '' && body != null)
      || Object.keys(headers || {}).some(k => k.toLowerCase() === 'stripe-account')) {
      const e = new Error('membership_financial_transport_denied'); e.code = e.message; throw e;
    }
    return normalized.makeRequest(...args);
  } });
  guarded.add(client); return client;
}
module.exports = { createMembershipFinancialFactsTransport, isMembershipFinancialFactsTransport: c => guarded.has(c) };
