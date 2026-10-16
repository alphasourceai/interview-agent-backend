'use strict';
// Authored GET graph and native-shaped responses, NOT cash or SQL acceptance.
const assert = require('node:assert/strict');
const accepted = require('./accepted-enterprise-usage-fixture');
const { anchoredMonthInstant } = require('../../src/services/membershipOffers');
const clone = v => structuredClone(v);
module.exports = async function fixture(t, { cadence = 'monthly', ordinal = 1, prefix = ordinal, manual = false } = {}) {
  const f = await accepted({ cadence }), native = f.nativeFixture, w = f.w, p = w.funding_receipt.proof;
  const step = cadence === 'annual' ? 12 : 1, original = new Date(w.subscription.current_period_end * 1000).toISOString();
  const anchor = Date.parse(anchoredMonthInstant(original, (ordinal - 1) * step)) / 1000;
  const end = Date.parse(anchoredMonthInstant(original, ordinal * step)) / 1000, paid = anchor + 60, gross = p.platform_nominal_cents;
  const price = { object: 'price', id: p.platform_price_id, livemode: p.livemode, currency: 'usd', unit_amount: gross,
    type: 'recurring', recurring: { interval: p.platform_interval, interval_count: 1, usage_type: 'licensed' },
    billing_scheme: 'per_unit', transform_quantity: null, tiers_mode: null, custom_unit_amount: null };
  const invoice = { object: 'invoice', id: 'in_LOCAL_CYCLE', customer: p.customer_id, subscription: p.subscription_id, livemode: p.livemode,
    currency: 'usd', billing_reason: 'subscription_cycle', collection_method: 'charge_automatically', subtotal: gross, total: gross,
    amount_due: gross, amount_paid: gross, amount_remaining: 0, paid: true, status: 'paid', paid_out_of_band: false,
    starting_balance: 0, ending_balance: 0, pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0,
    application_fee_amount: null, transfer_data: null, on_behalf_of: null, shipping_cost: null, total_discount_amounts: [],
    total_tax_amounts: [], created: anchor, status_transitions: { paid_at: paid }, payment_intent: 'pi_LOCAL_CYCLE', charge: 'ch_LOCAL_CYCLE' };
  const line = { object: 'line_item', id: 'il_LOCAL_CYCLE', type: 'subscription', proration: false, quantity: 1, currency: 'usd',
    subscription: p.subscription_id, subscription_item: p.platform_item_id, price, amount: gross,
    period: { start: anchor, end }, discount_amounts: [], tax_amounts: [] };
  const common = { customer: p.customer_id, livemode: p.livemode, currency: 'usd', amount: gross, created: anchor,
    invoice: invoice.id, payment_method: 'pm_LOCAL_CYCLE' };
  const pi = { ...common, object: 'payment_intent', id: invoice.payment_intent, latest_charge: invoice.charge, status: 'succeeded', amount_received: gross };
  const charge = { ...common, object: 'charge', id: invoice.charge, payment_intent: pi.id, status: 'succeeded', paid: true,
    captured: true, amount_captured: gross, amount_refunded: 0, refunded: false, disputed: false };
  Object.assign(native.a, { superseded_by_agreement_id: null });
  Object.assign(native.pool, { status: 'paid', paid_at: p.payment_success_at, stripe_payment_intent_id: p.payment_intent_id });
  const calls = [], list = data => ({ object: 'list', data, has_more: false });
  const x = { invoice, line, pi, charge, refunds: [], account: { object: 'account', id: p.provider_account_id } };
  const get = (kind, fn) => async (...args) => { calls.push({ kind, args }); return clone(fn(...args)); };
  const forbidden = () => { throw Error('provider mutation forbidden'); };
  const stripe = { getApiField: () => '2023-10-16', accounts: { retrieve: get('account', () => x.account) },
    invoices: { retrieve: get('invoice', () => x.invoice), listLineItems: get('lines', () => list([x.line])), pay: forbidden, update: forbidden },
    paymentIntents: { retrieve: get('pi', () => x.pi) }, charges: { retrieve: get('charge', () => x.charge) },
    refunds: { list: get('refunds', () => list(x.refunds)) }, subscriptions: { update: forbidden, cancel: forbidden } };
  const stamp = sec => new Date(sec * 1000).toISOString().replace(/Z$/, '000Z');
  const digest = '0123456789abcdef0123456789abcdef', rpcCalls = [], state = { native, x, calls, stripe, rpcCalls, persisted: 0, refreshes: 0 };
  native.db.tables.billing_invoices = [];
  native.db.rpc = async (name, args) => {
    rpcCalls.push({ name, args: clone(args) });
    if (state.beforeRpc) await state.beforeRpc(name, args);
    let data;
    if (name === 'read_enterprise_existing_billing') data = clone(native.a.enterprise_billing_receipt);
    else if (name === 'record_enterprise_existing_paid_period') {
      assert.deepEqual(clone(args.p_billing), w);
      const prior = native.db.tables.billing_invoices[0];
      if (prior) assert.deepEqual(prior.enterprise_period_receipt.proof, clone(args.p_proof));
      const receipt = prior?.enterprise_period_receipt || { version: 'enterprise_existing_paid_period_receipt_v1', source: clone(w),
        source_digest: digest, proof: clone(args.p_proof), recorded_at: stamp(paid + 1) };
      if (!prior) { native.db.tables.billing_invoices.push({ id: '10000000-0000-4000-8000-000000000042',
        billing_customer_id: native.db.tables.billing_customers[0].id, stripe_invoice_id: invoice.id, currency: 'usd',
        amount_total_cents: gross, status: 'paid', retail_period_receipt: null, enterprise_period_receipt: clone(receipt) }); state.persisted++; }
      data = { status: prior ? 'already_recorded' : 'recorded', invoice_id: native.db.tables.billing_invoices[0].id, receipt: clone(receipt) };
    } else if (name === 'refresh_enterprise_existing_paid_coverage') {
      state.refreshes++;
      data = { version: 'enterprise_existing_paid_coverage_v1', agreement_id: native.a.id, client_id: native.client.id,
        billing_source_digest: digest, contiguous_ordinal: prefix, funded_from: stamp(Date.parse(p.payment_success_at) / 1000),
        funded_through: stamp(Date.parse(anchoredMonthInstant(original, prefix * step)) / 1000), observed_at: stamp(paid + 2),
        provider_effect_authorized: false, paid_access_authorized: false, payroll_authorized: false,
        status: manual ? 'manual_override' : 'refreshed', [manual ? 'computed_billing_status' : 'billing_status']: prefix === ordinal ? 'active' : 'inactive' };
    } else throw Error('unapproved native operation');
    const result = { data, error: null };
    if (state.afterRpc) await state.afterRpc(name, result);
    return result;
  };
  t.mock.method(Date, 'now', () => (paid + 3) * 1000);
  state.args = { db: native.db, stripe, agreementId: native.a.id, clientId: native.client.id, invoiceId: invoice.id };
  return state;
};
