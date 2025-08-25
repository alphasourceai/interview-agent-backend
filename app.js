// app.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ---------- CORS ----------
const origins = (process.env.CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : true, credentials: true }));

app.use(express.json({ limit: '2mb' }));

// ---------- Supabase Admin ----------
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ---------- Auth + client scope ----------
async function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid token' });
    req.user = { id: data.user.id, email: data.user.email || null };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function withClientScope(req, _res, next) {
  try {
    const uid = req.user?.id;
    if (!uid) { req.clientIds = []; return next(); }
    const { data, error } = await supabaseAdmin
      .from('client_members')
      .select('client_id')
      .eq('user_id', uid);
    if (error) { req.clientIds = []; return next(); }
    req.clientIds = (data || []).map(r => r.client_id);
    next();
  } catch {
    req.clientIds = [];
    next();
  }
}
function injectClientMemberships(req, _res, next) {
  req.client_memberships = Array.isArray(req.clientIds) ? req.clientIds : [];
  next();
}

// ---------- Health / Debug ----------
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/auth/me', requireAuth, (req, res) =>
  res.json({ user: req.user, memberships: req.client_memberships || [] })
);

// ---------- Routers ----------
const clientsRouter = require('./routes/clients');       // UPDATED clients
const rolesRouter = require('./routes/roles');           // Your existing roles list/create
const rolesUploadRouter = require('./routes/rolesUpload'); // JD upload

app.use('/clients', requireAuth, withClientScope, injectClientMemberships, clientsRouter);
app.use('/roles',   requireAuth, withClientScope, injectClientMemberships, rolesRouter);
app.use('/roles',   requireAuth, withClientScope, injectClientMemberships, rolesUploadRouter);

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`API listening on :${PORT}`));
}
module.exports = app;
