// routes/webhook.js
'use strict';

const express = require('express');
const router = express.Router();
const { supabase } = require('../src/lib/supabaseClient');

const TRANSCRIPTS_BUCKET = process.env.SUPABASE_TRANSCRIPTS_BUCKET || 'transcripts';

const DAILY_ROOM_RE = /(^https?:\/\/)?([a-z0-9-]+\.)?(tavus\.daily\.co|c\.daily\.co)(\/|\?|$)/i;

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

function collectValues(obj, ...paths) {
  const out = [];
  for (const p of paths) {
    const v = fromAny(obj, p);
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item !== undefined && item !== null) out.push(item);
      }
    } else {
      out.push(v);
    }
  }
  return out;
}

function isDailyRoomUrl(url) {
  return !!url && DAILY_ROOM_RE.test(String(url));
}

function isDownloadableRecordingUrl(url) {
  if (!url) return false;
  if (!/^https?:\/\//i.test(String(url))) return false;
  if (isDailyRoomUrl(url)) return false;
  return true;
}

async function getInterviewByIds(interviewId, conversationId) {
  if (interviewId) {
    const { data } = await supabase
      .from('interviews')
      .select('*')
      .eq('id', interviewId)
      .maybeSingle();
    return data || null;
  }

  if (conversationId) {
    const { data } = await supabase
      .from('interviews')
      .select('*')
      .eq('tavus_application_id', conversationId)
      .maybeSingle();
    return data || null;
  }

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

async function putJsonToStorage(bucket, pathName, jsonOrUrl) {
  await ensureBucket(bucket);

  let buf;
  let contentType = 'application/json';

  if (typeof jsonOrUrl === 'string' && /^https?:\/\//i.test(jsonOrUrl)) {
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
    .upload(pathName, buf, { upsert: true, contentType });
  if (error) throw new Error(error.message);

  return `${bucket}/${pathName}`;
}

function extractSanitizedContent(item) {
  if (!item) return null;

  const role = typeof item.role === 'string' ? item.role.trim().toLowerCase() : '';
  if (role !== 'user') return null;

  let content = item.content ?? item.text ?? item.message ?? item.value;
  if (content == null) return null;
  if (typeof content !== 'string') {
    try {
      content = JSON.stringify(content);
    } catch {
      content = String(content);
    }
  }

  const text = String(content).trim();
  return text || null;
}

function sanitizeTranscriptArray(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const line = extractSanitizedContent(item);
    if (line) out.push(line);
  }
  return out;
}

router.get('/_ping', (_req, res) => res.json({ ok: true }));

// Primary webhook entry
router.post('/tavus', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const body = req.body || {};

    const eventTypeRaw = pickFirst(
      fromAny(body, 'event_type'),
      fromAny(body, 'eventType'),
      fromAny(body, 'event'),
      fromAny(body, 'type'),
      fromAny(body, 'status'),
      fromAny(body, 'payload.event_type'),
      fromAny(body, 'payload.eventType'),
      fromAny(body, 'payload.type')
    );

    const eventType = String(eventTypeRaw || '').toLowerCase();
    const isTranscriptionReady = eventType === 'application.transcription_ready';
    const isRecordingReady = eventType === 'application.recording_ready';

    const interviewId = pickFirst(
      fromAny(body, 'interview_id'),
      fromAny(body, 'interviewId'),
      fromAny(body, 'metadata.interview_id')
    );

    const conversationId = pickFirst(
      fromAny(body, 'conversation_id'),
      fromAny(body, 'properties.conversation_id'),
      fromAny(body, 'properties.conversationId'),
      fromAny(body, 'metadata.conversation_id')
    );

    const recordingUrls = collectValues(
      body,
      'properties.recording_url',
      'recording_url',
      'payload.recording_url'
    );
    const videoUrls = collectValues(
      body,
      'properties.video_url',
      'video_url',
      'payload.video_url',
      'output.video_url'
    );

    console.log('[webhook] received', {
      event_type: String(eventTypeRaw || ''),
      interview_id: interviewId || null,
      conversation_id: conversationId || null,
      recording_url: recordingUrls,
      video_url: videoUrls
    });

    if (!isTranscriptionReady && !isRecordingReady) {
      return res.status(200).json({ ok: true });
    }

    if (!interviewId && !conversationId) {
      return res.status(200).json({ ok: true });
    }

    const interview = await getInterviewByIds(interviewId, conversationId);
    if (!interview) {
      return res.status(200).json({ ok: true });
    }

    const updates = {};

    if (isTranscriptionReady) {
      const rawTranscript = pickFirst(
        fromAny(body, 'properties.transcript'),
        fromAny(body, 'transcript'),
        fromAny(body, 'payload.transcript')
      );

      const pathName = `interviews/${interview.id}.json`;
      const stored = await putJsonToStorage(TRANSCRIPTS_BUCKET, pathName, body);

      updates.transcript_url = stored;

      const transcriptItems = Array.isArray(rawTranscript)
        ? rawTranscript
        : Array.isArray(rawTranscript?.messages)
          ? rawTranscript.messages
          : null;

      if (transcriptItems) {
        const sanitizedLines = sanitizeTranscriptArray(transcriptItems);
        const transcriptText = sanitizedLines.join('\n').trim();
        updates.transcript = transcriptText || null;
      } else {
        updates.transcript = null;
      }

      if (updates.transcript) {
        updates.status = 'Transcribed';
      }
    }

    if (isRecordingReady) {
      const recordingFieldSnapshot = {
        properties_recording_url: fromAny(body, 'properties.recording_url'),
        properties_video_url: fromAny(body, 'properties.video_url'),
        recording_url: fromAny(body, 'recording_url'),
        video_url: fromAny(body, 'video_url'),
        payload_recording_url: fromAny(body, 'payload.recording_url'),
        payload_video_url: fromAny(body, 'payload.video_url'),
        output_video_url: fromAny(body, 'output.video_url')
      };
      console.log('[webhook] recording_ready fields', recordingFieldSnapshot);

      const recordingUrl = pickFirst(
        fromAny(body, 'properties.recording_url'),
        fromAny(body, 'properties.video_url'),
        fromAny(body, 'recording_url'),
        fromAny(body, 'video_url'),
        fromAny(body, 'payload.recording_url'),
        fromAny(body, 'payload.video_url'),
        fromAny(body, 'output.video_url')
      );

      if (recordingUrl) {
        if (isDailyRoomUrl(recordingUrl)) {
          const existingVideoUrl = interview.video_url || null;
          if (!existingVideoUrl || isDailyRoomUrl(existingVideoUrl)) {
            updates.video_url = null;
          }
        } else if (isDownloadableRecordingUrl(recordingUrl)) {
          updates.video_url = recordingUrl;
          if (!updates.status) updates.status = 'VideoReady';
        }
      }
    }

    if (Object.keys(updates).length) {
      await supabase.from('interviews').update(updates).eq('id', interview.id);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[webhook] error:', e.message || e);
    // Be lenient to avoid provider retries storms
    return res.status(200).json({ ok: true });
  }
});

module.exports = router;
