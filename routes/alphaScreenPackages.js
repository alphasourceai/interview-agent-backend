'use strict'

const express = require('express')
const crypto = require('crypto')
const { supabaseAdmin } = require('../src/lib/supabaseClient')
const {
  buildAlphaScreenPackageSnapshot,
  isAlphaScreenBillingCadenceSupported,
  listPublicAlphaScreenPackages,
  normalizeAlphaScreenPlanKey,
  normalizeBillingInterval
} = require('../src/lib/alphaScreenPackages')
const { buildMembershipAgreementSignUrl } = require('../config/urlConfig')
const { htmlToPdf } = require('../utils/pdfRenderer')
const { buildMembershipAgreementHtml } = require('../utils/renderMembershipAgreement')
const { resolvePublicCheckoutReturnState } = require('../src/lib/publicPurchaseActivation')
const { getRequestSubjectKey, hashRateLimitSubject, checkAndIncrementRateLimit } = require('../src/lib/rateLimit')
const { sendRetailSignupEmailVerificationCode } = require('../utils/mailer')
const {
  RETAIL_SMS_CONSENT_COPY_VERSION,
  RetailSmsVerificationError,
  consumeRetailSignupSmsOtp,
  deliverRetailSignupSmsOtp,
  invalidateRetailSmsVerification,
  loadRetailSmsVerificationState,
  normalizeRetailPhone,
  readRetailSmsConfiguration
} = require('../src/lib/retailSmsVerification')

const router = express.Router()
const AGREEMENTS_BUCKET = process.env.SUPABASE_AGREEMENTS_BUCKET || 'agreements'
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RETAIL_RATE_WINDOW_MS = 10 * 60 * 1000
const RETAIL_PURCHASE_INTENT_RATE_MAX = Number(process.env.ALPHASCREEN_PURCHASE_INTENT_RATE_MAX || 12)
const RETAIL_PURCHASE_INTENT_IP_RATE_MAX = Number(process.env.ALPHASCREEN_PURCHASE_INTENT_IP_RATE_MAX || 60)
const RETAIL_CHECKOUT_STATUS_RATE_MAX = Number(process.env.ALPHASCREEN_CHECKOUT_STATUS_RATE_MAX || 60)
const RETAIL_AGREEMENT_RATE_MAX = Number(process.env.ALPHASCREEN_AGREEMENT_RATE_MAX || 10)
const RETAIL_PUBLIC_IP_SAFETY_RATE_MAX = Number(process.env.ALPHASCREEN_PUBLIC_IP_SAFETY_RATE_MAX || 60)
const DUPLICATE_WINDOW_MS = 30 * 60 * 1000
const INTENT_EXPIRATION_MS = 14 * 24 * 60 * 60 * 1000
const SIGNING_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000
const RETAIL_EMAIL_VERIFICATION_TTL_SECONDS = 10 * 60
const RETAIL_EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS = 60
const RETAIL_EMAIL_VERIFICATION_SEND_RATE_MAX = 10
const RETAIL_EMAIL_VERIFICATION_VERIFY_RATE_MAX = 20
const RETAIL_EMAIL_VERIFICATION_STATUS_RATE_MAX = 120
const RETAIL_EMAIL_VERIFICATION_METHOD = 'retail_signup_email_otp_v1'
const RETAIL_SMS_VERIFICATION_TTL_SECONDS = 10 * 60
const RETAIL_SMS_VERIFICATION_RESEND_COOLDOWN_SECONDS = 120
const RETAIL_SMS_VERIFICATION_SEND_RATE_MAX = 10
const RETAIL_SMS_VERIFICATION_VERIFY_RATE_MAX = 20
const RETAIL_SMS_VERIFICATION_STATUS_RATE_MAX = 120
const BLOCKING_PURCHASE_INTENT_STATUSES = ['pending', 'agreement_pending', 'checkout_pending', 'completed']
const BLOCKING_AGREEMENT_STATUSES = ['sent', 'signed']
const SIGNUP_ALREADY_EXISTS_MESSAGE = 'This email is already associated with an alphaScreen account or signup. Sign in, check your email, or contact support for help.'

const RETAIL_VERIFICATION_INTENT_SELECT = [
  'id',
  'status',
  'selected_plan_key',
  'selected_billing_cadence',
  'buyer_email',
  'buyer_phone',
  'email_verified_at',
  'email_verified_address',
  'email_verification_method',
  'email_verification_version',
  'phone_verified_at',
  'phone_verified_destination_fingerprint',
  'phone_verification_method',
  'phone_verification_version',
  'expires_at',
  'agreement_id'
].join(',')

function retailRateLimitSubject(...parts) {
  return `v1:${hashRateLimitSubject('retail', ...parts)}`
}

function sendRateLimitResponse(res, req, { code, detail, retryAfterSeconds }) {
  const retryAfter = Math.max(0, Math.ceil(Number(retryAfterSeconds || 0)))
  if (retryAfter > 0) res.set('Retry-After', String(retryAfter))
  return res.status(429).json({
    error: 'rate_limited',
    code,
    detail,
    retry_after_seconds: retryAfter,
    request_id: req.request_id || null
  })
}

async function enforceRetailRateLimit(req, res, {
  routeName,
  subjectParts,
  maxCount,
  code = 'RETAIL_PUBLIC_RATE_LIMITED',
  detail = 'Please wait before trying again.',
  ipSafetyMax = RETAIL_PUBLIC_IP_SAFETY_RATE_MAX
}) {
  try {
    const primary = await checkAndIncrementRateLimit({
      routeName,
      subjectKey: retailRateLimitSubject(...subjectParts),
      windowMs: RETAIL_RATE_WINDOW_MS,
      maxCount
    })
    if (!primary.allowed) {
      sendRateLimitResponse(res, req, {
        code,
        detail,
        retryAfterSeconds: primary.retryAfterSeconds
      })
      return false
    }

    if (ipSafetyMax > 0) {
      const ipSafety = await checkAndIncrementRateLimit({
        routeName: `${routeName}:ip_safety`,
        subjectKey: retailRateLimitSubject('ip', getRequestSubjectKey(req)),
        windowMs: RETAIL_RATE_WINDOW_MS,
        maxCount: ipSafetyMax
      })
      if (!ipSafety.allowed) {
        sendRateLimitResponse(res, req, {
          code: 'RETAIL_PUBLIC_RATE_LIMITED',
          detail: 'Please wait before trying again.',
          retryAfterSeconds: ipSafety.retryAfterSeconds
        })
        return false
      }
    }
    return true
  } catch (error) {
    console.error('[alphascreen] rate_limit_failed:', error?.code || 'unknown')
    res.status(503).json({
      error: 'retail_signup_unavailable',
      code: 'RETAIL_SIGNUP_UNAVAILABLE',
      request_id: req.request_id || null
    })
    return false
  }
}

function trimText(value, max = 300) {
  return String(value || '').trim().slice(0, max)
}

function cleanPhone(value) {
  const raw = trimText(value, 40)
  return raw ? raw.replace(/[^\d+().\-\s]/g, '').slice(0, 40).trim() : ''
}

function cleanPath(value) {
  const raw = trimText(value, 500)
  if (!raw) return ''
  try {
    const url = new URL(raw, 'https://www.alphasourceai.com')
    return trimText(url.pathname || '/', 300)
  } catch (_) {
    return trimText(raw.split('?')[0].split('#')[0], 300)
  }
}

function cleanLookupId(value) {
  return trimText(value, 200)
}

function readOptionalBoolean(value) {
  if (value === true) return true
  return false
}

function slugify(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug || 'client'
}

function dateOnly(date) {
  const safe = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date()
  return safe.toISOString().slice(0, 10)
}

function addOneYearDateOnly(date) {
  const safe = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date()
  const next = new Date(Date.UTC(safe.getUTCFullYear() + 1, safe.getUTCMonth(), safe.getUTCDate()))
  return next.toISOString().slice(0, 10)
}

function packageNumber(snapshot, ...keys) {
  for (const key of keys) {
    const value = Number(snapshot?.[key])
    if (Number.isFinite(value) && value >= 0) return value
  }
  return null
}

function isValidEmail(value) {
  const email = trimText(value, 254).toLowerCase()
  return EMAIL_RE.test(email)
}

function normalizeEmail(value) {
  return trimText(value, 254).toLowerCase()
}

function generateRetailVerificationCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

function generateRetailVerificationSalt() {
  return crypto.randomBytes(32).toString('hex')
}

function hashRetailVerificationCode(code, salt) {
  return crypto.createHash('sha256').update(`${String(salt || '')}:${String(code || '')}`).digest('hex')
}

function hasValidRetailEmailVerification(intent) {
  const buyerEmail = normalizeEmail(intent?.buyer_email)
  return Boolean(
    buyerEmail &&
    intent?.email_verified_at &&
    normalizeEmail(intent?.email_verified_address) === buyerEmail &&
    String(intent?.email_verification_method || '').trim() === RETAIL_EMAIL_VERIFICATION_METHOD
  )
}

function secondsUntil(value) {
  const timestamp = Date.parse(String(value || ''))
  if (!Number.isFinite(timestamp)) return 0
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000))
}

function resendCooldownForVerification(verification) {
  const sentAt = Date.parse(String(verification?.sent_at || ''))
  if (!Number.isFinite(sentAt)) return 0
  return Math.max(0, RETAIL_EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS - Math.floor((Date.now() - sentAt) / 1000))
}

function publicEmailVerificationState(intent, verification = null, resendCooldownSeconds = null) {
  const verified = hasValidRetailEmailVerification(intent)
  const codeActive = Boolean(
    !verified &&
    verification &&
    !verification.used_at &&
    !verification.invalidated_at &&
    secondsUntil(verification.expires_at) > 0
  )
  const calculatedResendCooldownSeconds = resendCooldownSeconds !== null &&
    resendCooldownSeconds !== undefined &&
    Number.isFinite(Number(resendCooldownSeconds))
    ? Math.max(0, Number(resendCooldownSeconds))
    : resendCooldownForVerification(verification)
  return {
    verified,
    status: verified ? 'verified' : codeActive ? 'code_sent' : 'unverified',
    code_active: codeActive,
    expires_in_seconds: codeActive ? secondsUntil(verification.expires_at) : 0,
    resend_cooldown_seconds: calculatedResendCooldownSeconds
  }
}

async function loadLatestRetailEmailVerification(intentId, buyerEmail) {
  const { data, error } = await supabaseAdmin
    .from('retail_signup_email_verifications')
    .select('id,sent_at,expires_at,used_at,invalidated_at,invalidation_reason,code_salt')
    .eq('purchase_intent_id', intentId)
    .eq('buyer_email', buyerEmail)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return { verification: data || null, error }
}

async function loadRetailEmailVerificationStatus(intentId, buyerEmail) {
  const { data, error } = await supabaseAdmin
    .from('retail_signup_email_verifications')
    .select('id,sent_at,expires_at,used_at,invalidated_at,invalidation_reason')
    .eq('purchase_intent_id', intentId)
    .eq('buyer_email', buyerEmail)
    .order('sent_at', { ascending: false })
    .limit(5)
  const rows = Array.isArray(data) ? data : []
  const verification = rows[0] || null
  const hourlySentAt = rows
    .map((row) => Date.parse(String(row?.sent_at || '')))
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= Date.now() - 60 * 60 * 1000)
    .sort((left, right) => left - right)
  const hourlyCooldownSeconds = hourlySentAt.length >= 5
    ? Math.max(0, Math.ceil(((hourlySentAt[0] + 60 * 60 * 1000) - Date.now()) / 1000))
    : 0
  return {
    verification,
    resendCooldownSeconds: Math.max(resendCooldownForVerification(verification), hourlyCooldownSeconds),
    error
  }
}

function validatePurchaseIntentForEmailVerification(intent) {
  if (!intent) {
    return { ok: false, status: 404, code: 'purchase_intent_not_found', detail: 'Signup request was not found.' }
  }
  if (intent.expires_at) {
    const expiresAt = Date.parse(String(intent.expires_at))
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      return { ok: false, status: 410, code: 'purchase_intent_expired', detail: 'Signup request has expired.' }
    }
  }
  if (String(intent.status || '').trim().toLowerCase() !== 'pending') {
    return { ok: false, status: 409, code: 'purchase_intent_not_eligible', detail: 'Signup request is not eligible for email verification.' }
  }
  if (!isValidEmail(intent.buyer_email)) {
    return { ok: false, status: 409, code: 'purchase_intent_not_eligible', detail: 'Signup request is not eligible for email verification.' }
  }
  return { ok: true }
}

function validatePurchaseIntentForSmsVerification(intent) {
  if (!intent) {
    return { ok: false, status: 404, code: 'purchase_intent_not_found', detail: 'Signup request was not found.' }
  }
  if (intent.expires_at) {
    const expiresAt = Date.parse(String(intent.expires_at))
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      return { ok: false, status: 410, code: 'purchase_intent_expired', detail: 'Signup request has expired.' }
    }
  }
  if (String(intent.status || '').trim().toLowerCase() !== 'pending') {
    return { ok: false, status: 409, code: 'purchase_intent_not_eligible', detail: 'Signup request is not eligible for text verification.' }
  }
  if (!normalizeRetailPhone(intent.buyer_phone)) {
    return { ok: false, status: 409, code: 'RETAIL_SMS_VERIFICATION_INVALID_DESTINATION', detail: 'Text verification requires a valid U.S. mobile number. Choose email instead.' }
  }
  return { ok: true }
}

function publicSmsVerificationState(state = {}) {
  return {
    available: state.available === true,
    verified: state.verified === true,
    status: state.status || 'unverified',
    code_active: state.codeActive === true,
    expires_in_seconds: Number(state.expiresInSeconds || 0),
    resend_cooldown_seconds: Number(state.resendCooldownSeconds || 0)
  }
}

function sendSmsVerificationResponse(res, req, status, options = {}) {
  const retryAfter = Math.max(0, Math.ceil(Number(options.retryAfterSeconds || 0)))
  if (status === 429 && retryAfter > 0) res.set('Retry-After', String(retryAfter))
  return res.status(status).json({
    error: options.error || 'sms_verification_failed',
    code: options.code || 'RETAIL_SMS_VERIFICATION_FAILED',
    detail: options.detail || 'Text verification could not be completed. Choose email or try again.',
    retry_after_seconds: retryAfter,
    request_id: req.request_id || null
  })
}

function sendVerificationResponse(res, req, status, options = {}) {
  const retryAfter = Math.max(0, Math.ceil(Number(options.retryAfterSeconds || 0)))
  if (status === 429 && retryAfter > 0) res.set('Retry-After', String(retryAfter))
  return res.status(status).json({
    error: options.error || 'email_verification_failed',
    code: options.code || 'RETAIL_EMAIL_VERIFICATION_FAILED',
    detail: options.detail || 'Email verification could not be completed. No agreement was created.',
    retry_after_seconds: retryAfter,
    request_id: req.request_id || null
  })
}

function validationError(res, req, code, detail, fields = []) {
  return res.status(400).json({
    error: code,
    code,
    detail,
    fields,
    request_id: req.request_id || null
  })
}

function normalizePurchaseIntentInput(body = {}) {
  const rawPlanKey = trimText(body.plan_key || body.plan || body.selected_plan_key, 40).toLowerCase()
  const rawBillingCadence = trimText(body.billing_cadence || body.billing_interval || body.selected_billing_cadence, 40).toLowerCase()
  const planKey = normalizeAlphaScreenPlanKey(rawPlanKey)
  const billingCadence = normalizeBillingInterval(rawBillingCadence)
  const buyerEmail = trimText(body.buyer_email || body.email, 254).toLowerCase()
  const nestedPrepay = body.first_role_prepay && typeof body.first_role_prepay === 'object'
    ? body.first_role_prepay
    : {}

  return {
    raw_plan_key: rawPlanKey,
    raw_billing_cadence: rawBillingCadence,
    selected_plan_key: planKey,
    selected_billing_cadence: billingCadence,
    company_legal_name: trimText(body.company_legal_name || body.companyLegalName, 160),
    company_dba: trimText(body.company_dba || body.companyDba, 160),
    buyer_first_name: trimText(body.buyer_first_name || body.first_name || body.firstName, 80),
    buyer_last_name: trimText(body.buyer_last_name || body.last_name || body.lastName, 80),
    buyer_email: buyerEmail,
    buyer_phone: cleanPhone(body.buyer_phone || body.phone),
    buyer_title: trimText(body.buyer_title || body.title, 120),
    source_path: cleanPath(body.source_path || body.path),
    first_role_prepay_selected: readOptionalBoolean(
      Object.prototype.hasOwnProperty.call(body, 'first_role_prepay_selected')
        ? body.first_role_prepay_selected
        : nestedPrepay.selected
    ),
    agreement_acknowledged: body.agreement_acknowledged === true,
    contact_acknowledged: body.contact_acknowledged === true
  }
}

function validatePurchaseIntentInput(input) {
  const missing = []
  if (!input.raw_plan_key) missing.push('plan_key')
  if (!input.raw_billing_cadence) missing.push('billing_cadence')
  if (!input.company_legal_name) missing.push('company_legal_name')
  if (!input.buyer_first_name) missing.push('buyer_first_name')
  if (!input.buyer_last_name) missing.push('buyer_last_name')
  if (!input.buyer_email) missing.push('buyer_email')
  if (!input.buyer_phone) missing.push('buyer_phone')
  if (!input.buyer_title) missing.push('buyer_title')
  if (!input.agreement_acknowledged) missing.push('agreement_acknowledged')
  if (!input.contact_acknowledged) missing.push('contact_acknowledged')
  if (missing.length) {
    return {
      ok: false,
      code: 'required_fields_missing',
      detail: 'Required signup fields are missing.',
      fields: missing
    }
  }
  if (!['basic', 'pro'].includes(input.selected_plan_key)) {
    return { ok: false, code: 'invalid_plan', detail: 'Plan must be basic or pro.', fields: ['plan_key'] }
  }
  if (!input.selected_billing_cadence) {
    return {
      ok: false,
      code: 'invalid_billing_cadence',
      detail: 'Billing cadence is not supported for this plan.',
      fields: ['billing_cadence']
    }
  }
  if (!isAlphaScreenBillingCadenceSupported(input.selected_plan_key, input.selected_billing_cadence)) {
    return {
      ok: false,
      code: 'invalid_billing_cadence',
      detail: 'Billing cadence is not supported for this plan.',
      fields: ['billing_cadence']
    }
  }
  if (!isValidEmail(input.buyer_email)) {
    return { ok: false, code: 'invalid_email', detail: 'A valid email is required.', fields: ['buyer_email'] }
  }
  return { ok: true }
}

function safePackageSummary(snapshot = {}) {
  return {
    plan_key: snapshot.plan_key || null,
    display_name: snapshot.display_name || null,
    billing_cadence: snapshot.billing_cadence || null,
    platform_fee: snapshot.platform_fee ?? null,
    platform_fee_cents: snapshot.platform_fee_cents ?? null,
    platform_fee_billing_cadence: snapshot.platform_fee_billing_cadence || snapshot.billing_cadence || null,
    platform_monthly_fee: snapshot.platform_monthly_fee ?? null,
    platform_monthly_fee_cents: snapshot.platform_monthly_fee_cents ?? null,
    platform_annual_fee: snapshot.platform_annual_fee ?? null,
    platform_annual_fee_cents: snapshot.platform_annual_fee_cents ?? null,
    annual_platform_fee_note: snapshot.annual_platform_fee_note || null,
    included_interviews: snapshot.included_interviews ?? null,
    included_interviews_per_role: snapshot.included_interviews_per_role ?? null,
    interview_duration_minutes: snapshot.interview_duration_minutes ?? null,
    max_interview_minutes: snapshot.max_interview_minutes ?? null,
    scored_question_count: snapshot.scored_question_count ?? null,
    additional_interview_price: snapshot.additional_interview_price ?? null,
    additional_interview_fee: snapshot.additional_interview_fee ?? null,
    overage_price: snapshot.overage_price ?? null,
    per_role_fee: snapshot.per_role_fee ?? null,
    first_role_prepay: snapshot.first_role_prepay && typeof snapshot.first_role_prepay === 'object'
      ? {
          enabled: snapshot.first_role_prepay.enabled === true,
          selected: snapshot.first_role_prepay.selected === true,
          credit_type: snapshot.first_role_prepay.credit_type || null,
          normal_role_fee_cents: snapshot.first_role_prepay.normal_role_fee_cents ?? null,
          discounted_credit_amount_cents: snapshot.first_role_prepay.discounted_credit_amount_cents ?? null,
          discount_percent: snapshot.first_role_prepay.discount_percent ?? null,
          non_refundable: snapshot.first_role_prepay.non_refundable === true,
          expires: snapshot.first_role_prepay.expires === true
        }
      : null
  }
}

function purchaseIntentPrepayColumns(packageSnapshot = {}) {
  const prepay = packageSnapshot.first_role_prepay && typeof packageSnapshot.first_role_prepay === 'object'
    ? packageSnapshot.first_role_prepay
    : null
  if (!prepay?.selected) {
    return {
      first_role_prepay_selected: false,
      first_role_prepay_amount_cents: null,
      first_role_normal_role_fee_cents: null,
      first_role_prepay_discount_percent: null,
      first_role_prepay_credit_type: null
    }
  }
  return {
    first_role_prepay_selected: true,
    first_role_prepay_amount_cents: Number(prepay.discounted_credit_amount_cents),
    first_role_normal_role_fee_cents: Number(prepay.normal_role_fee_cents),
    first_role_prepay_discount_percent: Number(prepay.discount_percent),
    first_role_prepay_credit_type: prepay.credit_type || 'first_role_prepay'
  }
}

function buildPurchaseIntentResponse(row, { duplicate = false } = {}) {
  const snapshot = row?.package_snapshot && typeof row.package_snapshot === 'object' ? row.package_snapshot : {}
  return {
    purchase_intent_id: row?.id || null,
    status: row?.status || 'pending',
    duplicate,
    selected_package: safePackageSummary(snapshot),
    email_verification: publicEmailVerificationState(row),
    sms_verification: {
      available: readRetailSmsConfiguration(process.env).valid && Boolean(normalizeRetailPhone(row?.buyer_phone)),
      verified: false,
      status: 'unverified',
      code_active: false,
      expires_in_seconds: 0,
      resend_cooldown_seconds: 0
    },
    next_step_message: duplicate
      ? 'A signup request already exists for this company and package. The next step is membership agreement preparation.'
      : 'Signup request received. The next step is membership agreement preparation.',
    request_id: row?.request_id || null
  }
}

function duplicateSignupResponse(res, req, reason = 'signup_exists') {
  return res.status(409).json({
    error: 'signup_already_exists',
    code: 'SIGNUP_ALREADY_EXISTS',
    detail: SIGNUP_ALREADY_EXISTS_MESSAGE,
    message: SIGNUP_ALREADY_EXISTS_MESSAGE,
    next_step: reason === 'active_member'
      ? 'sign_in_or_contact_support'
      : 'check_email_or_contact_support',
    request_id: req.request_id || null
  })
}

function clientLooksActive(client) {
  if (!client) return true
  if (String(client.archived_at || '').trim()) return false
  return true
}

async function findSignupConflictByEmail(email) {
  const buyerEmail = trimText(email, 254).toLowerCase()
  if (!buyerEmail) return { conflict: null, error: null }

  const { data: existingMember, error: memberErr } = await supabaseAdmin
    .from('client_members')
    .select('client_id,email,role')
    .eq('email', buyerEmail)
    .limit(1)
    .maybeSingle()

  if (memberErr) return { conflict: null, error: memberErr }

  if (existingMember?.client_id) {
    const { data: client, error: clientErr } = await supabaseAdmin
      .from('clients')
      .select('id,archived_at')
      .eq('id', existingMember.client_id)
      .maybeSingle()

    if (clientErr) return { conflict: null, error: clientErr }
    if (clientLooksActive(client)) {
      return { conflict: { reason: 'active_member' }, error: null }
    }
  }

  const { data: existingIntent, error: intentErr } = await supabaseAdmin
    .from('public_purchase_intents')
    .select('id,status,agreement_id,client_id,created_at')
    .eq('buyer_email', buyerEmail)
    .in('status', BLOCKING_PURCHASE_INTENT_STATUSES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (intentErr) return { conflict: null, error: intentErr }
  if (existingIntent?.id) {
    const status = String(existingIntent.status || '').trim().toLowerCase()
    return {
      conflict: { reason: status === 'completed' ? 'paid_setup_pending' : 'purchase_in_progress' },
      error: null
    }
  }

  const { data: existingAgreement, error: agreementErr } = await supabaseAdmin
    .from('membership_agreements')
    .select('id,status,checkout_status,client_id,created_at')
    .eq('admin_email', buyerEmail)
    .in('status', BLOCKING_AGREEMENT_STATUSES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (agreementErr) return { conflict: null, error: agreementErr }
  if (existingAgreement?.id) {
    const checkoutStatus = String(existingAgreement.checkout_status || '').trim().toLowerCase()
    return {
      conflict: { reason: checkoutStatus === 'paid' ? 'paid_setup_pending' : 'agreement_in_progress' },
      error: null
    }
  }

  return { conflict: null, error: null }
}

function signingPathFromUrl(signingUrl) {
  const raw = String(signingUrl || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    return parsed.pathname || raw
  } catch (_) {
    return raw
  }
}

function buildAgreementResponse(intent, agreement, signingUrl, { refreshed = false } = {}) {
  const snapshot = intent?.package_snapshot && typeof intent.package_snapshot === 'object' ? intent.package_snapshot : {}
  return {
    ok: true,
    purchase_intent_id: intent?.id || null,
    status: intent?.status || 'agreement_pending',
    agreement: {
      id: agreement?.id || null,
      status: agreement?.status || 'sent',
      signing_url: signingUrl || null,
      signing_path: signingPathFromUrl(signingUrl) || null,
      expires_at: agreement?.signer_token_expires_at || null,
      refreshed: refreshed === true,
      selected_package: safePackageSummary(snapshot)
    },
    next_step_message: 'Membership agreement is ready for review and signature. Payment and account setup happen after signing in later steps.'
  }
}

function validatePurchaseIntentForAgreement(intent) {
  if (!intent) {
    return { ok: false, status: 404, code: 'purchase_intent_not_found', detail: 'Signup request was not found.' }
  }
  const status = String(intent.status || '').trim().toLowerCase()
  if (intent.expires_at) {
    const expiresAt = Date.parse(String(intent.expires_at))
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      return { ok: false, status: 410, code: 'purchase_intent_expired', detail: 'Signup request has expired.' }
    }
  }
  if (!['pending', 'agreement_pending'].includes(status)) {
    return { ok: false, status: 409, code: 'purchase_intent_not_eligible', detail: 'Signup request is not eligible for agreement preparation.' }
  }
  const snapshot = intent.package_snapshot && typeof intent.package_snapshot === 'object' ? intent.package_snapshot : null
  if (!snapshot || !snapshot.plan_key || !snapshot.billing_cadence) {
    return { ok: false, status: 409, code: 'package_snapshot_missing', detail: 'Signup request package snapshot is missing.' }
  }
  const planKey = normalizeAlphaScreenPlanKey(snapshot.plan_key)
  const billingCadence = normalizeBillingInterval(snapshot.billing_cadence)
  if (!['basic', 'pro'].includes(planKey) || !billingCadence) {
    return { ok: false, status: 409, code: 'package_snapshot_invalid', detail: 'Signup request package snapshot is invalid.' }
  }
  return { ok: true, planKey, billingCadence, snapshot }
}

function buildAgreementInputFromPurchaseIntent(intent) {
  const snapshot = intent?.package_snapshot && typeof intent.package_snapshot === 'object' ? intent.package_snapshot : {}
  const now = new Date()
  const firstName = trimText(intent?.buyer_first_name, 80)
  const lastName = trimText(intent?.buyer_last_name, 80)
  const adminName = trimText(`${firstName} ${lastName}`, 170) || trimText(intent?.buyer_email, 254)
  const includedInterviews = packageNumber(snapshot, 'included_interviews_per_role', 'included_interviews')
  const interviewDuration = packageNumber(snapshot, 'max_interview_minutes', 'interview_duration_minutes')
  const additionalInterviewFee = packageNumber(snapshot, 'additional_interview_fee', 'additional_interview_price', 'overage_price')
  const perRoleFee = packageNumber(snapshot, 'per_role_fee')
  const billingOption = normalizeBillingInterval(snapshot.billing_cadence || intent?.selected_billing_cadence)
  const platformFee = packageNumber(snapshot, 'platform_fee') ??
    (billingOption === 'annual'
      ? packageNumber(snapshot, 'platform_annual_fee')
      : packageNumber(snapshot, 'platform_monthly_fee'))

  return {
    client_id: null,
    client_legal_name: trimText(intent?.company_legal_name, 160),
    dba_trade_name: trimText(intent?.company_dba, 160) || trimText(intent?.company_legal_name, 160),
    primary_admin_name: adminName,
    admin_email: trimText(intent?.buyer_email, 254).toLowerCase(),
    membership_tier: normalizeAlphaScreenPlanKey(snapshot.plan_key),
    platform_fee: platformFee,
    per_role_fee: perRoleFee,
    first_role_prepay: snapshot.first_role_prepay && typeof snapshot.first_role_prepay === 'object'
      ? { ...snapshot.first_role_prepay }
      : null,
    additional_interview_fee: additionalInterviewFee,
    included_interviews_per_role: includedInterviews,
    max_interview_minutes: interviewDuration,
    initial_term_start: dateOnly(now),
    initial_renewal_date: addOneYearDateOnly(now),
    billing_option: billingOption,
    auto_renew: true,
    notice_deadline_days: 30
  }
}

function validateAgreementInput(input) {
  const missing = []
  if (!input.client_legal_name) missing.push('company_legal_name')
  if (!input.primary_admin_name) missing.push('buyer_name')
  if (!isValidEmail(input.admin_email)) missing.push('buyer_email')
  if (!input.membership_tier) missing.push('plan_key')
  if (!input.billing_option) missing.push('billing_cadence')
  if (!input.included_interviews_per_role) missing.push('included_interviews')
  if (!input.max_interview_minutes) missing.push('interview_duration_minutes')
  if (input.platform_fee === null || input.platform_fee === undefined) missing.push('platform_fee')
  if (input.additional_interview_fee === null || input.additional_interview_fee === undefined) missing.push('additional_interview_fee')
  if (input.per_role_fee === null || input.per_role_fee === undefined) missing.push('per_role_fee')
  if (missing.length) {
    return {
      ok: false,
      status: 409,
      code: 'agreement_values_missing',
      detail: 'Signup request is missing agreement package values.',
      fields: missing
    }
  }
  return { ok: true }
}

async function refreshAgreementSigningUrl(agreement) {
  const signerToken = crypto.randomBytes(32).toString('hex')
  const signerTokenHash = crypto.createHash('sha256').update(signerToken).digest('hex')
  const signerTokenExpiresAt = new Date(Date.now() + SIGNING_LINK_TTL_MS).toISOString()
  const signingUrl = buildMembershipAgreementSignUrl(signerToken)

  const { data, error } = await supabaseAdmin
    .from('membership_agreements')
    .update({
      signer_token_hash: signerTokenHash,
      signer_token_expires_at: signerTokenExpiresAt,
      updated_at: new Date().toISOString()
    })
    .eq('id', agreement.id)
    .eq('status', 'sent')
    .select('id,status,signer_token_expires_at,draft_pdf_path,sent_at')
    .single()

  if (error) {
    const err = new Error(error.message || 'agreement_token_refresh_failed')
    err.code = error.code || 'agreement_token_refresh_failed'
    err.status = 500
    throw err
  }

  return { agreement: data || agreement, signingUrl }
}

router.get('/packages', (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  return res.json({
    packages: listPublicAlphaScreenPackages(),
    request_id: req.request_id || null
  })
})

router.get('/checkout-status', async (req, res) => {
  const request_id = req.request_id || null
  const sessionId = cleanLookupId(req.query?.session_id)
  const agreementId = cleanLookupId(req.query?.agreement_id)
  const fallbackClientId = cleanLookupId(req.query?.client_id)

  if (!sessionId && !agreementId && !fallbackClientId) {
    return res.status(400).json({
      error: 'checkout_lookup_required',
      code: 'checkout_lookup_required',
      detail: 'Checkout session, agreement, or client reference is required.',
      request_id
    })
  }

  const allowed = await enforceRetailRateLimit(req, res, {
    routeName: 'retail_checkout_status',
    subjectParts: ['checkout_status', sessionId || agreementId || fallbackClientId],
    maxCount: RETAIL_CHECKOUT_STATUS_RATE_MAX
  })
  if (!allowed) return

  try {
    const state = await resolvePublicCheckoutReturnState({
      sessionId,
      agreementId,
      fallbackClientId
    })

    return res.json({
      ok: true,
      status: state?.status || 'payment_pending',
      client_id: state?.client_id || null,
      password_setup_required: state?.password_setup_required === true,
      direct_setup_available: state?.direct_setup_available === true,
      set_password_url: state?.set_password_url || null,
      setup_email_sent: state?.setup_email_sent === true,
      request_id
    })
  } catch (e) {
    console.error('[alphascreen/checkout-status] unexpected:', e?.message || e)
    return res.status(500).json({
      error: 'checkout_status_failed',
      code: 'checkout_status_failed',
      detail: 'Checkout status could not be loaded.',
      request_id
    })
  }
})

router.post('/purchase-intents', async (req, res) => {
  const request_id = req.request_id || null
  try {
    const input = normalizePurchaseIntentInput(req.body || {})
    const validation = validatePurchaseIntentInput(input)
    if (!validation.ok) {
      return validationError(res, req, validation.code, validation.detail, validation.fields)
    }

    const allowed = await enforceRetailRateLimit(req, res, {
      routeName: 'retail_purchase_intent_create',
      subjectParts: ['purchase_intent', getRequestSubjectKey(req), input.buyer_email],
      maxCount: RETAIL_PURCHASE_INTENT_RATE_MAX,
      ipSafetyMax: RETAIL_PURCHASE_INTENT_IP_RATE_MAX,
      code: 'RETAIL_SIGNUP_RATE_LIMITED',
      detail: 'Too many signup attempts were made from this browser or network. Try again later.'
    })
    if (!allowed) return

    const packageSnapshot = buildAlphaScreenPackageSnapshot(input.selected_plan_key, input.selected_billing_cadence, {
      firstRolePrepaySelected: input.first_role_prepay_selected
    })
    if (!packageSnapshot) {
      return validationError(
        res,
        req,
        'package_snapshot_unavailable',
        'Package configuration is not available for this selection.',
        ['plan_key', 'billing_cadence']
      )
    }

    const duplicateCutoff = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString()
    const { data: existingIntent, error: duplicateErr } = await supabaseAdmin
      .from('public_purchase_intents')
      .select('id,status,selected_plan_key,selected_billing_cadence,package_snapshot,first_role_prepay_selected,first_role_prepay_amount_cents,first_role_normal_role_fee_cents,first_role_prepay_discount_percent,first_role_prepay_credit_type,buyer_phone,email_verified_at,email_verified_address,email_verification_method,email_verification_version,phone_verified_at,phone_verified_destination_fingerprint,phone_verification_method,phone_verification_version,created_at')
      .eq('buyer_email', input.buyer_email)
      .eq('company_legal_name', input.company_legal_name)
      .eq('selected_plan_key', input.selected_plan_key)
      .eq('selected_billing_cadence', input.selected_billing_cadence)
      .eq('first_role_prepay_selected', input.first_role_prepay_selected === true)
      .in('status', ['pending'])
      .gte('created_at', duplicateCutoff)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (duplicateErr) {
      console.error('[alphascreen/purchase-intents] duplicate_lookup_failed:', duplicateErr.message || duplicateErr)
      return res.status(503).json({
        error: 'purchase_intent_lookup_failed',
        code: 'PURCHASE_INTENT_LOOKUP_FAILED',
        request_id
      })
    }

    if (existingIntent?.id) {
      let reusableIntent = existingIntent
      if (trimText(existingIntent.buyer_phone, 40) !== input.buyer_phone) {
        const { data: updatedIntent, error: updateErr } = await supabaseAdmin
          .from('public_purchase_intents')
          .update({
            buyer_phone: input.buyer_phone,
            updated_at: new Date().toISOString()
          })
          .eq('id', existingIntent.id)
          .eq('status', 'pending')
          .select('id,status,selected_plan_key,selected_billing_cadence,package_snapshot,first_role_prepay_selected,first_role_prepay_amount_cents,first_role_normal_role_fee_cents,first_role_prepay_discount_percent,first_role_prepay_credit_type,buyer_phone,email_verified_at,email_verified_address,email_verification_method,email_verification_version,phone_verified_at,phone_verified_destination_fingerprint,phone_verification_method,phone_verification_version,created_at')
          .maybeSingle()

        if (updateErr || !updatedIntent?.id) {
          console.error('[alphascreen/purchase-intents] duplicate_phone_sync_failed:', updateErr?.message || 'intent_not_pending')
          return res.status(409).json({
            error: 'purchase_intent_not_reusable',
            code: 'PURCHASE_INTENT_NOT_REUSABLE',
            detail: 'This signup request changed while it was being updated. Start again to continue safely.',
            request_id
          })
        }
        reusableIntent = updatedIntent
      }

      const body = buildPurchaseIntentResponse(reusableIntent, { duplicate: true })
      body.request_id = request_id
      return res.status(200).json(body)
    }

    const signupConflict = await findSignupConflictByEmail(input.buyer_email)
    if (signupConflict.error) {
      console.error('[alphascreen/purchase-intents] signup_conflict_lookup_failed:', signupConflict.error.message || signupConflict.error)
      return res.status(503).json({
        error: 'purchase_intent_lookup_failed',
        code: 'PURCHASE_INTENT_LOOKUP_FAILED',
        request_id
      })
    }
    if (signupConflict.conflict) {
      return duplicateSignupResponse(res, req, signupConflict.conflict.reason)
    }

    const nowIso = new Date().toISOString()
    const prepayColumns = purchaseIntentPrepayColumns(packageSnapshot)
    const insertPayload = {
      status: 'pending',
      selected_plan_key: input.selected_plan_key,
      selected_billing_cadence: input.selected_billing_cadence,
      package_snapshot: packageSnapshot,
      ...prepayColumns,
      company_legal_name: input.company_legal_name,
      company_dba: input.company_dba || null,
      buyer_first_name: input.buyer_first_name,
      buyer_last_name: input.buyer_last_name,
      buyer_email: input.buyer_email,
      buyer_phone: input.buyer_phone || null,
      buyer_title: input.buyer_title || null,
      source_path: input.source_path || null,
      agreement_id: null,
      stripe_checkout_session_id: null,
      client_id: null,
      expires_at: new Date(Date.now() + INTENT_EXPIRATION_MS).toISOString(),
      created_at: nowIso,
      updated_at: nowIso
    }

    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('public_purchase_intents')
      .insert(insertPayload)
      .select('id,status,selected_plan_key,selected_billing_cadence,package_snapshot,first_role_prepay_selected,first_role_prepay_amount_cents,first_role_normal_role_fee_cents,first_role_prepay_discount_percent,first_role_prepay_credit_type,buyer_phone,email_verified_at,email_verified_address,email_verification_method,email_verification_version,phone_verified_at,phone_verified_destination_fingerprint,phone_verification_method,phone_verification_version,created_at')
      .single()

    if (insertErr) {
      console.error('[alphascreen/purchase-intents] insert_failed:', insertErr.message || insertErr)
      return res.status(503).json({
        error: 'purchase_intent_create_failed',
        code: 'PURCHASE_INTENT_CREATE_FAILED',
        request_id
      })
    }

    const body = buildPurchaseIntentResponse(inserted, { duplicate: false })
    body.request_id = request_id
    return res.status(201).json(body)
  } catch (e) {
    console.error('[alphascreen/purchase-intents] unexpected:', e?.message || e)
    return res.status(500).json({
      error: 'server_error',
      code: 'SERVER_ERROR',
      request_id
    })
  }
})

router.get('/purchase-intents/:id/email-verification/status', async (req, res) => {
  const request_id = req.request_id || null
  const intentId = trimText(req.params?.id, 80)
  if (!UUID_RE.test(intentId)) {
    return sendVerificationResponse(res, req, 400, {
      code: 'purchase_intent_id_required',
      detail: 'A valid signup reference is required.'
    })
  }

  try {
    const { data: intent, error } = await supabaseAdmin
      .from('public_purchase_intents')
      .select(RETAIL_VERIFICATION_INTENT_SELECT)
      .eq('id', intentId)
      .maybeSingle()

    if (error) {
      console.error('[alphascreen/email-verification] status_lookup_failed:', error?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }

    const validation = validatePurchaseIntentForEmailVerification(intent)
    if (!validation.ok) {
      return sendVerificationResponse(res, req, validation.status, {
        code: validation.code,
        detail: validation.detail
      })
    }

    const buyerEmail = normalizeEmail(intent.buyer_email)
    const allowed = await enforceRetailRateLimit(req, res, {
      routeName: 'retail_email_verification_status',
      subjectParts: ['email_verification_status', intent.id, getRequestSubjectKey(req)],
      maxCount: RETAIL_EMAIL_VERIFICATION_STATUS_RATE_MAX
    })
    if (!allowed) return

    const {
      verification,
      resendCooldownSeconds,
      error: verificationError
    } = await loadRetailEmailVerificationStatus(intent.id, buyerEmail)
    if (verificationError) {
      console.error('[alphascreen/email-verification] status_verification_lookup_failed:', verificationError?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }

    return res.json({
      ok: true,
      email_verification: publicEmailVerificationState(intent, verification, resendCooldownSeconds),
      request_id
    })
  } catch (error) {
    console.error('[alphascreen/email-verification] status_failed:', error?.code || 'unknown')
    return sendVerificationResponse(res, req, 500)
  }
})

router.post('/purchase-intents/:id/email-verification/send', async (req, res) => {
  const request_id = req.request_id || null
  const intentId = trimText(req.params?.id, 80)
  if (!UUID_RE.test(intentId)) {
    return sendVerificationResponse(res, req, 400, {
      code: 'purchase_intent_id_required',
      detail: 'A valid signup reference is required.'
    })
  }

  try {
    const { data: intent, error: intentError } = await supabaseAdmin
      .from('public_purchase_intents')
      .select(RETAIL_VERIFICATION_INTENT_SELECT)
      .eq('id', intentId)
      .maybeSingle()

    if (intentError) {
      console.error('[alphascreen/email-verification] send_lookup_failed:', intentError?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }

    const validation = validatePurchaseIntentForEmailVerification(intent)
    if (!validation.ok) {
      return sendVerificationResponse(res, req, validation.status, {
        code: validation.code,
        detail: validation.detail
      })
    }

    const buyerEmail = normalizeEmail(intent.buyer_email)
    const allowed = await enforceRetailRateLimit(req, res, {
      routeName: 'retail_email_verification_send',
      subjectParts: ['email_verification_send', intent.id, buyerEmail],
      maxCount: RETAIL_EMAIL_VERIFICATION_SEND_RATE_MAX
    })
    if (!allowed) return

    const { verification: latestVerification, error: latestVerificationError } = await loadLatestRetailEmailVerification(intent.id, buyerEmail)
    if (latestVerificationError) {
      console.error('[alphascreen/email-verification] send_verification_lookup_failed:', latestVerificationError?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }

    if (hasValidRetailEmailVerification(intent)) {
      return res.json({
        ok: true,
        email_verification: publicEmailVerificationState(intent, latestVerification),
        request_id
      })
    }

    try {
      await invalidateRetailSmsVerification(supabaseAdmin, intent.id, 'channel_changed_to_email')
    } catch (error) {
      console.error('[alphascreen/email-verification] sms_supersede_failed:', error?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }

    const verificationCode = generateRetailVerificationCode()
    const verificationSalt = generateRetailVerificationSalt()
    const verificationHash = hashRetailVerificationCode(verificationCode, verificationSalt)
    const { data: issuedRows, error: issueError } = await supabaseAdmin.rpc('issue_retail_signup_email_verification', {
      p_purchase_intent_id: intent.id,
      p_buyer_email: buyerEmail,
      p_plan_key: intent.selected_plan_key,
      p_billing_cadence: intent.selected_billing_cadence,
      p_code_hash: verificationHash,
      p_code_salt: verificationSalt
    })
    const issued = Array.isArray(issuedRows) ? issuedRows[0] : issuedRows

    if (issueError || !issued?.status) {
      console.error('[alphascreen/email-verification] issue_failed:', issueError?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }
    if (issued.status === 'resend_cooldown') {
      return sendVerificationResponse(res, req, 429, {
        code: 'RETAIL_EMAIL_VERIFICATION_COOLDOWN',
        detail: 'Please wait before requesting another code.',
        retryAfterSeconds: Number(issued.resend_after_seconds || RETAIL_EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS)
      })
    }
    if (issued.status === 'hourly_limit') {
      return sendVerificationResponse(res, req, 429, {
        code: 'RETAIL_EMAIL_VERIFICATION_SEND_LIMIT',
        detail: 'Too many verification codes were requested. Try again later.',
        retryAfterSeconds: Number(issued.resend_after_seconds || 60 * 60)
      })
    }
    if (issued.status !== 'issued' || !issued.verification_id) {
      return sendVerificationResponse(res, req, 409, {
        code: 'RETAIL_EMAIL_VERIFICATION_NOT_ELIGIBLE'
      })
    }

    try {
      const delivery = await sendRetailSignupEmailVerificationCode(buyerEmail, verificationCode, {
        purchaseIntentId: intent.id,
        verificationId: issued.verification_id
      })
      if (delivery?.skipped) throw new Error('email_delivery_not_configured')
    } catch (error) {
      await supabaseAdmin
        .from('retail_signup_email_verifications')
        .update({
          invalidated_at: new Date().toISOString(),
          invalidation_reason: 'delivery_failed',
          updated_at: new Date().toISOString()
        })
        .eq('id', issued.verification_id)
        .is('used_at', null)
      console.error('[alphascreen/email-verification] send_failed:', error?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, {
        code: 'RETAIL_EMAIL_VERIFICATION_SEND_FAILED',
        detail: 'We couldn\'t send the verification code. Try again in a moment.'
      })
    }

    return res.status(202).json({
      ok: true,
      email_verification: {
        verified: false,
        status: 'code_sent',
        code_active: true,
        expires_in_seconds: RETAIL_EMAIL_VERIFICATION_TTL_SECONDS,
        resend_cooldown_seconds: Number(issued.resend_after_seconds || RETAIL_EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS)
      },
      request_id
    })
  } catch (error) {
    console.error('[alphascreen/email-verification] send_unexpected:', error?.code || 'unknown')
    return sendVerificationResponse(res, req, 500)
  }
})

router.post('/purchase-intents/:id/email-verification/verify', async (req, res) => {
  const request_id = req.request_id || null
  const intentId = trimText(req.params?.id, 80)
  const code = trimText(req.body?.code, 12)
  if (!UUID_RE.test(intentId)) {
    return sendVerificationResponse(res, req, 400, {
      code: 'purchase_intent_id_required',
      detail: 'A valid signup reference is required.'
    })
  }
  if (!/^\d{6}$/.test(code)) {
    return sendVerificationResponse(res, req, 400, {
      code: 'RETAIL_EMAIL_VERIFICATION_INVALID_CODE',
      detail: 'That code is not valid. Check the code and try again.'
    })
  }

  try {
    const { data: intent, error: intentError } = await supabaseAdmin
      .from('public_purchase_intents')
      .select(RETAIL_VERIFICATION_INTENT_SELECT)
      .eq('id', intentId)
      .maybeSingle()

    if (intentError) {
      console.error('[alphascreen/email-verification] verify_lookup_failed:', intentError?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }

    const validation = validatePurchaseIntentForEmailVerification(intent)
    if (!validation.ok) {
      return sendVerificationResponse(res, req, validation.status, {
        code: validation.code,
        detail: validation.detail
      })
    }
    if (hasValidRetailEmailVerification(intent)) {
      return res.json({ ok: true, email_verification: publicEmailVerificationState(intent), request_id })
    }

    const buyerEmail = normalizeEmail(intent.buyer_email)
    const { verification, error: verificationError } = await loadLatestRetailEmailVerification(intent.id, buyerEmail)

    if (verificationError) {
      console.error('[alphascreen/email-verification] verify_token_lookup_failed:', verificationError?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }

    const allowed = await enforceRetailRateLimit(req, res, {
      routeName: 'retail_email_verification_verify',
      subjectParts: ['email_verification_verify', intent.id, verification?.id || 'no_active_verification', buyerEmail],
      maxCount: RETAIL_EMAIL_VERIFICATION_VERIFY_RATE_MAX
    })
    if (!allowed) return

    if (!verification?.code_salt) {
      return sendVerificationResponse(res, req, 400, {
        code: 'RETAIL_EMAIL_VERIFICATION_INVALID_CODE',
        detail: 'That code is not valid. Check the code and try again.'
      })
    }

    const { data: consumedRows, error: consumeError } = await supabaseAdmin.rpc('consume_retail_signup_email_verification', {
      p_purchase_intent_id: intent.id,
      p_buyer_email: buyerEmail,
      p_code_hash: hashRetailVerificationCode(code, verification.code_salt)
    })
    const consumed = Array.isArray(consumedRows) ? consumedRows[0] : consumedRows
    const consumeStatus = String(consumed?.status || '').trim()

    if (consumeError || !consumeStatus) {
      console.error('[alphascreen/email-verification] consume_failed:', consumeError?.code || 'unknown')
      return sendVerificationResponse(res, req, 503, { code: 'RETAIL_EMAIL_VERIFICATION_UNAVAILABLE' })
    }
    if (consumeStatus === 'verified') {
      return res.json({
        ok: true,
        email_verification: {
          verified: true,
          status: 'verified',
          code_active: false,
          expires_in_seconds: 0,
          resend_cooldown_seconds: 0
        },
        request_id
      })
    }
    if (consumeStatus === 'expired') {
      return sendVerificationResponse(res, req, 400, {
        code: 'RETAIL_EMAIL_VERIFICATION_EXPIRED',
        detail: 'That code has expired. Request a new code.'
      })
    }
    if (consumeStatus === 'attempt_limit') {
      return sendVerificationResponse(res, req, 429, {
        code: 'RETAIL_EMAIL_VERIFICATION_ATTEMPTS_EXCEEDED',
        detail: 'Too many unsuccessful attempts. Request a new code.'
      })
    }
    return sendVerificationResponse(res, req, 400, {
      code: 'RETAIL_EMAIL_VERIFICATION_INVALID_CODE',
      detail: 'That code is not valid. Check the code and try again.'
    })
  } catch (error) {
    console.error('[alphascreen/email-verification] verify_unexpected:', error?.code || 'unknown')
    return sendVerificationResponse(res, req, 500)
  }
})

router.get('/purchase-intents/:id/sms-verification/status', async (req, res) => {
  const request_id = req.request_id || null
  const intentId = trimText(req.params?.id, 80)
  if (!UUID_RE.test(intentId)) {
    return sendSmsVerificationResponse(res, req, 400, {
      code: 'purchase_intent_id_required',
      detail: 'A valid signup reference is required.'
    })
  }

  try {
    const { data: intent, error } = await supabaseAdmin
      .from('public_purchase_intents')
      .select(RETAIL_VERIFICATION_INTENT_SELECT)
      .eq('id', intentId)
      .maybeSingle()
    if (error) {
      console.error('[alphascreen/sms-verification] status_lookup_failed:', error?.code || 'unknown')
      return sendSmsVerificationResponse(res, req, 503, { code: 'RETAIL_SMS_VERIFICATION_UNAVAILABLE' })
    }

    const validation = validatePurchaseIntentForSmsVerification(intent)
    if (!validation.ok) {
      return sendSmsVerificationResponse(res, req, validation.status, {
        code: validation.code,
        detail: validation.detail
      })
    }

    const allowed = await enforceRetailRateLimit(req, res, {
      routeName: 'retail_sms_verification_status',
      subjectParts: ['sms_verification_status', intent.id, getRequestSubjectKey(req)],
      maxCount: RETAIL_SMS_VERIFICATION_STATUS_RATE_MAX
    })
    if (!allowed) return

    const config = readRetailSmsConfiguration(process.env)
    if (!config.valid) {
      return res.json({
        ok: true,
        sms_verification: publicSmsVerificationState({ available: false }),
        request_id
      })
    }
    const state = await loadRetailSmsVerificationState(supabaseAdmin, intent, process.env)
    return res.json({ ok: true, sms_verification: publicSmsVerificationState(state), request_id })
  } catch (error) {
    console.error('[alphascreen/sms-verification] status_failed:', error?.code || 'unknown')
    return sendSmsVerificationResponse(res, req, 503, { code: 'RETAIL_SMS_VERIFICATION_UNAVAILABLE' })
  }
})

router.post('/purchase-intents/:id/sms-verification/send', async (req, res) => {
  const request_id = req.request_id || null
  const intentId = trimText(req.params?.id, 80)
  const consentCopyVersion = trimText(req.body?.consent_copy_version, 80)
  let providerSendStartedAtMs = null
  if (!UUID_RE.test(intentId)) {
    return sendSmsVerificationResponse(res, req, 400, {
      code: 'purchase_intent_id_required',
      detail: 'A valid signup reference is required.'
    })
  }
  if (consentCopyVersion !== RETAIL_SMS_CONSENT_COPY_VERSION) {
    return sendSmsVerificationResponse(res, req, 400, {
      code: 'RETAIL_SMS_CONSENT_REQUIRED',
      detail: 'Select Text Message and review the text-message disclosure before requesting a code.'
    })
  }

  try {
    const { data: intent, error } = await supabaseAdmin
      .from('public_purchase_intents')
      .select(RETAIL_VERIFICATION_INTENT_SELECT)
      .eq('id', intentId)
      .maybeSingle()
    if (error) {
      console.error('[alphascreen/sms-verification] send_lookup_failed:', error?.code || 'unknown')
      return sendSmsVerificationResponse(res, req, 503, { code: 'RETAIL_SMS_VERIFICATION_UNAVAILABLE' })
    }

    const validation = validatePurchaseIntentForSmsVerification(intent)
    if (!validation.ok) {
      return sendSmsVerificationResponse(res, req, validation.status, {
        code: validation.code,
        detail: validation.detail
      })
    }

    const allowed = await enforceRetailRateLimit(req, res, {
      routeName: 'retail_sms_verification_send',
      subjectParts: ['sms_verification_send', intent.id],
      maxCount: RETAIL_SMS_VERIFICATION_SEND_RATE_MAX
    })
    if (!allowed) return

    const current = await loadRetailSmsVerificationState(supabaseAdmin, intent, process.env)
    if (current.verified) {
      return res.json({ ok: true, sms_verification: publicSmsVerificationState(current), request_id })
    }

    providerSendStartedAtMs = Date.now()
    const result = await deliverRetailSignupSmsOtp({
      db: supabaseAdmin,
      intent,
      requestIp: getRequestSubjectKey(req),
      consentCopyVersion,
      env: process.env
    })
    console.info('[alphascreen/sms-verification] send_outcome', {
      outcome: result.outcome || 'unknown',
      provider_status: result.status || null,
      request_duration_ms: Math.max(0, Date.now() - providerSendStartedAtMs),
      retry_attempted: result.retryAttempted === true,
      failover_attempted: result.failoverAttempted === true
    })
    if (result.outcome !== 'accepted') {
      if (result.outcome === 'invalid_destination') {
        return sendSmsVerificationResponse(res, req, 409, {
          code: 'RETAIL_SMS_VERIFICATION_INVALID_DESTINATION',
          detail: 'Text verification requires a valid U.S. mobile number. Choose email instead.'
        })
      }
      if (result.outcome === 'blocked_destination') {
        return sendSmsVerificationResponse(res, req, 409, {
          code: 'RETAIL_SMS_VERIFICATION_BLOCKED',
          detail: 'Text verification is unavailable for this number. Choose email instead.'
        })
      }
      return sendSmsVerificationResponse(res, req, 503, {
        code: result.outcome === 'ambiguous_outcome'
          ? 'RETAIL_SMS_VERIFICATION_SEND_UNCERTAIN'
          : 'RETAIL_SMS_VERIFICATION_SEND_FAILED',
        detail: 'We could not confirm text delivery. Choose email or try again.'
      })
    }

    return res.status(202).json({
      ok: true,
      sms_verification: {
        available: true,
        verified: false,
        status: 'code_sent',
        code_active: true,
        expires_in_seconds: RETAIL_SMS_VERIFICATION_TTL_SECONDS,
        resend_cooldown_seconds: Number(result.retryAfterSeconds || RETAIL_SMS_VERIFICATION_RESEND_COOLDOWN_SECONDS)
      },
      request_id
    })
  } catch (error) {
    if (error instanceof RetailSmsVerificationError) {
      if (error.code === 'RETAIL_SMS_VERIFICATION_COOLDOWN') {
        return sendSmsVerificationResponse(res, req, 429, {
          code: error.code,
          detail: 'Please wait before requesting another code.',
          retryAfterSeconds: error.retryAfterSeconds
        })
      }
      if (error.code === 'RETAIL_SMS_VERIFICATION_SEND_LIMIT') {
        return sendSmsVerificationResponse(res, req, 429, {
          code: error.code,
          detail: 'Too many verification codes were requested. Choose email or try again later.',
          retryAfterSeconds: error.retryAfterSeconds
        })
      }
    }
    console.error('[alphascreen/sms-verification] send_failed:', {
      code: error?.code || 'unknown',
      request_duration_ms: providerSendStartedAtMs === null ? null : Math.max(0, Date.now() - providerSendStartedAtMs)
    })
    return sendSmsVerificationResponse(res, req, 503, { code: 'RETAIL_SMS_VERIFICATION_UNAVAILABLE' })
  }
})

router.post('/purchase-intents/:id/sms-verification/verify', async (req, res) => {
  const request_id = req.request_id || null
  const intentId = trimText(req.params?.id, 80)
  const code = trimText(req.body?.code, 12)
  if (!UUID_RE.test(intentId)) {
    return sendSmsVerificationResponse(res, req, 400, {
      code: 'purchase_intent_id_required',
      detail: 'A valid signup reference is required.'
    })
  }
  if (!/^\d{6}$/.test(code)) {
    return sendSmsVerificationResponse(res, req, 400, {
      code: 'RETAIL_SMS_VERIFICATION_INVALID_CODE',
      detail: 'That code is not valid. Check the code and try again.'
    })
  }

  try {
    const { data: intent, error } = await supabaseAdmin
      .from('public_purchase_intents')
      .select(RETAIL_VERIFICATION_INTENT_SELECT)
      .eq('id', intentId)
      .maybeSingle()
    if (error) {
      console.error('[alphascreen/sms-verification] verify_lookup_failed:', error?.code || 'unknown')
      return sendSmsVerificationResponse(res, req, 503, { code: 'RETAIL_SMS_VERIFICATION_UNAVAILABLE' })
    }

    const validation = validatePurchaseIntentForSmsVerification(intent)
    if (!validation.ok) {
      return sendSmsVerificationResponse(res, req, validation.status, {
        code: validation.code,
        detail: validation.detail
      })
    }
    const allowed = await enforceRetailRateLimit(req, res, {
      routeName: 'retail_sms_verification_verify',
      subjectParts: ['sms_verification_verify', intent.id],
      maxCount: RETAIL_SMS_VERIFICATION_VERIFY_RATE_MAX
    })
    if (!allowed) return

    const current = await loadRetailSmsVerificationState(supabaseAdmin, intent, process.env)
    if (current.verified) {
      return res.json({ ok: true, sms_verification: publicSmsVerificationState(current), request_id })
    }
    const consumed = await consumeRetailSignupSmsOtp({ db: supabaseAdmin, intent, code, env: process.env })
    if (consumed.status === 'verified') {
      return res.json({
        ok: true,
        sms_verification: {
          available: true,
          verified: true,
          status: 'verified',
          code_active: false,
          expires_in_seconds: 0,
          resend_cooldown_seconds: 0
        },
        request_id
      })
    }
    if (consumed.status === 'expired') {
      return sendSmsVerificationResponse(res, req, 400, {
        code: 'RETAIL_SMS_VERIFICATION_EXPIRED',
        detail: 'That code has expired. Request a new code.'
      })
    }
    if (consumed.status === 'attempt_limit') {
      return sendSmsVerificationResponse(res, req, 429, {
        code: 'RETAIL_SMS_VERIFICATION_ATTEMPTS_EXCEEDED',
        detail: 'Too many unsuccessful attempts. Request a new code.'
      })
    }
    return sendSmsVerificationResponse(res, req, 400, {
      code: 'RETAIL_SMS_VERIFICATION_INVALID_CODE',
      detail: 'That code is not valid. Check the code and try again.'
    })
  } catch (error) {
    console.error('[alphascreen/sms-verification] verify_failed:', error?.code || 'unknown')
    return sendSmsVerificationResponse(res, req, 503, { code: 'RETAIL_SMS_VERIFICATION_UNAVAILABLE' })
  }
})

router.post('/purchase-intents/:id/agreement', async (req, res) => {
  const request_id = req.request_id || null
  const intentId = trimText(req.params?.id, 80)
  if (!UUID_RE.test(intentId)) {
    return res.status(400).json({
      error: 'purchase_intent_id_required',
      code: 'purchase_intent_id_required',
      detail: 'A valid signup reference is required.',
      request_id
    })
  }

  const allowed = await enforceRetailRateLimit(req, res, {
    routeName: 'retail_agreement_create',
    subjectParts: ['agreement_create', intentId],
    maxCount: RETAIL_AGREEMENT_RATE_MAX
  })
  if (!allowed) return

  try {
    const { data: intent, error: intentErr } = await supabaseAdmin
      .from('public_purchase_intents')
      .select('id,status,selected_plan_key,selected_billing_cadence,package_snapshot,first_role_prepay_selected,first_role_prepay_amount_cents,first_role_normal_role_fee_cents,first_role_prepay_discount_percent,first_role_prepay_credit_type,company_legal_name,company_dba,buyer_first_name,buyer_last_name,buyer_email,buyer_phone,buyer_title,source_path,agreement_id,stripe_checkout_session_id,client_id,email_verified_at,email_verified_address,email_verification_method,email_verification_version,phone_verified_at,phone_verified_destination_fingerprint,phone_verification_method,phone_verification_version,expires_at,created_at')
      .eq('id', intentId)
      .maybeSingle()

    if (intentErr) {
      console.error('[alphascreen/purchase-intents/agreement] intent_lookup_failed:', intentErr.message || intentErr)
      return res.status(503).json({
        error: 'purchase_intent_lookup_failed',
        code: intentErr.code || 'purchase_intent_lookup_failed',
        request_id
      })
    }

    const intentValidation = validatePurchaseIntentForAgreement(intent)
    if (!intentValidation.ok) {
      return res.status(intentValidation.status).json({
        error: intentValidation.code,
        code: intentValidation.code,
        detail: intentValidation.detail,
        request_id
      })
    }

    let existingAgreement = null
    if (intent.agreement_id) {
      const { data, error: existingErr } = await supabaseAdmin
        .from('membership_agreements')
        .select('id,status,signer_token_expires_at,draft_pdf_path,sent_at')
        .eq('id', intent.agreement_id)
        .maybeSingle()

      if (existingErr) {
        console.error('[alphascreen/purchase-intents/agreement] existing_agreement_lookup_failed:', existingErr.message || existingErr)
        return res.status(503).json({
          error: 'agreement_lookup_failed',
          code: existingErr.code || 'agreement_lookup_failed',
          request_id
        })
      }

      existingAgreement = data
    }

    let contactVerified = hasValidRetailEmailVerification(intent)
    if (!contactVerified) {
      try {
        const smsState = await loadRetailSmsVerificationState(supabaseAdmin, intent, process.env)
        contactVerified = smsState.verified === true
      } catch (error) {
        console.error('[alphascreen/purchase-intents/agreement] sms_verification_lookup_failed:', error?.code || 'unknown')
      }
    }

    if (!contactVerified) {
      if (existingAgreement && String(existingAgreement.status || '').trim().toLowerCase() === 'signed') {
        return res.status(409).json({
          error: 'agreement_not_signable',
          code: 'agreement_not_signable',
          detail: 'The linked agreement is not available for signing.',
          request_id
        })
      }
      return res.status(409).json({
        error: 'retail_contact_verification_required',
        code: 'RETAIL_CONTACT_VERIFICATION_REQUIRED',
        detail: 'Verify the buyer by email or text message before continuing to the membership agreement.',
        request_id
      })
    }

    if (existingAgreement) {
      if (existingAgreement && String(existingAgreement.status || '').trim().toLowerCase() === 'sent') {
        const refreshed = await refreshAgreementSigningUrl(existingAgreement)
        const responseIntent = { ...intent, status: 'agreement_pending' }
        const body = buildAgreementResponse(responseIntent, refreshed.agreement, refreshed.signingUrl, { refreshed: true })
        body.request_id = request_id
        return res.json(body)
      }

      if (existingAgreement) {
        return res.status(409).json({
          error: 'agreement_not_signable',
          code: 'agreement_not_signable',
          detail: 'The linked agreement is not available for signing.',
          request_id
        })
      }
    }

    const agreementInput = buildAgreementInputFromPurchaseIntent(intent)
    const agreementInputValidation = validateAgreementInput(agreementInput)
    if (!agreementInputValidation.ok) {
      return res.status(agreementInputValidation.status).json({
        error: agreementInputValidation.code,
        code: agreementInputValidation.code,
        detail: agreementInputValidation.detail,
        fields: agreementInputValidation.fields,
        request_id
      })
    }

    const { html, normalized } = buildMembershipAgreementHtml(agreementInput, { showPackageTerms: true })
    const pdf = await htmlToPdf(html, {
      format: 'Letter',
      margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' }
    })

    const agreementId = crypto.randomUUID()
    const clientSlug = slugify(normalized.client_legal_name)
    const draftPdfPath = `membership-agreements/${agreementId}/${clientSlug}-draft.pdf`

    const upload = await supabaseAdmin
      .storage
      .from(AGREEMENTS_BUCKET)
      .upload(draftPdfPath, pdf, {
        contentType: 'application/pdf',
        upsert: true
      })

    if (upload.error) {
      console.error('[alphascreen/purchase-intents/agreement] draft_upload_failed:', upload.error.message || upload.error)
      return res.status(500).json({
        error: 'draft_upload_failed',
        code: upload.error.code || 'draft_upload_failed',
        detail: upload.error.message || 'Agreement draft could not be stored.',
        request_id
      })
    }

    const signerToken = crypto.randomBytes(32).toString('hex')
    const signerTokenHash = crypto.createHash('sha256').update(signerToken).digest('hex')
    const signerTokenExpiresAt = new Date(Date.now() + SIGNING_LINK_TTL_MS).toISOString()
    const signingUrl = buildMembershipAgreementSignUrl(signerToken)
    const nowIso = new Date().toISOString()
    const templateSnapshot = {
      template_name: 'membership-agreement',
      template_version: 'membership_agreement_v2_phase1',
      source: 'public_purchase_intent',
      source_document: 'alphaScreen Membership Agreementv2.docx',
      generated_at: nowIso,
      purchase_intent: {
        id: intent.id,
        source_path: intent.source_path || null,
        selected_plan_key: intent.selected_plan_key,
        selected_billing_cadence: intent.selected_billing_cadence,
        first_role_prepay_selected: intent.first_role_prepay_selected === true
      },
      package_snapshot: intentValidation.snapshot,
      values: normalized,
      rendered_html: html
    }

    const { data: insertedAgreement, error: insertErr } = await supabaseAdmin
      .from('membership_agreements')
      .insert({
        id: agreementId,
        client_id: null,
        status: 'sent',
        client_legal_name: normalized.client_legal_name,
        dba_trade_name: normalized.dba_trade_name || null,
        primary_admin_name: normalized.primary_admin_name,
        admin_email: normalized.admin_email,
        membership_tier: normalized.membership_tier,
        initial_term_start: normalized.initial_term_start,
        initial_renewal_date: normalized.initial_renewal_date,
        billing_option: normalized.billing_option,
        auto_renew: normalized.auto_renew,
        notice_deadline_days: normalized.notice_deadline_days,
        template_version: 'membership_agreement_v2_phase1',
        template_snapshot: templateSnapshot,
        draft_pdf_path: draftPdfPath,
        signer_token_hash: signerTokenHash,
        signer_token_expires_at: signerTokenExpiresAt,
        sent_at: nowIso,
        created_by_user_id: null,
        created_by_email: 'public_purchase_intent'
      })
      .select('id,status,signer_token_expires_at,draft_pdf_path,sent_at')
      .single()

    if (insertErr) {
      console.error('[alphascreen/purchase-intents/agreement] agreement_insert_failed:', insertErr.message || insertErr)
      return res.status(503).json({
        error: 'agreement_create_failed',
        code: insertErr.code || 'agreement_create_failed',
        request_id
      })
    }

    const { data: updatedIntent, error: updateErr } = await supabaseAdmin
      .from('public_purchase_intents')
      .update({
        status: 'agreement_pending',
        agreement_id: agreementId,
        updated_at: nowIso
      })
      .eq('id', intent.id)
      .select('id,status,package_snapshot,agreement_id')
      .single()

    if (updateErr) {
      console.error('[alphascreen/purchase-intents/agreement] intent_update_failed:', updateErr.message || updateErr)
      return res.status(503).json({
        error: 'purchase_intent_agreement_link_failed',
        code: updateErr.code || 'purchase_intent_agreement_link_failed',
        request_id
      })
    }

    const body = buildAgreementResponse(
      { ...intent, ...(updatedIntent || {}), package_snapshot: intent.package_snapshot },
      insertedAgreement,
      signingUrl
    )
    body.request_id = request_id
    return res.status(201).json(body)
  } catch (e) {
    console.error('[alphascreen/purchase-intents/agreement] unexpected:', e?.message || e)
    return res.status(Number(e?.status) || 500).json({
      error: e?.code || 'server_error',
      code: e?.code || 'server_error',
      detail: e?.message || 'Server error',
      request_id
    })
  }
})

router._test = {
  normalizePurchaseIntentInput,
  validatePurchaseIntentInput,
  safePackageSummary,
  buildPurchaseIntentResponse,
  buildAgreementInputFromPurchaseIntent,
  validatePurchaseIntentForAgreement,
  validatePurchaseIntentForEmailVerification,
  generateRetailVerificationCode,
  hashRetailVerificationCode,
  hasValidRetailEmailVerification
}

module.exports = router
