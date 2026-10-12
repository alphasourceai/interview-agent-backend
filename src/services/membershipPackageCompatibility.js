'use strict';
// Pricing adapter for the EXISTING package/agreement/Checkout/activation flow.
// No account, password, invitation, client-ownership or payment side effects.
const { isProxy } = require('node:util').types;
const { buildRetailOffer } = require('./membershipOffers');
const PROTOCOL = 'retail_package_terms_v2';
const FIELDS = ['schema_version','offer_version','offer_key','plan_key','display_name','currency','commitment_months',
  'term_start_basis','contract_timezone','payment_option','platform_payment_cents','platform_commitment_total_cents',
  'installment_count','stripe_recurrence','initial_payment_cents','per_role_fee_cents','additional_interview_fee_cents',
  'included_interviews_per_role','max_interview_minutes','scored_question_count','billing_model','rollover_days','first_role_prepay','renewal'];
function invalid() { const e = new Error('invalid_retail_package_terms'); e.code = e.message; e.status = 409; throw e; }
const check = v => { if (!v) invalid(); };
function object(v, fields) {
  check(v && typeof v === 'object' && !isProxy(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v)));
  const d = Object.getOwnPropertyDescriptors(v); check(Reflect.ownKeys(d).length === fields.length
    && fields.every(k => d[k]?.enumerable && Object.hasOwn(d[k],'value')));
  return Object.fromEntries(fields.map(k => [k,d[k].value]));
}
const positive = n => Number.isSafeInteger(n) && n > 0;
const cents = n => Number.isSafeInteger(n) && n >= 0;
function acceptedOffer(value) {
  const o = object(value,FIELDS), r = object(o.renewal,['default_auto_renew','commitment_months','retain_accepted_pricing','reminder_days','non_renewal_cutoff','ends_installments_early']);
  const role = object(o.first_role_prepay,['selected','amount_cents','normal_role_fee_cents','credit_type','expires','non_refundable']);
  const recurrence = object(o.stripe_recurrence,['interval','interval_count']);
  check(o.schema_version === 2 && typeof o.offer_version === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(o.offer_version)
    && ['basic','pro'].includes(o.plan_key) && typeof o.display_name === 'string' && o.display_name.length > 0 && o.display_name.length <= 100
    && [3,6,12].includes(o.commitment_months) && ['prepaid','monthly_installments'].includes(o.payment_option)
    && o.offer_key === `${o.plan_key}-${o.commitment_months}-${o.payment_option}` && o.currency === 'usd'
    && o.term_start_basis === 'first_payment_success' && o.contract_timezone === 'UTC');
  const count = o.payment_option === 'prepaid' ? 1 : o.commitment_months;
  check(positive(o.platform_payment_cents) && positive(o.platform_commitment_total_cents)
    && o.platform_commitment_total_cents === o.platform_payment_cents * count && o.installment_count === count
    && recurrence.interval === 'month' && recurrence.interval_count === (count === 1 ? o.commitment_months : 1)
    && typeof role.selected === 'boolean' && cents(role.amount_cents) && (role.selected ? role.amount_cents > 0 : role.amount_cents === 0)
    && role.credit_type === 'first_role_prepay' && role.expires === false && role.non_refundable === true
    && positive(o.per_role_fee_cents) && role.normal_role_fee_cents === o.per_role_fee_cents
    && (!role.selected || role.amount_cents < role.normal_role_fee_cents)
    && cents(o.initial_payment_cents) && o.initial_payment_cents === o.platform_payment_cents + role.amount_cents
    && cents(o.additional_interview_fee_cents) && positive(o.included_interviews_per_role)
    && positive(o.max_interview_minutes) && o.max_interview_minutes < 60 && positive(o.scored_question_count) && o.scored_question_count <= 7
    && ((o.billing_model === 'fixed' && o.rollover_days === null) || (o.billing_model === 'rollover' && positive(o.rollover_days) && o.rollover_days <= 3650))
    && r.default_auto_renew === true && r.retain_accepted_pricing === true && r.commitment_months === o.commitment_months
    && r.reminder_days === 30 && r.non_renewal_cutoff === 'before_term_end' && r.ends_installments_early === false);
  return { ...o, stripe_recurrence:recurrence, first_role_prepay:role, renewal:r };
}
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function packageFromOffer(o) {
  const billing = o.payment_option === 'prepaid' ? 'prepaid' : 'monthly';
  const role = o.first_role_prepay;
  return freeze({ pricing_protocol:PROTOCOL, pricing_version:o.offer_version, membership_terms:o,
    plan_key:o.plan_key, display_name:o.display_name, platform_fee:o.platform_payment_cents / 100,
    platform_fee_cents:o.platform_payment_cents, platform_fee_billing_cadence:billing,
    billing_cadence:billing, billing_cadence_display_name:o.payment_option === 'prepaid'
      ? `${o.commitment_months}-month prepaid` : `Monthly payments; ${o.commitment_months}-month commitment`,
    commitment_months:o.commitment_months, payment_option:o.payment_option,
    platform_commitment_total_cents:o.platform_commitment_total_cents,
    included_interviews:o.included_interviews_per_role, included_interviews_per_role:o.included_interviews_per_role,
    interview_duration_minutes:o.max_interview_minutes, max_interview_minutes:o.max_interview_minutes,
    scored_question_count:o.scored_question_count, additional_interview_price:o.additional_interview_fee_cents / 100,
    additional_interview_fee:o.additional_interview_fee_cents / 100, overage_price:o.additional_interview_fee_cents / 100,
    per_role_fee:o.per_role_fee_cents / 100, first_role_prepay:{ enabled:true, selected:role.selected,
      credit_type:role.credit_type, normal_role_fee_cents:role.normal_role_fee_cents,
      discounted_credit_amount_cents:role.amount_cents, discount_percent:10, non_refundable:true, expires:false } });
}
function buildRetailPackageSnapshot(selection) { return packageFromOffer(acceptedOffer(buildRetailOffer(selection))); }
function readRetailPackageOffer(snapshot) {
  // Legacy package snapshots continue unchanged. A present v2 discriminator
  // must never silently fall back to legacy prices or an annual term.
  if (snapshot == null) return null;
  check(typeof snapshot === 'object' && !isProxy(snapshot) && [Object.prototype,null].includes(Object.getPrototypeOf(snapshot)));
  const d = Object.getOwnPropertyDescriptors(snapshot);
  check(Reflect.ownKeys(d).every(k => typeof k === 'string' && d[k].enumerable && Object.hasOwn(d[k],'value')));
  if (!Object.hasOwn(d,'pricing_protocol') && !Object.hasOwn(d,'membership_terms') && !Object.hasOwn(d,'pricing_version')) return null;
  check(d.pricing_protocol?.value === PROTOCOL);
  const o = acceptedOffer(d.membership_terms?.value), expected = packageFromOffer(o);
  const actual = object(snapshot,Object.keys(expected));
  for (const k of Object.keys(expected)) {
    if (k === 'membership_terms') continue;
    if (k === 'first_role_prepay') {
      const role = object(actual[k],Object.keys(expected[k]));
      check(Object.keys(role).every(key => role[key] === expected[k][key]));
    } else check(actual[k] === expected[k]);
  }
  // Validate accepted arithmetic, NOT today's catalog price or offer version.
  return freeze(structuredClone(o));
}
module.exports = { buildRetailPackageSnapshot, readRetailPackageOffer };
