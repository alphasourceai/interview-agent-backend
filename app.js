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
    if (error) return res.status(500).json({ error: 'Failed to load memberships', detail: error.message })
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
    if (error) return res.status(500).json({ error: 'Failed to load clients', detail: error.message })

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

    if (candErr) return res.status(500).json({ error: 'Failed to load candidates', detail: candErr.message });

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
    if (error) return res.status(500).json({ error: 'Failed to create invite', detail: error.message })

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
    if (invErr || !invite) return res.status(400).json({ error: 'Invalid invite', detail: invErr?.message })
    if (invite.email && invite.email !== req.user.email) {
      return res.status(400).json({ error: 'Invite email does not match your account' })
    }

    const { error } = await supabaseAdmin
      .from('client_members')
      .upsert({ client_id: invite.client_id, user_id: req.user.id, role: invite.role }, { onConflict: 'client_id,user_id' })
    if (error) return res.status(500).json({ error: 'Failed to join client', detail: error.message })

    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

/* ========================= Admin guard + Admin API (fixed) ========================= */

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

    if (error) {
      console.error('admin_lookup_failed:', error.message)
      return res.status(500).json({ error: 'admin_lookup_failed', detail: error.message })
    }
    if (!adm) return res.status(403).json({ error: 'not_admin' })
    next()
  } catch (e) {
    return res.status(500).json({ error: 'admin_guard_failed' })
  }
}

// Admin router (global admin; no client association)
const adminRouter = express.Router()

// Helper: ensure a user exists & (preferably) send an invite; return user_id + optional action_link
async function ensureUserIdAndInvite(email, redirectTo) {
  let userId = null
  let actionLink = null
  let method = null

  // 1) Try invite first (sends email)
  try {
    const invited = await supabaseAdmin.auth.admin.inviteUserByEmail(email, { redirectTo })
    userId = invited?.data?.user?.id || null
    method = 'invite'
  } catch (e) {
    console.error('inviteUserByEmail failed:', e?.message || e)
  }

  // 2) If no userId, try generating a magic link (gives user + link; you can DM it if needed)
  if (!userId) {
    try {
      const link = await supabaseAdmin.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: { redirectTo }
      })
      userId = link?.data?.user?.id || null
      actionLink = link?.data?.action_link || null
      method = method || 'magiclink'
    } catch (e) {
      console.error('generateLink(magiclink) failed:', e?.message || e)
    }
  }

  // 3) If still no user, create the user (ensures a UUID), then try inviting again
  if (!userId) {
    try {
      const created = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true
      })
      userId = created?.data?.user?.id || null
      method = method || 'createUser'
    } catch (e) {
      console.error('createUser failed:', e?.message || e)
    }
    if (userId) {
      try {
        await supabaseAdmin.auth.admin.inviteUserByEmail(email, { redirectTo })
        method = 'createUser+invite'
      } catch (e) {
        console.error('second invite after createUser failed:', e?.message || e)
      }
    }
  }

  return { userId, actionLink, method }
}

// List all clients
adminRouter.get('/clients', requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id,name,created_at')
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: 'list_clients_failed', detail: error.message })
  res.json({ items: data || [] })
})

// Create client (now writes email to satisfy NOT NULL)
adminRouter.post('/clients', requireAuth, requireAdmin, async (req, res) => {
  const name = (req.body?.name || '').trim()
  const adminName  = (req.body?.admin_name  || '').trim()
  const adminEmail = (req.body?.admin_email || '').trim()
  const explicitClientEmail = (req.body?.email || '').trim()
  if (!name) return res.status(400).json({ error: 'name_required' })

  const emailForClient = explicitClientEmail || adminEmail
  if (!emailForClient) {
    return res.status(400).json({ error: 'email_required_for_client' })
  }

  const { data: client, error: cErr } = await supabaseAdmin
    .from('clients')
    .insert({ name, email: emailForClient })
    .select('id,name,created_at')
    .single()
  if (cErr) {
    console.error('create_client_failed:', cErr.message)
    return res.status(500).json({ error: 'create_client_failed', detail: cErr.message, hint: cErr.hint })
  }

  // Optionally seed an admin member
  let seeded_member = null
  if (adminEmail) {
    const redirectTo = 'https://www.alphasourceai.com/account?auth_callback=1'
    const { userId, actionLink, method } = await ensureUserIdAndInvite(adminEmail, redirectTo)

    if (!userId) {
      console.error('seed_member_no_user_id', { email: adminEmail, method })
      // We return client OK but skip seeding to satisfy NOT NULL
      return res.json({ item: client, seeded_member: null, note: 'client_created_invite_failed', action_link: actionLink || null })
    }

    const payload = {
      client_id: client.id,
      email: adminEmail,
      name: adminName || adminEmail,
      role: 'admin',
      user_id: userId
    }

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('client_members')
      .insert(payload)
      .select('client_id,user_id,email,name,role,created_at')
      .single()

    if (insErr) {
      console.error('seed_member_insert_failed:', insErr.message)
    } else {
      seeded_member = { ...inserted, id: inserted.user_id || inserted.email }
    }
  }

  res.json({ item: client, seeded_member })
})

// Delete client
adminRouter.delete('/clients/:id', requireAuth, requireAdmin, async (req, res) => {
  const { error } = await supabaseAdmin.from('clients').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: 'delete_client_failed', detail: error.message })
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
  if (error) return res.status(500).json({ error: 'list_roles_failed', detail: error.message })
  res.json({ items: data || [] })
})

// Create role (same as before; JD parsing can be added after we stabilize)
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
  if (error) return res.status(500).json({ error: 'create_role_failed', detail: error.message })

  res.json({ item: role })
})

// List members for a client (no "id" in SELECT; add synthetic id)
adminRouter.get('/client-members', requireAuth, requireAdmin, async (req, res) => {
  const { client_id } = req.query
  if (!client_id) return res.status(400).json({ error: 'client_id_required' })
  const { data, error } = await supabaseAdmin
    .from('client_members')
    .select('client_id,user_id,email,name,role,created_at')
    .eq('client_id', client_id)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: 'list_members_failed', detail: error.message })

  const items = (data || []).map(m => ({ ...m, id: m.user_id || m.email }))
  res.json({ items })
})

// Add a client member (guarantee user_id before insert)
adminRouter.post('/client-members', requireAuth, requireAdmin, async (req, res) => {
  const { client_id, email, name } = req.body || {}
  const role = (req.body?.role || 'member').toLowerCase()
  if (!client_id || !email || !name) return res.status(400).json({ error: 'client_id_email_name_required' })

  const redirectTo = 'https://www.alphasourceai.com/account?auth_callback=1'
  const { userId, actionLink, method } = await ensureUserIdAndInvite(email, redirectTo)

  if (!userId) {
    console.error('add_member_no_user_id', { email, method })
    return res.status(400).json({
      error: 'add_member_failed',
      detail: 'Could not create or locate user for this email.',
      hint: 'Try again or send the magic link manually.',
      action_link: actionLink || null
    })
  }

  const payload = { client_id, email, name, role, user_id: userId }

  const { data, error } = await supabaseAdmin
    .from('client_members')
    .insert(payload)
    .select('client_id,user_id,email,name,role,created_at')
    .single()

  if (error) {
    console.error('add_member_insert_failed:', error.message)
    return res.status(500).json({ error: 'add_member_failed', detail: error.message })
  }

  const m = data
  res.json({ item: { ...m, id: m.user_id || m.email } })
})

// Remove a client member (treat :id as user_id or email; optional ?client_id=)
adminRouter.delete('/client-members/:id', requireAuth, requireAdmin, async (req, res) => {
  const key = req.params.id
  const client_id = req.query.client_id || null

  let q = supabaseAdmin.from('client_members').delete()
  if (key.includes('@')) q = q.eq('email', key)
  else q = q.eq('user_id', key)
  if (client_id) q = q.eq('client_id', client_id)

  const { error } = await q
  if (error) return res.status(500).json({ error: 'remove_member_failed', detail: error.message })
  res.json({ ok: true })
})

app.use('/admin', adminRouter)

/* ======================= END: Admin guard + Admin API (fixed) ======================= */

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
