'use strict';
const { test, before } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), Stripe = require('stripe');
const { h, setup } = require('./fixtures/membership-checkout-pg');
const { createMembershipFinancialFacts } = require('../src/services/membershipFinancialFacts');
const { createMembershipFinancialFactsTransport } = require('../src/services/membershipFinancialFactsTransport');
before(() => { if (process.env.MEMBERSHIP_V2_DISPOSABLE === 'true') h.sql(fs.readFileSync(path.join(__dirname,
  '../supabase/migrations/20261012191508_membership_v2_capture_facts.sql'), 'utf8')); });
const methods = {
  membership_v2_financial_context: ['p_operation'], membership_v2_capture_proof_matches: ['p_operation', 'p_proof'],
  membership_v2_invoice_proof_matches: ['p_operation', 'p'], membership_v2_invoice_clock_ready: ['p_operation', 'p'],
  membership_v2_record_capture: ['p_operation', 'p_proof'], membership_v2_record_paid_invoice: ['p_operation', 'p_proof'],
  membership_v2_record_capture_observation: ['p_operation', 'p_observation']
};
async function fixture(t, selection = {}, hooks = {}) {
  const x = setup(selection); await x.sign(); await x.service.checkout(x.input); const op = x.op(), suffix = op.id.replaceAll('-', '');
  const binding = JSON.parse(h.sql(`select row_to_json(t) from membership_v2_checkout_bindings t where operation_id='${op.id}'`));
  const body = op.request_body, b = binding.proof, customer = `cus_SYNTHETIC_${suffix}`, piId = `pi_SYNTHETIC_${suffix}`;
  const chargeId = `ch_SYNTHETIC_${suffix}`, invoiceId = `in_SYNTHETIC_${suffix}`, clock = Math.max(b.created,
    Number(h.sql(`select floor(extract(epoch from accepted_at))::bigint from membership_v2_document_acceptances where document_id='${x.f.p.id}'`)));
  const session = { ...body, object: 'checkout.session', id: b.session_id, livemode: false, currency: 'usd', created: b.created,
    status: 'complete', payment_status: 'paid', amount_total: b.amount_total, amount_subtotal: b.amount_subtotal,
    total_details: { amount_discount: 0, amount_tax: 0, amount_shipping: 0 }, customer, payment_intent: piId, invoice: invoiceId, url: null };
  const lines = { object: 'list', has_more: false, data: b.items.map(i => ({ object: 'item', id: i.line_id,
    quantity: 1, currency: 'usd', amount_discount: 0, amount_tax: 0, amount_subtotal: i.unit_amount, amount_total: i.unit_amount,
    price: { object: 'price', id: i.price_id, currency: 'usd', livemode: false, unit_amount: i.unit_amount, type: 'one_time', recurring: null,
      product: { object: 'product', id: i.product_id, livemode: false, metadata: i.metadata, name: i.name } } })) };
  const intent = { object: 'payment_intent', id: piId, livemode: false, currency: 'usd', created: clock, status: 'succeeded',
    amount: b.amount_total, amount_received: b.amount_total, customer, metadata: body.payment_intent_data.metadata,
    capture_method: 'automatic', setup_future_usage: 'off_session', latest_charge: chargeId, invoice: null };
  const charge = { object: 'charge', id: chargeId, livemode: false, currency: 'usd', created: clock, status: 'succeeded', paid: true,
    captured: true, amount: b.amount_total, amount_captured: b.amount_total, customer, payment_intent: piId,
    invoice: invoiceId, amount_refunded: 0, disputed: false };
  const invoice = { object: 'invoice', id: invoiceId, livemode: false, currency: 'usd', customer, payment_intent: piId, charge: chargeId,
    status: 'paid', paid: true, paid_out_of_band: false, metadata: body.invoice_creation.invoice_data.metadata, amount_due: b.amount_total,
    amount_paid: b.amount_total, amount_remaining: 0, subtotal: b.amount_total, total: b.amount_total, starting_balance: 0, ending_balance: 0,
    pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0, discounts: [], total_discount_amounts: [], total_tax_amounts: [],
    shipping_cost: null, subscription: null, created: clock, status_transitions: { paid_at: clock } };
  const invoiceLines = { object: 'list', has_more: false, data: lines.data.map((l, i) => ({ object: 'line_item', id: `il_SYNTHETIC${i}`,
    quantity: 1, amount: l.amount_total, currency: 'usd', price: structuredClone(l.price), type: 'invoiceitem', subscription: null,
    subscription_item: null, discount_amounts: [], tax_amounts: [] })) };
  const graph = { session, lines, intent, charge, invoice, invoiceLines }, requests = [], calls = [];
  const db = { from: x.db.from, async rpc(name, args) {
    calls.push(name); assert.ok(methods[name], name);
    const statement = `set role service_role;select to_json(public.${name}(${methods[name].map(k => h.literal(args[k])).join(',')}));`;
    if (hooks.concurrentCapture && name === 'membership_v2_record_capture') {
      const results = await Promise.all([h.asyncSQL(statement).done, h.asyncSQL(statement).done]);
      for (const result of results) assert.equal(result.status, 0, result.err);
      assert.deepEqual(JSON.parse(results[0].out), JSON.parse(results[1].out));
      return { data: JSON.parse(results[0].out), error: null };
    }
    const r = h.run(statement);
    if (r.status) return { error: { message: r.stderr } };
    if (hooks.afterRPC) { const result = await hooks.afterRPC(name, args); if (result) return result; }
    return { data: JSON.parse(r.stdout.trim()), error: null };
  } };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1'); let body = ''; for await (const b of req) body += b;
    requests.push({ path: u.pathname, query: u.search, method: req.method, body });
    try {
      assert.equal(req.method, 'GET'); assert.equal(body, ''); assert.equal(req.headers['stripe-version'], '2023-10-16');
      assert.equal(req.headers['stripe-account'], undefined); assert.equal(req.headers['idempotency-key'], undefined);
      if (u.pathname.endsWith('/line_items') || u.pathname.endsWith('/lines')) {
        assert.deepEqual([...u.searchParams], [['limit', '100'], ['expand[0]', 'data.price.product']]);
      } else assert.equal(u.search, '');
      let result;
      if (u.pathname === '/v1/account') result = { object: 'account', id: 'acct_SYNTHETIC' };
      else if (u.pathname === '/v1/balance') result = { object: 'balance', livemode: false, available: [{ amount: -900000, currency: 'usd' }] };
      else if (u.pathname === `/v1/checkout/sessions/${b.session_id}`) result = graph.session;
      else if (u.pathname === `/v1/checkout/sessions/${b.session_id}/line_items`) result = graph.lines;
      else if (u.pathname === `/v1/payment_intents/${id(graph.session.payment_intent)}`) result = graph.intent;
      else if (u.pathname === `/v1/charges/${id(graph.intent.latest_charge)}`) result = graph.charge;
      else if (u.pathname === `/v1/invoices/${id(graph.session.invoice)}`) result = graph.invoice;
      else if (u.pathname === `/v1/invoices/${id(graph.session.invoice)}/lines`) result = graph.invoiceLines;
      else assert.fail(`unexpected path ${u.pathname}`);
      if (hooks.response) result = hooks.response(u.pathname, structuredClone(result), requests) ?? result;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Stripe-Version': hooks.version || '2023-10-16' }); res.end(JSON.stringify(result));
    } catch (_) { res.writeHead(500, { 'Content-Type': 'application/json', 'Stripe-Version': '2023-10-16' });
      res.end(JSON.stringify({ error: { type: 'api_error', message: 'SYNTHETIC fixture rejected request' } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port, transport = createMembershipFinancialFactsTransport(Stripe.createNodeHttpClient(), { host: '127.0.0.1', port, protocol: 'http' });
  const stripe = new Stripe('sk_test_SYNTHETIC_NOT_A_CREDENTIAL', { apiVersion: '2023-10-16', host: '127.0.0.1', port, protocol: 'http',
    maxNetworkRetries: 0, timeout: 60000, httpClient: transport });
  const service = createMembershipFinancialFacts({ db, stripe, environment: 'dev', contextId: x.contextId });
  const get = table => JSON.parse(h.sql(`select coalesce((select row_to_json(t) from ${table} t where operation_id='${op.id}'),'null'::json)`));
  const observe = () => service.observe({ operationId: op.id });
  return { x, op, graph, requests, calls, stripe, db, service, observe, get, transport };
}
const id = v => typeof v === 'string' ? v : v?.id;

for (const planKey of ['basic', 'pro']) for (const commitmentMonths of [3, 6, 12])
  for (const paymentOption of ['prepaid', 'monthly_installments']) for (const firstRolePrepaySelected of [false, true]) {
    test(`native paid facts ${planKey}/${commitmentMonths}/${paymentOption}/role:${firstRolePrepaySelected}`, h.opts, async t => {
      const f = await fixture(t, { planKey, commitmentMonths, paymentOption, firstRolePrepaySelected });
      const r = await f.observe(), c = f.get('membership_v2_capture_facts'), clock = f.get('membership_v2_paid_invoice_facts');
      assert.equal(r.capture_recorded, true); assert.equal(r.paid_clock_recorded, true); assert.equal(r.activation_enabled, false);
      assert.equal(c.captured_cents, f.x.f.quote.offer.initial_payment_cents); assert.equal(c.platform_cents, f.x.f.quote.offer.platform_payment_cents);
      assert.equal(c.role_cents, firstRolePrepaySelected ? (planKey === 'basic' ? 35900 : 62900) : 0);
      assert.equal(c.original_salesperson_user_id, h.rep); assert.equal(clock.provider_paid_at, f.graph.invoice.status_transitions.paid_at);
      assert.deepEqual(await f.observe(), r); assert.deepEqual(f.get('membership_v2_capture_facts'), c); assert.deepEqual(f.get('membership_v2_paid_invoice_facts'), clock);
      assert.equal(h.sql('select count(*) from membership_v2_contracts'), '0'); assert.ok(f.requests.every(r => r.method === 'GET'));
    });
  }
test('partial/unpaid/processing/auth-only graphs occupy neither full financial slot', h.opts, async t => {
  const changes = [g => { g.session.payment_status = 'unpaid'; }, g => { g.intent.status = 'processing'; },
    g => { g.intent.amount_received--; }, g => { g.charge.captured = false; }, g => { g.charge.amount_captured--; },
    g => { g.lines.has_more = true; }, g => { g.lines.data[0].price.product = 'prod_UNEXPANDED'; },
    g => { g.intent.currency = 'eur'; }, g => { g.charge.payment_intent = 'pi_OTHER'; }, g => { g.session.total_details.amount_tax = 1; },
    g => { g.intent.metadata = {}; }, g => { g.charge.transfer = 'tr_OTHER'; }, g => { g.charge.application_fee_amount = 1; },
    g => { g.lines.data[0].id = 'li_OTHER'; }, g => { g.lines.data[0].price.currency = 'eur'; }];
  for (const change of changes) { const f = await fixture(t); const original = structuredClone(f.graph); change(f.graph);
    await assert.rejects(f.observe()); assert.equal(f.get('membership_v2_capture_facts'), null); assert.equal(f.get('membership_v2_paid_invoice_facts'), null);
    Object.assign(f.graph, original); assert.equal((await f.observe()).paid_clock_recorded, true);
  }
});
test('capture precedes invoice; invoice null/outage/truncated/unsupported backreferences keep capture and no clock', h.opts, async t => {
  const changes = [g => { g.session.invoice = null; }, g => { g.invoiceLines.has_more = true; },
    g => { g.invoice.payment_intent = null; }, g => { g.invoice.charge = null; }, g => { g.charge.invoice = null; },
    g => { g.invoice.paid_out_of_band = true; }, g => { g.intent.invoice = 'in_OTHER'; },
    g => { g.invoice.pre_payment_credit_notes_amount = 1; }, g => { g.invoiceLines.data[0].price.product = 'prod_UNEXPANDED'; },
    g => { g.invoiceLines.data[0].price.currency = 'eur'; }];
  for (const change of changes) { const f = await fixture(t); const original = structuredClone(f.graph); change(f.graph);
    assert.equal((await f.observe()).paid_clock_recorded, false); const capture = f.get('membership_v2_capture_facts'); assert.ok(capture);
    Object.assign(f.graph, original); assert.equal((await f.observe()).paid_clock_recorded, true); assert.deepEqual(f.get('membership_v2_capture_facts'), capture);
  }
  const f = await fixture(t, {}, { response: p => { if (p.startsWith('/v1/invoices/')) throw Error('SYNTHETIC invoice outage'); } });
  assert.equal((await f.observe()).paid_clock_recorded, false); assert.ok(f.get('membership_v2_capture_facts')); assert.equal(f.get('membership_v2_paid_invoice_facts'), null);
});
test('same-second clock is valid; earlier/outside/fractional/null clock absent; future observed then reevaluated', h.opts, async t => {
  for (const value of [null, 1000, 4102444800, 123.4, '1700000000']) {
    const f = await fixture(t); f.graph.invoice.status_transitions.paid_at = value;
    assert.equal((await f.observe()).paid_clock_recorded, false); assert.ok(f.get('membership_v2_capture_facts'));
  }
  const f = await fixture(t); const now = f.graph.invoice.status_transitions.paid_at;
  f.graph.invoice.status_transitions.paid_at = now - 1; assert.equal((await f.observe()).paid_clock_recorded, false);
  const future = Math.ceil(Date.now() / 1000) + 2;
  f.graph.invoice.status_transitions.paid_at = future; assert.equal((await f.observe()).paid_clock_recorded, false);
  assert.equal(h.sql(`select count(*) from membership_v2_capture_observations where operation_id='${f.op.id}' and observation->>'kind'='provider_clock_ahead'`), '1');
  // Same raw provider clock; only native time catches up. Fresh SDK GET required.
  await new Promise(resolve => setTimeout(resolve, Math.max(0, future * 1000 - Date.now() + 20)));
  const before = f.requests.filter(r => /\/invoices\/in_/.test(r.path)).length;
  assert.equal((await f.observe()).paid_clock_recorded, true);
  assert.equal(f.get('membership_v2_paid_invoice_facts').provider_paid_at, future);
  assert.ok(f.requests.filter(r => /\/invoices\/in_/.test(r.path)).length > before);
});
test('refund/dispute/reuse changes append observations without rewriting capture/clock or enabling access', h.opts, async t => {
  const f = await fixture(t); await f.observe(); const capture = f.get('membership_v2_capture_facts'), clock = f.get('membership_v2_paid_invoice_facts');
  f.graph.charge.amount_refunded = capture.captured_cents; f.graph.charge.disputed = true; f.graph.intent.setup_future_usage = null;
  const r = await f.observe(); assert.equal(r.activation_enabled, false); assert.deepEqual(f.get('membership_v2_capture_facts'), capture);
  assert.deepEqual(f.get('membership_v2_paid_invoice_facts'), clock);
  assert.equal(h.sql(`select observation->>'amount_refunded' from membership_v2_capture_observations where operation_id='${f.op.id}' order by observed_at desc limit 1`), String(capture.captured_cents));
});
test('closed config and offboarded original rep cannot discard bound historical money', h.opts, async t => {
  const f = await fixture(t);
  const successor = h.source({}, f.x.f.sourceId, f.x.f.scopeId);
  h.denied(`set role service_role;${successor.register}`, /accepted_sales_source_immutable/);
  h.sql(`update membership_v2_checkout_contexts set checkout_enabled=false;
    update sales_reps set active=false where user_id='${h.rep}'`);
  assert.equal((await f.observe()).paid_clock_recorded, true); assert.equal(f.get('membership_v2_capture_facts').original_salesperson_user_id, h.rep);
  h.sql(`update sales_reps set active=true where user_id='${h.rep}'`);
});
test('lost capture/clock ACK reads exact committed fact once without repeated RPC or financial requests', h.opts, async t => {
  const f = await fixture(t, {}, { afterRPC: name => /record_capture$|record_paid_invoice$/.test(name) ? { error: { code: 'SYNTHETIC_LOST_ACK' } } : null });
  assert.equal((await f.observe()).paid_clock_recorded, true);
  assert.equal(f.calls.filter(k => k === 'membership_v2_record_capture').length, 1); assert.equal(f.calls.filter(k => k === 'membership_v2_record_paid_invoice').length, 1);
});
test('identity/clock conflicts preserve original facts; service cannot supply derived columns; browser cannot access', h.opts, async t => {
  const f = await fixture(t); await f.observe(); const capture = f.get('membership_v2_capture_facts'), clock = f.get('membership_v2_paid_invoice_facts');
  const forged = { ...capture.proof, charge_id: 'ch_OTHER', intent_latest_charge: 'ch_OTHER' };
  h.denied(`set role service_role;select membership_v2_record_capture('${f.op.id}',${h.literal(forged)})`, /capture_identity_conflict/);
  const clockProof = { ...clock.proof, provider_paid_at: clock.provider_paid_at - 1 };
  h.denied(`set role service_role;select membership_v2_record_paid_invoice('${f.op.id}',${h.literal(clockProof)})`, /invoice_clock_proof_denied/);
  const otherInvoice = { ...clock.proof, invoice_id: 'in_OTHER', session_invoice: 'in_OTHER', charge_invoice: 'in_OTHER' };
  h.denied(`set role service_role;select membership_v2_record_paid_invoice('${f.op.id}',${h.literal(otherInvoice)})`, /invoice_clock_identity_conflict/);
  for (const table of ['membership_v2_capture_facts','membership_v2_paid_invoice_facts','membership_v2_capture_observations']) {
    assert.equal(h.sql(`select relrowsecurity and relforcerowsecurity from pg_class where oid='${table}'::regclass`), 't');
    for (const role of ['anon','authenticated']) for (const q of [`select * from ${table}`,`truncate ${table}`,`delete from ${table}`]) h.denied(`set role ${role};${q}`, /permission denied/);
    for (const q of [`update ${table} set operation_id=operation_id`,`delete from ${table}`,`truncate ${table}`]) h.denied(`set role service_role;${q}`, /permission denied/);
    h.denied(`truncate ${table} cascade`, /immutable/);
  }
  h.denied(`set role service_role;insert into membership_v2_capture_facts(operation_id,proof,captured_cents) values('${f.op.id}',${h.literal(capture.proof)},1)`, /permission denied/);
  assert.deepEqual(f.get('membership_v2_capture_facts'), capture); assert.deepEqual(f.get('membership_v2_paid_invoice_facts'), clock);
});
test('real overlapping SQL capture commits one immutable row and returns the same identity', h.opts, async t => {
  const f = await fixture(t, {}, { concurrentCapture: true }); assert.equal((await f.observe()).paid_clock_recorded, true);
  assert.equal(h.sql(`select count(*) from membership_v2_capture_facts where operation_id='${f.op.id}'`), '1');
});
test('actual SDK transport denies writes, extra queries, Connect headers and wrong endpoint before network', h.opts, async t => {
  const f = await fixture(t); const count = f.requests.length;
  await assert.rejects(f.stripe.checkout.sessions.create({ mode: 'payment' }));
  await assert.rejects(f.stripe.accounts.retrieve({ expand: ['settings'] }));
  await assert.rejects(f.stripe.balance.retrieve({}, { stripeAccount: 'acct_OTHER' }));
  assert.equal(f.requests.length, count);
});
test('opening/closing actual account and mode checks precede capture; wrong headers write no fact', h.opts, async t => {
  const badVersion = await fixture(t, {}, { version: '2024-10-28' }); await assert.rejects(badVersion.observe()); assert.equal(badVersion.get('membership_v2_capture_facts'), null);
  for (const resource of ['account','balance']) {
    let reads = 0;
    const f = await fixture(t, {}, { response: (p, value) => {
      if (p === `/v1/${resource}` && ++reads === 2) return resource === 'account' ? { ...value, id: 'acct_OTHER' } : { ...value, livemode: true };
      return value;
    } });
    await assert.rejects(f.observe()); assert.equal(f.get('membership_v2_capture_facts'), null);
  }
});
test('private worker input is exact data-only UUID, with no coercion/accessor/proxy effects', h.opts, async t => {
  const f = await fixture(t); let effects = 0;
  const accessor = {}; Object.defineProperty(accessor, 'operationId', { enumerable: true, get() { effects++; return f.op.id; } });
  const coercible = { operationId: { toString() { effects++; return f.op.id; } } };
  for (const v of [null, [], { operationId: 1 }, { operationId: Symbol('synthetic') }, coercible, accessor,
    { operationId: f.op.id, providerId: 'pi_OTHER' }, new Proxy({ operationId: f.op.id }, { ownKeys() { effects++; return []; } })]) {
    await assert.rejects(f.service.observe(v), { code: 'invalid_membership_financial_observation' });
  }
  assert.equal(effects, 0); assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 0);
});
