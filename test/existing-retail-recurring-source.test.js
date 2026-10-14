'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { fixture, PAID } = require('./fixtures/existing-retail-funding-fixture');
const { readExistingRetailRecurringSource: read } = require('../src/services/existingRetailRecurringSource');
function setup(plan = 'basic', months = 3, payment = 'prepaid', role = false, admin = false) {
  const f = fixture(plan, months, payment, role, { admin }), p = f.inv.lines.data[0];
  const source = { version: 'retail_existing_recurring_source_v1', agreement_id: f.g.id, client_id: f.c.id,
    source_intent_id: admin ? null : f.i.id, package_snapshot: structuredClone(f.pkg), original_provider_account_id: 'acct_SYNTHETIC',
    original_period: { version: 'retail_initial_provider_period_v1', api_version: '2023-10-16', invoice_id: f.inv.id,
      platform_invoice_line_id: p.id, price_id: p.price.id, subscription_id: f.s.id, subscription_item_id: p.subscription_item,
      customer_id: f.c.stripe_customer_id, checkout_session_id: f.cs.id, livemode: false, paid_at: PAID,
      provider_period_start: p.period.start, provider_period_end: p.period.end },
    effect_authorized: false, collection_ready: false, paid_access_authorized: false, payroll_authorized: false };
  const calls = [], db = { async rpc(name, args) { calls.push({ name, args }); return { data: structuredClone(source), error: null }; } };
  return { source, calls, db, options: { db, agreementId: f.g.id, clientId: f.c.id } };
}
for (const plan of ['basic', 'pro']) for (const months of [3, 6, 12])
for (const payment of ['prepaid', 'monthly_installments']) for (const role of [false, true])
test(`native observation adapter ${plan}/${months}/${payment}/role:${role}`, async () => {
  const f = setup(plan, months, payment, role), before = structuredClone(f.source), result = await read(f.options);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), before); assert.deepEqual(f.source, before);
  assert.equal(Object.isFrozen(result.original_period), true); assert.equal(Object.isFrozen(result.package_snapshot.membership_terms), true);
  assert.equal(Object.isFrozen(f.source), false); assert.equal(Object.isFrozen(f.options), false);
  assert.deepEqual(f.calls, [{ name: 'read_retail_existing_recurring_source', args: { p_agreement: f.options.agreementId, p_client: f.options.clientId } }]);
});
test('admin historical snapshot needs no activation lease, current clock or provider calls', async () => {
  const f = setup('pro', 6, 'monthly_installments', true, true), old = Date.now;
  Date.now = () => { throw Error('No current-clock dependency'); };
  try { const r = await read(f.options); assert.equal(r.source_intent_id, null); assert.equal(r.original_period.paid_at, PAID); }
  finally { Date.now = old; }
});
test('input IDs canonicalize UUID case, never add a claim or supplied source', async () => {
  const f = setup(); f.options.agreementId = f.options.agreementId.toUpperCase(); f.options.clientId = f.options.clientId.toUpperCase();
  await read(f.options); assert.deepEqual(Object.keys(f.calls[0].args).sort(), ['p_agreement', 'p_client']);
  for (const mutate of [x => x.options.agreementId = 'not-a-uuid', x => x.options.claimKey = 'UNUSED', x => x.options.source = x.source]) {
    const x = setup(); mutate(x); await assert.rejects(read(x.options), { code: 'retail_recurring_source_invalid', status: 409 });
    assert.equal(x.calls.length, 0);
  }
});
test('exact projected envelope, matching identities and false authority required', async () => {
  const mutations = [s => s.extra = 'private', s => delete s.collection_ready, s => s.version = 'other',
    s => s.agreement_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', s => s.client_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    s => s.source_intent_id = 'not-uuid', s => s.source_intent_id = false,
    ...['effect_authorized', 'collection_ready', 'paid_access_authorized', 'payroll_authorized'].flatMap(k => [s => s[k] = true, s => s[k] = null])];
  for (const mutate of mutations) {
    const f = setup(); mutate(f.source); await assert.rejects(read(f.options), { code: 'retail_recurring_source_invalid', status: 409 });
    assert.equal(f.calls.length, 1);
  }
});
test('existing pure validator rejects malformed accepted package/account/A/B tuple without repricing', async () => {
  for (const mutate of [s => s.original_provider_account_id = 'acct_', s => s.package_snapshot.platform_fee_cents++,
    s => s.original_period.api_version = 'newer', s => s.original_period.paid_at = '2026-01-31',
    s => s.original_period.provider_period_end++, s => s.original_period.price_id = 'price_' + 'X'.repeat(250),
    s => s.original_period.extra = true, s => s.original_period.livemode = 'false']) {
    const f = setup(); mutate(f.source); await assert.rejects(read(f.options), { code: 'retail_recurring_source_invalid' });
  }
});
test('safe inert snapshots do not execute poison input/response accessors or proxies', async () => {
  let reads = 0; const f = setup();
  const accessor = { db: f.db, clientId: f.options.clientId }; Object.defineProperty(accessor, 'agreementId', { enumerable: true, get() { reads++; return f.options.agreementId; } });
  await assert.rejects(read(accessor), { code: 'retail_recurring_source_invalid' });
  await assert.rejects(read(new Proxy(f.options, { get() { reads++; throw Error('private'); } })), { code: 'retail_recurring_source_invalid' });
  f.db.rpc = async () => { const r = { error: null }; Object.defineProperty(r, 'data', { enumerable: true, get() { reads++; return f.source; } }); return r; };
  await assert.rejects(read(f.options), { code: 'retail_recurring_source_unknown' }); assert.equal(reads, 0);
});
test('DB/native errors normalized and no fallback to source tables or activation lease reader', async () => {
  for (const rpc of [async () => { throw Error('PRIVATE_TOKEN'); }, async () => ({ error: { message: 'PRIVATE_TOKEN' }, data: null }), async () => null]) {
    const f = setup(); f.db.rpc = rpc; f.db.from = () => { throw Error('must not load fallback'); };
    await assert.rejects(read(f.options), e => e.code === 'retail_recurring_source_unknown' && e.status === 503 && !e.message.includes('PRIVATE'));
  }
});
test('native source adapter importers remain the SDK census and existing funding adapter', () => {
  function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
  const importers = walk(path.join(__dirname, '../src')).filter(p => /\.(js|cjs|mjs|ts|tsx)$/.test(p)
    && path.basename(p) !== 'existingRetailRecurringSource.js' && fs.readFileSync(p, 'utf8').includes('existingRetailRecurringSource'));
  assert.deepEqual(importers.map(p => path.relative(path.join(__dirname, '../src'), p)),
    ['services/existingRetailCheckoutFunding.js','services/existingRetailRecurringCensus.js']);
});
