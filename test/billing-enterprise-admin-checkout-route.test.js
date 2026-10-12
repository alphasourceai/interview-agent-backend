'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const root = path.join(__dirname, '..', 'src');
const calls = [];

function stub(relative, exports) {
  const filename = require.resolve(path.join(root, relative));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
// All credentials, provider calls, recipient lookup and mail are synthetic.
stub('config/urlConfig', {});
stub('clients/sendgrid', { sendSubscriptionCheckoutEmail: async () => ({ statusCode: 202 }) });
stub('clients/supabase', { supabaseAdmin: {} });
stub('services/subscriptionCheckout', { createSubscriptionCheckoutSession: async (input) => {
  calls.push(input);
  return { session: { id: 'cs_synthetic', url: 'https://checkout.example.invalid/synthetic' },
    client: { name: 'Synthetic Fixture' }, clientEmail: 'owner@example.invalid' };
} });
stub('middleware/auth', { requireAuth: (req, res, next) => req.get('Authorization') ? next() : res.sendStatus(401) });
stub('middleware/requireAdmin', { requireAdmin: (req, res, next) => req.get('X-Fixture-Admin') === 'yes' ? next() : res.sendStatus(403) });
stub('services/admin/adminHelpers', { rejectChildClientForAdminBilling: async (req, res) => {
  if (req.params.id === 'synthetic-child') { res.sendStatus(403); return null; }
  return { ok: true };
} });
// Keep real pure model constants/defaults for raw validation; no billing read
// is executed by these scoped requests.
stub('services/billingReadModel', {});
stub('services/usageBilling', {});

const app = express();
app.use(express.json());
app.use('/admin', require('../src/routes/admin/billing'));
const send = (body, client = 'synthetic-parent') => request(app)
  .post(`/admin/clients/${client}/subscription-checkout`)
  .set('Authorization', 'Bearer synthetic').set('X-Fixture-Admin', 'yes').send(body);

test('admin Enterprise fallback passes explicit model, paired capacity and usage/pool terms to validated checkout service', async () => {
  const body = { plan_tier: 'enterprise', billing_interval: 'annual', platform_fee: '1200',
    per_role_fee: '0', included_interviews_per_role: '0', additional_interview_fee: '0',
    usage_interview_fee_cents: 2349, pool_quantity: 37, billing_model: 'usage',
    rollover_days: null, max_interview_minutes: 30, scored_question_count: 4,
    pool_discount_pct: 100, unrelated: 'must-not-forward' };
  const response = await send(body);
  assert.equal(response.status, 200);
  const input = calls.at(-1);
  assert.equal(input.planTier, 'enterprise');
  assert.deepEqual(input.enterpriseFees, {
    membership_tier:'enterprise',
    platform_fee: '1200', per_role_fee: '0', included_interviews_per_role: '0',
    additional_interview_fee: '0', usage_interview_fee_cents: 2349, pool_quantity: 37,
    billing_model: 'usage', rollover_days: null, max_interview_minutes: 30, scored_question_count: 4,
    pool_discount_pct:'7',pool_total_cents:80829,pool_discount_priced:true,
    pool_offer_snapshot:{offer_version:'enterprise-pool-v2-2026-10-11',currency:'usd',quantity:37,unit_price_cents:2349,
      gross_cents:86913,automatic_discount_percent:7,automatic_discount_cents:6084,coupon_cents:0,net_cents:80829},
    pool_offer_digest:'c39c0461f0cce1724f3afbd8b0fdec07cd5db1809225fa0babf44ccc252bb686',
  });
  assert.equal(input.enterpriseFees.pool_discount_pct,'7','browser100% ignored; prospective server band applies');
});
test('retail fallback never forwards client-supplied Enterprise overrides', async () => {
  assert.equal((await send({ plan_tier: 'basic', billing_interval: 'monthly', billing_model: 'usage', platform_fee: 1 })).status, 200);
  assert.equal(calls.at(-1).enterpriseFees, null);
});
test('invalid raw pool intent is rejected before it can be cleared into a platform-only checkout',async()=>{
  const before=calls.length;
  const r=await send({plan_tier:'enterprise',billing_interval:'monthly',billing_model:'usage',usage_interview_fee_cents:2500,pool_quantity:'not-a-number'});
  assert.equal(r.status,400);assert.equal(calls.length,before);
});
test('auth, admin and parent guards precede fallback checkout', async () => {
  const before = calls.length;
  const route = '/admin/clients/synthetic-parent/subscription-checkout';
  assert.equal((await request(app).post(route).send({})).status, 401);
  assert.equal((await request(app).post(route).set('Authorization', 'Bearer synthetic').send({})).status, 403);
  assert.equal((await send({ plan_tier: 'enterprise' }, 'synthetic-child')).status, 403);
  assert.equal(calls.length, before);
});
