// app.js
// Express bootstrap for Interview Agent backend

require('dotenv').config();

const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// --- Env + clients ----------------------------------------------------------

const PORT = process.env.PORT || 10000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// Buckets used by routes (keep names you already rely on)
const buckets = {
  reports: process.env.SUPABASE_REPORTS_BUCKET || 'reports',
  kbs: process.env.SUPABASE_KB_BUCKET || 'kbs',
};

// CORS: allow explicit list and FRONTEND_URL
const corsOriginsRaw = String(process.env.CORS_ORIGINS || '').trim();
const extra = process.env.FRONTEND_URL ? [String(process.env.FRONTEND_URL).trim()] : [];
const allowedOrigins = Array.from(
  new Set(
    corsOriginsRaw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .concat(extra)
  )
);

// --- App + middleware -------------------------------------------------------

const app = express();

app.use(
  cors({
    origin: (origin, cb) => {
      if (!allowedOrigins.length || allowedOrigins.includes('*')) return cb(null, true);
      if (!origin) return cb(null, true);
      return cb(null, allowedOrigins.includes(origin));
    },
    credentials: true,
  })
);
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// --- Helpers: safeRequire + mountRouter ------------------------------------

function safeRequire(relPath) {
  const abs = path.resolve(__dirname, relPath);
  try {
    // Let Node resolve extensions/index automatically
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const mod = require(abs);
    return mod && mod.__esModule ? mod.default || mod : mod;
  } catch (err1) {
    try {
      // Fallback for .js explicit
      // eslint-disable-next-line import/no-dynamic-require, global-require
      const mod2 = require(abs + '.js');
      return mod2 && mod2.__esModule ? mod2.default || mod2 : mod2;
    } catch (err2) {
      console.warn(`[require] Not found or failed: ${relPath} (${err2.message})`);
      return null;
    }
  }
}

function isExpressRouter(x) {
  return typeof x === 'function' && x.use && x.handle;
}

function mountRouter(basePath, mod, deps) {
  if (!mod) {
    console.warn(`[mount] Skipped ${basePath}: module missing`);
    return;
  }

  let router = null;

  if (typeof mod === 'function') {
    if (isExpressRouter(mod)) {
      // Already a router instance (callable) — do NOT call it
      router = mod;
    } else {
      // Factory: call with deps to get the router
      try {
        router = mod(deps || {});
      } catch (e) {
        console.error(`[mount] Factory threw for ${basePath}`, e);
        return;
      }
    }
  } else if (mod && isExpressRouter(mod.router)) {
    router = mod.router;
  }

  if (!router || !isExpressRouter(router)) {
    console.error(`[mount] Invalid router for ${basePath}`);
    return;
  }

  app.use(basePath, router);
  console.log(`[mount] ${basePath}`);
}

// pull auth/withClientScope from your middleware
const authMod = safeRequire('./src/middleware/auth');
const requireAuth = authMod?.requireAuth || authMod?.auth || authMod?.default?.requireAuth;
const withClientScope = authMod?.withClientScope || authMod?.default?.withClientScope;

const deps = { supabase, auth: requireAuth, withClientScope, buckets };

// --- Mount routes -----------------------------------------------------------

// Note: we can mount factory-style OR plain-router exports safely now.
mountRouter('/clients', safeRequire('./routes/clients'), deps);
mountRouter('/roles', safeRequire('./routes/roles'), deps);
mountRouter('/dashboard', safeRequire('./routes/dashboard'), deps);
mountRouter('/candidates', safeRequire('./routes/candidates'), deps);
mountRouter('/candidate-submit', safeRequire('./routes/candidateSubmit'), deps);
mountRouter('/reports', safeRequire('./routes/reports'), deps);
mountRouter('/kb', safeRequire('./routes/kb'), deps);
mountRouter('/files', safeRequire('./routes/files'), deps);
mountRouter('/roles-upload', safeRequire('./routes/rolesUpload'), deps);
mountRouter('/webhook', safeRequire('./routes/webhook'), deps);
mountRouter('/webhooks/stripe', safeRequire('./routes/webhookStripe'), { supabase });
mountRouter('/interviews', safeRequire('./routes/createTavusInterview'), deps);
mountRouter('/interviews/retry', safeRequire('./routes/retryInterview'), deps);
mountRouter('/verify-otp', safeRequire('./routes/verifyOtp'), deps);

// Health check
app.get('/', (_req, res) => res.send('ok'));

// --- Start ------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`api listening on :${PORT}`);
  console.log(`[cors] allowed origins: ${allowedOrigins.length ? allowedOrigins.join(', ') : '(permissive)'}`);
});
