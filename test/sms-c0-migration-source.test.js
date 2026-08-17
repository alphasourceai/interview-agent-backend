'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const durable = fs.readFileSync(path.join(root, 'supabase/migrations/20260810191316_durable_otp_challenge_architecture_prod.sql'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260817201935_sms_c0_provider_delivery_recording_rpc_prod.sql'), 'utf8');

test('pre-fix trusted boundary proves the blocker: it accepts only challenge ID plus sent or failed', () => {
  assert.match(durable, /service_mark_otp_challenge_delivery\(p_challenge_id uuid, p_delivery_state text\)/);
  assert.doesNotMatch(durable, /service_mark_otp_challenge_delivery\([^)]*provider_message_id/);
});

test('migration adds only functions, comments, ownership, grants, and transaction control', () => {
  assert.doesNotMatch(migration, /create\s+table|alter\s+table|add\s+column|create\s+(?:unique\s+)?index/i);
  assert.match(migration, /security definer[\s\S]*set search_path = ''/i);
  assert.match(migration, /revoke all on function public\.service_record_otp_sms_delivery_metadata[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.service_record_otp_sms_delivery_metadata[\s\S]*to service_role/i);
});

test('RPC allowlists delivery fields and contains no authentication-authority assignment', () => {
  for (const forbidden of [
    'verifier_hmac =', 'pepper_version =', 'purpose =', 'channel =', 'candidate_id =',
    'client_id =', 'role_id =', 'submission_id =', 'interview_attempt_id =',
    'recovery_authorization_id =', 'expires_at =', 'attempt_count =', 'max_attempts =',
    'consumed_at =', 'superseded_at =', 'destination_fingerprint =',
  ]) assert.equal(migration.includes(forbidden), false, forbidden);
  assert.doesNotMatch(migration, /jsonb|provider_response|raw_body/i);
});
