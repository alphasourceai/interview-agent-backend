// app.js (drop-in)
require('dotenv').config()
const express = require('express')
const cors = require('cors')
const crypto = require('crypto')
const { supabaseAnon, supabaseAdmin } = require('./src/lib/supabaseClient')

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'
const app = express()

// ---------- CORS ----------
const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'https://interview-agent-frontend.onrender.com',
  'https://ia-frontend-prod.onrender.com',
  'https://www.alphasourceai.com',
]
const envOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const ALLOWLIST = Array.from(new Set([
  ...DEFAULT_ORIGINS,
  FRONTEND_URL.replace(/\/+$/, ''),
  ...envOrigins
].filter(Boolean)))

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true) // curl / same-origin
    if (ALLOWLIST.includes(origin)) return cb(null, true)
    return cb(null, false)
  },
  credentials: true
}))
app.use(express.json({ limit: '10mb' }))

// ---------- small util ----------
function bearer(req) {
  const h = req.headers['authorization'] || req.headers['Authorization']
  if (!h) return null
  const m = String(h).match(/^Bearer\s+(.+)$/i)
  return m ? m[1] : null
}

// ---------- auth middlewares ----------
async function requireAuth(req, res, next) {
  try {
    const token = bearer(req)
    if (!token) return res.status(401).json({ error: 'Unauthorized' })
    const { data, error } = await supabaseAnon.auth.getUser(token)
    if (error || !data?.user) return res.status(401).json({ error: 'Unauthorized' })
    req.user = { id: data.user.id, email: data.user.email }
    next()
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
}

async function withClientScope(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' })
    const { data, error } = await supabaseAdmin
      .from('client_members')
      .select('client_id, role')
      .eq('user_id', req.user.id)
    if (error) return res.status(500).json({ error: 'Failed to load memberships' })
    req.clientIds = (data || []).map(r => r.client_id)
    req.memberships = data || []
    next()
  } catch (e) {
    return res.status(500).json({ error: 'Server error' })
  }
}

// ---------- Public candidate endpoints (MOUNTED) ----------
app.use('/api/candidate/submit', require('./routes/candidateSubmit'))
app.use('/api/candidate/verify-otp', require('./routes/verifyOtp'))
app.use('/create-tavus-interview', require('./routes/createTavusInterview'))

// ---------- Simple test endpoint ----------
app.get('/auth/ping', requireAuth, withClientScope, (req, res) => {
  res.json({ ok: true, user: req.user, client_ids: req.clientIds })
})

// ---------- Auth me ----------
app.get('/auth/me', requireAuth, withClientScope, (req, res) => {
  res.json({ user: req.user, memberships: req.memberships })
})

// ---------- Clients: my ----------
app.get('/clients/my', requireAuth, withClientScope, async (req, res) => {
  try {
    const ids = req.clientIds || []
    if (ids.length === 0) return res.json({ items: [] })

    const { data: clients, error } = await supabaseAdmin
      .from('clients')
      .select('id, name')
      .in('id', ids)
    if (error) return res.status(500).json({ error: 'Failed to load clients' })

    const roleById = Object.fromEntries((req.memberships || []).map(m => [m.client_id, m.role]))
    const items = (clients || []).map(c => ({
      client_id: c.id,
      name: c.name,
      role: roleById[c.id] || 'member'
    }))
    res.json({ items })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ---------- Dashboard: scoped rows (CANDIDATE-FIRST) ----------
async function buildDashboardRows(req, res) {
  try {
    const filterIds = req.clientIds || [];
    if (filterIds.length === 0) return res.json({ items: [] });

    const wantedClientId = req.query.client_id;
    const finalIds = wantedClientId ? filterIds.filter(id => id === wantedClientId) : filterIds;
    if (finalIds.length === 0) return res.json({ items: [] });

    // 1) Pull candidates for the scoped client(s)
    const { data: candRows, error: candErr } = await supabaseAdmin
      .from('candidates')
      .select('id, first_name, last_name, name, email, role_id, client_id, created_at')
      .in('client_id', finalIds)
      .order('created_at', { ascending: false });

    if (candErr) return res.status(500).json({ error: 'Failed to load candidates' });

    const candidateIds = Array.from(new Set((candRows || []).map(c => c.id)));
    const roleIds = Array.from(new Set((candRows || []).map(c => c.role_id).filter(Boolean)));

    // 2) Join roles for display
    let rolesById = {};
    if (roleIds.length) {
      const { data: roles, error: roleErr } = await supabaseAdmin
        .from('roles')
        .select('id, title, client_id')
        .in('id', roleIds);

      if (roleErr) {
        rolesById = {};
      } else {
        rolesById = Object.fromEntries(
          (roles || []).map(r => [r.id, { id: r.id, title: r.title, client_id: r.client_id }])
        );
      }
    }

    // 3) Find the latest interview per candidate (same client scope)
    let latestInterviewByCand = {};
    if (candidateIds.length) {
      const { data: ivs, error: intErr } = await supabaseAdmin
        .from('interviews')
        .select('id, candidate_id, client_id, role_id, created_at, video_url, transcript_url, analysis_url')
        .in('candidate_id', candidateIds)
        .in('client_id', finalIds)
        .order('created_at', { ascending: false });

      if (!intErr && ivs) {
        for (const r of ivs) {
          const cid = r.candidate_id;
          if (!latestInterviewByCand[cid]) latestInterviewByCand[cid] = r;
        }
      }
    }

    // 4) Pull reports once; then choose best per candidate
    let bestReportByCand = {};
    if (candidateIds.length) {
      const { data: reps, error: repErr } = await supabaseAdmin
        .from('reports')
        .select(`
          id, candidate_id, role_id,
          resume_score, interview_score, overall_score,
          resume_breakdown, interview_breakdown,
          report_url, created_at
        `)
        .in('candidate_id', candidateIds)
        .order('created_at', { ascending: false });

      if (!repErr && reps) {
        for (const rep of reps) {
          const cur = bestReportByCand[rep.candidate_id];
          if (!cur) {
            bestReportByCand[rep.candidate_id] = rep;
          } else {
            const candRole = (candRows.find(c => c.id === rep.candidate_id) || {}).role_id;
            const curMatch = cur?.role_id && candRole && cur.role_id === candRole;
            const newMatch = rep?.role_id && candRole && rep.role_id === candRole;
            if (!curMatch && newMatch) bestReportByCand[rep.candidate_id] = rep;
          }
        }
      }
    }

    const numOrNull = v => (typeof v === 'number' && isFinite(v)) ? v : (v === 0 ? 0 : null);

    // 5) Normalize to FE shape
    const items = (candRows || []).map(c => {
      const fullName =
        c.name ||
        [c.first_name, c.last_name].filter(Boolean).join(' ').trim() ||
        '';

      const role = c.role_id ? (rolesById[c.role_id] || null) : null;
      const latest = latestInterviewByCand[c.id] || null;
      const rep = bestReportByCand[c.id] || null;

      const rb = rep?.resume_breakdown || {};
      const ib = rep?.interview_breakdown || {};

      const resume_analysis = {
        experience: numOrNull(rb.experience_match_percent ?? rb.experience),
        skills:     numOrNull(rb.skills_match_percent ?? rb.skills),
        education:  numOrNull(rb.education_match_percent ?? rb.education),
        summary:    typeof rb.summary === 'string' ? rb.summary : ''
      };

      const interview_analysis = {
        clarity:       numOrNull(ib.clarity),
        confidence:    numOrNull(ib.confidence),
        body_language: numOrNull(ib.body_language)
      };

      return {
        id: latest?.id ?? null,
        created_at: c.created_at,
        client_id: c.client_id,

        candidate: { id: c.id, name: fullName, email: c.email || '' },
        role,

        video_url: latest?.video_url || null,
        transcript_url: latest?.transcript_url || null,
        analysis_url: latest?.analysis_url || null,

        has_video: !!latest?.video_url,
        has_transcript: !!latest?.transcript_url,
        has_analysis: !!latest?.analysis_url,

        resume_score:    numOrNull(rep?.resume_score ?? null),
        interview_score: numOrNull(rep?.interview_score ?? null),
        overall_score:   numOrNull(rep?.overall_score ?? null),

        resume_analysis,
        interview_analysis,

        latest_report_url: rep?.report_url ?? null,
        report_generated_at: rep?.created_at ?? null
      };
    });

    return res.json({ items });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
}

// Existing path (kept for compatibility)
app.get('/dashboard/interviews', requireAuth, withClientScope, (req, res) => {
  buildDashboardRows(req, res)
})

// New path used by the FE
app.get('/dashboard/rows', requireAuth, withClientScope, (req, res) => {
  buildDashboardRows(req, res)
})

// ---------- Optional: invites ----------
app.post('/clients/invite', requireAuth, withClientScope, async (req, res) => {
  try {
    const { email, role = 'member', client_id } = req.body || {}
    if (!email || !client_id) return res.status(400).json({ error: 'email and client_id are required' })
    if (!(req.clientIds || []).includes(client_id)) return res.status(403).json({ error: 'Forbidden' })

    const token = crypto.randomBytes(16).toString('hex')
    const { error } = await supabaseAdmin
      .from('client_invites')
      .insert({ client_id, email, role, token, invited_by: req.user.id })
    if (error) return res.status(500).json({ error: 'Failed to create invite' })

    const acceptUrlBase = (process.env.FRONTEND_URL || FRONTEND_URL).replace(/\/+$/, '')
    const accept_url = `${acceptUrlBase}/accept-invite?token=${encodeURIComponent(token)}`
    res.json({ ok: true, accept_url })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/clients/accept-invite', requireAuth, async (req, res) => {
  try {
    const { token } = req.body || {}
    if (!token) return res.status(400).json({ error: 'token is required' })

    const { data: invite, error: invErr } = await supabaseAdmin
      .from('client_invites')
      .select('client_id, email, role')
      .eq('token', token)
      .single()
    if (invErr || !invite) return res.status(400).json({ error: 'Invalid invite' })
    if (invite.email && invite.email !== req.user.email) {
      return res.status(400).json({ error: 'Invite email does not match your account' })
    }

    const { error } = await supabaseAdmin
      .from('client_members')
      .upsert({ client_id: invite.client_id, user_id: req.user.id, role: invite.role }, { onConflict: 'client_id,user_id' })
    if (error) return res.status(500).json({ error: 'Failed to join client' })

    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

/* ========================= ADDED: Admin guard + Admin API (PATCHED) ========================= */

// Admin-only guard (after requireAuth)
async function requireAdmin(req, res, next) {
  try {
    const email = req.user?.email || null
    if (!email) return res.status(403).json({ error: 'not_admin' })

    const { data: adm, error } = await supabaseAdmin
      .from('admins')
      .select('id,is_active')
      .eq('email', email)
      .eq('is_active', true)
      .maybeSingle()

    if (error) return res.status(500).json({ error: 'admin_lookup_failed' })
    if (!adm) return res.status(403).json({ error: 'not_admin' })
    next()
  } catch (e) {
    return res.status(500).json({ error: 'admin_guard_failed' })
  }
}

// Admin router (global admin; no client association)
const adminRouter = express.Router()

// List all clients
adminRouter.get('/clients', requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id,name,created_at')
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: 'list_clients_failed' })
  res.json({ items: data || [] })
})

// Create client (with optional seeded admin)
adminRouter.post('/clients', requireAuth, requireAdmin, async (req, res) => {
  const name = (req.body?.name || '').trim()
  const adminName  = (req.body?.admin_name  || '').trim()
  const adminEmail = (req.body?.admin_email || '').trim()
  if (!name) return res.status(400).json({ error: 'name_required' })

  const { data: client, error: cErr } = await supabaseAdmin
    .from('clients')
    .insert({ name })
    .select('id,name,created_at')
    .single()
  if (cErr) return res.status(500).json({ error: 'create_client_failed' })

  let seeded_member = null
  if (adminEmail) {
    let userId = null
    try {
      const invited = await supabaseAdmin.auth.admin.inviteUserByEmail(adminEmail, {
        redirectTo: 'https://www.alphasourceai.com/account?auth_callback=1'
      })
      userId = invited?.data?.user?.id || null
    } catch {}

    const payload = {
      client_id: client.id,
      email: adminEmail,
      name: adminName || adminEmail,
      role: 'admin',
      user_id: userId,
      user_id_uuid: userId
    }

    // Insert; tolerate schemas missing user_id_uuid
    const tryInsert = async (p) => supabaseAdmin
      .from('client_members')
      .insert(p)
      .select('id,client_id,user_id,user_id_uuid,email,name,role,created_at')
      .single()

    let ins = await tryInsert(payload)
    if (ins.error?.message?.includes('user_id_uuid')) {
      const p2 = { ...payload }; delete p2.user_id_uuid
      ins = await tryInsert(p2)
    }
    if (!ins.error) seeded_member = ins.data
  }

  res.json({ item: client, seeded_member })
})

// Delete client
adminRouter.delete('/clients/:id', requireAuth, requireAdmin, async (req, res) => {
  const { error } = await supabaseAdmin.from('clients').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: 'delete_client_failed' })
  res.json({ ok: true })
})

// List roles (optional client filter)
adminRouter.get('/roles', requireAuth, requireAdmin, async (req, res) => {
  const { client_id } = req.query
  let q = supabaseAdmin.from('roles')
    .select('id,title,client_id,slug_or_token,interview_type,job_description_url,description,rubric,kb_document_id,created_at')
    .order('created_at', { ascending: false })
  if (client_id) q = q.eq('client_id', client_id)
  const { data, error } = await q
  if (error) return res.status(500).json({ error: 'list_roles_failed' })
  res.json({ items: data || [] })
})

// Create role (saves interview_type + job_description_url; best-effort enrichment hooks)
adminRouter.post('/roles', requireAuth, requireAdmin, async (req, res) => {
  const { client_id, title } = req.body || {}
  let { interview_type, job_description_url } = req.body || {}

  if (!client_id || !title || !title.trim()) {
    return res.status(400).json({ error: 'client_id_and_title_required' })
  }
  const IT = String(interview_type || '').toUpperCase()
  const VALID = new Set(['BASIC','DETAILED','TECHNICAL'])
  interview_type = VALID.has(IT) ? IT : null

  const { data: role, error } = await supabaseAdmin
    .from('roles')
    .insert({
      client_id,
      title: title.trim(),
      interview_type,
      job_description_url: job_description_url || null
    })
    .select('id,title,client_id,slug_or_token,interview_type,job_description_url,description,rubric,kb_document_id,created_at')
    .single()
  if (error) return res.status(500).json({ error: 'create_role_failed' })

  // Optional enrichment (tolerant to missing modules)
  let updated = role
  if (job_description_url) {
    try {
      let rubric = null, descriptionText = null, kbDocId = null

      try {
        const jdParser = require('./utils/jdParser.js')
        const parseFn = jdParser?.parseJD || jdParser?.default
        if (typeof parseFn === 'function') {
          const r = await parseFn({ path: job_description_url, client_id, role_id: role.id })
          descriptionText = r?.description || r?.text || descriptionText
        }
      } catch {}

      try {
        const genMod = require('./utils/generateRubric.js')
        const genFn = genMod?.generateRubricForJD || genMod?.generateRubric || genMod?.default
        if (typeof genFn === 'function') {
          const r = await genFn({
            client_id, role_id: role.id,
            title: title.trim(),
            jd_path: job_description_url,
            description: descriptionText
          })
          rubric = r?.rubric || r || rubric
          if (!descriptionText && r?.description) descriptionText = r.description
        }
      } catch {}

      try {
        const kbMod = require('./routes/kb')
        const kbFn = kbMod?.createKnowledgeBaseFromJD || kbMod?.default
        if (typeof kbFn === 'function') {
          const r = await kbFn({ client_id, role_id: role.id, jd_path: job_description_url })
          kbDocId = r?.kb_document_id || kbDocId
          if (!descriptionText && r?.description) descriptionText = r.description
        }
      } catch {}

      const { data: saved } = await supabaseAdmin
        .from('roles')
        .update({
          description: descriptionText,
          rubric: rubric,
          kb_document_id: kbDocId
        })
        .eq('id', role.id)
        .select('id,title,client_id,slug_or_token,interview_type,job_description_url,description,rubric,kb_document_id,created_at')
        .single()
      updated = saved || role
    } catch (e) {
      console.error('enrich_role_failed', e?.message || e)
    }
  }

  res.json({ item: updated })
})

// Delete role
adminRouter.delete('/roles/:id', requireAuth, requireAdmin, async (req, res) => {
  const { error } = await supabaseAdmin.from('roles').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: 'delete_role_failed' })
  res.json({ ok: true })
})

// List members for a client
adminRouter.get('/client-members', requireAuth, requireAdmin, async (req, res) => {
  const { client_id } = req.query
  if (!client_id) return res.status(400).json({ error: 'client_id_required' })
  const { data, error } = await supabaseAdmin
    .from('client_members')
    .select('id,client_id,user_id,user_id_uuid,email,name,role,created_at')
    .eq('client_id', client_id)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: 'list_members_failed' })
  res.json({ items: data || [] })
})

// Add a client member (invite + persist role & dual UUIDs)
adminRouter.post('/client-members', requireAuth, requireAdmin, async (req, res) => {
  const { client_id, email, name } = req.body || {}
  const role = (req.body?.role || 'member').toLowerCase()
  if (!client_id || !email || !name) return res.status(400).json({ error: 'client_id_email_name_required' })

  let userId = null
  try {
    const invited = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: 'https://www.alphasourceai.com/account?auth_callback=1'
    })
    userId = invited?.data?.user?.id || null
  } catch {}

  const basePayload = {
    client_id, email, name, role,
    user_id: userId || null,
    user_id_uuid: userId || null
  }

  const tryInsert = async (p) => supabaseAdmin
    .from('client_members')
    .insert(p)
    .select('id,client_id,user_id,user_id_uuid,email,name,role,created_at')
    .single()

  let ins = await tryInsert(basePayload)
  if (ins.error?.message?.includes('user_id_uuid')) {
    const p2 = { ...basePayload }; delete p2.user_id_uuid
    ins = await tryInsert(p2)
  }
  if (ins.error) return res.status(500).json({ error: 'add_member_failed' })

  res.json({ item: ins.data })
})

// Remove a client member (by id)
adminRouter.delete('/client-members/:id', requireAuth, requireAdmin, async (req, res) => {
  const { error } = await supabaseAdmin.from('client_members').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: 'remove_member_failed' })
  res.json({ ok: true })
})

app.use('/admin', adminRouter)

/* ======================= END: Admin guard + Admin API (PATCHED) ======================= */

// ---------- Mount legacy/optional feature routes if present ----------
function mountIfExists(relPath, urlPath) {
  try {
    const mod = require(relPath)
    app.use(urlPath, mod)
  } catch (_) {}
}
mountIfExists('./routes/kb', '/kb')
mountIfExists('./routes/webhook', '/webhook')
mountIfExists('./routes/tavus', '/')

// ---------- Protected mounts ----------
app.use(
  '/files',
  requireAuth,
  withClientScope,
  (req, _res, next) => {
    if (!req.client_memberships) {
      const ids = Array.isArray(req.memberships) ? req.memberships.map(m => m.client_id) : (req.clientIds || [])
      req.client_memberships = ids
    }
    next()
  },
  require('./routes/files')
)

app.use(
  '/reports',
  requireAuth,
  withClientScope,
  (req, _res, next) => {
    if (!req.client_memberships) {
      const ids = Array.isArray(req.memberships) ? req.memberships.map(m => m.client_id) : (req.clientIds || [])
      req.client_memberships = ids
    }
    next()
  },
  require('./routes/reports')
)

// ---------- health ----------
app.get('/health', (_req, res) => res.json({ ok: true }))

// ---------- 404 ----------
app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

// ---------- Error handler ----------
app.use(function (err, req, res, next) {
  const status = err.status || 500
  const msg = err.message || 'Server error'
  res.status(status).json({ error: msg })
})

// ---------- Start ----------
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})

module.exports = app
