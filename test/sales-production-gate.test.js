'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  requireSalesProductionMutation,
  requireSalesProductionWrites,
  salesProductionWritesEnabled,
} = require('../src/lib/salesProductionGate');

function invoke(middleware, method = 'POST') {
  const result = { nextCalled: false, status: null, body: null };
  const res = {
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return this; },
  };
  middleware({ method }, res, () => { result.nextCalled = true; });
  return result;
}

test('sales side effects are disabled for missing, false, and ambiguous flags', () => {
  for (const env of [{}, { SALES_PRODUCTION_WRITES_ENABLED: 'false' }, { SALES_PRODUCTION_WRITES_ENABLED: 'TRUE' }, { SALES_PRODUCTION_WRITES_ENABLED: '1' }]) {
    assert.equal(salesProductionWritesEnabled(env), false);
    assert.deepEqual(invoke(requireSalesProductionWrites(env)), {
      nextCalled: false,
      status: 503,
      body: { error: 'sales_promotion_disabled' },
    });
  }
});

test('the exact reviewed true flag is required to pass a sales write', () => {
  const env = { SALES_PRODUCTION_WRITES_ENABLED: 'true' };
  assert.equal(salesProductionWritesEnabled(env), true);
  assert.deepEqual(invoke(requireSalesProductionWrites(env)), {
    nextCalled: true,
    status: null,
    body: null,
  });
});

test('read-only sales requests may pass while mutation methods are blocked', () => {
  const gate = requireSalesProductionMutation({ SALES_PRODUCTION_WRITES_ENABLED: 'false' });
  for (const method of ['GET', 'HEAD', 'OPTIONS']) assert.equal(invoke(gate, method).nextCalled, true);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(invoke(gate, method).status, 503);
  }
});
