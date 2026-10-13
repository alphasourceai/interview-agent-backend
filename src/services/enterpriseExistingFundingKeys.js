'use strict';
// Shared closed financial projection; no runtime/SDK/native effects.
module.exports = Object.freeze([
  'pool_id', 'client_id', 'provider_account_id', 'livemode', 'currency', 'offer_version', 'offer_digest', 'customer_id',
  'checkout_session_id', 'subscription_id', 'invoice_id', 'pool_line_id', 'payment_intent_id', 'charge_id',
  'platform_item_id', 'platform_price_id', 'pool_price_id', 'platform_interval', 'platform_nominal_cents',
  'payment_success_at', 'quantity', 'pool_paid_cents', 'pool_tax_cents', 'platform_line_cents', 'tax_cents',
  'collected_cents', 'credits_spendable', 'membership_activation_required', 'native_receipt_required'
]);
