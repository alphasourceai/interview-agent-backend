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
const ALLOWLIST = Array.from(new Set([...DEFAULT_ORIGINS, ...envOrigins]))

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true)
    if (ALLOWLIST.includes(origin)) return cb(null, true)
    return cb(new Error('Not allowed by CORS'))
  },
  credentials: true
}

// ---------- App basics ----------
app.set('trust proxy', 1)
app.use(cors(corsOptions))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

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

// ---------- Simple test endpoint ----------
app.get('/auth/ping', requireAuth, withClientScope, (req, res) => {
  res.json({ ok: true, userId: req.user.id, clientIds: req.clientIds })
})

// ---------- Auth: who am I ----------
app.get('/auth/me', requireAuth, withClientScope, (req, res) => {
  const user = { id: req.user.id, email: req.user.email }
  res.json({ user, memberships: req.memberships })
})

// ---------- Dashboard: scoped interviews ----------
app.get('/dashboard/interviews', requireAuth, withClientScope, async (req, res) => {
  try {
    const requested = (req.query.client_id || '').trim()
    const filterIds = requested && req.clientIds.includes(requested) ? [requested] : req.clientIds
    if (!filterIds || filterIds.length === 0) return res.json({ items: [] })

    const select =
      'id, candidate_id, role_id, created_at, video_url, transcript_url, analysis_url, client_id, roles:role_id ( id, title, client_id )'

    const { data, error } = await supabaseAdmin
      .from('interviews')
      .select(select)
      .in('client_id', filterIds)
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
    const { email, role = 'member', client_id } = req.body || {}
    if (!email || !client_id) return res.status(400).json({ error: 'email and client_id are required' })

    const membership = (req.memberships || []).find(m => m.client_id === client_id)
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return res.status(403).json({ error: 'not allowed' })
    }

    const token = crypto.randomBytes(24).toString('hex')
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()

    const { error: insertError } = await supabaseAdmin.from('client_invites').insert({
      client_id,
      email,
      role,
      token,
      expires_at: expiresAt
    })
    if (insertError) return res.status(500).json({ error: 'failed to create invite' })

    const acceptUrl = `${FRONTEND_URL}/accept-invite?token=${encodeURIComponent(token)}`
    res.json({ ok: true, accept_url: acceptUrl })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ---------- Accept invite (logged-in invitee) ----------
app.post('/clients/accept-invite', requireAuth, async (req, res) => {
  try {
    const { token } = req.body || {}
    if (!token) return res.status(400).json({ error: 'token required' })

    const { data: invites, error } = await supabaseAdmin
      .from('client_invites')
      .select('id, client_id, email, role, expires_at, accepted_at')
      .eq('token', token)
      .limit(1)

    if (error || !invites || invites.length === 0) return res.status(400).json({ error: 'invalid token' })

    const invite = invites[0]
    if (invite.accepted_at) return res.status(400).json({ error: 'invite already accepted' })
    if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'invite expired' })

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

    res.json({ ok: true, client_id: invite.client_id, role: invite.role })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ---------- Health & root ----------
app.get('/health', (req, res) => res.json({ ok: true }))
app.get('/', (req, res) => res.send('ok'))

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
