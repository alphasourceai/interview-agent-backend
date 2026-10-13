'use strict';

// Client-facing billing: the summary, the Stripe portal, and interview top-ups.
// Mounted at the application root, so the paths here are absolute.

const express = require('express');
const { buildClientDashboardReturnUrl } = require('../../config/urlConfig');
const { resolveBillingOwnerForScope } = require('../../services/clientBillingScope');
const { canViewLegalBillingForClient } = require('../../services/clientScope');
const { supabaseAdmin } = require('../../clients/supabase');
const { resolveBillingModel } = require('../../services/billingModel');
const { readBillingForClient } = require('../../services/billingReadModel');
const { readClientRetailBillingSummary } = require('../../services/clientRetailBillingSummary');
const { createClientBillingPortalSession } = require('../../services/retailBillingPortal');
const { requireAuth, withClientScope } = require('../../middleware/auth');
const {
  hasClientWriteAccess,
  respondWithBillingScopeError,
  sanitizeClientDashboardTab,
  wantsEmbeddedCheckout,
} = require('../../services/clientScope/clientBilling');

const router = express.Router();

router.get('/clients/billing/summary', requireAuth, withClientScope, async (req, res) => {
  try {
    const ids = Array.isArray(req.client_memberships) ? req.client_memberships : []
    if (ids.length === 0) return res.json({ items: [] })

    const wantedClientId = String(req.query?.client_id || '').trim()
    if (wantedClientId && !ids.includes(wantedClientId)) {
      return res.status(403).json({ error: 'forbidden' })
    }
    const isGlobalAdmin = req.isGlobalAdmin === true || req.isAdmin === true

    let queryIds = ids
    if (wantedClientId) {
      if (!isGlobalAdmin && !canViewLegalBillingForClient(req.clientScope, wantedClientId)) {
        return res.status(403).json({ error: 'forbidden' })
      }
      const billingScope = await resolveBillingOwnerForScope(supabaseAdmin, wantedClientId)
      if (!billingScope.ok) return respondWithBillingScopeError(res, billingScope, 'billing_client_lookup_failed')
      queryIds = [billingScope.billingClientId || wantedClientId]
    } else if (!isGlobalAdmin) {
      queryIds = ids.filter((clientId) => canViewLegalBillingForClient(req.clientScope, clientId))
      if (queryIds.length === 0) return res.status(403).json({ error: 'forbidden' })
    }

    let q = supabaseAdmin
      .from('clients')
      .select('id,name,plan_tier,billing_status,billing_interval,auto_renew,current_term_end,contract_start_at,contract_end_at,subscription_status,cancel_at_term_end,access_override_mode,stripe_customer_id,stripe_subscription_id')
      .in('id', Array.from(new Set(queryIds)))
      .order('name', { ascending: true })

    const { data, error } = await q
    if (error) return res.status(500).json({ error: 'list_billing_summary_failed', detail: error.message })

    const items = await Promise.all((data || []).map(async (client) => ({
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
      has_stripe_customer: !!client.stripe_customer_id,
      membership_terms: await readClientRetailBillingSummary({ db: supabaseAdmin, client })
    })))
    return res.json({ items })
  } catch (e) {
    return res.status(500).json({ error: 'server_error' })
  }
})

// Resolves which client a billing read is for, and refuses anything the caller
// is not a member of. Mirrors the checks the summary route above makes.
function resolveReadableClientId(req, res) {
  const ids = Array.isArray(req.client_memberships) ? req.client_memberships : []
  const wanted = String(req.query?.client_id || '').trim()
  const isGlobalAdmin = req.isGlobalAdmin === true || req.isAdmin === true

  if (wanted) {
    if (!ids.includes(wanted) && !isGlobalAdmin) {
      res.status(403).json({ error: 'forbidden' })
      return null
    }
    if (!isGlobalAdmin && !canViewLegalBillingForClient(req.clientScope, wanted)) {
      res.status(403).json({ error: 'forbidden' })
      return null
    }
    return wanted
  }

  const readable = isGlobalAdmin
    ? ids
    : ids.filter((clientId) => canViewLegalBillingForClient(req.clientScope, clientId))
  if (readable.length === 0) {
    res.status(403).json({ error: 'forbidden' })
    return null
  }
  if (readable.length > 1) {
    res.status(400).json({ error: 'client_id_required' })
    return null
  }
  return readable[0]
}

// Interview credits the client can still spend. A client on any other billing
// model simply has none, which is an empty list rather than an error.
router.get('/clients/billing/credits', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId = resolveReadableClientId(req, res)
    if (!clientId) return

    const billing = await readBillingForClient({ db: supabaseAdmin, clientId })
    if (!billing.ok) return res.status(500).json({ error: 'list_credits_failed', detail: billing.reason })
    if (!billing.credits.items.length) return res.json({ items: [], total_remaining: 0 })

    // The role a credit came from is named from the caller's own roles only, so
    // a title never leaks across clients.
    const titleById = new Map((billing.allocation.roles || [])
      .filter((role) => String(role.client_id) === String(clientId))
      .map((role) => [String(role.id), role.title || null]))

    const items = billing.credits.items.map((credit) => ({
      id: credit.id,
      source_role_id: credit.source_role_id,
      source_role_title: titleById.get(String(credit.source_role_id)) || null,
      quantity: credit.quantity,
      remaining: credit.remaining,
      minted_at: credit.minted_at,
      expires_at: credit.expires_at
    }))
    return res.json({ items, total_remaining: billing.credits.total_remaining })
  } catch (e) {
    return res.status(500).json({ error: 'list_credits_failed', detail: e?.message || 'list_credits_failed' })
  }
})

// What a usage client has run beyond its included counts and not yet been
// invoiced for, and what it has already been invoiced. Read-only: nothing here
// talks to Stripe or writes the ledger.
//
// The unbilled figure is live — an interview finished this morning is in it
// straight away — so it is not the same as the amount on the next invoice,
// which covers the month that has ended. Both come from the same allocation.
router.get('/clients/billing/usage', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId = resolveReadableClientId(req, res)
    if (!clientId) return

    const billing = await readBillingForClient({ db: supabaseAdmin, clientId })
    if (!billing.ok) return res.status(500).json({ error: 'read_usage_failed', detail: billing.reason })

    return res.json({
      lines: billing.unbilled_usage.lines,
      total_cents: billing.unbilled_usage.total_cents,
      billable: billing.unbilled_usage.billable,
      billed_invoices: billing.billed_usage.invoices
    })
  } catch (e) {
    return res.status(e?.status === 503 ? 503 : 500).json({ error: 'read_usage_failed', detail: e?.message || 'read_usage_failed' })
  }
})

// The Enterprise interview pool bought at signup: what is left of it, and what
// each block has been spent on. A client on any other model has no pool, which
// is zero rather than an error.
router.get('/clients/billing/pool', requireAuth, withClientScope, async (req, res) => {
  try {
    const clientId = resolveReadableClientId(req, res)
    if (!clientId) return

    const billing = await readBillingForClient({ db: supabaseAdmin, clientId })
    if (!billing.ok) return res.status(500).json({ error: 'read_pool_failed', detail: billing.reason })

    return res.json({
      billing_model: billing.billing_model,
      purchased: billing.pool.purchased,
      used: billing.pool.used,
      remaining: billing.pool.remaining,
      items: billing.pool.items
    })
  } catch (e) {
    return res.status(500).json({ error: 'read_pool_failed', detail: e?.message || 'read_pool_failed' })
  }
})

router.post('/clients/billing/portal-session', requireAuth, withClientScope, async (req, res) => {
  try {
    const ids = Array.isArray(req.client_memberships) ? req.client_memberships : []
    const clientId = String(req.body?.client_id || '').trim()
    const tab = sanitizeClientDashboardTab(req.body?.tab, 'billing')
    if (!clientId) return res.status(400).json({ error: 'client_id_required' })
    if (!ids.includes(clientId)) return res.status(403).json({ error: 'forbidden' })
    if (!hasClientWriteAccess(req, clientId)) return res.status(403).json({ error: 'forbidden' })

    const { data: client, error: clientErr } = await supabaseAdmin
      .from('clients')
      .select('id,stripe_customer_id')
      .eq('id', clientId)
      .maybeSingle()
    if (clientErr) return res.status(503).json({ error: 'RETAIL_PORTAL_UNAVAILABLE', code: 'RETAIL_PORTAL_UNAVAILABLE',
      detail: 'Billing portal is temporarily unavailable.' })
    if (!client) return res.status(404).json({ error: 'client_not_found' })

    const stripeCustomerId = String(client.stripe_customer_id || '').trim()
    if (!stripeCustomerId) return res.status(400).json({ error: 'missing_stripe_customer' })

    const stripe = require('../../clients/stripe')
    const returnParams = new URLSearchParams({
      client_id: clientId,
      tab
    })
    const session = await createClientBillingPortalSession({
      db: supabaseAdmin,
      stripe,
      clientId,
      customerId: stripeCustomerId,
      returnUrl: buildClientDashboardReturnUrl(returnParams),
      authorizeRetail: req.isGlobalAdmin === true || req.isAdmin === true || canViewLegalBillingForClient(req.clientScope, clientId),
      configurationId: process.env.STRIPE_RETAIL_PORTAL_CONFIGURATION_ID,
      stripeKey: process.env.STRIPE_SECRET_KEY
    })
    return res.json({ ok: true, url: session.url })
  } catch (e) {
    if (e?.code === 'RETAIL_PORTAL_UNAVAILABLE' || e?.code === 'RETAIL_PORTAL_FORBIDDEN') {
      return res.status(e.status).json({ error: e.code, code: e.code, detail: e.message });
    }
    return res.status(503).json({ error: 'RETAIL_PORTAL_UNAVAILABLE', code: 'RETAIL_PORTAL_UNAVAILABLE',
      detail: 'Billing portal is temporarily unavailable.' })
  }
})

router.post('/clients/billing/additional-interviews/checkout-session', requireAuth, withClientScope, async (req, res) => {
  try {
    const ids = Array.isArray(req.client_memberships) ? req.client_memberships : []
    const clientId = String(req.body?.client_id || '').trim()
    const roleId = String(req.body?.role_id || '').trim()
    const tab = sanitizeClientDashboardTab(req.body?.tab, 'billing')
    const embeddedCheckoutRequested = wantsEmbeddedCheckout(req.body?.embedded)
    const parsedQuantity = Number(req.body?.quantity)
    const quantity = Number.isInteger(parsedQuantity) ? parsedQuantity : NaN

    if (!clientId) return res.status(400).json({ error: 'client_id_required' })
    if (!ids.includes(clientId)) return res.status(403).json({ error: 'forbidden' })
    if (!hasClientWriteAccess(req, clientId)) return res.status(403).json({ error: 'forbidden' })
    if (!roleId) return res.status(400).json({ error: 'role_id_required' })
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ error: 'invalid_quantity' })
    }
    const billingScope = await resolveBillingOwnerForScope(supabaseAdmin, clientId)
    if (!billingScope.ok) return respondWithBillingScopeError(res, billingScope, 'billing_client_lookup_failed')
    const billingClient = billingScope.billingClient || {}
    const billingClientId = billingScope.billingClientId || clientId

    const { data: role, error: roleErr } = await supabaseAdmin
      .from('roles')
      .select('id,client_id,title')
      .eq('id', roleId)
      .eq('client_id', clientId)
      .maybeSingle()
    if (roleErr) return res.status(500).json({ error: 'role_lookup_failed', detail: roleErr.message })
    if (!role) return res.status(404).json({ error: 'role_not_found' })

    const { data: planSettings, error: planSettingsErr } = await supabaseAdmin
      .from('client_plan_settings')
      .select('additional_interview_fee,billing_model,plan_tier')
      .eq('client_id', billingClientId)
      .maybeSingle()
    if (planSettingsErr) return res.status(500).json({ error: 'plan_settings_lookup_failed', detail: planSettingsErr.message })

    // Preserve known legacy tier fallback, but do not let the general resolver's
    // default turn an unknown/invalid configuration into a paid purchase.
    const storedModel = String(planSettings?.billing_model ?? '').trim().toLowerCase()
    const storedTier = String(planSettings?.plan_tier ?? '').trim().toLowerCase()
    const confirmedModel = ['fixed', 'rollover', 'usage'].includes(storedModel)
      || (!storedModel && ['basic', 'essential', 'pro', 'enterprise'].includes(storedTier))
    if (!confirmedModel) return res.status(409).json({ error: 'BILLING_MODEL_UNAVAILABLE' })

    // Usage clients are invoiced for interviews beyond the included count after
    // the fact, so buying them in advance would charge twice. Refused with its
    // own code, before the price check — an Enterprise client on this model is
    // normally configured with no top-up price at all, and the generic
    // invalid_additional_interview_fee reads like a misconfiguration.
    // Resolved the way every other billing reader resolves it: a null column
    // follows the plan tier, and a child entity is charged under its parent.
    const { billing_model: billingModel } = await resolveBillingModel({ db: supabaseAdmin, clientId })
    if (!['fixed', 'rollover', 'usage'].includes(billingModel)) {
      return res.status(409).json({ error: 'BILLING_MODEL_UNAVAILABLE' })
    }
    if (billingModel === 'usage') {
      return res.status(409).json({
        error: 'usage_billing_no_top_ups',
        code: 'USAGE_BILLING_NO_TOP_UPS',
        detail: 'This plan bills interviews beyond the included count on your invoice, so they are not purchased in advance.'
      })
    }

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

    const stripe = require('../../clients/stripe')

    let stripeCustomerId = String(billingClient.stripe_customer_id || '').trim()
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
      const email = String(billingClient.email || '').trim()
      if (email) {
        const found = await stripe.customers.list({ email, limit: 1 })
        stripeCustomerId = String(found?.data?.[0]?.id || '').trim()
      }
      if (!stripeCustomerId) {
        const createdCustomer = await stripe.customers.create({
          name: billingClient.name || undefined,
          email: String(billingClient.email || '').trim() || undefined,
          metadata: {
            client_id: billingClientId,
            billing_client_id: billingClientId,
            scope_client_id: clientId
          }
        })
        stripeCustomerId = String(createdCustomer?.id || '').trim()
      }
      if (!stripeCustomerId) return res.status(500).json({ error: 'stripe_customer_create_failed' })

      if (stripeCustomerId !== String(billingClient.stripe_customer_id || '').trim()) {
        const { error: saveCustomerError } = await supabaseAdmin
          .from('clients')
          .update({ stripe_customer_id: stripeCustomerId })
          .eq('id', billingClientId)
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
    const checkoutBasePayload = {
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
      metadata: sessionMetadata
    }

    let checkoutClientSecret = null
    let primaryCheckoutSession = null
    let hostedFallbackSession = null

    if (embeddedCheckoutRequested) {
      try {
        primaryCheckoutSession = await stripe.checkout.sessions.create({
          ...checkoutBasePayload,
          ui_mode: 'embedded',
          return_url: buildClientDashboardReturnUrl(successParams)
        })
        const resolvedClientSecret = String(primaryCheckoutSession?.client_secret || '').trim()
        if (resolvedClientSecret) {
          checkoutClientSecret = resolvedClientSecret
        } else {
          primaryCheckoutSession = null
        }
      } catch (embeddedErr) {
        console.error('create_additional_interviews_embedded_checkout_session_failed:', embeddedErr?.message || embeddedErr)
      }
    }

    if (!primaryCheckoutSession) {
      primaryCheckoutSession = await stripe.checkout.sessions.create({
        ...checkoutBasePayload,
        success_url: buildClientDashboardReturnUrl(successParams),
        cancel_url: buildClientDashboardReturnUrl(cancelParams)
      })
    } else {
      try {
        hostedFallbackSession = await stripe.checkout.sessions.create({
          ...checkoutBasePayload,
          success_url: buildClientDashboardReturnUrl(successParams),
          cancel_url: buildClientDashboardReturnUrl(cancelParams)
        })
      } catch (hostedFallbackErr) {
        console.error('create_additional_interviews_hosted_fallback_checkout_session_failed:', hostedFallbackErr?.message || hostedFallbackErr)
      }
    }

    const checkoutUrl = String(hostedFallbackSession?.url || primaryCheckoutSession?.url || '').trim() || null
    const checkoutSessionId = String(primaryCheckoutSession?.id || hostedFallbackSession?.id || '').trim() || null

    const { error: updatePurchaseErr } = await supabaseAdmin
      .from('role_interview_purchases')
      .update({
        stripe_checkout_session_id: checkoutSessionId
      })
      .eq('id', pendingPurchase.id)
    if (updatePurchaseErr) {
      return res.status(500).json({ error: 'update_role_interview_purchase_failed', detail: updatePurchaseErr.message })
    }

    return res.json({
      ok: true,
      url: checkoutUrl,
      role_interview_purchase_id: pendingPurchase.id,
      checkout_client_secret: checkoutClientSecret,
      embedded_checkout: !!checkoutClientSecret
    })
  } catch (e) {
    return res.status(500).json({ error: 'create_additional_interviews_checkout_session_failed', detail: e?.message || 'create_additional_interviews_checkout_session_failed' })
  }
})


module.exports = router;
