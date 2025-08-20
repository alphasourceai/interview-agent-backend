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
  'https://interview-agent-frontend.onrender.com'
]
const envOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
// CHANGE #1: ensure FRONTEND_URL is always allowed
const ALLOWLIST = Array.from(new Set([...DEFAULT_ORIGINS, ...envOrigins, FRONTEND_URL]))

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true)
    if (ALLOWLIST.includes(origin)) return cb(null, true)
    return cb(new Error('Not allowed by CORS'))
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}

// ---------- App basics ----------
app.set('trust proxy', 1)
app.use(cors(corsOptions))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

// CHANGE #2 is further down when mounting routes/files with auth + scope

// ---------- Helper to mount optional routers without crashing ----------
function mountIfExists(routePath, mountPoint) {
  try {
    const router = require(routePath)
    app.use(mountPoint, router)
  } catch (e) {
    // Router not present — skip silently for MVP
  }
}

// Existing feature routers (present in your repo)
mountIfExists('./routes/webhook', '/webhook')                 // GET /_ping, POST /tavus, POST /recording-ready
mountIfExists('./routes/kb', '/kb')                           // POST /upload, POST /from-rubric
mountIfExists('./routes/createTavusInterview', '/create-tavus-interview')
mountIfExists('./routes/reports', '/reports')
mountIfExists('./routes/candidates', '/candidates')           // intake + OTP verify
mountIfExists('./routes/retryInterview', '/interviews')

// ---------- Auth & tenant scope middleware ----------
async function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || ''
    const token = h.startsWith('Bearer ') ? h.slice(7) : null
    if (!token) return res.status(401).json({ error: 'Missing bearer token' })
    const { data, error } = await supabaseAnon.auth.getUser(token)
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid token' })
    req.user = data.user
    req.jwt = token
    next()
  } catch (e) {
    res.status(401).json({ error: 'Auth error' })
  }
}

async function withClientScope(req, res, next) {
  if (!req.user) return res.status(500).json({ error: 'User not loaded' })
  const { data, error } = await supabaseAdmin
    .from('client_members')
    .select('client_id, role')
    .eq('user_id', req.user.id)

  if (error) return res.status(500).json({ error: 'Failed to load memberships' })

  req.clientIds = (data || []).map(r => r.client_id)
  req.memberships = data || []
  next()
}

// ---------- Auth helpers ----------
app.get('/auth/ping', requireAuth, withClientScope, (req, res) => {
  res.json({ ok: true })
})

app.get('/auth/me', requireAuth, withClientScope, (req, res) => {
  res.json({
    user: { id: req.user.id, email: req.user.email },
    memberships: req.memberships
  })
})

// ---------- Clients: list my clients with names ----------
app.get('/clients/my', requireAuth, async (req, res) => {
  try {
    const { data: mems, error: memErr } = await supabaseAdmin
      .from('client_members')
      .select('client_id, role')
      .eq('user_id', req.user.id)
    if (memErr) return res.status(500).json({ error: 'Failed to load memberships' })

    const clientIds = (mems || []).map(m => m.client_id)
    if (clientIds.length === 0) return res.json({ items: [] })

    const { data: clients, error: cliErr } = await supabaseAdmin
      .from('clients')
      .select('id, name')
      .in('id', clientIds)
    if (cliErr) return res.status(500).json({ error: 'Failed to load clients' })

    const nameById = Object.fromEntries((clients || []).map(c => [c.id, c.name]))
    const items = (mems || []).map(m => ({
      client_id: m.client_id,
      name: nameById[m.client_id] || m.client_id,
      role: m.role
    }))
    res.json({ items })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ---------- Dashboard: scoped interviews ----------
app.get('/dashboard/interviews', requireAuth, withClientScope, async (req, res) => {
  try {
    const filterIds = req.clientIds || []
    if (filterIds.length === 0) return res.json({ items: [] })

    const wantedClientId = req.query.client_id
    const finalIds = wantedClientId ? filterIds.filter(id => id === wantedClientId) : filterIds
    if (finalIds.length === 0) return res.json({ items: [] })

    const select = `
      id, created_at, candidate_id, role_id, client_id,
      video_url, transcript_url, analysis_url,
      roles:roles(id, title, client_id)
    `
    const { data, error } = await supabaseAdmin
      .from('interviews')
      .select(select)
      .in('client_id', finalIds)
      .order('created_at', { ascending: false })

    if (error) return res.status(500).json({ error: 'Failed to load interviews' })

    const items = (data || []).map(r => ({
      id: r.id,
      created_at: r.created_at,
      candidate_id: r.candidate_id || null,
      role_id: r.role_id || null,
      client_id: r.client_id || null,
      role: r.roles ? { id: r.roles.id, title: r.roles.title, client_id: r.roles.client_id } : null,
      video_url: r.video_url || null,
      transcript_url: r.transcript_url || null,
      analysis_url: r.analysis_url || null,
      has_video: !!r.video_url,
      has_transcript: !!r.transcript_url,
      has_analysis: !!r.analysis_url
    }))

    res.json({ items })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ---------- Invite teammates (owner/admin) ----------
app.post('/clients/invite', requireAuth, withClientScope, async (req, res) => {
  try {
    const { email, role, client_id } = req.body || {}
    if (!email || !role || !client_id) {
      return res.status(400).json({ error: 'email, role, client_id are required' })
    }

    const me = req.memberships.find(m => m.client_id === client_id)
    if (!me || !['owner', 'admin'].includes(me.role)) {
      return res.status(403).json({ error: 'Not allowed' })
    }

    const token = crypto.randomBytes(24).toString('hex')
    const { data, error } = await supabaseAdmin
      .from('client_invites')
      .insert({ client_id, email, role, token })
      .select('id')
      .single()
    if (error) return res.status(500).json({ error: 'Failed to create invite' })

    const acceptUrl = new URL('/accept-invite', FRONTEND_URL)
    acceptUrl.searchParams.set('token', token)

    res.json({
      ok: true,
      invite_id: data.id,
      accept_url: acceptUrl.toString()
    })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ---------- Accept invite (logged-in user) ----------
app.post('/clients/accept-invite', requireAuth, async (req, res) => {
  try {
    const { token } = req.body || {}
    if (!token) return res.status(400).json({ error: 'token is required' })

    const { data: invite, error } = await supabaseAdmin
      .from('client_invites')
      .select('*')
      .eq('token', token)
      .is('accepted_at', null)
      .single()

    if (error || !invite) return res.status(400).json({ error: 'Invalid or expired invite' })

    const userId = req.user.id
    const { error: upsertError } = await supabaseAdmin
      .from('client_members')
      .upsert(
        { client_id: invite.client_id, user_id: userId, role: invite.role },
        { onConflict: 'client_id,user_id' }
      )
    if (upsertError) return res.status(500).json({ error: 'failed to add member' })

    const { error: markAccepted } = await supabaseAdmin
      .from('client_invites')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invite.id)
    if (markAccepted) return res.status(500).json({ error: 'failed to mark accepted' })

    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ---------- Signed URLs for private storage (mounted with auth/scope) ----------
app.use(
  requireAuth,
  withClientScope,
  // Normalize to the shape expected by routes/files (req.client_memberships: string[])
  (req, _res, next) => {
    if (!req.client_memberships) {
      const ids = Array.isArray(req.memberships)
        ? req.memberships.map(m => m.client_id)
        : (req.clientIds || [])
      req.client_memberships = ids
    }
    next()
  },
  require('./routes/files')
)

// ---------- Health ----------
app.get('/health', (req, res) => res.json({ ok: true }))

// ---------- Root ----------
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Interview Agent Backend' })
})

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
