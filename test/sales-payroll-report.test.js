'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildSalesPayrollReport, localDate } = require('../src/lib/salesPayrollReport');

const repId = '11111111-1111-4111-8111-111111111111';
const intentId = '22222222-2222-4222-8222-222222222222';
const representatives = [{ user_id: repId, display_name: 'Synthetic Rep', email: 'rep@example.invalid' },
  { user_id: '33333333-3333-4333-8333-333333333333', display_name: 'No Sales', email: 'none@example.invalid' }];
const intents = [{ id: intentId, company_legal_name: 'Synthetic Client', channel: 'sales_assisted', created_by_user_id: repId }];
const receipt = (id, at) => ({ id, purchase_intent_id: intentId, rep_user_id: repId, funds_received_at: at,
  gross_membership_cents: 29900, discount_cents: 1000, provider_fee_cents: 900, net_membership_cents: 28000,
  commission_cents: 14000, payment_kind: 'monthly' });

test('Mountain dates include the DST cutoff without shifting the displayed day', () => {
  assert.equal(localDate('2026-03-08T06:59:59Z'), '2026-03-07');
  assert.equal(localDate('2026-03-08T07:00:00Z'), '2026-03-08');
});

test('two monthly receipts for one client count as one sale and reconcile exactly', () => {
  const report = buildSalesPayrollReport({ dateFrom: '2026-10-01', dateTo: '2026-10-31', representatives, intents,
    receipts: [receipt('r1', '2026-10-03T18:00:00Z'), receipt('r2', '2026-10-17T18:00:00Z')], adjustments: [], linkedReceipts: [] });
  assert.equal(report.totals.sale_count, 1);
  assert.equal(report.totals.gross_sales_cents, 59800);
  assert.equal(report.totals.adjustment_cents, -3800);
  assert.equal(report.totals.net_revenue_cents, 56000);
  assert.equal(report.totals.commission_cents, 28000);
  assert.equal(report.representatives.find((row) => row.user_id === repId).events.length, 2);
  assert.equal(report.representatives.find((row) => row.user_id !== repId).sale_count, 0);
});

test('a later refund on an older receipt belongs to the adjustment period but is not a new sale', () => {
  const source = receipt('old', '2026-09-03T18:00:00Z');
  const report = buildSalesPayrollReport({ dateFrom: '2026-10-01', dateTo: '2026-10-31', representatives, intents,
    receipts: [], linkedReceipts: [source], adjustments: [{ id: 'a1', receipt_id: 'old',
      effective_at: '2026-10-06T18:00:00Z', adjustment_type: 'refund', net_membership_delta_cents: -10001,
      commission_delta_cents: -5001 }] });
  assert.equal(report.totals.sale_count, 0);
  assert.equal(report.totals.gross_sales_cents, 0);
  assert.equal(report.totals.adjustment_cents, -10001);
  assert.equal(report.totals.net_revenue_cents, -10001);
  assert.equal(report.totals.commission_cents, -5001);
  assert.equal(report.representatives.find((row) => row.user_id === repId).events.length, 1);
});

test('an odd-cent refund uses the stored commission delta, including zero', () => {
  const source = receipt('old', '2026-09-03T18:00:00Z');
  const report = buildSalesPayrollReport({ dateFrom: '2026-10-01', dateTo: '2026-10-31', representatives, intents,
    receipts: [], linkedReceipts: [source], adjustments: [{ id: 'one-cent', receipt_id: 'old',
      effective_at: '2026-10-06T18:00:00Z', adjustment_type: 'refund', net_membership_delta_cents: -1,
      commission_delta_cents: 0 }] });
  assert.equal(report.totals.adjustment_cents, -1);
  assert.equal(report.totals.commission_cents, 0);
});

test('a recurring sale counts once per selected period, not once per installment or lifetime', () => {
  const september = receipt('sep', '2026-09-03T18:00:00Z');
  const october = receipt('oct', '2026-10-03T18:00:00Z');
  const annual = buildSalesPayrollReport({ dateFrom: '2026-01-01', dateTo: '2026-12-31', representatives, intents,
    receipts: [september, october], adjustments: [], linkedReceipts: [] });
  const monthly = buildSalesPayrollReport({ dateFrom: '2026-10-01', dateTo: '2026-10-31', representatives, intents,
    receipts: [october], adjustments: [], linkedReceipts: [] });
  assert.equal(annual.totals.sale_count, 1);
  assert.equal(monthly.totals.sale_count, 1);
  assert.equal(annual.totals.gross_sales_cents, 2 * monthly.totals.gross_sales_cents);
});

test('missing or self-service attribution fails closed instead of fabricating payroll data', () => {
  assert.throws(() => buildSalesPayrollReport({ dateFrom: '2026-10-01', dateTo: '2026-10-31', representatives,
    intents: [], receipts: [receipt('r1', '2026-10-03T18:00:00Z')], adjustments: [], linkedReceipts: [] }), /report_missing_sales_attribution/);
  assert.throws(() => buildSalesPayrollReport({ dateFrom: '2026-10-01', dateTo: '2026-10-31', representatives,
    intents: [{ ...intents[0], channel: 'retail' }], receipts: [receipt('r1', '2026-10-03T18:00:00Z')], adjustments: [], linkedReceipts: [] }), /report_missing_sales_attribution/);
});
