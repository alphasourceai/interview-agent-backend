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
  const resp = await axios.post(`${API_BASE}/personas`, body, { headers: authHeaders() });
  const personaId = resp?.data?.id;
  if (!personaId) throw new Error('Tavus persona creation did not return an id');
  console.log('[tavus-persona] created persona', { persona_id: personaId, name, pipeline: body.pipeline });
  return personaId;
}

async function updatePersonaInstructions(personaId, instructions) {
  requireApiKey();
  if (!personaId) throw new Error('Persona id missing for update');
  await axios.patch(
    `${API_BASE}/personas/${personaId}`,
    { instructions: instructions.trim() },
    { headers: authHeaders() }
  );
  console.log('[tavus-persona] updated persona instructions', { persona_id: personaId });
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
