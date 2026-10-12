'use strict';
// UNMOUNTED private financial facts only. Never charges, creates an account,
// grants access, assigns a term, qualifies commission or calls a legacy adapter.
const { isProxy } = require('node:util').types;
const { isMembershipFinancialFactsTransport } = require('./membershipFinancialFactsTransport');
const UUID = /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = '2023-10-16', OPTIONS = Object.freeze({ timeout: 10000, maxNetworkRetries: 0 });
const canonical = v => v && typeof v === 'object' ? (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`) : JSON.stringify(v);
const same = (a, b) => canonical(a) === canonical(b);
const id = v => typeof v === 'string' ? v : v?.id ?? null;
function fail(code = 'membership_financial_facts_held') { const e = new Error(code); e.code = code; throw e; }
const check = (ok, code) => { if (!ok) fail(code); };
const epoch = v => Number.isSafeInteger(v) && v >= 946684800 && v <= 4102444799;
function exactInput(v) {
  if (!v || typeof v !== 'object' || isProxy(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return false;
  const d = Object.getOwnPropertyDescriptors(v);
  return Reflect.ownKeys(d).length === 1 && d.operationId?.enumerable && Object.hasOwn(d.operationId, 'value')
    && typeof d.operationId.value === 'string' && UUID.test(d.operationId.value);
}
function createMembershipFinancialFacts({ db, stripe, environment, contextId } = {}) {
  check(db && typeof db.rpc === 'function' && typeof db.from === 'function'
    && ['dev', 'qa', 'production'].includes(environment) && UUID.test(contextId || '')
    && typeof stripe?.getApiField === 'function' && typeof stripe.getMaxNetworkRetries === 'function'
    && typeof stripe.accounts?.retrieve === 'function' && typeof stripe.balance?.retrieve === 'function'
    && typeof stripe.checkout?.sessions?.retrieve === 'function' && typeof stripe.checkout.sessions.listLineItems === 'function'
    && typeof stripe.paymentIntents?.retrieve === 'function' && typeof stripe.charges?.retrieve === 'function'
    && typeof stripe.invoices?.retrieve === 'function' && typeof stripe.invoices.listLineItems === 'function', 'membership_financial_not_configured');
  function version() {
    check(stripe.getApiField('version') === VERSION && !stripe.getApiField('stripeAccount')
      && stripe.getMaxNetworkRetries() === 0 && isMembershipFinancialFactsTransport(stripe.getApiField('httpClient')),
    'membership_financial_provider_mismatch');
  }
  async function provider(call) {
    version(); let r; try { r = await call(); } catch (_) { fail('membership_financial_provider_unavailable'); }
    version(); check(r?.lastResponse?.headers?.['stripe-version'] === VERSION, 'membership_financial_provider_version_unverified'); return r;
  }
  async function rpc(name, args) {
    let r; try { r = await db.rpc(name, args); } catch (_) { fail('membership_financial_store_unavailable'); }
    check(r && !r.error, 'membership_financial_store_unavailable'); return r.data;
  }
  async function row(table, operationId) {
    let r; try { r = await db.from(table).select('*').eq('operation_id', operationId).maybeSingle(); }
    catch (_) { fail('membership_financial_store_unavailable'); }
    check(r && !r.error, 'membership_financial_store_unavailable'); return r.data;
  }
  async function record(table, name, operationId, proof) {
    let ack; try { ack = await db.rpc(name, { p_operation: operationId, p_proof: proof }); }
    catch (_) { /* Read once, never repeat the insert RPC. */ }
    const r = await row(table, operationId);
    check(r?.operation_id === operationId && same(r.proof, proof), 'membership_financial_identity_conflict');
    if (ack && !ack.error) check(ack.data?.operation_id === operationId && ack.data.proof_digest === r.proof_digest,
      'membership_financial_ack_unverified');
    check(['term', 'owner', 'access', 'commission', 'collection'].every(k => r[`${k}_eligible`] === false)); return r;
  }
  async function account(ctx) {
    const a = await provider(() => stripe.accounts.retrieve({}, OPTIONS)), b = await provider(() => stripe.balance.retrieve({}, OPTIONS));
    check(a?.object === 'account' && a.id === ctx.provider_account_id && b?.object === 'balance' && b.livemode === ctx.livemode,
      'membership_financial_provider_mismatch');
  }
  function checkoutProof(s, list, ctx) {
    check(list?.object === 'list' && list.has_more === false && Array.isArray(list.data) && list.data.length >= 1 && list.data.length <= 2);
    const items = list.data.map(l => {
      const p = l.price, product = p?.product;
      check(l.object === 'item' && p?.object === 'price' && p.currency === 'usd' && p.livemode === ctx.livemode && product?.object === 'product'
        && product.deleted !== true && product.livemode === ctx.livemode);
      return { kind: product.metadata?.kind, line_id: l.id, price_id: p.id, product_id: product.id, metadata: product.metadata,
        name: product.name, unit_amount: p.unit_amount, amount_subtotal: l.amount_subtotal, amount_total: l.amount_total,
        quantity: l.quantity, currency: l.currency, price_type: p.type, recurring: p.recurring, amount_discount: l.amount_discount, amount_tax: l.amount_tax };
    }).sort((a, b) => String(a.kind).localeCompare(String(b.kind)));
    return { session_id: s.id, provider_account_id: ctx.provider_account_id, livemode: s.livemode, api_version: VERSION,
      mode: s.mode, currency: s.currency, customer_creation: s.customer_creation, customer_email: s.customer_email,
      client_reference_id: s.client_reference_id, metadata: s.metadata, invoice_metadata: s.invoice_creation?.invoice_data?.metadata,
      success_url: s.success_url, cancel_url: s.cancel_url, expires_at: s.expires_at, automatic_tax_enabled: s.automatic_tax?.enabled,
      amount_discount: s.total_details?.amount_discount, amount_tax: s.total_details?.amount_tax, amount_shipping: s.total_details?.amount_shipping,
      has_more: list.has_more, status: s.status, payment_status: s.payment_status, created: s.created,
      items, amount_subtotal: s.amount_subtotal, amount_total: s.amount_total };
  }
  async function invoiceProof(s, pi, charge) {
    const invoiceId = id(s.invoice); if (!/^in_[A-Za-z0-9_]+$/.test(invoiceId || '')) return null;
    const v = await provider(() => stripe.invoices.retrieve(invoiceId, {}, OPTIONS));
    const lines = await provider(() => stripe.invoices.listLineItems(invoiceId, { limit: 100, expand: ['data.price.product'] }, OPTIONS));
    check(v?.object === 'invoice' && v.id === invoiceId && lines?.object === 'list' && lines.has_more === false && Array.isArray(lines.data)
      && lines.data.length >= 1 && lines.data.length <= 2, 'membership_invoice_graph_held');
    const items = lines.data.map(l => {
      const p = l.price, product = p?.product;
      check(l.object === 'line_item' && p?.object === 'price' && p.currency === 'usd' && product?.object === 'product' && product.deleted !== true,
        'membership_invoice_graph_held');
      return { line_id: l.id, kind: product.metadata?.kind, price_id: p.id, product_id: product.id, unit_amount: p.unit_amount,
        quantity: l.quantity, amount: l.amount, currency: l.currency, price_type: p.type, recurring: p.recurring,
        metadata: product.metadata, name: product.name, livemode: p.livemode, product_livemode: product.livemode,
        type: l.type, subscription: id(l.subscription), subscription_item: id(l.subscription_item),
        discount_amounts: l.discount_amounts, tax_amounts: l.tax_amounts };
    }).sort((a, b) => String(a.kind).localeCompare(String(b.kind)));
    return { invoice_id: v.id, session_invoice: invoiceId, customer_id: id(v.customer), payment_intent_id: id(v.payment_intent),
      charge_id: id(v.charge), charge_invoice: id(charge.invoice), intent_invoice: id(pi.invoice), livemode: v.livemode, currency: v.currency, status: v.status,
      paid: v.paid, paid_out_of_band: v.paid_out_of_band, metadata: v.metadata, amount_due: v.amount_due, amount_paid: v.amount_paid,
      amount_remaining: v.amount_remaining, subtotal: v.subtotal, total: v.total, starting_balance: v.starting_balance,
      ending_balance: v.ending_balance, pre_payment_credit_notes_amount: v.pre_payment_credit_notes_amount,
      post_payment_credit_notes_amount: v.post_payment_credit_notes_amount, discounts: v.discounts,
      total_discount_amounts: v.total_discount_amounts, total_tax_amounts: v.total_tax_amounts, shipping_cost: v.shipping_cost,
      subscription: id(v.subscription), created: v.created, provider_paid_at: v.status_transitions?.paid_at, items, has_more: lines.has_more };
  }
  return Object.freeze({ async observe(input) {
    check(exactInput(input), 'invalid_membership_financial_observation'); version(); const operationId = input.operationId;
    const x = await rpc('membership_v2_financial_context', { p_operation: operationId });
    const ctx = x?.context, op = x?.operation, binding = x?.binding, purchase = x?.purchase;
    check(op?.id === operationId && binding?.operation_id === operationId && op.purchase_id === purchase?.id
      && op.context_id === contextId && ctx?.id === contextId && ctx.environment === environment && purchase.environment === environment
      && ctx.api_version === VERSION && ctx.livemode === (environment === 'production')
      && /^acct_[A-Za-z0-9_]+$/.test(ctx.provider_account_id || '') && binding.provider_account_id === ctx.provider_account_id
      && binding.livemode === ctx.livemode && binding.session_id?.startsWith(ctx.livemode ? 'cs_live_' : 'cs_test_')
      && op.source_digest === purchase.source_digest && Number.isFinite(Date.parse(x.observed_at)));
    await account(ctx);
    const s = await provider(() => stripe.checkout.sessions.retrieve(binding.session_id, {}, OPTIONS));
    const list = await provider(() => stripe.checkout.sessions.listLineItems(binding.session_id, { limit: 100, expand: ['data.price.product'] }, OPTIONS));
    check(s?.object === 'checkout.session' && s.id === binding.session_id && s.invoice_creation?.enabled === true
      && s.allow_promotion_codes === false && same(checkoutProof(s, list, ctx), { ...binding.proof, status: 'complete', payment_status: 'paid' }));
    const piId = id(s.payment_intent), customer = id(s.customer); check(/^pi_[A-Za-z0-9_]+$/.test(piId || '') && /^cus_[A-Za-z0-9_]+$/.test(customer || ''));
    const pi = await provider(() => stripe.paymentIntents.retrieve(piId, {}, OPTIONS));
    check(pi?.object === 'payment_intent' && pi.id === piId);
    const chargeId = id(pi.latest_charge); check(/^ch_[A-Za-z0-9_]+$/.test(chargeId || ''));
    const charge = await provider(() => stripe.charges.retrieve(chargeId, {}, OPTIONS));
    check(charge?.object === 'charge' && charge.id === chargeId && id(charge.payment_intent) === piId && epoch(pi.created) && epoch(charge.created));
    const proof = { checkout: checkoutProof(s, list, ctx), customer_id: customer, payment_intent_id: piId, charge_id: chargeId,
      intent_created: pi.created, charge_created: charge.created, intent_metadata: pi.metadata, intent_status: pi.status,
      intent_currency: pi.currency, intent_amount: pi.amount, intent_amount_received: pi.amount_received,
      intent_customer: id(pi.customer), intent_livemode: pi.livemode, intent_latest_charge: chargeId,
      charge_status: charge.status, charge_paid: charge.paid, charge_captured: charge.captured, charge_amount: charge.amount,
      charge_amount_captured: charge.amount_captured, charge_currency: charge.currency, charge_customer: id(charge.customer),
      charge_livemode: charge.livemode, charge_payment_intent: id(charge.payment_intent), connect: { intent_on_behalf_of: id(pi.on_behalf_of), intent_transfer_data: pi.transfer_data ?? null,
        intent_application_fee_amount: pi.application_fee_amount ?? null, charge_on_behalf_of: id(charge.on_behalf_of),
        charge_transfer_data: charge.transfer_data ?? null, charge_application_fee: id(charge.application_fee),
        charge_application_fee_amount: charge.application_fee_amount ?? null,
        charge_transfer: id(charge.transfer), charge_destination: id(charge.destination) } };
    check(await rpc('membership_v2_capture_proof_matches', { p_operation: operationId, p_proof: proof }) === true);
    await account(ctx);
    const capture = await record('membership_v2_capture_facts', 'membership_v2_record_capture', operationId, proof);
    // Current risks are separate observations. Never subtract a refund from the
    // original capture, or mistake a stored reuse setting for future authority.
    await rpc('membership_v2_record_capture_observation', { p_operation: operationId, p_observation: {
      charge_id: chargeId, amount_refunded: charge.amount_refunded, disputed: charge.disputed,
      capture_method: pi.capture_method, setup_future_usage: pi.setup_future_usage } });
    let clock = await row('membership_v2_paid_invoice_facts', operationId), invoiceHeld = false;
    try {
      const invoice = await invoiceProof(s, pi, charge);
      if (invoice && await rpc('membership_v2_invoice_proof_matches', { p_operation: operationId, p: invoice }) === true) {
        await account(ctx);
        if (await rpc('membership_v2_invoice_clock_ready', { p_operation: operationId, p: invoice }) === true) {
          clock = await record('membership_v2_paid_invoice_facts', 'membership_v2_record_paid_invoice', operationId, invoice);
        } else {
          await rpc('membership_v2_record_capture_observation', { p_operation: operationId,
            p_observation: { kind: 'provider_clock_ahead', invoice_proof: invoice } }); invoiceHeld = true;
        }
      } else invoiceHeld = true;
    } catch (e) {
      // Genuine capture is already committed. A clock outage cannot erase it.
      if (e.code === 'membership_financial_identity_conflict' || e.code === 'membership_financial_ack_unverified') throw e;
      invoiceHeld = true;
    }
    return Object.freeze({ operation_id: operationId, capture_recorded: true, paid_clock_recorded: !!clock,
      invoice_current_observation_held: invoiceHeld, provider_paid_at: clock?.provider_paid_at ?? null,
      account_ownership_verified: false, activation_enabled: false, commission_enabled: false, collection_enabled: false });
  } });
}
module.exports = { createMembershipFinancialFacts };
