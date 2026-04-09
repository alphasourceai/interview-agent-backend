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
const multer = require('multer')
const path = require('path')
const { supabaseAdmin } = require('./src/lib/supabaseClient')
const { generateRubricAndKBForRole, makeKBFromRubric } = require('./generateRubric')
const { ensureTavusDocumentForRole } = require('./lib/tavusDocuments')
const axios = require('axios')
const dashboardRouter = require('./routes/dashboard')
const rolesRouter = require('./routes/roles')
const { requireAuth, withClientScope } = require('./src/middleware/auth')
const { sendSubscriptionCheckoutEmail } = require('./utils/mailer')
const {
  frontendUrl: FRONTEND_URL,
  interviewAppBase: INTERVIEW_APP_BASE,
  corsDefaultOrigins,
  isInterviewPrettyLinkHost,
  resolvePublicBackendBase,
  buildPublicAccountUrl,
  buildClientDashboardReturnUrl,
  buildAdminDashboardUrl,
  buildClientPwResetUrl,
  buildPublicPwResetUrl,
  buildAcceptInviteUrl
} = require('./config/urlConfig')
const ROLE_CHECKOUT_JD_BUCKET = (process.env.SUPABASE_JOB_DESCRIPTIONS_BUCKET || process.env.SUPABASE_JD_BUCKET || 'job-descriptions').trim()
const roleCheckoutUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
})
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
const DEFAULT_ORIGINS = corsDefaultOrigins
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

app.use('/webhook/stripe', express.raw({ type: 'application/json' }), require('./routes/webhookStripe'))
app.use('/webhook', require('./routes/webhook'))

app.use(express.json({ limit: '10mb' }))

// ---------- CSP: allow Wix to embed (frame-ancestors) ----------
app.use((req, res, next) => {
  try {
    const cspFrameAncestors = String(
      process.env.CSP_FRAME_ANCESTORS || `'self' ${FRONTEND_URL} https://*.wixsite.com https://*.filesusr.com`
    ).trim();
    res.setHeader(
      'Content-Security-Policy',
      `frame-ancestors ${cspFrameAncestors};`
    );
    // Ensure we don't send legacy X-Frame-Options that could conflict with CSP
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

// ---------- auth middlewares ----------
// NOTE: Auth + client scoping are centralized in src/middleware/auth

// ---------- Public candidate endpoints (MOUNTED) ----------
app.use('/api/candidate/submit', require('./routes/candidateSubmit'))
app.use('/api/candidate/verify-otp', require('./routes/verifyOtp'))
app.use('/create-tavus-interview', require('./routes/createTavusInterview'))
app.use('/api/accommodations', require('./routes/accommodationRequests'))
app.use('/api/text-interview', require('./routes/textInterview'))

// ---------- Simple test endpoint ----------
app.get('/auth/ping', requireAuth, withClientScope, (req, res) => {
  res.json({ ok: true, user: req.user, client_ids: req.clientIds })
})

// ---------- Auth me ----------
app.get('/auth/me', requireAuth, withClientScope, (req, res) => {
  return res.json({
    user: {
      id: req.user?.id || null,
      email: req.user?.email || null,
    },
    isGlobalAdmin: req.isGlobalAdmin === true,
    client_scope: {
      client_ids: req.clientIds || [],
      client_ids_count: (req.clientIds || []).length,
      memberships: req.memberships || [],
      default_client_id: req.query?.client_id || null,
    }
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

app.get('/clients/billing/summary', requireAuth, withClientScope, async (req, res) => {
  try {
    const ids = Array.isArray(req.client_memberships) ? req.client_memberships : []
    if (ids.length === 0) return res.json({ items: [] })

    const wantedClientId = String(req.query?.client_id || '').trim()
    if (wantedClientId && !ids.includes(wantedClientId)) {
      return res.status(403).json({ error: 'forbidden' })
    }

    let q = supabaseAdmin
      .from('clients')
      .select('id,name,plan_tier,billing_status,billing_interval,auto_renew,current_term_end,contract_end_at,subscription_status,cancel_at_term_end,access_override_mode,stripe_customer_id')
      .in('id', ids)
      .order('name', { ascending: true })
    if (wantedClientId) q = q.eq('id', wantedClientId)

    const { data, error } = await q
    if (error) return res.status(500).json({ error: 'list_billing_summary_failed', detail: error.message })

    const items = (data || []).map((client) => ({
      id: client.id,
      name: client.name,
      plan_tier: client.plan_tier,
      billing_status: client.billing_status,
      billing_interval: client.billing_interval,
      auto_renew: client.auto_renew,
      current_term_end: client.current_term_end,
      contract_end_at: client.contract_end_at,
      subscription_status: client.subscription_status,
      cancel_at_term_end: client.cancel_at_term_end,
      access_override_mode: client.access_override_mode,
      has_stripe_customer: !!client.stripe_customer_id
    }))
    return res.json({ items })
  } catch (e) {
    return res.status(500).json({ error: 'server_error' })
  }
})

const CLIENT_DASHBOARD_TABS = new Set(['roles', 'candidates', 'members', 'billing', 'feedback'])
function sanitizeClientDashboardTab(value, fallback) {
  const raw = String(value || '').trim().toLowerCase()
  return CLIENT_DASHBOARD_TABS.has(raw) ? raw : fallback
}

app.post('/clients/billing/portal-session', requireAuth, withClientScope, async (req, res) => {
  try {
    const ids = Array.isArray(req.client_memberships) ? req.client_memberships : []
    const clientId = String(req.body?.client_id || '').trim()
    const tab = sanitizeClientDashboardTab(req.body?.tab, 'billing')
    if (!clientId) return res.status(400).json({ error: 'client_id_required' })
    if (!ids.includes(clientId)) return res.status(403).json({ error: 'forbidden' })

    const { data: client, error: clientErr } = await supabaseAdmin
      .from('clients')
      .select('id,stripe_customer_id')
      .eq('id', clientId)
      .maybeSingle()
    if (clientErr) return res.status(500).json({ error: 'client_lookup_failed', detail: clientErr.message })
    if (!client) return res.status(404).json({ error: 'client_not_found' })

    const stripeCustomerId = String(client.stripe_customer_id || '').trim()
    if (!stripeCustomerId) return res.status(400).json({ error: 'missing_stripe_customer' })

    const Stripe = require('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')
    const returnParams = new URLSearchParams({
      client_id: clientId,
      tab
    })
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: buildClientDashboardReturnUrl(returnParams)
    })
    return res.json({ ok: true, url: session?.url || null })
  } catch (e) {
    return res.status(500).json({ error: 'create_portal_session_failed', detail: e?.message || 'create_portal_session_failed' })
  }
})

app.post('/clients/billing/additional-interviews/checkout-session', requireAuth, withClientScope, async (req, res) => {
  try {
    const ids = Array.isArray(req.client_memberships) ? req.client_memberships : []
    const clientId = String(req.body?.client_id || '').trim()
    const roleId = String(req.body?.role_id || '').trim()
    const tab = sanitizeClientDashboardTab(req.body?.tab, 'billing')
    const parsedQuantity = Number(req.body?.quantity)
    const quantity = Number.isInteger(parsedQuantity) ? parsedQuantity : NaN

    if (!clientId) return res.status(400).json({ error: 'client_id_required' })
    if (!ids.includes(clientId)) return res.status(403).json({ error: 'forbidden' })
    if (!roleId) return res.status(400).json({ error: 'role_id_required' })
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: 'invalid_quantity' })
    }

    const { data: role, error: roleErr } = await supabaseAdmin
      .from('roles')
      .select('id,client_id,title')
      .eq('id', roleId)
      .eq('client_id', clientId)
      .maybeSingle()
    if (roleErr) return res.status(500).json({ error: 'role_lookup_failed', detail: roleErr.message })
    if (!role) return res.status(404).json({ error: 'role_not_found' })

    const { data: client, error: clientErr } = await supabaseAdmin
      .from('clients')
      .select('id,name,email,stripe_customer_id')
      .eq('id', clientId)
      .maybeSingle()
    if (clientErr) return res.status(500).json({ error: 'client_lookup_failed', detail: clientErr.message })
    if (!client) return res.status(404).json({ error: 'client_not_found' })

    const { data: planSettings, error: planSettingsErr } = await supabaseAdmin
      .from('client_plan_settings')
      .select('additional_interview_fee')
      .eq('client_id', clientId)
      .maybeSingle()
    if (planSettingsErr) return res.status(500).json({ error: 'plan_settings_lookup_failed', detail: planSettingsErr.message })

    const additionalInterviewFee = Number(planSettings?.additional_interview_fee)
    if (!Number.isFinite(additionalInterviewFee) || additionalInterviewFee <= 0) {
      return res.status(400).json({ error: 'invalid_additional_interview_fee' })
    }
    const additionalInterviewCents = Math.round(additionalInterviewFee * 100)
    if (!Number.isFinite(additionalInterviewCents) || additionalInterviewCents <= 0) {
      return res.status(400).json({ error: 'invalid_additional_interview_fee' })
    }

    const { data: pendingPurchase, error: pendingPurchaseErr } = await supabaseAdmin
      .from('role_interview_purchases')
      .insert({
        client_id: clientId,
        role_id: roleId,
        quantity,
        status: 'pending'
      })
      .select('id')
      .single()
    if (pendingPurchaseErr) {
      return res.status(500).json({ error: 'create_role_interview_purchase_failed', detail: pendingPurchaseErr.message })
    }

    const Stripe = require('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

    let stripeCustomerId = String(client.stripe_customer_id || '').trim()
    if (stripeCustomerId) {
      try {
        await stripe.customers.retrieve(stripeCustomerId)
      } catch (e) {
        const code = String(e?.code || '').toLowerCase()
        const message = String(e?.message || '').toLowerCase()
        if (code === 'resource_missing' || message.includes('no such customer')) {
          stripeCustomerId = ''
        } else {
          throw e
        }
      }
    }
    if (!stripeCustomerId) {
      const email = String(client.email || '').trim()
      if (email) {
        const found = await stripe.customers.list({ email, limit: 1 })
        stripeCustomerId = String(found?.data?.[0]?.id || '').trim()
      }
      if (!stripeCustomerId) {
        const createdCustomer = await stripe.customers.create({
          name: client.name || undefined,
          email: String(client.email || '').trim() || undefined,
          metadata: { client_id: client.id }
        })
        stripeCustomerId = String(createdCustomer?.id || '').trim()
      }
      if (!stripeCustomerId) return res.status(500).json({ error: 'stripe_customer_create_failed' })

      if (stripeCustomerId !== String(client.stripe_customer_id || '').trim()) {
        const { error: saveCustomerError } = await supabaseAdmin
          .from('clients')
          .update({ stripe_customer_id: stripeCustomerId })
          .eq('id', client.id)
        if (saveCustomerError) {
          return res.status(500).json({ error: 'client_update_failed', detail: saveCustomerError.message })
        }
      }
    }

    const sessionMetadata = {
      purchase_type: 'additional_interviews',
      role_interview_purchase_id: String(pendingPurchase.id || ''),
      client_id: clientId,
      role_id: roleId,
      quantity: String(quantity)
    }
    const successParams = new URLSearchParams({
      tab,
      intent: 'role_capacity',
      purchase: 'success',
      client_id: clientId,
      role_id: roleId
    })
    const cancelParams = new URLSearchParams({
      tab,
      intent: 'role_capacity',
      purchase: 'cancel',
      client_id: clientId,
      role_id: roleId
    })
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: stripeCustomerId || undefined,
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: additionalInterviewCents,
          product_data: {
            name: 'Additional interviews'
          }
        },
        quantity
      }],
      allow_promotion_codes: true,
      success_url: buildClientDashboardReturnUrl(successParams),
      cancel_url: buildClientDashboardReturnUrl(cancelParams),
      metadata: sessionMetadata
    })

    const { error: updatePurchaseErr } = await supabaseAdmin
      .from('role_interview_purchases')
      .update({
        stripe_checkout_session_id: session?.id || null
      })
      .eq('id', pendingPurchase.id)
    if (updatePurchaseErr) {
      return res.status(500).json({ error: 'update_role_interview_purchase_failed', detail: updatePurchaseErr.message })
    }

    return res.json({
      ok: true,
      url: session?.url || null,
      role_interview_purchase_id: pendingPurchase.id
    })
  } catch (e) {
    return res.status(500).json({ error: 'create_additional_interviews_checkout_session_failed', detail: e?.message || 'create_additional_interviews_checkout_session_failed' })
  }
})

app.post('/clients/roles/checkout-session', requireAuth, withClientScope, roleCheckoutUpload.single('file'), async (req, res) => {
  try {
    const ids = Array.isArray(req.client_memberships) ? req.client_memberships : []
    const clientId = String(req.body?.client_id || '').trim()
    const roleId = String(req.body?.role_id || '').trim()
    const tab = sanitizeClientDashboardTab(req.body?.tab, 'roles')
    const roleTitle = String(req.body?.role_title || '').trim()
    const interviewType = String(req.body?.interview_type || '').trim().toUpperCase()
    const jdFile = req.file || null

    if (!clientId) return res.status(400).json({ error: 'client_id_required' })
    if (!ids.includes(clientId)) return res.status(403).json({ error: 'forbidden' })
    if (!roleTitle) return res.status(400).json({ error: 'role_title_required' })
    if (!['BASIC', 'DETAILED', 'TECHNICAL'].includes(interviewType)) {
      return res.status(400).json({ error: 'invalid_interview_type' })
    }
    if (!jdFile) return res.status(400).json({ error: 'file_required' })

    const originalFilename = String(jdFile.originalname || '').trim()
    const ext = path.extname(originalFilename).toLowerCase()
    if (!['.pdf', '.docx'].includes(ext)) {
      return res.status(400).json({ error: 'invalid_file_type' })
    }
    if (!jdFile.buffer || !jdFile.buffer.length) {
      return res.status(400).json({ error: 'invalid_file' })
    }
    const rawName = path.basename(originalFilename, ext)
    const safeBase = rawName.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || `jd-${Date.now()}`
    const safeFilename = `${safeBase}${ext}`
    const contentType =
      ext === '.pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

    const { data: client, error: clientErr } = await supabaseAdmin
      .from('clients')
      .select('id,name,email,billing_status,access_override_mode,stripe_customer_id')
      .eq('id', clientId)
      .maybeSingle()
    if (clientErr) return res.status(500).json({ error: 'client_lookup_failed', detail: clientErr.message })
    if (!client) return res.status(404).json({ error: 'client_not_found' })

    const accessOverrideMode = String(client.access_override_mode || '').toLowerCase()
    const billingStatus = String(client.billing_status || '').toLowerCase()
    const allowedByBilling =
      accessOverrideMode === 'force_active' ||
      (accessOverrideMode !== 'force_inactive' && billingStatus === 'active')
    if (!allowedByBilling) return res.status(403).json({ error: 'client_inactive' })

    const { data: planSettings, error: planSettingsErr } = await supabaseAdmin
      .from('client_plan_settings')
      .select('plan_tier,billing_interval,per_role_fee')
      .eq('client_id', client.id)
      .maybeSingle()
    if (planSettingsErr) return res.status(500).json({ error: 'plan_settings_lookup_failed', detail: planSettingsErr.message })
    if (!planSettings) return res.status(400).json({ error: 'missing_plan_settings' })

    const perRoleFee = Number(planSettings.per_role_fee)
    if (!Number.isFinite(perRoleFee) || perRoleFee <= 0) {
      return res.status(400).json({ error: 'invalid_per_role_fee' })
    }
    const perRoleCents = Math.round(perRoleFee * 100)
    if (!Number.isFinite(perRoleCents) || perRoleCents <= 0) {
      return res.status(400).json({ error: 'invalid_per_role_fee' })
    }

    const Stripe = require('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

    let stripeCustomerId = String(client.stripe_customer_id || '').trim()
    if (stripeCustomerId) {
      try {
        await stripe.customers.retrieve(stripeCustomerId)
      } catch (e) {
        const code = String(e?.code || '').toLowerCase()
        const message = String(e?.message || '').toLowerCase()
        if (code === 'resource_missing' || message.includes('no such customer')) {
          stripeCustomerId = ''
        } else {
          throw e
        }
      }
    }
    if (!stripeCustomerId) {
      const email = String(client.email || '').trim()
      if (email) {
        const found = await stripe.customers.list({ email, limit: 1 })
        stripeCustomerId = String(found?.data?.[0]?.id || '').trim()
      }
      if (!stripeCustomerId) {
        const createdCustomer = await stripe.customers.create({
          name: client.name || undefined,
          email: String(client.email || '').trim() || undefined,
          metadata: { client_id: client.id }
        })
        stripeCustomerId = String(createdCustomer?.id || '').trim()
      }
      if (!stripeCustomerId) return res.status(500).json({ error: 'stripe_customer_create_failed' })

      if (stripeCustomerId !== String(client.stripe_customer_id || '').trim()) {
        const { error: saveCustomerError } = await supabaseAdmin
          .from('clients')
          .update({ stripe_customer_id: stripeCustomerId })
          .eq('id', client.id)
        if (saveCustomerError) {
          return res.status(500).json({ error: 'client_update_failed', detail: saveCustomerError.message })
        }
      }
    }

    const { data: pendingRolePurchase, error: pendingRolePurchaseErr } = await supabaseAdmin
      .from('pending_role_purchases')
      .insert({
        client_id: client.id,
        stripe_customer_id: stripeCustomerId || null,
        status: 'pending',
        role_title: roleTitle,
        interview_type: interviewType,
        plan_tier: String(planSettings.plan_tier || '').trim() || null,
        billing_interval: String(planSettings.billing_interval || '').trim() || null
      })
      .select('id')
      .single()
    if (pendingRolePurchaseErr) {
      return res.status(500).json({ error: 'create_pending_role_purchase_failed', detail: pendingRolePurchaseErr.message })
    }

    const pendingJdObjectKey = `pending/${client.id}/${pendingRolePurchase.id}/${safeFilename}`
    const pendingJdUpload = await supabaseAdmin.storage
      .from(ROLE_CHECKOUT_JD_BUCKET)
      .upload(pendingJdObjectKey, jdFile.buffer, { contentType, upsert: true })
    if (pendingJdUpload.error) {
      return res.status(500).json({ error: 'pending_jd_upload_failed', detail: pendingJdUpload.error.message })
    }

    const pendingJdStoragePath = `${ROLE_CHECKOUT_JD_BUCKET}/${pendingJdObjectKey}`
    const { error: pendingRolePurchaseJdUpdateErr } = await supabaseAdmin
      .from('pending_role_purchases')
      .update({
        jd_storage_path: pendingJdStoragePath
      })
      .eq('id', pendingRolePurchase.id)
    if (pendingRolePurchaseJdUpdateErr) {
      return res.status(500).json({ error: 'update_pending_role_purchase_failed', detail: pendingRolePurchaseJdUpdateErr.message })
    }

    const sessionMetadata = {
      source: 'client_role_purchase',
      client_id: client.id,
      pending_role_purchase_id: pendingRolePurchase.id,
      role_title: roleTitle,
      interview_type: interviewType,
      plan_tier: String(planSettings.plan_tier || ''),
      billing_interval: String(planSettings.billing_interval || '')
    }
    const rolePrice = await stripe.prices.create({
      currency: 'usd',
      unit_amount: perRoleCents,
      product_data: { name: 'Role creation fee' },
      metadata: sessionMetadata
    })

    const successParams = new URLSearchParams({
      role_checkout: 'success',
      client_id: String(client.id),
      tab
    })
    const cancelParams = new URLSearchParams({
      role_checkout: 'cancel',
      client_id: String(client.id),
      tab
    })
    if (roleId) {
      successParams.set('role_id', roleId)
      cancelParams.set('role_id', roleId)
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: stripeCustomerId,
      line_items: [{ price: rolePrice.id, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: buildClientDashboardReturnUrl(successParams),
      cancel_url: buildClientDashboardReturnUrl(cancelParams),
      metadata: sessionMetadata
    })

    const { error: pendingRolePurchaseUpdateErr } = await supabaseAdmin
      .from('pending_role_purchases')
      .update({
        stripe_checkout_session_id: session?.id || null,
        stripe_customer_id: stripeCustomerId || null
      })
      .eq('id', pendingRolePurchase.id)
    if (pendingRolePurchaseUpdateErr) {
      return res.status(500).json({ error: 'update_pending_role_purchase_failed', detail: pendingRolePurchaseUpdateErr.message })
    }

    return res.json({ ok: true, url: session?.url || null, session_id: session?.id || null })
  } catch (e) {
    return res.status(500).json({ error: 'create_role_checkout_session_failed', detail: e?.message || 'create_role_checkout_session_failed' })
  }
})

const clientMembersScopedRouter = require('./routes/clientMembersScoped')
app.use('/api/client-members', clientMembersScopedRouter)
app.use('/client-members', clientMembersScopedRouter)

app.use('/dashboard', dashboardRouter)
app.use('/api/dashboard', dashboardRouter)
app.use('/roles', rolesRouter)
app.use('/api/roles', rolesRouter)
app.use('/feedback', require('./routes/feedback'))
app.use('/api/feedback', require('./routes/feedback'))

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

    const accept_url = buildAcceptInviteUrl(token)
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

// Helper: ensure a user exists/invite; return user_id + optional action_link
async function ensureUserIdAndInvite(email, redirectTo, opts = {}) {
  const suppressInvite = opts?.suppressInvite === true
  let userId = null
  let actionLink = null
  let method = null

  if (!suppressInvite) {
    try {
      const invited = await supabaseAdmin.auth.admin.inviteUserByEmail(email, { redirectTo })
      userId = invited?.data?.user?.id || null
      method = 'invite'
    } catch (e) {
      console.error('inviteUserByEmail failed:', e?.message || e)
    }
  }

  if (!userId) {
    try {
      const link = await supabaseAdmin.auth.admin.generateLink({
        type: 'magiclink',
        email,
        options: { redirectTo }
      })
      userId = link?.data?.user?.id || null
      actionLink = link?.data?.action_link || null
      method = method || 'magiclink'
    } catch (e) {
      console.error('generateLink(magiclink) failed:', e?.message || e)
    }
  }

  if (!userId) {
    try {
      const created = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true
      })
      userId = created?.data?.user?.id || null
      method = method || 'createUser'
    } catch (e) {
      console.error('createUser failed:', e?.message || e)
    }
    if (userId && !suppressInvite) {
      try {
        await supabaseAdmin.auth.admin.inviteUserByEmail(email, { redirectTo })
        method = 'createUser+invite'
      } catch (e) {
        console.error('second invite after createUser failed:', e?.message || e)
      }
    }
  }

  return { userId, actionLink, method }
}

async function ensureUserIdAndRecoveryLink(email, redirectTo, opts = {}) {
  const requireActionLink = opts?.requireActionLink === true
  const normalizedEmail = String(email || '').trim()
  const emailLower = normalizedEmail.toLowerCase()

  let userId = null
  let actionLink = null
  let method = null
  let lastErr = null

  const findUserId = async () => {
    try {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ email: normalizedEmail })
      if (error) {
        console.error('listUsers(recovery) failed:', error?.message || error)
        return null
      }
      const existing = (data?.users || []).find((u) => String(u?.email || '').trim().toLowerCase() === emailLower)
      return existing?.id || null
    } catch (e) {
      console.error('listUsers(recovery) exception:', e?.message || e)
      return null
    }
  }

  const generateRecoveryLink = async () => {
    const link = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email: normalizedEmail,
      options: { redirectTo }
    })
    return {
      userId: link?.data?.user?.id || null,
      actionLink: link?.data?.action_link || link?.data?.properties?.action_link || null
    }
  }

  try {
    const generated = await generateRecoveryLink()
    userId = generated.userId || userId
    actionLink = generated.actionLink || actionLink
    method = 'recovery'
  } catch (e) {
    lastErr = e
    console.error('generateLink(recovery) failed:', e?.message || e)
  }

  if (!userId) {
    userId = await findUserId()
    if (userId && !method) method = 'existingUser'
  }

  if (!actionLink) {
    if (!userId) {
      try {
        const created = await supabaseAdmin.auth.admin.createUser({
          email: normalizedEmail,
          email_confirm: true
        })
        userId = created?.data?.user?.id || userId
        method = method || 'createUser'
      } catch (e) {
        const msg = String(e?.message || '').toLowerCase()
        if (!msg.includes('already') && !msg.includes('exists')) {
          const err = new Error('create_user_failed')
          err.code = 'create_user_failed'
          err.detail = e?.message || 'create_user_failed'
          err.status = e?.status || e?.response?.status || null
          throw err
        }
      }
      if (!userId) {
        userId = await findUserId()
      }
    }

    try {
      const retry = await generateRecoveryLink()
      userId = retry.userId || userId
      actionLink = retry.actionLink || actionLink
      method = userId ? 'recovery_retry' : method
    } catch (e) {
      lastErr = e
      console.error('generateLink(recovery) retry failed:', e?.message || e)
    }
  }

  if (!userId) {
    const err = new Error('add_member_no_user_id')
    err.code = 'add_member_no_user_id'
    err.detail = 'Could not create or locate user for this email.'
    err.status = lastErr?.status || lastErr?.response?.status || null
    throw err
  }

  if (requireActionLink && !actionLink) {
    const err = new Error('generate_recovery_link_failed')
    err.code = 'generate_recovery_link_failed'
    err.detail = lastErr?.message || 'Failed to generate recovery link'
    err.status = lastErr?.status || lastErr?.response?.status || null
    throw err
  }

  return { userId, actionLink, method }
}

function addMonthsToIso(isoString, monthsToAdd = 12) {
  const base = new Date(isoString)
  if (Number.isNaN(base.getTime())) return null
  const next = new Date(base.getTime())
  next.setUTCMonth(next.getUTCMonth() + monthsToAdd)
  return next.toISOString()
}

async function processContractRenewals(context = {}) {
  const triggerSource = String(context?.triggerSource || 'admin')
  const requestId = context?.requestId || null
  const triggeredByUserId = context?.triggeredByUserId || null
  const triggeredByEmail = context?.triggeredByEmail || null
  const now = new Date()
  const nowMs = now.getTime()
  const startedAt = now.toISOString()
  let runId = null

  try {
    const { data: startedRun, error: startedRunError } = await supabaseAdmin
      .from('contract_processing_runs')
      .insert({
        trigger_source: triggerSource,
        started_at: startedAt,
        request_id: requestId,
        triggered_by_user_id: triggeredByUserId,
        triggered_by_email: triggeredByEmail
      })
      .select('id')
      .maybeSingle()
    if (!startedRunError) {
      runId = startedRun?.id || null
    }
  } catch (_) {}

  try {
    let stripe = null
    try {
      const stripeKey = String(process.env.STRIPE_SECRET_KEY || '')
      if (stripeKey) {
        const Stripe = require('stripe')
        stripe = new Stripe(stripeKey)
      }
    } catch (_) {}

    const { data: clients, error } = await supabaseAdmin
      .from('clients')
      .select('id,name,billing_status,manual_active_override,contract_start_at,contract_end_at,auto_renew,cancel_effective_at,stripe_subscription_id,subscription_status,cancel_at_term_end')

    if (error) {
      const e = new Error(error.message || 'process_contracts_failed')
      e.detail = error.message || 'process_contracts_failed'
      throw e
    }

    const summary = {
      scanned: (clients || []).length,
      due: 0,
      renewed: 0,
      deactivated: 0,
      skipped_manual_override: 0,
      skipped_no_action: 0,
      errors: 0
    }
    const items = []

    for (const client of (clients || [])) {
      const oldContractEnd = client?.contract_end_at || null
      if (!oldContractEnd) continue

      const oldEndDate = new Date(oldContractEnd)
      if (Number.isNaN(oldEndDate.getTime())) continue
      if (oldEndDate.getTime() > nowMs) continue

      summary.due += 1

      if (client?.manual_active_override === true) {
        summary.skipped_manual_override += 1
        items.push({
          id: client.id,
          name: client.name || null,
          action: 'skipped_manual_override',
          contract_end_at_before: oldContractEnd
        })
        continue
      }

      if (client?.auto_renew === true) {
        const newContractStart = oldEndDate.toISOString()
        const newContractEnd = addMonthsToIso(newContractStart, 12)
        if (!newContractEnd) {
          summary.errors += 1
          items.push({
            id: client.id,
            name: client.name || null,
            action: 'error',
            contract_end_at_before: oldContractEnd,
            detail: 'invalid_contract_end_at'
          })
          continue
        }

        const { error: renewError } = await supabaseAdmin
          .from('clients')
          .update({
            contract_start_at: newContractStart,
            contract_end_at: newContractEnd
          })
          .eq('id', client.id)

        if (renewError) {
          summary.errors += 1
          items.push({
            id: client.id,
            name: client.name || null,
            action: 'error',
            contract_end_at_before: oldContractEnd,
            detail: renewError.message || 'renew_update_failed'
          })
          continue
        }

        summary.renewed += 1
        items.push({
          id: client.id,
          name: client.name || null,
          action: 'renewed',
          contract_end_at_before: oldContractEnd,
          contract_end_at_after: newContractEnd
        })
        continue
      }

      const localSubStatus = String(client?.subscription_status || '').toLowerCase()
      const stripeAlignmentNeeded =
        !!client?.stripe_subscription_id &&
        (localSubStatus === 'active' || localSubStatus === 'trialing') &&
        client?.cancel_at_term_end !== true
      const alreadyInactiveProcessed =
        String(client?.billing_status || '').toLowerCase() === 'inactive' &&
        !!client?.cancel_effective_at

      if (alreadyInactiveProcessed && !stripeAlignmentNeeded) {
        summary.skipped_no_action += 1
        items.push({
          id: client.id,
          name: client.name || null,
          action: 'skipped_no_action',
          contract_end_at_before: oldContractEnd,
          detail: 'already_inactive'
        })
        continue
      }

      if (!alreadyInactiveProcessed) {
        const cancelEffectiveAt = oldEndDate.toISOString()
        const { error: deactivateError } = await supabaseAdmin
          .from('clients')
          .update({
            billing_status: 'inactive',
            cancel_effective_at: cancelEffectiveAt
          })
          .eq('id', client.id)

        if (deactivateError) {
          summary.errors += 1
          items.push({
            id: client.id,
            name: client.name || null,
            action: 'error',
            contract_end_at_before: oldContractEnd,
            detail: deactivateError.message || 'deactivate_update_failed'
          })
          continue
        }
      }

      let stripeAlignmentError = null
      let stripeCancelAtTermEnd = false
      if (stripeAlignmentNeeded) {
        if (!stripe) {
          stripeAlignmentError = 'stripe_client_unavailable'
          summary.errors += 1
        } else {
          try {
            await stripe.subscriptions.update(client.stripe_subscription_id, { cancel_at_period_end: true })
            const { error: localStripeFlagError } = await supabaseAdmin
              .from('clients')
              .update({ cancel_at_term_end: true })
              .eq('id', client.id)
            if (localStripeFlagError) {
              stripeAlignmentError = localStripeFlagError.message || 'cancel_at_term_end_update_failed'
              summary.errors += 1
            } else {
              stripeCancelAtTermEnd = true
            }
          } catch (e) {
            stripeAlignmentError = e?.message || 'stripe_cancel_at_period_end_failed'
            summary.errors += 1
          }
        }
      }

      if (alreadyInactiveProcessed) {
        const alignedItem = {
          id: client.id,
          name: client.name || null,
          action: 'aligned_stripe_cancel',
          contract_end_at_before: oldContractEnd
        }
        if (stripeAlignmentError) alignedItem.stripe_alignment_error = stripeAlignmentError
        if (stripeCancelAtTermEnd) alignedItem.stripe_cancel_at_term_end = true
        items.push(alignedItem)
        continue
      }

      summary.deactivated += 1
      const deactivatedItem = {
        id: client.id,
        name: client.name || null,
        action: 'deactivated',
        contract_end_at_before: oldContractEnd,
        billing_status_after: 'inactive'
      }
      if (stripeAlignmentError) deactivatedItem.stripe_alignment_error = stripeAlignmentError
      if (stripeCancelAtTermEnd) deactivatedItem.stripe_cancel_at_term_end = true
      items.push(deactivatedItem)
    }

    const result = { ok: true, summary, items }
    const completedAt = new Date().toISOString()
    try {
      if (runId) {
        await supabaseAdmin
          .from('contract_processing_runs')
          .update({
            completed_at: completedAt,
            processed_ok: true,
            summary,
            items
          })
          .eq('id', runId)
      } else {
        await supabaseAdmin
          .from('contract_processing_runs')
          .insert({
            trigger_source: triggerSource,
            started_at: startedAt,
            completed_at: completedAt,
            processed_ok: true,
            summary,
            items,
            request_id: requestId,
            triggered_by_user_id: triggeredByUserId,
            triggered_by_email: triggeredByEmail
          })
      }
    } catch (_) {}

    return result
  } catch (e) {
    const completedAt = new Date().toISOString()
    const detail = e?.detail || e?.message || 'process_contracts_failed'
    try {
      if (runId) {
        await supabaseAdmin
          .from('contract_processing_runs')
          .update({
            completed_at: completedAt,
            processed_ok: false,
            error: detail
          })
          .eq('id', runId)
      } else {
        await supabaseAdmin
          .from('contract_processing_runs')
          .insert({
            trigger_source: triggerSource,
            started_at: startedAt,
            completed_at: completedAt,
            processed_ok: false,
            error: detail,
            request_id: requestId,
            triggered_by_user_id: triggeredByUserId,
            triggered_by_email: triggeredByEmail
          })
      }
    } catch (_) {}
    throw e
  }
}

// List all clients
adminRouter.get('/clients', requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,created_at,plan_tier,billing_status,manual_active_override,access_override_mode,candidate_assistance_contact,stripe_customer_id,stripe_subscription_id,subscription_status,current_term_end,cancel_at_term_end,billing_interval,contract_start_at,contract_end_at,auto_renew')
    .order('created_at', { ascending: false })
  if (error) return res.status(500).json({ error: 'list_clients_failed', detail: error.message })
  const items = data || []
  const clientIds = items.map((item) => item?.id).filter(Boolean)
  if (!clientIds.length) return res.json({ items })

  const { data: planSettingsRows, error: planSettingsError } = await supabaseAdmin
    .from('client_plan_settings')
    .select('client_id,plan_tier,per_role_fee,included_interviews_per_role,additional_interview_fee,updated_at')
    .in('client_id', clientIds)
    .order('updated_at', { ascending: false })
  if (planSettingsError) return res.status(500).json({ error: 'list_clients_failed', detail: planSettingsError.message })

  const planSettingsByClientId = {}
  for (const row of planSettingsRows || []) {
    const key = row?.client_id
    if (!key || planSettingsByClientId[key]) continue
    planSettingsByClientId[key] = row
  }

  const enrichedItems = items.map((item) => {
    const settings = planSettingsByClientId[item.id] || null
    return {
      ...item,
      plan_settings_plan_tier: settings?.plan_tier || null,
      plan_settings_per_role_fee: settings?.per_role_fee ?? null,
      plan_settings_included_interviews_per_role: settings?.included_interviews_per_role ?? null,
      plan_settings_additional_interview_fee: settings?.additional_interview_fee ?? null
    }
  })
  res.json({ items: enrichedItems })
})

// Create client (writes email to satisfy NOT NULL)
adminRouter.post('/clients', requireAuth, requireAdmin, async (req, res) => {
  const name = (req.body?.name || '').trim()
  const adminName  = (req.body?.admin_name  || '').trim()
  const adminEmail = (req.body?.admin_email || '').trim()
  const candidateAssistanceContact = (req.body?.candidate_assistance_contact || '').trim()
  const requestedInitialRole = String(req.body?.admin_role || '').trim().toLowerCase()
  const seededMemberRole = ['admin', 'tester', 'member'].includes(requestedInitialRole)
    ? requestedInitialRole
    : (requestedInitialRole === 'manager' ? 'admin' : 'admin')
  const explicitClientEmail = (req.body?.email || '').trim()
  if (!name) return res.status(400).json({ error: 'name_required' })
  if (!candidateAssistanceContact) return res.status(400).json({ error: 'candidate_assistance_contact_required' })

  const emailForClient = explicitClientEmail || adminEmail
  if (!emailForClient) {
    return res.status(400).json({ error: 'email_required_for_client' })
  }

  const { data: client, error: cErr } = await supabaseAdmin
    .from('clients')
    .insert({
      name,
      email: emailForClient,
      client_admin_name: adminName || null,
      candidate_assistance_contact: candidateAssistanceContact,
      plan_tier: null,
      billing_interval: null
    })
    .select('id,name,created_at')
    .single()
  if (cErr) {
    console.error('create_client_failed:', cErr.message)
    return res.status(500).json({ error: 'create_client_failed', detail: cErr.message, hint: cErr.hint })
  }

  // Optionally seed an admin member
  let seeded_member = null
  if (adminEmail) {
    const redirectTo = buildPublicAccountUrl({ auth_callback: '1' })
    const { userId, actionLink, method } = await ensureUserIdAndInvite(adminEmail, redirectTo, { suppressInvite: true })

    if (!userId) {
      console.error('seed_member_no_user_id', { email: adminEmail, method })
      return res.json({ item: client, seeded_member: null, note: 'client_created_invite_failed' })
    }

    const payload = {
      client_id: client.id,
      email: adminEmail,
      name: adminName || adminEmail,
      role: seededMemberRole,
      user_id: userId
    }

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('client_members')
      .insert(payload)
      .select('client_id,user_id,email,name,role,created_at')
      .single()

    if (insErr) {
      console.error('seed_member_insert_failed:', insErr.message)
    } else {
      seeded_member = { ...inserted, id: inserted.user_id || inserted.email }
    }
  }

  res.json({ item: client, seeded_member })
})

adminRouter.patch('/clients/:id/auto-renew', requireAuth, requireAdmin, async (req, res) => {
  const autoRenew = req.body?.auto_renew
  if (typeof autoRenew !== 'boolean') {
    return res.status(400).json({ error: 'invalid_auto_renew' })
  }
  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id,stripe_subscription_id,subscription_status,auto_renew,cancel_at_term_end,billing_interval')
    .eq('id', req.params.id)
    .maybeSingle()
  if (clientError) return res.status(500).json({ error: 'update_client_failed', detail: clientError.message })
  if (!client) return res.status(404).json({ error: 'client_not_found' })
  if (!client.stripe_subscription_id) return res.status(400).json({ error: 'missing_stripe_subscription' })
  const subscriptionStatus = String(client.subscription_status || '').toLowerCase()
  if (subscriptionStatus !== 'active' && subscriptionStatus !== 'trialing') {
    return res.status(400).json({ error: 'subscription_not_mutable' })
  }

  const billingInterval = String(client.billing_interval || '').toLowerCase()
  const isMonthly = billingInterval === 'monthly'
  const isAnnual = billingInterval === 'annual'
  if (isAnnual || !isMonthly) {
    try {
      const Stripe = require('stripe')
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')
      await stripe.subscriptions.update(client.stripe_subscription_id, { cancel_at_period_end: autoRenew !== true })
    } catch (e) {
      return res.status(500).json({ error: 'update_client_failed', detail: e?.message || 'stripe_update_failed' })
    }
  }

  const { data, error } = await supabaseAdmin
    .from('clients')
    .update({
      auto_renew: autoRenew,
      cancel_at_term_end: isMonthly ? false : (autoRenew ? false : true)
    })
    .eq('id', req.params.id)
    .select('id,auto_renew,cancel_at_term_end')
    .maybeSingle()
  if (error) return res.status(500).json({ error: 'update_client_failed', detail: error.message })
  return res.json({ ok: true, item: data || null })
})

adminRouter.patch('/clients/:id/access-override', requireAuth, requireAdmin, async (req, res) => {
  const accessOverrideMode = String(req.body?.access_override_mode || '').trim().toLowerCase()
  if (accessOverrideMode !== 'inherit' && accessOverrideMode !== 'force_active' && accessOverrideMode !== 'force_inactive') {
    return res.status(400).json({ error: 'invalid_access_override_mode' })
  }

  const { data: existingClient, error: existingClientError } = await supabaseAdmin
    .from('clients')
    .select('id')
    .eq('id', req.params.id)
    .maybeSingle()
  if (existingClientError) return res.status(500).json({ error: 'update_client_failed', detail: existingClientError.message })
  if (!existingClient) return res.status(404).json({ error: 'client_not_found' })

  const { data, error } = await supabaseAdmin
    .from('clients')
    .update({ access_override_mode: accessOverrideMode })
    .eq('id', req.params.id)
    .select('id,access_override_mode')
    .maybeSingle()
  if (error) return res.status(500).json({ error: 'update_client_failed', detail: error.message })
  return res.json({ ok: true, item: data || null })
})

adminRouter.post('/clients/:id/cancel-contract', requireAuth, requireAdmin, async (req, res) => {
  const requestId = req.request_id || null
  const clientId = req.params?.id
  const note = String(req.body?.note || '').trim() || null
  const rawFinalInvoiceAmount = req.body?.final_invoice_amount
  const parsedFinalInvoiceAmount = Number(rawFinalInvoiceAmount)
  const finalInvoiceAmount = Number.isFinite(parsedFinalInvoiceAmount) && parsedFinalInvoiceAmount > 0
    ? parsedFinalInvoiceAmount
    : null
  const nowIso = new Date().toISOString()

  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,stripe_customer_id,stripe_subscription_id,subscription_status,billing_status,auto_renew,cancel_at_term_end,cancel_effective_at')
    .eq('id', clientId)
    .maybeSingle()
  if (clientError) return res.status(500).json({ error: 'cancel_contract_failed', detail: clientError.message })
  if (!client) return res.status(404).json({ error: 'client_not_found' })
  if (!client.stripe_subscription_id) return res.status(400).json({ error: 'missing_stripe_subscription' })
  const subscriptionStatus = String(client.subscription_status || '').toLowerCase()
  if (subscriptionStatus !== 'active' && subscriptionStatus !== 'trialing') {
    return res.status(400).json({ error: 'subscription_not_cancelable' })
  }

  const { data: startedRun, error: startedRunError } = await supabaseAdmin
    .from('contract_cancellation_runs')
    .insert({
      client_id: client.id,
      client_name: client.name || null,
      triggered_by_user_id: req.user?.id || null,
      triggered_by_email: req.user?.email || null,
      started_at: nowIso,
      status: 'started',
      final_invoice_amount: finalInvoiceAmount,
      stripe_subscription_id: client.stripe_subscription_id,
      note,
      request_id: requestId
    })
    .select('id')
    .maybeSingle()
  if (startedRunError || !startedRun?.id) {
    return res.status(500).json({ error: 'cancel_contract_failed', detail: startedRunError?.message || 'audit_start_failed' })
  }
  const runId = startedRun.id

  const completeRunWithFailure = async (status, detail, extra = {}) => {
    try {
      await supabaseAdmin
        .from('contract_cancellation_runs')
        .update({
          completed_at: new Date().toISOString(),
          status,
          error: detail,
          ...extra
        })
        .eq('id', runId)
    } catch (_) {}
  }

  try {
    const Stripe = require('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')
    let stripeInvoiceId = null

    if (finalInvoiceAmount && finalInvoiceAmount > 0) {
      try {
        let stripeCustomerId = client.stripe_customer_id || null
        if (!stripeCustomerId) {
          const sub = await stripe.subscriptions.retrieve(client.stripe_subscription_id)
          stripeCustomerId = sub?.customer || null
        }
        if (!stripeCustomerId) throw new Error('missing_stripe_customer')

        const amountCents = Math.round(finalInvoiceAmount * 100)
        const createdInvoice = await stripe.invoices.create({
          customer: stripeCustomerId,
          collection_method: 'send_invoice',
          days_until_due: 0,
          auto_advance: false,
          description: 'Final contract cancellation invoice'
        })
        await stripe.invoiceItems.create({
          customer: stripeCustomerId,
          invoice: createdInvoice.id,
          amount: amountCents,
          currency: 'usd',
          description: 'Final contract cancellation invoice'
        })
        await stripe.invoices.finalizeInvoice(createdInvoice.id)
        const sentInvoice = await stripe.invoices.sendInvoice(createdInvoice.id)
        stripeInvoiceId = sentInvoice?.id || createdInvoice?.id || null
      } catch (e) {
        const detail = e?.message || 'invoice_creation_failed'
        await completeRunWithFailure('invoice_failed', detail)
        return res.status(500).json({ error: 'cancel_contract_failed', detail })
      }
    }

    try {
      await stripe.subscriptions.cancel(client.stripe_subscription_id)
    } catch (e) {
      const detail = e?.message || 'stripe_cancel_failed'
      await completeRunWithFailure('stripe_cancel_failed', detail, { stripe_invoice_id: stripeInvoiceId })
      return res.status(500).json({ error: 'cancel_contract_failed', detail })
    }

    const cancelEffectiveAt = new Date().toISOString()
    const { data: updatedClient, error: updateError } = await supabaseAdmin
      .from('clients')
      .update({
        billing_status: 'inactive',
        auto_renew: false,
        cancel_at_term_end: false,
        cancel_effective_at: cancelEffectiveAt
      })
      .eq('id', client.id)
      .select('id,billing_status,auto_renew,cancel_at_term_end,cancel_effective_at')
      .maybeSingle()
    if (updateError || !updatedClient) {
      const detail = updateError?.message || 'local_update_failed'
      await completeRunWithFailure('local_update_failed', detail, { stripe_invoice_id: stripeInvoiceId })
      return res.status(500).json({ error: 'cancel_contract_failed', detail })
    }

    try {
      await supabaseAdmin
        .from('contract_cancellation_runs')
        .update({
          completed_at: new Date().toISOString(),
          status: 'completed',
          stripe_invoice_id: stripeInvoiceId,
          error: null
        })
        .eq('id', runId)
    } catch (_) {}

    return res.json({ ok: true, item: updatedClient })
  } catch (e) {
    const detail = e?.message || 'cancel_contract_failed'
    await completeRunWithFailure('failed', detail)
    return res.status(500).json({ error: 'cancel_contract_failed', detail })
  }
})

adminRouter.post('/contracts/process-renewals', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await processContractRenewals({
      triggerSource: 'admin',
      requestId: req.request_id || null,
      triggeredByUserId: req.user?.id || null,
      triggeredByEmail: req.user?.email || null
    })
    return res.json(result)
  } catch (e) {
    return res.status(500).json({ error: 'process_contracts_failed', detail: e?.detail || e?.message || 'process_contracts_failed' })
  }
})

adminRouter.get('/audit/contract-processing-runs', requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('contract_processing_runs')
    .select('id,trigger_source,started_at,completed_at,processed_ok,summary,error,request_id,triggered_by_email,created_at')
    .order('created_at', { ascending: false })
    .limit(25)
  if (error) return res.status(500).json({ error: 'list_contract_processing_runs_failed', detail: error.message })
  return res.json({ items: data || [] })
})

adminRouter.get('/audit/contract-cancellation-runs', requireAuth, requireAdmin, async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from('contract_cancellation_runs')
    .select('id,client_id,client_name,triggered_by_email,started_at,completed_at,status,final_invoice_amount,stripe_invoice_id,stripe_subscription_id,note,request_id,error,created_at')
    .order('created_at', { ascending: false })
    .limit(25)
  if (error) return res.status(500).json({ error: 'list_contract_cancellation_runs_failed', detail: error.message })
  return res.json({ items: data || [] })
})

adminRouter.get('/audit/billing-reconciliation', requireAuth, requireAdmin, async (_req, res) => {
  const nowMs = Date.now()
  const { data, error } = await supabaseAdmin
    .from('clients')
    .select('id,name,billing_status,manual_active_override,access_override_mode,contract_end_at,auto_renew,subscription_status,cancel_at_term_end,current_term_end')
  if (error) return res.status(500).json({ error: 'list_billing_reconciliation_failed', detail: error.message })

  const items = (data || []).map((client) => {
    const billingStatus = String(client?.billing_status || '').toLowerCase()
    const accessOverrideMode = String(client?.access_override_mode || 'inherit').toLowerCase()
    const subscriptionStatus = String(client?.subscription_status || '').toLowerCase()
    const liveSubscription = subscriptionStatus === 'active' || subscriptionStatus === 'trialing'
    const contractEndMs = client?.contract_end_at ? new Date(client.contract_end_at).getTime() : NaN

    let reason = null
    if (accessOverrideMode === 'force_active' && billingStatus !== 'active') {
      reason = 'force_active_on_inactive_account'
    } else if (accessOverrideMode === 'force_inactive' && billingStatus === 'active') {
      reason = 'force_inactive_on_active_account'
    } else if (accessOverrideMode === 'force_active' && Number.isFinite(contractEndMs) && contractEndMs < nowMs) {
      reason = 'force_active_on_expired_contract'
    } else if (billingStatus === 'inactive' && liveSubscription && client?.cancel_at_term_end !== true) {
      reason = 'inactive_without_stripe_cancel'
    } else if (billingStatus === 'active' && client?.manual_active_override !== true && !liveSubscription) {
      reason = 'active_without_live_subscription'
    } else if (client?.cancel_at_term_end === true && !liveSubscription) {
      reason = 'stripe_cancel_flag_without_live_subscription'
    } else if (client?.manual_active_override === true && Number.isFinite(contractEndMs) && contractEndMs < nowMs) {
      reason = 'manual_override_on_expired_contract'
    }

    if (!reason) return null
    return {
      id: client.id,
      name: client.name,
      billing_status: client.billing_status,
      manual_active_override: client.manual_active_override,
      access_override_mode: client.access_override_mode,
      contract_end_at: client.contract_end_at,
      auto_renew: client.auto_renew,
      subscription_status: client.subscription_status,
      cancel_at_term_end: client.cancel_at_term_end,
      current_term_end: client.current_term_end,
      reason
    }
  }).filter(Boolean)

  return res.json({ items })
})

adminRouter.post('/clients/:id/billing/checkout-session', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  const clientId = req.params?.id
  const billingCycle = String(req.body?.billing_cycle || '')
  const returnTarget = String(req.body?.return_target || '').trim().toLowerCase()
  const returnTab = String(req.body?.tab || '').trim().toLowerCase()
  if (!clientId) {
    return res.status(400).json({
      error: 'invalid_request',
      code: 'CLIENT_ID_REQUIRED',
      detail: 'Client id is required.',
      hint: null,
      request_id
    })
  }
  if (billingCycle !== 'monthly' && billingCycle !== 'annual') {
    return res.status(400).json({
      error: 'invalid_request',
      code: 'INVALID_BILLING_CYCLE',
      detail: 'billing_cycle must be monthly or annual.',
      hint: null,
      request_id
    })
  }

  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,plan_tier,stripe_customer_id')
    .eq('id', clientId)
    .maybeSingle()

  if (clientError) {
    return res.status(500).json({
      error: 'internal_error',
      code: 'CLIENT_LOOKUP_FAILED',
      detail: clientError.message || 'Failed to load client.',
      hint: clientError.hint || null,
      request_id
    })
  }
  if (!client) {
    return res.status(404).json({
      error: 'not_found',
      code: 'CLIENT_NOT_FOUND',
      detail: 'Client not found.',
      hint: null,
      request_id
    })
  }

  const planTier = String(client.plan_tier || 'basic').toLowerCase()
  if (planTier === 'enterprise') {
    return res.status(400).json({
      error: 'invalid_request',
      code: 'ENTERPRISE_CHECKOUT_NOT_CONFIGURED',
      detail: 'Enterprise checkout is not configured.',
      hint: null,
      request_id
    })
  }

  let resolvedPriceId = ''
  if (planTier === 'basic') {
    resolvedPriceId = billingCycle === 'annual'
      ? String(process.env.STRIPE_PRICE_BASIC_ANNUAL || '')
      : String(process.env.STRIPE_PRICE_BASIC_MONTHLY || '')
  } else if (planTier === 'pro') {
    resolvedPriceId = billingCycle === 'annual'
      ? String(process.env.STRIPE_PRICE_PRO_ANNUAL || '')
      : String(process.env.STRIPE_PRICE_PRO_MONTHLY || '')
  }
  if (!resolvedPriceId) {
    return res.status(500).json({
      error: 'internal_error',
      code: 'STRIPE_PRICE_NOT_CONFIGURED',
      detail: `Missing Stripe price configuration for plan_tier=${planTier} billing_cycle=${billingCycle}.`,
      hint: null,
      request_id
    })
  }

  try {
    const Stripe = require('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')
    let stripeCustomerId = client.stripe_customer_id || null

    if (!stripeCustomerId) {
      const createdCustomer = await stripe.customers.create({
        name: client.name || undefined,
        email: client.email || undefined,
        metadata: { client_id: client.id }
      })
      stripeCustomerId = createdCustomer?.id || null
      if (!stripeCustomerId) {
        return res.status(500).json({
          error: 'internal_error',
          code: 'STRIPE_CUSTOMER_CREATE_FAILED',
          detail: 'Failed to create Stripe customer.',
          hint: null,
          request_id
        })
      }

      const { error: saveCustomerError } = await supabaseAdmin
        .from('clients')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('id', client.id)
      if (saveCustomerError) {
        return res.status(500).json({
          error: 'internal_error',
          code: 'CLIENT_UPDATE_FAILED',
          detail: saveCustomerError.message || 'Failed to persist Stripe customer.',
          hint: saveCustomerError.hint || null,
          request_id
        })
      }
    }

    const successParams = new URLSearchParams({
      checkout: 'success',
      client_id: String(client.id)
    })
    const cancelParams = new URLSearchParams({
      checkout: 'cancel',
      client_id: String(client.id)
    })
    if (returnTab) {
      successParams.set('tab', returnTab)
      cancelParams.set('tab', returnTab)
    }
    const successUrl =
      returnTarget === 'client'
        ? buildClientDashboardReturnUrl(successParams)
        : buildAdminDashboardUrl(successParams)
    const cancelUrl =
      returnTarget === 'client'
        ? buildClientDashboardReturnUrl(cancelParams)
        : buildAdminDashboardUrl(cancelParams)

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: resolvedPriceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      metadata: {
        client_id: client.id,
        billing_cycle: billingCycle,
        plan_tier: client.plan_tier || 'basic'
      }
    })

    return res.json({ ok: true, url: session.url, session_id: session.id })
  } catch (e) {
    return res.status(500).json({
      error: 'internal_error',
      code: 'STRIPE_CHECKOUT_SESSION_FAILED',
      detail: e?.message || 'Failed to create Stripe checkout session.',
      hint: null,
      request_id
    })
  }
})

adminRouter.post('/clients/:id/subscription-checkout', requireAuth, requireAdmin, async (req, res) => {
  const clientId = req.params?.id
  const planTier = String(req.body?.plan_tier || '').trim().toLowerCase()
  const billingInterval = String(req.body?.billing_interval || '').trim().toLowerCase()
  const returnTab = String(req.body?.tab || '').trim().toLowerCase()

  if (!['basic', 'pro', 'enterprise'].includes(planTier)) {
    return res.status(400).json({ error: 'invalid_plan_tier' })
  }
  if (!['monthly', 'annual'].includes(billingInterval)) {
    return res.status(400).json({ error: 'invalid_billing_interval' })
  }

  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,client_admin_name,stripe_customer_id')
    .eq('id', clientId)
    .maybeSingle()
  if (clientError) return res.status(500).json({ error: 'client_lookup_failed', detail: clientError.message })
  if (!client) return res.status(404).json({ error: 'client_not_found' })

  const clientEmail = String(client.email || '').trim()
  if (!clientEmail) return res.status(400).json({ error: 'missing_client_email' })

  const { data: billingCustomerRows, error: billingCustomerError } = await supabaseAdmin
    .from('billing_customers')
    .select('id,stripe_customer_id')
    .eq('client_id', client.id)
    .order('created_at', { ascending: false })
  if (billingCustomerError) return res.status(500).json({ error: 'customer_lookup_failed', detail: billingCustomerError.message })
  const billingCustomerList = Array.isArray(billingCustomerRows) ? billingCustomerRows : []
  const billingCustomer = billingCustomerList[0] || null

  try {
    const Stripe = require('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')

    const candidateStripeCustomerIds = []
    for (const row of billingCustomerList) {
      const id = String(row?.stripe_customer_id || '').trim()
      if (!id) continue
      if (!candidateStripeCustomerIds.includes(id)) candidateStripeCustomerIds.push(id)
    }
    const fallbackCustomerId = String(client?.stripe_customer_id || '').trim()
    if (fallbackCustomerId && !candidateStripeCustomerIds.includes(fallbackCustomerId)) {
      candidateStripeCustomerIds.push(fallbackCustomerId)
    }

    let resolvedStripeCustomerId = null
    for (const candidateId of candidateStripeCustomerIds) {
      try {
        await stripe.customers.retrieve(candidateId)
        resolvedStripeCustomerId = candidateId
        break
      } catch (e) {
        const message = String(e?.message || '').toLowerCase()
        const code = String(e?.code || '').toLowerCase()
        if (code === 'resource_missing' || message.includes('no such customer')) continue
        throw e
      }
    }

    if (!resolvedStripeCustomerId) {
      const createdCustomer = await stripe.customers.create({
        name: client.name || undefined,
        email: clientEmail,
        metadata: { client_id: client.id }
      })
      resolvedStripeCustomerId = createdCustomer?.id || null
    } else {
      try {
        await stripe.customers.update(resolvedStripeCustomerId, {
          name: client.name || undefined,
          email: clientEmail,
          metadata: { client_id: client.id }
        })
      } catch (_) {}
    }
    if (!resolvedStripeCustomerId) return res.status(400).json({ error: 'missing_billing_customer' })

    if (String(client?.stripe_customer_id || '').trim() !== resolvedStripeCustomerId) {
      try {
        await supabaseAdmin
          .from('clients')
          .update({ stripe_customer_id: resolvedStripeCustomerId })
          .eq('id', client.id)
      } catch (_) {}
    }
    if (billingCustomer?.id && String(billingCustomer?.stripe_customer_id || '').trim() !== resolvedStripeCustomerId) {
      try {
        await supabaseAdmin
          .from('billing_customers')
          .update({ stripe_customer_id: resolvedStripeCustomerId })
          .eq('id', billingCustomer.id)
      } catch (_) {}
    }

    const lineItems = []
    let enterpriseCheckoutMetadata = null
    if (planTier === 'enterprise') {
      const platformFee = Number(req.body?.platform_fee)
      const perRoleFee = Number(req.body?.per_role_fee)
      const includedInterviewsPerRole = Number(req.body?.included_interviews_per_role)
      const additionalInterviewFee = Number(req.body?.additional_interview_fee)
      if (!Number.isFinite(platformFee) || platformFee <= 0) {
        return res.status(400).json({ error: 'invalid_enterprise_fees' })
      }
      if (
        !Number.isFinite(perRoleFee) || perRoleFee < 0 ||
        !Number.isFinite(includedInterviewsPerRole) || !Number.isInteger(includedInterviewsPerRole) || includedInterviewsPerRole < 0 ||
        !Number.isFinite(additionalInterviewFee) || additionalInterviewFee < 0
      ) {
        return res.status(400).json({ error: 'invalid_enterprise_fees' })
      }
      const platformCents = Math.round(platformFee * 100)
      if (!Number.isFinite(platformCents) || platformCents <= 0) {
        return res.status(400).json({ error: 'invalid_enterprise_fees' })
      }
      enterpriseCheckoutMetadata = {
        platform_fee: String(Math.round(platformFee * 100) / 100),
        per_role_fee: String(Math.round(perRoleFee * 100) / 100),
        included_interviews_per_role: String(includedInterviewsPerRole),
        additional_interview_fee: String(Math.round(additionalInterviewFee * 100) / 100)
      }
      const enterprisePrice = await stripe.prices.create({
        currency: 'usd',
        unit_amount: platformCents,
        recurring: { interval: billingInterval === 'annual' ? 'year' : 'month' },
        product_data: { name: 'Enterprise membership' },
        metadata: {
          source: 'admin_subscription_checkout',
          client_id: client.id,
          plan_tier: 'enterprise',
          billing_interval: billingInterval,
          ...enterpriseCheckoutMetadata
        }
      })
      lineItems.push({
        price: enterprisePrice.id,
        quantity: 1
      })
    } else {
      let priceId = ''
      if (planTier === 'basic') {
        priceId = billingInterval === 'annual'
          ? String(process.env.STRIPE_PRICE_BASIC_ANNUAL || '')
          : String(process.env.STRIPE_PRICE_BASIC_MONTHLY || '')
      } else if (planTier === 'pro') {
        priceId = billingInterval === 'annual'
          ? String(process.env.STRIPE_PRICE_PRO_ANNUAL || '')
          : String(process.env.STRIPE_PRICE_PRO_MONTHLY || '')
      }
      if (!priceId) return res.status(500).json({ error: 'stripe_price_not_configured' })
      lineItems.push({ price: priceId, quantity: 1 })
    }

    const forwardedProto = String(req.headers?.['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim()
    const forwardedHost = String(req.headers?.['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim()
    const computedBackendBase = forwardedHost ? `${forwardedProto || 'https'}://${forwardedHost}` : ''
    const publicBackendBase = resolvePublicBackendBase(computedBackendBase || '')
    const checkoutSuccessUrl = publicBackendBase
      ? `${publicBackendBase}/checkout/subscription-success?session_id={CHECKOUT_SESSION_ID}&client_id=${encodeURIComponent(client.id)}${returnTab ? `&tab=${encodeURIComponent(returnTab)}` : ''}`
      : buildClientDashboardReturnUrl(returnTab ? { checkout: 'success', client_id: client.id, tab: returnTab } : { checkout: 'success', client_id: client.id })
    const checkoutMetadata = {
      source: 'admin_subscription_checkout',
      client_id: client.id,
      plan_tier: planTier,
      billing_interval: billingInterval,
      ...(enterpriseCheckoutMetadata || {})
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: resolvedStripeCustomerId,
      line_items: lineItems,
      success_url: checkoutSuccessUrl,
      cancel_url: buildClientDashboardReturnUrl(returnTab ? { checkout: 'cancel', client_id: client.id, tab: returnTab } : { checkout: 'cancel', client_id: client.id }),
      allow_promotion_codes: true,
      metadata: checkoutMetadata,
      subscription_data: {
        metadata: checkoutMetadata
      }
    })

    let email_sent = false
    let email_error = null
    try {
      const emailResult = await sendSubscriptionCheckoutEmail(
        clientEmail,
        session?.url || '',
        client.client_admin_name || client.name || ''
      )
      email_sent = emailResult?.statusCode === 202
      if (!email_sent && emailResult?.skipped) email_error = 'email_skipped'
    } catch (e) {
      email_error = e?.message || 'email_send_failed'
    }

    return res.json({
      ok: true,
      url: session?.url || null,
      session_id: session?.id || null,
      client_email: clientEmail,
      email_sent,
      email_error
    })
  } catch (e) {
    return res.status(500).json({ error: 'create_subscription_checkout_failed', detail: e?.message || 'create_subscription_checkout_failed' })
  }
})

adminRouter.post('/clients/:id/subscription-invoice', requireAuth, requireAdmin, async (req, res) => {
  const clientId = req.params?.id
  const planTier = String(req.body?.plan_tier || '').trim().toLowerCase()
  const billingInterval = String(req.body?.billing_interval || '').trim().toLowerCase()

  if (!['basic', 'pro', 'enterprise'].includes(planTier)) {
    return res.status(400).json({ error: 'invalid_plan_tier' })
  }
  if (!['monthly', 'annual'].includes(billingInterval)) {
    return res.status(400).json({ error: 'invalid_billing_interval' })
  }

  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,stripe_customer_id')
    .eq('id', clientId)
    .maybeSingle()
  if (clientError) return res.status(500).json({ error: 'client_lookup_failed', detail: clientError.message })
  if (!client) return res.status(404).json({ error: 'client_not_found' })

  const { data: billingCustomerRows, error: billingCustomerError } = await supabaseAdmin
    .from('billing_customers')
    .select('id,name,primary_contact_email,stripe_customer_id')
    .eq('client_id', client.id)
    .order('created_at', { ascending: false })
  if (billingCustomerError) return res.status(500).json({ error: 'customer_lookup_failed', detail: billingCustomerError.message })
  const billingCustomerList = Array.isArray(billingCustomerRows) ? billingCustomerRows : []
  const billingCustomer = billingCustomerList[0] || null
  if (!billingCustomer) return res.status(400).json({ error: 'missing_billing_customer' })

  try {
    const Stripe = require('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')
    const candidateStripeCustomerIds = []
    for (const row of billingCustomerList) {
      const id = String(row?.stripe_customer_id || '').trim()
      if (!id) continue
      if (!candidateStripeCustomerIds.includes(id)) candidateStripeCustomerIds.push(id)
    }
    const fallbackCustomerId = String(client?.stripe_customer_id || '').trim()
    if (fallbackCustomerId && !candidateStripeCustomerIds.includes(fallbackCustomerId)) {
      candidateStripeCustomerIds.push(fallbackCustomerId)
    }

    let resolvedStripeCustomerId = null
    for (const candidateId of candidateStripeCustomerIds) {
      try {
        await stripe.customers.retrieve(candidateId)
        resolvedStripeCustomerId = candidateId
        break
      } catch (e) {
        const message = String(e?.message || '').toLowerCase()
        const code = String(e?.code || '').toLowerCase()
        if (code === 'resource_missing' || message.includes('no such customer')) continue
        throw e
      }
    }
    if (!resolvedStripeCustomerId) return res.status(400).json({ error: 'missing_billing_customer' })
    if (billingCustomer?.id && String(billingCustomer?.stripe_customer_id || '').trim() !== resolvedStripeCustomerId) {
      try {
        await supabaseAdmin
          .from('billing_customers')
          .update({ stripe_customer_id: resolvedStripeCustomerId })
          .eq('id', billingCustomer.id)
      } catch (_) {}
    }

    const lineItems = []
    let invoiceTitle = ''
    const invoiceDescription = null
    const daysUntilDue = 7

    if (planTier === 'enterprise') {
      const platformFee = Number(req.body?.platform_fee)
      const perRoleFee = Number(req.body?.per_role_fee)
      if (!Number.isFinite(platformFee) || platformFee < 0 || !Number.isFinite(perRoleFee) || perRoleFee < 0) {
        return res.status(400).json({ error: 'invalid_enterprise_fees' })
      }
      const platformCents = Math.round(platformFee * 100)
      const perRoleCents = Math.round(perRoleFee * 100)
      invoiceTitle = `Enterprise membership (${billingInterval})`
      if (platformCents > 0) lineItems.push({ description: 'Enterprise membership fee', quantity: 1, unit_amount_cents: platformCents })
      if (perRoleCents > 0) lineItems.push({ description: 'Enterprise per-role fee', quantity: 1, unit_amount_cents: perRoleCents })
      if (!lineItems.length) return res.status(400).json({ error: 'invalid_enterprise_fees' })
    } else {
      let priceId = ''
      if (planTier === 'basic') {
        priceId = billingInterval === 'annual'
          ? String(process.env.STRIPE_PRICE_BASIC_ANNUAL || '')
          : String(process.env.STRIPE_PRICE_BASIC_MONTHLY || '')
      } else if (planTier === 'pro') {
        priceId = billingInterval === 'annual'
          ? String(process.env.STRIPE_PRICE_PRO_ANNUAL || '')
          : String(process.env.STRIPE_PRICE_PRO_MONTHLY || '')
      }
      if (!priceId) return res.status(500).json({ error: 'stripe_price_not_configured' })

      const price = await stripe.prices.retrieve(priceId)
      const unitAmount = Number(price?.unit_amount)
      if (!Number.isFinite(unitAmount) || unitAmount <= 0) {
        return res.status(500).json({ error: 'invalid_price_configuration' })
      }
      const planLabel = planTier === 'basic' ? 'Basic' : 'Pro'
      const intervalLabel = billingInterval === 'annual' ? 'annual' : 'monthly'
      invoiceTitle = `${planLabel} membership (${intervalLabel})`
      lineItems.push({
        description: `${planLabel} membership (${intervalLabel})`,
        quantity: 1,
        unit_amount_cents: unitAmount
      })
    }

    const normalizedItems = lineItems.map((item) => {
      const quantity = Number.isFinite(Number(item?.quantity)) && Number(item.quantity) > 0 ? Number(item.quantity) : 1
      const unitAmountCents = Number(item?.unit_amount_cents)
      return {
        description: String(item?.description || '').trim(),
        quantity,
        unit_amount_cents: unitAmountCents,
        line_total_cents: Number.isFinite(unitAmountCents) ? unitAmountCents * quantity : NaN
      }
    })
    if (!normalizedItems.length || normalizedItems.some((item) => !item.description || !Number.isFinite(item.line_total_cents) || item.line_total_cents <= 0)) {
      return res.status(400).json({ error: 'invalid_line_items' })
    }
    const computedSumCents = normalizedItems.reduce((sum, item) => sum + item.line_total_cents, 0)

    const draftInvoice = await stripe.invoices.create({
      customer: resolvedStripeCustomerId,
      collection_method: 'send_invoice',
      days_until_due: daysUntilDue,
      auto_advance: false,
      description: invoiceDescription || undefined,
      metadata: {
        billing_customer_id: billingCustomer.id,
        client_id: client.id,
        invoice_title: invoiceTitle,
        plan_tier: planTier,
        billing_interval: billingInterval
      }
    })

    for (const item of normalizedItems) {
      await stripe.invoiceItems.create({
        customer: resolvedStripeCustomerId,
        invoice: draftInvoice.id,
        description: item.description,
        amount: item.line_total_cents,
        currency: 'usd'
      })
    }

    const finalized = await stripe.invoices.finalizeInvoice(draftInvoice.id)
    const sent = await stripe.invoices.sendInvoice(finalized.id)
    const invoice = sent || finalized
    let amountTotalCents = computedSumCents
    try {
      const afterSend = await stripe.invoices.retrieve(finalized.id)
      amountTotalCents = Number.isFinite(afterSend?.amount_due)
        ? afterSend.amount_due
        : Number.isFinite(afterSend?.total)
          ? afterSend.total
          : computedSumCents
    } catch (_) {}

    const { data: inserted, error: persistError } = await supabaseAdmin
      .from('billing_invoices')
      .insert({
        billing_customer_id: billingCustomer.id,
        title: invoiceTitle,
        invoice_title: invoiceTitle,
        invoice_description: invoiceDescription,
        amount_total_cents: amountTotalCents,
        currency: 'usd',
        status: invoice?.status || null,
        hosted_invoice_url: invoice?.hosted_invoice_url || null,
        stripe_invoice_id: invoice?.id || null,
        customer_name: billingCustomer.name || null,
        customer_email: billingCustomer.primary_contact_email || null
      })
      .select('id,stripe_invoice_id,status,hosted_invoice_url,invoice_description,amount_total_cents,customer_name,customer_email')
      .single()
    if (persistError) return res.status(500).json({ error: 'persist_failed', detail: persistError.message })

    return res.json({
      ok: true,
      invoice: inserted
    })
  } catch (e) {
    return res.status(500).json({ error: 'send_subscription_invoice_failed', detail: e?.message || 'send_subscription_invoice_failed' })
  }
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

  const hasInitialJobDescriptionUrl = typeof role?.job_description_url === 'string' && role.job_description_url.trim().length > 0
  if (hasInitialJobDescriptionUrl) {
    try {
      await generateRubricAndKBForRole(role.id)
    } catch (e) {
      console.error('enrich_role_failed:', e?.message || e)
    }
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

// List candidates for admin dashboard (requires client selection)
adminRouter.get('/candidates', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const client_id = String(req.query?.client_id || '').trim();
    const role_id = String(req.query?.role_id || '').trim();

    if (!client_id) {
      return res.json({ candidates: [], message: 'Select a client to view candidates.' });
    }

    let cq = supabaseAdmin
      .from('candidates')
      .select('id,created_at,client_id,role_id,name,email,status,interview_status,resume_url,analysis_summary,candidate_id,first_name,last_name')
      .eq('client_id', client_id)
      .order('created_at', { ascending: false });

    if (role_id) cq = cq.eq('role_id', role_id);

    const { data: cands, error: cErr } = await cq;
    if (cErr) {
      console.error('[admin/candidates] list failed', {
        request_id,
        client_id,
        role_id: role_id || null,
        code: cErr.code,
        message: cErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'LIST_CANDIDATES_FAILED',
        detail: cErr.message,
        hint: cErr.hint || null,
        request_id
      });
    }

    const candidateIds = Array.from(new Set((cands || []).map(c => c.id).filter(Boolean)));
    const latestReportByCandidateId = {};

    if (candidateIds.length) {
      const { data: reports, error: rErr } = await supabaseAdmin
        .from('reports')
        .select('candidate_id,resume_score,interview_score,overall_score,report_url,created_at')
        .eq('client_id', client_id)
        .in('candidate_id', candidateIds)
        .order('created_at', { ascending: false });

      if (rErr) {
        console.error('[admin/candidates] reports lookup failed', {
          request_id,
          client_id,
          code: rErr.code,
          message: rErr.message
        });
        return res.status(500).json({
          error: 'server_error',
          code: 'LIST_CANDIDATES_FAILED',
          detail: rErr.message,
          hint: rErr.hint || null,
          request_id
        });
      }

      for (const rep of (reports || [])) {
        if (rep?.candidate_id && !latestReportByCandidateId[rep.candidate_id]) {
          latestReportByCandidateId[rep.candidate_id] = rep;
        }
      }
    }

    // Derive interview_score from latest interview transcript_scores.overall (matches client dashboard behavior)
    const latestInterviewByCandidateId = {};
    const transcriptOverallByCandidateId = {};

    if (candidateIds.length) {
      const { data: ivs, error: iErr } = await supabaseAdmin
        .from('interviews')
        .select('candidate_id,created_at,transcript_scores')
        .eq('client_id', client_id)
        .in('candidate_id', candidateIds)
        .order('created_at', { ascending: false });

      if (iErr) {
        console.error('[admin/candidates] interviews lookup failed', {
          request_id,
          client_id,
          code: iErr.code,
          message: iErr.message
        });
      } else {
        for (const iv of (ivs || [])) {
          if (iv?.candidate_id && !latestInterviewByCandidateId[iv.candidate_id]) {
            latestInterviewByCandidateId[iv.candidate_id] = iv;
          }
        }

        const clamp0to100Local = (v) => {
          if (!Number.isFinite(Number(v))) return null;
          const n = Number(v);
          return Math.max(0, Math.min(100, n));
        };

        for (const cid of candidateIds) {
          const iv = latestInterviewByCandidateId[cid];
          let ts = iv?.transcript_scores;
          if (typeof ts === 'string' && ts.trim()) {
            try { ts = JSON.parse(ts); } catch (_) { ts = null; }
          }
          const overall = ts && typeof ts === 'object' ? ts.overall : null;
          const clamped = clamp0to100Local(overall);
          if (clamped !== null) transcriptOverallByCandidateId[cid] = clamped;
        }
      }
    }

    const candidates = (cands || []).map((c) => {
      const rep = latestReportByCandidateId[c.id] || null;
      const resume_score = Number.isFinite(Number(rep?.resume_score)) ? Number(rep.resume_score) : null;

      const transcriptOverall = Object.prototype.hasOwnProperty.call(transcriptOverallByCandidateId, c.id)
        ? transcriptOverallByCandidateId[c.id]
        : null;

      const interview_score = Number.isFinite(Number(transcriptOverall)) ? Number(transcriptOverall) : null;

      const rep_overall = Number.isFinite(Number(rep?.overall_score)) ? Number(rep.overall_score) : null;

      const clamp0to100 = (v) => {
        if (!Number.isFinite(Number(v))) return null;
        const n = Number(v);
        return Math.max(0, Math.min(100, n));
      };

      const resumeClamped = clamp0to100(resume_score);
      const interviewClamped = clamp0to100(interview_score);
      const repOverallClamped = clamp0to100(rep_overall);

      let overall_score = null;
      if (resumeClamped !== null && interviewClamped !== null) {
        overall_score = clamp0to100((resumeClamped + interviewClamped) / 2);
      } else if (interviewClamped !== null) {
        overall_score = interviewClamped;
      } else if (resumeClamped !== null) {
        overall_score = resumeClamped;
      } else if (repOverallClamped !== null) {
        overall_score = repOverallClamped;
      }
      return {
        id: c.id,
        created_at: c.created_at,
        client_id: c.client_id,
        role_id: c.role_id,
        name: c.name || '',
        email: c.email || '',
        status: c.status || null,
        interview_status: c.interview_status || null,
        resume_url: c.resume_url || null,
        analysis_summary: c.analysis_summary || null,
        candidate_id: c.candidate_id || null,
        first_name: c.first_name || null,
        last_name: c.last_name || null,
        resume_score,
        interview_score,
        overall_score,
        latest_report_url: rep?.report_url || null,
        report_generated_at: rep?.created_at || null
      };
    });

    return res.json({ candidates });
  } catch (e) {
    console.error('[admin/candidates] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'LIST_CANDIDATES_FAILED',
      detail: e?.message || 'Failed to list candidates',
      hint: null,
      request_id
    });
  }
});

// Generate candidate report from Admin dashboard (mirrors client dashboard /reports/generate)
adminRouter.post('/reports/generate', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const candidate_id = String(req.body?.candidate_id || '').trim();
    if (!candidate_id) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'CANDIDATE_ID_REQUIRED',
        detail: 'candidate_id is required',
        hint: null,
        request_id
      });
    }

    const { data: cand, error: cErr } = await supabaseAdmin
      .from('candidates')
      .select('id, client_id')
      .eq('id', candidate_id)
      .maybeSingle();

    if (cErr) {
      console.error('[admin/reports/generate] candidate lookup failed', {
        request_id,
        candidate_id,
        code: cErr.code,
        message: cErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'CANDIDATE_LOOKUP_FAILED',
        detail: cErr.message,
        hint: cErr.hint || null,
        request_id
      });
    }

    if (!cand?.client_id) {
      return res.status(404).json({
        error: 'not_found',
        code: 'CANDIDATE_NOT_FOUND',
        detail: 'Candidate not found',
        hint: null,
        request_id
      });
    }

    // Provide the same scoped context that /reports/* routes expect.
    req.clientIds = [cand.client_id];
    req.client_memberships = [cand.client_id];
    req.memberships = Array.isArray(req.memberships) && req.memberships.length
      ? req.memberships
      : [{ client_id: cand.client_id, role: 'admin' }];

    let reportsPdfRoutes;
    try {
      reportsPdfRoutes = require('./routes/reportsPdf');
    } catch (e) {
      console.error('[admin/reports/generate] require reportsPdf failed', { request_id, error: e?.message || e });
      return res.status(500).json({
        error: 'server_error',
        code: 'REPORTS_PDF_ROUTES_MISSING',
        detail: e?.message || 'Failed to load reportsPdf routes',
        hint: null,
        request_id
      });
    }

    const handler = reportsPdfRoutes && typeof reportsPdfRoutes._handleGenerate === 'function'
      ? reportsPdfRoutes._handleGenerate
      : null;

    if (!handler) {
      return res.status(500).json({
        error: 'server_error',
        code: 'REPORTS_PDF_HANDLER_MISSING',
        detail: 'reportsPdfRoutes._handleGenerate is not available',
        hint: null,
        request_id
      });
    }

    return handler(req, res);
  } catch (e) {
    console.error('[admin/reports/generate] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'GENERATE_REPORT_FAILED',
      detail: e?.message || 'Failed to generate report',
      hint: null,
      request_id
    });
  }
});

// Delete candidate by id + client_id (safety guard)
adminRouter.delete('/candidates/:id', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const id = req.params.id;
    const client_id = String(req.query?.client_id || '').trim();

    if (!client_id) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'CLIENT_ID_REQUIRED',
        detail: 'client_id query param is required',
        hint: null,
        request_id
      });
    }

    const { data, error } = await supabaseAdmin
      .from('candidates')
      .delete()
      .eq('id', id)
      .eq('client_id', client_id)
      .select('id')
      .maybeSingle();

    if (error) {
      const blockedByDependencies = error.code === '23503';
      console.error('[admin/candidates] delete failed', {
        request_id,
        id,
        client_id,
        code: error.code,
        message: error.message
      });
      return res.status(blockedByDependencies ? 409 : 500).json({
        error: blockedByDependencies ? 'conflict' : 'server_error',
        code: blockedByDependencies ? 'CANDIDATE_DELETE_BLOCKED' : 'DELETE_CANDIDATE_FAILED',
        detail: error.message,
        hint: blockedByDependencies ? 'Candidate has dependent records; enable DB cascade or remove dependents first.' : (error.hint || null),
        request_id
      });
    }

    if (!data) {
      return res.status(404).json({
        error: 'not_found',
        code: 'CANDIDATE_NOT_FOUND',
        detail: 'Candidate not found for provided id/client_id',
        hint: null,
        request_id
      });
    }

    return res.json({ ok: true, id: data.id });
  } catch (e) {
    console.error('[admin/candidates] delete unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'DELETE_CANDIDATE_FAILED',
      detail: e?.message || 'Failed to delete candidate',
      hint: null,
      request_id
    });
  }
});

// Get editable role config
adminRouter.get('/roles/:id/config', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const roleId = req.params.id;
    const { data, error } = await supabaseAdmin
      .from('roles')
      .select('id,client_id,title,rubric,manual_questions,job_description_text')
      .eq('id', roleId)
      .maybeSingle();

    if (error) {
      console.error('[admin/roles/config] fetch failed', {
        request_id,
        role_id: roleId,
        code: error.code,
        message: error.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'FETCH_ROLE_CONFIG_FAILED',
        detail: error.message,
        hint: error.hint || null,
        request_id
      });
    }

    if (!data) {
      return res.status(404).json({
        error: 'not_found',
        code: 'ROLE_NOT_FOUND',
        detail: 'Role not found',
        hint: null,
        request_id
      });
    }

    return res.json({
      ok: true,
      item: {
        id: data.id,
        client_id: data.client_id,
        title: data.title,
        rubric: data.rubric || null,
        manual_questions: data.manual_questions || null,
        job_description_text: data.job_description_text || null
      }
    });
  } catch (e) {
    console.error('[admin/roles/config] unexpected', { request_id, role_id: req.params?.id || null, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'FETCH_ROLE_CONFIG_FAILED',
      detail: e?.message || 'Failed to fetch role config',
      hint: null,
      request_id
    });
  }
});

// Update editable role config
adminRouter.patch('/roles/:id/config', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const roleId = req.params.id;
    const client_id = String(req.query?.client_id || '').trim();
    if (!client_id) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'CLIENT_ID_REQUIRED',
        detail: 'client_id query param is required',
        hint: null,
        request_id
      });
    }

    const { data: existing, error: existingErr } = await supabaseAdmin
      .from('roles')
      .select('id,client_id,rubric')
      .eq('id', roleId)
      .maybeSingle();

    if (existingErr) {
      console.error('[admin/roles/config] lookup failed', {
        request_id,
        role_id: roleId,
        client_id,
        code: existingErr.code,
        message: existingErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'UPDATE_ROLE_CONFIG_FAILED',
        detail: existingErr.message,
        hint: existingErr.hint || null,
        request_id
      });
    }
    if (!existing || String(existing.client_id) !== client_id) {
      return res.status(404).json({
        error: 'not_found',
        code: 'ROLE_NOT_FOUND',
        detail: 'Role not found for provided client_id',
        hint: null,
        request_id
      });
    }

    const updates = {};
    let responseRubricQuestions;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'rubric')) {
      updates.rubric = req.body.rubric;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'manual_questions')) {
      updates.manual_questions = req.body.manual_questions;
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'NO_EDITABLE_FIELDS',
        detail: 'No editable fields provided',
        hint: 'Provide rubric and/or manual_questions',
        request_id
      });
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('roles')
      .update(updates)
      .eq('id', roleId)
      .eq('client_id', client_id)
      .select('id,client_id,title,rubric,manual_questions,job_description_text')
      .single();

    if (updateErr) {
      console.error('[admin/roles/config] update failed', {
        request_id,
        role_id: roleId,
        client_id,
        code: updateErr.code,
        message: updateErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'UPDATE_ROLE_CONFIG_FAILED',
        detail: updateErr.message,
        hint: updateErr.hint || null,
        request_id
      });
    }

    return res.json({
      ok: true,
      item: {
        id: updated.id,
        client_id: updated.client_id,
        title: updated.title,
        rubric: updated.rubric || null,
        manual_questions: updated.manual_questions || null,
        job_description_text: updated.job_description_text || null
      }
    });
  } catch (e) {
    console.error('[admin/roles/config] update unexpected', { request_id, role_id: req.params?.id || null, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'UPDATE_ROLE_CONFIG_FAILED',
      detail: e?.message || 'Failed to update role config',
      hint: null,
      request_id
    });
  }
});

adminRouter.get('/roles/:id/interview-config', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const roleId = req.params.id;
    const client_id = String(req.query?.client_id || '').trim();
    if (!client_id) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'CLIENT_ID_REQUIRED',
        detail: 'client_id query param is required',
        hint: null,
        request_id
      });
    }

    const { data, error } = await supabaseAdmin
      .from('roles')
      .select('id,client_id,title,tavus_prompt,rubric_questions,rubric,manual_questions')
      .eq('id', roleId)
      .maybeSingle();

    if (error) {
      console.error('[admin/roles/interview-config] fetch failed', {
        request_id,
        role_id: roleId,
        client_id,
        code: error.code,
        message: error.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'FETCH_INTERVIEW_CONFIG_FAILED',
        detail: error.message,
        hint: error.hint || null,
        request_id
      });
    }

    if (!data || String(data.client_id) !== client_id) {
      return res.status(404).json({
        error: 'not_found',
        code: 'ROLE_NOT_FOUND',
        detail: 'Role not found for provided client_id',
        hint: null,
        request_id
      });
    }

    // --- BEGIN: rubric_questions_out computation ---
    const directQuestions = Array.isArray(data.rubric_questions)
      ? data.rubric_questions
          .map((q) => (typeof q === 'string' ? q.trim() : ''))
          .filter(Boolean)
      : [];

    let rubric_questions_out = directQuestions;

    if (!rubric_questions_out.length) {
      const out = [];
      const seen = new Set();
      const add = (value) => {
        const text = typeof value === 'string' ? value.trim() : '';
        if (!text || seen.has(text)) return;
        seen.add(text);
        out.push(text);
      };

      let parsed = data.rubric;
      if (typeof parsed === 'string' && parsed.trim()) {
        try {
          parsed = JSON.parse(parsed);
        } catch (_) {
          parsed = null;
        }
      }

      const parsedQuestions = parsed && typeof parsed === 'object'
        ? (Array.isArray(parsed?.questions) ? parsed.questions : (Array.isArray(parsed) ? parsed : null))
        : null;

      if (Array.isArray(parsedQuestions) && parsedQuestions.length) {
        for (const item of parsedQuestions) {
          if (typeof item === 'string') {
            add(item);
          } else if (item && typeof item === 'object') {
            if (typeof item.question === 'string') add(item.question);
            else if (typeof item.text === 'string') add(item.text);
            else if (typeof item.prompt === 'string') add(item.prompt);
          }
        }
      }

      if (!out.length && typeof data.manual_questions === 'string' && data.manual_questions.trim()) {
        data.manual_questions
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .forEach(add);
      }

      rubric_questions_out = out;
    }
    // --- END: rubric_questions_out computation ---

    return res.json({
      ok: true,
      item: {
        id: data.id,
        client_id: data.client_id,
        title: data.title,
        tavus_prompt: data.tavus_prompt || null,
        rubric_questions: rubric_questions_out
      }
    });
  } catch (e) {
    console.error('[admin/roles/interview-config] unexpected', { request_id, role_id: req.params?.id || null, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'FETCH_INTERVIEW_CONFIG_FAILED',
      detail: e?.message || 'Failed to fetch interview config',
      hint: null,
      request_id
    });
  }
});

adminRouter.patch('/roles/:id/interview-config', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null;
  let responseRubricQuestions;
  let rubricQuestionsEdited = false;
  let updatedRubricForSync = null;
  try {
    const roleId = req.params.id;
    const client_id = String(req.query?.client_id || '').trim();
    if (!client_id) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'CLIENT_ID_REQUIRED',
        detail: 'client_id query param is required',
        hint: null,
        request_id
      });
    }

    const { data: existing, error: existingErr } = await supabaseAdmin
      .from('roles')
      .select('id,client_id,rubric')
      .eq('id', roleId)
      .maybeSingle();

    if (existingErr) {
      console.error('[admin/roles/interview-config] lookup failed', {
        request_id,
        role_id: roleId,
        client_id,
        code: existingErr.code,
        message: existingErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'UPDATE_INTERVIEW_CONFIG_FAILED',
        detail: existingErr.message,
        hint: existingErr.hint || null,
        request_id
      });
    }
    if (!existing || String(existing.client_id) !== client_id) {
      return res.status(404).json({
        error: 'not_found',
        code: 'ROLE_NOT_FOUND',
        detail: 'Role not found for provided client_id',
        hint: null,
        request_id
      });
    }

    const updates = {};

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'tavus_prompt')) {
      const v = req.body.tavus_prompt;
      if (v !== null && typeof v !== 'string') {
        return res.status(400).json({
          error: 'bad_request',
          code: 'INVALID_TAVUS_PROMPT',
          detail: 'tavus_prompt must be a string or null',
          hint: null,
          request_id
        });
      }
      updates.tavus_prompt = v;
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'rubric_questions')) {
      const rq = req.body.rubric_questions;
      responseRubricQuestions = rq;
      if (rq !== null) {
        if (!Array.isArray(rq) || rq.some((q) => typeof q !== 'string')) {
          return res.status(400).json({
            error: 'bad_request',
            code: 'INVALID_RUBRIC_QUESTIONS',
            detail: 'rubric_questions must be null or an array of strings',
            hint: null,
            request_id
          });
        }
        const cleanedQuestions = rq.map((q) => String(q || '').trim()).filter(Boolean);
        const normalizeQuestionKey = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const closedEndedStartRe = /^(do you|are you|did you|have you|can you|will you|would you|were you|is there|is it)\b/i;
        const openEndedContinuationRe = /^(do you|are you|did you|have you|can you|will you|would you|were you|is there|is it)\b[\s,:-]*(please\s+)?(tell me about|walk me through|describe\b|how have you\b|what was your approach to\b|explain\b|share\b|give me an example\b)/i;
        const seenQuestionKeys = new Set();
        for (const question of cleanedQuestions) {
          const key = normalizeQuestionKey(question);
          if (seenQuestionKeys.has(key)) {
            return res.status(400).json({
              error: 'bad_request',
              code: 'INVALID_RUBRIC_QUESTIONS',
              detail: 'rubric_questions contains duplicate questions',
              hint: null,
              request_id
            });
          }
          seenQuestionKeys.add(key);
          if (closedEndedStartRe.test(question) && !openEndedContinuationRe.test(question)) {
            return res.status(400).json({
              error: 'bad_request',
              code: 'INVALID_RUBRIC_QUESTIONS',
              detail: 'rubric_questions must be open-ended and not yes/no style',
              hint: null,
              request_id
            });
          }
        }
        responseRubricQuestions = cleanedQuestions;
        let parsedRubric = null;
        if (typeof existing?.rubric === 'string' && existing.rubric.trim()) {
          try {
            parsedRubric = JSON.parse(existing.rubric);
          } catch {}
        } else if (existing?.rubric && typeof existing.rubric === 'object') {
          parsedRubric = existing.rubric;
        }

        const normalizeQuestion = (value) => String(value || '').trim().toLowerCase();
        const existingCategoryByQuestion = new Map();
        const existingQuestions = Array.isArray(parsedRubric?.questions) ? parsedRubric.questions : [];
        for (const item of existingQuestions) {
          if (!item || typeof item !== 'object') continue;
          const questionText = normalizeQuestion(item.text || item.question || item.prompt);
          if (!questionText) continue;
          const category = typeof item.category === 'string' && item.category.trim() ? item.category : 'Custom';
          if (!existingCategoryByQuestion.has(questionText)) {
            existingCategoryByQuestion.set(questionText, category);
          }
        }

        const newRubricObject = {
          questions: cleanedQuestions.map((q) => ({
            text: q,
            category: existingCategoryByQuestion.get(normalizeQuestion(q)) || 'Custom'
          }))
        };
        updates.rubric = newRubricObject;
        updates.rubric_questions = newRubricObject.questions;
        rubricQuestionsEdited = true;
        updatedRubricForSync = newRubricObject;
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({
        error: 'bad_request',
        code: 'NO_EDITABLE_FIELDS',
        detail: 'No editable fields provided',
        hint: 'Provide tavus_prompt and/or rubric_questions',
        request_id
      });
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from('roles')
      .update(updates)
      .eq('id', roleId)
      .eq('client_id', client_id)
      .select('id,client_id,title,tavus_prompt,rubric')
      .single();

    if (updateErr) {
      console.error('[admin/roles/interview-config] update failed', {
        request_id,
        role_id: roleId,
        client_id,
        code: updateErr.code,
        message: updateErr.message
      });
      return res.status(500).json({
        error: 'server_error',
        code: 'UPDATE_INTERVIEW_CONFIG_FAILED',
        detail: updateErr.message,
        hint: updateErr.hint || null,
        request_id
      });
    }

    if (rubricQuestionsEdited && updatedRubricForSync) {
      try {
        const { data: roleForKbSync, error: roleForKbSyncErr } = await supabaseAdmin
          .from('roles')
          .select('id,title,kb_document_id')
          .eq('id', roleId)
          .eq('client_id', client_id)
          .maybeSingle();

        if (roleForKbSyncErr) throw roleForKbSyncErr;

        if (roleForKbSync?.kb_document_id) {
          const kbJson = makeKBFromRubric(updatedRubricForSync);
          const kbKey = `${roleForKbSync.kb_document_id}.json`;
          const kbPayload = JSON.stringify(kbJson, null, 2);
          let kbUploadError = null;

          const { error: kbUploadErr } = await supabaseAdmin.storage
            .from('kbs')
            .upload(kbKey, new Blob([kbPayload], { type: 'application/json' }), {
              contentType: 'application/json',
              upsert: true
            });
          kbUploadError = kbUploadErr || null;

          if (kbUploadError) {
            const { error: kbUploadErr2 } = await supabaseAdmin.storage
              .from('kbs')
              .upload(kbKey, Buffer.from(kbPayload), {
                contentType: 'application/json',
                upsert: true
              });
            kbUploadError = kbUploadErr2 || null;
          }

          if (kbUploadError) throw kbUploadError;

          await ensureTavusDocumentForRole(
            { id: roleForKbSync.id, title: roleForKbSync.title, kb_document_id: roleForKbSync.kb_document_id },
            { supabase: supabaseAdmin, rubric: updatedRubricForSync, forceRefresh: true }
          );
        }
      } catch (syncErr) {
        console.error('[admin/roles/interview-config] kb_tavus_sync_failed', {
          request_id,
          role_id: roleId,
          client_id,
          error: syncErr?.message || syncErr
        });
      }
    }

    return res.json({
      ok: true,
      item: {
        id: updated.id,
        client_id: updated.client_id,
        title: updated.title,
        tavus_prompt: updated.tavus_prompt || null,
        rubric_questions: responseRubricQuestions === undefined
          ? (() => {
              const questions = Array.isArray(updated?.rubric?.questions) ? updated.rubric.questions : [];
              const out = questions
                .map((item) => {
                  if (!item || typeof item !== 'object') return '';
                  const text = item.text || item.question || item.prompt;
                  return typeof text === 'string' ? text.trim() : '';
                })
                .filter(Boolean);
              return out.length ? out : null;
            })()
          : (Array.isArray(responseRubricQuestions) ? responseRubricQuestions : null)
      }
    });
  } catch (e) {
    console.error('[admin/roles/interview-config] update unexpected', { request_id, role_id: req.params?.id || null, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'UPDATE_INTERVIEW_CONFIG_FAILED',
      detail: e?.message || 'Failed to update interview config',
      hint: null,
      request_id
    });
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
  const { client_id, email, name } = req.body || {}
  const role = (req.body?.role || 'member').toLowerCase()
  const request_id = req.request_id || null
  if (!client_id || !email || !name) return res.status(400).json({ error: 'client_id_email_name_required' })

  let userId = null
  let method = null
  try {
    const ensured = await ensureUserIdAndRecoveryLink(email, buildPublicPwResetUrl(), {
      requireActionLink: true
    })
    userId = ensured?.userId || null
    method = ensured?.method || null
  } catch (e) {
    console.error('[admin/client-members] ensure_recovery_failed', {
      request_id,
      error: e?.message || e,
      code: e?.code,
      status: e?.status || null
    })
    return res.status(500).json({
      error: 'add_member_failed',
      detail: e?.detail || e?.message || 'add_member_failed',
      request_id,
      code: e?.code || 'add_member_failed',
      helper_status: e?.status || null
    })
  }

  if (!userId) {
    console.error('add_member_no_user_id', { email, method })
    return res.status(400).json({
      error: 'add_member_failed',
      detail: 'Could not create or locate user for this email.',
      hint: 'Try again or send the magic link manually.'
    })
  }

  const payload = { client_id, email, name, role, user_id: userId }

  const { data, error } = await supabaseAdmin
    .from('client_members')
    .insert(payload)
    .select('client_id,user_id,email,name,role,created_at')
    .single()

  if (error) {
    console.error('add_member_insert_failed:', error.message)
    return res.status(500).json({ error: 'add_member_failed', detail: error.message })
  }

  const m = data
  res.json({ item: { ...m, id: m.user_id || m.email } })
})

adminRouter.post('/send-password-reset', requireAuth, requireAdmin, async (req, res) => {
  const request_id = req.request_id || null
  const email = String(req.body?.email || '').trim()
  if (!email) return res.status(400).json({ error: 'email_required', request_id })

  try {
    await ensureUserIdAndRecoveryLink(email, buildPublicPwResetUrl(), {
      requireActionLink: true
    })
    return res.json({ ok: true, request_id })
  } catch (e) {
    return res.status(500).json({
      error: 'send_password_reset_failed',
      detail: e?.detail || e?.message || 'send_password_reset_failed',
      request_id,
      code: e?.code || 'send_password_reset_failed',
      helper_error_code: e?.code || null,
      helper_status: e?.status || null
    })
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

// Mount admin sub-routers (Billing + Accommodation Requests)
try {
  adminRouter.use('/billing', requireAuth, requireAdmin, require('./routes/adminBilling'))
} catch (_) {}
try {
  adminRouter.use('/accommodation-requests', requireAuth, requireAdmin, require('./routes/accommodationRequests'))
} catch (_) {}

app.post('/internal/contracts/process-renewals', async (req, res) => {
  const expectedSecret = String(process.env.CONTRACTS_CRON_SECRET || '')
  const providedSecret = String(req.get('x-cron-secret') || '')
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return res.status(403).json({ error: 'forbidden' })
  }
  try {
    const result = await processContractRenewals({
      triggerSource: 'cron',
      requestId: req.request_id || null
    })
    return res.json(result)
  } catch (e) {
    return res.status(500).json({ error: 'process_contracts_failed', detail: e?.detail || e?.message || 'process_contracts_failed' })
  }
})

app.get('/checkout/subscription-success', async (req, res) => {
  const makeAccountSuccessUrl = (clientId, tab) => {
    const params = new URLSearchParams({ checkout: 'success' })
    if (clientId) params.set('client_id', clientId)
    if (tab) params.set('tab', tab)
    return buildClientDashboardReturnUrl(params)
  }
  const fallbackClientId = String(req.query?.client_id || '').trim()
  const fallbackTab = String(req.query?.tab || '').trim().toLowerCase()
  const sessionId = String(req.query?.session_id || '').trim()
  const fallbackUrl = makeAccountSuccessUrl(fallbackClientId, fallbackTab)
  if (!sessionId) {
    console.log('subscription_checkout_success_redirect:', {
      branch: 'missing_session_id',
      target: 'fallback_url'
    })
    return res.redirect(302, fallbackUrl)
  }

  try {
    const Stripe = require('stripe')
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '')
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] })
    const metadata = session?.metadata && typeof session.metadata === 'object' ? session.metadata : {}
    const metadataSource = String(metadata?.source || '').trim().toLowerCase()
    const metadataClientId = String(metadata?.client_id || '').trim()
    const clientId = metadataClientId || fallbackClientId
    const successUrl = makeAccountSuccessUrl(clientId, fallbackTab)
    const paymentStatus = String(session?.payment_status || '').toLowerCase()
    const subscriptionObj = session?.subscription && typeof session.subscription === 'object' ? session.subscription : null
    const subscriptionStatus = String(subscriptionObj?.status || '').toLowerCase()

    console.log('subscription_checkout_success_entry:', {
      client_id: clientId || null,
      fallback_tab: fallbackTab || null,
      metadata_source: metadataSource || null,
      session_status: String(session?.status || '').toLowerCase() || null,
      session_payment_status: paymentStatus || null,
      subscription_status: subscriptionStatus || null
    })

    if (metadataSource !== 'admin_subscription_checkout') {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'metadata_source_mismatch',
        target: 'success_url'
      })
      return res.redirect(302, successUrl)
    }
    if (String(session?.status || '').toLowerCase() !== 'complete') {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'session_incomplete',
        target: 'success_url'
      })
      return res.redirect(302, successUrl)
    }
    if (paymentStatus && !['paid', 'no_payment_required'].includes(paymentStatus)) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'payment_not_paid',
        target: 'success_url'
      })
      return res.redirect(302, successUrl)
    }
    if (subscriptionStatus && !['active', 'trialing'].includes(subscriptionStatus)) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'subscription_not_active',
        target: 'success_url'
      })
      return res.redirect(302, successUrl)
    }

    let client = null
    if (clientId) {
      const { data: clientRow, error: clientErr } = await supabaseAdmin
        .from('clients')
        .select('id,email')
        .eq('id', clientId)
        .maybeSingle()
      if (clientErr) throw new Error(clientErr.message || 'client_lookup_failed')
      client = clientRow || null
    }
    console.log('subscription_checkout_success_client_lookup:', {
      client_id: clientId || null,
      found: !!client?.id,
      has_email: !!String(client?.email || '').trim()
    })
    if (!client?.id) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'client_not_found',
        target: 'success_url'
      })
      return res.redirect(302, successUrl)
    }

    const clientEmail = String(client.email || '').trim()
    if (!clientEmail) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'client_email_missing',
        target: 'success_url'
      })
      return res.redirect(302, successUrl)
    }
    const clientEmailLower = clientEmail.toLowerCase()

    let existingAuthUser = null
    try {
      const { data: authUsersData, error: authUsersError } = await supabaseAdmin.auth.admin.listUsers({ email: clientEmail })
      if (authUsersError) {
        console.error('subscription_checkout_list_users_failed:', authUsersError?.message || authUsersError)
      } else {
        existingAuthUser = (authUsersData?.users || []).find((user) => {
          return String(user?.email || '').trim().toLowerCase() === clientEmailLower
        }) || null
      }
    } catch (listUsersErr) {
      console.error('subscription_checkout_list_users_exception:', listUsersErr?.message || listUsersErr)
    }

    const hasSignedIn = !!String(existingAuthUser?.last_sign_in_at || '').trim()
    console.log('subscription_checkout_success_auth_user_lookup:', {
      matching_user_found: !!existingAuthUser,
      has_last_sign_in_at: hasSignedIn
    })
    if (existingAuthUser && hasSignedIn) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'existing_user_signed_in',
        target: 'success_url'
      })
      return res.redirect(302, successUrl)
    }

    const recoveryRedirectUrl = buildClientPwResetUrl({
      origin: 'client',
      checkout: 'success',
      client_id: client.id
    })
    const generateRecoveryActionLink = async () => {
      const link = await supabaseAdmin.auth.admin.generateLink({
        type: 'recovery',
        email: clientEmail,
        options: { redirectTo: recoveryRedirectUrl }
      })
      return link?.data?.action_link || link?.data?.properties?.action_link || null
    }

    let recoveryActionLink = null
    let createUserAttempted = false
    let retryProducedActionLink = false
    try {
      recoveryActionLink = await generateRecoveryActionLink()
    } catch (recoveryErr) {
      console.error('subscription_checkout_generate_recovery_link_failed:', recoveryErr?.message || recoveryErr)
    }
    console.log('subscription_checkout_success_recovery_first_result:', {
      has_action_link: !!recoveryActionLink
    })

    if (!recoveryActionLink) {
      createUserAttempted = true
      try {
        await supabaseAdmin.auth.admin.createUser({
          email: clientEmail,
          email_confirm: true
        })
      } catch (createErr) {
        const msg = String(createErr?.message || '').toLowerCase()
        if (!msg.includes('already') && !msg.includes('exists')) {
          console.error('subscription_checkout_create_user_failed:', createErr?.message || createErr)
        }
      }
      try {
        recoveryActionLink = await generateRecoveryActionLink()
        retryProducedActionLink = !!recoveryActionLink
      } catch (recoveryRetryErr) {
        console.error('subscription_checkout_generate_recovery_link_retry_failed:', recoveryRetryErr?.message || recoveryRetryErr)
      }
    }

    console.log('subscription_checkout_success_create_user_attempt:', {
      attempted: createUserAttempted
    })
    if (createUserAttempted) {
      console.log('subscription_checkout_success_recovery_retry_result:', {
        has_action_link: retryProducedActionLink
      })
    }

    if (recoveryActionLink) {
      console.log('subscription_checkout_success_redirect:', {
        branch: 'recovery_action_link',
        target: 'recovery_action_link'
      })
      return res.redirect(302, recoveryActionLink)
    }
    const pendingOnboardingUrl = buildPublicPwResetUrl({
      origin: 'client',
      checkout: 'success',
      client_id: client.id,
      onboarding: 'pending'
    })
    console.log('subscription_checkout_success_onboarding_pending_fallback:', {
      client_id: client.id,
      target: 'pending_onboarding_pwreset'
    })
    console.log('subscription_checkout_success_redirect:', {
      branch: 'onboarding_pending_no_recovery_link',
      target: 'pending_onboarding_pwreset'
    })
    return res.redirect(302, pendingOnboardingUrl)
  } catch (e) {
    console.error('subscription_checkout_success_handoff_failed:', e?.message || e)
    console.log('subscription_checkout_success_redirect:', {
      branch: 'handler_exception',
      target: 'fallback_url'
    })
    return res.redirect(302, fallbackUrl)
  }
})

app.use('/admin', adminRouter)

/* ======================= END: Admin guard + Admin API ======================= */

app.use('/kb', require('./routes/kb'))
app.use('/', require('./routes/tavus'))
app.use('/', require('./routes/publicInterviewStatus'))

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

// ---------- Interview host shim (redirect to FE interview-access) ----------
app.get(['/interview-host', '/interview-host/:token'], (req, res) => {
  try {
    const token = req.params.token ? encodeURIComponent(req.params.token) : '';
    const targetPath = token ? `/interview-access/${token}` : '/interview-access';

    // Preserve any query string
    const qsIndex = req.url.indexOf('?');
    const qs = qsIndex >= 0 ? req.url.slice(qsIndex) : '';

    const targetUrl = `${INTERVIEW_APP_BASE}${targetPath}${qs}`;
    return res.redirect(302, targetUrl);
  } catch (e) {
    return res.status(500).type('text/plain').send('redirect_failed');
  }
});
// Pretty link: https://interviews.alphasourceai.com/<token> -> /interview-host/<token>
app.get('/:token', (req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  // Only act on the interviews subdomain; otherwise defer
  if (!isInterviewPrettyLinkHost(host)) return next();

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
// /health remains a lightweight liveness check.
// /healthz is a bounded readiness-ish probe that also tests Supabase Auth reachability.
app.get('/healthz', async (req, res) => {
  const request_id =
    req.request_id ||
    req.headers['x-request-id'] ||
    req.headers['x-correlation-id'] ||
    (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));

  const now = new Date().toISOString();
  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const anonKey = String(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLIC_ANON_KEY || '');

  const supabase_auth = { ok: false, latency_ms: 0 };
  const startedAt = Date.now();

  if (!supabaseUrl || !anonKey || typeof fetch !== 'function' || typeof AbortController !== 'function') {
    supabase_auth.latency_ms = Date.now() - startedAt;
    if (!supabaseUrl) supabase_auth.error = 'Missing SUPABASE_URL';
    else if (!anonKey) supabase_auth.error = 'Missing SUPABASE_ANON_KEY';
    else if (typeof fetch !== 'function') supabase_auth.error = 'fetch unavailable';
    else supabase_auth.error = 'AbortController unavailable';

    return res.json({
      ok: false,
      degraded: true,
      request_id,
      now,
      supabase_auth,
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/health`, {
      method: 'GET',
      headers: { apikey: anonKey },
      signal: controller.signal,
    });

    supabase_auth.ok = true;
    supabase_auth.status = response.status;
  } catch (err) {
    if (err?.name === 'AbortError') {
      supabase_auth.ok = false;
      supabase_auth.timeout = true;
    } else {
      supabase_auth.ok = false;
      supabase_auth.error = err?.message || String(err);
    }
  } finally {
    clearTimeout(timeoutId);
    supabase_auth.latency_ms = Date.now() - startedAt;
  }

  return res.json({
    ok: supabase_auth.ok === true,
    degraded: supabase_auth.ok !== true,
    request_id,
    now,
    supabase_auth,
  });
});

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
