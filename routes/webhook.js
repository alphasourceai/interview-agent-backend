const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { supabase } = require('../supabaseClient');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');
const { Readable } = require('stream');

// Helper: download file and return buffer
async function downloadFile(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch file: ${response.statusText}`);
  const contentType = response.headers.get('content-type');
  const ext = mime.extension(contentType);
  const buffer = await response.buffer();
  return { buffer, ext };
}

router.post('/recording-ready', async (req, res) => {
  const payload = req.body;

  try {
    // Log raw webhook payload
    await supabase.from('webhook_logs').insert({ event_type: 'recording-ready', payload });

    const {
      candidate_id,
      conversation_id,
      video_url,
      duration_seconds,
      completed_at
    } = payload;

    if (!video_url || !candidate_id || !conversation_id) {
      return res.status(400).json({ error: 'Missing required fields in webhook payload.' });
    }

    // Download video from Tavus (S3)
    const { buffer, ext } = await downloadFile(video_url);
    const filePath = `interviews/${candidate_id}_${conversation_id}.${ext}`;

    // Upload to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('videos')
      .upload(filePath, buffer, {
        contentType: mime.lookup(ext) || 'video/mp4',
        upsert: true
      });

    if (uploadError) {
      throw new Error(`Supabase upload failed: ${uploadError.message}`);
    }

    const { data: publicUrlData } = supabase
      .storage
      .from('videos')
      .getPublicUrl(filePath);

    // Update conversation record
    const { error: updateError } = await supabase
      .from('conversations')
      .update({
        status: 'ready',
        interview_video_url: publicUrlData.publicUrl,
        duration_seconds,
        completed_at
      })
      .eq('conversation_id', conversation_id);

    if (updateError) {
      throw new Error(`Supabase update failed: ${updateError.message}`);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Webhook Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
