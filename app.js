// app.js
'use strict';

// ----- Env & deps -----
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const CORS_ORIGINS =
  (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

// Admin client (server-only)
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ----- App -----
const app = express();

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow same-origin & local dev when origin is undefined (e.g. curl)
      if (!origin) return cb(null, true);
      if (CORS_ORIGINS.length === 0) return cb(null, true);
      cb(null, CORS_ORIGINS.includes(origin));
    },
    credentials: false,
    allowedHeaders: ['Authorization', 'Content-Type'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(morgan('tiny'));

// ----- Auth helpers -----
async function getUserFromReq(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return { user: null, token: null };

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error) return { user: null, token: null };
  return { user: data?.user || null, token };
}

async function loadMemberships(userId) {
  if (!userId) return { clientIds: [], memberships: [] };
  const { data, error } = await supabaseAdmin
    .from('client_members')
    .select('client_id, user_id, role, name')
    .eq('user_id', userId);
  if (error) return { clientIds: [], memberships: [] };
  const clientIds = (data || []).map(r => r.client_id);
  return { clientIds, memberships: data || [] };
}

async function requireAuth(req, res, next) {
  try {
    const { user, token } = await getUserFromReq(req);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    req.accessToken = token;

    const { clientIds, memberships } = await loadMemberships(user.id);
    req.clientIds = clientIds;
    req.client_memberships = memberships;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// Small wrapper so we can mount optional routers without crashing if file missing
function mountOptional(prefix, middlewares, path) {
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const router = require(path);
    if (Array.isArray(middlewares) && middlewares.length) {
      app.use(prefix, ...middlewares, router);
    } else {
      app.use(prefix, router);
    }
    // eslint-disable-next-line no-console
    console.log(`[mount] ${prefix} -> ${path}`);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.warn(`[mount:skip] ${path} (not found)`);
    } else {
      console.warn(`[mount:skip] ${path} (${e.message})`);
    }
  }
}

// ----- Health -----
app.get('/healthz', (_req, res) =>
  res.json({ ok: true, service: 'interview-agent-backend', time: new Date().toISOString() })
);

// ----- Core routers -----
// Clients (in this message)
mountOptional('/clients', [requireAuth], './routes/clients');

// Roles CRUD
mountOptional('/roles', [requireAuth], './routes/roles');
// Role file upload (pdf/doc/docx JD) — used by RoleNew.jsx
mountOptional('/roles', [requireAuth], './routes/rolesUpload');

// Private file signer (transcripts/analysis) used by Candidates page
mountOptional('/files', [requireAuth], './routes/files');

// Reports (generate/download)
mountOptional('/reports', [requireAuth], './routes/reports');

// Dashboard (legacy-compatible endpoint powering Candidates page)
mountOptional('/dashboard', [requireAuth], './routes/dashboard');

// Tavus webhook (unauthenticated, signature handled inside the route)
mountOptional('/webhook/tavus', [], './routes/webhookTavus');

// Root
app.get('/', (_req, res) => res.json({ ok: true }));

// ----- Start -----
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`⚙️  backend listening on :${PORT}`);
});

module.exports = app;
