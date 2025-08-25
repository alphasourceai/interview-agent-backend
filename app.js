// chore: mvp-hardening-backend-v3 (no-op)
require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { supabaseAnon, supabaseAdmin } = require('./src/lib/supabaseClient')

// Routers
const rolesRouter = require('./routes/roles')
const rolesUploadRouter = require('./routes/rolesUpload')
const clientsRouter = require('./routes/clients') // sendgrid-enabled clients routes
// Optional routers (mounted if present later): kb, webhook, tavus

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '')
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
const ALLOWLIST = Array.from(new Set([...DEFAULT_ORIGINS, FRONTEND_URL, ...envOrigins].filter(Boolean)))

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true)
    if (ALLOWLIST.includes(origin)) return cb(null, true)
    return cb(null, false)
  },
  credentials: true
}))

// ---------- Parsers ----------
app.use(express.json({ limit: '10mb' }))

// ---------- helpers ----------
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
  } catch {
    res.status(401).json({ error: 'Unauthorized' })
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
    req.memberships = data || []
    req.clientIds = (data || []).map(r => r.client_id)
    next()
  } catch {
    res.status(500).json({ error: 'Server error' })
  }
}

function injectClientMemberships(req, _res, next) {
  req.getClientIds = () => Array.isArray(req.clientIds) ? req.clientIds : []
  req.hasClient = (id) => req.getClientIds().includes(id)
  next()
}

// ---------- auth/identity ----------
app.get('/auth/me', requireAuth, withClientScope, injectClientMemberships, async (req, res) => {
  res.json({
    user: req.user,
    clientIds: req.getClientIds(),
    memberships: req.memberships
  })
})

app.get('/auth/ping', (_req, res) => res.json({ ok: true }))

// ---------- dashboard summaries (kept for legacy /dashboard consumers) ----------
app.get('/dashboard/interviews', requireAuth, withClientScope, injectClientMemberships, async (req, res) => {
  try {
    const qIds = String(req.query.client_id || '').split(',').map(s => s.trim()).filter(Boolean)
    const finalIds = qIds.length ? qIds.filter(id => req.hasClient(id)) : req.getClientIds()
    if (finalIds.length === 0) return res.json({ items: [] })

    const select = `
      id, created_at, candidate_id, role_id, client_id,
      video_url, transcript_url, analysis_url,
      roles:roles(id, title, client_id),
      candidates:candidates(id, name, email)
    `
    const { data: interviews, error } = await supabaseAdmin
      .from('interviews')
      .select(select)
      .in('client_id', finalIds)
      .order('created_at', { ascending: false })

    if (error) return res.status(500).json({ error: 'Failed to load interviews' })

    const interviewIds = (interviews || []).map(r => r.id)
    const reportsByInterview = {}
    if (interviewIds.length) {
      const { data: reps } = await supabaseAdmin
        .from('reports')
        .select('*')
        .in('interview_id', interviewIds)
        .order('created_at', { ascending: false })
      for (const r of reps || []) {
        if (!reportsByInterview[r.interview_id]) reportsByInterview[r.interview_id] = r
      }
    }

    const numOrNull = x => Number.isFinite(Number(x)) ? Number(x) : null

    const items = (interviews || []).map(r => {
      const rep = reportsByInterview[r.id] || null
      const resume_score = numOrNull(rep?.resume_score)
      const interview_score = numOrNull(rep?.interview_score)
      const overall_score = numOrNull(rep?.overall_score)
      return {
        id: r.id,
        created_at: r.created_at,
        role: r.roles ? { id: r.roles.id, title: r.roles.title } : null,
        candidate: r.candidates ? { id: r.candidates.id, name: r.candidates.name, email: r.candidates.email } : null,
        has_transcript: !!r.transcript_url,
        has_analysis: !!r.analysis_url,
        report_url: rep?.report_url || null,
        resume_score, interview_score, overall_score
      }
    })

    res.json({ items })
  } catch (_e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ---------- Clients (invitations, members) ----------
app.use('/clients', requireAuth, withClientScope, injectClientMemberships, clientsRouter)

// ---------- Optional router mounts helper ----------
function mountIfExists(modPath, urlPath, middlewares = []) {
  try {
    const mod = require(modPath)
    if (mod && typeof mod === 'function') {
      if (middlewares.length) app.use(urlPath, ...middlewares, mod)
      else app.use(urlPath, mod)
      console.log(`Mounted ${modPath} at ${urlPath}`)
    }
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
  injectClientMemberships,
  require('./routes/files')
)

app.use(
  '/reports',
  requireAuth,
  withClientScope,
  injectClientMemberships,
  require('./routes/reports') // fingerprinting + cache
)

// ---------- Roles JD upload (protected) ----------
app.use(
  '/roles',
  requireAuth,
  withClientScope,
  injectClientMemberships,
  rolesUploadRouter
)

// ---------- Roles (mount same router at BOTH paths) ----------
app.use(
  ['/roles', '/create-role'],
  requireAuth,
  withClientScope,
  injectClientMemberships,
  rolesRouter
)

// ---------- health ----------
app.get('/health', (_req, res) => res.json({ ok: true }))

// ---------- Error handler ----------
app.use(function (err, _req, res, _next) {
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
