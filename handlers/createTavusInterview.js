// handlers/createTavusInterview.js
require('dotenv').config();
const axios = require('axios');

/**
 * Create a Tavus v2 conversation for a candidate/role.
 * Attaches the role Knowledge Base document when available.
 * Returns { conversation_url, conversation_id }.
 *
 * @param {Object} candidate - { id, role_id, email, name }
 * @param {Object} role - { id, kb_document_id }
 * @param {string} [webhookUrl] - Full URL to your /webhook/recording-ready endpoint
 */
async function createTavusInterviewHandler(candidate, role, webhookUrl) {
  const API_KEY = String(process.env.TAVUS_API_KEY || '').trim();
  const REPLICA_ID = String(process.env.TAVUS_REPLICA_ID || '').trim();
  const PERSONA_ID = process.env.TAVUS_PERSONA_ID ? String(process.env.TAVUS_PERSONA_ID).trim() : null;

  if (!API_KEY) throw new Error('TAVUS_API_KEY missing');
  if (!REPLICA_ID) throw new Error('TAVUS_REPLICA_ID missing');

  const payload = {
    replica_id: REPLICA_ID
  };

  if (PERSONA_ID) payload.persona_id = PERSONA_ID;
  if (webhookUrl) payload.webhook_url = webhookUrl;
  if (role && role.kb_document_id) {
    payload.document_ids = [role.kb_document_id];
    payload.document_retrieval_strategy = 'balanced';
  }

  const resp = await axios.post('https://tavusapi.com/v2/conversations', payload, {
    headers: { 'x-api-key': API_KEY }
  });

  const data = resp && resp.data ? resp.data : {};
  const conversation_url = data.conversation_url || data.url || data.link || null;
  const conversation_id = data.conversation_id || data.id || null;

  return { conversation_url, conversation_id };
}

module.exports = { createTavusInterviewHandler };
