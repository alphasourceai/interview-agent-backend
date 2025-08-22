require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { supabaseAnon, supabaseAdmin } = require('./src/lib/supabaseClient')

// Routers
const rolesRouter = require('./routes/roles')
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
    if (!origin) return cb(null, true) // curl / same-origin
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

// Normalizer so downstream routers always see req.client_memberships[]
function injectClientMemberships(req, _res, next) {
  if (!req.client_memberships) {
    const ids = Array.isArray(req.memberships) ? req.memberships.map(m => m.client_id) : (req.clientIds || [])
    req.client_memberships = ids
  }
  next()
}

// ---------- Simple test endpoints ----------
app.get('/auth/ping', requireAuth, withClientScope, (req, res) => {
  res.json({ ok: true, user: req.user, client_ids: req.clientIds })
})

app.get('/auth/me', requireAuth, withClientScope, (req, res) => {
  res.json({ user: req.user, memberships: req.memberships })
})

// ---------- Clients (my, invite, accept-invite) ----------
app.use('/clients', requireAuth, withClientScope, injectClientMemberships, clientsRouter)

// ---------- Dashboard: client-scoped interviews with scores ----------
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
      roles:roles(id, title, client_id),
      candidates:candidates(id, name, email)
    `
    const { data: interviews, error } = await supabaseAdmin
      .from('interviews')
      .select(select)
      .in('client_id', finalIds)
      .order('created_at', { ascending: false })

    if (error) return res.status(500).json({ error: 'Failed to load interviews' })

    const intIds = (interviews || []).map(r => r.id)
    let reportsByInterview = {}
    if (intIds.length) {
      const { data: reps } = await supabaseAdmin
        .from('reports')
        .select('*')
        .in('interview_id', intIds)
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
      const overall_score =
        numOrNull(rep?.overall_score) ??
        (Number.isFinite(resume_score) && Number.isFinite(interview_score)
          ? Math.round((resume_score + interview_score) / 2)
          : null)

      const rb = rep?.resume_breakdown || {}
      const ib = rep?.interview_breakdown || {}

      return {
        id: r.id,
        created_at: r.created_at,
        client_id: r.client_id || null,

        candidate: r.candidates
          ? { id: r.candidates.id, name: r.candidates.name || '', email: r.candidates.email || '' }
          : { id: r.candidate_id || null, name: '', email: '' },

        role: r.roles ? { id: r.roles.id, title: r.roles.title, client_id: r.roles.client_id } : null,

        video_url: r.video_url || null,
        transcript_url: r.transcript_url || null,
        analysis_url: r.analysis_url || null,

        has_video: !!r.video_url,
        has_transcript: !!r.transcript_url,
        has_analysis: !!r.analysis_url,

        resume_score,
        interview_score,
        overall_score,

        resume_analysis: {
          experience: numOrNull(rb.experience),
          skills:     numOrNull(rb.skills),
          education:  numOrNull(rb.education),
          summary:    typeof rb.summary === 'string' ? rb.summary : ''
        },
        interview_analysis: {
          clarity:       numOrNull(ib.clarity),
          confidence:    numOrNull(ib.confidence),
          body_language: numOrNull(ib.body_language)
        },

        report_url: rep?.report_url ?? null,
        report_generated_at: rep?.created_at ?? null
      }
    })

    res.json({ items })
  } catch {
    res.status(500).json({ error: 'Server error' })
  }
})

// ---------- Optional mounts if present ----------
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
