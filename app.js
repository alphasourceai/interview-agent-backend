// app.js — backend entry (clean, auth-safe, keeps existing routes)
require('dotenv').config();

const express = require('express');
const cors = require('cors');

// Try to use your shared Supabase helper, otherwise build clients from env.
let supabaseAnon, supabaseAdmin;
try {
  ({ supabaseAnon, supabaseAdmin } = require('./src/lib/supabaseClient'));
} catch {
  const { createClient } = require('@supabase/supabase-js');
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLIC_ANON_KEY =
    process.env.SUPABASE_PUBLIC_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_PUBLIC_ANON_KEY) {
    throw new Error('Missing Supabase env (URL / ANON / SERVICE_ROLE).');
  }
  supabaseAnon = createClient(SUPABASE_URL, SUPABASE_PUBLIC_ANON_KEY, {
    auth: { persistSession: false },
  });
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

// Routers you already have
const rolesRouter = require('./routes/roles');
const clientsRouter = require('./routes/clients');
const dashboardRouter = require('./routes/dashboard'); // (this message includes its full code)

const FRONTEND_URL =
  (process.env.FRONTEND_URL ||
    process.env.VITE_AUTH_REDIRECT_URL ||
    'http://localhost:5173').replace(/\/+$/, '');
const CORS_ORIGINS = (process.env.CORS_ORIGINS || FRONTEND_URL)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();

// ---------- middleware ----------
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // SSR / curl
      const ok = CORS_ORIGINS.some((o) => origin.startsWith(o));
      cb(ok ? null : new Error('CORS'), ok);
    },
    credentials: true,
  }),
);

// health
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- auth helpers ----------
function getBearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

async function requireAuth(req, res, next) {
  const token = getBearer(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = { id: data.user.id, email: data.user.email };
  next();
}

async function withClientScope(req, res, next) {
  const client_id = req.query.client_id || req.params.client_id || req.body.client_id;
  if (!client_id) return res.status(400).json({ error: 'client_id is required' });
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  async function tryQuery(clientCol, userCol) {
    return supabaseAdmin
      .from('client_members')
      .select('role')
      .eq(clientCol, client_id)
      .eq(userCol, req.user.id)
      .maybeSingle();
  }

  // Try modern column names first; fall back to legacy names if needed.
  let q = await tryQuery('client_id', 'user_id_uuid');
  if (q.error && q.error.code === '42703') q = await tryQuery('client_id_uuid', 'user_id_uuid');

  if (q.error || !q.data) return res.status(403).json({ error: 'Forbidden' });
  req.client = { id: client_id, role: q.data.role };
  next();
}

// Small helper for FE
app.get('/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

// List the clients for the current user (used by FE dropdowns)
app.get('/clients/my', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id, name, created_at, client_members:client_members!inner(role, user_id_uuid)')
    .eq('client_members.user_id_uuid', req.user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json({
    clients: (data || []).map((c) => ({
      id: c.id,
      name: c.name,
      role: c.client_members?.[0]?.role || 'member',
    })),
  });
});

// ---------- mount your existing route modules ----------
app.use('/clients', requireAuth, clientsRouter);
app.use('/roles', requireAuth, rolesRouter);
app.use('/dashboard', requireAuth, withClientScope, dashboardRouter);

// root
app.get('/', (_req, res) => res.json({ ok: true }));

// generic error handler
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  const msg = err.message || 'Server error';
  if (process.env.NODE_ENV !== 'production') console.error(err);
  res.status(status).json({ error: msg });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));

module.exports = app;
