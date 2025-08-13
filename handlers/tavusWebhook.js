// handlers/tavusWebhook.js
require('dotenv').config();
const { supabase } = require('../src/lib/supabaseClient');

/**
 * Optional signature verification if TAVUS_WEBHOOK_SECRET is set.
 */
function verifySignature(req) {
  const secret = process.env.TAVUS_WEBHOOK_SECRET;
  if (!secret) return true;
  const provided = req.headers['x-webhook-secret'];
  return Boolean(provided && provided === secret);
}

async function handleTavusWebhook(req, res) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!verifySignature(req)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const body = req.body || {};
    const conversation_id = body.conversation_id || body.id || null;
    const video_url = body.video_url || body.url || null;

    if (!conversation_id) {
      return res.status(400).json({ error: 'Missing conversation_id' });
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
