'use strict';

// Commercial correspondence at the EXISTING signed-agreement checkout boundary.
// No account creation, price lookup, provider call, or browser price authority.
const { readRetailPackageOffer } = require('./membershipPackageCompatibility');
const { isDeepStrictEqual } = require('node:util');
const { GENERATION_DATE_OFFER_VERSION } = require('./membershipOffers');
const { validateRetailAgreementSource } = require('./retailQuoteSelection');
const TEMPLATE_VERSION = 'membership_agreement_retail_terms_v2';
function fail(code) { const e = new Error(code); e.code = code; e.status = 409; throw e; }
const check = (value, code = 'package_snapshot_mismatch') => { if (!value) fail(code); };
const tier = value => value === 'essential' ? 'basic' : value;
function matchesNumber(value, expected) {
  return (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d{1,2})?$/.test(value)))
    && Number.isFinite(Number(value)) && Number(value) === expected;
}
function validDeadline(value, code, storedOnly = false) {
  const time = typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  check(Number.isFinite(time), code);
  if (!storedOnly && time <= Date.now()) { const e = new Error(code); e.code = code; e.status = 410; throw e; }
}
function readSavedRetailCheckoutTerms({ agreement, intent, deadlineMode = 'checkout' } = {}) {
  check(['checkout','stored'].includes(deadlineMode), 'invalid_retail_deadline_mode');
  const saved = agreement?.template_snapshot;
  // Inspect BOTH raw saved snapshots, including malformed/mixed discriminators,
  // BEFORE falling back to legacy. A prepaid label alone is never sufficient.
  const offer = readRetailPackageOffer(saved?.package_snapshot);
  const intentOffer = readRetailPackageOffer(intent?.package_snapshot);
  const prepaid = [agreement?.billing_option, saved?.values?.billing_option, intent?.selected_billing_cadence]
    .some(value => typeof value === 'string' && value.trim().toLowerCase() === 'prepaid');
  const retailTemplate = agreement?.template_version === TEMPLATE_VERSION || saved?.template_version === TEMPLATE_VERSION;
  if (!offer && !intentOffer && !prepaid && !retailTemplate) return null;
  check(offer, 'package_snapshot_missing');
  const values = saved?.values;
  const generation = offer.offer_version === GENERATION_DATE_OFFER_VERSION;
  const cadence = offer.payment_option === 'prepaid' ? 'prepaid' : 'monthly';
  // A new commercial snapshot must have been issued with the new legal copy,
  // never an old twelve-month PDF relabeled with a new price at checkout.
  check(agreement.template_version === TEMPLATE_VERSION && saved.template_version === TEMPLATE_VERSION,
    'retail_agreement_template_required');
  check(values && tier(values.membership_tier) === offer.plan_key && tier(agreement.membership_tier) === offer.plan_key
    && values.billing_option === cadence && agreement.billing_option === cadence
    && values.commitment_months === offer.commitment_months && values.payment_option === offer.payment_option
    && values.pricing_version === offer.offer_version && values.term_start_basis === (generation ? 'generation_date' : 'successful_payment')
    && values.auto_renew === true && agreement.auto_renew === true);
  // Re-read the same accepted generation calendar rendered in the PDF; no
  // replacement clock or browser date may enter the payment proof.
  if (generation) validateRetailAgreementSource(agreement);
  const fields = { platform_fee: offer.platform_payment_cents / 100, per_role_fee: offer.per_role_fee_cents / 100,
    additional_interview_fee: offer.additional_interview_fee_cents / 100,
    included_interviews_per_role: offer.included_interviews_per_role, max_interview_minutes: offer.max_interview_minutes };
  check(Object.entries(fields).every(([key, expected]) => matchesNumber(values[key], expected)));
  check(values.first_role_prepay?.selected === offer.first_role_prepay.selected);
  if (offer.first_role_prepay.selected) {
    check(matchesNumber(values.first_role_prepay.discounted_credit_amount_cents, offer.first_role_prepay.amount_cents)
      && matchesNumber(values.first_role_prepay.normal_role_fee_cents, offer.per_role_fee_cents)
      && values.first_role_prepay.credit_type === 'first_role_prepay');
  }
  check(!agreement.superseded_by_agreement_id && agreement.signer_accepted === true,
    'agreement_not_checkout_eligible');
  // Delayed webhook validation uses stored deadlines; its authenticated paid_at
  // is checked against them by funding proof, never against today's wall clock.
  validDeadline(agreement.agreement_expires_at, 'agreement_expired', deadlineMode === 'stored');
  const linked = ['public_purchase_intent', 'sales_assisted'].includes(saved.source);
  if (linked) {
    check(intent && intentOffer && isDeepStrictEqual(offer, intentOffer));
    check(intent.protocol === 'fenced_v2' && intent.id === saved.purchase_intent?.id && intent.agreement_id === agreement.id);
    if (generation) check(intent.term_start_basis === 'generation_date');
    check(intent.selected_plan_key === offer.plan_key && intent.selected_billing_cadence === cadence
      && intent.first_role_prepay_selected === offer.first_role_prepay.selected);
    if (offer.first_role_prepay.selected) {
      check(intent.first_role_prepay_amount_cents === offer.first_role_prepay.amount_cents
        && intent.first_role_normal_role_fee_cents === offer.per_role_fee_cents
        && intent.first_role_prepay_discount_percent === 10 && intent.first_role_prepay_credit_type === 'first_role_prepay');
    }
    validDeadline(intent.expires_at, 'purchase_intent_expired', deadlineMode === 'stored');
    if (offer.payment_option === 'prepaid') check(!String(intent.promotion_code_id || '').trim(), 'retail_prepaid_discount_denied');
    if (saved.source === 'public_purchase_intent') check(offer.payment_option === 'prepaid', 'public_installments_not_available');
  } else check(!intent && !intentOffer);
  return { offer, billingInterval: cadence, packageSnapshot: saved.package_snapshot };
}
module.exports = { readSavedRetailCheckoutTerms, TEMPLATE_VERSION };
