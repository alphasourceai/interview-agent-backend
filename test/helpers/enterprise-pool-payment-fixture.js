'use strict';

// Entirely synthetic pinned-API shape, NOT Stripe Sandbox acceptance.
const { prepareEnterprisePoolTerms } = require('../../src/services/enterprisePoolSnapshot');
module.exports = function fixture({ platformAmount = 7000, tax = 0, poolTax = 0,
  quantity = 30, unit = 2500, proration = true } = {}) {
  const terms = prepareEnterprisePoolTerms({ membership_tier: 'enterprise', billing_model: 'usage',
    pool_quantity: quantity, usage_interview_fee_cents: unit });
  const net = terms.pool_offer_snapshot.net_cents;
  const created = 1798761600, paidAt = created + 3600;
  const common = { created, livemode: false, customer: 'cus_synthetic' };
  const nativePrice = (id, amount, recurring) => ({ object: 'price', id, created,
    livemode: false, currency: 'usd', billing_scheme: 'per_unit',
    unit_amount: amount, unit_amount_decimal: String(amount), custom_unit_amount: null,
    transform_quantity: null, tiers_mode: null, type: recurring ? 'recurring' : 'one_time',
    recurring: recurring ? { interval: 'month', interval_count: 1, usage_type: 'licensed' } : null });
  const platformPrice = nativePrice('price_platform', 10000, true);
  const poolPrice = nativePrice('price_pool', net, false);
  const taxes = amount => amount ? [{ amount, inclusive: false, tax_rate: 'txr_synthetic' }] : [];
  const invoiceLines = [
    { id: 'il_platform', object: 'line_item', livemode: false, invoice: 'in_initial',
      type: 'subscription', subscription: 'sub_synthetic', discounts: [],
      subscription_item: 'si_platform', price: platformPrice, quantity: 1, currency: 'usd',
      amount: platformAmount, proration, discount_amounts: [], tax_amounts: taxes(tax) },
    { id: 'il_pool', object: 'line_item', livemode: false, invoice: 'in_initial',
      type: 'invoiceitem', subscription: null, subscription_item: null, discounts: [],
      price: poolPrice, quantity: 1, currency: 'usd', amount: net,
      proration: false, discount_amounts: [], tax_amounts: taxes(poolTax) }
  ];
  const checkoutLines = invoiceLines.map((line, index) => ({ id: index ? 'li_pool' : 'li_platform',
    object: 'item', price: line.price, quantity: 1, currency: 'usd', amount_discount: 0,
    amount_subtotal: line.amount, amount_tax: index ? poolTax : tax,
    amount_total: line.amount + (index ? poolTax : tax), discounts: [] }));
  const subtotal = net + platformAmount, totalTax = tax + poolTax, amount = subtotal + totalTax;
  return {
    binding: { poolId: '10000000-0000-0000-0000-000000000001',
      clientId: '20000000-0000-0000-0000-000000000001',
      snapshot: terms.pool_offer_snapshot, digest: terms.pool_offer_digest,
      providerAccountId: 'acct_synthetic', livemode: false, customerId: 'cus_synthetic',
      checkoutSessionId: 'cs_synthetic', subscriptionId: 'sub_synthetic',
      platformPriceId: 'price_platform', platformItemId: 'si_platform',
      platformMonthlyCents: 10000, poolPriceId: 'price_pool' },
    account: { object: 'account', id: 'acct_synthetic' },
    checkout: { ...common, object: 'checkout.session', id: 'cs_synthetic', mode: 'subscription',
      subscription: 'sub_synthetic', invoice: 'in_initial', payment_intent: null, currency: 'usd',
      status: 'complete', payment_status: 'paid', amount_subtotal: subtotal,
      amount_total: amount, total_details: { amount_tax: totalTax, amount_discount: 0, amount_shipping: 0 } },
    checkoutLines: { object: 'list', has_more: false, data: checkoutLines },
    subscription: { ...common, object: 'subscription', id: 'sub_synthetic', currency: 'usd', status: 'active',
      discount: null, discounts: [],
      items: { object: 'list', has_more: false, data: [{ id: 'si_platform', subscription: 'sub_synthetic',
        quantity: 1, price: platformPrice, discounts: [] }] } },
    invoice: { ...common, object: 'invoice', id: 'in_initial', subscription: 'sub_synthetic',
      payment_intent: 'pi_initial', charge: 'ch_initial', currency: 'usd',
      billing_reason: 'subscription_create', status: 'paid', paid: true, paid_out_of_band: false,
      collection_method: 'charge_automatically', amount_due: amount, amount_paid: amount,
      amount_remaining: 0, starting_balance: 0, ending_balance: 0,
      pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0,
      discounts: [], total_discount_amounts: [], total_tax_amounts: taxes(totalTax),
      subtotal, total: amount, tax: totalTax, status_transitions: { paid_at: paidAt },
      lines: { object: 'list', has_more: false, data: invoiceLines, total_count: 2 } },
    paymentIntent: { ...common, object: 'payment_intent', id: 'pi_initial', invoice: 'in_initial',
      latest_charge: 'ch_initial', currency: 'usd', status: 'succeeded', amount, amount_received: amount },
    charge: { ...common, object: 'charge', id: 'ch_initial', invoice: 'in_initial', payment_intent: 'pi_initial',
      currency: 'usd', status: 'succeeded', paid: true, captured: true, amount, amount_captured: amount,
      amount_refunded: 0, refunded: false, disputed: false, dispute: null,
      refunds: { object: 'list', has_more: false, data: [] } },
    observedAt: paidAt + 86400
  };
};
