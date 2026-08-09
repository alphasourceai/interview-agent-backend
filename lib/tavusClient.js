'use strict';

const { tavusHttpClient } = require('../src/lib/tavusHttpClient');

let activePersonaId = String(process.env.TAVUS_PERSONA_ID || '').trim() || null;
let personaConfigured = false;

function requireApiKey() {
  if (!String(process.env.TAVUS_API_KEY || '').trim()) {
    throw new Error('TAVUS_API_KEY is not set');
  }
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
  try {
    const data = await tavusHttpClient.createPersona(body);
    const personaId = data?.persona_id || data?.id;
    if (!personaId) throw new Error('Tavus persona creation did not return an id');
    console.log('[tavus-persona] created persona', { persona_id: personaId, name, pipeline: body.pipeline });
    return personaId;
  } catch (err) {
    logPersonaError(err, 'create_persona');
    const status = err?.status;
    const e = new Error(`tavus_persona_create_failed: ${status || 'unknown_status'}`);
    e.status = status || 500;
    throw e;
  }
}

async function updatePersonaInstructions(personaId, instructions) {
  requireApiKey();
  if (!personaId) throw new Error('Persona id missing for update');
  const body = { instructions: instructions.trim() };
  try {
    await tavusHttpClient.patchPersona(personaId, body);
    console.log('[tavus-persona] updated persona instructions', { persona_id: personaId });
  } catch (err) {
    logPersonaError(err, 'patch_persona');
    const status = err?.status;
    const e = new Error(`tavus_persona_update_failed: ${status || 'unknown_status'}`);
    e.status = status || 500;
    throw e;
  }
}

function logPersonaError(error, operation) {
  console.error('[tavus-persona-error]', {
    operation,
    status: error?.status || null,
    providerCode: error?.providerCode || null,
    category: error?.category || 'provider_error',
    attemptCount: Number.isInteger(error?.attemptCount) ? error.attemptCount : 1,
    timeout: error?.timeout === true,
  });
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
