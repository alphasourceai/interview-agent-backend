'use strict';

// On-demand usage invoices, and the monthly cron for annual Enterprise clients.
//
// Both spend money, so the guards are the point: the admin route will not raise
// two invoices for one Idempotency-Key, and the cron only acts on the 1st.
//
// Stripe, Supabase and auth are stubbed; no network.

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const request = require('supertest');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const adminBillingPath = path.join(ROOT, 'src', 'routes', 'admin', 'billing.js');
const internalUsagePath = path.join(ROOT, 'src', 'routes', 'internal', 'usageBilling.js');
const usageBillingPath = path.join(ROOT, 'src', 'services', 'usageBilling.js');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const sendgridPath = path.join(ROOT, 'src', 'clients', 'sendgrid.js');
const stripeClientPath = path.join(ROOT, 'src', 'clients', 'stripe.js');
const checkoutPath = path.join(ROOT, 'src', 'services', 'subscriptionCheckout.js');
const authPath = path.join(ROOT, 'src', 'middleware', 'auth.js');
const requireAdminPath = path.join(ROOT, 'src', 'middleware', 'requireAdmin.js');
const adminHelpersPath = path.join(ROOT, 'src', 'services', 'admin', 'adminHelpers.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

injectModule(sendgridPath, {
  sendSubscriptionCheckoutEmail: async () => ({ ok: true }),
  sendRoleInterviewLimitReachedEmail: async () => ({ ok: true }),
  buildBrandedEmailShell: () => '',
  escapeHtml: (value) => String(value)
});

const CLIENT = 'client_1';
const CUSTOMER = 'cus_1';
const ADMIN = 'admin_1';
const NOW = '2026-09-15T12:00:00.000Z';

const UNIQUE_KEYS = {
  usage_billing_ledger: (row) => `interview:${row.interview_id}`,
  billing_idempotency_keys: (row) => `${row.actor_user_id}|${row.route_key}|${row.idempotency_key}`
};

function usedInterviews(count, { clientId = CLIENT, roleId = 'role_1', prefix = 'iv' } = {}) {
  const start = new Date('2026-08-01T00:00:00.000Z').getTime();
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}_${i + 1}`,
    client_id: clientId,
    role_id: roleId,
    status: 'completed',
    completed_at: new Date(start + i * 3600000).toISOString(),
    updated_at: new Date(start + i * 3600000).toISOString()
  }));
}

function makeStripe({ failFinalize = false, failDelete = false } = {}) {
  const calls = { invoices: [], items: [], finalized: [], deleted: [] };
  return {
    calls,
    invoices: {
      retrieve: async id => ({ id, status: 'open' }),
      create: async (payload) => {
        calls.invoices.push(payload);
        return { id: `in_${calls.invoices.length}` };
      },
      finalizeInvoice: async (id) => {
        if (failFinalize) throw new Error('Stripe is unavailable');
        calls.finalized.push(id);
        return { id, status: 'open' };
      },
      del: async (id) => {
        if (failDelete) throw new Error('Stripe is unavailable');
        calls.deleted.push(id);
        return { id, deleted: true };
      }
    },
    invoiceItems: {
      list: async () => ({ data: [], has_more: false }),
      create: async (payload) => {
        calls.items.push(payload);
        return { id: `ii_${calls.items.length}` };
      }
    }
  };
}

function makeDb({
  clients = [{
    id: CLIENT, parent_client_id: null, name: 'Acme Dental Group',
    stripe_customer_id: CUSTOMER, billing_interval: 'annual',
    contract_start_at: '2025-09-15T00:00:00.000Z', current_term_end: '2026-09-15T00:00:00.000Z'
  }],
  planSettings = [{
    client_id: CLIENT, plan_tier: 'enterprise', billing_model: 'usage',
    included_interviews_per_role: 0, per_role_fee: 0,
    usage_interview_fee_cents: 2500, rollover_days: 90
  }],
  roles = [{ id: 'role_1', client_id: CLIENT, title: 'Hygienist' }],
  interviews = usedInterviews(3),
  ledger = [],
  idempotency = []
} = {}) {
  return createFakeSupabase({
    clients,
    client_plan_settings: planSettings,
    roles,
    interviews,
    usage_billing_ledger: ledger,
    billing_idempotency_keys: idempotency
  }, { unique: UNIQUE_KEYS });
}

// --- the service -----------------------------------------------------------

function loadService() {
  for (const p of [usageBillingPath, supabasePath]) delete require.cache[p];
  injectModule(supabasePath, { supabaseAdmin: {}, supabase: {}, supabaseAnon: {} });
  return require(usageBillingPath);
}

const { createImmediateUsageInvoice } = loadService();

test('an immediate invoice bills the unbilled usage and finalizes', async () => {
  const db = makeDb({ interviews: usedInterviews(4) });
  const stripe = makeStripe();

  const result = await createImmediateUsageInvoice({
    db, stripe, clientId: CLIENT, asOf: NOW, reason: 'admin_request', now: NOW
  });

  assert.equal(result.invoice_id, 'in_1');
  assert.equal(result.total_cents, 4 * 2500);
  assert.equal(stripe.calls.invoices[0].customer, CUSTOMER);
  assert.equal(stripe.calls.invoices[0].collection_method, 'charge_automatically');
  assert.equal(stripe.calls.invoices[0].auto_advance, false, 'a draft cannot charge while it is incomplete');
  assert.equal(stripe.calls.invoices[0].metadata.source, 'usage_billing');
  assert.equal(stripe.calls.invoices[0].metadata.reason, 'admin_request');
  assert.equal(stripe.calls.items.length, 1);
  assert.equal(stripe.calls.items[0].quantity, 4);
  assert.deepEqual(stripe.calls.finalized, ['in_1']);
  assert.equal(db.tables.usage_billing_ledger.length, 4);
  assert.ok(db.tables.usage_billing_ledger.every((row) => row.billed_at));
});

test('a client with nothing unbilled is skipped without touching Stripe', async () => {
  // Every interview completed after the month being billed.
  const db = makeDb({
    interviews: usedInterviews(3).map((row) => ({
      ...row, updated_at: '2026-09-20T00:00:00.000Z', completed_at: '2026-09-20T00:00:00.000Z'
    }))
  });
  const stripe = makeStripe();

  const result = await createImmediateUsageInvoice({ db, stripe, clientId: CLIENT, asOf: NOW, now: NOW });

  assert.equal(result.skipped, true);
  assert.deepEqual(stripe.calls.invoices, [], 'an empty invoice must never be raised');
});

test('a client on another billing model is skipped', async () => {
  const db = makeDb({
    planSettings: [{
      client_id: CLIENT, plan_tier: 'pro', billing_model: 'rollover',
      included_interviews_per_role: 0, per_role_fee: 699,
      usage_interview_fee_cents: null, rollover_days: 90
    }]
  });
  const stripe = makeStripe();

  const result = await createImmediateUsageInvoice({ db, stripe, clientId: CLIENT, asOf: NOW, now: NOW });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'billing_model');
});

test('a client with no Stripe customer is skipped rather than half invoiced', async () => {
  const db = makeDb({
    clients: [{ id: CLIENT, parent_client_id: null, stripe_customer_id: null, billing_interval: 'annual' }]
  });
  const stripe = makeStripe();

  const result = await createImmediateUsageInvoice({ db, stripe, clientId: CLIENT, asOf: NOW, now: NOW });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no_stripe_customer');
  assert.deepEqual(db.tables.usage_billing_ledger, []);
});

// There is unbilled usage, so an invoice is created — but the id it comes back
// with already carries fully stamped ledger rows, so applyUsageToInvoice adds
// nothing. Finalizing then would send an empty invoice, and auto_advance would
// try to collect it.
const ALREADY_BILLED = Object.freeze({
  interviews: [
    { id: 'iv_1', client_id: CLIENT, role_id: 'role_1', status: 'completed', updated_at: '2026-08-01T00:00:00.000Z' },
    { id: 'iv_2', client_id: CLIENT, role_id: 'role_1', status: 'completed', updated_at: '2026-08-02T00:00:00.000Z' },
    { id: 'iv_3', client_id: CLIENT, role_id: 'role_1', status: 'completed', updated_at: '2026-08-03T00:00:00.000Z' }
  ],
  ledger: [
    { client_id: CLIENT, role_id: 'role_1', interview_id: 'iv_1', unit_price_cents: 2500, stripe_invoice_id: 'in_1', billed_at: '2026-09-01T00:00:00.000Z' },
    { client_id: CLIENT, role_id: 'role_1', interview_id: 'iv_2', unit_price_cents: 2500, stripe_invoice_id: 'in_1', billed_at: '2026-09-01T00:00:00.000Z' }
  ]
});

test('an invoice that ends up with no lines is discarded, not finalized', async () => {
  const db = makeDb({ ...ALREADY_BILLED });
  const stripe = makeStripe();

  const result = await createImmediateUsageInvoice({
    db, stripe, clientId: CLIENT, asOf: NOW, reason: 'admin_request', now: NOW
  });

  assert.equal(result.skipped, true);
  assert.equal(stripe.calls.invoices.length, 1, 'the draft was created before we knew it would be empty');
  assert.deepEqual(stripe.calls.items, [], 'nothing was added to it');
  assert.deepEqual(stripe.calls.finalized, [], 'an empty invoice must never be finalized');
  assert.deepEqual(stripe.calls.deleted, ['in_1'], 'the draft must be discarded');
});

test('a failed discard is logged and still reports skipped rather than charging', async () => {
  const db = makeDb({ ...ALREADY_BILLED });
  const stripe = makeStripe({ failDelete: true });
  const lines = [];
  const originalError = console.error;
  console.error = (...args) => lines.push(args);
  let result;
  try {
    result = await createImmediateUsageInvoice({
      db, stripe, clientId: CLIENT, asOf: NOW, reason: 'admin_request', now: NOW
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(result.skipped, true);
  assert.deepEqual(stripe.calls.finalized, [], 'a cleanup failure must not fall through to finalize');
  assert.ok(lines.find(([message]) => message === 'usage_invoice_discard_failed'));
});

// --- the cron route --------------------------------------------------------

function loadCron(db, stripe, { invoiceService } = {}) {
  for (const p of [internalUsagePath, usageBillingPath, supabasePath, stripeClientPath]) delete require.cache[p];
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });
  injectModule(stripeClientPath, stripe);
  if (invoiceService) injectModule(usageBillingPath, { createImmediateUsageInvoice: invoiceService });

  const app = express();
  app.use(express.json());
  app.use('/internal', require(internalUsagePath));
  return app;
}

const CRON_SECRET = 'usage-cron-secret-value';

function withCronSecret(fn) {
  const previous = process.env.USAGE_BILLING_CRON_SECRET;
  process.env.USAGE_BILLING_CRON_SECRET = CRON_SECRET;
  return Promise.resolve(fn()).finally(() => {
    if (previous === undefined) delete process.env.USAGE_BILLING_CRON_SECRET;
    else process.env.USAGE_BILLING_CRON_SECRET = previous;
  });
}

const runCron = (app, secret = CRON_SECRET) =>
  request(app).post('/internal/billing/usage-invoices').set('x-cron-secret', secret).send({});

// The handler decides from the wall clock, so these run with it pinned to a 1st.
const FIRST_OF_MONTH = new Date('2026-09-01T03:00:00.000Z');
const SECOND_OF_MONTH = new Date('2026-09-02T03:00:00.000Z');

function atFixedClock(fixed, fn) {
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...args) {
      if (!args.length) return new RealDate(fixed.getTime());
      return new RealDate(...args);
    }

    static now() { return fixed.getTime(); }
  };
  return Promise.resolve(fn()).finally(() => { global.Date = RealDate; });
}

const onTheSecond = (fn) => atFixedClock(SECOND_OF_MONTH, fn);
const onTheFirst = (fn) => atFixedClock(FIRST_OF_MONTH, fn);

test('the cron refuses a wrong or missing secret', async () => {
  await withCronSecret(() => onTheFirst(async () => {
    const app = loadCron(makeDb(), makeStripe());
    assert.equal((await runCron(app, 'wrong-secret-value')).status, 403);
    assert.equal((await request(app).post('/internal/billing/usage-invoices').send({})).status, 403);
  }));
});

test('the cron invoices an annual usage client on the 1st', async () => {
  await withCronSecret(() => onTheFirst(async () => {
    const db = makeDb({
      clients: [{
        id: CLIENT, parent_client_id: null, name: 'Acme Dental Group',
        stripe_customer_id: CUSTOMER, billing_interval: 'annual',
        contract_start_at: `2025-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}-${String(new Date().getUTCDate()).padStart(2, '0')}T00:00:00.000Z`
      }],
      interviews: usedInterviews(2)
    });
    const stripe = makeStripe();
    const app = loadCron(db, stripe);

    const res = await runCron(app);

    assert.equal(res.status, 200);
    assert.equal(res.body.invoiced, 1);
    assert.equal(res.body.total_cents, 5000);
    assert.equal(stripe.calls.invoices[0].metadata.reason, 'monthly_cycle');
  }));
});

test('monthly clients are excluded — their usage rides the cycle invoice', async () => {
  await withCronSecret(() => onTheFirst(async () => {
    const today = new Date();
    const anchor = `2025-01-${String(today.getUTCDate()).padStart(2, '0')}T00:00:00.000Z`;
    const db = makeDb({
      clients: [{
        id: CLIENT, parent_client_id: null, stripe_customer_id: CUSTOMER,
        billing_interval: 'monthly', contract_start_at: anchor
      }],
      interviews: usedInterviews(3)
    });
    const stripe = makeStripe();

    const res = await runCron(loadCron(db, stripe));

    assert.equal(res.body.considered, 0);
    assert.deepEqual(stripe.calls.invoices, []);
  }));
});

test('clients on other billing models are never considered', async () => {
  await withCronSecret(() => onTheFirst(async () => {
    const today = new Date();
    const anchor = `2025-01-${String(today.getUTCDate()).padStart(2, '0')}T00:00:00.000Z`;
    const db = makeDb({
      clients: [{
        id: CLIENT, parent_client_id: null, stripe_customer_id: CUSTOMER,
        billing_interval: 'annual', contract_start_at: anchor
      }],
      planSettings: [{
        client_id: CLIENT, plan_tier: 'pro', billing_model: 'rollover',
        included_interviews_per_role: 0, per_role_fee: 699,
        usage_interview_fee_cents: null, rollover_days: 90
      }],
      interviews: usedInterviews(3)
    });
    const stripe = makeStripe();

    const res = await runCron(loadCron(db, stripe));

    assert.equal(res.body.considered, 0);
    assert.deepEqual(stripe.calls.invoices, []);
  }));
});

test('a client whose billing_model is null follows its tier: Enterprise is invoiced, Pro is not', async () => {
  // Null means "follow the plan tier", so the cron cannot select usage clients
  // by filtering the column for 'usage' — that would skip every Enterprise
  // client left on its tier's model.
  await withCronSecret(() => onTheFirst(async () => {
    const today = new Date();
    const anchor = `2025-01-${String(today.getUTCDate()).padStart(2, '0')}T00:00:00.000Z`;
    const db = makeDb({
      clients: [
        { id: 'client_ent', parent_client_id: null, stripe_customer_id: 'cus_ent', billing_interval: 'annual', contract_start_at: anchor },
        { id: 'client_pro', parent_client_id: null, stripe_customer_id: 'cus_pro', billing_interval: 'annual', contract_start_at: anchor }
      ],
      planSettings: [
        { client_id: 'client_ent', plan_tier: 'enterprise', billing_model: null, included_interviews_per_role: 0, per_role_fee: 0, usage_interview_fee_cents: 2500, rollover_days: 90 },
        { client_id: 'client_pro', plan_tier: 'pro', billing_model: null, included_interviews_per_role: 0, per_role_fee: 699, usage_interview_fee_cents: 2500, rollover_days: 90 }
      ],
      roles: [
        { id: 'role_ent', client_id: 'client_ent', title: 'Hygienist' },
        { id: 'role_pro', client_id: 'client_pro', title: 'Front Desk' }
      ],
      interviews: [
        ...usedInterviews(2, { clientId: 'client_ent', roleId: 'role_ent', prefix: 'ent' }),
        ...usedInterviews(3, { clientId: 'client_pro', roleId: 'role_pro', prefix: 'pro' })
      ]
    });
    const stripe = makeStripe();

    const res = await runCron(loadCron(db, stripe));

    assert.equal(res.status, 200);
    assert.equal(res.body.considered, 1, 'only the Enterprise client resolves to usage');
    assert.equal(res.body.invoiced, 1);
    assert.deepEqual(stripe.calls.invoices.map((invoice) => invoice.customer), ['cus_ent']);
  }));
});

test('the cron does nothing on the 2nd, or any other day', async () => {
  await withCronSecret(() => onTheSecond(async () => {
    // The schedule runs daily and the handler decides, so a missed day is a
    // missed run rather than a missed month.
    const db = makeDb({ interviews: usedInterviews(3) });
    const stripe = makeStripe();

    const res = await runCron(loadCron(db, stripe));

    assert.equal(res.status, 200);
    assert.equal(res.body.skipped, 'not_first_of_month');
    assert.deepEqual(stripe.calls.invoices, [], 'usage is only invoiced on the 1st');
  }));
});

test('one failing client does not stop the rest of the run', async () => {
  await withCronSecret(() => onTheFirst(async () => {
    const today = new Date();
    const anchor = `2025-01-${String(today.getUTCDate()).padStart(2, '0')}T00:00:00.000Z`;
    const db = makeDb({
      clients: [
        { id: 'client_bad', parent_client_id: null, stripe_customer_id: 'cus_bad', billing_interval: 'annual', contract_start_at: anchor },
        { id: 'client_good', parent_client_id: null, stripe_customer_id: 'cus_good', billing_interval: 'annual', contract_start_at: anchor }
      ],
      planSettings: [
        { client_id: 'client_bad', plan_tier: 'enterprise', billing_model: 'usage', included_interviews_per_role: 0, per_role_fee: 0, usage_interview_fee_cents: 2500, rollover_days: 90 },
        { client_id: 'client_good', plan_tier: 'enterprise', billing_model: 'usage', included_interviews_per_role: 0, per_role_fee: 0, usage_interview_fee_cents: 2500, rollover_days: 90 }
      ],
      roles: [
        { id: 'role_bad', client_id: 'client_bad', title: 'Hygienist' },
        { id: 'role_good', client_id: 'client_good', title: 'Front Desk' }
      ],
      interviews: [
        ...usedInterviews(2, { clientId: 'client_bad', roleId: 'role_bad', prefix: 'bad' }),
        ...usedInterviews(3, { clientId: 'client_good', roleId: 'role_good', prefix: 'good' })
      ]
    });
    const stripe = makeStripe();
    const originalCreate = stripe.invoices.create;
    stripe.invoices.create = async (payload) => {
      if (payload.customer === 'cus_bad') throw new Error('Stripe is unavailable');
      return originalCreate(payload);
    };

    const originalError = console.error;
    console.error = () => {};
    let res;
    try {
      res = await runCron(loadCron(db, stripe));
    } finally {
      console.error = originalError;
    }

    assert.equal(res.status, 200);
    assert.equal(res.body.failed, 1);
    assert.equal(res.body.invoiced, 1);
    assert.equal(res.body.total_cents, 7500);
    const failed = res.body.results.find((entry) => entry.status === 'failed');
    assert.equal(failed.client_id, 'client_bad');
  }));
});

test('the cron pages past the row cap instead of billing only the first page', async () => {
  await withCronSecret(() => onTheFirst(async () => {
    // PostgREST returns at most 1,000 rows per request and the route pages at
    // 500, so a client beyond the first page must still be picked up.
    const today = new Date();
    const anchor = `2025-01-${String(today.getUTCDate()).padStart(2, '0')}T00:00:00.000Z`;
    const clients = [];
    const planSettings = [];
    for (let i = 0; i < 1200; i += 1) {
      const id = `bulk_${String(i).padStart(4, '0')}`;
      clients.push({
        id, parent_client_id: null, stripe_customer_id: `cus_${i}`,
        billing_interval: i === 1100 ? 'annual' : 'monthly', contract_start_at: anchor
      });
      planSettings.push({
        client_id: id, plan_tier: 'enterprise', billing_model: 'usage',
        included_interviews_per_role: 0, per_role_fee: 0,
        usage_interview_fee_cents: 2500, rollover_days: 90
      });
    }
    const db = makeDb({
      clients,
      planSettings,
      roles: [{ id: 'role_bulk', client_id: 'bulk_1100', title: 'Hygienist' }],
      interviews: usedInterviews(2, { clientId: 'bulk_1100', roleId: 'role_bulk', prefix: 'b' })
    });
    const stripe = makeStripe();

    const originalLog = console.log;
    console.log = () => {};
    let res;
    try {
      res = await runCron(loadCron(db, stripe));
    } finally {
      console.log = originalLog;
    }

    assert.equal(res.status, 200);
    assert.equal(res.body.considered, 1, 'the only annual client sits past the first page');
    assert.equal(res.body.invoiced, 1);
    assert.equal(stripe.calls.invoices[0].metadata.client_id, 'bulk_1100');
  }));
});

for (const cadence of ['monthly','annual']) for (const partial of [false,true]) {
  test(`marked ${cadence}/${partial} owner reaches cron hold despite fixed settings; zero provider calls`,async()=>{
    const f=await require('./helpers/accepted-enterprise-usage-fixture')({cadence});
    f.plan.billing_model='fixed';if(partial)f.a.enterprise_billing_receipt=null;
    let providerCalls=0;const stripe=new Proxy({}, {get(){providerCalls++;throw Error('provider must remain untouched');}});
    await withCronSecret(()=>onTheFirst(async()=>{
      const res=await runCron(loadCron(f.db,stripe));
      assert.equal(res.status,503);assert.equal(res.body.ok,false);assert.equal(res.body.held_clients,1);
      assert.equal(res.body.considered,1);assert.equal(res.body.failed,1);assert.equal(res.body.invoiced,0);
      assert.equal(res.body.results[0].retryable,true);assert.equal(res.body.results[0].http_status,503);
      assert.equal(res.body.results[0].code,partial?'enterprise_usage_terms_unavailable':'enterprise_usage_invoice_executor_pending');
      assert.equal(providerCalls,0);
      assert.equal(f.db.calls.some(c=>c.table==='usage_billing_ledger'),false);
    }));
  });
}

function watchedDb(db) {
  const reads={};const from=db.from;
  db.from=table=>{reads[table]=(reads[table]||0)+1;return from(table);};
  return reads;
}
function watchStripeImport() {
  let imports=0;const module=require.cache[stripeClientPath];const value=module.exports;
  Object.defineProperty(module,'exports',{get(){imports++;return value;},configurable:true});
  return()=>imports;
}
for(const marker of ['',0,false,{},'synthetic'])test(`day2 non-null ${JSON.stringify(marker)} marker is held without other reads or Stripe import`,async()=>{
  const db=makeDb();db.tables.membership_agreements=[
    {id:'a',client_id:CLIENT,enterprise_checkout_pool_id:marker},
    {id:'b',client_id:CLIENT,enterprise_funding_receipt:marker},
    {id:'c',client_id:'other',enterprise_billing_receipt:marker}];
  const reads=watchedDb(db);
  await withCronSecret(()=>onTheSecond(async()=>{
    const app=loadCron(db,makeStripe());const imports=watchStripeImport();const res=await runCron(app);
    assert.equal(res.status,503);assert.equal(res.body.ok,false);assert.equal(res.body.held_clients,2);
    assert.equal(res.body.code,'enterprise_usage_invoice_executor_pending');
    assert.equal(res.body.considered,2);assert.equal(res.body.failed,2);assert.equal(res.body.invoiced,0);
    assert.deepEqual(res.body.results,[]);assert.deepEqual(reads,{membership_agreements:1});assert.equal(imports(),0);
    assert.equal(JSON.stringify(res.body).includes('synthetic'),false);
  }));
});
for(const column of ['id','client_id'])for(const bad of [null,0,'',' \t'])test(`day2 agreement ${column} ${JSON.stringify(bad)} refuses census before marker classification`,async()=>{
  const db=makeDb();db.tables.membership_agreements=[{id:'a',client_id:CLIENT,[column]:bad}];
  const reads=watchedDb(db);
  await withCronSecret(()=>onTheSecond(async()=>{
    const app=loadCron(db,makeStripe());const imports=watchStripeImport();const res=await runCron(app);
    assert.equal(res.status,503);assert.deepEqual(res.body,{error:'billing_unavailable',code:'enterprise_usage_owner_census_unavailable'});
    assert.deepEqual(reads,{membership_agreements:1});assert.equal(imports(),0);
  }));
});
test('unmarked day2 preserves exact legacy skip and performs only one agreement census',async()=>{
  const db=makeDb();db.tables.membership_agreements=[{id:'a',client_id:CLIENT,enterprise_checkout_source:null}];
  const reads=watchedDb(db);
  await withCronSecret(()=>onTheSecond(async()=>{
    const app=loadCron(db,makeStripe());const imports=watchStripeImport();const res=await runCron(app);
    assert.equal(res.status,200);assert.deepEqual(res.body,{ok:true,skipped:'not_first_of_month',considered:0,invoiced:0,skipped_clients:0,failed:0,total_cents:0,results:[]});
    assert.deepEqual(reads,{membership_agreements:1});assert.equal(imports(),0);
  }));
});
for(const table of ['membership_agreements','client_plan_settings','clients'])test(`${table} incomplete/thrown census bypasses 500 catch and prevents Stripe construction`,async()=>{
  for(const throwing of [false,true]){
    const db=makeDb();const from=db.from;
    db.from=name=>{if(name!==table)return from(name);if(throwing)throw Error('private-token');
      const q=from(name);q.range=()=>Promise.resolve({data:[],error:null,count:1});return q;};
    await withCronSecret(()=>onTheFirst(async()=>{
      const app=loadCron(db,makeStripe());const imports=watchStripeImport();const res=await runCron(app);
      assert.equal(res.status,503);assert.deepEqual(res.body,{error:'billing_unavailable',code:'enterprise_usage_owner_census_unavailable'});
      assert.equal(imports(),0);assert.equal(db.tables.usage_billing_ledger.length,0);
    }));
  }
});
test('later client chunk failure prevents every earlier client invoice',async()=>{
  const clients=Array.from({length:201},(_,n)=>({id:`chunk_${String(n).padStart(3,'0')}`,billing_interval:'annual'}));
  const db=makeDb({clients,planSettings:clients.map(c=>({client_id:c.id,plan_tier:'enterprise'}))});
  const from=db.from;let chunks=0;
  db.from=table=>{const q=from(table);if(table==='clients'&&++chunks===2)q.range=()=>Promise.resolve({data:null,error:{message:'secret'},count:null});return q;};
  await withCronSecret(()=>onTheFirst(async()=>{
    const app=loadCron(db,makeStripe(),{invoiceService:async()=>{assert.fail('no partial dispatch');}});const imports=watchStripeImport();
    const res=await runCron(app);assert.equal(res.status,503);assert.equal(chunks,2);assert.equal(imports(),0);
    assert.equal(res.body.code,'enterprise_usage_owner_census_unavailable');
  }));
});
test('an exact client chunk may omit a requested id; the remaining real legacy invoice is retained',async()=>{
  const db=makeDb();db.tables.client_plan_settings.push({client_id:'missing',plan_tier:'enterprise'});
  const stripe=makeStripe();
  await withCronSecret(()=>onTheFirst(async()=>{
    const res=await runCron(loadCron(db,stripe));assert.equal(res.status,200);assert.equal(res.body.invoiced,1);
    assert.equal(res.body.held_clients,undefined);assert.equal(stripe.calls.invoices.length,1);
  }));
});
test('day1 performs exactly one route census; existing scoped source reads remain separate',async()=>{
  const db=makeDb();const from=db.from;let scans=0;
  db.from=table=>{const q=from(table);if(table==='membership_agreements'){
    const range=q.range;q.range=(...args)=>{scans++;return range(...args);};}return q;};
  await withCronSecret(()=>onTheFirst(async()=>{const res=await runCron(loadCron(db,makeStripe()));assert.equal(res.status,200);assert.equal(scans,1);}));
});
test('day1 mixed actual legacy invoice and both marked hold codes keep each outcome and do not imply rollback',async()=>{
  const f=await require('./helpers/accepted-enterprise-usage-fixture')();const db=makeDb();
  const second=structuredClone(f.client);second.id='other_marked';
  db.tables.clients.push(f.client,second);db.tables.client_plan_settings.push(f.plan,{...f.plan,client_id:second.id});
  db.tables.membership_agreements=[f.a,{...structuredClone(f.a),id:'other_agreement',client_id:second.id,enterprise_billing_receipt:null}];
  db.rpc=f.db.rpc;const stripe=makeStripe();
  await withCronSecret(()=>onTheFirst(async()=>{
    const res=await runCron(loadCron(db,stripe));assert.equal(res.status,503);assert.equal(res.body.ok,false);
    assert.equal(res.body.held_clients,2);assert.equal(res.body.invoiced,1);assert.equal(res.body.total_cents,7500);
    assert.equal(res.body.code,'enterprise_usage_invoice_executor_pending');assert.equal(stripe.calls.invoices.length,1);
    assert.equal(res.body.results.filter(r=>r.status==='invoiced').length,1);
    assert.deepEqual(res.body.results.filter(r=>r.http_status===503).map(r=>r.code).sort(),
      ['enterprise_usage_invoice_executor_pending','enterprise_usage_terms_unavailable']);
    assert.equal(db.tables.usage_billing_ledger.length,3);
  }));
});
test('other per-client 503 failures keep the old aggregate contract, not a pricing hold',async()=>{
  await withCronSecret(()=>onTheFirst(async()=>{
    const res=await runCron(loadCron(makeDb(),makeStripe(),{invoiceService:async()=>{
      throw Object.assign(Error('different local failure'),{status:503,code:'unrelated_service_unavailable'});}}));
    assert.equal(res.status,200);assert.equal(res.body.ok,true);assert.equal(res.body.held_clients,undefined);assert.equal(res.body.failed,1);
  }));
});
test('unauthorized usage caller does no census read or Stripe construction',async()=>{
  const db=makeDb();db.from=()=>assert.fail('unauthorized read');
  await withCronSecret(async()=>{
    const app=loadCron(db,makeStripe());const imports=watchStripeImport();assert.equal((await runCron(app,'wrong')).status,403);assert.equal(imports(),0);
  });
});
test('the cron uses the same secret shape as the other internal routes', () => {
  const source = fs.readFileSync(internalUsagePath, 'utf8');
  assert.match(source, /process\.env\.USAGE_BILLING_CRON_SECRET/);
  assert.match(source, /req\.get\('x-cron-secret'\)/);
  assert.match(source, /secretsMatch\(providedSecret, expectedSecret\)/,
    'the comparison must be the timing-safe one the other cron routes use');
  assert.match(source, /res\.status\(403\)\.json\(\{ error: 'forbidden' \}\)/);
});

// --- the admin route -------------------------------------------------------

function loadAdmin(db, stripe, { isChildClient = false, user = { id: ADMIN } } = {}) {
  for (const p of [adminBillingPath, usageBillingPath, supabasePath, stripeClientPath, checkoutPath, authPath, requireAdminPath, adminHelpersPath]) {
    delete require.cache[p];
  }
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });
  injectModule(stripeClientPath, stripe);
  injectModule(checkoutPath, { createSubscriptionCheckoutSession: async () => ({}) });
  injectModule(authPath, { requireAuth: (req, _res, next) => { req.user = user; next(); } });
  injectModule(requireAdminPath, { requireAdmin: (_req, _res, next) => next() });
  injectModule(adminHelpersPath, {
    rejectChildClientForAdminBilling: async (_req, res) => {
      if (!isChildClient) return true;
      res.status(403).json({ error: 'child_client_not_allowed' });
      return false;
    }
  });

  const app = express();
  app.use(express.json());
  app.use('/admin', require(adminBillingPath));
  return app;
}

const postUsageInvoice = (app, key, body = {}) => {
  const req = request(app).post(`/admin/clients/${CLIENT}/usage-invoice`);
  if (key) req.set('Idempotency-Key', key);
  return req.send(body);
};

test('an admin can raise a usage invoice on demand', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  const db = makeDb({ interviews: usedInterviews(3) });
  const stripe = makeStripe();
  const originalLog = console.log;
  console.log = () => {};
  let res;
  try {
    res = await postUsageInvoice(loadAdmin(db, stripe), 'usage-invoice-key-1');
  } finally {
    console.log = originalLog;
  }

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.total_cents, 7500);
  assert.equal(stripe.calls.invoices[0].metadata.reason, 'admin_request');
});

test('the Idempotency-Key header is required and must be well formed', async () => {
  const stripe = makeStripe();
  const app = loadAdmin(makeDb(), stripe);

  for (const key of [null, 'short', 'has spaces in it', 'x'.repeat(256)]) {
    const res = await postUsageInvoice(app, key);
    assert.equal(res.status, 400, `key ${JSON.stringify(key)} should be refused`);
    assert.equal(res.body.code, 'IDEMPOTENCY_KEY_REQUIRED');
  }
  assert.deepEqual(stripe.calls.invoices, [], 'a malformed key must not spend money');
});

test('reusing a key with the same body replays the first answer', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(NOW) });
  const db = makeDb({ interviews: usedInterviews(3) });
  const stripe = makeStripe();
  const originalLog = console.log;
  console.log = () => {};
  let first;
  let second;
  try {
    const app = loadAdmin(db, stripe);
    first = await postUsageInvoice(app, 'usage-invoice-key-2');
    second = await postUsageInvoice(app, 'usage-invoice-key-2');
  } finally {
    console.log = originalLog;
  }

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body, 'a double submit must return the first answer');
  assert.equal(stripe.calls.invoices.length, 1, 'and must not raise a second invoice');
});

test('nonempty bodies are refused before reserving a key or charging, and that key remains usable', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-05T12:00:00.000Z') });
  const db = makeDb({ interviews: [
    ...usedInterviews(3),
    { id: 'september_iv', client_id: CLIENT, role_id: 'role_1', status: 'completed', completed_at: '2026-09-15T00:00:00.000Z' }
  ] });
  const stripe = makeStripe();
  const originalLog = console.log;
  console.log = () => {};
  let second;
  try {
    const app = loadAdmin(db, stripe);
    for (const body of [{ period_end: '2026-08-01T00:00:00.000Z' }, { asOf: NOW }, { unexpected: true }]) {
      const rejected = await postUsageInvoice(app, 'usage-invoice-key-3', body);
      assert.equal(rejected.status, 400);
      assert.equal(rejected.body.code, 'PERIOD_NOT_SELECTABLE');
      assert.deepEqual(db.tables.billing_idempotency_keys, []);
      assert.deepEqual(stripe.calls.invoices, []);
    }
    second = await postUsageInvoice(app, 'usage-invoice-key-3', {});
  } finally {
    console.log = originalLog;
  }

  assert.equal(second.status, 200);
  assert.equal(second.body.period_start, '2026-09-01T00:00:00.000Z');
  assert.equal(second.body.period_end, '2026-10-01T00:00:00.000Z');
  assert.equal(second.body.total_cents, 2500);
  assert.deepEqual(db.tables.usage_billing_ledger.map(row => row.interview_id), ['september_iv']);
  assert.equal(stripe.calls.invoices.length, 1);
});

test('a key seen while the first call is still running is refused', async () => {
  const db = makeDb({
    interviews: usedInterviews(3),
    idempotency: [{
      actor_user_id: ADMIN,
      route_key: 'POST:/admin/clients/:id/usage-invoice',
      idempotency_key: 'usage-invoice-key-4',
      request_fingerprint: require('node:crypto')
        .createHash('sha256')
        .update(JSON.stringify({ client_id: CLIENT }))
        .digest('hex'),
      response_status: null,
      response_body: null
    }]
  });
  const stripe = makeStripe();

  const res = await postUsageInvoice(loadAdmin(db, stripe), 'usage-invoice-key-4');

  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'REQUEST_IN_PROGRESS');
  assert.deepEqual(stripe.calls.invoices, []);
});

test('a child client is refused', async () => {
  const stripe = makeStripe();
  const db = makeDb();
  const app = loadAdmin(db, stripe, { isChildClient: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await postUsageInvoice(app, 'usage-invoice-key-5');
    assert.equal(res.status, 403);
    assert.notEqual(res.body.code, 'REQUEST_IN_PROGRESS');
  }
  assert.deepEqual(db.tables.billing_idempotency_keys, []);
  assert.deepEqual(stripe.calls.invoices, []);
});

test('both new routes are registered with the auth they need', () => {
  const adminSource = fs.readFileSync(adminBillingPath, 'utf8');
  assert.match(adminSource, /router\.post\('\/clients\/:id\/usage-invoice', requireAuth, requireAdmin/);

  const internalIndex = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'internal', 'index.js'), 'utf8');
  assert.match(internalIndex, /require\('\.\/usageBilling'\)/, 'the cron route must be mounted');

  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'route-inventory.json'), 'utf8'));
  assert.ok(inventory.includes('POST /admin/clients/:id/usage-invoice'));
  assert.ok(inventory.includes('POST /internal/billing/usage-invoices'));
});

test('the idempotency migration mirrors the sales one', () => {
  const sql = fs.readFileSync(
    path.join(ROOT, 'supabase', 'migrations', '20261009150000_billing_idempotency_keys.sql'),
    'utf8'
  );

  assert.match(sql, /create table if not exists public\.billing_idempotency_keys/i);
  assert.match(sql, /primary key \(actor_user_id, route_key, idempotency_key\)/i,
    'the primary key is what makes a concurrent duplicate fail rather than run twice');
  assert.match(sql, /request_fingerprint text not null/i);
  assert.match(sql, /alter table public\.billing_idempotency_keys enable row level security/i);
  assert.match(sql, /revoke all privileges on table public\.billing_idempotency_keys\s*\n?from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.billing_idempotency_keys\s*\n?to service_role/i);
});
for(const partial of [false,true])test(`admin persists and replays distinct503 hold (${partial}) without provider calls`,async()=>{
  const f=await require('./helpers/accepted-enterprise-usage-fixture')();f.plan.billing_model='fixed';
  if(partial)f.a.enterprise_billing_receipt=null;
  let providerCalls=0;const stripe=new Proxy({}, {get(){providerCalls++;throw Error('provider touched');}});
  const app=loadAdmin(f.db,stripe),key='synthetic-enterprise-hold-key';
  const send=()=>request(app).post(`/admin/clients/${f.client.id}/usage-invoice`).set('Idempotency-Key',key).send({});
  const first=await send();assert.equal(first.status,503);
  assert.equal(first.body.code,partial?'enterprise_usage_terms_unavailable':'enterprise_usage_invoice_executor_pending');
  const saved=f.db.tables.billing_idempotency_keys[0];assert.equal(saved.response_status,503);assert.equal(saved.response_body.code,first.body.code);
  const replay=await send();assert.equal(replay.status,503);assert.equal(replay.body.code,first.body.code);
  assert.equal(providerCalls,0);assert.equal(f.db.calls.some(c=>c.table==='usage_billing_ledger'),false);
});
