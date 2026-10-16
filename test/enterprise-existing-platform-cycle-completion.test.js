'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const dbPath = require.resolve('../src/clients/supabase');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { supabaseAdmin: { from() { throw Error('default DB forbidden'); } } } };
const fixture = require('./helpers/enterprise-platform-cycle-fixture');
const { completeExistingEnterprisePlatformPeriod: complete } = require('../src/services/existingEnterprisePaymentCompletion');
const code = { code: 'enterprise_platform_period_ack_unknown', status: 503 };
for (const cadence of ['monthly', 'annual']) test(`cycle completion composes real GET reader and native ${cadence} receipts, not initial activation`, async t => {
  const f = await fixture(t, { cadence }), before = structuredClone(f.native.db.tables), r = await complete(f.args);
  assert.equal(r.status, 'recorded'); assert.equal(r.coverage.contiguous_ordinal, 1); assert.ok(Object.isFrozen(r.receipt.proof));
  assert.equal(f.persisted, 1); assert.equal(f.refreshes, 1); assert.equal(f.calls.length, 12);
  assert.deepEqual(f.rpcCalls.map(x => x.name), ['read_enterprise_existing_billing', 'read_enterprise_existing_billing',
    'read_enterprise_existing_billing', 'record_enterprise_existing_paid_period', 'refresh_enterprise_existing_paid_coverage']);
  for (const [table, rows] of Object.entries(before)) if (table !== 'billing_invoices') assert.deepEqual(f.native.db.tables[table], rows);
  const again = await complete(f.args); assert.equal(again.status, 'already_recorded'); assert.equal(f.persisted, 1); assert.equal(f.refreshes, 2);
  assert.deepEqual(again.receipt, r.receipt);
});
for (const options of [{ manual: true }, { ordinal: 2, prefix: 0 }, { ordinal: 3, prefix: 1 }]) test(`cycle coverage honors native gaps/override ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t, options), r = await complete(f.args);
  assert.equal(r.coverage.contiguous_ordinal, options.prefix ?? 1);
  assert.equal(r.coverage.status, options.manual ? 'manual_override' : 'refreshed');
});
test('unverified provider cash never reaches period writer', async t => {
  const f = await fixture(t); f.x.charge.amount_captured--; await assert.rejects(complete(f.args), code);
  assert.equal(f.persisted, 0); assert.equal(f.refreshes, 0);
});
test('extra clock or event proof arguments are refused by real reader', async t => {
  const f = await fixture(t); await assert.rejects(complete({ ...f.args, now: () => 0 }), code); assert.equal(f.rpcCalls.length, 0);
});
test('source changes between GET reader and native writer are refused', async t => {
  const f = await fixture(t); let count = 0;
  f.afterRpc = (name, r) => { if (name === 'read_enterprise_existing_billing' && ++count === 3) r.data.client_initial.auto_renew = false; };
  await assert.rejects(complete(f.args), code); assert.equal(f.persisted, 0);
});
for (const [name, change] of [
  ['lost writer ack', r => { r.data = null; }], ['writer error', r => { r.error = { message: 'unknown' }; }],
  ['unknown status', r => { r.data.status = 'ok'; }], ['malformed id', r => { r.data.invoice_id = 'foreign'; }],
  ['extra ack authority', r => { r.data.paid = true; }], ['source', r => { r.data.receipt.source.plan_initial.platform_fee++; }],
  ['proof', r => { r.data.receipt.proof.cash_cents--; }], ['digest', r => { r.data.receipt.source_digest = 'foreign'; }],
  ['old stamp', r => { r.data.receipt.recorded_at = '2020-01-01T00:00:00.000000Z'; }],
  ['future stamp', r => { r.data.receipt.recorded_at = '2090-01-01T00:00:00.000000Z'; }]
]) test(`cycle completion holds ${name} without claiming rollback`, async t => {
  const f = await fixture(t); f.afterRpc = (rpc, r) => { if (rpc === 'record_enterprise_existing_paid_period') change(r); };
  await assert.rejects(complete(f.args), code); assert.equal(f.persisted, 1);
  f.afterRpc = null; const recovered = await complete(f.args); assert.equal(recovered.status, 'already_recorded'); assert.equal(f.persisted, 1);
});
for (const field of ['billing_customer_id', 'stripe_invoice_id', 'currency', 'amount_total_cents', 'enterprise_period_receipt', 'retail_period_receipt']) test(`cycle readback holds changed invoice ${field}`, async t => {
  const f = await fixture(t);
  f.afterRpc = rpc => { if (rpc === 'record_enterprise_existing_paid_period') f.native.db.tables.billing_invoices[0][field] = 'foreign'; };
  await assert.rejects(complete(f.args), code); assert.equal(f.refreshes, 0);
});
for (const [name, change] of [
  ['lost coverage ack', r => { r.data = null; }], ['coverage error', r => { r.error = { message: 'unknown' }; }],
  ['owner', r => { r.data.client_id = '00000000-0000-4000-8000-000000000099'; }],
  ['agreement', r => { r.data.agreement_id = '00000000-0000-4000-8000-000000000099'; }],
  ['digest', r => { r.data.billing_source_digest = 'f'.repeat(32); }], ['ordinal', r => { r.data.contiguous_ordinal = -1; }],
  ['funded from', r => { r.data.funded_from = '2020-01-01T00:00:00.000000Z'; }],
  ['funded through', r => { r.data.funded_through = '2090-01-01T00:00:00.000000Z'; }],
  ['old observation', r => { r.data.observed_at = '2020-01-01T00:00:00.000000Z'; }],
  ['authority', r => { r.data.paid_access_authorized = true; }], ['status', r => { r.data.status = 'ok'; }]
]) test(`cycle completion holds native ${name}`, async t => {
  const f = await fixture(t); f.afterRpc = (rpc, r) => { if (rpc === 'refresh_enterprise_existing_paid_coverage') change(r); };
  await assert.rejects(complete(f.args), code); assert.equal(f.persisted, 1);
  f.afterRpc = null; assert.equal((await complete(f.args)).status, 'already_recorded'); assert.equal(f.persisted, 1);
});
test('native throw after durable receipt permits exact same-invoice recovery, no second collection', async t => {
  const f = await fixture(t); f.beforeRpc = rpc => { if (rpc === 'refresh_enterprise_existing_paid_coverage') throw Error('transport lost'); };
  await assert.rejects(complete(f.args), code); assert.equal(f.persisted, 1); f.beforeRpc = null;
  assert.equal((await complete(f.args)).status, 'already_recorded'); assert.equal(f.persisted, 1);
});
