// app.js
'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
let morgan; try { morgan = require('morgan'); } catch (_) {}

const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;

// ----- Supabase Admin -----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ----- App -----
const app = express();

const origins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (origins.length === 0) return cb(null, true);
    cb(null, origins.includes(origin));
  },
  credentials: false,
  allowedHeaders: ['Authorization','Content-Type'],
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
}));

app.use(express.json({ limit: '10mb' }));
if (morgan) app.use(morgan('tiny'));

// ----- Auth helpers -----
async function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Unauthorized' });

    req.user = { id: data.user.id, email: data.user.email || null };
    // load client memberships
    const { data: rows, error: memErr } = await supabaseAdmin
      .from('client_members')
      .select('client_id, user_id, role, name')
      .eq('user_id', req.user.id);

    if (memErr) {
      req.clientIds = [];
      req.client_memberships = [];
    } else {
      req.client_memberships = rows || [];
      req.clientIds = (rows || []).map(r => r.client_id);
    }

    next();
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// ----- Health & Auth -----
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'interview-agent-backend', time: new Date().toISOString() }));

// Re-add /auth/me for the frontend
app.get('/auth/me', requireAuth, (req, res) => {
  res.json({
    user: req.user,
    clientIds: req.clientIds || [],
    memberships: req.client_memberships || [],
  });
});

// ----- Mount routers (with auth) -----
function mount(prefix, path) {
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const router = require(path);
  app.use(prefix, requireAuth, router);
}

mount('/clients', './routes/clients');         // includes /my and /mine
mount('/roles', './routes/roles');             // GET/POST roles
mount('/roles', './routes/rolesUpload');       // POST /roles/upload-jd
mount('/files', './routes/files');             // GET /files/signed-url
mount('/reports', './routes/reports');         // generate/download
mount('/dashboard', './routes/dashboard');     // /dashboard/interviews
mount('/webhook/tavus', './routes/webhookTavus'); // webhook (may be unauth inside)

// Root
app.get('/', (_req, res) => res.json({ ok: true }));

// Start
app.listen(PORT, () => console.log(`API listening on :${PORT}`));

module.exports = app;
