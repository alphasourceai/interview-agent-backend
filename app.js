// app.js (drop-in)
require('dotenv').config()

// --- Sentry MUST be initialized before requiring Express to instrument it ---
const Sentry = require('@sentry/node');
const { nodeProfilingIntegration } = require('@sentry/profiling-node');
const SENTRY_ENABLED = process.env.SENTRY_ENABLED === '1' && !!process.env.SENTRY_DSN;
if (SENTRY_ENABLED) {
  const integrations = [];
  try { if (typeof Sentry.httpIntegration === 'function') integrations.push(Sentry.httpIntegration()); } catch {}
  try { if (typeof Sentry.expressIntegration === 'function') integrations.push(Sentry.expressIntegration()); } catch {}
  try { if (typeof nodeProfilingIntegration === 'function') integrations.push(nodeProfilingIntegration()); } catch {}
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENV || process.env.NODE_ENV || 'production',
    release: process.env.RENDER_GIT_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || undefined,
    integrations,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.05),
    profilesSampleRate: Number(process.env.SENTRY_PROFILES_SAMPLE_RATE ?? 0.0),
    beforeSend(event) {
      try {
        if (event.request?.headers) {
          delete event.request.headers['authorization'];
          delete event.request.headers['cookie'];
        }
        const scrub = (s) =>
          typeof s === 'string'
            ? s
                .replace(/[^@\s]+@[^@\s]+\.[^@\s]+/g, '***@***')
                .replace(/(X-Amz-Signature|Signature)=[^&]+/g, '$1=REDACTED')
                .replace(/(Authorization|Bearer)\s+[A-Za-z0-9\-\._~\+\/]+=*/gi, '$1 REDACTED')
            : s;
        if (event.request?.url) event.request.url = scrub(event.request.url);
        if (event.extra) {
          for (const k of Object.keys(event.extra)) {
            if (typeof event.extra[k] === 'string') event.extra[k] = scrub(event.extra[k]);
          }
        }
      } catch (_) {}
      return event;
    },
  });
}

// Now import Express and other modules
const express = require('express')
const cors = require('cors')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { URLSearchParams } = require('url')
const {
  isDuplicateAuthError,
  isDuplicateDbError,
  isRlsViolationError,
  DUPLICATE_MEMBER_RESPONSE
} = require('./src/lib/clientMemberErrors')
const { supabaseAnon, supabaseAdmin } = require('./src/lib/supabaseClient')
const { generateRubricAndKBForRole } = require('./generateRubric')
const axios = require('axios')

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'
const FRONTEND_BASE = (process.env.FRONTEND_BASE || process.env.FRONTEND_URL || FRONTEND_URL || '').replace(/\/+$/, '')
const AUTH_EMAIL_HMAC_SECRET = process.env.AUTH_EMAIL_HMAC_SECRET || ''
const PASSWORD_START_TTL_SECONDS = 15 * 60
const PASSWORD_START_RATE_WINDOW_MS = 10 * 60 * 1000
const PASSWORD_START_RATE_MAX = 5
const passwordStartRateMap = new Map()
/**
 * Environment-aware auth redirect resolver
 * - Honors REDIRECT_BASE_URL or AUTH_REDIRECT_BASE if set
 * - Infers QA/Staging/Prod from SENTRY_ENV, FRONTEND_URL, or Render service hints
 * - Defaults to localhost in dev and www.alphasourceai.com in production
 */
function _inferEnvBase(env = process.env, fallbackFrontend = FRONTEND_URL) {
  const read = (key) => {
    const value = env?.[key];
    return typeof value === 'string' ? value : '';
  };

  const explicitSrc = `${read('REDIRECT_BASE_URL') || read('AUTH_REDIRECT_BASE')}`.trim();
  if (explicitSrc) return explicitSrc.replace(/\/+$/, '');

  // Prefer SENTRY_ENV hints when present
  const sentry = read('SENTRY_ENV').toLowerCase();
  if (sentry.includes('qa')) return 'https://ia-frontend-qa.onrender.com';
  if (sentry.includes('stag')) return 'https://ia-frontend-staging.onrender.com';

  const svc = (read('RENDER_SERVICE_NAME') || read('RENDER_EXTERNAL_URL')).toLowerCase();
  const feCandidate = (read('FRONTEND_BASE') || read('FRONTEND_URL') || fallbackFrontend || '').toLowerCase();

  // Prefer explicit FE env URLs if present
  if (feCandidate.includes('qa')) return 'https://ia-frontend-qa.onrender.com';
  if (feCandidate.includes('staging')) return 'https://ia-frontend-staging.onrender.com';
  if (feCandidate.includes('prod') || feCandidate.includes('alphasourceai.com')) return 'https://www.alphasourceai.com';

  // Fallback to Render service name hints
  if (svc.includes('-qa')) return 'https://ia-frontend-qa.onrender.com';
  if (svc.includes('-staging')) return 'https://ia-frontend-staging.onrender.com';
  if (svc.includes('-prod')) return 'https://www.alphasourceai.com';

  const nodeEnv = (read('NODE_ENV') || process.env.NODE_ENV || '').toLowerCase();

  // Local/dev default
  return nodeEnv === 'production'
    ? 'https://www.alphasourceai.com'
    : 'http://localhost:5173';
}
function authRedirect(mode, env) {
  const base = _inferEnvBase(env).replace(/\/+$/, '');
  if (mode === 'recovery') return `${base}/set-password?mode=recovery&password_reset=1`;
  if (mode === 'signup') return `${base}/set-password?mode=signup`;
  return `${base}/account?auth_callback=1`;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function computeEmailHmac(email, ts) {
  if (!AUTH_EMAIL_HMAC_SECRET) return null;
  const normalizedEmail = normalizeEmail(email);
  const tsPart = ts ? String(ts).trim() : '';
  if (!normalizedEmail || !tsPart) return null;
  try {
    return crypto
      .createHmac('sha256', AUTH_EMAIL_HMAC_SECRET)
      .update(`${normalizedEmail}:${tsPart}`)
      .digest('hex');
  } catch (err) {
    console.error('[email_hmac] compute failed', err?.message || err);
    return null;
  }
}

function verifyEmailHmac(email, signature, ts) {
  if (!AUTH_EMAIL_HMAC_SECRET) return false;
  const expected = computeEmailHmac(email, ts);
  if (!expected) return false;
  const provided = String(signature || '').trim().toLowerCase();
  if (!provided || provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch {
    return false;
  }
}

function buildPasswordStartUrl(email, env) {
  const base = _inferEnvBase(env).replace(/\/+$/, '');
  const normalizedEmail = normalizeEmail(email);
  const ts = Math.floor(Date.now() / 1000);
  const sig = computeEmailHmac(normalizedEmail, ts);
  if (!sig) return null;
  const qs = new URLSearchParams({ e: normalizedEmail, sig, ts }).toString();
  return `${base}/password-start?${qs}`;
}

function buildRecoveryRedirect(env) {
  return `${_inferEnvBase(env).replace(/\/+$/, '')}/set-password?mode=recovery&password_reset=1`;
}

function cleanupRateEntries(entries, windowStart) {
  return entries.filter(ts => ts >= windowStart);
}

function rateLimitKey(email, ip) {
  return `${normalizeEmail(email)}::${ip || 'unknown'}`;
}

function isPasswordStartRateLimited(email, ip) {
  const now = Date.now();
  const windowStart = now - PASSWORD_START_RATE_WINDOW_MS;
  const key = rateLimitKey(email, ip);
  const existing = passwordStartRateMap.get(key) || [];
  const recent = cleanupRateEntries(existing, windowStart);
  if (recent.length >= PASSWORD_START_RATE_MAX) {
    passwordStartRateMap.set(key, recent);
    return true;
  }
  recent.push(now);
  passwordStartRateMap.set(key, recent);
  return false;
}

const SHOULD_RUN_REDIRECT_TESTS =
  process.argv.some(arg => /app\.reset\.redirect\.test\.js$/.test(arg)) ||
  process.env.RUN_REDIRECT_TESTS === '1';

if (SHOULD_RUN_REDIRECT_TESTS) {
  const { describe, test } = require('node:test');
  const assert = require('node:assert/strict');

  const buildEnv = (overrides = {}) => ({
    NODE_ENV: 'development',
    ...overrides,
  });

  describe('authRedirect resolver', () => {
    test('prefers explicit redirect base URL', () => {
      const env = buildEnv({ REDIRECT_BASE_URL: 'https://custom.example/base/' });
      assert.equal(_inferEnvBase(env), 'https://custom.example/base');
      assert.equal(authRedirect('recovery', env), 'https://custom.example/base/set-password?mode=recovery&password_reset=1');
      assert.equal(authRedirect('signup', env), 'https://custom.example/base/set-password?mode=signup');
    });

    test('falls back to AUTH_REDIRECT_BASE when REDIRECT_BASE_URL is absent', () => {
      const env = buildEnv({ AUTH_REDIRECT_BASE: 'https://alt.example/auth' });
      assert.equal(authRedirect('magic', env), 'https://alt.example/auth/account?auth_callback=1');
    });

    test('uses SENTRY_ENV hints for QA/Staging', () => {
      const qaEnv = buildEnv({ SENTRY_ENV: 'qa-fleet' });
      assert.equal(_inferEnvBase(qaEnv), 'https://ia-frontend-qa.onrender.com');

      const stagEnv = buildEnv({ SENTRY_ENV: 'staging-run' });
      assert.equal(_inferEnvBase(stagEnv), 'https://ia-frontend-staging.onrender.com');
    });

    test('infers from FRONTEND_URL when set', () => {
      const env = buildEnv({ FRONTEND_URL: 'https://www.alphasourceai.com/app' });
      assert.equal(_inferEnvBase(env), 'https://www.alphasourceai.com');
    });

    test('falls back to Render service hints', () => {
      const env = buildEnv({ RENDER_SERVICE_NAME: 'worker-qa' });
      assert.equal(_inferEnvBase(env), 'https://ia-frontend-qa.onrender.com');
    });

    test('defaults to localhost in development and prod base in production', () => {
      const devEnv = buildEnv();
      assert.equal(_inferEnvBase(devEnv), 'http://localhost:5173');

      const prodEnv = buildEnv({ NODE_ENV: 'production' });
      assert.equal(_inferEnvBase(prodEnv), 'https://www.alphasourceai.com');
    });
  });
}
const app = express()

// Sentry request middleware (must be before other app.use and routes)
if (SENTRY_ENABLED) {
  if (typeof Sentry.expressRequestMiddleware === 'function') {
    app.use(Sentry.expressRequestMiddleware()); // v8+
  } else if (Sentry.Handlers && typeof Sentry.Handlers.requestHandler === 'function') {
    app.use(Sentry.Handlers.requestHandler()); // v7
  }
}

// ---------- CORS ----------
const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'https://interview-agent-frontend.onrender.com',
  'https://ia-frontend-prod.onrender.com',
  'https://ia-frontend-qa.onrender.com',
  'https://ia-frontend-staging.onrender.com',
  'https://www.alphasourceai.com',
  'https://alphasourceai.com',
  'https://www-alphasourceai-com.filesusr.com',
  'https://editor.wix.com',
]
const envOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

const ALLOWLIST = Array.from(new Set([
  ...DEFAULT_ORIGINS,
  FRONTEND_URL.replace(/\/+$/, ''),
  ...envOrigins
].filter(Boolean)))

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl / same-origin
    if (ALLOWLIST.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Authorization',
    'Content-Type',
    'X-Requested-With',
    'apikey',
    'x-client-info',
    'Prefer',
    'Range',
    'Accept'
  ],
  exposedHeaders: ['Content-Range', 'Range-Unit']
}))

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ limit: '2mb', extended: false }))

// ---------- CSP: allow Wix to embed (frame-ancestors) ----------
app.use((req, res, next) => {
  try {
    res.setHeader(
      'Content-Security-Policy',
      'frame-ancestors https://www.alphasourceai.com https://alphasourceai.com https://*.wixsite.com https://*.filesusr.com;'
    );
    res.removeHeader && res.removeHeader('X-Frame-Options');
  } catch (_) {}
  next();
});
// ---------- Permissions-Policy: allow Tavus (daily.co) to access camera/mic in nested iframes ----------
app.use((req, res, next) => {
  try {
    res.setHeader(
      'Permissions-Policy',
      'camera=(self "https://tavus.daily.co" "https://c.daily.co"), microphone=(self "https://tavus.daily.co" "https://c.daily.co"), display-capture=(self "https://tavus.daily.co" "https://c.daily.co"), fullscreen=(self "https://tavus.daily.co" "https://c.daily.co"), autoplay=(self "https://tavus.daily.co" "https://c.daily.co"), clipboard-read=(self), clipboard-write=(self)'
    );
  } catch (_) {}
  next();
});

// Per-request context (request_id + basic tags)
app.use((req, _res, next) => {
  try {
    const rid = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
    req.request_id = rid;
    if (Sentry?.getCurrentScope) {
      Sentry.setTag('request_id', rid);
      if (req.user?.id) Sentry.setUser({ id: req.user.id, email: req.user.email || undefined });
    }
  } catch (_) {}
  next();
});

// ---------- small util ----------
function bearer(req) {
  const h = req.headers['authorization'] || req.headers['Authorization']
  if (!h) return null
  const m = String(h).match(/^Bearer\s+(.+)$/i)
  return m ? m[1] : null
}

// ---------- auth middlewares ----------
async function requireAuth(req, res, next) {
  try {
    const token = bearer(req)
    if (!token) return res.status(401).json({ error: 'Unauthorized' })
    const { data, error } = await supabaseAnon.auth.getUser(token)
    if (error || !data?.user) return res.status(401).json({ error: 'Unauthorized' })
    req.user = { id: data.user.id, email: data.user.email }
    next()
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
}

// Replace the existing withClientScope with this version
async function withClientScope(req, res, next) {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    // Admins get global scope
    let isAdmin = false;
    try {
      const { data: adm, error: admErr } = await supabaseAdmin
        .from('admins')
        .select('id')
        .eq('email', req.user.email)
        .eq('is_active', true)
        .maybeSingle();
      if (!admErr && adm) isAdmin = true;
    } catch (_) {}

    if (isAdmin) {
      const { data: allClients, error: cErr } = await supabaseAdmin
        .from('clients')
        .select('id');
      if (cErr) return res.status(500).json({ error: 'Failed to load clients', detail: cErr.message });
      req.clientIds = (allClients || []).map(c => c.id);
      req.memberships = (allClients || []).map(c => ({ client_id: c.id, role: 'admin' }));
      req.isAdmin = true;
      return next();
    }

    // Regular users: scope to their memberships
    const { data, error } = await supabaseAdmin
      .from('client_members')
      .select('client_id, role')
      .eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: 'Failed to load memberships', detail: error.message });

    req.clientIds = (data || []).map(r => r.client_id);
    req.memberships = data || [];
    req.isAdmin = false;
    next();
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
}

// ---------- Public candidate endpoints (MOUNTED) ----------
app.use('/api/candidate/submit', require('./routes/candidateSubmit'))
app.use('/api/candidate/verify-otp', require('./routes/verifyOtp'))
app.use('/create-tavus-interview', require('./routes/createTavusInterview'))

// ---------- Simple test endpoint ----------
app.get('/auth/ping', requireAuth, withClientScope, (req, res) => {
  res.json({ ok: true, user: req.user, client_ids: req.clientIds })
})

// ---------- Auth me ----------
app.get('/auth/me', requireAuth, withClientScope, (req, res) => {
  res.json({ user: req.user, memberships: req.memberships })
})

// ---------- Password start (scanner-proof) ----------
app.post('/auth/password-start', async (req, res) => {
  try {
    if (!AUTH_EMAIL_HMAC_SECRET) {
      return res.status(500).json({ error: 'email_hmac_unconfigured' });
    }
    const bodyEmail = req.body?.email || req.body?.e;
    const queryEmail = req.query?.email || req.query?.e;
    const email = normalizeEmail(bodyEmail || queryEmail);
    const sig = String(req.body?.sig || req.query?.sig || '').trim();
    const tsParam = req.body?.ts || req.query?.ts;
    const tsInt = Number(tsParam);
    if (!email || !sig || !tsParam || !Number.isFinite(tsInt)) {
      return res.status(400).json({ error: 'email_signature_timestamp_required' });
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - tsInt > PASSWORD_START_TTL_SECONDS || tsInt - nowSec > 300) {
      return res.status(400).json({ error: 'link_expired' });
    }

    if (!verifyEmailHmac(email, sig, tsInt)) {
      return res.status(400).json({ error: 'invalid_signature' });
    }

    const ip =
      (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      '';

    if (isPasswordStartRateLimited(email, ip)) {
      return res.status(429).json({ error: 'rate_limited' });
    }

    const redirectTo = buildRecoveryRedirect();
    console.info('[password-start] request', { email, redirectTo });

    let actionLink = null;
    try {
      const linkResult = await generateRecoveryLink(email, redirectTo);
      actionLink = linkResult?.actionLink;
      console.info('[password-start] generated recovery link', { email });
    } catch (err) {
      console.error('[password-start] generate link failed', err?.message || err);
      const detail = err?.details?.message || err?.message || 'generate_link_failed';
      return res.status(500).json({ error: 'generate_link_failed', detail });
    }

    if (!actionLink) {
      return res.status(500).json({ error: 'missing_action_link' });
    }

    if (String(req.query?.redirect || '').trim() === '1') {
      res.setHeader('Cache-Control', 'no-store');
      return res.redirect(actionLink);
    }

    res.json({ ok: true, action_link: actionLink });
  } catch (err) {
    console.error('[password-start] unexpected error', err?.message || err);
    res.status(500).json({ error: 'password_start_failed', detail: err?.message || String(err) });
  }
});

// ---------- Clients: my ----------
app.get('/clients/my', requireAuth, withClientScope, async (req, res) => {
  try {
    const ids = req.clientIds || []
    if (ids.length === 0) return res.json({ items: [] })

    const { data: clients, error } = await supabaseAdmin
      .from('clients')
      .select('id, name')
      .in('id', ids)
    if (error) return res.status(500).json({ error: 'Failed to load clients', detail: error.message })

    const roleById = Object.fromEntries((req.memberships || []).map(m => [m.client_id, m.role]))
    const items = (clients || []).map(c => ({
      client_id: c.id,
      name: c.name,
      role: roleById[c.id] || 'member'
    }))
    res.json({ items })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// ---------- Dashboard: scoped rows ----------
async function buildDashboardRows(req, res) {
  try {
    const filterIds = req.clientIds || [];
    if (filterIds.length === 0) return res.json({ items: [] });

    const wantedClientId = req.query.client_id;
    const finalIds = wantedClientId ? filterIds.filter(id => id === wantedClientId) : filterIds;
    if (finalIds.length === 0) return res.json({ items: [] });

    const { data: candRows, error: candErr } = await supabaseAdmin
      .from('candidates')
      .select('id, first_name, last_name, name, email, role_id, client_id, created_at')
      .in('client_id', finalIds)
      .order('created_at', { ascending: false });

    if (candErr) return res.status(500).json({ error: 'Failed to load candidates', detail: candErr.message });

    const candidateIds = Array.from(new Set((candRows || []).map(c => c.id)));
    const roleIds = Array.from(new Set((candRows || []).map(c => c.role_id).filter(Boolean)));

    let rolesById = {};
    if (roleIds.length) {
      const { data: roles, error: roleErr } = await supabaseAdmin
        .from('roles')
        .select('id, title, client_id')
        .in('id', roleIds);
      if (!roleErr && roles) {
        rolesById = Object.fromEntries(
          roles.map(r => [r.id, { id: r.id, title: r.title, client_id: r.client_id }])
        );
      }
    }

    let latestInterviewByCand = {};
    if (candidateIds.length) {
      const { data: ivs, error: intErr } = await supabaseAdmin
        .from('interviews')
        .select('id, candidate_id, client_id, role_id, created_at, video_url, transcript_url, analysis_url')
        .in('candidate_id', candidateIds)
        .in('client_id', finalIds)
        .order('created_at', { ascending: false });

      if (!intErr && ivs) {
        for (const r of ivs) {
          const cid = r.candidate_id;
          if (!latestInterviewByCand[cid]) latestInterviewByCand[cid] = r;
        }
      }
    }

    let bestReportByCand = {};
    if (candidateIds.length) {
      const { data: reps } = await supabaseAdmin
        .from('reports')
        .select(`
          id, candidate_id, role_id,
          resume_score, interview_score, overall_score,
          resume_breakdown, interview_breakdown, analysis,
          report_url, created_at
        `)
        .in('candidate_id', candidateIds)
        .order('created_at', { ascending: false });

      if (reps) {
        for (const rep of reps) {
          const cur = bestReportByCand[rep.candidate_id];
          if (!cur) {
            bestReportByCand[rep.candidate_id] = rep;
          } else {
            const candRole = (candRows.find(c => c.id === rep.candidate_id) || {}).role_id;
            const curMatch = cur?.role_id && candRole && cur.role_id === candRole;
            const newMatch = rep?.role_id && candRole && rep.role_id === candRole;
            if (!curMatch && newMatch) bestReportByCand[rep.candidate_id] = rep;
          }
        }
      }
    }

    const numOrNull = v => (typeof v === 'number' && isFinite(v)) ? v : (v === 0 ? 0 : null);

    const items = (candRows || []).map(c => {
      const fullName =
        c.name ||
        [c.first_name, c.last_name].filter(Boolean).join(' ').trim() ||
        '';

      const role = c.role_id ? (rolesById[c.role_id] || null) : null;
      const latest = latestInterviewByCand[c.id] || null;
      const rep = bestReportByCand[c.id] || null;

      const rb = rep?.resume_breakdown || {};
      const ib = rep?.interview_breakdown || {};

      // Prefer summary from interview_breakdown.summary; fall back to reports.analysis
      const interview_summary =
        (typeof ib.summary === 'string' && ib.summary.trim())
          ? ib.summary.trim()
          : (
              typeof rep?.analysis === 'string'
                ? rep.analysis
                : (typeof rep?.analysis?.summary === 'string' ? rep.analysis.summary : '')
            );

      const resume_analysis = {
        experience: numOrNull(rb.experience_match_percent ?? rb.experience),
        skills:     numOrNull(rb.skills_match_percent ?? rb.skills),
        education:  numOrNull(rb.education_match_percent ?? rb.education),
        summary:    typeof rb.summary === 'string' ? rb.summary : ''
      };

      const interview_analysis = {
        clarity:       numOrNull(ib.clarity),
        confidence:    numOrNull(ib.confidence),
        body_language: numOrNull(ib.body_language),
        summary:       typeof interview_summary === 'string' ? interview_summary : ''
      };

      return {
        id: latest?.id ?? null,
        created_at: c.created_at,
        client_id: c.client_id,

        candidate: { id: c.id, name: fullName, email: c.email || '' },
        role,

        video_url: latest?.video_url || null,
        transcript_url: latest?.transcript_url || null,
        analysis_url: latest?.analysis_url || null,

        has_video: !!latest?.video_url,
        has_transcript: !!latest?.transcript_url,
        has_analysis: !!latest?.analysis_url,

        resume_score:    numOrNull(rep?.resume_score ?? null),
        interview_score: numOrNull(rep?.interview_score ?? null),
        overall_score:   numOrNull(rep?.overall_score ?? null),

        resume_analysis,
        interview_analysis,

        latest_report_url: rep?.report_url ?? null,
        report_generated_at: rep?.created_at ?? null
      };
    });

    return res.json({ items });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
}

// Existing path (kept for compatibility)
app.get('/dashboard/interviews', requireAuth, withClientScope, (req, res) => {
  buildDashboardRows(req, res)
})

// New path used by the FE
app.get('/dashboard/rows', requireAuth, withClientScope, (req, res) => {
  buildDashboardRows(req, res)
})

// ---------- Optional: invites ----------
app.post('/clients/invite', requireAuth, withClientScope, async (req, res) => {
  try {
    const { email, role = 'member', client_id } = req.body || {}
    if (!email || !client_id) return res.status(400).json({ error: 'email and client_id are required' })
    if (!(req.clientIds || []).includes(client_id)) return res.status(403).json({ error: 'Forbidden' })

    const token = crypto.randomBytes(16).toString('hex')
    const { error } = await supabaseAdmin
      .from('client_invites')
      .insert({ client_id, email, role, token, invited_by: req.user.id })
    if (error) return res.status(500).json({ error: 'Failed to create invite', detail: error.message })

    const acceptUrlBase = (process.env.FRONTEND_URL || FRONTEND_URL).replace(/\/+$/, '')
    const accept_url = `${acceptUrlBase}/accept-invite?token=${encodeURIComponent(token)}`
    res.json({ ok: true, accept_url })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/clients/accept-invite', requireAuth, async (req, res) => {
  try {
    const { token } = req.body || {}
    if (!token) return res.status(400).json({ error: 'token is required' })

    const { data: invite, error: invErr } = await supabaseAdmin
      .from('client_invites')
      .select('client_id, email, role')
      .eq('token', token)
      .single()
    if (invErr || !invite) return res.status(400).json({ error: 'Invalid invite', detail: invErr?.message })
    if (invite.email && invite.email !== req.user.email) {
      return res.status(400).json({ error: 'Invite email does not match your account' })
    }

    const { error } = await supabaseAdmin
      .from('client_members')
      .upsert({ client_id: invite.client_id, user_id: req.user.id, role: invite.role }, { onConflict: 'client_id,user_id' })
    if (error) return res.status(500).json({ error: 'Failed to join client', detail: error.message })

    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

/* ========================= Admin guard + Admin API (with JD→Rubric→KB) ========================= */

// Admin-only guard (after requireAuth)
async function requireAdmin(req, res, next) {
  try {
    const email = req.user?.email || null
    if (!email) return res.status(403).json({ error: 'not_admin' })

    const { data: adm, error } = await supabaseAdmin
      .from('admins')
      .select('id,is_active')
      .eq('email', email)
      .eq('is_active', true)
      .maybeSingle()

    if (error) {
      console.error('admin_lookup_failed:', error.message)
      return res.status(500).json({ error: 'admin_lookup_failed', detail: error.message })
    }
    if (!adm) return res.status(403).json({ error: 'not_admin' })
    next()
  } catch (e) {
    return res.status(500).json({ error: 'admin_guard_failed' })
  }
}


const adminRouter = express.Router()

// --- Password reset (Admin-triggered) ---
// Helper: send HTML email via SendGrid
const INLINE_LOGO_PATH = path.join(__dirname, 'assets', 'alpha-logo.png')
let inlineLogoBase64 = undefined

function getInlineLogo() {
  if (inlineLogoBase64 !== undefined) return inlineLogoBase64
  try {
    const file = fs.readFileSync(INLINE_LOGO_PATH)
    inlineLogoBase64 = file.toString('base64')
  } catch (err) {
    console.warn('[sendgrid.inline_logo] unavailable:', err?.message || err)
    inlineLogoBase64 = null
  }
  return inlineLogoBase64
}

async function _sendgridSend({ to, subject, html, attachments = [] }) {
  const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || process.env.SENDGRID_KEY;
  const FROM = process.env.SENDGRID_FROM || process.env.SENDGRID_FROM_EMAIL || 'info@alphasourceai.com';
  if (!SENDGRID_API_KEY) throw new Error('missing SENDGRID_API_KEY');
  if (!FROM) throw new Error('missing SENDGRID_FROM');

  const finalAttachments = Array.isArray(attachments)
    ? attachments.filter(Boolean)
    : [];
  const logo = getInlineLogo();
  if (logo && !finalAttachments.some(att => att?.content_id === 'logo')) {
    finalAttachments.push({
      content: logo,
      filename: 'alpha-logo.png',
      type: 'image/png',
      disposition: 'inline',
      content_id: 'logo'
    });
  }

  const textContent = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const payload = {
    personalizations: [{ to: [{ email: to }] }],
    from: { email: FROM, name: 'alphaSource' },
    subject,
    content: [
      { type: 'text/plain', value: textContent || subject },
      { type: 'text/html', value: html }
    ],
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false }
    }
  };
  if (finalAttachments.length > 0) {
    payload.attachments = finalAttachments;
  }

  await axios.post('https://api.sendgrid.com/v3/mail/send', payload, {
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 10000
  });
}

function renderPasswordStartEmail({ heading, bodyHtml, buttonLabel, link }) {
  return `
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>${heading}</title>
    </head>
    <body style="margin:0;padding:0;background:#0A1547;color:#ffffff;font-family:Arial,Helvetica,sans-serif;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0A1547;">
        <tr>
          <td align="center" style="padding:32px 16px;">
            <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;background:#0A1547;border-radius:8px;">
              <tr>
                <td style="padding:24px 24px 0 24px;" align="left">
                  <img src="cid:logo" alt="alphaSource" width="160" style="display:block;height:auto;border:0;" />
                </td>
              </tr>
              <tr>
                <td style="padding:24px;" align="left">
                  <h1 style="margin:0 0 12px 0;font-size:22px;font-weight:700;line-height:1.3;color:#ffffff;">${heading}</h1>
                  ${bodyHtml}
                  <p style="margin:0 0 28px 0;">
                    <a href="${link}"
                       style="background:#C3B4F3;color:#0A1547;text-decoration:none;font-weight:700;font-size:14px;padding:12px 18px;border-radius:6px;display:inline-block;">
                      ${buttonLabel}
                    </a>
                  </p>
                  <p style="margin:0 0 24px 0;font-size:12px;color:#93a0c6;">
                    Click <a href="${link}" style="color:#C3B4F3;text-decoration:none;font-weight:600;">here</a> if the button doesn't work.
                  </p>
                  <p style="margin:0;font-size:12px;color:#93a0c6;">Questions? Email <a href="mailto:info@alphasourceai.com" style="color:#C3B4F3;">info@alphasourceai.com</a>.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

function _extractActionLink(data) {
  if (!data || typeof data !== 'object') return null;
  return data.action_link || data.properties?.action_link || null;
}

const SUPPORTED_LINK_TYPES = new Set(['recovery', 'signup', 'magiclink', 'invite']);

async function generateAuthLink(type, email, redirectTo) {
  const resolvedType = SUPPORTED_LINK_TYPES.has(type) ? type : 'recovery';
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: resolvedType,
    email,
    options: { redirectTo }
  });

  if (error) {
    const err = new Error(error.message || 'generate_link_failed');
    err.details = error;
    throw err;
  }

  const actionLink = _extractActionLink(data);
  if (!actionLink) {
    const err = new Error('no_action_link');
    err.details = { data };
    throw err;
  }

  return {
    actionLink,
    userId: data?.user?.id || null,
    raw: data
  };
}

async function generateRecoveryLink(email, redirectTo) {
  return generateAuthLink('recovery', email, redirectTo);
}

async function ensureAuthUserId(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return { userId: null, created: false, error: new Error('email_required') };
  }

  async function lookup() {
    if (!supabaseAdmin?.auth?.admin?.getUserByEmail) return { userId: null, error: null };
    try {
      const { data, error } = await supabaseAdmin.auth.admin.getUserByEmail(normalizedEmail);
      if (error) {
        const msg = error?.message || '';
        if (msg && !/user not found/i.test(msg)) {
          console.warn('[ensureAuthUserId] lookup error:', msg);
        }
        return { userId: null, error };
      }
      return { userId: data?.user?.id || null, error: null };
    } catch (err) {
      console.warn('[ensureAuthUserId] lookup exception:', err?.message || err);
      return { userId: null, error: err };
    }
  }

  const firstLookup = await lookup();
  if (firstLookup.userId) {
    return { userId: firstLookup.userId, created: false, error: null };
  }

  const createResp = await supabaseAdmin.auth.admin.createUser({
    email: normalizedEmail,
    email_confirm: true
  });

  if (createResp?.error) {
    if (!isDuplicateAuthError(createResp.error)) {
      console.error('[ensureAuthUserId] createUser failed:', createResp.error?.message || createResp.error);
      return { userId: null, created: false, error: createResp.error };
    }
    const retryLookup = await lookup();
    if (retryLookup.userId) {
      return { userId: retryLookup.userId, created: false, error: null };
    }
    return { userId: null, created: false, error: createResp.error };
  }

  return { userId: createResp?.data?.user?.id || null, created: true, error: null };
}

// POST /admin/users/:userId/reset-password
// Optional body: { email?: string }
adminRouter.post('/users/:userId/reset-password', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!AUTH_EMAIL_HMAC_SECRET) {
      return res.status(500).json({ error: 'email_hmac_unconfigured' });
    }
    const userId = (req.params.userId || '').trim();
    const fallbackEmail = (req.body?.email || '').trim();

    if (!userId && !fallbackEmail) {
      return res.status(400).json({ error: 'user_id_or_email_required' });
    }

    // Look up Supabase user (prefer by id)
    let email = null;
    if (userId && supabaseAdmin?.auth?.admin?.getUserById) {
      try {
        const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
        if (!error && data?.user?.email) email = data.user.email;
      } catch (e) {
        // fall through to fallbackEmail
      }
    }
    if (!email && fallbackEmail) email = fallbackEmail;

    if (!email) {
      return res.status(404).json({ error: 'user_email_not_found' });
    }

    const passwordStartUrl = buildPasswordStartUrl(email);
    if (!passwordStartUrl) {
      return res.status(500).json({ error: 'password_start_url_unavailable' });
    }

    const bodyHtml = `
      <p style="margin:0 0 20px 0;font-size:14px;line-height:1.6;color:#e7eaf6;">
        Click the button below to reset your alphaSource password. This link will expire shortly for security.
      </p>
    `;

    const html = renderPasswordStartEmail({
      heading: 'Reset your password',
      bodyHtml,
      buttonLabel: 'Reset password',
      link: passwordStartUrl
    });

    await _sendgridSend({
      to: email,
      subject: 'Reset your alphaSource password',
      html
    });

    return res.json({ ok: true, email, sent_via: 'sendgrid', mode: 'password_start' });
  } catch (e) {
    console.error('reset_password_admin_failed:', e?.message || e);
    return res.status(500).json({ error: 'reset_password_admin_failed', detail: e?.message || String(e) });
  }
});

// Admin-triggered password reset by email (not userId)
adminRouter.post('/reset-password', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!AUTH_EMAIL_HMAC_SECRET) {
      return res.status(500).json({ error: 'email_hmac_unconfigured' });
    }
    const email = (req.body?.email || '').trim();
    if (!email) return res.status(400).json({ error: 'email_required' });

    const passwordStartUrl = buildPasswordStartUrl(email);
    if (!passwordStartUrl) {
      return res.status(500).json({ error: 'password_start_url_unavailable' });
    }

    const bodyHtml = `
      <p style="margin:0 0 20px 0;font-size:14px;line-height:1.6;color:#e7eaf6;">
        Click the button below to reset your alphaSource password.
      </p>
    `;

    const html = renderPasswordStartEmail({
      heading: 'Reset your password',
      bodyHtml,
      buttonLabel: 'Reset password',
      link: passwordStartUrl
    });

    await _sendgridSend({ to: email, subject: 'Reset your alphaSource password', html });
    return res.json({ ok: true, email, sent_via: 'sendgrid', mode: 'password_start' });
  } catch (e) {
    console.error('reset_password_admin_email_failed:', e?.message || e);
    return res.status(500).json({ error: 'reset_password_admin_failed', detail: e?.message || String(e) });
  }
});

// List all clients
adminRouter.get('/clients', requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id,name,created_at')
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: 'list_clients_failed', detail: error.message })
  res.json({ items: data || [] })
})

// Create client (writes email to satisfy NOT NULL)
adminRouter.post('/clients', requireAuth, requireAdmin, async (req, res) => {
  const name = (req.body?.name || '').trim()
  const adminName  = (req.body?.admin_name  || '').trim()
  const adminEmail = (req.body?.admin_email || '').trim()
  const explicitClientEmail = (req.body?.email || '').trim()
  if (!name) return res.status(400).json({ error: 'name_required' })

  const emailForClient = explicitClientEmail || adminEmail
  if (!emailForClient) {
    return res.status(400).json({ error: 'email_required_for_client' })
  }

  const { data: client, error: cErr } = await supabaseAdmin
    .from('clients')
    .insert({ name, email: emailForClient })
    .select('id,name,created_at')
    .single()
  if (cErr) {
    console.error('create_client_failed:', cErr.message)
    return res.status(500).json({ error: 'create_client_failed', detail: cErr.message, hint: cErr.hint })
  }

  // Optionally seed an admin member
  let seeded_member = null
  if (adminEmail) {
    const { userId, error: seedErr } = await ensureAuthUserId(adminEmail)
    if (!userId) {
      console.error('seed_member_no_user_id', { email: adminEmail, detail: seedErr?.message || seedErr })
    } else {
      const payload = {
        client_id: client.id,
        email: normalizeEmail(adminEmail),
        name: adminName || adminEmail,
        role: 'admin',
        user_id: userId
      }

      const { data: inserted, error: insErr } = await supabaseAdmin
        .from('client_members')
        .upsert(payload, { onConflict: 'client_id,user_id', ignoreDuplicates: true })
        .select('client_id,user_id,email,name,role,created_at')
        .maybeSingle()

      if (insErr) {
        console.error('seed_member_insert_failed:', insErr.message)
      } else if (inserted) {
        seeded_member = { ...inserted, id: inserted.user_id || inserted.email }

        if (AUTH_EMAIL_HMAC_SECRET) {
          try {
            const passwordStartUrl = buildPasswordStartUrl(adminEmail)
            if (!passwordStartUrl) throw new Error('password_start_url_unavailable')
            const bodyHtml = `
              <p style="margin:0 0 20px 0;font-size:14px;line-height:1.6;color:#e7eaf6;">
                Use the button below to create your password and access the alphaSource client workspace.
              </p>
            `
            const inviteHtml = renderPasswordStartEmail({
              heading: 'Set up your alphaSource password',
              bodyHtml,
              buttonLabel: 'Set your password',
              link: passwordStartUrl
            })
            await _sendgridSend({
              to: adminEmail,
              subject: 'Set your alphaSource password',
              html: inviteHtml
            })
          } catch (e) {
            console.error('seed_member_email_failed:', e?.message || e)
          }
        }
      }
    }
  }

  res.json({ item: client, seeded_member })
})

// Delete client
adminRouter.delete('/clients/:id', requireAuth, requireAdmin, async (req, res) => {
  const { error } = await supabaseAdmin.from('clients').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: 'delete_client_failed', detail: error.message })
  res.json({ ok: true })
})

// List roles (optional client filter)
adminRouter.get('/roles', requireAuth, requireAdmin, async (req, res) => {
  const { client_id } = req.query
  let q = supabaseAdmin.from('roles')
    .select('id,title,client_id,slug_or_token,interview_type,job_description_url,description,rubric,kb_document_id,created_at')
    .order('created_at', { ascending: false })
  if (client_id) q = q.eq('client_id', client_id)
  const { data, error } = await q
  if (error) return res.status(500).json({ error: 'list_roles_failed', detail: error.message })
  res.json({ items: data || [] })
})

// Create role (keeps existing rubric+KB generation)
adminRouter.post('/roles', requireAuth, requireAdmin, async (req, res) => {
  const { client_id, title } = req.body || {}
  let { interview_type, job_description_url } = req.body || {}

  if (!client_id || !title || !title.trim()) {
    return res.status(400).json({ error: 'client_id_and_title_required' })
  }
  const IT = String(interview_type || '').toUpperCase()
  const VALID = new Set(['BASIC','DETAILED','TECHNICAL'])
  interview_type = VALID.has(IT) ? IT : null

  const { data: role, error } = await supabaseAdmin
    .from('roles')
    .insert({
      client_id,
      title: title.trim(),
      interview_type,
      job_description_url: job_description_url || null
    })
    .select('id,title,client_id,slug_or_token,interview_type,job_description_url,description,rubric,kb_document_id,created_at')
    .single()
  if (error) return res.status(500).json({ error: 'create_role_failed', detail: error.message })

  try {
    await generateRubricAndKBForRole(role.id)
  } catch (e) {
    console.error('enrich_role_failed:', e?.message || e)
  }

  const { data: updated } = await supabaseAdmin
    .from('roles')
    .select('id,title,client_id,slug_or_token,interview_type,job_description_url,description,rubric,kb_document_id,created_at')
    .eq('id', role.id)
    .single()

  res.json({ item: updated || role })
})

// Delete role by id + client_id (matches FE call shape)
adminRouter.delete('/roles', requireAuth, requireAdmin, async (req, res) => {
  try {
    const roleId = req.query.id || req.body?.id;
    const clientId = req.query.client_id || req.body?.client_id;
    if (!roleId || !clientId) {
      return res.status(400).json({ error: 'id_and_client_id_required' });
    }

    const { data, error } = await supabaseAdmin
      .from('roles')
      .delete()
      .eq('id', roleId)
      .eq('client_id', clientId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('delete_role_failed:', error.message);
      return res.status(500).json({ error: 'delete_role_failed', detail: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json({ ok: true, id: data.id });
  } catch (e) {
    console.error('delete_role_exception:', e?.message || e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Alternate delete endpoint via POST body { id, client_id }
adminRouter.post('/roles/delete', requireAuth, requireAdmin, async (req, res) => {
  try {
    const roleId = req.body?.id;
    const clientId = req.body?.client_id;
    if (!roleId || !clientId) {
      return res.status(400).json({ error: 'id_and_client_id_required' });
    }

    const { data, error } = await supabaseAdmin
      .from('roles')
      .delete()
      .eq('id', roleId)
      .eq('client_id', clientId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('post_delete_role_failed:', error.message);
      return res.status(500).json({ error: 'delete_role_failed', detail: error.message });
    }
    if (!data) {
      return res.status(404).json({ error: 'not_found' });
    }
    return res.json({ ok: true, id: data.id });
  } catch (e) {
    console.error('post_delete_role_exception:', e?.message || e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// List members for a client (synthetic id)
adminRouter.get('/client-members', requireAuth, requireAdmin, async (req, res) => {
  const { client_id } = req.query
  if (!client_id) return res.status(400).json({ error: 'client_id_required' })
  const { data, error } = await supabaseAdmin
    .from('client_members')
    .select('client_id,user_id,email,name,role,created_at')
    .eq('client_id', client_id)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: 'list_members_failed', detail: error.message })

  const items = (data || []).map(m => ({ ...m, id: m.user_id || m.email }))
  res.json({ items })
})

// Add a client member
adminRouter.post('/client-members', requireAuth, requireAdmin, async (req, res) => {
  const clientId = (req.body?.client_id || '').trim()
  const emailRaw = normalizeEmail(req.body?.email || '')
  const nameRaw = (req.body?.name || '').trim()
  const role = (req.body?.role || 'member').toLowerCase()
  if (!clientId || !emailRaw || !nameRaw) return res.status(400).json({ error: 'client_id_email_name_required' })

  if (!AUTH_EMAIL_HMAC_SECRET) {
    return res.status(500).json({ error: 'email_hmac_unconfigured' })
  }

  const duplicateMemberResponse = () => res.status(409).json(DUPLICATE_MEMBER_RESPONSE)

  const { userId, created, error: ensureErr } = await ensureAuthUserId(emailRaw)
  if (!userId) {
    const detail = ensureErr?.message || 'ensure_user_failed'
    console.error('[add_member] ensureAuthUserId failed', detail)
    return res.status(500).json({ error: 'ensure_user_failed', detail })
  }

  const payload = { client_id: clientId, email: emailRaw, name: nameRaw, role, user_id: userId }

  let insertedMember = null
  try {
    const { data: upserted, error: upsertErr } = await supabaseAdmin
      .from('client_members')
      .upsert(payload, { onConflict: 'client_id,user_id', ignoreDuplicates: true })
      .select('client_id,user_id,email,name,role,created_at')

    if (upsertErr) {
      if (isDuplicateDbError(upsertErr) || isRlsViolationError(upsertErr)) {
        console.warn('[add_member] duplicate membership detected during upsert', { email: emailRaw, clientId })
        return duplicateMemberResponse()
      }
      throw upsertErr
    }

    const rows = Array.isArray(upserted) ? upserted : []
    if (rows.length === 0) {
      console.warn('[add_member] duplicate membership detected (empty upsert result)', { email: emailRaw, clientId, userId })
      return duplicateMemberResponse()
    }

    insertedMember = rows[0]
  } catch (insertErr) {
    console.error('add_member_upsert_failed:', insertErr?.message || insertErr)
    return res.status(500).json({ error: 'add_member_failed', detail: insertErr?.message || String(insertErr) })
  }

  let note = created ? null : 'existing_user'
  try {
    const passwordStartUrl = buildPasswordStartUrl(emailRaw)
    if (!passwordStartUrl) {
      throw new Error('password_start_url_unavailable')
    }
    const bodyHtml = `
      <p style="margin:0 0 20px 0;font-size:14px;line-height:1.6;color:#e7eaf6;">
        Use the button below to create your password and access the alphaSource client workspace.
      </p>
    `
    const inviteHtml = renderPasswordStartEmail({
      heading: 'Set up your alphaSource password',
      bodyHtml,
      buttonLabel: 'Set your password',
      link: passwordStartUrl
    })
    await _sendgridSend({
      to: emailRaw,
      subject: 'Set your alphaSource password',
      html: inviteHtml
    })
  } catch (e) {
    note = 'membership_created_email_failed'
    console.error('sendgrid_invite_failed:', e?.message || e)
  }

  const responsePayload = {
    ok: true,
    item: { ...insertedMember, id: insertedMember.user_id || insertedMember.email }
  }
  if (note) responsePayload.note = note

  res.status(201).json(responsePayload)
})

adminRouter.delete('/client-members', requireAuth, requireAdmin, async (req, res) => {
  const userId = typeof req.body?.user_id === 'string' ? req.body.user_id.trim() : ''
  const emailRaw = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
  const clientId = typeof req.body?.client_id === 'string' ? req.body.client_id.trim() : ''

  if (!userId && !emailRaw) {
    return res.status(400).json({ error: 'user_id_or_email_required' })
  }

  const applyFilters = (builder) => {
    if (userId) {
      builder = builder.eq('user_id', userId)
    } else {
      builder = builder.eq('email', emailRaw)
    }
    if (clientId) builder = builder.eq('client_id', clientId)
    return builder
  }

  try {
    const { data: matches, error: fetchErr } = await applyFilters(
      supabaseAdmin
        .from('client_members')
        .select('client_id,user_id,email')
    )

    if (fetchErr) {
      console.error('[admin.remove-member] select_failed:', fetchErr.message)
      return res.status(500).json({ error: 'remove_member_failed', detail: fetchErr.message })
    }

    const rows = Array.isArray(matches) ? matches : []
    if (rows.length === 0) {
      return res.json({ ok: true, removed: 0 })
    }

    if (!clientId) {
      const uniqueClients = new Set(rows.map(r => r.client_id).filter(Boolean))
      if (uniqueClients.size > 1) {
        return res.status(400).json({
          error: 'ambiguous_membership',
          detail: 'Multiple client memberships found. Provide client_id to remove a specific membership.'
        })
      }
    }

    const { error: deleteErr } = await applyFilters(
      supabaseAdmin
        .from('client_members')
        .delete()
    )

    if (deleteErr) {
      console.error('[admin.remove-member] delete_failed:', deleteErr.message)
      return res.status(500).json({ error: 'remove_member_failed', detail: deleteErr.message })
    }

    return res.json({ ok: true, removed: rows.length })
  } catch (e) {
    console.error('[admin.remove-member] unexpected:', e?.message || e)
    return res.status(500).json({ error: 'remove_member_failed', detail: e?.message || String(e) })
  }
})


app.use('/admin', adminRouter)
console.log('[mount] admin routes mounted at /admin');

/* ======================= END: Admin guard + Admin API ======================= */

// ---------- Mount legacy/optional feature routes if present ----------
function mountIfExists(relPath, urlPath) {
  try {
    const mod = require(relPath)
    app.use(urlPath, mod)
  } catch (_) {}
}
mountIfExists('./routes/kb', '/kb')
mountIfExists('./routes/webhook', '/webhook')
mountIfExists('./routes/tavus', '/')

// ---------- JD upload route (authenticated + scoped) ----------
try {
  app.use('/roles-upload', requireAuth, withClientScope, require('./routes/rolesUpload'))
} catch (_) {}

// ---------- Protected mounts ----------
app.use(
  '/files',
  requireAuth,
  withClientScope,
  (req, _res, next) => {
    if (!req.client_memberships) {
      const ids = Array.isArray(req.memberships) ? req.memberships.map(m => m.client_id) : (req.clientIds || [])
      req.client_memberships = ids
    }
    next()
  },
  require('./routes/files')
)


app.use(
  '/reports',
  requireAuth,
  withClientScope,
  (req, _res, next) => {
    if (!req.client_memberships) {
      const ids = Array.isArray(req.memberships) ? req.memberships.map(m => m.client_id) : (req.clientIds || [])
      req.client_memberships = ids
    }
    next()
  },
  require('./routes/reports')
)

// ---------- Reports PDF (HTML→PDF) ----------
try {
  const reportsPdfRoutes = require('./routes/reportsPdf');
  app.use(
    '/reports',
    requireAuth,
    withClientScope,
    (req, _res, next) => {
      if (!req.client_memberships) {
        const ids = Array.isArray(req.memberships)
          ? req.memberships.map(m => m.client_id)
          : (req.clientIds || []);
        req.client_memberships = ids;
      }
      next();
    },
    reportsPdfRoutes
  );
  console.log('[mount] reportsPdfRoutes mounted at /reports');
} catch (e) {
  console.error('[mount] Failed to load routes/reportsPdf:', e?.message || e);
}

// ---------- Interview host shim (serve container HTML that embeds FE interview with permission headers) ----------
app.get(['/interview-host', '/interview-host/:token'], async (req, res) => {
  try {
    const token = req.params.token ? encodeURIComponent(req.params.token) : '';
    const targetPath = token ? `/interview-access/${token}` : '/interview-access';
    const targetUrl = `${FRONTEND_BASE}${targetPath}`;

    // Ensure required permission delegation headers are present on the document
    res.setHeader(
      'Permissions-Policy',
      'camera=(self "https://tavus.daily.co" "https://c.daily.co"), microphone=(self "https://tavus.daily.co" "https://c.daily.co"), display-capture=(self "https://tavus.daily.co" "https://c.daily.co"), fullscreen=(self "https://tavus.daily.co" "https://c.daily.co"), autoplay=(self "https://tavus.daily.co" "https://c.daily.co"), clipboard-read=(self), clipboard-write=(self)'
    );

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Interview</title>
    <style>
      html, body { margin:0; padding:0; height:100%; background:#0000; }
      #iv { width:100%; height:100vh; border:0; display:block; }
    </style>
  </head>
  <body>
    <iframe id="iv"
      src="${targetUrl}"
      allow="camera; microphone; autoplay; clipboard-read; clipboard-write; display-capture; fullscreen; storage-access"
      allowfullscreen
      referrerpolicy="no-referrer"
      scrolling="no"></iframe>
  </body>
</html>`;
    res.status(200).type('html').send(html);
  } catch (e) {
    const status = e?.response?.status || 502;
    const body = typeof e?.response?.data === 'string' ? e.response.data : 'Upstream error';
    res.status(status).type('text/plain').send(body);
  }
})
// Pretty link: https://interviews.alphasourceai.com/<token> -> /interview-host/<token>
app.get('/:token', (req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  // Only act on the interviews subdomain; otherwise defer
  if (!/^interviews\.alphasourceai\.com(?::\d+)?$/.test(host)) return next();

  const token = req.params.token;
  // Conservative match: UUID v4 tokens only, prevents clashes with other paths
  const isUuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
  if (!isUuidV4) return next();

  // Preserve any query string when redirecting
  const qsIndex = req.url.indexOf('?');
  const qs = qsIndex >= 0 ? req.url.slice(qsIndex) : '';
  return res.redirect(302, `/interview-host/${encodeURIComponent(token)}${qs}`);
});

// ---------- Diagnostics ----------
app.get('/ops/redirect-debug', (_req, res) => {
  try {
    const base = _inferEnvBase();
    res.json({
      base,
      samples: {
        recovery: `${base.replace(/\/+$/, '')}/account?password_reset=1`,
        magic: `${base.replace(/\/+$/, '')}/account?auth_callback=1`,
      },
      env: {
        REDIRECT_BASE_URL: process.env.REDIRECT_BASE_URL || null,
        AUTH_REDIRECT_BASE: process.env.AUTH_REDIRECT_BASE || null,
        SENTRY_ENV: process.env.SENTRY_ENV || null,
        NODE_ENV: process.env.NODE_ENV || null,
        FRONTEND_URL: process.env.FRONTEND_URL || null,
        RENDER_SERVICE_NAME: process.env.RENDER_SERVICE_NAME || null,
        RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL || null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: 'redirect_debug_failed', detail: String(e?.message || e) });
  }
});

// ---------- health ----------
app.get('/health', (_req, res) => res.json({ ok: true }))

// ---------- 404 ----------
app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

// Sentry error handler (v8) — mount after routes
if (SENTRY_ENABLED) {
  if (typeof Sentry.setupExpressErrorHandler === 'function') {
    Sentry.setupExpressErrorHandler(app); // v8+
  } else if (Sentry.Handlers && typeof Sentry.Handlers.errorHandler === 'function') {
    app.use(Sentry.Handlers.errorHandler()); // v7
  }
}

// ---------- Error handler ----------
app.use(function (err, req, res, next) {
  const status = err.status || 500
  const msg = err.message || 'Server error'
  res.status(status).json({ error: msg })
})

// ---------- Start ----------
const shouldStartServer = require.main === module && !SHOULD_RUN_REDIRECT_TESTS;
if (shouldStartServer) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app
module.exports.__authRedirect = { authRedirect, _inferEnvBase };
module.exports.__redirectTestFlag = SHOULD_RUN_REDIRECT_TESTS;
