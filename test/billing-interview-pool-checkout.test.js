'use strict';

// Buying the Enterprise interview pool at signup, and settling it.
//
// The pool is a one-off charge riding the same subscription checkout as the
// membership, priced by the volume bands. The row is reserved before the session
// exists so the webhook always has something to mark paid, and it only becomes
// spendable once the money settles.
//
// Stripe and Supabase are stubbed; no network.

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const request = require('supertest');

const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { guardPlanSettingsNotNull } = require('./helpers/planSettingsNotNull');

const ROOT = path.join(__dirname, '..');
const checkoutPath = path.join(ROOT, 'src', 'services', 'subscriptionCheckout.js');
const webhookPath = path.join(ROOT, 'src', 'routes', 'webhooks', 'stripe.js');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const stripeClientPath = path.join(ROOT, 'src', 'clients', 'stripe.js');
const clientBillingScopePath = path.join(ROOT, 'src', 'services', 'clientBillingScope.js');
const urlConfigPath = path.join(ROOT, 'src', 'config', 'urlConfig.js');
const activationPath = path.join(ROOT, 'src', 'services', 'publicPurchaseActivation.js');
const stripePackagePath = require.resolve('stripe');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const CLIENT = 'client_1';

const DISCOUNTS = [
  { id: 'd1', min_quantity: 20, discount_pct: 0 },
  { id: 'd2', min_quantity: 30, discount_pct: 5 },
  { id: 'd3', min_quantity: 50, discount_pct: 10 }
];

function makeDb({ pools = [] } = {}) {
  // max_interview_minutes is NOT NULL with no default in the hosted database.
  return guardPlanSettingsNotNull(createFakeSupabase({
    clients: [{
      id: CLIENT, parent_client_id: null, name: 'Acme Dental Group',
      email: 'owner@acme.example', stripe_customer_id: 'cus_1', stripe_subscription_id: null
    }],
    billing_customers: [],
    enterprise_pool_discounts: DISCOUNTS,
    client_interview_pools: pools.map(p=>({offer_snapshot:null,offer_digest:null,...p})),
    client_interview_pool_draws: []
  }));
}

// --- buying ---------------------------------------------------------------

function loadCheckout(db, stripeCalls) {
  for (const p of [checkoutPath, supabasePath, clientBillingScopePath, urlConfigPath, stripePackagePath]) {
    delete require.cache[p];
  }
  injectModule(supabasePath, { supabaseAdmin: db });
  injectModule(clientBillingScopePath, { requireParentClient: async () => ({ ok: true, clientId: CLIENT }) });
  injectModule(urlConfigPath, {
    resolvePublicBackendBase: (value) => value || 'https://api.test',
    buildClientDashboardReturnUrl: () => 'https://dash.test/return'
  });
  injectModule(stripePackagePath, function Stripe() {
    return {
      customers: {
        retrieve: async (id) => ({ id }),
        update: async (id) => ({ id }),
        create: async () => ({ id: 'cus_created' })
      },
      subscriptions: { list: async () => ({ data: [] }) },
      prices: {
        create: async (payload) => {
          stripeCalls.prices.push(payload);
          return { id: `price_${stripeCalls.prices.length}` };
        }
      },
      checkout: {
        sessions: {
          create: async (payload) => {
            stripeCalls.sessions.push(payload);
            return { id: 'cs_1', url: 'https://checkout.test/cs_1' };
          }
        }
      }
    };
  });
  return require(checkoutPath);
}

const ENTERPRISE_FEES = Object.freeze({
  platform_fee: 1200,
  per_role_fee: 0,
  included_interviews_per_role: 0,
  additional_interview_fee: 0,
  usage_interview_fee_cents: 2500
});

async function buy(db, enterpriseFees) {
  const stripeCalls = { prices: [], sessions: [] };
  const previous = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  try {
    const { createSubscriptionCheckoutSession } = loadCheckout(db, stripeCalls);
    const result = await createSubscriptionCheckoutSession({
      clientId: CLIENT,
      planTier: 'enterprise',
      billingInterval: 'monthly',
      metadataSource: 'admin_subscription_checkout',
      enterpriseFees,
      requestContext: { forwardedProto: 'https', forwardedHost: 'api.test' }
    });
    return { result, stripeCalls };
  } finally {
    if (previous === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previous;
  }
}

test('a pool is priced by the bands and charged as one line', async () => {
  const db = makeDb();

  const { result, stripeCalls } = await buy(db, { ...ENTERPRISE_FEES, pool_quantity: 50 });

  const poolPrice = stripeCalls.prices.find((p) => p.metadata?.purchase_type === 'interview_pool');
  assert.ok(poolPrice, 'a pool price must be created');
  assert.equal(poolPrice.unit_amount, 112500, '50 x 2500 less 10%');
  assert.equal(poolPrice.recurring, undefined, 'the pool is one-off, not recurring');
  assert.match(poolPrice.product_data.name, /50 interviews/);

  const poolLine = stripeCalls.sessions[0].line_items.find((item) => item.price === poolPrice.__id || item.quantity === 1);
  assert.ok(poolLine, 'the pool rides the subscription session');
  assert.equal(stripeCalls.sessions[0].line_items.length, 2, 'membership plus pool');
  assert.ok(result.interviewPoolId);
});

test('the pending pool row is reserved before the session is created', async () => {
  const db = makeDb();

  const { result } = await buy(db, { ...ENTERPRISE_FEES, pool_quantity: 30 });

  const row = db.tables.client_interview_pools[0];
  assert.equal(row.id, result.interviewPoolId);
  assert.equal(row.status, 'pending');
  assert.equal(row.quantity_purchased, 30);
  assert.equal(row.quantity_remaining, undefined,
    'nothing stores a balance; pending status is what makes it unspendable');
  assert.equal(row.unit_price_cents, 2500);
  assert.equal(Number(row.discount_pct), 5);
  assert.equal(row.total_cents, 71250, '30 x 2500 less 5%');
  assert.equal(row.stripe_checkout_session_id, 'cs_1', 'linked once the session exists');
});

test('the pool travels in the checkout metadata so the webhook can find it', async () => {
  const db = makeDb();

  const { result, stripeCalls } = await buy(db, { ...ENTERPRISE_FEES, pool_quantity: 50 });

  const metadata = stripeCalls.sessions[0].metadata;
  assert.equal(metadata.purchase_type, 'interview_pool');
  assert.equal(metadata.client_interview_pool_id, result.interviewPoolId);
  assert.equal(metadata.pool_quantity, '50');
  assert.equal(metadata.pool_total_cents, '112500');
  assert.equal(metadata.pool_discount_pct, '10');
});

test('no pool quantity means no pool and no extra line', async () => {
  const db = makeDb();

  const { result, stripeCalls } = await buy(db, { ...ENTERPRISE_FEES });

  assert.equal(result.interviewPoolId, null);
  assert.equal(stripeCalls.sessions[0].line_items.length, 1);
  assert.deepEqual(db.tables.client_interview_pools, []);
  assert.ok(!('pool_quantity' in stripeCalls.sessions[0].metadata));
});

test('a pool without a usage price is refused with its own code', async () => {
  const db = makeDb();
  const fees = { ...ENTERPRISE_FEES, pool_quantity: 50 };
  delete fees.usage_interview_fee_cents;

  await assert.rejects(
    () => buy(db, fees),
    (err) => {
      assert.equal(err.code, 'pool_requires_usage_price');
      assert.equal(err.status, 400);
      return true;
    },
    'a pool is sold at the usage price, so it cannot be priced without one'
  );
  assert.deepEqual(db.tables.client_interview_pools, [], 'nothing reserved on a refusal');
});

test('an unusable pool quantity is refused', async () => {
  for (const quantity of [0, -5, 2.5, 'fifty']) {
    const db = makeDb();
    await assert.rejects(
      () => buy(db, { ...ENTERPRISE_FEES, pool_quantity: quantity }),
      (err) => {
        assert.equal(err.code, 'invalid_enterprise_fees');
        return true;
      },
      `pool_quantity ${JSON.stringify(quantity)} must be refused`
    );
  }
});

// --- settling -------------------------------------------------------------

// What buy() puts on the session: the pool rides an Enterprise subscription
// checkout, so settling it and activating the membership arrive as one event.
const SUBSCRIPTION_METADATA = Object.freeze({
  source: 'admin_subscription_checkout',
  client_id: CLIENT,
  plan_tier: 'enterprise',
  billing_interval: 'monthly',
  platform_fee: '1200',
  per_role_fee: '0',
  included_interviews_per_role: '0',
  additional_interview_fee: '0',
  usage_interview_fee_cents: '2500'
});

function loadWebhook(event, db) {
  for (const p of [webhookPath, stripeClientPath, supabasePath, activationPath, clientBillingScopePath]) {
    delete require.cache[p];
  }

  injectModule(activationPath, { activatePublicPurchaseAgreementCheckout: async () => ({ ok: true }) });
  injectModule(stripeClientPath, {
    webhooks: { constructEvent: () => event },
    subscriptions: {
      retrieve: async () => ({
        id: 'sub_1', status: 'active', customer: 'cus_1',
        items: { data: [{ price: { recurring: { interval: 'month' } } }] },
        metadata: { ...SUBSCRIPTION_METADATA }
      })
    }
  });
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });

  const app = express();
  app.use('/webhook/stripe', express.raw({ type: 'application/json' }), require(webhookPath));
  return app;
}

function poolEvent({ type = 'checkout.session.completed', payment_status = 'paid', metadata = {} } = {}) {
  return {
    id: `evt_${Math.random().toString(16).slice(2)}`,
    type,
    created: 1789000000,
    data: {
      object: {
        id: 'cs_1', mode: 'subscription', status: 'complete', payment_status,
        customer: 'cus_1', subscription: 'sub_1', payment_intent: 'pi_1',
        metadata: {
          ...SUBSCRIPTION_METADATA,
          purchase_type: 'interview_pool',
          client_interview_pool_id: 'pool_1',
          client_id: CLIENT,
          pool_quantity: '30',
          ...metadata
        }
      }
    }
  };
}

const pendingPool = (overrides = {}) => ({
  id: 'pool_1', client_id: CLIENT, quantity_purchased: 30, quantity_remaining: 0,
  unit_price_cents: 2500, discount_pct: 5, total_cents: 71250, status: 'pending', ...overrides
});

const post = (app) => request(app)
  .post('/webhook/stripe')
  .set('Content-Type', 'application/json')
  .set('stripe-signature', 't=1,v1=stubbed')
  .send(Buffer.from('{}'));

function assertMembershipActivated(db) {
  const client = db.tables.clients[0];
  assert.equal(client.stripe_subscription_id, 'sub_1', 'the client is linked to the subscription');
  assert.equal(client.plan_tier, 'enterprise');
  const settings = db.tables.client_plan_settings.filter((row) => row.client_id === CLIENT);
  assert.equal(settings.length, 1, 'Enterprise plan settings are written');
  assert.equal(settings[0].usage_interview_fee_cents, 2500);
  assert.equal(settings[0].max_interview_minutes, 15, 'no length: the plan default');
  assert.deepEqual(db.notNullViolations, [], 'no null max_interview_minutes was sent');
}

function assertMembershipNotActivated(db) {
  assert.equal(db.tables.clients[0].stripe_subscription_id, null);
  assert.deepEqual(db.tables.client_plan_settings || [], []);
}

test('a settled pool checkout makes the interviews spendable', async () => {
  const db = makeDb({ pools: [pendingPool()] });

  assert.equal((await post(loadWebhook(poolEvent(), db))).status, 200);

  const row = db.tables.client_interview_pools[0];
  assert.equal(row.status, 'paid', 'paid is what makes the interviews spendable');
  assert.equal(row.quantity_purchased, 30);
  assert.equal(row.stripe_payment_intent_id, 'pi_1');
  assertMembershipActivated(db);
});

test('an unsettled session leaves the pool pending', async () => {
  const db = makeDb({ pools: [pendingPool()] });

  await post(loadWebhook(poolEvent({ payment_status: 'unpaid' }), db));

  assert.equal(db.tables.client_interview_pools[0].status, 'pending');
  assert.equal(db.tables.client_interview_pools[0].quantity_remaining, 0);
  assertMembershipNotActivated(db);
});

test('a failed payment marks the pool failed', async () => {
  const db = makeDb({ pools: [pendingPool()] });

  await post(loadWebhook(
    poolEvent({ type: 'checkout.session.async_payment_failed', payment_status: 'unpaid' }), db));

  assert.equal(db.tables.client_interview_pools[0].status, 'failed');
  assertMembershipNotActivated(db);
});

test('a redelivered settlement does not refill a drawn-down pool', async () => {
  const db = makeDb({ pools: [pendingPool({ status: 'paid', quantity_remaining: 4 })] });

  assert.equal((await post(loadWebhook(poolEvent(), db))).status, 200);

  assert.equal(db.tables.client_interview_pools[0].quantity_remaining, 4,
    'Stripe redelivers; spent interviews must not come back');
  assertMembershipActivated(db);
});

test('metadata that disagrees with the row is acknowledged, not retried', async () => {
  for (const [metadata, why] of [
    [{ client_id: 'client_other' }, 'client mismatch'],
    [{ pool_quantity: '999' }, 'quantity mismatch'],
    [{ client_interview_pool_id: '' }, 'missing pool id']
  ]) {
    const db = makeDb({ pools: [pendingPool()] });
    const res = await post(loadWebhook(poolEvent({ metadata }), db));

    assert.equal(res.status, 200, `${why} must be acknowledged, since no retry can fix it`);
    assert.equal(db.tables.client_interview_pools[0].status, 'pending');
    assertMembershipNotActivated(db);
  }
});

test('a pool id that does not exist is acknowledged', async () => {
  const db = makeDb({ pools: [] });

  const res = await post(loadWebhook(poolEvent(), db));

  assert.equal(res.status, 200);
  assertMembershipNotActivated(db);
});

test('the pool is checked before the purchase branches and settled after them', () => {
  const source = fs.readFileSync(webhookPath, 'utf8');
  const loaded = source.indexOf("purchaseType === 'interview_pool'\n        ? await loadInterviewPoolForCheckout(metadata)");
  const poolOnly = source.indexOf('if (interviewPool && !isSubscriptionSession) {');
  const additional = source.indexOf("} else if (purchaseType === 'additional_interviews') {");
  const settled = source.indexOf('await settleInterviewPoolFromCheckout(interviewPool');
  assert.ok(loaded > 0 && poolOnly > loaded, 'the pool is checked, writing nothing, before any branch runs');
  assert.ok(additional > poolOnly,
    'a pool on its own session and additional interviews stay exclusive branches of the same chain');
  assert.ok(settled > additional, 'the pool is settled after the branches, so a subscription session also activates');
});
