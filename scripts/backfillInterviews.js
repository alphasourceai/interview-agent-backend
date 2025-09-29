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

// Helpers to read private Supabase Storage objects
function parsePublicStorageUrl(u) {
  // matches /storage/v1/object/{public|sign}/<bucket>/<path...>
  const m = u?.match(/\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/);
  return m ? { bucket: m[1], path: m[2] } : null;
}

function parseStoredRef(ref) {
  if (!ref) return null;
  // Accept "bucket/path/to/file.json" or just "path..." (we'll assume transcripts bucket)
  if (ref.includes('/')) {
    const [bucket, ...rest] = ref.split('/');
    return { bucket, path: rest.join('/') };
  }
  return { bucket: 'transcripts', path: ref }; // default bucket guess
}

/** Fetch transcript text from either DB column or transcript_url using Storage SDK (private bucket safe). */
async function getTranscriptText(row) {
  if (row.transcript && row.transcript.trim().length > 0) {
    return row.transcript.trim();
  }

  const ref = row.transcript_url;
  if (!ref) return '';

  const parsed =
    parsePublicStorageUrl(ref) ||
    parseStoredRef(ref);

  if (!parsed) return '';

  const { data, error } = await supabase.storage.from(parsed.bucket).download(parsed.path);
  if (error) {
    // As a last resort, try direct fetch (will fail for private buckets, but keeps old behavior)
    try {
      const res = await fetch(ref);
      if (!res.ok) throw new Error(`fetch transcript_url failed: ${res.status}`);
      const fallbackText = await res.text();
      try {
        const j = JSON.parse(fallbackText);
        if (typeof j === 'string') return j;
        if (j && typeof j.text === 'string') return j.text;
      } catch {}
      return fallbackText;
    } catch (e) {
      throw new Error(`storage.download failed (${parsed.bucket}/${parsed.path}): ${error.message || e.message}`);
    }
  }

  const buf = Buffer.from(await data.arrayBuffer());
  const raw = buf.toString('utf8');
  try {
    const j = JSON.parse(raw);
    if (typeof j === 'string') return j;
    if (Array.isArray(j)) return j.join('\n');
    if (j && typeof j.text === 'string') return j.text;
    return JSON.stringify(j);
  } catch {
    return raw;
  }
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});