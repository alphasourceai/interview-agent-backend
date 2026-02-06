// routes/adminReprocessTranscript.js
'use strict';

const express = require('express');
const { supabase } = require('../src/lib/supabaseClient');

const router = express.Router();

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

async function downloadJsonFromStorage(pathValue) {
  if (!pathValue || typeof pathValue !== 'string') return null;

  if (/^https?:\/\//i.test(pathValue)) {
    const resp = await fetch(pathValue);
    if (!resp.ok) return null;
    return resp.json();
  }

  const [bucket, ...rest] = pathValue.split('/');
  const objectPath = rest.join('/');
  if (!bucket || !objectPath) return null;

  const { data, error } = await supabase.storage.from(bucket).download(objectPath);
  if (error || !data) return null;

  const ab = await data.arrayBuffer();
  const text = Buffer.from(ab).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

router.post('/', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const interviewId = req.body?.interview_id || null;
    if (!interviewId) {
      return res.status(200).json({ ok: true, updated: false });
    }

    const { data: interview, error } = await supabase
      .from('interviews')
      .select('id, transcript, transcript_url, status')
      .eq('id', interviewId)
      .maybeSingle();

    if (error || !interview) {
      return res.status(200).json({ ok: true, updated: false });
    }

    const transcriptText = typeof interview.transcript === 'string' ? interview.transcript.trim() : '';
    if (!interview.transcript_url || transcriptText) {
      return res.status(200).json({ ok: true, updated: false });
    }

    const payload = await downloadJsonFromStorage(interview.transcript_url);
    if (!payload) {
      return res.status(200).json({ ok: true, updated: false });
    }

    const rawTranscript = pickFirst(
      fromAny(payload, 'properties.transcript'),
      fromAny(payload, 'transcript'),
      fromAny(payload, 'payload.transcript')
    );

    const transcriptItems = Array.isArray(rawTranscript)
      ? rawTranscript
      : Array.isArray(rawTranscript?.messages)
        ? rawTranscript.messages
        : null;

    const sanitizedLines = transcriptItems ? sanitizeTranscriptArray(transcriptItems) : [];
    const sanitizedText = sanitizedLines.join('\n').trim();

    const updates = sanitizedText
      ? { transcript: sanitizedText, status: 'Transcribed' }
      : { transcript: null, status: 'TranscriptionReceived' };

    const { error: uErr } = await supabase
      .from('interviews')
      .update(updates)
      .eq('id', interview.id);

    if (uErr) {
      return res.status(200).json({ ok: true, updated: false });
    }

    return res.status(200).json({ ok: true, updated: true });
  } catch (_err) {
    return res.status(200).json({ ok: true, updated: false });
  }
});

module.exports = router;
