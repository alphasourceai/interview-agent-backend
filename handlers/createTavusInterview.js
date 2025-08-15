// handlers/createTavusInterview.js
'use strict';

require('dotenv').config();
const axios = require('axios');

/**
 * Create a Tavus v2 conversation for a candidate/role.
 * - Attaches role KB via document_ids when available.
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

  // Nudge the agent to use the KB doc
  const context = [
    'You are interviewing a candidate. Use the attached knowledge-base "rubric" document to guide your questions and answers.',
    'If the candidate asks about evaluation, list the scoring categories exactly as written in the rubric.',
    'Prefer facts from the document over generic advice.'
  ].join(' ');

  // Build the payload Tavus expects
  const payload = {
    persona_id: PERSONA_ID || undefined,
    replica_id: REPLICA_ID || undefined,
    callback_url: webhookUrl || undefined,
    conversation_name: candidate?.name || candidate?.email || 'Interview',
    conversational_context: context
  };

  // Attach KB via document_ids if we have it
  if (role?.kb_document_id) {
    payload.document_ids = [role.kb_document_id];
    // "speed" | "balanced" | "quality"
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
    const status = e.response?.status || 500;
    const details = e.response?.data || e.message;
    const err = new Error(typeof details === 'string' ? details : JSON.stringify(details));
    err.status = status;
    throw err;
  }
}

module.exports = { createTavusInterviewHandler };
