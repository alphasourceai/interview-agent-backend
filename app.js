// app.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ---------- CORS ----------
const origins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: origins.length ? origins : true,
  credentials: true,
}));

// ---------- JSON body ----------
app.use(express.json({ limit: '2mb' }));

// ---------- Supabase admin ----------
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ---------- Auth + client scope (as in your original app.js) ----------
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });
  try {
    const payload = jwt.verify(token, process.env.SUPABASE_JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email || null };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function withClientScope(req, _res, next) {
  try {
    const uid = req.user?.id;
    if (!uid) {
      req.clientIds = [];
      return next();
    }
    const { data, error } = await supabaseAdmin
      .from('client_members')
      .select('client_id')
      .eq('user_id', uid);

    if (error) {
      console.warn('[withClientScope] error:', error.message);
      req.clientIds = [];
      return next();
    }
    req.clientIds = (data || []).map(r => r.client_id);
    next();
  } catch (e) {
    console.warn('[withClientScope] unexpected:', e.message);
    req.clientIds = [];
    next();
  }
}

function injectClientMemberships(req, _res, next) {
  req.client_memberships = Array.isArray(req.clientIds) ? req.clientIds : [];
  next();
}

// ---------- Health ----------
app.get('/healthz', (_req, res) => res.json({ ok: true }));


// ---------- Auth debug ----------
app.get('/auth/me', requireAuth, async (req, res) => {
  res.json({ user: req.user, clientIds: req.clientIds || [], memberships: req.client_memberships || [] });
});

// ---------- Routers ----------
const clientsRouter = require('./routes/clients');            // (updated in this patch)
const rolesUploadRouter = require('./routes/rolesUpload');   // (new in this patch)

// Mount protected routers with auth + scope (your original pattern)
app.use('/clients', requireAuth, withClientScope, injectClientMemberships, clientsRouter);

// NOTE: This only adds /roles/upload-jd; keep your existing /roles routes too.
app.use('/roles', requireAuth, withClientScope, injectClientMemberships, rolesUploadRouter);

// ---- Optional: mount other existing routers if present (safe no-ops if missing) ----
function tryMount(path, routerPath) {
  try {
    const r = require(routerPath);
    app.use(path, requireAuth, withClientScope, injectClientMemberships, r);
    console.log(`[mount] ${routerPath} -> ${path}`);
  } catch (e) {
    // ignore if the file doesn't exist in your repo
  }
}
// Example (uncomment if these exist in your repo):
// tryMount('/roles', './routes/roles');
// tryMount('/files', './routes/files');
// tryMount('/reports', './routes/reports');
// tryMount('/webhook', './routes/webhook');

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`API listening on :${PORT}`));
}

module.exports = app;
