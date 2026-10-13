'use strict';

// Selection adapter for the current quote paths, not a second checkout system.
const { OFFER_VERSION, listRetailOffers, buildRetailOffer, RETAIL_PRICES_CENTS } = require('./membershipOffers');
const { buildRetailPackageSnapshot, readRetailPackageOffer } = require('./membershipPackageCompatibility');
const RETAIL_TEMPLATE = 'membership_agreement_retail_terms_v2';
const enabled = (env = process.env) => env.MEMBERSHIP_PRICING_TERMS_ENABLED === 'true';
function fail(code, status = 400) { const e = new Error(code); e.code = code; e.status = status; throw e; }
function field(body, names, normalize = v => v) {
  const values = names.filter(k => Object.hasOwn(body, k)).map(k => normalize(body[k]));
  if (values.some(v => v !== values[0])) fail('conflicting_pricing_selection');
  return values[0];
}
function normalizeRetailQuoteSelection(body = {}, { channel, env = process.env, savedPackageSnapshot } = {}) {
  if (savedPackageSnapshot !== undefined) {
    const offer = readRetailPackageOffer(savedPackageSnapshot);
    const comparisons = [
      [field(body,['commitment_months','commitmentMonths'],v=>typeof v==='string'&&/^\d+$/.test(v)?Number(v):v),offer?.commitment_months],
      [field(body,['payment_option','paymentOption']),offer?.payment_option],
      [field(body,['offer_version','offerVersion','pricing_version','pricingVersion']),offer?.offer_version]
    ];
    if (comparisons.some(([actual,expected])=>actual!==undefined && actual!==expected)) fail('conflicting_pricing_selection');
    const cadence=field(body,['billing_cadence','billing_interval','selected_billing_cadence','billing_option','billingOption'],v=>String(v||'').trim().toLowerCase());
    if(offer && cadence!==undefined && cadence!==savedPackageSnapshot.billing_cadence) fail('conflicting_pricing_selection');
    return offer ? { commitment_months: offer.commitment_months, payment_option: offer.payment_option,
      offer_version: offer.offer_version, billing_cadence: savedPackageSnapshot.billing_cadence } : null;
  }
  const months = field(body, ['commitment_months', 'commitmentMonths'], v => typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
  const payment = field(body, ['payment_option', 'paymentOption']);
  const version = field(body, ['offer_version', 'offerVersion', 'pricing_version', 'pricingVersion']);
  const supplied = months !== undefined || payment !== undefined || version !== undefined;
  if (!enabled(env)) { if (supplied) fail('retail_pricing_not_enabled', 409); return null; }
  const plan = field(body, ['plan_key', 'plan', 'selected_plan_key', 'membership_tier', 'membershipTier'],
    v => String(v || '').trim().toLowerCase() === 'essential' ? 'basic' : String(v || '').trim().toLowerCase());
  // Only server selection keys determine a NEW offer. Never accept raw prices.
  const pkg = buildRetailPackageSnapshot({ planKey: plan, commitmentMonths: months,
    paymentOption: payment, offerVersion: version, channel });
  const cadence = field(body, ['billing_cadence', 'billing_interval', 'selected_billing_cadence', 'billing_option', 'billingOption'],
    v => String(v || '').trim().toLowerCase());
  if (cadence !== undefined && cadence !== pkg.billing_cadence) fail('conflicting_pricing_selection');
  return { commitment_months: pkg.commitment_months, payment_option: pkg.payment_option,
    offer_version: pkg.pricing_version, billing_cadence: pkg.billing_cadence };
}
function quotePackageOptions(selection, channel, firstRolePrepaySelected) {
  return { firstRolePrepaySelected, ...(selection ? { commitmentMonths: selection.commitment_months,
    paymentOption: selection.payment_option, offerVersion: selection.offer_version, channel } : {}) };
}
function retailAgreementTerms(pkg) {
  const offer = readRetailPackageOffer(pkg);
  return offer ? { commitment_months: offer.commitment_months, payment_option: offer.payment_option,
    pricing_version: offer.offer_version, term_start_basis: 'successful_payment',
    billing_option: pkg.billing_cadence, initial_term_start: null, initial_renewal_date: null,
    scored_question_count: offer.scored_question_count, billing_model: offer.billing_model,
    rollover_days: offer.rollover_days, auto_renew: true, notice_deadline_days: offer.renewal.reminder_days } : null;
}
function validateRetailIntentSource(intent) {
  const offer = readRetailPackageOffer(intent?.package_snapshot);
  if (!offer) return null;
  const pkg = intent.package_snapshot;
  const role = pkg.first_role_prepay;
  if (intent.protocol !== 'fenced_v2' || intent.selected_plan_key !== offer.plan_key
    || intent.selected_billing_cadence !== pkg.billing_cadence
    || intent.first_role_prepay_selected !== role.selected) fail('retail_quote_source_mismatch', 409);
  const expected = role.selected ? [role.discounted_credit_amount_cents, role.normal_role_fee_cents, role.discount_percent, role.credit_type]
    : [null, null, null, null];
  const actual = [intent.first_role_prepay_amount_cents, intent.first_role_normal_role_fee_cents,
    intent.first_role_prepay_discount_percent, intent.first_role_prepay_credit_type];
  if (actual.some((v, i) => v !== expected[i])) fail('retail_quote_source_mismatch', 409);
  return offer;
}
function retailQuoteCatalog(channel, env = process.env) {
  if (!enabled(env)) return null;
  return { pricing_version: OFFER_VERSION, offers: listRetailOffers({ channel }),
    // Display-only comparison, not an authorized public installment offer.
    // Keep checkout authority in the six public PREPAID selection keys.
    ...(channel === 'public' ? { monthly_payment_references: Object.fromEntries(
      ['basic','pro'].map(plan => [plan, Object.fromEntries([3,6,12].map(months =>
        [months, RETAIL_PRICES_CENTS[plan][months].monthly_installments]))])) } : {}),
    first_role_prepay_prices: Object.fromEntries(['basic','pro'].map(planKey => [planKey,
      buildRetailOffer({planKey,channel,commitmentMonths:3,paymentOption:'prepaid',offerVersion:OFFER_VERSION,
        firstRolePrepaySelected:true}).first_role_prepay.amount_cents])) };
}
function validateRetailAgreementSource(agreement, intent) {
  const snapshot = agreement?.template_snapshot;
  const offer = readRetailPackageOffer(snapshot?.package_snapshot);
  if (!offer && agreement?.template_version !== RETAIL_TEMPLATE && snapshot?.template_version !== RETAIL_TEMPLATE
    && agreement?.billing_option !== 'prepaid') return null;
  if (!offer || agreement.template_version !== RETAIL_TEMPLATE || snapshot.template_version !== RETAIL_TEMPLATE
    || !snapshot.values || agreement.membership_tier !== offer.plan_key
    || agreement.billing_option !== snapshot.package_snapshot.billing_cadence
    || agreement.auto_renew !== true || agreement.notice_deadline_days !== offer.renewal.reminder_days) {
    fail('retail_agreement_terms_mismatch', 409);
  }
  // The existing renderer owns own-field/alias arithmetic correspondence.
  require('../render/membershipAgreement').normalizeMembershipAgreementInput(snapshot.values,
    { packageSnapshot: snapshot.package_snapshot });
  if (intent !== undefined) {
    const intentOffer = validateRetailIntentSource(intent);
    if (!intentOffer || JSON.stringify(intentOffer) !== JSON.stringify(offer)
      || intent.agreement_id !== agreement.id) fail('retail_quote_source_mismatch', 409);
  }
  return offer;
}
module.exports = { RETAIL_TEMPLATE, enabled, normalizeRetailQuoteSelection, quotePackageOptions,
  retailAgreementTerms, validateRetailIntentSource, validateRetailAgreementSource, retailQuoteCatalog };
