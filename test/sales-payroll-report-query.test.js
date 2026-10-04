'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { reportBounds, loadSalesPayrollReport, allRows } = require('../src/lib/salesPayrollReportQuery');

const rep = '11111111-1111-4111-8111-111111111111';
const intent = '22222222-2222-4222-8222-222222222222';
const oldReceipt = { id: '33333333-3333-4333-8333-333333333333', purchase_intent_id: intent,
  rep_user_id: rep, funds_received_at: '2026-09-10T18:00:00Z', payment_kind: 'monthly',
  gross_membership_cents: 29900, discount_cents: 0, provider_fee_cents: 0,
  net_membership_cents: 29900, commission_cents: 14950, reviewed_at: '2026-09-11T00:00:00Z' };

function fakeDb(seed) {
  const reads = [];
  return {
    reads,
    from(table) {
      const state = { table, filters: [], ids: null, range: null, limit: null };
      const builder = {
        select() { return builder; },
        gte(column, value) { state.filters.push([column, 'gte', value]); return builder; },
        lt(column, value) { state.filters.push([column, 'lt', value]); return builder; },
        lte(column, value) { state.filters.push([column, 'lte', value]); return builder; },
        in(_column, ids) { state.ids = ids; return builder; },
        order() { return builder; },
        range(start, end) { state.range = [start, end]; return builder; },
        limit(value) { state.limit = value; return builder; },
        then(resolve, reject) {
          reads.push(state);
          let data = seed[table] || [];
          if (state.ids) data = data.filter((row) => state.ids.includes(row.id));
          for (const [column, operator, value] of state.filters) data = data.filter((row) =>
            operator === 'gte' ? row[column] >= value : operator === 'lt' ? row[column] < value : row[column] <= value);
          const count = data.length;
          if (state.range) data = data.slice(state.range[0], state.range[1] + 1);
          if (state.limit != null) data = data.slice(0, state.limit);
          resolve({ data, count, error: null });
        },
      };
      return builder;
    },
  };
}

test('report bounds are half-open Mountain days across DST', () => {
  const bounds = reportBounds({ date_from: '2026-03-08', date_to: '2026-03-08' });
  assert.equal(bounds.fromIso, '2026-03-08T07:00:00.000Z');
  assert.equal(bounds.toIso, '2026-03-09T06:00:00.000Z');
  assert.throws(() => reportBounds({ date_from: '2026-02-30', date_to: '2026-03-01' }), /invalid_report_date/);
  assert.throws(() => reportBounds({ date_from: '2026-10-03', date_to: '2026-10-02' }), /invalid_report_range/);
});

test('period adjustment fetches prior linked receipt without counting its old payment', async () => {
  const db = fakeDb({
    sales_reps: [{ user_id: rep, display_name: 'Synthetic Rep', email: 'rep@example.invalid', created_at: '2026-09-01T00:00:00Z' }],
    sales_commission_receipts: [oldReceipt],
    sales_commission_adjustments: [{ id: '44444444-4444-4444-8444-444444444444', receipt_id: oldReceipt.id,
      adjustment_type: 'refund', net_membership_delta_cents: -10000, commission_delta_cents: -5000,
      effective_at: '2026-10-02T18:00:00Z', reviewed_at: '2026-10-02T19:00:00Z' }],
    public_purchase_intents: [{ id: intent, channel: 'sales_assisted', created_by_user_id: rep,
      company_legal_name: 'Prior client' }],
  });
  const report = await loadSalesPayrollReport(db, { date_from: '2026-10-01', date_to: '2026-10-03' }, '2026-10-03T20:00:00Z');
  assert.equal(report.totals.sale_count, 0);
  assert.equal(report.totals.adjustment_cents, -10000);
  assert.equal(report.representatives[0].events[0].client_name, 'Prior client');
  assert.equal(db.reads.filter((row) => row.table === 'sales_commission_receipts').length, 2);
});

test('missing linked records fail closed', async () => {
  const db = fakeDb({ sales_reps: [{ user_id: rep, display_name: 'Synthetic Rep', created_at: '2026-09-01T00:00:00Z' }],
    sales_commission_adjustments: [{ id: 'a', receipt_id: oldReceipt.id, adjustment_type: 'refund',
      net_membership_delta_cents: -100, commission_delta_cents: -50,
      effective_at: '2026-10-02T18:00:00Z', reviewed_at: '2026-10-02T19:00:00Z' }] });
  await assert.rejects(loadSalesPayrollReport(db, { date_from: '2026-10-01', date_to: '2026-10-03' }), /report_sales_commission_receipts_join_failed/);
});

test('pagination rejects absent counts, short pages, and duplicate identifiers', async () => {
  function response(data, count) {
    return { from() { return { select() { return { order() { return { range: async () => ({ data, count, error: null }) }; } }; } }; } };
  }
  await assert.rejects(allRows(response([], null), 'sales_reps', 'user_id', (value) => value, 'user_id'), /read_failed/);
  await assert.rejects(allRows(response([{ user_id: rep }], 2), 'sales_reps', 'user_id', (value) => value, 'user_id'), /incomplete_read/);
  await assert.rejects(allRows(response([{ user_id: rep }, { user_id: rep }], 2), 'sales_reps', 'user_id', (value) => value, 'user_id'), /duplicate_or_missing_id/);
  await assert.rejects(allRows(response([], 10001), 'sales_reps', 'user_id', (value) => value, 'user_id'), /report_range_too_large/);
});
