// routes/kb.js (POST /kb/upload)
'use strict';

const express = require('express');
const axios = require('axios');
const { supabase } = require('../src/lib/supabaseClient');

const kbRouter = express.Router();

/**
 * Create (or set) a KB document for a role.
 *
 * POST /kb/upload
 * Body (one of):
 *   - { role_id, document_url, document_name?, tags?[] }  → creates a Tavus doc and stores its document_id/uuid
 *   - { role_id, kb_document_id }                         → directly stores an existing Tavus document_id
 *
 * Returns: { kb_document_id: "<document_id>" }
 *
 * Notes:
 * - Tavus KB docs page shows create returns a "document_id" used later in create-conversation as "document_ids".
 * - API reference also shows "uuid" in responses. We accept both and persist whichever is present (preferring document_id).
 */
kbRouter.post('/upload', async (req, res) => {
  try {
    const { role_id, kb_document_id, document_url, document_name, tags } = req.body || {};
    if (!role_id) return res.status(400).json({ error: 'role_id required' });

    // If caller already has a Tavus document id, just save it.
    if (kb_document_id) {
      const { error } = await supabase
        .from('roles')
        .update({ kb_document_id: kb_document_id })
        .eq('id', role_id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ kb_document_id });
    }

    // Otherwise, create the document via Tavus API from a public URL.
    if (!document_url) {
      return res.status(400).json({ error: 'Provide kb_document_id OR document_url' });
    }

    const API_KEY = String(process.env.TAVUS_API_KEY || '').trim();
    if (!API_KEY) return res.status(500).json({ error: 'TAVUS_API_KEY not set' });

    const payload = {
      document_url,
      document_name: document_name || `role-${role_id}-kb-doc`,
      // Optionally pass tags to group docs and use document_tags later
      tags: Array.isArray(tags) ? tags : undefined
      // callback_url for document processing updates is optional; omit for now
    };

    const resp = await axios.post('https://tavusapi.com/v2/documents', payload, {
      headers: {
        'x-api-key': API_KEY,
        'Content-Type': 'application/json'
      }
    });

    // Tavus docs show either "document_id" (KB page) or "uuid" (API ref). Save whichever exists.
    const respData = resp?.data || {};
    const docId =
      respData.document_id || respData.uuid || respData.id || null;

    if (!docId) {
      return res.status(500).json({ error: 'No document id returned from Tavus' });
    }

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

module.exports = { kbRouter };
