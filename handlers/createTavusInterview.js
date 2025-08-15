// handlers/createTavusInterview.js
'use strict';

require('dotenv').config();
const axios = require('axios');

/**
 * Create a Tavus v2 conversation for a candidate/role.
 * - Attaches role KB via document_ids when available (per KB docs).
 * - Includes callback_url so Tavus posts to our webhook.
 * Returns { conversation_url, conversation_id }.
 *
 * @param {Object} candidate - { id, role_id, email, name }
 * @param {Object} role - { id, kb_document_id }
 * @param {string} [webhookUrl] - Full URL to /webhook/recording-ready
 */
async function createTavusInterviewHandler(candidate, role, webhookUrl) {
  const API_KEY = String(process.env.TAVUS_API_KEY || '').trim();
  const REPLICA_ID = String(process.env.TAVUS_REPLICA_ID || '').trim();
  const PERSONA_ID = String(process.env.TAVUS_PERSONA_ID || '').trim();
  const RETRIEVAL = String(process.env.TAVUS_DOCUMENT_STRATEGY || 'balanced').trim();

  if (!API_KEY) throw new Error('TAVUS_API_KEY is not set');
  if (!REPLICA_ID && !PERSONA_ID) {
    throw new Error('Tavus requires persona_id or replica_id. Set TAVUS_REPLICA_ID or TAVUS_PERSONA_ID.');
  }

  const payload = {
    // Either/both accepted (persona may carry a default replica; replica here overrides).
    persona_id: PERSONA_ID || undefined,
    replica_id: REPLICA_ID || undefined,

    // Webhook for conversation events
    callback_url: webhookUrl || undefined,

    // Optional niceties
    conversation_name: candidate?.name || candidate?.email || 'Interview',
    properties: {
      candidate_id: candidate?.id ?? null,
      role_id: role?.id ?? null
    }
  };

  // Attach KB properly via document_ids (array of Tavus document IDs)
  if (role?.kb_document_id) {
    payload.document_ids = [role.kb_document_id];
    // Optional: retrieval strategy (speed | balanced | quality)
    payload.document_retrieval_strategy = RETRIEVAL;
  }

  try {
    const resp = await axios.post('https://tavusapi.com/v2/conversations', payload, {
      headers: {
        'x-api-key': API_KEY,
        'Content-Type': 'application/json'
      }
    });

    const data = resp?.data || {};
    return {
      conversation_url: data.conversation_url || data.url || data.link || null,
      conversation_id: data.conversation_id || data.id || null
    };
  } catch (e) {
    // Surface Tavus error details so callers (route) can send actionable messages
    const status = e.response?.status || 500;
    const details = e.response?.data || e.message;
    const err = new Error(typeof details === 'string' ? details : JSON.stringify(details));
    err.status = status;
    throw err;
  }
}

module.exports = { createTavusInterviewHandler };
