'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  OFFER_VERSION, RETAIL_PRICES_CENTS, buildRetailOffer, listRetailOffers,
  anchoredMonthInstant, retailTermWindow, assertRenewalPreferenceChange
} = require('../src/services/membershipOffers');

const base = { planKey: 'basic', commitmentMonths: 3, paymentOption: 'prepaid', channel: 'public', offerVersion: OFFER_VERSION };
// Independent accepted-price fixture, not copied out of the code under test.
const accepted = {
  basic: [[3, 120000, 44900], [6, 195000, 39900], [12, 330000, 34900]],
  pro: [[3, 210000, 74900], [6, 360000, 69900], [12, 650000, 64900]]
};

for (const [planKey, terms] of Object.entries(accepted)) {
  for (const [commitmentMonths, prepaid, monthly] of terms) {
    for (const paymentOption of ['prepaid', 'monthly_installments']) {
      test(`${planKey} ${commitmentMonths} ${paymentOption}: accepted prices, totals and renewal rules`, () => {
        const offer = buildRetailOffer({ ...base, planKey, commitmentMonths, paymentOption, channel: 'sales' });
        const installments = paymentOption === 'monthly_installments';
        const payment = installments ? monthly : prepaid;
        assert.equal(offer.platform_payment_cents, payment);
        assert.equal(offer.platform_commitment_total_cents, payment * (installments ? commitmentMonths : 1));
        assert.equal(offer.initial_payment_cents, payment);
        assert.equal(offer.term_start_basis, 'first_payment_success');
        assert.equal(offer.contract_timezone, 'UTC');
        assert.equal(offer.installment_count, installments ? commitmentMonths : 1);
        assert.deepEqual(offer.stripe_recurrence, { interval: 'month', interval_count: installments ? 1 : commitmentMonths });
        assert.equal(offer.renewal.default_auto_renew, true);
        assert.equal(offer.renewal.retain_accepted_pricing, true);
        assert.equal(offer.renewal.commitment_months, commitmentMonths);
        assert.equal(offer.renewal.reminder_days, 30);
        assert.equal(offer.renewal.ends_installments_early, false);
        assert.equal(offer.renewal.non_renewal_cutoff, 'before_term_end');
      });
    }
  }
}

test('public has exactly six prepaid offers; sales/admin have all twelve', () => {
  for (const channel of ['sales', 'admin']) assert.equal(listRetailOffers({ channel }).length, 12);
  const offers = listRetailOffers({ channel: 'public' });
  assert.equal(offers.length, 6);
  assert.ok(offers.every(offer => offer.payment_option === 'prepaid'));
  assert.throws(() => buildRetailOffer({ ...base, paymentOption: 'monthly_installments' }), { code: 'public_installments_not_available' });
});

test('first-role prepay is a separate, one-time credit; never increases platform commitment or renewal price', () => {
  for (const [planKey, roleAmount] of [['basic', 35900], ['pro', 62900]]) {
    const plain = buildRetailOffer({ ...base, planKey });
    const selected = buildRetailOffer({ ...base, planKey, firstRolePrepaySelected: true });
    assert.equal(selected.initial_payment_cents, plain.initial_payment_cents + roleAmount);
    assert.equal(selected.first_role_prepay.amount_cents, roleAmount);
    assert.equal(selected.platform_commitment_total_cents, plain.platform_commitment_total_cents);
    assert.equal(selected.platform_payment_cents, plain.platform_payment_cents);
  }
});

test('quote uses server prices, ignores submitted money and freezes nested terms', () => {
  const offer = buildRetailOffer({ ...base, platform_payment_cents: 1, auto_renew: false });
  assert.equal(offer.platform_payment_cents, 120000);
  assert.equal(offer.renewal.default_auto_renew, true);
  assert.throws(() => { offer.platform_payment_cents = 1; }, TypeError);
  assert.throws(() => { offer.renewal.commitment_months = 1; }, TypeError);
  assert.throws(() => { RETAIL_PRICES_CENTS.pro[12].prepaid = 1; }, TypeError);
});

test('invalid, stale and custom Enterprise selections fail closed', () => {
  const cases = [
    [{ offerVersion: 'old' }, 'stale_offer_version'],
    [{ offerVersion: null }, 'stale_offer_version'],
    [{ planKey: 'enterprise' }, 'invalid_retail_plan'],
    [{ commitmentMonths: 1 }, 'invalid_commitment_months'],
    [{ commitmentMonths: '3.0' }, 'invalid_commitment_months'],
    [{ commitmentMonths: true }, 'invalid_commitment_months'],
    [{ commitmentMonths: '3x' }, 'invalid_commitment_months'],
    [{ paymentOption: 'monthly' }, 'invalid_payment_option'],
    [{ channel: 'client' }, 'invalid_offer_channel'],
    [{ firstRolePrepaySelected: 'true' }, 'invalid_first_role_selection']
  ];
  for (const [changes, code] of cases) assert.throws(() => buildRetailOffer({ ...base, ...changes }), { code });
  assert.equal(buildRetailOffer({ ...base, planKey: 'essential', commitmentMonths: '3' }).plan_key, 'basic');
});

test('plan capacities, role charges, Pro expiry and extra-interview defaults are preserved', () => {
  const essential = buildRetailOffer(base);
  const pro = buildRetailOffer({ ...base, planKey: 'pro' });
  assert.equal(essential.additional_interview_fee_cents, 2500);
  assert.equal(pro.additional_interview_fee_cents, 3000);
  assert.equal(essential.included_interviews_per_role, 20);
  assert.equal(pro.included_interviews_per_role, 30);
  assert.equal(essential.per_role_fee_cents, 39900);
  assert.equal(pro.per_role_fee_cents, 69900);
  assert.equal(pro.rollover_days, 90);
  assert.equal(essential.rollover_days, null);
});

test('month-end and leap-year dates are derived from original anchor, without drift', () => {
  const january = '2027-01-31T18:23:45.123Z';
  assert.equal(anchoredMonthInstant(january, 1), '2027-02-28T18:23:45.123Z');
  assert.equal(anchoredMonthInstant(january, 2), '2027-03-31T18:23:45.123Z');
  const leap = '2028-02-29T00:00:00.000Z';
  assert.equal(anchoredMonthInstant(leap, 12), '2029-02-28T00:00:00.000Z');
  assert.equal(anchoredMonthInstant(leap, 48), '2032-02-29T00:00:00.000Z');
  assert.equal(anchoredMonthInstant('0042-01-31T00:00:00.000Z', 1), '0042-02-28T00:00:00.000Z');
  assert.throws(() => anchoredMonthInstant('9999-12-31T00:00:00.000Z', 1), { code: 'invalid_month_offset' });
});

test('independent UTC civil calendar oracle covers every approved clamp case', () => {
  const oracle = [
    ['2026-01-31T15:04:05Z', 1, '2026-02-28T15:04:05.000Z'],
    ['2026-01-31T15:04:05Z', 2, '2026-03-31T15:04:05.000Z'],
    ['2026-01-31T15:04:05Z', 3, '2026-04-30T15:04:05.000Z'],
    ['2028-01-31T00:00:00Z', 1, '2028-02-29T00:00:00.000Z'],
    ['2028-02-29T12:00:00Z', 12, '2029-02-28T12:00:00.000Z']
  ];
  for (const [start, offset, expected] of oracle) assert.equal(anchoredMonthInstant(start, offset), expected);
});

test('term windows keep selected term and separate 30-day reminder from cancellation cutoff', () => {
  const originalStart = '2026-11-30T12:00:00.000Z';
  const first = retailTermWindow({ originalStart, commitmentMonths: 3 });
  const second = retailTermWindow({ originalStart, commitmentMonths: 3, termIndex: 1 });
  assert.equal(first.term_end_at, '2027-02-28T12:00:00.000Z');
  assert.equal(first.renewal_reminder_at, '2027-01-29T12:00:00.000Z');
  assert.equal(second.term_start_at, first.term_end_at);
  assert.equal(second.term_end_at, '2027-05-30T12:00:00.000Z');
  const preference = assertRenewalPreferenceChange({ autoRenew: false,
    requestedAt: '2027-02-28T11:59:59.999Z', termStart: first.term_start_at, termEnd: first.term_end_at });
  assert.equal(preference.auto_renew, false);
  assert.equal(preference.effective_at, first.term_end_at);
});

test('preference changes reject exact/past boundary or invalid clocks; re-enable before end is allowed', () => {
  const input = { autoRenew: false, termStart: '2026-10-01T00:00:00.000Z', termEnd: '2027-01-01T00:00:00.000Z', requestedAt: '2026-12-31T23:59:59.999Z' };
  assert.equal(assertRenewalPreferenceChange({ ...input, autoRenew: true }).auto_renew, true);
  for (const requestedAt of ['2027-01-01T00:00:00.000Z', '2027-01-02T00:00:00.000Z', '2026-09-30T00:00:00.000Z']) {
    assert.throws(() => assertRenewalPreferenceChange({ ...input, requestedAt }), { code: 'term_not_mutable' });
  }
  assert.throws(() => assertRenewalPreferenceChange({ ...input, autoRenew: 'false' }), { code: 'invalid_auto_renew' });
  assert.throws(() => assertRenewalPreferenceChange({ ...input, requestedAt: '2026-12-31' }), { code: 'invalid_request_instant' });
  assert.throws(() => assertRenewalPreferenceChange({ ...input, termEnd: input.termStart }), { code: 'invalid_term_window' });
});

test('invalid dates/offsets cannot silently roll over or create an unknown term', () => {
  for (const value of ['2026-02-30T00:00:00.000Z', '2026-01-01', '2026-01-01T00:00:00-07:00', null]) {
    assert.throws(() => anchoredMonthInstant(value, 3), { code: 'invalid_original_start' });
  }
  assert.throws(() => retailTermWindow({ originalStart: '2026-01-01T00:00:00.000Z', commitmentMonths: 4 }), { code: 'invalid_commitment_months' });
  assert.throws(() => anchoredMonthInstant('2026-01-01T00:00:00.000Z', Number.MAX_SAFE_INTEGER), { code: 'invalid_month_offset' });
});

test('new foundation does not replace grandfathered legacy package prices', () => {
  const { buildAlphaScreenPackageSnapshot } = require('../src/services/alphaScreenPackages');
  assert.equal(buildAlphaScreenPackageSnapshot('basic', 'monthly').platform_fee_cents, 29900);
  assert.equal(buildAlphaScreenPackageSnapshot('pro', 'annual').platform_fee_cents, 649900);
  assert.equal(buildRetailOffer({ ...base, planKey: 'pro', commitmentMonths: 12 }).platform_payment_cents, 650000);
});
