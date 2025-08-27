// app.js
require('dotenv').config();

const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const path = require('path');

/* ------------------------------------------------------------------------- */
/* Auth middleware (your repo stores it under src/middleware/auth.js)        */
/* ------------------------------------------------------------------------- */
const { requireAuth: auth, withClientScope, supabase } = require('./src/middleware/auth');

/* ------------------------------------------------------------------------- */
/* Env & constants                                                           */
/* ------------------------------------------------------------------------- */

const PORT = process.env.PORT || 10000;

const buckets = {
  reports: process.env.SUPABASE_REPORTS_BUCKET || 'reports',
  kbs: process.env.SUPABASE_KB_BUCKET || 'kbs',
};

// Build CORS allowlist safely
const corsOriginsRaw = typeof process.env.CORS_ORIGINS === 'string'
  ? process.env.CORS_ORIGINS
  : '';

const frontendUrlArr = process.env.FRONTEND_URL
  ? [String(process.env.FRONTEND_URL).trim()]
  : [];

const allowedOrigins = Array.from(new Set(
  corsOriginsRaw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .concat(frontendUrlArr)
));

/* ------------------------------------------------------------------------- */
/* App init                                                                  */
/* ------------------------------------------------------------------------- */

const app = express();

app.use(
  cors({
    origin: (origin, cb) => {
      // permissive if no allowlist or '*' present
      if (!allowedOrigins.length || allowedOrigins.includes('*')) return cb(null, true);
      // same-origin / curl / webviews
      if (!origin) return cb(null, true);
      return cb(null, allowedOrigins.includes(origin));
    },
    credentials: true,
  })
);

app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Robust require that lets Node resolve extensions.
 * - Tries requiring the resolved absolute path as-is.
 * - If that fails, tries appending ".js".
 * - Returns null with a warning if it still fails.
 */
function safeRequire(relPath) {
  const abs = path.resolve(__dirname, relPath);
  try {
    // Let Node do normal resolution (it will add .js, .json, etc.)
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const mod = require(abs);
    return mod && mod.__esModule ? (mod.default || mod) : mod;
  } catch (e1) {
    try {
      // Try with explicit .js for environments where resolution differs
      // eslint-disable-next-line import/no-dynamic-require, global-require
      const mod2 = require(abs + '.js');
      return mod2 && mod2.__esModule ? (mod2.default || mod2) : mod2;
    } catch (e2) {
      console.warn(`[require] Not found or failed: ${relPath} (${e2.message})`);
      return null;
    }
  }
}

/**
 * mountRouter supports:
 *  - module.exports = (ctx) => router
 *  - module.exports = router
 *  - module.exports = { router }
 */
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

/* ------------------------------------------------------------------------- */
/* Health + Root auth                                                        */
/* ------------------------------------------------------------------------- */

app.get('/', (_req, res) => res.send('ok'));

// FE calls this on boot; also returns client scope summary
app.get('/auth/me', auth, withClientScope, (req, res) => {
  try {
    const { user, memberships, defaultClientId } = req.clientScope || {};
    if (!user?.id) return res.status(401).json({ error: 'unauthorized' });

    const clients = (memberships || []).map(m => ({
      id: m.client_id,
      role: m.role,
      name: m.name || null,
    }));

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

/* ------------------------------------------------------------------------- */
/* Routers (matches your repo)                                               */
/* ------------------------------------------------------------------------- */

const ctx = { supabase, auth, withClientScope, buckets };

mountRouter('/clients',         safeRequire('./routes/clients'), ctx);
mountRouter('/roles',           safeRequire('./routes/roles'), ctx);
mountRouter('/dashboard',       safeRequire('./routes/dashboard'), ctx);
mountRouter('/candidates',      safeRequire('./routes/candidates'), ctx);
mountRouter('/reports',         safeRequire('./routes/reports'), ctx);
mountRouter('/kb',              safeRequire('./routes/kb'), ctx);
mountRouter('/files',           safeRequire('./routes/files'), ctx);
mountRouter('/roles-upload',    safeRequire('./routes/rolesUpload'), ctx);
mountRouter('/webhook',         safeRequire('./routes/webhook'), ctx);
mountRouter('/webhooks/stripe', safeRequire('./routes/webhookStripe'), ctx);
mountRouter('/interviews',      safeRequire('./routes/createTavusInterview'), ctx);
mountRouter('/interviews/retry',safeRequire('./routes/retryInterview'), ctx);
mountRouter('/verify-otp',      safeRequire('./routes/verifyOtp'), ctx);

/* ------------------------------------------------------------------------- */
/* Error handler (last)                                                      */
/* ------------------------------------------------------------------------- */

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Server error' });
});

/* ------------------------------------------------------------------------- */
/* Start                                                                     */
/* ------------------------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(`api listening on :${PORT}`);
  console.log(`[cors] allowed origins: ${allowedOrigins.length ? allowedOrigins.join(', ') : '(permissive)'}`);
});
