// app.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');

let morgan = null;
try { morgan = require('morgan'); } catch { /* optional */ }

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const app = express();

// ---- middleware
const corsOrigins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || corsOrigins.length === 0 || corsOrigins.includes(origin)) return cb(null, true);
    return cb(null, true); // be permissive for now to avoid CORS surprises
  },
  credentials: true
}));

if (morgan) app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Small helper to read Bearer token
function getBearer(req) {
  const h = req.headers.authorization || '';
  const [, token] = h.split(' ');
  return token || null;
}

// Verify Supabase session token and attach req.user
async function requireAuth(req, res, next) {
  try {
    const token = getBearer(req);
    if (!token) return res.status(401).json({ error: 'No auth token' });
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid auth' });
    req.user = data.user;
    next();
  } catch (e) {
    console.error('[requireAuth] error', e);
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// Populate req.clientIds and (optionally) enforce client_id param
async function withClientScope(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    // Find all client_ids this user belongs to
    const { data, error } = await supabaseAdmin
      .from('client_members')
      .select('client_id, role')
      .eq('user_id_uuid', req.user.id);

    if (error) {
      console.error('[withClientScope] supabase error', error);
      return res.status(500).json({ error: 'scope lookup failed' });
    }

    const clientIds = (data || []).map(r => r.client_id);
    req.client_memberships = data || [];
    req.clientIds = clientIds;

    // If a client_id query param is provided, ensure it’s in scope
    const qClient = req.query.client_id;
    if (qClient && !clientIds.includes(qClient)) {
      return res.status(403).json({ error: 'No client scope' });
    }

    next();
  } catch (e) {
    console.error('[withClientScope] error', e);
    res.status(500).json({ error: 'scope error' });
  }
}

// Convenience: expose memberships to downstream handlers expecting locals
function injectClientMemberships(req, _res, next) {
  req._role_scope_ids = req.clientIds || [];
  next();
}

// ---- health/auth probes
app.get('/auth/ping', (req, res) => res.json({ ok: true }));
app.get('/auth/me', requireAuth, withClientScope, (req, res) => {
  res.json({
    user: { id: req.user.id, email: req.user.email },
    client_memberships: req.client_memberships
  });
});

// ---- Routers (existing ones)
function safeMount(path, router) {
  if (router) app.use(path, requireAuth, withClientScope, injectClientMemberships, router);
}

// Keep these requires guarded to avoid “module not found” crashes on older branches
let clientsRouter=null, rolesRouter=null, filesRouter=null, reportsRouter=null;
try { clientsRouter = require('./routes/clients'); } catch {}
try { rolesRouter   = require('./routes/roles'); } catch {}
try { filesRouter   = require('./routes/files'); } catch {}
try { reportsRouter = require('./routes/reports'); } catch {}

safeMount('/clients',  clientsRouter);
safeMount('/roles',    rolesRouter);
safeMount('/files',    filesRouter);
safeMount('/reports',  reportsRouter);

// ---- Dashboard routes (restores legacy endpoints FE calls)
const dashboardRouter = require('./routes/dashboard');
app.use('/dashboard', requireAuth, withClientScope, dashboardRouter);

// ---- root
app.get('/', (_req, res) => res.json({ ok: true }));

// ---- error fallback
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'server error' });
});

// ---- start
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`api listening on :${PORT}`));
