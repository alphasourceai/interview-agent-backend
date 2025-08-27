// app.js
// Express bootstrap for Interview Agent backend

require('dotenv').config();

const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// --- Env + clients ----------------------------------------------------------

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  // Log but do not crash; allow container to boot with 5xx for protected routes
  console.warn('[boot] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// CORS allow-list (comma separated)
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// --- App init ---------------------------------------------------------------

const app = express();

app.use(
  cors({
    origin: (origin, cb) => {
      if (!allowedOrigins.length) return cb(null, true);
      if (!origin) return cb(null, true); // same-origin / curl
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(null, false);
    },
    credentials: true,
  })
);

app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// --- Helpers: safeRequire + mountRouter ------------------------------------

function safeRequire(relPath) {
  const full = path.resolve(__dirname, relPath);
  try {
    if (!fs.existsSync(full)) {
      console.error(`[require] Not found: ${relPath}`);
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

/**
 * Supports:
 * - module.exports = router
 * - module.exports = (ctx) => router
 * - module.exports = { router }
 */
function mountRouter(basePath, mod, ctx = {}) {
  if (!mod) {
    console.warn(`[mount] Skipped ${basePath}: module missing`);
    return;
  }
  let router = null;

  if (typeof mod === 'function') {
    // factory style
    try {
      router = mod(ctx) || mod;
    } catch (e) {
      console.error(`[mount] Factory threw for ${basePath}`, e);
    }
  }

  if (!router && mod.router) {
    router = mod.router;
  }

  // If it still isn't a router, assume the module IS the router
  router = router || mod;

  if (!router || typeof router !== 'function') {
    console.error(`[mount] Invalid router for ${basePath}`);
    return;
  }

  app.use(basePath, router);
  console.log(`[mount] ${basePath}`);
}

// --- Root auth endpoint (stable for FE) ------------------------------------

const { requireAuth } = safeRequire('./middleware/auth') || {};

// Keep /auth/me at ROOT so FE calls like GET /auth/me continue to work.
if (requireAuth) {
  app.get('/auth/me', requireAuth, (req, res) => {
    res.json({ user: { id: req.user?.id || null, email: req.user?.email || null } });
  });
} else {
  console.warn('[boot] middleware/auth not found; /auth/me will not be protected');
  app.get('/auth/me', (_req, res) => res.status(500).json({ error: 'auth middleware missing' }));
}

// --- Routers ---------------------------------------------------------------
// These files should exist based on the earlier drop-ins:
//   ./routes/clients.js   (GET /clients/my + resilient membership select)
//   ./routes/roles.js     (JD upload+parse, role list/create)
//   ./routes/reports.js   (signed URL redirect / stream fallback)

mountRouter('/clients', safeRequire('./routes/clients'), { supabase });
mountRouter('/roles', safeRequire('./routes/roles'), { supabase });
mountRouter('/reports', safeRequire('./routes/reports'), { supabase });

// Stripe webhook (keep if you already have it)
mountRouter('/webhooks/stripe', safeRequire('./routes/webhookStripe'), { supabase });

// Health check
app.get('/', (_req, res) => res.send('ok'));

// --- Error handler (last) --------------------------------------------------

/* eslint-disable no-unused-vars */
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Server error' });
});
/* eslint-enable no-unused-vars */

// --- Start ------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`api listening on :${PORT}`);
  console.log(`[cors] allowed origins: ${allowedOrigins.length ? allowedOrigins.join(', ') : '(permissive)'}`);
});
