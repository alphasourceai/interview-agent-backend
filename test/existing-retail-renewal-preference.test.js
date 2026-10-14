'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { recurringFixture } = require('./fixtures/existing-retail-recurring-funding-fixture');
const { anchoredMonthInstant } = require('../src/services/membershipOffers');
const { renewalBillingCutoff, renewalSubscriptionProjection, requestExistingRetailRenewal,
  reconcileExistingRetailRenewal } = require('../src/services/existingRetailRenewalPreference');

function fixture(months = 3, payment = 'prepaid') {
  const f = recurringFixture('basic', months, payment, true, { ordinal: 1 });
  f.invs.splice(1); // Only the original invoice is needed for this setting-only census.
  const p = f.source.original_period, o = f.source.package_snapshot.membership_terms;
  const a = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  p.provider_period_start = Date.parse(a) / 1000; p.paid_at = a;
  p.provider_period_end = Date.parse(anchoredMonthInstant(a, o.stripe_recurrence.interval_count)) / 1000;
  const sub = { object: 'subscription', id: p.subscription_id, customer: p.customer_id, livemode: false,
    currency: 'usd', billing_cycle_anchor: p.provider_period_start, current_period_start: p.provider_period_start,
    current_period_end: p.provider_period_end, status: 'active', cancel_at_period_end: false, cancel_at: null,
    schedule: null, pause_collection: null, trial_start: null, trial_end: null, canceled_at: null, test_clock: null,
    items: { object: 'list', has_more: false, data: [{ id: p.subscription_item_id,
      subscription: p.subscription_id, quantity: 1, price: { object: 'price', id: p.price_id, type: 'recurring',
        unit_amount: o.platform_payment_cents, currency: 'usd', recurring: { interval: 'month',
          interval_count: o.stripe_recurrence.interval_count, usage_type: 'licensed' } } }] } };
  let operation = null; const writes = [], nativeCalls = []; let fail = null, holdCancel = false;
  f.db.rpc = async (name, args) => {
    if (name === 'read_retail_existing_recurring_source') return { data: structuredClone(f.source), error: null };
    assert.equal(name, 'change_retail_existing_renewal'); nativeCalls.push(structuredClone(args));
    if (fail === args.p_action) { fail = null; throw Error('SYNTHETIC lost acknowledgment'); }
    if (args.p_action === 'request') operation = { operation_id: randomUUID(), source: structuredClone(f.source),
      generation: 0, status: 'waiting', requested_auto_renew: args.p_auto_renew,
      billing_cutoff_at: renewalBillingCutoff(f.source), sent_at: null };
    if (args.p_action === 'claim') { operation.generation++; operation.status = 'claimed'; operation.observation = args.p_observation; }
    if (args.p_action === 'send') operation.sent_at ||= new Date().toISOString();
    if (args.p_action === 'unknown') operation.status = 'unknown';
    if (args.p_action === 'finish') operation.status = 'applied';
    if (args.p_action === 'hold') operation.status = 'held';
    return { data: { status: operation?.status || 'none', operation: structuredClone(operation) }, error: null };
  };
  f.sdk.subscriptions = { retrieve: async () => structuredClone(sub), update: async (id, body, options) => {
    writes.push({ id, body: structuredClone(body), options });
    if ('cancel_at_period_end' in body) {
      sub.cancel_at_period_end = body.cancel_at_period_end;
      sub.cancel_at = body.cancel_at_period_end ? sub.current_period_end : holdCancel ? sub.current_period_end : null;
    } else { assert.equal(body.cancel_at, ''); sub.cancel_at = null; }
    if (fail === 'provider') { fail = null; throw Error('SYNTHETIC lost provider acknowledgment'); }
    return structuredClone(sub);
  } };
  f.sdk.invoiceItems = { list: async () => ({ object: 'list', has_more: false, data: [] }) };
  return { ...f, sub, writes, nativeCalls, failAt: value => { fail = value; }, holdCancel: value => { holdCancel = value; },
    get operation() { return operation; }, input: { db: f.db, stripe: f.sdk,
      agreementId: f.source.agreement_id, clientId: f.source.client_id, effectsEnabled: true } };
}

for (const months of [3, 6, 12]) for (const payment of ['prepaid', 'monthly_installments'])
test(`existing ${months}/${payment} stores whole commitment cutoff and uses native period-end setting`, async () => {
  const f = fixture(months, payment), before = structuredClone(f.source), result = await requestExistingRetailRenewal({ ...f.input, autoRenew: false });
  const b = new Date(f.source.original_period.provider_period_start * 1000).toISOString();
  assert.equal(result.operation.billing_cutoff_at, anchoredMonthInstant(b, months));
  assert.equal(result.status, payment === 'prepaid' ? 'applied' : 'waiting');
  assert.equal(f.writes.length, payment === 'prepaid' ? 1 : 0);
  if (payment === 'prepaid') assert.deepEqual(f.writes[0].body, { cancel_at_period_end: true, proration_behavior: 'none' });
  assert.deepEqual(f.source, before); // Setting changes do not mutate accepted money/contract source.
});
test('renewal on is the original flag body; explicit cancel repair has a separate stable key', async () => {
  for (const repair of [false, true]) {
    const f = fixture(); f.sub.cancel_at_period_end = true; f.sub.cancel_at = f.sub.current_period_end; f.holdCancel(repair);
    assert.equal((await requestExistingRetailRenewal({ ...f.input, autoRenew: true })).status, 'applied');
    assert.deepEqual(f.writes[0].body, { cancel_at_period_end: false });
    assert.equal(f.writes[0].options.idempotencyKey, `retail-renewal:${f.operation.operation_id}`);
    if (repair) { assert.deepEqual(f.writes[1].body, { cancel_at: '' });
      assert.equal(f.writes[1].options.idempotencyKey, `${f.writes[0].options.idempotencyKey}:clear-cancel-at`); }
    assert.equal(f.writes.length, repair ? 2 : 1);
  }
});
test('lost provider acknowledgment resumes original operation and reads committed setting without another update', async () => {
  const f = fixture(); f.failAt('provider');
  await assert.rejects(requestExistingRetailRenewal({ ...f.input, autoRenew: false }), { code: 'retail_renewal_control_unknown' });
  assert.equal(f.operation.status, 'unknown'); const id = f.operation.operation_id;
  assert.equal((await reconcileExistingRetailRenewal(f.input)).status, 'applied');
  assert.equal(f.operation.operation_id, id); assert.equal(f.writes.length, 1); assert.equal(f.operation.generation, 2);
});
test('lost final native acknowledgment keeps provider identity rather than creating another operation', async () => {
  const f = fixture(); f.failAt('finish');
  await assert.rejects(requestExistingRetailRenewal({ ...f.input, autoRenew: false }));
  assert.equal(f.operation.status, 'unknown'); assert.equal((await reconcileExistingRetailRenewal(f.input)).status, 'applied');
  assert.equal(f.writes.length, 1);
});
test('disabled adapter never contacts provider; waiting preference does not masquerade as effective auto-renew', async () => {
  const f = fixture(); f.sdk.accounts.retrieve = () => { throw Error('provider forbidden'); };
  assert.equal((await reconcileExistingRetailRenewal({ ...f.input, effectsEnabled: false })).status, 'disabled');
  assert.equal((await requestExistingRetailRenewal({ ...f.input, autoRenew: false, effectsEnabled: false })).status, 'waiting');
  assert.equal(f.writes.length, 0); assert.equal(f.nativeCalls.some(c => c.p_action === 'finish'), false);
});
for (const status of ['past_due', 'unpaid']) test(`${status} never sends a provider setting`, async () => {
  const f = fixture(); f.sub.status = status;
  assert.equal((await requestExistingRetailRenewal({ ...f.input, autoRenew: false })).status, 'waiting'); assert.equal(f.writes.length, 0);
});
for (const mutate of [s => { s.billing_cycle_anchor++; }, s => { s.items.has_more = true; },
  s => { s.pause_collection = { behavior: 'void' }; }, s => { s.schedule = 'sub_sched_FOREIGN'; },
  s => { s.trial_end = s.current_period_end; }, s => { s.customer = 'cus_FOREIGN'; },
  s => { s.items.data[0].quantity = 2; }, s => { s.items.data[0].price.unit_amount++; },
  s => { s.livemode = true; s.test_clock = 'clock_FOREIGN'; }])
test(`foreign subscription geometry/configuration refuses before SDK update ${mutate.toString()}`, async () => {
  const f = fixture(); mutate(f.sub);
  await assert.rejects(requestExistingRetailRenewal({ ...f.input, autoRenew: false })); assert.equal(f.writes.length, 0);
});
test('foreign scheduled cancel holds, never repairs someone else’s arbitrary cancellation', async () => {
  const f = fixture(); f.sub.cancel_at = f.sub.current_period_end - 1;
  assert.equal((await requestExistingRetailRenewal({ ...f.input, autoRenew: true })).status, 'held'); assert.equal(f.writes.length, 0);
});
test('incomplete pending census and an existing proration hold before any update', async () => {
  for (const page of [{ object: 'list', has_more: true, data: [] }, { object: 'list', has_more: false,
    data: [{ object: 'invoiceitem', id: 'ii_PRORATION', proration: true }] }]) {
    const f = fixture(); f.sdk.invoiceItems.list = async () => page;
    await assert.rejects(requestExistingRetailRenewal({ ...f.input, autoRenew: false })); assert.equal(f.writes.length, 0);
  }
});
test('whole commitment boundary is original B, not next monthly period or contractual A', () => {
  const f = fixture(3, 'monthly_installments'), p = f.source.original_period;
  p.provider_period_start = Date.parse('2026-01-31T11:59:59.000Z') / 1000;
  p.provider_period_end = Date.parse('2026-02-28T11:59:59.000Z') / 1000;
  p.paid_at = '2026-01-31T12:13:14.000Z';
  assert.equal(renewalBillingCutoff(f.source, Date.parse('2026-02-15Z')), '2026-04-30T11:59:59.000Z');
  assert.equal(renewalBillingCutoff(f.source, Date.parse('2026-04-30T11:59:59.000Z')), '2026-07-31T11:59:59.000Z');
  assert.equal(renewalBillingCutoff(f.source, Date.parse('2026-12-01Z')), '2027-01-31T11:59:59.000Z');
});
test('pure provider projection retains unchanged identities without private metadata', () => {
  const f = fixture(); f.sub.metadata = { private: 'not returned' };
  const result = renewalSubscriptionProjection(f.sub, f.source);
  assert.equal(Object.hasOwn(result, 'metadata'), false); assert.equal(result.subscription_id, f.sub.id);
});
test('installed Stripe 16 SDK sends only the two existing API2023 setting bodies over local loopback', async () => {
  const http = require('node:http'), Stripe = require('stripe'), f = fixture(), posts = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    assert.equal(req.headers['stripe-version'], '2023-10-16');
    let result;
    if (url.pathname === '/v1/account') result = { object: 'account', id: 'acct_SYNTHETIC' };
    else if (url.pathname === '/v1/invoiceitems') result = { object: 'list', has_more: false, data: [] };
    else if (url.pathname === '/v1/invoices') result = { object: 'list', has_more: false, data: f.invs };
    else if (url.pathname === '/v1/subscriptions/sub_SYNTHETIC') {
      if (req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        const values = Object.fromEntries(new URLSearchParams(body)); posts.push({ values, key: req.headers['idempotency-key'] });
        f.sub.cancel_at_period_end = values.cancel_at_period_end === 'true';
        f.sub.cancel_at = f.sub.cancel_at_period_end ? f.sub.current_period_end : null;
      }
      result = f.sub;
    } else { res.statusCode = 500; result = { error: { message: 'Unexpected local path' } }; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const stripe = new Stripe('sk_test_SYNTHETIC_NO_PROVIDER', { apiVersion: '2023-10-16', host: '127.0.0.1',
      port: server.address().port, protocol: 'http', maxNetworkRetries: 0 });
    assert.equal((await requestExistingRetailRenewal({ ...f.input, stripe, autoRenew: false })).status, 'applied');
    const offKey = `retail-renewal:${f.operation.operation_id}`;
    assert.equal((await requestExistingRetailRenewal({ ...f.input, stripe, autoRenew: true })).status, 'applied');
    assert.deepEqual(posts, [{ values: { cancel_at_period_end: 'true', proration_behavior: 'none' }, key: offKey },
      { values: { cancel_at_period_end: 'false' }, key: `retail-renewal:${f.operation.operation_id}` }]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
