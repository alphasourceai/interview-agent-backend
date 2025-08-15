// routes/kb.js
'use strict';

const express = require('express');
const axios = require('axios');
const { supabase } = require('../src/lib/supabaseClient');

const kbRouter = express.Router();

/**
 * POST /kb/upload
 * Body (one of):
 *   - { role_id, kb_document_id }
 *   - { role_id, document_url, document_name?, tags?[] }
 */
kbRouter.post('/upload', async (req, res) => {
  try {
    const { role_id, kb_document_id, document_url, document_name, tags } = req.body || {};
    if (!role_id) return res.status(400).json({ error: 'role_id required' });

    if (kb_document_id) {
      const { error } = await supabase
        .from('roles')
        .update({ kb_document_id })
        .eq('id', role_id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ kb_document_id });
    }

    if (!document_url) {
      return res.status(400).json({ error: 'Provide kb_document_id OR document_url' });
    }

    const API_KEY = String(process.env.TAVUS_API_KEY || '').trim();
    if (!API_KEY) return res.status(500).json({ error: 'TAVUS_API_KEY not set' });

    const payload = {
      document_url,
      document_name: document_name || `role-${role_id}-kb`,
      tags: Array.isArray(tags) ? tags : undefined
    };

    const resp = await axios.post('https://tavusapi.com/v2/documents', payload, {
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' }
    });

    const data = resp?.data || {};
    const docId = data.document_id || data.uuid || data.id || null;
    if (!docId) return res.status(500).json({ error: 'No document id returned from Tavus' });

    const { error } = await supabase
      .from('roles')
      .update({ kb_document_id: docId })
      .eq('id', role_id);
    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ kb_document_id: docId });
  } catch (e) {
    const status = e.response?.status || 500;
    const details = e.response?.data || e.message;
    return res.status(status).json({ error: details });
  }
});

/**
 * POST /kb/from-rubric
 * Body: { role_id, use_signed_url?, document_name?, tags?[] }
 * Saves roles.rubric to Storage and creates a Tavus KB doc from that URL.
 */
kbRouter.post('/from-rubric', async (req, res) => {
  try {
    const { role_id, use_signed_url, document_name, tags } = req.body || {};
    if (!role_id) return res.status(400).json({ error: 'role_id required' });

    const { data: role, error: rErr } = await supabase
      .from('roles')
      .select('id, rubric')
      .eq('id', role_id)
      .single();
    if (rErr || !role) return res.status(404).json({ error: rErr?.message || 'Role not found' });
    if (!role.rubric) return res.status(400).json({ error: 'roles.rubric is empty for this role' });

    const bucket = process.env.SUPABASE_KB_BUCKET || 'kbs';
    const path = `${role_id}.json`;
    const content = JSON.stringify(role.rubric, null, 2);
    const upload = await supabase.storage.from(bucket).upload(path, content, {
      contentType: 'application/json',
      upsert: true
    });
    if (upload.error) return res.status(500).json({ error: upload.error.message });

    let docUrl;
    if (use_signed_url) {
      const { data: signed, error: signErr } = await supabase
        .storage
        .from(bucket)
        .createSignedUrl(path, 60 * 60 * 24 * 7);
      if (signErr) return res.status(500).json({ error: signErr.message });
      docUrl = signed?.signedUrl;
    } else {
      const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
      docUrl = pub?.publicUrl;
    }
    if (!docUrl) return res.status(500).json({ error: 'Failed to get document URL' });

    const API_KEY = String(process.env.TAVUS_API_KEY || '').trim();
    if (!API_KEY) return res.status(500).json({ error: 'TAVUS_API_KEY not set' });

    const payload = {
      document_url: docUrl,
      document_name: document_name || `role-${role_id}-kb-from-rubric`,
      tags: Array.isArray(tags) ? tags : undefined
    };

    const resp = await axios.post('https://tavusapi.com/v2/documents', payload, {
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' }
    });

    const data = resp?.data || {};
    const docId = data.document_id || data.uuid || data.id || null;
    if (!docId) return res.status(500).json({ error: 'No document id returned from Tavus' });

    const { error: uErr } = await supabase
      .from('roles')
      .update({ kb_document_id: docId })
      .eq('id', role_id);
    if (uErr) return res.status(500).json({ error: uErr.message });

    return res.status(200).json({ kb_document_id: docId, document_url: docUrl });
  } catch (e) {
    const status = e.response?.status || 500;
    const details = e.response?.data || e.message;
    return res.status(status).json({ error: details });
  }
});

module.exports = { kbRouter };
