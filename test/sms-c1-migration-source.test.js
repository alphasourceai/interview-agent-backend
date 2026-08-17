'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260817201937_sms_c1_provider_delivery_callback_rpc_prod.sql'), 'utf8');

test('callback migration is provider-neutral and contains no provider-specific schema', () => {
  assert.doesNotMatch(migration, /telnyx|twilio|signalwire|plivo|vonage|bandwidth/i);
  assert.doesNotMatch(migration, /create\s+table|alter\s+table|add\s+column/i);
  assert.match(migration, /\(provider, last_provider_event_id\)/i);
  assert.match(migration, /where last_provider_event_id is not null/i);
});

test('callback RPC can mutate telemetry only, never OTP authority', () => {
  for (const forbidden of [
    'verifier_hmac =', 'pepper_version =', 'purpose =', 'channel =', 'candidate_id =', 'client_id =',
    'role_id =', 'submission_id =', 'interview_attempt_id =', 'recovery_authorization_id =',
    'expires_at =', 'attempt_count =', 'max_attempts =', 'consumed_at =', 'superseded_at =',
    'destination_fingerprint =',
  ]) assert.equal(migration.includes(forbidden), false, forbidden);
  assert.doesNotMatch(migration, /raw_body|provider_response|jsonb/i);
});

test('callback RPC is SECURITY DEFINER with empty search path and service-only public execution', () => {
  assert.match(migration, /security definer[\s\S]*set search_path = ''/i);
  assert.match(migration, /revoke all on function private_auth\.record_otp_sms_delivery_event[\s\S]*service_role/i);
  assert.match(migration, /revoke all on function public\.service_record_otp_sms_delivery_event[\s\S]*public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.service_record_otp_sms_delivery_event[\s\S]*to service_role/i);
});
