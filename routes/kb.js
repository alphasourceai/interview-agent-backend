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

/** Turn JSON rubric into human-readable bullet text. */
function rubricToPlainText(rubric) {
  const lines = [];

  function isPrimitive(v) {
    return v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  }

  function titleCase(s) {
    try {
      return String(s)
        .replace(/[_\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase());
    } catch { return String(s); }
  }

  function walk(node, indent = 0, label) {
    const pad = '  '.repeat(indent);
    if (isPrimitive(node)) {
      if (label != null) lines.push(`${pad}- ${titleCase(label)}: ${node}`);
      else lines.push(`${pad}- ${node}`);
      return;
    }
    if (Array.isArray(node)) {
      if (label != null) lines.push(`${pad}- ${titleCase(label)}:`);
      node.forEach((item) => walk(item, indent + 1));
      return;
    }
    if (typeof node === 'object') {
      if (label != null) lines.push(`${pad}- ${titleCase(label)}:`);
      Object.entries(node).forEach(([k, v]) => walk(v, indent + 1, k));
    }
  }

  const preferredKeys = ['summary', 'overview', 'categories', 'weights', 'scoring', 'skills', 'experience', 'behavioral', 'technical'];
  const keys = Object.keys(rubric || {});
  const ordered = [...new Set([...preferredKeys.filter(k => keys.includes(k)), ...keys.filter(k => !preferredKeys.includes(k))])];

  ordered.forEach((k) => walk(rubric[k], 0, k));
  return lines.join('\n');
}

/**
 * POST /kb/from-rubric
 * Body: { role_id, use_signed_url?, document_name?, tags?[] }
 * Exports roles.rubric as plain TXT (bullets) and appends JD URL if present,
 * then creates a Tavus KB document.
 */
kbRouter.post('/from-rubric', async (req, res) => {
  try {
    const { role_id, use_signed_url, document_name, tags } = req.body || {};
    if (!role_id) return res.status(400).json({ error: 'role_id required' });

    // NOTE: fetch job_description_url (not job_description)
    const { data: role, error: rErr } = await supabase
      .from('roles')
      .select('id, title, rubric, job_description_url')
      .eq('id', role_id)
      .single();
    if (rErr || !role) return res.status(404).json({ error: rErr?.message || 'Role not found' });
    if (!role.rubric) return res.status(400).json({ error: 'roles.rubric is empty for this role' });

    const rubricText = rubricToPlainText(role.rubric);

    // We don't try to read the PDF here—just include the URL/path for reference.
    const jdLine = role.job_description_url
      ? `\nJOB DESCRIPTION FILE (storage path): ${role.job_description_url}\n`
      : '';

    const header = `ROLE: ${role.title || role.id}${jdLine}`;
    const body = [header, '\nRUBRIC:\n', rubricText].join('\n');

    // Upload as .txt to the kbs bucket
    const bucket = process.env.SUPABASE_KB_BUCKET || 'kbs';
    const path = `${role_id}.txt`;
    const upload = await supabase.storage.from(bucket).upload(path, body, {
      contentType: 'text/plain',
      upsert: true
    });
    if (upload.error) return res.status(500).json({ error: upload.error.message });

    // Get URL (public or signed)
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

    // Create Tavus Document
    const API_KEY = String(process.env.TAVUS_API_KEY || '').trim();
    if (!API_KEY) return res.status(500).json({ error: 'TAVUS_API_KEY not set' });

    const payload = {
      document_url: docUrl,
      document_name: document_name || `role-${role_id}-kb-from-rubric-txt`,
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
