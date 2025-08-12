// handlers/createTavusInterview.js
// Tavus v2 conversations (as in 8/4): POST https://tavusapi.com/v2/conversations
// Auth: x-api-key
// Payload: replica_id (+ optional persona_id, webhook_url, script)
// Returns: { conversation_url, conversation_id? }
// Also inserts a "Pending" interview row.

require('dotenv').config();
const axios = require('axios');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Optional role-based script
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
 * @param {{id:string,email:string,role_id:string}} candidate
 * @param {{id:string,title?:string,description?:string,interview_type?:string,rubric?:any}} role
 */
module.exports = async function createTavusInterview(candidate, role) {
  if (!candidate?.id || !candidate?.email || !candidate?.role_id) {
    throw new Error('createTavusInterview: missing candidate.id/email/role_id');
  }

  const API_KEY = (process.env.TAVUS_API_KEY || '').trim();
  const REPLICA_ID = (process.env.TAVUS_REPLICA_ID || '').trim();   // e.g. "rc2146c13e81" (trim removes stray spaces)
  const PERSONA_ID = (process.env.TAVUS_PERSONA_ID || '').trim();   // optional

  if (!API_KEY) throw new Error('Missing TAVUS_API_KEY');
  if (!REPLICA_ID) throw new Error('Missing TAVUS_REPLICA_ID');

  const explicitWebhook = (process.env.TAVUS_WEBHOOK_URL || '').trim();
  const backendBase =
    (process.env.PUBLIC_BACKEND_URL || '').trim() ||
    (process.env.VITE_BACKEND_URL || '').trim();
  const WEBHOOK_URL = explicitWebhook || (backendBase ? `${backendBase.replace(/\/+$/, '')}/webhook/recording-ready` : undefined);

  const endpoint = 'https://tavusapi.com/v2/conversations';

  // ✅ Minimal payload (what worked on 8/4), plus optional script for role-tailoring
  const payload = {
    replica_id: REPLICA_ID,
    ...(PERSONA_ID ? { persona_id: PERSONA_ID } : {}),
    ...(WEBHOOK_URL ? { webhook_url: WEBHOOK_URL } : {}),
    ...(buildScript(role) ? { script: buildScript(role) } : {})
    // ❌ DO NOT include `metadata` — Tavus v2 here rejects it
  };

  const httpsAgent = new https.Agent({ keepAlive: true, timeout: 10000 });
  const axiosOpts = {
    headers: {
      'x-api-key': API_KEY,
      'Content-Type': 'application/json'
    },
    httpsAgent,
    timeout: 10000,
    transitional: { clarifyTimeoutError: true }
  };

  let resp;
  try {
    resp = await axios.post(endpoint, payload, axiosOpts);
  } catch (err) {
    const code = err?.code || '';
    const msg = err?.response?.data || err?.message || err;
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
      throw new Error('Tavus creation failed: request timed out');
    }
    throw new Error(`Tavus creation failed: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }

  const data = resp?.data || {};
  const conversation_url =
    data.conversation_url || data.url || data.join_url || data.link || null;
  const conversation_id = data.conversation_id || data.id || null;

  // Insert Pending interview row
  try {
    await supabase.from('interviews').insert([{
      candidate_id: candidate.id,
      role_id: candidate.role_id,
      video_url: conversation_url || null,
      tavus_application_id: conversation_id,
      status: 'Pending',
      rubric: role?.rubric || null
    }]);
  } catch (interviewError) {
    console.warn('Interview insert warning:', interviewError?.message || interviewError);
  }

  return { conversation_url, conversation_id };
};
