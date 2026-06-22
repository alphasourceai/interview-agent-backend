'use strict';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SUMMARY_LIMIT = 500;
const VALID_LEAD_STATUSES = new Set(['partial', 'abandoned', 'submitted']);
const SAFE_EVENT_NAME_RE = /^[a-z][a-z0-9_]{1,80}$/;
const SENSITIVE_META_KEY_RE = /(authorization|bearer|cookie|token|secret|password|credential|email|phone|message|body|payload|form|name|ip|user[_-]?agent)/i;

function trimText(value, max = 300) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseDateBoundary(value, endOfDay = false) {
  const raw = trimText(value, 40);
  if (!raw) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = new Date(dateOnly && endOfDay ? `${raw}T23:59:59.999Z` : raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function isoDateOnly(value) {
  const parsed = value instanceof Date ? value : new Date(value || '');
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : '';
}

function parseDateRange(query = {}, now = new Date()) {
  const safeNow = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const days = parsePositiveInt(query.days || query.date_range, DEFAULT_DAYS, MAX_DAYS);
  const defaultFrom = new Date(safeNow.getTime() - days * 24 * 60 * 60 * 1000);
  const from = parseDateBoundary(query.date_from, false) || defaultFrom;
  const to = parseDateBoundary(query.date_to, true) || safeNow;
  return {
    days,
    from,
    to,
    date_range: trimText(query.date_from) || trimText(query.date_to) ? 'custom' : `${days}d`,
    date_from: from.toISOString(),
    date_to: to.toISOString(),
    date_from_display: isoDateOnly(from),
    date_to_display: isoDateOnly(to),
  };
}

function cleanPath(value) {
  const raw = trimText(value, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://www.alphasourceai.com');
    return trimText(url.pathname || '/', 300);
  } catch (_) {
    return trimText(raw.split('?')[0].split('#')[0], 300);
  }
}

function parseFilters(query = {}, now = new Date()) {
  const dateRange = parseDateRange(query, now);
  const leadStatus = trimText(query.status || query.lead_status, 40).toLowerCase();
  const eventName = trimText(query.event_name || query.event, 100).toLowerCase();
  return {
    ...dateRange,
    lead_status: VALID_LEAD_STATUSES.has(leadStatus) ? leadStatus : '',
    event_name: SAFE_EVENT_NAME_RE.test(eventName) ? eventName : '',
    path: cleanPath(query.path || query.page_path),
    lead_page: parsePositiveInt(query.lead_page || query.page, 1, 10000),
    event_page: parsePositiveInt(query.event_page || query.page, 1, 10000),
    lead_limit: parsePositiveInt(query.lead_limit || query.limit, DEFAULT_LIMIT, MAX_LIMIT),
    event_limit: parsePositiveInt(query.event_limit || query.limit, DEFAULT_LIMIT, MAX_LIMIT),
  };
}

function applyDateRange(query, column, filters) {
  return query
    .gte(column, filters.date_from)
    .lte(column, filters.date_to);
}

function applyLeadFilters(query, filters) {
  let next = applyDateRange(query, 'updated_at', filters);
  if (filters.lead_status) next = next.eq('status', filters.lead_status);
  if (filters.path) next = next.eq('source_path', filters.path);
  return next;
}

function applyEventFilters(query, filters) {
  let next = applyDateRange(query, 'occurred_at', filters);
  if (filters.event_name) next = next.eq('event_name', filters.event_name);
  if (filters.path) next = next.eq('path', filters.path);
  return next;
}

async function runQuery(builder, code) {
  const { data, error } = await builder;
  if (error) {
    const serviceError = new Error('Could not load public analytics records.');
    serviceError.code = code;
    serviceError.status = 503;
    throw serviceError;
  }
  return Array.isArray(data) ? data : [];
}

function pageRange(page, limit) {
  const offset = (page - 1) * limit;
  return { from: offset, to: offset + limit };
}

async function readLeadRows(db, filters, { page = 1, limit = DEFAULT_LIMIT, summary = false } = {}) {
  let query = db
    .from('public_lead_drafts')
    .select('id,status,form_id,form_type,product_interest,first_name,last_name,email,phone,message,fields_completed,last_field,source_path,source_referrer_path,source_cta,utm,privacy_notice_version,submitted_at,expires_at,created_at,updated_at');
  query = applyLeadFilters(query, filters).order('updated_at', { ascending: false });
  if (summary) query = query.limit(SUMMARY_LIMIT);
  else {
    const range = pageRange(page, limit);
    query = query.range(range.from, range.to);
  }
  return runQuery(query, 'public_leads_read_failed');
}

async function readEventRows(db, filters, { page = 1, limit = DEFAULT_LIMIT, summary = false } = {}) {
  let query = db
    .from('public_analytics_events')
    .select('id,event_name,path,page_title,referrer_path,utm,properties,occurred_at,created_at');
  query = applyEventFilters(query, filters).order('occurred_at', { ascending: false });
  if (summary) query = query.limit(SUMMARY_LIMIT);
  else {
    const range = pageRange(page, limit);
    query = query.range(range.from, range.to);
  }
  return runQuery(query, 'public_events_read_failed');
}

function safeMetaValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') {
    return trimText(value, 120)
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .replace(/sk-[A-Za-z0-9._-]+/gi, '[redacted]')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]');
  }
  if (Array.isArray(value)) return `array(${Math.min(value.length, 20)})`;
  if (typeof value === 'object') return 'object';
  return '';
}

function summarizeObject(value, maxItems = 4) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { keys: [], entries: [] };
  }
  const keys = [];
  const entries = [];
  for (const [key, raw] of Object.entries(value)) {
    const safeKey = trimText(key, 80);
    if (!safeKey || SENSITIVE_META_KEY_RE.test(safeKey)) continue;
    keys.push(safeKey);
    if (entries.length < maxItems) {
      const safeValue = safeMetaValue(raw);
      if (safeValue) entries.push({ key: safeKey, value: safeValue });
    }
  }
  return {
    keys: keys.slice(0, 12),
    entries,
  };
}

function messagePreview(row) {
  if (row?.status !== 'submitted') return null;
  const text = safeMetaValue(row?.message);
  return text || null;
}

function sanitizeLead(row) {
  const firstName = trimText(row?.first_name, 80);
  const lastName = trimText(row?.last_name, 80);
  const fieldsCompleted = Array.isArray(row?.fields_completed) ? row.fields_completed.filter(Boolean) : [];
  const utm = summarizeObject(row?.utm || {}, 5);
  const preview = messagePreview(row);
  return {
    id: trimText(row?.id, 80),
    status: trimText(row?.status, 40) || 'unknown',
    form_id: trimText(row?.form_id, 120) || null,
    form_type: trimText(row?.form_type, 80) || null,
    product_interest: trimText(row?.product_interest, 120) || null,
    contact: {
      first_name: firstName || null,
      last_name: lastName || null,
      full_name: [firstName, lastName].filter(Boolean).join(' ') || null,
      email: trimText(row?.email, 254) || null,
      phone: trimText(row?.phone, 40) || null,
    },
    source: {
      path: cleanPath(row?.source_path) || '/',
      referrer_path: cleanPath(row?.source_referrer_path) || null,
      cta: trimText(row?.source_cta, 160) || null,
      utm_summary: utm.entries,
      utm_keys: utm.keys,
    },
    progress: {
      fields_completed_count: fieldsCompleted.length,
      fields_completed: fieldsCompleted.slice(0, 12).map((field) => trimText(field, 80)).filter(Boolean),
      last_field: trimText(row?.last_field, 80) || null,
    },
    message_preview: preview,
    message_character_count: trimText(row?.message, 5000).length || 0,
    privacy_notice_version: trimText(row?.privacy_notice_version, 120) || null,
    submitted_at: trimText(row?.submitted_at, 40) || null,
    expires_at: trimText(row?.expires_at, 40) || null,
    created_at: trimText(row?.created_at, 40) || null,
    updated_at: trimText(row?.updated_at, 40) || null,
  };
}

function sanitizeEvent(row) {
  const utm = summarizeObject(row?.utm || {}, 4);
  const properties = summarizeObject(row?.properties || {}, 5);
  return {
    id: trimText(row?.id, 80),
    event_name: trimText(row?.event_name, 100) || 'unknown',
    path: cleanPath(row?.path) || '/',
    page_title: trimText(row?.page_title, 180) || null,
    referrer_path: cleanPath(row?.referrer_path) || null,
    metadata_summary: properties.entries,
    metadata_keys: properties.keys,
    utm_summary: utm.entries,
    utm_keys: utm.keys,
    occurred_at: trimText(row?.occurred_at, 40) || null,
    created_at: trimText(row?.created_at, 40) || null,
  };
}

function paginate(rows, page, limit) {
  const items = rows.slice(0, limit);
  return {
    page,
    limit,
    returned: items.length,
    has_more: rows.length > limit,
  };
}

function buildSummary(leadRows, eventRows) {
  const leadCounts = {
    submitted: 0,
    partial: 0,
    abandoned: 0,
  };
  for (const row of leadRows) {
    const status = trimText(row?.status, 40).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(leadCounts, status)) leadCounts[status] += 1;
  }
  const pageCounts = {};
  let recentActivityAt = '';
  for (const event of eventRows) {
    const path = cleanPath(event?.path) || '/';
    pageCounts[path] = (pageCounts[path] || 0) + 1;
    const occurredAt = trimText(event?.occurred_at || event?.created_at, 40);
    if (occurredAt && (!recentActivityAt || occurredAt > recentActivityAt)) recentActivityAt = occurredAt;
  }
  for (const lead of leadRows) {
    const updatedAt = trimText(lead?.updated_at || lead?.submitted_at || lead?.created_at, 40);
    if (updatedAt && (!recentActivityAt || updatedAt > recentActivityAt)) recentActivityAt = updatedAt;
  }
  const mostActivePage = Object.entries(pageCounts)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .map(([path, count]) => ({ path, count }))
    .at(0) || null;
  return {
    submitted_leads: leadCounts.submitted,
    draft_or_partial_leads: leadCounts.partial + leadCounts.abandoned,
    partial_leads: leadCounts.partial,
    abandoned_leads: leadCounts.abandoned,
    public_analytics_events: eventRows.length,
    most_active_page: mostActivePage,
    recent_activity_at: recentActivityAt || null,
    sampled: leadRows.length >= SUMMARY_LIMIT || eventRows.length >= SUMMARY_LIMIT,
  };
}

async function buildAdminPublicAnalyticsPayload({ db, query = {}, now = new Date(), requestId = null } = {}) {
  if (!db || typeof db.from !== 'function') {
    const error = new Error('Database client is not configured.');
    error.code = 'public_analytics_db_missing';
    error.status = 503;
    throw error;
  }
  const filters = parseFilters(query, now);
  const [leadRowsRaw, eventRowsRaw, leadSummaryRows, eventSummaryRows] = await Promise.all([
    readLeadRows(db, filters, { page: filters.lead_page, limit: filters.lead_limit }),
    readEventRows(db, filters, { page: filters.event_page, limit: filters.event_limit }),
    readLeadRows(db, filters, { summary: true }),
    readEventRows(db, filters, { summary: true }),
  ]);
  const leadRows = leadRowsRaw.map(sanitizeLead);
  const eventRows = eventRowsRaw.map(sanitizeEvent);
  return {
    generated_at: (now instanceof Date ? now : new Date()).toISOString(),
    filters: {
      date_range: filters.date_range,
      date_from: filters.date_from,
      date_to: filters.date_to,
      date_from_display: filters.date_from_display,
      date_to_display: filters.date_to_display,
      lead_status: filters.lead_status || 'all',
      event_name: filters.event_name || 'all',
      path: filters.path || 'all',
      lead_page: filters.lead_page,
      event_page: filters.event_page,
      lead_limit: filters.lead_limit,
      event_limit: filters.event_limit,
    },
    summary: buildSummary(leadSummaryRows, eventSummaryRows),
    leads: {
      items: leadRows.slice(0, filters.lead_limit),
      pagination: paginate(leadRowsRaw, filters.lead_page, filters.lead_limit),
    },
    events: {
      items: eventRows.slice(0, filters.event_limit),
      pagination: paginate(eventRowsRaw, filters.event_page, filters.event_limit),
    },
    request_id: requestId || null,
  };
}

function safePublicAnalyticsErrorBody(error, requestId) {
  return {
    error: error?.code || 'admin_public_analytics_failed',
    code: error?.code || 'admin_public_analytics_failed',
    detail: error?.message || 'Could not load public analytics records.',
    hint: null,
    request_id: requestId || null,
  };
}

module.exports = {
  buildAdminPublicAnalyticsPayload,
  parseFilters,
  safePublicAnalyticsErrorBody,
  sanitizeEvent,
  sanitizeLead,
};
