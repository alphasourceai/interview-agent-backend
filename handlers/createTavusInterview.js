// handlers/createTavusInterview.js
'use strict';

require('dotenv').config();
const axios = require('axios');
const { ensureTavusDocumentForRole, missingTavusKbError } = require('../lib/tavusDocuments');
const { ensurePersonaConfigured, TAVUS_PERSONA_ID } = require('../lib/tavusClient');

/**
 * Create a Tavus v2 conversation for a candidate/role.
 * - Attaches role KB via document_ids when available.
 * - Includes callback_url so Tavus posts to our webhook.
 * Returns { conversation_url, conversation_id }.
 *
 * @param {Object} candidate - { id, role_id, email, name }
 * @param {Object} role - { id, kb_document_id, tavus_document_id }
 * @param {string} [webhookUrl] - Full URL to /webhook/recording-ready
 * @param {Object} [options] - { companyName }
 */
async function createTavusInterviewHandler(candidate, role, webhookUrl, options = {}) {
  const API_KEY = String(process.env.TAVUS_API_KEY || '').trim();
  const REPLICA_ID = String(process.env.TAVUS_REPLICA_ID || '').trim();
  const PERSONA_ID = String(process.env.TAVUS_PERSONA_ID || '').trim();
  const RETRIEVAL = String(process.env.TAVUS_DOCUMENT_STRATEGY || 'balanced').trim();

  if (!API_KEY) throw new Error('TAVUS_API_KEY is not set');
  if (!REPLICA_ID && !PERSONA_ID) {
    throw new Error('Tavus requires persona_id or replica_id. Set TAVUS_REPLICA_ID or TAVUS_PERSONA_ID.');
  }

  const companyName = (options.companyName || role.company_name || '').trim() || 'the hiring organization';
  const roleTitle = (role?.title || 'this position').trim();
  const candidateName = (candidate?.name || '').trim() || 'there';

  const personaInstructions = [
    'You are AlphaSource’s virtual interviewer. Stay strictly within interview topics, never mention platform internals, tooling, APIs, or models, and rely only on the provided KB.',
    'Always capture questions you cannot answer with [[UNANSWERED_QUESTION: <verbatim candidate question>]] and redirect back to the interview.',
    'Do not reveal anything about the KB contents or interview structure beyond what is explicitly asked and allowed in the KB.'
  ].join(' ');

  await ensurePersonaConfigured(personaInstructions);
  console.log('[tavus-interview] persona_applied', { persona_id: TAVUS_PERSONA_ID });

  const openingScript = `Hi ${candidateName}, thanks for joining today. I'm your virtual interviewer for the ${roleTitle} role at ${companyName}. I'm excited to learn more about your experience, so let's get started.`;

  const context = [
    `When the call begins, speak first with this greeting and immediately flow into the first question: "${openingScript}"`,
    'Never wait for the candidate to start the conversation. Keep asking questions sequentially with minimal pauses.'
  ].join(' ');

  // Build the payload Tavus expects
  const payload = {
    persona_id: TAVUS_PERSONA_ID || PERSONA_ID || undefined,
    replica_id: REPLICA_ID || undefined,
    callback_url: webhookUrl || undefined,
    conversation_name: candidate?.name || candidate?.email || 'Interview',
    conversational_context: context,
    opening_script: openingScript
  };
  console.log('[tavus-interview-prompt]', {
    role_id: role?.id,
    role_title: roleTitle,
    company: companyName,
    persona_id: payload.persona_id,
    prompt: context,
    opening_script: openingScript
  });

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
