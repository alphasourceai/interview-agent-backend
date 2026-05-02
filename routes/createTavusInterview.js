// routes/createTavusInterview.js
'use strict';

const express = require('express');
const Sentry = require('@sentry/node');
const { supabase, supabaseAdmin } = require('../src/lib/supabaseClient');
const { createTavusInterviewHandler } = require('../handlers/createTavusInterview');
const { getRoleInterviewAvailability, syncRoleInterviewLimitNotification } = require('../src/lib/roleInterviewAvailability');
const { getRequestSubjectKey, checkAndIncrementRateLimit } = require('../src/lib/rateLimit');
const { isRoleInactive, buildRoleInactivePayload, logInactiveRoleBlocked } = require('../src/lib/roleLifecycle');
const { resolvePublicBackendBase } = require('../config/urlConfig');

const router = express.Router();
const BILLING_MODE = String(process.env.BILLING_MODE || 'off').toLowerCase();
const BILLING_ENFORCED = BILLING_MODE === 'enforce';
const CREATE_TAVUS_RATE_WINDOW_MS = 15 * 60 * 1000;
const CREATE_TAVUS_RATE_MAX = 10;

async function createTavusRateLimit(req, res, next) {
  try {
    const result = await checkAndIncrementRateLimit({
      routeName: 'create_tavus_interview',
      subjectKey: getRequestSubjectKey(req),
      windowMs: CREATE_TAVUS_RATE_WINDOW_MS,
      maxCount: CREATE_TAVUS_RATE_MAX
    });
    if (!result.allowed) {
      return res.status(429).json({
        error: 'rate_limited',
        code: 'RATE_LIMIT_EXCEEDED',
        detail: 'Too many requests. Please try again later.'
      });
    }
  } catch (error) {
    console.error('[rate-limit] create tavus interview check failed', {
      request_id: req.request_id || null,
      error: error?.message || error
    });
    return res.status(503).json({
      error: 'rate_limit_unavailable',
      code: 'RATE_LIMIT_UNAVAILABLE',
      detail: 'Request protection is temporarily unavailable. Please try again shortly.'
    });
  }
  return next();
}

router.post('/', createTavusRateLimit, async (req, res) => {
  const request_id = req.request_id || null;
  let sentryCandidateId = null;
  let sentryRoleId = null;
  let sentryClientId = null;
  Sentry.setTag('route_name', 'create_tavus_interview');
  Sentry.setTag('surface', 'backend');
  if (request_id) Sentry.setTag('request_id', String(request_id));
  try {
    const launchFailed = (reason, details = {}) => {
      console.warn('[create-tavus-interview] launch_failed', {
        request_id,
        reason,
        ...details
      });
      const payload = {
        error: 'launch_failed',
        code: 'LAUNCH_FAILED',
        detail: 'We could not start this interview. Please restart from the interview link and try again.'
      };
      if (request_id) payload.request_id = request_id;
      return res.status(400).json(payload);
    };
    const computedBase = `${req.protocol}://${req.get('host')}`;
    const base = resolvePublicBackendBase(computedBase);

    const {
      candidate_id,
      role_id: roleIdFromBody,
      roleToken,
      role_token
    } = req.body || {};
    sentryCandidateId = candidate_id || null;
    if (sentryCandidateId) Sentry.setTag('candidate_id', String(sentryCandidateId));
    const roleTokenFromBody = roleToken || role_token || null;
    if (!candidate_id) return res.status(400).json({ error: 'candidate_id required' });

    // candidate
    const { data: candidate, error: cErr } = await supabase
      .from('candidates')
      .select('*')
      .eq('id', candidate_id)
      .single();
    if (cErr || !candidate) {
      return launchFailed('candidate_not_found', {
        candidate_id,
        error: cErr?.message || null,
        code: cErr?.code || null
      });
    }
    Sentry.addBreadcrumb({
      category: 'create_tavus_interview',
      message: 'candidate loaded',
      level: 'info',
      data: { candidate_id }
    });

    const candidateRoleId = String(candidate?.role_id || '').trim();
    const candidateClientId = String(candidate?.client_id || '').trim();
    let role = null;
    let roleId = String(roleIdFromBody || '').trim();

    if (roleTokenFromBody) {
      const { data: roleByToken, error: rtErr } = await supabase
        .from('roles')
        .select('*')
        .eq('slug_or_token', roleTokenFromBody)
        .limit(1)
        .maybeSingle();
      if (rtErr) {
        return res.status(500).json({ error: rtErr.message });
      }
      if (!roleByToken) {
        return launchFailed('role_token_not_found', {
          role_token: roleTokenFromBody
        });
      }
      if (String(roleByToken.id || '') !== candidateRoleId) {
        return launchFailed('candidate_role_mismatch', {
          candidate_id,
          role_id: roleByToken.id || null
        });
      }
      role = roleByToken;
      roleId = String(roleByToken.id || '').trim();
    }
    sentryRoleId = roleId || candidateRoleId || null;
    if (sentryRoleId) Sentry.setTag('role_id', String(sentryRoleId));

    if (roleId && roleId !== candidateRoleId) {
      return launchFailed('candidate_role_mismatch', {
        candidate_id,
        role_id: roleId
      });
    }

    if (!roleId && !roleTokenFromBody && candidateRoleId) {
      roleId = candidateRoleId;
    }

    if (!role) {
      if (!roleId) {
        return launchFailed('missing_role_binding_context', {
          candidate_id,
          candidate_role_id: candidateRoleId || null
        });
      }
      const { data: roleById, error: rErr } = await supabase
        .from('roles')
        .select('*')
        .eq('id', roleId)
        .single();
      if (rErr || !roleById) {
        return launchFailed('role_id_not_found', {
          candidate_id,
          role_id: roleId,
          error: rErr?.message || null,
          code: rErr?.code || null
        });
      }
      role = roleById;
    }
    sentryRoleId = String(role?.id || roleId || '').trim() || null;
    if (sentryRoleId) Sentry.setTag('role_id', String(sentryRoleId));
    Sentry.addBreadcrumb({
      category: 'create_tavus_interview',
      message: 'role loaded',
      level: 'info',
      data: { role_id: sentryRoleId }
    });

    if (String(role?.id || '') !== candidateRoleId) {
      return launchFailed('candidate_role_mismatch', {
        candidate_id,
        role_id: role?.id || null
      });
    }

    if (candidateClientId && String(role?.client_id || '').trim() && String(role.client_id || '').trim() !== candidateClientId) {
      return launchFailed('candidate_client_mismatch', {
        candidate_id,
        candidate_client_id: candidateClientId || null,
        role_client_id: role?.client_id || null
      });
    }

    if (isRoleInactive(role)) {
      logInactiveRoleBlocked(console, {
        route_name: 'create_tavus_interview',
        request_id,
        role_id: role?.id || roleId || null
      });
      return res.status(403).json(buildRoleInactivePayload(request_id));
    }

    const clientId = role.client_id || candidate.client_id || null;
    sentryClientId = clientId || null;
    if (sentryClientId) Sentry.setTag('client_id', String(sentryClientId));
    if (!clientId) {
      return launchFailed('missing_role_binding_context', {
        candidate_id,
        role_id: role?.id || roleId || null
      });
    }
    let candidateAssistanceContact = '';
    let maxInterviewMinutes = null;
    try {
      const { data: planSettings } = await supabaseAdmin
        .from('client_plan_settings')
        .select('max_interview_minutes')
        .eq('client_id', clientId)
        .maybeSingle();
      const parsedMaxInterviewMinutes = Number(planSettings?.max_interview_minutes);
      if (Number.isFinite(parsedMaxInterviewMinutes) && parsedMaxInterviewMinutes > 0) {
        maxInterviewMinutes = Math.floor(parsedMaxInterviewMinutes);
      }
    } catch (_) {}
    if (BILLING_ENFORCED) {
      const { data: client, error: clientErr } = await supabase
        .from('clients')
        .select('id,billing_status,manual_active_override,access_override_mode,candidate_assistance_contact')
        .eq('id', clientId)
        .maybeSingle();

      if (clientErr || !client) {
        return res.status(500).json({
          error: 'server_error',
          code: 'CLIENT_LOOKUP_FAILED',
          detail: clientErr?.message || 'Failed to load client record',
          hint: clientErr?.hint || null,
          request_id
        });
      }
      Sentry.addBreadcrumb({
        category: 'create_tavus_interview',
        message: 'client loaded',
        level: 'info',
        data: { client_id: clientId }
      });
      const accessOverrideMode = String(client.access_override_mode || 'inherit').toLowerCase();
      if (accessOverrideMode === 'force_inactive' || (accessOverrideMode !== 'force_active' && client.billing_status !== 'active')) {
        return res.status(403).json({
          error: 'forbidden',
          code: 'CLIENT_INACTIVE',
          detail: 'Interviewing service is currently inactive for this employer.',
          hint: client.candidate_assistance_contact || 'Please contact the employer.',
          request_id
        });
      }
      candidateAssistanceContact = String(client.candidate_assistance_contact || '').trim();
    } else {
      try {
        const { data: client } = await supabase
          .from('clients')
          .select('candidate_assistance_contact')
          .eq('id', clientId)
          .maybeSingle();
        candidateAssistanceContact = String(client?.candidate_assistance_contact || '').trim();
      } catch {}
    }

    // Check for existing interview row
    const { data: existing, error: eErr } = await supabase
      .from('interviews')
      .select('id, tavus_application_id')
      .eq('candidate_id', candidate_id)
      .eq('role_id', roleId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (eErr) return res.status(500).json({ error: eErr.message });

    if (!existing) {
      const availability = await getRoleInterviewAvailability({
        db: supabaseAdmin,
        roleId,
        clientId
      });
      await syncRoleInterviewLimitNotification({
        db: supabaseAdmin,
        roleId,
        clientId,
        remainingInterviews: availability.remaining_interviews,
        roleTitle: role?.title || ''
      });
      if (availability.remaining_interviews != null && availability.remaining_interviews <= 0) {
        Sentry.addBreadcrumb({
          category: 'create_tavus_interview',
          message: 'interview limit reached',
          level: 'info',
          data: { role_id: roleId, client_id: clientId }
        });
        return res.status(403).json({
          error: 'forbidden',
          code: 'interview_limit_reached',
          detail: 'This role has no interviews remaining under the current plan.',
          hint: null,
          request_id
        });
      }
    }

    const webhookUrl = `${base}/webhook/tavus`;

    // Tavus
    Sentry.addBreadcrumb({
      category: 'create_tavus_interview',
      message: 'tavus launch started',
      level: 'info',
      data: { candidate_id, role_id: roleId, client_id: clientId }
    });
    const result = await createTavusInterviewHandler(candidate, role, webhookUrl, {
      maxInterviewMinutes
    });
    Sentry.addBreadcrumb({
      category: 'create_tavus_interview',
      message: 'tavus launch succeeded',
      level: 'info',
      data: { conversation_id: result?.conversation_id || null }
    });

    // Immediately reflect on candidate
    await supabase
      .from('candidates')
      .update({
        interview_status: 'Started',
        interview_video_url: result.conversation_url || null,
        candidate_external_id: result.conversation_id || null
      })
      .eq('id', candidate_id);

    // Stamp linkage on existing report rows for this candidate (if any)
    await supabase
      .from('reports')
      .update({
        role_id: role.id,
        client_id: clientId,
        candidate_external_id: result.conversation_id || null
      })
      .eq('candidate_id', candidate_id);

    if (!existing) {
      const { error: iErr, data: iData } = await supabase
        .from('interviews')
        .insert({
          candidate_id,
          client_id: clientId,
          role_id: roleId,
          video_url: result.conversation_url || null,
          tavus_application_id: result.conversation_id || null,
          status: 'Pending'
        })
        .select('id')
        .single();
      if (iErr) return res.status(500).json({ error: iErr.message });

      return res.status(200).json({
        message: 'Interview created',
        conversation_url: result.conversation_url || null,
        conversation_id: result.conversation_id || null,
        interview_id: iData.id,
        max_interview_minutes: maxInterviewMinutes,
        candidate_assistance_contact: candidateAssistanceContact || null
      });
    } else {
      const { error: uErr } = await supabase
        .from('interviews')
        .update({
          client_id: clientId,
          video_url: result.conversation_url || null,
          tavus_application_id: result.conversation_id || existing.tavus_application_id || null,
          status: 'Pending'
        })
        .eq('id', existing.id);
      if (uErr) return res.status(500).json({ error: uErr.message });

      return res.status(200).json({
        message: 'Interview updated',
        conversation_url: result.conversation_url || null,
        conversation_id: result.conversation_id || existing.tavus_application_id || null,
        interview_id: existing.id,
        max_interview_minutes: maxInterviewMinutes,
        candidate_assistance_contact: candidateAssistanceContact || null
      });
    }
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) {
      Sentry.captureException(e, {
        tags: {
          route_name: 'create_tavus_interview',
          surface: 'backend',
          request_id: request_id || undefined,
          candidate_id: sentryCandidateId || undefined,
          role_id: sentryRoleId || undefined,
          client_id: sentryClientId || undefined
        },
        extra: {
          request_id,
          candidate_id: sentryCandidateId,
          role_id: sentryRoleId,
          client_id: sentryClientId
        }
      });
    }
    return res.status(status).json({ error: e.message });
  }
});

module.exports = router;
