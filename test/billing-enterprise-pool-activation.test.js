'use strict';

// An Enterprise agreement checkout that includes an interview pool, end to end.
//
// The pool rides the subscription checkout session, so one checkout.session.completed
// has to do two things: settle the pool, and activate the subscription and the
// agreement it paid for. The webhook and the activation service are the real ones;
// Stripe, Supabase, email and auth are stubbed. No database, no network.

const assert = require('node:assert/strict');
const express = require('express');
const path = require('node:path');
const { test } = require('node:test');
const request = require('supertest');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const webhookPath = path.join(ROOT, 'src', 'routes', 'webhooks', 'stripe.js');
const activationPath = path.join(ROOT, 'src', 'services', 'publicPurchaseActivation.js');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const stripeClientPath = path.join(ROOT, 'src', 'clients', 'stripe.js');
const sendgridPath = path.join(ROOT, 'src', 'clients', 'sendgrid.js');
const recoveryHelperPath = path.join(ROOT, 'src', 'services', 'recoveryHelper.js');
const salesIntegrationsPath = path.join(ROOT, 'src', 'services', 'salesIntegrations.js');
const clientBillingScopePath = path.join(ROOT, 'src', 'services', 'clientBillingScope.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const CLIENT = 'client_ent_1';
const AGREEMENT = 'agr_ent_1';
const POOL = 'pool_ent_1';
const ADMIN_EMAIL = 'owner@enterprise.example';

const ENTERPRISE_METADATA = Object.freeze({
  source: 'agreement_checkout',
  agreement_id: AGREEMENT,
  client_id: CLIENT,
  plan_tier: 'enterprise',
  billing_interval: 'monthly',
  platform_fee: '1200',
  per_role_fee: '0',
  included_interviews_per_role: '0',
  additional_interview_fee: '0',
  usage_interview_fee_cents: '2500'
});

const POOL_METADATA = Object.freeze({
  purchase_type: 'interview_pool',
  client_interview_pool_id: POOL,
  pool_quantity: '30',
  pool_unit_price_cents: '2500',
  pool_discount_pct: '5',
  pool_total_cents: '71250'
});

function makeDb({ pool = {}, agreement = {}, client = {}, intents = [] } = {}) {
  const db = createFakeSupabase({
    clients: [{
      id: CLIENT, parent_client_id: null, name: 'Enterprise Co', email: ADMIN_EMAIL,
      stripe_customer_id: 'cus_ent', stripe_subscription_id: null, plan_tier: null,
      billing_status: 'inactive', subscription_status: null, ...client
    }],
    membership_agreements: [{
      id: AGREEMENT, client_id: CLIENT, status: 'signed', is_current: true,
      checkout_status: 'pending', checkout_session_id: null, checkout_paid_at: null,
      primary_admin_name: 'Owner', admin_email: ADMIN_EMAIL, client_legal_name: 'Enterprise Co',
      membership_tier: 'enterprise', billing_option: 'monthly', auto_renew: true,
      superseded_by_agreement_id: null,
      template_snapshot: {
        values: {
          membership_tier: 'enterprise', billing_option: 'monthly',
          platform_fee: '1200', per_role_fee: '0', included_interviews_per_role: '0',
          additional_interview_fee: '0', usage_interview_fee_cents: '2500', pool_quantity: '30'
        }
      },
      ...agreement
    }],
    public_purchase_intents: intents,
    client_interview_pools: [{
      id: POOL, client_id: CLIENT, quantity_purchased: 30, unit_price_cents: 2500,
      discount_pct: 5, total_cents: 71250, status: 'pending', ...pool
    }],
    client_plan_settings: [],
    client_members: [],
    billing_events: []
  }, {
    // billing_events.stripe_event_id is unique, which is what turns a redelivery
    // into a replay rather than a second run.
    unique: { billing_events: (row) => row.stripe_event_id }
  });
  db.rpcs = [];
  // An agreement sent by an admin has no public purchase intent, so the activation
  // claim answers the way the database does for that case.
  db.rpc = async (name, args) => {
    db.rpcs.push({ name, args });
    if (name === 'claim_public_purchase_activation') {
      return { data: { status: 'purchase_intent_missing' }, error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  };
  db.auth = {
    admin: {
      listUsers: async () => ({ data: { users: [{ id: 'user_owner', email: ADMIN_EMAIL }] }, error: null }),
      getUserById: async () => ({ data: { user: { id: 'user_owner', email: ADMIN_EMAIL } }, error: null })
    }
  };
  return db;
}

function liveSubscription(metadata = { ...ENTERPRISE_METADATA, ...POOL_METADATA }) {
  return {
    id: 'sub_ent', status: 'active', customer: 'cus_ent',
    start_date: 1789000000, current_period_end: 1791600000, cancel_at_period_end: false,
    items: { data: [{ price: { recurring: { interval: 'month' } } }] },
    metadata
  };
}

function checkoutEvent({ type = 'checkout.session.completed', payment_status = 'paid', metadata = {}, id } = {}) {
  return {
    id: id || `evt_${type}_${payment_status}_${Math.random().toString(16).slice(2)}`,
    type,
    created: 1789000000,
    data: {
      object: {
        id: 'cs_ent', mode: 'subscription', status: 'complete', payment_status,
        customer: 'cus_ent', subscription: 'sub_ent', payment_intent: 'pi_ent',
        metadata: { ...ENTERPRISE_METADATA, ...POOL_METADATA, ...metadata }
      }
    }
  };
}

function loadApp(event, db, { subscription = liveSubscription() } = {}) {
  for (const p of [webhookPath, activationPath, stripeClientPath, supabasePath, sendgridPath,
    recoveryHelperPath, salesIntegrationsPath, clientBillingScopePath]) {
    delete require.cache[p];
  }
  const subscriptionRetrievals = [];
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });
  injectModule(stripeClientPath, {
    webhooks: { constructEvent: () => event },
    subscriptions: {
      retrieve: async (id) => {
        subscriptionRetrievals.push(id);
        return structuredClone(subscription);
      }
    }
  });
  injectModule(sendgridPath, {
    sendMemberRecoveryEmail: async () => ({ statusCode: 202 }),
    sendAlphaScreenWelcomeEmail: async () => ({ statusCode: 202 })
  });
  injectModule(recoveryHelperPath, {
    ensureUserAndSendRecovery: async () => ({ userId: 'user_owner', method: 'existing_user' }),
    redactEmail: () => '[redacted]'
  });
  injectModule(salesIntegrationsPath, { enqueueSalesWonDelivery: async () => ({ status: 'not_applicable' }) });

  const app = express();
  app.use('/webhook/stripe', express.raw({ type: 'application/json' }), require(webhookPath));
  return { app, subscriptionRetrievals };
}

const post = (app) => request(app)
  .post('/webhook/stripe')
  .set('Content-Type', 'application/json')
  .set('stripe-signature', 't=1,v1=stubbed')
  .send(Buffer.from('{}'));

const poolRow = (db) => db.tables.client_interview_pools[0];
const clientRow = (db) => db.tables.clients[0];
const agreementRow = (db) => db.tables.membership_agreements[0];
const planSettingsFor = (db) => db.tables.client_plan_settings.filter((row) => row.client_id === CLIENT);

function assertActivated(db) {
  assert.equal(clientRow(db).stripe_subscription_id, 'sub_ent', 'the client is linked to the subscription');
  assert.equal(clientRow(db).billing_status, 'active');
  assert.equal(clientRow(db).plan_tier, 'enterprise');
  const settings = planSettingsFor(db);
  assert.ok(settings.length >= 1, 'Enterprise plan settings are written');
  const latest = settings.at(-1);
  assert.equal(latest.plan_tier, 'enterprise');
  assert.equal(latest.usage_interview_fee_cents, 2500);
  assert.equal(latest.included_interviews_per_role, 0);
  assert.equal(agreementRow(db).checkout_status, 'paid', 'the agreement is marked paid');
  assert.equal(agreementRow(db).checkout_session_id, 'cs_ent');
}

function assertNotActivated(db) {
  assert.equal(clientRow(db).stripe_subscription_id, null);
  assert.equal(clientRow(db).billing_status, 'inactive');
  assert.deepEqual(planSettingsFor(db), []);
  assert.equal(agreementRow(db).checkout_status, 'pending');
}

test('a paid Enterprise checkout with a pool settles the pool and activates the agreement', async () => {
  const db = makeDb();
  const { app } = loadApp(checkoutEvent(), db);

  const res = await post(app);

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(poolRow(db).status, 'paid', 'the pool is settled');
  assert.equal(poolRow(db).stripe_payment_intent_id, 'pi_ent');
  assertActivated(db);
});

const activationClaims = (db) => db.rpcs.filter((call) => call.name === 'claim_public_purchase_activation').length;
const writesTo = (db, table, op) => db.calls.filter((call) => call.table === table && call.op === op).length;
const eventRow = (db) => db.tables.billing_events.at(-1);

test('a failed payment fails the pool and activates nothing', async () => {
  const db = makeDb();
  const { app } = loadApp(checkoutEvent({ type: 'checkout.session.async_payment_failed', payment_status: 'unpaid' }), db);

  assert.equal((await post(app)).status, 200);

  assert.equal(poolRow(db).status, 'failed');
  assertNotActivated(db);
  assert.equal(activationClaims(db), 0);
});

test('a completed session whose payment has not settled grants nothing', async () => {
  const db = makeDb();
  const { app } = loadApp(checkoutEvent({ payment_status: 'unpaid' }), db);

  assert.equal((await post(app)).status, 200);

  assert.equal(poolRow(db).status, 'pending', 'the pool is not granted');
  assertNotActivated(db);
  assert.equal(activationClaims(db), 0, 'the agreement is not activated');
});

test('a redelivered event leaves the pool paid once and does not activate again', async () => {
  const db = makeDb();
  const event = checkoutEvent({ id: 'evt_redelivered' });

  assert.equal((await post(loadApp(event, db).app)).status, 200);
  const paidAt = poolRow(db).paid_at;
  const poolWrites = writesTo(db, 'client_interview_pools', 'update');
  const clientWrites = writesTo(db, 'clients', 'update');
  const agreementWrites = writesTo(db, 'membership_agreements', 'update');
  assert.equal(activationClaims(db), 1);

  assert.equal((await post(loadApp(event, db).app)).status, 200);

  assert.equal(poolRow(db).status, 'paid');
  assert.equal(poolRow(db).paid_at, paidAt, 'the pool is paid once');
  assert.equal(writesTo(db, 'client_interview_pools', 'update'), poolWrites);
  assert.equal(activationClaims(db), 1, 'activation is not repeated');
  assert.equal(writesTo(db, 'clients', 'update'), clientWrites);
  assert.equal(writesTo(db, 'membership_agreements', 'update'), agreementWrites);
  assertActivated(db);
});

test('a pool the session does not describe is a permanent failure that activates nothing', async () => {
  for (const [label, options] of [
    ['missing pool id', { metadata: { client_interview_pool_id: '' } }],
    ['pool belongs to another client', { pool: { client_id: 'client_other' } }],
    ['quantity disagrees with the row', { metadata: { pool_quantity: '999' } }],
    ['pool row does not exist', { metadata: { client_interview_pool_id: 'pool_missing' } }]
  ]) {
    const db = makeDb({ pool: options.pool || {} });
    const { app, subscriptionRetrievals } = loadApp(checkoutEvent({ metadata: options.metadata || {} }), db);

    const res = await post(app);

    assert.equal(res.status, 200, `${label}: acknowledged, since no retry can fix it`);
    assert.equal(eventRow(db).processed_ok, false, `${label}: recorded as not processed`);
    assert.match(String(eventRow(db).error), /Interview pool/, `${label}: the reason is recorded`);
    assert.equal(poolRow(db).status, 'pending', `${label}: the pool is untouched`);
    assertNotActivated(db);
    assert.equal(activationClaims(db), 0, `${label}: activation never started`);
    assert.deepEqual(subscriptionRetrievals, [], `${label}: refused before reaching Stripe`);
  }
});

test('an Enterprise agreement checkout without a pool activates', async () => {
  const db = makeDb();
  const event = checkoutEvent({ metadata: { purchase_type: '', client_interview_pool_id: '', pool_quantity: '' } });
  const { app } = loadApp(event, db, { subscription: liveSubscription({ ...ENTERPRISE_METADATA }) });

  const res = await post(app);

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assertActivated(db);
  assert.equal(poolRow(db).status, 'pending', 'a pool the session did not buy is not touched');
});

test('an Enterprise subscription without its terms is refused before anything is written', async () => {
  const db = makeDb();
  const terms = { ...ENTERPRISE_METADATA, ...POOL_METADATA };
  delete terms.platform_fee;
  const { app } = loadApp(checkoutEvent(), db, { subscription: liveSubscription(terms) });

  const res = await post(app);

  assert.equal(res.status, 503, 'a paid agreement that did not activate is retried');
  assert.match(String(eventRow(db).error), /Enterprise agreement activation requires plan settings/);
  assertNotActivated(db);
  assert.equal(poolRow(db).status, 'pending', 'the pool is settled only after activation succeeds');
});

test('Enterprise is still refused through a public purchase', async () => {
  const db = makeDb({
    intents: [{
      id: 'ppi_ent', agreement_id: AGREEMENT, status: 'pending', protocol: 'fenced_v2',
      selected_plan_key: 'enterprise', selected_billing_cadence: 'monthly',
      activated_at: null, canceled_at: null
    }]
  });
  const { app } = loadApp(checkoutEvent(), db);

  const res = await post(app);

  assert.equal(res.status, 503);
  assert.match(String(eventRow(db).error), /invalid membership key/);
  assertNotActivated(db);
  assert.equal(poolRow(db).status, 'pending');
});
