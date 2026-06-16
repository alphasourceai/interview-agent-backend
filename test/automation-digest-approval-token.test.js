'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { test } = require('node:test');
const express = require('express');

const projectRoot = path.resolve(__dirname, '..');
const routePath = path.join(projectRoot, 'routes', 'automation.js');
const supabaseClientPath = path.join(projectRoot, 'src', 'lib', 'supabaseClient.js');
const authMiddlewarePath = path.join(projectRoot, 'src', 'middleware', 'auth.js');
const mailerPath = path.join(projectRoot, 'utils', 'mailer.js');
const digestTokenHelpersPath = path.join(projectRoot, 'src', 'lib', 'automationDigestApprovalTokens.js');

const {
  createDigestApprovalTokenForDelivery,
  hashDigestApprovalToken,
  buildDigestApprovalItemId
} = require(digestTokenHelpersPath);

const rawToken = 'digest-token-1234567890';
const now = Date.now();

function futureIso(hours = 1) {
  return new Date(now + hours * 60 * 60 * 1000).toISOString();
}

function pastIso(hours = 1) {
  return new Date(now - hours * 60 * 60 * 1000).toISOString();
}

function baseTokenRow(overrides = {}) {
  return {
    id: 'token-row-1',
    delivery_id: 'delivery-1',
    client_id: 'client-1',
    recipient_email: 'reviewer@example.com',
    token_hash: hashDigestApprovalToken(rawToken),
    token_purpose: 'pending_approval_digest',
    state: 'active',
    expires_at: futureIso(),
    item_salt: 'item-salt-12345678901234567890',
    last_viewed_at: null,
    view_count: 0,
    request_id: null,
    created_at: '2026-06-16T00:00:00.000Z',
    updated_at: '2026-06-16T00:00:00.000Z',
    ...overrides,
  };
}

function baseDelivery(overrides = {}) {
  return {
    id: 'delivery-1',
    client_id: 'client-1',
    role_id: 'role-1',
    recipient_email: 'reviewer@example.com',
    digest_type: 'pending_approval',
    delivery_date: '2026-06-16',
    timezone: 'America/Denver',
    send_time_local: '09:00',
    status: 'sent',
    action_count: 2,
    action_ids: ['action-2', 'action-1'],
    request_id: 'digest-request-1',
    sent_at: '2026-06-16T09:00:00.000Z',
    failed_at: null,
    last_error: null,
    created_at: '2026-06-16T09:00:00.000Z',
    updated_at: '2026-06-16T09:00:00.000Z',
    ...overrides,
  };
}

function baseAction(id, overrides = {}) {
  return {
    id,
    evaluation_id: `evaluation-${id}`,
    rule_id: 'rule-1',
    rule_version: 1,
    client_id: 'client-1',
    role_id: 'role-1',
    candidate_id: `candidate-${id}`,
    report_id: `report-${id}`,
    interview_id: `interview-${id}`,
    action_type: 'send_second_round_scheduling_email',
    state: 'pending_approval',
    idempotency_key: `key-${id}`,
    candidate_snapshot: {
      candidate_name: id === 'action-1' ? 'Alex Candidate' : 'Jordan Applicant',
      role_title: 'Account Executive',
      candidate_email: `${id}@example.com`,
      overall_score: id === 'action-1' ? 85 : 91,
      resume_score: id === 'action-1' ? 82 : 90,
      interview_score: id === 'action-1' ? 88 : 93,
      content_sufficiency: {
        raw_notes: 'Do not expose.',
      },
      score_thresholds: {
        min_overall_score: 75,
      },
    },
    action_snapshot: {
      action_config: {
        scheduling_url: 'https://schedule.example.com/secret',
        rubric: {
          internal: true,
        },
      },
    },
    approved_by_user_id: null,
    approved_by_email: null,
    approved_at: null,
    rejected_at: null,
    canceled_at: null,
    sent_at: null,
    failed_at: null,
    last_error: null,
    send_attempt_count: 0,
    created_at: '2026-06-16T09:00:00.000Z',
    updated_at: '2026-06-16T09:00:00.000Z',
    ...overrides,
  };
}

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.operation = 'select';
    this.payload = null;
    this.selectedColumns = '';
  }

  select(columns) {
    this.selectedColumns = columns;
    this.db.selects.push({ table: this.table, columns });
    return this;
  }

  eq(column, value) {
    this.filters.push({ op: 'eq', column, value });
    return this;
  }

  in(column, value) {
    this.filters.push({ op: 'in', column, value });
    return this;
  }

  insert(payload) {
    this.operation = 'insert';
    this.payload = payload;
    this.db.inserts.push({ table: this.table, payload });
    return this;
  }

  update(payload) {
    this.operation = 'update';
    this.payload = payload;
    this.db.updates.push({ table: this.table, payload });
    return this;
  }

  maybeSingle() {
    return Promise.resolve(this.db.resolve(this, true));
  }

  then(resolve, reject) {
    return Promise.resolve(this.db.resolve(this, false)).then(resolve, reject);
  }
}

class FakeDb {
  constructor({ tokenRow, delivery, actions, candidates } = {}) {
    this.tokenRow = tokenRow === undefined ? baseTokenRow() : tokenRow;
    this.delivery = delivery === undefined ? baseDelivery() : delivery;
    this.actions = actions === undefined
      ? [
        baseAction('action-1'),
        baseAction('action-2', { state: 'sent' }),
        baseAction('action-outside-delivery', {
          candidate_snapshot: {
            candidate_name: 'Outside Candidate',
            role_title: 'Account Executive',
          },
        }),
      ]
      : actions;
    this.candidates = candidates === undefined
      ? [
        { id: 'candidate-action-1', client_id: 'client-1', role_id: 'role-1', name: 'Alex Candidate', email: 'alex@example.com' },
        { id: 'candidate-action-2', client_id: 'client-1', role_id: 'role-1', name: 'Jordan Applicant', email: 'jordan@example.com' },
        {
          id: 'candidate-action-outside-delivery',
          client_id: 'client-1',
          role_id: 'role-1',
          name: 'Outside Candidate',
          email: 'outside@example.com',
        },
      ]
      : candidates;
    this.events = [];
    this.inserts = [];
    this.updates = [];
    this.selects = [];
  }

  from(table) {
    return new FakeQuery(this, table);
  }

  findFilter(query, column, op = 'eq') {
    return query.filters.find((filter) => filter.op === op && filter.column === column);
  }

  resolve(query, single) {
    if (query.table === 'automation_digest_approval_tokens') {
      return this.resolveTokenQuery(query);
    }
    if (query.table === 'automation_digest_deliveries') {
      return this.resolveDeliveryQuery(query);
    }
    if (query.table === 'automation_actions') {
      return this.resolveActionsQuery(query, single);
    }
    if (query.table === 'automation_action_events') {
      return this.resolveEventQuery(query);
    }
    if (query.table === 'candidates') {
      return this.resolveCandidateQuery(query);
    }
    return { data: single ? null : [], error: null };
  }

  resolveTokenQuery(query) {
    if (query.operation === 'insert') {
      return {
        data: {
          id: 'created-digest-token',
          ...query.payload,
          last_viewed_at: null,
          view_count: 0,
          created_at: '2026-06-16T00:00:00.000Z',
          updated_at: '2026-06-16T00:00:00.000Z',
        },
        error: null,
      };
    }
    if (query.operation === 'update') {
      if (!this.tokenRow) return { data: null, error: null };
      this.tokenRow = {
        ...this.tokenRow,
        ...query.payload,
      };
      return { data: this.tokenRow, error: null };
    }

    const hash = this.findFilter(query, 'token_hash')?.value;
    if (!this.tokenRow || this.tokenRow.token_hash !== hash) {
      return { data: null, error: null };
    }
    return { data: this.tokenRow, error: null };
  }

  resolveDeliveryQuery(query) {
    const id = this.findFilter(query, 'id')?.value;
    const clientId = this.findFilter(query, 'client_id')?.value;
    if (!this.delivery || this.delivery.id !== id || this.delivery.client_id !== clientId) {
      return { data: null, error: null };
    }
    return { data: this.delivery, error: null };
  }

  resolveActionsQuery(query, single) {
    if (query.operation === 'update') {
      const action = this.actions.find((row) => this.matchesFilters(row, query.filters));
      if (!action) return { data: null, error: null };
      Object.assign(action, query.payload);
      return { data: { ...action }, error: null };
    }

    const rows = this.actions.filter((action) => this.matchesFilters(action, query.filters));
    return { data: single ? rows[0] || null : rows, error: null };
  }

  resolveEventQuery(query) {
    if (query.operation !== 'insert') return { data: null, error: null };
    const event = {
      id: `event-${this.events.length + 1}`,
      created_at: '2026-06-16T09:00:00.000Z',
      ...query.payload,
    };
    this.events.push(event);
    return { data: event, error: null };
  }

  resolveCandidateQuery(query) {
    const row = this.candidates.find((candidate) => this.matchesFilters(candidate, query.filters));
    return { data: row || null, error: null };
  }

  matchesFilters(row, filters) {
    return filters.every((filter) => {
      if (filter.op === 'eq') return row[filter.column] === filter.value;
      if (filter.op === 'in') {
        const values = Array.isArray(filter.value) ? filter.value : [];
        return values.includes(row[filter.column]);
      }
      return true;
    });
  }
}

function injectModule(filename, exports) {
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
}

function buildApp(db, mailer = {}) {
  delete require.cache[routePath];
  delete require.cache[supabaseClientPath];
  delete require.cache[authMiddlewarePath];
  delete require.cache[mailerPath];

  injectModule(supabaseClientPath, { supabaseAdmin: db });
  injectModule(authMiddlewarePath, {
    requireAuth: (req, _res, next) => {
      req.user = { id: 'user-1', email: 'user@example.com' };
      req.isGlobalAdmin = true;
      req.isAdmin = true;
      return next();
    },
    withClientScope: (_req, _res, next) => next(),
  });
  injectModule(mailerPath, mailer);

  const router = require(routePath);
  const app = express();
  app.use(express.json());
  app.use('/api/automation', router);
  return app;
}

function itemIdFor(actionId, tokenRow = baseTokenRow()) {
  return buildDigestApprovalItemId(tokenRow.item_salt, actionId);
}

function assertSafeDigestActionResponse(body) {
  const bodyText = JSON.stringify(body);
  assert.ok(!bodyText.includes('action-1'));
  assert.ok(!bodyText.includes('action-2'));
  assert.ok(!bodyText.includes('delivery-1'));
  assert.ok(!bodyText.includes(rawToken));
  assert.ok(!bodyText.includes('token_hash'));
  assert.ok(!bodyText.includes('candidate_email'));
  assert.ok(!bodyText.includes('alex@example.com'));
  assert.ok(!bodyText.includes('jordan@example.com'));
  assert.ok(!bodyText.includes('schedule.example.com'));
  assert.ok(!bodyText.includes('content_sufficiency'));
  assert.ok(!bodyText.includes('score_thresholds'));
  assert.ok(!bodyText.includes('rubric'));
}

function createMailerStub() {
  const sent = [];
  return {
    sent,
    async sendSecondRoundSchedulingEmail(email, payload) {
      sent.push({ email, payload });
      return { ok: true };
    },
  };
}

async function request(app, method, pathname) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? JSON.parse(text) : null,
    };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('createDigestApprovalTokenForDelivery stores only token hash', async () => {
  const db = new FakeDb();

  const outcome = await createDigestApprovalTokenForDelivery({
    db,
    delivery: {
      id: 'delivery-create-1',
      client_id: 'client-1',
      recipient_email: 'Reviewer@Example.com ',
    },
    requestId: 'request-1',
  });

  assert.equal(typeof outcome.token, 'string');
  assert.ok(outcome.token.length >= 40);

  const insert = db.inserts.find((entry) => entry.table === 'automation_digest_approval_tokens');
  assert.ok(insert);
  assert.equal(insert.payload.delivery_id, 'delivery-create-1');
  assert.equal(insert.payload.client_id, 'client-1');
  assert.equal(insert.payload.recipient_email, 'reviewer@example.com');
  assert.equal(insert.payload.token_purpose, 'pending_approval_digest');
  assert.equal(insert.payload.state, 'active');
  assert.equal(insert.payload.token_hash, hashDigestApprovalToken(outcome.token));
  assert.notEqual(insert.payload.token_hash, outcome.token);
  assert.ok(!Object.values(insert.payload).includes(outcome.token));
  assert.ok(insert.payload.item_salt);
});

test('GET /api/automation/digest-approval/:token returns multiple safe items', async () => {
  const db = new FakeDb();
  const result = await request(
    buildApp(db),
    'GET',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}`
  );

  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.body.ok, true);
  assert.equal(result.body.item.expires_at, db.tokenRow.expires_at);
  assert.equal(result.body.item.items.length, 2);
  assert.equal(result.body.item.items[0].candidate_name, 'Jordan Applicant');
  assert.equal(result.body.item.items[0].status, 'approved_or_sent');
  assert.equal(result.body.item.items[1].candidate_name, 'Alex Candidate');
  assert.equal(result.body.item.items[1].status, 'pending');
  assert.equal(result.body.item.items[1].can_approve_send, true);
  assert.equal(result.body.item.items[1].scores.overall_score, 85);

  const actionSelect = db.selects.find((entry) => entry.table === 'automation_actions')?.columns || '';
  assert.match(actionSelect, /\bcandidate_snapshot\b/);
  assert.doesNotMatch(actionSelect, /\baction_snapshot\b/);
  assert.doesNotMatch(actionSelect, /\bcandidate_id\b/);

  const itemIds = result.body.item.items.map((item) => item.item_id);
  assert.equal(new Set(itemIds).size, 2);
  assert.ok(itemIds.every((itemId) => typeof itemId === 'string' && itemId.length === 64));
  assert.ok(!itemIds.includes('action-1'));
  assert.ok(!itemIds.includes('action-2'));

  const bodyText = JSON.stringify(result.body);
  assert.ok(!bodyText.includes('action-1'));
  assert.ok(!bodyText.includes('action-2'));
  assert.ok(!bodyText.includes('action-outside-delivery'));
  assert.ok(!bodyText.includes('delivery-1'));
  assert.ok(!bodyText.includes(rawToken));
  assert.ok(!bodyText.includes('token_hash'));
  assert.ok(!bodyText.includes('candidate_email'));
  assert.ok(!bodyText.includes('schedule.example.com'));
  assert.ok(!bodyText.includes('content_sufficiency'));
  assert.ok(!bodyText.includes('score_thresholds'));
  assert.ok(!bodyText.includes('rubric'));

  assert.equal(db.tokenRow.view_count, 1);
  assert.ok(db.tokenRow.last_viewed_at);
  assert.equal(db.updates.length, 1);
});

test('GET /api/automation/digest-approval/:token returns only delivery action_ids', async () => {
  const db = new FakeDb({
    delivery: baseDelivery({ action_ids: ['action-1'] }),
  });

  const result = await request(
    buildApp(db),
    'GET',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}`
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.item.items.length, 1);
  assert.equal(result.body.item.items[0].candidate_name, 'Alex Candidate');
  assert.ok(!JSON.stringify(result.body).includes('Jordan Applicant'));
});

test('GET /api/automation/digest-approval/:token rejects expired token', async () => {
  const db = new FakeDb({
    tokenRow: baseTokenRow({ expires_at: pastIso() }),
  });

  const result = await request(
    buildApp(db),
    'GET',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}`
  );

  assert.equal(result.status, 410);
  assert.equal(result.body.code, 'digest_approval_token_expired');
  assert.equal(db.updates.length, 0);
});

test('GET /api/automation/digest-approval/:token rejects invalid token', async () => {
  const db = new FakeDb({ tokenRow: null });

  const result = await request(
    buildApp(db),
    'GET',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}`
  );

  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'digest_approval_token_invalid');
  assert.equal(db.updates.length, 0);
});

test('GET /api/automation/digest-approval/:token rejects unavailable delivery', async () => {
  const db = new FakeDb({
    delivery: baseDelivery({ status: 'failed' }),
  });

  const result = await request(
    buildApp(db),
    'GET',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}`
  );

  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'digest_approval_unavailable');
  assert.equal(db.updates.length, 0);
});

test('GET /api/automation/digest-approval/:token does not mark unavailable reads viewed', async () => {
  const db = new FakeDb({
    actions: [],
  });

  const result = await request(
    buildApp(db),
    'GET',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}`
  );

  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'digest_approval_unavailable');
  assert.equal(db.tokenRow.view_count, 0);
  assert.equal(db.updates.length, 0);
});

test('POST digest approve-send sends exactly once for pending action', async () => {
  const db = new FakeDb();
  const mailer = createMailerStub();
  const result = await request(
    buildApp(db, mailer),
    'POST',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}/items/${itemIdFor('action-1')}/approve-send`
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.item.item_id, itemIdFor('action-1'));
  assert.equal(result.body.item.status, 'sent');
  assert.equal(result.body.item.can_approve_send, false);
  assert.equal(result.body.item.can_reject, false);
  assert.equal(result.body.side_effects.emails_sent, 1);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].email, 'alex@example.com');
  assert.equal(db.actions.find((action) => action.id === 'action-1').state, 'sent');
  assert.deepEqual(db.events.map((event) => event.event_type), [
    'action_approved_from_digest_approval_token',
    'candidate_scheduling_email_sent',
  ]);
  assertSafeDigestActionResponse(result.body);
});

test('POST digest approve-send retry does not send duplicate email', async () => {
  const db = new FakeDb();
  const mailer = createMailerStub();
  const app = buildApp(db, mailer);
  const path = `/api/automation/digest-approval/${encodeURIComponent(rawToken)}/items/${itemIdFor('action-1')}/approve-send`;

  const first = await request(app, 'POST', path);
  const second = await request(app, 'POST', path);

  assert.equal(first.status, 200);
  assert.equal(first.body.side_effects.emails_sent, 1);
  assert.equal(second.status, 200);
  assert.equal(second.body.item.status, 'sent');
  assert.equal(second.body.side_effects.emails_sent, 0);
  assert.equal(mailer.sent.length, 1);
  assertSafeDigestActionResponse(second.body);
});

test('POST digest approve-send rejects item outside digest', async () => {
  const db = new FakeDb();
  const mailer = createMailerStub();
  const result = await request(
    buildApp(db, mailer),
    'POST',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}/items/${itemIdFor('action-outside-delivery')}/approve-send`
  );

  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'digest_approval_item_unavailable');
  assert.equal(mailer.sent.length, 0);
});

test('POST digest approve-send rejects expired token', async () => {
  const db = new FakeDb({
    tokenRow: baseTokenRow({ expires_at: pastIso() }),
  });
  const mailer = createMailerStub();
  const result = await request(
    buildApp(db, mailer),
    'POST',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}/items/${itemIdFor('action-1')}/approve-send`
  );

  assert.equal(result.status, 410);
  assert.equal(result.body.code, 'digest_approval_token_expired');
  assert.equal(mailer.sent.length, 0);
});

test('POST digest approve-send rejects invalid token', async () => {
  const db = new FakeDb({ tokenRow: null });
  const mailer = createMailerStub();
  const result = await request(
    buildApp(db, mailer),
    'POST',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}/items/${itemIdFor('action-1')}/approve-send`
  );

  assert.equal(result.status, 404);
  assert.equal(result.body.code, 'digest_approval_token_invalid');
  assert.equal(mailer.sent.length, 0);
});

test('POST digest reject marks pending action rejected and sends no email', async () => {
  const db = new FakeDb();
  const mailer = createMailerStub();
  const result = await request(
    buildApp(db, mailer),
    'POST',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}/items/${itemIdFor('action-1')}/reject`
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.item.item_id, itemIdFor('action-1'));
  assert.equal(result.body.item.status, 'rejected');
  assert.equal(result.body.side_effects.emails_sent, 0);
  assert.equal(mailer.sent.length, 0);
  assert.equal(db.actions.find((action) => action.id === 'action-1').state, 'rejected');
  assert.deepEqual(db.events.map((event) => event.event_type), [
    'action_rejected_from_digest_approval_token',
  ]);
  assertSafeDigestActionResponse(result.body);
});

test('POST digest reject is idempotent for already rejected action', async () => {
  const db = new FakeDb({
    actions: [
      baseAction('action-1', { state: 'rejected' }),
      baseAction('action-2', { state: 'sent' }),
    ],
  });
  const mailer = createMailerStub();
  const result = await request(
    buildApp(db, mailer),
    'POST',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}/items/${itemIdFor('action-1')}/reject`
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.item.status, 'rejected');
  assert.equal(result.body.side_effects.emails_sent, 0);
  assert.equal(db.events.length, 0);
  assert.equal(mailer.sent.length, 0);
  assertSafeDigestActionResponse(result.body);
});

test('POST digest reject conflicts after action was sent', async () => {
  const db = new FakeDb();
  const mailer = createMailerStub();
  const result = await request(
    buildApp(db, mailer),
    'POST',
    `/api/automation/digest-approval/${encodeURIComponent(rawToken)}/items/${itemIdFor('action-2')}/reject`
  );

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'automation_digest_approval_action_already_sent');
  assert.equal(mailer.sent.length, 0);
});
