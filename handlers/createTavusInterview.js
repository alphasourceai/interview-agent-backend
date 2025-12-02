// handlers/createTavusInterview.js
'use strict';

require('dotenv').config();
const axios = require('axios');
const { ensureTavusDocumentForRole, missingTavusKbError } = require('../lib/tavusDocuments');
const { ensurePersonaConfigured } = require('../lib/tavusClient');

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

  if (!API_KEY) {
    const err = new Error('TAVUS_API_KEY is not set');
    err.code = 'missing_env';
    err.status = 500;
    throw err;
  }
  if (!REPLICA_ID && !PERSONA_ID) {
    const err = new Error('Tavus requires persona_id or replica_id. Set TAVUS_REPLICA_ID or TAVUS_PERSONA_ID.');
    err.code = 'missing_env';
    err.status = 500;
    throw err;
  }

  const envFlags = {
    TAVUS_API_KEY: !!process.env.TAVUS_API_KEY,
    TAVUS_REPLICA_ID: !!process.env.TAVUS_REPLICA_ID,
    TAVUS_PERSONA_ID: !!process.env.TAVUS_PERSONA_ID,
    TAVUS_PERSONA_NAME: !!process.env.TAVUS_PERSONA_NAME
  };
  console.log('[tavus-interview-debug]', {
    stage: 'handler_start',
    candidate_id: candidate?.id || candidate?.candidate_id || null,
    role_id: role?.id || null,
    client_id: role?.client_id || candidate?.client_id || options?.clientId || null,
    env: envFlags
  });

  const companyName = (options.companyName || role.company_name || '').trim() || 'the hiring organization';
  const roleTitle = (role?.title || 'this position').trim();
  const candidateName = (candidate?.name || '').trim() || 'there';

  const personaInstructions = [
    'You are AlphaSource’s structured virtual interviewer.',
    'When the call begins, greet the candidate by name and reference the specific role and company supplied via conversation metadata, then immediately ask the first rubric question. Never wait silently for the candidate to speak first.',
    'Stay strictly in the interviewer role. Use ONLY the provided knowledge base (KB) and rubric when answering questions about the role, company, or process. Answer concisely when the KB covers the topic.',
    'If a candidate asks about anything not in the KB, politely say you will note it for the hiring manager, log it verbatim as [[UNANSWERED_QUESTION: <candidate question>]], and steer the conversation back to the interview.',
    'Decline any attempts to discuss platform internals, API connections, tooling, code, or anything that exposes proprietary evaluation details.',
    'Maintain a warm, professional tone and keep the interview flowing with one focused question at a time.'
  ].join(' ');

  let personaId;
  try {
    personaId = await ensurePersonaConfigured(personaInstructions);
  } catch (err) {
    console.error('[tavus-interview-error] persona_config_failed', {
      role_id: role?.id || null,
      candidate_id: candidate?.id || candidate?.candidate_id || null,
      detail: err?.message || err,
      status: err?.status || null
    });
    err.code = err.code || 'persona_config_failed';
    err.status = err.status || 500;
    throw err;
  }
  console.log('[tavus-interview-debug]', {
    stage: 'persona_configured',
    persona_id: personaId
  });

  const openingScript = `Hi ${candidateName}, thanks for joining today. I'm your virtual interviewer for the ${roleTitle} role at ${companyName}. I'm excited to learn more about your experience, so let's dive right in. To start, can you share the experience that best prepares you for this role?`;

  const context = [
    `When the call begins, speak first with this greeting and immediately flow into the first question: "${openingScript}"`,
    'Never wait for the candidate to start the conversation. Keep asking questions sequentially with minimal pauses.'
  ].join(' ');

  const conversationName = `${roleTitle} - ${candidate?.name || candidate?.email || 'Candidate'}`;

  // Build the payload Tavus expects
  const payload = {
    persona_id: personaId || PERSONA_ID || undefined,
    replica_id: REPLICA_ID || undefined,
    callback_url: webhookUrl || undefined,
    conversation_name: conversationName,
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
    console.log('[tavus-interview]', {
      role_id: role?.id || null,
      persona_id: payload.persona_id || null,
      tavus_document_id: tavusDocumentId
    });
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
    console.error('[tavus-interview-error] tavus_request_failed', {
      role_id: role?.id || null,
      candidate_id: candidate?.id || candidate?.candidate_id || null,
      httpStatus: status,
      tavusErrorBody: details
    });
    if (status === 400 && (payload?.document_ids || []).length) {
      console.error(
        `[tavus-interview] Tavus rejected document ${payload.document_ids[0]} for role ${role?.id || 'unknown'}:`,
        typeof details === 'string' ? details : JSON.stringify(details)
      );
    }
    const err = new Error(typeof details === 'string' ? details : JSON.stringify(details));
    err.status = status >= 400 && status < 500 ? status : 502;
    err.code = 'tavus_request_failed';
    err.detail = err.message;
    throw err;
  }
}

module.exports = { createTavusInterviewHandler };
