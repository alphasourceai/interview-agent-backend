'use strict';

// Read-only projection of the accepted agreement. No catalog repricing or
// inference about receipts, remaining payments, or funded access periods.
const { loadExistingRetailSubscriptionTerms } = require('./contracts/subscriptionPricingTerms');
const { STRIPE_RECURRING_OFFER_VERSION,GENERATION_DATE_OFFER_VERSION } = require('./membershipOffers');
const { readExistingRetailRenewalSummary } = require('./existingRetailRenewalPreference');
const { hasNativeMarker } = require('./existingEnterprisePaymentWebhook');
const { readExistingEnterpriseCheckoutScope } = require('./existingEnterpriseCheckoutFunding');
const { readExistingEnterpriseLegalWindow } = require('./existingEnterpriseLegalWindow');
const { readExistingEnterpriseRenewalSummary } = require('./existingEnterpriseRenewalPreference');

async function readClientRetailBillingSummary({ db, client }) {
  const { data: agreement, error } = await db.from('membership_agreements')
    .select('id,client_id,is_current,enterprise_checkout_source,enterprise_checkout_pool_id,enterprise_checkout_prices,enterprise_funding_receipt,enterprise_billing_receipt')
    .eq('client_id', client.id).eq('is_current', true).maybeSingle();
  if (error) throw new Error('billing_terms_unverified');
  if (hasNativeMarker(agreement)) {
    const n = await readExistingEnterpriseCheckoutScope({ db, agreementId: agreement.id });
    if (!n || !n.billingReceipt || n.client.id !== client.id || n.a.checkout_status !== 'paid') throw new Error('billing_terms_unverified');
    for (const key of ['id','plan_tier','billing_interval','auto_renew','stripe_customer_id','stripe_subscription_id']) {
      if (client[key] !== n.client[key]) throw new Error('billing_terms_changed_during_read');
    }
    const legal = await readExistingEnterpriseLegalWindow({ db, agreement: n.a, billingReceipt: n.billingReceipt });
    const renewal = await readExistingEnterpriseRenewalSummary({ db, agreementId: n.a.id, clientId: client.id });
    if (legal.auto_renew !== n.client.auto_renew
      || (renewal.requested_auto_renew ?? n.billingReceipt.client_initial.auto_renew) !== legal.auto_renew) throw new Error('billing_terms_changed_during_read');
    if (legal.term_end_at !== renewal.stripe_renewal_billing_cutoff_at
      && Date.parse(legal.term_end_at) !== Date.parse(renewal.stripe_renewal_billing_cutoff_at)) throw new Error('billing_terms_changed_during_read');
    return { kind: 'enterprise', currency: 'usd', billing_model: n.billingReceipt.plan_initial.billing_model,
      billing_interval: n.a.billing_option, platform_payment_cents: n.billingReceipt.funding_receipt.proof.platform_nominal_cents,
      current_term_start_at: legal.term_start_at, current_term_end_at: legal.term_end_at,
      term_start_basis: n.a.enterprise_checkout_source.material.template_snapshot.values.term_start_basis,
      auto_renew: legal.auto_renew, ...renewal };
  }
  const context = await loadExistingRetailSubscriptionTerms({ db, clientId: client.id });
  if (!context || context.pending) return null;
  for (const key of ['id', 'plan_tier', 'billing_interval', 'contract_start_at', 'contract_end_at',
    'auto_renew', 'stripe_customer_id', 'stripe_subscription_id']) {
    if (client[key] !== context.client[key]) throw new Error('billing_terms_changed_during_read');
  }
  const { offer } = context;
  return {
    commitment_months: offer.commitment_months,
    payment_option: offer.payment_option,
    currency: offer.currency,
    platform_payment_cents: offer.platform_payment_cents,
    platform_commitment_total_cents: offer.platform_commitment_total_cents,
    installment_count: offer.installment_count,
    current_term_start_at: context.client.contract_start_at,
    current_term_end_at: context.client.contract_end_at,
    term_start_basis: offer.term_start_basis,
    auto_renew: context.client.auto_renew,
    ...([STRIPE_RECURRING_OFFER_VERSION,GENERATION_DATE_OFFER_VERSION].includes(offer.offer_version)
      ? await readExistingRetailRenewalSummary({ db, agreementId: context.agreementId, clientId: client.id }) : {})
  };
}

module.exports = { readClientRetailBillingSummary };
