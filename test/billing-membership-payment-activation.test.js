'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OFFER_VERSION, buildRetailOffer } = require('../src/services/membershipOffers');
const { proveFirstMembershipPayment, planFirstMembershipActivation } = require('../src/services/membershipPaymentActivation');

const seconds = value => Date.parse(value) / 1000;

// Authenticated provider object SHAPE fixture, not an actual provider acceptance
// test. Every amount/date/identity below is synthetic and no SDK/network is used.
function fixture({ planKey = 'basic', commitmentMonths = 3, paymentOption = 'prepaid', firstRole = false,
  paidAt = '2027-01-31T12:13:14.000Z', tax = 0 } = {}) {
  const offer = buildRetailOffer({ planKey, commitmentMonths, paymentOption, channel: 'sales',
    offerVersion: OFFER_VERSION, firstRolePrepaySelected: firstRole });
  const created = seconds('2027-01-28T12:13:14.000Z');
  const common = { created, livemode: false, customer: 'cus_synthetic' };
  const recurringPrice = { object: 'price', id: 'price_platform', unit_amount: offer.platform_payment_cents,
    currency: 'usd', type: 'recurring', recurring: { ...offer.stripe_recurrence, usage_type: 'licensed' } };
  const taxes = tax ? [{ amount: tax, inclusive: false, tax_rate: 'txr_synthetic' }] : [];
  const line = { id: 'il_platform', type: 'subscription', amount: offer.platform_payment_cents,
    subscription: 'sub_synthetic', subscription_item: 'si_platform', price: recurringPrice,
    currency: 'usd', quantity: 1, proration: false, discount_amounts: [], tax_amounts: taxes };
  const lines = [line];
  if (firstRole) lines.push({ ...line, id: 'il_firstrole', type: 'invoiceitem', subscription: null,
    subscription_item: null, amount: offer.first_role_prepay.amount_cents, tax_amounts: [],
    price: { object: 'price', id: 'price_firstrole', unit_amount: offer.first_role_prepay.amount_cents,
      currency: 'usd', type: 'one_time', recurring: null } });
  const amount = offer.initial_payment_cents + tax;
  return {
    binding: { contractId: 'synthetic-contract', contractVersion: 1, offer, livemode: false,
      checkoutSessionId: 'cs_synthetic', customerId: 'cus_synthetic', subscriptionId: 'sub_synthetic',
      platformItemId: 'si_platform', platformPriceId: 'price_platform', firstRolePriceId: firstRole ? 'price_firstrole' : null },
    checkout: { ...common, object: 'checkout.session', id: 'cs_synthetic', mode: 'subscription',
      subscription: 'sub_synthetic', invoice: 'in_initial', currency: 'usd',
      status: 'complete', payment_status: 'paid', amount_total: amount },
    subscription: { ...common, object: 'subscription', id: 'sub_synthetic', currency: 'usd',
      items: { has_more: false, data: [{ id: 'si_platform', subscription: 'sub_synthetic', quantity: 1, price: recurringPrice }] } },
    invoice: { ...common, object: 'invoice', id: 'in_initial', subscription: 'sub_synthetic',
      payment_intent: 'pi_initial', charge: 'ch_initial', currency: 'usd',
      billing_reason: 'subscription_create', status: 'paid', paid: true, paid_out_of_band: false,
      collection_method: 'charge_automatically', amount_due: amount, amount_paid: amount,
      amount_remaining: 0, starting_balance: 0, ending_balance: 0,
      pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0,
      discounts: [], total_discount_amounts: [], total_tax_amounts: taxes,
      subtotal: offer.initial_payment_cents, total: amount, tax,
      status_transitions: { paid_at: seconds(paidAt) },
      lines: { has_more: false, data: lines, total_count: lines.length } },
    paymentIntent: { ...common, object: 'payment_intent', id: 'pi_initial', invoice: 'in_initial',
      latest_charge: 'ch_initial', currency: 'usd', status: 'succeeded', amount, amount_received: amount },
    charge: { ...common, object: 'charge', id: 'ch_initial', invoice: 'in_initial', payment_intent: 'pi_initial',
      currency: 'usd', status: 'succeeded', paid: true, captured: true, amount, amount_captured: amount,
      amount_refunded: 0, refunded: false, disputed: false },
    observedAt: seconds('2027-02-10T00:00:00.000Z')
  };
}

for (const planKey of ['basic', 'pro']) {
  for (const commitmentMonths of [3, 6, 12]) {
    for (const paymentOption of ['prepaid', 'monthly_installments']) {
      test(`first paid ${planKey}/${commitmentMonths}/${paymentOption} gets its full accepted term`, () => {
        const input = fixture({ planKey, commitmentMonths, paymentOption });
        const result = planFirstMembershipActivation(input);
        assert.equal(result.action, 'reserve_initial_activation');
        assert.equal(result.activation.original_start_at, '2027-01-31T12:13:14.000Z');
        const ends = { 3: '2027-04-30', 6: '2027-07-31', 12: '2028-01-31' };
        assert.equal(result.activation.term_end_at, `${ends[commitmentMonths]}T12:13:14.000Z`);
        assert.equal(result.activation.initial_paid_access_end_at, paymentOption === 'prepaid'
          ? result.activation.term_end_at : '2027-02-28T12:13:14.000Z');
        assert.equal(result.activation.platform_payment_cents, input.binding.offer.platform_payment_cents);
        assert.equal(result.renewal_ready, false);
        assert.equal(result.provider_alignment, 'requires_verified_executor');
      });
    }
  }
}

test('delayed bank success and much later webhook delivery do not use creation or delivery as term start', () => {
  const early = fixture();
  const late = structuredClone(early);
  late.observedAt = seconds('2027-03-20T00:00:00.000Z');
  // Metadata is deliberately misleading: only the object graph owns this receipt.
  late.invoice.metadata = { term_start: '2000-01-01', contract_id: 'foreign', platform_amount: '1' };
  assert.deepEqual(planFirstMembershipActivation(late), planFirstMembershipActivation(early));
  assert.notEqual(planFirstMembershipActivation(late).activation.original_start_at,
    new Date(late.invoice.created * 1000).toISOString());
});

test('same immutable initial activation is no-write even after later renewal and preference changes', () => {
  const input = fixture();
  const activation = planFirstMembershipActivation(input).activation;
  const currentState = { initialActivation: activation, term_index: 3, auto_renew: false,
    access_end_at: '2028-01-31T12:13:14.000Z', intent_version: 8 };
  const before = structuredClone(currentState);
  assert.deepEqual(planFirstMembershipActivation({ ...input, existingActivation: currentState.initialActivation }),
    { action: 'already_activated' });
  assert.deepEqual(currentState, before);
  assert.ok(Object.isFrozen(activation));
  assert.throws(() => { activation.original_start_at = '2000-01-01'; }, TypeError);
});

test('conflicting original receipt, contract version, or start is held rather than reset', () => {
  const input = fixture();
  const original = planFirstMembershipActivation(input).activation;
  for (const patch of [{ invoice_id: 'in_other' }, { contract_version: 2 },
    { original_start_at: '2027-01-28T12:13:14.000Z' }, { first_role_payment_cents: 1 },
    { term_end_at: '2027-05-01T12:13:14.000Z' }]) {
    assert.throws(() => planFirstMembershipActivation({ ...input, existingActivation: { ...original, ...patch } }),
      { code: 'conflicting_initial_activation' });
  }
});

test('first-role and native tax are proved separately, not included in platform renewal/commission amount', () => {
  const input = fixture({ planKey: 'pro', firstRole: true, tax: 15000 });
  const result = proveFirstMembershipPayment(input);
  assert.equal(result.platform_payment_cents, 210000);
  assert.equal(result.first_role_payment_cents, 62900);
  assert.equal(result.tax_cents, 15000);
  assert.equal(result.collected_cents, 287900);
});

const rejectCases = [
  ['processing', input => { input.paymentIntent.status = 'processing'; }, 'initial_payment_not_succeeded'],
  ['partial payment', input => { input.paymentIntent.amount_received--; }, 'initial_payment_not_succeeded'],
  ['manual paid', input => { input.invoice.paid_out_of_band = true; }, 'initial_invoice_not_fully_collected'],
  ['not paid', input => { input.invoice.status = 'open'; }, 'initial_invoice_not_fully_collected'],
  ['zero invoice', input => { input.invoice.amount_due = 0; }, 'initial_invoice_not_fully_collected'],
  ['customer credit', input => { input.invoice.starting_balance = -100; }, 'initial_invoice_not_fully_collected'],
  ['credit note', input => { input.invoice.post_payment_credit_notes_amount = 100; }, 'initial_invoice_not_fully_collected'],
  ['coupon', input => { input.invoice.discounts = ['di_coupon']; }, 'initial_invoice_not_fully_collected'],
  ['refund', input => { input.charge.amount_refunded = 1; }, 'initial_payment_not_succeeded'],
  ['dispute', input => { input.charge.disputed = true; }, 'initial_payment_not_succeeded'],
  ['wrong customer', input => { input.charge.customer = 'cus_other'; }, 'initial_provider_identity_mismatch'],
  ['wrong mode', input => { input.paymentIntent.livemode = true; }, 'initial_provider_identity_mismatch'],
  ['wrong subscription', input => { input.invoice.subscription = 'sub_other'; }, 'initial_provider_link_mismatch'],
  ['wrong checkout invoice', input => { input.checkout.invoice = 'in_other'; }, 'initial_provider_link_mismatch'],
  ['wrong PI invoice', input => { input.paymentIntent.invoice = 'in_other'; }, 'initial_provider_link_mismatch'],
  ['wrong charge PI', input => { input.charge.payment_intent = 'pi_other'; }, 'initial_provider_link_mismatch'],
  ['foreign currency', input => { input.invoice.currency = 'eur'; }, 'initial_currency_mismatch'],
  ['renewal instead of initial', input => { input.invoice.billing_reason = 'subscription_cycle'; }, 'initial_invoice_not_fully_collected'],
  ['incomplete lines', input => { input.invoice.lines.has_more = true; }, 'initial_lines_incomplete'],
  ['incomplete subscription items', input => { input.subscription.items.has_more = true; }, 'initial_items_incomplete'],
  ['unknown line', input => { input.invoice.lines.data.push({ id: 'il_unknown' }); }, 'initial_lines_incomplete'],
  ['wrong platform price', input => { input.invoice.lines.data[0].price = { ...input.invoice.lines.data[0].price, id: 'price_other' }; }, 'initial_price_mismatch'],
  ['wrong platform amount', input => { input.invoice.lines.data[0].amount--; }, 'initial_platform_amount_mismatch'],
  ['wrong recurrence', input => { input.subscription.items.data[0].price.recurring.interval_count = 6; }, 'initial_recurrence_mismatch'],
  ['unknown tax', input => { input.invoice.total++; }, 'initial_invoice_not_fully_collected'],
  ['missing success time', input => { input.invoice.status_transitions.paid_at = null; }, 'initial_payment_time_unverified'],
  ['before creation', input => { input.invoice.status_transitions.paid_at = input.invoice.created - 1; }, 'initial_payment_time_unverified'],
  ['future success', input => { input.invoice.status_transitions.paid_at = input.observedAt + 1; }, 'initial_payment_time_unverified'],
  ['timestamp string', input => { input.invoice.status_transitions.paid_at = String(input.invoice.status_transitions.paid_at); }, 'initial_payment_time_unverified'],
  ['invalid observed time', input => { input.observedAt = Infinity; }, 'initial_payment_time_unverified']
];
for (const [label, mutate, code] of rejectCases) {
  test(`${label} cannot start or extend a v2 paid term`, () => {
    const input = structuredClone(fixture());
    mutate(input);
    assert.throws(() => planFirstMembershipActivation(input), { code });
  });
}

test('bad price/tax on the one-time first-role line fails closed', () => {
  const input = structuredClone(fixture({ firstRole: true, tax: 100 }));
  input.invoice.lines.data[1].price.id = 'price_other';
  assert.throws(() => planFirstMembershipActivation(input), { code: 'initial_price_mismatch' });
  const wrongTax = structuredClone(fixture({ tax: 100 }));
  wrongTax.invoice.lines.data[0].tax_amounts[0].amount = 99;
  assert.throws(() => planFirstMembershipActivation(wrongTax), { code: 'initial_total_mismatch' });
});

test('accepted past catalog versions remain authoritative, without consulting current catalog', () => {
  const input = structuredClone(fixture());
  input.binding.offer.offer_version = 'previously-accepted-v2';
  assert.equal(planFirstMembershipActivation(input).activation.offer_version, 'previously-accepted-v2');
  const legacy = structuredClone(input);
  legacy.binding.offer.schema_version = 1;
  assert.throws(() => planFirstMembershipActivation(legacy), { code: 'unsupported_payment_start_contract' });
});

test('leap-day successful payment receives the full twelve calendar months', () => {
  const input = fixture({ commitmentMonths: 12, paidAt: '2028-02-29T01:02:03.000Z' });
  input.observedAt = seconds('2028-03-02T00:00:00.000Z');
  const result = planFirstMembershipActivation(input);
  assert.equal(result.activation.term_end_at, '2029-02-28T01:02:03.000Z');
  assert.equal(result.activation.renewal_reminder_at, '2029-01-29T01:02:03.000Z');
});
