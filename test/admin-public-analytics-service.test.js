'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  buildAdminPublicAnalyticsLeadsCsv,
  buildAdminPublicAnalyticsPayload,
  CSV_EXPORT_LIMIT,
} = require('../src/lib/adminPublicAnalyticsService');

class FakeQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.ranges = [];
    this.orderField = null;
    this.ascending = false;
    this.limitCount = null;
    this.rangeFrom = null;
    this.rangeTo = null;
  }

  select(columns) {
    this.db.selects.push({ table: this.table, columns: String(columns || '') });
    return this;
  }

  eq(column, value) {
    this.filters.push({ type: 'eq', column, value: String(value) });
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
    this.limitCount = Number(count || 0);
    return this;
  }

  range(from, to) {
    this.rangeFrom = Number(from || 0);
    this.rangeTo = Number(to || 0);
    return this;
  }

  execute() {
    let rows = (this.db.tables[this.table] || []).map((row) => ({ ...row }));
    for (const filter of this.filters) {
      if (filter.type === 'eq') {
        rows = rows.filter((row) => String(row[filter.column] || '') === filter.value);
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
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      rows = rows.slice(this.rangeFrom, this.rangeTo + 1);
    } else if (this.limitCount) {
      rows = rows.slice(0, this.limitCount);
    }
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

function makeDb(tables = {}) {
  return {
    tables: {
      public_lead_drafts: [],
      public_analytics_events: [],
      ...tables,
    },
    selects: [],
    from(table) {
      return new FakeQuery(this, table);
    },
  };
}

const NOW = new Date('2026-06-22T12:00:00.000Z');

test('admin public analytics route is registered behind admin auth and public write routes remain mounted', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(appSource, /adminRouter\.get\('\/public-analytics', requireAuth, requireAdmin/);
  assert.match(appSource, /adminRouter\.get\('\/public-analytics\/leads\.csv', requireAuth, requireAdmin/);
  assert.match(appSource, /Content-Disposition/);
  assert.match(appSource, /X-Export-Row-Count/);
  assert.match(appSource, /app\.use\('\/api\/public-analytics', require\('\.\/routes\/publicAnalytics'\)\)/);
  assert.match(appSource, /app\.use\('\/api\/public-leads', require\('\.\/routes\/publicLeads'\)\)/);
});

test('admin public analytics payload returns sanitized leads and events', async () => {
  const db = makeDb({
    public_lead_drafts: [
      {
        id: 'lead-submitted',
        status: 'submitted',
        form_id: 'demo-form',
        form_type: 'demo',
        product_interest: 'alphaScreen',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'lead@example.com',
        phone: '+1 555 111 2222',
        message: 'Please follow up. Secret token sk-live-raw and person@example.com should not leak.',
        fields_completed: ['first_name', 'email', 'message'],
        last_field: 'message',
        source_path: '/alphascreen?utm_source=ad',
        source_referrer_path: 'https://www.alphasourceai.com/about?x=1',
        source_cta: 'hero-demo',
        utm: { utm_source: 'linkedin', email: 'utm@example.com', token: 'raw-token' },
        anonymous_id: 'anonymous-raw',
        session_id: 'session-raw',
        request_id: 'request-raw',
        privacy_notice_version: '2026-06',
        submitted_at: '2026-06-21T10:00:00.000Z',
        expires_at: '2026-09-21T10:00:00.000Z',
        created_at: '2026-06-21T09:45:00.000Z',
        updated_at: '2026-06-21T10:00:00.000Z',
      },
      {
        id: 'lead-partial',
        status: 'partial',
        email: 'partial@example.com',
        message: 'Partial draft message should not be shown.',
        fields_completed: ['email'],
        source_path: '/about',
        created_at: '2026-06-20T09:45:00.000Z',
        updated_at: '2026-06-20T10:00:00.000Z',
      },
    ],
    public_analytics_events: [
      {
        id: 'event-1',
        event_name: 'lead_form_submit',
        path: '/alphascreen',
        page_title: 'alphaScreen',
        referrer_path: '/about',
        utm: { utm_source: 'linkedin', secret: 'raw-secret' },
        properties: {
          cta_id: 'hero',
          scroll_depth: 75,
          email: 'metadata@example.com',
          token: 'raw-token',
          nested: { raw: 'payload' },
        },
        anonymous_id: 'anonymous-event',
        session_id: 'session-event',
        request_id: 'request-event',
        occurred_at: '2026-06-21T10:05:00.000Z',
        created_at: '2026-06-21T10:06:00.000Z',
      },
      {
        id: 'event-2',
        event_name: 'cta_clicked',
        path: '/',
        properties: {
          cta_label: 'Request a Demo',
          cta_target: '/alphascreen',
          placement: 'hero',
          email: 'cta@example.com',
        },
        occurred_at: '2026-06-21T10:04:00.000Z',
        created_at: '2026-06-21T10:04:30.000Z',
      },
      {
        id: 'event-3',
        event_name: 'lead_form_started',
        path: '/alphascreen',
        properties: {
          form_id: 'home-contact',
          form_type: 'contact',
          first_field: 'email',
        },
        occurred_at: '2026-06-21T10:03:00.000Z',
        created_at: '2026-06-21T10:03:30.000Z',
      },
    ],
  });

  const payload = await buildAdminPublicAnalyticsPayload({
    db,
    now: NOW,
    query: { days: '30', limit: '25' },
    requestId: 'admin-request',
  });

  assert.equal(payload.summary.submitted_leads, 1);
  assert.equal(payload.summary.draft_or_partial_leads, 1);
  assert.equal(payload.summary.public_analytics_events, 3);
  assert.equal(payload.summary.most_active_page.display_name, 'alphaScreen');
  assert.equal(payload.leads.items[0].message_preview.includes('[redacted]'), true);
  assert.equal(payload.leads.items[1].message_preview, null);
  assert.deepEqual(payload.events.items[0].metadata_summary, [
    { key: 'cta_id', value: 'hero' },
    { key: 'scroll_depth', value: '75' },
    { key: 'nested', value: 'object' },
  ]);
  assert.deepEqual(payload.insights.cta_activity[0], {
    label: 'Request a Demo',
    placement: 'hero',
    target_path: '/alphascreen',
    count: 1,
    last_clicked_at: '2026-06-21T10:04:00.000Z',
  });
  assert.equal(payload.insights.page_activity[0].display_name, 'alphaScreen');
  assert.equal(payload.insights.page_activity[0].form_activity, 2);
  assert.equal(payload.insights.form_activity.some((item) => item.form_id === 'home-contact'), true);
  assert.equal(payload.insights.event_types.some((item) => item.event_name === 'cta_clicked' && item.count === 1), true);

  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /anonymous-raw|session-raw|request-raw|anonymous-event|session-event|request-event/i);
  assert.doesNotMatch(serialized, /sk-live-raw|person@example\.com|utm@example\.com|metadata@example\.com|cta@example\.com|raw-token|raw-secret|Partial draft message/i);
});

test('admin public analytics supports filters and page-size pagination without raw payloads', async () => {
  const db = makeDb({
    public_lead_drafts: [
      { id: 'lead-1', status: 'submitted', email: 'a@example.com', source_path: '/alphascreen', updated_at: '2026-06-21T10:00:00.000Z', created_at: '2026-06-21T10:00:00.000Z' },
      { id: 'lead-2', status: 'partial', email: 'b@example.com', source_path: '/alphascreen', updated_at: '2026-06-21T09:00:00.000Z', created_at: '2026-06-21T09:00:00.000Z' },
      { id: 'lead-3', status: 'submitted', email: 'c@example.com', source_path: '/about', updated_at: '2026-06-21T08:00:00.000Z', created_at: '2026-06-21T08:00:00.000Z' },
    ],
    public_analytics_events: [
      { id: 'event-1', event_name: 'page_view', path: '/alphascreen', properties: { section: 'hero' }, occurred_at: '2026-06-21T10:00:00.000Z', created_at: '2026-06-21T10:00:00.000Z' },
      { id: 'event-2', event_name: 'page_view', path: '/alphascreen', properties: { section: 'pricing' }, occurred_at: '2026-06-21T09:00:00.000Z', created_at: '2026-06-21T09:00:00.000Z' },
      { id: 'event-3', event_name: 'page_view', path: '/alphascreen', properties: { section: 'faq' }, occurred_at: '2026-06-21T08:00:00.000Z', created_at: '2026-06-21T08:00:00.000Z' },
      { id: 'event-4', event_name: 'cta_click', path: '/about', properties: { section: 'footer' }, occurred_at: '2026-06-21T07:00:00.000Z', created_at: '2026-06-21T07:00:00.000Z' },
    ],
  });

  const payload = await buildAdminPublicAnalyticsPayload({
    db,
    now: NOW,
    query: {
      date_from: '2026-06-20',
      date_to: '2026-06-22',
      status: 'submitted',
      event_name: 'page_view',
      path: '/alphascreen?ignored=true',
      lead_limit: '1',
      event_limit: '2',
    },
  });

  assert.equal(payload.filters.lead_status, 'submitted');
  assert.equal(payload.filters.event_name, 'page_view');
  assert.equal(payload.filters.path, '/alphascreen');
  assert.equal(payload.leads.items.length, 1);
  assert.equal(payload.leads.items[0].id, 'lead-1');
  assert.equal(payload.leads.pagination.has_more, false);
  assert.equal(payload.events.items.length, 2);
  assert.equal(payload.events.pagination.has_more, true);
  assert.deepEqual(payload.events.items.map((item) => item.id), ['event-1', 'event-2']);
});

test('admin public analytics lead CSV export is sanitized and respects filters', async () => {
  const db = makeDb({
    public_lead_drafts: [
      {
        id: 'lead-export-1',
        status: 'submitted',
        form_id: 'demo-form',
        form_type: 'demo',
        product_interest: 'alphaScreen',
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'lead@example.com',
        phone: '+1 555 111 2222',
        message: '=Formula token sk-live-raw person@example.com 555-111-2222',
        fields_completed: ['first_name', 'email', 'message'],
        last_field: 'message',
        source_path: '/alphascreen',
        source_cta: 'hero-demo',
        anonymous_id: 'anonymous-raw',
        session_id: 'session-raw',
        request_id: 'request-raw',
        submitted_at: '2026-06-21T10:00:00.000Z',
        created_at: '2026-06-21T09:45:00.000Z',
        updated_at: '2026-06-21T10:00:00.000Z',
      },
      {
        id: 'lead-export-2',
        status: 'partial',
        email: 'partial@example.com',
        message: 'Partial draft message should not export.',
        fields_completed: ['email'],
        source_path: '/alphascreen',
        created_at: '2026-06-21T09:00:00.000Z',
        updated_at: '2026-06-21T09:00:00.000Z',
      },
      {
        id: 'lead-export-3',
        status: 'submitted',
        email: 'other@example.com',
        source_path: '/about',
        created_at: '2026-06-21T08:00:00.000Z',
        updated_at: '2026-06-21T08:00:00.000Z',
      },
    ],
  });

  const payload = await buildAdminPublicAnalyticsLeadsCsv({
    db,
    now: NOW,
    query: {
      date_from: '2026-06-20',
      date_to: '2026-06-22',
      status: 'submitted',
      path: '/alphascreen?ignored=true',
    },
  });

  assert.equal(payload.content_type, 'text/csv; charset=utf-8');
  assert.equal(payload.filename, 'public-leads-2026-06-20-to-2026-06-22-submitted.csv');
  assert.equal(payload.row_count, 1);
  assert.equal(payload.truncated, false);
  assert.match(payload.csv, /^created_at,updated_at,status,submitted,submitted_at,source_page,source_path/m);
  assert.match(payload.csv, /lead@example\.com/);
  assert.match(payload.csv, /alphaScreen,\/alphascreen/);
  assert.match(payload.csv, /hero-demo/);
  assert.match(payload.csv, /\[redacted\]/);

  assert.doesNotMatch(payload.csv, /lead-export-1|anonymous-raw|session-raw|request-raw/i);
  assert.doesNotMatch(payload.csv, /sk-live-raw|person@example\.com|555-111-2222|Partial draft message|partial@example\.com|other@example\.com/i);
  assert.doesNotMatch(payload.csv, /^=/m);
});

test('admin public analytics lead CSV export is bounded', async () => {
  const publicLeadDrafts = Array.from({ length: CSV_EXPORT_LIMIT + 5 }, (_, index) => ({
    id: `lead-${index}`,
    status: 'submitted',
    email: `lead${index}@example.com`,
    source_path: '/alphascreen',
    created_at: '2026-06-21T08:00:00.000Z',
    updated_at: `2026-06-21T08:${String(index % 60).padStart(2, '0')}:00.000Z`,
  }));
  const db = makeDb({ public_lead_drafts: publicLeadDrafts });

  const payload = await buildAdminPublicAnalyticsLeadsCsv({
    db,
    now: NOW,
    query: { days: '30' },
  });

  assert.equal(payload.row_count, CSV_EXPORT_LIMIT);
  assert.equal(payload.truncated, true);
  assert.equal(payload.csv.trim().split('\n').length, CSV_EXPORT_LIMIT + 1);
});
