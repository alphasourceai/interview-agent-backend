// handlers/tavusWebhook.js
require('dotenv').config();
const { supabase } = require('../src/lib/supabaseClient');
const { verifyTavusWebhookRequest } = require('../src/lib/tavusWebhookAuth');
const {
  getOwnPath,
  validateTavusWebhookPayload,
} = require('../src/lib/tavusWebhookPayload');

function firstOwnValue(body, paths) {
  for (const path of paths) {
    const candidate = getOwnPath(body, path);
    if (candidate.found) return candidate.value;
  }
  return undefined;
}

async function handleTavusWebhook(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!verifyTavusWebhookRequest(req).ok) {
      return res.status(401).json({
        ok: false,
        error: 'webhook_authentication_failed',
      });
    }

    const body = req.body;
    const validation = validateTavusWebhookPayload(body);
    if (!validation.ok) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_webhook_payload',
      });
    }
    if (!validation.supported || validation.eventType !== 'application.recording_ready') {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const conversation_id = validation.conversationId;
    const video_url = firstOwnValue(body, [
      'properties.recording_url',
      'properties.video_url',
      'recording_url',
      'video_url',
      'payload.recording_url',
      'payload.video_url',
      'output.video_url',
    ]);
    if (typeof video_url !== 'string' || !video_url.trim()) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const { data: interview, error: iErr } = await supabase
      .from('interviews')
      .select('id, candidate_id, role_id')
      .eq('tavus_application_id', conversation_id)
      .maybeSingle();

    if (iErr) {
      return res.status(500).json({ error: iErr.message });
    }

    if (!interview) {
      return res.status(200).json({ ok: true, warning: 'No interview matched conversation_id' });
    }

    const { error: u1 } = await supabase
      .from('interviews')
      .update({ status: 'Video Ready', video_url })
      .eq('id', interview.id);
    if (u1) return res.status(500).json({ error: u1.message });

    const { error: u2 } = await supabase
      .from('candidates')
      .update({ status: 'Completed' })
      .eq('id', interview.candidate_id);
    if (u2) return res.status(500).json({ error: u2.message });

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

module.exports = { handleTavusWebhook };
