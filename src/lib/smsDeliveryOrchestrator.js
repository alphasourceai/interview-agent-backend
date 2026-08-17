'use strict';

const { recordOtpSmsDeliveryMetadata } = require('./otpChallenge');
const { getSmsOtpEligibility } = require('./smsOtpFoundation');
const {
  assertSmsProviderResult,
  safeSmsTelemetry,
} = require('./smsProviderContract');

function qaDestinationAllowed({ environment, destinationFingerprint, adapterNetwork }) {
  if (adapterNetwork === 'none') return true;
  return environment === 'qa'
    && /^[0-9a-f]{64}$/.test(String(destinationFingerprint || ''));
}

function validateCommittedChallenge(challenge) {
  if (!challenge || challenge.committed !== true || challenge.channel !== 'sms'
      || !/^[0-9a-f-]{36}$/i.test(String(challenge.challengeId || ''))
      || !/^\d{6}$/.test(String(challenge.code || ''))
      || !Number.isFinite(Date.parse(String(challenge.expiresAt || '')))) {
    throw new TypeError('a committed SMS challenge is required before adapter invocation');
  }
  return challenge;
}

async function orchestrateOtpSmsDelivery({
  db,
  environment,
  candidate,
  destinationFingerprint,
  authorizeAndBind,
  checkSuppressed,
  rateLimitGates = [],
  issueChallenge,
  adapter,
  allowNetwork = false,
  recordMetadata = recordOtpSmsDeliveryMetadata,
  logger = null,
} = {}) {
  if (!['local', 'qa'].includes(environment)) throw new Error('SMS-C0 orchestration is disabled outside local and QA');
  if (!adapter || typeof adapter.sendOtpSms !== 'function') throw new TypeError('one SMS adapter is required');
  if (adapter.network !== 'none' && !allowNetwork) throw new Error('network SMS adapters are disabled in SMS-C0');

  const authorization = await authorizeAndBind();
  if (!authorization || authorization.valid !== true) return Object.freeze({ outcome: 'misconfigured', challengeCreated: false, adapterCalled: false });
  const suppressed = await checkSuppressed(destinationFingerprint);
  const eligibility = getSmsOtpEligibility(candidate, { bindingValid: true, architectureAvailable: true, suppressed });
  if (!eligibility.eligible) {
    return Object.freeze({
      outcome: suppressed ? 'blocked_destination' : 'invalid_destination',
      challengeCreated: false,
      adapterCalled: false,
    });
  }
  if (!qaDestinationAllowed({
    environment,
    destinationFingerprint,
    adapterNetwork: adapter.network,
  })) return Object.freeze({ outcome: 'blocked_destination', challengeCreated: false, adapterCalled: false });

  for (const gate of rateLimitGates) {
    const result = await gate({ destinationFingerprint, candidateId: candidate.id || null, country: eligibility.country });
    if (!result || result.allowed !== true) return Object.freeze({ outcome: 'blocked_destination', challengeCreated: false, adapterCalled: false });
  }

  const challenge = validateCommittedChallenge(await issueChallenge());
  await recordMetadata(db, {
    challengeId: challenge.challengeId,
    event: 'send_requested',
    provider: adapter.name,
  });

  let result;
  try {
    result = await adapter.sendOtpSms({
      toE164: candidate.phone_e164,
      code: challenge.code,
      challengeId: challenge.challengeId,
      expiresAt: challenge.expiresAt,
      environment,
    });
    assertSmsProviderResult(result);
  } catch (_error) {
    result = Object.freeze({
      provider: adapter.name,
      messageId: null,
      status: null,
      outcome: 'ambiguous_outcome',
      failureCategory: 'ambiguous_outcome',
    });
  }

  if (result.outcome === 'accepted') {
    try {
      await recordMetadata(db, {
        challengeId: challenge.challengeId,
        event: 'provider_accepted',
        provider: result.provider,
        providerMessageId: result.messageId,
        deliveryStatus: result.status,
      });
    } catch (_error) {
      result = Object.freeze({
        provider: result.provider,
        messageId: null,
        status: null,
        outcome: 'ambiguous_outcome',
        failureCategory: 'ambiguous_outcome',
      });
    }
  } else {
    try {
      await recordMetadata(db, {
        challengeId: challenge.challengeId,
        event: 'send_outcome',
        provider: result.provider,
        deliveryStatus: result.status,
        failureCategory: result.failureCategory,
      });
    } catch (_error) {
      result = Object.freeze({
        provider: result.provider,
        messageId: null,
        status: null,
        outcome: 'ambiguous_outcome',
        failureCategory: 'ambiguous_outcome',
      });
    }
  }

  if (logger && typeof logger.info === 'function') {
    logger.info('sms_delivery_outcome', safeSmsTelemetry({ ...result, country: eligibility.country }));
  }
  return Object.freeze({ ...result, challengeCreated: true, adapterCalled: true, retryAttempted: false, failoverAttempted: false });
}

module.exports = {
  orchestrateOtpSmsDelivery,
  qaDestinationAllowed,
  validateCommittedChallenge,
};
