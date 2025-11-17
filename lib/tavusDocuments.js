// lib/tavusDocuments.js
'use strict';

/**
 * KB flow overview:
 *  - generateRubricAndKBForRole builds a rubric and drops a JSON KB file into
 *    Supabase storage (bucket kbs), storing the UUID in roles.kb_document_id.
 *  - ensureTavusDocumentForRole reads that JSON, POSTs it to Tavus /v2/documents,
 *    and persists the Tavus document id in roles.tavus_document_id.
 *  - handlers/createTavusInterview consumes roles.tavus_document_id when
 *    launching Daily/Tavus interviews (falling back to syncing on demand).
 */

const axios = require('axios');
const { supabase } = require('../src/lib/supabaseClient');

const KB_BUCKET = process.env.SUPABASE_KB_BUCKET || 'kbs';
const TAVUS_API_BASE_URL = (process.env.TAVUS_API_BASE_URL || 'https://tavusapi.com/v2').replace(/\/+$/, '');

function missingTavusKbError(roleId, detail) {
  const err = new Error(detail || 'Role is missing Tavus KB ID');
  err.code = 'missing_tavus_kb';
  err.status = 500;
  err.role_id = roleId || null;
  return err;
}

function normalizeKbKey(kbId) {
  if (!kbId) return null;
  return kbId.endsWith('.json') ? kbId : `${kbId}.json`;
}

async function downloadKbJson(kbId, supabaseClient) {
  const key = normalizeKbKey(kbId);
  if (!key) return null;
  const storage = supabaseClient.storage.from(KB_BUCKET);
  const { data, error } = await storage.download(key);
  if (error) {
    return { error };
  }
  if (typeof data?.arrayBuffer === 'function') {
    const buf = Buffer.from(await data.arrayBuffer());
    return { json: buf.toString('utf8'), size: buf.length };
  }
  if (Buffer.isBuffer(data)) {
    return { json: data.toString('utf8'), size: data.length };
  }
  return { json: String(data || ''), size: Buffer.byteLength(String(data || '')) };
}

async function createTavusDocument({ role, kbJson, supabaseClient }) {
  const API_KEY = String(process.env.TAVUS_API_KEY || '').trim();
  if (!API_KEY) {
    console.warn('[tavus-doc] TAVUS_API_KEY not set; skipping Tavus document creation');
    return null;
  }
  if (!kbJson) throw new Error('kb_json_missing');

  const roleName = role?.title ? role.title : `Role ${role?.id || ''}`.trim();
  const document_name = roleName ? `${roleName} KB` : 'Interview KB';
  const payload = {
    document_name,
    document_description: `Auto-generated interview KB for role ${role?.id || 'unknown'}`,
    document_content: kbJson,
    document_type: 'text',
    metadata: {
      role_id: role?.id || null,
      kb_document_id: role?.kb_document_id || null
    }
  };

  console.log(`[tavus-doc] Creating Tavus document for role=${role?.id || 'unknown'} using kb_document_id=${role?.kb_document_id}`);
  const resp = await axios.post(`${TAVUS_API_BASE_URL}/documents`, payload, {
    headers: {
      'x-api-key': API_KEY,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });
  const docId = resp?.data?.document_id || resp?.data?.id;
  if (!docId) throw new Error('tavus_document_id_missing');
  console.log(`[tavus-doc] Created Tavus document ${docId} for role=${role?.id || 'unknown'}`);

  const updateFields = { tavus_document_id: docId };
  await supabaseClient
    .from('roles')
    .update(updateFields)
    .eq('id', role.id);
  return docId;
}

async function ensureTavusDocumentForRole(roleInput, opts = {}) {
  const supabaseClient = opts.supabase || supabase;
  if (!roleInput || !roleInput.id) throw new Error('role_id_required');
  const forceRefresh = Boolean(opts.forceRefresh);

  // Always refetch the latest kb/tavus columns if caller didn't pass them.
  let role = roleInput;
  if (!('kb_document_id' in roleInput) || !('tavus_document_id' in roleInput) || opts.refetch === true) {
    const { data, error } = await supabaseClient
      .from('roles')
      .select('id, title, kb_document_id, tavus_document_id')
      .eq('id', roleInput.id)
      .single();
    if (error || !data) throw new Error(error?.message || 'role_not_found');
    role = { ...roleInput, ...data };
  }

  if (!forceRefresh && role.tavus_document_id) {
    return role.tavus_document_id;
  }

  if (!role.kb_document_id) {
    console.warn(`[tavus-doc] Role ${role.id} missing kb_document_id; cannot create Tavus document`);
    return null;
  }

  const download = await downloadKbJson(role.kb_document_id, supabaseClient);
  if (download?.error) {
    const statusCode = download.error?.statusCode || download.error?.status || '';
    if (!forceRefresh && String(statusCode) === '404') {
      console.warn(`[tavus-doc] KB file ${role.kb_document_id} missing; treating stored id as Tavus document id`);
      await supabaseClient
        .from('roles')
        .update({ tavus_document_id: role.kb_document_id })
        .eq('id', role.id);
      return role.kb_document_id;
    }
    console.error(`[tavus-doc] Failed to download KB for role ${role.id}:`, download.error?.message || download.error);
    throw missingTavusKbError(role.id, 'KB file could not be downloaded for Tavus sync');
  }

  try {
    return await createTavusDocument({
      role,
      kbJson: download.json,
      supabaseClient
    });
  } catch (err) {
    console.error(`[tavus-doc] Tavus document creation failed for role ${role.id}:`, err?.response?.data || err?.message || err);
    throw err;
  }
}

module.exports = {
  ensureTavusDocumentForRole,
  missingTavusKbError
};
