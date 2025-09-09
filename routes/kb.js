// routes/kb.js
'use strict';

const express = require('express');
const axios = require('axios');
const { supabase } = require('../src/lib/supabaseClient');
const { requireAuth, withClientScope } = require('../src/middleware/auth');

const router = express.Router();

// Collect scoped client IDs from standardized middleware
function getScopedClientIds(req) {
  const fromScope = Array.isArray(req?.clientScope?.memberships)
    ? req.clientScope.memberships.map(m => m.client_id).filter(Boolean)
    : [];
  const legacy = req.client?.id ? [req.client.id] : [];
  return Array.from(new Set([...fromScope, ...legacy]));
}

/**
 * POST /kb/upload
 * Body (one of):
 *   - { role_id, kb_document_id }
 *   - { role_id, document_url, document_name?, tags?[] }
 *
 * AuthZ: caller must have scope to the role's client_id.
 */
router.post('/upload', requireAuth, withClientScope, async (req, res) => {
  try {
    const role_id = req.body?.role_id;
    const kb_document_id = req.body?.kb_document_id;
    const document_url = req.body?.document_url;
    const document_name = req.body?.document_name || null;
    const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];

    if (!role_id) return res.status(400).json({ error: 'role_id required' });

    // Ensure caller has scope over this role's client
    const { data: roleRow, error: roleErr } = await supabase
      .from('roles')
      .select('id, client_id')
      .eq('id', role_id)
      .single();
    if (roleErr || !roleRow) return res.status(404).json({ error: 'Role not found' });

    const scopedIds = getScopedClientIds(req);
    if (!scopedIds.includes(roleRow.client_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // If caller passed a pre-existing doc id, just attach it
    if (kb_document_id) {
      const { error: uErr } = await supabase
        .from('roles')
        .update({ kb_document_id })
        .eq('id', role_id);

      if (uErr) return res.status(500).json({ error: uErr.message });
      return res.status(200).json({ kb_document_id });
    }

    // Otherwise, create a KB doc from a URL via your KB service
    if (!document_url) {
      return res.status(400).json({ error: 'Either kb_document_id or document_url required' });
    }

    const kbServiceUrl = process.env.KB_SERVICE_URL;
    const kbApiKey = process.env.KB_SERVICE_API_KEY;
    if (!kbServiceUrl || !kbApiKey) {
      return res.status(500).json({ error: 'KB service not configured' });
    }

    const resp = await axios.post(
      `${kbServiceUrl}/documents`,
      { url: document_url, name: document_name, tags },
      { headers: { Authorization: `Bearer ${kbApiKey}` } }
    );

    const docId = resp?.data?.id;
    const docUrl = resp?.data?.url;
    if (!docId) return res.status(502).json({ error: 'KB service did not return an id' });

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

module.exports = router;
