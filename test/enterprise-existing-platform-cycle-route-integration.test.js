'use strict';
// Real existing Express route/classifier/GET proof/completion, synthetic native
// RPC responses only. NOT SQL/cash/hosted acceptance or recipient delivery.
const { test } = require('node:test'), assert = require('node:assert/strict');
const express = require('express'), request = require('supertest');
const inject = (path, value) => { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports: value }; };
inject('../src/clients/supabase', { supabaseAdmin: { from() { throw Error('unscoped DB forbidden'); } } });
const fixture = require('./helpers/enterprise-platform-cycle-fixture');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
for (const cadence of ['monthly', 'annual']) test(`real ${cadence} cycle route composes cash reader, native receipt and coverage without initial tail`, async t => {
  const f = await fixture(t, { cadence }), db = f.native.db;
  const events = createFakeSupabase({ billing_events: [] }, { unique: { billing_events: row => row.stripe_event_id } });
  const nativeFrom = db.from.bind(db);
  db.from = table => table === 'billing_events' ? events.from(table) : nativeFrom(table);
  const stripe = { ...f.stripe, checkout: f.native.stripe.checkout, subscriptions: f.native.stripe.subscriptions,
    webhooks: { constructEvent: () => ({ id: 'evt_LOCAL_CYCLE', type: 'invoice.paid', livemode: false,
      data: { object: structuredClone(f.x.invoice) } }) } };
  inject('../src/clients/supabase', { supabaseAdmin: db }); inject('../src/clients/stripe', stripe);
  const forbidden = () => { throw Error('initial activation/account tail forbidden'); };
  inject('../src/services/publicPurchaseActivation', { activatePublicPurchaseAgreementCheckout: forbidden, finishExistingEnterpriseAccountSetup: forbidden });
  const path = require.resolve('../src/routes/webhooks/stripe'); delete require.cache[path];
  const app = express(); app.use('/webhook/stripe', express.raw({ type: 'application/json' }), require(path));
  const post = () => request(app).post('/webhook/stripe').set('content-type', 'application/json').send('{}');
  const before = structuredClone(db.tables);
  assert.equal((await post()).status, 200); assert.equal(f.persisted, 1); assert.equal(f.refreshes, 1);
  assert.equal(events.tables.billing_events.length, 1); assert.equal(events.tables.billing_events[0].processed_ok, true);
  assert.equal((await post()).status, 200); assert.equal(f.persisted, 1); assert.equal(f.refreshes, 2);
  for (const [table, rows] of Object.entries(before)) if (table !== 'billing_invoices') assert.deepEqual(db.tables[table], rows);
  assert.ok(f.rpcCalls.every(x => ['read_enterprise_existing_billing', 'record_enterprise_existing_paid_period', 'refresh_enterprise_existing_paid_coverage'].includes(x.name)));
  // A true event flag cannot hide cash becoming unverified on a later delivery.
  f.x.charge.refunded = true;
  assert.equal((await post()).status, 503); assert.equal(f.persisted, 1); assert.equal(f.refreshes, 2);
  assert.equal(events.tables.billing_events[0].processed_ok, true); // native HTTP hold, not false rollback/downgrade
});
