'use strict';

const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');

const router = express.Router();

router.get('/public/interview-status', async (req, res) => {
  const request_id = req.request_id || req.headers['x-request-id'] || req.headers['x-correlation-id'] || null;
  try {
    const interview_id = String(req.query?.interview_id || '').trim();
    const role_token = String(req.query?.role_token || '').trim();

    if (!interview_id || !role_token) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'MISSING_REQUIRED_PARAMS',
        detail: 'interview_id and role_token are required',
        hint: null,
        request_id
      });
    }

    const { data: role, error: roleError } = await supabase
      .from('roles')
      .select('id')
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
