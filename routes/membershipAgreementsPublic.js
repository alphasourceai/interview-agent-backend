'use strict';

const express = require('express');
const crypto = require('crypto');
const { supabaseAdmin } = require('../src/lib/supabaseClient');
const { requireParentClient, resolveBillingOwnerForScope } = require('../src/lib/clientBillingScope');
const { canViewLegalBillingForClient } = require('../src/lib/clientScope');
const { buildMembershipAgreementSignUrl } = require('../config/urlConfig');
const { requireAuth, withClientScope } = require('../src/middleware/auth');
const { htmlToPdf } = require('../utils/pdfRenderer');
const {
  buildMembershipAgreementHtml,
  normalizeMembershipAgreementInput
} = require('../utils/renderMembershipAgreement');
const {
  sendMembershipAgreementSignedCopyEmail,
  sendMembershipAgreementCompletedInternalNotification
} = require('../utils/mailer');
const { createSubscriptionCheckoutSession } = require('../src/lib/subscriptionCheckout');
const {
  normalizeAlphaScreenPlanKey,
  normalizeBillingInterval,
  getAlphaScreenPlatformFee,
  getAlphaScreenFirstRolePrepayConfig
} = require('../src/lib/alphaScreenPackages');

const router = express.Router();

const AGREEMENTS_BUCKET = process.env.SUPABASE_AGREEMENTS_BUCKET || 'agreements';
const MEMBERSHIP_INTERNAL_NOTIFY_EMAIL = 'memberships@alphasourceai.com';
const SIGNED_URL_TTL_SECONDS = Math.max(60, Number(process.env.SIGNED_URL_TTL_SECONDS || 600));
const EMAIL_SIGNED_URL_TTL_SECONDS = Math.max(300, Number(process.env.AGREEMENT_SIGNED_EMAIL_LINK_TTL_SECONDS || 604800));
const PUBLIC_TOKEN_RATE_WINDOW_MS = 10 * 60 * 1000;
const PUBLIC_TOKEN_RATE_MAX = Number(process.env.MEMBERSHIP_AGREEMENT_PUBLIC_TOKEN_RATE_MAX || 60);
const publicAgreementTokenRateBuckets = new Map();

function getRequestIp(req) {
  return String((req.headers['x-forwarded-for'] || req.ip || 'unknown')).split(',')[0].trim() || 'unknown';
}

function publicAgreementTokenRateLimit(req, res, next) {
  const now = Date.now();
  const routeKey = `${req.method || 'POST'}:${req.path || req.originalUrl || 'membership-agreement'}`;
  const subject = `${getRequestIp(req)}:${routeKey}`;
  const current = publicAgreementTokenRateBuckets.get(subject);
  const bucket = (!current || current.resetAt <= now)
    ? { count: 0, resetAt: now + PUBLIC_TOKEN_RATE_WINDOW_MS }
    : current;
  bucket.count += 1;
  publicAgreementTokenRateBuckets.set(subject, bucket);
  if (bucket.count > PUBLIC_TOKEN_RATE_MAX) {
    return res.status(429).json({
      error: 'rate_limited',
      code: 'RATE_LIMIT_EXCEEDED',
      detail: 'Too many requests. Please try again later.',
      request_id: req.request_id || null
    });
  }
  return next();
}

function extractErrorMessage(text, fallback) {
  const raw = String(text || '').trim();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    const detail = parsed?.detail || parsed?.message || parsed?.error;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
  } catch (_) {}
  return raw;
}

function makeCheckoutError(status, code, detail, hint) {
  const err = new Error(detail || code || 'checkout_failed');
  err.status = Number(status) || 500;
  err.code = String(code || 'checkout_failed');
  err.hint = hint || null;
  return err;
}

function readToken(req) {
  return String(req.body?.token || '').trim();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function slugify(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'client';
}

function normalizeAccepted(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function wantsEmbeddedCheckout(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  if (value === true) return true;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'embedded';
}

function appendQueryParam(url, key, value) {
  const raw = String(url || '').trim();
  if (!raw) return raw;
  const separator = raw.includes('?') ? '&' : '?';
  return `${raw}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();

  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0];
    if (first && first.trim()) return first.trim();
  }

  if (Array.isArray(xff) && xff.length > 0) {
    const first = String(xff[0] || '').trim();
    if (first) return first;
  }

  return String(req.ip || '').trim() || null;
}

function parseSignaturePayload(raw) {
  const source = String(raw || '').trim();
  if (!source) {
    const err = new Error('signature_required');
    err.code = 'signature_required';
    throw err;
  }

  const match = source.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) {
    const err = new Error('signature_invalid');
    err.code = 'signature_invalid';
    throw err;
  }

  const mimeRaw = String(match[1] || '').toLowerCase();
  const mime = mimeRaw === 'image/jpg' ? 'image/jpeg' : mimeRaw;
  const base64 = String(match[2] || '').replace(/\s+/g, '');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) {
    const err = new Error('signature_invalid');
    err.code = 'signature_invalid';
    throw err;
  }
  if (buffer.length > 2 * 1024 * 1024) {
    const err = new Error('signature_too_large');
    err.code = 'signature_too_large';
    throw err;
  }

  const ext = mime === 'image/png'
    ? 'png'
    : mime === 'image/webp'
      ? 'webp'
      : 'jpg';

  return {
    mime,
    ext,
    base64,
    buffer,
    dataUrl: `data:${mime};base64,${base64}`
  };
}

function isExpired(isoTime) {
  if (!isoTime) return false;
  const ts = Date.parse(String(isoTime));
  if (!Number.isFinite(ts)) return false;
  return ts <= Date.now();
}

function validateSignableAgreement(row) {
  if (!row) {
    return {
      ok: false,
      status: 404,
      code: 'token_invalid',
      detail: 'This signing link is invalid.'
    };
  }

  if (String(row.status || '').toLowerCase() !== 'sent') {
    return {
      ok: false,
      status: 409,
      code: 'agreement_not_signable',
      detail: 'This agreement is no longer available for signing.'
    };
  }

  if (isExpired(row.signer_token_expires_at)) {
    return {
      ok: false,
      status: 410,
      code: 'token_expired',
      detail: 'This signing link has expired.'
    };
  }

  return { ok: true };
}

async function requireParentAgreementClient(agreement, context) {
  return requireParentClient(supabaseAdmin, agreement?.client_id, context);
}

function isPublicPurchaseIntentAgreement(agreement) {
  const snapshot = agreement?.template_snapshot && typeof agreement.template_snapshot === 'object'
    ? agreement.template_snapshot
    : null;
  return String(snapshot?.source || '').trim() === 'public_purchase_intent';
}

function publicPurchaseIntentIdFromAgreement(agreement) {
  const snapshot = agreement?.template_snapshot && typeof agreement.template_snapshot === 'object'
    ? agreement.template_snapshot
    : null;
  return String(snapshot?.purchase_intent?.id || '').trim();
}

function packageSnapshotFromAgreement(agreement) {
  const snapshot = agreement?.template_snapshot && typeof agreement.template_snapshot === 'object'
    ? agreement.template_snapshot
    : null;
  const packageSnapshot = snapshot?.package_snapshot && typeof snapshot.package_snapshot === 'object'
    ? snapshot.package_snapshot
    : null;
  return packageSnapshot || null;
}

function packageNumber(snapshot, ...keys) {
  for (const key of keys) {
    const n = Number(snapshot?.[key]);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function firstRolePrepaySnapshot(packageSnapshot) {
  return packageSnapshot?.first_role_prepay && typeof packageSnapshot.first_role_prepay === 'object'
    ? packageSnapshot.first_role_prepay
    : null;
}

function buildFirstRolePrepayCheckout(packageSnapshot) {
  const prepay = firstRolePrepaySnapshot(packageSnapshot);
  if (!prepay?.selected) return null;
  return {
    selected: true,
    credit_type: prepay.credit_type || 'first_role_prepay',
    amount_cents: Number(prepay.discounted_credit_amount_cents),
    normal_role_fee_cents: Number(prepay.normal_role_fee_cents),
    discount_percent: Number(prepay.discount_percent)
  };
}

function buildPublicAgreementCheckoutMetadata({ agreement, agreementInput, intent, packageSnapshot }) {
  const planTier = normalizeAlphaScreenPlanKey(packageSnapshot?.plan_key || agreementInput?.membership_tier);
  const billingInterval = normalizeBillingInterval(packageSnapshot?.billing_cadence || agreementInput?.billing_option);
  const firstRolePrepay = buildFirstRolePrepayCheckout(packageSnapshot);
  const metadata = {
    agreement_id: agreement.id,
    purchase_intent_id: intent?.id || undefined,
    public_purchase_intent_id: intent?.id || undefined,
    membership_agreement_id: agreement.id,
    agreement_checkout: 'true',
    checkout_status: 'pending_payment',
    package_plan_key: planTier,
    package_billing_cadence: billingInterval,
    platform_fee: packageNumber(packageSnapshot, 'platform_fee'),
    per_role_fee: packageNumber(packageSnapshot, 'per_role_fee'),
    included_interviews_per_role: packageNumber(packageSnapshot, 'included_interviews_per_role', 'included_interviews'),
    additional_interview_fee: packageNumber(packageSnapshot, 'additional_interview_fee', 'additional_interview_price', 'overage_price'),
    max_interview_minutes: packageNumber(packageSnapshot, 'max_interview_minutes', 'interview_duration_minutes')
  };
  if (firstRolePrepay?.selected) {
    metadata.first_role_prepay_selected = 'true';
    metadata.first_role_prepay_credit_type = firstRolePrepay.credit_type;
    metadata.first_role_prepay_amount_cents = firstRolePrepay.amount_cents;
    metadata.first_role_prepay_normal_role_fee_cents = firstRolePrepay.normal_role_fee_cents;
    metadata.first_role_prepay_discount_percent = firstRolePrepay.discount_percent;
  }
  return metadata;
}

function validatePublicPurchaseIntentForCheckout({ agreement, agreementInput, intent }) {
  if (!intent) {
    throw makeCheckoutError(404, 'purchase_intent_not_found', 'Signup request was not found.');
  }

  const status = String(intent.status || '').trim().toLowerCase();
  if (!['agreement_pending', 'checkout_pending'].includes(status)) {
    throw makeCheckoutError(409, 'purchase_intent_not_checkout_eligible', 'Signup request is not eligible for checkout.');
  }

  const agreementId = String(agreement?.id || '').trim();
  const intentAgreementId = String(intent.agreement_id || '').trim();
  if (!intentAgreementId || intentAgreementId !== agreementId) {
    throw makeCheckoutError(409, 'purchase_intent_agreement_mismatch', 'Signup request is not linked to this agreement.');
  }

  const packageSnapshot = packageSnapshotFromAgreement(agreement);
  if (!packageSnapshot) {
    throw makeCheckoutError(409, 'package_snapshot_missing', 'Agreement package snapshot is missing.');
  }

  const planTier = normalizeAlphaScreenPlanKey(agreementInput?.membership_tier);
  const billingInterval = normalizeBillingInterval(agreementInput?.billing_option);
  const snapshotPlan = normalizeAlphaScreenPlanKey(packageSnapshot.plan_key);
  const snapshotBilling = normalizeBillingInterval(packageSnapshot.billing_cadence);
  const intentPlan = normalizeAlphaScreenPlanKey(intent.selected_plan_key);
  const intentBilling = normalizeBillingInterval(intent.selected_billing_cadence);

  if (!['basic', 'pro'].includes(planTier) || !['basic', 'pro'].includes(snapshotPlan) || !['basic', 'pro'].includes(intentPlan)) {
    throw makeCheckoutError(409, 'invalid_agreement_plan', 'Agreement plan tier is invalid for checkout.');
  }
  if (!billingInterval || !snapshotBilling || !intentBilling) {
    throw makeCheckoutError(409, 'invalid_agreement_billing_interval', 'Agreement billing interval is invalid for checkout.');
  }
  if (planTier !== snapshotPlan || planTier !== intentPlan || billingInterval !== snapshotBilling || billingInterval !== intentBilling) {
    throw makeCheckoutError(409, 'package_snapshot_mismatch', 'Agreement package selection does not match the signup request.');
  }

  const configuredPlatformFee = getAlphaScreenPlatformFee(planTier, billingInterval);
  const snapshotPlatformFee = packageNumber(packageSnapshot, 'platform_fee');
  const perRoleFee = packageNumber(packageSnapshot, 'per_role_fee');
  const includedInterviews = packageNumber(packageSnapshot, 'included_interviews_per_role', 'included_interviews');
  const additionalInterviewFee = packageNumber(packageSnapshot, 'additional_interview_fee', 'additional_interview_price', 'overage_price');
  const maxInterviewMinutes = packageNumber(packageSnapshot, 'max_interview_minutes', 'interview_duration_minutes');
  const firstRolePrepay = firstRolePrepaySnapshot(packageSnapshot);
  const firstRolePrepaySelected = firstRolePrepay?.selected === true;
  const expectedPrepay = getAlphaScreenFirstRolePrepayConfig(planTier);
  if (
    configuredPlatformFee === null ||
    snapshotPlatformFee === null ||
    Number(snapshotPlatformFee) !== Number(configuredPlatformFee) ||
    perRoleFee === null ||
    includedInterviews === null ||
    additionalInterviewFee === null ||
    maxInterviewMinutes === null
  ) {
    throw makeCheckoutError(409, 'package_snapshot_invalid', 'Agreement package snapshot is invalid for checkout.');
  }
  if (intent.first_role_prepay_selected === true && !firstRolePrepaySelected) {
    throw makeCheckoutError(409, 'first_role_prepay_snapshot_missing', 'Agreement first-role prepay snapshot is missing.');
  }
  if (firstRolePrepaySelected) {
    if (
      !expectedPrepay ||
      firstRolePrepay.credit_type !== expectedPrepay.credit_type ||
      Number(firstRolePrepay.normal_role_fee_cents) !== Number(expectedPrepay.normal_role_fee_cents) ||
      Number(firstRolePrepay.discounted_credit_amount_cents) !== Number(expectedPrepay.discounted_credit_amount_cents) ||
      Number(firstRolePrepay.discount_percent) !== Number(expectedPrepay.discount_percent)
    ) {
      throw makeCheckoutError(409, 'first_role_prepay_snapshot_invalid', 'Agreement first-role prepay snapshot is invalid for checkout.');
    }
  }

  return {
    planTier,
    billingInterval,
    packageSnapshot
  };
}

async function loadPublicPurchaseIntentForAgreement(agreement) {
  const purchaseIntentId = publicPurchaseIntentIdFromAgreement(agreement);
  if (!purchaseIntentId) {
    throw makeCheckoutError(409, 'purchase_intent_missing', 'Agreement is missing its signup request reference.');
  }

  const { data, error } = await supabaseAdmin
    .from('public_purchase_intents')
    .select('id,status,selected_plan_key,selected_billing_cadence,package_snapshot,first_role_prepay_selected,first_role_prepay_amount_cents,first_role_normal_role_fee_cents,first_role_prepay_discount_percent,first_role_prepay_credit_type,company_legal_name,company_dba,buyer_first_name,buyer_last_name,buyer_email,buyer_phone,buyer_title,source_path,agreement_id,stripe_checkout_session_id,client_id,expires_at,created_at')
    .eq('id', purchaseIntentId)
    .maybeSingle();
  if (error) {
    throw makeCheckoutError(503, error.code || 'purchase_intent_lookup_failed', error.message || 'Signup request lookup failed.', error.hint || null);
  }
  return data || null;
}

async function ensurePublicAgreementCheckoutClient({ agreement, agreementInput, intent, planTier, billingInterval }) {
  const nowIso = new Date().toISOString();
  let clientId = String(agreement.client_id || intent?.client_id || '').trim();

  if (!clientId) {
    const firstName = String(intent?.buyer_first_name || '').trim();
    const lastName = String(intent?.buyer_last_name || '').trim();
    const adminName = `${firstName} ${lastName}`.trim() || String(intent?.buyer_email || '').trim();
    const { data: client, error: clientErr } = await supabaseAdmin
      .from('clients')
      .insert({
        name: String(intent?.company_legal_name || agreementInput.client_legal_name || '').trim(),
        email: String(intent?.buyer_email || agreementInput.admin_email || '').trim().toLowerCase(),
        client_admin_name: adminName || null,
        plan_tier: planTier,
        billing_interval: billingInterval,
        billing_status: 'inactive',
        subscription_status: 'incomplete',
        auto_renew: false
      })
      .select('id,name,email,client_admin_name')
      .single();
    if (clientErr || !client?.id) {
      throw makeCheckoutError(503, clientErr?.code || 'checkout_client_create_failed', clientErr?.message || 'Could not prepare billing account.', clientErr?.hint || null);
    }
    clientId = String(client.id || '').trim();
  }

  if (!clientId) {
    throw makeCheckoutError(500, 'checkout_client_missing', 'Could not prepare billing account.');
  }

  if (String(agreement.client_id || '').trim() !== clientId) {
    const { error: agreementUpdateErr } = await supabaseAdmin
      .from('membership_agreements')
      .update({ client_id: clientId, updated_at: nowIso })
      .eq('id', agreement.id)
      .eq('status', 'signed')
      .eq('is_current', true);
    if (agreementUpdateErr) {
      throw makeCheckoutError(503, agreementUpdateErr.code || 'agreement_client_link_failed', agreementUpdateErr.message || 'Could not link agreement to billing account.', agreementUpdateErr.hint || null);
    }
    agreement.client_id = clientId;
  }

  if (String(intent?.client_id || '').trim() !== clientId) {
    const { error: intentClientErr } = await supabaseAdmin
      .from('public_purchase_intents')
      .update({ client_id: clientId, updated_at: nowIso })
      .eq('id', intent.id);
    if (intentClientErr) {
      throw makeCheckoutError(503, intentClientErr.code || 'purchase_intent_client_link_failed', intentClientErr.message || 'Could not link signup request to billing account.', intentClientErr.hint || null);
    }
    intent.client_id = clientId;
  }

  return clientId;
}

async function requireAgreementClientWhenPresent(agreement, context) {
  if (!String(agreement?.client_id || '').trim() && isPublicPurchaseIntentAgreement(agreement)) {
    return { ok: true, client: null, clientId: null };
  }
  return requireParentAgreementClient(agreement, context);
}

function respondWithAgreementClientGuard(res, result, request_id) {
  return res.status(result.status || 500).json({
    ...(result.body || {
      error: 'client_lookup_failed',
      code: 'client_lookup_failed',
      detail: 'Client lookup failed.'
    }),
    request_id
  });
}

function resolveAgreementPublicSessionState(row) {
  if (!row) {
    return {
      ok: false,
      status: 404,
      code: 'token_invalid',
      detail: 'This signing link is invalid.'
    };
  }

  const status = String(row.status || '').trim().toLowerCase();
  const checkoutStatus = String(row.checkout_status || '').trim().toLowerCase();

  if (status === 'sent') {
    if (isExpired(row.signer_token_expires_at)) {
      return {
        ok: false,
        status: 410,
        code: 'token_expired',
        detail: 'This signing link has expired.'
      };
    }
    return {
      ok: true,
      state: 'signable'
    };
  }

  if (status === 'signed' && row.is_current === true) {
    if (!String(row.client_id || '').trim() && isPublicPurchaseIntentAgreement(row)) {
      return {
        ok: true,
        state: 'agreement_signed_pending_payment_setup'
      };
    }
    if (checkoutStatus === 'paid') {
      return {
        ok: true,
        state: 'activation_complete'
      };
    }
    if (!checkoutStatus || checkoutStatus === 'pending_payment') {
      return {
        ok: true,
        state: 'activation_pending'
      };
    }
  }

  return {
    ok: false,
    status: 409,
    code: 'agreement_not_available',
    detail: 'This agreement is no longer available.'
  };
}

function buildAgreementInputFromRow(row) {
  const snapshotValues =
    row?.template_snapshot &&
    typeof row.template_snapshot === 'object' &&
    row.template_snapshot.values &&
    typeof row.template_snapshot.values === 'object'
      ? row.template_snapshot.values
      : null;

  if (snapshotValues) {
    return normalizeMembershipAgreementInput(snapshotValues);
  }

  return normalizeMembershipAgreementInput({
    client_id: row?.client_id || null,
    client_legal_name: row?.client_legal_name || '',
    dba_trade_name: row?.dba_trade_name || '',
    primary_admin_name: row?.primary_admin_name || '',
    admin_email: row?.admin_email || '',
    membership_tier: row?.membership_tier || '',
    initial_term_start: row?.initial_term_start || '',
    initial_renewal_date: row?.initial_renewal_date || '',
    billing_option: row?.billing_option || '',
    auto_renew: row?.auto_renew,
    notice_deadline_days: row?.notice_deadline_days
  });
}

async function createAgreementSignedUrl(path, expiresInSeconds) {
  const key = String(path || '').trim();
  if (!key) return null;
  const { data, error } = await supabaseAdmin
    .storage
    .from(AGREEMENTS_BUCKET)
    .createSignedUrl(key, expiresInSeconds);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

async function loadAgreementByTokenHash(tokenHash) {
  const { data, error } = await supabaseAdmin
    .from('membership_agreements')
    .select('id,client_id,status,is_current,checkout_status,checkout_session_id,checkout_created_at,client_legal_name,dba_trade_name,primary_admin_name,admin_email,membership_tier,initial_term_start,initial_renewal_date,billing_option,auto_renew,notice_deadline_days,template_snapshot,draft_pdf_path,executed_pdf_path,signer_token_expires_at,opened_at,sent_at,signed_at,signer_typed_name')
    .eq('signer_token_hash', tokenHash)
    .maybeSingle();

  if (error) {
    const err = new Error(error.message || 'agreement_lookup_failed');
    err.code = error.code || 'agreement_lookup_failed';
    err.hint = error.hint || null;
    throw err;
  }

  return data || null;
}

async function resolveLegalBillingAgreementClient(req, clientId, requestId) {
  const requestedClientId = String(clientId || '').trim();
  if (!requestedClientId || requestedClientId === 'all') {
    return { ok: true, client_id: null };
  }

  const scopedIds = Array.isArray(req.client_memberships)
    ? req.client_memberships
    : (Array.isArray(req.clientIds) ? req.clientIds : []);
  const isGlobalAdmin = req.isGlobalAdmin === true || req.isAdmin === true;
  if (!isGlobalAdmin && !scopedIds.includes(requestedClientId)) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'Client scope mismatch.',
        request_id: requestId
      }
    };
  }

  const billingScope = await resolveBillingOwnerForScope(supabaseAdmin, requestedClientId);
  if (!billingScope.ok) {
    return {
      ok: false,
      status: billingScope.status || 500,
      body: {
        error: billingScope.body?.error || billingScope.body?.code || 'billing_client_lookup_failed',
        code: billingScope.body?.code || billingScope.body?.error || 'billing_client_lookup_failed',
        detail: billingScope.body?.detail || 'Billing client lookup failed.',
        hint: billingScope.body?.hint || null,
        request_id: requestId
      }
    };
  }

  if (
    !isGlobalAdmin &&
    !canViewLegalBillingForClient(req.clientScope, billingScope.scopeClientId || requestedClientId) &&
    !canViewLegalBillingForClient(req.clientScope, billingScope.billingClientId)
  ) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'forbidden',
        code: 'forbidden',
        detail: 'Legal billing access is required.',
        request_id: requestId
      }
    };
  }

  return {
    ok: true,
    client_id: billingScope.billingClientId || requestedClientId,
    scope_client_id: billingScope.scopeClientId || requestedClientId
  };
}

router.post('/session', publicAgreementTokenRateLimit, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const token = readToken(req);
    if (!token) {
      return res.status(400).json({
        error: 'token_required',
        code: 'token_required',
        detail: 'Signing token is required.',
        request_id
      });
    }

    const tokenHash = hashToken(token);
    const agreement = await loadAgreementByTokenHash(tokenHash);
    const sessionState = resolveAgreementPublicSessionState(agreement);
    if (!sessionState.ok) {
      return res.status(sessionState.status).json({
        error: sessionState.code,
        code: sessionState.code,
        detail: sessionState.detail,
        request_id
      });
    }
    const parentGuard = await requireAgreementClientWhenPresent(agreement, { route: 'membership_agreements_session', agreement_id: agreement.id });
    if (!parentGuard.ok) return respondWithAgreementClientGuard(res, parentGuard, request_id);

    let openedAt = agreement.opened_at || null;
    if (sessionState.state === 'signable' && !openedAt) {
      openedAt = new Date().toISOString();
      const { error: openedErr } = await supabaseAdmin
        .from('membership_agreements')
        .update({ opened_at: openedAt, updated_at: openedAt })
        .eq('id', agreement.id);
      if (openedErr) {
        console.error('[membership-agreements/session] opened_at_update_failed', {
          request_id,
          agreement_id: agreement.id,
          error: openedErr.message,
          code: openedErr.code
        });
      }
    }

    const draftPdfUrl =
      sessionState.state === 'signable'
        ? await createAgreementSignedUrl(agreement.draft_pdf_path, SIGNED_URL_TTL_SECONDS)
        : null;
    const executedPdfUrl =
      sessionState.state !== 'signable'
        ? await createAgreementSignedUrl(agreement.executed_pdf_path, SIGNED_URL_TTL_SECONDS)
        : null;

    return res.json({
      ok: true,
      session: {
        agreement_id: agreement.id,
        state: sessionState.state,
        status: agreement.status,
        is_current: agreement.is_current === true,
        checkout_status: agreement.checkout_status || null,
        client_legal_name: agreement.client_legal_name,
        dba_trade_name: agreement.dba_trade_name,
        primary_admin_name: agreement.primary_admin_name,
        admin_email: agreement.admin_email,
        membership_tier: agreement.membership_tier,
        billing_option: agreement.billing_option,
        auto_renew: agreement.auto_renew,
        notice_deadline_days: agreement.notice_deadline_days,
        initial_term_start: agreement.initial_term_start,
        initial_renewal_date: agreement.initial_renewal_date,
        expires_at: agreement.signer_token_expires_at,
        sent_at: agreement.sent_at,
        signed_at: agreement.signed_at,
        opened_at: openedAt,
        draft_pdf_url: draftPdfUrl,
        executed_pdf_url: executedPdfUrl
      },
      request_id
    });
  } catch (e) {
    console.error('[membership-agreements/session] unexpected', { request_id, error: e?.message || e, code: e?.code || null });
    return res.status(500).json({
      error: 'server_error',
      code: e?.code || 'server_error',
      detail: extractErrorMessage(e?.message || '', 'Server error.'),
      request_id
    });
  }
});

router.post('/sign', publicAgreementTokenRateLimit, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const token = readToken(req);
    if (!token) {
      return res.status(400).json({
        error: 'token_required',
        code: 'token_required',
        detail: 'Signing token is required.',
        request_id
      });
    }

    const typedName = String(req.body?.typed_name || req.body?.typedName || '').trim();
    if (!typedName) {
      return res.status(400).json({
        error: 'typed_name_required',
        code: 'typed_name_required',
        detail: 'Typed name is required.',
        request_id
      });
    }

    const accepted = normalizeAccepted(req.body?.accepted ?? req.body?.agreement_accepted ?? req.body?.agreementAccepted);
    if (!accepted) {
      return res.status(400).json({
        error: 'agreement_acceptance_required',
        code: 'agreement_acceptance_required',
        detail: 'Agreement acceptance checkbox is required.',
        request_id
      });
    }

    let signaturePayload;
    try {
      signaturePayload = parseSignaturePayload(req.body?.signature_image || req.body?.signatureImage || req.body?.signature_image_data_url || req.body?.signatureDataUrl);
    } catch (signatureErr) {
      return res.status(400).json({
        error: signatureErr.code || 'signature_invalid',
        code: signatureErr.code || 'signature_invalid',
        detail: 'A drawn signature image is required.',
        request_id
      });
    }

    const tokenHash = hashToken(token);
    const agreement = await loadAgreementByTokenHash(tokenHash);
    const validation = validateSignableAgreement(agreement);
    if (!validation.ok) {
      return res.status(validation.status).json({
        error: validation.code,
        code: validation.code,
        detail: validation.detail,
        request_id
      });
    }
    const parentGuard = await requireAgreementClientWhenPresent(agreement, { route: 'membership_agreements_sign', agreement_id: agreement.id });
    if (!parentGuard.ok) return respondWithAgreementClientGuard(res, parentGuard, request_id);

    const signedAt = new Date().toISOString();
    const signatureSha256 = crypto.createHash('sha256').update(signaturePayload.buffer).digest('hex');
    const clientSlug = slugify(agreement.client_legal_name);
    const signaturePath = `membership-agreements/${agreement.id}/signature.${signaturePayload.ext}`;

    const signatureUpload = await supabaseAdmin
      .storage
      .from(AGREEMENTS_BUCKET)
      .upload(signaturePath, signaturePayload.buffer, {
        contentType: signaturePayload.mime,
        upsert: true
      });

    if (signatureUpload.error) {
      console.error('[membership-agreements/sign] signature_upload_failed', {
        request_id,
        agreement_id: agreement.id,
        error: signatureUpload.error.message,
        code: signatureUpload.error.code
      });
      return res.status(500).json({
        error: 'signature_upload_failed',
        code: signatureUpload.error.code || 'signature_upload_failed',
        detail: signatureUpload.error.message,
        request_id
      });
    }

    const agreementInput = buildAgreementInputFromRow(agreement);
    const { html } = buildMembershipAgreementHtml(agreementInput, {
      showPackageTerms: isPublicPurchaseIntentAgreement(agreement),
      execution: {
        accepted: true,
        signer_typed_name: typedName,
        signature_image_src: signaturePayload.dataUrl,
        signed_at: signedAt
      }
    });

    const executedPdf = await htmlToPdf(html, {
      format: 'Letter',
      margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' }
    });

    const executedPdfPath = `membership-agreements/${agreement.id}/${clientSlug}-executed.pdf`;
    const executedUpload = await supabaseAdmin
      .storage
      .from(AGREEMENTS_BUCKET)
      .upload(executedPdfPath, executedPdf, {
        contentType: 'application/pdf',
        upsert: true
      });

    if (executedUpload.error) {
      console.error('[membership-agreements/sign] executed_pdf_upload_failed', {
        request_id,
        agreement_id: agreement.id,
        error: executedUpload.error.message,
        code: executedUpload.error.code
      });
      return res.status(500).json({
        error: 'executed_pdf_upload_failed',
        code: executedUpload.error.code || 'executed_pdf_upload_failed',
        detail: executedUpload.error.message,
        request_id
      });
    }

    const ipAddress = getClientIp(req);
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 1024) || null;
    const nextTemplateSnapshot = {
      ...(agreement.template_snapshot && typeof agreement.template_snapshot === 'object' ? agreement.template_snapshot : {}),
      execution: {
        signed_at: signedAt,
        signer_typed_name: typedName,
        signer_accepted: true,
        signature_sha256: signatureSha256,
        signature_image_path: signaturePath,
        executed_pdf_path: executedPdfPath,
        signer_ip: ipAddress,
        signer_user_agent: userAgent
      }
    };

    const { data: signingRows, error: updateErr } = await supabaseAdmin
      .rpc('complete_membership_agreement_signing', {
        p_agreement_id: agreement.id,
        p_signed_at: signedAt,
        p_opened_at: agreement.opened_at || signedAt,
        p_signer_typed_name: typedName,
        p_signature_image_path: signaturePath,
        p_signature_sha256: signatureSha256,
        p_signer_ip: ipAddress,
        p_signer_user_agent: userAgent,
        p_executed_pdf_path: executedPdfPath,
        p_template_snapshot: nextTemplateSnapshot
      });
    const updatedAgreement = Array.isArray(signingRows) ? (signingRows[0] || null) : (signingRows || null);

    if (updateErr) {
      console.error('[membership-agreements/sign] status_update_failed', {
        request_id,
        agreement_id: agreement.id,
        error: updateErr.message,
        code: updateErr.code,
        hint: updateErr.hint
      });
      return res.status(500).json({
        error: 'status_update_failed',
        code: updateErr.code || 'status_update_failed',
        detail: updateErr.message,
        hint: updateErr.hint,
        request_id
      });
    }

    if (!updatedAgreement) {
      return res.status(409).json({
        error: 'agreement_not_signable',
        code: 'agreement_not_signable',
        detail: 'This agreement was already signed or is no longer signable.',
        request_id
      });
    }

    const emailDownloadUrl = await createAgreementSignedUrl(executedPdfPath, EMAIL_SIGNED_URL_TTL_SECONDS);
    const responseDownloadUrl = await createAgreementSignedUrl(executedPdfPath, SIGNED_URL_TTL_SECONDS);
    const executedPdfBuffer = Buffer.isBuffer(executedPdf)
      ? executedPdf
      : ArrayBuffer.isView(executedPdf)
        ? Buffer.from(executedPdf.buffer, executedPdf.byteOffset, executedPdf.byteLength)
        : Buffer.from(executedPdf);

    try {
      const signedCopyEmailResult = await sendMembershipAgreementSignedCopyEmail(updatedAgreement.admin_email, {
        client_legal_name: updatedAgreement.client_legal_name,
        primary_admin_name: updatedAgreement.primary_admin_name,
        signer_typed_name: typedName,
        signed_at: signedAt,
        executed_pdf_url: emailDownloadUrl,
        pdf_base64: executedPdfBuffer.toString('base64'),
        file_name: `${clientSlug}-membership-agreement-signed.pdf`
      });
      if (!signedCopyEmailResult || signedCopyEmailResult.skipped) {
        console.warn('[membership-agreements/sign] signed_copy_email_skipped', {
          request_id,
          agreement_id: updatedAgreement.id || agreement.id,
          result: signedCopyEmailResult || null
        });
      } else {
        console.info('[membership-agreements/sign] signed_copy_email_sent', {
          request_id,
          agreement_id: updatedAgreement.id || agreement.id,
          status_code: signedCopyEmailResult.statusCode || null
        });
      }
    } catch (emailErr) {
      const sendgridResponseBody = emailErr?.response?.body || null;
      const sendgridResponseErrors = Array.isArray(sendgridResponseBody?.errors)
        ? sendgridResponseBody.errors
        : null;
      console.error('[membership-agreements/sign] signed_copy_email_failed', {
        request_id,
        agreement_id: updatedAgreement.id || agreement.id,
        message: emailErr?.message || String(emailErr || ''),
        code: emailErr?.code || null,
        status: emailErr?.response?.statusCode || emailErr?.statusCode || null,
        response_body: sendgridResponseBody,
        response_errors: sendgridResponseErrors
      });
    }

    try {
      await sendMembershipAgreementCompletedInternalNotification(MEMBERSHIP_INTERNAL_NOTIFY_EMAIL, {
        agreement_id: updatedAgreement.id,
        client_legal_name: updatedAgreement.client_legal_name,
        primary_admin_name: updatedAgreement.primary_admin_name,
        admin_email: updatedAgreement.admin_email,
        signer_typed_name: typedName,
        signed_at: signedAt
      });
    } catch (notifyErr) {
      console.error('[membership-agreements/sign] internal_completion_email_failed', {
        request_id,
        agreement_id: agreement.id,
        error: notifyErr?.message || notifyErr
      });
    }

    return res.json({
      ok: true,
      agreement: {
        id: updatedAgreement.id,
        status: updatedAgreement.status,
        signed_at: updatedAgreement.signed_at,
        signer_typed_name: updatedAgreement.signer_typed_name
      },
      executed_pdf_url: responseDownloadUrl,
      request_id
    });
  } catch (e) {
    console.error('[membership-agreements/sign] unexpected', { request_id, error: e?.message || e, code: e?.code || null });
    return res.status(500).json({
      error: 'server_error',
      code: e?.code || 'server_error',
      detail: extractErrorMessage(e?.message || '', 'Server error.'),
      request_id
    });
  }
});

router.post('/checkout-session', publicAgreementTokenRateLimit, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const token = readToken(req);
    if (!token) {
      return res.status(400).json({
        error: 'token_required',
        code: 'token_required',
        detail: 'Signing token is required.',
        request_id
      });
    }

    const tokenHash = hashToken(token);
    const agreement = await loadAgreementByTokenHash(tokenHash);
    if (!agreement) {
      return res.status(404).json({
        error: 'token_invalid',
        code: 'token_invalid',
        detail: 'This signing link is invalid.',
        request_id
      });
    }

    const publicAgreement = isPublicPurchaseIntentAgreement(agreement);
    const embeddedCheckoutRequested = wantsEmbeddedCheckout(req.body?.embedded, !publicAgreement);
    if (String(agreement.status || '').trim().toLowerCase() !== 'signed' || agreement.is_current !== true) {
      return res.status(409).json({
        error: 'agreement_not_checkout_eligible',
        code: 'agreement_not_checkout_eligible',
        detail: 'This agreement is not eligible for checkout.',
        request_id
      });
    }
    if (String(agreement.checkout_status || '').trim().toLowerCase() === 'paid') {
      return res.status(409).json({
        error: 'agreement_checkout_already_paid',
        code: 'agreement_checkout_already_paid',
        detail: 'Checkout is already completed for this agreement.',
        request_id
      });
    }

    const agreementInput = buildAgreementInputFromRow(agreement);
    const planTier = String(agreementInput.membership_tier || '').trim().toLowerCase();
    const billingInterval = String(agreementInput.billing_option || '').trim().toLowerCase();
    if (!['basic', 'pro', 'enterprise'].includes(planTier)) {
      return res.status(409).json({
        error: 'invalid_agreement_plan',
        code: 'invalid_agreement_plan',
        detail: 'Agreement plan tier is invalid for checkout.',
        request_id
      });
    }
    if (!['monthly', 'annual'].includes(billingInterval)) {
      return res.status(409).json({
        error: 'invalid_agreement_billing_interval',
        code: 'invalid_agreement_billing_interval',
        detail: 'Agreement billing interval is invalid for checkout.',
        request_id
      });
    }

    let purchaseIntent = null;
    let publicPackageSnapshot = null;
    let clientId = String(agreement.client_id || '').trim();
    if (publicAgreement) {
      purchaseIntent = await loadPublicPurchaseIntentForAgreement(agreement);
      const publicCheckout = validatePublicPurchaseIntentForCheckout({ agreement, agreementInput, intent: purchaseIntent });
      publicPackageSnapshot = publicCheckout.packageSnapshot;
      clientId = await ensurePublicAgreementCheckoutClient({
        agreement,
        agreementInput,
        intent: purchaseIntent,
        planTier: publicCheckout.planTier,
        billingInterval: publicCheckout.billingInterval
      });
    }

    if (!clientId) {
      return res.status(400).json({
        error: 'missing_client_id',
        code: 'missing_client_id',
        detail: 'Agreement is not linked to a client.',
        request_id
      });
    }
    const parentGuard = await requireParentAgreementClient(agreement, { route: 'membership_agreements_checkout_session', agreement_id: agreement.id });
    if (!parentGuard.ok) return respondWithAgreementClientGuard(res, parentGuard, request_id);

    const enterpriseFees = planTier === 'enterprise'
      ? {
          platform_fee: agreementInput.platform_fee,
          per_role_fee: agreementInput.per_role_fee,
          included_interviews_per_role: agreementInput.included_interviews_per_role,
          additional_interview_fee: agreementInput.additional_interview_fee
        }
      : null;

    if (
      planTier === 'enterprise' &&
      (
        !String(enterpriseFees?.platform_fee || '').trim() ||
        !String(enterpriseFees?.per_role_fee || '').trim() ||
        !String(enterpriseFees?.included_interviews_per_role || '').trim() ||
        !String(enterpriseFees?.additional_interview_fee || '').trim()
      )
    ) {
      return res.status(409).json({
        error: 'invalid_enterprise_checkout_fields',
        code: 'invalid_enterprise_checkout_fields',
        detail: 'Enterprise checkout values are missing from this agreement.',
        request_id
      });
    }

    const checkoutMetadata = publicAgreement
      ? buildPublicAgreementCheckoutMetadata({
          agreement,
          agreementInput,
          intent: purchaseIntent,
          packageSnapshot: publicPackageSnapshot
        })
      : {
          agreement_id: agreement.id
        };
    const firstRolePrepay = publicAgreement
      ? buildFirstRolePrepayCheckout(publicPackageSnapshot)
      : null;
    const idempotencyKey = publicAgreement
      ? `agreement_checkout:${agreement.id}:${planTier}:${billingInterval}`
      : '';
    const cancelUrl = publicAgreement
      ? appendQueryParam(buildMembershipAgreementSignUrl(token), 'checkout', 'cancel')
      : buildMembershipAgreementSignUrl(token);

    const {
      session,
      fallbackSession,
      checkoutClientSecret,
      replacesStripeSubscriptionId,
      replacementPolicy
    } = await createSubscriptionCheckoutSession({
      clientId,
      planTier,
      billingInterval,
      metadataSource: 'agreement_checkout',
      metadata: checkoutMetadata,
      firstRolePrepay,
      enterpriseFees,
      embedded: embeddedCheckoutRequested,
      cancelUrl,
      idempotencyKey,
      requestContext: {
        forwardedProto: req.headers?.['x-forwarded-proto'],
        forwardedHost: req.headers?.['x-forwarded-host'],
        protocol: req.protocol,
        host: req.get('host')
      }
    });

    const checkoutSessionId = String(session?.id || fallbackSession?.id || '').trim();
    const checkoutUrl = String(fallbackSession?.url || session?.url || '').trim();
    const resolvedCheckoutClientSecret = String(checkoutClientSecret || '').trim();
    if (!checkoutSessionId || (!checkoutUrl && !resolvedCheckoutClientSecret)) {
      return res.status(500).json({
        error: 'checkout_session_missing',
        code: 'checkout_session_missing',
        detail: 'Checkout session was created without a valid URL.',
        request_id
      });
    }

    const nowIso = new Date().toISOString();
    const checkoutUpdate = {
      checkout_status: 'pending_payment',
      checkout_session_id: checkoutSessionId,
      checkout_created_at: nowIso,
      updated_at: nowIso
    };
    if (replacesStripeSubscriptionId) {
      checkoutUpdate.replaces_stripe_subscription_id = replacesStripeSubscriptionId;
      checkoutUpdate.replacement_policy = replacementPolicy || 'immediate_cancel';
      checkoutUpdate.replacement_error = null;
    }
    const { error: checkoutStateErr } = await supabaseAdmin
      .from('membership_agreements')
      .update(checkoutUpdate)
      .eq('id', agreement.id)
      .eq('status', 'signed')
      .eq('is_current', true);

    if (checkoutStateErr) {
      console.error('[membership-agreements/checkout-session] checkout_state_update_failed', {
        request_id,
        agreement_id: agreement.id,
        error: checkoutStateErr.message,
        code: checkoutStateErr.code,
        hint: checkoutStateErr.hint
      });
      return res.status(500).json({
        error: 'checkout_state_update_failed',
        code: checkoutStateErr.code || 'checkout_state_update_failed',
        detail: checkoutStateErr.message,
        hint: checkoutStateErr.hint,
        request_id
      });
    }

    if (purchaseIntent?.id) {
      const { error: intentCheckoutErr } = await supabaseAdmin
        .from('public_purchase_intents')
        .update({
          status: 'checkout_pending',
          stripe_checkout_session_id: checkoutSessionId,
          client_id: clientId,
          updated_at: nowIso
        })
        .eq('id', purchaseIntent.id);

      if (intentCheckoutErr) {
        console.error('[membership-agreements/checkout-session] purchase_intent_checkout_update_failed', {
          request_id,
          agreement_id: agreement.id,
          purchase_intent_id: purchaseIntent.id,
          error: intentCheckoutErr.message,
          code: intentCheckoutErr.code,
          hint: intentCheckoutErr.hint
        });
        return res.status(500).json({
          error: 'purchase_intent_checkout_update_failed',
          code: intentCheckoutErr.code || 'purchase_intent_checkout_update_failed',
          detail: intentCheckoutErr.message,
          hint: intentCheckoutErr.hint,
          request_id
        });
      }
    }

    return res.json({
      ok: true,
      url: checkoutUrl || null,
      session_id: checkoutSessionId,
      checkout_client_secret: resolvedCheckoutClientSecret || null,
      embedded_checkout: !!resolvedCheckoutClientSecret,
      request_id
    });
  } catch (e) {
    return res.status(Number(e?.status) || 500).json({
      error: e?.code || 'create_subscription_checkout_failed',
      code: e?.code || 'create_subscription_checkout_failed',
      detail: extractErrorMessage(e?.message || '', 'Could not create checkout session.'),
      request_id
    });
  }
});

router.get('/latest-signed', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const clientId = String(req.query?.client_id || req.client?.id || req.clientScope?.defaultClientId || '').trim();
    if (!clientId || clientId === 'all') {
      return res.json({ ok: true, agreement: null, request_id });
    }

    const access = await resolveLegalBillingAgreementClient(req, clientId, request_id);
    if (!access.ok) return res.status(access.status || 403).json(access.body);
    const agreementClientId = access.client_id;

    const { data: latest, error: latestErr } = await supabaseAdmin
      .from('membership_agreements')
      .select('id,client_id,status,signed_at,signer_typed_name,client_legal_name,executed_pdf_path,created_at,is_current')
      .eq('client_id', agreementClientId)
      .eq('status', 'signed')
      .eq('is_current', true)
      .maybeSingle();

    if (latestErr) {
      console.error('[membership-agreements/latest-signed] query_failed', {
        request_id,
        client_id: agreementClientId,
        error: latestErr.message,
        code: latestErr.code,
        hint: latestErr.hint
      });
      return res.status(500).json({
        error: 'latest_signed_query_failed',
        code: latestErr.code || 'latest_signed_query_failed',
        detail: latestErr.message,
        hint: latestErr.hint,
        request_id
      });
    }

    if (!latest) {
      return res.json({ ok: true, agreement: null, request_id });
    }

    const executedPdfUrl = await createAgreementSignedUrl(latest.executed_pdf_path, SIGNED_URL_TTL_SECONDS);

    return res.json({
      ok: true,
      agreement: {
        id: latest.id,
        client_id: latest.client_id,
        status: latest.status,
        signed_at: latest.signed_at,
        signer_typed_name: latest.signer_typed_name,
        client_legal_name: latest.client_legal_name,
        executed_pdf_url: executedPdfUrl
      },
      request_id
    });
  } catch (e) {
    console.error('[membership-agreements/latest-signed] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'server_error',
      detail: e?.message || 'Server error',
      request_id
    });
  }
});

router.get('/latest-signed-url', requireAuth, withClientScope, async (req, res) => {
  const request_id = req.request_id || null;
  try {
    const clientId = String(req.query?.client_id || req.client?.id || req.clientScope?.defaultClientId || '').trim();
    if (!clientId || clientId === 'all') {
      return res.json({ ok: true, executed_pdf_url: null, request_id });
    }

    const access = await resolveLegalBillingAgreementClient(req, clientId, request_id);
    if (!access.ok) return res.status(access.status || 403).json(access.body);
    const agreementClientId = access.client_id;

    const { data: latest, error: latestErr } = await supabaseAdmin
      .from('membership_agreements')
      .select('id,executed_pdf_path,created_at,signed_at,is_current')
      .eq('client_id', agreementClientId)
      .eq('status', 'signed')
      .eq('is_current', true)
      .maybeSingle();

    if (latestErr) {
      console.error('[membership-agreements/latest-signed-url] query_failed', {
        request_id,
        client_id: agreementClientId,
        error: latestErr.message,
        code: latestErr.code,
        hint: latestErr.hint
      });
      return res.status(500).json({
        error: 'latest_signed_query_failed',
        code: latestErr.code || 'latest_signed_query_failed',
        detail: latestErr.message,
        hint: latestErr.hint,
        request_id
      });
    }

    if (!latest) {
      return res.json({ ok: true, executed_pdf_url: null, request_id });
    }

    const executedPdfUrl = await createAgreementSignedUrl(latest.executed_pdf_path, SIGNED_URL_TTL_SECONDS);

    return res.json({
      ok: true,
      agreement_id: latest.id,
      executed_pdf_url: executedPdfUrl,
      request_id
    });
  } catch (e) {
    console.error('[membership-agreements/latest-signed-url] unexpected', { request_id, error: e?.message || e });
    return res.status(500).json({
      error: 'server_error',
      code: 'server_error',
      detail: e?.message || 'Server error',
      request_id
    });
  }
});

module.exports = router;
