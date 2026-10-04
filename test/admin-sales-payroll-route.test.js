'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createAdminSalesPayrollRouter } = require('../routes/adminSalesPayroll');
const { HEADERS } = require('../src/lib/mercuryPayrollCsv');
const JSZip = require('jszip');

async function withServer(callback, db = {}) {
  const app = express();
  app.use(express.json());
  app.use('/admin/sales-payroll', (req, _res, next) => {
    req.user = { id: '11111111-1111-4111-8111-111111111111' };
    next();
  }, createAdminSalesPayrollRouter({ db }));
  const server = await new Promise((resolve) => {
    const handle = app.listen(0, '127.0.0.1', () => resolve(handle));
  });
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('payroll automation stays off even if an admin requests ON', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/admin/sales-payroll/automation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'automation_not_implemented', enabled: false });
  });
});

test('date-filtered report and Excel export reconcile from the same reviewed source', async () => {
  const repId = '11111111-1111-4111-8111-111111111111';
  const intentId = '22222222-2222-4222-8222-222222222222';
  const tables = {
    sales_reps: [{ user_id: repId, display_name: 'Synthetic Rep', email: 'rep@example.invalid', created_at: '2026-09-01T00:00:00Z' }],
    sales_commission_receipts: [{ id: '33333333-3333-4333-8333-333333333333', rep_user_id: repId, purchase_intent_id: intentId,
      funds_received_at: '2026-10-02T18:00:00Z', reviewed_at: '2026-10-02T19:00:00Z', payment_kind: 'monthly',
      gross_membership_cents: 29900, discount_cents: 1000, provider_fee_cents: 900, net_membership_cents: 28000,
      commission_cents: 14000 }],
    sales_commission_adjustments: [],
    public_purchase_intents: [{ id: intentId, created_by_user_id: repId, channel: 'sales_assisted', company_legal_name: 'Synthetic Buyer' }],
  };
  const db = { from(table) {
    const filters = []; let ids = null; let range = null;
    const builder = {
      select() { return builder; }, order() { return builder; },
      gte(column, value) { filters.push([column, 'gte', value]); return builder; },
      lt(column, value) { filters.push([column, 'lt', value]); return builder; },
      lte(column, value) { filters.push([column, 'lte', value]); return builder; },
      in(_column, value) { ids = value; return builder; }, limit() { return builder; },
      range(start, end) { range = [start, end]; return builder; },
      then(resolve) {
        let data = tables[table] || [];
        if (ids) data = data.filter((row) => ids.includes(row.id));
        for (const [column, operation, value] of filters) data = data.filter((row) => operation === 'gte' ? row[column] >= value : operation === 'lt' ? row[column] < value : row[column] <= value);
        const count = data.length;
        if (range) data = data.slice(range[0], range[1] + 1);
        resolve({ data, count, error: null });
      },
    };
    return builder;
  } };
  await withServer(async (base) => {
    const path = '/admin/sales-payroll';
    const query = '?date_from=2026-10-01&date_to=2026-10-03';
    const reportResponse = await fetch(`${base}${path}/report${query}`);
    assert.equal(reportResponse.status, 200);
    const report = await reportResponse.json();
    assert.equal(report.totals.net_revenue_cents, 28000);
    assert.equal(report.totals.sale_count, 1);
    const exportResponse = await fetch(`${base}${path}/export${query}`);
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get('content-type'), /spreadsheetml/);
    const workbook = await JSZip.loadAsync(await exportResponse.arrayBuffer());
    const summary = await workbook.file('xl/worksheets/sheet1.xml').async('string');
    assert.match(summary, /<c r="E6" s="2"><v>280<\/v><\/c>/);
    const invalid = await fetch(`${base}${path}/report?date_from=2026-02-30&date_to=2026-03-01`);
    assert.equal(invalid.status, 422);
    assert.deepEqual(await invalid.json(), { error: 'invalid_report_date' });
  }, db);
});

test('payroll overview excludes a reversed bank payout from paid totals', async () => {
  const tables = {
    sales_commission_payouts: [
      { id: 'bank-payout', receipt_id: 'receipt-1', bank_transaction_id: 'bank-1', amount_cents: 1000 },
      { id: 'manual-payout', receipt_id: 'receipt-1', bank_transaction_id: null, amount_cents: 500 },
    ],
    sales_commission_bank_reversals: [{ bank_transaction_id: 'bank-1' }],
  };
  const db = { from(table) { return { select() { return { order() { return {
    limit: async () => ({ data: tables[table] || [], error: null }),
  }; } }; } }; } };
  await withServer(async (base) => {
    const response = await fetch(`${base}/admin/sales-payroll`);
    assert.equal(response.status, 200);
    const overview = await response.json();
    assert.deepEqual(overview.payouts.map((row) => row.id), ['manual-payout']);
  }, db);
});

test('reviewing one monthly receipt stores one net payment, not twelve annualized payments', async () => {
  const saleId = '22222222-2222-4222-8222-222222222222';
  const agreementId = '33333333-3333-4333-8333-333333333333';
  const clientId = '55555555-5555-4555-8555-555555555555';
  const repId = '44444444-4444-4444-8444-444444444444';
  const records = {
    public_purchase_intents: { id: saleId, status: 'completed', channel: 'sales_assisted', created_by_user_id: repId,
      agreement_id: agreementId, client_id: clientId, activated_at: '2026-07-08T19:00:00Z', selected_billing_cadence: 'monthly', platform_fee_cents: 29900 },
    clients: { id: clientId, billing_status: 'active', subscription_status: 'active' },
    membership_agreements: { id: agreementId, client_id: clientId, status: 'signed', checkout_status: 'paid',
      signed_at: '2026-07-08T18:00:00Z', checkout_paid_at: '2026-07-08T18:30:00Z',
      initial_term_start: '2026-07-08', initial_renewal_date: '2027-07-08' },
    sales_reps: { user_id: repId, active: true },
    sales_commission_departures: null,
    sales_commission_statement_locks: null,
  };
  let inserted;
  const db = { from(table) { return {
    select() {
      const query = { eq() { return query; }, maybeSingle: async () => ({ data: records[table], error: null }) };
      return query;
    },
    insert(row) { inserted = row; return { select() { return { single: async () => ({ data: { id: 'receipt-local' }, error: null }) }; } }; },
  }; } };
  await withServer(async (base) => {
    const response = await fetch(`${base}/admin/sales-payroll/receipts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purchase_intent_id: saleId, provider: 'stripe', provider_payment_id: 'pi_local_month_2',
        payment_kind: 'monthly', payment_success_at: '2026-09-08T18:00:00Z', funds_received_at: '2026-09-10T18:00:00Z',
        gross_membership_cents: 29900, discount_cents: 0, provider_fee_cents: 897, evidence_reference: 'receipt local' }),
    });
    assert.equal(response.status, 201);
    assert.equal(inserted.gross_membership_cents, 29900);
    assert.equal(inserted.provider_fee_cents, 897);
    assert.equal(inserted.payment_kind, 'monthly');
    assert.equal(inserted.qualification_closed_at, '2026-07-08T19:00:00.000Z');
    const wrongCadence = await fetch(`${base}/admin/sales-payroll/receipts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purchase_intent_id: saleId, provider: 'stripe', provider_payment_id: 'pi_local_wrong_cadence',
        payment_kind: 'paid_in_full', payment_success_at: '2026-09-08T18:00:00Z', funds_received_at: '2026-09-10T18:00:00Z',
        gross_membership_cents: 29900, discount_cents: 0, provider_fee_cents: 897, evidence_reference: 'receipt local' }),
    });
    assert.equal(wrongCadence.status, 422);
    assert.deepEqual(await wrongCadence.json(), { error: 'payment_kind_billing_cadence_mismatch' });
    const tooLarge = await fetch(`${base}/admin/sales-payroll/receipts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purchase_intent_id: saleId, provider: 'stripe', provider_payment_id: 'pi_local_too_large',
        payment_kind: 'monthly', payment_success_at: '2026-09-08T18:00:00Z', funds_received_at: '2026-09-10T18:00:00Z',
        gross_membership_cents: 358800, discount_cents: 0, provider_fee_cents: 897, evidence_reference: 'receipt local' }),
    });
    assert.equal(tooLarge.status, 422);
    assert.deepEqual(await tooLarge.json(), { error: 'gross_exceeds_contract_platform_fee' });
    records.clients.billing_status = 'past_due';
    const inactive = await fetch(`${base}/admin/sales-payroll/receipts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purchase_intent_id: saleId, provider: 'stripe', provider_payment_id: 'pi_local_inactive',
        payment_kind: 'monthly', payment_success_at: '2026-09-08T18:00:00Z', funds_received_at: '2026-09-10T18:00:00Z',
        gross_membership_cents: 29900, discount_cents: 0, provider_fee_cents: 897, evidence_reference: 'receipt local' }),
    });
    assert.equal(inactive.status, 422);
    assert.deepEqual(await inactive.json(), { error: 'client_not_active' });
    records.clients.billing_status = 'active';
    records.public_purchase_intents.channel = 'self_service';
    const wrongChannel = await fetch(`${base}/admin/sales-payroll/receipts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purchase_intent_id: saleId, provider: 'stripe', provider_payment_id: 'pi_local_wrong_channel',
        payment_kind: 'monthly', payment_success_at: '2026-09-08T18:00:00Z', funds_received_at: '2026-09-10T18:00:00Z',
        gross_membership_cents: 29900, discount_cents: 0, provider_fee_cents: 897, evidence_reference: 'receipt local' }),
    });
    assert.equal(wrongChannel.status, 422);
    assert.deepEqual(await wrongChannel.json(), { error: 'unverified_qualifying_sale' });
  }, db);
});

test('receipt review rejects a payment time without explicit timezone before database access', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/admin/sales-payroll/receipts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        purchase_intent_id: '22222222-2222-4222-8222-222222222222',
        provider: 'stripe', provider_payment_id: 'pi_test_local_001', payment_kind: 'monthly',
        evidence_reference: 'local receipt', gross_membership_cents: 29900,
        discount_cents: 0, provider_fee_cents: 897,
        payment_success_at: '2026-10-02T12:00', funds_received_at: '2026-10-03T12:00Z',
      }),
    });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: 'invalid_payment_success_at_timezone' });
  });
});

test('Mercury preview never writes and import stays closed without approved source account', async () => {
  const values = {
    'Date (UTC)': '07-10-2026', Description: 'Synthetic QA ACH', Amount: '-100.00',
    Status: 'Sent', 'Source Account': 'Synthetic Checking', 'Bank Description': '',
    Reference: '', Note: '', 'Last Four Digits': '', 'Name On Card': '', 'Merchant Type': '',
    Category: '', 'Source of Category': '', 'GL Code': '', 'Source of GL Code': '',
    Timestamp: '07-10-2026 12:00:00', 'Original Currency': '', 'Check Number': '',
    'Cardholder Email': '', 'Tracking ID': '123456789012345', 'Failure Reason': '',
  };
  const csv = `${HEADERS.join(',')}\n${HEADERS.map((name) => values[name]).join(',')}\n`;
  let calls = 0;
  const db = { rpc() { calls += 1; throw new Error('rpc_must_not_run'); } };
  const previous = process.env.SALES_MERCURY_PAYROLL_ACCOUNT_SHA256;
  delete process.env.SALES_MERCURY_PAYROLL_ACCOUNT_SHA256;
  try {
    await withServer(async (base) => {
      const preview = await fetch(`${base}/admin/sales-payroll/mercury/preview`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }),
      });
      assert.equal(preview.status, 200);
      const rows = (await preview.json()).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].source_account_allowed, false);
      const attempted = await fetch(`${base}/admin/sales-payroll/mercury/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, row_number: 2, rep_user_id: '11111111-1111-4111-8111-111111111111',
          allocations: [{ receipt_id: '22222222-2222-4222-8222-222222222222', amount_cents: 10000 }], attested: true }),
      });
      assert.equal(attempted.status, 409);
      assert.deepEqual(await attempted.json(), { error: 'unapproved_mercury_source_account' });
    }, db);
  } finally {
    if (previous === undefined) delete process.env.SALES_MERCURY_PAYROLL_ACCOUNT_SHA256;
    else process.env.SALES_MERCURY_PAYROLL_ACCOUNT_SHA256 = previous;
  }
  assert.equal(calls, 0);
});
