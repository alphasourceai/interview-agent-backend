'use strict';

const express = require('express');
const axios = require('axios');
const { supabaseAdmin } = require('../src/lib/supabaseClient');

const router = express.Router();
const EARLY_END_GRACE_MS = 15000;
const EARLY_END_WINDOW_MS = 20 * 60 * 1000;
const EARLY_END_SUMMARY = 'Interview ended before substantive responses were captured.';
const EARLY_END_TRANSCRIPT_SCORES = {
  overall: null,
  role_fit: null,
  technical_strength: null,
  communication_quality: null,
  confidence: 0,
  ai_aided_risk: 'low',
  ai_aided_risk_reason: 'No substantive interview response was available to assess.'
};

function hasNonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasAnalysisData(value) {
  if (!value) return false;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return false;
    return trimmed !== '{}' && trimmed !== '[]';
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

router.post('/tavus/end-conversation', express.json({ limit: '1mb' }), async (req, res) => {
  const request_id = req.request_id || req.headers['x-request-id'] || req.headers['x-correlation-id'] || null;
  try {
    const conversation_id = typeof req.body?.conversation_id === 'string' ? req.body.conversation_id.trim() : '';
    const interview_id = typeof req.body?.interview_id === 'string' ? req.body.interview_id.trim() : '';
    const role_token = typeof req.body?.role_token === 'string' ? req.body.role_token.trim() : '';
    if (!conversation_id || !interview_id || !role_token) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'MISSING_REQUIRED_PARAMS',
        detail: 'conversation_id, interview_id, and role_token are required',
        hint: null,
        request_id
      });
    }

    const { data: role, error: roleError } = await supabaseAdmin
      .from('roles')
      .select('id')
      .eq('slug_or_token', role_token)
      .maybeSingle();

    if (roleError) {
      return res.status(500).json({
        error: 'server_error',
        code: 'ROLE_LOOKUP_FAILED',
        detail: roleError.message || 'Failed to load role',
        hint: roleError.hint || null,
        request_id
      });
    }
    if (!role) {
      return res.status(404).json({
        error: 'not_found',
        code: 'ROLE_NOT_FOUND',
        detail: 'Role not found',
        hint: null,
        request_id
      });
    }

    const { data: interview, error: interviewError } = await supabaseAdmin
      .from('interviews')
      .select('id, role_id, tavus_application_id, status')
      .eq('id', interview_id)
      .maybeSingle();

    if (interviewError) {
      return res.status(500).json({
        error: 'server_error',
        code: 'INTERVIEW_LOOKUP_FAILED',
        detail: interviewError.message || 'Failed to load interview',
        hint: interviewError.hint || null,
        request_id
      });
    }
    if (!interview) {
      return res.status(404).json({
        error: 'not_found',
        code: 'INTERVIEW_NOT_FOUND',
        detail: 'Interview not found',
        hint: null,
        request_id
      });
    }

    if (
      String(interview.role_id || '') !== String(role.id || '') ||
      String(interview.tavus_application_id || '') !== conversation_id
    ) {
      return res.status(403).json({
        error: 'forbidden',
        code: 'INTERVIEW_BINDING_MISMATCH',
        detail: 'Interview does not match supplied role_token and conversation_id',
        hint: null,
        request_id
      });
    }

    const apiKey = String(process.env.TAVUS_API_KEY || '').trim();
    if (!apiKey) {
      return res.status(500).json({
        error: 'server_error',
        code: 'MISSING_TAVUS_API_KEY',
        detail: 'TAVUS_API_KEY is not set',
        hint: null,
        request_id
      });
    }

    try {
      await axios.post(
        `https://tavusapi.com/v2/conversations/${encodeURIComponent(conversation_id)}/end`,
        {},
        {
          headers: {
            'x-api-key': apiKey,
            'Content-Type': 'application/json'
          }
        }
      );
    } catch (e) {
      const upstreamStatus = e?.response?.status;
      const upstreamData = e?.response?.data;
      const detail = typeof upstreamData === 'string'
        ? upstreamData
        : (upstreamData ? JSON.stringify(upstreamData) : (e?.message || 'Failed to end Tavus conversation'));
      console.error('[tavus/end-conversation] tavus_end_failed', {
        request_id,
        conversation_id,
        status: upstreamStatus,
        detail
      });
      return res.status(upstreamStatus && upstreamStatus >= 400 && upstreamStatus < 600 ? upstreamStatus : 502).json({
        error: 'upstream_error',
        code: 'TAVUS_END_FAILED',
        detail,
        hint: null,
        request_id
      });
    }

    const { data: updatedInterview, error: updateError } = await supabaseAdmin
      .from('interviews')
      .update({
        status: 'ending_requested',
        updated_at: new Date().toISOString()
      })
      .eq('tavus_application_id', conversation_id)
      .select('id, status')
      .maybeSingle();

    if (updateError) {
      console.error('[tavus/end-conversation] status_update_failed', {
        request_id,
        conversation_id,
        code: updateError.code,
        detail: updateError.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'INTERVIEW_STATUS_UPDATE_FAILED',
        detail: updateError.message,
        hint: updateError.hint || null,
        request_id
      });
    }

    if (updatedInterview?.id) {
      const interviewId = updatedInterview.id;
      setTimeout(async () => {
        try {
          const { data: fresh, error: freshError } = await supabaseAdmin
            .from('interviews')
            .select('id,candidate_id,role_id,status,created_at,transcript,analysis,interview_summary')
            .eq('id', interviewId)
            .maybeSingle();

          if (freshError) {
            console.error('[tavus/end-conversation] early_end_reconcile_read_failed', {
              request_id,
              interview_id: interviewId,
              code: freshError.code,
              detail: freshError.message
            });
            return;
          }
          if (!fresh) return;

          const status = String(fresh.status || '').toLowerCase();
          const createdAtMs = new Date(fresh.created_at || 0).getTime();
          const isRecent = Number.isFinite(createdAtMs) && (Date.now() - createdAtMs <= EARLY_END_WINDOW_MS);
          const transcriptEmpty = !hasNonEmptyText(fresh.transcript);
          const summaryEmpty = !hasNonEmptyText(fresh.interview_summary);
          const analysisEmpty = !hasAnalysisData(fresh.analysis);
          const shouldFinalizeEarlyEnded =
            status === 'ending_requested' &&
            isRecent &&
            transcriptEmpty &&
            summaryEmpty &&
            analysisEmpty;

          if (!shouldFinalizeEarlyEnded) return;

          const { error: finalizeError } = await supabaseAdmin
            .from('interviews')
            .update({
              status: 'Ended',
              interview_summary: EARLY_END_SUMMARY,
              transcript_scores: EARLY_END_TRANSCRIPT_SCORES,
              updated_at: new Date().toISOString()
            })
            .eq('id', interviewId)
            .eq('status', 'ending_requested');

          if (finalizeError) {
            console.error('[tavus/end-conversation] early_end_reconcile_finalize_failed', {
              request_id,
              interview_id: interviewId,
              code: finalizeError.code,
              detail: finalizeError.message
            });
            return;
          }

          if (fresh.candidate_id) {
            const { error: reportCleanupError } = await supabaseAdmin
              .from('reports')
              .update({
                interview_score: null,
                overall_score: null,
                interview_breakdown: {
                  clarity: null,
                  confidence: null,
                  body_language: null,
                  evidence_strength: null,
                  total_score: null,
                  summary: EARLY_END_SUMMARY
                }
              })
              .eq('candidate_id', fresh.candidate_id)
              .eq('role_id', fresh.role_id);

            if (reportCleanupError) {
              console.error('[tavus/end-conversation] early_end_reconcile_report_cleanup_failed', {
                request_id,
                interview_id: interviewId,
                candidate_id: fresh.candidate_id,
                role_id: fresh.role_id,
                code: reportCleanupError.code,
                detail: reportCleanupError.message
              });
            }
          }

        } catch (e) {
          console.error('[tavus/end-conversation] early_end_reconcile_unexpected', {
            request_id,
            interview_id: interviewId,
            error: e?.message || e
          });
        }
      }, EARLY_END_GRACE_MS);
    }

    return res.json({ ok: true, request_id });
  } catch (e) {
    console.error('[tavus/end-conversation] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'END_CONVERSATION_FAILED',
      detail: e?.message || 'Failed to end conversation',
      hint: null,
      request_id
    });
  }
});

module.exports = router;
