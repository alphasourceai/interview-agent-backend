require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { supabaseAnon, supabaseAdmin } = require('./src/lib/supabaseClient')

const app = express()

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
  origin: function (origin, cb) {
    if (!origin) return cb(null, true)
    if (ALLOWLIST.includes(origin)) return cb(null, true)
    return cb(new Error('Not allowed by CORS'))
  },
  credentials: true
}

app.set('trust proxy', 1)
app.use(cors(corsOptions))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

function mountIfExists(routePath, mountPoint) {
  try {
    const router = require(routePath)
    app.use(mountPoint, router)
  } catch (e) {}
}

mountIfExists('./routes/webhook', '/webhook')
mountIfExists('./routes/kb', '/kb')
mountIfExists('./routes/createTavusInterview', '/create-tavus-interview')
mountIfExists('./routes/reports', '/reports')
mountIfExists('./routes/candidates', '/candidates')
mountIfExists('./routes/retryInterview', '/interviews')

async function requireAuth(req, res, next) {
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Missing bearer token' })
  const { data, error } = await supabaseAnon.auth.getUser(token)
  if (error || !data?.user) return res.status(401).json({ error: 'Invalid token' })
  req.user = data.user
  req.jwt = token
  next()
}

async function withClientScope(req, res, next) {
  if (!req.user) return res.status(500).json({ error: 'User not loaded' })
  const { data, error } = await supabaseAdmin
    .from('client_members')
    .select('client_id, role')
    .eq('user_id', req.user.id)
  if (error) return res.status(500).json({ error: 'Failed to load memberships' })
  req.clientIds = data.map(r => r.client_id)
  req.memberships = data
  next()
}

app.get('/auth/ping', requireAuth, withClientScope, (req, res) => {
  res.json({ ok: true, userId: req.user.id, clientIds: req.clientIds })
})

app.get('/auth/me', requireAuth, withClientScope, (req, res) => {
  const user = { id: req.user.id, email: req.user.email }
  res.json({ user, memberships: req.memberships })
})

app.get('/dashboard/interviews', requireAuth, withClientScope, async (req, res) => {
  const requested = (req.query.client_id || '').trim()
  const filterIds = requested && req.clientIds.includes(requested) ? [requested] : req.clientIds
  if (!filterIds || filterIds.length === 0) return res.json({ items: [] })

  const select = `
    id, candidate_id, role_id, created_at,
    video_url, transcript_url, analysis_url, client_id,
    roles:role_id ( id, title, client_id )
  `
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
})

app.get('/health', (req, res) => res.json({ ok: true }))
app.get('/', (req, res) => res.send('ok'))

app.use(function (err, req, res, next) {
  const status = err.status || 500
  const msg = err.message || 'Server error'
  res.status(status).json({ error: msg })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})

module.exports = app
