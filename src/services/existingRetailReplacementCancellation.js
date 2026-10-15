'use strict';

// Cancellation is an irreversible provider mutation. This module is mounted
// only after the fenced retail agreement has a native funding receipt and
// activation completion. A pending journal alone never authorizes a DELETE.
const { prepareExistingRetailReplacement } = require('./existingRetailReplacementPreflight');
const { TIMEOUT_PROFILES } = require('../clients/http');
const { snapshotStripeSdkData: snap } = require('./enterprisePoolPaymentProof');

class Hold extends Error {
  constructor(code = 'retail_replacement_cancel_unknown') {
    super(code); this.code = code; this.status = 503;
  }
}
const fail = code => { throw new Hold(code); };
const id = value => typeof value === 'string' ? value : value?.id;
const epoch = value => Number.isSafeInteger(value) && value > 0 && value <= 253402300799;
const apiVersion = stripe => typeof stripe?.getApiField === 'function' && stripe.getApiField('version') === '2023-10-16'
  && !stripe.getApiField('stripeAccount');

function canceledProjection(value, request) {
  if (!value || value.id !== request.old_subscription_id || id(value.customer) !== request.customer_id
    || value.currency !== 'usd' || value.livemode !== request.livemode || value.status !== 'canceled'
    || !epoch(value.canceled_at) || value.canceled_at > Math.floor(Date.now() / 1000)) return null;
  return { id: value.id, customer: id(value.customer), currency: value.currency, livemode: value.livemode,
    status: value.status, canceled_at: value.canceled_at };
}

async function execute(options = {}) {
  const { db, stripe, agreementId, intentId, claimKey, assertFence = async () => {} } = options;
  if (!db || !stripe || !apiVersion(stripe) || !stripe.subscriptions
    || typeof stripe.subscriptions.cancel !== 'function' || typeof stripe.subscriptions.retrieve !== 'function'
    || typeof assertFence !== 'function' || !agreementId || !intentId || typeof claimKey !== 'string' || claimKey.length < 32) {
    fail('retail_replacement_cancel_precondition_unknown');
  }

  let prepared;
  try {
    prepared = await (options.prepareExistingRetailReplacement || prepareExistingRetailReplacement)({
      db, stripe, agreementId, intentId, claimKey, assertFence,
      eventSessionId: options.eventSessionId, eventSubscriptionId: options.eventSubscriptionId,
      eventInvoiceId: options.eventInvoiceId, eventLivemode: options.eventLivemode
    });
  } catch (error) {
    if (error?.code === 'public_purchase_activation_guard_lost') fail('public_purchase_activation_guard_lost');
    fail('retail_replacement_cancel_preflight_unknown');
  }
  if (prepared?.status === 'no_replacement' && prepared.request === null && prepared.effect_authorized === false
    && prepared.native_completion === false) {
    return { status: 'no_replacement' };
  }
  if (prepared?.status !== 'preflight_verified' || prepared.effect_authorized !== false
    || prepared.native_completion !== false || !prepared.request || !prepared.old_subscription) {
    fail('retail_replacement_cancel_preflight_unknown');
  }
  const request = snap(prepared.request);
  if (Object.keys(request).sort().join(',') !== ['agreement_id','api_version','cancellation','client_id','customer_id','funding_receipt_digest',
    'intent_id','livemode','new_subscription_id','old_subscription_id','provider_account_id','source_digest','version'].sort().join(',')
    || request.agreement_id !== agreementId || request.intent_id !== intentId
    || request.api_version !== '2023-10-16' || request.cancellation?.method !== 'DELETE'
    || !/^acct_[A-Za-z0-9_]+$/.test(request.provider_account_id || '') || typeof request.livemode !== 'boolean'
    || !/^cus_[A-Za-z0-9_]+$/.test(request.customer_id || '')
    || !/^sub_[A-Za-z0-9_]{1,250}$/.test(request.old_subscription_id || '')
    || !/^sub_[A-Za-z0-9_]{1,250}$/.test(request.new_subscription_id || '')
    || !/^[a-f0-9]{64}$/.test(request.source_digest || '') || !/^[a-f0-9]{64}$/.test(request.funding_receipt_digest || '')
    || request.cancellation?.path !== `/v1/subscriptions/${request.old_subscription_id}`
    || request.cancellation?.policy !== 'immediate_cancel'
    || request.cancellation?.parameters?.invoice_now !== false || request.cancellation?.parameters?.prorate !== false) {
    fail('retail_replacement_cancel_request_unknown');
  }

  let canceled = canceledProjection(prepared.old_subscription, request);
  if (!canceled) {
    // One bounded DELETE, with SDK retries explicitly disabled. A lost/unknown
    // response is resolved by exactly one fresh GET; it is never blindly retried.
    await assertFence();
    try {
      const result = snap(await stripe.subscriptions.cancel(request.old_subscription_id,
        { invoice_now: false, prorate: false }, { maxNetworkRetries: 0, timeout: TIMEOUT_PROFILES.mutation.requestMs }));
      if (apiVersion(stripe)) canceled = canceledProjection(result, request);
    } catch (_) {
      canceled = null;
    }
    await assertFence();
    if (!canceled) {
      if (!apiVersion(stripe)) fail('retail_replacement_cancel_api_changed');
      let fresh;
      try {
        // The shared Stripe client allows one network retry by default. Keep
        // this confirmation to exactly one bounded request after an unknown
        // DELETE outcome; a second GET could otherwise race another mutation.
        fresh = snap(await stripe.subscriptions.retrieve(request.old_subscription_id, {}, {
          maxNetworkRetries: 0,
          timeout: TIMEOUT_PROFILES.mutation.requestMs
        }));
      }
      catch (_) { fail('retail_replacement_cancel_unconfirmed'); }
      await assertFence();
      canceled = canceledProjection(fresh, request);
    }
  }
  if (!canceled) fail('retail_replacement_cancel_unconfirmed');

  await assertFence();
  let recorded;
  try {
    const result = await db.rpc('record_retail_existing_replacement_canceled', {
      p_agreement: agreementId, p_intent: intentId, p_claim: claimKey,
      p_request: request, p_account: request.provider_account_id, p_old: canceled
    });
    if (!result || result.error) {
      if (result?.error?.message === 'retail_cancel_observation_claim_denied'
        || result?.error?.code === 'retail_cancel_observation_claim_denied') fail('public_purchase_activation_guard_lost');
      fail('retail_replacement_cancel_record_unknown');
    }
    recorded = snap(result.data);
  } catch (error) {
    if (error instanceof Hold) throw error;
    if (error?.message === 'retail_cancel_observation_claim_denied'
      || error?.code === 'retail_cancel_observation_claim_denied') fail('public_purchase_activation_guard_lost');
    fail('retail_replacement_cancel_record_unknown');
  }
  await assertFence();
  if (!recorded || !['observed', 'existing'].includes(recorded.status)
    || recorded.observation?.request == null || recorded.observation.request.agreement_id !== agreementId
    || recorded.observation.request.intent_id !== intentId
    || recorded.observation.old_subscription?.id !== canceled.id
    || recorded.observation.provider_account_id !== request.provider_account_id) {
    fail('retail_replacement_cancel_record_unknown');
  }
  return { status: recorded.status };
}

module.exports = { executeExistingRetailReplacementCancellation: execute };
