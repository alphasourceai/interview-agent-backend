'use strict';

// Read-only projection of the accepted agreement. No catalog repricing or
// inference about receipts, remaining payments, or funded access periods.
const { loadExistingRetailSubscriptionTerms } = require('./contracts/subscriptionPricingTerms');
const { STRIPE_RECURRING_OFFER_VERSION } = require('./membershipOffers');
const { readExistingRetailRenewalSummary } = require('./existingRetailRenewalPreference');

async function readClientRetailBillingSummary({ db, client }) {
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
    auto_renew: context.client.auto_renew,
    ...(offer.offer_version === STRIPE_RECURRING_OFFER_VERSION
      ? await readExistingRetailRenewalSummary({ db, agreementId: context.agreementId, clientId: client.id }) : {})
  };
}

module.exports = { readClientRetailBillingSummary };
