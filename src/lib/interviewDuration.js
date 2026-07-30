'use strict';

const MIN_INTERVIEW_MINUTES = 1;
const MAX_INTERVIEW_MINUTES = 60;

function validateConfiguredInterviewDuration(value) {
  if (value === undefined) return { ok: false, reason: 'missing_setting' };
  if (value === null) return { ok: false, reason: 'null_duration' };
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, reason: 'malformed_duration' };
  }
  if (!Number.isInteger(value)) return { ok: false, reason: 'non_integer_duration' };
  if (value < MIN_INTERVIEW_MINUTES) return { ok: false, reason: 'non_positive_duration' };
  if (value > MAX_INTERVIEW_MINUTES) return { ok: false, reason: 'duration_above_provider_limit' };
  return { ok: true, minutes: value };
}

function requireConfiguredInterviewDuration(value) {
  const validation = validateConfiguredInterviewDuration(value);
  if (validation.ok) return validation.minutes;

  const error = new Error('Interview duration configuration is invalid');
  error.code = 'INTERVIEW_DURATION_NOT_CONFIGURED';
  error.status = 503;
  error.retryable = false;
  error.failureCategory = 'definite_pre_acceptance';
  error.durationReason = validation.reason;
  throw error;
}

module.exports = {
  MAX_INTERVIEW_MINUTES,
  MIN_INTERVIEW_MINUTES,
  requireConfiguredInterviewDuration,
  validateConfiguredInterviewDuration,
};
