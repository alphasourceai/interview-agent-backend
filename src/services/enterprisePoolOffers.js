'use strict';

// Prospective v2 pool arithmetic only. Legacy signed quotes retain
// enterprisePoolPricing's accepted net rounding and discounts. No route uses
// this module yet. An eventual caller must authorize overrides/coupons on the
// server; browser-supplied discounts are never authority for a quote.
const POOL_OFFER_VERSION = 'enterprise-pool-v2-2026-10-11';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  error.status = 400;
  throw error;
}

function whole(value, name, min = 0) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) fail(`invalid_${name}`);
  return BigInt(value);
}

function bandPercent(quantity) {
  if (quantity >= 50) return 10;
  if (quantity >= 30) return 7;
  if (quantity >= 20) return 5;
  return 0;
}

function quoteEnterprisePoolOffer({ quantity, acceptedUnitPriceCents, authorizedAutomaticPercent, authorizedCouponCents = 0 } = {}) {
  const count = whole(quantity, 'pool_quantity', 1);
  const unit = whole(acceptedUnitPriceCents, 'pool_unit_price', 1);
  const coupon = whole(authorizedCouponCents, 'pool_coupon');
  const automaticPercent = authorizedAutomaticPercent === undefined ? bandPercent(quantity) : authorizedAutomaticPercent;
  const percent = whole(automaticPercent, 'pool_automatic_percent');
  if (percent > 10n) fail('invalid_pool_automatic_percent');
  const gross = count * unit;
  if (gross > BigInt(Number.MAX_SAFE_INTEGER)) fail('pool_amount_out_of_range');
  // Half-up on discount, not on net: these differ at half-cent ties.
  const automaticDiscount = (gross * percent + 50n) / 100n;
  const net = gross - automaticDiscount - coupon;
  if (net < 0n) fail('pool_reductions_exceed_gross');
  return Object.freeze({
    offer_version: POOL_OFFER_VERSION,
    currency: 'usd',
    quantity,
    unit_price_cents: acceptedUnitPriceCents,
    gross_cents: Number(gross),
    automatic_discount_percent: automaticPercent,
    automatic_discount_cents: Number(automaticDiscount),
    coupon_cents: Number(coupon),
    net_cents: Number(net),
  });
}

module.exports = { POOL_OFFER_VERSION, quoteEnterprisePoolOffer };
