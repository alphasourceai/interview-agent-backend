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
  // inside createTavusInterviewHandler(candidate, role, webhookUrl)
const API_KEY = String(process.env.TAVUS_API_KEY || '').trim();
const REPLICA_ID = String(process.env.TAVUS_REPLICA_ID || '').trim();
const PERSONA_ID = String(process.env.TAVUS_PERSONA_ID || '').trim();

if (!API_KEY) throw new Error('TAVUS_API_KEY is not set');

const payload = {
  // At least one of these is typically required based on your setup
  persona_id: PERSONA_ID || undefined,
  replica_id: REPLICA_ID || undefined,

  // Ensures Tavus calls back to your server when recording/transcripts are ready
  callback_url: webhookUrl || undefined,

  // Optional labels for convenience
  conversation_name: candidate?.name || candidate?.email || 'Interview',
  properties: {
    candidate_id: candidate?.id || null,
    role_id: role?.id || null
  }
};

// Attach the Knowledge Base doc if we have it
if (role?.kb_document_id) {
  // Tavus KB docs can be added to conversations;
  // API currently accepts a list of documents.
  payload.documents = [{ uuid: role.kb_document_id }];
}

// POST https://tavusapi.com/v2/conversations with x-api-key header
const resp = await axios.post('https://tavusapi.com/v2/conversations', payload, {
  headers: { 'x-api-key': API_KEY }
});

const data = resp?.data || {};
const conversation_url = data.conversation_url || data.url || data.link || null;
const conversation_id = data.conversation_id || data.id || null;

return { conversation_url, conversation_id };

}

module.exports = { createTavusInterviewHandler };
