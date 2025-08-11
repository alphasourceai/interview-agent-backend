// handlers/createTavusInterview.js
// Creates a Tavus interview with a role-specific prompt.
// Exports: async function createTavusInterview(candidate, role) -> { conversation_url }

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
  if (!API_KEY) throw new Error('Missing TAVUS_API_KEY');
  if (!REPLICA_ID) console.warn('TAVUS_REPLICA_ID is empty—using Tavus default for your account (if any).');

  const interviewer_prompt = buildPrompt(role);

  // Prefer the endpoint you’ve been using; v2 "applications" vs "conversations" varies by account.
  // We’ll try `applications` first since your webhook emits `application.recording_ready`.
  const endpoints = [
    'https://api.tavus.io/v2/applications',
    'https://api.tavus.io/v2/conversations'
  ];

  const payload = {
    // Common fields
    replica_id: REPLICA_ID || undefined,
    metadata: {
      candidate_id: candidate.id,
      role_id: role?.id,
      email: candidate.email,
      role_title: role?.title || null
    },

    // Prompt fields (Tavus may name these differently; include common variants)
    interviewer_prompt,
    system_prompt: interviewer_prompt,
    script: interviewer_prompt,

    // If your Tavus project expects a webhook URL, set it here (optional):
    // webhook_url: `${process.env.PUBLIC_BACKEND_URL}/webhook/recording-ready`,
  };

  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json'
  };

  let lastErr;
  for (const url of endpoints) {
    try {
      const resp = await axios.post(url, payload, { headers });

      // Normalize potential shapes
      const data = resp?.data || {};
      const conversation_url =
        data.conversation_url ||
        data.url ||
        data.join_url ||
        data.link ||
        null;

      if (!conversation_url) {
        // Sometimes Tavus returns an id and expects you to build the URL in the web app domain.
        // Keep id in case you need to debug or construct a URL.
        return { conversation_url: null, id: data.id || null };
      }

      return { conversation_url };
    } catch (err) {
      lastErr = err;
      // Try the next endpoint variant
    }
  }

  // If both attempts failed, surface the last error cleanly
  const msg = lastErr?.response?.data || lastErr?.message || lastErr;
  throw new Error(`Tavus creation failed: ${JSON.stringify(msg)}`);
};
