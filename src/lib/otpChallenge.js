'use strict';

const crypto = require('crypto');

const OTP_PURPOSE = 'interview_access';
const OTP_CHANNEL_EMAIL = 'email';
const OTP_CODE_TTL_SECONDS = 10 * 60;
const OTP_MAX_ATTEMPTS = 5;
const OTP_PEPPER_VERSION = 1;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class OtpConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OtpConfigurationError';
    this.code = 'OTP_CONFIGURATION_ERROR';
  }
}

class OtpChallengeError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'OtpChallengeError';
    this.code = code;
  }
}

function getOtpSecret(version = OTP_PEPPER_VERSION, env = process.env) {
  const configuredVersion = Number(env.OTP_HMAC_SECRET_VERSION || OTP_PEPPER_VERSION);
  if (configuredVersion !== version) {
    throw new OtpConfigurationError(`OTP HMAC secret version ${version} is not configured`);
  }
  const raw = String(env[`OTP_HMAC_SECRET_V${version}`] || '').trim();
  if (!raw) throw new OtpConfigurationError(`OTP_HMAC_SECRET_V${version} is required`);

  let bytes;
  if (/^[0-9a-f]{64,}$/i.test(raw) && raw.length % 2 === 0) {
    bytes = Buffer.from(raw, 'hex');
  } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(raw) && raw.length % 4 === 0) {
    bytes = Buffer.from(raw, 'base64');
  } else {
    bytes = Buffer.from(raw, 'utf8');
  }
  if (bytes.length < 32) throw new OtpConfigurationError('OTP HMAC secret must contain at least 32 bytes');
  return bytes;
}

function framed(fields) {
  return fields.map((value) => {
    const normalized = value == null ? '' : String(value);
    return `${Buffer.byteLength(normalized, 'utf8')}:${normalized}`;
  }).join('|');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function canonicalBinding(binding = {}) {
  const values = {
    candidate_id: String(binding.candidate_id || '').trim().toLowerCase(),
    client_id: String(binding.client_id || '').trim().toLowerCase(),
    role_id: String(binding.role_id || '').trim().toLowerCase(),
    submission_id: String(binding.submission_id || '').trim().toLowerCase(),
    interview_attempt_id: String(binding.interview_attempt_id || '').trim().toLowerCase(),
    recovery_authorization_id: String(binding.recovery_authorization_id || '').trim().toLowerCase(),
  };
  for (const field of ['candidate_id', 'client_id', 'role_id']) {
    if (!UUID_RE.test(values[field])) throw new OtpChallengeError('INVALID_OTP_BINDING', `${field} is required`);
  }
  for (const field of ['submission_id', 'interview_attempt_id', 'recovery_authorization_id']) {
    if (values[field] && !UUID_RE.test(values[field])) throw new OtpChallengeError('INVALID_OTP_BINDING', `${field} is invalid`);
  }
  return values;
}

function bindingFingerprint(binding) {
  const b = canonicalBinding(binding);
  return crypto.createHash('sha256').update(framed([
    OTP_PURPOSE,
    OTP_CHANNEL_EMAIL,
    b.candidate_id,
    b.client_id,
    b.role_id,
    b.submission_id,
    b.interview_attempt_id,
    b.recovery_authorization_id,
  ])).digest('hex');
}

function destinationFingerprint(destination, version = OTP_PEPPER_VERSION, env = process.env) {
  const normalized = normalizeEmail(destination);
  if (!normalized) throw new OtpChallengeError('INVALID_OTP_DESTINATION', 'email destination is required');
  return crypto.createHmac('sha256', getOtpSecret(version, env))
    .update(framed(['otp-destination', OTP_CHANNEL_EMAIL, normalized]))
    .digest('hex');
}

function verifierHmac({ challengeId, code, binding, version = OTP_PEPPER_VERSION, env = process.env }) {
  const normalizedChallengeId = String(challengeId || '').trim().toLowerCase();
  const normalizedCode = String(code || '').trim();
  if (!UUID_RE.test(normalizedChallengeId)) throw new OtpChallengeError('INVALID_CHALLENGE_ID');
  if (!/^\d{6}$/.test(normalizedCode)) throw new OtpChallengeError('INVALID_OTP_CODE');
  const b = canonicalBinding(binding);
  return crypto.createHmac('sha256', getOtpSecret(version, env))
    .update(framed([
      'otp-verifier',
      String(version),
      normalizedChallengeId,
      OTP_PURPOSE,
      OTP_CHANNEL_EMAIL,
      normalizedCode,
      b.candidate_id,
      b.client_id,
      b.role_id,
      b.submission_id,
      b.interview_attempt_id,
      b.recovery_authorization_id,
    ]))
    .digest('hex');
}

function generateOtpCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function timingSafeHexEqual(left, right) {
  if (!/^[0-9a-f]{64}$/i.test(String(left || '')) || !/^[0-9a-f]{64}$/i.test(String(right || ''))) return false;
  const a = Buffer.from(String(left), 'hex');
  const b = Buffer.from(String(right), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function rpcRow(data) {
  return Array.isArray(data) ? (data[0] || null) : (data || null);
}

async function issueOtpChallenge(db, {
  email,
  candidateId,
  clientId,
  roleId,
  submissionId = null,
  interviewAttemptId = null,
  recoveryAuthorizationId = null,
  deliveryState = 'pending',
  env = process.env,
}) {
  const challengeId = crypto.randomUUID();
  const code = generateOtpCode();
  const binding = canonicalBinding({
    candidate_id: candidateId,
    client_id: clientId,
    role_id: roleId,
    submission_id: submissionId,
    interview_attempt_id: interviewAttemptId,
    recovery_authorization_id: recoveryAuthorizationId,
  });
  const version = Number(env.OTP_HMAC_SECRET_VERSION || OTP_PEPPER_VERSION);
  const verifier = verifierHmac({ challengeId, code, binding, version, env });
  const destination = destinationFingerprint(email, version, env);
  const fingerprint = bindingFingerprint(binding);

  const { data, error } = await db.rpc('service_issue_otp_challenge', {
    p_challenge_id: challengeId,
    p_purpose: OTP_PURPOSE,
    p_channel: OTP_CHANNEL_EMAIL,
    p_pepper_version: version,
    p_verifier_hmac_hex: verifier,
    p_binding_fingerprint: fingerprint,
    p_candidate_id: binding.candidate_id,
    p_client_id: binding.client_id,
    p_role_id: binding.role_id,
    p_submission_id: binding.submission_id || null,
    p_interview_attempt_id: binding.interview_attempt_id || null,
    p_recovery_authorization_id: binding.recovery_authorization_id || null,
    p_destination_fingerprint: destination,
    p_expires_in_seconds: OTP_CODE_TTL_SECONDS,
    p_max_attempts: OTP_MAX_ATTEMPTS,
    p_delivery_state: deliveryState,
  });
  if (error) throw new OtpChallengeError('OTP_CHALLENGE_CREATE_FAILED', error.message);
  const created = rpcRow(data);
  if (!created?.challenge_id || String(created.challenge_id) !== challengeId) {
    throw new OtpChallengeError('OTP_CHALLENGE_CREATE_FAILED', 'challenge creation was not confirmed');
  }
  return { challengeId, code, expiresAt: created.expires_at || null, binding };
}

async function getOtpChallengeContext(db, challengeId) {
  const normalized = String(challengeId || '').trim().toLowerCase();
  if (!UUID_RE.test(normalized)) return null;
  const { data, error } = await db.rpc('service_get_otp_challenge_context', { p_challenge_id: normalized });
  if (error) throw new OtpChallengeError('OTP_CHALLENGE_LOOKUP_FAILED', error.message);
  return rpcRow(data);
}

async function consumeOtpChallenge(db, { challengeId, code, env = process.env }) {
  const context = await getOtpChallengeContext(db, challengeId);
  if (!context) return { status: 'not_found' };
  const binding = canonicalBinding(context);
  let supplied;
  try {
    supplied = verifierHmac({
      challengeId,
      code,
      binding,
      version: Number(context.pepper_version),
      env,
    });
  } catch (error) {
    if (!(error instanceof OtpChallengeError) || error.code !== 'INVALID_OTP_CODE') throw error;
    supplied = '0'.repeat(64);
  }
  const verifierMatches = timingSafeHexEqual(context.verifier_hmac_hex, supplied);
  const { data, error } = await db.rpc('service_consume_otp_challenge', {
    p_challenge_id: String(challengeId).trim().toLowerCase(),
    p_verifier_matches: verifierMatches,
  });
  if (error) throw new OtpChallengeError('OTP_CHALLENGE_CONSUME_FAILED', error.message);
  return rpcRow(data) || { status: 'not_found' };
}

async function markOtpChallengeDelivery(db, challengeId, state) {
  const normalizedState = ['sent', 'failed'].includes(state) ? state : 'failed';
  const { error } = await db.rpc('service_mark_otp_challenge_delivery', {
    p_challenge_id: challengeId,
    p_delivery_state: normalizedState,
  });
  if (error) throw new OtpChallengeError('OTP_DELIVERY_STATE_FAILED', error.message);
}

async function supersedeOtpChallenges(db, { candidateId, roleId, reason }) {
  const { data, error } = await db.rpc('service_supersede_otp_challenges', {
    p_candidate_id: candidateId,
    p_role_id: roleId,
    p_reason: String(reason || 'superseded').slice(0, 80),
  });
  if (error) throw new OtpChallengeError('OTP_CHALLENGE_SUPERSEDE_FAILED', error.message);
  return Number(data || 0);
}

module.exports = {
  OTP_CHANNEL_EMAIL,
  OTP_CODE_TTL_SECONDS,
  OTP_MAX_ATTEMPTS,
  OTP_PEPPER_VERSION,
  OTP_PURPOSE,
  OtpChallengeError,
  OtpConfigurationError,
  bindingFingerprint,
  canonicalBinding,
  consumeOtpChallenge,
  destinationFingerprint,
  generateOtpCode,
  getOtpChallengeContext,
  getOtpSecret,
  issueOtpChallenge,
  markOtpChallengeDelivery,
  normalizeEmail,
  supersedeOtpChallenges,
  timingSafeHexEqual,
  verifierHmac,
};
