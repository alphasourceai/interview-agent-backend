'use strict';

const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');

const router = express.Router();
const PUBLIC_STATUS_RATE_WINDOW_MS = 5 * 60 * 1000;
const PUBLIC_STATUS_RATE_MAX = 120;
const publicStatusRateBuckets = new Map();

function publicStatusRateLimit(req, res, next) {
  const now = Date.now();
  const ip = String((req.headers['x-forwarded-for'] || req.ip || 'unknown')).split(',')[0].trim() || 'unknown';
  const current = publicStatusRateBuckets.get(ip);
  const bucket = (!current || current.resetAt <= now)
    ? { count: 0, resetAt: now + PUBLIC_STATUS_RATE_WINDOW_MS }
    : current;
  bucket.count += 1;
  publicStatusRateBuckets.set(ip, bucket);
  if (bucket.count > PUBLIC_STATUS_RATE_MAX) {
    const request_id = req.request_id || req.headers['x-request-id'] || req.headers['x-correlation-id'] || null;
    return res.status(429).json({
      error: 'rate_limited',
      code: 'RATE_LIMIT_EXCEEDED',
      detail: 'Too many requests. Please try again later.',
      request_id
    });
  }
  return next();
}

router.get('/public/interview-status', publicStatusRateLimit, async (req, res) => {
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
