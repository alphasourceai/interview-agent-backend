// handlers/createTavusInterview.js
// Tavus v2 (as in 8/4/2025 version) using tavusapi.com/v2/conversations
// Auth: x-api-key
// Returns: { conversation_url, conversation_id? }
// Also inserts a "Pending" interview row for the candidate.

require('dotenv').config();
const axios = require('axios');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Build an optional role-based script (prompt)
function buildScript(role) {
  if (!role) return null;

  const questions = Array.isArray(role?.rubric?.questions)
    ? role.rubric.questions.map(q => (typeof q === 'string' ? q : q?.text)).filter(Boolean)
    : [];

  const style =
    role?.interview_type === 'technical'
      ? 'a technical interviewer who focuses on practical problem solving, tooling, and trade-offs'
      : role?.interview_type === 'detailed'
      ? 'a leadership interviewer who probes collaboration, decisions, and outcomes'
      : 'a concise screening interviewer who evaluates communication and general fit';

  const jd = (role?.description || '').slice(0, 3000);

  return `
You are ${style}.
Position: ${role?.title || 'Unknown'}
Job Description (trimmed):
${jd || '[none provided]'}

Ask the candidate the following questions in order, one at a time. Keep a professional, friendly tone.
If the candidate drifts, briefly refocus them. Thank them at the end.

Questions:
${questions.length ? questions.map((q, i) => `${i + 1}. ${q}`).join('\n') : '1. Tell me about your relevant experience for this role.'}
  `.trim();
}

/**
 * Create a Tavus v2 conversation for a candidate.
 * @param {object} candidate - expects { id, email, role_id, name? }
 * @param {object} role      - expects { id, title, description, interview_type, rubric }
 * @returns {Promise<{conversation_url: string|null, conversation_id?: string|null}>}
 */
module.exports = async function createTavusInterview(candidate, role) {
  if (!candidate?.id || !candidate?.email || !candidate?.role_id) {
    throw new Error('createTavusInterview: missing candidate.id/email/role_id');
  }

  const API_KEY = (process.env.TAVUS_API_KEY || '').trim();
  const REPLICA_ID = (process.env.TAVUS_REPLICA_ID || '').trim();
  const PERSONA_ID = (process.env.TAVUS_PERSONA_ID || '').trim();

  if (!API_KEY) throw new Error('Missing TAVUS_API_KEY');
  if (!REPLICA_ID) throw new Error('Missing TAVUS_REPLICA_ID');

  // Webhook URL preference: explicit env -> PUBLIC_BACKEND_URL -> VITE_BACKEND_URL
  const explicitWebhook = (process.env.TAVUS_WEBHOOK_URL || '').trim();
  const backendBase =
    (process.env.PUBLIC_BACKEND_URL || '').trim() ||
    (process.env.VITE_BACKEND_URL || '').trim();
  const WEBHOOK_URL = explicitWebhook || (backendBase ? `${backendBase.replace(/\/+$/, '')}/webhook/recording-ready` : undefined);

  // Keep the same host & path that worked before:
  const endpoint = 'https://tavusapi.com/v2/conversations';

  // Minimal payload that matched 8/4 behavior, with optional script:
  const payload = {
    replica_id: REPLICA_ID,
    ...(PERSONA_ID ? { persona_id: PERSONA_ID } : {}),
    ...(WEBHOOK_URL ? { webhook_url: WEBHOOK_URL } : {}),
    // Tavus often accepts `script` in v2 conversations; include it so we don't fall back to generic persona
    // If their project ignores it, call still succeeds (we keep old behavior).
    script: buildScript(role) || undefined,
    // Metadata can be useful; safe to include
    metadata: {
      candidate_id: candidate.id,
      role_id: candidate.role_id,
      email: candidate.email,
      role_title: role?.title || null
    }
  };

  const httpsAgent = new https.Agent({ keepAlive: true, timeout: 10000 });
  const axiosOpts = {
    headers: {
      'x-api-key': API_KEY,
      'Content-Type': 'application/json'
    },
    httpsAgent,
    timeout: 10000, // 10s to keep verify step responsive
    transitional: { clarifyTimeoutError: true }
  };

  let resp;
  try {
    resp = await axios.post(endpoint, payload, axiosOpts);
  } catch (err) {
    const code = err?.code || '';
    const msg = err?.response?.data || err?.message || err;
    // Surface concise error (verify route catches and won’t freeze)
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      throw new Error('Tavus creation failed: request timed out');
    }
    throw new Error(`Tavus creation failed: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }

  const data = resp?.data || {};
  const conversation_url =
    data.conversation_url || data.url || data.join_url || data.link || null;
  const conversation_id = data.conversation_id || data.id || null;

  // Insert a Pending interview row immediately (matches older behavior)
  try {
    await supabase.from('interviews').insert([{
      candidate_id: candidate.id,
      role_id: candidate.role_id,
      video_url: conversation_url || null,       // may be null if Tavus delayed
      tavus_application_id: conversation_id,     // older code stored conversation_id here
      status: 'Pending',
      rubric: role?.rubric || null
    }]);
  } catch (interviewError) {
    // Don’t fail user flow if DB insert has an issue; log and continue
    console.warn('Interview insert warning:', interviewError?.message || interviewError);
  }

  return { conversation_url, conversation_id };
};
