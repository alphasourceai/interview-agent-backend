// app.js
// Express bootstrap for Interview Agent backend

require('dotenv').config();

const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// Use the shared auth + supabase from middleware/auth.js
// (This file should export: { requireAuth: auth, withClientScope, supabase })
const { requireAuth: auth, withClientScope, supabase } = require('./middleware/auth');

// ---------------------------------------------------------------------------
// Env / constants
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 10000;

// Buckets used by routes that handle uploads/downloads
const buckets = {
  reports: process.env.SUPABASE_REPORTS_BUCKET || 'reports',
  kbs: process.env.SUPABASE_KB_BUCKET || 'kbs',
};

// Compute allowed CORS origins from env
const allowedOrigins = (() => {
  const fromEnv = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const fe = process.env.FRONTEND_URL ? [process.env.FRONTEND_URL.trim()] : [];
  const uniq = Array.from(new Set([...fromEnv, ...fe]));
  return uniq.length ? uniq : ['*'];
})();

// ---------------------------------------------------------------------------
// App init
// ---------------------------------------------------------------------------

const app = express();

app.use(
  cors({
    origin: (origin, cb) => {
      if (!allowedOrigins.length || allowedOrigins.includes('*')) return cb(null, true);
      if (!origin) return cb(null, true); // same-origin / curl / mobile webview
      return cb(null, allowedOrigins.includes(origin));
    },
    credentials: true,
  })
);

app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
/**
 * Safe loader for route modules.
 * Supports:
 *  - module.exports = router
 *  - module.exports = (ctx) => router (factory)
 *  - module.exports = { router }
 */
function safeRequire(relPath) {
  const full = path.resolve(__dirname, relPath);
  try {
    if (!fs.existsSync(full)) {
      console.warn(`[require] Not found: ${relPath}`);
      return null;
    }
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const mod = require(full);
    return mod && mod.__esModule ? mod.default || mod : mod;
  } catch (e) {
    console.error(`[require] Failed to load ${relPath}`, e);
    return null;
  }
}

function mountRouter(basePath, mod, ctx = {}) {
  if (!mod) {
    console.warn(`[mount] Skipped ${basePath}: module missing`);
    return;
  }
  let router = null;

  if (typeof mod === 'function') {
    try {
      router = mod(ctx);
    } catch (e) {
      console.error(`[mount] Factory threw for ${basePath}`, e);
    }
  } else if (mod.router) {
    router = mod.router;
  } else {
    router = mod;
  }

  if (!router || typeof router !== 'function') {
    console.error(`[mount] Invalid router for ${basePath}`);
    return;
  }

  app.use(basePath, router);
  console.log(`[mount] ${basePath}`);
}
// ---------------------------------------------------------------------------

// Health probe
app.get('/', (_req, res) => res.send('ok'));

// Root auth endpoint used by FE on boot; also returns client scope summary
app.get('/auth/me', auth, withClientScope, (req, res) => {
  try {
    const { user, memberships, defaultClientId } = req.clientScope || {};
    if (!user?.id) return res.status(401).json({ error: 'unauthorized' });

    const clients =
      (memberships || []).map(m => ({
        id: m.client_id,
        role: m.role,
        name: m.name || null,
      })) || [];

    return res.json({
      user: { id: user.id, email: user.email || null },
      clients,
      defaultClientId: defaultClientId || (clients[0] && clients[0].id) || null,
    });
  } catch (err) {
    console.error('[auth/me]', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ---------------------------------------------------------------------------
// Routers (factory-style where applicable). Each will be passed ctx:
// { supabase, auth, withClientScope, buckets }
// ---------------------------------------------------------------------------

const ctx = { supabase, auth, withClientScope, buckets };

// Clients (expects /clients/my, etc.)
mountRouter('/clients', safeRequire('./routes/clients'), ctx);

// Roles (list/create, upload-jd, etc.)
mountRouter('/roles', safeRequire('./routes/roles'), ctx);

// Candidates & dashboard
mountRouter('/dashboard', safeRequire('./routes/dashboard'), ctx);
mountRouter('/candidates', safeRequire('./routes/candidates'), ctx);

// Reports (signed URL downloads / stream fallback)
mountRouter('/reports', safeRequire('./routes/reports'), ctx);

// Knowledge base & uploads (if present)
mountRouter('/kb', safeRequire('./routes/kb'), ctx);
mountRouter('/files', safeRequire('./routes/files'), ctx);
mountRouter('/roles-upload', safeRequire('./routes/rolesUpload'), ctx);

// Tavus / webhooks / misc
mountRouter('/webhook', safeRequire('./routes/webhook'), ctx);
mountRouter('/webhooks/stripe', safeRequire('./routes/webhookStripe'), ctx);
mountRouter('/interviews', safeRequire('./routes/createTavusInterview'), ctx);
mountRouter('/interviews/retry', safeRequire('./routes/retryInterview'), ctx);

// Public auth helpers
mountRouter('/verify-otp', safeRequire('./routes/verifyOtp'), ctx);

// ---------------------------------------------------------------------------
// Error handler (last)
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Server error' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`api listening on :${PORT}`);
  console.log(`[cors] allowed origins: ${allowedOrigins.join(', ')}`);
});
