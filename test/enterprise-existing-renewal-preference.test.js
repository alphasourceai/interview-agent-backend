'use strict';
// Authored SDK graphs/native RPC acknowledgments, NOT actual SQL acceptance,
// Stripe cash, hosted cancellation or access. Native journal has separate PG tests.
const test = require('node:test'), assert = require('node:assert/strict');
const fixture = require('./helpers/enterprise-status-observation-fixture');
const { reconcileExistingEnterpriseRenewal: reconcile, requestExistingEnterpriseRenewal: request,
  readExistingEnterpriseRenewalSummary: summary } = require('../src/services/existingEnterpriseRenewalPreference');
const clone = v => structuredClone(v);
const opId = '10000000-0000-4000-8000-000000000081', oldId = '10000000-0000-4000-8000-000000000080';
async function setup(t, { on = false, owned = false, cadence = 'monthly', status = 'waiting' } = {}) {
  const f = await fixture(t, { cadence }), w = f.native.a.enterprise_billing_receipt, p = w.funding_receipt.proof;
  f.x.invoice.status_transitions.finalized_at = f.x.invoice.created;
  f.fullEnd = f.sub.current_period_end;
  f.cutoff = f.fullEnd - 86400;
  const iso = sec => new Date(sec * 1000).toISOString();
  f.operation = { version: 'enterprise_existing_renewal_change_v2', operation_id: opId, source: clone(w),
    source_digest: '0123456789abcdef0123456789abcdef', requested_auto_renew: on,
    accepted_at: iso(Math.floor(Date.now()/1000)-10), effective_at: iso(f.cutoff), notice_cutoff_at: iso(f.cutoff-86400),
    term_index: 0, status, generation: 0, lease_until: null, sent_at: null, observation: null,
    completed_at: null, repair_sent_at: null, provider_cancel_operation_id: owned ? oldId : null };
  if (owned) { f.sub.cancel_at = f.cutoff; f.sub.current_period_end = f.cutoff; }
  f.pending = []; f.updates = []; f.actions = [];
  f.stripe.invoices.list = async () => ({ object: 'list', has_more: false, data: [clone(f.x.invoice)] });
  f.stripe.invoiceItems = { list: async () => ({ object: 'list', has_more: false, data: clone(f.pending) }) };
  f.stripe.subscriptions.update = async (id, body, options) => {
    f.updates.push({ id, body: clone(body), options: clone(options) });
    if (f.onUpdate) await f.onUpdate(body);
    if (body.cancel_at === '') { f.sub.cancel_at = null; f.sub.current_period_end = f.fullEnd; }
    else if (body.cancel_at) { f.sub.cancel_at = body.cancel_at; f.sub.current_period_end = body.cancel_at; }
    if (body.cancel_at_period_end === false) f.sub.cancel_at_period_end = false;
    return clone(f.sub);
  };
  const priorRpc = f.native.db.rpc;
  f.native.db.rpc = async (name, args) => {
    if (!['advance_enterprise_existing_renewal', 'change_enterprise_existing_renewal'].includes(name)) return priorRpc(name, args);
    f.actions.push({ name, args: clone(args) });
    assert.deepEqual(clone(args.p_billing), clone(w));
    const op = f.operation, result = () => ({ status: op.status, operation: clone(op),
      legal_term_end: f.legalEnd || iso(f.cutoff), notice_cutoff_at: iso(f.cutoff-86400),
      provider_effect_authorized: false, paid_access_authorized: false, payroll_authorized: false });
    if (f.onRpc) { const r = await f.onRpc(name, args); if (r) return r; }
    if (args.p_action === 'request') op.requested_auto_renew = args.p_auto_renew;
    if (args.p_action === 'claim') {
      if (op.sent_at && !(op.requested_auto_renew ? args.p_observation.subscription.cancel_at === null
        && !args.p_observation.subscription.cancel_at_period_end : args.p_observation.subscription.cancel_at === f.cutoff)) {
        return { error: null, data: { ...result(), status: 'unknown' } };
      }
      op.status = 'claimed'; op.generation++; op.observation = clone(args.p_observation);
    }
    if (args.p_action === 'send') op.sent_at = iso(Math.floor(Date.now()/1000));
    if (args.p_action === 'repair') op.repair_sent_at = iso(Math.floor(Date.now()/1000));
    if (['unknown', 'reject'].includes(args.p_action)) assert.deepEqual(clone(args.p_observation), clone(op.observation));
    if (args.p_action === 'unknown') op.status = 'unknown';
    if (['hold', 'reject'].includes(args.p_action)) op.status = 'held';
    if (args.p_action === 'finish') { op.status = 'applied'; op.observation = clone(args.p_observation); }
    return { data: result(), error: null };
  };
  f.args = { db: f.native.db, stripe: f.stripe, agreementId: f.native.a.id, clientId: f.native.client.id, effectsEnabled: true };
  return f;
}
test('Enterprise SDK renewal OFF is one existing setting write, pinned API, full invoice period retained', async t => {
  const f = await setup(t), before = clone(f.native.a.enterprise_billing_receipt), pool = clone(f.native.pool);
  const result = await reconcile(f.args);
  assert.equal(result.status, 'applied');
  assert.deepEqual(f.updates, [{ id: f.sub.id, body: { cancel_at: f.cutoff, proration_behavior: 'none' },
    options: { idempotencyKey: `enterprise-renewal:${opId}`, maxNetworkRetries: 0 } }]);
  assert.equal(result.operation.observation.invoice.period_end, f.fullEnd);
  assert.equal(result.operation.observation.subscription.current_period_end, f.cutoff);
  assert.deepEqual(f.native.a.enterprise_billing_receipt, before); assert.deepEqual(f.native.pool, pool);
  assert.deepEqual(f.actions.map(x => x.args.p_action), ['read', 'claim', 'send', 'finish']);
});
test('Enterprise SDK ON clears only owned cancellation with a separate fixed repair key', async t => {
  const f = await setup(t, { on: true, owned: true }); f.sub.cancel_at_period_end = true;
  assert.equal((await reconcile(f.args)).status, 'applied');
  assert.deepEqual(f.updates.map(x => x.body), [{ cancel_at_period_end: false }, { cancel_at: '', proration_behavior: 'none' }]);
  assert.deepEqual(f.updates.map(x => x.options.idempotencyKey), [`enterprise-renewal:${opId}`, `enterprise-renewal:${opId}:clear-cancel-at`]);
  assert.ok(f.updates.every(x => x.options.maxNetworkRetries === 0));
  assert.deepEqual(f.actions.map(x => x.args.p_action), ['read', 'claim', 'send', 'repair', 'finish']);
});
test('Enterprise SDK future installment period waits without native claim or SDK effect', async t => {
  const f = await setup(t); f.operation.effective_at = new Date((f.fullEnd+86400)*1000).toISOString();
  assert.equal((await reconcile(f.args)).status, 'waiting');
  assert.equal(f.updates.length, 0); assert.deepEqual(f.actions.map(x => x.args.p_action), ['read']);
});
test('Enterprise SDK annual cadence also uses native full period and custom E', async t => {
  const f = await setup(t, { cadence: 'annual' }); assert.equal((await reconcile(f.args)).status, 'applied');
  assert.equal(f.updates[0].body.cancel_at, f.cutoff);
});
for (const subStatus of ['past_due', 'unpaid']) test(`Enterprise SDK ${subStatus} can honor OFF without paying owed invoices`, async t => {
  const f = await setup(t); f.sub.status = subStatus; f.x.invoice.status = 'open'; f.x.invoice.paid = false;
  f.x.invoice.amount_paid = 0; f.x.invoice.amount_remaining = f.x.invoice.total;
  f.x.invoice.payment_intent = null; f.x.invoice.charge = null;
  assert.equal((await reconcile(f.args)).status, 'applied'); assert.equal(f.updates.length, 1);
});
for (const change of ['invoice amount', 'line amount', 'pending item', 'charge refund', 'payment intent', 'discount', 'new invoice']) {
  test(`Enterprise SDK ${change} drift after send is UNKNOWN, not a financial acceptance or retry`, async t => {
    const f = await setup(t);
    f.onUpdate = () => {
      if (change === 'invoice amount') f.x.invoice.amount_remaining++;
      if (change === 'line amount') f.x.line.amount--;
      if (change === 'pending item') f.pending.push({ object: 'invoiceitem', id: 'ii_NEW', customer: f.sub.customer,
        livemode: false, amount: 17, currency: 'usd', proration: false });
      if (change === 'charge refund') f.x.charge.amount_refunded++;
      if (change === 'payment intent') f.x.pi.amount_received--;
      if (change === 'discount') f.sub.discount = { id: 'di_NEW' };
      if (change === 'new invoice') f.stripe.invoices.list = async () => ({ object: 'list', has_more: false, data: [] });
    };
    await assert.rejects(reconcile(f.args), /enterprise_renewal_control_unverified/);
    assert.equal(f.operation.status, 'unknown'); assert.equal(f.updates.length, 1);
    assert.equal(f.actions.at(-1).args.p_action, 'unknown');
  });
}
test('Enterprise SDK known 4xx held once, original claim supplied, no SDK retry', async t => {
  const f = await setup(t); f.onUpdate = () => { throw Object.assign(Error('authored rejection'), { statusCode: 400 }); };
  await assert.rejects(reconcile(f.args), /enterprise_renewal_control_unverified/);
  assert.equal(f.operation.status, 'held'); assert.equal(f.updates.length, 1);
  assert.equal(f.actions.at(-1).args.p_action, 'reject');
  assert.equal((await reconcile(f.args)).status, 'held'); assert.equal(f.updates.length, 1);
});
test('Enterprise SDK lost setting ACK uses same unknown operation, exact desired GET can finish without send', async t => {
  const f = await setup(t); f.onUpdate = () => { f.sub.cancel_at = f.cutoff; f.sub.current_period_end = f.cutoff; throw Error('lost ACK'); };
  await assert.rejects(reconcile(f.args), /enterprise_renewal_control_unverified/);
  assert.equal(f.operation.status, 'unknown');
  f.onUpdate = null; assert.equal((await reconcile(f.args)).status, 'applied'); assert.equal(f.updates.length, 1);
});
test('Enterprise SDK unknown non-desired state never resends even with the same key', async t => {
  const f = await setup(t); f.onUpdate = () => { throw Error('timeout'); };
  await assert.rejects(reconcile(f.args), /enterprise_renewal_control_unverified/);
  f.onUpdate = null; assert.equal((await reconcile(f.args)).status, 'unknown'); assert.equal(f.updates.length, 1);
});
test('Enterprise SDK commit loss after successful send remains UNKNOWN with original observation', async t => {
  const f = await setup(t); f.onRpc = (name, args) => { if (args.p_action === 'finish') throw Error('commit ACK lost'); };
  await assert.rejects(reconcile(f.args), /enterprise_renewal_control_unverified/);
  assert.equal(f.operation.status, 'unknown'); assert.equal(f.updates.length, 1);
});
for (const issue of ['account', 'API', 'foreign cancel', 'foreign period-end', 'schedule', 'trial', 'test clock', 'draft invoice', 'missing page', 'source']) {
  test(`Enterprise SDK preflight refuses ${issue} without any setting or native claim`, async t => {
    const f = await setup(t);
    if (issue === 'account') f.x.account.id = 'acct_FOREIGN';
    if (issue === 'API') f.stripe.getApiField = () => '2025-01-01';
    if (issue === 'foreign cancel') { f.sub.cancel_at = f.cutoff; f.sub.current_period_end = f.cutoff; }
    if (issue === 'foreign period-end') f.sub.cancel_at_period_end = true;
    if (issue === 'schedule') f.sub.schedule = 'sub_sched_FOREIGN';
    if (issue === 'trial') f.sub.trial_end = f.fullEnd;
    if (issue === 'test clock') f.sub.test_clock = 'clock_LOCAL';
    if (issue === 'draft invoice') f.x.invoice.status = 'draft';
    if (issue === 'missing page') f.stripe.invoices.list = async () => ({ object: 'list', has_more: true, data: [] });
    if (issue === 'source') f.native.a.enterprise_checkout_source.material.customer_id = 'cus_FOREIGN';
    await assert.rejects(reconcile(f.args)); assert.equal(f.updates.length, 0);
    assert.ok(!f.actions.some(x => x.args.p_action === 'claim'));
  });
}
test('Enterprise SDK native busy does not acknowledge a newly requested preference', async t => {
  const f = await setup(t); f.onRpc = (name, args) => args.p_action === 'request' ? { error: null, data: {
    status: 'busy', operation: clone(f.operation), provider_effect_authorized: false, paid_access_authorized: false, payroll_authorized: false } } : null;
  assert.equal((await request({ ...f.args, autoRenew: true })).status, 'busy');
  assert.equal(f.updates.length, 0); assert.deepEqual(f.actions.map(x => x.args.p_action), ['request']);
});
for (const prior of ['none', 'opposite']) test(`Enterprise SDK deadline-held request keeps rejection with ${prior} prior operation, no read or reconcile`, async t => {
  const f = await setup(t, { on: true });
  const held = { status: 'held', reason: 'request_deadline_passed', operation: prior === 'none' ? null : clone(f.operation),
    legal_term_end: f.operation.effective_at, notice_cutoff_at: f.operation.notice_cutoff_at,
    provider_effect_authorized: false, paid_access_authorized: false, payroll_authorized: false };
  f.onRpc = (name, args) => {
    if (args.p_action === 'request') return { error: null, data: clone(held) };
    if (prior === 'none' && args.p_action === 'read') {
      const { reason, ...read } = held; return { error: null, data: { ...read, status: 'none' } };
    }
    return null;
  };
  const result = await request({ ...f.args, autoRenew: false });
  assert.equal(result.status, 'held'); assert.equal(result.reason, 'request_deadline_passed');
  assert.deepEqual(f.actions.map(x => x.args.p_action), ['request']); assert.equal(f.updates.length, 0);
});
test('Enterprise SDK summary uses current legal E after completed ON, not the old operation E', async t => {
  const f = await setup(t, { on: true, status: 'applied' }); f.legalEnd = new Date((f.fullEnd+31536000)*1000).toISOString();
  const r = await summary(f.args); assert.equal(r.stripe_renewal_billing_cutoff_at, f.legalEnd);
  assert.equal(r.renewal_requested_at, f.operation.accepted_at);
});
test('Enterprise SDK disabled reconciliation is no source/RPC/SDK operation; strict arguments reject injected clock', async () => {
  const args = { db: null, stripe: null, agreementId: opId, clientId: oldId, effectsEnabled: false };
  assert.deepEqual(await reconcile(args), { status: 'disabled' });
  await assert.rejects(reconcile({ ...args, now: () => 0 }));
  const hostile = { ...args }; Object.defineProperty(hostile, 'db', { enumerable: true, get() { throw Error('must not run'); } });
  await assert.rejects(reconcile(hostile), /enterprise_renewal_control_unverified/);
});
test('Enterprise SDK original partial Checkout period waits without any invoice/setting operation', async t => {
  const f = await setup(t);
  f.sub.current_period_start = Math.floor(Date.parse(f.native.a.enterprise_funding_receipt.proof.payment_success_at)/1000);
  f.sub.current_period_end = f.sub.billing_cycle_anchor;
  assert.equal((await reconcile(f.args)).status, 'waiting'); assert.equal(f.updates.length, 0);
  assert.deepEqual(f.actions.map(x => x.args.p_action), ['read']);
  assert.ok(!f.calls.some(x => x.kind === 'invoice'));
});
test('Enterprise SDK complete pagination includes later invoices, lines, pending items and refunds in drift fence', async t => {
  const f = await setup(t);
  const other = { ...clone(f.x.invoice), id: 'in_OLDER', subscription: 'sub_OTHER' };
  const line = { ...clone(f.x.line), id: 'il_OLDER', subscription: 'sub_OTHER' };
  const pending = { object: 'invoiceitem', id: 'ii_OLDER', customer: f.sub.customer, livemode: false, currency: 'usd', amount: 123, proration: false };
  const page = (data, has_more = false) => ({ object: 'list', data: clone(data), has_more });
  const reads = [];
  f.stripe.invoices.list = async args => { reads.push(clone(args)); return args.starting_after ? page([other]) : page([f.x.invoice], true); };
  f.stripe.invoices.retrieve = async id => clone(id === other.id ? other : f.x.invoice);
  f.stripe.invoices.listLineItems = async (id,args) => id === other.id ? page([line])
    : args.starting_after ? page([{ ...clone(line), id: 'il_EXTRA', type: 'invoiceitem', subscription_item: null }]) : page([f.x.line], true);
  f.stripe.invoiceItems.list = async args => args.starting_after ? page([pending]) : page([{ ...pending, id: 'ii_HEAD' }], true);
  f.stripe.refunds.list = async args => args.starting_after ? page([{ object: 'refund', id: 're_TAIL', amount: 0 }])
    : page([{ object: 'refund', id: 're_HEAD', amount: 0 }], true);
  f.onUpdate = () => { pending.amount++; };
  await assert.rejects(reconcile(f.args), /enterprise_renewal_control_unverified/);
  assert.equal(f.operation.status, 'unknown'); assert.equal(f.updates.length, 1);
  assert.ok(reads.some(x => x.starting_after === f.x.invoice.id));
});
test('Enterprise SDK actual installed Stripe client sends only GETs and one setting POST on loopback with API2023', async t => {
  const http = require('node:http'), Stripe = require('stripe'), f = await setup(t), requests = [];
  const list = data => ({ object: 'list', has_more: false, data: clone(data) });
  const server = http.createServer(async (req,res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString(), path = new URL(req.url, 'http://127.0.0.1').pathname;
    requests.push({ method: req.method, path, body, version: req.headers['stripe-version'], key: req.headers['idempotency-key'] });
    let value;
    if (path === '/v1/account') value = f.x.account;
    else if (path === `/v1/subscriptions/${f.sub.id}`) {
      if (req.method === 'POST') {
        const params = new URLSearchParams(body); assert.equal(params.get('proration_behavior'), 'none');
        f.sub.cancel_at = Number(params.get('cancel_at')); f.sub.current_period_end = f.sub.cancel_at;
      }
      value = f.sub;
    } else if (path === '/v1/invoices') value = list([f.x.invoice]);
    else if (path === `/v1/invoices/${f.x.invoice.id}`) value = f.x.invoice;
    else if (path === `/v1/invoices/${f.x.invoice.id}/lines`) value = list([f.x.line]);
    else if (path === `/v1/payment_intents/${f.x.pi.id}`) value = f.x.pi;
    else if (path === `/v1/charges/${f.x.charge.id}`) value = f.x.charge;
    else if (path === '/v1/refunds' || path === '/v1/invoiceitems') value = list([]);
    else { res.statusCode = 500; value = { error: { message: 'unapproved fixture route' } }; }
    res.setHeader('content-type','application/json'); res.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  f.args.stripe = new Stripe('sk_test_AUTHORED_ONLY', { apiVersion: '2023-10-16', host: '127.0.0.1',
    port: server.address().port, protocol: 'http', maxNetworkRetries: 0 });
  assert.equal((await reconcile(f.args)).status,'applied');
  assert.ok(requests.every(x => x.version === '2023-10-16'));
  const posts = requests.filter(x => x.method !== 'GET'); assert.equal(posts.length,1);
  assert.equal(posts[0].path,`/v1/subscriptions/${f.sub.id}`); assert.equal(posts[0].key,`enterprise-renewal:${opId}`);
});
