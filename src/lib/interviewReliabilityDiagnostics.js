'use strict';

const TELEMETRY_EVENTS = new Set([
  'reconnect_started',
  'reconnect_local_joined',
  'reconnect_remote_presence',
  'reconnect_remote_audio_ready',
  'reconnect_remote_media_changed',
  'reconnect_practical_progress',
  'reconnect_succeeded',
  'reconnect_failed',
  'daily_participant_joined',
  'daily_participant_left',
  'daily_remote_track_started',
  'daily_remote_track_stopped',
  'app_message_received',
  'progress_checkpoint_updated',
  'watchdog_deadline_evaluated',
  'browser_online',
  'browser_offline',
  'browser_visibility_changed',
  'interview_terminal_requested',
  'question_lock_entered',
  'closing_only_entered',
  'candidate_question_invitation_sent',
  'candidate_question_received',
  'candidate_question_response_completed',
  'closing_farewell_started',
  'termination_only_entered',
  'provider_end_requested',
  'provider_end_confirmed',
  'post_closing_question_violation',
  'candidate_inactivity_nudge_armed',
  'candidate_inactivity_nudge_cancelled',
  'candidate_inactivity_nudge_sent',
  'candidate_inactivity_nudge_suppressed',
  // Existing Phase B events retained for deployment compatibility.
  'watchdog_started',
  'watchdog_timeout',
  'reconnect_attempted',
  'browser_closed_or_navigation',
]);

const TOP_LEVEL_KEYS = new Set([
  'conversation_id',
  'interview_id',
  'role_token',
  'event',
  'event_sequence',
  'observed_at',
  'reason',
  'metadata',
]);

const INTEGER_FIELDS = Object.freeze({
  recovery_attempt: [0, 1],
  elapsed_ms: [0, 3_600_000],
  progress_age_ms: [0, 3_600_000],
  recovery_age_ms: [0, 3_600_000],
  participant_count: [0, 16],
  turn_index: [0, 10_000],
  threshold_ms: [0, 60_000],
  turn_sequence: [0, 1_000_000_000],
});

const BOOLEAN_FIELDS = new Set([
  'remote_participant_present',
  'is_recovery_active',
  'speech_interrupted',
  'candidate_speaking',
  'reconnect_active',
  'transport_healthy',
  'replica_present',
  'remote_audio_ready',
  'runtime_owner',
]);

const ENUM_FIELDS = Object.freeze({
  recovery_phase: new Set([
    'idle',
    'reconnecting_transport',
    'awaiting_remote_presence',
    'awaiting_remote_media',
    'awaiting_practical_progress',
    'recovered',
    'failed',
  ]),
  participant_role: new Set(['candidate', 'replica', 'unknown']),
  remote_audio_state: new Set(['absent', 'loading', 'playable', 'stopped', 'unavailable', 'unknown']),
  remote_video_state: new Set(['absent', 'loading', 'playable', 'stopped', 'unavailable', 'unknown']),
  track_kind: new Set(['audio', 'video']),
  track_state: new Set(['started', 'stopped', 'playable', 'unavailable', 'unknown']),
  meeting_state: new Set(['joined', 'left', 'reconnecting', 'unknown']),
  network_state: new Set(['online', 'offline', 'unknown']),
  visibility_state: new Set(['visible', 'hidden', 'prerender', 'unknown']),
  progress_source: new Set([
    'replica_started_speaking',
    'replica_utterance',
    'candidate_utterance',
    'candidate_speaking_started',
    'candidate_speaking_ended',
  ]),
  watchdog_reset_source: new Set(['progress_checkpoint', 'reconnect_practical_progress']),
  watchdog_evaluation: new Set([
    'recovery_threshold_reached',
    'recovery_deadline_expired',
    'post_recovery_progress_stale',
    'candidate_speaking_active',
    'candidate_speaking_protection_expired',
  ]),
  terminal_reason: new Set([
    'watchdog_timeout',
    'reconnect_failed',
    'browser_closed_or_navigation',
  ]),
  closing_state: new Set([
    'INTERVIEWING',
    'QUESTION_LOCKED',
    'CLOSING_ONLY',
    'TERMINATION_ONLY',
    'ENDED',
  ]),
  remaining_time_bucket: new Set([
    'over_45',
    '31_45',
    '11_30',
    '0_10',
  ]),
  inactivity_state: new Set([
    'DISABLED',
    'DISARMED',
    'ARMED_AFTER_PAL_TURN',
    'CANCELLED',
    'NUDGE_DISPATCHED',
    'WAITING_FOR_CANDIDATE_AFTER_NUDGE',
    'SUPPRESSED',
    'TERMINAL',
  ]),
  inactivity_reason: new Set([
    'candidate_speaking',
    'candidate_utterance',
    'pal_speaking',
    'reconnect',
    'transport_unhealthy',
    'candidate_media_unavailable',
    'replica_absent',
    'remote_audio_unavailable',
    'watchdog_recovery',
    'question_lock',
    'closing',
    'termination',
    'provider_end',
    'conversation_changed',
    'unmount',
    'runtime_ownership_lost',
    'hidden_document',
    'interrupted_pal_turn',
    'duplicate_turn',
    'stale_sequence',
    'wrong_conversation',
    'application_control_turn',
    'late_timer',
    'ambiguous_state',
    'dispatch_failed',
  ]),
  timer_lateness_bucket: new Set(['on_time', 'within_2s', 'over_2s']),
  ownership_mode: new Set(['prompt', 'tavus_patient', 'application_inactivity']),
});

const METADATA_KEYS = new Set([
  ...Object.keys(INTEGER_FIELDS),
  ...BOOLEAN_FIELDS,
  ...Object.keys(ENUM_FIELDS),
]);

const REASON_VALUES = new Set([
  'watchdog_timeout',
  'reconnect_failed',
  'browser_closed_or_navigation',
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function invalid(code) {
  return { ok: false, code };
}

function validateMetadata(value) {
  if (value === undefined) return { ok: true, metadata: {} };
  if (!isPlainObject(value)) return invalid('INVALID_TELEMETRY_METADATA');

  const serialized = JSON.stringify(value);
  if (serialized.length > 2048 || Object.keys(value).length > 12) {
    return invalid('TELEMETRY_METADATA_TOO_LARGE');
  }

  const metadata = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!METADATA_KEYS.has(key)) return invalid('UNKNOWN_TELEMETRY_METADATA');

    if (Object.prototype.hasOwnProperty.call(INTEGER_FIELDS, key)) {
      const [minimum, maximum] = INTEGER_FIELDS[key];
      if (!Number.isInteger(fieldValue) || fieldValue < minimum || fieldValue > maximum) {
        return invalid('INVALID_TELEMETRY_METADATA');
      }
      metadata[key] = fieldValue;
      continue;
    }

    if (BOOLEAN_FIELDS.has(key)) {
      if (typeof fieldValue !== 'boolean') return invalid('INVALID_TELEMETRY_METADATA');
      metadata[key] = fieldValue;
      continue;
    }

    const allowedValues = ENUM_FIELDS[key];
    if (!allowedValues?.has(fieldValue)) return invalid('INVALID_TELEMETRY_METADATA');
    metadata[key] = fieldValue;
  }

  return { ok: true, metadata };
}

function validateTelemetryPayload(body) {
  if (!isPlainObject(body)) return invalid('INVALID_TELEMETRY_PAYLOAD');
  if (Object.keys(body).some((key) => !TOP_LEVEL_KEYS.has(key))) {
    return invalid('UNKNOWN_TELEMETRY_FIELD');
  }

  const interviewId = typeof body.interview_id === 'string' ? body.interview_id.trim() : '';
  const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id.trim() : '';
  const roleToken = typeof body.role_token === 'string' ? body.role_token.trim() : '';
  const event = typeof body.event === 'string' ? body.event.trim().toLowerCase() : '';
  const eventSequence = body.event_sequence;
  const observedAt = typeof body.observed_at === 'string' ? body.observed_at.trim() : '';
  const reason = body.reason === undefined
    ? null
    : (typeof body.reason === 'string' ? body.reason.trim().toLowerCase() : '');

  if (!interviewId || interviewId.length > 80 || conversationId.length > 200
    || roleToken.length > 200) {
    return invalid('MISSING_REQUIRED_PARAMS');
  }
  if (!TELEMETRY_EVENTS.has(event)) return invalid('UNKNOWN_TELEMETRY_EVENT');
  if (!Number.isInteger(eventSequence) || eventSequence < 1 || eventSequence > 1_000_000) {
    return invalid('INVALID_TELEMETRY_SEQUENCE');
  }
  if (!observedAt || observedAt.length > 40 || !Number.isFinite(Date.parse(observedAt))) {
    return invalid('INVALID_TELEMETRY_TIMESTAMP');
  }
  if (reason !== null && !REASON_VALUES.has(reason)) return invalid('INVALID_TELEMETRY_REASON');

  const metadataResult = validateMetadata(body.metadata);
  if (!metadataResult.ok) return metadataResult;

  return {
    ok: true,
    telemetry: {
      interviewId,
      conversationId,
      roleToken,
      event,
      eventSequence,
      observedAt,
      reason,
      metadata: metadataResult.metadata,
    },
  };
}

function diagnosticDedupeKey(eventSequence, observedAt) {
  return `browser:${eventSequence}:${observedAt}`;
}

function decodeTelemetryAuthorization(value) {
  if (typeof value !== 'string' || value.length > 700) return null;
  const match = value.match(/^AlphaScreen-Telemetry ([A-Za-z0-9+/=_-]+)$/);
  if (!match) return null;
  try {
    const decoded = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
    if (!Array.isArray(decoded) || decoded.length !== 2) return null;
    const [roleToken, conversationId] = decoded;
    if (typeof roleToken !== 'string' || !roleToken.trim() || roleToken.length > 200) return null;
    if (typeof conversationId !== 'string' || !conversationId.trim() || conversationId.length > 200) return null;
    return {
      roleToken: roleToken.trim(),
      conversationId: conversationId.trim(),
    };
  } catch {
    return null;
  }
}

module.exports = {
  METADATA_KEYS,
  TELEMETRY_EVENTS,
  decodeTelemetryAuthorization,
  diagnosticDedupeKey,
  validateTelemetryPayload,
};
