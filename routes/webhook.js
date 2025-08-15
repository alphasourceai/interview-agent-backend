// routes/webhook.js
'use strict';

const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');

const webhookRouter = express.Router();

/** Quick ping so we can verify this router is mounted */
webhookRouter.get('/_ping', (req, res) => {
  res.json({ ok: true, router: 'webhook', ts: Date.now() });
});

/** Optional shared secret check */
function checkSecret(req, res) {
  const expected = (process.env.TAVUS_WEBHOOK_SECRET || '').trim();
  if (!expected) return true; // no secret set, allow
  const got = String(req.headers['x-webhook-secret'] || '').trim();
  if (got && got === expected) return true;
  res.status(401).json({ error: 'invalid or missing x-webhook-secret' });
  return false;
}

/**
 * POST /webhook/tavus
 * Handles Tavus conversation callbacks:
 * - system.replica_joined         -> status = 'In Progress'
 * - system.shutdown               -> status = 'Ended'
 * - application.recording_ready   -> set video_url (if provided)
 * - application.transcription_ready -> status = 'Transcribed'
 * - application.perception_analysis -> status = 'Analyzed'
 */
webhookRouter.post('/tavus', async (req, res) => {
  try {
    if (!checkSecret(req, res)) return;

    const body = req.body || {};
    const { event_type, conversation_id, properties = {} } = body;

    if (!conversation_id || !event_type) {
      return res.status(400).json({ error: 'conversation_id and event_type required' });
    }

    const { data: interview, error: findErr } = await supabase
      .from('interviews')
      .select('id, status, video_url')
      .eq('tavus_application_id', conversation_id)
      .maybeSingle();

    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!interview) return res.status(404).json({ error: 'interview not found for conversation_id' });

    const patch = {};

    if (event_type === 'system.replica_joined') {
      patch.status = 'In Progress';
    } else if (event_type === 'system.shutdown') {
      patch.status = 'Ended';
    } else if (event_type === 'application.recording_ready') {
      const s3Key = properties?.s3_key || null;
      const videoUrl = properties?.video_url || body.video_url || null;
      patch.status = 'Video Ready';
      if (videoUrl) patch.video_url = videoUrl;
      else if (s3Key) patch.video_url = s3Key;
    } else if (event_type === 'application.transcription_ready') {
      patch.status = 'Transcribed';
    } else if (event_type === 'application.perception_analysis') {
      patch.status = 'Analyzed';
    } else {
      return res.json({ ok: true, note: 'ignored event_type', event_type });
    }

    const { error: updErr } = await supabase
      .from('interviews')
      .update(patch)
      .eq('id', interview.id);

    if (updErr) return res.status(500).json({ error: updErr.message });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

/**
 * POST /webhook/recording-ready
 * Manual test helper: { conversation_id, video_url }
 */
webhookRouter.post('/recording-ready', async (req, res) => {
  try {
    if (!checkSecret(req, res)) return;

    const { conversation_id, video_url } = req.body || {};
    if (!conversation_id) return res.status(400).json({ error: 'conversation_id required' });

    const { data: interview, error: findErr } = await supabase
      .from('interviews')
      .select('id')
      .eq('tavus_application_id', conversation_id)
      .maybeSingle();
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!interview) return res.status(404).json({ error: 'interview not found' });

    const { error: updErr } = await supabase
      .from('interviews')
      .update({ status: 'Video Ready', video_url: video_url || null })
      .eq('id', interview.id);
    if (updErr) return res.status(500).json({ error: updErr.message });

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
});

module.exports = webhookRouter;
