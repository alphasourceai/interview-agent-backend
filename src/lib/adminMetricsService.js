'use strict';

const { resolveEntityFilter } = require('./entityScopeFilter');

const DEFAULT_RANGE_DAYS = 30;
const MISSING_REPORT_THRESHOLD_MS = 60 * 60 * 1000;
const RECORDING_THRESHOLD_MS = 60 * 60 * 1000;
const PENDING_APPROVAL_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;
const ATTENTION_LIMIT = 50;

function trimText(value) {
  return String(value == null ? '' : value).trim();
}

function lowerText(value) {
  return trimText(value).toLowerCase();
}

function isNonEmptyObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseDateMs(value) {
  const raw = trimText(value);
  if (!raw) return 0;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function parseBoundary(value, endOfDay) {
  const raw = trimText(value);
  if (!raw) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = new Date(dateOnly ? `${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function metricsError(code, detail, status = 500, hint = null, requestId = null) {
  const error = new Error(detail || code);
  error.code = code;
  error.status = status;
  error.hint = hint;
  error.request_id = requestId;
  return error;
}

function parseMetricsDateRange(query = {}, now = new Date()) {
  const nowMs = now.getTime();
  const defaultFrom = new Date(nowMs - (DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000));
  const from = trimText(query.date_from) ? parseBoundary(query.date_from, false) : defaultFrom;
  const to = trimText(query.date_to) ? parseBoundary(query.date_to, true) : now;
  if (!from || !to || from.getTime() > to.getTime()) {
    throw metricsError(
      'invalid_date_range',
      'date_from and date_to must be valid dates, and date_from must be before date_to.',
      400
    );
  }
  return {
    from,
    to,
    date_from: from.toISOString(),
    date_to: to.toISOString(),
    date_from_display: isoDateOnly(from),
    date_to_display: isoDateOnly(to),
    default_range_days: DEFAULT_RANGE_DAYS,
  };
}

function safeErrorBody(error, requestId) {
  return {
    error: error?.code || 'admin_metrics_failed',
    code: error?.code || 'admin_metrics_failed',
    detail: error?.message || error?.detail || 'Could not load admin metrics.',
    hint: error?.hint || null,
    request_id: error?.request_id || requestId || null,
  };
}

function isMissingOptionalSchema(error) {
  const text = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''} ${error?.hint || ''}`.toLowerCase();
  return (
    text.includes('42p01') ||
    text.includes('42703') ||
    text.includes('pgrst205') ||
    text.includes('schema cache') ||
    text.includes('could not find') ||
    text.includes('does not exist') ||
    text.includes('column') && text.includes('not')
  );
}

function applyClientScope(query, clientIds, field = 'client_id') {
  if (!Array.isArray(clientIds)) return query;
  if (clientIds.length === 1) return query.eq(field, clientIds[0]);
  return query.in(field, clientIds);
}

async function readRows({
  db,
  table,
  columns,
  clientIds = null,
  clientField = 'client_id',
  roleId = null,
  dateField = null,
  dateRange = null,
  orderBy = null,
  ascending = false,
  limit = null,
  optional = false,
  warnings,
}) {
  if (Array.isArray(clientIds) && clientIds.length === 0) return [];

  let query = db.from(table).select(columns);
  query = applyClientScope(query, clientIds, clientField);
  if (roleId) query = query.eq('role_id', roleId);
  if (dateField && dateRange) {
    query = query.gte(dateField, dateRange.date_from).lte(dateField, dateRange.date_to);
  }
  if (orderBy) query = query.order(orderBy, { ascending });
  if (limit) query = query.limit(limit);

  const { data, error } = await query;
  if (error) {
    if (optional && isMissingOptionalSchema(error)) {
      warnings.push({
        table,
        code: error.code || 'optional_source_unavailable',
        detail: error.message || 'Optional metrics source is unavailable.',
      });
      return [];
    }
    throw metricsError(`${table}_query_failed`, error.message || `Could not query ${table}.`, 500, error.hint || null);
  }
  return toArray(data);
}

async function resolveMetricsScope({ db, req, query, requestId }) {
  const clientId = trimText(query.client_id);
  const entityFilter = trimText(query.entity_filter);
  if (!clientId || clientId === 'all') {
    return {
      selected_client_id: clientId || 'all',
      entity_filter: entityFilter || null,
      clientIds: null,
      entityScope: null,
      notes: [],
    };
  }

  if (!entityFilter) {
    return {
      selected_client_id: clientId,
      entity_filter: null,
      clientIds: [clientId],
      entityScope: null,
      notes: [],
    };
  }

  const resolved = await resolveEntityFilter({
    db,
    req: { ...req, isAdmin: true, isGlobalAdmin: true },
    clientId,
    entityFilter,
    requestId,
  });
  if (!resolved.ok) {
    const body = resolved.body || {};
    throw metricsError(
      body.code || body.error || 'entity_scope_failed',
      body.detail || body.error || 'Could not resolve entity filter.',
      resolved.status || 400,
      body.hint || null,
      requestId
    );
  }

  return {
    selected_client_id: clientId,
    entity_filter: entityFilter,
    clientIds: resolved.clientIds || [clientId],
    entityScope: resolved,
    notes: [],
  };
}

function countBy(rows, field) {
  const counts = {};
  for (const row of rows || []) {
    const key = lowerText(row?.[field]) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function isActiveClient(client) {
  return !trimText(client?.archived_at) && !trimText(client?.parent_client_id);
}

function isChildClient(client) {
  return Boolean(trimText(client?.parent_client_id));
}

function isActiveRole(role) {
  return lowerText(role?.status || 'active') !== 'inactive';
}

function candidateStatusForInterview(candidateById, interview) {
  const candidate = candidateById?.[trimText(interview?.candidate_id)];
  return lowerText(candidate?.interview_status || candidate?.status);
}

function isCompletedInterview(interview, context = {}) {
  const status = lowerText(interview?.status);
  if (status.includes('complete') || status === 'completed' || status === 'analyzed') return true;
  const candidateStatus = candidateStatusForInterview(context.candidateById, interview);
  if (candidateStatus.includes('complete')) return true;
  if (context.reportsByCandidateRole?.has(reportKey(interview?.candidate_id, interview?.role_id))) return true;
  return false;
}

function latestReportAtForInterview(reportCreatedAtByCandidateRole, interview) {
  return reportCreatedAtByCandidateRole?.[reportKey(interview?.candidate_id, interview?.role_id)] || null;
}

function interviewCompletedAt(interview, context = {}) {
  const status = lowerText(interview?.status);
  const candidateStatus = candidateStatusForInterview(context.candidateById, interview);
  const reportAt = latestReportAtForInterview(context.reportCreatedAtByCandidateRole, interview);
  if (reportAt) return reportAt;
  // The current interviews schema has no completed_at column. When a row or its
  // candidate has an explicit completed/analyzed status, updated_at is the safest
  // available completion proxy for delay thresholds.
  if (status.includes('complete') || status === 'completed' || status === 'analyzed' || candidateStatus.includes('complete')) {
    return trimText(interview?.updated_at) || trimText(interview?.created_at) || null;
  }
  return null;
}

function isTranscriptReady(interview) {
  return Boolean(
    trimText(interview?.transcript_url) ||
    trimText(interview?.transcript) ||
    trimText(interview?.interview_summary) ||
    isNonEmptyObject(interview?.transcript_scores) ||
    isNonEmptyObject(interview?.interview_analysis_v2)
  );
}

function recordingStatus(interview) {
  const status = lowerText(interview?.recording_status);
  if (trimText(interview?.recording_deleted_at) || status === 'deleted') return 'deleted';
  if (status === 'ready' || trimText(interview?.recording_ready_at)) return 'ready';
  if (
    status.includes('fail') ||
    status.includes('error') ||
    status.includes('problem') ||
    trimText(interview?.recording_delete_error)
  ) {
    return 'problem';
  }
  if (status || trimText(interview?.video_url)) return 'pending';
  return 'unknown';
}

function hasNoSubstanceOrDeletedRecording(interview) {
  const reason = lowerText(interview?.recording_delete_reason || interview?.delete_reason);
  return recordingStatus(interview) === 'deleted' || reason.includes('substance');
}

function reportKey(candidateId, roleId) {
  return `${trimText(candidateId)}::${trimText(roleId)}`;
}

function buildReportCreatedAtByCandidateRole(reports) {
  const byKey = {};
  for (const report of reports || []) {
    const key = reportKey(report?.candidate_id, report?.role_id);
    const createdAt = trimText(report?.created_at);
    if (!key || !createdAt) continue;
    const current = byKey[key];
    if (!current || parseDateMs(createdAt) > parseDateMs(current)) byKey[key] = createdAt;
  }
  return byKey;
}

function normalizeEmailEvent(row) {
  const type = lowerText(row?.event_type || row?.status);
  const status = lowerText(row?.status);
  const isProblem = row?.is_problem === true || row?.is_problem === 'true';
  if (
    isProblem ||
    ['bounce', 'bounced', 'dropped', 'drop', 'deferred', 'failed', 'failure', 'error', 'blocked', 'spamreport'].includes(type) ||
    ['bounce', 'bounced', 'dropped', 'failed', 'failure', 'error', 'problem'].includes(status)
  ) {
    return 'problem';
  }
  if (['open', 'opened', 'click', 'clicked'].includes(type)) return 'engagement';
  if (['processed', 'delivered', 'sent', 'send'].includes(type) || ['delivered', 'sent'].includes(status)) {
    return 'sent_delivered';
  }
  return 'unknown';
}

function sanitizeSummary(value, maxLength = 180) {
  const text = trimText(value)
    .replace(/[^@\s]+@[^@\s]+\.[^@\s]+/g, '***@***')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\b(token|secret|signature|password|apikey|api_key|key)=\S+/gi, '$1=REDACTED');
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function entityNameFor(clientById, clientId) {
  const client = clientById[trimText(clientId)];
  return client?.name || trimText(clientId) || null;
}

function parentClientNameFor(clientById, clientId) {
  const client = clientById[trimText(clientId)];
  const parentId = trimText(client?.parent_client_id);
  if (parentId && clientById[parentId]) return clientById[parentId].name || parentId;
  return client?.name || trimText(clientId) || null;
}

function roleTitleFor(roleById, roleId) {
  return roleById[trimText(roleId)]?.title || trimText(roleId) || null;
}

function candidateName(candidate) {
  return (
    trimText(candidate?.name) ||
    [candidate?.first_name, candidate?.last_name].map(trimText).filter(Boolean).join(' ') ||
    trimText(candidate?.id) ||
    null
  );
}

function ageLabel(value, now) {
  const then = parseDateMs(value);
  if (!then) return 'unknown';
  const minutes = Math.max(0, Math.round((now.getTime() - then) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function buildEntityOperations({ clients, roles, candidates, members }) {
  const clientById = Object.fromEntries(clients.map((client) => [client.id, client]));
  const parentRows = clients.filter((client) => !trimText(client.parent_client_id));
  const roleCounts = {};
  const candidateCounts = {};
  const memberCounts = {};

  for (const role of roles) roleCounts[role.client_id] = (roleCounts[role.client_id] || 0) + 1;
  for (const candidate of candidates) candidateCounts[candidate.client_id] = (candidateCounts[candidate.client_id] || 0) + 1;
  for (const member of members) memberCounts[member.client_id] = (memberCounts[member.client_id] || 0) + 1;

  const rows = parentRows.map((parent) => {
    const children = clients.filter((client) => trimText(client.parent_client_id) === parent.id);
    const ids = [parent.id, ...children.map((child) => child.id)];
    return {
      client_id: parent.id,
      client_name: parent.name || parent.id,
      child_entity_count: children.filter((child) => !trimText(child.archived_at)).length,
      archived_child_entity_count: children.filter((child) => trimText(child.archived_at)).length,
      member_count: ids.reduce((sum, id) => sum + (memberCounts[id] || 0), 0),
      role_count: ids.reduce((sum, id) => sum + (roleCounts[id] || 0), 0),
      candidate_count: ids.reduce((sum, id) => sum + (candidateCounts[id] || 0), 0),
    };
  });

  const byEntity = clients.map((client) => ({
    client_id: client.id,
    client_name: parentClientNameFor(clientById, client.id),
    entity_name: client.name || client.id,
    parent_client_id: client.parent_client_id || null,
    archived: Boolean(trimText(client.archived_at)),
    role_count: roleCounts[client.id] || 0,
    candidate_count: candidateCounts[client.id] || 0,
    member_count: memberCounts[client.id] || 0,
  }));

  return {
    parent_client_count: parentRows.length,
    child_entity_count: clients.filter((client) => isChildClient(client) && !trimText(client.archived_at)).length,
    archived_child_entity_count: clients.filter((client) => isChildClient(client) && trimText(client.archived_at)).length,
    member_count: members.length,
    rows: rows.sort((a, b) => b.candidate_count - a.candidate_count).slice(0, 50),
    by_entity: byEntity.sort((a, b) => b.candidate_count - a.candidate_count).slice(0, 75),
  };
}

function buildAttentionItems({
  now,
  clients,
  roles,
  candidates,
  interviews,
  reports,
  perceptionEvents,
  automationActions,
  digestDeliveries,
  emailEvents,
}) {
  const clientById = Object.fromEntries(clients.map((client) => [client.id, client]));
  const roleById = Object.fromEntries(roles.map((role) => [role.id, role]));
  const candidateById = Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate]));
  const reportKeys = new Set(reports.map((report) => reportKey(report.candidate_id, report.role_id)));
  const reportCreatedAtByCandidateRole = buildReportCreatedAtByCandidateRole(reports);
  const perceptionInterviewIds = new Set(perceptionEvents.map((event) => trimText(event.interview_id)).filter(Boolean));
  const items = [];
  const nowMs = now.getTime();

  for (const interview of interviews) {
    const completionContext = { candidateById, reportsByCandidateRole: reportKeys, reportCreatedAtByCandidateRole };
    const completedAt = interviewCompletedAt(interview, completionContext);
    const completedMs = parseDateMs(completedAt);
    if (!isCompletedInterview(interview, completionContext) || !completedMs) continue;
    const candidate = candidateById[trimText(interview.candidate_id)];
    const base = {
      client_id: interview.client_id || null,
      client_name: parentClientNameFor(clientById, interview.client_id),
      entity_name: entityNameFor(clientById, interview.client_id),
      role_id: interview.role_id || null,
      role_title: roleTitleFor(roleById, interview.role_id),
      candidate_id: interview.candidate_id || null,
      candidate_name: candidateName(candidate),
      created_at: completedAt,
      age: ageLabel(completedAt, now),
    };

    if (nowMs - completedMs > MISSING_REPORT_THRESHOLD_MS && !reportKeys.has(reportKey(interview.candidate_id, interview.role_id))) {
      items.push({
        type: 'missing_report',
        status: 'completed_no_report',
        suggested_action: 'Review report generation queue or regenerate from admin candidate details.',
        ...base,
      });
    }
    if (nowMs - completedMs > RECORDING_THRESHOLD_MS && recordingStatus(interview) === 'pending') {
      items.push({
        type: 'recording_pending',
        status: 'recording_pending_after_threshold',
        suggested_action: 'Check Tavus webhook and recording cleanup logs before launch.',
        ...base,
      });
    }
    if (nowMs - completedMs > RECORDING_THRESHOLD_MS && !isTranscriptReady(interview)) {
      items.push({
        type: 'transcript_missing',
        status: 'transcript_missing_after_threshold',
        suggested_action: 'Review interview webhook processing and transcript availability.',
        ...base,
      });
    }
    if (nowMs - completedMs > RECORDING_THRESHOLD_MS && !perceptionInterviewIds.has(trimText(interview.id))) {
      items.push({
        type: 'perception_missing',
        status: 'perception_missing_after_threshold',
        suggested_action: 'Check perception event webhook delivery for this interview.',
        ...base,
      });
    }
  }

  for (const action of automationActions) {
    const state = lowerText(action.state);
    const createdMs = parseDateMs(action.created_at);
    if (state === 'pending_approval' && createdMs && nowMs - createdMs > PENDING_APPROVAL_THRESHOLD_MS) {
      const candidate = candidateById[trimText(action.candidate_id)];
      items.push({
        type: 'pending_approval',
        client_id: action.client_id || null,
        client_name: parentClientNameFor(clientById, action.client_id),
        entity_name: entityNameFor(clientById, action.client_id),
        role_id: action.role_id || null,
        role_title: roleTitleFor(roleById, action.role_id),
        candidate_id: action.candidate_id || null,
        candidate_name: candidateName(candidate),
        status: 'pending_approval_over_3_days',
        age: ageLabel(action.created_at, now),
        created_at: action.created_at || null,
        suggested_action: 'Follow up with approver or review automation criteria.',
      });
    }
  }

  for (const digest of digestDeliveries) {
    if (lowerText(digest.status) !== 'failed') continue;
    items.push({
      type: 'digest_failed',
      client_id: digest.client_id || null,
      client_name: parentClientNameFor(clientById, digest.client_id),
      entity_name: entityNameFor(clientById, digest.client_id),
      role_id: digest.role_id || null,
      role_title: roleTitleFor(roleById, digest.role_id),
      candidate_id: null,
      candidate_name: null,
      status: 'digest_failed',
      age: ageLabel(digest.failed_at || digest.created_at, now),
      created_at: digest.failed_at || digest.created_at || null,
      suggested_action: 'Review digest delivery failure details in automation logs.',
    });
  }

  for (const event of emailEvents.filter((row) => normalizeEmailEvent(row) === 'problem').slice(0, 25)) {
    items.push({
      type: 'email_problem',
      client_id: null,
      client_name: 'Platform email',
      entity_name: null,
      role_id: null,
      role_title: null,
      candidate_id: null,
      candidate_name: null,
      status: trimText(event.event_type || event.status) || 'problem',
      age: ageLabel(event.event_at || event.created_at, now),
      created_at: event.event_at || event.created_at || null,
      detail: sanitizeSummary(event.reason || event.status),
      suggested_action: 'Review SendGrid event category and recipient suppression status.',
    });
  }

  const archivedClientIds = new Set(clients.filter((client) => trimText(client.archived_at)).map((client) => client.id));
  for (const role of roles) {
    if (!archivedClientIds.has(trimText(role.client_id)) || !isActiveRole(role)) continue;
    items.push({
      type: 'archived_entity_active_role',
      client_id: role.client_id || null,
      client_name: parentClientNameFor(clientById, role.client_id),
      entity_name: entityNameFor(clientById, role.client_id),
      role_id: role.id || null,
      role_title: role.title || role.id,
      candidate_id: null,
      candidate_name: null,
      status: 'active_role_on_archived_entity',
      age: ageLabel(role.created_at, now),
      created_at: role.created_at || null,
      suggested_action: 'Archive or move the role before go-live if this entity should stay inactive.',
    });
  }

  return items
    .sort((a, b) => parseDateMs(b.created_at) - parseDateMs(a.created_at))
    .slice(0, ATTENTION_LIMIT);
}

function tokenCounts(tokens, now) {
  const nowMs = now.getTime();
  let active = 0;
  let expired = 0;
  let revoked_or_used = 0;
  for (const token of tokens || []) {
    const state = lowerText(token.state);
    if (['revoked', 'used', 'rejected'].includes(state) || trimText(token.used_at)) {
      revoked_or_used += 1;
      continue;
    }
    const expiresMs = parseDateMs(token.expires_at);
    if (state === 'expired' || (expiresMs && expiresMs < nowMs)) expired += 1;
    else if (state === 'active') active += 1;
  }
  return { active, expired, revoked_or_used };
}

function envConfigured(env, keys) {
  return keys.some((key) => trimText(env?.[key]));
}

function envEnabled(env, key) {
  return ['true', '1', 'yes'].includes(lowerText(env?.[key]));
}

function schedulerSendEnabled(env) {
  return envEnabled(env, 'AUTOMATION_DIGEST_SCHEDULER_SEND_ENABLED');
}

function schedulerSecretConfigured(env) {
  return envConfigured(env, [
    'AUTOMATION_DIGEST_RUNNER_SECRET',
    'AUTOMATION_DIGEST_CRON_SECRET',
    'CONTRACTS_CRON_SECRET',
  ]);
}

function healthStatusFromProblems({ problem = 0, warning = 0, healthyWhenZero = true, unknownWhenZero = false }) {
  if (problem > 0) return 'problem';
  if (warning > 0) return 'warning';
  if (unknownWhenZero && healthyWhenZero && problem === 0 && warning === 0) return 'unknown';
  return 'healthy';
}

function estimateRecordingMinutes(interviews) {
  let seconds = 0;
  for (const interview of interviews || []) {
    const metadata = interview?.recording_metadata && typeof interview.recording_metadata === 'object'
      ? interview.recording_metadata
      : {};
    const candidates = [
      metadata.duration_seconds,
      metadata.duration_secs,
      metadata.duration,
      metadata.recording_duration_seconds,
      metadata.recording_duration,
      metadata.video_duration_seconds,
      metadata.video_duration,
    ];
    const nested = metadata.recording && typeof metadata.recording === 'object'
      ? [metadata.recording.duration_seconds, metadata.recording.duration]
      : [];
    for (const value of [...candidates, ...nested]) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        seconds += parsed > 1800 && parsed % 1 === 0 ? parsed : parsed;
        break;
      }
    }
  }
  return seconds > 0 ? Math.round(seconds / 60) : null;
}

function buildVendorUsage({
  now,
  dateRange,
  env,
  overview,
  readiness,
  emailCategoryCounts,
  interviews,
  reports,
  candidates,
  roles,
  clients,
  automationRules,
  automationActions,
  digestDeliveries,
  warnings,
}) {
  const lastChecked = now.toISOString();
  const recordingPendingOrProblem = Number(readiness.recording_pending || 0) + Number(readiness.recording_problem || 0);
  const estimatedVideoMinutes = estimateRecordingMinutes(interviews);
  const openaiConfigured = envConfigured(env, ['OPENAI_API_KEY']);
  const tavusConfigured = envConfigured(env, ['TAVUS_API_KEY']);
  const supabaseConfigured = envConfigured(env, ['SUPABASE_URL']) && envConfigured(env, ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_ANON_KEY']);
  const sendgridConfigured = envConfigured(env, ['SENDGRID_API_KEY']);
  const renderConfigured = envConfigured(env, ['RENDER_API_KEY', 'RENDER_SERVICE_ID']);
  const sentryConfigured = envEnabled(env, 'SENTRY_ENABLED') && envConfigured(env, ['SENTRY_DSN']);

  const reportProblemCount = Number(readiness.missing_report_after_complete || 0);
  const videoProblemCount = Number(readiness.recording_problem || 0) + Number(readiness.perception_missing_after_video_completion || 0);
  const emailProblemCount = Number(emailCategoryCounts.problem || 0);

  return {
    period: {
      date_from: dateRange.date_from,
      date_to: dateRange.date_to,
      date_from_display: dateRange.date_from_display,
      date_to_display: dateRange.date_to_display,
    },
    services: [
      {
        key: 'openai',
        name: 'OpenAI / Scoring',
        status: reportProblemCount > 0 ? 'warning' : reports.length > 0 ? 'healthy' : 'unknown',
        configured: openaiConfigured,
        source: 'database_estimate',
        current_period: {
          reports_generated: Number(overview.reports_generated || 0),
          missing_reports_after_complete: reportProblemCount,
          transcript_ready: Number(readiness.transcript_ready || 0),
          interviews_completed_proxy: Number(overview.interviews_completed || 0),
        },
        estimated_cost: null,
        notes: [
          openaiConfigured ? 'OpenAI key presence is confirmed without exposing the key.' : 'Live OpenAI usage API is not configured for this admin page.',
          'Usage is estimated from reports and scoring readiness stored in the database.',
        ],
        last_checked: lastChecked,
      },
      {
        key: 'tavus',
        name: 'Tavus / Video',
        status: videoProblemCount > 0 ? 'problem' : recordingPendingOrProblem > 0 ? 'warning' : interviews.length > 0 ? 'healthy' : 'unknown',
        configured: tavusConfigured,
        source: 'database_estimate',
        current_period: {
          interviews_started: Number(overview.interviews_started || 0),
          recording_ready: Number(readiness.recording_ready || 0),
          recording_pending: Number(readiness.recording_pending || 0),
          recording_problem: Number(readiness.recording_problem || 0),
          recording_deleted: Number(readiness.recording_deleted || 0),
          perception_events_received: Number(readiness.perception_event_received || 0),
          perception_missing_after_completion: Number(readiness.perception_missing_after_video_completion || 0),
          estimated_minutes: estimatedVideoMinutes,
        },
        estimated_cost: null,
        notes: [
          tavusConfigured ? 'Tavus key presence is confirmed without exposing the key.' : 'Live Tavus usage API is not configured for this admin page.',
          estimatedVideoMinutes === null ? 'Recording duration metadata was not available for a minute estimate.' : 'Estimated minutes come from recording metadata only.',
        ],
        last_checked: lastChecked,
      },
      {
        key: 'supabase',
        name: 'Supabase',
        status: warnings.length ? 'warning' : 'healthy',
        configured: supabaseConfigured,
        source: 'environment_check',
        current_period: {
          clients_loaded: clients.length,
          roles_loaded: roles.length,
          candidates_loaded: candidates.length,
          interviews_loaded: interviews.length,
          reports_loaded: reports.length,
        },
        estimated_cost: null,
        notes: [
          'Database is reachable because the metrics query completed.',
          warnings.length ? `${warnings.length} optional source warning(s) were returned.` : 'No optional source warnings were returned.',
        ],
        last_checked: lastChecked,
      },
      {
        key: 'sendgrid',
        name: 'SendGrid',
        status: emailProblemCount > 0 ? 'problem' : Object.values(emailCategoryCounts).some((count) => Number(count) > 0) ? 'healthy' : 'unknown',
        configured: sendgridConfigured,
        source: 'database_estimate',
        current_period: {
          sent_delivered: Number(emailCategoryCounts.sent_delivered || 0),
          engagement: Number(emailCategoryCounts.engagement || 0),
          problem: emailProblemCount,
          unknown: Number(emailCategoryCounts.unknown || 0),
        },
        estimated_cost: null,
        notes: [
          sendgridConfigured ? 'SendGrid key presence is confirmed without exposing the key.' : 'Live SendGrid usage API is not configured for this admin page.',
          'email_delivery_events currently lacks client_id, so SendGrid metrics are platform-wide for the selected date range.',
        ],
        last_checked: lastChecked,
      },
      {
        key: 'render',
        name: 'Render',
        status: renderConfigured ? 'unknown' : 'not_configured',
        configured: renderConfigured,
        source: 'not_available',
        current_period: {},
        estimated_cost: null,
        notes: [
          renderConfigured ? 'Render configuration presence is detected, but no live Render API integration is used here.' : 'No live Render usage source is configured.',
        ],
        last_checked: lastChecked,
      },
      {
        key: 'sentry',
        name: 'Sentry',
        status: sentryConfigured ? 'unknown' : 'not_configured',
        configured: sentryConfigured,
        source: 'environment_check',
        current_period: {},
        estimated_cost: null,
        notes: [
          sentryConfigured ? 'Sentry is configured for backend capture, but live issue counts are not integrated here.' : 'No live Sentry usage source is configured.',
        ],
        last_checked: lastChecked,
      },
    ],
  };
}

function buildHealthSummary({
  now,
  env,
  overview,
  readiness,
  emailCategoryCounts,
  automationRules,
  automationActions,
  digestDeliveries,
  warnings,
}) {
  const lastChecked = now.toISOString();
  const schedulerEnabled = schedulerSendEnabled(env);
  const schedulerSecret = schedulerSecretConfigured(env);
  const automationConfigured = automationRules.length > 0 || automationActions.length > 0 || digestDeliveries.length > 0;
  const interviewProblems = Number(readiness.missing_report_after_complete || 0) + Number(readiness.recording_problem || 0) + Number(readiness.perception_missing_after_video_completion || 0);
  const interviewWarnings = Number(readiness.recording_pending || 0);
  const emailProblems = Number(emailCategoryCounts.problem || 0);
  const videoProblems = Number(readiness.recording_problem || 0) + Number(readiness.perception_missing_after_video_completion || 0);
  const videoWarnings = Number(readiness.recording_pending || 0);
  const scoringProblems = Number(readiness.missing_report_after_complete || 0);
  const sentryConfigured = envEnabled(env, 'SENTRY_ENABLED') && envConfigured(env, ['SENTRY_DSN']);

  return [
    {
      key: 'backend_api',
      label: 'Backend API',
      status: 'healthy',
      detail: 'Current admin metrics request succeeded.',
      source: 'current_request',
      last_checked: lastChecked,
    },
    {
      key: 'database',
      label: 'Database',
      status: warnings.length ? 'warning' : 'healthy',
      detail: warnings.length ? `${warnings.length} optional source warning(s).` : 'Metrics queries completed.',
      source: 'database',
      last_checked: lastChecked,
    },
    {
      key: 'interview_pipeline',
      label: 'Interview pipeline',
      status: healthStatusFromProblems({ problem: interviewProblems, warning: interviewWarnings, unknownWhenZero: Number(overview.interviews_started || 0) === 0 }),
      detail: `${Number(overview.interviews_completed || 0)} completed proxy, ${interviewProblems} readiness issue(s).`,
      source: 'database_estimate',
      last_checked: lastChecked,
    },
    {
      key: 'automation_scheduler',
      label: 'Automation scheduler',
      status: !automationConfigured ? 'unknown' : schedulerEnabled && schedulerSecret ? 'healthy' : 'warning',
      detail: schedulerEnabled && schedulerSecret ? 'Send guard and scheduler secret are configured.' : 'Scheduler send guard or secret is not fully configured.',
      source: 'environment_check',
      last_checked: lastChecked,
    },
    {
      key: 'email_delivery',
      label: 'Email delivery',
      status: emailProblems > 0 ? 'problem' : Object.values(emailCategoryCounts).some((count) => Number(count) > 0) ? 'healthy' : 'unknown',
      detail: `${emailProblems} platform email problem event(s) in range.`,
      source: 'database_estimate',
      last_checked: lastChecked,
    },
    {
      key: 'tavus_video',
      label: 'Tavus / Video',
      status: healthStatusFromProblems({ problem: videoProblems, warning: videoWarnings, unknownWhenZero: Number(overview.interviews_started || 0) === 0 }),
      detail: `${Number(readiness.recording_ready || 0)} recording(s) ready, ${videoProblems + videoWarnings} pending/problem.`,
      source: 'database_estimate',
      last_checked: lastChecked,
    },
    {
      key: 'openai_scoring',
      label: 'OpenAI / Scoring',
      status: scoringProblems > 0 ? 'warning' : Number(overview.reports_generated || 0) > 0 ? 'healthy' : 'unknown',
      detail: `${Number(overview.reports_generated || 0)} report(s), ${scoringProblems} missing after threshold.`,
      source: 'database_estimate',
      last_checked: lastChecked,
    },
    {
      key: 'error_monitoring',
      label: 'Error monitoring',
      status: sentryConfigured ? 'unknown' : 'not_configured',
      detail: sentryConfigured ? 'Sentry configured; live issue counts are not integrated.' : 'No Sentry live metrics source configured.',
      source: 'environment_check',
      last_checked: lastChecked,
    },
  ];
}

function buildSourceSummary(rowsByName, warnings, scopeNotes) {
  return {
    row_counts: Object.fromEntries(Object.entries(rowsByName).map(([key, rows]) => [key, rows.length])),
    warnings,
    scope_notes: scopeNotes,
  };
}

async function buildAdminMetricsPayload({ db, req = {}, query = {}, requestId = null, now = new Date(), env = process.env }) {
  const warnings = [];
  const dateRange = parseMetricsDateRange(query, now);
  const scope = await resolveMetricsScope({ db, req, query, requestId });
  const roleId = trimText(query.role_id) || null;
  const scopedClientIds = Array.isArray(scope.clientIds) ? scope.clientIds : null;
  const scopeNotes = [
    ...scope.notes,
    'Interview completion uses interviews.status, candidate completed status, or matching report rows; interviews.completed_at is not present in the current schema.',
    'Email delivery events are date-filtered platform-wide because email_delivery_events does not store client_id in the current schema.',
    'Approval link metrics count token state and expiry only; token hashes, salts, recipients, and raw links are never selected or returned.',
  ];
  if (roleId) {
    scopeNotes.push('role_id filters metrics with direct role_id columns; approval token counts remain client-scoped.');
  }

  const [
    clients,
    roles,
    candidates,
    interviews,
    reports,
    perceptionEvents,
    emailEvents,
    automationRules,
    automationEvaluations,
    automationActions,
    digestDeliveries,
    actionTokens,
    digestTokens,
    members,
  ] = await Promise.all([
    readRows({ db, table: 'clients', columns: 'id,name,parent_client_id,entity_label,archived_at', clientIds: scopedClientIds, clientField: 'id', orderBy: 'name', ascending: true, warnings }),
    readRows({ db, table: 'roles', columns: 'id,title,client_id,status,created_at', clientIds: scopedClientIds, orderBy: 'created_at', roleId, warnings }),
    readRows({ db, table: 'candidates', columns: 'id,client_id,role_id,name,first_name,last_name,status,interview_status,created_at', clientIds: scopedClientIds, roleId, dateField: 'created_at', dateRange, orderBy: 'created_at', warnings }),
    readRows({ db, table: 'interviews', columns: 'id,client_id,role_id,candidate_id,created_at,updated_at,status,video_url,transcript_url,transcript,transcript_scores,interview_summary,interview_analysis_v2,perception_scores,recording_status,recording_ready_at,recording_metadata,recording_deleted_at,recording_delete_reason,recording_delete_error', clientIds: scopedClientIds, roleId, dateField: 'created_at', dateRange, orderBy: 'created_at', warnings }),
    readRows({ db, table: 'reports', columns: 'id,client_id,role_id,candidate_id,created_at', clientIds: scopedClientIds, roleId, dateField: 'created_at', dateRange, orderBy: 'created_at', warnings }),
    readRows({ db, table: 'interview_perception_events', columns: 'id,client_id,interview_id,event_type,received_at', clientIds: scopedClientIds, dateField: 'received_at', dateRange, orderBy: 'received_at', optional: true, warnings }),
    readRows({ db, table: 'email_delivery_events', columns: 'id,created_at,event_at,event_type,email_category,category,status,is_problem,reason', dateField: 'created_at', dateRange, orderBy: 'created_at', optional: true, warnings }),
    readRows({ db, table: 'automation_rules', columns: 'id,client_id,role_id,enabled,archived_at,created_at,updated_at', clientIds: scopedClientIds, roleId, orderBy: 'updated_at', optional: true, warnings }),
    readRows({ db, table: 'automation_evaluations', columns: 'id,client_id,role_id,matched,evaluation_status,created_at', clientIds: scopedClientIds, roleId, dateField: 'created_at', dateRange, orderBy: 'created_at', optional: true, warnings }),
    readRows({ db, table: 'automation_actions', columns: 'id,client_id,role_id,candidate_id,state,created_at,updated_at,approved_at,rejected_at,sent_at,failed_at', clientIds: scopedClientIds, roleId, dateField: 'created_at', dateRange, orderBy: 'created_at', optional: true, warnings }),
    readRows({ db, table: 'automation_digest_deliveries', columns: 'id,client_id,role_id,status,delivery_date,action_count,sent_at,failed_at,created_at,updated_at', clientIds: scopedClientIds, roleId, dateField: 'created_at', dateRange, orderBy: 'created_at', optional: true, warnings }),
    readRows({ db, table: 'automation_action_approval_tokens', columns: 'id,client_id,action_id,state,expires_at,used_at,created_at', clientIds: scopedClientIds, dateField: 'created_at', dateRange, orderBy: 'created_at', optional: true, warnings }),
    readRows({ db, table: 'automation_digest_approval_tokens', columns: 'id,client_id,delivery_id,state,expires_at,created_at', clientIds: scopedClientIds, dateField: 'created_at', dateRange, orderBy: 'created_at', optional: true, warnings }),
    readRows({ db, table: 'client_members', columns: 'client_id,user_id,role,created_at', clientIds: scopedClientIds, orderBy: 'created_at', optional: true, warnings }),
  ]);

  const clientById = Object.fromEntries(clients.map((client) => [client.id, client]));
  const reportsByCandidateRole = new Set(reports.map((report) => reportKey(report.candidate_id, report.role_id)));
  const reportCreatedAtByCandidateRole = buildReportCreatedAtByCandidateRole(reports);
  const candidateById = Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate]));
  const completionContext = { candidateById, reportsByCandidateRole, reportCreatedAtByCandidateRole };
  const completedInterviews = interviews.filter((interview) => isCompletedInterview(interview, completionContext));
  const transcriptReady = interviews.filter(isTranscriptReady);
  const missingReportAfterComplete = completedInterviews.filter((interview) => {
    const completedMs = parseDateMs(interviewCompletedAt(interview, completionContext));
    return completedMs && now.getTime() - completedMs > MISSING_REPORT_THRESHOLD_MS &&
      !reportsByCandidateRole.has(reportKey(interview.candidate_id, interview.role_id));
  });
  const perceptionInterviewIds = new Set(perceptionEvents.map((event) => trimText(event.interview_id)).filter(Boolean));
  const perceptionMissing = completedInterviews.filter((interview) => {
    const completedMs = parseDateMs(interviewCompletedAt(interview, completionContext));
    return completedMs && now.getTime() - completedMs > RECORDING_THRESHOLD_MS && !perceptionInterviewIds.has(trimText(interview.id));
  });
  const recordingCounts = interviews.reduce((counts, interview) => {
    const status = recordingStatus(interview);
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
  const emailCategoryCounts = emailEvents.reduce((counts, event) => {
    const category = normalizeEmailEvent(event);
    counts[category] = (counts[category] || 0) + 1;
    return counts;
  }, {});
  const actionStateCounts = countBy(automationActions, 'state');
  const digestStatusCounts = countBy(digestDeliveries, 'status');
  const evaluationStatusCounts = countBy(automationEvaluations, 'evaluation_status');
  const ruleStatusCounts = {
    enabled: automationRules.filter((rule) => rule.enabled === true && !trimText(rule.archived_at)).length,
    paused: automationRules.filter((rule) => rule.enabled !== true && !trimText(rule.archived_at)).length,
    archived: automationRules.filter((rule) => trimText(rule.archived_at)).length,
  };
  const actionApprovalTokenCounts = tokenCounts(actionTokens, now);
  const digestApprovalTokenCounts = tokenCounts(digestTokens, now);
  const entityOperations = buildEntityOperations({ clients, roles, candidates, members });
  const attentionItems = buildAttentionItems({
    now,
    clients,
    roles,
    candidates,
    interviews,
    reports,
    perceptionEvents,
    automationActions,
    digestDeliveries,
    emailEvents,
  });
  const overview = {
    active_clients: clients.filter(isActiveClient).length,
    active_roles: roles.filter(isActiveRole).length,
    candidates_in_range: candidates.length,
    interviews_started: interviews.length,
    interviews_completed: completedInterviews.length,
    reports_generated: reports.length,
    automation_pending_approvals: actionStateCounts.pending_approval || 0,
    email_delivery_failures: emailCategoryCounts.problem || 0,
  };
  const readiness = {
    recording_ready: recordingCounts.ready || 0,
    recording_pending: recordingCounts.pending || 0,
    recording_problem: recordingCounts.problem || 0,
    recording_deleted: recordingCounts.deleted || 0,
    report_generated: reports.length,
    missing_report_after_complete: missingReportAfterComplete.length,
    perception_event_received: perceptionEvents.length,
    perception_missing_after_video_completion: perceptionMissing.length,
    transcript_ready: transcriptReady.length,
  };
  const healthSummary = buildHealthSummary({
    now,
    env,
    overview,
    readiness,
    emailCategoryCounts,
    automationRules,
    automationActions,
    digestDeliveries,
    warnings,
  });
  const vendorUsage = buildVendorUsage({
    now,
    dateRange,
    env,
    overview,
    readiness,
    emailCategoryCounts,
    interviews,
    reports,
    candidates,
    roles,
    clients,
    automationRules,
    automationActions,
    digestDeliveries,
    warnings,
  });

  return {
    ok: true,
    request_id: requestId || null,
    generated_at: now.toISOString(),
    filters: {
      selected_client_id: scope.selected_client_id,
      entity_filter: scope.entity_filter,
      scoped_client_ids: scopedClientIds,
      role_id: roleId,
      date_from: dateRange.date_from,
      date_to: dateRange.date_to,
      date_from_display: dateRange.date_from_display,
      date_to_display: dateRange.date_to_display,
      default_range_days: DEFAULT_RANGE_DAYS,
    },
    health_summary: healthSummary,
    vendor_usage: vendorUsage,
    overview,
    interview_funnel: [
      { key: 'candidate_created', label: 'Candidate created', count: candidates.length },
      { key: 'interview_started', label: 'Interview started', count: interviews.length },
      { key: 'interview_completed', label: 'Interview completed', count: completedInterviews.length },
      { key: 'transcript_ready', label: 'Transcript ready', count: transcriptReady.length },
      { key: 'report_generated', label: 'Report generated', count: reports.length },
      { key: 'recording_ready', label: 'Recording ready', count: recordingCounts.ready || 0 },
      {
        key: 'recording_no_substance_or_deleted',
        label: 'No-substance/failed/deleted recordings',
        count: interviews.filter(hasNoSubstanceOrDeletedRecording).length + (recordingCounts.problem || 0),
      },
    ],
    automation: {
      rule_status_counts: ruleStatusCounts,
      evaluation_status_counts: evaluationStatusCounts,
      evaluations_matched: automationEvaluations.filter((row) => row.matched === true).length,
      action_state_counts: actionStateCounts,
      digest_status_counts: digestStatusCounts,
      approval_links: {
        action: actionApprovalTokenCounts,
        digest: digestApprovalTokenCounts,
        active: actionApprovalTokenCounts.active + digestApprovalTokenCounts.active,
        expired: actionApprovalTokenCounts.expired + digestApprovalTokenCounts.expired,
      },
      pending_approvals: actionStateCounts.pending_approval || 0,
      approved_actions: actionStateCounts.approved || 0,
      rejected_actions: actionStateCounts.rejected || 0,
      sent_actions: (actionStateCounts.sent || 0) + (actionStateCounts.delivered || 0),
      failed_actions: actionStateCounts.failed || 0,
    },
    email: {
      normalized_counts: {
        sent_delivered: emailCategoryCounts.sent_delivered || 0,
        engagement: emailCategoryCounts.engagement || 0,
        problem: emailCategoryCounts.problem || 0,
        unknown: emailCategoryCounts.unknown || 0,
      },
      event_type_counts: countBy(emailEvents, 'event_type'),
      recent_problem_events: emailEvents
        .filter((event) => normalizeEmailEvent(event) === 'problem')
        .slice(0, 20)
        .map((event) => ({
          id: event.id || null,
          event_at: event.event_at || event.created_at || null,
          event_type: event.event_type || event.status || 'problem',
          category: event.email_category || event.category || null,
          detail: sanitizeSummary(event.reason || event.status),
        })),
      scope: 'platform_date_range',
    },
    readiness,
    entity_operations: entityOperations,
    attention: {
      thresholds: {
        missing_report_minutes: Math.round(MISSING_REPORT_THRESHOLD_MS / 60000),
        recording_or_transcript_minutes: Math.round(RECORDING_THRESHOLD_MS / 60000),
        pending_approval_days: Math.round(PENDING_APPROVAL_THRESHOLD_MS / (24 * 60 * 60 * 1000)),
      },
      items: attentionItems,
    },
    sources: buildSourceSummary({
      clients,
      roles,
      candidates,
      interviews,
      reports,
      interview_perception_events: perceptionEvents,
      email_delivery_events: emailEvents,
      automation_rules: automationRules,
      automation_evaluations: automationEvaluations,
      automation_actions: automationActions,
      automation_digest_deliveries: digestDeliveries,
      automation_action_approval_tokens: actionTokens,
      automation_digest_approval_tokens: digestTokens,
      client_members: members,
    }, warnings, scopeNotes),
    entities_by_id: Object.fromEntries(Object.entries(clientById).map(([id, client]) => [id, {
      id,
      name: client.name || id,
      parent_client_id: client.parent_client_id || null,
      archived: Boolean(trimText(client.archived_at)),
    }])),
  };
}

module.exports = {
  DEFAULT_RANGE_DAYS,
  parseMetricsDateRange,
  normalizeEmailEvent,
  buildAdminMetricsPayload,
  safeErrorBody,
};
