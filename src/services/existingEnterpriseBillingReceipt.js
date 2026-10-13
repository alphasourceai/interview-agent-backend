'use strict';

// Native receipt verification, not provider authentication or mutable admin
// settings verification. Callers are server readers, not browser payloads.
const { isDeepStrictEqual } = require('node:util');
const { snapshotStripeSdkData } = require('./enterprisePoolPaymentProof');
const PROOF_KEYS = require('./enterpriseExistingFundingKeys');
const { anchoredMonthInstant } = require('./membershipOffers');
const { validateEnterpriseSettings } = require('./enterpriseSettings');
const { dollarsToCents } = require('./existingEnterpriseCheckoutAttempt');
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
function fail() {
  const error = new Error('enterprise_billing_receipt_unverified');
  error.code = error.message; error.status = 503; throw error;
}
function check(value) { if (!value) fail(); }
function iso6(value) {
  const parsed = Date.parse(value);
  check(Number.isFinite(parsed));
  return new Date(parsed).toISOString().replace(/(\.\d{3})Z$/, '$1000Z');
}
function stamp(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value));
  const parsed = Date.parse(value);
  check(Number.isFinite(parsed) && new Date(parsed).toISOString() === value.replace(/(\.\d{3})\d{3}Z$/, '$1Z'));
  return BigInt(parsed) * 1000n + BigInt(value.slice(-4, -1));
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function verifyEnterpriseBillingReceipt(value, { source, prices, fundingReceipt, expectedSubscription } = {}) {
  try {
    const receipt = snapshotStripeSdkData(value), funding = receipt?.funding_receipt, proof = funding?.proof;
    check(keys(receipt, ['version', 'funding_receipt', 'subscription', 'client_initial', 'plan_initial', 'applied_at'])
      && receipt.version === 'enterprise_existing_billing_v1'
      && keys(funding, ['version', 'proof', 'recorded_at']) && funding.version === 'enterprise_existing_funding_v1'
      && keys(proof, PROOF_KEYS) && isDeepStrictEqual(funding, snapshotStripeSdkData(fundingReceipt))
      && stamp(receipt.applied_at) >= stamp(funding.recorded_at)
      && stamp(funding.recorded_at) >= stamp(iso6(proof.payment_success_at)));
    const sub = receipt.subscription, material = source?.material, values = material?.template_snapshot?.values;
    check(keys(sub, ['id', 'customer', 'status', 'current_period_end', 'cancel_at_period_end'])
      && sub.id === proof.subscription_id && sub.customer === proof.customer_id && sub.status === 'active'
      && Number.isSafeInteger(sub.current_period_end) && sub.current_period_end > 0 && sub.current_period_end <= 253402300799
      && sub.current_period_end * 1000 > Date.parse(proof.payment_success_at)
      && typeof sub.cancel_at_period_end === 'boolean' && typeof material?.auto_renew === 'boolean'
      && sub.cancel_at_period_end === !material.auto_renew
      && (expectedSubscription === undefined || isDeepStrictEqual(sub, snapshotStripeSdkData(expectedSubscription))));
    check(proof.client_id === material.client_id && proof.customer_id === material.customer_id
      && proof.pool_id === source.pool_id && proof.platform_price_id === prices?.platform_price_id
      && proof.pool_price_id === prices?.pool_price_id && proof.platform_nominal_cents === dollarsToCents(values.platform_fee)
      && proof.credits_spendable === false && proof.membership_activation_required === true && proof.native_receipt_required === true);
    check(typeof values.term_start_basis === 'string'
      && (!Object.hasOwn(material.template_snapshot, 'term_start_basis')
        || material.template_snapshot.term_start_basis === values.term_start_basis));
    let start, end;
    if (values.term_start_basis === 'agreement_date') {
      check(/^\d{4}-\d{2}-\d{2}$/.test(values.initial_term_start) && /^\d{4}-\d{2}-\d{2}$/.test(values.initial_renewal_date));
      start = iso6(values.initial_term_start + 'T00:00:00.000Z');
      end = iso6(values.initial_renewal_date + 'T00:00:00.000Z');
      check(start.slice(0, 10) === values.initial_term_start && end.slice(0, 10) === values.initial_renewal_date && end > start);
    } else {
      check(values.term_start_basis === 'successful_payment' && values.initial_term_start === '' && values.initial_renewal_date === '');
      start = iso6(proof.payment_success_at); end = iso6(anchoredMonthInstant(proof.payment_success_at, 12));
    }
    const settings = validateEnterpriseSettings(values, { planTier: 'enterprise' });
    check(settings.ok && settings.settings.billing_model === 'usage' && settings.settings.rollover_days === null
      && Number(values.per_role_fee) === 0 && Number(values.additional_interview_fee) === 0
      && Number(values.included_interviews_per_role) === 0 && Number.isSafeInteger(Number(values.usage_interview_fee_cents))
      && Number(values.usage_interview_fee_cents) > 0);
    const clientInitial = { stripe_customer_id: proof.customer_id, stripe_subscription_id: proof.subscription_id,
      subscription_status: 'active', billing_status: 'active', billing_interval: material.billing_option, plan_tier: 'enterprise',
      current_term_end: iso6(new Date(sub.current_period_end * 1000).toISOString()), cancel_at_term_end: !material.auto_renew,
      auto_renew: material.auto_renew, cancel_effective_at: null, contract_start_at: start, contract_end_at: end };
    const planInitial = { client_id: proof.client_id, plan_tier: 'enterprise', billing_interval: material.billing_option,
      platform_fee: proof.platform_nominal_cents / 100, per_role_fee: 0, included_interviews_per_role: 0, additional_interview_fee: 0,
      max_interview_minutes: settings.settings.max_interview_minutes ?? 15,
      scored_question_count: settings.settings.scored_question_count, billing_model: 'usage',
      usage_interview_fee_cents: Number(values.usage_interview_fee_cents) };
    check(isDeepStrictEqual(receipt.client_initial, snapshotStripeSdkData(clientInitial))
      && isDeepStrictEqual(receipt.plan_initial, snapshotStripeSdkData(planInitial)));
    return freeze(receipt);
  } catch (_) { fail(); }
}
async function readVerifiedEnterpriseBillingReceipt({ db, agreement }) {
  try {
    const result = await db.rpc('read_enterprise_existing_billing', { p_agreement: agreement.id });
    check(result && !result.error);
    if (agreement.enterprise_billing_receipt == null) { check(result.data == null); return null; }
    const receipt = verifyEnterpriseBillingReceipt(result.data, { source: agreement.enterprise_checkout_source,
      prices: agreement.enterprise_checkout_prices, fundingReceipt: agreement.enterprise_funding_receipt });
    check(isDeepStrictEqual(receipt, snapshotStripeSdkData(agreement.enterprise_billing_receipt)));
    return receipt;
  } catch (_) { fail(); }
}
module.exports = { verifyEnterpriseBillingReceipt, readVerifiedEnterpriseBillingReceipt, freeze };
