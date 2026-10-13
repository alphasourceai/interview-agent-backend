'use strict'

const Stripe = require('../clients/stripeFactory')()
const { supabaseAdmin } = require('../clients/supabase')
const { requireParentClient } = require('./clientBillingScope')
const {
  getAlphaScreenStripePriceId,
  getAlphaScreenFirstRolePrepayStripePriceId
} = require('./alphaScreenPackages')
const { resolvePublicBackendBase, buildClientDashboardReturnUrl, buildMembershipAgreementSignUrl } = require('../config/urlConfig')
const { priceEnterprisePool, quoteEnterprisePool } = require('./enterprisePoolPricing')
const {enterprisePoolCheckoutQuote}=require('./enterprisePoolSnapshot')
const { enterpriseSettingsMetadata, validateEnterpriseSettings } = require('./enterpriseSettings')
const {createExistingEnterpriseCheckout}=require('./existingEnterpriseCheckoutAttempt')
const { readRetailPackageOffer } = require('./membershipPackageCompatibility')
const { isDeepStrictEqual } = require('node:util')
const { claimExistingRetailAttempt, assertWindow, frozenRetailCancelUrl, readOpenRetailSession,
  pinExistingRetailSession,ensureRetailBillingProfile } = require('./existingRetailCheckoutAttempt')

function makeError(status, code, detail) {
  const err = new Error(detail || code || 'checkout_failed')
  err.status = Number(status) || 500
  err.code = String(code || 'checkout_failed')
  return err
}

function normalizePlanTier(value) {
  const normalized = String(value || '').trim().toLowerCase()
  const canonical = normalized === 'essential' ? 'basic' : normalized
  return ['basic', 'pro', 'enterprise'].includes(canonical) ? canonical : ''
}

function normalizeBillingInterval(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return ['monthly', 'annual'].includes(normalized) ? normalized : ''
}

function normalizeMetadataObject(value) {
  const output = {}
  const source = value && typeof value === 'object' ? value : {}
  for (const [key, raw] of Object.entries(source)) {
    const keyText = String(key || '').trim()
    if (!keyText) continue
    if (raw == null) continue
    const text = String(raw).trim()
    if (!text) continue
    output[keyText] = text
  }
  return output
}

function asMoneyOrNull(value, { allowZero = true } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const rounded = Math.round(n * 100) / 100
  if (allowZero ? rounded < 0 : rounded <= 0) return null
  return rounded
}

function asWholeNumberOrNull(value, { allowZero = true } = {}) {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  if (allowZero ? n < 0 : n <= 0) return null
  return n
}

// Distinguishes "the caller left this out" from "the caller sent something bad",
// so an optional field can still be validated when it is supplied.
function isSuppliedValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== ''
}

// Parses and validates an Enterprise checkout's terms without any I/O, and
// returns what the session needs: the platform charge, the pool, and the
// metadata the webhook turns into the client's plan settings.
function parseEnterpriseCheckoutTerms(enterpriseFees) {
  const acceptedPoolQuote=enterprisePoolCheckoutQuote(enterpriseFees||{})
  const platformFee = asMoneyOrNull(enterpriseFees?.platform_fee, { allowZero: false })
  const perRoleFee = asMoneyOrNull(enterpriseFees?.per_role_fee, { allowZero: true })
  const includedInterviewsPerRole = asWholeNumberOrNull(enterpriseFees?.included_interviews_per_role, { allowZero: true })
  const additionalInterviewFee = asMoneyOrNull(enterpriseFees?.additional_interview_fee, { allowZero: true })
  if (
    platformFee === null ||
    perRoleFee === null ||
    includedInterviewsPerRole === null ||
    additionalInterviewFee === null
  ) {
    throw makeError(400, 'invalid_enterprise_fees', 'Invalid enterprise pricing fields.')
  }
  // Supplying something unparseable is refused here; whether the model needs a
  // price at all is decided by validateEnterpriseSettings below.
  const usageFeeSupplied = isSuppliedValue(enterpriseFees?.usage_interview_fee_cents)
  const usageInterviewFeeCents = usageFeeSupplied
    ? asWholeNumberOrNull(enterpriseFees.usage_interview_fee_cents, { allowZero: true })
    : null
  if (usageFeeSupplied && usageInterviewFeeCents === null) {
    throw makeError(400, 'invalid_enterprise_fees', 'Invalid enterprise pricing fields.')
  }
  // Optional. A pool cannot be priced without a per-interview price, since the
  // pool is sold at that same number.
  const poolSupplied = isSuppliedValue(enterpriseFees?.pool_quantity)
  const poolQuantity = poolSupplied
    ? asWholeNumberOrNull(enterpriseFees.pool_quantity, { allowZero: false })
    : null
  if (poolSupplied && poolQuantity === null) {
    throw makeError(400, 'invalid_enterprise_fees', 'Invalid enterprise pricing fields.')
  }
  if (poolQuantity !== null && usageInterviewFeeCents === null) {
    throw makeError(400, 'pool_requires_usage_price', 'An interview pool needs a per-interview usage price.')
  }
  // The discount an agreement was priced at when it was sent, which is what the
  // client signed. Absent (an admin checkout without an agreement), the pool is
  // priced from the bands at checkout, as before.
  const poolDiscountSupplied = poolQuantity !== null && isSuppliedValue(enterpriseFees?.pool_discount_pct)
  const agreedPoolDiscountPct = poolDiscountSupplied ? Number(enterpriseFees.pool_discount_pct) : null
  if (poolDiscountSupplied && !(Number.isFinite(agreedPoolDiscountPct) && agreedPoolDiscountPct >= 0 && agreedPoolDiscountPct <= 100)) {
    throw makeError(400, 'invalid_enterprise_fees', 'Invalid enterprise pricing fields.')
  }
  const platformCents = Math.round(platformFee * 100)
  if (!Number.isFinite(platformCents) || platformCents <= 0) {
    throw makeError(400, 'invalid_enterprise_fees', 'Invalid enterprise pricing fields.')
  }

  const settings = validateEnterpriseSettings(enterpriseFees || {}, { planTier: 'enterprise' })
  if (!settings.ok) throw makeError(settings.status, settings.code, settings.detail)

  return {
    platformCents,
    usageInterviewFeeCents,
    poolQuantity,
    agreedPoolDiscountPct,
    acceptedPoolQuote,
    metadata: {
      platform_fee: String(Math.round(platformFee * 100) / 100),
      per_role_fee: String(Math.round(perRoleFee * 100) / 100),
      included_interviews_per_role: String(includedInterviewsPerRole),
      additional_interview_fee: String(Math.round(additionalInterviewFee * 100) / 100),
      ...(usageInterviewFeeCents === null
        ? {}
        : { usage_interview_fee_cents: String(usageInterviewFeeCents) }),
      ...enterpriseSettingsMetadata(settings.settings)
    }
  }
}

/**
 * The next 1st of the month at 00:00 UTC, as a Unix timestamp.
 *
 * A checkout on the 1st anchors to the *following* month: the current month has
 * already begun, so anchoring to today would mean no proration and a cycle that
 * starts in the past.
 */
function nextFirstOfMonthEpoch(nowMs) {
  const now = Number.isFinite(nowMs) ? new Date(nowMs) : new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return Math.floor(next.getTime() / 1000);
}

function wantsEmbeddedCheckout(value) {
  if (value === true) return true
  const raw = String(value || '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'embedded'
}

function normalizeIdempotencyKey(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  return raw.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 255)
}

function normalizeFirstRolePrepayCheckout(value) {
  const source = value && typeof value === 'object' ? value : null
  if (!source || source.selected !== true) return null
  const amountCents = Number(source.amount_cents ?? source.discounted_credit_amount_cents)
  const normalRoleFeeCents = Number(source.normal_role_fee_cents)
  const discountPercent = Number(source.discount_percent)
  const creditType = String(source.credit_type || 'first_role_prepay').trim()
  if (
    creditType !== 'first_role_prepay' ||
    !Number.isInteger(amountCents) ||
    amountCents <= 0 ||
    !Number.isInteger(normalRoleFeeCents) ||
    normalRoleFeeCents <= 0 ||
    !Number.isInteger(discountPercent) ||
    discountPercent <= 0
  ) {
    throw makeError(400, 'invalid_first_role_prepay', 'Invalid first-role prepay checkout values.')
  }
  return {
    selected: true,
    credit_type: creditType,
    amount_cents: amountCents,
    normal_role_fee_cents: normalRoleFeeCents,
    discount_percent: discountPercent
  }
}

async function resolveStripeCustomerId({
  stripe,
  client,
  billingCustomerList,
  exactPrepaid = false,
  strictRetailCredits = false,
  requiredPromotionCustomerId = null,
  pinnedCustomerId = '',
  skipCustomerUpdate = false,
  preferCurrentCustomer = false
}) {
  const zeroCurrencies = value => value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([currency,amount]) => /^[a-z]{3}$/.test(currency) && amount === 0);
  const candidateStripeCustomerIds = []
  const customerRows = Array.isArray(billingCustomerList) ? billingCustomerList : []
  for (const row of customerRows) {
    const id = String(row?.stripe_customer_id || '').trim()
    if (!id) continue
    if (!candidateStripeCustomerIds.includes(id)) candidateStripeCustomerIds.push(id)
  }
  const fallbackCustomerId = String(client?.stripe_customer_id || '').trim()
  if (fallbackCustomerId && !candidateStripeCustomerIds.includes(fallbackCustomerId)) {
    candidateStripeCustomerIds.push(fallbackCustomerId)
  }
  if (preferCurrentCustomer && fallbackCustomerId) {
    const at = candidateStripeCustomerIds.indexOf(fallbackCustomerId)
    if (at >= 0) candidateStripeCustomerIds.splice(at, 1)
    candidateStripeCustomerIds.unshift(fallbackCustomerId)
  }
  if (pinnedCustomerId && fallbackCustomerId !== pinnedCustomerId) {
    throw makeError(409, 'retail_checkout_customer_changed', 'The original checkout customer needs review.')
  }
  if (pinnedCustomerId) candidateStripeCustomerIds.splice(0,candidateStripeCustomerIds.length,pinnedCustomerId)

  let resolvedStripeCustomerId = null
  for (const candidateId of candidateStripeCustomerIds) {
    try {
      const customer = await stripe.customers.retrieve(candidateId)
      if (requiredPromotionCustomerId && (customer.deleted === true || customer.id !== requiredPromotionCustomerId)) {
        throw makeError(409,'retail_checkout_promotion_customer_mismatch','The approved promotion does not match this billing customer.')
      }
      // New retail commercial totals must not inherit old customer discounts
      // or account credits. Refuse, never clear/change the customer's balance.
      // Actual paid-invoice proof is still independently required at fulfillment.
      if (exactPrepaid && (customer.deleted === true || customer.discount !== null
        || !Number.isSafeInteger(customer.balance) || customer.balance !== 0
        || (customer.discounts != null && (!Array.isArray(customer.discounts) || customer.discounts.length > 0))
        || (customer.invoice_credit_balance != null && (strictRetailCredits ? !zeroCurrencies(customer.invoice_credit_balance)
          : Object.values(customer.invoice_credit_balance).some(value => value !== 0)))
        || (customer.cash_balance != null && (strictRetailCredits ? customer.cash_balance.object !== 'cash_balance'
          || !zeroCurrencies(customer.cash_balance.available)
          : typeof customer.cash_balance !== 'object' || Object.values(customer.cash_balance.available || {}).some(value => value !== 0))))) {
        throw makeError(409, 'retail_customer_adjustment_denied', strictRetailCredits
          ? 'This checkout requires review of existing customer discounts or credits.'
          : 'This prepaid checkout requires review of existing customer discounts or credits.')
      }
      resolvedStripeCustomerId = candidateId
      break
    } catch (e) {
      const message = String(e?.message || '').toLowerCase()
      const code = String(e?.code || '').toLowerCase()
      if (code === 'resource_missing' || message.includes('no such customer')) continue
      throw e
    }
  }

  const clientEmail = String(client?.email || '').trim()
  if (!resolvedStripeCustomerId) {
    if (requiredPromotionCustomerId) throw makeError(409,'retail_checkout_promotion_customer_mismatch','This promotion requires an existing matching billing customer.')
    if (pinnedCustomerId) throw makeError(409, 'retail_checkout_customer_changed', 'The original checkout customer is unavailable.')
    const createdCustomer = await stripe.customers.create({
      name: client?.name || undefined,
      email: clientEmail || undefined,
      metadata: { client_id: client.id }
    })
    resolvedStripeCustomerId = createdCustomer?.id || null
  } else if (!pinnedCustomerId && !skipCustomerUpdate) {
    try {
      await stripe.customers.update(resolvedStripeCustomerId, {
        name: client?.name || undefined,
        email: clientEmail || undefined,
        metadata: { client_id: client.id }
      })
    } catch (_) {}
  }

  return resolvedStripeCustomerId || null
}

async function createSubscriptionCheckoutSession({
  clientId,
  planTier,
  billingInterval,
  returnTab = '',
  cancelUrl = '',
  embedded = false,
  metadataSource = 'admin_subscription_checkout',
  metadata = {},
  firstRolePrepay = null,
  promotionCodeId = '',
  enterpriseFees = null,
  packageSnapshot = null,
  requestContext = null,
  idempotencyKey = '',
  checkoutExpiresAt = null,
  retailAgreement = null,
  enterpriseAgreement = null,
  now = null
}) {
  require('../config/guardedPricingDev').assertGuardedDevOutboundAllowed()
  const normalizedClientId = String(clientId || '').trim()
  const normalizedPlanTier = normalizePlanTier(planTier)
  const retailOffer = readRetailPackageOffer(packageSnapshot)
  const retailInterval = retailOffer?.payment_option === 'prepaid' ? 'prepaid' : 'monthly'
  const normalizedBillingInterval = retailOffer ? retailInterval : normalizeBillingInterval(billingInterval)
  if (retailOffer && (normalizedPlanTier !== retailOffer.plan_key || billingInterval !== retailInterval || normalizedPlanTier === 'enterprise')) {
    throw makeError(409, 'retail_package_selection_mismatch', 'Checkout selection does not match the accepted pricing terms.')
  }
  const normalizedMetadataSource = String(metadataSource || '').trim().toLowerCase()
  const normalizedReturnTab = String(returnTab || '').trim().toLowerCase()
  let embeddedCheckoutRequested = wantsEmbeddedCheckout(embedded)
  const normalizedIdempotencyKey = normalizeIdempotencyKey(idempotencyKey)
  const normalizedPromotionCodeId = String(promotionCodeId || '').trim().slice(0, 255)
  const exactPrepaid = retailOffer?.payment_option === 'prepaid'
  if (exactPrepaid && normalizedPromotionCodeId) {
    throw makeError(409, 'retail_prepaid_discount_denied', 'Additional checkout discounts are not available for this prepaid offer.')
  }
  const firstRolePrepayCheckout = normalizeFirstRolePrepayCheckout(firstRolePrepay)
  if (retailOffer && firstRolePrepayCheckout && (!retailOffer.first_role_prepay.selected
    || firstRolePrepayCheckout.amount_cents !== retailOffer.first_role_prepay.amount_cents
    || firstRolePrepayCheckout.normal_role_fee_cents !== retailOffer.first_role_prepay.normal_role_fee_cents
    || firstRolePrepayCheckout.discount_percent !== packageSnapshot.first_role_prepay.discount_percent)) {
    throw makeError(409, 'retail_first_role_mismatch', 'First-role payment does not match the accepted pricing terms.')
  }
  const retailMetadata = retailOffer ? { membership_pricing_version:retailOffer.offer_version,
    membership_commitment_months:String(retailOffer.commitment_months), membership_payment_option:retailOffer.payment_option,
    membership_platform_payment_cents:String(retailOffer.platform_payment_cents),
    membership_commitment_total_cents:String(retailOffer.platform_commitment_total_cents) } : null
  if (retailOffer && (!normalizedIdempotencyKey || typeof idempotencyKey !== 'string'
    || !/^[A-Za-z0-9_.:-]{1,255}$/.test(idempotencyKey) || normalizedIdempotencyKey !== idempotencyKey)) {
    throw makeError(409, 'retail_checkout_key_required', 'The existing agreement checkout identity is required.')
  }
  if (retailOffer && (normalizedMetadataSource !== 'agreement_checkout' || normalizedReturnTab
    || !retailAgreement?.id || retailAgreement.client_id !== normalizedClientId
    || !isDeepStrictEqual(retailAgreement.template_snapshot?.package_snapshot, packageSnapshot)
    || normalizedIdempotencyKey !== `agreement_checkout:${retailAgreement.id}:${normalizedPlanTier}:${normalizedBillingInterval}`)) {
    throw makeError(409, 'retail_checkout_source_required', 'The existing signed agreement checkout source is required.')
  }
  const nowMs = now ? new Date(now).getTime() : Date.now()
  let checkoutExpiresAtEpoch = null
  if (checkoutExpiresAt && !retailOffer) {
    const requestedExpiryMs = new Date(checkoutExpiresAt).getTime()
    if (!Number.isFinite(nowMs) || !Number.isFinite(requestedExpiryMs)) {
      throw makeError(400, 'invalid_checkout_expiration', 'Checkout expiration is invalid.')
    }
    const remainingMs = requestedExpiryMs - nowMs
    if (remainingMs < 30 * 60 * 1000) {
      throw makeError(410, 'agreement_checkout_window_closed', 'This agreement is too close to expiration. Request a newly dated agreement.')
    }
    checkoutExpiresAtEpoch = Math.floor(Math.min(requestedExpiryMs, nowMs + (24 * 60 * 60 * 1000) - 1000) / 1000)
  }

  if (!normalizedClientId) throw makeError(400, 'client_id_required', 'Client id is required.')
  if (!normalizedPlanTier) throw makeError(400, 'invalid_plan_tier', 'Invalid plan tier.')
  if (!normalizedBillingInterval) throw makeError(400, 'invalid_billing_interval', 'Invalid billing interval.')
  if (!normalizedMetadataSource) throw makeError(400, 'invalid_metadata_source', 'Checkout source is required.')

  // Every Enterprise term is checked here, before the client lookup and before
  // anything reaches Stripe, so a refused checkout leaves nothing behind.
  if(normalizedPlanTier!=='enterprise' && (enterpriseFees?.pool_offer_snapshot!=null || enterpriseFees?.pool_offer_digest!=null))throw makeError(409,'invalid_enterprise_pool_snapshot','Enterprise pool terms do not apply to this plan.')
  const enterpriseTerms = normalizedPlanTier === 'enterprise' ? parseEnterpriseCheckoutTerms(enterpriseFees) : null
  if(enterpriseTerms?.acceptedPoolQuote && normalizedPromotionCodeId)throw makeError(409,'enterprise_pool_extra_discount_denied','The accepted pool total cannot be changed by an additional checkout discount.')
  if (enterpriseTerms?.acceptedPoolQuote && normalizedMetadataSource !== 'agreement_checkout') {
    throw makeError(409, 'enterprise_pool_signed_agreement_required',
      'Use the existing Admin Billing signed-agreement flow for these interview pool terms.')
  }
  const markedEnterprise = normalizedPlanTier === 'enterprise' && (enterpriseTerms?.acceptedPoolQuote
    || enterpriseAgreement?.enterprise_checkout_source != null || enterpriseAgreement?.enterprise_checkout_pool_id != null
    || enterpriseAgreement?.enterprise_checkout_prices != null)
  if (markedEnterprise && (!enterpriseAgreement?.id || normalizedMetadataSource !== 'agreement_checkout'
    || normalizedReturnTab || !enterpriseTerms?.acceptedPoolQuote || normalizedPromotionCodeId
    || firstRolePrepayCheckout || normalizedIdempotencyKey !== `agreement_checkout:${enterpriseAgreement.id}:enterprise:${normalizedBillingInterval}`)) {
    throw makeError(409,'enterprise_checkout_source_required','The existing signed Enterprise agreement is required.')
  }

  // A positive accepted initial payment is required for the existing paid_at
  // activation path. Validate a saved monthly promo before any writer runs.
  // No current price lookup, new payment engine or changed legacy promo flow.
  const retailStripe = retailOffer ? new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion:'2023-10-16' }) : null
  const retailPromotion = retailOffer ? await require('./retailInitialPromotion').readInitialPromotion({
    stripe:retailStripe, promotionId:normalizedPromotionCodeId, offer:retailOffer
  }) : null

  const parentGuard = await requireParentClient(supabaseAdmin, normalizedClientId, {
    source: normalizedMetadataSource
  })
  if (!parentGuard.ok) {
    const body = parentGuard.body || {}
    throw makeError(
      parentGuard.status || 500,
      body.code || body.error || 'client_lookup_failed',
      body.detail || 'Client lookup failed.'
    )
  }

  const { data: client, error: clientError } = await supabaseAdmin
    .from('clients')
    .select('id,name,email,client_admin_name,stripe_customer_id')
    .eq('id', normalizedClientId)
    .maybeSingle()
  if (clientError) throw makeError(500, 'client_lookup_failed', clientError.message || 'Client lookup failed.')
  if (!client) throw makeError(404, 'client_not_found', 'Client not found.')

  const clientEmail = String(client.email || '').trim()
  if (!clientEmail) throw makeError(400, 'missing_client_email', 'Client email is required.')

  if (markedEnterprise) return createExistingEnterpriseCheckout({db:supabaseAdmin,
    stripeFactory:()=>new Stripe(process.env.STRIPE_SECRET_KEY||'',{apiVersion:'2023-10-16'}),resolveCustomer:resolveStripeCustomerId,
    client,agreement:enterpriseAgreement,fees:enterpriseFees,billingInterval:normalizedBillingInterval,embedded:embeddedCheckoutRequested,
    cancelUrl,key:normalizedIdempotencyKey,config:{public_backend_base:resolvePublicBackendBase(''),
      public_sign_base:buildMembershipAgreementSignUrl('').replace(/\/membership-agreement\/sign\/$/,'')}})

  const { data: billingCustomerRows, error: billingCustomerError } = await supabaseAdmin
    .from('billing_customers')
    .select('id,stripe_customer_id')
    .eq('client_id', client.id)
    .order('created_at', { ascending: false })
  if (billingCustomerError) throw makeError(500, 'customer_lookup_failed', billingCustomerError.message || 'Billing customer lookup failed.')
  const billingCustomerList = Array.isArray(billingCustomerRows) ? billingCustomerRows : []
  const billingCustomer = billingCustomerList[0] || null

  const stripe = retailStripe || new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion:'2023-10-16' })

  let resolvedStripeCustomerId = null
  try {
    resolvedStripeCustomerId = await resolveStripeCustomerId({
      stripe,
      client,
      billingCustomerList,
      exactPrepaid: !!retailOffer,
      strictRetailCredits: !!retailOffer,
      requiredPromotionCustomerId:retailPromotion?.customerId || null,
      pinnedCustomerId:retailOffer ? String(retailAgreement.checkout_attempt_source?.customer_id || '') : ''
    })
  } catch (e) {
    if (e?.code === 'retail_customer_adjustment_denied' || e?.code === 'retail_checkout_customer_changed'
      || e?.code === 'retail_checkout_promotion_customer_mismatch') throw e
    throw makeError(500, 'stripe_customer_failed', e?.message || 'Stripe customer resolution failed.')
  }
  if (!resolvedStripeCustomerId) throw makeError(400, 'missing_billing_customer', 'Missing billing customer.')

  if (String(client?.stripe_customer_id || '').trim() !== resolvedStripeCustomerId) {
    if (retailOffer) {
      const { data, error } = await supabaseAdmin.from('clients').update({ stripe_customer_id: resolvedStripeCustomerId })
        .eq('id', client.id).select('id,stripe_customer_id').maybeSingle()
      if (error || data?.stripe_customer_id !== resolvedStripeCustomerId) throw makeError(503, 'retail_checkout_customer_save_failed')
    } else {
    try {
      await supabaseAdmin
        .from('clients')
        .update({ stripe_customer_id: resolvedStripeCustomerId })
        .eq('id', client.id)
    } catch (_) {}
    }
  }

  if (!retailOffer && billingCustomer?.id && String(billingCustomer?.stripe_customer_id || '').trim() !== resolvedStripeCustomerId) {
    try {
      await supabaseAdmin
        .from('billing_customers')
        .update({ stripe_customer_id: resolvedStripeCustomerId })
        .eq('id', billingCustomer.id)
    } catch (_) {}
  }

  let replacesStripeSubscriptionId = null
  let replacementMetadata = null
  if (retailOffer && retailAgreement.checkout_attempt_source) {
    // Native replay returns the original replacement even if subscriptions
    // have appeared/disappeared. Do not turn a retry into a new live selection.
    replacesStripeSubscriptionId = retailAgreement.replaces_stripe_subscription_id || null
  } else if (['admin_subscription_checkout', 'agreement_checkout'].includes(normalizedMetadataSource)) {
    const existingSubscriptions = await stripe.subscriptions.list({
      customer: resolvedStripeCustomerId,
      status: 'all',
      limit: 100
    })
    const blockingSubscription = (existingSubscriptions?.data || []).find((subscription) => {
      return ['active', 'trialing', 'past_due', 'incomplete'].includes(String(subscription?.status || '').trim().toLowerCase())
    })
    if (blockingSubscription) {
      if (normalizedMetadataSource === 'admin_subscription_checkout') {
        throw makeError(409, 'client_subscription_already_exists', 'Client already has an active or pending Stripe subscription.')
      }
      replacesStripeSubscriptionId = String(blockingSubscription?.id || '').trim() || null
      if (replacesStripeSubscriptionId) {
        replacementMetadata = {
          replaces_stripe_subscription_id: replacesStripeSubscriptionId,
          replacement_policy: 'immediate_cancel'
        }
      }
    }
  }

  let retailAttempt = null
  if (retailOffer) {
    await ensureRetailBillingProfile({db:supabaseAdmin,client,customerId:resolvedStripeCustomerId})
    const signBase = buildMembershipAgreementSignUrl('').replace(/\/membership-agreement\/sign\/$/, '')
    retailAttempt = await claimExistingRetailAttempt({ db:supabaseAdmin, agreement:retailAgreement,
      customerId:resolvedStripeCustomerId, embedded:embeddedCheckoutRequested, replacementId:replacesStripeSubscriptionId,
      config:{ public_backend_base:resolvePublicBackendBase(''), public_sign_base:signBase } })
    if (normalizedPromotionCodeId !== String(retailAttempt.source.intent?.promotion_code_id || '')) {
      throw makeError(409, 'retail_checkout_promotion_changed', 'Promotion does not match the existing signed checkout source.')
    }
    embeddedCheckoutRequested = retailAttempt.embedded
    replacesStripeSubscriptionId = retailAttempt.replacement_id
    replacementMetadata = replacesStripeSubscriptionId ? { replaces_stripe_subscription_id:replacesStripeSubscriptionId,
      replacement_policy:'immediate_cancel' } : null
    checkoutExpiresAtEpoch = retailAttempt.expires_at
  }

  const lineItems = []
  let enterpriseCheckoutMetadata = null
  let poolQuantity = null
  let poolMetadata = null
  let poolPoolId = null
  if (normalizedPlanTier === 'enterprise') {
    const { platformCents, usageInterviewFeeCents } = enterpriseTerms
    poolQuantity = enterpriseTerms.poolQuantity
    enterpriseCheckoutMetadata = enterpriseTerms.metadata
    const enterprisePrice = await stripe.prices.create({
      currency: 'usd',
      unit_amount: platformCents,
      recurring: { interval: normalizedBillingInterval === 'annual' ? 'year' : 'month' },
      product_data: { name: 'Enterprise membership' },
      metadata: {
        source: normalizedMetadataSource,
        client_id: client.id,
        plan_tier: 'enterprise',
        billing_interval: normalizedBillingInterval,
        ...enterpriseCheckoutMetadata,
        ...normalizeMetadataObject(metadata),
        ...normalizeMetadataObject(replacementMetadata || {})
      }
    })
    lineItems.push({ price: enterprisePrice.id, quantity: 1 })

    // The interview pool is a one-off charge alongside the recurring membership,
    // the same shape first-role prepay uses below. It is charged as a single
    // unit amount with quantity 1 because the volume discount is rounded on the
    // whole order — see enterprisePoolPricing.
    if (poolQuantity !== null) {
      const quote = enterpriseTerms.acceptedPoolQuote || (enterpriseTerms.agreedPoolDiscountPct !== null
        ? quoteEnterprisePool({
          quantity: poolQuantity,
          unitPriceCents: usageInterviewFeeCents,
          discountPct: enterpriseTerms.agreedPoolDiscountPct
        })
        : await priceEnterprisePool({
          db: supabaseAdmin,
          quantity: poolQuantity,
          unitPriceCents: usageInterviewFeeCents
        }))
      const poolPrice = await stripe.prices.create({
        currency: 'usd',
        unit_amount: quote.total_cents,
        product_data: { name: `Interview pool (${quote.quantity} interviews)` },
        metadata: {
          source: normalizedMetadataSource,
          client_id: client.id,
          purchase_type: 'interview_pool',
          quantity: String(quote.quantity),
          discount_pct: String(quote.discount_pct),
          discounted_unit_price_cents: String(quote.discounted_unit_price_cents),
          ...(quote.offer_snapshot?{pool_offer_version:quote.offer_snapshot.offer_version,pool_offer_digest:quote.offer_digest}:{})
        }
      })
      lineItems.push({ price: poolPrice.id, quantity: 1 })

      // Reserved before the session exists, so the webhook always has a row to
      // mark paid even if the response never reaches the caller.
      const { data: pendingPool, error: poolInsertError } = await supabaseAdmin
        .from('client_interview_pools')
        .insert({
          client_id: client.id,
          quantity_purchased: quote.quantity,
          unit_price_cents: quote.unit_price_cents,
          discount_pct: quote.discount_pct,
          total_cents: quote.total_cents,
          offer_snapshot:quote.offer_snapshot||null,
          offer_digest:quote.offer_digest||null,
          status: 'pending'
        })
        .select('id')
        .maybeSingle()
      if (poolInsertError || !pendingPool?.id) {
        throw makeError(503, 'interview_pool_reserve_failed', 'The interview pool could not be reserved.')
      }
      poolPoolId = pendingPool.id

      poolMetadata = {
        purchase_type: 'interview_pool',
        client_interview_pool_id: String(pendingPool.id),
        pool_quantity: String(quote.quantity),
        pool_unit_price_cents: String(quote.unit_price_cents),
        pool_discount_pct: String(quote.discount_pct),
        pool_discounted_unit_price_cents: String(quote.discounted_unit_price_cents),
        pool_total_cents: String(quote.total_cents),
        ...(quote.offer_snapshot?{pool_offer_version:quote.offer_snapshot.offer_version,pool_offer_digest:quote.offer_digest}:{})
      }
    }
  } else if (retailOffer) {
    lineItems.push({ quantity:1, price_data:{ currency:'usd', unit_amount:retailOffer.platform_payment_cents,
      recurring:{ interval:'month', interval_count:retailOffer.stripe_recurrence.interval_count },
      product_data:{ name:`alphaScreen ${retailOffer.display_name} — ${retailOffer.commitment_months}-month ${retailOffer.payment_option === 'prepaid' ? 'prepaid' : 'commitment'}`,
        metadata:retailMetadata } } })
  } else {
    const priceId = getAlphaScreenStripePriceId(normalizedPlanTier, normalizedBillingInterval)
    if (!priceId) throw makeError(500, 'stripe_price_not_configured', 'Stripe price is not configured.')
    lineItems.push({ price: priceId, quantity: 1 })
  }
  let firstRolePrepayMetadata = null
  if (retailOffer?.first_role_prepay.selected) {
    const role = retailOffer.first_role_prepay
    lineItems.push({ quantity:1, price_data:{ currency:'usd', unit_amount:role.amount_cents,
      product_data:{ name:`alphaScreen ${retailOffer.display_name} first-role prepay`, metadata:{ credit_type:role.credit_type } } } })
    firstRolePrepayMetadata = { first_role_prepay_selected:'true', first_role_prepay_credit_type:role.credit_type,
      first_role_prepay_amount_cents:String(role.amount_cents), first_role_prepay_normal_role_fee_cents:String(role.normal_role_fee_cents),
      first_role_prepay_discount_percent:String(packageSnapshot.first_role_prepay.discount_percent) }
  } else if (!retailOffer && firstRolePrepayCheckout) {
    const firstRolePrepayPriceId = getAlphaScreenFirstRolePrepayStripePriceId(normalizedPlanTier)
    if (!firstRolePrepayPriceId) {
      throw makeError(500, 'first_role_prepay_price_not_configured', 'First-role prepay Stripe price is not configured.')
    }
    lineItems.push({ price: firstRolePrepayPriceId, quantity: 1 })
    firstRolePrepayMetadata = {
      first_role_prepay_selected: 'true',
      first_role_prepay_credit_type: firstRolePrepayCheckout.credit_type,
      first_role_prepay_amount_cents: String(firstRolePrepayCheckout.amount_cents),
      first_role_prepay_normal_role_fee_cents: String(firstRolePrepayCheckout.normal_role_fee_cents),
      first_role_prepay_discount_percent: String(firstRolePrepayCheckout.discount_percent)
    }
  }

  const forwardedProto = String(requestContext?.forwardedProto || requestContext?.protocol || 'https').split(',')[0].trim()
  const forwardedHost = String(requestContext?.forwardedHost || requestContext?.host || '').split(',')[0].trim()
  const computedBackendBase = forwardedHost ? `${forwardedProto || 'https'}://${forwardedHost}` : ''
  const publicBackendBase = retailAttempt?.source.config.public_backend_base || resolvePublicBackendBase(computedBackendBase || '')

  const successParams = normalizedReturnTab
    ? { checkout: 'success', client_id: client.id, tab: normalizedReturnTab }
    : { checkout: 'success', client_id: client.id }
  const cancelParams = normalizedReturnTab
    ? { checkout: 'cancel', client_id: client.id, tab: normalizedReturnTab }
    : { checkout: 'cancel', client_id: client.id }
  const normalizedCancelUrl = retailAttempt ? frozenRetailCancelUrl(retailAttempt, cancelUrl) : String(cancelUrl || '').trim()

  const checkoutSuccessUrl = publicBackendBase
    ? `${publicBackendBase}/checkout/subscription-success?session_id={CHECKOUT_SESSION_ID}&client_id=${encodeURIComponent(client.id)}${normalizedReturnTab ? `&tab=${encodeURIComponent(normalizedReturnTab)}` : ''}`
    : buildClientDashboardReturnUrl(successParams)

  let checkoutMetadata = {
    source: normalizedMetadataSource,
    client_id: client.id,
    plan_tier: normalizedPlanTier,
    billing_interval: normalizedBillingInterval,
    ...normalizeMetadataObject(enterpriseCheckoutMetadata || {}),
    ...normalizeMetadataObject(firstRolePrepayMetadata || {}),
    ...normalizeMetadataObject(poolMetadata || {}),
    ...normalizeMetadataObject(retailAttempt ? {} : metadata),
    ...normalizeMetadataObject(replacementMetadata || {}),
    ...(enterpriseTerms?.acceptedPoolQuote?normalizeMetadataObject(poolMetadata||{}):{}),
    ...(retailOffer ? { ...retailMetadata, agreement_id:retailAttempt.agreement_id,
      ...(retailAttempt.source.intent ? { purchase_intent_id:retailAttempt.source.intent.id,
        public_purchase_intent_id:retailAttempt.source.intent.id,membership_agreement_id:retailAttempt.agreement_id,
        agreement_checkout:'true',checkout_status:'pending_payment',package_plan_key:retailOffer.plan_key,
        package_billing_cadence:normalizedBillingInterval,platform_fee:String(packageSnapshot.platform_fee),
        per_role_fee:String(packageSnapshot.per_role_fee),included_interviews_per_role:String(packageSnapshot.included_interviews_per_role),
        additional_interview_fee:String(packageSnapshot.additional_interview_fee),max_interview_minutes:String(packageSnapshot.max_interview_minutes) } : {}),
      source:normalizedMetadataSource, client_id:client.id,
      plan_tier:retailOffer.plan_key, billing_interval:normalizedBillingInterval,
      first_role_prepay_selected:String(retailOffer.first_role_prepay.selected),
      first_role_prepay_amount_cents:String(retailOffer.first_role_prepay.amount_cents),
      first_role_prepay_credit_type:retailOffer.first_role_prepay.credit_type,
      first_role_prepay_normal_role_fee_cents:String(retailOffer.first_role_prepay.normal_role_fee_cents),
      first_role_prepay_discount_percent:String(packageSnapshot.first_role_prepay.discount_percent) } : {})
  }
  if (retailAttempt) checkoutMetadata = normalizeMetadataObject(checkoutMetadata)

  const checkoutBasePayload = {
    mode: 'subscription',
    customer: resolvedStripeCustomerId,
    line_items: lineItems,
    ...(exactPrepaid || retailOffer && !normalizedPromotionCodeId ? { allow_promotion_codes: false } : enterpriseTerms?.acceptedPoolQuote?{}:normalizedPromotionCodeId
      ? { discounts: [{ promotion_code: normalizedPromotionCodeId }] }
      : { allow_promotion_codes: true }),
    metadata: checkoutMetadata,
    subscription_data: {
      metadata: checkoutMetadata,
      // Enterprise bills on the 1st, so a client gets one charge a month with
      // the prior month's usage on it. The first invoice is prorated to that
      // date. Both intervals anchor; Essentials and Pro are left alone.
      //
      // billing_cycle_anchor, not billing_cycle_anchor_config: the latter only
      // reached Checkout in API version 2026-06-24, and this client pins
      // 2023-10-16 (src/clients/stripe.js).
      ...(normalizedPlanTier === 'enterprise'
        ? {
            billing_cycle_anchor: nextFirstOfMonthEpoch(nowMs),
            proration_behavior: 'create_prorations'
          }
        : {})
    },
    ...(checkoutExpiresAtEpoch ? { expires_at: checkoutExpiresAtEpoch } : {})
  }

  let checkoutClientSecret = null
  let primaryCheckoutSession = null
  let hostedFallbackSession = null
  const createOptions = (suffix = '') => {
    if (!normalizedIdempotencyKey) return undefined
    const key = suffix ? `${normalizedIdempotencyKey}:${suffix}` : normalizedIdempotencyKey
    return { idempotencyKey: key.slice(0, 255) }
  }

  if (retailAttempt?.checkout_session_id) {
    primaryCheckoutSession = await readOpenRetailSession({ stripe, sessionId:retailAttempt.checkout_session_id,
      attempt:retailAttempt, offer:retailOffer, promotion:retailPromotion, metadata:checkoutMetadata,successUrl:checkoutSuccessUrl,cancelUrl:normalizedCancelUrl })
    checkoutClientSecret = retailAttempt.embedded ? primaryCheckoutSession.client_secret : null
  }

  if (embeddedCheckoutRequested && !primaryCheckoutSession) {
    try {
      if (retailAttempt) assertWindow(retailAttempt)
      primaryCheckoutSession = await stripe.checkout.sessions.create({
        ...checkoutBasePayload,
        ui_mode: 'embedded',
        return_url: checkoutSuccessUrl
      }, createOptions('embedded'))
      const resolvedClientSecret = String(primaryCheckoutSession?.client_secret || '').trim()
      if (resolvedClientSecret) {
        checkoutClientSecret = resolvedClientSecret
      } else {
        if (retailOffer) throw makeError(503, 'retail_checkout_ack_unknown', 'Checkout could not be confirmed. Reconcile the existing attempt before continuing.')
        primaryCheckoutSession = null
      }
    } catch (embeddedErr) {
      if (retailOffer) throw makeError(503, 'retail_checkout_ack_unknown', 'Checkout could not be confirmed. Reconcile the existing attempt before continuing.')
      console.error('create_subscription_embedded_checkout_session_failed:', embeddedErr?.message || embeddedErr)
    }
  }

  if (!primaryCheckoutSession) {
    if (retailAttempt) assertWindow(retailAttempt)
    try {
    primaryCheckoutSession = await stripe.checkout.sessions.create({
      ...checkoutBasePayload,
      success_url: checkoutSuccessUrl,
      cancel_url: normalizedCancelUrl || buildClientDashboardReturnUrl(cancelParams)
    }, createOptions())
    } catch (e) {
      if (retailAttempt) throw makeError(503, 'retail_checkout_ack_unknown', 'Checkout could not be confirmed. Retry only the existing attempt.')
      throw e
    }
  } else if (!retailOffer) {
    try {
      hostedFallbackSession = await stripe.checkout.sessions.create({
        ...checkoutBasePayload,
        success_url: checkoutSuccessUrl,
        cancel_url: normalizedCancelUrl || buildClientDashboardReturnUrl(cancelParams)
      }, createOptions('hosted'))
    } catch (hostedFallbackErr) {
      console.error('create_subscription_hosted_fallback_checkout_session_failed:', hostedFallbackErr?.message || hostedFallbackErr)
    }
  }

  if (retailAttempt) {
    assertWindow(retailAttempt)
    if (!retailAttempt.checkout_session_id) primaryCheckoutSession = await readOpenRetailSession({ stripe,
      sessionId:primaryCheckoutSession?.id,attempt:retailAttempt,offer:retailOffer,promotion:retailPromotion,metadata:checkoutMetadata,
      successUrl:checkoutSuccessUrl,cancelUrl:normalizedCancelUrl })
    await pinExistingRetailSession({ db:supabaseAdmin,agreement:retailAgreement,customerId:resolvedStripeCustomerId,
      attempt:retailAttempt,sessionId:primaryCheckoutSession.id })
    checkoutClientSecret = retailAttempt.embedded ? primaryCheckoutSession.client_secret : null
  }

  // Recorded for support: the webhook finds the pool by its id in metadata, not
  // by the session, so a failure here costs traceability rather than the pool.
  if (poolPoolId) {
    const poolSessionId = String(primaryCheckoutSession?.id || hostedFallbackSession?.id || '').trim()
    if (poolSessionId) {
      const { error: poolSessionError } = await supabaseAdmin
        .from('client_interview_pools')
        .update({ stripe_checkout_session_id: poolSessionId })
        .eq('id', poolPoolId)
      if (poolSessionError) {
        console.error('interview_pool_session_link_failed', {
          client_interview_pool_id: poolPoolId,
          error: poolSessionError.message || poolSessionError
        })
      }
    }
  }

  return {
    session: primaryCheckoutSession,
    fallbackSession: hostedFallbackSession,
    checkoutClientSecret,
    client,
    clientEmail,
    checkoutMetadata,
    interviewPoolId: poolPoolId,
    replacesStripeSubscriptionId,
    replacementPolicy: replacesStripeSubscriptionId ? 'immediate_cancel' : null,
    retailAttemptLinked:!!retailAttempt
  }
}

module.exports = {
  createSubscriptionCheckoutSession
}
