// routes/webhookStripe.js
const express = require('express');
const crypto = require('node:crypto');
const stripe = require('../../clients/stripe');
const { supabaseAdmin } = require('../../clients/supabase');
const { requireParentClient } = require('../../services/clientBillingScope');
const { getRoleInterviewAvailability } = require('../../services/roleInterviewAvailability');
const { buildAlphaScreenPlanSettingsPayload } = require('../../services/alphaScreenPackages');
const { activatePublicPurchaseAgreementCheckout } = require('../../services/publicPurchaseActivation');
const { finalizePendingRolePurchase } = require('../../services/rolePurchaseFinalizer');
const { getPlanCapacity } = require('../../services/planCapacity');
const {
  ENTERPRISE_SETTING_FIELDS,
  recordExplicitBillingModel,
  validateEnterpriseSettings
} = require('../../services/enterpriseSettings');
const { resolveBillingModel } = require('../../services/billingModel');
const { applyUsageToInvoice } = require('../../services/usageBilling');
const { markPoolFailed, markPoolPaid } = require('../../services/interviewPool');
const router = express.Router();

const SETTLED_PAYMENT_STATUSES = new Set(['paid', 'no_payment_required']);

// True only once Stripe says the money is actually collected. A completed checkout
// session is not sufficient on its own.
function isSettledPayment(session) {
  return SETTLED_PAYMENT_STATUSES.has(String(session?.payment_status || '').trim().toLowerCase());
}

// A failure that will never succeed on redelivery, so acknowledging it is correct.
// Anything not marked this way is treated as transient and left for Stripe to retry.
function permanentFailure(message) {
  const err = new Error(message);
  err.permanentFailure = true;
  return err;
}

function isUniqueViolation(error) {
  const code = String(error?.code || '');
  const msg = String(error?.message || '');
  return code === '23505' || /duplicate key|unique/i.test(msg);
}

function toIsoFromUnixSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function addMonthsToIso(isoValue, monthsToAdd) {
  if (!isoValue) return null;
  const d = new Date(isoValue);
  if (!Number.isFinite(d.getTime())) return null;
  d.setMonth(d.getMonth() + Number(monthsToAdd || 0));
  return d.toISOString();
}

function pickId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.id === 'string') return value.id;
  return null;
}

function buildBillingInvoiceSyncPayload(stripeInvoice) {
  const statusRaw = String(stripeInvoice?.status || '').trim().toLowerCase();
  const hostedInvoiceUrlRaw = String(stripeInvoice?.hosted_invoice_url || '').trim();
  const totalRaw = Number(stripeInvoice?.total);
  const amountDueRaw = Number(stripeInvoice?.amount_due);
  const amountTotalCents = Number.isFinite(totalRaw)
    ? Math.round(totalRaw)
    : Number.isFinite(amountDueRaw)
      ? Math.round(amountDueRaw)
      : null;
  const currencyRaw = String(stripeInvoice?.currency || '').trim().toLowerCase();

  const payload = {};
  if (statusRaw) payload.status = statusRaw;
  if (hostedInvoiceUrlRaw) payload.hosted_invoice_url = hostedInvoiceUrlRaw;
  if (amountTotalCents !== null) payload.amount_total_cents = amountTotalCents;
  if (currencyRaw) payload.currency = currencyRaw;
  return payload;
}

async function syncBillingInvoiceFromStripeEvent(stripeInvoice, request_id) {
  const stripeInvoiceId = pickId(stripeInvoice?.id);
  if (!stripeInvoiceId) return;
  const payload = buildBillingInvoiceSyncPayload(stripeInvoice);
  if (!Object.keys(payload).length) return;

  const { error } = await supabaseAdmin
    .from('billing_invoices')
    .update(payload)
    .eq('stripe_invoice_id', stripeInvoiceId);
  if (error) {
    throw new Error(`Billing invoice sync failed (${stripeInvoiceId}): ${error.message || 'update_failed'}`);
  }
}

const LIVE_SUB_STATUSES = new Set(['active', 'trialing']);
const MANAGED_SUBSCRIPTION_CHECKOUT_SOURCES = new Set(['admin_subscription_checkout', 'agreement_checkout']);

async function requireParentClientForStripeBilling(clientId, context = {}) {
  const result = await requireParentClient(supabaseAdmin, clientId, context);
  if (result.ok) return result;

  const body = result.body || {};
  const err = new Error(body.detail || body.error || body.code || 'Client billing scope check failed');
  err.code = body.code || body.error || 'CLIENT_BILLING_SCOPE_CHECK_FAILED';
  err.status = result.status || 500;
  err.detail = body.detail || err.message;
  err.context = body.context || context || null;
  throw err;
}

function normalizeBillingInterval(raw, fallback = null) {
  const intervalRaw = String(raw || '').toLowerCase();
  if (intervalRaw === 'month') return 'monthly';
  if (intervalRaw === 'year') return 'annual';
  if (fallback === 'monthly' || fallback === 'annual') return fallback;
  return null;
}

// A value that was never sent. Number(null) and Number('') are both 0, so
// without this check an absent price or count reads as a deliberate zero — and
// a client gets provisioned with a figure nobody chose.
function isAbsent(raw) {
  return raw == null || (typeof raw === 'string' && raw.trim() === '');
}

function parseMoneyValue(raw, options = {}) {
  if (isAbsent(raw)) return null;
  const allowZero = options.allowZero !== false;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  if (allowZero ? rounded < 0 : rounded <= 0) return null;
  return rounded;
}

// Returns null for a missing value as well as an unusable one. Zero is a real
// answer — an Enterprise client may legitimately include no interviews per role
// — so the caller must tell the two apart, which it cannot do if absence is
// silently 0.
function parseWholeNumber(raw, options = {}) {
  if (isAbsent(raw)) return null;
  const allowZero = options.allowZero !== false;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (allowZero ? n < 0 : n <= 0) return null;
  return n;
}

function getSubscriptionMetadataSources(subscription) {
  const subscriptionMetadata = subscription?.metadata && typeof subscription?.metadata === 'object' ? subscription.metadata : {};
  const priceMetadata = subscription?.items?.data?.[0]?.price?.metadata && typeof subscription?.items?.data?.[0]?.price?.metadata === 'object'
    ? subscription.items.data[0].price.metadata
    : {};
  const planMetadata = subscription?.items?.data?.[0]?.plan?.metadata && typeof subscription?.items?.data?.[0]?.plan?.metadata === 'object'
    ? subscription.items.data[0].plan.metadata
    : {};
  return { subscriptionMetadata, priceMetadata, planMetadata };
}

function getSubscriptionMetadataValue(metadataSources, key, fallback = null) {
  const pick = (obj) => {
    const value = obj?.[key];
    if (value == null) return null;
    const text = String(value).trim();
    return text ? text : null;
  };
  return (
    pick(metadataSources?.subscriptionMetadata) ||
    pick(metadataSources?.priceMetadata) ||
    pick(metadataSources?.planMetadata) ||
    fallback
  );
}

function buildClientPlanSettingsPayloadFromSubscription(subscription, clientId, options = {}) {
  if (!clientId) return null;
  const subStatus = String(subscription?.status || '').toLowerCase();
  if (!LIVE_SUB_STATUSES.has(subStatus)) return null;

  const metadataSources = getSubscriptionMetadataSources(subscription);
  const metadataSource = String(getSubscriptionMetadataValue(metadataSources, 'source', options.fallbackSource || '') || '').trim().toLowerCase();
  if (!MANAGED_SUBSCRIPTION_CHECKOUT_SOURCES.has(metadataSource)) return null;

  const planTier = String(getSubscriptionMetadataValue(metadataSources, 'plan_tier', options.fallbackPlanTier || '') || '').trim().toLowerCase();
  if (!['basic', 'pro', 'enterprise'].includes(planTier)) return null;

  const metadataBillingInterval = String(getSubscriptionMetadataValue(metadataSources, 'billing_interval', options.fallbackBillingInterval || '') || '').trim().toLowerCase();
  const intervalRaw =
    subscription?.items?.data?.[0]?.price?.recurring?.interval ||
    subscription?.plan?.interval ||
    '';
  const billingInterval = ['monthly', 'annual'].includes(metadataBillingInterval)
    ? metadataBillingInterval
    : normalizeBillingInterval(intervalRaw, options.fallbackBillingInterval || null);
  if (!['monthly', 'annual'].includes(String(billingInterval || '').toLowerCase())) return null;

  if (planTier === 'enterprise') {
    const platformFee = parseMoneyValue(getSubscriptionMetadataValue(metadataSources, 'platform_fee', options.fallbackPlatformFee), { allowZero: false });
    const perRoleFee = parseMoneyValue(getSubscriptionMetadataValue(metadataSources, 'per_role_fee', options.fallbackPerRoleFee));
    const includedInterviewsPerRole = parseWholeNumber(getSubscriptionMetadataValue(metadataSources, 'included_interviews_per_role', options.fallbackIncludedInterviewsPerRole));
    const additionalInterviewFee = parseMoneyValue(getSubscriptionMetadataValue(metadataSources, 'additional_interview_fee', options.fallbackAdditionalInterviewFee));
    // Optional: Enterprise clients on the usage model price extra interviews with
    // it. The raw value is checked for presence first, because parseWholeNumber
    // reads an absent value as zero, which would silently reprice the client.
    const usageInterviewFeeCentsRaw = getSubscriptionMetadataValue(metadataSources, 'usage_interview_fee_cents', options.fallbackUsageInterviewFeeCents ?? null);
    const usageInterviewFeeCents = usageInterviewFeeCentsRaw == null
      ? null
      : parseWholeNumber(usageInterviewFeeCentsRaw);

    if (
      platformFee === null ||
      perRoleFee === null ||
      includedInterviewsPerRole === null ||
      additionalInterviewFee === null
    ) {
      return null;
    }

    // The per-client settings the agreement stated. Shape only: the commercial
    // rules were enforced when the agreement was sent and checked out, and a
    // subscription from before they existed must still provision.
    const settingsInput = {};
    for (const field of ENTERPRISE_SETTING_FIELDS) {
      const value = getSubscriptionMetadataValue(metadataSources, field, null);
      if (value != null) settingsInput[field] = value;
    }
    const settings = validateEnterpriseSettings(settingsInput, { planTier: 'enterprise', enforcePolicy: false });
    if (!settings.ok) {
      // The metadata is fixed on the subscription, so no redelivery can fix it.
      const err = permanentFailure(`Enterprise plan settings metadata invalid: ${settings.code}`);
      err.code = settings.code;
      throw err;
    }

    return {
      client_id: clientId,
      plan_tier: 'enterprise',
      billing_interval: billingInterval,
      platform_fee: platformFee,
      per_role_fee: perRoleFee,
      included_interviews_per_role: includedInterviewsPerRole,
      additional_interview_fee: additionalInterviewFee,
      // Never null: the column is NOT NULL with no default in the hosted
      // database. The agreement's length, else the tier's default length.
      // Written on every event, like the prices.
      max_interview_minutes: settings.settings.max_interview_minutes
        ?? getPlanCapacity('enterprise').max_interview_minutes,
      // Nullable: empty means the plan's question count.
      scored_question_count: settings.settings.scored_question_count,
      // The column is not nullable and defaults to 90, so it is only written
      // when the agreement stated a value.
      ...(settings.settings.rollover_days === null ? {} : { rollover_days: settings.settings.rollover_days }),
      ...(usageInterviewFeeCents === null ? {} : { usage_interview_fee_cents: usageInterviewFeeCents }),
      // Not a column write: the caller stores it only where none is stored yet.
      ...(settings.settings.billing_model === null ? {} : { billing_model: settings.settings.billing_model })
    };
  }

  return buildAlphaScreenPlanSettingsPayload({
    clientId,
    planKey: planTier,
    billingInterval
  });
}

async function upsertClientPlanSettingsFromSubscription(subscription, clientId, options = {}) {
  const payload = buildClientPlanSettingsPayloadFromSubscription(subscription, clientId, options);
  if (!payload) {
    const metadataSources = getSubscriptionMetadataSources(subscription);
    const metadataSource = String(getSubscriptionMetadataValue(metadataSources, 'source', options.fallbackSource || '') || '').trim().toLowerCase();
    const planTier = String(getSubscriptionMetadataValue(metadataSources, 'plan_tier', options.fallbackPlanTier || '') || '').trim().toLowerCase();
    if (MANAGED_SUBSCRIPTION_CHECKOUT_SOURCES.has(metadataSource) && planTier === 'enterprise') {
      const platformFee = parseMoneyValue(getSubscriptionMetadataValue(metadataSources, 'platform_fee', options.fallbackPlatformFee), { allowZero: false });
      const perRoleFee = parseMoneyValue(getSubscriptionMetadataValue(metadataSources, 'per_role_fee', options.fallbackPerRoleFee));
      const includedInterviewsPerRole = parseWholeNumber(getSubscriptionMetadataValue(metadataSources, 'included_interviews_per_role', options.fallbackIncludedInterviewsPerRole));
      const additionalInterviewFee = parseMoneyValue(getSubscriptionMetadataValue(metadataSources, 'additional_interview_fee', options.fallbackAdditionalInterviewFee));
      const missingFields = [];
      if (platformFee === null) missingFields.push('platform_fee');
      if (perRoleFee === null) missingFields.push('per_role_fee');
      if (includedInterviewsPerRole === null) missingFields.push('included_interviews_per_role');
      if (additionalInterviewFee === null) missingFields.push('additional_interview_fee');

      // Permanent: the metadata is fixed on the subscription, so every redelivery
      // would fail the same way. Acknowledged with the reason recorded, rather
      // than retried until Stripe gives up.
      const err = permanentFailure(
        `Enterprise plan settings metadata missing or unusable: ${missingFields.join(', ') || 'unknown'}. `
        + 'Each must be present; zero is allowed for included_interviews_per_role, per_role_fee '
        + 'and additional_interview_fee, but absent is not.'
      );
      err.code = 'enterprise_plan_settings_metadata_missing';
      err.missing_fields = missingFields;
      err.client_id = clientId;
      err.subscription_id = pickId(subscription?.id) || null;
      err.source = metadataSource;
      throw err;
    }
    return false;
  }
  await requireParentClientForStripeBilling(clientId, {
    route: 'stripe_webhook_client_plan_settings',
    client_id: clientId,
    subscription_id: pickId(subscription?.id) || null
  });
  // billing_model is never upserted. A stored value is an explicit choice for
  // this client and must survive subscription events; an empty one follows
  // plan_tier. An agreement that states a model has it recorded only where the
  // column is still empty, so a later event never clears or changes it.
  const { billing_model: explicitBillingModel, ...columns } = payload;
  const { error } = await supabaseAdmin
    .from('client_plan_settings')
    .upsert(columns, { onConflict: 'client_id' });
  if (error) throw new Error(error.message || 'Client plan settings upsert failed');
  if (explicitBillingModel) {
    await recordExplicitBillingModel({ db: supabaseAdmin, clientId, billingModel: explicitBillingModel });
  }
  return true;
}

function buildClientSubscriptionUpdatesFromStripe(subscription, options = {}) {
  const subStatus = String(subscription?.status || '').toLowerCase();
  const metadata = subscription?.metadata && typeof subscription?.metadata === 'object' ? subscription.metadata : {};
  const metadataSource = String(metadata?.source || options.fallbackSource || '').trim().toLowerCase();
  const metadataPlanTier = String(metadata?.plan_tier || options.fallbackPlanTier || '').trim().toLowerCase();
  const currentTermEnd = toIsoFromUnixSeconds(
    subscription?.current_period_end ??
    subscription?.items?.data?.[0]?.current_period_end ??
    null
  );
  const cancelAtTermEnd = subscription?.cancel_at_period_end === true;
  const isLive = LIVE_SUB_STATUSES.has(subStatus);
  const contractStartAt = toIsoFromUnixSeconds(subscription?.start_date) || null;
  const contractEndAt = contractStartAt ? addMonthsToIso(contractStartAt, 12) : null;
  const intervalRaw =
    subscription?.items?.data?.[0]?.price?.recurring?.interval ||
    subscription?.plan?.interval ||
    '';
  const updates = {
    stripe_customer_id: pickId(subscription?.customer) || options.fallbackCustomerId || null,
    stripe_subscription_id: pickId(subscription?.id) || options.fallbackSubscriptionId || null,
    stripe_subscription_schedule_id: pickId(subscription?.schedule) || null,
    subscription_status: subStatus || null,
    current_term_end: currentTermEnd,
    cancel_at_term_end: cancelAtTermEnd,
    billing_interval: normalizeBillingInterval(intervalRaw, options.fallbackBillingInterval || null),
    billing_status: isLive ? 'active' : 'inactive',
    auto_renew: isLive ? !cancelAtTermEnd : false,
    cancel_effective_at: isLive ? null : (currentTermEnd || new Date().toISOString()),
    contract_start_at: contractStartAt,
    contract_end_at: contractEndAt
  };
  if (MANAGED_SUBSCRIPTION_CHECKOUT_SOURCES.has(metadataSource) && ['basic', 'pro', 'enterprise'].includes(metadataPlanTier)) {
    updates.plan_tier = metadataPlanTier;
  }
  return updates;
}

// Usage billing rides the platform-fee invoice: when Stripe opens the next
// cycle's draft, the interviews a usage client ran beyond its included counts are
// added to it as line items before it finalizes.
//
// Only a draft invoice can take items. A finalized one is left alone and the
// usage stays unbilled for the next cycle, which is a delay rather than a loss.
async function addUsageLinesToInvoice(invoice, requestId) {
  const billingReason = String(invoice?.billing_reason || '').trim().toLowerCase();
  if (billingReason !== 'subscription_cycle') return;

  const invoiceId = pickId(invoice?.id);
  const subscriptionId = pickId(invoice?.subscription);
  const customerId = pickId(invoice?.customer);
  if (!invoiceId || (!subscriptionId && !customerId)) return;

  let client = null;
  if (subscriptionId) {
    const { data, error } = await supabaseAdmin
      .from('clients')
      .select('id,stripe_customer_id')
      .eq('stripe_subscription_id', subscriptionId)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Usage billing client lookup failed');
    client = data || null;
  }
  if (!client && customerId) {
    const { data, error } = await supabaseAdmin
      .from('clients')
      .select('id,stripe_customer_id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle();
    if (error) throw new Error(error.message || 'Usage billing client lookup failed');
    client = data || null;
  }
  if (!client?.id) return;

  const billing = await resolveBillingModel({ db: supabaseAdmin, clientId: client.id });
  if (billing.billing_model !== 'usage') return;

  const invoiceStatus = String(invoice?.status || '').trim().toLowerCase();
  if (invoiceStatus && invoiceStatus !== 'draft') {
    console.warn('usage_invoice_already_finalized', {
      request_id: requestId || null,
      client_id: client.id,
      stripe_invoice_id: invoiceId,
      status: invoiceStatus
    });
    return;
  }

  // The period is the prior calendar month, decided by interviews.completed_at.
  // Nothing here reads the invoice's own period or a previous ledger row.
  //
  // The month is anchored on when Stripe raised this invoice rather than on the
  // wall clock, so a redelivery days later still bills the same month.
  const result = await applyUsageToInvoice({
    db: supabaseAdmin,
    stripe,
    clientId: client.id,
    customerId: customerId || client.stripe_customer_id || null,
    invoiceId,
    asOf: toIsoFromUnixSeconds(invoice?.created) || undefined,
    metadata: { stripe_invoice_id: invoiceId }
  });

  console.log('usage_invoice_lines_applied', {
    request_id: requestId || null,
    client_id: client.id,
    stripe_invoice_id: invoiceId,
    applied: result.applied === true,
    reason: result.reason || null,
    items: result.items,
    total_cents: result.total_cents
  });
}

function shouldIgnoreStaleSubscriptionUpdate(client, incomingSubscriptionId, eventType) {
  const currentSubscriptionId = String(client?.stripe_subscription_id || '').trim();
  const subscriptionId = String(incomingSubscriptionId || '').trim();
  if (!currentSubscriptionId || !subscriptionId || currentSubscriptionId === subscriptionId) return false;
  console.log('stripe_webhook_subscription_stale_ignored', {
    client_id: client?.id || null,
    incoming_subscription_id: subscriptionId,
    current_subscription_id: currentSubscriptionId,
    event_type: eventType || null
  });
  return true;
}

// Reads and cross-checks the pool a checkout session names, writing nothing.
// Metadata that disagrees with the row means the session is not describing this
// pool, the same cross-checks the additional-interviews branch makes, and no
// retry will change that.
async function loadInterviewPoolForCheckout(metadata = {}) {
  const poolId = String(metadata?.client_interview_pool_id || '').trim();
  if (!poolId) throw permanentFailure('Interview pool id missing from checkout metadata');

  const { data: pool, error: poolLookupErr } = await supabaseAdmin
    .from('client_interview_pools')
    .select('id,client_id,quantity_purchased,status,offer_snapshot,offer_digest')
    .eq('id', poolId)
    .maybeSingle();
  if (poolLookupErr) throw new Error(poolLookupErr.message || 'Interview pool lookup failed');
  if (!pool) throw permanentFailure('Interview pool not found');
  // Prospective native price proof is required BEFORE any client activation;
  // old metadata-only settlement must never grant new-protocol pool credits.
  if(pool.offer_snapshot!==null || pool.offer_digest!==null)throw permanentFailure('ENTERPRISE_POOL_V2_PAYMENT_PROOF_REQUIRED');

  const metadataClientId = String(metadata?.client_id || '').trim();
  if (metadataClientId && String(pool.client_id) !== metadataClientId) {
    throw permanentFailure('Interview pool client mismatch');
  }
  const metadataPoolQuantity = Number(metadata?.pool_quantity);
  if (Number.isInteger(metadataPoolQuantity) && metadataPoolQuantity > 0
    && Number(pool.quantity_purchased) !== metadataPoolQuantity) {
    throw permanentFailure('Interview pool quantity mismatch');
  }
  return pool;
}

// Grants the pool only on settled money; a failed payment fails it, and an
// unsettled one leaves it pending.
async function settleInterviewPoolFromCheckout(pool, { paymentFailed, paymentSettled, session, requestId } = {}) {
  if (paymentFailed) {
    await markPoolFailed({ db: supabaseAdmin, poolId: pool.id });
    console.warn('[stripe-webhook][interview-pool] payment_failed', {
      request_id: requestId, client_interview_pool_id: pool.id, client_id: pool.client_id
    });
    return;
  }
  if (!paymentSettled) {
    console.log('[stripe-webhook][interview-pool] payment_not_settled', {
      request_id: requestId,
      client_interview_pool_id: pool.id,
      payment_status: String(session?.payment_status || '') || null
    });
    return;
  }
  const result = await markPoolPaid({
    db: supabaseAdmin,
    poolId: pool.id,
    stripePaymentIntentId: pickId(session?.payment_intent) || null
  });
  console.log('[stripe-webhook][interview-pool] settled', {
    request_id: requestId,
    client_interview_pool_id: pool.id,
    client_id: pool.client_id,
    paid: result.paid === true,
    reason: result.reason || null
  });
}

function buildEnterprisePlanSettingsForActivation(options = {}) {
  const subscription = options.subscription || null;
  const clientId = String(options.fallbackClientId || subscription?.metadata?.client_id || '').trim();
  if (!subscription || !clientId) return null;
  const payload = buildClientPlanSettingsPayloadFromSubscription(subscription, clientId, {
    fallbackSource: 'agreement_checkout',
    fallbackPlanTier: options.fallbackPlanTier || null,
    fallbackBillingInterval: options.fallbackBillingInterval || null
  });
  return payload?.plan_tier === 'enterprise' ? payload : null;
}

async function markAgreementCheckoutPaid(agreementId, options = {}) {
  const normalizedAgreementId = String(agreementId || '').trim();
  if (!normalizedAgreementId) return;
  const db = options.db || supabaseAdmin;
  const claim = await claimAgreementPurchaseActivation(
    normalizedAgreementId,
    options.checkoutSessionId || null,
    db
  );
  if (!claim.proceed) return claim.result;
  let heartbeatTimer = null;
  let fenceLost = false;
  let fenceQueue = Promise.resolve();
  const serializeFenceOperation = (operation) => {
    const pending = fenceQueue.then(operation);
    // Keep the queue usable after a transient provider/network failure;
    // only an explicit false heartbeat proves the lease was lost.
    fenceQueue = pending.catch(() => {});
    return pending;
  };
  const fenceError = (message) => {
    const error = new Error(message || 'Purchase activation fence was lost');
    error.code = 'activation_fence_lost';
    return error;
  };
  const heartbeat = async () => {
    if (!claim.claimed || fenceLost) return;
    const { data, error } = await db.rpc('heartbeat_public_purchase_activation', {
      p_intent_id: claim.intentId,
      p_claim_key: claim.key
    });
    if (data === false) {
      fenceLost = true;
      throw fenceError();
    }
    if (error || data !== true) {
      const failure = new Error(error?.message || 'Purchase activation fence could not be verified');
      failure.code = 'activation_fence_unverified';
      throw failure;
    }
  };
  const assertFence = async () => {
    if (fenceLost) throw fenceError();
    await serializeFenceOperation(heartbeat);
  };
  const fencedDb = claim.claimed ? new Proxy(db, {
    get(target, key) {
      if (key === 'rpc') return (name, args) => serializeFenceOperation(() => target.rpc(name, args));
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  }) : db;
  if (claim.claimed) {
    heartbeatTimer = setInterval(() => {
      serializeFenceOperation(heartbeat).catch((error) => {
        console.warn('stripe_webhook_activation_heartbeat_unverified', {
          purchase_intent_id: claim.intentId,
          code: error?.code || null
        });
      });
    }, 30000);
    heartbeatTimer.unref?.();
  }
  try {
    const activate = options.activate || activatePublicPurchaseAgreementCheckout;
    // Enterprise prices are per client and travel on the subscription, so they are
    // read here with the same builder the subscription events use. Null for any
    // other tier, which takes its package defaults.
    const enterprisePlanSettings = buildEnterprisePlanSettingsForActivation(options);
    const result = await activate({
      agreementId: normalizedAgreementId,
      checkoutSessionId: options.checkoutSessionId || null,
      paidAt: options.paidAt || null,
      subscription: options.subscription || null,
      fallbackCustomerId: options.fallbackCustomerId || null,
      fallbackSubscriptionId: options.fallbackSubscriptionId || null,
      fallbackClientId: options.fallbackClientId || null,
      fallbackPlanTier: options.fallbackPlanTier || null,
      fallbackBillingInterval: options.fallbackBillingInterval || null,
      requestId: options.requestId || null,
      enterprisePlanSettings,
      activationClaimKey: claim.claimed ? claim.key : null,
      activationIntentId: claim.claimed ? claim.intentId : null,
      assertActivationFence: assertFence,
      db: fencedDb
    });
    return result;
  } catch (error) {
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await fenceQueue;
    if (claim.claimed) await releaseAgreementPurchaseActivationClaim(claim.intentId, claim.key, db);
    if (fenceLost) throw fenceError();
  }
}

function isInitialAgreementCheckoutInvoice(eventType, metadataSource, agreementId, billingReason) {
  return eventType === 'invoice.payment_succeeded' &&
    metadataSource === 'agreement_checkout' &&
    Boolean(agreementId) &&
    String(billingReason || '').trim().toLowerCase() === 'subscription_create';
}

// An agreement payment that fails to activate is answered 503 so Stripe redelivers
// it. async_payment_succeeded is included because a delayed-notification payment
// activates on that event rather than on checkout.session.completed.
async function isRetryableAgreementActivationEvent(event) {
  const object = event?.data?.object || {};
  if (event?.type === 'checkout.session.completed' || event?.type === 'checkout.session.async_payment_succeeded') {
    const metadata = object.metadata || {};
    return isSettledPayment(object) &&
      String(metadata.source || '').toLowerCase() === 'agreement_checkout' &&
      Boolean(String(metadata.agreement_id || '').trim());
  }
  if (event?.type !== 'invoice.payment_succeeded' || object.billing_reason !== 'subscription_create') return false;
  let metadata = object.metadata || {};
  if ((!metadata.source || !metadata.agreement_id) && pickId(object.subscription)) {
    const subscription = await stripe.subscriptions.retrieve(pickId(object.subscription));
    metadata = { ...(subscription?.metadata || {}), ...metadata };
  }
  return isInitialAgreementCheckoutInvoice(
    event.type,
    String(metadata.source || '').toLowerCase(),
    String(metadata.agreement_id || '').trim(),
    object.billing_reason
  );
}

function requireAgreementActivationResult(result) {
  if (result?.ok === true) return;
  if (['purchase_canceled', 'agreement_superseded', 'historical_complete'].includes(result?.status)) return;
  const error = new Error(`Agreement checkout activation incomplete: ${result?.status || 'unknown'}`);
  error.code = result?.status || 'agreement_activation_incomplete';
  throw error;
}

async function claimAgreementPurchaseActivation(agreementId, checkoutSessionId, db = supabaseAdmin) {
  const normalizedAgreementId = String(agreementId || '').trim();
  if (!normalizedAgreementId) return { proceed: false, result: { ok: false, status: 'agreement_missing' } };
  const key = `${String(checkoutSessionId || '').trim() || `agreement:${normalizedAgreementId}`}:${crypto.randomUUID()}`;
  const { data, error } = await db.rpc('claim_public_purchase_activation', {
    p_agreement_id: normalizedAgreementId,
    p_claim_key: key
  });
  if (error) throw new Error(error.message || 'Purchase activation claim failed');
  if (data?.status === 'claimed') return { proceed: true, claimed: true, intentId: data.intent_id, key };
  // An agreement issued outside the public purchase flow has no purchase intent, so
  // there is nothing to fence. It activates unclaimed, as it did before the fence.
  if (data?.status === 'purchase_intent_missing') return { proceed: true, claimed: false };
  return { proceed: false, result: {
    ok: false,
    status: data?.status || 'activation_claim_failed',
    purchase_intent_id: data?.intent_id || null
  } };
}

async function releaseAgreementPurchaseActivationClaim(intentId, claimKey, db = supabaseAdmin) {
  if (!intentId || !claimKey) return;
  const { error } = await db.rpc('release_public_purchase_activation', {
    p_intent_id: intentId,
    p_claim_key: claimKey
  });
  if (error) console.error('stripe_webhook_activation_claim_release_failed', {
    purchase_intent_id: intentId,
    error: error.message || String(error)
  });
}

async function shouldApplyGenericSubscriptionUpdate(metadata, db = supabaseAdmin) {
  const source = String(metadata?.source || '').trim().toLowerCase();
  const agreementId = String(metadata?.agreement_id || '').trim();
  if (source !== 'agreement_checkout' || !agreementId) return true;
  const { data: intent, error } = await db
    .from('public_purchase_intents')
    .select('id,status,activated_at,canceled_at')
    .eq('agreement_id', agreementId)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Public purchase intent lookup failed');
  if (!intent) return true;
  return String(intent.status || '').trim().toLowerCase() === 'completed' && !!intent.activated_at && !intent.canceled_at;
}

router.post('/', async (req, res) => {
  const request_id = req.request_id || null;
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    // The verification detail stays server-side: it describes the verification path to a
    // caller who by definition could not authenticate.
    console.warn('[stripe-webhook] signature_verification_failed', {
      request_id,
      detail: err?.message || 'invalid signature'
    });
    return res.status(400).json({
      error: 'bad_request',
      code: 'STRIPE_SIGNATURE_VERIFICATION_FAILED',
      detail: 'Signature verification failed.',
      hint: null,
      request_id
    });
  }

  const eventObject = event?.data?.object || null;
  let retryableAgreementEvent = false;
  try {
    retryableAgreementEvent = await isRetryableAgreementActivationEvent(event);
  } catch (error) {
    return res.status(503).json({ error: 'server_error', code: 'AGREEMENT_EVENT_CLASSIFICATION_FAILED', request_id });
  }
  // processed_ok starts false rather than null so the "never downgrade true" guard
  // in markProcessed (processed_ok <> true) also matches a row nobody has finished.
  const { error: insertErr } = await supabaseAdmin
    .from('billing_events')
    .insert({
      stripe_event_id: event.id,
      type: event.type,
      payload: eventObject,
      processed_ok: false
    });

  if (insertErr) {
    if (isUniqueViolation(insertErr)) {
      if (!retryableAgreementEvent) return res.status(200).json({ ok: true });
      const { data: priorEvent, error: priorEventError } = await supabaseAdmin
        .from('billing_events')
        .select('processed_ok')
        .eq('stripe_event_id', event.id)
        .maybeSingle();
      if (priorEventError || !priorEvent) {
        return res.status(503).json({ error: 'server_error', code: 'BILLING_EVENT_REENTRY_LOOKUP_FAILED', request_id });
      }
      if (priorEvent.processed_ok === true) return res.status(200).json({ ok: true });
      // An incomplete verified paid agreement event may re-enter. The fenced
      // claim below serializes it with another retry or the initial invoice.
    } else {
      return res.status(500).json({
        error: 'server_error',
        code: 'BILLING_EVENT_INSERT_FAILED',
        detail: insertErr.message,
        hint: insertErr.hint || null,
        request_id
      });
    }
  }

  const markProcessed = async (processed_ok, errorText = null) => {
    let query = supabaseAdmin
      .from('billing_events')
      .update({
        processed_ok,
        error: errorText
      })
      .eq('stripe_event_id', event.id);
    if (!processed_ok) query = query.neq('processed_ok', true);
    const { error } = await query;
    if (error) throw new Error(error.message || 'Billing event status update failed');
  };

  try {
    if (String(event.type || '').startsWith('invoice.')) {
      await syncBillingInvoiceFromStripeEvent(eventObject, request_id);
    }

    if (event.type === 'invoice.created') {
      await addUsageLinesToInvoice(eventObject, request_id);
    }

    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const customerId = pickId(eventObject?.customer);
      const subscriptionMetadata = eventObject?.metadata && typeof eventObject.metadata === 'object'
        ? eventObject.metadata
        : {};
      const allowGenericSubscriptionUpdate = await shouldApplyGenericSubscriptionUpdate(subscriptionMetadata);
      if (customerId) {
        const incomingSubscriptionId = pickId(eventObject?.id) || pickId(eventObject?.subscription) || null;
        const { data: client, error: clientErr } = await supabaseAdmin
          .from('clients')
          .select('id,stripe_subscription_id')
          .eq('stripe_customer_id', customerId)
          .maybeSingle();
        if (clientErr) throw new Error(clientErr.message || 'Client lookup failed');
        if (client?.id && allowGenericSubscriptionUpdate && !shouldIgnoreStaleSubscriptionUpdate(client, incomingSubscriptionId, event.type)) {
          await requireParentClientForStripeBilling(client.id, {
            route: 'stripe_webhook_customer_subscription',
            event_type: event.type,
            client_id: client.id,
            customer_id: customerId,
            subscription_id: incomingSubscriptionId
          });
          const updates = buildClientSubscriptionUpdatesFromStripe(eventObject, {
            fallbackCustomerId: customerId,
            fallbackSubscriptionId: incomingSubscriptionId
          });
          const { error: updateErr } = await supabaseAdmin
            .from('clients')
            .update(updates)
            .eq('id', client.id);
          if (updateErr) throw new Error(updateErr.message || 'Client update failed');
          if (event.type !== 'customer.subscription.deleted') {
            await upsertClientPlanSettingsFromSubscription(eventObject, client.id, {
              fallbackPlanTier: updates?.plan_tier || null,
              fallbackBillingInterval: updates?.billing_interval || null
            });
          }
        } else if (client?.id && !allowGenericSubscriptionUpdate) {
          console.warn('[stripe-webhook] agreement_subscription_update_deferred', {
            agreement_id: String(subscriptionMetadata?.agreement_id || '').trim() || null,
            client_id: client.id,
            event_type: event.type
          });
        }
      }
    } else if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded' ||
      event.type === 'checkout.session.async_payment_failed'
    ) {
      const metadata = eventObject?.metadata && typeof eventObject.metadata === 'object' ? eventObject.metadata : {};
      const purchaseType = String(metadata?.purchase_type || '').trim().toLowerCase();
      const metadataSource = String(metadata?.source || '').trim().toLowerCase();
      const metadataClientId = String(metadata?.client_id || '').trim();
      const metadataAgreementId = String(metadata?.agreement_id || '').trim();
      const metadataPlanTier = String(metadata?.plan_tier || '').trim().toLowerCase();
      const metadataBillingInterval = String(metadata?.billing_interval || '').trim().toLowerCase();
      const customerId = pickId(eventObject?.customer);
      // checkout.session.completed can arrive before the money settles for
      // delayed-notification payment methods, so entitlement is granted on the payment
      // status rather than on the session having completed.
      const paymentFailed = event.type === 'checkout.session.async_payment_failed';
      const paymentSettled = !paymentFailed && isSettledPayment(eventObject);
      const isSubscriptionSession = String(eventObject?.mode || '').toLowerCase() === 'subscription';

      // An Enterprise pool is sold on the membership's own subscription session, so
      // that one event has to settle the pool and activate the subscription. The
      // pool is checked first, before anything is written: a pool the session does
      // not describe is a permanent failure, and refusing it here leaves nothing
      // half-done. It is settled last, once activation has succeeded, so a pool is
      // never spendable for a membership whose activation failed.
      const interviewPool = purchaseType === 'interview_pool'
        ? await loadInterviewPoolForCheckout(metadata)
        : null;

      if (interviewPool && !isSubscriptionSession) {
        // A pool on a session of its own: nothing to activate; settled below.
      } else if (purchaseType === 'additional_interviews') {
        const purchaseId = String(metadata?.role_interview_purchase_id || '').trim();
        const metadataRoleId = String(metadata?.role_id || '').trim();
        const metadataQuantity = Number(metadata?.quantity);
        let purchase = null;

        if (purchaseId) {
          const { data: purchaseById, error: purchaseByIdErr } = await supabaseAdmin
            .from('role_interview_purchases')
            .select('id,client_id,role_id,quantity,status')
            .eq('id', purchaseId)
            .maybeSingle();
          if (purchaseByIdErr) throw new Error(purchaseByIdErr.message || 'Role interview purchase lookup failed');
          purchase = purchaseById || null;
        } else if (metadataClientId && metadataRoleId) {
          const { data: purchaseByMeta, error: purchaseByMetaErr } = await supabaseAdmin
            .from('role_interview_purchases')
            .select('id,client_id,role_id,quantity,status')
            .eq('client_id', metadataClientId)
            .eq('role_id', metadataRoleId)
            .eq('status', 'pending')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (purchaseByMetaErr) throw new Error(purchaseByMetaErr.message || 'Role interview purchase lookup failed');
          purchase = purchaseByMeta || null;
        }

        if (!purchase) {
          console.warn('[stripe-webhook][additional-interviews] purchase_not_found', {
            role_interview_purchase_id: purchaseId || null,
            client_id: metadataClientId || null,
            role_id: metadataRoleId || null
          });
          throw permanentFailure('Role interview purchase not found');
        }

        console.log('[stripe-webhook][additional-interviews] purchase_found', {
          role_interview_purchase_id: purchase.id,
          client_id: purchase.client_id,
          role_id: purchase.role_id,
          status: purchase.status
        });

        if (metadataClientId && purchase.client_id !== metadataClientId) {
          throw permanentFailure('Role interview purchase client mismatch');
        }
        if (metadataRoleId && purchase.role_id !== metadataRoleId) {
          throw permanentFailure('Role interview purchase role mismatch');
        }
        if (Number.isFinite(metadataQuantity) && Number.isInteger(metadataQuantity) && metadataQuantity > 0) {
          if (Number(purchase.quantity) !== metadataQuantity) {
            throw permanentFailure('Role interview purchase quantity mismatch');
          }
        }

        if (paymentFailed) {
          console.warn('[stripe-webhook][additional-interviews] payment_failed', {
            request_id,
            role_interview_purchase_id: purchase.id,
            client_id: purchase.client_id,
            role_id: purchase.role_id
          });
          const { error: markFailedErr } = await supabaseAdmin
            .from('role_interview_purchases')
            .update({ status: 'failed' })
            .eq('id', purchase.id)
            .in('status', ['pending']);
          if (markFailedErr) throw new Error(markFailedErr.message || 'Role interview purchase failed update failed');
        } else if (!paymentSettled) {
          // Delayed payment method: wait for checkout.session.async_payment_succeeded.
          console.log('[stripe-webhook][additional-interviews] payment_not_settled', {
            request_id,
            role_interview_purchase_id: purchase.id,
            client_id: purchase.client_id,
            role_id: purchase.role_id,
            payment_status: String(eventObject?.payment_status || '') || null
          });
        } else if (String(purchase.status || '').trim().toLowerCase() === 'paid') {
          console.log('[stripe-webhook][additional-interviews] already_paid', {
            role_interview_purchase_id: purchase.id,
            client_id: purchase.client_id,
            role_id: purchase.role_id
          });
        } else {
          const { error: markPaidErr } = await supabaseAdmin
            .from('role_interview_purchases')
            .update({
              status: 'paid',
              stripe_payment_intent_id: pickId(eventObject?.payment_intent) || null,
              stripe_invoice_id: pickId(eventObject?.invoice) || null
            })
            .eq('id', purchase.id)
            .in('status', ['pending', 'paid']);
          if (markPaidErr) throw new Error(markPaidErr.message || 'Role interview purchase paid update failed');

          console.log('[stripe-webhook][additional-interviews] marked_paid', {
            role_interview_purchase_id: purchase.id,
            client_id: purchase.client_id,
            role_id: purchase.role_id,
            stripe_payment_intent_id: pickId(eventObject?.payment_intent) || null,
            stripe_invoice_id: pickId(eventObject?.invoice) || null
          });
        }

        const availability = paymentSettled
          ? await getRoleInterviewAvailability({
            db: supabaseAdmin,
            roleId: purchase.role_id,
            clientId: purchase.client_id
          })
          : { remaining_interviews: null };
        if (availability.remaining_interviews != null && availability.remaining_interviews > 0) {
          const { error: resetNotifyErr } = await supabaseAdmin
            .from('roles')
            .update({ interview_limit_notified_at: null })
            .eq('id', purchase.role_id)
            .eq('client_id', purchase.client_id)
            .not('interview_limit_notified_at', 'is', null);
          if (resetNotifyErr) throw new Error(resetNotifyErr.message || 'Role interview limit notify reset failed');

          console.log('[stripe-webhook][additional-interviews] notify_marker_reset', {
            role_interview_purchase_id: purchase.id,
            client_id: purchase.client_id,
            role_id: purchase.role_id,
            remaining_interviews: availability.remaining_interviews
          });
        } else {
          console.log('[stripe-webhook][additional-interviews] notify_marker_reset_skipped', {
            role_interview_purchase_id: purchase.id,
            client_id: purchase.client_id,
            role_id: purchase.role_id,
            remaining_interviews: availability.remaining_interviews
          });
        }
      } else if (metadataSource === 'client_role_purchase') {
        const pendingRolePurchaseId = String(metadata?.pending_role_purchase_id || '').trim();
        if (!pendingRolePurchaseId) throw permanentFailure('Pending role purchase id missing');
        const { data: pendingRolePurchase, error: pendingRolePurchaseErr } = await supabaseAdmin
          .from('pending_role_purchases')
          .select('id,client_id,status,role_title,interview_type,jd_storage_path,created_at,paid_at,finalized_role_id')
          .eq('id', pendingRolePurchaseId)
          .maybeSingle();
        if (pendingRolePurchaseErr) throw new Error(pendingRolePurchaseErr.message || 'Pending role purchase lookup failed');
        if (!pendingRolePurchase) throw permanentFailure('Pending role purchase not found');

        if (paymentFailed) {
          console.warn('[stripe-webhook][client-role-purchase] payment_failed', {
            request_id,
            pending_role_purchase_id: pendingRolePurchase.id,
            client_id: pendingRolePurchase.client_id
          });
          const { error: markFailedErr } = await supabaseAdmin
            .from('pending_role_purchases')
            .update({ status: 'failed' })
            .eq('id', pendingRolePurchase.id)
            .is('finalized_role_id', null)
            .in('status', ['pending']);
          if (markFailedErr) throw new Error(markFailedErr.message || 'Pending role purchase failed update failed');
        } else if (!paymentSettled) {
          // Delayed payment method: wait for checkout.session.async_payment_succeeded.
          console.log('[stripe-webhook][client-role-purchase] payment_not_settled', {
            request_id,
            pending_role_purchase_id: pendingRolePurchase.id,
            client_id: pendingRolePurchase.client_id,
            payment_status: String(eventObject?.payment_status || '') || null
          });
        } else if (!pendingRolePurchase.finalized_role_id) {
          const amountTotal = Number(eventObject?.amount_total);
          const { error: markPaidErr } = await supabaseAdmin
            .from('pending_role_purchases')
            .update({
              status: 'paid',
              stripe_checkout_session_id: pickId(eventObject?.id) || null,
              stripe_payment_intent_id: pickId(eventObject?.payment_intent) || null,
              stripe_customer_id: customerId || null,
              amount_paid: Number.isFinite(amountTotal) ? (amountTotal / 100) : null,
              paid_at: new Date().toISOString()
            })
            .is('finalized_role_id', null)
            .in('status', ['pending', 'paid'])
            .eq('id', pendingRolePurchase.id);
          if (markPaidErr) throw new Error(markPaidErr.message || 'Pending role purchase paid update failed');

          const { data: initialClaimedPendingRolePurchase, error: claimFinalizeErr } = await supabaseAdmin
            .from('pending_role_purchases')
            .update({ status: 'finalizing' })
            .eq('id', pendingRolePurchase.id)
            .is('finalized_role_id', null)
            .in('status', ['pending', 'paid'])
            .select('id,client_id,role_title,interview_type,jd_storage_path,created_at,paid_at')
            .maybeSingle();
          if (claimFinalizeErr) throw new Error(claimFinalizeErr.message || 'Pending role purchase claim failed');
          let claimedPendingRolePurchase = initialClaimedPendingRolePurchase || null;
          if (!claimedPendingRolePurchase) {
            const { data: inProgressPendingRolePurchase, error: inProgressClaimErr } = await supabaseAdmin
              .from('pending_role_purchases')
              .select('id,client_id,role_title,interview_type,jd_storage_path,created_at,paid_at')
              .eq('id', pendingRolePurchase.id)
              .is('finalized_role_id', null)
              .eq('status', 'finalizing')
              .maybeSingle();
            if (inProgressClaimErr) throw new Error(inProgressClaimErr.message || 'Pending role purchase claim failed');
            claimedPendingRolePurchase = inProgressPendingRolePurchase || null;
          }
          if (claimedPendingRolePurchase) {
            await finalizePendingRolePurchase({
              db: supabaseAdmin,
              pendingRolePurchase: claimedPendingRolePurchase
            });
          }
        }
      } else if (
        (event.type === 'checkout.session.completed'
          || event.type === 'checkout.session.async_payment_succeeded')
        && String(eventObject?.mode || '').toLowerCase() === 'subscription'
      ) {
        // async_payment_succeeded is admitted because a delayed-notification payment
        // settles after the session completes; without it an agreement paid that way
        // would never activate. async_payment_failed is deliberately excluded.
        const subscriptionId = pickId(eventObject?.subscription);
        let targetClientId = null;
        let checkoutSubscription = null;
        const isPaidAgreementCheckout =
          metadataSource === 'agreement_checkout' &&
          !!metadataAgreementId &&
          isSettledPayment(eventObject);

        if (subscriptionId) {
          if (metadataClientId) {
            const { data: metadataClient, error: metadataClientErr } = await supabaseAdmin
              .from('clients')
              .select('id')
              .eq('id', metadataClientId)
              .maybeSingle();
            if (metadataClientErr) throw new Error(metadataClientErr.message || 'Client lookup failed');
            targetClientId = metadataClient?.id || null;
          }
          if (!targetClientId && customerId) {
            const { data: customerClient, error: customerClientErr } = await supabaseAdmin
              .from('clients')
              .select('id')
              .eq('stripe_customer_id', customerId)
              .maybeSingle();
            if (customerClientErr) throw new Error(customerClientErr.message || 'Client lookup failed');
            targetClientId = customerClient?.id || null;
          }
          if (targetClientId) {
            await requireParentClientForStripeBilling(targetClientId, {
              route: 'stripe_webhook_checkout_subscription',
              client_id: targetClientId,
              customer_id: customerId,
              subscription_id: subscriptionId,
              source: metadataSource || null
            });
            checkoutSubscription = await stripe.subscriptions.retrieve(subscriptionId);
            // Same rule the additional-interviews path follows: a completed session
            // whose payment has not settled grants nothing.
            if (!isPaidAgreementCheckout && paymentSettled) {
              const updates = buildClientSubscriptionUpdatesFromStripe(checkoutSubscription, {
                fallbackCustomerId: customerId,
                fallbackSubscriptionId: subscriptionId,
                fallbackBillingInterval: metadataBillingInterval,
                fallbackSource: metadataSource,
                fallbackPlanTier: metadataPlanTier
              });
              const { error: updateErr } = await supabaseAdmin
                .from('clients')
                .update(updates)
                .eq('id', targetClientId);
              if (updateErr) throw new Error(updateErr.message || 'Client update failed');

              if (MANAGED_SUBSCRIPTION_CHECKOUT_SOURCES.has(metadataSource)) {
                const planTierForSettings = String(updates?.plan_tier || metadataPlanTier || '').trim().toLowerCase();
                const planSettingsUpserted = await upsertClientPlanSettingsFromSubscription(checkoutSubscription, targetClientId, {
                  fallbackSource: metadataSource,
                  fallbackPlanTier: updates?.plan_tier || metadataPlanTier || null,
                  fallbackBillingInterval: updates?.billing_interval || metadataBillingInterval || null,
                  fallbackPlatformFee: metadata?.platform_fee,
                  fallbackPerRoleFee: metadata?.per_role_fee,
                  fallbackIncludedInterviewsPerRole: metadata?.included_interviews_per_role,
                  fallbackAdditionalInterviewFee: metadata?.additional_interview_fee
                });
                if (!planSettingsUpserted && planTierForSettings === 'enterprise') {
                  const err = new Error('Enterprise plan settings upsert skipped');
                  err.code = 'enterprise_plan_settings_upsert_skipped';
                  err.client_id = targetClientId;
                  err.subscription_id = subscriptionId;
                  err.source = metadataSource;
                  throw err;
                }
              }
            }
          }
        }

        if (isPaidAgreementCheckout) {
          const activation = await markAgreementCheckoutPaid(metadataAgreementId, {
            checkoutSessionId: pickId(eventObject?.id) || null,
            paidAt: toIsoFromUnixSeconds(event?.created) || new Date().toISOString(),
            subscription: checkoutSubscription || (subscriptionId ? await stripe.subscriptions.retrieve(subscriptionId) : null),
            fallbackCustomerId: customerId,
            fallbackSubscriptionId: subscriptionId,
            fallbackClientId: targetClientId || metadataClientId || null,
            fallbackPlanTier: metadataPlanTier,
            fallbackBillingInterval: metadataBillingInterval,
            requestId: request_id
          });
          requireAgreementActivationResult(activation);
        }
      }

      if (interviewPool) {
        await settleInterviewPoolFromCheckout(interviewPool, {
          paymentFailed, paymentSettled, session: eventObject, requestId: request_id
        });
      }
    } else if (event.type === 'invoice.payment_succeeded' || event.type === 'invoice.payment_failed') {
      const customerId = pickId(eventObject?.customer);
      const subscriptionId = pickId(eventObject?.subscription);
      let invoiceSubscription = null;
      let metadata = eventObject?.metadata && typeof eventObject.metadata === 'object' ? eventObject.metadata : {};
      if (
        subscriptionId &&
        (
          !String(metadata?.source || '').trim() ||
          !String(metadata?.agreement_id || '').trim() ||
          !String(metadata?.client_id || '').trim()
        )
      ) {
        invoiceSubscription = await stripe.subscriptions.retrieve(subscriptionId);
        const subscriptionMetadata = invoiceSubscription?.metadata && typeof invoiceSubscription.metadata === 'object'
          ? invoiceSubscription.metadata
          : {};
        metadata = {
          ...subscriptionMetadata,
          ...metadata
        };
      }
      const metadataSource = String(metadata?.source || '').trim().toLowerCase();
      const metadataClientId = String(metadata?.client_id || '').trim();
      const metadataAgreementId = String(metadata?.agreement_id || '').trim();
      const metadataPlanTier = String(metadata?.plan_tier || '').trim().toLowerCase();
      const metadataBillingInterval = String(metadata?.billing_interval || '').trim().toLowerCase();
      const isAgreementCheckoutInvoice = isInitialAgreementCheckoutInvoice(
        event.type,
        metadataSource,
        metadataAgreementId,
        eventObject?.billing_reason
      );
      const isManagedSubscriptionInvoice =
        event.type === 'invoice.payment_succeeded' &&
        MANAGED_SUBSCRIPTION_CHECKOUT_SOURCES.has(metadataSource) &&
        metadataSource !== 'agreement_checkout' &&
        !isAgreementCheckoutInvoice &&
        !!metadataClientId &&
        ['basic', 'pro', 'enterprise'].includes(metadataPlanTier) &&
        ['monthly', 'annual'].includes(metadataBillingInterval);

      if (isManagedSubscriptionInvoice) {
        const { data: activationClient, error: activationClientErr } = await supabaseAdmin
          .from('clients')
          .select('id')
          .eq('id', metadataClientId)
          .maybeSingle();
        if (activationClientErr) throw new Error(activationClientErr.message || 'Client lookup failed');
        if (!activationClient?.id) throw new Error('Client lookup failed');
        await requireParentClientForStripeBilling(activationClient.id, {
          route: 'stripe_webhook_invoice_managed_activation',
          client_id: activationClient.id,
          subscription_id: subscriptionId,
          source: metadataSource || null
        });

        const contractStartAt = new Date().toISOString();
        const contractEndAt = addMonthsToIso(contractStartAt, 12);
        const invoicePeriodEnd = toIsoFromUnixSeconds(eventObject?.lines?.data?.[0]?.period?.end);
        const activationUpdates = {
          plan_tier: metadataPlanTier,
          subscription_status: 'active',
          billing_status: 'active',
          billing_interval: metadataBillingInterval,
          auto_renew: true,
          cancel_at_term_end: false,
          cancel_effective_at: null,
          contract_start_at: contractStartAt,
          contract_end_at: contractEndAt
        };
        if (!subscriptionId || invoicePeriodEnd) {
          activationUpdates.current_term_end = invoicePeriodEnd || contractEndAt;
        }
        const { error: activationErr } = await supabaseAdmin
          .from('clients')
          .update(activationUpdates)
          .eq('id', activationClient.id);
        if (activationErr) throw new Error(activationErr.message || 'Client activation update failed');
      }

      if (isAgreementCheckoutInvoice) {
        // Checkout and invoice can arrive in either order. Use the same Stripe
        // subscription snapshot for the first billing digest on both paths.
        if (subscriptionId && !invoiceSubscription) {
          invoiceSubscription = await stripe.subscriptions.retrieve(subscriptionId);
        }
        const activation = await markAgreementCheckoutPaid(metadataAgreementId, {
          paidAt: toIsoFromUnixSeconds(event?.created) || new Date().toISOString(),
          subscription: invoiceSubscription || null,
          fallbackCustomerId: customerId,
          fallbackSubscriptionId: subscriptionId,
          fallbackClientId: metadataClientId,
          fallbackPlanTier: metadataPlanTier,
          fallbackBillingInterval: metadataBillingInterval,
          requestId: request_id
        });
        requireAgreementActivationResult(activation);
      }

      if (customerId && !isManagedSubscriptionInvoice && !isAgreementCheckoutInvoice) {
        const { data: client, error: clientErr } = await supabaseAdmin
          .from('clients')
          .select('id,stripe_subscription_id')
          .eq('stripe_customer_id', customerId)
          .maybeSingle();
        if (clientErr) throw new Error(clientErr.message || 'Client lookup failed');
        if (client?.id) {
          if (subscriptionId && !shouldIgnoreStaleSubscriptionUpdate(client, subscriptionId, event.type)) {
            await requireParentClientForStripeBilling(client.id, {
              route: 'stripe_webhook_invoice_subscription_sync',
              event_type: event.type,
              client_id: client.id,
              customer_id: customerId,
              subscription_id: subscriptionId
            });
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const updates = buildClientSubscriptionUpdatesFromStripe(subscription, {
              fallbackCustomerId: customerId,
              fallbackSubscriptionId: subscriptionId
            });
            const { error: updateErr } = await supabaseAdmin
              .from('clients')
              .update(updates)
              .eq('id', client.id);
            if (updateErr) throw new Error(updateErr.message || 'Client update failed');
          }
        }
      }
    }

    await markProcessed(true, null);
    return res.status(200).json({ ok: true });
  } catch (err) {
    const permanent = err?.permanentFailure === true;
    const detail = String(err?.message || err || 'processing_failed');
    console.error('[stripe-webhook] processing_failed', {
      request_id,
      stripe_event_id: event.id,
      type: event.type,
      permanent,
      detail
    });

    if (permanent || retryableAgreementEvent) {
      try {
        await markProcessed(false, detail);
      } catch (markError) {
        console.error('stripe_webhook_event_status_failed', { event_id: event.id, error: markError.message });
      }
    }

    // Redelivery cannot change a permanent failure, so its reason is recorded and acknowledged.
    if (permanent) return res.status(200).json({ ok: true });

    // A paid agreement that did not activate keeps its dedupe row, marked incomplete, and
    // the redelivery re-enters through the check above; the activation claim serializes it
    // with any other delivery for the same agreement.
    if (retryableAgreementEvent) {
      return res.status(503).json({ error: 'server_error', code: 'AGREEMENT_ACTIVATION_RETRY_REQUIRED', request_id });
    }

    // Transient. The dedupe row is removed first, otherwise Stripe's retry would be
    // rejected as a replay by the insert above and the event would be lost for good.
    const { error: cleanupErr } = await supabaseAdmin
      .from('billing_events')
      .delete()
      .eq('stripe_event_id', event.id);
    if (cleanupErr) {
      console.error('[stripe-webhook] dedupe_cleanup_failed', {
        request_id,
        stripe_event_id: event.id,
        detail: String(cleanupErr?.message || cleanupErr)
      });
    }

    return res.status(500).json({
      error: 'server_error',
      code: 'STRIPE_EVENT_PROCESSING_FAILED',
      detail: 'Event processing failed.',
      hint: null,
      request_id
    });
  }
});

module.exports = router;
module.exports.shouldApplyGenericSubscriptionUpdate = shouldApplyGenericSubscriptionUpdate;
module.exports.markAgreementCheckoutPaid = markAgreementCheckoutPaid;
module.exports.isInitialAgreementCheckoutInvoice = isInitialAgreementCheckoutInvoice;
module.exports.claimAgreementPurchaseActivation = claimAgreementPurchaseActivation;
module.exports.releaseAgreementPurchaseActivationClaim = releaseAgreementPurchaseActivationClaim;
