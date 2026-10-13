'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { calculateReceiptCommission } = require('../src/services/salesCommissionPolicy');
const { anchoredMonthInstant } = require('../src/services/membershipOffers');
const REP = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const A = '2026-01-31T12:13:14.000Z';
function receipt(months = 3, changes = {}) {
  return {
    membership_terms_protocol: 'retail_existing_terms_v2', currency: 'usd',
    payment_kind: 'monthly', payment_succeeded: true,
    gross_membership_cents: 44900, discount_cents: 1500, provider_fee_cents: 1347,
    original_membership_start_at: A, original_commitment_months: months,
    original_salesperson_user_id: REP, sales_rep_user_id: REP,
    original_qualification_closed_at: A, original_qualification_verified: true,
    qualification_closed_at: '2030-01-01T00:00:00Z', qualification_verified: false,
    first_term_start_at: A, first_term_end_at: anchoredMonthInstant(A, months),
    payment_success_at: '2026-10-31T12:13:14Z', funds_received_at: '2026-11-02T00:00:00Z',
    ...changes,
  };
}
for (const months of [3, 6, 12]) {
  for (const paymentKind of ['monthly', 'paid_in_full']) {
    test(`existing ${months}-month ${paymentKind} policy uses only this actual net platform receipt`, () => {
      const input = receipt(months, { payment_kind: paymentKind });
      const result = calculateReceiptCommission(input);
      assert.equal(result.status, 'payable');
      assert.equal(result.net_membership_cents, 42053);
      assert.equal(result.commission_cents, 21027);
      assert.deepEqual(result, calculateReceiptCommission({ ...input, membership_terms_protocol: 'retail_terms_v2' }));
    });
  }
  test(`existing ${months}-month original first-year cutoff remains half-open`, () => {
    assert.equal(calculateReceiptCommission(receipt(months, {
      payment_success_at: '2027-01-31T12:13:13Z', funds_received_at: '2027-02-01T00:00:00Z',
    })).status, 'payable');
    const at = calculateReceiptCommission(receipt(months, {
      payment_success_at: '2027-01-31T12:13:14Z', funds_received_at: '2027-02-01T00:00:00Z',
    }));
    assert.equal(at.reason, 'outside_original_first_year');
    assert.equal(at.commission_cents, 0);
    assert.equal(calculateReceiptCommission(receipt(months, {
      payment_success_at: '2026-01-31T12:13:13Z', funds_received_at: A,
    })).reason, 'outside_original_first_year');
  });
}
test('existing retail leap-day, first clock and delayed settlement stay distinct', () => {
  const original = '2024-02-29T12:13:14.000Z';
  const input = receipt(6, {
    original_membership_start_at: original, original_qualification_closed_at: original,
    first_term_start_at: original, first_term_end_at: anchoredMonthInstant(original, 6),
    payment_success_at: '2025-02-28T12:13:13Z', funds_received_at: '2025-03-10T00:00:00Z',
  });
  const result = calculateReceiptCommission(input);
  assert.equal(result.status, 'payable');
  assert.equal(result.statement_week.date_from, '2025-03-03');
  assert.equal(calculateReceiptCommission({ ...input, payment_success_at: '2025-02-28T12:13:14Z' }).reason, 'outside_original_first_year');
});
test('existing retail qualification uses original rep and paid close, not later reassignment or supplied close', () => {
  assert.throws(() => calculateReceiptCommission(receipt(3, { sales_rep_user_id: OTHER })), /original_salesperson_mismatch/);
  assert.equal(calculateReceiptCommission(receipt(3, { original_qualification_verified: false, qualification_verified: true })).reason, 'sale_not_verified');
  assert.equal(calculateReceiptCommission(receipt(3, { original_qualification_closed_at: '2026-01-30T00:00:00Z' })).reason, 'outside_original_first_year');
  assert.equal(calculateReceiptCommission(receipt(3, { original_qualification_closed_at: anchoredMonthInstant(A, 3) })).reason, 'outside_original_first_year');
});
test('existing retail missing source and rewritten term cannot become legacy qualification', () => {
  for (const changes of [
    { original_membership_start_at: null }, { original_qualification_closed_at: null },
    { original_salesperson_user_id: null }, { original_commitment_months: 9 },
    { first_term_start_at: '2026-10-31T12:13:14Z' }, { first_term_end_at: anchoredMonthInstant(A, 12) },
    { membership_terms_protocol: 'retail_existing_terms_v3' },
  ]) assert.throws(() => calculateReceiptCommission(receipt(3, changes)));
});
test('existing retail failed, unfunded, zero-net and malformed money remain nonpayable', () => {
  assert.equal(calculateReceiptCommission(receipt(3, { payment_succeeded: false })).reason, 'payment_not_successful');
  assert.equal(calculateReceiptCommission(receipt(3, { funds_received_at: null })).status, 'awaiting_funds');
  assert.equal(calculateReceiptCommission(receipt(3, { discount_cents: 44900, provider_fee_cents: 0 })).reason, 'no_net_membership_fee');
  assert.throws(() => calculateReceiptCommission(receipt(3, { provider_fee_cents: 50000 })), /invalid_net_membership/);
  assert.throws(() => calculateReceiptCommission(receipt(3, { funds_received_at: A })), /funds_received_before_payment/);
});
test('existing retail departure cutoff and legacy first-term behavior are unchanged', () => {
  assert.equal(calculateReceiptCommission(receipt(3, { rep_final_day: '2026-09-01' })).reason, 'after_departure_window');
  assert.equal(calculateReceiptCommission(receipt(3, { rep_final_day: '2026-10-01' })).status, 'payable');
  const input = receipt(3, { qualification_closed_at: A, qualification_verified: true });
  delete input.membership_terms_protocol;
  assert.equal(calculateReceiptCommission(input).reason, 'outside_first_term');
  assert.equal(calculateReceiptCommission({ ...input, payment_success_at: '2026-02-28T12:13:14Z', funds_received_at: '2026-03-01T00:00:00Z' }).status, 'payable');
});
