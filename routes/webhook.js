// routes/webhook.js
'use strict';

const express = require('express');
const router = express.Router();
const { supabase } = require('../src/lib/supabaseClient');

const TRANSCRIPTS_BUCKET = process.env.SUPABASE_TRANSCRIPTS_BUCKET || 'transcripts';
const ANALYSIS_BUCKET    = process.env.SUPABASE_ANALYSIS_BUCKET    || 'analysis';

// --- utilities ---
function pickFirst(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function fromAny(obj, ...paths) {
  for (const p of paths) {
    try {
      const parts = p.split('.');
      let cur = obj;
      for (const key of parts) cur = cur?.[key];
      if (cur !== undefined) return cur;
    } catch {}
  }
  return undefined;
}

async function getInterviewByAnyId(anyId) {
  if (!anyId) return null;
  // Try by id
  let { data } = await supabase.from('interviews').select('*').eq('id', anyId).maybeSingle();
  if (data) return data;
  // Try by conversation_id
  ({ data } = await supabase.from('interviews').select('*').eq('conversation_id', anyId).maybeSingle());
  if (data) return data;
  return null;
}

async function ensureBucket(name) {
  const { data: list } = await supabase.storage.listBuckets();
  if (!list?.find(b => b.name === name)) {
    try {
      await supabase.storage.createBucket(name, { public: false });
    } catch {}
  }
}

async function putJsonToStorage(bucket, path, jsonOrUrl) {
  await ensureBucket(bucket);

  let buf;
  let contentType = 'application/json';

  if (typeof jsonOrUrl === 'string' && /^https?:\/\//i.test(jsonOrUrl)) {
    // fetch from remote URL
    const r = await fetch(jsonOrUrl);
    if (!r.ok) throw new Error(`fetch ${jsonOrUrl} failed: ${r.status}`);
    const ct = r.headers.get('content-type') || '';
    contentType = ct || contentType;
    const ab = await r.arrayBuffer();
    buf = Buffer.from(ab);
  } else if (typeof jsonOrUrl === 'string') {
    buf = Buffer.from(jsonOrUrl, 'utf8');
  } else {
    buf = Buffer.from(JSON.stringify(jsonOrUrl ?? {}), 'utf8');
  }

  const { error } = await supabase
    .storage
    .from(bucket)
    .upload(path, buf, { upsert: true, contentType });
  if (error) throw new Error(error.message);

  return `${bucket}/${path}`;
}

router.get('/_ping', (_req, res) => res.json({ ok: true }));

// Primary webhook entry
router.post('/tavus', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const body = req.body || {};

    // Find an interview identifier from the payload
    const anyId = pickFirst(
      fromAny(body, 'interview_id'),
      fromAny(body, 'interviewId'),
      fromAny(body, 'conversation_id'),
      fromAny(body, 'conversationId'),
      fromAny(body, 'metadata.interview_id'),
      fromAny(body, 'metadata.conversation_id')
    );
    if (!anyId) return res.status(400).json({ error: 'No interview identifier in payload' });

    const interview = await getInterviewByAnyId(anyId);
    if (!interview) return res.status(404).json({ error: 'Interview not found' });

    // Determine event type loosely
    const event =
      pickFirst(fromAny(body, 'event'), fromAny(body, 'type'), fromAny(body, 'status')) || '';

    // Possible blobs/links
    const transcriptObj = pickFirst(fromAny(body, 'transcript'), fromAny(body, 'payload.transcript'));
    const transcriptUrl = pickFirst(fromAny(body, 'transcript_url'), fromAny(body, 'payload.transcript_url'));
    const analysisObj   = pickFirst(fromAny(body, 'analysis'), fromAny(body, 'payload.analysis'));
    const analysisUrl   = pickFirst(fromAny(body, 'analysis_url'), fromAny(body, 'payload.analysis_url'));
    const videoUrl      = pickFirst(
      fromAny(body, 'video_url'),
      fromAny(body, 'payload.video_url'),
      fromAny(body, 'output.video_url')
    );

    const updates = {};

    // If video URL present, persist it
    if (videoUrl && !interview.video_url) {
      updates.video_url = videoUrl;
    }

    // If transcript present (object or url), upload privately and store bucket/path
    if (transcriptObj || transcriptUrl) {
      const path = `${interview.id}.json`;
      const stored = await putJsonToStorage(TRANSCRIPTS_BUCKET, path, transcriptObj || transcriptUrl);
      updates.transcript_url = stored;
    }

    // If analysis present (object or url), upload privately and store bucket/path
    if (analysisObj || analysisUrl) {
      const path = `${interview.id}.json`;
      const stored = await putJsonToStorage(ANALYSIS_BUCKET, path, analysisObj || analysisUrl);
      updates.analysis_url = stored;
    }

    // Optional status update heuristics
    if (updates.analysis_url) {
      updates.status = 'Analyzed';
    } else if (updates.transcript_url) {
      updates.status = 'Transcribed';
    } else if (updates.video_url) {
      updates.status = 'VideoReady';
    }

    if (Object.keys(updates).length) {
      await supabase.from('interviews').update(updates).eq('id', interview.id);
    }

    res.json({ ok: true, interview_id: interview.id, event });
  } catch (e) {
    console.error('[webhook] error:', e.message);
    // Be lenient to avoid provider retries storms
    res.status(200).json({ ok: true });
  }
});

module.exports = router;
