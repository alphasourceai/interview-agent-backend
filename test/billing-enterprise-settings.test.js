'use strict';

// Per-client Enterprise settings: billing_model, rollover_days,
// max_interview_minutes and scored_question_count.
//
// They travel the road the Enterprise prices already use — admin agreement ->
// agreement snapshot -> Stripe checkout metadata -> webhook -> client_plan_settings
// — and are refused, with a named code, before anything is written or sent to
// Stripe. Nothing reads them yet.
//
// The routes, the checkout service, the webhook and the activation are the real
// ones. Stripe, Supabase, PDF rendering and email are stubbed; no network.

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const request = require('supertest');

const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { guardPlanSettingsNotNull } = require('./helpers/planSettingsNotNull');
const { PLAN_CAPACITY } = require('../src/services/planCapacity');

const ROOT = path.join(__dirname, '..');
const src = (...parts) => path.join(ROOT, 'src', ...parts);
const PATHS = {
  settings: src('services', 'enterpriseSettings.js'),
  adminRouter: src('routes', 'admin', 'billingRouter.js'),
  checkoutRouter: src('routes', 'public', 'membershipAgreements', 'checkout.js'),
  agreementsService: src('services', 'membershipAgreements', 'index.js'),
  subscriptionCheckout: src('services', 'subscriptionCheckout.js'),
  webhook: src('routes', 'webhooks', 'stripe.js'),
  activation: src('services', 'publicPurchaseActivation.js'),
  supabase: src('clients', 'supabase.js'),
  stripeClient: src('clients', 'stripe.js'),
  sendgrid: src('clients', 'sendgrid.js'),
  pdf: src('render', 'pdfRenderer.js'),
  recovery: src('services', 'recoveryHelper.js'),
  salesIntegrations: src('services', 'salesIntegrations.js'),
  billingScope: src('services', 'clientBillingScope.js'),
  billingModel: src('services', 'billingModel.js'),
  stripePackage: require.resolve('stripe')
};
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20261011130000_client_plan_settings_interview_settings.sql');

const {
  INTERVIEW_MINUTES_MAX,
  SCORED_QUESTIONS_MAX,
  validateEnterpriseSettings
} = require(PATHS.settings);

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const CLIENT = '7b1e4c2a-0000-4000-8000-000000000001';
const ADMIN_EMAIL = 'admin@alphasource.example';
const OWNER_EMAIL = 'owner@enterprise.example';

const ENTERPRISE_PRICES = Object.freeze({
  platform_fee: '1200',
  per_role_fee: '0',
  included_interviews_per_role: '0',
  additional_interview_fee: '0',
  usage_interview_fee_cents: '2500'
});

const ALL_FOUR = Object.freeze({
  billing_model: 'rollover',
  rollover_days: '120',
  max_interview_minutes: '30',
  scored_question_count: '6'
});

// --- the rules ----------------------------------------------------------------

const enterprise = (input) => validateEnterpriseSettings({ ...ENTERPRISE_PRICES, ...input }, { planTier: 'enterprise' });
const refusedWith = (result, code) => {
  assert.equal(result.ok, false, `expected ${code}, got ok`);
  assert.equal(result.code, code);
  assert.equal(result.status, 400);
};

test('the limits are the real ones: 59 minutes and 7 questions', () => {
  // 3600 s provider call limit less the 20 s closing grace; every interview
  // type's rubric blueprint has seven entries.
  assert.equal(INTERVIEW_MINUTES_MAX, 59);
  assert.equal(SCORED_QUESTIONS_MAX, 7);
});

test('billing_model must be fixed, rollover or usage', () => {
  for (const model of ['fixed', 'rollover', 'usage', 'USAGE']) {
    assert.equal(enterprise({ billing_model: model }).ok, true, model);
  }
  refusedWith(enterprise({ billing_model: 'metered' }), 'invalid_billing_model');
});

test('the usage model needs a usage price above zero', () => {
  const noPrice = { ...ENTERPRISE_PRICES };
  delete noPrice.usage_interview_fee_cents;
  refusedWith(validateEnterpriseSettings(noPrice, { planTier: 'enterprise' }), 'usage_price_required');
  refusedWith(enterprise({ usage_interview_fee_cents: '0' }), 'usage_price_required');
  refusedWith(enterprise({ billing_model: 'usage', usage_interview_fee_cents: '0' }), 'usage_price_required');
  assert.equal(enterprise({ usage_interview_fee_cents: '1' }).ok, true);
  // The tier's model is usage, so an Enterprise agreement that names no model
  // needs the price too: that is the gap where overage was never billed.
  assert.equal(validateEnterpriseSettings({ ...noPrice, billing_model: 'fixed' }, { planTier: 'enterprise' }).ok, true);
});

test('a pool is allowed only on the usage model', () => {
  assert.equal(enterprise({ pool_quantity: '30' }).ok, true);
  refusedWith(enterprise({ billing_model: 'fixed', pool_quantity: '30' }), 'pool_requires_usage_model');
  refusedWith(enterprise({ billing_model: 'rollover', pool_quantity: '30' }), 'pool_requires_usage_model');
  assert.equal(enterprise({ billing_model: 'fixed', pool_quantity: '0' }).ok, true, 'zero is "no pool"');
});

test('rollover_days is a whole number from 1 to 365, and only with the rollover model', () => {
  for (const days of ['1', '90', '365', 365]) {
    assert.equal(enterprise({ billing_model: 'rollover', rollover_days: days }).ok, true, String(days));
  }
  for (const days of ['0', '366', '12.5', '-3', 'ninety', 30.5]) {
    refusedWith(enterprise({ billing_model: 'rollover', rollover_days: days }), 'invalid_rollover_days');
  }
  refusedWith(enterprise({ rollover_days: '90' }), 'rollover_days_requires_rollover_model');
  refusedWith(enterprise({ billing_model: 'fixed', rollover_days: '90' }), 'rollover_days_requires_rollover_model');
});

test('max_interview_minutes is a whole number from 5 to 59', () => {
  for (const minutes of ['5', '15', '59']) {
    assert.equal(enterprise({ max_interview_minutes: minutes, scored_question_count: '5' }).ok, true, minutes);
  }
  for (const minutes of ['4', '60', '0', '20.5', 'half an hour']) {
    refusedWith(enterprise({ max_interview_minutes: minutes, scored_question_count: '5' }), 'invalid_max_interview_minutes');
  }
});

test('scored_question_count is a whole number from 1 to the blueprint size', () => {
  for (const count of ['1', '7']) {
    assert.equal(enterprise({ max_interview_minutes: '20', scored_question_count: count }).ok, true, count);
  }
  for (const count of ['0', '8', '2.5', 'six']) {
    refusedWith(enterprise({ max_interview_minutes: '20', scored_question_count: count }), 'invalid_scored_question_count');
  }
});

test('interview length and question count are given together or not at all', () => {
  refusedWith(enterprise({ max_interview_minutes: '20' }), 'interview_length_and_questions_required_together');
  refusedWith(enterprise({ scored_question_count: '5' }), 'interview_length_and_questions_required_together');
  assert.equal(enterprise({}).ok, true);
});

test('Essentials and Pro refuse every one of these settings', () => {
  for (const planTier of ['basic', 'pro']) {
    for (const [field, value] of Object.entries(ALL_FOUR)) {
      refusedWith(validateEnterpriseSettings({ [field]: value }, { planTier }), 'enterprise_settings_not_allowed');
    }
    assert.equal(validateEnterpriseSettings({}, { planTier }).ok, true);
  }
});

// --- the harness ---------------------------------------------------------------

function makeDb({ client = {}, planSettings = [] } = {}) {
  const db = createFakeSupabase({
    clients: [{
      id: CLIENT, parent_client_id: null, name: 'Enterprise Co', email: OWNER_EMAIL,
      client_admin_name: 'Owner', stripe_customer_id: 'cus_ent', stripe_subscription_id: null,
      plan_tier: null, billing_status: 'inactive', ...client
    }],
    admins: [{ id: 'adm_1', email: ADMIN_EMAIL, is_active: true }],
    billing_customers: [],
    membership_agreements: [],
    public_purchase_intents: [],
    client_plan_settings: planSettings,
    client_members: [],
    billing_events: []
  }, { unique: { billing_events: (row) => row.stripe_event_id } });

  // Upsert on client_id merges the named columns, as PostgREST does.
  const baseFrom = db.from;
  db.from = (table) => {
    const query = baseFrom(table);
    if (table !== 'client_plan_settings') return query;
    query.upsert = (payload) => {
      db.calls.push({ table, op: 'upsert', payload });
      const rows = db.tables.client_plan_settings;
      const existing = rows.find((row) => row.client_id === payload.client_id);
      if (existing) Object.assign(existing, payload);
      else rows.push({ ...payload });
      return Promise.resolve({ data: null, error: null });
    };
    return query;
  };
  db.uploads = [];
  db.storage = {
    from: () => ({
      upload: async (filePath) => {
        db.uploads.push(filePath);
        return { data: { path: filePath }, error: null };
      }
    })
  };
  db.rpc = async (name) => (name === 'claim_public_purchase_activation'
    ? { data: { status: 'purchase_intent_missing' }, error: null }
    : { data: null, error: { message: `unexpected rpc ${name}` } });
  db.auth = {
    admin: {
      listUsers: async () => ({ data: { users: [{ id: 'user_owner', email: OWNER_EMAIL }] }, error: null }),
      getUserById: async () => ({ data: { user: { id: 'user_owner', email: OWNER_EMAIL } }, error: null })
    }
  };
  // max_interview_minutes is NOT NULL with no default in the hosted database.
  return guardPlanSettingsNotNull(db);
}

function makeStripe() {
  const calls = { customers: [], prices: [], sessions: [], subscriptionsListed: 0 };
  const api = {
    customers: {
      retrieve: async (id) => { calls.customers.push(['retrieve', id]); return { id }; },
      update: async (id) => { calls.customers.push(['update', id]); return { id }; },
      create: async () => { calls.customers.push(['create']); return { id: 'cus_ent' }; }
    },
    subscriptions: { list: async () => { calls.subscriptionsListed += 1; return { data: [] }; } },
    prices: { create: async (payload) => { calls.prices.push(payload); return { id: `price_${calls.prices.length}` }; } },
    checkout: {
      sessions: {
        create: async (payload) => {
          calls.sessions.push(payload);
          return { id: `cs_${calls.sessions.length}`, url: 'https://checkout.test', client_secret: 'secret' };
        }
      }
    }
  };
  return { api, calls };
}

// Loads every module fresh against one fake database, one Stripe stub and one
// webhook event slot.
function loadSystem(db) {
  for (const p of Object.values(PATHS)) {
    if (p !== PATHS.settings) delete require.cache[p];
  }
  const stripe = makeStripe();
  const emails = [];
  const webhook = { event: null, subscription: null };

  injectModule(PATHS.supabase, {
    supabaseAdmin: db,
    supabase: db,
    supabaseAnon: {
      auth: { getUser: async () => ({ data: { user: { id: 'admin_user', email: ADMIN_EMAIL } }, error: null }) }
    }
  });
  injectModule(PATHS.stripePackage, function Stripe() { return stripe.api; });
  injectModule(PATHS.stripeClient, {
    webhooks: { constructEvent: () => webhook.event },
    subscriptions: { retrieve: async () => structuredClone(webhook.subscription) }
  });
  injectModule(PATHS.pdf, { htmlToPdf: async () => Buffer.from('%PDF-stub') });
  injectModule(PATHS.sendgrid, {
    sendMembershipAgreementEmail: async (to, signingUrl) => { emails.push({ to, signingUrl }); return { statusCode: 202 }; },
    sendMembershipAgreementInternalNotification: async () => ({ statusCode: 202 }),
    sendSubscriptionCheckoutEmail: async () => ({ statusCode: 202 }),
    sendMemberRecoveryEmail: async () => ({ statusCode: 202 }),
    sendAlphaScreenWelcomeEmail: async () => ({ statusCode: 202 })
  });
  injectModule(PATHS.recovery, {
    ensureUserAndSendRecovery: async () => ({ userId: 'user_owner', method: 'existing_user' }),
    redactEmail: () => '[redacted]'
  });
  injectModule(PATHS.salesIntegrations, { enqueueSalesWonDelivery: async () => ({ status: 'not_applicable' }) });

  const app = express();
  app.use('/webhook/stripe', express.raw({ type: 'application/json' }), require(PATHS.webhook));
  app.use(express.json());
  app.use('/admin/billing', require(PATHS.adminRouter));
  app.use('/membership-agreements', require(PATHS.checkoutRouter));
  return { app, stripe, emails, webhook, checkout: require(PATHS.subscriptionCheckout) };
}

function agreementBody(overrides = {}) {
  return {
    client_mode: 'attach_existing_client',
    attached_client_id: CLIENT,
    client_legal_name: 'Enterprise Co',
    primary_admin_name: 'Owner',
    admin_email: OWNER_EMAIL,
    membership_tier: 'enterprise',
    billing_option: 'monthly',
    initial_term_start: '2026-11-01',
    initial_renewal_date: '2027-11-01',
    ...ENTERPRISE_PRICES,
    ...overrides
  };
}

const sendAgreement = (app, body) => request(app)
  .post('/admin/billing/agreements/send')
  .set('Authorization', 'Bearer admin-token')
  .send(body);

test('new marked Enterprise draft freezes default/custom deadline in native row, document and snapshot; legacy unchanged',async()=>{
  const now=Date.now();
  for(const explicit of [null,new Date(now+3*86400000).toISOString(),new Date(now+10*86400000).toISOString()]){
    const db=makeDb(),system=loadSystem(db);
    const res=await sendAgreement(system.app,agreementBody({pool_quantity:'30',...(explicit?{agreement_expires_at:explicit}:{})}));
    assert.equal(res.status,200,res.text);
    const row=db.tables.membership_agreements[0],deadline=Date.parse(row.agreement_expires_at);
    assert.equal(row.template_snapshot.values.agreement_expires_at,row.agreement_expires_at);
    assert.ok(deadline>now && deadline<=Date.now()+10*86400000);
    if(explicit)assert.equal(row.agreement_expires_at,explicit);
    else assert.ok(deadline>=now+7*86400000 && deadline<=Date.now()+7*86400000);
    assert.ok(Date.parse(row.signer_token_expires_at)<=deadline);
    assert.match(row.template_snapshot.rendered_html,/Signature and initial payment deadline:/);
  }
  for(const expiry of ['not-a-date','2000-01-01T00:00:00Z']){
    const db=makeDb(),system=loadSystem(db);
    const res=await sendAgreement(system.app,agreementBody({pool_quantity:'30',agreement_expires_at:expiry}));
    assert.equal(res.status,400);assert.equal(res.body.code,'invalid_agreement_expiry');assertNothingWritten(db,system.stripe);
  }
  const db=makeDb(),system=loadSystem(db);
  const res=await sendAgreement(system.app,agreementBody({billing_model:'rollover',rollover_days:'90'}));
  assert.equal(res.status,200,res.text);assert.equal(db.tables.membership_agreements[0].agreement_expires_at,undefined);
});

const postWebhook = (system, event, subscription) => {
  system.webhook.event = event;
  system.webhook.subscription = subscription;
  return request(system.app)
    .post('/webhook/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 't=1,v1=stubbed')
    .send(Buffer.from('{}'));
};

function assertNothingWritten(db, stripe) {
  assert.deepEqual(db.tables.membership_agreements, [], 'no agreement written');
  assert.deepEqual(db.uploads, [], 'no draft uploaded');
  assert.equal(db.tables.clients.length, 1, 'no client created');
  if (stripe) {
    assert.deepEqual(stripe.calls.customers, [], 'Stripe not called');
    assert.deepEqual(stripe.calls.prices, []);
    assert.deepEqual(stripe.calls.sessions, []);
    assert.equal(stripe.calls.subscriptionsListed, 0);
  }
}

// --- refused when the agreement is sent ------------------------------------------

test('the admin send route refuses each rule with a 400 and a named code, writing nothing', async () => {
  const cases = [
    [{ billing_model: 'metered' }, 'invalid_billing_model'],
    [{ usage_interview_fee_cents: '0' }, 'usage_price_required'],
    [{ usage_interview_fee_cents: '' }, 'usage_price_required'],
    [{ billing_model: 'fixed', pool_quantity: '30' }, 'pool_requires_usage_model'],
    [{ rollover_days: '90' }, 'rollover_days_requires_rollover_model'],
    [{ billing_model: 'rollover', rollover_days: '400' }, 'invalid_rollover_days'],
    [{ max_interview_minutes: '60', scored_question_count: '5' }, 'invalid_max_interview_minutes'],
    [{ max_interview_minutes: '4', scored_question_count: '5' }, 'invalid_max_interview_minutes'],
    [{ max_interview_minutes: '20', scored_question_count: '8' }, 'invalid_scored_question_count'],
    [{ max_interview_minutes: '20' }, 'interview_length_and_questions_required_together'],
    [{ membership_tier: 'pro', billing_model: 'fixed' }, 'enterprise_settings_not_allowed'],
    [{ membership_tier: 'basic', max_interview_minutes: '20', scored_question_count: '5' }, 'enterprise_settings_not_allowed'],
    [{ membership_tier: 'pro', rollover_days: '30' }, 'enterprise_settings_not_allowed']
  ];
  for (const [overrides, code] of cases) {
    const db = makeDb();
    const system = loadSystem(db);

    const res = await sendAgreement(system.app, agreementBody(overrides));

    assert.equal(res.status, 400, `${code}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, code);
    assert.equal(res.body.error, code);
    assert.ok(res.body.detail, `${code}: the reason is stated`);
    assertNothingWritten(db);
    assert.deepEqual(system.emails, [], `${code}: no email sent`);
  }
});

test('an Essentials or Pro agreement without these settings is sent as before', async () => {
  for (const tier of ['basic', 'pro']) {
    const db = makeDb();
    const system = loadSystem(db);
    const body = agreementBody({ membership_tier: tier });
    for (const key of Object.keys(ENTERPRISE_PRICES)) delete body[key];

    const res = await sendAgreement(system.app, body);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(db.tables.membership_agreements.length, 1);
  }
});

test('a valid Enterprise agreement keeps the four settings on the agreement record', async () => {
  const db = makeDb();
  const system = loadSystem(db);

  const res = await sendAgreement(system.app, agreementBody(ALL_FOUR));

  assert.equal(res.status, 200, JSON.stringify(res.body));
  const values = db.tables.membership_agreements[0].template_snapshot.values;
  assert.equal(values.billing_model, 'rollover');
  assert.equal(values.rollover_days, '120');
  assert.equal(values.max_interview_minutes, '30');
  assert.equal(values.scored_question_count, '6');
});

// --- refused at checkout, before Stripe -------------------------------------------

test('checkout refuses an invalid setting before any lookup or Stripe call', async () => {
  const db = makeDb();
  const system = loadSystem(db);
  const previous = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  try {
    for (const [fees, code] of [
      [{ ...ENTERPRISE_PRICES, billing_model: 'metered' }, 'invalid_billing_model'],
      [{ ...ENTERPRISE_PRICES, usage_interview_fee_cents: '0' }, 'usage_price_required'],
      [{ ...ENTERPRISE_PRICES, billing_model: 'rollover', pool_quantity: '30' }, 'pool_requires_usage_model'],
      [{ ...ENTERPRISE_PRICES, max_interview_minutes: '30' }, 'interview_length_and_questions_required_together']
    ]) {
      await assert.rejects(
        () => system.checkout.createSubscriptionCheckoutSession({
          clientId: CLIENT, planTier: 'enterprise', billingInterval: 'monthly',
          metadataSource: 'agreement_checkout', enterpriseFees: fees
        }),
        (err) => {
          assert.equal(err.status, 400);
          assert.equal(err.code, code);
          return true;
        }
      );
    }
    assertNothingWritten(db, system.stripe);
  } finally {
    if (previous === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previous;
  }
});

// --- the webhook ---------------------------------------------------------------------

function liveSubscription(metadata) {
  return {
    id: 'sub_ent', object: 'subscription', status: 'active', customer: 'cus_ent',
    start_date: 1789000000, current_period_end: 1791600000, cancel_at_period_end: false,
    items: { data: [{ price: { recurring: { interval: 'month' } }, metadata: {} }] },
    metadata
  };
}

function subscriptionEvent(subscription, type = 'customer.subscription.updated') {
  return { id: `evt_${Math.random().toString(16).slice(2)}`, type, created: 1789000000, data: { object: subscription } };
}

const settingsRow = (db) => db.tables.client_plan_settings.find((row) => row.client_id === CLIENT);
const adminCheckoutMetadata = (extra = {}) => ({
  source: 'admin_subscription_checkout', client_id: CLIENT, plan_tier: 'enterprise',
  billing_interval: 'monthly', ...ENTERPRISE_PRICES, ...extra
});

test('the fake refuses a null or missing max_interview_minutes, as the hosted database does', async () => {
  const db = makeDb({ planSettings: [{ client_id: CLIENT, plan_tier: 'pro', max_interview_minutes: 12 }] });

  const sendsNull = await db.from('client_plan_settings').upsert({ client_id: CLIENT, max_interview_minutes: null });
  const createsWithout = await db.from('client_plan_settings').upsert({ client_id: 'client_new', plan_tier: 'pro' });
  const updatesToNull = await db.from('client_plan_settings').update({ max_interview_minutes: null }).eq('client_id', CLIENT);

  for (const result of [sendsNull, createsWithout, updatesToNull]) assert.equal(result.error?.code, '23502');
  assert.deepEqual(db.notNullViolations, ['max_interview_minutes', 'max_interview_minutes', 'max_interview_minutes']);
  assert.equal(settingsRow(db).max_interview_minutes, 12, 'nothing was written');
});

test('a subscription event with no length writes the tier default: Essentials 10, Pro 12, Enterprise 15', async () => {
  for (const [tier, expected] of [['basic', 10], ['pro', 12], ['enterprise', 15]]) {
    const db = makeDb({ planSettings: [] });
    const system = loadSystem(db);
    const metadata = tier === 'enterprise'
      ? adminCheckoutMetadata()
      : { source: 'admin_subscription_checkout', client_id: CLIENT, plan_tier: tier, billing_interval: 'monthly' };
    const subscription = liveSubscription(metadata);

    const res = await postWebhook(system, subscriptionEvent(subscription), subscription);

    assert.equal(res.status, 200, `${tier}: ${JSON.stringify(res.body)}`);
    assert.equal(settingsRow(db).max_interview_minutes, expected, `${tier}: the plan default`);
    assert.equal(settingsRow(db).max_interview_minutes, PLAN_CAPACITY[tier].max_interview_minutes,
      `${tier}: read from PLAN_CAPACITY`);
    assert.equal(settingsRow(db).scored_question_count ?? null, null, `${tier}: the question count stays empty`);
    assert.deepEqual(db.notNullViolations, [], `${tier}: no null max_interview_minutes was sent`);
  }
});

test('an Enterprise agreement\'s length replaces the default, and dropping it goes back to the default', async () => {
  const db = makeDb({ planSettings: [{ client_id: CLIENT, plan_tier: 'enterprise', max_interview_minutes: 15 }] });
  const system = loadSystem(db);

  const withLength = liveSubscription(adminCheckoutMetadata({ max_interview_minutes: '30', scored_question_count: '5' }));
  assert.equal((await postWebhook(system, subscriptionEvent(withLength), withLength)).status, 200);
  assert.equal(settingsRow(db).max_interview_minutes, 30);
  assert.equal(settingsRow(db).scored_question_count, 5);

  const without = liveSubscription(adminCheckoutMetadata());
  assert.equal((await postWebhook(system, subscriptionEvent(without), without)).status, 200);
  assert.equal(settingsRow(db).max_interview_minutes, 15, 'no length: the plan default, never null');
  assert.equal(settingsRow(db).scored_question_count, null, 'no question count: empty, the plan default');
  assert.deepEqual(db.notNullViolations, []);
});

test('rollover_days is written only when the agreement states it', async () => {
  const db = makeDb({ planSettings: [{ client_id: CLIENT, plan_tier: 'enterprise', rollover_days: 90 }] });
  const system = loadSystem(db);
  const without = liveSubscription(adminCheckoutMetadata());
  await postWebhook(system, subscriptionEvent(without), without);
  assert.equal(settingsRow(db).rollover_days, 90, 'not stated: the column keeps its value');
  assert.ok(!db.calls.some((call) => call.op === 'upsert' && 'rollover_days' in call.payload));

  const stated = liveSubscription(adminCheckoutMetadata({ billing_model: 'rollover', rollover_days: '45' }));
  await postWebhook(system, subscriptionEvent(stated), stated);
  assert.equal(settingsRow(db).rollover_days, 45);
});

test('a stated billing_model is recorded once, and a later event never clears or changes it', async () => {
  const db = makeDb({ planSettings: [{ client_id: CLIENT, plan_tier: 'enterprise', billing_model: null }] });
  const system = loadSystem(db);
  const stated = liveSubscription(adminCheckoutMetadata({ billing_model: 'fixed' }));

  await postWebhook(system, subscriptionEvent(stated), stated);
  assert.equal(settingsRow(db).billing_model, 'fixed', 'the agreement states it, so it is recorded');
  assert.ok(db.calls.filter((call) => call.op === 'upsert').every((call) => !('billing_model' in call.payload)),
    'billing_model is never part of the upsert');

  // Changed since by hand: the same subscription's next event must not undo it.
  settingsRow(db).billing_model = 'rollover';
  await postWebhook(system, subscriptionEvent(stated), stated);
  assert.equal(settingsRow(db).billing_model, 'rollover', 'a later event never changes it');

  // An event whose metadata states nothing must not clear it either.
  const silent = liveSubscription(adminCheckoutMetadata());
  await postWebhook(system, subscriptionEvent(silent), silent);
  assert.equal(settingsRow(db).billing_model, 'rollover', 'a later event never clears it');
});

test('metadata that breaks the rules is a permanent failure, not a guess', async () => {
  const db = makeDb({ planSettings: [{ client_id: CLIENT, plan_tier: 'enterprise' }] });
  const system = loadSystem(db);
  const broken = liveSubscription(adminCheckoutMetadata({ max_interview_minutes: '90', scored_question_count: '5' }));

  const res = await postWebhook(system, subscriptionEvent(broken), broken);

  assert.equal(res.status, 200, 'acknowledged: the metadata will not change on redelivery');
  assert.match(String(db.tables.billing_events.at(-1).error), /invalid_max_interview_minutes/);
  assert.equal(settingsRow(db).max_interview_minutes, undefined, 'nothing written');
});

test('a subscription from before these settings existed still provisions without a usage price', async () => {
  const db = makeDb({ planSettings: [] });
  const system = loadSystem(db);
  const legacy = { ...adminCheckoutMetadata() };
  delete legacy.usage_interview_fee_cents;
  const subscription = liveSubscription(legacy);

  assert.equal((await postWebhook(system, subscriptionEvent(subscription), subscription)).status, 200);
  assert.equal(settingsRow(db).plan_tier, 'enterprise', 'the usage-price rule is enforced at sale, not on old subscriptions');
});

// --- end to end -------------------------------------------------------------------------

// Admin send -> signing (simulated) -> checkout -> checkout.session.completed
// through the real activation -> a later subscription event. Asserts the
// expected plan settings after activation and again after the later event.
async function agreementToActivation(settings, expected) {
  const db = makeDb();
  const system = loadSystem(db);
  const previous = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  try {
    // 1. The admin sends the agreement.
    const sent = await sendAgreement(system.app, agreementBody(settings));
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const token = decodeURIComponent(system.emails[0].signingUrl.split('/').pop());

    // 2. The client signs it (the signing route is outside this step).
    Object.assign(db.tables.membership_agreements[0], { status: 'signed', is_current: true });

    // 3. Checkout from the agreement.
    const checkout = await request(system.app).post('/membership-agreements/checkout-session').send({ token });
    assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
    const sessionMetadata = system.stripe.calls.sessions[0].subscription_data.metadata;
    for (const field of ['billing_model', 'rollover_days', 'max_interview_minutes', 'scored_question_count']) {
      assert.equal(sessionMetadata[field], settings[field], `${field} travels in the checkout metadata as stated`);
    }

    // 4. Stripe reports the paid checkout; the agreement activates.
    const subscription = liveSubscription(sessionMetadata);
    const completed = {
      id: 'evt_checkout', type: 'checkout.session.completed', created: 1789000000,
      data: {
        object: {
          id: 'cs_1', mode: 'subscription', status: 'complete', payment_status: 'paid',
          customer: 'cus_ent', subscription: 'sub_ent', metadata: system.stripe.calls.sessions[0].metadata
        }
      }
    };
    const activated = await postWebhook(system, completed, subscription);
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
    assert.equal(db.tables.membership_agreements[0].checkout_status, 'paid', 'the agreement activated');
    assert.equal(db.tables.clients[0].stripe_subscription_id, 'sub_ent', 'the parent is linked');

    const pick = (row) => Object.fromEntries(Object.keys(expected).map((key) => [key, row?.[key] ?? null]));
    assert.deepEqual(pick(settingsRow(db)), expected, 'on the parent\'s plan settings');
    assert.equal(db.tables.client_plan_settings.length, 1, 'one row, the parent\'s');

    // 5. A later subscription event for the same subscription changes nothing.
    assert.equal((await postWebhook(system, subscriptionEvent(subscription), subscription)).status, 200);
    assert.deepEqual(pick(settingsRow(db)), expected, 'a second event leaves them unchanged');
    assert.deepEqual(db.notNullViolations, [], 'no path sent a null max_interview_minutes');
  } finally {
    if (previous === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previous;
  }
}

test('an admin Enterprise agreement with all four settings ends on the parent\'s plan settings, and a second event leaves them', async () => {
  await agreementToActivation(ALL_FOUR, {
    plan_tier: 'enterprise',
    billing_model: 'rollover',
    rollover_days: 120,
    max_interview_minutes: 30,
    scored_question_count: 6,
    usage_interview_fee_cents: 2500
  });
});

test('an admin Enterprise agreement without a length activates with the plan default length and no question count', async () => {
  await agreementToActivation({}, {
    plan_tier: 'enterprise',
    billing_model: null,
    max_interview_minutes: PLAN_CAPACITY.enterprise.max_interview_minutes,
    scored_question_count: null,
    usage_interview_fee_cents: 2500
  });
});

// --- the agreement shows what Stripe charges (Step E5) ----------------------------------

const POOL_BANDS = [
  { id: 'band_20', min_quantity: 20, discount_pct: 0 },
  { id: 'band_30', min_quantity: 30, discount_pct: 5 },
  { id: 'band_50', min_quantity: 50, discount_pct: 10 }
];

// Sends the agreement, signs it, checks it out, and returns the agreement's terms
// (read back from the stored record, as the signed PDF is) beside what reached
// Stripe.
async function agreementAndCharge(settings, { changeBandsBeforeCheckout = false, beforeCheckout = null } = {}) {
  const db = makeDb();
  db.tables.enterprise_pool_discounts = POOL_BANDS.map((band) => ({ ...band }));
  const system = loadSystem(db);
  const previous = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  try {
    const sent = await sendAgreement(system.app, agreementBody(settings));
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const token = decodeURIComponent(system.emails[0].signingUrl.split('/').pop());
    Object.assign(db.tables.membership_agreements[0], { status: 'signed', is_current: true });

    if (changeBandsBeforeCheckout) {
      for (const band of db.tables.enterprise_pool_discounts) band.discount_pct = 40;
    }
    if (beforeCheckout) beforeCheckout(db.tables.membership_agreements[0]);

    let sdkCalls=system.stripe.calls;
    const actual=db.tables.membership_agreements[0];
    if(actual.template_snapshot.values.pool_offer_snapshot!=null){
      // This older send/terms harness used an unsealed direct status mutation.
      // Feed its actual server-produced quote into the explicit injected seal/
      // native boundary fixture instead. Native sealing/pins are separately
      // verified in real PG17, and the actual route dispatch has its own tests.
      const {fixture}=require('./helpers/enterprise-existing-checkout-fixture');
      const {createExistingEnterpriseCheckout}=require('../src/services/existingEnterpriseCheckoutAttempt');
      const mock=fixture({cadence:actual.billing_option,emptyProfile:true});
      const execution={...mock.seal.execution,signed_at:new Date(Date.now()-1000).toISOString()};
      const unsigned=structuredClone(actual.template_snapshot);delete unsigned.execution;
      Object.assign(mock.a,structuredClone(actual),{signed_at:execution.signed_at,signer_accepted:true,template_version:actual.template_version,
        template_snapshot:{...unsigned,execution}});
      for(const k of ['signer_typed_name','signature_image_path','signature_sha256','executed_pdf_path','signer_ip','signer_user_agent'])mock.a[k]=execution[k];
      Object.assign(mock.seal,{agreement_id:mock.a.id,token_hash:mock.a.signer_token_hash,source_snapshot:unsigned,execution,signed_at:execution.signed_at});
      Object.assign(mock.client,db.tables.clients[0]);mock.db.tables.clients=[mock.client];mock.customer.id=mock.client.stripe_customer_id;
      const nativeArgs={db:mock.db,client:db.tables.clients[0],agreement:structuredClone(mock.a),fees:mock.a.template_snapshot.values,billingInterval:mock.a.billing_option,
        embedded:false,cancelUrl:`${mock.args.config.public_sign_base}/membership-agreement/sign/${encodeURIComponent(token)}`,
        key:`agreement_checkout:${mock.a.id}:enterprise:${mock.a.billing_option}`,config:mock.args.config,stripeFactory:()=>mock.stripe,
        resolveCustomer:async()=>db.tables.clients[0].stripe_customer_id};
      await createExistingEnterpriseCheckout(nativeArgs);
      db.tables.membership_agreements[0]=mock.a;db.tables.client_interview_pools=mock.db.tables.client_interview_pools;
      sdkCalls={prices:mock.calls.filter(c=>c.kind==='priceCreate').map(c=>c.body),sessions:mock.calls.filter(c=>c.kind==='sessionCreate').map(c=>c.body)};
    }else{
      const checkout = await request(system.app).post('/membership-agreements/checkout-session').send({ token });
      assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
    }

    const agreement = db.tables.membership_agreements[0];
    const { buildExecutedMembershipAgreementHtml } = require(PATHS.agreementsService);
    const executed = buildExecutedMembershipAgreementHtml(agreement, {});
    return {
      terms: executed.commercial_terms,
      draftHtml: agreement.template_snapshot.rendered_html,
      executedHtml: executed.html,
      pendingPools:db.tables.client_interview_pools,
      stripe: sdkCalls
    };
  } finally {
    if (previous === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previous;
  }
}

// Every term the agreement shows, against what checkout sent to Stripe. Fails
// on the first figure that differs.
function assertAgreementMatchesCharge({ terms, stripe }) {
  const membershipPrice = stripe.prices.find((price) => price.recurring);
  const poolPrice = stripe.prices.find((price) => price.metadata?.purchase_type === 'interview_pool');
  const metadata = stripe.sessions[0].subscription_data.metadata;

  assert.equal(membershipPrice.unit_amount, terms.platform_fee_cents, 'platform fee');
  assert.equal(membershipPrice.recurring.interval, terms.billing_interval === 'annual' ? 'year' : 'month', 'billing interval');
  assert.equal(Math.round(Number(metadata.per_role_fee) * 100), terms.per_role_fee_cents, 'per-role fee');
  assert.equal(Number(metadata.included_interviews_per_role), terms.included_interviews_per_role, 'included interviews');
  assert.equal(metadata.billing_model || 'usage', terms.billing_model, 'billing model');
  assert.equal(Number(metadata.max_interview_minutes || PLAN_CAPACITY.enterprise.max_interview_minutes),
    terms.max_interview_minutes, 'interview length');
  assert.equal(Number(metadata.scored_question_count || PLAN_CAPACITY.enterprise.scored_question_count),
    terms.scored_question_count, 'scored questions');
  if (terms.billing_model === 'usage') {
    assert.equal(Number(metadata.usage_interview_fee_cents), terms.usage_interview_fee_cents, 'usage price');
  }
  if (terms.rollover_days !== null) {
    assert.equal(Number(metadata.rollover_days || 90), terms.rollover_days, 'rollover days');
  }
  if (terms.pool) {
    assert.ok(poolPrice, 'a pool on the agreement is charged');
    assert.equal(poolPrice.unit_amount, terms.pool.total_cents, 'pool total');
    assert.equal(Number(poolPrice.metadata.discount_pct), terms.pool.discount_pct, 'pool discount');
    assert.equal(Number(poolPrice.metadata.quantity), terms.pool.quantity, 'pool quantity');
  } else {
    assert.equal(poolPrice, undefined, 'no pool on the agreement, none charged');
  }
}

function assertHtmlShowsTerms(html, terms) {
  for (const row of terms.rows) {
    assert.ok(html.includes(row.label), `the agreement shows "${row.label}"`);
    assert.ok(html.includes(row.value), `the agreement shows "${row.label}: ${row.value}"`);
  }
}

test('an Enterprise usage agreement with a pool shows every term, and each one is what Stripe charges', async () => {
  const result = await agreementAndCharge({ pool_quantity: '30', max_interview_minutes: '30', scored_question_count: '6' });

  assert.equal(result.terms.billing_model, 'usage');
  assert.deepEqual(result.terms.pool, { quantity: 30, discount_pct: 7, total_cents: 69750 }, 'prospective v2: 30 x $25 less 7%');
  assertAgreementMatchesCharge(result);
  assertHtmlShowsTerms(result.draftHtml, result.terms);
  assertHtmlShowsTerms(result.executedHtml, result.terms);
  assert.match(result.draftHtml, /Usage is billed monthly, on the 1st of each month, for the previous calendar month\./);
});

test('an Enterprise rollover agreement shows its rollover days and no usage price, and matches the charge', async () => {
  const result = await agreementAndCharge({ billing_model: 'rollover', rollover_days: '120' });

  assert.equal(result.terms.rollover_days, 120);
  assert.equal(result.terms.usage_interview_fee_cents, null, 'a usage price does not apply on rollover');
  assert.equal(result.terms.pool, null);
  assert.equal(result.terms.max_interview_minutes, 15, 'no length on the agreement: the plan default');
  assertAgreementMatchesCharge(result);
  assertHtmlShowsTerms(result.draftHtml, result.terms);
  assert.doesNotMatch(result.draftHtml, /Per-Interview Usage Price|Usage is billed monthly/);
});

test('the pool is charged at the price the agreement shows, even if the bands change before checkout', async () => {
  const result = await agreementAndCharge({ pool_quantity: '30' }, { changeBandsBeforeCheckout: true });

  assert.equal(result.terms.pool.discount_pct, 7, 'the prospective agreement was priced at send');
  assertAgreementMatchesCharge(result);
});

test('a pool discount or total typed into the request is ignored; the bands price it', async () => {
  const result = await agreementAndCharge({ pool_quantity: '30', pool_discount_pct: '90', pool_total_cents: '1' });

  assert.deepEqual(result.terms.pool, { quantity: 30, discount_pct: 7, total_cents: 69750 });
  assertAgreementMatchesCharge(result);
});

test('v2 accepted snapshot matches pending row/price, protected metadata and no unchecked checkout promotion',async()=>{
  const r=await agreementAndCharge({pool_quantity:'51',usage_interview_fee_cents:5,pool_discount_pct:'90',pool_total_cents:1});
  const p=r.pendingPools[0],poolPrice=r.stripe.prices.find(v=>v.metadata?.purchase_type==='interview_pool'),session=r.stripe.sessions[0];
  assert.equal(p.total_cents,229);assert.equal(p.offer_snapshot.net_cents,229);assert.equal(poolPrice.unit_amount,229);
  assert.equal(p.offer_digest,poolPrice.metadata.pool_offer_digest);assert.equal(p.offer_digest,session.metadata.pool_offer_digest);
  assert.equal(session.metadata.pool_offer_version,'enterprise-pool-v2-2026-10-11');
  assert.equal(session.allow_promotion_codes,false);assert.equal(Object.hasOwn(session,'discounts'),false);
  assert.equal(p.status,'pending');assertAgreementMatchesCharge(r);
});

test('an agreement sent before pools were priced at send is charged at the bands, never at a typed discount', async () => {
  const result = await agreementAndCharge({ pool_quantity: '30' }, {
    beforeCheckout: (agreement) => {
      // What an older agreement looks like: a typed discount, and no mark that
      // the system priced it.
      const values = agreement.template_snapshot.values;
      // Explicit synthetic LEGACY fixture, not a permitted native backfill or
      // way to strip a new signed snapshot. Real native v2 rows forbid this.
      delete values.pool_offer_snapshot;
      delete values.pool_offer_digest;
      delete values.pool_discount_priced;
      values.pool_discount_pct = '90';
      values.pool_total_cents = 7500;
    }
  });

  const poolPrice = result.stripe.prices.find((price) => price.metadata?.purchase_type === 'interview_pool');
  assert.equal(poolPrice.unit_amount, 71250, 'priced from the bands (5%), as before this step');
  assert.equal(Number(poolPrice.metadata.discount_pct), 5);
});

// --- the migration --------------------------------------------------------------------

test('the migration adds scored_question_count safely and only comments max_interview_minutes', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const statements = sql.split(/\r?\n/).filter((line) => !line.trim().startsWith('--')).join('\n');

  assert.match(statements, /column_name = 'scored_question_count'[\s\S]{0,200}?add column scored_question_count integer null/i);
  assert.match(statements, /check \(scored_question_count is null or scored_question_count > 0\)/i);
  assert.match(statements, /conname = 'client_plan_settings_scored_question_count_check'/, 'the constraint is guarded');
  assert.match(statements, /comment on column public\.client_plan_settings\.scored_question_count/i);
  assert.match(statements, /column_name = 'max_interview_minutes'[\s\S]{0,200}?comment on column public\.client_plan_settings\.max_interview_minutes/i,
    'the comment is added only where the column exists');
  assert.doesNotMatch(statements, /add column max_interview_minutes/i, 'it already exists in the hosted database');
  assert.doesNotMatch(statements, /\b(grant|revoke|drop)\b/i);

  const names = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).sort();
  assert.ok(names.indexOf(path.basename(MIGRATION)) > names.indexOf('20261011120000_billing_model_follow_plan_tier.sql'));
});
