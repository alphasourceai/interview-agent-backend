'use strict';

const INTERNAL_SYNTHETIC_CLIENT_IDS_ENV = 'INTERNAL_SYNTHETIC_INTERVIEW_CLIENT_IDS';

const PLAN_CAPACITY = Object.freeze({
  basic: Object.freeze({
    membership_level: 'basic',
    display_name: 'Essential',
    interview_duration_minutes: 10,
    max_interview_minutes: 10,
    scored_question_count: 5,
  }),
  pro: Object.freeze({
    membership_level: 'pro',
    display_name: 'Pro',
    interview_duration_minutes: 12,
    max_interview_minutes: 12,
    scored_question_count: 6,
  }),
  enterprise: Object.freeze({
    membership_level: 'enterprise',
    display_name: 'Enterprise',
    interview_duration_minutes: 15,
    max_interview_minutes: 15,
    scored_question_count: 7,
  }),
});

class PlanCapacityError extends Error {
  constructor(message, code = 'INVALID_MEMBERSHIP_LEVEL') {
    super(message);
    this.name = 'PlanCapacityError';
    this.code = code;
    this.status = 400;
  }
}

function normalizeMembershipLevel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  const canonical = normalized === 'essential' ? 'basic' : normalized;
  return Object.prototype.hasOwnProperty.call(PLAN_CAPACITY, canonical) ? canonical : '';
}

function getPlanCapacity(value) {
  const membershipLevel = normalizeMembershipLevel(value);
  return membershipLevel ? PLAN_CAPACITY[membershipLevel] : null;
}

function requirePlanCapacity(value) {
  const capacity = getPlanCapacity(value);
  if (!capacity) {
    throw new PlanCapacityError('Membership level must be Essential, Pro, or Enterprise.');
  }
  return capacity;
}

function parseInternalSyntheticClientIds(env = process.env) {
  return new Set(
    String(env?.[INTERNAL_SYNTHETIC_CLIENT_IDS_ENV] || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function isInternalSyntheticClient(clientId, env = process.env) {
  const normalizedClientId = String(clientId || '').trim();
  return Boolean(normalizedClientId && parseInternalSyntheticClientIds(env).has(normalizedClientId));
}

function validInternalSyntheticDuration(value) {
  const duration = Number(value);
  return Number.isInteger(duration) && duration > 0 && duration <= 59 ? duration : null;
}

// An Enterprise client's own length and question count, from its plan settings.
// A value outside what an agreement may set is ignored in favour of the plan
// value rather than trusted: the agreement validator is the only writer, so an
// out-of-range value means the row was edited by hand.
function enterpriseSetting(value, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function resolvePlanCapacity({
  planTier,
  clientId,
  configuredDurationMinutes,
  configuredScoredQuestionCount,
  env = process.env,
} = {}) {
  const capacity = requirePlanCapacity(planTier);
  const internalDuration = isInternalSyntheticClient(clientId, env)
    ? validInternalSyntheticDuration(configuredDurationMinutes)
    : null;

  if (isInternalSyntheticClient(clientId, env) && internalDuration === null) {
    throw new PlanCapacityError(
      'Internal synthetic interview duration is invalid.',
      'INVALID_INTERNAL_SYNTHETIC_DURATION',
    );
  }

  if (internalDuration !== null) {
    return Object.freeze({
      ...capacity,
      interview_duration_minutes: internalDuration,
      max_interview_minutes: internalDuration,
      internal_synthetic_duration_override: true,
    });
  }

  // Only Enterprise is configured per client. Essentials and Pro always run at
  // their plan values, whatever their plan settings hold.
  if (capacity.membership_level !== 'enterprise') return capacity;

  const {
    INTERVIEW_MINUTES_MAX,
    INTERVIEW_MINUTES_MIN,
    SCORED_QUESTIONS_MAX,
    SCORED_QUESTIONS_MIN,
  } = require('./enterpriseSettings');
  const minutes = enterpriseSetting(configuredDurationMinutes, INTERVIEW_MINUTES_MIN, INTERVIEW_MINUTES_MAX)
    ?? capacity.max_interview_minutes;
  // Empty means the plan's count.
  const scoredQuestionCount = enterpriseSetting(configuredScoredQuestionCount, SCORED_QUESTIONS_MIN, SCORED_QUESTIONS_MAX)
    ?? capacity.scored_question_count;
  if (minutes === capacity.max_interview_minutes && scoredQuestionCount === capacity.scored_question_count) {
    return capacity;
  }
  return Object.freeze({
    ...capacity,
    interview_duration_minutes: minutes,
    max_interview_minutes: minutes,
    scored_question_count: scoredQuestionCount,
    client_configured: true,
  });
}

function planCapacityLookupError(error) {
  const lookupError = new PlanCapacityError(
    'Membership capacity could not be loaded.',
    'PLAN_CAPACITY_LOOKUP_FAILED',
  );
  lookupError.status = 503;
  lookupError.cause = error || null;
  return lookupError;
}

async function lookupPlanSettings(db, clientId) {
  const { data, error } = await db
    .from('client_plan_settings')
    .select('client_id,plan_tier,max_interview_minutes,scored_question_count')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw planCapacityLookupError(error);
  return data || null;
}

async function resolvePlanCapacityForClient({ db, clientId, env = process.env } = {}) {
  const scopedClientId = String(clientId || '').trim();
  if (!db || typeof db.from !== 'function' || !scopedClientId) {
    throw new PlanCapacityError('Client membership capacity requires a database and client id.');
  }

  // Resolve to the billing owner first, the way getRoleInterviewAvailability
  // does. Plan settings belong to whoever pays: a child entity has no row of its
  // own, and reading one if it ever appeared would put the two resolvers in
  // disagreement about the same table.
  const { resolveBillingOwnerForScope } = require('./clientBillingScope');
  const billingScope = await resolveBillingOwnerForScope(db, scopedClientId);
  if (!billingScope?.ok) {
    if (Number(billingScope?.status) >= 500) throw planCapacityLookupError(billingScope?.body);
    // The clients row could not be resolved, so there is no billing owner to
    // read. Settings stored directly against this id are better than refusing
    // the preflight outright, which is what this did before the owner lookup
    // was added.
    const scopedSettings = await lookupPlanSettings(db, scopedClientId);
    if (!scopedSettings) return requirePlanCapacity(null);
    return resolvePlanCapacity({
      planTier: scopedSettings.plan_tier,
      clientId: scopedClientId,
      configuredDurationMinutes: scopedSettings.max_interview_minutes,
      configuredScoredQuestionCount: scopedSettings.scored_question_count,
      env,
    });
  }

  const billingClientId = String(billingScope.billingClientId || scopedClientId).trim();
  if (!billingClientId) return requirePlanCapacity(null);
  const billingSettings = await lookupPlanSettings(db, billingClientId);
  if (!billingSettings) return requirePlanCapacity(null);
  return resolvePlanCapacity({
    planTier: billingSettings.plan_tier,
    clientId: billingClientId,
    configuredDurationMinutes: billingSettings.max_interview_minutes,
    configuredScoredQuestionCount: billingSettings.scored_question_count,
    env,
  });
}

// The length and question count a role's rubric was generated with, stamped on
// the rubric when it was generated (generateRubric.js). Null for a rubric from
// before stamping, or one without a usable stamp.
function stampedRubricCapacity(rubric) {
  const parsed = typeof rubric === 'string' ? (() => {
    try { return JSON.parse(rubric); } catch (_) { return null; }
  })() : rubric;
  if (!parsed || typeof parsed !== 'object') return { rubric: null, minutes: null, questions: null };
  const minutes = Number(parsed.max_interview_minutes);
  const questions = Number(parsed.scored_question_count);
  return {
    rubric: parsed,
    minutes: Number.isInteger(minutes) && minutes > 0 ? minutes : null,
    questions: Number.isInteger(questions) && questions > 0 ? questions : null,
  };
}

/**
 * The capacity an interview for this role runs at.
 *
 * A role keeps the length its rubric was generated with, so a later change to
 * the client's settings applies only to roles created (or regenerated) after it.
 * The client is still resolved first: a lookup failure or a client with no valid
 * plan is refused exactly as before, and an internal synthetic client keeps its
 * configured override, live, as it always has.
 *
 * A rubric from before stamping falls back to its own tier's plan values, which
 * is what every rubric was generated at until per-client settings existed.
 */
async function resolveRoleInterviewCapacity({ db, role, env = process.env } = {}) {
  const clientCapacity = await resolvePlanCapacityForClient({ db, clientId: role?.client_id, env });
  return capacityForRole(clientCapacity, role?.rubric);
}

// The rule above, given a client's already-resolved capacity, for callers that
// resolve each client once and apply it to many roles.
function capacityForRole(clientCapacity, rubric) {
  if (!clientCapacity) return null;
  if (clientCapacity.internal_synthetic_duration_override) return clientCapacity;

  const stamp = stampedRubricCapacity(rubric);
  if (stamp.minutes !== null) {
    return Object.freeze({
      ...clientCapacity,
      interview_duration_minutes: stamp.minutes,
      max_interview_minutes: stamp.minutes,
      scored_question_count: stamp.questions ?? clientCapacity.scored_question_count,
      capacity_source: 'role_rubric',
    });
  }
  const rubricPlan = getPlanCapacity(stamp.rubric?.membership_level);
  if (rubricPlan) return Object.freeze({ ...rubricPlan, capacity_source: 'role_rubric_plan' });
  return clientCapacity;
}

module.exports = {
  INTERNAL_SYNTHETIC_CLIENT_IDS_ENV,
  PLAN_CAPACITY,
  PlanCapacityError,
  capacityForRole,
  getPlanCapacity,
  isInternalSyntheticClient,
  normalizeMembershipLevel,
  parseInternalSyntheticClientIds,
  requirePlanCapacity,
  resolvePlanCapacity,
  resolvePlanCapacityForClient,
  resolveRoleInterviewCapacity,
};
