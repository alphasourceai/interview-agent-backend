'use strict';

const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');

const router = express.Router();

router.get('/public/interview-status', async (req, res) => {
  const request_id = req.request_id || req.headers['x-request-id'] || req.headers['x-correlation-id'] || null;
  try {
    const interview_id = String(req.query?.interview_id || '').trim();
    const role_token = String(req.query?.role_token || '').trim();

    if (!role_token) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'MISSING_REQUIRED_PARAMS',
        detail: 'role_token is required',
        hint: null,
        request_id
      });
    }

    const { data: role, error: roleError } = await supabase
      .from('roles')
      .select('id, client_id')
      .eq('slug_or_token', role_token)
      .maybeSingle();

    if (roleError || !role) {
      return res.status(404).json({
        error: 'not_found',
        code: 'INTERVIEW_NOT_FOUND',
        detail: 'Interview not found',
        hint: null,
        request_id
      });
    }

    let max_interview_minutes = null;
    if (role?.client_id) {
      const { data: plan } = await supabase
        .from('client_plan_settings')
        .select('max_interview_minutes')
        .eq('client_id', role.client_id)
        .maybeSingle();
      const raw = Number(plan?.max_interview_minutes);
      if (Number.isFinite(raw) && raw > 0) {
        max_interview_minutes = Math.floor(raw);
      }
    }

    if (!interview_id) {
      return res.status(200).json({
        ok: true,
        interview_id: null,
        status: null,
        updated_at: null,
        max_interview_minutes,
        request_id
      });
    }

    const { data: interview, error: interviewError } = await supabase
      .from('interviews')
      .select('id, role_id, status, updated_at')
      .eq('id', interview_id)
      .maybeSingle();

    if (interviewError || !interview || String(interview.role_id || '') !== String(role.id || '')) {
      return res.status(404).json({
        error: 'not_found',
        code: 'INTERVIEW_NOT_FOUND',
        detail: 'Interview not found',
        hint: null,
        request_id
      });
    }

    return res.status(200).json({
      ok: true,
      interview_id: interview.id,
      status: interview.status || null,
      updated_at: interview.updated_at || null,
      max_interview_minutes,
      request_id
    });
  } catch (err) {
    return res.status(500).json({
      error: 'server_error',
      code: 'PUBLIC_INTERVIEW_STATUS_FAILED',
      detail: err?.message || 'Failed to load interview status',
      hint: null,
      request_id
    });
  }
});

module.exports = router;
