// handlers/createTavusInterview.js
// Creates a Tavus interview with a role-specific prompt.
// Exports: async function createTavusInterview(candidate, role) -> { conversation_url, id? }

require('dotenv').config();
const axios = require('axios');

function buildPrompt(role) {
  const questions = Array.isArray(role?.rubric?.questions)
    ? role.rubric.questions.map(q => (typeof q === 'string' ? q : q?.text)).filter(Boolean)
    : [];

  const interviewerStyle =
    role?.interview_type === 'technical'
      ? 'a technical interviewer who focuses on practical problem solving, tooling, and trade-offs'
      : role?.interview_type === 'detailed'
      ? 'a leadership interviewer who probes collaboration, decisions, and outcomes'
      : 'a concise screening interviewer who evaluates communication and general fit';

  const jd = (role?.description || '').slice(0, 3000);

  return `
You are ${interviewerStyle}.
Position: ${role?.title || 'Unknown'}
Job Description (trimmed):
${jd || '[none provided]'}

Ask the candidate the following questions in order, one at a time. Keep a professional, friendly tone.
If the candidate drifts, briefly refocus them. Thank them at the end.

Questions:
${questions.length ? questions.map((q, i) => `${i + 1}. ${q}`).join('\n') : '1. Tell me about your relevant experience for this role.'}
`.trim();
}

module.exports = async function createTavusInterview(candidate, role) {
  const API_KEY = process.env.TAVUS_API_KEY;
  const REPLICA_ID = (process.env.TAVUS_REPLICA_ID || '').trim();
  const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || process.env.VITE_BACKEND_URL || '';

  if (!API_KEY) throw new Error('Missing TAVUS_API_KEY');
  if (!REPLICA_ID) console.warn('TAVUS_REPLICA_ID is empty—using Tavus default for your account (if any).');

  const interviewer_prompt = buildPrompt(role);

  // Prefer applications first (your webhook uses application.recording_ready), then conversations
  const endpoints = [
    'https://api.tavus.io/v2/applications',
    'https://api.tavus.io/v2/conversations'
  ];

  // Build payload (include common prompt fields in case Tavus expects specific keys)
  const payload = {
    replica_id: REPLICA_ID || undefined,
    metadata: {
      candidate_id: candidate.id,
      role_id: role?.id,
      email: candidate.email,
      role_title: role?.title || null
    },
    interviewer_prompt,
    system_prompt: interviewer_prompt,
    script: interviewer_prompt,
    // Uncomment if your Tavus project expects a webhook:
    // webhook_url: PUBLIC_BACKEND_URL ? `${PUBLIC_BACKEND_URL}/webhook/recording-ready` : undefined,
  };

  const axiosOpts = {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 12000 // 12s hard timeout so the verify request never hangs forever
  };

  let lastErr;
  for (const url of endpoints) {
    try {
      const resp = await axios.post(url, payload, axiosOpts);

      const data = resp?.data || {};
      const conversation_url =
        data.conversation_url ||
        data.url ||
        data.join_url ||
        data.link ||
        null;

      if (!conversation_url) {
        // Sometimes Tavus only returns an ID; return it for later use/debug.
        return { conversation_url: null, id: data.id || null };
      }

      return { conversation_url };
    } catch (err) {
      lastErr = err;
      // Try the next endpoint variant
    }
  }

  // If both attempts failed, surface a concise error (timeout/network/response)
  const code = lastErr?.code || '';
  const msg =
    lastErr?.response?.data ||
    lastErr?.message ||
    lastErr;

  // Normalize common network timeouts for clearer logs upstream
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    throw new Error('Tavus creation failed: request timed out');
  }

  throw new Error(`Tavus creation failed: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
};
