// routes/webhook.js
'use strict';

const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { analyzeInterviewTranscriptById } = require('../scripts/backfillInterviews.js');
const { INSUFFICIENT_SUMMARY, isSubstantiveTranscript, scoreInterview } = require('../src/lib/interviewScoring');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const TRANSCRIPTS_BUCKET = process.env.SUPABASE_TRANSCRIPTS_BUCKET || 'transcripts';

const DAILY_ROOM_RE = /(^https?:\/\/)?([a-z0-9-]+\.)?(tavus\.daily\.co|c\.daily\.co)(\/|\?|$)/i;
const ANALYSIS_TRIGGER_TTL_MS = 2 * 60 * 1000;
const analysisTriggerGuard = new Map();
const roleJdCache = new Map();

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

function looksLikeJson(value) {
  if (value == null) return false;
  const trimmed = String(value).trim();
  if (!trimmed) return false;
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function extractPerceptionScores(payload) {
  if (!payload || typeof payload !== 'object') return {};

  const clarityRaw = pickFirst(
    fromAny(payload, 'clarity'),
    fromAny(payload, 'scores.clarity'),
    fromAny(payload, 'analysis.clarity'),
    fromAny(payload, 'analysis.scores.clarity')
  );
  const confidenceRaw = pickFirst(
    fromAny(payload, 'confidence'),
    fromAny(payload, 'scores.confidence'),
    fromAny(payload, 'analysis.confidence'),
    fromAny(payload, 'analysis.scores.confidence')
  );
  const engagementRaw = pickFirst(
    fromAny(payload, 'engagement'),
    fromAny(payload, 'engagement_score'),
    fromAny(payload, 'body_language'),
    fromAny(payload, 'bodyLanguage'),
    fromAny(payload, 'body_language_score'),
    fromAny(payload, 'bodyLanguageScore'),
    fromAny(payload, 'nonverbal'),
    fromAny(payload, 'non_verbal'),
    fromAny(payload, 'nonVerbal'),
    fromAny(payload, 'nonverbal_score'),
    fromAny(payload, 'nonVerbalScore'),
    fromAny(payload, 'scores.engagement'),
    fromAny(payload, 'scores.body_language'),
    fromAny(payload, 'scores.bodyLanguage'),
    fromAny(payload, 'scores.bodyLanguageScore'),
    fromAny(payload, 'scores.nonverbal'),
    fromAny(payload, 'scores.nonVerbal'),
    fromAny(payload, 'analysis.engagement'),
    fromAny(payload, 'analysis.body_language'),
    fromAny(payload, 'analysis.bodyLanguage'),
    fromAny(payload, 'analysis.bodyLanguageScore'),
    fromAny(payload, 'analysis.nonverbal'),
    fromAny(payload, 'analysis.nonVerbal'),
    fromAny(payload, 'analysis.scores.engagement'),
    fromAny(payload, 'analysis.scores.body_language'),
    fromAny(payload, 'analysis.scores.bodyLanguage'),
    fromAny(payload, 'analysis.scores.bodyLanguageScore'),
    fromAny(payload, 'analysis.scores.nonverbal'),
    fromAny(payload, 'analysis.scores.nonVerbal')
  );

  const out = {};
  const clarity = clampScore(clarityRaw);
  const confidence = clampScore(confidenceRaw);
  const engagement = clampScore(engagementRaw);
  if (clarity !== null) out.clarity = clarity;
  if (confidence !== null) out.confidence = confidence;
  if (engagement !== null) out.engagement = engagement;
  return out;
}

function extractPerceptionScoresFromText(text) {
  if (!text || typeof text !== 'string') return {};
  const readNum = (re) => {
    const match = re.exec(text);
    if (!match) return null;
    return clampScore(match[1]);
  };
  const clarity = readNum(/CLARITY\s*[:=]\s*(\d{1,3})/i);
  const confidence = readNum(/CONFIDENCE\s*[:=]\s*(\d{1,3})/i);
  let engagement = readNum(/ENGAGEMENT\s*[:=]\s*(\d{1,3})/i);
  if (engagement === null) engagement = readNum(/BODY[_\s-]*LANGUAGE\s*[:=]\s*(\d{1,3})/i);
  if (engagement === null) engagement = readNum(/NONVERBAL\s*[:=]\s*(\d{1,3})/i);

  const out = {};
  if (clarity !== null) out.clarity = clarity;
  if (confidence !== null) out.confidence = confidence;
  if (engagement !== null) out.engagement = engagement;
  return out;
}

function extractJsonFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || null;
  if (candidate) {
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const snippet = text.slice(first, last + 1);
    try {
      return JSON.parse(snippet);
    } catch {
      return null;
    }
  }
  return null;
}

function sanitizePerceptionText(text) {
  if (!text) return '';
  let out = String(text);
  const patterns = [
    /\b(\d{1,2}\s*-\s*year\s*-\s*old|\d{1,2}\s*year\s*old|\d{2}s|teen(ager|age)?|young|younger|middle[-\s]?aged|elderly|senior|old|older)\b/gi,
    /\b(male|female|man|woman|boy|girl|nonbinary|non-binary|transgender|cisgender|trans|cis)\b/gi,
    /\b(white|black|african\s*american|asian|latino|latina|latinx|hispanic|indigenous|native\s*american|middle\s*eastern|arab|pacific\s*islander)\b/gi,
    /\b(christian|muslim|jewish|hindu|buddhist|sikh|atheist|agnostic|catholic|protestant|mormon)\b/gi,
    /\b(disabled|disability|wheelchair|blind|deaf|autistic|adhd|amputee|bipolar|schizophrenia|ptsd|paralyzed)\b/gi,
    /\b(pregnant|pregnancy)\b/gi,
    /\b(in|around)\s+(his|her|their)\s+\d{2}s\b/gi,
    /\b(appears|appeared|seems|seemed|looks|looked)\s+(?:to\s+be\s+)?(young|older|middle[-\s]?aged|elderly|\d{2}s)\b/gi
  ];
  for (const re of patterns) {
    out = out.replace(re, '[REDACTED]');
  }
  out = out.replace(/\[REDACTED\](\s+\[REDACTED\])+/g, '[REDACTED]');
  out = out.replace(/\s{2,}/g, ' ').trim();
  return out;
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
  const transcriptScores = interview.analysis.transcript_scores && typeof interview.analysis.transcript_scores === 'object'
    ? Object.keys(interview.analysis.transcript_scores).length > 0
    : false;
  const legacyScores = interview.analysis.scores && typeof interview.analysis.scores === 'object'
    ? Object.keys(interview.analysis.scores).length > 0
    : false;
  return !!summary && (transcriptScores || legacyScores);
}

function isTranscriptAnalysisComplete(analysis) {
  if (!analysis) return false;
  let obj = analysis;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return false;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const overallNew = obj.transcript_scores && typeof obj.transcript_scores === 'object'
    ? obj.transcript_scores.overall
    : undefined;
  const overallLegacy = obj.scores && typeof obj.scores === 'object'
    ? obj.scores.overall
    : undefined;
  return Number.isFinite(overallNew) || Number.isFinite(overallLegacy);
}

function isTranscriptAnalysisCompleteForRow(row) {
  if (!row) return false;
  if (row.transcript_scores && typeof row.transcript_scores === 'object') {
    if (Number.isFinite(row.transcript_scores.overall)) return true;
  }
  return isTranscriptAnalysisComplete(row.analysis);
}

function extractAnswerScoresFromAnalysis(analysis) {
  let obj = analysis;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const src = obj.transcript_scores && typeof obj.transcript_scores === 'object'
    ? obj.transcript_scores
    : obj.scores && typeof obj.scores === 'object'
      ? obj.scores
      : null;
  if (!src) return {};
  const out = {};
  if (Number.isFinite(src.overall)) out.overall = src.overall;
  if (Number.isFinite(src.role_fit ?? src.roleFit)) out.role_fit = Number.isFinite(src.role_fit) ? src.role_fit : src.roleFit;
  if (Number.isFinite(src.technical_strength ?? src.technicalStrength)) {
    out.technical_strength = Number.isFinite(src.technical_strength) ? src.technical_strength : src.technicalStrength;
  }
  if (Number.isFinite(src.communication_quality ?? src.communicationQuality)) {
    out.communication_quality = Number.isFinite(src.communication_quality) ? src.communication_quality : src.communicationQuality;
  }
  return out;
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

async function getRoleJdText(roleId, requestId, interviewId, conversationId) {
  if (!roleId) return '';
  const cacheKey = String(roleId);
  if (roleJdCache.has(cacheKey)) return roleJdCache.get(cacheKey);

  const { data, error } = await supabaseAdmin
    .from('roles')
    .select('id, job_description_text, job_description_url')
    .eq('id', roleId)
    .maybeSingle();

  if (error) {
    console.error('[webhook] role jd lookup failed', {
      request_id: requestId || null,
      interview_id: interviewId || null,
      conversation_id: conversationId || null,
      role_id: roleId || null,
      error: error.message || error,
      details: error.details || null,
      hint: error.hint || null
    });
    roleJdCache.set(cacheKey, '');
    return '';
  }

  const jdText = typeof data?.job_description_text === 'string' && data.job_description_text.trim()
    ? data.job_description_text.trim()
    : (typeof data?.job_description_url === 'string' ? data.job_description_url.trim() : '');
  roleJdCache.set(cacheKey, jdText || '');
  return jdText || '';
}

async function applyTranscriptScoringForInterview({ interview, fresh, transcriptText, requestId, conversationId }) {
  const transcript = typeof transcriptText === 'string' ? transcriptText.trim() : '';
  const substantiveCheck = isSubstantiveTranscript(transcript);
  const existingTopScores =
    fresh?.transcript_scores && typeof fresh.transcript_scores === 'object'
      ? fresh.transcript_scores
      : {};
  const existingSummary = typeof fresh?.interview_summary === 'string' ? fresh.interview_summary.trim() : '';
  const existingOverall = existingTopScores.overall;
  const existingConfidence = existingTopScores.confidence;
  const hasInsufficientSummary = existingSummary === INSUFFICIENT_SUMMARY ||
    existingSummary.includes('Interview ended before any substantive responses were recorded.');

  if (substantiveCheck.ok && Number.isFinite(existingOverall) && Number.isFinite(existingConfidence) && existingSummary) {
    return { updated: false, substantive: true, reason: 'already_scored' };
  }
  if (!substantiveCheck.ok && Number(existingConfidence) === 0 && hasInsufficientSummary) {
    return { updated: false, substantive: false, reason: 'already_insufficient' };
  }

  const roleId = fresh?.role_id || interview?.role_id || null;
  const jdText = await getRoleJdText(roleId, requestId, interview?.id, conversationId);
  const perceptionScores =
    fresh?.perception_scores && typeof fresh.perception_scores === 'object'
      ? fresh.perception_scores
      : (
        interview?.perception_scores && typeof interview.perception_scores === 'object'
          ? interview.perception_scores
          : {}
      );

  const scored = await scoreInterview({
    transcriptText: transcript,
    jdText,
    perceptionScores,
    mode: 'webhook',
    request_id: requestId || null
  });

  if (!substantiveCheck.ok) {
    console.log('[webhook] transcript summary skipped insufficient', {
      request_id: requestId || null,
      interview_id: interview?.id || null,
      reason: substantiveCheck.reason
    });
  }

  const updateFields = {
    transcript_scores: {
      ...existingTopScores,
      ...(scored?.transcript_scores || {})
    }
  };
  if (substantiveCheck.ok) {
    if (!existingSummary || existingSummary === INSUFFICIENT_SUMMARY) {
      updateFields.interview_summary = scored.summary;
    }
  } else if (!hasInsufficientSummary) {
    updateFields.interview_summary = scored.summary;
  }

  const { error: scoreErr } = await supabaseAdmin
    .from('interviews')
    .update(updateFields)
    .eq('id', interview.id);
  if (scoreErr) {
    console.error('[webhook] transcript_scores update failed', {
      request_id: requestId || null,
      interview_id: interview.id,
      conversation_id: conversationId || null,
      error: scoreErr.message || scoreErr,
      details: scoreErr.details || null,
      hint: scoreErr.hint || null
    });
    return { updated: false, substantive: substantiveCheck.ok, reason: 'update_failed' };
  }

  return { updated: true, substantive: substantiveCheck.ok, reason: substantiveCheck.reason };
}

function extractCandidateQuestions(transcriptText) {
  if (!transcriptText || typeof transcriptText !== 'string') return [];
  const markerRe = /\[\[UNANSWERED_QUESTION:\s*([^\]]+?)\s*\]\]/g;
  const markerSet = new Set();
  let match;
  while ((match = markerRe.exec(transcriptText)) !== null) {
    const text = String(match[1] || '').trim();
    if (text) markerSet.add(text);
  }
  if (markerSet.size) return Array.from(markerSet);

  const lines = transcriptText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = new Set();
  const interrogativeRe = /^(who|what|when|where|why|how|can|could|would|do|does|is|are|should)\b/i;
  const refusalRe = /note it for the hiring manager|i don't have that information|i do not have that information|i can't answer|i cannot answer|i will pass it to the hiring manager|i'll pass it to the hiring manager|i will note it for the hiring manager|i'll note it for the hiring manager/i;
  let lastCandidate = '';
  for (const line of lines) {
    const upper = line.toUpperCase();
    const isInterviewer = upper.startsWith('INTERVIEWER:');
    const isCandidate = upper.startsWith('CANDIDATE:');
    let cleaned = line;
    if (isInterviewer) cleaned = line.slice('INTERVIEWER:'.length).trim();
    if (isCandidate) cleaned = line.slice('CANDIDATE:'.length).trim();

    if (isCandidate) {
      if (cleaned) lastCandidate = cleaned;
      if (cleaned && (cleaned.includes('?') || interrogativeRe.test(cleaned))) {
        out.add(cleaned);
      }
      continue;
    }

    if (isInterviewer && refusalRe.test(cleaned) && lastCandidate) {
      out.add(lastCandidate);
    }
  }
  return Array.from(out).slice(0, 10);
}

function isEmptyQuestionList(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return !value.trim();
  return false;
}

async function applyInterviewUpdates(interviewId, updates, recordingMeta) {
  const baseUpdates = updates && Object.keys(updates).length ? updates : null;
  const cleanedMeta = pruneMetadata(recordingMeta);
  const hasMeta = Object.keys(cleanedMeta).length > 0;

  if (!hasMeta) {
    if (!baseUpdates) return;
    const { error } = await supabaseAdmin.from('interviews').update(baseUpdates).eq('id', interviewId);
    if (error) throw error;
    return;
  }

  const combined = { ...(baseUpdates || {}), ...cleanedMeta };
  let { error } = await supabaseAdmin.from('interviews').update(combined).eq('id', interviewId);
  if (!error) return;

  if (!isMissingColumnError(error)) throw error;

  if (baseUpdates) {
    const { error: baseErr } = await supabaseAdmin.from('interviews').update(baseUpdates).eq('id', interviewId);
    if (baseErr) throw baseErr;
  }

  ({ error } = await supabaseAdmin
    .from('interviews')
    .update({ recording_metadata: cleanedMeta })
    .eq('id', interviewId));
  if (!error) return;
  if (!isMissingColumnError(error)) throw error;

  const pathName = `interviews/${interviewId}-recording-metadata.json`;
  const stored = await putJsonToStorage(TRANSCRIPTS_BUCKET, pathName, cleanedMeta);

  const { error: urlErr } = await supabaseAdmin
    .from('interviews')
    .update({ recording_metadata_url: stored })
    .eq('id', interviewId);
  if (urlErr && !isMissingColumnError(urlErr)) throw urlErr;
}

async function updatePerceptionAnalysis(interview, analysisText, requestId) {
  let rawText;
  if (analysisText && typeof analysisText === 'object') {
    try {
      rawText = JSON.stringify(analysisText);
    } catch {
      rawText = String(analysisText);
    }
  } else {
    rawText = String(analysisText || '');
  }
  rawText = String(rawText || '').trim();
  if (!rawText) return { stored: false, perception_scores: {} };
  const sanitizedText = sanitizePerceptionText(rawText);
  const conversationId = interview?.tavus_application_id || interview?.conversation_id || null;

  let perceptionScores = {};
  let parsedDirect = null;
  if (analysisText && typeof analysisText === 'object') {
    parsedDirect = analysisText;
  } else if (looksLikeJson(rawText)) {
    try {
      parsedDirect = JSON.parse(rawText);
    } catch (err) {
      console.error('[webhook] perception_analysis JSON parse failed', {
        request_id: requestId || null,
        interview_id: interview.id,
        conversation_id: conversationId,
        error: err?.message || err,
        details: err?.details || null,
        hint: err?.hint || null
      });
    }
  }

  if (parsedDirect) {
    perceptionScores = extractPerceptionScores(parsedDirect);
  }

  if (!Object.keys(perceptionScores).length) {
    const blockJson = extractJsonFromText(rawText);
    if (blockJson) {
      perceptionScores = extractPerceptionScores(blockJson);
    }
  }

  if (!Object.keys(perceptionScores).length) {
    perceptionScores = extractPerceptionScoresFromText(rawText);
  }

  const updates = { perception_analysis_text: sanitizedText };
  if (Object.keys(perceptionScores).length) {
    const existingScores =
      interview.perception_scores && typeof interview.perception_scores === 'object'
        ? interview.perception_scores
        : {};
    updates.perception_scores = { ...existingScores, ...perceptionScores };
  }

  const { error } = await supabaseAdmin
    .from('interviews')
    .update(updates)
    .eq('id', interview.id);
  if (error) {
    console.error('[webhook] perception_analysis update failed', {
      request_id: requestId || null,
      interview_id: interview.id,
      conversation_id: conversationId,
      error: error.message || error,
      details: error.details || null,
      hint: error.hint || null
    });
    return { stored: false, perception_scores: perceptionScores };
  }

  return { stored: true, perception_scores: perceptionScores };
}

async function getInterviewByIds(interviewId, conversationId) {
  if (conversationId) {
    let { data } = await supabaseAdmin
      .from('interviews')
      .select('*')
      .eq('tavus_application_id', conversationId)
      .maybeSingle();
    if (data) return data;

    ({ data } = await supabaseAdmin
      .from('interviews')
      .select('*')
      .eq('conversation_id', conversationId)
      .maybeSingle());
    if (data) return data;
  }

  if (interviewId) {
    const { data } = await supabaseAdmin
      .from('interviews')
      .select('*')
      .eq('id', interviewId)
      .maybeSingle();
    return data || null;
  }

  return null;
}

async function ensureBucket(name) {
  const { data: list } = await supabaseAdmin.storage.listBuckets();
  if (!list?.find(b => b.name === name)) {
    try {
      await supabaseAdmin.storage.createBucket(name, { public: false });
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

  const { error } = await supabaseAdmin
    .storage
    .from(bucket)
    .upload(pathName, buf, { upsert: true, contentType });
  if (error) throw new Error(error.message);

  return `${bucket}/${pathName}`;
}

function extractSanitizedContent(item) {
  if (!item) return null;

  const role = typeof item.role === 'string' ? item.role.trim().toLowerCase() : '';
  if (!role || role === 'system') return null;

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
  if (!text) return null;

  if (role === 'user') {
    return `CANDIDATE: ${text}`;
  }

  if (role === 'assistant' || role === 'interviewer' || role === 'agent') {
    return `INTERVIEWER: ${text}`;
  }

  return null;
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
    const isPerceptionAnalysis =
      eventType === 'conversation.perception_analysis' ||
      eventType === 'application.perception_analysis';
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

    if (!supabaseAdmin) {
      console.error('[webhook] fatal missing supabase admin credentials', {
        request_id: requestId || null,
        interview_id: interviewId || null,
        conversation_id: conversationId || null
      });
      return res.status(200).json({ ok: true });
    }

    const interview = await getInterviewByIds(interviewId, conversationId);
    if (!interview) {
      console.error(`[webhook] interview not found conversation_id=${conversationId || 'null'}`);
      return res.status(200).json({ ok: true });
    }

    const statusBefore = interview.status || null;
    let statusAfter = null;
    let analysisCompleteSummary = null;
    let perceptionKeysCount = null;
    let unansweredQuestionsCount = null;

    const updates = {};
    let transcriptNonEmpty = false;
    let analysisMissing = false;
    let shouldTriggerAnalysisRun = false;
    let transcriptText = '';

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
      transcriptText = sanitizedLines.join('\n\n').trim();
      if (transcriptText) {
        updates.transcript = transcriptText;
        updates.status = 'Transcribed';
        transcriptNonEmpty = true;
        analysisMissing = !isTranscriptAnalysisCompleteForRow(interview);
        shouldTriggerAnalysisRun = analysisMissing;
      } else {
        updates.transcript = null;
        updates.status = 'TranscriptionReceived';
      }
    }

    if (!transcriptText && interview?.transcript) {
      const existingTranscript = String(interview.transcript || '').trim();
      if (existingTranscript) {
        transcriptText = existingTranscript;
        if (!transcriptNonEmpty) {
          transcriptNonEmpty = true;
          analysisMissing = !isTranscriptAnalysisCompleteForRow(interview);
          shouldTriggerAnalysisRun = analysisMissing;
        }
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
      let perceptionRawPath = null;
      try {
        const perceptionPath = `interviews/${interview.id}-perception.json`;
        perceptionRawPath = await putJsonToStorage(TRANSCRIPTS_BUCKET, perceptionPath, body);
        const { error: rawErr } = await supabaseAdmin
          .from('interviews')
          .update({ perception_raw_path: perceptionRawPath })
          .eq('id', interview.id);
        if (rawErr) {
          console.error('[webhook] perception_raw_path update failed', {
            request_id: requestId || null,
            interview_id: interview.id,
            conversation_id: conversationId || null,
            error: rawErr.message || rawErr,
            details: rawErr.details || null,
            hint: rawErr.hint || null
          });
        }
      } catch (err) {
        console.error('[webhook] perception_analysis storage failed', {
          request_id: requestId || null,
          interview_id: interview.id,
          conversation_id: conversationId || null,
          error: err?.message || err,
          details: err?.details || null,
          hint: err?.hint || null
        });
      }

      let analysisText = pickFirst(
        fromAny(body, 'properties.analysis'),
        fromAny(body, 'analysis'),
        fromAny(body, 'payload.analysis'),
        fromAny(body, 'properties.perception_analysis'),
        fromAny(body, 'perception_analysis'),
        fromAny(body, 'payload.perception_analysis')
      );
      if (analysisText && typeof analysisText === 'object') {
        try {
          analysisText = JSON.stringify(analysisText);
        } catch {
          analysisText = String(analysisText);
        }
      }
      if (analysisText) {
        const perceptionResult = await updatePerceptionAnalysis(interview, analysisText, requestId);
        const extractedKeys = Object.keys(perceptionResult?.perception_scores || {});
        perceptionKeysCount = extractedKeys.length;
        console.log('[webhook] perception_analysis processed', {
          request_id: requestId || null,
          event_type: eventType || null,
          interview_id: interview.id,
          conversation_id: conversationId || null,
          extracted_keys: extractedKeys,
          extracted_count: extractedKeys.length,
          stored: perceptionResult?.stored ?? null
        });
      } else {
        perceptionKeysCount = 0;
        console.log('[webhook] perception_analysis missing analysis', {
          request_id: requestId || null,
          interview_id: interview.id,
          conversation_id: conversationId || null,
          top_keys: Object.keys(body || {}),
          payload_keys: Object.keys(body?.payload || {})
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
          conversation_id: conversationId || null,
          error: err?.message || err,
          details: err?.details || null,
          hint: err?.hint || null
        });
      }
    }

    let freshAfterTranscript = null;
    let transcriptForQuestions = transcriptText;
    if (isTranscriptionReady) {
      const { data: fresh, error: freshErr } = await supabaseAdmin
        .from('interviews')
        .select('id, role_id, status, analysis, transcript_scores, transcript, interview_summary, perception_scores, unanswered_candidate_questions')
        .eq('id', interview.id)
        .maybeSingle();
      if (freshErr) {
        console.error('[webhook] post-transcription reselect failed', {
          request_id: requestId || null,
          interview_id: interview.id,
          conversation_id: conversationId || null,
          error: freshErr.message || freshErr,
          details: freshErr.details || null,
          hint: freshErr.hint || null
        });
      } else {
        freshAfterTranscript = fresh;
        const freshTranscript = typeof fresh?.transcript === 'string' ? fresh.transcript.trim() : '';
        if (!transcriptForQuestions && freshTranscript) {
          transcriptForQuestions = freshTranscript;
          transcriptNonEmpty = true;
        }

        const analysisComplete = isTranscriptAnalysisCompleteForRow(fresh);
        analysisCompleteSummary = analysisComplete;
        if (transcriptNonEmpty) {
          analysisMissing = !analysisComplete;
          shouldTriggerAnalysisRun = analysisMissing;
        }
        if (transcriptNonEmpty) {
          const scoringResult = await applyTranscriptScoringForInterview({
            interview,
            fresh,
            transcriptText: freshTranscript || transcriptForQuestions || '',
            requestId,
            conversationId
          });

          const statusFrom = fresh.status || null;
          let statusTo = null;
          const allowed = [
            'ReadyForAnalysis',
            'Ready For Analysis',
            'Transcribed',
            'TranscriptionReceived',
            'TranscriptionReady',
            'TranscriptReady',
            'Video Ready'
          ];
          if (allowed.includes(statusFrom)) {
            statusTo = analysisComplete ? 'Analyzed' : 'ReadyForAnalysis';
          }

          if (statusTo) {
            const { error: statusErr } = await supabaseAdmin
              .from('interviews')
              .update({ status: statusTo })
              .eq('id', interview.id);
            if (statusErr) {
              console.error('[webhook] analysis status update failed', {
                request_id: requestId || null,
                interview_id: interview.id,
                conversation_id: conversationId || null,
                error: statusErr.message || statusErr,
                details: statusErr.details || null,
                hint: statusErr.hint || null
              });
            } else if (statusTo !== statusFrom) {
              statusAfter = statusTo;
            }
          }

          console.log('[webhook] post-transcription status normalization', {
            interview_id: interview.id,
            status_from: statusFrom,
            status_to: statusTo,
            scoring_updated: scoringResult?.updated || false
          });
        }
      }
    }

    if (transcriptNonEmpty && !analysisMissing) {
      console.log('[webhook] skip transcript analysis (already analyzed)', {
        request_id: requestId || null,
        interview_id: interview.id
      });
    }

    const currentQuestions = freshAfterTranscript
      ? freshAfterTranscript.unanswered_candidate_questions
      : interview.unanswered_candidate_questions;
    const needsQuestionCapture =
      transcriptNonEmpty &&
      transcriptForQuestions &&
      isEmptyQuestionList(currentQuestions);

    if (needsQuestionCapture) {
      const questions = extractCandidateQuestions(transcriptForQuestions);
      unansweredQuestionsCount = questions.length;
      if (questions.length) {
        setImmediate(async () => {
          try {
            const { error } = await supabaseAdmin
              .from('interviews')
              .update({ unanswered_candidate_questions: questions })
              .eq('id', interview.id);
            if (error) {
              console.error('[webhook] unanswered_candidate_questions update failed', {
                request_id: requestId || null,
                interview_id: interview.id,
                conversation_id: conversationId || null,
                error: error.message || error,
                details: error.details || null,
                hint: error.hint || null
              });
            } else {
              console.log('[webhook] unanswered_candidate_questions updated', {
                request_id: requestId || null,
                interview_id: interview.id,
                count: questions.length
              });
            }
          } catch (err) {
            console.error('[webhook] unanswered_candidate_questions update failed', {
              request_id: requestId || null,
              interview_id: interview.id,
              conversation_id: conversationId || null,
              error: err?.message || err,
              details: err?.details || null,
              hint: err?.hint || null
            });
          }
        });
      }
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
      setImmediate(async () => {
        try {
          const result = await analyzeInterviewTranscriptById(interview.id, {
            request_id: requestId || null,
            dry_run: false
          });
          let analysisComplete = false;
          let statusFrom = null;
          let statusTo = null;
          let statusError = null;

          if (result?.ok) {
            const { data: fresh, error: freshErr } = await supabaseAdmin
              .from('interviews')
              .select('id, role_id, status, analysis, transcript_scores, transcript, interview_summary, perception_scores')
              .eq('id', interview.id)
              .maybeSingle();
            if (!freshErr && fresh) {
          analysisComplete = isTranscriptAnalysisCompleteForRow(fresh);
          statusFrom = fresh.status || null;
          await applyTranscriptScoringForInterview({
            interview,
            fresh,
            transcriptText: typeof fresh.transcript === 'string' ? fresh.transcript : '',
            requestId,
            conversationId
          });

              const allowed = [
                'ReadyForAnalysis',
                'Ready For Analysis',
                'Transcribed',
                'TranscriptionReceived',
                'TranscriptionReady',
                'TranscriptReady',
                'Video Ready'
              ];
              if (allowed.includes(statusFrom)) {
                if (analysisComplete) {
                  statusTo = 'Analyzed';
                } else if (typeof fresh.transcript === 'string' && fresh.transcript.trim()) {
                  statusTo = 'ReadyForAnalysis';
                }
              }
              if (statusTo) {
                const { error: statusErr } = await supabaseAdmin
                  .from('interviews')
                  .update({ status: statusTo })
                  .eq('id', interview.id);
                if (statusErr) {
                  statusError = statusErr.message || statusErr;
                  console.error('[webhook] analysis status update failed', {
                    request_id: requestId || null,
                    interview_id: interview.id,
                    conversation_id: conversationId || null,
                    error: statusErr.message || statusErr,
                    details: statusErr.details || null,
                    hint: statusErr.hint || null
                  });
                }
              }
            } else if (freshErr) {
              statusError = freshErr.message || freshErr;
            }
          }

          console.log('[webhook] transcript analysis finished', {
            request_id: requestId || null,
            interview_id: interview.id,
            ok: result?.ok ?? null,
            updated: result?.updated ?? null,
            skipped: result?.skipped ?? null,
            reason: result?.reason ?? null,
            error: result?.error ?? statusError ?? null,
            analysis_complete: analysisComplete,
            status_from: statusFrom,
            status_to: statusTo
          });
          if (result?.ok === false) {
            console.error('[webhook] transcript analysis update failed', {
              request_id: requestId || null,
              interview_id: interview.id,
              conversation_id: conversationId || null,
              error: result?.error ?? null
            });
          }
        } catch (err) {
          console.error('[webhook] transcript analysis failed', {
            request_id: requestId || null,
            interview_id: interview.id,
            conversation_id: conversationId || null,
            error: err?.message || err
          });
        }
      });
    }

    if (analysisCompleteSummary === null) {
      analysisCompleteSummary = isTranscriptAnalysisCompleteForRow(interview);
    }

    console.log('[webhook] summary', {
      request_id: requestId || null,
      event_type: eventType || null,
      interview_id: interview.id,
      conversation_id: conversationId || null,
      status_before: statusBefore,
      status_after: statusAfter,
      analysis_complete: analysisCompleteSummary,
      perception_keys_count: perceptionKeysCount,
      unanswered_questions_count: unansweredQuestionsCount
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[webhook] error:', e.message || e);
    // Be lenient to avoid provider retries storms
    return res.status(200).json({ ok: true });
  }
});

module.exports = router;
