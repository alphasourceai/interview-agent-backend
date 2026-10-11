'use strict';

// Prospective retail offer foundation. Intentionally not wired into checkout:
// legacy accepted agreements continue through their existing price contracts.
// Quote creation is server-side; only selection keys come from a browser.
const OFFER_VERSION = 'retail-terms-2026-10-11-v1';
const COMMITMENT_MONTHS = Object.freeze([3, 6, 12]);
const PAYMENT_OPTIONS = Object.freeze(['prepaid', 'monthly_installments']);
const CHANNELS = Object.freeze(['public', 'sales', 'admin']);
const RENEWAL_REMINDER_DAYS = 30;
const DAY_MS = 86400000;

function deepFreeze(value) {
  for (const item of Object.values(value)) {
    if (item && typeof item === 'object') deepFreeze(item);
  }
  return Object.freeze(value);
}

const RETAIL_PRICES_CENTS = deepFreeze({
  basic: {
    3: { prepaid: 120000, monthly_installments: 44900 },
    6: { prepaid: 195000, monthly_installments: 39900 },
    12: { prepaid: 330000, monthly_installments: 34900 }
  },
  pro: {
    3: { prepaid: 210000, monthly_installments: 74900 },
    6: { prepaid: 360000, monthly_installments: 69900 },
    12: { prepaid: 650000, monthly_installments: 64900 }
  }
});

// These are part of this offer version, not reads from a mutable future default
// package. A new catalog version must explicitly choose its own complete terms.
const RETAIL_TERMS = deepFreeze({
  basic: {
    display_name: 'Essential', per_role_fee_cents: 39900, additional_interview_fee_cents: 2500,
    first_role_prepay_price_cents: 35900, included_interviews_per_role: 20,
    max_interview_minutes: 10, scored_question_count: 5, billing_model: 'fixed', rollover_days: null
  },
  pro: {
    display_name: 'Pro', per_role_fee_cents: 69900, additional_interview_fee_cents: 3000,
    first_role_prepay_price_cents: 62900, included_interviews_per_role: 30,
    max_interview_minutes: 12, scored_question_count: 6, billing_model: 'rollover', rollover_days: 90
  }
});

function fail(code) {
  const error = new Error(code);
  error.code = code;
  error.status = 400;
  throw error;
}

function whole(value, code) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) fail(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(code);
  return parsed;
}

function normalizeSelection({ planKey, commitmentMonths, paymentOption, channel, offerVersion } = {}) {
  if (!CHANNELS.includes(channel)) fail('invalid_offer_channel');
  if (offerVersion !== OFFER_VERSION) fail('stale_offer_version');
  const normalizedPlan = typeof planKey === 'string' ? planKey.trim().toLowerCase() : '';
  const plan = normalizedPlan === 'essential' ? 'basic' : normalizedPlan;
  if (!Object.hasOwn(RETAIL_TERMS, plan)) fail('invalid_retail_plan');
  const months = whole(commitmentMonths, 'invalid_commitment_months');
  if (!COMMITMENT_MONTHS.includes(months)) fail('invalid_commitment_months');
  if (!PAYMENT_OPTIONS.includes(paymentOption)) fail('invalid_payment_option');
  if (channel === 'public' && paymentOption !== 'prepaid') fail('public_installments_not_available');
  return { plan, months, paymentOption };
}

function buildRetailOffer(input = {}) {
  const { plan, months, paymentOption } = normalizeSelection(input);
  if (input.firstRolePrepaySelected != null && typeof input.firstRolePrepaySelected !== 'boolean') {
    fail('invalid_first_role_selection');
  }
  const pkg = RETAIL_TERMS[plan];
  const installment = paymentOption === 'monthly_installments';
  const platformPayment = RETAIL_PRICES_CENTS[plan][months][paymentOption];
  const firstRole = input.firstRolePrepaySelected === true ? pkg.first_role_prepay_price_cents : 0;
  return deepFreeze({
    schema_version: 2,
    offer_version: OFFER_VERSION,
    offer_key: `${plan}-${months}-${paymentOption}`,
    plan_key: plan,
    display_name: pkg.display_name,
    currency: 'usd',
    commitment_months: months,
    term_start_basis: 'first_payment_success',
    contract_timezone: 'UTC',
    payment_option: paymentOption,
    platform_payment_cents: platformPayment,
    platform_commitment_total_cents: platformPayment * (installment ? months : 1),
    installment_count: installment ? months : 1,
    stripe_recurrence: { interval: 'month', interval_count: installment ? 1 : months },
    initial_payment_cents: platformPayment + firstRole,
    per_role_fee_cents: pkg.per_role_fee_cents,
    additional_interview_fee_cents: pkg.additional_interview_fee_cents,
    included_interviews_per_role: pkg.included_interviews_per_role,
    max_interview_minutes: pkg.max_interview_minutes,
    scored_question_count: pkg.scored_question_count,
    billing_model: pkg.billing_model,
    rollover_days: pkg.rollover_days,
    first_role_prepay: {
      selected: input.firstRolePrepaySelected === true,
      amount_cents: firstRole,
      normal_role_fee_cents: pkg.per_role_fee_cents,
      credit_type: 'first_role_prepay',
      expires: false,
      non_refundable: true
    },
    renewal: {
      default_auto_renew: true,
      commitment_months: months,
      retain_accepted_pricing: true,
      reminder_days: RENEWAL_REMINDER_DAYS,
      non_renewal_cutoff: 'before_term_end',
      ends_installments_early: false
    }
  });
}

function listRetailOffers({ channel } = {}) {
  if (!CHANNELS.includes(channel)) fail('invalid_offer_channel');
  const options = channel === 'public' ? ['prepaid'] : PAYMENT_OPTIONS;
  return Object.keys(RETAIL_PRICES_CENTS).flatMap(planKey => COMMITMENT_MONTHS.flatMap(commitmentMonths =>
    options.map(paymentOption => buildRetailOffer({ planKey, commitmentMonths, paymentOption, channel, offerVersion: OFFER_VERSION }))
  ));
}

// Strict UTC instant parsing: rejects date-only strings and local timezone
// guesses. The activation boundary must supply the actual accepted start.
function instant(value, code) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) fail(code);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail(code);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (date.toISOString() !== canonical) fail(code);
  return date;
}

// Always derive from the original calendar anchor, never a previously clamped
// February date. Jan31 + 1 month -> Feb28; Jan31 + 2 months -> Mar31.
function anchoredMonthInstant(originalStart, offsetMonths) {
  const start = instant(originalStart, 'invalid_original_start');
  const offset = whole(offsetMonths, 'invalid_month_offset');
  if (offset > 12000) fail('invalid_month_offset');
  const totalMonth = start.getUTCMonth() + offset;
  const year = start.getUTCFullYear() + Math.floor(totalMonth / 12);
  if (year > 9999) fail('invalid_month_offset');
  const month = totalMonth % 12;
  const lastDayDate = new Date(start);
  lastDayDate.setUTCFullYear(year, month + 1, 0);
  const result = new Date(start);
  result.setUTCDate(1);
  result.setUTCFullYear(year, month, Math.min(start.getUTCDate(), lastDayDate.getUTCDate()));
  return result.toISOString();
}

function retailTermWindow({ originalStart, commitmentMonths, termIndex = 0 } = {}) {
  const months = whole(commitmentMonths, 'invalid_commitment_months');
  if (!COMMITMENT_MONTHS.includes(months)) fail('invalid_commitment_months');
  const index = whole(termIndex, 'invalid_term_index');
  if ((index + 1) * months > 12000) fail('invalid_term_index');
  const termStart = anchoredMonthInstant(originalStart, index * months);
  const termEnd = anchoredMonthInstant(originalStart, (index + 1) * months);
  return {
    original_start_at: originalStart,
    term_index: index,
    term_start_at: termStart,
    term_end_at: termEnd,
    renewal_reminder_at: new Date(Date.parse(termEnd) - RENEWAL_REMINDER_DAYS * DAY_MS).toISOString()
  };
}

function assertRenewalPreferenceChange({ autoRenew, requestedAt, termStart, termEnd } = {}) {
  if (typeof autoRenew !== 'boolean') fail('invalid_auto_renew');
  const requested = instant(requestedAt, 'invalid_request_instant').getTime();
  const start = instant(termStart, 'invalid_term_start').getTime();
  const end = instant(termEnd, 'invalid_term_end').getTime();
  if (start >= end) fail('invalid_term_window');
  if (requested < start || requested >= end) fail('term_not_mutable');
  return { auto_renew: autoRenew, requested_at: requestedAt, effective_at: termEnd };
}

module.exports = {
  OFFER_VERSION, COMMITMENT_MONTHS, PAYMENT_OPTIONS, RENEWAL_REMINDER_DAYS,
  RETAIL_PRICES_CENTS, buildRetailOffer, listRetailOffers, anchoredMonthInstant,
  retailTermWindow, assertRenewalPreferenceChange
};
