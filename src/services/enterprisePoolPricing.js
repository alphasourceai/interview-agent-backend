'use strict';

// Volume pricing for the Enterprise interview pool.
//
// An Enterprise client buys a pool of interviews at signup, priced from the same
// number it pays for overage afterwards — `usage_interview_fee_cents`. There is
// one price, not two. The larger the pool, the larger the discount, from
// thresholds stored in public.enterprise_pool_discounts so they can be changed
// without a deploy.
//
// Rounding: the discount is applied to the whole order and the TOTAL is rounded
// to whole cents. The per-unit figure this returns is informational and may not
// multiply back to the total exactly. Callers charging this must use
// `total_cents` — see the note on discounted_unit_price_cents below.

const DISCOUNT_TABLE = 'enterprise_pool_discounts';

function parsePositiveInteger(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseNonNegativeInteger(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

// discount_pct is numeric(5,2), which PostgREST may hand back as a string.
function parsePercent(value) {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return parsed;
}

/**
 * The best threshold for a quantity: the highest min_quantity at or below it.
 * No matching row — including an empty table — means no discount.
 */
async function resolvePoolDiscount({ db, quantity } = {}) {
  const { data, error } = await db
    .from(DISCOUNT_TABLE)
    .select('min_quantity,discount_pct')
    .lte('min_quantity', quantity)
    .order('min_quantity', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message || 'Enterprise pool discount lookup failed');
  if (!data) return { discount_pct: 0, threshold_min: null };

  const percent = parsePercent(data.discount_pct);
  const thresholdMin = parsePositiveInteger(data.min_quantity);
  // A threshold row that cannot be read as a percentage is treated as no
  // discount rather than guessed at: undercharging silently is worse than
  // charging list price and being told about it.
  if (percent == null) {
    console.warn('enterprise_pool_discount_unreadable', {
      min_quantity: data.min_quantity ?? null,
      discount_pct: data.discount_pct ?? null
    });
    return { discount_pct: 0, threshold_min: thresholdMin };
  }
  return { discount_pct: percent, threshold_min: thresholdMin };
}

/**
 * Prices a pool purchase.
 *
 * @returns {{
 *   quantity: number,
 *   unit_price_cents: number,
 *   discount_pct: number,
 *   discounted_unit_price_cents: number,
 *   total_cents: number,
 *   threshold_min: number|null
 * }}
 *
 * `total_cents` is authoritative — it is what the client is charged.
 * `discounted_unit_price_cents` is the per-unit price rounded for display, and
 * multiplying it by the quantity can differ from the total by a cent or two.
 * Anything creating a Stripe line item should charge `total_cents` as a single
 * unit amount with quantity 1, not the per-unit figure with quantity N.
 */
async function priceEnterprisePool({ db, quantity, unitPriceCents } = {}) {
  const normalizedQuantity = parsePositiveInteger(quantity);
  if (normalizedQuantity == null) {
    throw new Error('Enterprise pool quantity must be a positive whole number.');
  }
  const normalizedUnitPrice = parseNonNegativeInteger(unitPriceCents);
  if (normalizedUnitPrice == null) {
    throw new Error('Enterprise pool unit price must be a whole number of cents.');
  }
  if (!db || typeof db.from !== 'function') {
    throw new Error('Enterprise pool pricing requires a database.');
  }

  const { discount_pct: discountPct, threshold_min: thresholdMin } =
    await resolvePoolDiscount({ db, quantity: normalizedQuantity });

  return quoteEnterprisePool({
    quantity: normalizedQuantity,
    unitPriceCents: normalizedUnitPrice,
    discountPct,
    thresholdMin
  });
}

/**
 * Prices a pool at a discount already agreed, without the database.
 *
 * An agreement is priced from the bands when it is sent, and that discount is
 * what the client signs. Checkout charges it with this same arithmetic, so the
 * total on the agreement is the total charged even if the bands change between
 * the two.
 */
function quoteEnterprisePool({ quantity, unitPriceCents, discountPct, thresholdMin = null } = {}) {
  const normalizedQuantity = parsePositiveInteger(quantity);
  if (normalizedQuantity == null) {
    throw new Error('Enterprise pool quantity must be a positive whole number.');
  }
  const normalizedUnitPrice = parseNonNegativeInteger(unitPriceCents);
  if (normalizedUnitPrice == null) {
    throw new Error('Enterprise pool unit price must be a whole number of cents.');
  }
  const normalizedDiscount = parsePercent(discountPct);
  if (normalizedDiscount == null) {
    throw new Error('Enterprise pool discount must be a percentage from 0 to 100.');
  }

  const grossCents = normalizedQuantity * normalizedUnitPrice;
  return {
    quantity: normalizedQuantity,
    unit_price_cents: normalizedUnitPrice,
    discount_pct: normalizedDiscount,
    discounted_unit_price_cents: Math.round((normalizedUnitPrice * (100 - normalizedDiscount)) / 100),
    total_cents: Math.round((grossCents * (100 - normalizedDiscount)) / 100),
    threshold_min: thresholdMin
  };
}

module.exports = {
  DISCOUNT_TABLE,
  priceEnterprisePool,
  quoteEnterprisePool,
  resolvePoolDiscount
};
