'use strict';

// A newly provisioned client must land on the billing model its tier implies,
// so nothing has to be set by hand after a subscription starts. It does so by
// leaving billing_model empty, which follows the tier: a stored value is an
// explicit choice, and the webhook never writes one.
//
// Driven through the real webhook rather than an exported internal, so the
// assertion is on what actually reaches client_plan_settings. The Stripe SDK,
// Supabase and the activation service are stubbed; no database, no network.

const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { test } = require('node:test');
const request = require('supertest');

const ROOT = path.join(__dirname, '..');
const routerPath = path.join(ROOT, 'src', 'routes', 'webhooks', 'stripe.js');
const { normalizeBillingModel } = require(path.join(ROOT, 'src', 'services', 'billingModel.js'));

// The model a provisioned row resolves to, and proof that it came from the tier
// rather than from a value the webhook stored.
function assertFollowsTier(upsert, expectedModel) {
  assert.ok(!('billing_model' in upsert), 'the webhook does not write billing_model');
  assert.equal(normalizeBillingModel(upsert.billing_model, upsert.plan_tier), expectedModel);
}
const stripeClientPath = path.join(ROOT, 'src', 'clients', 'stripe.js');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const activationPath = path.join(ROOT, 'src', 'services', 'publicPurchaseActivation.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Serves the client row for both the customer lookup and the billing-scope
// lookup, and records every plan-settings upsert.
function makeDb() {
  const client = { id: 'client_1', parent_client_id: null, stripe_subscription_id: null };
  const upserts = [];
  const processed = [];
  return {
    upserts,
    processed,
    from(table) {
      const filters = {};
      const query = {
        select() { return query; },
        eq(column, value) { filters[column] = value; return query; },
        neq() { return query; },
        is() { return query; },
        or() { return query; },
        in() { return query; },
        not() { return query; },
        order() { return query; },
        limit() { return query; },
        update(row) {
          if (table === 'billing_events') processed.push(row);
          return query;
        },
        insert() { return Promise.resolve({ error: null }); },
        delete() { return query; },
        upsert(row) {
          if (table === 'client_plan_settings') upserts.push(row);
          return Promise.resolve({ error: null });
        },
        maybeSingle() {
          if (table === 'clients') return Promise.resolve({ data: { ...client }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve) { return resolve({ data: null, error: null }); }
      };
      return query;
    }
  };
}

function subscriptionEvent(metadata, { interval = 'month' } = {}) {
  return {
    id: `evt_${Math.random().toString(16).slice(2)}`,
    type: 'customer.subscription.updated',
    created: 1789000000,
    data: {
      object: {
        id: 'sub_1',
        object: 'subscription',
        status: 'active',
        customer: 'cus_1',
        start_date: 1789000000,
        current_period_end: 1791600000,
        cancel_at_period_end: false,
        metadata,
        items: { data: [{ price: { recurring: { interval } }, metadata: {} }] }
      }
    }
  };
}

function loadApp(event) {
  for (const p of [routerPath, stripeClientPath, supabasePath, activationPath]) delete require.cache[p];

  injectModule(activationPath, { activatePublicPurchaseAgreementCheckout: async () => ({ ok: true }) });
  injectModule(stripeClientPath, {
    webhooks: { constructEvent: () => event },
    subscriptions: { retrieve: async () => event.data.object }
  });
  const db = makeDb();
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });

  const app = express();
  app.use('/webhook/stripe', express.raw({ type: 'application/json' }), require(routerPath));
  return { app, db };
}

async function post(app) {
  return request(app)
    .post('/webhook/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 't=1,v1=stubbed')
    .send(Buffer.from('{}'));
}

const ENTERPRISE_FEES = {
  platform_fee: '1200',
  per_role_fee: '0',
  included_interviews_per_role: '0',
  additional_interview_fee: '0'
};

test('an Essentials subscription provisions the fixed model', async () => {
  const { app, db } = loadApp(subscriptionEvent({
    source: 'admin_subscription_checkout', client_id: 'client_1',
    plan_tier: 'basic', billing_interval: 'monthly'
  }));

  assert.equal((await post(app)).status, 200);
  assert.equal(db.upserts.length, 1);
  assert.equal(db.upserts[0].plan_tier, 'basic');
  assertFollowsTier(db.upserts[0], 'fixed');
});

test('a Pro subscription provisions the rollover model', async () => {
  const { app, db } = loadApp(subscriptionEvent({
    source: 'admin_subscription_checkout', client_id: 'client_1',
    plan_tier: 'pro', billing_interval: 'monthly'
  }));

  assert.equal((await post(app)).status, 200);
  assert.equal(db.upserts[0].plan_tier, 'pro');
  assertFollowsTier(db.upserts[0], 'rollover');
});

test('an Enterprise subscription provisions the usage model', async () => {
  const { app, db } = loadApp(subscriptionEvent({
    source: 'admin_subscription_checkout', client_id: 'client_1',
    plan_tier: 'enterprise', billing_interval: 'monthly', ...ENTERPRISE_FEES
  }));

  assert.equal((await post(app)).status, 200);
  assert.equal(db.upserts[0].plan_tier, 'enterprise');
  assertFollowsTier(db.upserts[0], 'usage');
});

test('an Enterprise usage price carries through from the subscription metadata', async () => {
  const { app, db } = loadApp(subscriptionEvent({
    source: 'admin_subscription_checkout', client_id: 'client_1',
    plan_tier: 'enterprise', billing_interval: 'monthly',
    ...ENTERPRISE_FEES, usage_interview_fee_cents: '2500'
  }));

  assert.equal((await post(app)).status, 200);
  assert.equal(db.upserts[0].usage_interview_fee_cents, 2500);
});

test('no usage price in the metadata leaves the column alone', async () => {
  const { app, db } = loadApp(subscriptionEvent({
    source: 'admin_subscription_checkout', client_id: 'client_1',
    plan_tier: 'enterprise', billing_interval: 'monthly', ...ENTERPRISE_FEES
  }));

  assert.equal((await post(app)).status, 200);
  assert.ok(!('usage_interview_fee_cents' in db.upserts[0]),
    'an absent price must not overwrite a value an administrator set');
});

test('the existing plan settings fields are unchanged by the new column', async () => {
  const { app, db } = loadApp(subscriptionEvent({
    source: 'admin_subscription_checkout', client_id: 'client_1',
    plan_tier: 'pro', billing_interval: 'monthly'
  }));

  await post(app);
  assert.deepEqual(db.upserts[0], {
    client_id: 'client_1',
    plan_tier: 'pro',
    billing_interval: 'monthly',
    platform_fee: 599,
    per_role_fee: 699,
    included_interviews_per_role: 30,
    additional_interview_fee: 30,
    max_interview_minutes: 12
  });
});

// --- a required figure that was never sent ---------------------------------
//
// Number(null) and Number('') are both 0, so an absent count or price used to
// reach client_plan_settings as a deliberate zero. Zero is a real Enterprise
// setting — no included interviews, billed from the pool and the meter — so
// absence and zero must not arrive looking the same.

// The webhook records why it gave up on the dedupe row, which is where an
// operator looks after a client is not provisioned.
const missingMetadataDetail = (db) =>
  db.processed.map((row) => String(row?.error || '')).join(' ');

test('a missing included count is refused, not read as zero', async () => {
  const metadata = {
    source: 'admin_subscription_checkout', client_id: 'client_1',
    plan_tier: 'enterprise', billing_interval: 'monthly', ...ENTERPRISE_FEES
  };
  delete metadata.included_interviews_per_role;
  const { app, db } = loadApp(subscriptionEvent(metadata));

  const res = await post(app);

  assert.equal(res.status, 200, 'a permanent failure is acknowledged, not retried');
  assert.deepEqual(db.upserts, [], 'nothing is provisioned from a figure nobody chose');
  assert.match(missingMetadataDetail(db), /included_interviews_per_role/,
    'the reason names the field that was missing');
});

test('an empty included count is refused the same way', async () => {
  const { app, db } = loadApp(subscriptionEvent({
    source: 'admin_subscription_checkout', client_id: 'client_1',
    plan_tier: 'enterprise', billing_interval: 'monthly',
    ...ENTERPRISE_FEES, included_interviews_per_role: '   '
  }));

  assert.equal((await post(app)).status, 200);
  assert.deepEqual(db.upserts, []);
  assert.match(missingMetadataDetail(db), /included_interviews_per_role/);
});

test('an included count of zero is a setting and provisions normally', async () => {
  const { app, db } = loadApp(subscriptionEvent({
    source: 'admin_subscription_checkout', client_id: 'client_1',
    plan_tier: 'enterprise', billing_interval: 'monthly',
    ...ENTERPRISE_FEES, included_interviews_per_role: '0'
  }));

  assert.equal((await post(app)).status, 200);
  assert.equal(db.upserts.length, 1);
  assert.equal(db.upserts[0].included_interviews_per_role, 0,
    'nought included means billed from the pool and the meter from the first interview');
});

test('an included count of a number provisions that number', async () => {
  const { app, db } = loadApp(subscriptionEvent({
    source: 'admin_subscription_checkout', client_id: 'client_1',
    plan_tier: 'enterprise', billing_interval: 'monthly',
    ...ENTERPRISE_FEES, included_interviews_per_role: '25'
  }));

  assert.equal((await post(app)).status, 200);
  assert.equal(db.upserts[0].included_interviews_per_role, 25);
});

test('a missing fee is refused too, and every missing field is named', async () => {
  const metadata = {
    source: 'admin_subscription_checkout', client_id: 'client_1',
    plan_tier: 'enterprise', billing_interval: 'monthly', ...ENTERPRISE_FEES
  };
  delete metadata.per_role_fee;
  delete metadata.additional_interview_fee;
  const { app, db } = loadApp(subscriptionEvent(metadata));

  assert.equal((await post(app)).status, 200);
  assert.deepEqual(db.upserts, []);
  const detail = missingMetadataDetail(db);
  assert.match(detail, /per_role_fee/);
  assert.match(detail, /additional_interview_fee/);
});

test('a fee of zero is kept, because an Enterprise fee may be nothing', async () => {
  const { app, db } = loadApp(subscriptionEvent({
    source: 'admin_subscription_checkout', client_id: 'client_1',
    plan_tier: 'enterprise', billing_interval: 'monthly',
    ...ENTERPRISE_FEES, per_role_fee: '0', additional_interview_fee: '0'
  }));

  assert.equal((await post(app)).status, 200);
  assert.equal(db.upserts[0].per_role_fee, 0);
  assert.equal(db.upserts[0].additional_interview_fee, 0);
});

test('the refusal is permanent, so Stripe is not asked to retry it forever', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'webhooks', 'stripe.js'), 'utf8');
  const at = source.indexOf("err.code = 'enterprise_plan_settings_metadata_missing'");
  assert.notEqual(at, -1);
  assert.match(source.slice(Math.max(0, at - 600), at), /permanentFailure\(/,
    'the metadata on a subscription does not change between redeliveries');
});
