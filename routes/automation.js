'use strict';

const express = require('express');
const { supabaseAdmin } = require('../src/lib/supabaseClient');
const { requireAuth, withClientScope } = require('../src/middleware/auth');
const {
  buildClientScopeContext,
  canCreateRolesForClient
} = require('../src/lib/clientScope');
const {
  evaluateCandidateAutomation,
  normalizeCriteriaConfig,
  stableStringify
} = require('../src/lib/candidateAutomationEvaluator');
const {
  createPendingAutomationAction,
  listAutomationActions,
  listAutomationActionEvents,
  writeAutomationActionEvent
} = require('../src/lib/automationActions');
const {
  createApprovalTokenForAction,
  loadApprovalTokenContext,
  markApprovalTokenViewed,
  rejectActionFromApprovalToken
} = require('../src/lib/automationApprovalTokens');

const router = express.Router();
const db = supabaseAdmin;

const RULE_SELECT = [
  'id',
  'client_id',
  'role_id',
  'enabled',
  'mode',
  'criteria_config',
  'action_config',
  'digest_config',
  'rule_version',
  'created_by_user_id',
  'created_by_email',
  'updated_by_user_id',
  'updated_by_email',
  'archived_at',
  'created_at',
  'updated_at'
].join(',');

const EVALUATION_SELECT = [
  'id',
  'rule_id',
  'rule_version',
  'client_id',
  'role_id',
  'candidate_id',
  'report_id',
  'interview_id',
  'trigger_source',
  'matched',
  'evaluation_status',
  'criteria_config_snapshot',
  'normalized_candidate_snapshot',
  'match_reasons',
  'non_match_reasons',
  'score_snapshot_hash',
  'idempotency_key',
  'request_id',
  'created_at'
].join(',');

const ACTION_SELECT = [
  'id',
  'evaluation_id',
  'rule_id',
  'rule_version',
  'client_id',
  'role_id',
  'candidate_id',
  'report_id',
  'interview_id',
  'action_type',
  'state',
  'idempotency_key',
  'candidate_snapshot',
  'action_snapshot',
  'approved_by_user_id',
  'approved_by_email',
  'approved_at',
  'rejected_at',
  'canceled_at',
  'sent_at',
  'failed_at',
  'last_error',
  'send_attempt_count',
  'created_at',
  'updated_at'
].join(',');

function requestId(req) {
  return req.request_id || req.headers['x-request-id'] || req.headers['x-correlation-id'] || null;
}

function sendError(res, status, payload = {}) {
  return res.status(status).json({
    error: payload.error || payload.code || 'server_error',
    code: payload.code || payload.error || 'server_error',
    detail: payload.detail || null,
    hint: payload.hint || null,
    request_id: payload.request_id || null
  });
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toRequiredId(value, code) {
  const id = String(value || '').trim();
  if (!id) {
    const err = new Error(code);
    err.status = 400;
    err.code = code;
    err.detail = code.replace(/_/g, ' ');
    throw err;
  }
  return id;
}

function normalizeEnabled(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true || value === false) return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  const err = new Error('enabled must be a boolean.');
  err.status = 400;
  err.code = 'invalid_enabled';
  err.detail = 'enabled must be a boolean.';
  throw err;
}

function normalizeJsonObject(value, fieldName, fallback = {}) {
  if (value === undefined) return fallback;
  if (!isPlainObject(value)) {
    const err = new Error(`${fieldName} must be a JSON object.`);
    err.status = 400;
    err.code = `invalid_${fieldName}`;
    err.detail = `${fieldName} must be a JSON object.`;
    throw err;
  }
  return value;
}

function buildScopeContext(req) {
  const memberships =
    (Array.isArray(req?.clientScope?.memberships) && req.clientScope.memberships) ||
    (Array.isArray(req?.memberships) && req.memberships) ||
    [];
  const clients = memberships.map((membership) => membership?.client).filter(Boolean);
  return buildClientScopeContext({ memberships, clients });
}

function canConfigureAutomation(req, clientId) {
  if (req?.isGlobalAdmin === true || req?.isAdmin === true) return true;
  const id = String(clientId || '').trim();
  if (!id) return false;
  const scopeContext = buildScopeContext(req);
  return canCreateRolesForClient(scopeContext, id);
}

function configurableClientIds(req) {
  if (req?.isGlobalAdmin === true || req?.isAdmin === true) return null;
  const scopeContext = buildScopeContext(req);
  return Array.from(new Set((scopeContext.accessibleClientIds || [])
    .map((id) => String(id || '').trim())
    .filter((id) => id && canCreateRolesForClient(scopeContext, id))));
}

function resolveClientId(req) {
  return String(
    req.query?.client_id ||
    req.body?.client_id ||
    req.client?.id ||
    req.clientScope?.defaultClientId ||
    ''
  ).trim();
}

function cleanUserEmail(req) {
  return String(req?.user?.email || '').trim() || null;
}

function actorFromRequest(req) {
  return {
    type: req?.isGlobalAdmin === true || req?.isAdmin === true ? 'admin' : 'user',
    userId: req?.user?.id || null,
    email: cleanUserEmail(req)
  };
}

function normalizeLimit(value, fallback = 100, max = 500) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

async function loadRoleForClient(roleId, clientId) {
  const { data, error } = await db
    .from('roles')
    .select('id,client_id,title')
    .eq('id', roleId)
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) {
    const err = new Error(error.message || 'role_lookup_failed');
    err.status = 500;
    err.code = 'role_lookup_failed';
    err.detail = error.message || 'Role lookup failed.';
    err.hint = error.hint || null;
    throw err;
  }
  return data || null;
}

async function loadCandidateForClient(candidateId, clientId, roleId = null) {
  let query = db
    .from('candidates')
    .select('id,client_id,role_id')
    .eq('id', candidateId)
    .eq('client_id', clientId);
  if (roleId) query = query.eq('role_id', roleId);

  const { data, error } = await query.maybeSingle();
  if (error) {
    const err = new Error(error.message || 'candidate_lookup_failed');
    err.status = 500;
    err.code = 'candidate_lookup_failed';
    err.detail = error.message || 'Candidate lookup failed.';
    err.hint = error.hint || null;
    throw err;
  }
  return data || null;
}

async function loadCandidateForClientRole(candidateId, clientId, roleId) {
  const { data, error } = await db
    .from('candidates')
    .select('id,client_id,role_id')
    .eq('id', candidateId)
    .eq('client_id', clientId)
    .eq('role_id', roleId)
    .maybeSingle();
  if (error) {
    const err = new Error(error.message || 'candidate_lookup_failed');
    err.status = 500;
    err.code = 'candidate_lookup_failed';
    err.detail = error.message || 'Candidate lookup failed.';
    err.hint = error.hint || null;
    throw err;
  }
  return data || null;
}

async function loadAction(actionId, clientIds = null) {
  if (Array.isArray(clientIds) && clientIds.length === 0) return null;
  let query = db
    .from('automation_actions')
    .select(ACTION_SELECT)
    .eq('id', actionId);
  if (Array.isArray(clientIds)) query = query.in('client_id', clientIds);

  const { data, error } = await query.maybeSingle();
  if (error) {
    const err = new Error(error.message || 'automation_action_lookup_failed');
    err.status = 500;
    err.code = 'automation_action_lookup_failed';
    err.detail = error.message || 'Automation action lookup failed.';
    err.hint = error.hint || null;
    throw err;
  }
  return data || null;
}

async function loadRule(ruleId, clientIds = null) {
  if (Array.isArray(clientIds) && clientIds.length === 0) return null;
  let query = db
    .from('automation_rules')
    .select(RULE_SELECT)
    .eq('id', ruleId)
    .is('archived_at', null);
  if (Array.isArray(clientIds)) query = query.in('client_id', clientIds);

  const { data, error } = await query.maybeSingle();
  if (error) {
    const err = new Error(error.message || 'automation_rule_lookup_failed');
    err.status = 500;
    err.code = 'automation_rule_lookup_failed';
    err.detail = error.message || 'Automation rule lookup failed.';
    err.hint = error.hint || null;
    throw err;
  }
  return data || null;
}

function handleCaughtError(res, req, err, fallbackCode = 'server_error') {
  const status = Number.isFinite(Number(err?.status)) ? Number(err.status) : 500;
  const code = err?.code || fallbackCode;
  if (status >= 500) {
    console.error('[automation] unexpected', {
      request_id: requestId(req),
      code,
      error: err?.message || err
    });
  }
  return sendError(res, status, {
    error: status >= 500 ? 'server_error' : code,
    code,
    detail: err?.detail || (status >= 500 ? 'Server error.' : err?.message || null),
    hint: err?.hint || null,
    request_id: requestId(req)
  });
}

function setApprovalNoStore(res) {
  res.set('Cache-Control', 'no-store');
}

function sendApprovalTokenUnavailable(res, req, context = {}) {
  const reason = String(context?.reason || '').trim();
  const expired = reason === 'expired';
  setApprovalNoStore(res);
  return res.status(expired ? 410 : 404).json({
    ok: false,
    error: expired ? 'approval_token_expired' : 'approval_token_invalid',
    code: expired ? 'approval_token_expired' : 'approval_token_invalid',
    detail: expired
      ? 'This approval link has expired or is no longer available.'
      : 'This approval link is invalid or no longer available.',
    request_id: requestId(req)
  });
}

function buildApprovalActionSummary({ action, tokenRow } = {}) {
  const snapshot = isPlainObject(action?.candidate_snapshot) ? action.candidate_snapshot : {};
  const cleanText = (value) => String(value || '').trim() || null;
  return {
    action_id: action?.id || null,
    state: action?.state || null,
    candidate_name: cleanText(snapshot.candidate_name),
    role_title: cleanText(snapshot.role_title),
    scores: {
      overall_score: snapshot.overall_score ?? null,
      resume_score: snapshot.resume_score ?? null,
      interview_score: snapshot.interview_score ?? null
    },
    content_sufficiency: isPlainObject(snapshot.content_sufficiency)
      ? snapshot.content_sufficiency
      : null,
    expires_at: tokenRow?.expires_at || null
  };
}

async function persistDryRunEvaluation({
  req,
  rule,
  clientId,
  roleId,
  candidateId,
  result,
  triggerSource = 'dry_run'
}) {
  const payload = {
    rule_id: rule?.id || null,
    rule_version: rule?.rule_version || null,
    client_id: clientId,
    role_id: roleId,
    candidate_id: candidateId,
    report_id: result.reportId || null,
    interview_id: result.interviewId || null,
    trigger_source: triggerSource,
    matched: result.matched,
    evaluation_status: result.evaluationStatus,
    criteria_config_snapshot: result.criteriaConfigSnapshot,
    normalized_candidate_snapshot: result.normalizedCandidateSnapshot,
    match_reasons: result.matchReasons,
    non_match_reasons: result.nonMatchReasons,
    score_snapshot_hash: result.scoreSnapshotHash,
    idempotency_key: result.idempotencyKey,
    request_id: requestId(req)
  };

  const { data, error } = await db
    .from('automation_evaluations')
    .insert(payload)
    .select(EVALUATION_SELECT)
    .maybeSingle();

  if (!error) return { row: data || null, deduped: false };

  if (String(error?.code || '') === '23505') {
    const existing = await db
      .from('automation_evaluations')
      .select(EVALUATION_SELECT)
      .eq('idempotency_key', result.idempotencyKey)
      .maybeSingle();
    if (existing.error) {
      const err = new Error(existing.error.message || 'automation_evaluation_lookup_failed');
      err.status = 500;
      err.code = 'automation_evaluation_lookup_failed';
      err.detail = existing.error.message || 'Automation evaluation lookup failed.';
      err.hint = existing.error.hint || null;
      throw err;
    }
    return { row: existing.data || null, deduped: true };
  }

  const err = new Error(error.message || 'automation_evaluation_insert_failed');
  err.status = 500;
  err.code = 'automation_evaluation_insert_failed';
  err.detail = error.message || 'Automation evaluation insert failed.';
  err.hint = error.hint || null;
  throw err;
}

function evaluationResponse({ result, persisted, rule }) {
  const row = persisted?.row || null;
  return {
    ok: true,
    evaluation: {
      id: row?.id || null,
      rule_id: rule?.id || null,
      rule_version: rule?.rule_version || null,
      matched: result.matched,
      evaluation_status: result.evaluationStatus,
      normalized_candidate_snapshot: result.normalizedCandidateSnapshot,
      criteria_config_snapshot: result.criteriaConfigSnapshot,
      score_snapshot_hash: result.scoreSnapshotHash,
      match_reasons: result.matchReasons,
      non_match_reasons: result.nonMatchReasons,
      report_id: result.reportId || null,
      interview_id: result.interviewId || null,
      idempotency_key: result.idempotencyKey,
      deduped: Boolean(persisted?.deduped),
      created_at: row?.created_at || null
    },
    side_effects: {
      actions_created: 0,
      emails_sent: 0,
      digests_sent: 0
    }
  };
}

router.get('/rules', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const clientId = resolveClientId(req);
    const roleId = String(req.query?.role_id || '').trim();
    if (!clientId) {
      return sendError(res, 400, {
        error: 'client_id_required',
        code: 'client_id_required',
        detail: 'client_id is required.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, clientId)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to configure automation for this client.',
        request_id
      });
    }
    if (roleId) {
      const role = await loadRoleForClient(roleId, clientId);
      if (!role) {
        return sendError(res, 404, {
          error: 'not_found',
          code: 'role_not_found',
          detail: 'Role not found.',
          request_id
        });
      }
    }

    let query = db
      .from('automation_rules')
      .select(RULE_SELECT)
      .eq('client_id', clientId)
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(500);
    if (roleId) query = query.eq('role_id', roleId);
    const { data, error } = await query;
    if (error) {
      return sendError(res, 500, {
        error: 'server_error',
        code: 'automation_rules_lookup_failed',
        detail: error.message,
        hint: error.hint || null,
        request_id
      });
    }
    return res.json({ ok: true, items: data || [], request_id });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_rules_lookup_failed');
  }
});

router.post('/rules', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const clientId = toRequiredId(req.body?.client_id, 'client_id_required');
    const roleId = toRequiredId(req.body?.role_id, 'role_id_required');
    const mode = String(req.body?.mode || 'daily_digest_pending_approval').trim();
    if (mode !== 'daily_digest_pending_approval') {
      return sendError(res, 400, {
        error: 'invalid_mode',
        code: 'invalid_mode',
        detail: 'mode must be daily_digest_pending_approval.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, clientId)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to configure automation for this client.',
        request_id
      });
    }
    const role = await loadRoleForClient(roleId, clientId);
    if (!role) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'role_not_found',
        detail: 'Role not found.',
        request_id
      });
    }

    const payload = {
      client_id: clientId,
      role_id: roleId,
      enabled: normalizeEnabled(req.body?.enabled, false),
      mode,
      criteria_config: normalizeCriteriaConfig(normalizeJsonObject(req.body?.criteria_config, 'criteria_config', {})),
      action_config: normalizeJsonObject(req.body?.action_config, 'action_config', {}),
      digest_config: normalizeJsonObject(req.body?.digest_config, 'digest_config', {}),
      created_by_user_id: req.user?.id || null,
      created_by_email: cleanUserEmail(req),
      updated_by_user_id: req.user?.id || null,
      updated_by_email: cleanUserEmail(req)
    };

    const { data, error } = await db
      .from('automation_rules')
      .insert(payload)
      .select(RULE_SELECT)
      .maybeSingle();

    if (error) {
      if (String(error.code || '') === '23505') {
        return sendError(res, 409, {
          error: 'automation_rule_already_exists',
          code: 'automation_rule_already_exists',
          detail: 'This role already has a current automation rule.',
          request_id
        });
      }
      return sendError(res, 500, {
        error: 'server_error',
        code: 'automation_rule_create_failed',
        detail: error.message,
        hint: error.hint || null,
        request_id
      });
    }
    return res.status(201).json({ ok: true, item: data, request_id });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_rule_create_failed');
  }
});

router.patch('/rules/:id', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const ruleId = toRequiredId(req.params?.id, 'rule_id_required');
    const rule = await loadRule(ruleId, configurableClientIds(req));
    if (!rule) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'automation_rule_not_found',
        detail: 'Automation rule not found.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, rule.client_id)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to configure automation for this client.',
        request_id
      });
    }

    const updates = {
      updated_by_user_id: req.user?.id || null,
      updated_by_email: cleanUserEmail(req),
      updated_at: new Date().toISOString()
    };
    let hasEditableField = false;
    let configChanged = false;

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'enabled')) {
      updates.enabled = normalizeEnabled(req.body.enabled, rule.enabled === true);
      hasEditableField = true;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'criteria_config')) {
      const next = normalizeCriteriaConfig(normalizeJsonObject(req.body.criteria_config, 'criteria_config'));
      updates.criteria_config = next;
      hasEditableField = true;
      if (stableStringify(next) !== stableStringify(rule.criteria_config || {})) configChanged = true;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'action_config')) {
      const next = normalizeJsonObject(req.body.action_config, 'action_config');
      updates.action_config = next;
      hasEditableField = true;
      if (stableStringify(next) !== stableStringify(rule.action_config || {})) configChanged = true;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'digest_config')) {
      const next = normalizeJsonObject(req.body.digest_config, 'digest_config');
      updates.digest_config = next;
      hasEditableField = true;
      if (stableStringify(next) !== stableStringify(rule.digest_config || {})) configChanged = true;
    }

    if (!hasEditableField) {
      return sendError(res, 400, {
        error: 'no_update_fields',
        code: 'no_update_fields',
        detail: 'Provide enabled, criteria_config, action_config, or digest_config.',
        request_id
      });
    }
    if (configChanged) {
      updates.rule_version = Math.max(1, Number(rule.rule_version || 1)) + 1;
    }

    const { data, error } = await db
      .from('automation_rules')
      .update(updates)
      .eq('id', rule.id)
      .is('archived_at', null)
      .select(RULE_SELECT)
      .maybeSingle();

    if (error) {
      return sendError(res, 500, {
        error: 'server_error',
        code: 'automation_rule_update_failed',
        detail: error.message,
        hint: error.hint || null,
        request_id
      });
    }
    if (!data) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'automation_rule_not_found',
        detail: 'Automation rule not found.',
        request_id
      });
    }
    return res.json({ ok: true, item: data, request_id });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_rule_update_failed');
  }
});

router.post('/rules/:id/dry-run', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const ruleId = toRequiredId(req.params?.id, 'rule_id_required');
    const candidateId = toRequiredId(req.body?.candidate_id, 'candidate_id_required');
    const rule = await loadRule(ruleId, configurableClientIds(req));
    if (!rule) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'automation_rule_not_found',
        detail: 'Automation rule not found.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, rule.client_id)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to configure automation for this client.',
        request_id
      });
    }
    const candidate = await loadCandidateForClientRole(candidateId, rule.client_id, rule.role_id);
    if (!candidate) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'candidate_not_found',
        detail: 'Candidate not found.',
        request_id
      });
    }

    const result = await evaluateCandidateAutomation({
      db,
      clientId: rule.client_id,
      roleId: rule.role_id,
      candidateId,
      criteriaConfig: rule.criteria_config || {},
      triggerSource: 'dry_run',
      ruleId: rule.id,
      ruleVersion: rule.rule_version,
      requestId: request_id
    });
    const persisted = await persistDryRunEvaluation({
      req,
      rule,
      clientId: rule.client_id,
      roleId: rule.role_id,
      candidateId,
      result
    });
    return res.json(evaluationResponse({ result, persisted, rule }));
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_dry_run_failed');
  }
});

router.post('/rules/:id/evaluate-action', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const ruleId = toRequiredId(req.params?.id, 'rule_id_required');
    const candidateId = toRequiredId(req.body?.candidate_id, 'candidate_id_required');
    const rule = await loadRule(ruleId, configurableClientIds(req));
    if (!rule) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'automation_rule_not_found',
        detail: 'Automation rule not found.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, rule.client_id)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to configure automation for this client.',
        request_id
      });
    }
    if (rule.enabled !== true) {
      return sendError(res, 409, {
        error: 'automation_rule_disabled',
        code: 'automation_rule_disabled',
        detail: 'Automation rule must be enabled before creating pending approval actions.',
        request_id
      });
    }
    const candidate = await loadCandidateForClientRole(candidateId, rule.client_id, rule.role_id);
    if (!candidate) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'candidate_not_found',
        detail: 'Candidate not found.',
        request_id
      });
    }

    const result = await evaluateCandidateAutomation({
      db,
      clientId: rule.client_id,
      roleId: rule.role_id,
      candidateId,
      criteriaConfig: rule.criteria_config || {},
      triggerSource: 'manual',
      ruleId: rule.id,
      ruleVersion: rule.rule_version,
      requestId: request_id
    });
    const persisted = await persistDryRunEvaluation({
      req,
      rule,
      clientId: rule.client_id,
      roleId: rule.role_id,
      candidateId,
      result,
      triggerSource: 'manual'
    });
    const actionOutcome = await createPendingAutomationAction({
      db,
      evaluationRow: persisted?.row || null,
      evaluationResult: result,
      rule,
      actor: actorFromRequest(req),
      requestId: request_id
    });
    const base = evaluationResponse({ result, persisted, rule });
    const actionsCreated = actionOutcome?.action && !actionOutcome?.deduped && !actionOutcome?.skipped ? 1 : 0;
    return res.json({
      ...base,
      action: actionOutcome?.action || null,
      side_effects: {
        actions_created: actionsCreated,
        emails_sent: 0,
        digests_sent: 0
      }
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_evaluate_action_failed');
  }
});

router.post('/dry-run/candidate', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const clientId = toRequiredId(req.body?.client_id, 'client_id_required');
    const roleId = toRequiredId(req.body?.role_id, 'role_id_required');
    const candidateId = toRequiredId(req.body?.candidate_id, 'candidate_id_required');
    const criteriaConfig = normalizeCriteriaConfig(normalizeJsonObject(req.body?.criteria_config, 'criteria_config', {}));
    if (!canConfigureAutomation(req, clientId)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to configure automation for this client.',
        request_id
      });
    }
    const role = await loadRoleForClient(roleId, clientId);
    if (!role) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'role_not_found',
        detail: 'Role not found.',
        request_id
      });
    }
    const candidate = await loadCandidateForClientRole(candidateId, clientId, roleId);
    if (!candidate) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'candidate_not_found',
        detail: 'Candidate not found.',
        request_id
      });
    }

    const result = await evaluateCandidateAutomation({
      db,
      clientId,
      roleId,
      candidateId,
      criteriaConfig,
      triggerSource: 'dry_run',
      requestId: request_id
    });
    const persisted = await persistDryRunEvaluation({
      req,
      rule: null,
      clientId,
      roleId,
      candidateId,
      result
    });
    return res.json(evaluationResponse({ result, persisted, rule: null }));
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_dry_run_failed');
  }
});

router.get('/actions', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const clientId = resolveClientId(req);
    const roleId = String(req.query?.role_id || '').trim();
    const candidateId = String(req.query?.candidate_id || '').trim();
    const state = String(req.query?.state || '').trim();
    const limit = normalizeLimit(req.query?.limit, 100, 500);

    if (!clientId) {
      return sendError(res, 400, {
        error: 'client_id_required',
        code: 'client_id_required',
        detail: 'client_id is required.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, clientId)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to view automation actions for this client.',
        request_id
      });
    }
    if (roleId) {
      const role = await loadRoleForClient(roleId, clientId);
      if (!role) {
        return sendError(res, 404, {
          error: 'not_found',
          code: 'role_not_found',
          detail: 'Role not found.',
          request_id
        });
      }
    }
    if (candidateId) {
      const candidate = await loadCandidateForClient(candidateId, clientId, roleId || null);
      if (!candidate) {
        return sendError(res, 404, {
          error: 'not_found',
          code: 'candidate_not_found',
          detail: 'Candidate not found.',
          request_id
        });
      }
    }

    const items = await listAutomationActions({
      db,
      clientId,
      roleId: roleId || null,
      candidateId: candidateId || null,
      state: state || null,
      limit
    });
    return res.json({ ok: true, items, request_id });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_actions_lookup_failed');
  }
});

router.post('/actions/:id/approval-token', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const actionId = toRequiredId(req.params?.id, 'action_id_required');
    const action = await loadAction(actionId, configurableClientIds(req));
    if (!action) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'automation_action_not_found',
        detail: 'Automation action not found.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, action.client_id)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to create approval tokens for this automation action.',
        request_id
      });
    }
    if (action.state !== 'pending_approval') {
      return sendError(res, 409, {
        error: 'invalid_action_state',
        code: 'invalid_action_state',
        detail: 'Only pending approval actions can receive approval tokens.',
        request_id
      });
    }

    const outcome = await createApprovalTokenForAction({
      db,
      action,
      recipientUserId: req.body?.recipient_user_id || req.body?.recipientUserId || null,
      recipientEmail: req.body?.recipient_email || req.body?.recipientEmail || null,
      expiresInHours: req.body?.expires_in_hours ?? req.body?.expiresInHours,
      requestId: request_id
    });

    return res.status(201).json({
      ok: true,
      approval_url_path: `/automation/approval/${outcome.token}`,
      token: outcome.token,
      expires_at: outcome.expires_at,
      request_id
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_approval_token_create_failed');
  }
});

router.get('/actions/:id/events', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const actionId = toRequiredId(req.params?.id, 'action_id_required');
    const action = await loadAction(actionId, configurableClientIds(req));
    if (!action) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'automation_action_not_found',
        detail: 'Automation action not found.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, action.client_id)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to view events for this automation action.',
        request_id
      });
    }

    const items = await listAutomationActionEvents({
      db,
      actionId: action.id,
      clientId: action.client_id,
      limit: normalizeLimit(req.query?.limit, 100, 500)
    });
    return res.json({ ok: true, items, request_id });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_action_events_lookup_failed');
  }
});

router.get('/approval/:token', async (req, res) => {
  const request_id = requestId(req);
  setApprovalNoStore(res);
  try {
    const context = await loadApprovalTokenContext({
      db,
      token: req.params?.token
    });
    if (!context.valid) {
      return sendApprovalTokenUnavailable(res, req, context);
    }

    const viewedToken = await markApprovalTokenViewed({
      db,
      tokenRow: context.tokenRow,
      requestId: request_id
    });

    return res.json({
      ok: true,
      item: buildApprovalActionSummary({
        action: context.action,
        tokenRow: viewedToken || context.tokenRow
      }),
      request_id
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_approval_token_lookup_failed');
  }
});

router.post('/approval/:token/reject', async (req, res) => {
  const request_id = requestId(req);
  setApprovalNoStore(res);
  try {
    const context = await loadApprovalTokenContext({
      db,
      token: req.params?.token
    });
    if (!context.valid) {
      return sendApprovalTokenUnavailable(res, req, context);
    }

    const outcome = await rejectActionFromApprovalToken({
      db,
      tokenRow: context.tokenRow,
      action: context.action,
      actor: { type: 'system' },
      requestId: request_id
    });

    return res.json({
      ok: true,
      state: outcome?.action?.state || 'rejected',
      side_effects: {
        actions_created: 0,
        emails_sent: 0,
        digests_sent: 0
      },
      request_id
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_approval_token_reject_failed');
  }
});

router.post('/actions/:id/reject', requireAuth, withClientScope, async (req, res) => {
  const request_id = requestId(req);
  try {
    const actionId = toRequiredId(req.params?.id, 'action_id_required');
    const action = await loadAction(actionId, configurableClientIds(req));
    if (!action) {
      return sendError(res, 404, {
        error: 'not_found',
        code: 'automation_action_not_found',
        detail: 'Automation action not found.',
        request_id
      });
    }
    if (!canConfigureAutomation(req, action.client_id)) {
      return sendError(res, 403, {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'You do not have access to reject this automation action.',
        request_id
      });
    }
    if (action.state !== 'pending_approval') {
      return sendError(res, 409, {
        error: 'invalid_action_state',
        code: 'invalid_action_state',
        detail: 'Only pending approval actions can be rejected.',
        request_id
      });
    }

    const now = new Date().toISOString();
    const { data, error } = await db
      .from('automation_actions')
      .update({
        state: 'rejected',
        rejected_at: now,
        updated_at: now
      })
      .eq('id', action.id)
      .eq('state', 'pending_approval')
      .select(ACTION_SELECT)
      .maybeSingle();

    if (error) {
      return sendError(res, 500, {
        error: 'server_error',
        code: 'automation_action_reject_failed',
        detail: error.message,
        hint: error.hint || null,
        request_id
      });
    }
    if (!data) {
      return sendError(res, 409, {
        error: 'invalid_action_state',
        code: 'invalid_action_state',
        detail: 'Only pending approval actions can be rejected.',
        request_id
      });
    }

    const event = await writeAutomationActionEvent({
      db,
      actionId: data.id,
      clientId: data.client_id,
      eventType: 'action_rejected',
      fromState: 'pending_approval',
      toState: 'rejected',
      actor: actorFromRequest(req),
      requestId: request_id,
      metadata: null
    });

    return res.json({
      ok: true,
      item: data,
      event,
      side_effects: {
        actions_created: 0,
        emails_sent: 0,
        digests_sent: 0
      },
      request_id
    });
  } catch (err) {
    return handleCaughtError(res, req, err, 'automation_action_reject_failed');
  }
});

module.exports = router;
