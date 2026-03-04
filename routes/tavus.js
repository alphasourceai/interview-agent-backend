'use strict';

const express = require('express');
const axios = require('axios');
const { supabaseAdmin } = require('../src/lib/supabaseClient');

const router = express.Router();

router.post('/tavus/end-conversation', express.json({ limit: '1mb' }), async (req, res) => {
  const request_id = req.request_id || req.headers['x-request-id'] || req.headers['x-correlation-id'] || null;
  try {
    const conversation_id = typeof req.body?.conversation_id === 'string' ? req.body.conversation_id.trim() : '';
    if (!conversation_id) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'CONVERSATION_ID_REQUIRED',
        detail: 'conversation_id is required',
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

    console.log('[tavus/end-conversation] status_updated', {
      request_id,
      conversation_id,
      interview_id: updatedInterview?.id || null,
      status: updatedInterview?.status || 'ending_requested'
    });

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
