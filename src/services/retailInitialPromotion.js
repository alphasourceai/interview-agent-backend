'use strict';

// Read-only eligibility for the EXISTING API2023 Checkout path. This is not a
// receipt, paid clock or activation proof. Actual webhook funding still rules.
function refuse(code = 'retail_checkout_promotion_unverified', status = 409) {
  const error = new Error(code);error.code = code;error.status = status;throw error;
}
const check = (ok, code) => { if (!ok) refuse(code); };
const cents = value => Number.isSafeInteger(value) && value >= 0;
const future = (value, now) => value === null || Number.isSafeInteger(value) && value > now;
function initialAmounts(offer) {
  check(cents(offer?.platform_payment_cents) && offer.platform_payment_cents > 0
    && typeof offer.first_role_prepay?.selected === 'boolean');
  const lines = [offer.platform_payment_cents];
  if (offer.first_role_prepay.selected) {
    check(cents(offer.first_role_prepay.amount_cents) && offer.first_role_prepay.amount_cents > 0);
    lines.push(offer.first_role_prepay.amount_cents);
  }
  const total = lines.reduce((sum, value) => sum + value, 0);
  check(cents(total) && total === offer.initial_payment_cents);
  return {lines, total};
}
function verifyInitialPromotion(promotion, {promotionId, offer, nowEpoch = Math.floor(Date.now()/1000)} = {}) {
  const {lines, total} = initialAmounts(offer);
  check(offer.payment_option === 'monthly_installments' && /^promo_[A-Za-z0-9_]+$/.test(promotionId || '')
    && Number.isSafeInteger(nowEpoch) && nowEpoch > 0);
  check(promotion?.object === 'promotion_code' && promotion.id === promotionId && promotion.active === true
    && typeof promotion.livemode === 'boolean' && !Object.hasOwn(promotion, 'promotion')
    && future(promotion.expires_at, nowEpoch));
  // Customer-specific/history-restricted promos need a separate proven owner
  // eligibility flow. Do not let a read-only safety floor invent that proof.
  check(promotion.customer === null && promotion.restrictions
    && promotion.restrictions.first_time_transaction === false);
  const restriction = promotion.restrictions;
  check(restriction.minimum_amount === null || cents(restriction.minimum_amount)
    && restriction.minimum_amount_currency === 'usd' && restriction.minimum_amount <= total);
  const coupon = promotion.coupon;
  check(coupon?.object === 'coupon' && typeof coupon.id === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(coupon.id)
    && coupon.deleted !== true && coupon.valid === true && coupon.livemode === promotion.livemode
    && ['once','repeating','forever'].includes(coupon.duration) && future(coupon.redeem_by, nowEpoch)
    && (coupon.duration === 'repeating' ? Number.isSafeInteger(coupon.duration_in_months) && coupon.duration_in_months > 0
      : coupon.duration_in_months === null)
    && (coupon.applies_to === undefined || Array.isArray(coupon.applies_to?.products) && coupon.applies_to.products.length === 0)
    && coupon.currency_options == null);
  let upper;
  if (typeof coupon.percent_off === 'number' && coupon.percent_off > 0 && coupon.percent_off < 100
    && coupon.amount_off === null && coupon.currency === null) {
    const text = String(coupon.percent_off);
    check(/^\d{1,2}(?:\.\d{1,2})?$/.test(text));
    const [whole, fraction = ''] = text.split('.');
    const basisPoints = BigInt(whole) * 100n + BigInt(fraction.padEnd(2,'0'));
    upper = lines.reduce((sum, value) => sum + (BigInt(value) * basisPoints + 9999n) / 10000n, 0n);
  } else {
    check(coupon.percent_off === null && cents(coupon.amount_off) && coupon.amount_off > 0 && coupon.currency === 'usd');
    upper = BigInt(coupon.amount_off);
  }
  const floor = BigInt(total) - upper;
  check(floor >= 1n, 'retail_checkout_zero_initial_payment_denied');
  return Object.freeze({promotionId, couponId:coupon.id, livemode:promotion.livemode,
    minimumNetCents:Number(floor), maximumDiscountCents:Number(upper),
    coupon:Object.freeze({percent_off:coupon.percent_off, amount_off:coupon.amount_off, currency:coupon.currency,
      duration:coupon.duration, duration_in_months:coupon.duration_in_months})});
}
async function readInitialPromotion({stripe, promotionId, offer}) {
  if (!promotionId) return null;
  check(/^promo_[A-Za-z0-9_]+$/.test(promotionId));
  let promotion;
  try { promotion = await stripe.promotionCodes.retrieve(promotionId); }
  catch (_) { refuse('retail_checkout_promotion_unavailable',503); }
  return verifyInitialPromotion(promotion,{promotionId,offer});
}
module.exports = {verifyInitialPromotion, readInitialPromotion, initialAmounts};
