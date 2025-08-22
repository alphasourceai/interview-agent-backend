// routes/roles.js
const express = require('express')
const router = express.Router()
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
}
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// ---- helpers: scope ----
function getClientIds(req) {
  if (Array.isArray(req.client_memberships) && req.client_memberships.length) return req.client_memberships
  if (Array.isArray(req.memberships) && req.memberships.length) return req.memberships.map(m => m.client_id)
  if (Array.isArray(req.clientIds) && req.clientIds.length) return req.clientIds
  return []
}
function requireClientScope(req, res, next) {
  const ids = getClientIds(req)
  if (!ids.length) return res.status(403).json({ error: 'No client scope' })
  req._role_scope_ids = ids
  next()
}

// ---- helpers: schema introspection & safe insert ----
let rolesColumnsCache = null

async function getRolesColumns() {
  if (rolesColumnsCache) return rolesColumnsCache
  // Ask Postgres which columns exist on public.roles
  const { data, error } = await supabaseAdmin
    .from('information_schema.columns')
    .select('column_name')
    .eq('table_schema', 'public')
    .eq('table_name', 'roles')
  if (error) {
    // Some PostgREST configs don’t expose information_schema; fall back to safe defaults
    rolesColumnsCache = new Set(['id', 'client_id', 'title', 'interview_type', 'kb_document_id'])
    return rolesColumnsCache
  }
  rolesColumnsCache = new Set((data || []).map(r => r.column_name))
  return rolesColumnsCache
}

function pick(obj, allowedSet) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    if (allowedSet.has(k) && v !== undefined) out[k] = v
  }
  return out
}

// ---- GET /roles?client_id=... ----
router.get('/', requireClientScope, async (req, res) => {
  try {
    const allowed = req._role_scope_ids
    const cid = req.query.client_id
    let q = supabaseAdmin.from('roles').select('*').order('created_at', { ascending: false })
    if (cid) q = q.eq('client_id', cid)
    else q = q.in('client_id', allowed)
    const { data, error } = await q
    if (error) return res.status(400).json({ error: error.message })
    res.json({ roles: data || [] })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ---- POST /roles ----
// Body may include: { client_id (req), title (req), interview_type?, job_description_text?, manual_questions?[], kb_document_id? }
// We only insert columns that actually exist in your DB. If a JSONB 'meta' column exists, we’ll stash extras there.
router.post('/', requireClientScope, async (req, res) => {
  try {
    const allowed = req._role_scope_ids
    const {
      client_id,
      title,
      interview_type,
      job_description_text,  // may not exist in your schema
      manual_questions,      // may not exist in your schema (JSONB or text[])
      kb_document_id,        // often exists in your schema
    } = req.body || {}

    if (!client_id || !title) return res.status(400).json({ error: 'client_id and title are required' })
    if (!allowed.includes(client_id)) return res.status(403).json({ error: 'Forbidden for this client' })

    const cols = await getRolesColumns()

    // Build the minimal, safe payload first
    const baseInsert = {
      client_id,
      title,
      interview_type: interview_type || 'basic',
      kb_document_id: kb_document_id || null,
      // If your schema has created_by or similar:
      ...(cols.has('created_by') ? { created_by: req.user?.id || null } : {})
    }
    // Only keep keys that exist in columns
    const safeInsert = pick(baseInsert, cols)

    // Extra fields:
    const extras = {}
    if (job_description_text !== undefined) extras.job_description_text = job_description_text
    if (manual_questions !== undefined) {
      extras.manual_questions = Array.isArray(manual_questions) ? manual_questions : []
    }

    // If the concrete columns exist, write them directly
    if (cols.has('job_description_text') && extras.job_description_text !== undefined) {
      safeInsert.job_description_text = extras.job_description_text
      delete extras.job_description_text
    }
    if (cols.has('manual_questions') && extras.manual_questions !== undefined) {
      safeInsert.manual_questions = extras.manual_questions
      delete extras.manual_questions
    }

    // If a JSONB 'meta' column exists, stash any remaining extras there
    if (Object.keys(extras).length && cols.has('meta')) {
      // Merge with any default
      safeInsert.meta = Object.assign({}, safeInsert.meta || {}, extras)
    }

    const { data, error } = await supabaseAdmin.from('roles').insert(safeInsert).select('*').single()
    if (error) return res.status(400).json({ error: error.message })

    res.json({ ok: true, role: data })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
