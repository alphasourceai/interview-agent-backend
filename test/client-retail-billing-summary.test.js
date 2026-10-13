'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { buildRetailPackageSnapshot } = require('../src/services/membershipPackageCompatibility');
const { OFFER_VERSION, retailTermWindow } = require('../src/services/membershipOffers');
// The reused renewal validator imports the normal server DB at module load.
// This test supplies its DB per call and never configures a real project.
const databaseModule = path.resolve(__dirname, '../src/clients/supabase.js');
require.cache[databaseModule] = { id: databaseModule, filename: databaseModule, loaded: true, exports: { supabaseAdmin: {} } };
const { readClientRetailBillingSummary } = require('../src/services/clientRetailBillingSummary');
const C = '44444444-4444-4444-8444-444444444444';
const CHILD = '55555555-5555-4555-8555-555555555555';
const A = '2026-01-31T12:13:14.000Z';
function fixture(months = 3, payment = 'prepaid', plan = 'basic') {
  const pkg = structuredClone(buildRetailPackageSnapshot({ planKey: plan, commitmentMonths: months,
    paymentOption: payment, channel: 'sales', offerVersion: OFFER_VERSION }));
  const window = retailTermWindow({ originalStart: A, commitmentMonths: months, termIndex: 1 });
  const client = { id: C, name: 'Synthetic Billing', parent_client_id: null, plan_tier: plan,
    billing_interval: pkg.billing_cadence, auto_renew: false, current_term_end: '2026-02-01T00:00:00Z',
    contract_start_at: window.term_start_at, contract_end_at: window.term_end_at,
    stripe_customer_id: 'cus_SYNTHETIC', stripe_subscription_id: 'sub_SYNTHETIC', billing_status: 'active' };
  const agreement = { id: '33333333-3333-4333-8333-333333333333', client_id: C, status: 'signed',
    is_current: true, checkout_status: 'paid', checkout_paid_at: A, membership_tier: plan,
    billing_option: pkg.billing_cadence, template_version: 'membership_agreement_retail_terms_v2',
    template_snapshot: { template_version: 'membership_agreement_retail_terms_v2', package_snapshot: pkg } };
  const tables = { clients: [client], membership_agreements: [agreement], client_plan_settings: [
    { client_id: C, platform_fee: 999999 } // Current settings are not accepted-price authority.
  ] };
  return { client, agreement, pkg, tables, db: createFakeSupabase(tables) };
}
test('all retail terms show accepted platform payment and original-anchored membership end', async () => {
  for (const plan of ['basic', 'pro']) for (const months of [3, 6, 12]) for (const payment of ['prepaid', 'monthly_installments']) {
    const f = fixture(months, payment, plan), before = structuredClone(f.tables);
    const result = await readClientRetailBillingSummary({ db: f.db, client: f.client });
    assert.equal(result.commitment_months, months);
    assert.equal(result.platform_payment_cents, f.pkg.membership_terms.platform_payment_cents);
    assert.equal(result.platform_commitment_total_cents, f.pkg.membership_terms.platform_commitment_total_cents);
    assert.equal(result.current_term_end_at, f.client.contract_end_at);
    assert.notEqual(result.current_term_end_at, f.client.current_term_end);
    assert.equal(result.auto_renew, false);
    assert.deepEqual(f.tables, before);
    assert.equal(f.db.calls.some(c => c.table === 'client_plan_settings'), false);
  }
});
test('accepted historical cents and version survive without catalog repricing', async () => {
  const f = fixture(), p = f.agreement.template_snapshot.package_snapshot;
  p.pricing_version = p.membership_terms.offer_version = 'accepted_historical_version';
  p.platform_fee = 1100.17; p.platform_fee_cents = p.platform_commitment_total_cents = 110017;
  Object.assign(p.membership_terms, { platform_payment_cents: 110017, platform_commitment_total_cents: 110017, initial_payment_cents: 110017 });
  const result = await readClientRetailBillingSummary({ db: f.db, client: f.client });
  assert.equal(result.platform_payment_cents, 110017);
});
test('legacy and unpaid retail keep the existing summary without invented funded terms', async () => {
  const legacy = fixture(); legacy.tables.membership_agreements = []; legacy.client.billing_interval = 'monthly';
  assert.equal(await readClientRetailBillingSummary({ db: legacy.db, client: legacy.client }), null);
  const pending = fixture(); pending.agreement.checkout_status = 'pending_payment'; pending.agreement.checkout_paid_at = null;
  assert.equal(await readClientRetailBillingSummary({ db: pending.db, client: pending.client }), null);
});
test('malformed marked sources and changed client binding refuse rather than show guessed terms', async () => {
  for (const change of [f => { f.agreement.template_snapshot.package_snapshot.membership_terms.commitment_months = 9; },
    f => { f.agreement.checkout_paid_at = null; }, f => { f.agreement.template_version = 'legacy'; },
    f => { f.client.contract_end_at = '2030-01-01T00:00:00Z'; }]) {
    const f = fixture(); change(f);
    await assert.rejects(readClientRetailBillingSummary({ db: f.db, client: f.client }), /invalid_retail|retail_renewal|retail_subscription/);
  }
  const f = fixture(), stale = { ...f.client, auto_renew: true };
  await assert.rejects(readClientRetailBillingSummary({ db: f.db, client: stale }), /billing_terms_changed_during_read/);
});
function appFor(f, { role = 'manager', ids = [C] } = {}) {
  const root = path.resolve(__dirname, '..');
  const inject = (name, exports) => { const file = path.join(root, name); require.cache[file] = { id: file, filename: file, loaded: true, exports }; };
  inject('src/clients/supabase.js', { supabaseAdmin: f.db });
  inject('src/middleware/auth.js', { requireAuth: (_req, _res, next) => next(), withClientScope: (req, _res, next) => {
    req.client_memberships = ids;
    req.clientScope = { effectiveRolesByClientId: { [C]: [role] }, clientById: { [C]: f.client,
      [CHILD]: { id: CHILD, parent_client_id: C } } }; next();
  } });
  const file = path.join(root, 'src/routes/client/billing.js'); delete require.cache[file];
  const app = express(); app.use(require(file)); return app;
}
test('mounted summary resolves child billing to the authorized parent and exposes no provider IDs', async () => {
  const f = fixture(6, 'monthly_installments'); f.tables.clients.push({ id: CHILD, parent_client_id: C, name: 'Synthetic Child' });
  const response = await request(appFor(f, { ids: [C, CHILD] })).get(`/clients/billing/summary?client_id=${CHILD}`);
  assert.equal(response.status, 200); assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].id, C);
  assert.equal(response.body.items[0].membership_terms.commitment_months, 6);
  assert.equal(JSON.stringify(response.body).includes('cus_SYNTHETIC'), false);
  assert.equal(JSON.stringify(response.body).includes('sub_SYNTHETIC'), false);
});
test('mounted summary denies foreign and ordinary member access before accepted-source reads', async () => {
  for (const [role, target] of [['manager', 'FOREIGN'], ['member', C]]) {
    const f = fixture(), response = await request(appFor(f, { role })).get(`/clients/billing/summary?client_id=${target}`);
    assert.equal(response.status, 403);
    assert.equal(f.db.calls.some(c => c.table === 'membership_agreements'), false);
  }
});
