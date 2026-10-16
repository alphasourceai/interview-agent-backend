'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { proveEnterprisePoolPayment: prove } = require('../src/services/enterprisePoolPaymentProof');
const { quoteEnterprisePoolOffer } = require('../src/services/enterprisePoolOffers');
const fixture = require('./helpers/enterprise-pool-payment-fixture');

for (const amount of [0, 1, 7000, 10000]) {
  test(`positive pool within fully collected initial prorated platform ${amount}c`, () => {
    const input = fixture({ platformAmount: amount }), before = structuredClone(input);
    const result = prove(input);
    assert.equal(result.platform_line_cents, amount);
    assert.equal(result.pool_paid_cents, 69750);
    assert.equal(result.collected_cents, 69750 + amount);
    assert.equal(result.payment_success_at, '2027-01-01T01:00:00.000Z');
    assert.equal(result.credits_spendable, false);
    assert.equal(result.membership_activation_required, true);
    assert.equal(result.native_receipt_required, true);
    assert.equal(result.pool_line_id, 'il_pool');
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(input, before);
    assert.throws(() => { result.quantity = 300; }, TypeError);
    for (const k of ['term_start_at', 'term_end_at', 'auto_renew', 'commission', 'activated']) {
      assert.equal(Object.hasOwn(result, k), false);
    }
  });
}
test('non-prorated platform must equal nominal, not an invented partial amount', () => {
  assert.equal(prove(fixture({ platformAmount: 10000, proration: false })).platform_line_cents, 10000);
  assert.throws(() => prove(fixture({ platformAmount: 7000, proration: false })),
    { code: 'pool_proof_platform_line_mismatch', status: 409 });
});
test('API2023 may omit embedded charge refunds when the fresh refund collection is complete', () => {
  const input = fixture();
  delete input.charge.refunds;
  assert.equal(prove(input).pool_paid_cents, 69750);
});
test('API2023 initial platform proration may be an invoiceitem linked to its subscription item', () => {
  const input = fixture({ platformCents: 30000, platformAmount: 15442 });
  Object.assign(input.invoice.lines.data[0], { type: 'invoiceitem', invoice_item: 'ii_platform' });
  const result = prove(input);
  assert.equal(result.platform_line_cents, 15442);
  assert.equal(result.collected_cents, 85192);
  assert.equal(result.platform_nominal_cents, 30000);
});
test('observed API2023 invoiceitem proration and omitted embedded refunds compose', () => {
  const input = fixture({ platformCents: 30000, platformAmount: 15442 });
  Object.assign(input.invoice.lines.data[0], { type: 'invoiceitem', invoice_item: 'ii_platform' });
  delete input.charge.refunds;
  assert.equal(prove(input).collected_cents, 85192);
});
for (const omitted of [[0], [1], [0, 1]]) {
  test(`API2023 Checkout may omit optional discounts on lines ${omitted}`, () => {
    const input = fixture({ platformCents: 30000, platformAmount: 15442 });
    Object.assign(input.invoice.lines.data[0], { type: 'invoiceitem', invoice_item: 'ii_platform' });
    delete input.charge.refunds;
    for (const index of omitted) delete input.checkoutLines.data[index].discounts;
    const proof = prove(input);
    assert.equal(proof.collected_cents, 85192); assert.equal(proof.pool_paid_cents, 69750);
    assert.equal(proof.platform_line_cents, 15442);
  });
}
for (const [label, change] of [
  ['own undefined discounts', l => { l.discounts = undefined; }],
  ['malformed discounts', l => { l.discounts = {}; }],
  ['nonempty discounts', l => { l.discounts = [{ id: 'di_other' }]; }],
  ['nonzero discount amount', l => { l.amount_discount = 1; }],
  ['missing discount amount', l => { delete l.amount_discount; }],
  ['incorrect subtotal', l => { l.amount_subtotal++; }],
  ['incorrect tax', l => { l.amount_tax++; }],
  ['incorrect total', l => { l.amount_total++; }]
]) for (const index of [0, 1]) {
  test(`omitted Checkout discounts still holds ${label} on line ${index}`, () => {
    const input = fixture();
    for (const line of input.checkoutLines.data) delete line.discounts;
    change(input.checkoutLines.data[index]);
    assert.throws(() => prove(input), { code: 'pool_proof_checkout_line_mismatch', status: 409 });
  });
}
for (const index of [0, 1]) test(`omitted Checkout discounts still holds foreign price on line ${index}`, () => {
  const input = fixture();
  for (const line of input.checkoutLines.data) delete line.discounts;
  input.checkoutLines.data[index].price = { ...input.checkoutLines.data[index].price, id: 'price_foreign' };
  assert.throws(() => prove(input), { code: 'pool_proof_mixed_lines', status: 409 });
});
for (const index of [0, 1]) test(`omitted Checkout discounts still holds altered pinned unit price on line ${index}`, () => {
  const input = fixture();
  for (const line of input.checkoutLines.data) delete line.discounts;
  const line = input.checkoutLines.data[index];
  line.price = { ...line.price, unit_amount: line.price.unit_amount + 1 };
  assert.throws(() => prove(input), { code: 'pool_proof_price_mismatch', status: 409 });
});
test('nonprorated invoiceitem is held even when its amount equals the accepted nominal', () => {
  const input = fixture({ platformCents: 30000, platformAmount: 30000, proration: false });
  Object.assign(input.invoice.lines.data[0], { type: 'invoiceitem', invoice_item: 'ii_platform' });
  assert.throws(() => prove(input), { code: 'pool_proof_platform_line_mismatch', status: 409 });
});
for (const [label, change] of [
  ['missing fresh collection', p => { delete p.refunds; }],
  ['incomplete fresh collection', p => { p.refunds.has_more = true; }],
  ['nonempty fresh collection', p => { p.refunds.data.push({ id: 're_pending' }); }],
  ['explicit undefined embedded collection', p => { p.charge.refunds = undefined; }],
  ['malformed embedded collection', p => { p.charge.refunds = {}; }]
]) {
  test(`omitted optional embedded refunds still holds ${label}`, () => {
    const input = fixture(); delete input.charge.refunds; change(input);
    assert.throws(() => prove(input), { code: 'pool_proof_incomplete_list', status: 409 });
  });
}
for (const [label, change, code = 'pool_proof_platform_line_mismatch'] of [
  ['nonprorated invoiceitem', l => { l.proration = false; }],
  ['missing invoice item id', l => { delete l.invoice_item; }],
  ['malformed invoice item id', l => { l.invoice_item = 'price_wrong'; }],
  ['empty invoice item id', l => { l.invoice_item = 'ii_'; }],
  ['foreign subscription', l => { l.subscription = 'sub_other'; }],
  ['foreign subscription item', l => { l.subscription_item = 'si_other'; }],
  ['foreign accepted price', l => { l.price.id = 'price_other'; }, 'pool_proof_price_mismatch'],
  ['above accepted nominal amount', l => { l.amount = 30001; }],
  ['negative proration', l => { l.amount = -1; }, 'pool_proof_invoice_line_mismatch']
]) {
  test(`API2023 prorated invoiceitem still holds ${label}`, () => {
    const input = fixture({ platformCents: 30000, platformAmount: 15442 });
    const line = input.invoice.lines.data[0];
    Object.assign(line, { type: 'invoiceitem', invoice_item: 'ii_platform' });
    change(line);
    assert.throws(() => prove(input), { code, status: 409 });
  });
}
test('actual exclusive pool and platform taxes reconcile separately', () => {
  const result = prove(fixture({ tax: 700, poolTax: 6975 }));
  assert.equal(result.pool_paid_cents, 69750);
  assert.equal(result.platform_line_cents, 7000);
  assert.equal(result.pool_tax_cents, 6975);
  assert.equal(result.tax_cents, 7675);
  assert.equal(result.collected_cents, 84425);
});
test('native zero tax permits missing/null scalar only after full arrays prove zero', () => {
  for (const value of [null, undefined]) {
    const input = fixture(); input.invoice.tax = value;
    assert.equal(prove(input).tax_cents, 0);
    const taxed = fixture({ poolTax: 1 }); taxed.invoice.tax = value;
    assert.throws(() => prove(taxed), { code: 'pool_proof_invoice_total_mismatch', status: 409 });
  }
});
test('half-cent and separately accepted coupon never reprice using legacy net rounding', () => {
  const input = fixture({ quantity: 51, unit: 5 });
  assert.equal(prove(input).pool_paid_cents, 229);
  const snapshot = quoteEnterprisePoolOffer({ quantity: 51, acceptedUnitPriceCents: 5,
    authorizedAutomaticPercent: 10, authorizedCouponCents: 29 });
  input.binding.snapshot = snapshot;
  input.binding.digest = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const pool = input.invoice.lines.data[1], cli = input.checkoutLines.data[1], delta = 29;
  pool.amount = snapshot.net_cents;
  pool.price.unit_amount = snapshot.net_cents; pool.price.unit_amount_decimal = String(snapshot.net_cents);
  cli.amount_subtotal = snapshot.net_cents; cli.amount_total = snapshot.net_cents;
  input.invoice.subtotal -= delta; input.invoice.total -= delta;
  input.invoice.amount_due -= delta; input.invoice.amount_paid -= delta;
  input.checkout.amount_subtotal -= delta; input.checkout.amount_total -= delta;
  input.paymentIntent.amount -= delta; input.paymentIntent.amount_received -= delta;
  input.charge.amount -= delta; input.charge.amount_captured -= delta;
  assert.equal(prove(input).pool_paid_cents, 200);
  assert.equal(prove(input).offer_digest, input.binding.digest);
});
test('later observations and deceptive metadata do not reset payment time or accepted money', () => {
  const input = fixture(), result = prove(input);
  input.observedAt += 86400 * 60;
  for (const k of ['checkout', 'subscription', 'invoice', 'paymentIntent', 'charge']) {
    input[k].metadata = { pool_id: 'foreign', amount: '1', paid_at: '1999-01-01', client_id: 'foreign' };
  }
  assert.deepEqual(prove(input), result);
});

function held(label, mutate) {
  test(`hold: ${label}`, () => {
    const input = fixture(); mutate(input);
    assert.throws(() => prove(input), e => e.status === 409 && typeof e.code === 'string');
  });
}
for (const field of ['poolId', 'clientId', 'providerAccountId', 'customerId', 'checkoutSessionId',
  'subscriptionId', 'platformItemId', 'platformPriceId', 'poolPriceId']) {
  held(`missing binding ${field}`, p => { delete p.binding[field]; });
}
held('unvalidated snapshot digest', p => { p.binding.digest = '0'.repeat(64); });
held('fractional nominal platform', p => { p.binding.platformCents = 10000.5; });
held('zero nominal platform requires separate reviewed policy', p => { p.binding.platformCents = 0; });
held('unknown price aliases', p => { p.binding.poolPriceId = p.binding.platformPriceId; });
held('foreign authenticated account', p => { p.account.id = 'acct_other'; });
for (const kind of ['checkout', 'subscription', 'invoice', 'paymentIntent', 'charge']) {
  for (const field of ['object', 'customer', 'currency', 'livemode']) {
    held(`${kind} wrong ${field}`, p => { p[kind][field] = field === 'livemode' ? true : 'foreign'; });
  }
  held(`${kind} created after payment`, p => { p[kind].created = p.invoice.status_transitions.paid_at + 1; });
}
for (const [kind, field] of [['checkout', 'subscription'], ['checkout', 'invoice'],
  ['invoice', 'subscription'], ['invoice', 'payment_intent'], ['invoice', 'charge'],
  ['paymentIntent', 'invoice'], ['paymentIntent', 'latest_charge'], ['charge', 'invoice'], ['charge', 'payment_intent']]) {
  held(`${kind} foreign ${field} link`, p => { p[kind][field] = 'foreign'; });
}
held('invalid paid-at', p => { p.invoice.status_transitions.paid_at = null; });
held('payment in future', p => { p.observedAt = p.invoice.status_transitions.paid_at - 1; });
held('unsupported epoch range', p => { p.observedAt = 253402300800; });
held('checkout only completed, not paid', p => { p.checkout.payment_status = 'unpaid'; });
held('not subscription mode', p => { p.checkout.mode = 'payment'; });
held('different succeeded PaymentIntent on session cannot substitute for native invoice link',
  p => { p.checkout.payment_intent = 'pi_different'; });
held('subscription incomplete', p => { p.subscription.status = 'incomplete'; });
held('provider subscription coupon object', p => { p.subscription.discount = { id: 'di_synthetic' }; });
held('provider subscription promotion list', p => { p.subscription.discounts = ['di_synthetic']; });
held('provider item coupon', p => { p.subscription.items.data[0].discounts = ['di_synthetic']; });
held('provider Checkout discount breakdown', p => {
  p.checkout.total_details.breakdown = { discounts: [{ amount: 0, discount: { id: 'di_synthetic' } }] };
});
for (const [field, value] of Object.entries({ billing_reason: 'subscription_cycle', paid: false,
  paid_out_of_band: true, status: 'open', collection_method: 'send_invoice', amount_paid: 1,
  amount_remaining: 1, starting_balance: 1, ending_balance: 1,
  pre_payment_credit_notes_amount: 1, post_payment_credit_notes_amount: 1,
  discounts: ['di_synthetic'], total_discount_amounts: [{ amount: 1 }] })) {
  held(`invoice ${field}`, p => { p.invoice[field] = value; });
}
for (const [kind, field, value] of [['paymentIntent', 'status', 'processing'],
  ['paymentIntent', 'amount_received', 1], ['charge', 'status', 'failed'], ['charge', 'paid', false],
  ['charge', 'captured', false], ['charge', 'amount_captured', 1], ['charge', 'refunded', true],
  ['charge', 'amount_refunded', 1], ['charge', 'disputed', true], ['charge', 'dispute', 'dp_synthetic']]) {
  held(`${kind} ${field}`, p => { p[kind][field] = value; });
}
held('pending or failed refund history exists', p => { p.charge.refunds.data = [{ id: 're_synthetic', status: 'failed' }]; });
for (const kind of ['checkoutLines', 'subscriptionItems', 'invoiceLines', 'refunds']) {
  const read = p => ({ checkoutLines: p.checkoutLines, subscriptionItems: p.subscription.items,
    invoiceLines: p.invoice.lines, refunds: p.charge.refunds })[kind];
  held(`${kind} truncated`, p => { read(p).has_more = true; });
  held(`${kind} missing completeness`, p => { delete read(p).has_more; });
}
held('duplicate invoice line', p => { p.invoice.lines.data[1].id = p.invoice.lines.data[0].id; });
held('duplicate Checkout line', p => { p.checkoutLines.data[1].id = p.checkoutLines.data[0].id; });
held('unowned extra invoice line', p => { p.invoice.lines.data.push({ ...p.invoice.lines.data[1], id: 'il_extra' }); });
held('unowned extra Checkout line', p => { p.checkoutLines.data.push({ ...p.checkoutLines.data[1], id: 'li_extra' }); });
held('pool absent from invoice', p => { p.invoice.lines.data[1].price = { ...p.invoice.lines.data[1].price, id: 'price_other' }; });
held('pool line quantity two', p => { p.invoice.lines.data[1].quantity = 2; });
held('pool amount differs', p => { p.invoice.lines.data[1].amount -= 1; });
held('pool line is prorated', p => { p.invoice.lines.data[1].proration = true; });
held('pool owns subscription item', p => { p.invoice.lines.data[1].subscription_item = 'si_platform'; });
held('foreign pool invoice', p => { p.invoice.lines.data[1].invoice = 'in_other'; });
held('pool hidden line discount', p => { p.invoice.lines.data[1].discounts = ['di_synthetic']; });
held('pool discount amount', p => { p.invoice.lines.data[1].discount_amounts = [{ amount: 1 }]; });
held('platform overcharge', p => { p.invoice.lines.data[0].amount = 10001; });
held('platform negative proration', p => { p.invoice.lines.data[0].amount = -1; });
held('platform foreign item', p => { p.invoice.lines.data[0].subscription_item = 'si_other'; });
held('native subscription wrong quantity', p => { p.subscription.items.data[0].quantity = 2; });
for (const [field, value] of Object.entries({ unit_amount: 1, unit_amount_decimal: '1',
  currency: 'eur', livemode: true, recurring: { interval: 'month' }, type: 'recurring',
  billing_scheme: 'tiered', transform_quantity: { divide_by: 2 }, tiers_mode: 'graduated',
  custom_unit_amount: { enabled: true }, created: 253402300800 })) {
  held(`native pool Price ${field}`, p => { p.invoice.lines.data[1].price[field] = value; });
}
held('Checkout independent wrong price', p => { p.checkoutLines.data[1].price = { ...p.checkoutLines.data[1].price, unit_amount: 1 }; });
held('Checkout pool quantity', p => { p.checkoutLines.data[1].quantity = 2; });
held('Checkout pool discount', p => { p.checkoutLines.data[1].amount_discount = 1; });
held('Checkout incomplete total', p => { p.checkout.amount_total -= 1; });
held('Checkout shipping', p => { p.checkout.total_details.amount_shipping = 1; });
held('Checkout unrestricted discount', p => { p.checkout.total_details.amount_discount = 1; });
held('inclusive tax', p => { p.invoice.lines.data[1].tax_amounts = [{ amount: 1, inclusive: true, tax_rate: 'txr_synthetic' }]; });
held('unknown tax rate', p => { p.invoice.lines.data[1].tax_amounts = [{ amount: 1, inclusive: false, tax_rate: 'unknown' }]; });
held('missing tax array', p => { delete p.invoice.total_tax_amounts; });
held('unreconciled tax', p => { p.invoice.total_tax_amounts = [{ amount: 1, inclusive: false, tax_rate: 'txr_synthetic' }]; });
held('invoice subtotal fabricated', p => { p.invoice.subtotal += 1; });
held('native line page count inconsistent', p => { p.invoice.lines.total_count = 3; });
for (const [kind, fields] of Object.entries({ checkout: ['amount_subtotal', 'amount_total'],
  invoice: ['subtotal', 'tax', 'total', 'amount_due', 'amount_paid'],
  paymentIntent: ['amount', 'amount_received'], charge: ['amount', 'amount_captured'] })) {
  for (const field of fields) for (const value of [-1, 0.5, 2147483648]) {
    held(`${kind}.${field} invalid money ${value}`, p => { p[kind][field] = value; });
  }
}
test('review counterexample cannot prove pool money against zero or negative collected total', () => {
  const input = fixture({ platformAmount: 0 });
  input.invoice.tax = -input.binding.snapshot.net_cents;
  input.invoice.total_tax_amounts = [{ amount: input.invoice.tax, inclusive: false, tax_rate: 'txr_synthetic' }];
  input.invoice.lines.data[1].tax_amounts = input.invoice.total_tax_amounts;
  input.invoice.total = input.invoice.amount_due = input.invoice.amount_paid = 0;
  input.paymentIntent.amount = input.paymentIntent.amount_received = 0;
  input.charge.amount = input.charge.amount_captured = 0;
  input.checkout.amount_total = 0;
  assert.throws(() => prove(input), e => e.status === 409);
  for (const value of [0, -1]) {
    const reduced = fixture();
    reduced.charge.amount = reduced.charge.amount_captured = value;
    assert.throws(() => prove(reduced), { code: 'pool_proof_collection_mismatch', status: 409 });
  }
});
test('zero accepted pool is held for a separate policy, never called paid', () => {
  const input = fixture({ quantity: 1, unit: 1 });
  const snapshot = quoteEnterprisePoolOffer({ quantity: 1, acceptedUnitPriceCents: 1, authorizedCouponCents: 1 });
  input.binding.snapshot = snapshot;
  input.binding.digest = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  assert.throws(() => prove(input), { code: 'pool_proof_free_pool_requires_policy', status: 409 });
});
test('non-JSON graph fails boundedly without invoking getters/proxies/toJSON', () => {
  for (const input of [null, [], 1, 'json', { binding: new Date() }, { self: null }]) {
    if (input?.self === null) input.self = input;
    assert.throws(() => prove(input), e => e.status === 409);
  }
  let called = 0;
  const input = fixture();
  Object.defineProperty(input.invoice, 'paid', { enumerable: true, get() { called++; return true; } });
  assert.throws(() => prove(input), { code: 'pool_proof_invalid_graph', status: 409 });
  const proxied = new Proxy(fixture(), { get() { called++; throw Error('trap'); } });
  assert.throws(() => prove(proxied), { code: 'pool_proof_invalid_graph', status: 409 });
  assert.equal(called, 0);
  const sparse = fixture(); sparse.invoice.lines.data = [sparse.invoice.lines.data[0], ,];
  assert.throws(() => prove(sparse), { code: 'pool_proof_invalid_graph', status: 409 });
});
