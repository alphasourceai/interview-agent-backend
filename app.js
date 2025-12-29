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
const jwt = require('jsonwebtoken')
const sg = require('@sendgrid/mail')
const { supabaseAnon, supabaseAdmin } = require('./src/lib/supabaseClient')
const { generateRubricAndKBForRole } = require('./generateRubric')
const { ensureUserAndSendRecovery, redactEmail } = require('./src/lib/recoveryHelper')

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'
const FRONTEND_BASE = (process.env.FRONTEND_BASE || process.env.FRONTEND_URL || FRONTEND_URL || '').replace(/\/+$/, '')
const INTERVIEW_FAVICON_URL = (process.env.INTERVIEW_HOST_FAVICON_URL || 'https://ia-frontend-prod.onrender.com/alpha-symbol.png').trim()
const SENDGRID_KEY = process.env.SENDGRID_API_KEY || ''
const SENDGRID_FROM = process.env.SENDGRID_FROM || ''
const APP_NAME = process.env.APP_NAME || 'Interview Agent'
const TEXT_INTERVIEW_TEMPLATE_ID = process.env.TEXT_INTERVIEW_SENDGRID_TEMPLATE_ID || ''
const TEXT_INTERVIEW_TOKEN_SECRET =
  process.env.TEXT_INTERVIEW_JWT_SECRET ||
  process.env.SUPABASE_JWT_SECRET ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ''
const TEXT_INTERVIEW_EXP_DAYS = 7
const app = express()

console.log('[boot] entrypoint =', __filename)
console.log('[boot] accommodationRequests =', require.resolve('./routes/accommodationRequests'))
console.log('[boot] createTavusInterview =', require.resolve('./routes/createTavusInterview'))

if (SENDGRID_KEY) {
  sg.setApiKey(SENDGRID_KEY)
}

function humanizeDays(days) {
  const d = Number(days || 0)
  if (d <= 1) return '1 day'
  return `${d} days`
}

const normalizeOrigin = (input) => {
  try {
    if (!input) return null;
    return new URL(input).origin;
  } catch (_) {
    return null;
  }
};

// Origins that need delegated camera/mic access when the Daily/Tavus player is nested
const INTERVIEW_FRONTEND_ORIGINS = Array.from(new Set([
  FRONTEND_BASE,
  process.env.FRONTEND_URL,
  process.env.FRONTEND_BASE,
  'https://ia-frontend-prod.onrender.com',
  'https://ia-frontend-staging.onrender.com',
  'https://ia-frontend-qa.onrender.com',
  'https://interview-agent-frontend.onrender.com'
].map(normalizeOrigin).filter(Boolean)));

const DAILY_ORIGINS = ['https://tavus.daily.co', 'https://c.daily.co'];
const INTERVIEW_FEATURE_ORIGINS = Array.from(new Set(['self', ...INTERVIEW_FRONTEND_ORIGINS, ...DAILY_ORIGINS]));
const formatPolicyOrigins = (origins) => `(${origins.map((origin) => (origin === 'self' ? 'self' : `"${origin}"`)).join(' ')})`;
const INTERVIEW_PERMISSIONS_POLICY = [
  'camera',
  'microphone',
  'display-capture',
  'fullscreen',
  'autoplay',
  'storage-access'
].map((feature) => `${feature}=${formatPolicyOrigins(INTERVIEW_FEATURE_ORIGINS)}`)
  .concat(['clipboard-read=(self)', 'clipboard-write=(self)'])
  .join(', ');

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
  'https://www.alphasourceai.com',
  'https://alphasourceai.com',
  'https://www-alphasourceai-com.filesusr.com',
  'https://editor.wix.com',
  'https://ia-frontend-qa.onrender.com',
  'https://ia-frontend-staging.onrender.com',
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

// ---------- CSP: allow Wix to embed (frame-ancestors) ----------
app.use((req, res, next) => {
  try {
    // Keep CSP minimal to avoid breaking existing resources; just control who may embed us
    // Add your production Wix domain(s) here as needed
    res.setHeader(
      'Content-Security-Policy',
      'frame-ancestors https://www.alphasourceai.com https://alphasourceai.com https://*.wixsite.com https://*.filesusr.com;'
    );
    // Ensure we don't send legacy X-Frame-Options that could conflict with CSP
    res.removeHeader && res.removeHeader('X-Frame-Options');
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
      .select('client_id, role, tester_acknowledged_at, tester_acknowledged_ip')
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
app.use('/api/accommodations', require('./routes/accommodationRequests'))
app.use('/api/text-interview', require('./routes/textInterview'))
app.use('/api/payments', require('./routes/payments'))
app.use('/api/feedback', require('./routes/feedback'))
app.use('/create-tavus-interview', require('./routes/createTavusInterview'))

// ---------- Simple test endpoint ----------
app.get('/__version', (_req, res) => {
  res.json({
    service: 'ia-backend-prod',
    commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
    node: process.version,
    now: new Date().toISOString()
  })
})

app.get('/auth/ping', requireAuth, withClientScope, (req, res) => {
  res.json({ ok: true, user: req.user, client_ids: req.clientIds })
})

// ---------- Auth me ----------
app.get('/auth/me', requireAuth, withClientScope, (req, res) => {
  res.json({
    user: req.user,
    memberships: req.memberships,
    default_client_id: req.clientScope?.defaultClientId || null
  })
})

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
          unanswered_candidate_questions,
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
      const unanswered_candidate_questions = Array.isArray(rep?.unanswered_candidate_questions)
        ? rep.unanswered_candidate_questions
        : [];

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
        report_generated_at: rep?.created_at ?? null,
        unanswered_candidate_questions
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
    const { email, role = 'member', client_id, name } = req.body || {}
    const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now())
    if (!email || !client_id) return res.status(400).json({ error: 'email and client_id are required', request_id })
    if (!(req.clientIds || []).includes(client_id)) return res.status(403).json({ error: 'Forbidden', request_id })
    const r = String(role || '').toLowerCase()
    if (!['member', 'manager'].includes(r)) return res.status(400).json({ error: 'invalid_role', request_id })

    try {
      const { userId, method, recovery_sent } = await ensureUserIdAndInvite({
        email,
        redirectTo: `${FRONTEND_BASE}/pwreset`,
        request_id,
        loggerPrefix: '[clients/invite]'
      })
      if (!userId) {
        console.error('client_invite_no_user_id', { request_id, email: redactEmail(email), method })
        return res.status(400).json({ error: 'invite_failed', detail: 'Could not create or locate user.', request_id })
      }

      const payload = { client_id, email, name: name || email, role: r, user_id: userId }
      const { error } = await supabaseAdmin.from('client_members').insert(payload).select('client_id').single();
      if (error) {
        console.error('client_invite_insert_failed', { request_id, error: error.message, code: error.code })
        if (error.code === '23505' || error.code === 'PGRST116') {
          return res.status(409).json({ error: 'email_in_use', detail: 'Email address already exists', request_id })
        }
        return res.status(500).json({ error: 'invite_failed', detail: error.message, code: error.code, request_id })
      }
      const accept_url = `${FRONTEND_BASE}/pwreset`;
      res.json({ ok: true, accept_url, request_id, recovery_sent: !!recovery_sent })
    } catch (e) {
      if (e?.code === 'misconfigured_supabase_auth') {
        return res.status(500).json({ error: 'misconfigured_supabase_auth', detail: e.detail || 'Missing SUPABASE_PUBLIC_ANON_KEY', request_id })
      }
      if (e?.code === 'email_in_use') {
        return res.status(409).json({ error: 'email_in_use', detail: 'Email address already exists', request_id })
      }
      console.error('client_invite_error', { request_id, error: e?.message || e, status: e?.status || null })
      res.status(500).json({ error: 'invite_failed', detail: e?.message || 'Invite failed', request_id, code: e?.code || 'invite_failed' })
    }
  } catch (e) {
    const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now())
    res.status(500).json({ error: 'Server error', request_id })
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

// Helper: ensure a user exists and send a recovery email (used for onboarding + resets)
async function ensureUserIdAndInvite({ email, redirectTo, request_id, loggerPrefix }) {
  const reqId = request_id || crypto.randomUUID?.() || String(Date.now())
  const effectiveRedirect = redirectTo || `${FRONTEND_BASE}/pwreset`
  const result = await ensureUserAndSendRecovery({
    email,
    redirectTo: effectiveRedirect,
    request_id: reqId,
    loggerPrefix: loggerPrefix || '[invite-helper]'
  })
  return {
    userId: result?.userId || null,
    actionLink: null,
    method: result?.method || null,
    inviteActionLink: null,
    recovery_sent: !!result?.recovery_sent,
    request_id: reqId
  }
}

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
  const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now())
  const name = (req.body?.name || '').trim()
  const adminName  = (req.body?.admin_name  || '').trim()
  const adminEmail = (req.body?.admin_email || '').trim()
  const explicitClientEmail = (req.body?.email || '').trim()
  const adminRole = (req.body?.admin_role || 'manager').toLowerCase()
  if (!['manager', 'tester'].includes(adminRole)) {
    return res.status(400).json({ error: 'admin_role_invalid', detail: 'admin_role must be manager or tester', request_id })
  }
  if (!name) return res.status(400).json({ error: 'name_required', request_id })

  const emailForClient = explicitClientEmail || adminEmail
  if (!emailForClient) {
    return res.status(400).json({ error: 'email_required_for_client', request_id })
  }

  console.log('[admin/create-client] start', { request_id, name, adminRole, adminEmail: redactEmail(adminEmail), emailForClient: redactEmail(emailForClient), redirectTo: `${FRONTEND_BASE}/pwreset` })

  // Block duplicate admin emails before proceeding
  if (adminEmail) {
    try {
      const { data: dupClient, error: dupClientErr } = await supabaseAdmin
        .from('clients')
        .select('id')
        .ilike('email', adminEmail)
        .maybeSingle()
      if (dupClient) {
        console.warn('[admin/create-client] duplicate client email', { request_id, adminEmail: redactEmail(adminEmail) })
        return res.status(409).json({ error: 'email_in_use', detail: 'Email address already exists', request_id })
      }
      if (dupClientErr && dupClientErr.code !== 'PGRST116') {
        console.error('[admin/create-client] duplicate_client_lookup_failed', { request_id, error: dupClientErr.message, code: dupClientErr.code, hint: dupClientErr.hint })
        return res.status(500).json({ error: 'duplicate_check_failed', detail: dupClientErr.message, hint: dupClientErr.hint, code: dupClientErr.code, request_id })
      }

      const { data: dupMember, error: dupMemberErr } = await supabaseAdmin
        .from('client_members')
        .select('client_id')
        .eq('email', adminEmail)
        .in('role', ['manager', 'tester'])
        .limit(1)
      if (dupMember && dupMember.length > 0) {
        console.warn('[admin/create-client] duplicate client member email', { request_id, adminEmail: redactEmail(adminEmail) })
        return res.status(409).json({ error: 'email_in_use', detail: 'Email address already exists', request_id })
      }
      if (dupMemberErr) {
        console.error('[admin/create-client] duplicate_member_lookup_failed', { request_id, error: dupMemberErr.message, code: dupMemberErr.code, hint: dupMemberErr.hint })
        return res.status(500).json({ error: 'duplicate_check_failed', detail: dupMemberErr.message, hint: dupMemberErr.hint, code: dupMemberErr.code, request_id })
      }
    } catch (e) {
      console.error('[admin/create-client] duplicate_admin_email_check_failed', { request_id, error: e?.message || e })
      return res.status(500).json({ error: 'duplicate_check_failed', detail: e?.message || 'Duplicate check failed', request_id })
    }
  }

  let inviteResult = null
  if (adminEmail) {
    try {
      inviteResult = await ensureUserIdAndInvite({
        email: adminEmail,
        redirectTo: `${FRONTEND_BASE}/pwreset`,
        request_id,
        loggerPrefix: '[admin/create-client]'
      })
    } catch (e) {
      if (e?.code === 'misconfigured_supabase_auth') {
        return res.status(500).json({ error: 'misconfigured_supabase_auth', detail: e.detail || 'Missing SUPABASE_PUBLIC_ANON_KEY', request_id })
      }
      if (e?.code === 'email_in_use') {
        console.warn('[admin/create-client] invite email_in_use', { request_id, adminEmail: redactEmail(adminEmail) })
        return res.status(409).json({ error: 'email_in_use', detail: 'Email address already exists', request_id })
      }
      const detail = e?.responseData?.error_description || e?.message || e
      console.error('[admin/create-client] seed_member_invite_failed', { request_id, error: detail, status: e?.status || null })
      return res.status(500).json({ error: 'invite_failed', detail: detail || 'Invite failed', request_id, code: 'invite_failed' })
    }
    if (!inviteResult?.userId) {
      console.error('[admin/create-client] invite returned no userId', { request_id, adminEmail: redactEmail(adminEmail), method: inviteResult?.method })
      return res.status(500).json({ error: 'invite_failed', detail: 'Could not create or locate user for this email.', request_id, code: 'invite_failed' })
    }
  }

  const { data: client, error: cErr } = await supabaseAdmin
    .from('clients')
    .insert({ name, email: emailForClient })
    .select('id,name,created_at')
    .single()
  if (cErr) {
    console.error('[admin/create-client] create_client_failed', { request_id, error: cErr.message, code: cErr.code, hint: cErr.hint })
    if (cErr.code === '23505' || cErr.code === 'PGRST116') {
      return res.status(409).json({ error: 'email_in_use', detail: 'Email address already exists', request_id })
    }
    return res.status(500).json({ error: 'create_client_failed', detail: cErr.message, hint: cErr.hint, code: cErr.code, request_id })
  }

  // Optionally seed an admin member
  let seeded_member = null
  if (adminEmail && inviteResult?.userId) {
    try {
      const payload = {
        client_id: client.id,
        email: adminEmail,
        name: adminName || adminEmail,
        role: adminRole,
        user_id: inviteResult.userId
      }

      const { data: inserted, error: insErr } = await supabaseAdmin
        .from('client_members')
        .insert(payload)
        .select('client_id,user_id,email,name,role,created_at,tester_acknowledged_at,tester_acknowledged_ip')
        .single()

      if (insErr) {
        console.error('[admin/create-client] seed_member_insert_failed', { request_id, error: insErr.message, code: insErr.code, hint: insErr.hint })
        try { await supabaseAdmin.from('clients').delete().eq('id', client.id) } catch (_) {}
        if (insErr.code === '23505' || insErr.code === 'PGRST116') {
          return res.status(409).json({ error: 'email_in_use', detail: 'Email address already exists', request_id })
        }
        return res.status(500).json({ error: 'seed_member_failed', detail: insErr.message, hint: insErr.hint, code: insErr.code, request_id })
      } else {
        seeded_member = { ...inserted, id: inserted.user_id || inserted.email }
      }
    } catch (e) {
      console.error('[admin/create-client] seed_member_invite_failed', { request_id, error: e?.message || e })
      try { await supabaseAdmin.from('clients').delete().eq('id', client.id) } catch (_) {}
      return res.status(500).json({ error: 'invite_failed', detail: e?.message || 'Invite failed', request_id })
    }
  }

  console.log('[admin/create-client] success', { request_id, client_id: client.id, adminRole, adminEmail: redactEmail(adminEmail), invite_method: inviteResult?.method || null, hasInviteActionLink: !!inviteResult?.inviteActionLink })
  res.json({ item: client, seeded_member, action_link: inviteResult?.actionLink || null, invite_action_link: inviteResult?.inviteActionLink || null, request_id })
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
    .select('client_id,user_id,email,name,role,created_at,tester_acknowledged_at,tester_acknowledged_ip')
    .eq('client_id', client_id)
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: 'list_members_failed', detail: error.message })

  const items = (data || []).map(m => ({ ...m, id: m.user_id || m.email }))
  res.json({ items })
})

// Add a client member
adminRouter.post('/client-members', requireAuth, requireAdmin, async (req, res) => {
  const { client_id, email, name } = req.body || {}
  const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now())
  const role = (req.body?.role || 'member').toLowerCase()
  if (!client_id || !email || !name) return res.status(400).json({ error: 'client_id_email_name_required', request_id })
  if (!['member', 'manager', 'tester'].includes(role)) {
    return res.status(400).json({ error: 'invalid_role', request_id })
  }
  console.log('[admin/add-member] start', { request_id, client_id, role, email: redactEmail(email), redirectTo: `${FRONTEND_BASE}/pwreset` })

  try {
    const { userId, method, inviteActionLink, recovery_sent } = await ensureUserIdAndInvite({
      email,
      redirectTo: `${FRONTEND_BASE}/pwreset`,
      request_id,
      loggerPrefix: '[admin/add-member]'
    })
    console.log('[admin/add-member] invite-result', { request_id, email: redactEmail(email), method, userIdPresent: !!userId, hasInviteActionLink: !!inviteActionLink, redirectTo: `${FRONTEND_BASE}/pwreset`, recovery_sent: !!recovery_sent })

    if (!userId) {
      console.error('[admin/add-member] add_member_no_user_id', { request_id, email: redactEmail(email), method })
      return res.status(400).json({
        error: 'add_member_failed',
        detail: 'Could not create or locate user for this email.',
        hint: 'Try again or send the magic link manually.',
        action_link: null,
        request_id,
      })
    }

    const payload = { client_id, email, name, role, user_id: userId }

    const { data, error } = await supabaseAdmin
      .from('client_members')
      .insert(payload)
      .select('client_id,user_id,email,name,role,created_at,tester_acknowledged_at,tester_acknowledged_ip')
      .single()

    if (error) {
      console.error('[admin/add-member] add_member_insert_failed', { request_id, error: error.message, code: error.code, hint: error.hint })
      if (error.code === '23505' || error.code === 'PGRST116') {
        return res.status(409).json({ error: 'email_in_use', detail: 'Email address already exists', request_id })
      }
      return res.status(500).json({ error: 'add_member_failed', detail: error.message, hint: error.hint, code: error.code, request_id })
    }

    const m = data
    console.log('[admin/add-member] success', { request_id, client_id, role, email: redactEmail(email), method })
    res.json({ item: { ...m, id: m.user_id || m.email }, request_id, invite_action_link: inviteActionLink || null })
  } catch (e) {
    if (e?.code === 'misconfigured_supabase_auth') {
      return res.status(500).json({ error: 'misconfigured_supabase_auth', detail: e.detail || 'Missing SUPABASE_PUBLIC_ANON_KEY', request_id })
    }
    if (e?.code === 'email_in_use') {
      console.warn('[admin/add-member] email_in_use', { request_id, email: redactEmail(email) })
      return res.status(409).json({ error: 'email_in_use', detail: 'Email address already exists', request_id })
    }
    console.error('[admin/add-member] add_member_invite_failed', { request_id, error: e?.message || e })
    return res.status(500).json({ error: 'add_member_failed', detail: e?.message || 'Invite failed', request_id, code: 'add_member_failed' })
  }
})

// Remove a client member
adminRouter.delete('/client-members/:id', requireAuth, requireAdmin, async (req, res) => {
  const key = req.params.id
  const client_id = req.query.client_id || null

  let q = supabaseAdmin.from('client_members').delete()
  if (key.includes('@')) q = q.eq('email', key)
  else q = q.eq('user_id', key)
  if (client_id) q = q.eq('client_id', client_id)

  const { error } = await q
  if (error) return res.status(500).json({ error: 'remove_member_failed', detail: error.message })
  res.json({ ok: true })
})

// Send password reset (admin only) for a given email
adminRouter.post('/send-password-reset', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
  const email = (req.body?.email || '').trim();
  if (!email) return res.status(400).json({ error: 'email_required', code: 'email_required', request_id });
  const redirectTo = `${FRONTEND_BASE}/pwreset`;
  console.log('[admin/send-password-reset] start', { request_id, email: redactEmail(email), redirectTo });
  try {
    await ensureUserAndSendRecovery({
      email,
      redirectTo,
      request_id,
      loggerPrefix: '[admin/send-password-reset]'
    });
    return res.json({ ok: true, request_id });
  } catch (e) {
    if (e?.code === 'misconfigured_supabase_auth') {
      return res.status(500).json({ error: 'misconfigured_supabase_auth', detail: e.detail || 'Missing SUPABASE_PUBLIC_ANON_KEY', request_id });
    }
    const detail = e?.responseData?.error_description || e?.response?.data?.error_description || e?.response?.data?.msg || e?.message || 'Failed to send password reset email';
    console.error('[admin/send-password-reset] failed', { request_id, email: redactEmail(email), status: e?.status || e?.response?.status || null, error: detail });
    return res.status(500).json({ error: 'password_reset_failed', code: e?.code || 'password_reset_failed', detail, request_id });
  }
});

// Accommodation requests (admin)
adminRouter.get('/accommodation-requests', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
  try {
    const status = String(req.query?.status || 'pending').toLowerCase();
    const client_id = String(req.query?.client_id || '').trim();
    let q = supabaseAdmin
      .from('accommodation_requests')
      .select('id, role_id, candidate_id, candidate_name, candidate_email, candidate_phone, request_text, resume_url, status, admin_notes, created_at, approved_at, sent_at, resume_received_at, text_completed_at, role:roles(id,title,client_id)')
      .order('created_at', { ascending: false });

    if (status && status !== 'all') {
      q = q.eq('status', status);
    }
    if (client_id) {
      q = q.eq('role.client_id', client_id);
    }

    const { data, error } = await q;
    if (error) {
      console.error('[admin/accommodations] list failed', { request_id, error: error.message });
      return res.status(500).json({ error: 'list_failed', request_id });
    }
    return res.json({ items: data || [], request_id });
  } catch (e) {
    console.error('[admin/accommodations] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'server_error', request_id });
  }
});

adminRouter.patch('/accommodation-requests/:id', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
  const id = req.params.id;
  try {
    const { data: existing } = await supabaseAdmin
      .from('accommodation_requests')
      .select('id, status, candidate_id')
      .eq('id', id)
      .maybeSingle();
    if (!existing) return res.status(404).json({ error: 'not_found', request_id });

    const status = req.body?.status ? String(req.body.status).toLowerCase() : null;
    const admin_notes = typeof req.body?.admin_notes === 'string' ? req.body.admin_notes : null;
    const allowed = new Set(['pending', 'approved', 'denied', 'sent']);
    if (status && !allowed.has(status)) {
      return res.status(400).json({ error: 'invalid_status', request_id });
    }

    const updates = {};
    if (status) updates.status = status;
    if (admin_notes !== null) updates.admin_notes = admin_notes;
    if (status === 'approved' && existing.status !== 'approved') {
      updates.approved_at = new Date().toISOString();
    }

    const { data, error } = await supabaseAdmin
      .from('accommodation_requests')
      .update(updates)
      .eq('id', id)
      .select('*')
      .single();
    if (error) return res.status(500).json({ error: 'update_failed', request_id });

    if (status === 'approved' && existing.status !== 'approved') {
      console.log('accommodation_approved', { request_id: id });
      if (existing.candidate_id) {
        await supabaseAdmin
          .from('candidates')
          .update({ status: 'Accommodation Approved', interview_status: 'Accommodation Approved' })
          .eq('id', existing.candidate_id);
      }
    }
    if (status === 'denied' && existing.candidate_id) {
      await supabaseAdmin
        .from('candidates')
        .update({ status: 'Accommodation Denied', interview_status: 'Accommodation Denied' })
        .eq('id', existing.candidate_id);
    }

    return res.json({ item: data, request_id });
  } catch (e) {
    console.error('[admin/accommodations] update failed', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'server_error', request_id });
  }
});

adminRouter.post('/accommodation-requests/:id/send-text-link', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
  const id = req.params.id;
  try {
    if (!TEXT_INTERVIEW_TOKEN_SECRET) {
      return res.status(500).json({ error: 'token_secret_missing', request_id });
    }
    if (!SENDGRID_KEY || !SENDGRID_FROM || !TEXT_INTERVIEW_TEMPLATE_ID) {
      return res.status(500).json({ error: 'sendgrid_not_configured', request_id });
    }

    const { data: reqRow, error: reqErr } = await supabaseAdmin
      .from('accommodation_requests')
      .select('id, role_id, candidate_id, candidate_name, candidate_email, status')
      .eq('id', id)
      .maybeSingle();
    if (reqErr || !reqRow) return res.status(404).json({ error: 'not_found', request_id });
    if (String(reqRow.status).toLowerCase() !== 'approved') {
      return res.status(400).json({ error: 'not_approved', request_id });
    }

    const { data: role, error: roleErr } = await supabaseAdmin
      .from('roles')
      .select('id, title, client_id')
      .eq('id', reqRow.role_id)
      .maybeSingle();
    if (roleErr || !role) return res.status(404).json({ error: 'role_not_found', request_id });

    const expiresIn = `${TEXT_INTERVIEW_EXP_DAYS}d`;
    const token = jwt.sign(
      {
        mode: 'text',
        request_id: reqRow.id,
        role_id: reqRow.role_id,
        candidate_email: reqRow.candidate_email,
        candidate_name: reqRow.candidate_name,
      },
      TEXT_INTERVIEW_TOKEN_SECRET,
      { expiresIn }
    );

    const interview_link = `${FRONTEND_BASE}/text-interview/${encodeURIComponent(token)}`.replace(/\s+/g, '');
    const expires_in = humanizeDays(TEXT_INTERVIEW_EXP_DAYS);

    await sg.send({
      to: reqRow.candidate_email,
      from: { email: SENDGRID_FROM, name: APP_NAME },
      templateId: TEXT_INTERVIEW_TEMPLATE_ID,
      dynamic_template_data: {
        candidate_name: reqRow.candidate_name,
        role_title: role.title || '',
        interview_link,
        expires_in,
      },
    });

    console.log('email_link_sent', {
      request_id: reqRow.id,
      role_id: reqRow.role_id,
      candidate_email: redactEmail(reqRow.candidate_email),
    });

    await supabaseAdmin
      .from('accommodation_requests')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', reqRow.id);

    if (reqRow.candidate_id) {
      await supabaseAdmin
        .from('candidates')
        .update({ status: 'Text Interview Sent', interview_status: 'Text Interview Sent' })
        .eq('id', reqRow.candidate_id);
    }

    console.log('text_link_sent', {
      request_id: reqRow.id,
      role_id: reqRow.role_id,
      candidate_email: redactEmail(reqRow.candidate_email),
    });

    return res.json({ ok: true, request_id });
  } catch (e) {
    console.error('[admin/accommodations] send link failed', { request_id, error: e?.message || e });
    return res.status(500).json({ error: 'send_failed', request_id });
  }
});

app.use('/admin', adminRouter)

// ======================= Client-scoped roles (authenticated) =======================
app.get('/roles', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || crypto.randomUUID?.() || String(Date.now());
  try {
    const allowedIds = Array.isArray(req.clientIds) ? req.clientIds.filter(Boolean) : [];
    if (!allowedIds.length) {
      return res.json({ items: [], request_id });
    }

    const requestedClientId = req.query?.client_id || null;
    let finalIds = allowedIds;
    if (requestedClientId) {
      if (!allowedIds.includes(requestedClientId)) {
        return res.status(403).json({
          error: 'forbidden',
          code: 'client_scope_mismatch',
          detail: 'You do not have access to this client',
          hint: 'Join the client to view roles.',
          request_id
        });
      }
      finalIds = [requestedClientId];
    }

    const { data, error } = await supabaseAdmin
      .from('roles')
      .select('id,title,client_id,slug_or_token,interview_type,job_description_url,description,rubric,kb_document_id,created_at')
      .in('client_id', finalIds)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[roles:list] supabase error', {
        request_id,
        code: error.code,
        hint: error.hint,
        message: error.message
      });
      return res.status(500).json({
        error: 'list_roles_failed',
        code: error.code || 'list_roles_failed',
        detail: error.message,
        hint: error.hint,
        request_id
      });
    }

    return res.json({ items: data || [], request_id });
  } catch (e) {
    console.error('[roles:list] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'server_error',
      detail: e?.message || 'Server error',
      request_id
    });
  }
});

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
mountIfExists('./routes/clientMembersScoped', '/client-members')
mountIfExists('./routes/adminBilling', '/admin/billing')

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

// Serve favicon for interview host (Chrome eagerly requests /favicon.ico)
app.get('/favicon.ico', (req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  if (!/^interviews\.alphasourceai\.com(?::\d+)?$/.test(host)) return next();
  if (!INTERVIEW_FAVICON_URL) return res.status(404).end();
  res.redirect(302, INTERVIEW_FAVICON_URL);
});

// ---------- Interview host shim (serve container HTML that embeds FE interview with permission headers) ----------
app.get(['/interview-host', '/interview-host/:token'], async (req, res) => {
  try {
    const token = req.params.token ? encodeURIComponent(req.params.token) : '';
    const targetPath = token ? `/interview-access/${token}` : '/interview-access';
    const targetUrl = `${FRONTEND_BASE}${targetPath}`;

    // Chrome only surfaces camera/mic prompts when the parent explicitly delegates
    res.setHeader('Permissions-Policy', INTERVIEW_PERMISSIONS_POLICY);

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Interview</title>
    ${INTERVIEW_FAVICON_URL ? `<link rel="icon" type="image/png" href="${INTERVIEW_FAVICON_URL}" />` : ''}
    <style>
      html, body { margin:0; padding:0; height:100%; background:#0000; }
      #iv { width:100%; min-height:100vh; height:2000px; border:0; display:block; }
    </style>
  </head>
  <body>
    <iframe id="iv"
      src="${targetUrl}"
      allow="camera; microphone; autoplay; clipboard-read; clipboard-write; display-capture; fullscreen; storage-access"
      allowfullscreen
      referrerpolicy="no-referrer"
      scrolling="yes"></iframe>
    <script>
      (function(){
        var iv = document.getElementById('iv');
        function size(h){
          try {
            var min = 2000;
            var vh = window.innerHeight || document.documentElement.clientHeight || 800;
            var target = Math.max(h||0, vh, min);
            iv.style.height = target + 'px';
          } catch(e) {}
        }
        window.__EMBED__ = { updateSize: function(){ size(); } };
        window.addEventListener('message', function(e){
          try {
            var d = e && e.data || {};
            if ((d.type === 'EMBED_HEIGHT' || d.type === 'TAVUS_HEIGHT') && d.height) size(Number(d.height));
          } catch(_) {}
        });
        size();
        window.addEventListener('resize', function(){ size(); });
      })();
    </script>
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
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})

module.exports = app
