'use strict';

// The frontend contract has to stay true to the responses.
//
// docs/billing-frontend-contract.md is what the client's frontend developer
// builds against, so a field renamed here and not there is a broken screen they
// find out about in production. Each field table in the document is tagged with
// a marker naming the endpoint and the object it describes; this test drives the
// real routes against a stubbed database and asserts the documented field names
// are exactly the keys that come back.
//
// Endpoints that spend money — the portal and top-up checkout sessions — are not
// driven here; their responses are asserted against the literal object the route
// returns instead, which is the next best thing without stubbing Stripe.
//
// Supabase and auth are stubbed; no database, no network.

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const request = require('supertest');

const { createFakeSupabase } = require('./helpers/fakeSupabase');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'billing-frontend-contract.md');
const doc = fs.readFileSync(DOC, 'utf8');

const clientBillingPath = path.join(ROOT, 'src', 'routes', 'client', 'billing.js');
const adminBillingPath = path.join(ROOT, 'src', 'routes', 'admin', 'billing.js');
const availabilityPath = path.join(ROOT, 'src', 'services', 'roleInterviewAvailability.js');
const supabasePath = path.join(ROOT, 'src', 'clients', 'supabase.js');
const sendgridPath = path.join(ROOT, 'src', 'clients', 'sendgrid.js');
const stripeClientPath = path.join(ROOT, 'src', 'clients', 'stripe.js');
const checkoutPath = path.join(ROOT, 'src', 'services', 'subscriptionCheckout.js');
const authPath = path.join(ROOT, 'src', 'middleware', 'auth.js');
const requireAdminPath = path.join(ROOT, 'src', 'middleware', 'requireAdmin.js');
const adminHelpersPath = path.join(ROOT, 'src', 'services', 'admin', 'adminHelpers.js');
const clientScopePath = path.join(ROOT, 'src', 'services', 'clientScope.js');

function injectModule(filename, exports) {
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

injectModule(sendgridPath, {
  sendSubscriptionCheckoutEmail: async () => ({ ok: true }),
  sendRoleInterviewLimitReachedEmail: async () => ({ ok: true }),
  buildBrandedEmailShell: () => '',
  escapeHtml: (value) => String(value)
});

/**
 * The field names in the table that follows `<!-- fields: <name> -->`.
 *
 * A table row is `| \`field\` | type | null? | meaning |`, so the first cell of
 * each row after the header and separator is the field name.
 */
function documentedFields(marker) {
  const at = doc.indexOf(`<!-- fields: ${marker} -->`);
  assert.notEqual(at, -1, `the document has no field table for ${marker}`);
  const rest = doc.slice(at);
  const rows = [];
  for (const line of rest.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (rows.length) break;
      continue;
    }
    const first = trimmed.split('|')[1]?.trim() || '';
    const name = first.replace(/`/g, '');
    if (!name || name === 'Field' || /^-+$/.test(name)) continue;
    rows.push(name);
  }
  assert.ok(rows.length, `the field table for ${marker} is empty`);
  return rows.sort();
}

function keysOf(value) {
  assert.ok(value && typeof value === 'object', 'expected an object to compare against');
  return Object.keys(value).sort();
}

const MINE = 'client_1';

function usedInterviews(count, { roleId = 'role_1', prefix = 'iv', from = '2026-08-01T00:00:00.000Z' } = {}) {
  const start = new Date(from).getTime();
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}_${i + 1}`,
    client_id: MINE,
    role_id: roleId,
    status: 'completed',
    completed_at: new Date(start + i * 3600000).toISOString(),
    updated_at: new Date(start + i * 3600000).toISOString()
  }));
}

// One Enterprise client with everything populated, so no documented field is
// missing merely because the fixture had nothing to put in it.
function makeDb() {
  return createFakeSupabase({
    clients: [{
      id: MINE, parent_client_id: null, name: 'Acme Dental Group',
      plan_tier: 'enterprise', billing_status: 'active', billing_interval: 'monthly',
      auto_renew: true, current_term_end: '2027-01-01T00:00:00.000Z',
      contract_end_at: '2027-01-01T00:00:00.000Z', subscription_status: 'active',
      cancel_at_term_end: false, access_override_mode: null, stripe_customer_id: 'cus_1'
    }],
    client_plan_settings: [{
      client_id: MINE, plan_tier: 'enterprise', billing_model: 'usage',
      billing_interval: 'monthly', platform_fee: 1200, per_role_fee: 0,
      included_interviews_per_role: 1, additional_interview_fee: 0,
      usage_interview_fee_cents: 2500, rollover_days: 90,
      updated_at: '2026-09-01T00:00:00.000Z'
    }],
    roles: [{ id: 'role_1', client_id: MINE, title: 'Hygienist', status: 'active' }],
    interviews: usedInterviews(6),
    interview_credits: [{
      id: 'credit_1', client_id: MINE, source_role_id: 'role_1', quantity: 3,
      remaining: 3, minted_at: '2026-08-01T00:00:00.000Z',
      expires_at: '2026-12-01T00:00:00.000Z', revoked_at: null
    }],
    interview_credit_draws: [],
    client_interview_pools: [{
      id: 'pool_1', client_id: MINE, quantity_purchased: 2, status: 'paid',
      created_at: '2026-07-01T00:00:00.000Z', paid_at: '2026-07-01T00:00:00.000Z'
    }],
    usage_billing_ledger: [{
      client_id: MINE, role_id: 'role_1', interview_id: 'iv_1', unit_price_cents: 2500,
      stripe_invoice_id: 'in_1', stripe_invoice_item_id: 'ii_1',
      billed_at: '2026-09-01T00:00:00.000Z',
      period_start: '2026-08-01T00:00:00.000Z', period_end: '2026-09-01T00:00:00.000Z'
    }]
  });
}

function loadClientApp(db) {
  for (const p of [clientBillingPath, supabasePath, authPath, clientScopePath]) delete require.cache[p];
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });
  injectModule(authPath, {
    requireAuth: (req, _res, next) => { req.user = { id: 'user_1' }; next(); },
    withClientScope: (req, _res, next) => {
      req.client_memberships = [MINE];
      req.clientScope = { memberships: [MINE] };
      next();
    }
  });
  injectModule(clientScopePath, { canViewLegalBillingForClient: () => true });

  const app = express();
  app.use(express.json());
  app.use('/', require(clientBillingPath));
  return app;
}

function loadAdminApp(db) {
  for (const p of [adminBillingPath, supabasePath, stripeClientPath, checkoutPath, authPath, requireAdminPath, adminHelpersPath]) {
    delete require.cache[p];
  }
  injectModule(supabasePath, { supabaseAdmin: db, supabase: db, supabaseAnon: db });
  injectModule(stripeClientPath, {});
  injectModule(checkoutPath, { createSubscriptionCheckoutSession: async () => ({}) });
  injectModule(authPath, { requireAuth: (req, _res, next) => { req.user = { id: 'admin_1' }; next(); } });
  injectModule(requireAdminPath, { requireAdmin: (_req, _res, next) => next() });
  injectModule(adminHelpersPath, { rejectChildClientForAdminBilling: async () => true });

  const app = express();
  app.use(express.json());
  app.use('/admin', require(adminBillingPath));
  return app;
}

// --- the client endpoints --------------------------------------------------

test('the billing summary items are documented exactly', async () => {
  const res = await request(loadClientApp(makeDb())).get('/clients/billing/summary');

  assert.equal(res.status, 200);
  assert.ok(res.body.items.length, 'the fixture must produce an item to compare');
  assert.deepEqual(keysOf(res.body.items[0]), documentedFields('GET /clients/billing/summary items[]'));
});

test('the credits response and its items are documented exactly', async () => {
  const res = await request(loadClientApp(makeDb())).get('/clients/billing/credits');

  assert.equal(res.status, 200);
  assert.deepEqual(keysOf(res.body), documentedFields('GET /clients/billing/credits'));
  assert.ok(res.body.items.length, 'the fixture must produce a credit to compare');
  assert.deepEqual(keysOf(res.body.items[0]), documentedFields('GET /clients/billing/credits items[]'));
});

test('the usage response, its lines and its history are documented exactly', async () => {
  const res = await request(loadClientApp(makeDb())).get('/clients/billing/usage');

  assert.equal(res.status, 200);
  assert.deepEqual(keysOf(res.body), documentedFields('GET /clients/billing/usage'));
  assert.ok(res.body.lines.length, 'the fixture must produce a usage line to compare');
  assert.deepEqual(keysOf(res.body.lines[0]), documentedFields('GET /clients/billing/usage lines[]'));
  assert.ok(res.body.billed_invoices.length, 'the fixture must produce a billed invoice to compare');
  assert.deepEqual(
    keysOf(res.body.billed_invoices[0]),
    documentedFields('GET /clients/billing/usage billed_invoices[]')
  );
});

test('the pool response and its blocks are documented exactly', async () => {
  const res = await request(loadClientApp(makeDb())).get('/clients/billing/pool');

  assert.equal(res.status, 200);
  assert.deepEqual(keysOf(res.body), documentedFields('GET /clients/billing/pool'));
  assert.ok(res.body.items.length, 'the fixture must produce a pool block to compare');
  assert.deepEqual(keysOf(res.body.items[0]), documentedFields('GET /clients/billing/pool items[]'));
});

test('the role availability fields are documented exactly', async () => {
  delete require.cache[availabilityPath];
  const { getRoleInterviewAvailability } = require(availabilityPath);

  const availability = await getRoleInterviewAvailability({
    db: makeDb(), roleId: 'role_1', clientId: MINE
  });

  // The roles route exposes a subset of the service's shape; the contract
  // documents what GET /roles returns, so that subset is what is compared.
  const documented = documentedFields('GET /roles availability');
  for (const field of documented) {
    assert.ok(field in availability, `${field} is documented but not returned`);
  }
  const rolesSource = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'client', 'roles.js'), 'utf8');
  for (const field of documented) {
    assert.match(rolesSource, new RegExp(`${field}: availability\\?\\.${field}`),
      `${field} is documented but GET /roles does not expose it`);
  }
});

// --- the admin endpoint ----------------------------------------------------

test('the admin role availability fields are documented exactly', async () => {
  delete require.cache[availabilityPath];
  const { getRoleInterviewAvailability } = require(availabilityPath);

  const availability = await getRoleInterviewAvailability({
    db: makeDb(), roleId: 'role_1', clientId: MINE
  });

  // GET /admin/roles exposes a subset of the service's shape, as GET /roles
  // does; the contract documents what the route returns, so that is what is
  // compared. test/billing-admin-roles-allocation.test.js drives the real route
  // and asserts the same eight fields are on every item.
  const documented = documentedFields('GET /admin/roles availability');
  const rolesSource = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'admin', 'roles.js'), 'utf8');
  for (const field of documented) {
    assert.ok(field in availability, field + ' is documented but not returned');
    assert.match(rolesSource, new RegExp(field + ': availability\\?\\.' + field),
      field + ' is documented but GET /admin/roles does not expose it');
  }
});

test('the admin roles list reports everything the client list does', () => {
  // Parity is the point: an administrator answering "why can this role not
  // start an interview" must not be looking at fewer figures than the client.
  const client = documentedFields('GET /roles availability');
  const admin = documentedFields('GET /admin/roles availability');

  for (const field of client) {
    assert.ok(admin.includes(field), field + ' is on the client list but not the admin one');
  }
});

test('the admin roles fallback lists every field, so a failed lookup is not a partial row', () => {
  const rolesSource = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'admin', 'roles.js'), 'utf8');
  const fallback = rolesSource.slice(
    rolesSource.indexOf('const availabilityFallback'),
    rolesSource.indexOf('const allocationByBillingClientId')
  );

  for (const field of documentedFields('GET /admin/roles availability')) {
    assert.ok(fallback.includes(field + ': null'),
      field + ' must be null in the fallback, not absent');
  }
});

test('the admin roles list allocates once per billing owner', () => {
  const rolesSource = fs.readFileSync(path.join(ROOT, 'src', 'routes', 'admin', 'roles.js'), 'utf8');

  assert.match(rolesSource, /allocationByBillingClientId/,
    'an admin list spans clients, so the allocation is cached per payer');
  assert.match(rolesSource, /getRoleInterviewAvailability\(\{[\s\S]{0,160}?allocation\s*\}\)/,
    'and handed to each role rather than recomputed');
});


test('the admin billing summary and its role rows are documented exactly', async () => {
  const res = await request(loadAdminApp(makeDb())).get(`/admin/clients/${MINE}/billing-summary`);

  assert.equal(res.status, 200);
  assert.deepEqual(keysOf(res.body), documentedFields('GET /admin/clients/:id/billing-summary'));
  assert.ok(res.body.roles.length, 'the fixture must produce a role row to compare');
  assert.deepEqual(
    keysOf(res.body.roles[0]),
    documentedFields('GET /admin/clients/:id/billing-summary roles[]')
  );
});

test('the plan settings columns named in the document are the ones selected', () => {
  const adminSource = fs.readFileSync(adminBillingPath, 'utf8');
  for (const column of [
    'plan_tier', 'billing_model', 'billing_interval', 'platform_fee', 'per_role_fee',
    'included_interviews_per_role', 'additional_interview_fee', 'usage_interview_fee_cents',
    'rollover_days', 'updated_at'
  ]) {
    assert.match(doc, new RegExp(`\`${column}\``), `${column} must be documented`);
    assert.ok(adminSource.includes(column), `${column} is documented but not selected`);
  }
});

// --- the endpoints that spend money ---------------------------------------

test('the money-spending responses are documented exactly', () => {
  const source = fs.readFileSync(clientBillingPath, 'utf8');

  // Asserted against the literal the route returns rather than a live call, so
  // that no test here can create a Stripe session.
  assert.match(source, /return res\.json\(\{ ok: true, url: session\.url \}\)/);
  assert.match(doc, /\| `url` \| string \| no \| Verified short-lived Stripe portal URL\./);
  assert.deepEqual(
    documentedFields('POST /clients/billing/portal-session'),
    ['ok', 'url'].sort()
  );

  const topUp = source.slice(source.indexOf('role_interview_purchase_id'));
  for (const field of documentedFields('POST /clients/billing/additional-interviews/checkout-session')) {
    assert.ok(
      new RegExp(`\\b${field}:`).test(topUp) || field === 'ok',
      `${field} is documented but the top-up response does not set it`
    );
  }
});

// --- the things a reader will act on --------------------------------------

test('the document warns that remaining_interviews is null under usage', () => {
  assert.match(doc, /`remaining_interviews` is null for `usage` clients/,
    'a frontend that reads null as zero will tell an Enterprise client they are out of interviews');
});

test('the document states that the dashboard figure is live and the invoice is the prior month', () => {
  assert.match(doc, /unbilled usage is live/i);
  assert.match(doc, /calendar month that has ended/i);
});

test('every error code in the document exists in the routes', () => {
  const sources = [clientBillingPath, adminBillingPath]
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n')
    + fs.readFileSync(path.join(ROOT, 'src', 'routes', 'public', 'membershipAgreements', 'checkout.js'), 'utf8');

  const section = doc.slice(doc.indexOf('## Error codes'), doc.indexOf('## Example responses'));
  // Table rows only: the prose around them names `error`, `code` and `detail`,
  // which are the envelope rather than codes to look for.
  const codes = new Set();
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    for (const match of line.matchAll(/`([a-z_]{6,}|[A-Z_]{6,})`/g)) codes.add(match[1]);
  }

  for (const code of codes) {
    assert.ok(sources.includes(`'${code}'`) || sources.includes(`"${code}"`),
      `the document lists the error ${code}, which no route returns`);
  }
});

test('the three billing models are each given an example response', () => {
  for (const heading of ['Essentials — `fixed`', 'Pro — `rollover`', 'Enterprise — `usage`']) {
    assert.ok(doc.includes(heading), `${heading} must have an example`);
  }
});
