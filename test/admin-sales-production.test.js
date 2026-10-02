'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSalesProductionOverview, createAdminSalesProductionRouter } = require('../routes/adminSalesProduction');

const line1 = '21000000-0000-4000-8000-000000000001';
const assignmentId = 'assignment-1';
const secret = 'Bearer do-not-return-this-token';

function fixture() {
  return {
    members: [{ id: 'member-1', sales_rep_user_id: 'rep-1', display_name: 'QA Rep', workspace_email: 'rep@example.invalid', ghl_user_id: 'ghl-1', slack_user_id: 'slack-1', status: 'active', secret }],
    reps: [{ user_id: 'rep-1', active: true }],
    phones: [{ id: line1, e164: '+17207904187', active: true, shared_voice_entrypoint: false, handoff_token_sha256: secret }],
    assignments: [{ id: assignmentId, team_member_id: 'member-1', phone_number_id: line1, status: 'active', handoff_token_sha256: secret }],
    configs: [{ assignment_id: assignmentId, status: 'applied', is_current: true, notify_email: true, notify_slack: true, notify_sms: false, secret }],
    bindings: [{ status: 'imported', manual_review_required: false, contact_email: secret }],
    deliveries: [{ integration: 'ghl', status: 'delivered', payload: secret }],
  };
}

test('admin sales overview shows fixed line readiness without secrets or customer data', () => {
  const payload = buildSalesProductionOverview(fixture(), {
    SALES_PRODUCTION_WRITES_ENABLED: 'true',
    GHL_SALES_SYNC_ENABLED: 'true',
    SALES_VOICE_DB_ROUTES_ENABLED: 'true',
    SALES_VOICE_HANDOFF_ENABLED: 'true',
  });
  assert.equal(payload.lines.length, 4);
  assert.equal(payload.lines[0].representative.name, 'QA Rep');
  assert.equal(payload.lines[0].voice_configuration.sms, false);
  assert.equal(payload.lines[1].assignment_status, 'unassigned');
  assert.equal(payload.ghl_sync.bindings_by_status.imported, 1);
  assert.equal(payload.settings.voice_routes_enabled, true);
  assert.equal(JSON.stringify(payload).includes(secret), false);
  assert.equal(JSON.stringify(payload).includes('contact_email'), false);
});

test('admin sales route returns generic error if production database is unavailable', async () => {
  const router = createAdminSalesProductionRouter({ db: { from() { return { select() { return { order() { return { range: async () => ({ data: null, error: { code: '42501' } }) }; } }; } }; } } });
  const route = router.stack.find((layer) => layer.route?.path === '/');
  assert.ok(route);
  const headers = {};
  const res = {
    statusCode: 200,
    setHeader(name, value) { headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  const previous = console.error;
  console.error = () => {};
  try {
    await route.route.stack[0].handle({}, res);
  } finally {
    console.error = previous;
  }
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'sales_admin_unavailable' });
});

test('admin sales route reads every page before reporting binding and delivery counts', async () => {
  const data = fixture();
  data.bindings = Array.from({ length: 501 }, (_, index) => ({ status: index === 500 ? 'failed' : 'imported', manual_review_required: index === 500 }));
  data.deliveries = Array.from({ length: 502 }, (_, index) => ({ integration: 'ghl', status: index >= 500 ? 'failed' : 'delivered' }));
  const db = { from(table) { return { select() { return { order() { return { range: async (from, to) => ({ data: data[{ sales_team_members: 'members', sales_reps: 'reps', sales_phone_numbers: 'phones', sales_phone_assignments: 'assignments', sales_voice_configs: 'configs', ghl_sales_deal_bindings: 'bindings', sales_integration_deliveries: 'deliveries' }[table]].slice(from, to + 1), count: data[{ sales_team_members: 'members', sales_reps: 'reps', sales_phone_numbers: 'phones', sales_phone_assignments: 'assignments', sales_voice_configs: 'configs', ghl_sales_deal_bindings: 'bindings', sales_integration_deliveries: 'deliveries' }[table]].length, error: null }) }; } }; } }; } };
  const router = createAdminSalesProductionRouter({ db });
  const route = router.stack.find((layer) => layer.route?.path === '/');
  const res = { setHeader() {}, json(value) { this.body = value; return this; } };
  await route.route.stack[0].handle({}, res);
  assert.equal(res.body.ghl_sync.bindings_by_status.failed, 1);
  assert.equal(res.body.ghl_sync.deliveries_by_status.failed, 2);
  assert.equal(res.body.ghl_sync.manual_review_count, 1);
});
