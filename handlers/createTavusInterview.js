// handlers/createTavusInterview.js
'use strict';

require('dotenv').config();
const axios = require('axios');
const { ensureTavusDocumentForRole, missingTavusKbError } = require('../lib/tavusDocuments');

/**
 * Create a Tavus v2 conversation for a candidate/role.
 * - Attaches role KB via document_ids when available.
 * - Includes callback_url so Tavus posts to our webhook.
 * Returns { conversation_url, conversation_id }.
 *
 * @param {Object} candidate - { id, role_id, email, name }
 * @param {Object} role - { id, kb_document_id, tavus_document_id }
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

  let tavusDocumentId = role?.tavus_document_id || null;
  if (!tavusDocumentId && role?.kb_document_id) {
    try {
      tavusDocumentId = await ensureTavusDocumentForRole(role);
    } catch (err) {
      console.error(`[tavus-interview] Failed to sync Tavus KB for role ${role?.id || 'unknown'}:`, err?.message || err);
      if (err?.code === 'missing_tavus_kb') throw err;
      throw err;
    }
  }
  if (tavusDocumentId) {
    console.log(`[tavus-interview] role=${role?.id || 'unknown'} using tavus_document_id=${tavusDocumentId}`);
    payload.document_ids = [tavusDocumentId];
    payload.document_retrieval_strategy = RETRIEVAL;
  } else if (role?.kb_document_id) {
    throw missingTavusKbError(role?.id, 'Role is missing Tavus KB ID');
  } else {
    throw missingTavusKbError(role?.id, 'Role has no KB source to sync to Tavus');
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
    if (status === 400 && (payload?.document_ids || []).length) {
      console.error(
        `[tavus-interview] Tavus rejected document ${payload.document_ids[0]} for role ${role?.id || 'unknown'}:`,
        typeof details === 'string' ? details : JSON.stringify(details)
      );
    }
    const err = new Error(typeof details === 'string' ? details : JSON.stringify(details));
    err.status = status;
    err.code = status === 400 ? 'tavus_400' : undefined;
    throw err;
  }
}

module.exports = { createTavusInterviewHandler };
