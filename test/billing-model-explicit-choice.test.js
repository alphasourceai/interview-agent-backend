'use strict';

// A stored billing_model is an explicit choice for that client; an empty one
// follows plan_tier. Nothing in the backend writes the column, so a Stripe event
// can neither fill it in nor overwrite it, and a tier change moves a client
// whose column is empty.
//
// Driven through the real webhook and the real billing-model resolver. Stripe and
// Supabase are stubbed; the plan-settings upsert merges on conflict the way
// PostgREST does, so "unchanged" means unchanged in the stored row.

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const request = require('supertest');

const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { guardPlanSettingsNotNull } = require('./helpers/planSettingsNotNull');

const ROOT = path.join(__dirname, '..');
const webhookPath = path.join(ROOT, 'src', 'routes', 'webhooks', 'stripe.js');
const stripeClientPath = path.join(ROOT, 'src', 'clients', 'stripe.js');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const activationPath = path.join(ROOT, 'src', 'services', 'publicPurchaseActivation.js');
const clientBillingScopePath = path.join(ROOT, 'src', 'services', 'clientBillingScope.js');
const billingModelPath = path.join(ROOT, 'src', 'services', 'billingModel.js');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20261011120000_billing_model_follow_plan_tier.sql');

const CLIENT = 'client_1';

const ENTERPRISE_FEES = Object.freeze({
  platform_fee: '1200',
  per_role_fee: '0',
  included_interviews_per_role: '0',
  additional_interview_fee: '0',
  usage_interview_fee_cents: '2500'
});

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

function makeDb(planSettings) {
  const db = createFakeSupabase({
    clients: [{
      id: CLIENT, parent_client_id: null, name: 'Client', stripe_customer_id: 'cus_1',
      stripe_subscription_id: 'sub_1', plan_tier: planSettings.plan_tier
    }],
    client_plan_settings: [{ client_id: CLIENT, ...planSettings }],
    billing_events: []
  });
  const baseFrom = db.from;
  db.from = (table) => {
    const query = baseFrom(table);
    if (table !== 'client_plan_settings') return query;
    // Upsert on client_id: update the named columns of an existing row, as
    // PostgREST does; columns not in the payload keep their stored value.
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
  // max_interview_minutes is NOT NULL with no default in the hosted database.
  return guardPlanSettingsNotNull(db);
}

function subscriptionEvent(metadata) {
  return {
    id: `evt_${Math.random().toString(16).slice(2)}`,
    type: 'customer.subscription.updated',
    created: 1789000000,
    data: {
      object: {
        id: 'sub_1', object: 'subscription', status: 'active', customer: 'cus_1',
        start_date: 1789000000, current_period_end: 1791600000, cancel_at_period_end: false,
        metadata: { source: 'admin_subscription_checkout', client_id: CLIENT, billing_interval: 'monthly', ...metadata },
        items: { data: [{ price: { recurring: { interval: 'month' } }, metadata: {} }] }
      }
    }
  };
}

function loadApp(event, db) {
  for (const p of [webhookPath, stripeClientPath, supabasePath, activationPath, clientBillingScopePath, billingModelPath]) {
    delete require.cache[p];
  }
  injectModule(activationPath, { activatePublicPurchaseAgreementCheckout: async () => ({ ok: true }) });
  injectModule(stripeClientPath, {
    webhooks: { constructEvent: () => event },
    subscriptions: { retrieve: async () => event.data.object }
  });
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });

  const app = express();
  app.use('/webhook/stripe', express.raw({ type: 'application/json' }), require(webhookPath));
  return app;
}

const post = (app) => request(app)
  .post('/webhook/stripe')
  .set('Content-Type', 'application/json')
  .set('stripe-signature', 't=1,v1=stubbed')
  .send(Buffer.from('{}'));

const storedSettings = (db) => db.tables.client_plan_settings.find((row) => row.client_id === CLIENT);
const upsertPayloads = (db) => db.calls.filter((call) => call.table === 'client_plan_settings' && call.op === 'upsert')
  .map((call) => call.payload);
const resolvedModel = async (db) => {
  if (!require.cache[supabasePath]) injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });
  return (await require(billingModelPath).resolveBillingModel({ db, clientId: CLIENT })).billing_model;
};

test('a subscription event leaves an empty billing_model empty', async () => {
  const db = makeDb({ plan_tier: 'pro', billing_model: null });

  assert.equal((await post(loadApp(subscriptionEvent({ plan_tier: 'pro' }), db))).status, 200);

  assert.equal(upsertPayloads(db).length, 1, 'the plan settings were written');
  assert.ok(!('billing_model' in upsertPayloads(db)[0]), 'the webhook does not write billing_model');
  assert.equal(storedSettings(db).billing_model, null);
  assert.equal(await resolvedModel(db), 'rollover', 'empty follows the tier');
});

test('a subscription event leaves an explicit billing_model that differs from the tier unchanged', async () => {
  const db = makeDb({ plan_tier: 'pro', billing_model: 'fixed' });

  assert.equal((await post(loadApp(subscriptionEvent({ plan_tier: 'pro' }), db))).status, 200);

  assert.equal(storedSettings(db).billing_model, 'fixed', 'an explicit choice survives the event');
  assert.equal(await resolvedModel(db), 'fixed', 'and still wins over the tier');
});

test('an explicit billing_model survives a change of tier too', async () => {
  const db = makeDb({ plan_tier: 'pro', billing_model: 'rollover' });

  assert.equal((await post(loadApp(subscriptionEvent({ plan_tier: 'enterprise', ...ENTERPRISE_FEES }), db))).status, 200);

  assert.equal(storedSettings(db).plan_tier, 'enterprise');
  assert.equal(storedSettings(db).billing_model, 'rollover');
  assert.equal(await resolvedModel(db), 'rollover');
});

test('a client moving from Pro to Enterprise with an empty model resolves to usage', async () => {
  const db = makeDb({ plan_tier: 'pro', billing_model: null });
  assert.equal(await resolvedModel(db), 'rollover', 'before: Pro follows rollover');

  assert.equal((await post(loadApp(subscriptionEvent({ plan_tier: 'enterprise', ...ENTERPRISE_FEES }), db))).status, 200);

  assert.equal(storedSettings(db).plan_tier, 'enterprise');
  assert.equal(storedSettings(db).billing_model, null, 'nothing was written to the column');
  assert.equal(await resolvedModel(db), 'usage', 'after: the tier change moved the client');
});

test('nothing in src stores the tier default in billing_model', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const source = fs.readFileSync(full, 'utf8');
        if (/billing_model\s*:\s*defaultBillingModelForPlanTier/.test(source)) offenders.push(path.relative(ROOT, full));
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepEqual(offenders, [], 'a tier default stored in the column could not be told apart from a choice');
});

// --- the migration that empties the stamped values ---------------------------

test('the migration preserves all existing choices rather than guessing provenance', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const statements = sql.split(/\r?\n/).filter((line) => !line.trim().startsWith('--')).join('\n');

  assert.match(statements, /^\s*select 1;\s*$/i);
  assert.doesNotMatch(statements, /\b(update|delete|insert|alter|drop|grant|revoke|create)\b/i,
    'no existing row, schema, or permission may change');
});

test('the migration runs after the billing migrations and is documented', () => {
  const names = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).sort();
  assert.ok(names.indexOf('20261011120000_billing_model_follow_plan_tier.sql')
    > names.indexOf('20261009200000_client_plan_settings_money_units.sql'));
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'billing-models.md'), 'utf8');
  assert.match(doc, /20261011120000_billing_model_follow_plan_tier\.sql/);
  // Since E3 an agreement that states a model records it, once; nothing else
  // writes the column, and no Stripe event changes or clears it.
  assert.match(doc, /`billing_model` is written only when an agreement states one/);
  assert.match(doc, /no Stripe event changes or clears it/);
});
