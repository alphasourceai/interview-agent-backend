'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const supabaseClientPath = path.join(__dirname, '..', 'src', 'lib', 'supabaseClient.js');
require.cache[supabaseClientPath] = {
  id: supabaseClientPath,
  filename: supabaseClientPath,
  loaded: true,
  exports: { supabaseAdmin: {} },
};

const {
  assertOpportunityBoundary,
  ghlSalesConfiguration,
  importReadyGhlOpportunity,
  markGhlOpportunityWon,
  timingSafeSecret,
  verifyReadyGhlBinding,
  verifyGhlEd25519Signature,
} = require('../src/lib/ghlSalesIntegration');
const { authenticateWebhook, webhookIdentifiers } = require('../routes/ghlSalesWebhook');
const { agreementIsSignedAndPaid } = require('../src/lib/salesIntegrations');

const env = {
  GHL_PRIVATE_INTEGRATION_TOKEN: 'pit-' + 'x'.repeat(40),
  GHL_LOCATION_ID: 'location_qa',
  GHL_SALES_PIPELINE_ID: 'pipeline_qa',
  GHL_SALES_READY_STAGE_ID: 'stage_agreement_checkout',
  GHL_SALES_SYNC_ENABLED: 'true',
};

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

class Query {
  constructor(db, table) { this.db = db; this.table = table; this.filters = []; this.pending = null; }
  select() { return this; }
  eq(field, value) { this.filters.push([field, value]); return this; }
  limit() { return this; }
  insert(value) { this.pending = { type: 'insert', value }; return this; }
  update(value) { this.pending = { type: 'update', value }; return this; }
  rows() { return (this.db.tables[this.table] || []).filter((row) => this.filters.every(([key, value]) => row[key] === value)); }
  maybeSingle() { return Promise.resolve({ data: this.rows()[0] || null, error: null }); }
  single() {
    if (this.pending?.type === 'insert') {
      const row = { id: 'binding_qa_1', ...this.pending.value };
      this.db.tables[this.table].push(row);
      return Promise.resolve({ data: row, error: null });
    }
    if (this.pending?.type === 'update') {
      const row = this.rows()[0];
      if (row) Object.assign(row, this.pending.value);
      return Promise.resolve({ data: row || null, error: null });
    }
    return Promise.resolve({ data: this.rows()[0] || null, error: null });
  }
  then(resolve, reject) {
    try { resolve({ data: this.rows().map((row) => ({ ...row })), error: null }); } catch (error) { reject(error); }
  }
}

function inboundDb() {
  return {
    tables: {
      sales_team_members: [{ id: 'member_qa', sales_rep_user_id: '11111111-1111-4111-8111-111111111111', ghl_user_id: 'owner_qa', status: 'active' }],
      sales_reps: [{ user_id: '11111111-1111-4111-8111-111111111111', email: 'rep@example.com', display_name: 'QA Rep', active: true }],
      ghl_sales_deal_bindings: [],
    },
    from(table) { return new Query(this, table); },
  };
}

test('GHL configuration and boundary checks fail closed to the configured QA location, pipeline, and ready stage', () => {
  const config = ghlSalesConfiguration(env);
  assert.equal(config.configured, true);
  const opportunity = { id: 'opp_qa', locationId: 'location_qa', pipelineId: 'pipeline_qa', pipelineStageId: 'stage_agreement_checkout', status: 'open' };
  assert.deepEqual(assertOpportunityBoundary(opportunity, config, { requireReadyStage: true, rejectClosed: true }), {
    locationId: 'location_qa', pipelineId: 'pipeline_qa', stageId: 'stage_agreement_checkout', status: 'open',
  });
  assert.throws(() => assertOpportunityBoundary({ ...opportunity, locationId: 'location_prod' }, config), (error) => error.code === 'ghl_location_mismatch' && error.manualReview === true);
  assert.throws(() => assertOpportunityBoundary({ ...opportunity, pipelineStageId: 'stage_other' }, config, { requireReadyStage: true }), (error) => error.code === 'ghl_ready_stage_mismatch');
  assert.throws(() => assertOpportunityBoundary({ ...opportunity, status: '' }, config, { rejectClosed: true }), (error) => error.code === 'ghl_opportunity_not_open');
});

test('prefilled deal creation rechecks the live ready-stage opportunity and active owner mapping', async () => {
  const binding = {
    id: 'binding_qa', location_id: 'location_qa', pipeline_id: 'pipeline_qa', ready_stage_id: 'stage_agreement_checkout',
    opportunity_id: 'opp_qa', contact_id: 'contact_qa', provider_owner_user_id: 'owner_qa',
    sales_team_member_id: 'member_qa', sales_rep_user_id: '11111111-1111-4111-8111-111111111111',
    status: 'ready', purchase_intent_id: null, manual_review_required: false,
  };
  const db = inboundDb();
  const opportunity = { id: 'opp_qa', locationId: 'location_qa', pipelineId: 'pipeline_qa', pipelineStageId: 'stage_agreement_checkout', status: 'open', contactId: 'contact_qa', assignedTo: 'owner_qa' };
  const fetchFor = (current) => async (url) => {
    if (url.endsWith('/opportunities/opp_qa')) return response({ opportunity: current });
    if (url.endsWith('/users/owner_qa')) return response({ user: { id: 'owner_qa', roles: { type: 'account', role: 'user', locationIds: ['location_qa'] } } });
    throw new Error(`unexpected URL ${url}`);
  };
  await verifyReadyGhlBinding(binding, { db, env, fetchImpl: fetchFor(opportunity) });
  await assert.rejects(verifyReadyGhlBinding(binding, { db, env, fetchImpl: fetchFor({ ...opportunity, pipelineStageId: 'stage_other' }) }), (error) => error.code === 'ghl_ready_stage_mismatch');
  await assert.rejects(verifyReadyGhlBinding(binding, { db, env, fetchImpl: fetchFor({ ...opportunity, status: 'lost' }) }), (error) => error.code === 'ghl_opportunity_not_open');
  db.tables.sales_team_members[0].sales_rep_user_id = 'rep_changed';
  await assert.rejects(verifyReadyGhlBinding(binding, { db, env, fetchImpl: fetchFor(opportunity) }), (error) => error.code === 'sales_rep_inactive');
});

test('ready-stage import authoritatively fetches GHL records and maps exactly one active salesperson', async () => {
  const db = inboundDb();
  const calls = [];
  const result = await importReadyGhlOpportunity('opp_qa', {
    db,
    env,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.endsWith('/opportunities/opp_qa')) return response({ opportunity: { id: 'opp_qa', locationId: 'location_qa', pipelineId: 'pipeline_qa', pipelineStageId: 'stage_agreement_checkout', status: 'open', contactId: 'contact_qa', assignedTo: 'owner_qa', name: 'QA Opportunity' } });
      if (url.endsWith('/contacts/contact_qa')) return response({ contact: { id: 'contact_qa', companyName: 'QA Dental', firstName: 'Quinn', lastName: 'Tester', email: 'QUINN@example.com', phone: '+17205550100', title: 'Owner' } });
      if (url.endsWith('/users/owner_qa')) return response({ user: { id: 'owner_qa', roles: { type: 'account', role: 'user', locationIds: ['location_qa'] } } });
      throw new Error(`unexpected URL ${url}`);
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(result.binding.sales_rep_user_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(result.binding.contact_email, 'quinn@example.com');
  assert.equal(result.binding.status, 'ready');
  assert.equal(db.tables.ghl_sales_deal_bindings.length, 1);
});

test('replayed import cannot rewrite immutable salesperson attribution after an opportunity is linked', async () => {
  const db = inboundDb();
  db.tables.sales_team_members.push({ id: 'member_new', sales_rep_user_id: '44444444-4444-4444-8444-444444444444', ghl_user_id: 'owner_new', status: 'active' });
  db.tables.sales_reps.push({ user_id: '44444444-4444-4444-8444-444444444444', email: 'new@example.com', display_name: 'New Owner', active: true });
  db.tables.ghl_sales_deal_bindings.push({
    id: 'binding_linked', location_id: 'location_qa', opportunity_id: 'opp_qa', contact_id: 'contact_qa',
    pipeline_id: 'pipeline_qa', ready_stage_id: 'stage_agreement_checkout', provider_owner_user_id: 'owner_qa',
    sales_team_member_id: 'member_qa', sales_rep_user_id: '11111111-1111-4111-8111-111111111111',
    purchase_intent_id: '55555555-5555-4555-8555-555555555555', status: 'linked',
  });
  const result = await importReadyGhlOpportunity('opp_qa', {
    db, env,
    fetchImpl: async (url) => {
      if (url.endsWith('/opportunities/opp_qa')) return response({ opportunity: { id: 'opp_qa', locationId: 'location_qa', pipelineId: 'pipeline_qa', pipelineStageId: 'stage_agreement_checkout', status: 'open', contactId: 'contact_qa', assignedTo: 'owner_new', name: 'Renamed Opportunity' } });
      if (url.endsWith('/contacts/contact_qa')) return response({ contact: { id: 'contact_qa', companyName: 'Renamed Dental' } });
      if (url.endsWith('/users/owner_new')) return response({ user: { id: 'owner_new', roles: { type: 'account', role: 'user', locationIds: ['location_qa'] } } });
      throw new Error(`unexpected URL ${url}`);
    },
  });
  assert.equal(result.binding.provider_owner_user_id, 'owner_qa');
  assert.equal(result.binding.sales_rep_user_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(result.binding.purchase_intent_id, '55555555-5555-4555-8555-555555555555');
  assert.equal(result.binding.opportunity_name, 'Renamed Opportunity');
});

for (const [label, roles] of [
  ['Agency User', { type: 'agency', role: 'user', locationIds: ['location_qa'] }],
  ['Account Admin', { type: 'account', role: 'admin', locationIds: ['location_qa'] }],
  ['another location', { type: 'account', role: 'user', locationIds: ['location_other'] }],
  ['multiple locations', { type: 'account', role: 'user', locationIds: ['location_qa', 'location_other'] }],
  ['missing roles', undefined],
]) {
  test(`ready-stage import holds ${label} for manual review`, async () => {
    const db = inboundDb();
    await assert.rejects(importReadyGhlOpportunity('opp_qa', {
      db, env,
      fetchImpl: async (url) => {
        if (url.endsWith('/opportunities/opp_qa')) return response({ opportunity: { id: 'opp_qa', locationId: 'location_qa', pipelineId: 'pipeline_qa', pipelineStageId: 'stage_agreement_checkout', status: 'open', contactId: 'contact_qa', assignedTo: 'owner_qa' } });
        if (url.endsWith('/contacts/contact_qa')) return response({ contact: { id: 'contact_qa' } });
        if (url.endsWith('/users/owner_qa')) return response({ user: { id: 'owner_qa', roles } });
        throw new Error(`unexpected URL ${url}`);
      },
    }), (error) => error.code === 'ghl_owner_access_scope_invalid' && error.manualReview === true);
    assert.equal(db.tables.ghl_sales_deal_bindings.length, 1);
    assert.equal(db.tables.ghl_sales_deal_bindings[0].status, 'exception');
    assert.equal(db.tables.ghl_sales_deal_bindings[0].sales_rep_user_id, null);
    assert.equal(db.tables.ghl_sales_deal_bindings[0].manual_review_required, true);
  });
}

test('outbound Won update is idempotent and writes a stable alphaScreen activation note', async () => {
  const calls = [];
  const delivery = { id: '22222222-2222-4222-8222-222222222222' };
  const intent = {
    id: '33333333-3333-4333-8333-333333333333', client_id: 'client_qa', agreement_id: 'agreement_qa',
    ghl_opportunity_id: 'opp_qa', stripe_checkout_session_id: 'cs_test_qa', selected_plan_key: 'pro',
    selected_billing_cadence: 'annual', initial_payment_cents: 649900, promotion_discount_cents: 0,
    activated_at: '2026-09-22T18:00:00.000Z',
  };
  const binding = { id: 'binding_qa', location_id: 'location_qa', opportunity_id: 'opp_qa', contact_id: 'contact_qa', provider_owner_user_id: 'owner_qa' };
  const result = await markGhlOpportunityWon(delivery, { intent, binding, agreement: { checkout_session_id: 'cs_test_qa' } }, {
    env,
    fetchImpl: async (url, request) => {
      calls.push({ url, method: request.method, body: request.body ? JSON.parse(request.body) : null });
      if (url.endsWith('/opportunities/opp_qa') && request.method === 'GET') return response({ opportunity: { id: 'opp_qa', locationId: 'location_qa', pipelineId: 'pipeline_qa', pipelineStageId: 'stage_agreement_checkout', status: 'open', contactId: 'contact_qa', assignedTo: 'owner_qa' } });
      if (url.endsWith('/opportunities/opp_qa/status')) return response({ success: true });
      if (url.endsWith('/contacts/contact_qa/notes') && request.method === 'GET') return response({ notes: [] });
      if (url.endsWith('/contacts/contact_qa/notes') && request.method === 'POST') return response({ note: { id: 'note_qa' } });
      throw new Error(`unexpected URL ${url}`);
    },
  });
  assert.equal(result.noteId, 'note_qa');
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'PUT', 'GET', 'POST']);
  assert.deepEqual(calls[1].body, { status: 'won' });
  assert.match(calls[3].body.body, /alphaScreen activation synchronized/);
  assert.match(calls[3].body.body, /cs_test_qa/);
  assert.doesNotMatch(calls[3].body.body, /Bearer|pit-/);
});

test('outbound Won refuses to overwrite an opportunity moved or closed after import', async () => {
  const binding = { id: 'binding_qa', location_id: 'location_qa', opportunity_id: 'opp_qa', contact_id: 'contact_qa', provider_owner_user_id: 'owner_qa' };
  for (const change of [{ status: 'lost' }, { pipelineStageId: 'stage_other' }]) {
    const calls = [];
    await assert.rejects(markGhlOpportunityWon({ id: 'delivery_qa' }, {
      intent: { ghl_opportunity_id: 'opp_qa' }, binding, agreement: {}
    }, {
      env,
      fetchImpl: async (url, request) => {
        calls.push(request.method);
        return response({ opportunity: { id: 'opp_qa', locationId: 'location_qa', pipelineId: 'pipeline_qa', pipelineStageId: 'stage_agreement_checkout', status: 'open', contactId: 'contact_qa', assignedTo: 'owner_qa', ...change } });
      },
    }), (error) => ['ghl_opportunity_not_open', 'ghl_ready_stage_mismatch'].includes(error.code));
    assert.deepEqual(calls, ['GET']);
  }
});

test('duplicate Won delivery performs no provider mutation when status and idempotency note already exist', async () => {
  const delivery = { id: '22222222-2222-4222-8222-222222222222' };
  const methods = [];
  const result = await markGhlOpportunityWon(delivery, {
    intent: { id: '33333333-3333-4333-8333-333333333333', ghl_opportunity_id: 'opp_qa' },
    binding: { id: 'binding_qa', location_id: 'location_qa', opportunity_id: 'opp_qa', contact_id: 'contact_qa', provider_owner_user_id: 'owner_qa' },
    agreement: {},
  }, {
    env,
    fetchImpl: async (url, request) => {
      methods.push(request.method);
      if (url.endsWith('/opportunities/opp_qa')) return response({ opportunity: { id: 'opp_qa', locationId: 'location_qa', pipelineId: 'pipeline_qa', pipelineStageId: 'stage_agreement_checkout', status: 'won', contactId: 'contact_qa', assignedTo: 'owner_qa' } });
      return response({ notes: [{ id: 'note_existing', body: `[alphaScreen sync:${delivery.id}]` }] });
    },
  });
  assert.deepEqual(methods, ['GET', 'GET']);
  assert.deepEqual(result, { opportunityId: 'opp_qa', contactId: 'contact_qa', noteId: 'note_existing', noteCreated: false });
});

test('signed and paid gate rejects unsigned, unpaid, and timestamp-free agreement states', () => {
  assert.equal(agreementIsSignedAndPaid({ id: 'a', status: 'signed', checkout_status: 'paid', checkout_paid_at: '2026-09-22T18:00:00Z' }), true);
  assert.equal(agreementIsSignedAndPaid({ id: 'a', status: 'sent', checkout_status: 'paid', checkout_paid_at: '2026-09-22T18:00:00Z' }), false);
  assert.equal(agreementIsSignedAndPaid({ id: 'a', status: 'signed', checkout_status: 'pending_payment' }), false);
  assert.equal(agreementIsSignedAndPaid({ id: 'a', status: 'signed', checkout_status: 'paid' }), false);
});

test('webhook authentication requires the shared secret and validates current Ed25519 signatures when required', () => {
  const raw = Buffer.from(JSON.stringify({ opportunityId: 'opp_qa', locationId: 'location_qa' }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const signature = crypto.sign(null, raw, privateKey).toString('base64');
  assert.equal(verifyGhlEd25519Signature(raw, signature, publicDer), true);
  assert.equal(timingSafeSecret('shared-secret', 'shared-secret'), true);
  const req = { get(name) { return ({ authorization: 'Bearer shared-secret', 'x-ghl-signature': signature })[String(name).toLowerCase()] || ''; } };
  assert.deepEqual(authenticateWebhook(req, raw, { GHL_SALES_WEBHOOK_SECRET: 'shared-secret', GHL_WEBHOOK_PUBLIC_KEY: publicDer, GHL_WEBHOOK_REQUIRE_SIGNATURE: 'true' }), { ok: true });
  assert.deepEqual(authenticateWebhook(req, raw, { GHL_SALES_WEBHOOK_SECRET: 'shared-secret', GHL_WEBHOOK_PUBLIC_KEY: publicPem, GHL_WEBHOOK_REQUIRE_SIGNATURE: 'true' }), { ok: true });
  assert.equal(authenticateWebhook(req, Buffer.from('{}'), { GHL_SALES_WEBHOOK_SECRET: 'shared-secret', GHL_WEBHOOK_PUBLIC_KEY: publicDer, GHL_WEBHOOK_REQUIRE_SIGNATURE: 'true' }).code, 'invalid_signature');
});

test('webhook idempotency keys are fixed-length hashes and never contain provider IDs', () => {
  const identifiers = webhookIdentifiers({ opportunityId: 'opp_sensitive_123', locationId: 'location_sensitive_456', eventId: 'event-sensitive-789' });
  assert.match(identifiers.eventKey, /^ghl:[a-f0-9]{64}$/);
  assert.doesNotMatch(identifiers.eventKey, /sensitive|opp_|location_/);
});

test('GHL sales migration is service-only, idempotent, and uses an atomic binding claim', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261002032225_sales_prod_forward.sql'), 'utf8').toLowerCase();
  assert.match(sql, /create unique index if not exists ghl_sales_deal_bindings_opportunity_uidx/);
  assert.match(sql, /purchase_intent_id uuid unique/);
  assert.match(sql, /alter table public\.ghl_sales_deal_bindings enable row level security/);
  assert.match(sql, /revoke all on table public\.ghl_sales_deal_bindings from public, anon, authenticated/);
  assert.match(sql, /grant select, insert, update on table public\.ghl_sales_deal_bindings to service_role/);
  assert.match(sql, /create or replace function public\.claim_ghl_sales_binding/);
  assert.match(sql, /for update skip locked|update public\.ghl_sales_deal_bindings as binding/);
  assert.doesNotMatch(sql, /grant [^;]* to (?:anon|authenticated)/);
});
