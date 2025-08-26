// app.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const dashboardRouter = require('./routes/dashboard');

const app = express();

/* ------------------------- CORS ------------------------- */
const origins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// allow credentials so Authorization header is passed through
app.use(
  cors({
    origin: origins.length ? origins : true,
    credentials: true,
  })
);

// Basic body parsers (file uploads use multer in their routers)
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

/* -------------------- Supabase Admin -------------------- */
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

/* -------------------- Auth middleware ------------------- */
// Extract Bearer token and validate it against Supabase Admin
async function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing bearer token' });

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid token' });

    req.user = { id: data.user.id, email: data.user.email || null };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/* ----------------- Client scope middleware --------------- */
// Support either column naming scheme in client_members:
// - client_id / user_id
// - client_id_uuid / user_id_uuid
async function withClientScope(req, _res, next) {
  try {
    const uid = req.user?.id;
    if (!uid) {
      req.clientIds = [];
      return next();
    }

    const { data, error } = await supabaseAdmin.from('client_members').select('*');
    if (error) {
      req.clientIds = [];
      return next();
    }

    const myRows = (data || []).filter(
      (r) => (r.user_id ?? r.user_id_uuid) === uid
    );

    req.clientIds = myRows
      .map((r) => (r.client_id ?? r.client_id_uuid))
      .filter(Boolean);

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

/* ---------------------- Health/Auth ---------------------- */
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/auth/me', requireAuth, (req, res) =>
  res.json({ user: req.user, memberships: req.client_memberships || [] })
);

/* ------------------------ Routers ------------------------ */
// NOTE: Ensure these files exist in ./routes
const clientsRouter = require('./routes/clients');       // /clients/my, /clients/members, /clients/invite, etc.
const rolesRouter = require('./routes/roles');           // /roles (GET/POST)
const rolesUploadRouter = require('./routes/rolesUpload'); // /roles/upload-jd

app.use('/clients', requireAuth, withClientScope, injectClientMemberships, clientsRouter);
app.use('/roles',   requireAuth, withClientScope, injectClientMemberships, rolesRouter);
app.use('/roles',   requireAuth, withClientScope, injectClientMemberships, rolesUploadRouter);
app.use('/dashboard', requireAuth, withClientScope, injectClientMemberships, dashboardRouter);

/* ---------------------- Default root --------------------- */
app.get('/', (_req, res) => res.json({ ok: true }));

/* ------------------------ Startup ------------------------ */
const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`API listening on :${PORT}`));
}

module.exports = app;
