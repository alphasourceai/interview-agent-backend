'use strict';

// Activation claims on public_purchase_intents must be reclaimable.
//
// The claim is a database lease: claim_public_purchase_activation refuses a second
// caller while the lease is fresh, and lets a later delivery take over a lease older
// than five minutes, so a run that died holding it cannot block activation forever.
// A live run keeps its lease fresh with heartbeat_public_purchase_activation and
// gives it up with release_public_purchase_activation.
//
// The timing lives in SQL. The first test pins it in the migration source; the rest
// drive the webhook against a stub whose claim answers by the same rule, so they
// exercise what the JavaScript does with each answer.

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const request = require('supertest');

const ROOT = path.join(__dirname, '..');
const routerPath = path.join(ROOT, 'src', 'routes', 'webhooks', 'stripe.js');
const stripeClientPath = path.join(ROOT, 'src', 'clients', 'stripe.js');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const activationPath = path.join(ROOT, 'src', 'services', 'publicPurchaseActivation.js');
const enterpriseWebhookPath = path.join(ROOT, 'src', 'services', 'existingEnterprisePaymentWebhook.js');
const FENCE_MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20261001131612_qa_public_purchase_activation_fences.sql');

const MINUTE = 60 * 1000;
const LEASE_MS = 5 * MINUTE;

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Answers the claim the way claim_public_purchase_activation does in the fence migration.
function makeDb(intentRow) {
  const state = { intent: intentRow ? { ...intentRow } : null, rpcs: [] };
  const db = {
    state,
    async rpc(name, args) {
      state.rpcs.push({ name, args });
      const intent = state.intent;
      if (name === 'claim_public_purchase_activation') {
        if (!intent) return { data: { status: 'purchase_intent_missing' }, error: null };
        if (intent.status === 'canceled' || intent.canceled_at) {
          return { data: { status: 'purchase_canceled', intent_id: intent.id }, error: null };
        }
        if (intent.protocol === 'legacy_complete') {
          return { data: { status: 'historical_complete', intent_id: intent.id }, error: null };
        }
        if (intent.activation_claimed_at && Date.parse(intent.activation_claimed_at) >= Date.now() - LEASE_MS) {
          return { data: { status: 'activation_in_progress', intent_id: intent.id }, error: null };
        }
        intent.activation_claimed_at = new Date().toISOString();
        intent.activation_claim_key = args.p_claim_key;
        return { data: { status: 'claimed', intent_id: intent.id }, error: null };
      }
      if (name === 'heartbeat_public_purchase_activation') {
        return { data: intent?.activation_claim_key === args.p_claim_key, error: null };
      }
      if (name === 'release_public_purchase_activation') {
        const owned = intent?.activation_claim_key === args.p_claim_key;
        if (owned) {
          intent.activation_claimed_at = null;
          intent.activation_claim_key = null;
        }
        return { data: owned, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
    from() {
      const q = {
        select() { return q; },
        eq() { return q; },
        neq() { return q; },
        is() { return q; },
        or() { return q; },
        in() { return q; },
        not() { return q; },
        order() { return q; },
        limit() { return q; },
        insert() { return Promise.resolve({ error: null }); },
        upsert() { return Promise.resolve({ error: null }); },
        delete() { return q; },
        update() { return q; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        then(resolve) { return resolve({ data: null, error: null }); },
      };
      return q;
    },
  };
  return db;
}

function loadApp(intentRow, { type = 'checkout.session.completed' } = {}) {
  for (const p of [routerPath, stripeClientPath, supabasePath, activationPath, enterpriseWebhookPath]) delete require.cache[p];

  const activationCalls = [];
  injectModule(activationPath, {
    activatePublicPurchaseAgreementCheckout: async (args) => {
      activationCalls.push(args);
      return { ok: true, status: 'activated' };
    },
  });
  injectModule(enterpriseWebhookPath, { classifyExistingEnterprisePaymentEvent: async () => null });
  injectModule(stripeClientPath, {
    webhooks: {
      constructEvent: () => ({
        id: `evt_${Math.random().toString(16).slice(2)}`,
        type,
        created: 1789000000,
        data: {
          object: {
            id: 'cs_1', mode: 'subscription', status: 'complete', payment_status: 'paid',
            customer: 'cus_1', subscription: 'sub_1',
            metadata: {
              source: 'agreement_checkout', agreement_id: 'agr_1',
              client_id: 'client_1', plan_tier: 'pro', billing_interval: 'monthly',
            },
          },
        },
      }),
    },
    subscriptions: { retrieve: async () => ({ id: 'sub_1', status: 'active', items: { data: [] }, metadata: {} }) },
  });
  const db = makeDb(intentRow);
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });

  const app = express();
  app.use('/webhook/stripe', express.raw({ type: 'application/json' }), require(routerPath));
  return { app, db, activationCalls };
}

const intent = (overrides = {}) => ({
  id: 'ppi_1', agreement_id: 'agr_1', status: 'pending', protocol: 'fenced_v2', activated_at: null,
  canceled_at: null, activation_claimed_at: null, activation_claim_key: null,
  ...overrides,
});

async function post(app) {
  return request(app)
    .post('/webhook/stripe')
    .set('Content-Type', 'application/json')
    .set('stripe-signature', 't=1,v1=stubbed')
    .send(Buffer.from('{}'));
}

test('the database lease refuses a fresh claim and lets a five-minute-old one be taken over', () => {
  const sql = fs.readFileSync(FENCE_MIGRATION, 'utf8');
  const claim = sql.match(/create or replace function public\.claim_public_purchase_activation\([\s\S]*?\n\$\$;/)?.[0];
  assert.ok(claim, 'the fence migration defines the claim function');
  assert.match(claim, /activation_claimed_at >= v_now - interval '5 minutes' then\s+return jsonb_build_object\('status', 'activation_in_progress'/);
  // Freshness is sampled after the row lock, so a lease refreshed during the wait holds.
  assert.ok(claim.indexOf('for update') < claim.indexOf('v_now := clock_timestamp()'));
  assert.match(claim, /set activation_claimed_at = v_now, activation_claim_key = p_claim_key/);
});

test('an unclaimed intent is claimed and activated', async () => {
  const { app, db, activationCalls } = loadApp(intent());

  assert.equal((await post(app)).status, 200);
  assert.equal(activationCalls.length, 1);
  const claim = db.state.rpcs.find((call) => call.name === 'claim_public_purchase_activation');
  assert.ok(claim, 'the claim should be recorded');
  assert.equal(activationCalls[0].activationClaimKey, claim.args.p_claim_key, 'activation runs under the claim');
  assert.equal(activationCalls[0].activationIntentId, 'ppi_1');
  assert.ok(db.state.rpcs.some((call) => call.name === 'release_public_purchase_activation'
    && call.args.p_claim_key === claim.args.p_claim_key), 'the claim is released when the run ends');
});

test('a fresh claim blocks a second caller, and Stripe is asked to retry', async () => {
  const heldAt = new Date(Date.now() - 2 * MINUTE).toISOString();
  const { app, db, activationCalls } = loadApp(
    intent({ activation_claimed_at: heldAt, activation_claim_key: 'cs_other' }));

  const res = await post(app);
  assert.equal(res.status, 503, 'the paid agreement has not activated, so the event must be redelivered');
  assert.equal(res.body.code, 'AGREEMENT_ACTIVATION_RETRY_REQUIRED');
  assert.deepEqual(activationCalls, [], 'a live claim must not be taken over');
  assert.equal(db.state.intent.activation_claim_key, 'cs_other', 'the held claim is untouched');
});

test('a claim older than the five-minute lease is taken over', async () => {
  const staleAt = new Date(Date.now() - 6 * MINUTE).toISOString();
  const { app, db, activationCalls } = loadApp(
    intent({ activation_claimed_at: staleAt, activation_claim_key: 'cs_abandoned' }));

  assert.equal((await post(app)).status, 200);
  assert.equal(activationCalls.length, 1, 'an abandoned claim must not block activation forever');
  const claim = db.state.rpcs.find((call) => call.name === 'claim_public_purchase_activation');
  assert.match(claim.args.p_claim_key, /^cs_1:/, 'the new caller claims under its own session');
  assert.notEqual(claim.args.p_claim_key, 'cs_abandoned');
});

test('a claim inside the five-minute lease is still treated as live', async () => {
  const insideLease = new Date(Date.now() - 4 * MINUTE).toISOString();
  const { app, activationCalls } = loadApp(
    intent({ activation_claimed_at: insideLease, activation_claim_key: 'cs_other' }));

  assert.equal((await post(app)).status, 503);
  assert.deepEqual(activationCalls, [], 'inside the lease the claim still holds');
});

test('a historically completed intent is never reclaimed', async () => {
  const staleAt = new Date(Date.now() - 60 * MINUTE).toISOString();
  const { app, db, activationCalls } = loadApp(intent({
    status: 'completed',
    protocol: 'legacy_complete',
    activated_at: '2026-09-19T00:00:00.000Z',
    activation_claimed_at: staleAt,
    activation_claim_key: 'cs_done',
  }));

  assert.equal((await post(app)).status, 200, 'a finished purchase is acknowledged, not retried');
  assert.deepEqual(activationCalls, []);
  assert.equal(db.state.intent.activation_claim_key, 'cs_done',
    'a completed activation must never have its claim taken over');
});

test('a canceled intent is never claimed, however old', async () => {
  const staleAt = new Date(Date.now() - 60 * MINUTE).toISOString();
  const { app, db, activationCalls } = loadApp(intent({
    status: 'canceled',
    canceled_at: '2026-09-19T00:00:00.000Z',
    activation_claimed_at: staleAt,
    activation_claim_key: 'cs_canceled',
  }));

  assert.equal((await post(app)).status, 200);
  assert.deepEqual(activationCalls, [], 'a canceled purchase must never activate');
  assert.equal(db.state.intent.activation_claim_key, 'cs_canceled');
});

test('an agreement with no purchase intent still activates, unclaimed', async () => {
  // Agreements issued outside the public purchase flow have no intent to fence.
  const { app, db, activationCalls } = loadApp(null);

  assert.equal((await post(app)).status, 200);
  assert.equal(activationCalls.length, 1, 'the paid agreement must still activate');
  assert.equal(activationCalls[0].activationClaimKey, null);
  assert.ok(!db.state.rpcs.some((call) => call.name === 'release_public_purchase_activation'),
    'there is no claim to release');
});

test('a delayed payment that settles but cannot claim yet is retried, not dropped', async () => {
  const heldAt = new Date(Date.now() - 1 * MINUTE).toISOString();
  const { app, activationCalls } = loadApp(
    intent({ activation_claimed_at: heldAt, activation_claim_key: 'cs_other' }),
    { type: 'checkout.session.async_payment_succeeded' });

  const res = await post(app);
  assert.equal(res.status, 503);
  assert.deepEqual(activationCalls, []);
});
