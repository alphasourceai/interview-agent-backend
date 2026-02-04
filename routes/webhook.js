// routes/webhook.js
'use strict';

const express = require('express');
const router = express.Router();
const { supabase } = require('../src/lib/supabaseClient');
const { analyzeInterviewTranscriptById } = require('../scripts/backfillInterviews.js');

const TRANSCRIPTS_BUCKET = process.env.SUPABASE_TRANSCRIPTS_BUCKET || 'transcripts';

const DAILY_ROOM_RE = /(^https?:\/\/)?([a-z0-9-]+\.)?(tavus\.daily\.co|c\.daily\.co)(\/|\?|$)/i;
const ANALYSIS_TRIGGER_TTL_MS = 2 * 60 * 1000;
const analysisTriggerGuard = new Map();

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

function isMissingColumnError(error) {
  const msg = String(error?.message || '');
  return /column .* does not exist/i.test(msg);
}

function pruneMetadata(meta) {
  const out = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    out[key] = value;
  }
  return out;
}

function hasColumn(row, key) {
  return Object.prototype.hasOwnProperty.call(row || {}, key);
}

function hasAnalysisResult(interview) {
  if (!interview) return false;
  if (interview.analysis) {
    if (typeof interview.analysis === 'object') {
      if (Array.isArray(interview.analysis)) return interview.analysis.length > 0;
      return Object.keys(interview.analysis).length > 0;
    }
    return true;
  }
  if (interview.analysis_url) return true;
  if (interview.interview_analysis) return true;
  if (interview.report_url) return true;
  if (interview.overall_score !== undefined && interview.overall_score !== null) return true;
  return false;
}

function hasTranscriptAnalysis(interview) {
  if (!interview || !interview.analysis || typeof interview.analysis !== 'object' || Array.isArray(interview.analysis)) {
    return false;
  }
  const summary = typeof interview.analysis.summary === 'string' ? interview.analysis.summary.trim() : '';
  const scores = interview.analysis.scores && typeof interview.analysis.scores === 'object'
    ? Object.keys(interview.analysis.scores).length > 0
    : false;
  return !!summary && !!scores;
}

function getRequestId(req, body) {
  return pickFirst(
    req?.headers?.['x-request-id'],
    req?.headers?.['x-requestid'],
    req?.headers?.['x-correlation-id'],
    fromAny(body, 'request_id'),
    fromAny(body, 'requestId'),
    fromAny(body, 'metadata.request_id'),
    fromAny(body, 'metadata.requestId'),
    fromAny(body, 'properties.request_id'),
    fromAny(body, 'payload.request_id')
  );
}

function shouldTriggerAnalysis(interviewId, requestId) {
  if (!interviewId) return false;
  const now = Date.now();
  const last = analysisTriggerGuard.get(interviewId);
  if (last && now - last < ANALYSIS_TRIGGER_TTL_MS) {
    console.log('[analysis-trigger] dedupe', {
      request_id: requestId || null,
      interview_id: interviewId
    });
    return false;
  }
  analysisTriggerGuard.set(interviewId, now);
  if (analysisTriggerGuard.size > 1000) {
    for (const [id, ts] of analysisTriggerGuard.entries()) {
      if (now - ts > ANALYSIS_TRIGGER_TTL_MS) analysisTriggerGuard.delete(id);
    }
  }
  return true;
}

async function applyInterviewUpdates(interviewId, updates, recordingMeta) {
  const baseUpdates = updates && Object.keys(updates).length ? updates : null;
  const cleanedMeta = pruneMetadata(recordingMeta);
  const hasMeta = Object.keys(cleanedMeta).length > 0;

  if (!hasMeta) {
    if (!baseUpdates) return;
    const { error } = await supabase.from('interviews').update(baseUpdates).eq('id', interviewId);
    if (error) throw error;
    return;
  }

  const combined = { ...(baseUpdates || {}), ...cleanedMeta };
  let { error } = await supabase.from('interviews').update(combined).eq('id', interviewId);
  if (!error) return;

  if (!isMissingColumnError(error)) throw error;

  if (baseUpdates) {
    const { error: baseErr } = await supabase.from('interviews').update(baseUpdates).eq('id', interviewId);
    if (baseErr) throw baseErr;
  }

  ({ error } = await supabase
    .from('interviews')
    .update({ recording_metadata: cleanedMeta })
    .eq('id', interviewId));
  if (!error) return;
  if (!isMissingColumnError(error)) throw error;

  const pathName = `interviews/${interviewId}-recording-metadata.json`;
  const stored = await putJsonToStorage(TRANSCRIPTS_BUCKET, pathName, cleanedMeta);

  const { error: urlErr } = await supabase
    .from('interviews')
    .update({ recording_metadata_url: stored })
    .eq('id', interviewId);
  if (urlErr && !isMissingColumnError(urlErr)) throw urlErr;
}

async function updatePerceptionAnalysis(interview, analysisText, requestId) {
  const trimmed = String(analysisText || '').trim();
  if (!trimmed) return false;

  if (hasColumn(interview, 'perception_analysis')) {
    const { error } = await supabase
      .from('interviews')
      .update({ perception_analysis: trimmed })
      .eq('id', interview.id);
    if (!error) return true;
    if (!isMissingColumnError(error)) {
      console.error('[webhook] perception_analysis update failed', {
        request_id: requestId || null,
        interview_id: interview.id,
        error: error.message || error
      });
      return false;
    }
  }

  if (hasColumn(interview, 'metadata')) {
    const baseMeta = interview.metadata && typeof interview.metadata === 'object' ? interview.metadata : {};
    const { error } = await supabase
      .from('interviews')
      .update({ metadata: { ...baseMeta, perception_analysis: trimmed } })
      .eq('id', interview.id);
    if (!error) return true;
    if (!isMissingColumnError(error)) {
      console.error('[webhook] perception_analysis metadata update failed', {
        request_id: requestId || null,
        interview_id: interview.id,
        error: error.message || error
      });
      return false;
    }
  }

  if (hasColumn(interview, 'perception_json')) {
    const { error } = await supabase
      .from('interviews')
      .update({ perception_json: { analysis: trimmed } })
      .eq('id', interview.id);
    if (!error) return true;
    if (!isMissingColumnError(error)) {
      console.error('[webhook] perception_analysis perception_json update failed', {
        request_id: requestId || null,
        interview_id: interview.id,
        error: error.message || error
      });
      return false;
    }
  }

  if (hasColumn(interview, 'notes')) {
    const { error } = await supabase
      .from('interviews')
      .update({ notes: trimmed })
      .eq('id', interview.id);
    if (!error) return true;
    if (!isMissingColumnError(error)) {
      console.error('[webhook] perception_analysis notes update failed', {
        request_id: requestId || null,
        interview_id: interview.id,
        error: error.message || error
      });
      return false;
    }
  }

  console.log('[webhook] perception_analysis skipped (no column)', {
    request_id: requestId || null,
    interview_id: interview.id
  });
  return false;
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
    const requestId = getRequestId(req, body);

    const eventTypeRaw = pickFirst(
      fromAny(body, 'event_type'),
      fromAny(body, 'eventType'),
      fromAny(body, 'type'),
      fromAny(body, 'payload.event_type'),
      fromAny(body, 'payload.eventType'),
      fromAny(body, 'payload.type'),
      fromAny(body, 'event'),
      fromAny(body, 'status')
    );

    const eventType = String(eventTypeRaw || '').toLowerCase();
    const isTranscriptionReady = eventType === 'application.transcription_ready';
    const isRecordingReady = eventType === 'application.recording_ready';
    const isPerceptionAnalysis = eventType === 'conversation.perception_analysis';
    const isReplicaJoined = eventType === 'system.replica_joined';
    const isShutdown = eventType === 'system.shutdown';
    const isKnownEvent = isReplicaJoined || isShutdown || isTranscriptionReady || isRecordingReady || isPerceptionAnalysis;

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
      request_id: requestId || null,
      event_type_raw: eventTypeRaw ?? null,
      event_type: eventType || null,
      interview_id: interviewId || null,
      conversation_id: conversationId || null,
      recording_url: recordingUrls,
      video_url: videoUrls
    });

    if (!isKnownEvent) {
      return res.status(200).json({ ok: true });
    }

    if (!interviewId && !conversationId) {
      return res.status(200).json({ ok: true });
    }

    const interview = await getInterviewByIds(interviewId, conversationId);
    if (!interview) {
      console.log('[webhook] interview not found', {
        request_id: requestId || null,
        event_type_raw: eventTypeRaw ?? null,
        interview_id: interviewId || null,
        conversation_id: conversationId || null
      });
      return res.status(200).json({ ok: true });
    }

    const updates = {};
    let transcriptNonEmpty = false;
    let analysisMissing = false;
    let shouldTriggerAnalysisRun = false;

    if (isTranscriptionReady) {
      const rawTranscript = pickFirst(
        fromAny(body, 'properties.transcript'),
        fromAny(body, 'transcript'),
        fromAny(body, 'payload.transcript')
      );

      const transcriptUrlSignal = pickFirst(
        fromAny(body, 'properties.transcript_url'),
        fromAny(body, 'transcript_url'),
        fromAny(body, 'payload.transcript_url')
      );
      const hasTranscriptSignal =
        (rawTranscript !== undefined && rawTranscript !== null) ||
        (transcriptUrlSignal !== undefined && transcriptUrlSignal !== null);
      if (hasTranscriptSignal) {
        const pathName = `interviews/${interview.id}.json`;
        const stored = await putJsonToStorage(TRANSCRIPTS_BUCKET, pathName, body);
        updates.transcript_url = stored;
      }

      const transcriptItems = Array.isArray(rawTranscript)
        ? rawTranscript
        : Array.isArray(rawTranscript?.messages)
          ? rawTranscript.messages
          : Array.isArray(fromAny(body, 'messages'))
            ? fromAny(body, 'messages')
            : Array.isArray(fromAny(body, 'transcript'))
              ? fromAny(body, 'transcript')
              : null;

      const sanitizedLines = transcriptItems ? sanitizeTranscriptArray(transcriptItems) : [];
      const transcriptText = sanitizedLines.join('\n').trim();
      if (transcriptText) {
        updates.transcript = transcriptText;
        updates.status = 'Transcribed';
        transcriptNonEmpty = true;
        analysisMissing = !hasTranscriptAnalysis(interview);
        shouldTriggerAnalysisRun = analysisMissing;
      } else {
        updates.transcript = null;
        updates.status = 'TranscriptionReceived';
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
        output_video_url: fromAny(body, 'output.video_url'),
        bucket_name: fromAny(body, 'bucket_name'),
        s3_key: fromAny(body, 's3_key'),
        duration: fromAny(body, 'duration'),
        properties_bucket_name: fromAny(body, 'properties.bucket_name'),
        properties_s3_key: fromAny(body, 'properties.s3_key'),
        properties_duration: fromAny(body, 'properties.duration'),
        payload_bucket_name: fromAny(body, 'payload.bucket_name'),
        payload_s3_key: fromAny(body, 'payload.s3_key'),
        payload_duration: fromAny(body, 'payload.duration'),
        output_bucket_name: fromAny(body, 'output.bucket_name'),
        output_s3_key: fromAny(body, 'output.s3_key'),
        output_duration: fromAny(body, 'output.duration')
      };
      console.log('[webhook] recording_ready fields', {
        request_id: requestId || null,
        ...recordingFieldSnapshot
      });

      const recordingUrl = pickFirst(
        fromAny(body, 'properties.recording_url'),
        fromAny(body, 'properties.video_url'),
        fromAny(body, 'recording_url'),
        fromAny(body, 'video_url'),
        fromAny(body, 'payload.recording_url'),
        fromAny(body, 'payload.video_url'),
        fromAny(body, 'output.video_url')
      );

      const recordingMeta = {
        bucket_name: pickFirst(
          fromAny(body, 'bucket_name'),
          fromAny(body, 'properties.bucket_name'),
          fromAny(body, 'payload.bucket_name'),
          fromAny(body, 'output.bucket_name')
        ),
        s3_key: pickFirst(
          fromAny(body, 's3_key'),
          fromAny(body, 'properties.s3_key'),
          fromAny(body, 'payload.s3_key'),
          fromAny(body, 'output.s3_key')
        ),
        duration: pickFirst(
          fromAny(body, 'duration'),
          fromAny(body, 'properties.duration'),
          fromAny(body, 'payload.duration'),
          fromAny(body, 'output.duration')
        )
      };

      const hasDownloadableUrl = isDownloadableRecordingUrl(recordingUrl);
      if (recordingUrl && !hasDownloadableUrl && isDailyRoomUrl(recordingUrl)) {
        const existingVideoUrl = interview.video_url || null;
        if (!existingVideoUrl || isDailyRoomUrl(existingVideoUrl)) {
          updates.video_url = null;
        }
      } else if (hasDownloadableUrl) {
        updates.video_url = recordingUrl;
      }

      if (!hasDownloadableUrl && Object.keys(pruneMetadata(recordingMeta)).length) {
        updates.recording_metadata = recordingMeta;
      }
    }

    if (isPerceptionAnalysis) {
      const analysisText = pickFirst(
        fromAny(body, 'properties.analysis'),
        fromAny(body, 'analysis'),
        fromAny(body, 'payload.analysis')
      );
      if (analysisText) {
        await updatePerceptionAnalysis(interview, analysisText, requestId);
      } else {
        console.log('[webhook] perception_analysis missing analysis', {
          request_id: requestId || null,
          interview_id: interview.id,
          conversation_id: conversationId || null
        });
      }
    }

    let updatesApplied = false;
    if (Object.keys(updates).length) {
      const { recording_metadata: recordingMeta, ...baseUpdates } = updates;
      try {
        await applyInterviewUpdates(interview.id, baseUpdates, recordingMeta);
        updatesApplied = true;
      } catch (err) {
        console.error('[webhook] interview update failed', {
          request_id: requestId || null,
          interview_id: interview.id,
          error: err?.message || err
        });
      }
    }

    if (transcriptNonEmpty && analysisMissing) {
      const { error: readyErr } = await supabase
        .from('interviews')
        .update({ status: 'ReadyForAnalysis' })
        .eq('id', interview.id);
      if (!readyErr) {
        console.log('[webhook] transcript ready -> marked ReadyForAnalysis', {
          request_id: requestId || null,
          interview_id: interview.id
        });
      } else {
        console.error('[webhook] ReadyForAnalysis update failed', {
          request_id: requestId || null,
          interview_id: interview.id,
          error: readyErr.message || readyErr
        });
      }
    }

    if (transcriptNonEmpty && !analysisMissing) {
      console.log('[webhook] skip transcript analysis (already analyzed)', {
        request_id: requestId || null,
        interview_id: interview.id
      });
    }

    if (
      shouldTriggerAnalysisRun &&
      transcriptNonEmpty &&
      shouldTriggerAnalysis(interview.id, requestId)
    ) {
      console.log('[webhook] trigger transcript analysis', {
        request_id: requestId || null,
        interview_id: interview.id,
        transcriptNonEmpty,
        analysisMissing
      });
      setImmediate(() => {
        analyzeInterviewTranscriptById(interview.id, { request_id: requestId || null })
          .then((result) => {
            console.log('[webhook] transcript analysis finished', {
              request_id: requestId || null,
              interview_id: interview.id,
              ok: result?.ok ?? null,
              updated: result?.updated ?? null,
              skipped: result?.skipped ?? null,
              reason: result?.reason ?? null
            });
          })
          .catch((err) => {
            console.error('[webhook] transcript analysis failed', {
              request_id: requestId || null,
              interview_id: interview.id,
              error: err?.message || err
            });
          });
      });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[webhook] error:', e.message || e);
    // Be lenient to avoid provider retries storms
    return res.status(200).json({ ok: true });
  }
});

module.exports = router;
