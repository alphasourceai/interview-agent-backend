'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { calculateReceiptCommission, departureCutoffExclusive, weekRangeForTimestamp } = require('../src/lib/salesCommissionPolicy');

const monthly = {
  currency: 'usd', payment_kind: 'monthly', payment_succeeded: true, qualification_verified: true,
  gross_membership_cents: 29900, discount_cents: 0, provider_fee_cents: 897,
  payment_success_at: '2026-10-02T18:00:00Z', funds_received_at: '2026-10-05T18:00:00Z',
  qualification_closed_at: '2026-10-02T19:00:00Z',
  first_term_start_at: '2026-10-01T00:00:00Z', first_term_end_at: '2027-10-01T00:00:00Z',
};

test('annual term billed monthly earns only this net monthly receipt, not twelve months', () => {
  const result = calculateReceiptCommission(monthly);
  assert.equal(result.status, 'payable');
  assert.equal(result.net_membership_cents, 29003);
  assert.equal(result.commission_cents, 14502);
  assert.equal(result.statement_week.date_from, '2026-10-05');
});

test('a subsequent monthly receipt after the original close is independently commissionable', () => {
  const result = calculateReceiptCommission({
    ...monthly,
    payment_success_at: '2026-11-02T18:00:00Z',
    funds_received_at: '2026-11-04T18:00:00Z',
  });
  assert.equal(result.status, 'payable');
  assert.equal(result.commission_cents, 14502);
});

test('paid-in-full and funded financing count one actual net payment', () => {
  for (const paymentKind of ['paid_in_full', 'financed_checkout']) {
    const result = calculateReceiptCommission({ ...monthly, payment_kind: paymentKind,
      gross_membership_cents: 360000, discount_cents: 10000, provider_fee_cents: 7500,
    });
    assert.equal(result.net_membership_cents, 342500);
    assert.equal(result.commission_cents, 171250);
  }
});

test('failed payments and unverified sales do not earn commission', () => {
  assert.equal(calculateReceiptCommission({ ...monthly, payment_succeeded: false }).reason, 'payment_not_successful');
  assert.equal(calculateReceiptCommission({ ...monthly, qualification_verified: false }).reason, 'sale_not_verified');
});

test('successful payment waits for funds before becoming payable', () => {
  const result = calculateReceiptCommission({ ...monthly, funds_received_at: null });
  assert.equal(result.status, 'awaiting_funds');
  assert.equal(result.commission_cents, 0);
});

test('funds cannot precede payment success', () => {
  assert.throws(() => calculateReceiptCommission({ ...monthly, funds_received_at: '2026-10-01T18:00:00Z' }), /funds_received_before_payment/);
});

test('departure cutoff uses payment success, not delayed funds receipt', () => {
  assert.equal(departureCutoffExclusive('2026-10-02').toISOString(), '2026-11-02T07:00:00.000Z');
  const onDay30 = calculateReceiptCommission({ ...monthly,
    rep_final_day: '2026-10-02', payment_success_at: '2026-11-02T06:59:59Z',
    qualification_closed_at: '2026-11-02T06:59:59Z',
    funds_received_at: '2026-11-05T18:00:00Z', first_term_end_at: '2027-10-01T00:00:00Z',
  });
  assert.equal(onDay30.status, 'payable');
  const afterWindow = calculateReceiptCommission({ ...monthly,
    rep_final_day: '2026-10-02', payment_success_at: '2026-11-02T07:00:00Z',
    qualification_closed_at: '2026-11-02T07:00:00Z',
    funds_received_at: '2026-11-05T18:00:00Z',
  });
  assert.equal(afterWindow.reason, 'after_departure_window');
});

test('first term boundary and net-fee deductions are enforced', () => {
  assert.equal(calculateReceiptCommission({ ...monthly, payment_success_at: '2027-10-01T00:00:00Z',
    qualification_closed_at: '2027-10-01T01:00:00Z', funds_received_at: '2027-10-02T00:00:00Z' }).reason, 'outside_first_term');
  assert.throws(() => calculateReceiptCommission({ ...monthly, provider_fee_cents: 30000 }), /invalid_net_membership/);
  assert.throws(() => calculateReceiptCommission({ ...monthly, payment_success_at: null }), /invalid_payment_success_at/);
});

test('first payment can precede account activation, but the sale must close in the first term', () => {
  const result = calculateReceiptCommission({ ...monthly,
    payment_success_at: '2026-09-30T23:50:00Z',
    qualification_closed_at: '2026-10-01T00:10:00Z',
  });
  assert.equal(result.status, 'payable');
  assert.equal(calculateReceiptCommission({ ...monthly,
    qualification_closed_at: '2027-10-01T00:00:00Z',
  }).reason, 'outside_first_term');
});

test('when funds arrive before account activation, statement week begins at close', () => {
  const result = calculateReceiptCommission({ ...monthly,
    payment_success_at: '2026-10-02T18:00:00Z',
    funds_received_at: '2026-10-02T19:00:00Z',
    qualification_closed_at: '2026-10-05T18:00:00Z',
  });
  assert.equal(result.status, 'payable');
  assert.equal(result.statement_week.date_from, '2026-10-05');
});

test('post-departure sale must close within the cutoff even if its payment succeeded earlier', () => {
  const result = calculateReceiptCommission({ ...monthly,
    rep_final_day: '2026-10-02',
    qualification_closed_at: '2026-11-02T07:00:00Z',
    funds_received_at: '2026-11-03T18:00:00Z',
  });
  assert.equal(result.reason, 'after_departure_window');
});

test('Mountain Monday-Sunday statement week handles fall DST', () => {
  assert.deepEqual(weekRangeForTimestamp('2026-11-01T07:30:00Z'), {
    date_from: '2026-10-26', date_to: '2026-11-01',
    from_iso: '2026-10-26T06:00:00.000Z', to_exclusive_iso: '2026-11-02T07:00:00.000Z',
  });
});
