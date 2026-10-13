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
const { guardPlanSettingsNotNull } = require('./helpers/planSettingsNotNull');

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

function makeDb({ pool = {}, agreement = {}, client = {}, intents = [], claimed = false } = {}) {
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
      discount_pct: 5, total_cents: 71250, status: 'pending', ...pool,
      offer_snapshot:pool.offer_snapshot??null,offer_digest:pool.offer_digest??null
    }],
    client_plan_settings: [],
    client_members: [],
    billing_invoices: [{ id: 'invoice_synthetic', stripe_invoice_id: 'in_ent', status: 'open' }],
    billing_events: []
  }, {
    // billing_events.stripe_event_id is unique, which is what turns a redelivery
    // into a replay rather than a second run.
    unique: { billing_events: (row) => row.stripe_event_id }
  });
  db.rpcs = [];
  db.deliveryCalls = [];
  db.authCalls = [];
  // An agreement sent by an admin has no public purchase intent, so the activation
  // claim answers the way the database does for that case.
  db.rpc = async (name, args) => {
    db.rpcs.push({ name, args });
    if (name === 'claim_public_purchase_activation') {
      if (claimed) {
        db.claimKey = args.p_claim_key;
        return { data: { status: 'claimed', intent_id: 'ppi_ent' }, error: null };
      }
      return { data: { status: 'purchase_intent_missing' }, error: null };
    }
    if (name === 'heartbeat_public_purchase_activation') return { data: db.claimKey === args.p_claim_key, error: null };
    if (name === 'release_public_purchase_activation') {
      assert.equal(args.p_claim_key, db.claimKey); db.claimKey = null;
      return { data: true, error: null };
    }
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  };
  db.auth = {
    admin: {
      listUsers: async () => { db.authCalls.push('list'); return { data: { users: [{ id: 'user_owner', email: ADMIN_EMAIL }] }, error: null }; },
      getUserById: async () => { db.authCalls.push('read'); return { data: { user: { id: 'user_owner', email: ADMIN_EMAIL } }, error: null }; }
    }
  };
  // max_interview_minutes is NOT NULL with no default in the hosted database.
  return guardPlanSettingsNotNull(db);
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
  injectModule(require.resolve('../src/services/existingEnterprisePaymentWebhook'), {
    classifyExistingEnterprisePaymentEvent: async () => null
  });
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
    sendMemberRecoveryEmail: async () => { db.deliveryCalls.push('recovery'); return { statusCode: 202 }; },
    sendAlphaScreenWelcomeEmail: async () => { db.deliveryCalls.push('welcome'); return { statusCode: 202 }; }
  });
  injectModule(recoveryHelperPath, {
    ensureUserAndSendRecovery: async () => { db.authCalls.push('recovery'); return { userId: 'user_owner', method: 'existing_user' }; },
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
  assert.equal(latest.max_interview_minutes, 15, 'no length on the agreement: the plan default');
  assert.deepEqual(db.notNullViolations, [], 'no null max_interview_minutes was sent');
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

test('new snapshot, split markers and missing selected columns hold before any client or pool activation',async()=>{
  for(const mode of ['v2','split','missing']){
    const db=makeDb();if(mode==='v2'){
      const {prepareEnterprisePoolTerms}=require('../src/services/enterprisePoolSnapshot');
      const p=prepareEnterprisePoolTerms({membership_tier:'enterprise',billing_model:'usage',pool_quantity:30,usage_interview_fee_cents:2500});
      Object.assign(poolRow(db),{offer_snapshot:p.pool_offer_snapshot,offer_digest:p.pool_offer_digest,total_cents:69750,discount_pct:7});
    }else if(mode==='split')poolRow(db).offer_digest='a'.repeat(64);else delete poolRow(db).offer_snapshot;
    const {app,subscriptionRetrievals}=loadApp(checkoutEvent(),db),res=await post(app);
    assert.equal(res.status,503,JSON.stringify(res.body));assertNotActivated(db);assert.equal(poolRow(db).status,'pending');
    assert.equal(subscriptionRetrievals.length,0);assert.match(String(eventRow(db).error),/enterprise_pool_payment_proof_required/);
    assert.equal(writesTo(db,'client_interview_pools','update'),0);
  }
});

function markedAgreement(values = { pool_offer_snapshot: {} }) {
  return { template_snapshot: { values: { ...values } } };
}
function invoiceEvent({ metadata = { ...ENTERPRISE_METADATA, ...POOL_METADATA }, id = 'evt_invoice_ent' } = {}) {
  return { id, type: 'invoice.payment_succeeded', created: 1789000000,
    data: { object: { id: 'in_ent', customer: 'cus_ent', subscription: 'sub_ent',
      billing_reason: 'subscription_create', status: 'paid', paid: true, total: 120000,
      currency: 'usd', metadata } } };
}
function assertNoAdmission(db, { invoiceAuditAllowed = false } = {}) {
  assertNotActivated(db);
  assert.equal(poolRow(db).status, 'pending');
  for (const table of ['clients', 'client_plan_settings', 'membership_agreements', 'billing_invoices',
    'client_members', 'client_role_credits', 'client_interview_pools']) {
    if (table === 'billing_invoices' && invoiceAuditAllowed) continue;
    assert.equal(db.calls.filter(c => c.table === table && ['update', 'insert', 'upsert', 'delete'].includes(c.op)).length, 0, table);
  }
  assert.deepEqual(db.deliveryCalls, []);
  assert.deepEqual(db.authCalls, []);
}
test('actual shared activation rejects partial/malformed native pool terms and ignores caller proof; no effects', async () => {
  for (const values of [{ pool_offer_snapshot: {} }, { pool_offer_snapshot: false }, { pool_offer_snapshot: '' },
    { pool_offer_digest: '' }, { pool_offer_snapshot: null, pool_offer_digest: 'synthetic' }]) {
    for (const claimed of [false, true]) {
      const db = makeDb({ agreement: markedAgreement(values), claimed });
      loadApp(checkoutEvent(), db);
      const activate = require(activationPath).activatePublicPurchaseAgreementCheckout;
      await assert.rejects(activate({ db, agreementId: AGREEMENT, activationClaimKey: claimed ? 'synthetic' : null,
        enterpriseFunding: { verified: true }, enterprisePlanSettings: { verified: true }, paymentProof: true }),
        { code: 'enterprise_pool_payment_proof_required', status: 503 });
      assertNoAdmission(db);
      assert.equal(db.rpcs.length, 0);
    }
  }
});
test('invoice-first new pool hold runs before invoice ledger sync, including subscription metadata fallback; redelivery stays503', async () => {
  for (const metadata of [undefined, {}]) {
    const db = makeDb({ agreement: markedAgreement({ pool_offer_digest: '' }) });
    const { app } = loadApp(invoiceEvent(metadata === undefined ? {} : { metadata }), db);
    for (let i = 0; i < 2; i++) {
      const response = await post(app);
      assert.equal(response.status, 503, JSON.stringify(response.body));
      assert.equal(response.body.code, 'AGREEMENT_ACTIVATION_RETRY_REQUIRED');
      assertNoAdmission(db);
      assert.equal(eventRow(db).processed_ok, false);
      assert.equal(db.tables.billing_events.length, 1);
      assert.equal(db.rpcs.length, 0, 'early hold precedes claim');
    }
  }
});
test('omitted pool metadata cannot bypass native agreement hold; a claimed activation lease is released', async () => {
  for (const claimed of [false, true]) {
    const db = makeDb({ agreement: markedAgreement(), claimed, intents: claimed ? [{ id: 'ppi_ent',
      agreement_id: AGREEMENT, status: 'pending', protocol: 'fenced_v2' }] : [] });
    const { app } = loadApp(checkoutEvent({ metadata: { purchase_type: '', client_interview_pool_id: '' } }), db);
    assert.equal((await post(app)).status, 503);
    assertNoAdmission(db);
    if (claimed) {
      assert.equal(db.claimKey, null);
      assert.equal(db.rpcs.filter(c => c.name === 'release_public_purchase_activation').length, 1);
    }
  }
});
test('new pool completed and async-settled holds retry; marked client/quantity mismatches stay permanent200', async () => {
  for (const type of ['checkout.session.completed', 'checkout.session.async_payment_succeeded']) {
    const db = makeDb({ pool: { offer_digest: 'synthetic' } });
    const { app } = loadApp(checkoutEvent({ type }), db);
    assert.equal((await post(app)).status, 503);
    assert.equal((await post(app)).status, 503);
    assertNoAdmission(db);
  }
  for (const mismatch of [{ pool: { client_id: 'other_client' } }, { metadata: { pool_quantity: '999' } }]) {
    const db = makeDb({ pool: { offer_digest: 'synthetic', ...mismatch.pool } });
    const { app } = loadApp(checkoutEvent({ metadata: mismatch.metadata }), db);
    assert.equal((await post(app)).status, 200);
    assertNoAdmission(db);
    assert.match(eventRow(db).error, /Interview pool (client|quantity) mismatch/);
  }
});
test('unmarked Enterprise initial invoice and direct no-intent activation preserve existing account/settings flow', async () => {
  const db = makeDb(), { app } = loadApp(invoiceEvent(), db);
  assert.equal((await post(app)).status, 200);
  assert.equal(clientRow(db).billing_status, 'active');
  assert.equal(db.tables.billing_invoices[0].status, 'paid');
  assert.equal(poolRow(db).status, 'pending', 'legacy invoice branch does not settle pool by inference');
  const direct = makeDb(); loadApp(checkoutEvent(), direct);
  const response = await require(activationPath).activatePublicPurchaseAgreementCheckout({ db: direct,
    agreementId: AGREEMENT, subscription: liveSubscription(), checkoutSessionId: 'cs_ent',
    enterprisePlanSettings: { client_id: CLIENT, plan_tier: 'enterprise', billing_interval: 'monthly',
      platform_fee: 1200, per_role_fee: 0, included_interviews_per_role: 0,
      additional_interview_fee: 0, usage_interview_fee_cents: 2500, max_interview_minutes: 15 },
    ensureRecovery: async () => ({ userId: 'user_owner', method: 'existing_user' }),
    sendWelcomeEmail: async () => ({ statusCode: 202 }) });
  assert.equal(response.ok, true);
  assert.equal(clientRow(direct).billing_status, 'active');
});
test('marked subscription create/update/delete hold no-intent and pendingfenced writers; same event retries instead of dedupe200', async () => {
  for (const type of ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']) {
    for (const fenced of [false, true]) {
      const db = makeDb({ agreement: markedAgreement({ pool_offer_digest: '' }), intents: fenced ? [{ id: 'ppi_ent',
        agreement_id: AGREEMENT, status: 'pending', protocol: 'fenced_v2', activated_at: null }] : [] });
      const event = { id: `evt_${type}_${fenced}`, type,
        data: { object: { ...liveSubscription(), status: type.endsWith('deleted') ? 'canceled' : 'active' } } };
      const { app } = loadApp(event, db);
      for (let repeat = 0; repeat < 2; repeat++) {
        const response = await post(app);
        assert.equal(response.status, 500);
        assert.equal(response.body.code, 'STRIPE_EVENT_PROCESSING_FAILED');
        assertNoAdmission(db);
        assert.equal(db.tables.billing_events.length, 0);
      }
    }
  }
});
test('unmarked no-intent Enterprise lifecycle keeps baseline client and settings updates', async () => {
  for (const type of ['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted']) {
    const db = makeDb();
    const event = { id: `evt_legacy_${type}`, type,
      data: { object: { ...liveSubscription(), status: type.endsWith('deleted') ? 'canceled' : 'active' } } };
    const { app } = loadApp(event, db);
    assert.equal((await post(app)).status, 200);
    assert.ok(writesTo(db, 'clients', 'update') > 0);
    assert.equal(clientRow(db).plan_tier, 'enterprise');
    if (!type.endsWith('deleted')) assert.ok(writesTo(db, 'client_plan_settings', 'upsert') > 0);
  }
});
test('new source generic failed/cycle-paid invoice cannot update client; failure audit preserved and dedupe cleared for retry', async () => {
  for (const [type, reason] of [['invoice.payment_failed', 'subscription_create'],
    ['invoice.payment_failed', 'subscription_cycle'], ['invoice.payment_succeeded', 'subscription_cycle']]) {
    const db = makeDb({ agreement: markedAgreement() }), event = invoiceEvent({ id: `evt_generic_${type}_${reason}` });
    event.type = type; event.data.object.billing_reason = reason;
    event.data.object.status = type.endsWith('failed') ? 'open' : 'paid';
    event.data.object.paid = !type.endsWith('failed');
    const { app } = loadApp(event, db);
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.equal((await post(app)).status, 500);
      assertNoAdmission(db, { invoiceAuditAllowed: true });
      assert.equal(db.tables.billing_events.length, 0);
      assert.equal(db.tables.billing_invoices[0].status, event.data.object.status);
    }
  }
});
test('unmarked generic failed/cycle-paid invoice still syncs existing client state', async () => {
  for (const type of ['invoice.payment_failed', 'invoice.payment_succeeded']) {
    const db = makeDb(), event = invoiceEvent({ id: `evt_generic_legacy_${type}` });
    event.type = type; event.data.object.billing_reason = 'subscription_cycle';
    const { app } = loadApp(event, db);
    assert.equal((await post(app)).status, 200);
    assert.ok(writesTo(db, 'clients', 'update') > 0);
  }
});
test('early invoice source read failures are bounded and precede invoice/account mutation', async () => {
  for (const throws of [false, true]) {
    const db = makeDb(), from = db.from.bind(db);
    db.from = table => {
      const query = from(table);
      if (table === 'membership_agreements') query.maybeSingle = async () => {
        if (throws) throw Error('PRIVATE_SYNTHETIC_DATABASE_DETAIL');
        return { data: null, error: { message: 'PRIVATE_SYNTHETIC_DATABASE_DETAIL' } };
      };
      return query;
    };
    const { app } = loadApp(invoiceEvent(), db), response = await post(app);
    assert.equal(response.status, 503);
    assert.ok(!JSON.stringify(response.body).includes('PRIVATE'));
    assert.equal(eventRow(db).error, 'enterprise_pool_source_unavailable');
    assertNoAdmission(db);
  }
});
