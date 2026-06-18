'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  buildAdminMetricsPayload,
  normalizeEmailEvent,
} = require('../src/lib/adminMetricsService');

const TABLE_NAMES = [
  'clients',
  'roles',
  'candidates',
  'interviews',
  'reports',
  'interview_perception_events',
  'email_delivery_events',
  'automation_rules',
  'automation_evaluations',
  'automation_actions',
  'automation_digest_deliveries',
  'automation_action_approval_tokens',
  'automation_digest_approval_tokens',
  'client_members',
];

function emptyTables() {
  return Object.fromEntries(TABLE_NAMES.map((name) => [name, []]));
}

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.ranges = [];
    this.orderField = null;
    this.ascending = false;
    this.limitCount = null;
  }

  select(columns) {
    this.db.selects.push({ table: this.table, columns: String(columns || '') });
    return this;
  }

  eq(column, value) {
    this.filters.push({ type: 'eq', column, value: String(value) });
    return this;
  }

  in(column, values) {
    this.filters.push({ type: 'in', column, values: new Set((values || []).map(String)) });
    return this;
  }

  gte(column, value) {
    this.ranges.push({ type: 'gte', column, value: new Date(value).getTime() });
    return this;
  }

  lte(column, value) {
    this.ranges.push({ type: 'lte', column, value: new Date(value).getTime() });
    return this;
  }

  order(column, options = {}) {
    this.orderField = column;
    this.ascending = options.ascending === true;
    return this;
  }

  limit(count) {
    this.limitCount = count;
    return this;
  }

  execute() {
    let rows = (this.db.tables[this.table] || []).map((row) => ({ ...row }));
    for (const filter of this.filters) {
      if (filter.type === 'eq') {
        rows = rows.filter((row) => String(row[filter.column] || '') === filter.value);
      } else if (filter.type === 'in') {
        rows = rows.filter((row) => filter.values.has(String(row[filter.column] || '')));
      }
    }
    for (const range of this.ranges) {
      rows = rows.filter((row) => {
        const value = new Date(row[range.column] || '').getTime();
        if (!Number.isFinite(value)) return false;
        return range.type === 'gte' ? value >= range.value : value <= range.value;
      });
    }
    if (this.orderField) {
      rows.sort((a, b) => {
        const left = String(a[this.orderField] || '');
        const right = String(b[this.orderField] || '');
        return this.ascending ? left.localeCompare(right) : right.localeCompare(left);
      });
    }
    if (this.limitCount) rows = rows.slice(0, this.limitCount);
    return { data: rows, error: null };
  }

  then(resolve, reject) {
    try {
      resolve(this.execute());
    } catch (error) {
      reject(error);
    }
  }
}

function makeDb(tables = emptyTables()) {
  return {
    tables,
    selects: [],
    from(table) {
      return new FakeQuery(this, table);
    },
  };
}

test('GET /admin/metrics route is registered behind admin auth', () => {
  const appPath = path.resolve(__dirname, '../app.js');
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(source, /adminRouter\.get\('\/metrics', requireAuth, requireAdmin/);
});

test('admin metrics returns zeros and empty lists for empty data', async () => {
  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: {},
    requestId: 'req-empty',
    now: new Date('2026-06-18T12:00:00.000Z'),
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.request_id, 'req-empty');
  assert.deepEqual(payload.overview, {
    active_clients: 0,
    active_roles: 0,
    candidates_in_range: 0,
    interviews_started: 0,
    interviews_completed: 0,
    reports_generated: 0,
    automation_pending_approvals: 0,
    email_delivery_failures: 0,
  });
  assert.deepEqual(payload.attention.items, []);
  assert.equal(payload.email.normalized_counts.problem, 0);
  assert.equal(payload.health_summary.find((item) => item.key === 'interview_pipeline')?.status, 'unknown');
  assert.equal(payload.health_summary.find((item) => item.key === 'error_monitoring')?.status, 'not_configured');
  assert.equal(payload.vendor_usage.services.find((service) => service.key === 'openai')?.status, 'unknown');
  assert.equal(payload.vendor_usage.services.find((service) => service.key === 'render')?.status, 'not_configured');
});

test('admin metrics applies date range filters to range-bound sources', async () => {
  const tables = emptyTables();
  tables.clients.push({ id: 'client-1', name: 'Espire Dental', parent_client_id: null, archived_at: null });
  tables.roles.push({ id: 'role-1', client_id: 'client-1', title: 'Dental Assistant', status: 'active', created_at: '2026-05-01T00:00:00.000Z' });
  tables.candidates.push(
    { id: 'candidate-in', client_id: 'client-1', role_id: 'role-1', name: 'In Range', created_at: '2026-06-10T10:00:00.000Z' },
    { id: 'candidate-out', client_id: 'client-1', role_id: 'role-1', name: 'Out Range', created_at: '2026-04-10T10:00:00.000Z' },
  );
  tables.interviews.push(
    { id: 'interview-in', client_id: 'client-1', role_id: 'role-1', candidate_id: 'candidate-in', created_at: '2026-06-10T11:00:00.000Z', updated_at: '2026-06-10T12:00:00.000Z', status: 'completed', transcript: 'ready', recording_status: 'ready', recording_ready_at: '2026-06-10T12:10:00.000Z' },
    { id: 'interview-out', client_id: 'client-1', role_id: 'role-1', candidate_id: 'candidate-out', created_at: '2026-04-10T11:00:00.000Z', updated_at: '2026-04-10T12:00:00.000Z', status: 'completed' },
  );
  tables.reports.push(
    { id: 'report-in', client_id: 'client-1', role_id: 'role-1', candidate_id: 'candidate-in', created_at: '2026-06-10T12:20:00.000Z' },
    { id: 'report-out', client_id: 'client-1', role_id: 'role-1', candidate_id: 'candidate-out', created_at: '2026-04-10T12:20:00.000Z' },
  );
  tables.email_delivery_events.push(
    { id: 'email-in', created_at: '2026-06-11T00:00:00.000Z', event_type: 'bounce', is_problem: true },
    { id: 'email-out', created_at: '2026-04-11T00:00:00.000Z', event_type: 'bounce', is_problem: true },
  );

  const db = makeDb(tables);
  const payload = await buildAdminMetricsPayload({
    db,
    query: { client_id: 'client-1', date_from: '2026-06-01', date_to: '2026-06-30' },
    now: new Date('2026-06-18T12:00:00.000Z'),
  });

  assert.equal(payload.overview.active_clients, 1);
  assert.equal(payload.overview.candidates_in_range, 1);
  assert.equal(payload.overview.interviews_started, 1);
  assert.equal(payload.overview.interviews_completed, 1);
  assert.equal(payload.overview.reports_generated, 1);
  assert.equal(payload.overview.email_delivery_failures, 1);
  assert.equal(payload.interview_funnel.find((row) => row.key === 'recording_ready').count, 1);
  const interviewSelect = db.selects?.find((entry) => entry.table === 'interviews')?.columns || '';
  assert.doesNotMatch(interviewSelect, /completed_at|interview_status/);
  assert.match(interviewSelect, /\bstatus\b/);
});

test('admin metrics response and selects do not expose raw token or webhook fields', async () => {
  const tables = emptyTables();
  tables.clients.push({ id: 'client-1', name: 'Espire Dental', parent_client_id: null, archived_at: null });
  tables.automation_action_approval_tokens.push({
    id: 'token-1',
    client_id: 'client-1',
    action_id: 'action-1',
    state: 'active',
    token_hash: 'super-secret-token-hash',
    recipient_email: 'reviewer@example.com',
    expires_at: '2026-06-20T00:00:00.000Z',
    created_at: '2026-06-12T00:00:00.000Z',
  });
  tables.automation_digest_approval_tokens.push({
    id: 'digest-token-1',
    client_id: 'client-1',
    delivery_id: 'delivery-1',
    state: 'expired',
    token_hash: 'super-secret-digest-token-hash',
    recipient_email: 'digest@example.com',
    item_salt: 'secret-salt',
    expires_at: '2026-06-10T00:00:00.000Z',
    created_at: '2026-06-09T00:00:00.000Z',
  });
  tables.email_delivery_events.push({
    id: 'email-1',
    created_at: '2026-06-12T00:00:00.000Z',
    event_type: 'bounce',
    is_problem: true,
    reason: 'Failed for person@example.com at https://example.test/review?token=raw',
    raw_payload: 'raw-sendgrid-payload',
  });

  const db = makeDb(tables);
  const payload = await buildAdminMetricsPayload({
    db,
    query: { client_id: 'client-1', date_from: '2026-06-01', date_to: '2026-06-30' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      OPENAI_API_KEY: 'sk-test-secret',
      TAVUS_API_KEY: 'tavus-secret',
      SENDGRID_API_KEY: 'sendgrid-secret',
      SUPABASE_SERVICE_ROLE_KEY: 'supabase-secret',
      SUPABASE_URL: 'https://example.supabase.co',
      AUTOMATION_DIGEST_RUNNER_SECRET: 'scheduler-secret',
      SENTRY_DSN: 'sentry-secret',
      SENTRY_ENABLED: '1',
    },
  });
  const serialized = JSON.stringify(payload);
  const actionTokenSelect = db.selects.find((entry) => entry.table === 'automation_action_approval_tokens')?.columns || '';
  const digestTokenSelect = db.selects.find((entry) => entry.table === 'automation_digest_approval_tokens')?.columns || '';
  const emailSelect = db.selects.find((entry) => entry.table === 'email_delivery_events')?.columns || '';

  assert.equal(payload.automation.approval_links.active, 1);
  assert.equal(payload.automation.approval_links.expired, 1);
  assert.doesNotMatch(actionTokenSelect, /token_hash|recipient_email/i);
  assert.doesNotMatch(digestTokenSelect, /token_hash|item_salt|recipient_email/i);
  assert.doesNotMatch(emailSelect, /raw_payload/i);
  assert.doesNotMatch(serialized, /super-secret|raw-sendgrid-payload|reviewer@example\.com|digest@example\.com|person@example\.com|https:\/\/example\.test|sk-test-secret|tavus-secret|sendgrid-secret|supabase-secret|scheduler-secret|sentry-secret/i);
  assert.equal(payload.vendor_usage.services.find((service) => service.key === 'openai')?.configured, true);
  assert.equal(payload.vendor_usage.services.find((service) => service.key === 'tavus')?.source, 'database_estimate');
  assert.equal(payload.vendor_usage.services.find((service) => service.key === 'sentry')?.status, 'unknown');
});

test('admin metrics vendor usage returns expected services and DB-backed usage fields', async () => {
  const tables = emptyTables();
  tables.clients.push({ id: 'client-1', name: 'Espire Dental', parent_client_id: null, archived_at: null });
  tables.roles.push({ id: 'role-1', client_id: 'client-1', title: 'Dental Assistant', status: 'active', created_at: '2026-06-01T00:00:00.000Z' });
  tables.candidates.push({ id: 'candidate-1', client_id: 'client-1', role_id: 'role-1', name: 'Candidate One', created_at: '2026-06-10T10:00:00.000Z' });
  tables.interviews.push({
    id: 'interview-1',
    client_id: 'client-1',
    role_id: 'role-1',
    candidate_id: 'candidate-1',
    created_at: '2026-06-10T11:00:00.000Z',
    updated_at: '2026-06-10T12:00:00.000Z',
    status: 'Analyzed',
    transcript: 'ready',
    recording_status: 'ready',
    recording_ready_at: '2026-06-10T12:10:00.000Z',
    recording_metadata: { duration_seconds: 600 },
  });
  tables.reports.push({ id: 'report-1', client_id: 'client-1', role_id: 'role-1', candidate_id: 'candidate-1', created_at: '2026-06-10T12:20:00.000Z' });
  tables.email_delivery_events.push({ id: 'email-1', created_at: '2026-06-11T00:00:00.000Z', event_type: 'delivered' });

  const payload = await buildAdminMetricsPayload({
    db: makeDb(tables),
    query: { client_id: 'client-1', date_from: '2026-06-01', date_to: '2026-06-30' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {},
  });

  const services = payload.vendor_usage.services.map((service) => service.key);
  assert.deepEqual(services, ['openai', 'tavus', 'supabase', 'sendgrid', 'render', 'sentry']);
  assert.equal(payload.health_summary.length, 8);
  assert.equal(payload.vendor_usage.services.find((service) => service.key === 'openai')?.current_period.reports_generated, 1);
  assert.equal(payload.vendor_usage.services.find((service) => service.key === 'tavus')?.current_period.estimated_minutes, 10);
  assert.equal(payload.vendor_usage.services.find((service) => service.key === 'sendgrid')?.current_period.sent_delivered, 1);
  assert.equal(payload.vendor_usage.services.find((service) => service.key === 'render')?.status, 'not_configured');
});

test('email event taxonomy normalizes delivery, engagement, problem, and unknown events', () => {
  assert.equal(normalizeEmailEvent({ event_type: 'delivered' }), 'sent_delivered');
  assert.equal(normalizeEmailEvent({ event_type: 'click' }), 'engagement');
  assert.equal(normalizeEmailEvent({ event_type: 'dropped' }), 'problem');
  assert.equal(normalizeEmailEvent({ event_type: 'custom_event' }), 'unknown');
});
