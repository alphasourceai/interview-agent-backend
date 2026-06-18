'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  buildAdminMetricsPayload,
  normalizeEmailEvent,
} = require('../src/lib/adminMetricsService');
const { buildOpenAIHealth } = require('../src/lib/platformHealth/openaiHealth');

const PLATFORM_HEALTH_FILES = [
  'index.js',
  'openaiHealth.js',
  'tavusHealth.js',
  'supabaseHealth.js',
  'sendgridHealth.js',
  'renderHealth.js',
  'sentryHealth.js',
  'awsS3Health.js',
  'stripeHealth.js',
  'normalizePlatformHealth.js',
];

const TABLE_NAMES = [
  'clients',
  'roles',
  'candidates',
  'interviews',
  'reports',
  'interview_perception_events',
  'email_delivery_events',
  'automation_action_approval_tokens',
  'automation_digest_approval_tokens',
  'contract_cancellation_runs',
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

function serviceByKey(payload, key) {
  return (payload.services || []).find((service) => service.key === key) || null;
}

function openAIHealthContext(overrides = {}) {
  const now = new Date('2026-06-18T12:00:00.000Z');
  return {
    now,
    env: {
      OPENAI_ADMIN_KEY: 'sk-admin-secret',
      OPENAI_USAGE_ENABLED: 'true',
    },
    dateRange: {
      from: new Date('2026-06-11T12:00:00.000Z'),
      to: now,
      date_from: '2026-06-11T12:00:00.000Z',
      date_to: '2026-06-18T12:00:00.000Z',
    },
    signals: {
      missingReports: 0,
      reports: [],
      completedInterviews: [],
      lastReportAt: null,
    },
    liveChecksEnabled: true,
    cacheEnabled: false,
    ...overrides,
    env: {
      OPENAI_ADMIN_KEY: 'sk-admin-secret',
      OPENAI_USAGE_ENABLED: 'true',
      ...(overrides.env || {}),
    },
  };
}

test('GET /admin/metrics route is registered behind admin auth', () => {
  const appPath = path.resolve(__dirname, '../app.js');
  const source = fs.readFileSync(appPath, 'utf8');
  assert.match(source, /adminRouter\.get\('\/metrics', requireAuth, requireAdmin/);
});

test('platform health adapter framework includes all required service files', () => {
  for (const file of PLATFORM_HEALTH_FILES) {
    const fullPath = path.resolve(__dirname, '../src/lib/platformHealth', file);
    assert.equal(fs.existsSync(fullPath), true, `${file} should exist`);
  }
});

test('admin metrics returns platform-only service shape with all required services', async () => {
  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: {},
    requestId: 'req-empty',
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {},
    liveChecksEnabled: false,
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.request_id, 'req-empty');
  assert.equal(payload.filters.date_range, '30d');
  assert.equal(payload.filters.selected_client_id, undefined);
  assert.equal(payload.filters.entity_filter, undefined);
  assert.equal(payload.filters.role_id, undefined);
  assert.deepEqual(payload.services.map((service) => service.key), [
    'openai',
    'tavus',
    'supabase',
    'sendgrid',
    'render',
    'sentry',
    'aws_s3',
    'stripe',
  ]);
  assert.equal(payload.status_cards.length, 8);
  assert.equal(payload.integration_readiness.length, 8);
  assert.equal(payload.attention, undefined);
  assert.equal(payload.entity_operations, undefined);
  assert.equal(payload.interview_funnel, undefined);
  assert.equal(payload.email, undefined);
  assert.equal(serviceByKey(payload, 'render').status, 'not_configured');
  assert.equal(serviceByKey(payload, 'sentry').status, 'not_configured');
  for (const service of payload.services) {
    assert.equal(typeof service.connection_label, 'string');
    assert.equal(typeof service.source_label, 'string');
    assert.equal(typeof service.meaning, 'string');
    assert.ok(Array.isArray(service.usage_summary));
    assert.ok(Array.isArray(service.problem_summary));
    assert.ok(Array.isArray(service.readiness_items));
    assert.equal(typeof service.live_api_connected, 'boolean');
  }
});

test('admin metrics applies platform date range filters and preserves interview completion bug fix', async () => {
  const tables = emptyTables();
  tables.clients.push(
    { id: 'client-1', name: 'Espire Dental', parent_client_id: null, archived_at: null, stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', subscription_status: 'active', created_at: '2026-01-01T00:00:00.000Z' },
    { id: 'client-2', name: 'Other Client', parent_client_id: null, archived_at: null, created_at: '2026-01-01T00:00:00.000Z' },
  );
  tables.roles.push({ id: 'role-1', client_id: 'client-1', title: 'Dental Assistant', status: 'active', created_at: '2026-05-01T00:00:00.000Z' });
  tables.candidates.push(
    { id: 'candidate-in', client_id: 'client-1', role_id: 'role-1', status: 'Interview Completed', interview_status: 'Interview Completed', created_at: '2026-06-10T10:00:00.000Z' },
    { id: 'candidate-out', client_id: 'client-1', role_id: 'role-1', status: 'Interview Completed', interview_status: 'Interview Completed', created_at: '2026-04-10T10:00:00.000Z' },
  );
  tables.interviews.push(
    { id: 'interview-in', client_id: 'client-1', role_id: 'role-1', candidate_id: 'candidate-in', created_at: '2026-06-10T11:00:00.000Z', updated_at: '2026-06-10T12:00:00.000Z', status: 'completed', transcript: 'ready', recording_status: 'ready', recording_ready_at: '2026-06-10T12:10:00.000Z', recording_metadata: { duration_seconds: 600 } },
    { id: 'interview-out', client_id: 'client-1', role_id: 'role-1', candidate_id: 'candidate-out', created_at: '2026-04-10T11:00:00.000Z', updated_at: '2026-04-10T12:00:00.000Z', status: 'completed' },
  );
  tables.reports.push(
    { id: 'report-in', client_id: 'client-1', role_id: 'role-1', candidate_id: 'candidate-in', created_at: '2026-06-10T12:20:00.000Z' },
    { id: 'report-out', client_id: 'client-1', role_id: 'role-1', candidate_id: 'candidate-out', created_at: '2026-04-10T12:20:00.000Z' },
  );
  tables.interview_perception_events.push({ id: 'event-1', client_id: 'client-1', interview_id: 'interview-in', event_type: 'application.perception_analysis', received_at: '2026-06-10T12:15:00.000Z' });
  tables.email_delivery_events.push(
    { id: 'email-in', created_at: '2026-06-11T00:00:00.000Z', event_type: 'bounce', is_problem: true },
    { id: 'email-out', created_at: '2026-04-11T00:00:00.000Z', event_type: 'bounce', is_problem: true },
  );

  const db = makeDb(tables);
  const payload = await buildAdminMetricsPayload({
    db,
    query: { client_id: 'ignored-client', entity_filter: 'ignored-entity', role_id: 'ignored-role', date_range: '30d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {},
    liveChecksEnabled: false,
  });

  assert.equal(payload.filters.date_range, '30d');
  assert.equal(payload.filters.selected_client_id, undefined);
  assert.equal(serviceByKey(payload, 'openai').usage.find((row) => row.label === 'Reports generated').value, 1);
  assert.equal(serviceByKey(payload, 'tavus').usage.find((row) => row.label === 'Interview starts').value, 1);
  assert.equal(serviceByKey(payload, 'tavus').usage.find((row) => row.label === 'Estimated minutes').value, 10);
  assert.equal(serviceByKey(payload, 'sendgrid').errors.find((row) => row.label === 'Bounces').value, 1);
  const interviewSelect = db.selects.find((entry) => entry.table === 'interviews')?.columns || '';
  assert.doesNotMatch(interviewSelect, /completed_at|interview_status/);
  assert.match(interviewSelect, /\bstatus\b/);
});

test('admin metrics response does not expose raw secrets, tokens, raw links, or raw event lists', async () => {
  const tables = emptyTables();
  tables.clients.push({ id: 'client-1', name: 'Espire Dental', parent_client_id: null, archived_at: null });
  tables.automation_action_approval_tokens.push({
    id: 'token-1',
    client_id: 'client-1',
    token_hash: 'super-secret-token-hash',
    recipient_email: 'reviewer@example.com',
    created_at: '2026-06-12T00:00:00.000Z',
  });
  tables.automation_digest_approval_tokens.push({
    id: 'digest-token-1',
    client_id: 'client-1',
    token_hash: 'super-secret-digest-token-hash',
    item_salt: 'secret-salt',
    recipient_email: 'digest@example.com',
    created_at: '2026-06-12T00:00:00.000Z',
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
    query: { date_range: '30d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      OPENAI_API_KEY: 'sk-test-secret',
      TAVUS_API_KEY: 'tavus-secret',
      SENDGRID_API_KEY: 'sendgrid-secret',
      SUPABASE_SERVICE_ROLE_KEY: 'supabase-secret',
      SUPABASE_URL: 'https://example.supabase.co',
      RENDER_API_KEY: 'render-secret',
      SENTRY_DSN: 'sentry-dsn-secret',
      SENTRY_AUTH_TOKEN: 'sentry-token-secret',
      AWS_ACCESS_KEY_ID: 'aws-access-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-key-secret',
      STRIPE_SECRET_KEY: 'stripe-secret',
      STRIPE_WEBHOOK_SECRET: 'stripe-webhook-secret',
      AUTOMATION_DIGEST_RUNNER_SECRET: 'scheduler-secret',
      SENTRY_ENABLED: '1',
    },
    liveChecksEnabled: false,
  });
  const serialized = JSON.stringify(payload);

  assert.equal(db.selects.some((entry) => entry.table === 'automation_action_approval_tokens'), false);
  assert.equal(db.selects.some((entry) => entry.table === 'automation_digest_approval_tokens'), false);
  assert.equal(payload.services.find((service) => service.key === 'sendgrid').recent_problem_events, undefined);
  assert.equal(payload.services.find((service) => service.key === 'sendgrid').events, undefined);
  assert.doesNotMatch(serialized, /super-secret|raw-sendgrid-payload|reviewer@example\.com|digest@example\.com|person@example\.com|https:\/\/example\.test|sk-test-secret|tavus-secret|sendgrid-secret|supabase-secret|render-secret|sentry-dsn-secret|sentry-token-secret|aws-access-secret|aws-secret-key-secret|stripe-secret|stripe-webhook-secret|scheduler-secret/i);
  assert.doesNotMatch(serialized, /api_key|webhook_secret|service_role|private_key|access_key|approval_token|digest_token|token_hash|item_salt|raw_payload|bearer/i);
});

test('admin metrics marks missing live integrations as not connected without fake usage', async () => {
  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {},
    liveChecksEnabled: false,
  });

  assert.equal(payload.filters.date_range, '7d');
  assert.equal(serviceByKey(payload, 'render').source_label, 'Configuration check');
  assert.equal(serviceByKey(payload, 'sentry').source_label, 'Not connected yet');
  assert.equal(serviceByKey(payload, 'aws_s3').status, 'not_configured');
  assert.equal(serviceByKey(payload, 'stripe').status, 'not_configured');
  assert.equal(payload.integration_readiness.find((row) => row.service === 'Render').live_usage_connected, false);
});

test('admin metrics uses live vendor APIs when configured and still returns safe summaries', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          data: [{
            results: [{
              num_model_requests: 3,
              input_tokens: 100,
              output_tokens: 50,
              model: 'gpt-test',
            }],
          }],
        }),
      };
    }
    if (String(url).includes('/organization/costs')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ amount: { value: 1.23, currency: 'usd' } }] }],
        }),
      };
    }
    if (String(url).includes('sendgrid.com')) {
      return {
        ok: true,
        text: async () => JSON.stringify([
          { stats: [{ metrics: { requests: 5, delivered: 4, bounces: 1, drops: 0, blocks: 0, deferred: 0, spam_reports: 0 } }] },
        ]),
      };
    }
    throw new Error('unexpected_url');
  };

  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      OPENAI_ADMIN_KEY: 'sk-test-secret',
      OPENAI_USAGE_ENABLED: 'true',
      SENDGRID_API_KEY: 'sendgrid-secret',
    },
    fetchImpl,
    liveChecksEnabled: true,
    cacheEnabled: false,
  });

  assert.ok(calls.some((url) => url.includes('/organization/usage/completions')));
  assert.ok(calls.some((url) => url.includes('sendgrid.com/v3/stats')));
  const costCall = new URL(calls.find((url) => url.includes('/organization/costs')));
  assert.equal(costCall.pathname, '/v1/organization/costs');
  assert.equal(costCall.searchParams.has('start_time'), true);
  assert.equal(costCall.searchParams.has('end_time'), true);
  assert.equal(costCall.searchParams.get('bucket_width'), '1d');
  assert.equal(costCall.searchParams.get('limit'), '180');
  assert.equal(costCall.searchParams.has('group_by'), false);
  assert.equal(costCall.searchParams.has('project_ids'), false);
  assert.equal(serviceByKey(payload, 'openai').live_api_connected, true);
  assert.equal(serviceByKey(payload, 'openai').source_label, 'Live OpenAI API');
  assert.equal(serviceByKey(payload, 'openai').usage.find((row) => row.label === 'Requests').value, 3);
  assert.equal(serviceByKey(payload, 'openai').cost_summary.display, '$1.23');
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_usage_status, 'connected');
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_status, 'connected');
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_call_status, 'called_connected');
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_http_status, 200);
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_error_kind, null);
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_endpoint_version, 'organization_costs');
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_response_kind, 'buckets');
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_bucket_count, 1);
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_total_seen, true);
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_request_attempted, true);
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_request_url_valid, true);
  assert.deepEqual(serviceByKey(payload, 'openai').diagnostics.openai_cost_query_param_keys, ['start_time', 'end_time', 'bucket_width', 'limit']);
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_exception_kind, null);
  assert.equal(serviceByKey(payload, 'openai').diagnostics.openai_cost_exception_message_safe, null);
  assert.equal(serviceByKey(payload, 'sendgrid').live_api_connected, true);
  assert.equal(serviceByKey(payload, 'sendgrid').usage.find((row) => row.label === 'Delivered').value, 4);
  assert.doesNotMatch(JSON.stringify(payload), /sk-test-secret|sendgrid-secret/i);
});

test('admin metrics OpenAI cost skips when OPENAI_COSTS_ENABLED is false', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ num_model_requests: 1, input_tokens: 10, output_tokens: 5, model: 'gpt-test' }] }],
        }),
      };
    }
    throw new Error('cost_should_not_be_called');
  };

  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      OPENAI_ADMIN_KEY: 'sk-admin-secret',
      OPENAI_USAGE_ENABLED: 'true',
      OPENAI_COSTS_ENABLED: 'false',
    },
    fetchImpl,
    liveChecksEnabled: true,
    cacheEnabled: false,
  });

  const service = serviceByKey(payload, 'openai');
  assert.equal(calls.some((url) => url.includes('/organization/usage/completions')), true);
  assert.equal(calls.some((url) => url.includes('/organization/costs')), false);
  assert.equal(service.live_api_connected, true);
  assert.equal(service.cost_summary.display, 'Not available');
  assert.equal(service.diagnostics.openai_usage_status, 'connected');
  assert.equal(service.diagnostics.openai_cost_status, 'not_called');
  assert.equal(service.diagnostics.openai_cost_call_status, 'skipped_by_env');
  assert.equal(service.diagnostics.openai_cost_response_kind, 'not_called');
  assert.equal(service.diagnostics.openai_cost_bucket_count, null);
  assert.equal(service.diagnostics.openai_cost_total_seen, false);
  assert.equal(service.diagnostics.openai_cost_request_attempted, false);
  assert.equal(service.diagnostics.openai_cost_request_url_valid, false);
  assert.doesNotMatch(JSON.stringify(payload), /sk-admin-secret/i);
});

test('admin metrics OpenAI cost skips without OPENAI_ADMIN_KEY', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ num_model_requests: 1, input_tokens: 10, output_tokens: 5, model: 'gpt-test' }] }],
        }),
      };
    }
    throw new Error('cost_should_not_be_called');
  };

  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      OPENAI_API_KEY: 'sk-standard-secret',
      OPENAI_USAGE_ENABLED: 'true',
    },
    fetchImpl,
    liveChecksEnabled: true,
    cacheEnabled: false,
  });

  const service = serviceByKey(payload, 'openai');
  assert.equal(calls.some((url) => url.includes('/organization/usage/completions')), true);
  assert.equal(calls.some((url) => url.includes('/organization/costs')), false);
  assert.equal(service.live_api_connected, true);
  assert.equal(service.diagnostics.openai_key_source, 'standard_key');
  assert.equal(service.diagnostics.openai_usage_status, 'connected');
  assert.equal(service.diagnostics.openai_cost_status, 'not_called');
  assert.equal(service.diagnostics.openai_cost_call_status, 'skipped_missing_admin_key');
  assert.equal(service.diagnostics.openai_cost_response_kind, 'not_called');
  assert.equal(service.diagnostics.openai_cost_request_attempted, false);
  assert.equal(service.diagnostics.openai_cost_request_url_valid, false);
  assert.doesNotMatch(JSON.stringify(payload), /sk-standard-secret/i);
});

test('admin metrics OpenAI cost treats empty buckets as connected zero cost', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ num_model_requests: 1, input_tokens: 10, output_tokens: 5, model: 'gpt-test' }] }],
        }),
      };
    }
    if (String(url).includes('/organization/costs')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ object: 'page', data: [], has_more: false, next_page: null }),
      };
    }
    throw new Error('unexpected_url');
  };

  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      OPENAI_ADMIN_KEY: 'sk-admin-secret',
      OPENAI_USAGE_ENABLED: 'true',
    },
    fetchImpl,
    liveChecksEnabled: true,
    cacheEnabled: false,
  });

  const service = serviceByKey(payload, 'openai');
  assert.equal(service.live_api_connected, true);
  assert.equal(service.cost_summary.display, '$0.00');
  assert.equal(service.cost_summary.help, 'No cost returned for selected period');
  assert.equal(service.notes.includes('No cost returned for selected period'), true);
  assert.equal(service.diagnostics.openai_usage_status, 'connected');
  assert.equal(service.diagnostics.openai_cost_status, 'connected');
  assert.equal(service.diagnostics.openai_cost_call_status, 'called_connected');
  assert.equal(service.diagnostics.openai_cost_http_status, 200);
  assert.equal(service.diagnostics.openai_cost_error_kind, null);
  assert.equal(service.diagnostics.openai_cost_endpoint_version, 'organization_costs');
  assert.equal(service.diagnostics.openai_cost_response_kind, 'empty_buckets');
  assert.equal(service.diagnostics.openai_cost_bucket_count, 0);
  assert.equal(service.diagnostics.openai_cost_total_seen, false);
  assert.equal(service.diagnostics.openai_cost_request_attempted, true);
  assert.equal(service.diagnostics.openai_cost_request_url_valid, true);
  assert.deepEqual(service.diagnostics.openai_cost_query_param_keys, ['start_time', 'end_time', 'bucket_width', 'limit']);
  assert.equal(service.diagnostics.openai_cost_exception_kind, null);
  assert.equal(service.diagnostics.openai_cost_exception_message_safe, null);
  assert.doesNotMatch(JSON.stringify(payload), /sk-admin-secret/i);
});

test('admin metrics OpenAI diagnostics use admin key and classify cost permission failures', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url: String(url),
      authorization: String(options.headers?.Authorization || ''),
    });
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ num_model_requests: 1, input_tokens: 10, output_tokens: 5, model: 'gpt-test' }] }],
        }),
      };
    }
    if (String(url).includes('/organization/costs')) {
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ error: { message: 'forbidden raw detail' } }),
      };
    }
    throw new Error('unexpected_url');
  };

  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      OPENAI_ADMIN_KEY: 'sk-admin-secret',
      OPENAI_API_KEY: 'sk-standard-secret',
      OPENAI_USAGE_ENABLED: 'true',
      OPENAI_PROJECT_ID: 'proj-test',
      OPENAI_ORG_ID: 'org-test',
    },
    fetchImpl,
    liveChecksEnabled: true,
    cacheEnabled: false,
  });

  const usageCall = calls.find((call) => call.url.includes('/organization/usage/completions'));
  const costCall = calls.find((call) => call.url.includes('/organization/costs'));
  assert.ok(usageCall);
  assert.ok(costCall);
  assert.equal(usageCall.authorization, 'Bearer sk-admin-secret');
  assert.equal(costCall.authorization, 'Bearer sk-admin-secret');
  const costUrl = new URL(costCall.url);
  assert.equal(costUrl.pathname, '/v1/organization/costs');
  assert.equal(costUrl.searchParams.get('project_ids'), 'proj-test');
  assert.equal(costUrl.searchParams.get('bucket_width'), '1d');
  assert.equal(costUrl.searchParams.get('limit'), '180');
  assert.equal(costUrl.searchParams.has('group_by'), false);

  const diagnostics = serviceByKey(payload, 'openai').diagnostics;
  assert.deepEqual(diagnostics, {
    openai_usage_status: 'connected',
    openai_cost_status: 'failed',
    openai_cost_call_status: 'called_failed',
    openai_cost_http_status: 403,
    openai_cost_error_kind: 'permission',
    openai_cost_endpoint_version: 'organization_costs',
    openai_cost_response_kind: 'http_error',
    openai_cost_bucket_count: null,
    openai_cost_total_seen: false,
    openai_cost_request_attempted: true,
    openai_cost_request_url_valid: true,
    openai_cost_query_param_keys: ['start_time', 'end_time', 'bucket_width', 'limit', 'project_ids'],
    openai_cost_exception_kind: null,
    openai_cost_exception_message_safe: null,
    openai_key_source: 'admin_key',
    openai_project_scope: 'present',
    openai_org_scope: 'present',
  });
  assert.equal(serviceByKey(payload, 'openai').cost_summary.display, 'Not available');
  assert.doesNotMatch(JSON.stringify(payload), /sk-admin-secret|sk-standard-secret|forbidden raw detail/i);
});

test('admin metrics OpenAI cost captures fetch TypeError as request exception', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ num_model_requests: 1, input_tokens: 10, output_tokens: 5, model: 'gpt-test' }] }],
        }),
      };
    }
    if (String(url).includes('/organization/costs')) {
      throw new TypeError('fetch failed for https://api.openai.com/v1/organization/costs?api_key=sk-admin-secret');
    }
    throw new Error('unexpected_url');
  };

  const service = await buildOpenAIHealth(openAIHealthContext({ fetchImpl }));
  const diagnostics = service.diagnostics;
  assert.equal(diagnostics.openai_usage_status, 'connected');
  assert.equal(diagnostics.openai_cost_status, 'failed');
  assert.equal(diagnostics.openai_cost_call_status, 'called_failed');
  assert.equal(diagnostics.openai_cost_http_status, null);
  assert.equal(diagnostics.openai_cost_error_kind, 'unavailable');
  assert.equal(diagnostics.openai_cost_response_kind, 'request_exception');
  assert.equal(diagnostics.openai_cost_request_attempted, true);
  assert.equal(diagnostics.openai_cost_request_url_valid, true);
  assert.deepEqual(diagnostics.openai_cost_query_param_keys, ['start_time', 'end_time', 'bucket_width', 'limit']);
  assert.equal(diagnostics.openai_cost_exception_kind, 'fetch');
  assert.match(diagnostics.openai_cost_exception_message_safe, /fetch failed/i);
  assert.doesNotMatch(JSON.stringify(service), /sk-admin-secret|api\.openai\.com\/v1\/organization\/costs\?api_key/i);
});

test('admin metrics OpenAI cost captures AbortController timeout as request exception', async () => {
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ num_model_requests: 1, input_tokens: 10, output_tokens: 5, model: 'gpt-test' }] }],
        }),
      };
    }
    if (String(url).includes('/organization/costs')) {
      return new Promise((resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error('raw abort detail for https://api.openai.com/v1/organization/costs');
          error.name = 'AbortError';
          reject(error);
        };
        if (options.signal?.aborted) rejectAbort();
        else options.signal?.addEventListener('abort', rejectAbort, { once: true });
      });
    }
    throw new Error('unexpected_url');
  };

  const service = await buildOpenAIHealth(openAIHealthContext({ fetchImpl, timeoutMs: 1 }));
  const diagnostics = service.diagnostics;
  assert.equal(diagnostics.openai_usage_status, 'connected');
  assert.equal(diagnostics.openai_cost_status, 'failed');
  assert.equal(diagnostics.openai_cost_call_status, 'called_failed');
  assert.equal(diagnostics.openai_cost_http_status, null);
  assert.equal(diagnostics.openai_cost_error_kind, 'unavailable');
  assert.equal(diagnostics.openai_cost_response_kind, 'request_exception');
  assert.equal(diagnostics.openai_cost_request_attempted, true);
  assert.equal(diagnostics.openai_cost_request_url_valid, true);
  assert.equal(diagnostics.openai_cost_exception_kind, 'abort');
  assert.match(diagnostics.openai_cost_exception_message_safe, /timed out/i);
  assert.doesNotMatch(JSON.stringify(service), /sk-admin-secret|api\.openai\.com\/v1\/organization\/costs/i);
});

test('admin metrics OpenAI cost captures invalid URL construction safely', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ num_model_requests: 1, input_tokens: 10, output_tokens: 5, model: 'gpt-test' }] }],
        }),
      };
    }
    throw new Error('cost_should_not_be_called');
  };

  const service = await buildOpenAIHealth(openAIHealthContext({
    fetchImpl,
    openAICostOrganizationBaseUrl: 'https://[invalid-openai-url',
  }));
  const diagnostics = service.diagnostics;
  assert.equal(diagnostics.openai_usage_status, 'connected');
  assert.equal(diagnostics.openai_cost_status, 'failed');
  assert.equal(diagnostics.openai_cost_call_status, 'called_failed');
  assert.equal(diagnostics.openai_cost_http_status, null);
  assert.equal(diagnostics.openai_cost_error_kind, 'unknown');
  assert.equal(diagnostics.openai_cost_response_kind, 'request_exception');
  assert.equal(diagnostics.openai_cost_request_attempted, false);
  assert.equal(diagnostics.openai_cost_request_url_valid, false);
  assert.deepEqual(diagnostics.openai_cost_query_param_keys, []);
  assert.equal(diagnostics.openai_cost_exception_kind, 'url');
  assert.match(diagnostics.openai_cost_exception_message_safe, /invalid url/i);
  assert.doesNotMatch(JSON.stringify(service), /sk-admin-secret|invalid-openai-url/i);
});

test('admin metrics OpenAI cost marks invalid response shape as failed without raw payload', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/organization/usage/completions')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: [{ results: [{ num_model_requests: 1, input_tokens: 10, output_tokens: 5, model: 'gpt-test' }] }],
        }),
      };
    }
    if (String(url).includes('/organization/costs')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          object: 'page',
          data: { raw_detail: 'invalid raw cost payload detail' },
        }),
      };
    }
    throw new Error('unexpected_url');
  };

  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      OPENAI_ADMIN_KEY: 'sk-admin-secret',
      OPENAI_USAGE_ENABLED: 'true',
    },
    fetchImpl,
    liveChecksEnabled: true,
    cacheEnabled: false,
  });

  const service = serviceByKey(payload, 'openai');
  assert.equal(service.live_api_connected, true);
  assert.equal(service.cost_summary.display, 'Not available');
  assert.equal(service.diagnostics.openai_usage_status, 'connected');
  assert.equal(service.diagnostics.openai_cost_status, 'failed');
  assert.equal(service.diagnostics.openai_cost_call_status, 'called_failed');
  assert.equal(service.diagnostics.openai_cost_http_status, 200);
  assert.equal(service.diagnostics.openai_cost_error_kind, 'unknown');
  assert.equal(service.diagnostics.openai_cost_endpoint_version, 'organization_costs');
  assert.equal(service.diagnostics.openai_cost_response_kind, 'invalid_shape');
  assert.equal(service.diagnostics.openai_cost_bucket_count, null);
  assert.equal(service.diagnostics.openai_cost_total_seen, false);
  assert.equal(service.diagnostics.openai_cost_request_attempted, true);
  assert.equal(service.diagnostics.openai_cost_request_url_valid, true);
  assert.deepEqual(service.diagnostics.openai_cost_query_param_keys, ['start_time', 'end_time', 'bucket_width', 'limit']);
  assert.equal(service.diagnostics.openai_cost_exception_kind, null);
  assert.equal(service.diagnostics.openai_cost_exception_message_safe, null);
  assert.doesNotMatch(JSON.stringify(payload), /sk-admin-secret|invalid raw cost payload detail/i);
});

test('admin metrics AWS/S3 diagnostics align with recording storage env names', async () => {
  const sentCommands = [];
  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      TAVUS_RECORDING_S3_BUCKET_NAME: 'recordings-secret-bucket',
      AWS_REGION: 'us-west-2',
      AWS_ACCESS_KEY_ID: 'aws-access-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-key-secret',
      AWS_S3_BUCKET: 'wrong-generic-bucket',
    },
    liveChecksEnabled: true,
    cacheEnabled: false,
    awsS3ClientFactory: ({ region }) => ({
      send: async (command) => {
        sentCommands.push({ region, input: command.input });
        return {};
      },
    }),
  });

  const service = serviceByKey(payload, 'aws_s3');
  assert.equal(service.live_api_connected, true);
  assert.equal(service.diagnostics.aws_key_source, 'explicit_credentials');
  assert.equal(service.diagnostics.aws_bucket_source, 'TAVUS_RECORDING_S3_BUCKET_NAME');
  assert.equal(service.diagnostics.aws_region_source, 'AWS_REGION');
  assert.equal(service.diagnostics.aws_health_check, 'head_bucket');
  assert.equal(service.diagnostics.aws_health_status, 'connected');
  assert.equal(service.diagnostics.aws_error_kind, null);
  assert.equal(service.diagnostics.aws_error_http_status, null);
  assert.equal(sentCommands[0].region, 'us-west-2');
  assert.equal(sentCommands[0].input.Bucket, 'recordings-secret-bucket');
  assert.doesNotMatch(JSON.stringify(payload), /recordings-secret-bucket|wrong-generic-bucket|aws-access-secret|aws-secret-key-secret/i);
});

test('admin metrics AWS/S3 diagnostics classify HeadBucket AccessDenied safely', async () => {
  const payload = await buildAdminMetricsPayload({
    db: makeDb(),
    query: { date_range: '7d' },
    now: new Date('2026-06-18T12:00:00.000Z'),
    env: {
      TAVUS_RECORDING_S3_BUCKET_NAME: 'recordings-secret-bucket',
      TAVUS_RECORDING_S3_BUCKET_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'aws-access-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret-key-secret',
    },
    liveChecksEnabled: true,
    cacheEnabled: false,
    awsS3ClientFactory: () => ({
      send: async () => {
        const error = new Error('raw aws access denied detail for recordings-secret-bucket');
        error.name = 'AccessDenied';
        error.$metadata = { httpStatusCode: 403 };
        throw error;
      },
    }),
  });

  const service = serviceByKey(payload, 'aws_s3');
  assert.equal(service.live_api_connected, false);
  assert.equal(service.diagnostics.aws_bucket_source, 'TAVUS_RECORDING_S3_BUCKET_NAME');
  assert.equal(service.diagnostics.aws_region_source, 'TAVUS_RECORDING_S3_BUCKET_REGION');
  assert.equal(service.diagnostics.aws_health_check, 'head_bucket');
  assert.equal(service.diagnostics.aws_health_status, 'failed');
  assert.equal(service.diagnostics.aws_error_kind, 'permission');
  assert.equal(service.diagnostics.aws_error_http_status, 403);
  assert.doesNotMatch(JSON.stringify(payload), /recordings-secret-bucket|aws-access-secret|aws-secret-key-secret|raw aws access denied detail/i);
});

test('email event taxonomy normalizes delivery, engagement, problem, and unknown events', () => {
  assert.equal(normalizeEmailEvent({ event_type: 'delivered' }), 'sent_delivered');
  assert.equal(normalizeEmailEvent({ event_type: 'click' }), 'engagement');
  assert.equal(normalizeEmailEvent({ event_type: 'dropped' }), 'problem');
  assert.equal(normalizeEmailEvent({ event_type: 'custom_event' }), 'unknown');
});
