'use strict';

// The per-client Enterprise settings an admin agreement can state, beyond the
// prices: the billing model, how long rollover credit lasts, how long an
// interview runs and how many questions it scores.
//
// They travel the same road as the Enterprise prices: admin agreement ->
// agreement snapshot -> Stripe checkout metadata -> webhook ->
// client_plan_settings. This module is the one place that decides what a valid
// value is, so the agreement, the checkout and the webhook cannot disagree.
//
// An absent setting means "use the plan default", and is stored as empty.

const { BILLING_MODELS, defaultBillingModelForPlanTier } = require('./billingModel');
const { MAX_INTERVIEW_MINUTES } = require('./interviewDuration');
const { INTERVIEW_TYPE_CONFIG } = require('./interviewTypes');

const ENTERPRISE_PLAN_TIER = 'enterprise';
const USAGE_BILLING_MODEL = 'usage';
const ROLLOVER_BILLING_MODEL = 'rollover';

const ENTERPRISE_SETTING_FIELDS = Object.freeze([
  'billing_model',
  'rollover_days',
  'max_interview_minutes',
  'scored_question_count'
]);

const ROLLOVER_DAYS_MIN = 1;
const ROLLOVER_DAYS_MAX = 365;
// Below five minutes an interview cannot get past the introduction and warm-up.
const INTERVIEW_MINUTES_MIN = 5;
// The provider's call limit less the closing grace (interviewDuration.js).
const INTERVIEW_MINUTES_MAX = MAX_INTERVIEW_MINUTES;
const SCORED_QUESTIONS_MIN = 1;
// A rubric draws one scored question per blueprint entry, so no interview type
// can score more questions than its blueprint has. The smallest blueprint is the
// limit, so the count is valid whatever type a role is given later.
const SCORED_QUESTIONS_MAX = Math.min(
  ...Object.values(INTERVIEW_TYPE_CONFIG).map((config) => config?.blueprint?.length || 0)
);

// Each setting, with the spellings the agreement normaliser already accepts.
const FIELD_ALIASES = Object.freeze({
  billing_model: ['billing_model', 'billingModel'],
  rollover_days: ['rollover_days', 'rolloverDays'],
  max_interview_minutes: ['max_interview_minutes', 'maxInterviewMinutes', 'interview_duration_minutes', 'interviewDurationMinutes'],
  scored_question_count: ['scored_question_count', 'scoredQuestionCount']
});

function isSupplied(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  return true;
}

function pick(input, keys) {
  for (const key of keys) {
    if (isSupplied(input?.[key])) return input[key];
  }
  return undefined;
}

// A whole number written as a number or as digits; anything else is NaN.
function parseWhole(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : NaN;
  if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) return Number(value.trim());
  return NaN;
}

function failure(code, detail, field) {
  return { ok: false, status: 400, code, detail, field };
}

/**
 * Validates the Enterprise settings on an agreement or checkout.
 *
 * `enforcePolicy` adds the commercial rules — a usage model needs a usage price,
 * and a pool is sold only on the usage model. Those are checked when an agreement
 * is sent and when its checkout is created; the webhook checks shape only, so a
 * subscription created before these rules existed is not refused.
 *
 * @returns {{ ok: true, settings: {billing_model, rollover_days, max_interview_minutes,
 *   scored_question_count}, effective_billing_model: string }
 *   | { ok: false, status: 400, code: string, detail: string, field: string }}
 */
function validateEnterpriseSettings(input = {}, { planTier, enforcePolicy = true } = {}) {
  const raw = {};
  for (const field of ENTERPRISE_SETTING_FIELDS) raw[field] = pick(input, FIELD_ALIASES[field]);
  const supplied = ENTERPRISE_SETTING_FIELDS.filter((field) => raw[field] !== undefined);

  if (String(planTier || '').trim().toLowerCase() !== ENTERPRISE_PLAN_TIER) {
    if (supplied.length) {
      return failure(
        'enterprise_settings_not_allowed',
        `${supplied.join(', ')} can only be set on an Enterprise agreement.`,
        supplied[0]
      );
    }
    return {
      ok: true,
      settings: { billing_model: null, rollover_days: null, max_interview_minutes: null, scored_question_count: null },
      effective_billing_model: null
    };
  }

  let billingModel = null;
  if (raw.billing_model !== undefined) {
    billingModel = String(raw.billing_model).trim().toLowerCase();
    if (!BILLING_MODELS.includes(billingModel)) {
      return failure('invalid_billing_model', `billing_model must be one of ${BILLING_MODELS.join(', ')}.`, 'billing_model');
    }
  }
  const effectiveModel = billingModel || defaultBillingModelForPlanTier(ENTERPRISE_PLAN_TIER);

  let rolloverDays = null;
  if (raw.rollover_days !== undefined) {
    rolloverDays = parseWhole(raw.rollover_days);
    if (!(rolloverDays >= ROLLOVER_DAYS_MIN && rolloverDays <= ROLLOVER_DAYS_MAX)) {
      return failure('invalid_rollover_days',
        `rollover_days must be a whole number from ${ROLLOVER_DAYS_MIN} to ${ROLLOVER_DAYS_MAX}.`, 'rollover_days');
    }
    if (effectiveModel !== ROLLOVER_BILLING_MODEL) {
      return failure('rollover_days_requires_rollover_model',
        'rollover_days can only be set with billing_model rollover.', 'rollover_days');
    }
  }

  let maxInterviewMinutes = null;
  if (raw.max_interview_minutes !== undefined) {
    maxInterviewMinutes = parseWhole(raw.max_interview_minutes);
    if (!(maxInterviewMinutes >= INTERVIEW_MINUTES_MIN && maxInterviewMinutes <= INTERVIEW_MINUTES_MAX)) {
      return failure('invalid_max_interview_minutes',
        `max_interview_minutes must be a whole number from ${INTERVIEW_MINUTES_MIN} to ${INTERVIEW_MINUTES_MAX}.`,
        'max_interview_minutes');
    }
  }

  let scoredQuestionCount = null;
  if (raw.scored_question_count !== undefined) {
    scoredQuestionCount = parseWhole(raw.scored_question_count);
    if (!(scoredQuestionCount >= SCORED_QUESTIONS_MIN && scoredQuestionCount <= SCORED_QUESTIONS_MAX)) {
      return failure('invalid_scored_question_count',
        `scored_question_count must be a whole number from ${SCORED_QUESTIONS_MIN} to ${SCORED_QUESTIONS_MAX}.`,
        'scored_question_count');
    }
  }

  // The questions have to fit the time, so one is never set without the other.
  if ((maxInterviewMinutes === null) !== (scoredQuestionCount === null)) {
    return failure('interview_length_and_questions_required_together',
      'max_interview_minutes and scored_question_count must be given together or not at all.',
      maxInterviewMinutes === null ? 'max_interview_minutes' : 'scored_question_count');
  }

  if (enforcePolicy) {
    // Zero is how the agreement form says "no pool".
    const poolRaw = pick(input, ['pool_quantity', 'poolQuantity']);
    const poolSupplied = poolRaw !== undefined && parseWhole(poolRaw) !== 0;
    const usagePriceRaw = pick(input, ['usage_interview_fee_cents', 'usageInterviewFeeCents']);
    const usagePrice = usagePriceRaw === undefined ? NaN : parseWhole(usagePriceRaw);

    if (poolSupplied && effectiveModel !== USAGE_BILLING_MODEL) {
      return failure('pool_requires_usage_model',
        'An interview pool can only be sold on the usage billing model.', 'pool_quantity');
    }
    if (effectiveModel === USAGE_BILLING_MODEL && !(usagePrice > 0)) {
      // Kept under its existing name when a pool is what needs the price.
      if (poolSupplied && usagePriceRaw === undefined) {
        return failure('pool_requires_usage_price',
          'An interview pool needs a per-interview usage price.', 'usage_interview_fee_cents');
      }
      return failure('usage_price_required',
        'The usage billing model needs usage_interview_fee_cents, a whole number of cents greater than zero.',
        'usage_interview_fee_cents');
    }
  }

  return {
    ok: true,
    settings: {
      billing_model: billingModel,
      rollover_days: rolloverDays,
      max_interview_minutes: maxInterviewMinutes,
      scored_question_count: scoredQuestionCount
    },
    effective_billing_model: effectiveModel
  };
}

/** The settings that were stated, as Stripe metadata strings; absent ones are left out. */
function enterpriseSettingsMetadata(settings = {}) {
  const metadata = {};
  for (const field of ENTERPRISE_SETTING_FIELDS) {
    if (settings[field] !== null && settings[field] !== undefined) metadata[field] = String(settings[field]);
  }
  return metadata;
}

/**
 * Stores an explicit billing model, only where none is stored yet.
 *
 * A stored billing_model is a choice for that client (Step E2), so a later
 * subscription event, which carries the same agreement terms, must never change
 * one that has been set since, and nothing here ever clears one.
 */
async function recordExplicitBillingModel({ db, clientId, billingModel } = {}) {
  const model = String(billingModel || '').trim().toLowerCase();
  if (!db || !clientId || !BILLING_MODELS.includes(model)) return { recorded: false };
  const { data, error } = await db
    .from('client_plan_settings')
    .update({ billing_model: model })
    .eq('client_id', clientId)
    .is('billing_model', null)
    .select('client_id');
  if (error) throw new Error(error.message || 'Billing model update failed');
  return { recorded: Array.isArray(data) ? data.length > 0 : !!data };
}

module.exports = {
  ENTERPRISE_SETTING_FIELDS,
  INTERVIEW_MINUTES_MAX,
  INTERVIEW_MINUTES_MIN,
  ROLLOVER_DAYS_MAX,
  ROLLOVER_DAYS_MIN,
  SCORED_QUESTIONS_MAX,
  SCORED_QUESTIONS_MIN,
  enterpriseSettingsMetadata,
  recordExplicitBillingModel,
  validateEnterpriseSettings
};
