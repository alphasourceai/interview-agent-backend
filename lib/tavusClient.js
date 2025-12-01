'use strict';

const axios = require('axios');

const API_BASE = (process.env.TAVUS_API_BASE || 'https://tavusapi.com/v2').replace(/\/+$/, '');
const API_KEY = String(process.env.TAVUS_API_KEY || '').trim();
const PERSONA_ID = String(process.env.TAVUS_PERSONA_ID || '').trim();

let personaConfigured = false;

function requirePersonaConfig() {
  if (!API_KEY) {
    throw new Error('TAVUS_API_KEY is not set');
  }
  if (!PERSONA_ID) {
    throw new Error('TAVUS_PERSONA_ID is not set');
  }
}

async function ensurePersonaConfigured(instructions) {
  requirePersonaConfig();
  if (personaConfigured) return PERSONA_ID;

  if (instructions && instructions.trim()) {
    try {
      await axios.patch(
        `${API_BASE}/personas/${PERSONA_ID}`,
        { instructions: instructions.trim() },
        { headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' } }
      );
      console.log('[tavus-persona] updated persona instructions', { persona_id: PERSONA_ID });
    } catch (err) {
      console.error('[tavus-persona] failed to update persona instructions', err?.response?.data || err?.message || err);
      throw err;
    }
  }
  personaConfigured = true;
  return PERSONA_ID;
}

module.exports = {
  ensurePersonaConfigured,
  TAVUS_PERSONA_ID: PERSONA_ID
};
