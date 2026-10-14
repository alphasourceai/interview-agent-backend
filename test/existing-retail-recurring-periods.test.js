'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./fixtures/existing-retail-funding-fixture');
const { verifyExistingRetailFunding } = require('../src/services/existingRetailCheckoutFunding');
const { anchoredMonthInstant, retailTermWindow } = require('../src/services/membershipOffers');
const { inspectExistingRetailRecurringPeriods: inspect } = require('../src/services/existingRetailRecurringPeriods');

const invalid = 'retail_recurring_period_invalid', unsupported = 'retail_recurring_period_unsupported';
function input(plan = 'basic', months = 3, payment = 'monthly_installments', role = false, count = 4) {
  const f = fixture(plan, months, payment, role);
  const offer = f.pkg.membership_terms;
  const period = verifyExistingRetailFunding({ offer, checkout: f.cs,
    checkoutLines: { object: 'list', data: f.cl, has_more: false }, subscription: f.s, subscriptionItems: f.s.items,
    invoice: f.inv, invoiceLines: f.inv.lines, paymentIntent: f.pi, charge: f.ch,
    expected: { customerId: f.c.stripe_customer_id, signedAt: f.g.signed_at, agreementDeadline: f.g.agreement_expires_at,
      intentDeadline: f.i.expires_at } }).initialProviderPeriod;
  const b = new Date(period.provider_period_start * 1000).toISOString(), interval = offer.stripe_recurrence.interval_count;
  const records = [structuredClone(f.inv)];
  for (let n = 1; n <= count; n++) {
    const line = structuredClone(f.il[0]);
    line.id = `il_CYCLE_${n}`;
    line.period = { start: Date.parse(anchoredMonthInstant(b, n * interval)) / 1000,
      end: Date.parse(anchoredMonthInstant(b, (n + 1) * interval)) / 1000 };
    records.push({ id: `in_CYCLE_${n}`, object: 'invoice', customer: period.customer_id, subscription: period.subscription_id,
      currency: 'usd', livemode: period.livemode, billing_reason: 'subscription_cycle', status: 'draft',
      lines: { object: 'list', data: [line], has_more: false, total_count: 1 } });
  }
  return { packageSnapshot: structuredClone(f.pkg), originalPeriod: structuredClone(period),
    originalProviderAccountId: 'acct_SYNTHETIC', providerAccountId: 'acct_SYNTHETIC',
    invoices: { object: 'list', has_more: false, data: records, total_count: records.length } };
}
const cycle = value => value.invoices.data[1];
const line = value => cycle(value).lines.data[0];
const expectRefusal = (value, code = invalid) => assert.throws(() => inspect(value), error => error.code === code && error.message === code);
function moveAnchor(value, originalB, originalA) {
  const p = value.originalPeriod, interval = value.packageSnapshot.membership_terms.stripe_recurrence.interval_count;
  p.paid_at = originalA; p.provider_period_start = Date.parse(originalB) / 1000;
  p.provider_period_end = Date.parse(anchoredMonthInstant(originalB, interval)) / 1000;
  for (let n = 1; n < value.invoices.data.length; n++) value.invoices.data[n].lines.data[0].period = {
    start: Date.parse(anchoredMonthInstant(originalB, n * interval)) / 1000,
    end: Date.parse(anchoredMonthInstant(originalB, (n + 1) * interval)) / 1000 };
}

for (const plan of ['basic', 'pro']) for (const months of [3, 6, 12]) for (const payment of ['prepaid', 'monthly_installments']) {
  for (const role of [false, true]) test(`recurring chronology ${plan}/${months}/${payment}/role:${role}`, () => {
    const value = input(plan, months, payment, role, payment === 'prepaid' ? 2 : months + 1);
    const before = structuredClone(value), result = inspect(value), interval = value.packageSnapshot.membership_terms.stripe_recurrence.interval_count;
    assert.equal(result.cycle_count, before.invoices.data.length - 1);
    for (const c of result.cycles) {
      const termIndex = payment === 'prepaid' ? c.ordinal : Math.floor(c.ordinal / months);
      const t = retailTermWindow({ originalStart: value.originalPeriod.paid_at, commitmentMonths: months, termIndex });
      assert.equal(c.observed_original_a_period_start, anchoredMonthInstant(value.originalPeriod.paid_at, c.ordinal * interval));
      assert.equal(c.observed_original_a_period_end, anchoredMonthInstant(value.originalPeriod.paid_at, (c.ordinal + 1) * interval));
      assert.equal(c.term_index, termIndex); assert.equal(c.installment_index, payment === 'prepaid' ? 1 : c.ordinal % months + 1);
      assert.equal(c.observed_term_start_at, t.term_start_at); assert.equal(c.observed_term_end_at, t.term_end_at);
      assert.notEqual(Date.parse(c.observed_original_a_period_start) / 1000, c.provider_period_start);
    }
    assert.deepEqual(value, before);
    assert.equal(Object.isFrozen(value), false); assert.equal(Object.isFrozen(value.originalPeriod), false);
  });
}
test('month ends and leap days use each original anchor and accept the shared raw boundary', () => {
  const v = input(); moveAnchor(v, '2024-01-31T23:59:49.000Z', '2024-01-31T23:59:59.000Z');
  const r = inspect(v);
  assert.equal(r.cycles[0].observed_original_a_period_start, '2024-02-29T23:59:59.000Z');
  assert.equal(r.cycles[0].observed_original_a_period_end, '2024-03-31T23:59:59.000Z');
  assert.equal(r.cycles[0].provider_period_end, r.cycles[1].provider_period_start);
  const six = input('pro', 6, 'prepaid', false, 2);
  moveAnchor(six, '2023-08-31T00:00:00.000Z', '2023-08-31T00:00:10.000Z');
  assert.equal(inspect(six).cycles[0].observed_original_a_period_start, '2024-02-29T00:00:10.000Z');
  assert.equal(inspect(six).cycles[0].observed_original_a_period_end, '2024-08-31T00:00:10.000Z');
  const leap = input('basic', 12, 'prepaid', false, 2);
  moveAnchor(leap, '2024-02-29T00:00:00.000Z', '2024-02-29T00:00:10.000Z');
  assert.equal(inspect(leap).cycles[0].observed_original_a_period_start, '2025-02-28T00:00:10.000Z');
});
test('delayed first cash after B end remains A; initial refunds and all statuses are not cash reproof', () => {
  const value = input('basic', 3, 'monthly_installments', true);
  value.originalPeriod.paid_at = '2026-03-03T12:13:14.000Z';
  const initial = value.invoices.data[0]; initial.status = 'void'; initial.paid = false; initial.amount_paid = 0;
  initial.charge = null; initial.status_transitions = { paid_at: null }; delete initial.lines;
  value.invoices.data.slice(1).forEach((i, n) => { i.status = ['draft', 'void', 'paid', 'uncollectible'][n]; i.paid = false; });
  const result = inspect(value);
  assert.equal(result.cycles[0].observed_original_a_period_start, '2026-04-03T12:13:14.000Z');
  assert.ok(Date.parse(result.cycles[0].observed_original_a_period_start) / 1000 > result.cycles[0].provider_period_end);
});
test('current lookback/plan/financial fields are ignored and shuffled records return consecutive observations', () => {
  const value = input(), expected = inspect(value);
  value.invoices.data.forEach(i => { i.period_start = 1; i.period_end = 2; i.latest_invoice = 'in_OTHER';
    i.total = 0; i.amount_paid = 0; i.starting_balance = -999; i.tax = 999; i.total_discount_amounts = [{ amount: 999 }]; });
  value.invoices.data.slice(1).forEach(i => { i.lines.data[0].plan = { amount: 1 }; i.lines.data[0].amount_excluding_tax = 1;
    i.lines.data[0].price.unit_amount_excluding_tax = 1; });
  value.invoices.data.reverse(); assert.deepEqual(inspect(value), expected);
});
test('accepted historical price is preserved independently of the current catalog', () => {
  const v = input(), p = v.packageSnapshot, o = p.membership_terms;
  o.platform_payment_cents = 12345; o.platform_commitment_total_cents = 12345 * o.installment_count;
  o.initial_payment_cents = 12345 + o.first_role_prepay.amount_cents; o.offer_version = p.pricing_version = 'accepted-historical-v9';
  p.platform_fee_cents = 12345; p.platform_fee = 123.45; p.platform_commitment_total_cents = o.platform_commitment_total_cents;
  v.invoices.data.slice(1).forEach(i => { i.lines.data[0].price.unit_amount = 12345; i.lines.data[0].amount = 12345; });
  assert.equal(inspect(v).cycle_count, 4);
});
test('exact success keys, deep freeze and empty history never imply absence or effect authority', () => {
  for (const n of [0, 2]) {
    const value = input('basic', 3, 'monthly_installments', false, n), result = inspect(value);
    assert.deepEqual(Object.keys(result).sort(), ['version', 'effect_authorized', 'collection_ready', 'paid_access_authorized',
      'collection_absence_proven', 'provider_effect_absence_proven', 'cycle_count', 'cycles'].sort());
    for (const key of ['effect_authorized', 'collection_ready', 'paid_access_authorized', 'collection_absence_proven', 'provider_effect_absence_proven']) assert.equal(result[key], false);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.cycles));
    for (const c of result.cycles) { assert.ok(Object.isFrozen(c)); assert.deepEqual(Object.keys(c).sort(), ['ordinal', 'invoice_id', 'line_id',
      'provider_period_start', 'provider_period_end', 'observed_original_a_period_start', 'observed_original_a_period_end',
      'term_index', 'installment_index', 'observed_term_start_at', 'observed_term_end_at'].sort()); }
  }
});
test('wrong source, provider/account bindings, price, line and census details refuse the whole input', () => {
  const mutations = [v => v.packageSnapshot = null, v => v.providerAccountId = 'acct_OTHER', v => v.originalProviderAccountId = 'acct_',
    v => v.originalPeriod.api_version = '2024-06-20', v => v.originalPeriod.extra = true,
    v => v.originalPeriod.paid_at = '2026-01-31T12:13:14Z', v => v.originalPeriod.paid_at = '2026-02-30T12:13:14.000Z',
    v => v.originalPeriod.paid_at = '2026-01-01T00:00:00.000Z', v => v.originalPeriod.price_id = 'price_',
    v => v.invoices.has_more = true, v => v.invoices.total_count--, v => v.invoices.data.shift(),
    v => v.invoices.data.push(structuredClone(cycle(v))), v => v.invoices.data[0].billing_reason = 'subscription_cycle',
    v => cycle(v).object = 'not_invoice', v => cycle(v).customer = 'cus_OTHER', v => cycle(v).customer = { id: 'cus_SYNTHETIC' },
    v => cycle(v).subscription = 'sub_OTHER', v => cycle(v).livemode = true, v => cycle(v).currency = 'eur',
    v => cycle(v).lines.has_more = true, v => cycle(v).lines.total_count = 2,
    v => cycle(v).lines.data.push(structuredClone(line(v))), v => line(v).quantity = 2, v => line(v).proration = true,
    v => line(v).id = v.originalPeriod.platform_invoice_line_id, v => line(v).object = 'invoiceitem',
    v => line(v).subscription_item = 'si_OTHER', v => line(v).subscription = { id: 'sub_SYNTHETIC' },
    v => line(v).price.id = 'price_OTHER', v => line(v).price = 'price_PLATFORM', v => line(v).price.unit_amount++,
    v => line(v).amount++, v => line(v).currency = 'eur', v => line(v).price.type = 'one_time',
    v => line(v).price.recurring.interval_count = 6, v => line(v).price.recurring.usage_type = 'metered',
    v => v.invoices.data[2].lines.data[0].id = line(v).id, v => v.invoices.data.splice(1, 1)];
  for (const mutate of mutations) { const v = input(); mutate(v); expectRefusal(v); }
  for (const reason of ['manual', 'subscription', 'subscription_update', 'subscription_threshold', 'upcoming',
    'quote_accept', 'automatic_pending_invoice_item_invoice', null]) { const v = input(); cycle(v).billing_reason = reason; expectRefusal(v); }
});
test('non-integer/out-of-range epochs are invalid; in-range phase/short windows are unsupported', () => {
  for (const key of ['provider_period_start', 'provider_period_end']) for (const value of [0, -1, 1.5, '1', 253402300800, NaN]) {
    const v = input(); v.originalPeriod[key] = value; expectRefusal(v);
  }
  for (const key of ['start', 'end']) for (const value of [0, -1, 1.5, '1', 253402300800, Infinity]) {
    const v = input(); line(v).period[key] = value; expectRefusal(v);
  }
  for (const mutate of [v => v.originalPeriod.provider_period_end++, v => line(v).period.start++, v => line(v).period.end--,
    v => { v.originalPeriod.provider_period_end = v.originalPeriod.provider_period_start; },
    v => { line(v).period.end = line(v).period.start - 1; },
    v => { line(v).period = { start: v.originalPeriod.provider_period_start, end: v.originalPeriod.provider_period_end }; }]) {
    const v = input(); mutate(v); expectRefusal(v, unsupported);
  }
  const gap = input(); gap.invoices.data[2].lines.data[0].period = structuredClone(line(gap).period); expectRefusal(gap);
});
test('1000 rich invoices reset snapshot budgets per record, and every budget failure is total', () => {
  const v = input('basic', 3, 'monthly_installments', false, 999);
  for (const i of v.invoices.data) i.metadata = Object.fromEntries(Array.from({ length: 25 }, (_, n) => [`field${n}`, 'synthetic']));
  v.invoices.data.reverse(); const r = inspect(v); assert.equal(r.cycle_count, 999); assert.equal(r.cycles[998].ordinal, 999);
  const tooMany = input('basic', 3, 'monthly_installments', false, 1000); expectRefusal(tooMany);
  const heavy = input(); cycle(heavy).extra = Array(10001).fill('synthetic'); expectRefusal(heavy);
});
test('clock, accessors, proxies and array holes cannot be executed or silently reduce a census', () => {
  let reads = 0;
  for (const poison of [v => Object.defineProperty(v, 'invoices', { enumerable: true, get() { reads++; return {}; } }),
    v => Object.defineProperty(v.invoices, 'data', { enumerable: true, get() { reads++; return []; } }),
    v => Object.defineProperty(v.invoices.data, '1', { enumerable: true, get() { reads++; return {}; } }),
    v => Object.defineProperty(cycle(v), 'lines', { enumerable: true, get() { reads++; return {}; } }),
    v => { v.originalPeriod = new Proxy(v.originalPeriod, {}); }, v => { v.invoices.data = new Proxy(v.invoices.data, {}); },
    v => { delete v.invoices.data[1]; }, v => { v.invoices.data.extra = true; }, v => { v.db = {}; }]) {
    const v = input(); poison(v); expectRefusal(v);
  }
  assert.equal(reads, 0);
  const v = input(), before = structuredClone(v), clock = Date.now;
  Date.now = () => { throw Error('Clock must not be read'); };
  try { assert.equal(inspect(v).cycle_count, 4); } finally { Date.now = clock; }
  assert.deepEqual(v, before);
});
test('sealed SDK root metadata is ignored without inspecting its data', () => {
  const v = input(), result = inspect(v);
  for (const value of [v.invoices, ...v.invoices.data]) Object.defineProperty(value, 'lastResponse', {
    value: new Proxy({}, { get() { throw Error('SDK metadata must not be inspected'); } }), enumerable: false,
    writable: false, configurable: false });
  assert.deepEqual(inspect(v), result);
});
test('the chronology inspector importers remain only the explicitly unmounted native source and SDK census', () => {
  const importers = [];
  function scan(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (entry.name.endsWith('.js') && entry.name !== 'existingRetailRecurringPeriods.js') {
      if (fs.readFileSync(file, 'utf8').includes('existingRetailRecurringPeriods')) importers.push(path.relative(path.resolve(__dirname, '../src'), file));
    }
  } }
  scan(path.resolve(__dirname, '../src'));
  assert.deepEqual(importers.sort(), ['services/existingRetailRecurringCensus.js', 'services/existingRetailRecurringSource.js']);
});
