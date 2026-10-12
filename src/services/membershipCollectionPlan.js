'use strict';

// UNMOUNTED calendar descriptor only. Inputs must come from native accepted
// source + genuine original full-paid proof, never a request body. No provider,
// collection, preference, access, account or commission authority is returned.
const { isProxy } = require('node:util').types;
const { anchoredMonthInstant, retailTermWindow } = require('./membershipOffers');
const UUID = /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

function fail(code = 'invalid_membership_collection_plan') {
  const error = new Error(code);
  error.code = code;
  error.status = 409;
  throw error;
}
function requireValue(value) { if (!value) fail(); }
function dataObject(value) {
  return value && typeof value === 'object' && !isProxy(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).every(key => typeof key === 'string')
    && Object.values(Object.getOwnPropertyDescriptors(value))
      .every(descriptor => descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
}
function ownKeys(value, keys) {
  return dataObject(value) && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}
function safeJson(value, depth = 0) {
  if (depth > 12) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 2048;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (!dataObject(value)) return false;
  return Object.keys(value).length <= 100
    && Object.values(Object.getOwnPropertyDescriptors(value))
      .every(descriptor => safeJson(descriptor.value, depth + 1));
}
const cents = value => Number.isSafeInteger(value) && value >= 0;
function acceptedOffer(value) {
  requireValue(safeJson(value));
  // Validate the accepted descriptor, not today's mutable catalog prices.
  requireValue(value.schema_version === 2 && typeof value.offer_version === 'string'
    && value.offer_version.length > 0 && ['basic', 'pro'].includes(value.plan_key)
    && value.currency === 'usd' && value.term_start_basis === 'first_payment_success'
    && value.contract_timezone === 'UTC' && [3, 6, 12].includes(value.commitment_months)
    && ['prepaid', 'monthly_installments'].includes(value.payment_option));
  const interval = value.payment_option === 'prepaid' ? value.commitment_months : 1;
  const payments = value.payment_option === 'prepaid' ? 1 : value.commitment_months;
  requireValue(cents(value.platform_payment_cents) && value.platform_payment_cents > 0
    && cents(value.platform_commitment_total_cents)
    && value.platform_commitment_total_cents === value.platform_payment_cents * payments
    && value.installment_count === payments && value.stripe_recurrence?.interval === 'month'
    && value.stripe_recurrence.interval_count === interval
    && typeof value.first_role_prepay?.selected === 'boolean'
    && cents(value.first_role_prepay.amount_cents)
    && (value.first_role_prepay.selected ? value.first_role_prepay.amount_cents > 0
      : value.first_role_prepay.amount_cents === 0)
    && cents(value.initial_payment_cents)
    && value.initial_payment_cents === value.platform_payment_cents + value.first_role_prepay.amount_cents
    && value.renewal?.default_auto_renew === true && value.renewal.retain_accepted_pricing === true
    && value.renewal.commitment_months === value.commitment_months
    && value.renewal.non_renewal_cutoff === 'before_term_end'
    && value.renewal.ends_installments_early === false);
  return { offer: structuredClone(value), interval };
}
function freeze(value) {
  for (const item of Object.values(value)) if (item && typeof item === 'object') freeze(item);
  return Object.freeze(value);
}

function planMembershipCollection(input) {
  requireValue(ownKeys(input, ['purchaseId', 'sourceDigest', 'offer', 'originalPaidAt', 'boundaryOffset']));
  const { purchaseId, sourceDigest, originalPaidAt, boundaryOffset } = input;
  requireValue(typeof purchaseId === 'string' && UUID.test(purchaseId)
    && typeof sourceDigest === 'string' && HASH.test(sourceDigest)
    && typeof originalPaidAt === 'string'
    && Number.isSafeInteger(boundaryOffset) && boundaryOffset > 0 && boundaryOffset <= 12000);
  const { offer, interval } = acceptedOffer(input.offer);
  requireValue(offer.payment_option !== 'prepaid' || boundaryOffset % offer.commitment_months === 0);
  // Helpers validate a strict original UTC instant and supported calendar range.
  let starts, ends, term;
  const termIndex = Math.floor(boundaryOffset / offer.commitment_months);
  try {
    starts = anchoredMonthInstant(originalPaidAt, boundaryOffset);
    ends = anchoredMonthInstant(originalPaidAt, boundaryOffset + interval);
    term = retailTermWindow({ originalStart: originalPaidAt,
      commitmentMonths: offer.commitment_months, termIndex });
  } catch (_) { fail(); }
  const inTermIndex = boundaryOffset % offer.commitment_months;
  const kind = inTermIndex === 0 ? 'renewal_first_payment' : 'commitment_installment';
  // Amount/date/digest do NOT generate a second identity. The native ledger must
  // UNIQUE(purchase,offset) and hold a changed descriptor against this key.
  // Kind is also derived from accepted terms, not a way to bypass that identity.
  const key = `membership-collection-v2:${purchaseId}:${boundaryOffset}`;
  return freeze({
    protocol: 'owned_membership_collection_v2', purchase_id: purchaseId,
    source_digest: sourceDigest, original_paid_at: new Date(originalPaidAt).toISOString(),
    boundary_offset_months: boundaryOffset, collection_key: key, kind,
    term_index: termIndex, installment_index_in_term: inTermIndex,
    term_start_at: term.term_start_at, term_end_at: term.term_end_at,
    period_start_at: starts, period_end_at: ends, collect_not_before: starts,
    currency: 'usd', platform_cents_before_tax: offer.platform_payment_cents,
    first_role_cents: 0, offer_version: offer.offer_version,
    requires_existing_commitment: kind === 'commitment_installment',
    requires_renewal_preference_fence: kind === 'renewal_first_payment',
    requires_native_period_and_owner_proof: true,
    requires_verified_tax_policy: true,
    required_invoice_auto_advance: false,
    provider_effects_enabled: false, paid_access_enabled: false, commission_enabled: false,
    operations: {
      create_invoice_key: `${key}:create-invoice`,
      finalize_invoice_key: `${key}:finalize-invoice`,
      pay_invoice_key: `${key}:pay-invoice`
    }
  });
}

module.exports = { planMembershipCollection };
