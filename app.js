// app.js
'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
let morgan; try { morgan = require('morgan'); } catch (_) {}
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = express();

// CORS
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

// --- Auth middleware ---
async function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Unauthorized' });

    req.user = { id: data.user.id, email: data.user.email || null };

    // load client memberships for scope
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

// Optional router mount (won’t crash if file missing)
function mountOptional(prefix, routerPath, { unauth = false } = {}) {
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const router = require(routerPath);
    if (unauth) app.use(prefix, router);
    else app.use(prefix, requireAuth, router);
    console.log(`[mount] ${prefix} -> ${routerPath}`);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.warn(`[mount skipped] ${routerPath} (not found)`);
    } else {
      console.warn(`[mount error] ${routerPath}: ${e.message}`);
    }
  }
}

// Health
app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'interview-agent-backend', time: new Date().toISOString() }));

// Auth info (FE expects this)
app.get('/auth/me', requireAuth, (req, res) => {
  res.json({
    user: req.user,
    clientIds: req.clientIds || [],
    memberships: req.client_memberships || [],
  });
});

// Core routers (all optional to prevent deploy crashes if a file is absent)
mountOptional('/clients', './routes/clients');        // has /clients/my and /clients/mine
mountOptional('/roles', './routes/roles');
mountOptional('/roles', './routes/rolesUpload');      // POST /roles/upload-jd
mountOptional('/files', './routes/files');            // GET /files/signed-url
mountOptional('/reports', './routes/reports');
mountOptional('/dashboard', './routes/dashboard');    // /dashboard/interviews
mountOptional('/webhook/tavus', './routes/webhookTavus', { unauth: true }); // if present

// Root
app.get('/', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
module.exports = app;
