'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createAdminSalesPayrollRouter } = require('../routes/adminSalesPayroll');

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

test('reviewing one monthly receipt stores one net payment, not twelve annualized payments', async () => {
  const saleId = '22222222-2222-4222-8222-222222222222';
  const agreementId = '33333333-3333-4333-8333-333333333333';
  const repId = '44444444-4444-4444-8444-444444444444';
  const records = {
    public_purchase_intents: { id: saleId, status: 'activated', created_by_user_id: repId,
      agreement_id: agreementId, activated_at: '2026-07-08T19:00:00Z', selected_billing_cadence: 'monthly' },
    membership_agreements: { id: agreementId, status: 'signed', checkout_status: 'paid',
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
