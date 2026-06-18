'use strict';

const { resolveEntityFilter, uniqueIds } = require('./entityScopeFilter');

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

function isCompletedInterview(interview) {
  if (parseDateMs(interview?.completed_at)) return true;
  const status = lowerText(interview?.interview_status || interview?.status);
  return status.includes('complete') || status === 'completed';
}

function interviewCompletedAt(interview) {
  return (
    trimText(interview?.completed_at) ||
    trimText(interview?.interview_completed_at) ||
    trimText(interview?.updated_at) ||
    trimText(interview?.created_at) ||
    null
  );
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
  const perceptionInterviewIds = new Set(perceptionEvents.map((event) => trimText(event.interview_id)).filter(Boolean));
  const items = [];
  const nowMs = now.getTime();

  for (const interview of interviews) {
    const completedAt = interviewCompletedAt(interview);
    const completedMs = parseDateMs(completedAt);
    if (!isCompletedInterview(interview) || !completedMs) continue;
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

function buildSourceSummary(rowsByName, warnings, scopeNotes) {
  return {
    row_counts: Object.fromEntries(Object.entries(rowsByName).map(([key, rows]) => [key, rows.length])),
    warnings,
    scope_notes: scopeNotes,
  };
}

async function buildAdminMetricsPayload({ db, req = {}, query = {}, requestId = null, now = new Date() }) {
  const warnings = [];
  const dateRange = parseMetricsDateRange(query, now);
  const scope = await resolveMetricsScope({ db, req, query, requestId });
  const roleId = trimText(query.role_id) || null;
  const scopedClientIds = Array.isArray(scope.clientIds) ? scope.clientIds : null;
  const scopeNotes = [
    ...scope.notes,
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
    readRows({ db, table: 'interviews', columns: 'id,client_id,role_id,candidate_id,created_at,updated_at,completed_at,interview_status,video_url,transcript_url,transcript,transcript_scores,interview_summary,interview_analysis_v2,perception_scores,recording_status,recording_ready_at,recording_deleted_at,recording_delete_reason,recording_delete_error', clientIds: scopedClientIds, roleId, dateField: 'created_at', dateRange, orderBy: 'created_at', warnings }),
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
  const completedInterviews = interviews.filter(isCompletedInterview);
  const transcriptReady = interviews.filter(isTranscriptReady);
  const reportsByCandidateRole = new Set(reports.map((report) => reportKey(report.candidate_id, report.role_id)));
  const missingReportAfterComplete = completedInterviews.filter((interview) => {
    const completedMs = parseDateMs(interviewCompletedAt(interview));
    return completedMs && now.getTime() - completedMs > MISSING_REPORT_THRESHOLD_MS &&
      !reportsByCandidateRole.has(reportKey(interview.candidate_id, interview.role_id));
  });
  const perceptionInterviewIds = new Set(perceptionEvents.map((event) => trimText(event.interview_id)).filter(Boolean));
  const perceptionMissing = completedInterviews.filter((interview) => {
    const completedMs = parseDateMs(interviewCompletedAt(interview));
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
    overview: {
      active_clients: clients.filter(isActiveClient).length,
      active_roles: roles.filter(isActiveRole).length,
      candidates_in_range: candidates.length,
      interviews_started: interviews.length,
      interviews_completed: completedInterviews.length,
      reports_generated: reports.length,
      automation_pending_approvals: actionStateCounts.pending_approval || 0,
      email_delivery_failures: emailCategoryCounts.problem || 0,
    },
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
    readiness: {
      recording_ready: recordingCounts.ready || 0,
      recording_pending: recordingCounts.pending || 0,
      recording_problem: recordingCounts.problem || 0,
      recording_deleted: recordingCounts.deleted || 0,
      report_generated: reports.length,
      missing_report_after_complete: missingReportAfterComplete.length,
      perception_event_received: perceptionEvents.length,
      perception_missing_after_video_completion: perceptionMissing.length,
      transcript_ready: transcriptReady.length,
    },
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
