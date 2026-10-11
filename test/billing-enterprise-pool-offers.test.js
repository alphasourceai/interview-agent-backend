'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { quoteEnterprisePoolOffer } = require('../src/services/enterprisePoolOffers');

for (const [quantity, percent, discount, net] of [
  [19, 0, 0, 47500], [20, 5, 2500, 47500], [29, 5, 3625, 68875],
  [30, 7, 5250, 69750], [49, 7, 8575, 113925], [50, 10, 12500, 112500],
  [37, 7, 6475, 86025],
]) {
  test(`v2 pool ${quantity}: approved automatic band and exact cents`, () => {
    const quote = quoteEnterprisePoolOffer({ quantity, acceptedUnitPriceCents: 2500 });
    assert.equal(quote.automatic_discount_percent, percent);
    assert.equal(quote.automatic_discount_cents, discount);
    assert.equal(quote.net_cents, net);
    assert.equal(quote.gross_cents, quantity * 2500);
    assert.equal(quote.currency, 'usd');
  });
}
test('half-cent tie rounds discount half-up, not legacy net rounding', () => {
  const quote = quoteEnterprisePoolOffer({ quantity: 1, acceptedUnitPriceCents: 10005, authorizedAutomaticPercent: 10 });
  assert.equal(quote.automatic_discount_cents, 1001);
  assert.equal(quote.net_cents, 9004);
  const { quoteEnterprisePool } = require('../src/services/enterprisePoolPricing');
  assert.equal(quoteEnterprisePool({ quantity: 1, unitPriceCents: 10005, discountPct: 10 }).total_cents, 9005);
});
test('approved seven-percent rounding fixture', () => {
  const quote = quoteEnterprisePoolOffer({ quantity: 1, acceptedUnitPriceCents: 66660, authorizedAutomaticPercent: 7 });
  assert.equal(quote.automatic_discount_cents, 4666);
  assert.equal(quote.net_cents, 61994);
});
test('separate authorized coupon cents and explicit automatic override are snapshotted', () => {
  const quote = quoteEnterprisePoolOffer({ quantity: 50, acceptedUnitPriceCents: 2500,
    authorizedAutomaticPercent: 0, authorizedCouponCents: 20000 });
  assert.equal(quote.automatic_discount_percent, 0);
  assert.equal(quote.automatic_discount_cents, 0);
  assert.equal(quote.coupon_cents, 20000);
  assert.equal(quote.net_cents, 105000);
  assert.throws(() => { quote.net_cents = 1; }, TypeError);
});
test('rejects unsafe money, fractional/negative/zero inputs and excessive discounts', () => {
  const base = { quantity: 20, acceptedUnitPriceCents: 2500 };
  for (const changes of [{ quantity: 0 }, { quantity: -1 }, { quantity: 2.5 }, { quantity: true },
    { quantity: '20' }, { acceptedUnitPriceCents: 0 }, { acceptedUnitPriceCents: 25.5 },
    { acceptedUnitPriceCents: Number.MAX_SAFE_INTEGER + 1 }, { authorizedAutomaticPercent: 11 },
    { authorizedAutomaticPercent: 7.5 }, { authorizedAutomaticPercent: null },
    { authorizedCouponCents: -1 }, { authorizedCouponCents: 50001 }]) {
    assert.throws(() => quoteEnterprisePoolOffer({ ...base, ...changes }));
  }
  assert.throws(() => quoteEnterprisePoolOffer({ quantity: 2, acceptedUnitPriceCents: Number.MAX_SAFE_INTEGER }), { code: 'pool_amount_out_of_range' });
});
test('legacy signed pool discounts above ten percent remain unchanged', () => {
  const { quoteEnterprisePool } = require('../src/services/enterprisePoolPricing');
  assert.equal(quoteEnterprisePool({ quantity: 30, unitPriceCents: 2500, discountPct: 15 }).total_cents, 63750);
});
