// routes/createTavusInterview.js
'use strict';

const express = require('express');
const { supabase, supabaseAdmin } = require('../src/lib/supabaseClient');
const { createTavusInterviewHandler } = require('../handlers/createTavusInterview');
const { getRoleInterviewAvailability, syncRoleInterviewLimitNotification } = require('../src/lib/roleInterviewAvailability');

const router = express.Router();
const BILLING_MODE = String(process.env.BILLING_MODE || 'off').toLowerCase();
const BILLING_ENFORCED = BILLING_MODE === 'enforce';
const CREATE_TAVUS_RATE_WINDOW_MS = 15 * 60 * 1000;
const CREATE_TAVUS_RATE_MAX = 10;
const createTavusRateBuckets = new Map();

function createTavusRateLimit(req, res, next) {
  const now = Date.now();
  const ip = String((req.headers['x-forwarded-for'] || req.ip || 'unknown')).split(',')[0].trim() || 'unknown';
  const current = createTavusRateBuckets.get(ip);
  const bucket = (!current || current.resetAt <= now)
    ? { count: 0, resetAt: now + CREATE_TAVUS_RATE_WINDOW_MS }
    : current;
  bucket.count += 1;
  createTavusRateBuckets.set(ip, bucket);
  if (bucket.count > CREATE_TAVUS_RATE_MAX) {
    return res.status(429).json({
      error: 'rate_limited',
      code: 'RATE_LIMIT_EXCEEDED',
      detail: 'Too many requests. Please try again later.'
    });
  }
  return next();
}

router.post('/', createTavusRateLimit, async (req, res) => {
  try {
    const request_id = req.request_id || null;
    const computedBase = `${req.protocol}://${req.get('host')}`;
    const base = (process.env.PUBLIC_BACKEND_URL || computedBase).replace(/\/+$/, '');

    const {
      candidate_id,
      role_id: roleIdFromBody,
      roleToken,
      role_token
    } = req.body || {};
    const roleTokenFromBody = roleToken || role_token || null;
    if (!candidate_id) return res.status(400).json({ error: 'candidate_id required' });

    // candidate
    const { data: candidate, error: cErr } = await supabase
      .from('candidates')
      .select('*')
      .eq('id', candidate_id)
      .single();
    if (cErr || !candidate) return res.status(404).json({ error: cErr?.message || 'Candidate not found' });

    let role = null;
    let roleId = roleIdFromBody || null;

    // If no explicit role id, try token from body
    if (!roleId && roleTokenFromBody) {
      const { data: roleByToken, error: rtErr } = await supabase
        .from('roles')
        .select('*')
        .or(`slug_or_token.eq.${roleTokenFromBody},token.eq.${roleTokenFromBody}`)
        .limit(1)
        .single();
      if (rtErr && rtErr.code !== 'PGRST116') {
        return res.status(500).json({ error: rtErr.message });
      }
      if (roleByToken) {
        role = roleByToken;
        roleId = roleByToken.id;
      }
    }

    // If still no role resolved, try the candidate's role_id
    if (!roleId && candidate.role_id) {
      roleId = candidate.role_id;
    }

    if (!role) {
      // If we have a roleId now, fetch the role row
      if (!roleId) {
        return res.status(400).json({ error: 'role_id or valid role token required (candidate has no role_id)' });
      }
      const { data: roleById, error: rErr } = await supabase
        .from('roles')
        .select('*')
        .eq('id', roleId)
        .single();
      if (rErr || !roleById) return res.status(404).json({ error: rErr?.message || 'Role not found' });
      role = roleById;
    }

    const clientId = role.client_id || candidate.client_id || null;
    if (!clientId) {
      return res.status(400).json({ error: 'client_id could not be determined from role or candidate' });
    }
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
    console.log('[create-tavus-interview] launch_role_state', {
      role_id: role?.id || roleId || null,
      kb_document_id: role?.kb_document_id || null,
      tavus_document_id: role?.tavus_document_id || null,
      candidate_id
    });
    const result = await createTavusInterviewHandler(candidate, role, webhookUrl, {
      maxInterviewMinutes
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
        max_interview_minutes: maxInterviewMinutes
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
        max_interview_minutes: maxInterviewMinutes
      });
    }
  } catch (e) {
    const status = e.status || 500;
    return res.status(status).json({ error: e.message });
  }
});

module.exports = router;
