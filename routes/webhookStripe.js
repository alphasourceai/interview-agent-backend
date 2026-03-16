// routes/webhookStripe.js
const express = require('express');
const Stripe = require('stripe');
const { supabaseAdmin } = require('../src/lib/supabaseClient');
const router = express.Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

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

const LIVE_SUB_STATUSES = new Set(['active', 'trialing']);
const PLAN_SETTINGS_DEFAULTS = {
  basic: {
    per_role_fee: 399,
    included_interviews_per_role: 25,
    additional_interview_fee: 35,
    max_interview_minutes: 8
  },
  pro: {
    per_role_fee: 699,
    included_interviews_per_role: 50,
    additional_interview_fee: 45,
    max_interview_minutes: 10
  }
};

function normalizeBillingInterval(raw, fallback = null) {
  const intervalRaw = String(raw || '').toLowerCase();
  if (intervalRaw === 'month') return 'monthly';
  if (intervalRaw === 'year') return 'annual';
  if (fallback === 'monthly' || fallback === 'annual') return fallback;
  return null;
}

function parseMoneyValue(raw, options = {}) {
  const allowZero = options.allowZero !== false;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  if (allowZero ? rounded < 0 : rounded <= 0) return null;
  return rounded;
}

function parseWholeNumber(raw, options = {}) {
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
  if (metadataSource !== 'admin_subscription_checkout') return null;

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

    if (
      platformFee === null ||
      perRoleFee === null ||
      includedInterviewsPerRole === null ||
      additionalInterviewFee === null
    ) {
      return null;
    }

    return {
      client_id: clientId,
      plan_tier: 'enterprise',
      billing_interval: billingInterval,
      platform_fee: platformFee,
      per_role_fee: perRoleFee,
      included_interviews_per_role: includedInterviewsPerRole,
      additional_interview_fee: additionalInterviewFee,
      max_interview_minutes: 15
    };
  }

  const defaults = PLAN_SETTINGS_DEFAULTS[planTier];
  if (!defaults) return null;
  return {
    client_id: clientId,
    plan_tier: planTier,
    billing_interval: billingInterval,
    platform_fee: null,
    per_role_fee: defaults.per_role_fee,
    included_interviews_per_role: defaults.included_interviews_per_role,
    additional_interview_fee: defaults.additional_interview_fee,
    max_interview_minutes: defaults.max_interview_minutes
  };
}

async function upsertClientPlanSettingsFromSubscription(subscription, clientId, options = {}) {
  const payload = buildClientPlanSettingsPayloadFromSubscription(subscription, clientId, options);
  if (!payload) return false;
  const { error } = await supabaseAdmin
    .from('client_plan_settings')
    .upsert(payload, { onConflict: 'client_id' });
  if (error) throw new Error(error.message || 'Client plan settings upsert failed');
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
  if (metadataSource === 'admin_subscription_checkout' && ['basic', 'pro', 'enterprise'].includes(metadataPlanTier)) {
    updates.plan_tier = metadataPlanTier;
  }
  return updates;
}

router.post('/', async (req, res) => {
  const request_id = req.request_id || null;
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    return res.status(400).json({
      error: 'bad_request',
      code: 'STRIPE_SIGNATURE_VERIFICATION_FAILED',
      detail: err?.message || 'Invalid signature',
      hint: null,
      request_id
    });
  }

  const eventObject = event?.data?.object || null;
  const { error: insertErr } = await supabaseAdmin
    .from('billing_events')
    .insert({
      stripe_event_id: event.id,
      type: event.type,
      payload: eventObject
    });

  if (insertErr) {
    if (isUniqueViolation(insertErr)) {
      return res.status(200).json({ ok: true });
    }
    return res.status(500).json({
      error: 'server_error',
      code: 'BILLING_EVENT_INSERT_FAILED',
      detail: insertErr.message,
      hint: insertErr.hint || null,
      request_id
    });
  }

  const markProcessed = async (processed_ok, errorText = null) => {
    await supabaseAdmin
      .from('billing_events')
      .update({
        processed_ok,
        error: errorText
      })
      .eq('stripe_event_id', event.id);
  };

  try {
    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const customerId = pickId(eventObject?.customer);
      if (customerId) {
        const { data: client, error: clientErr } = await supabaseAdmin
          .from('clients')
          .select('id')
          .eq('stripe_customer_id', customerId)
          .maybeSingle();
        if (clientErr) throw new Error(clientErr.message || 'Client lookup failed');
        if (client?.id) {
          const updates = buildClientSubscriptionUpdatesFromStripe(eventObject, {
            fallbackCustomerId: customerId,
            fallbackSubscriptionId: pickId(eventObject?.id) || pickId(eventObject?.subscription) || null
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
        }
      }
    } else if (event.type === 'checkout.session.completed') {
      if (String(eventObject?.mode || '').toLowerCase() === 'subscription') {
        const metadata = eventObject?.metadata && typeof eventObject.metadata === 'object' ? eventObject.metadata : {};
        const metadataSource = String(metadata?.source || '').trim().toLowerCase();
        const metadataClientId = String(metadata?.client_id || '').trim();
        const metadataPlanTier = String(metadata?.plan_tier || '').trim().toLowerCase();
        const metadataBillingInterval = String(metadata?.billing_interval || '').trim().toLowerCase();
        const subscriptionId = pickId(eventObject?.subscription);
        const customerId = pickId(eventObject?.customer);

        if (subscriptionId) {
          let targetClientId = null;
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
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const updates = buildClientSubscriptionUpdatesFromStripe(subscription, {
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

            if (metadataSource === 'admin_subscription_checkout') {
              const planTierForSettings = String(updates?.plan_tier || metadataPlanTier || '').trim().toLowerCase();
              const billingIntervalForSettings = String(updates?.billing_interval || metadataBillingInterval || '').trim().toLowerCase();
              let planSettingsPayload = null;

              if (['basic', 'pro'].includes(planTierForSettings) && ['monthly', 'annual'].includes(billingIntervalForSettings)) {
                const defaults = PLAN_SETTINGS_DEFAULTS[planTierForSettings];
                planSettingsPayload = {
                  client_id: targetClientId,
                  plan_tier: planTierForSettings,
                  billing_interval: billingIntervalForSettings,
                  platform_fee: null,
                  per_role_fee: defaults.per_role_fee,
                  included_interviews_per_role: defaults.included_interviews_per_role,
                  additional_interview_fee: defaults.additional_interview_fee,
                  max_interview_minutes: defaults.max_interview_minutes
                };
              } else if (planTierForSettings === 'enterprise' && ['monthly', 'annual'].includes(billingIntervalForSettings)) {
                const subscriptionMetadata = subscription?.metadata && typeof subscription?.metadata === 'object' ? subscription.metadata : {};
                const platformFee = parseMoneyValue(subscriptionMetadata?.platform_fee ?? metadata?.platform_fee, { allowZero: false });
                const perRoleFee = parseMoneyValue(subscriptionMetadata?.per_role_fee ?? metadata?.per_role_fee);
                const includedInterviewsPerRole = parseWholeNumber(subscriptionMetadata?.included_interviews_per_role ?? metadata?.included_interviews_per_role);
                const additionalInterviewFee = parseMoneyValue(subscriptionMetadata?.additional_interview_fee ?? metadata?.additional_interview_fee);

                if (
                  platformFee !== null &&
                  perRoleFee !== null &&
                  includedInterviewsPerRole !== null &&
                  additionalInterviewFee !== null
                ) {
                  planSettingsPayload = {
                    client_id: targetClientId,
                    plan_tier: 'enterprise',
                    billing_interval: billingIntervalForSettings,
                    platform_fee: platformFee,
                    per_role_fee: perRoleFee,
                    included_interviews_per_role: includedInterviewsPerRole,
                    additional_interview_fee: additionalInterviewFee,
                    max_interview_minutes: 15
                  };
                }
              }

              if (planSettingsPayload) {
                const { error: planSettingsErr } = await supabaseAdmin
                  .from('client_plan_settings')
                  .upsert(planSettingsPayload, { onConflict: 'client_id' });
                if (planSettingsErr) throw new Error(planSettingsErr.message || 'Client plan settings upsert failed');
              }
            }
          }
        }
      }
    } else if (event.type === 'invoice.payment_succeeded' || event.type === 'invoice.payment_failed') {
      const customerId = pickId(eventObject?.customer);
      const subscriptionId = pickId(eventObject?.subscription);
      const metadata = eventObject?.metadata && typeof eventObject.metadata === 'object' ? eventObject.metadata : {};
      const metadataSource = String(metadata?.source || '').trim().toLowerCase();
      const metadataClientId = String(metadata?.client_id || '').trim();
      const metadataPlanTier = String(metadata?.plan_tier || '').trim().toLowerCase();
      const metadataBillingInterval = String(metadata?.billing_interval || '').trim().toLowerCase();
      const isAdminSubscriptionInvoice =
        event.type === 'invoice.payment_succeeded' &&
        metadataSource !== 'admin_subscription_checkout' &&
        !!metadataClientId &&
        ['basic', 'pro', 'enterprise'].includes(metadataPlanTier) &&
        ['monthly', 'annual'].includes(metadataBillingInterval);

      if (isAdminSubscriptionInvoice) {
        const { data: activationClient, error: activationClientErr } = await supabaseAdmin
          .from('clients')
          .select('id')
          .eq('id', metadataClientId)
          .maybeSingle();
        if (activationClientErr) throw new Error(activationClientErr.message || 'Client lookup failed');
        if (!activationClient?.id) throw new Error('Client lookup failed');

        const contractStartAt = new Date().toISOString();
        const contractEndAt = addMonthsToIso(contractStartAt, 12);
        const invoicePeriodEnd = toIsoFromUnixSeconds(eventObject?.lines?.data?.[0]?.period?.end);
        const activationUpdates = {
          plan_tier: metadataPlanTier,
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

      if (customerId) {
        const { data: client, error: clientErr } = await supabaseAdmin
          .from('clients')
          .select('id')
          .eq('stripe_customer_id', customerId)
          .maybeSingle();
        if (clientErr) throw new Error(clientErr.message || 'Client lookup failed');
        if (client?.id) {
          if (subscriptionId) {
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
    await markProcessed(false, String(err?.message || err || 'processing_failed'));
    return res.status(200).json({ ok: true });
  }
});

module.exports = router;
