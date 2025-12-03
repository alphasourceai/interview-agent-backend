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
 * @param {Object} [options] - { companyName }
 */
async function createTavusInterviewHandler(candidate, role, webhookUrl, options = {}) {
  const API_KEY = String(process.env.TAVUS_API_KEY || '').trim();
  const REPLICA_ID = String(process.env.TAVUS_REPLICA_ID || '').trim();
  const RETRIEVAL = String(process.env.TAVUS_DOCUMENT_STRATEGY || 'balanced').trim();

  if (!API_KEY) {
    const err = new Error('TAVUS_API_KEY is not set');
    err.code = 'missing_env';
    err.status = 500;
    throw err;
  }
  if (!REPLICA_ID) {
    const err = new Error('Tavus requires replica_id. Set TAVUS_REPLICA_ID.');
    err.code = 'missing_env';
    err.status = 500;
    throw err;
  }

  const envFlags = {
    TAVUS_API_KEY: !!process.env.TAVUS_API_KEY,
    TAVUS_REPLICA_ID: !!process.env.TAVUS_REPLICA_ID
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

  const firstQuestion = extractFirstQuestion(role?.rubric);
  const customGreeting = buildCustomGreeting(candidateName, roleTitle, companyName, firstQuestion);
  const context = buildConversationalContext(candidateName, roleTitle, companyName);

  const conversationName = `${roleTitle} - ${candidate?.name || candidate?.email || 'Candidate'}`;

  // Build the payload Tavus expects
  const payload = {
    replica_id: REPLICA_ID || undefined,
    callback_url: webhookUrl || undefined,
    conversation_name: conversationName,
    conversational_context: context,
    custom_greeting: customGreeting,
    properties: {
      max_call_duration: 3600,
      participant_left_timeout: 60
    }
  };
  console.log('[tavus-interview-prompt]', {
    role_id: role?.id,
    role_title: roleTitle,
    company: companyName,
    replica_id: payload.replica_id,
    tavus_document_id: role?.tavus_document_id || null,
    prompt: context,
    custom_greeting: customGreeting
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
      replica_id: payload.replica_id || null,
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

function extractFirstQuestion(rubric) {
  const fallback = 'To start, can you tell me a bit about your background and how it relates to this role?';
  if (!rubric) return fallback;
  let parsed = rubric;
  if (typeof rubric === 'string') {
    try {
      parsed = JSON.parse(rubric);
    } catch (_) {
      return fallback;
    }
  }
  if (!parsed || typeof parsed !== 'object') return fallback;
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : Array.isArray(parsed) ? parsed : null;
  if (questions && questions.length) {
    const first = questions[0];
    if (typeof first === 'string' && first.trim()) return first.trim();
    if (first && typeof first === 'object') {
      if (first.question && typeof first.question === 'string' && first.question.trim()) return first.question.trim();
      if (first.text && typeof first.text === 'string' && first.text.trim()) return first.text.trim();
    }
  }
  return fallback;
}

function buildCustomGreeting(candidateName, roleTitle, companyName, firstQuestion) {
  const greeting = `Hi ${candidateName}, it's nice to meet you today. My name is Alex, and I'll be conducting your interview for the ${roleTitle} position at ${companyName}. I'm looking forward to our conversation. Let's get started.`;
  return `${greeting} ${firstQuestion}`;
}

function buildConversationalContext(candidateName, roleTitle, companyName) {
  return `
Interview Details:
- Candidate: ${candidateName}
- Position: ${roleTitle}
- Company: ${companyName}

Instructions:
- You are a structured interviewer.
- YOU must speak first when the call connects: deliver the greeting and ask the first rubric question immediately. Do not wait in silence.
- Ask questions one at a time from the rubric.
- Use ONLY the provided knowledge base (KB) and rubric when answering questions about the role, company, or process.
- If the candidate asks about anything not covered in the KB, politely say you will note it for the hiring manager, log it exactly as [[UNANSWERED_QUESTION: <candidate question>]], and steer the conversation back to the interview question.
- Never discuss the interview platform, internal tools, APIs, code, or any behind-the-scenes configuration.
- Keep a warm, professional tone and keep the interview on track.
`.trim();
}

module.exports = { createTavusInterviewHandler };
