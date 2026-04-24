'use strict';

const axios = require('axios');

const API_BASE = (process.env.TAVUS_API_BASE || 'https://tavusapi.com/v2').replace(/\/+$/, '');
const API_KEY = String(process.env.TAVUS_API_KEY || '').trim();
let activePersonaId = String(process.env.TAVUS_PERSONA_ID || '').trim() || null;
let personaConfigured = false;

function requireApiKey() {
  if (!API_KEY) {
    throw new Error('TAVUS_API_KEY is not set');
  }
}

function authHeaders() {
  return { 'x-api-key': API_KEY, 'Content-Type': 'application/json' };
}

async function createPersona(defaultInstructions) {
  requireApiKey();
  const name = (process.env.TAVUS_PERSONA_NAME || 'AlphaSource Interviewer Persona').trim();
  const replicaId = (process.env.TAVUS_REPLICA_ID || '').trim() || undefined;
  const body = {
    name,
    description: 'Persona for AlphaSource AI Interviewer. Handles structured interviews with KB context.',
    pipeline: 'conversational',
    default_replica_id: replicaId,
    instructions: defaultInstructions.trim()
  };
  const url = `${API_BASE}/personas`;
  try {
    const resp = await axios.post(url, body, { headers: authHeaders() });
    const personaId = resp?.data?.id;
    if (!personaId) throw new Error('Tavus persona creation did not return an id');
    console.log('[tavus-persona] created persona', { persona_id: personaId, name, pipeline: body.pipeline });
    return personaId;
  } catch (err) {
    logPersonaError(err, url, body);
    const status = err?.response?.status;
    const e = new Error(`tavus_persona_create_failed: ${status || 'unknown_status'}`);
    e.status = status || 500;
    throw e;
  }
}

async function updatePersonaInstructions(personaId, instructions) {
  requireApiKey();
  if (!personaId) throw new Error('Persona id missing for update');
  const url = `${API_BASE}/personas/${personaId}`;
  const body = { instructions: instructions.trim() };
  try {
    await axios.patch(url, body, { headers: authHeaders() });
    console.log('[tavus-persona] updated persona instructions', { persona_id: personaId });
  } catch (err) {
    logPersonaError(err, url, body);
    const status = err?.response?.status;
    const e = new Error(`tavus_persona_update_failed: ${status || 'unknown_status'}`);
    e.status = status || 500;
    throw e;
  }
}

function logPersonaError(error, url, requestBody) {
  if (error?.response) {
    console.error('[tavus-persona-error]', {
      status: error.response.status,
      url,
      requestBody,
      responseBody: error.response.data,
      responseText: typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data)
    });
  } else {
    console.error('[tavus-persona-error]', {
      url,
      requestBody,
      error: error?.message || error
    });
  }
}

async function ensurePersonaConfigured(instructions) {
  requireApiKey();
  if (!instructions || !instructions.trim()) throw new Error('Persona instructions are required');

  if (!personaConfigured) {
    if (!activePersonaId) {
      activePersonaId = await createPersona(instructions);
    } else {
      await updatePersonaInstructions(activePersonaId, instructions);
    }
    personaConfigured = true;
  }
  return activePersonaId;
}

function getPersonaId() {
  return activePersonaId;
}

module.exports = {
  ensurePersonaConfigured,
  getPersonaId
};
