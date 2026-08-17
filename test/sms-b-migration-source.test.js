'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const migration = fs.readFileSync(path.join(
  __dirname, '..', 'supabase', 'migrations', '20260817201934_sms_b_e164_cross_channel_foundation_prod.sql'
), 'utf8');

test('SMS-B migration keeps active resource identity cross-channel', () => {
  assert.match(migration, /otp_challenges_one_active_resource_uidx[\s\S]*\(purpose, candidate_id, client_id, role_id\)/);
  assert.doesNotMatch(migration, /otp_challenges_one_active_resource_uidx[\s\S]{0,180}\bchannel\b/);
  assert.match(migration, /hashtextextended\([\s\S]*p_purpose[\s\S]*p_candidate_id[\s\S]*p_client_id[\s\S]*p_role_id/);
  assert.doesNotMatch(migration, /hashtextextended\([\s\S]{0,300}p_channel/);
});

test('SMS-B migration is provider-neutral and consent-bound', () => {
  assert.match(migration, /provider_message_id text null/);
  assert.match(migration, /otp_challenges_provider_message_uidx/);
  assert.match(migration, /service_issue_sms_otp_challenge/);
  assert.match(migration, /sms requires the consent-bound issuance boundary/);
  assert.doesNotMatch(migration, /twilio_message_sid|telnyx_id|signalwire_message_id/i);
});

test('SMS-B suppression table is private and stores no plaintext destination column', () => {
  assert.match(migration, /private_auth\.sms_destination_suppressions/);
  assert.match(migration, /revoke all privileges on table private_auth\.sms_destination_suppressions from public, anon, authenticated, service_role/);
  assert.doesNotMatch(migration, /sms_destination_suppressions[\s\S]{0,1000}\b(phone|phone_e164|to_e164)\s+text\b/i);
});

test('SMS-B deliberately performs no guessed historical backfill', () => {
  assert.match(migration, /Deliberately no historical phone backfill/);
  assert.doesNotMatch(migration, /update\s+public\.candidates[\s\S]{0,300}phone_e164\s*=/i);
});
