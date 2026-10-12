'use strict';
// Synthetic provider HTTP graph; actual installed SDK and native migrations.
const assert = require('node:assert/strict'), http = require('node:http'), Stripe = require('stripe');
const { h, setup } = require('./membership-checkout-pg');
const { createMembershipFinancialFacts } = require('../../src/services/membershipFinancialFacts');
const { createMembershipFinancialFactsTransport } = require('../../src/services/membershipFinancialFactsTransport');
const methods = {
  membership_v2_financial_context: ['p_operation'], membership_v2_capture_proof_matches: ['p_operation', 'p_proof'],
  membership_v2_invoice_proof_matches: ['p_operation', 'p'], membership_v2_invoice_clock_ready: ['p_operation', 'p'],
  membership_v2_record_capture: ['p_operation', 'p_proof'], membership_v2_record_paid_invoice: ['p_operation', 'p_proof'],
  membership_v2_record_capture_observation: ['p_operation', 'p_observation']
};
async function fixture(t, selection = {}, hooks = {}) {
  const x = setup(selection, { session: hooks.initialSession }); await x.sign(); await x.service.checkout(x.input); const op = x.op(), suffix = op.id.replaceAll('-', '');
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

module.exports = { fixture, h };
