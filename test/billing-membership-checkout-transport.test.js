'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), path = require('node:path');
const { createMembershipCheckoutTransport, isMembershipCheckoutTransport } = require('../src/services/membershipCheckoutTransport');
const { RequestSender } = require(path.join(path.dirname(require.resolve('stripe')), 'RequestSender.js'));
for (const code of ['ECONNRESET', 'EPIPE']) test(`installed SDK forced ${code} retry is suppressed by guarded transport`, async () => {
  const original = Object.assign(Error('SYNTHETIC reset'), { code }); let attempts = 0;
  const transport = createMembershipCheckoutTransport({ getClientName: () => 'node', async makeRequest() { attempts++; throw original; } });
  assert.equal(RequestSender._shouldRetry(null, 0, 0, original), true);
  await assert.rejects(transport.makeRequest('SYNTHETIC'), error => {
    assert.equal(error.code, 'MEMBERSHIP_CHECKOUT_TRANSPORT_ABORTED'); assert.equal(RequestSender._shouldRetry(null, 0, 0, error), false);
    assert.equal(error.cause, undefined); return true;
  }); assert.equal(attempts, 1); assert.equal(isMembershipCheckoutTransport(transport), true); assert.equal(Object.isFrozen(transport), true);
});
test('transport passes the same response/arguments and ordinary error without credentials or vendor mutation', async () => {
  const response = { object: 'SYNTHETIC_RESPONSE' }, args = ['localhost', 42, '/synthetic', 'POST', {}, 'body', 'http', 10000];
  const original = Object.assign(Error('SYNTHETIC timeout'), { code: 'ETIMEDOUT' }); let observed;
  const transport = createMembershipCheckoutTransport({ getClientName: () => 'node', async makeRequest(...input) {
    observed = input; if (input.length === 0) throw original; return response;
  } });
  assert.equal(await transport.makeRequest(...args), response); assert.deepEqual(observed, args); assert.equal(transport.getClientName(), 'node');
  await assert.rejects(transport.makeRequest(), error => error === original); assert.equal(RequestSender._shouldRetry(null, 0, 0, original), false);
  assert.equal(isMembershipCheckoutTransport({ ...transport }), false); assert.equal(isMembershipCheckoutTransport(null), false);
});
test('transport configuration requires both actual transport methods', () => {
  for (const transport of [null, {}, { makeRequest() {} }, { getClientName() {} }])
    assert.throws(() => createMembershipCheckoutTransport(transport), { code: 'membership_checkout_transport_not_configured' });
});
