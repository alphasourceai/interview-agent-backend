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
 * Tavus conversation callbacks. See docs for payload shapes:
 * - application.transcription_ready → transcript in properties.transcript
 * - application.perception_analysis → analysis summary in properties.analysis
 * - application.recording_ready     → video url in properties.video_url / body.video_url
 * - system.replica_joined / system.shutdown
 * Docs: https://docs.tavus.io/sections/webhooks-and-callbacks
 */
webhookRouter.post('/tavus', async (req, res) => {
  try {
    if (!checkSecret(req, res)) return;

    const body = req.body || {};
    const { event_type, conversation_id, properties = {} } = body;

    if (!conversation_id || !event_type) {
      return res.status(400).json({ error: 'conversation_id and event_type required' });
    }

    // Find the interview by Tavus conversation id
    const { data: interview, error: findErr } = await supabase
      .from('interviews')
      .select('id, status, video_url')
      .eq('tavus_application_id', conversation_id)
      .maybeSingle();
    if (findErr) return res.status(500).json({ error: findErr.message });
    if (!interview) return res.status(404).json({ error: 'interview not found for conversation_id' });

    // --- System events ---
    if (event_type === 'system.replica_joined') {
      await supabase.from('interviews').update({ status: 'In Progress' }).eq('id', interview.id);
      return res.json({ ok: true });
    }
    if (event_type === 'system.shutdown') {
      await supabase.from('interviews').update({ status: 'Ended' }).eq('id', interview.id);
      return res.json({ ok: true });
    }

    // --- Recording ready ---
    if (event_type === 'application.recording_ready') {
      const videoUrl = properties?.video_url || body.video_url || properties?.s3_key || null;
      const patch = { status: 'Video Ready' };
      if (videoUrl) patch.video_url = videoUrl;
      const { error: updErr } = await supabase.from('interviews').update(patch).eq('id', interview.id);
      if (updErr) return res.status(500).json({ error: updErr.message });
      return res.json({ ok: true });
    }

    // --- Transcription ready ---
    if (event_type === 'application.transcription_ready') {
      // Tavus sends transcript as an array of { role, content } messages. :contentReference[oaicite:1]{index=1}
      const transcript = properties?.transcript;
      if (!Array.isArray(transcript)) {
        // Fallback: if Tavus starts sending a URL instead
        const tUrl = properties?.transcript_url || null;
        if (tUrl) {
          const { error: updErr } = await supabase
            .from('interviews')
            .update({ status: 'Transcribed', transcript_url: tUrl })
            .eq('id', interview.id);
          if (updErr) return res.status(500).json({ error: updErr.message });
          return res.json({ ok: true, note: 'stored transcript_url' });
        }
        return res.status(400).json({ error: 'transcript missing in properties' });
      }

      const bucket = process.env.SUPABASE_TRANSCRIPTS_BUCKET || 'transcripts';
      const path = `${conversation_id}.json`;
      const content = JSON.stringify({ conversation_id, transcript }, null, 2);

      const upload = await supabase.storage.from(bucket).upload(path, content, {
        contentType: 'application/json',
        upsert: true,
      });
      if (upload.error) return res.status(500).json({ error: upload.error.message });

      const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
      const transcript_url = pub?.publicUrl || null;

      const { error: updErr } = await supabase
        .from('interviews')
        .update({ status: 'Transcribed', transcript_url })
        .eq('id', interview.id);
      if (updErr) return res.status(500).json({ error: updErr.message });

      return res.json({ ok: true, transcript_url });
    }

    // --- Perception analysis ready ---
    if (event_type === 'application.perception_analysis') {
      // Docs: analysis summary arrives post-call when perception is enabled. :contentReference[oaicite:2]{index=2}
      const analysis = properties?.analysis ?? properties ?? {};
      const bucket = process.env.SUPABASE_ANALYSIS_BUCKET || 'analysis';
      const path = `${conversation_id}.json`;
      const content = JSON.stringify({ conversation_id, analysis }, null, 2);

      const upload = await supabase.storage.from(bucket).upload(path, content, {
        contentType: 'application/json',
        upsert: true,
      });
      if (upload.error) return res.status(500).json({ error: upload.error.message });

      const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
      const analysis_url = pub?.publicUrl || null;

      const { error: updErr } = await supabase
        .from('interviews')
        .update({ status: 'Analyzed', analysis_url })
        .eq('id', interview.id);
      if (updErr) return res.status(500).json({ error: updErr.message });

      return res.json({ ok: true, analysis_url });
    }

    // Unknown event -> acknowledge to avoid retries
    return res.json({ ok: true, note: 'ignored event_type', event_type });
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
