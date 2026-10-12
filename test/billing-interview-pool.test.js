'use strict';

// The Enterprise interview pool.
//
// A pool is bought once at signup and every role under the client — or under any
// of its child entities — draws from it. The two rules worth protecting are that
// an interview can only ever spend one unit, and that running out never stops
// anyone working: past the pool an interview is metered, not refused.
//
// Supabase is an in-memory stand-in; no database, no network.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const sendgridPath = path.join(ROOT, 'src', 'clients', 'sendgrid.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

injectModule(supabasePath, { supabaseAdmin: {}, supabase: {}, supabaseAnon: {} });
injectModule(sendgridPath, {
  sendRoleInterviewLimitReachedEmail: async () => ({ ok: true }),
  buildBrandedEmailShell: () => '',
  escapeHtml: (value) => String(value)
});

const {
  markPoolFailed,
  markPoolPaid
} = require(path.join(ROOT, 'src', 'services', 'interviewPool.js'));
const { getRoleInterviewAvailability } = require(path.join(ROOT, 'src', 'services', 'roleInterviewAvailability.js'));

const PARENT = 'client_parent';
const CHILD = 'client_child';
const ROLE = 'role_parent';
const CHILD_ROLE = 'role_child';
const FIRST_PAID_AT = '2026-09-01T00:00:00.000Z';

const pool = (overrides = {}) => ({
  id: 'pool_1',
  client_id: PARENT,
  quantity_purchased: 10,
  unit_price_cents: 2500,
  discount_pct: 0,
  total_cents: 25000,
  offer_snapshot:null,offer_digest:null,
  status: 'paid',
  created_at: '2026-09-01T00:00:00.000Z',
  paid_at: '2026-09-01T00:00:00.000Z',
  ...overrides
});

function makeDb({
  pools = [pool()],
  interviews = [],
  purchases = [],
  billingModel = 'usage',
  planTier = 'enterprise',
  included = 0
} = {}) {
  return createFakeSupabase({
    clients: [
      { id: PARENT, parent_client_id: null, name: 'Acme Dental Group' },
      { id: CHILD, parent_client_id: PARENT, name: 'Acme Downtown', entity_label: 'Downtown' }
    ],
    client_plan_settings: [{
      client_id: PARENT,
      plan_tier: planTier,
      billing_model: billingModel,
      included_interviews_per_role: included,
      per_role_fee: 0,
      usage_interview_fee_cents: 2500,
      rollover_days: 90
    }],
    roles: [
      { id: ROLE, client_id: PARENT, title: 'Hygienist' },
      { id: CHILD_ROLE, client_id: CHILD, title: 'Front Desk' }
    ],
    interviews,
    role_interview_purchases: purchases,
    client_interview_pools: pools,
    interview_credits: []
  });
}

// --- paying for a pool ----------------------------------------------------

test('paying a pending pool makes its interviews spendable', async () => {
  const db = makeDb({ pools: [pool({ status: 'pending', quantity_purchased: 8 })] });

  const result = await markPoolPaid({ db, poolId: 'pool_1', stripePaymentIntentId: 'pi_1' });

  assert.equal(result.paid, true);
  const row = db.tables.client_interview_pools[0];
  assert.equal(row.status, 'paid', 'paid is what makes a pool spendable; nothing else is written');
  assert.equal(row.quantity_purchased, 8);
  assert.equal(row.quantity_remaining, undefined, 'no balance is stored');
  assert.equal(row.stripe_payment_intent_id, 'pi_1');
  assert.ok(row.paid_at);
});

test('paid helper refuses v2/split/missing pair and native-null compare gate is on the actual write',async()=>{
  for(const extra of [{offer_snapshot:{}},{offer_digest:'a'.repeat(64)},{offer_snapshot:undefined}]){
    const db=makeDb({pools:[pool({status:'pending',...extra})]});await assert.rejects(()=>markPoolPaid({db,poolId:'pool_1'}),/PAYMENT_PROOF_REQUIRED/);
    assert.equal(db.tables.client_interview_pools[0].status,'pending');assert.ok(!db.calls.some(c=>c.table==='client_interview_pools' && c.op==='update'));
  }
  const source=fs.readFileSync(path.join(ROOT,'src/services/interviewPool.js'),'utf8');
  assert.match(source,/\.is\('offer_snapshot',null\)\s*\.is\('offer_digest',null\)/);
});

test('a redelivered payment changes nothing about a pool already paid', async () => {
  const db = makeDb({ pools: [pool({ status: 'paid', quantity_purchased: 10, paid_at: FIRST_PAID_AT })] });

  const result = await markPoolPaid({ db, poolId: 'pool_1' });

  assert.equal(result.paid, false);
  assert.equal(result.reason, 'already_paid');
  assert.equal(db.tables.client_interview_pools[0].paid_at, FIRST_PAID_AT,
    'the first settlement stands');
});

test('a failed payment marks the pool failed and leaves it unspendable', async () => {
  const db = makeDb({ pools: [pool({ status: 'pending' })] });

  assert.equal((await markPoolFailed({ db, poolId: 'pool_1' })).failed, true);
  assert.equal(db.tables.client_interview_pools[0].status, 'failed');
  assert.equal((await availabilityFor(db)).pool_remaining_interviews, 0,
    'only a paid pool is ever spendable');
});

test('a pool that is already paid cannot be marked failed', async () => {
  const db = makeDb({ pools: [pool({ status: 'paid' })] });

  assert.equal((await markPoolFailed({ db, poolId: 'pool_1' })).failed, false);
  assert.equal(db.tables.client_interview_pools[0].status, 'paid');
});

test('marking an unknown pool is refused, not silently ignored', async () => {
  const db = makeDb();

  assert.deepEqual(await markPoolPaid({ db, poolId: 'pool_missing' }), { paid: false, reason: 'not_found' });
});

// --- what availability reports --------------------------------------------

const availabilityFor = (db, roleId = ROLE, clientId = PARENT) =>
  getRoleInterviewAvailability({ db, roleId, clientId });

test('a usage role reports the pool and no cap', async () => {
  const db = makeDb({ pools: [pool({ quantity_purchased: 6 })] });

  const availability = await availabilityFor(db);

  assert.equal(availability.pool_remaining_interviews, 6);
  assert.equal(availability.remaining_interviews, null, 'usage roles are metered, never capped');
  assert.equal(availability.billing_model, 'usage');
  assert.equal(availability.included_interviews_per_role, 0,
    'the per-role included count is not meaningful under this model');
});

test('a child role sees the parent pool', async () => {
  const db = makeDb({ pools: [pool({ quantity_purchased: 6 })] });

  const availability = await availabilityFor(db, CHILD_ROLE, CHILD);

  assert.equal(availability.pool_remaining_interviews, 6);
  assert.equal(availability.remaining_interviews, null);
});

test('an empty pool still reports no cap, so interviews carry on', async () => {
  // Genuinely exhausted: one interview bought, one run.
  const db = makeDb({
    pools: [pool({ quantity_purchased: 1 })],
    interviews: [{
      id: 'iv_1', client_id: PARENT, role_id: ROLE, status: 'completed',
      completed_at: '2026-09-02T00:00:00.000Z'
    }]
  });

  const availability = await availabilityFor(db);

  assert.equal(availability.pool_remaining_interviews, 0);
  assert.equal(availability.remaining_interviews, null,
    'running out must never read as full — past the pool an interview is billed');
});

test('a usage client reports the included count its agreement gives it', async () => {
  const db = makeDb({ included: 25, pools: [pool({ quantity_purchased: 1 })] });

  assert.equal((await availabilityFor(db)).included_interviews_per_role, 25,
    'the included count is free under Enterprise too, so it is not hidden');
});

test('legacy paid top-ups on a usage role are still counted', async () => {
  const db = makeDb({
    purchases: [{ client_id: PARENT, role_id: ROLE, quantity: 4, status: 'paid' }],
    pools: [pool({ quantity_purchased: 2 })]
  });

  const availability = await availabilityFor(db);

  assert.equal(availability.purchased_interviews, 4);
  assert.equal(availability.own_remaining_interviews, 4);
  assert.equal(availability.pool_remaining_interviews, 2);
});

test('the other models are untouched by the pool', async () => {
  for (const [planTier, billingModel] of [['basic', 'fixed'], ['pro', 'rollover']]) {
    const db = makeDb({ planTier, billingModel, included: 5, pools: [pool({ quantity_purchased: 9 })] });

    const availability = await availabilityFor(db);

    assert.equal(availability.pool_remaining_interviews, 0, `${billingModel} has no pool`);
    assert.equal(availability.remaining_interviews, 5, 'and still reports a real cap');
  }
});

// --- the migration --------------------------------------------------------

test('the migration pins the invariants the service relies on', () => {
  const sql = fs.readFileSync(
    path.join(ROOT, 'supabase', 'migrations', '20261009180000_client_interview_pools.sql'),
    'utf8'
  );

  assert.match(sql, /create table if not exists public\.client_interview_pools/i);
  assert.doesNotMatch(sql, /client_interview_pool_draws/i,
    'draws are derived from the interviews; a draw table would be a second truth');
  assert.doesNotMatch(sql, /quantity_remaining/i,
    'a stored balance is what this design removed');
  assert.match(sql, /check \(quantity_purchased > 0\)/i,
    'a pool of nothing is not a pool');
  assert.match(sql, /check \(status in \('pending', 'paid', 'failed', 'voided', 'refunded'\)\)/i);
  assert.match(sql, /alter table public\.client_interview_pools enable row level security/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.client_interview_pools[\s\S]*?to service_role/i);

  for (const grant of (sql.match(/grant[\s\S]*?;/gi) || [])) {
    assert.doesNotMatch(grant, /\bto\b[\s\S]*\b(anon|authenticated)\b/i, `unexpected grant: ${grant}`);
  }
});
