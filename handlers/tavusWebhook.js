const crypto = require('crypto');
const { supabase } = require('../utils/supabaseClient');
require('dotenv').config();

const TAVUS_WEBHOOK_SECRET = process.env.TAVUS_WEBHOOK_SECRET;

function verifySignature(req, secret) {
  const providedSecret = req.headers['x-webhook-secret'];
  return providedSecret && providedSecret === secret;
}

async function handleTavusWebhook(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send({ error: 'Method not allowed' });
  }

  const valid = verifySignature(req, TAVUS_WEBHOOK_SECRET);
  if (!valid) {
    return res.status(401).send({ error: 'Invalid webhook secret' });
  }

  const event = req.body;

  if (event.type !== 'application.recording_ready') {
    return res.status(200).send({ message: 'Event ignored' });
  }

  const { application_id, video_url, metadata } = event.data;

  // Save to Supabase "interviews" table
  const { error } = await supabase.from('interviews').insert({
    candidate_id: metadata?.candidate_id || null,
    video_url,
    tavus_application_id: application_id,
    status: 'Video Ready',
  });

  if (error) {
    console.error('Supabase insert error:', error);
    return res.status(500).send({ error: 'Failed to save interview info' });
  }

  return res.status(200).send({ message: 'Webhook processed successfully' });
}

module.exports = { handleTavusWebhook };
