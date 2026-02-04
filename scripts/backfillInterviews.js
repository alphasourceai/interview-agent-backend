// scripts/backfillInterviews.js
require('dotenv').config();
const fetch = require('node-fetch');

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
  process.env.SUPABASE_URL,
  // Service role key so we can write to any row
  process.env.SUPABASE_SERVICE_ROLE_KEY
);


const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

// Helpers to read private Supabase Storage objects
function parsePublicStorageUrl(u) {
  // matches /storage/v1/object/{public|sign}/<bucket>/<path...>
  const m = u?.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/);
  return m ? { bucket: m[1], path: m[2] } : null;
}

function parseStoredRef(ref) {
  if (!ref) return null;
  const trimmed = String(ref).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return null;
  let path = trimmed.replace(/^\/+/, '');
  if (path.startsWith('transcripts/')) {
    path = path.slice('transcripts/'.length);
  }
  return { bucket: 'transcripts', path };
}

function resolveTranscriptRef(ref) {
  if (!ref) return null;
  const trimmed = String(ref).trim();
  if (!trimmed) return null;

  const storage = parsePublicStorageUrl(trimmed);
  if (storage) return { ...storage, source: 'storage-url' };

  if (/^https?:\/\//i.test(trimmed)) {
    return { url: trimmed, source: 'http' };
  }

  const stored = parseStoredRef(trimmed);
  return stored ? { ...stored, source: 'path' } : null;
}

async function downloadTranscriptPayload(ref) {
  const resolved = resolveTranscriptRef(ref);
  if (!resolved) return null;

  if (resolved.source === 'storage-url' || resolved.source === 'path') {
    const { data, error } = await supabase.storage.from(resolved.bucket).download(resolved.path);
    if (error || !data) {
      console.warn('[transcript] storage download failed', {
        bucket: resolved.bucket,
        path: resolved.path,
        error: error?.message || error
      });
      if (resolved.source === 'storage-url' && /^https?:\/\//i.test(String(ref || ''))) {
        // fallback to HTTP fetch for public/signed URLs
        try {
          const res = await fetch(ref);
          if (!res.ok) return null;
          const text = await res.text();
          try {
            return JSON.parse(text);
          } catch {
            return text;
          }
        } catch (err) {
          console.warn('[transcript] fetch fallback failed', { error: err?.message || err });
          return null;
        }
      }
      return null;
    }

    const buf = Buffer.from(await data.arrayBuffer());
    const raw = buf.toString('utf8');
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  if (resolved.source === 'http') {
    try {
      const res = await fetch(resolved.url);
      if (!res.ok) return null;
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (err) {
      console.warn('[transcript] fetch failed', { error: err?.message || err });
      return null;
    }
  }

  return null;
}

function extractTranscriptItemsFromPayload(payload) {
  if (!payload) return null;
  const rawTranscript = pickFirst(
    fromAny(payload, 'properties.transcript'),
    fromAny(payload, 'transcript'),
    fromAny(payload, 'payload.transcript')
  );

  if (Array.isArray(rawTranscript)) return rawTranscript;
  if (Array.isArray(rawTranscript?.messages)) return rawTranscript.messages;
  if (Array.isArray(fromAny(payload, 'messages'))) return fromAny(payload, 'messages');
  if (Array.isArray(fromAny(payload, 'transcript'))) return fromAny(payload, 'transcript');
  return null;
}

function sanitizeTranscriptPayload(payload) {
  if (payload == null) return '';

  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return '';
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        return sanitizeTranscriptPayload(parsed);
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }

  if (Array.isArray(payload)) {
    const lines = sanitizeTranscriptArray(payload);
    return lines.join('\n').trim();
  }

  if (typeof payload === 'object') {
    const items = extractTranscriptItemsFromPayload(payload);
    if (!items) return '';
    const lines = sanitizeTranscriptArray(items);
    return lines.join('\n').trim();
  }

  return '';
}

/** Fetch transcript text from either DB column or transcript_url using Storage SDK (private bucket safe). */
async function getTranscriptText(row) {
  if (row.transcript && row.transcript.trim().length > 0) {
    return row.transcript.trim();
  }

  const ref = row.transcript_url;
  if (!ref) return '';
  const payload = await downloadTranscriptPayload(ref);
  return sanitizeTranscriptPayload(payload);
}

/** Ask OpenAI to score + summarize the transcript */
async function scoreTranscriptWithOpenAI(transcript) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');

  const prompt = `
You are an interview evaluator. Read the interview transcript and return JSON with:

- clarity (0-100)
- confidence (0-100)
- body_language (0-100)  // estimate from wording (pace, hesitations, etc.)
- overall (0-100)        // not a simple average; your holistic score
- summary (1–3 sentences)

Transcript:
"""${transcript.slice(0, 12000)}"""
`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Return only JSON.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' }
    })
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`OpenAI ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  let parsed = {};
  try {
    parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  } catch {
    parsed = {};
  }

  // Normalize & clamp
  function num(v) {
    const n = Number(v);
    if (Number.isNaN(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  }
  const scores = {
    clarity: num(parsed.clarity),
    confidence: num(parsed.confidence),
    body_language: num(parsed.body_language),
    overall: num(parsed.overall)
  };
  const summary = String(parsed.summary || '').trim();

  return { scores, summary };
}

async function analyzeInterviewTranscriptById(interviewId, opts = {}) {
  const requestId = opts?.request_id || null;
  const logContext = { request_id: requestId || null, interview_id: interviewId || null };

  try {
    if (!interviewId) {
      return { ok: false, error: 'missing_interview_id', request_id: requestId || null };
    }

    console.log('[analyze-interview-transcript] start', logContext);

    const { data: row, error } = await supabase
      .from('interviews')
      .select('id, transcript, transcript_url, analysis, status')
      .eq('id', interviewId)
      .maybeSingle();
    if (error || !row) {
      return { ok: false, error: error?.message || 'interview_not_found', request_id: requestId || null };
    }

    let transcriptText = '';
    if (row.transcript && row.transcript.trim().length > 0) {
      transcriptText = row.transcript.trim();
    } else if (row.transcript_url) {
      const payload = await downloadTranscriptPayload(row.transcript_url);
      transcriptText = sanitizeTranscriptPayload(payload);
    }

    if (!transcriptText) {
      console.log('[analyze-interview-transcript] skipped', {
        ...logContext,
        reason: 'empty_transcript'
      });
      return { ok: true, skipped: true, reason: 'empty_transcript', request_id: requestId || null };
    }

    const { scores, summary } = await scoreTranscriptWithOpenAI(transcriptText);

    const nextAnalysis =
      row.analysis && typeof row.analysis === 'object'
        ? { ...row.analysis, scores, summary }
        : { scores, summary };

    const updatePayload = { analysis: nextAnalysis };
    if (!row.transcript || row.transcript.trim().length === 0) {
      updatePayload.transcript = transcriptText;
    }

    const { error: upErr } = await supabase
      .from('interviews')
      .update(updatePayload)
      .eq('id', row.id);
    if (upErr) {
      return { ok: false, error: upErr.message, request_id: requestId || null };
    }

    console.log('[analyze-interview-transcript] updated', {
      ...logContext,
      updated: true
    });
    return { ok: true, updated: true, request_id: requestId || null };
  } catch (err) {
    console.error('[analyze-interview-transcript] error', {
      ...logContext,
      error: err?.message || err
    });
    return { ok: false, error: err?.message || String(err), request_id: requestId || null };
  }
}

async function main() {
  console.log('Backfill: scanning…');

  // Only rows missing scores
  const { data: rows, error } = await supabase
    .from('interviews')
    .select('id, transcript, transcript_url, analysis')
    .or('transcript.is.null,transcript.eq.,analysis.is.null,analysis->>summary.is.null')
    .limit(5000);

  if (error) throw error;
  if (!rows || rows.length === 0) {
    console.log('Nothing to do (no rows with NULL transcript_scores).');
    return;
  }

  for (const row of rows) {
    try {
      const transcript = await getTranscriptText(row);
      const hydratedFromUrl = (!row.transcript || row.transcript.trim().length === 0) && !!row.transcript_url;
      if (!transcript || transcript.trim().length < 10) {
        console.log(`Skip ${row.id}: empty transcript`);
        continue;
      }

      const { scores, summary } = await scoreTranscriptWithOpenAI(transcript);

      // Merge summary into analysis JSONB (don’t wipe other fields)
      const nextAnalysis =
        row.analysis && typeof row.analysis === 'object'
          ? { ...row.analysis, summary: summary || row.analysis.summary }
          : { summary };

      const updatePayload = {
        analysis: {
          ...(row.analysis && typeof row.analysis === 'object' ? row.analysis : {}),
          scores,
          summary
        }
      };
      if (hydratedFromUrl) {
        updatePayload.transcript = transcript;
      }

      const { error: upErr } = await supabase
        .from('interviews')
        .update(updatePayload)
        .eq('id', row.id);

      if (upErr) throw upErr;
      console.log(`Updated ${row.id}: overall=${scores.overall}${hydratedFromUrl ? ' (hydrated transcript)' : ''}`);
    } catch (e) {
      console.warn(`Row ${row.id} failed:`, e.message);
    }
  }

  console.log('Backfill complete.');
}

module.exports = { analyzeInterviewTranscriptById };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
