'use strict';
// Real disposable SQL and signer; synthetic in-memory files/renderer/provider.
const { before } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const h = require('./retail-signing-pg'), { sha } = require('./retail-review-fixture'), { signature } = require('./retail-signature');
const { createMembershipRetailSigningService } = require('../../src/services/membershipRetailSigning');
const { createMembershipCheckoutExecutor } = require('../../src/services/membershipCheckoutExecutor');
const PDF = Buffer.from('%PDF-1.7\nSYNTHETIC CHECKOUT FIXTURE\n%%EOF');
before(() => {
  if (process.env.MEMBERSHIP_V2_DISPOSABLE !== 'true') return;
  for (const file of ['20261012155804_membership_v2_pending_purchases.sql', '20261012172955_membership_v2_checkout_operations.sql'])
    h.sql(fs.readFileSync(path.join(__dirname, '../../supabase/migrations', file), 'utf8'));
});
const rpcKeys = {
  membership_v2_signing_session: ['p_document', 'p_token_hash'],
  membership_v2_read_acceptance_attempt: ['p_document', 'p_token_hash', 'p_attempt'],
  membership_v2_accept_png_document: ['p_acceptance', 'p_pixels_hash', 'p_width', 'p_height'],
  membership_v2_pending_source: ['p_document', 'p_token_hash', 'p_current'],
  membership_v2_reserve_pending_purchase: ['p_id', 'p_document', 'p_token_hash', 'p_environment'],
  membership_v2_read_pending_purchase: ['p_document', 'p_token_hash', 'p_environment'],
  membership_v2_checkout_context: ['p_purchase', 'p_token_hash', 'p_context', 'p_current'],
  membership_v2_claim_checkout_operation: ['p_id', 'p_purchase', 'p_token_hash', 'p_context'],
  membership_v2_claim_checkout_dispatch: ['p_operation', 'p_token_hash', 'p_nonce'],
  membership_v2_checkout_proof_matches: ['p_operation', 'p_proof'],
  membership_v2_bind_checkout: ['p_operation', 'p_token_hash', 'p_proof']
};
function setup(selection = {}, hooks = {}) {
  const f = h.setup(selection), token = 'T'.repeat(43), files = new Map(), calls = [], providerCalls = [];
  f.p.preview_pdf_sha256 = sha(PDF); f.p.preview_pdf_size = PDF.length;
  f.p.signer_token_hash = sha(`retail-signing-v2\n${f.p.id}\n${f.sourceFingerprint}\n${token}`);
  f.issue(); files.set(f.p.preview_pdf_path, Buffer.from(PDF));
  const contextId = crypto.randomUUID();
  h.sql(`update membership_v2_checkout_contexts set checkout_enabled=false;
    ${h.insert('membership_v2_checkout_contexts', { id: contextId, environment: 'dev', provider_account_id: 'acct_SYNTHETIC',
      api_version: '2023-10-16', livemode: false, frontend_origin: 'https://example.invalid',
      tax_policy: 'existing_checkout_no_automatic_tax_v1', checkout_enabled: hooks.disabled ? false : true })}`);
  const db = { from(table) { return { select(columns) { const filters = []; return {
    eq(k, v) { filters.push(`${k}=${h.literal(v)}`); return this; }, async maybeSingle() {
      if (hooks.beforeRead) await hooks.beforeRead(table);
      const r = h.run(`set role service_role;select row_to_json(t) from (select ${columns} from public.${table} where ${filters.join(' and ')}) t;`);
      return r.status ? { error: { code: 'SQLERR' } } : { data: r.stdout.trim() ? JSON.parse(r.stdout) : null, error: null };
    }
  }; } }; }, async rpc(name, p) {
    calls.push(name); if (hooks.beforeRPC) await hooks.beforeRPC(name, p);
    assert.ok(rpcKeys[name], name);
    const list = /signing_session|read_acceptance_attempt|accept_png_document/.test(name);
    const q = `set role service_role;select ${list ? "coalesce(json_agg(t),'[]'::json) from " : 'to_json('}public.${name}(${rpcKeys[name].map(k => h.literal(p[k])).join(',')})${list ? ' t' : ')'};`;
    const r = hooks.concurrent ? await h.asyncSQL(q).done : h.run(q);
    if (r.status) return { error: { code: (r.err || r.stderr).match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1] || 'SQLERR', message: r.err || r.stderr } };
    if (hooks.afterRPC) { const changed = await hooks.afterRPC(name, p); if (changed) return changed; }
    return { data: JSON.parse((r.out || r.stdout).trim()), error: null };
  } };
  const signing = createMembershipRetailSigningService({ db, artifacts: { async readPrivate(p) { return files.get(p); },
    async putIfAbsent(p, b, o) { assert.equal(o.upsert, false); assert.ok(!files.has(p)); files.set(p, Buffer.from(b)); } },
  renderExecution: async () => ({ pdf_bytes: PDF }) });
  let body, session, lineList;
  const response = v => Object.assign(v, { lastResponse: { headers: { 'stripe-version': hooks.responseVersion || '2023-10-16' } } });
  const opts = o => assert.deepEqual(o, { maxNetworkRetries: 0, timeout: 10000 });
  const stripe = {
    getApiField(k) { return k === 'version' ? (hooks.version || '2023-10-16') : undefined; }, getMaxNetworkRetries() { return 0; },
    accounts: { async retrieve(p, o) { assert.deepEqual(p, {}); opts(o); providerCalls.push('account'); return response({ object: 'account', id: hooks.account || 'acct_SYNTHETIC' }); } },
    balance: { async retrieve(p, o) { assert.deepEqual(p, {}); opts(o); providerCalls.push('balance'); return response({ object: 'balance', livemode: hooks.live || false }); } },
    paymentIntents: { async retrieve(id, p, o) {
      assert.deepEqual(p, {}); opts(o); providerCalls.push('intent');
      const value = { object: 'payment_intent', id, livemode: false, currency: 'usd', capture_method: 'automatic',
        setup_future_usage: 'off_session', metadata: body.payment_intent_data.metadata, amount: session.amount_total,
        customer: session.customer, status: 'requires_action' };
      if (hooks.intent) hooks.intent(value); return response(value);
    } },
    checkout: { sessions: {
      async create(b, o) {
        providerCalls.push('create'); body = structuredClone(b);
        assert.equal(o.timeout, 10000); assert.equal(o.maxNetworkRetries, 0); assert.match(o.idempotencyKey, /^membership-checkout-v2:/);
        if (hooks.onCreate) await hooks.onCreate(b);
        const sessionId = `cs_test_SYNTHETIC_${b.metadata.operation_id.replaceAll('-', '')}`;
        session = { object: 'checkout.session', id: sessionId, livemode: false, currency: 'usd', payment_intent: null, customer: null, ...b,
          automatic_tax: b.automatic_tax, total_details: { amount_tax: 0, amount_discount: 0, amount_shipping: 0 },
          amount_subtotal: b.line_items.reduce((n, l) => n + l.price_data.unit_amount, 0), status: 'open', payment_status: 'unpaid',
          created: Math.floor(Date.now() / 1000), url: `https://checkout.stripe.com/c/pay/${sessionId}#provider-fragment` };
        session.amount_total = session.amount_subtotal;
        lineList = { object: 'list', has_more: false, data: b.line_items.map((l, i) => ({ object: 'item', id: `li_SYNTHETIC${i}`,
          quantity: 1, currency: 'usd', amount_discount: 0, amount_tax: 0, amount_subtotal: l.price_data.unit_amount,
          amount_total: l.price_data.unit_amount, price: { object: 'price', id: `price_SYNTHETIC${i}`, livemode: false,
            unit_amount: l.price_data.unit_amount, type: 'one_time', recurring: null, currency: 'usd',
            product: { object: 'product', id: `prod_SYNTHETIC${i}`, livemode: false, ...l.price_data.product_data } } })) };
        return response({ id: session.id });
      },
      async retrieve(id, p, o) { assert.deepEqual(p, {}); opts(o); providerCalls.push('retrieve'); assert.equal(id, session.id);
        const r = structuredClone(session); if (hooks.session) hooks.session(r); return response(r); },
      async listLineItems(id, p, o) { opts(o); providerCalls.push('lines'); assert.equal(id, session.id);
        assert.deepEqual(p, { limit: 100, expand: ['data.price.product'] }); const r = structuredClone(lineList);
        if (hooks.lines) hooks.lines(r); return response(r); }
    } }
  };
  const input = { documentId: f.p.id, token }, service = createMembershipCheckoutExecutor({ db, signing, stripe, environment: 'dev', contextId });
  return { f, contextId, input, service, db, signing, stripe, files, calls, providerCalls, body: () => body,
    sign: () => signing.sign({ ...input, typedName: 'Demo Buyer', consent: true, signatureDataUrl: signature() }),
    op: () => JSON.parse(h.sql(`select row_to_json(o) from membership_v2_checkout_operations o where purchase_id=
      (select id from membership_v2_pending_purchases where document_id='${f.p.id}')`)) };
}
module.exports = { h, setup };
