// routes/createTavusInterview.js
'use strict';

const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');
const { createTavusInterviewHandler } = require('../handlers/createTavusInterview');

const router = express.Router();

function sendError(res, status, code, detail, context = {}, hint = null) {
  const payload = {
    error: code,
    detail,
    hint,
    role_id: context.role_id || null,
    candidate_id: context.candidate_id || null
  };
  console.error('[tavus-interview-error]', code, { ...context, status, detail, hint });
  return res.status(status).json(payload);
}

router.post('/', async (req, res) => {
  let candidate_id;
  let roleIdFromBody;
  let roleToken;
  let role_token;
  let roleId = null;
  let role = null;
  try {
    const computedBase = `${req.protocol}://${req.get('host')}`;
    const base = (process.env.PUBLIC_BACKEND_URL || computedBase).replace(/\/+$/, '');

    ({ candidate_id, role_id: roleIdFromBody, roleToken, role_token } = req.body || {});
    const roleTokenFromBody = roleToken || role_token || null;
    if (!candidate_id) {
      return sendError(res, 400, 'missing_fields', 'candidate_id required', { candidate_id });
    }

    // candidate
    const { data: candidate, error: cErr } = await supabase
      .from('candidates')
      .select('*')
      .eq('id', candidate_id)
      .single();
    if (cErr || !candidate) {
      return sendError(res, 404, 'candidate_not_found', cErr?.message || 'Candidate not found', { candidate_id });
    }

    roleId = roleIdFromBody || null;

    // If no explicit role id, try token from body
    if (!roleId && roleTokenFromBody) {
      const { data: roleByToken, error: rtErr } = await supabase
        .from('roles')
        .select('*')
        .or(`slug_or_token.eq.${roleTokenFromBody},token.eq.${roleTokenFromBody}`)
        .limit(1)
        .single();
      if (rtErr && rtErr.code !== 'PGRST116') {
        return sendError(res, 500, 'role_lookup_failed', rtErr.message || 'Failed to lookup role by token', { candidate_id, role_id: roleId });
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
        return sendError(res, 400, 'missing_role', 'role_id or valid role token required (candidate has no role_id)', { candidate_id });
      }
      const { data: roleById, error: rErr } = await supabase
        .from('roles')
        .select('*')
        .eq('id', roleId)
        .single();
      if (rErr || !roleById) {
        return sendError(res, 404, 'role_not_found', rErr?.message || 'Role not found', { candidate_id, role_id });
      }
      role = roleById;
    }

    const clientId = role.client_id || candidate.client_id || null;
    if (!clientId) {
      return sendError(res, 400, 'missing_client', 'client_id could not be determined from role or candidate', { candidate_id, role_id });
    }

    const webhookUrl = `${base}/webhook/tavus`;

    let companyName = 'the hiring organization';
    try {
      const { data: clientRow } = await supabase
        .from('clients')
        .select('id, name')
        .eq('id', clientId)
        .single();
      if (clientRow?.name) companyName = clientRow.name.trim();
    } catch (err) {
      console.warn('[create-tavus] client_lookup_failed', err?.message || err);
    }

    // Tavus
    const result = await createTavusInterviewHandler(candidate, role, webhookUrl, { companyName });

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
      if (iErr) {
        return sendError(res, 500, 'interview_insert_failed', iErr.message, { candidate_id, role_id });
      }

      return res.status(200).json({
        message: 'Interview created',
        conversation_url: result.conversation_url || null,
        interview_id: iData.id
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
      if (uErr) {
        return sendError(res, 500, 'interview_update_failed', uErr.message, { candidate_id, role_id });
      }

      return res.status(200).json({
        message: 'Interview updated',
        conversation_url: result.conversation_url || null,
        interview_id: existing.id
      });
    }
  } catch (e) {
    const context = {
      candidate_id,
      role_id: roleId || roleIdFromBody || null
    };
    if (e?.code === 'missing_tavus_kb' || e?.code === 'kb_not_ready') {
      const status = e.code === 'kb_not_ready' ? 409 : 500;
      return sendError(res, status, e.code, e.message, context);
    }
    if (e?.code === 'tavus_request_failed') {
      return sendError(res, e.status || 502, 'tavus_request_failed', e.detail || e.message || 'Failed to create Tavus conversation', context, 'Check Tavus logs or retry shortly');
    }
    if (e?.code === 'missing_env') {
      return sendError(res, e.status || 500, 'missing_env', e.message || 'Missing Tavus configuration', context);
    }
    return sendError(res, e.status || 500, e.code || 'unexpected_error', e.message || 'Server error', context);
  }
});

module.exports = router;
