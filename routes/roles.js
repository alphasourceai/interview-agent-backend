// routes/roles.js
'use strict';

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---------- helpers ----------
function normalizeClientIds(req) {
  if (Array.isArray(req.clientIds) && req.clientIds.length) return req.clientIds;
  if (Array.isArray(req.client_memberships) && req.client_memberships.length) {
    return req.client_memberships
      .map(m => m.client_id || m.client_id_uuid)
      .filter(Boolean);
  }
  if (Array.isArray(req.memberships) && req.memberships.length) {
    return req.memberships
      .map(m => m.client_id || m.client_id_uuid)
      .filter(Boolean);
  }
  return [];
}

function pick(obj, allowed) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

// optional: works if you created the RPC; otherwise we’ll just assume common columns
async function listColumns(table) {
  try {
    const { data, error } = await supabaseAdmin.rpc('get_table_columns', { tname: table });
    if (error || !Array.isArray(data)) return new Set();
    return new Set(data.map(c => c.name));
  } catch {
    return new Set(['id','client_id','title','interview_type','manual_questions','job_description_url','job_description_text','meta','created_by','created_at']);
  }
}

// ---------- GET /roles?client_id=... ----------
router.get('/', async (req, res) => {
  try {
    const scope = normalizeClientIds(req);
    if (!scope.length) return res.json({ items: [] });

    const requested = req.query.client_id;
    if (!requested) {
      // default to first scoped client if FE hasn’t chosen yet
      const first = scope[0];
      const { data, error } = await supabaseAdmin
        .from('roles')
        .select('id, client_id, title, interview_type, created_at')
        .in('client_id', [first])
        .order('created_at', { ascending: false });

      if (error) return res.status(400).json({ error: error.message });
      return res.json({ items: data || [] });
    }

    if (!scope.includes(requested)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { data, error } = await supabaseAdmin
      .from('roles')
      .select('id, client_id, title, interview_type, created_at')
      .eq('client_id', requested)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    res.json({ items: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- POST /roles ----------
router.post('/', async (req, res) => {
  try {
    const scope = normalizeClientIds(req);
    if (!scope.length) return res.status(403).json({ error: 'Forbidden' });

    const {
      client_id,
      title,
      interview_type,
      job_description_text,
      job_description_url,   // path returned by /roles/upload-jd
      manual_questions,
      kb_document_id,
    } = req.body || {};

    if (!client_id || !scope.includes(client_id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const cols = await listColumns('roles');

    const base = {
      client_id,
      title,
      interview_type: interview_type || 'basic',
      kb_document_id: kb_document_id || null,
      ...(cols.has('created_by') ? { created_by: req.user?.id || null } : {}),
    };
    const insertable = pick(base, cols);

    // extras: store in columns if present, else meta
    const extras = {};
    if (job_description_text !== undefined) extras.job_description_text = job_description_text;
    if (job_description_url !== undefined) extras.job_description_url = job_description_url;
    if (manual_questions !== undefined) extras.manual_questions = Array.isArray(manual_questions) ? manual_questions : [];

    for (const k of Object.keys(extras)) {
      if (cols.has(k)) {
        insertable[k] = extras[k];
        delete extras[k];
      }
    }
    if (Object.keys(extras).length) {
      if (cols.has('meta')) {
        insertable.meta = { ...(insertable.meta || {}), ...extras };
      }
    }

    const { data, error } = await supabaseAdmin
      .from('roles')
      .insert(insertable)
      .select('*')
      .single();

    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true, role: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
