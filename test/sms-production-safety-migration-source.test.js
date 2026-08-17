'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const migration = fs.readFileSync(path.join(
  __dirname, '..', 'supabase', 'migrations', '20260817212357_sms_production_safety_controls.sql'
), 'utf8');

test('production safety migration stores fingerprints and bounded metadata, never plaintext destinations', () => {
  for (const table of [
    'sms_line_type_cache', 'sms_spend_reservations', 'sms_inbound_control_events', 'sms_provider_breakers',
  ]) assert.match(migration, new RegExp(`private_auth\\.${table}`));
  assert.doesNotMatch(migration, /\b(phone|phone_e164|to_e164|message_body|otp_code)\s+text\b/i);
});

test('all safety tables are private and all public boundaries are service-role only', () => {
  assert.match(migration, /revoke all on table private_auth\.sms_line_type_cache from public, anon, authenticated, service_role/);
  assert.match(migration, /revoke all on table private_auth\.sms_provider_breakers from public, anon, authenticated, service_role/);
  assert.match(migration, /revoke all on function public\.service_reserve_sms_spend[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.service_reserve_sms_spend[\s\S]*to service_role/);
  assert.match(migration, /security definer[\s\S]*set search_path = ''/i);
});

test('STOP and START semantics cannot release administrative or abuse blocks', () => {
  assert.match(migration, /p_action = 'stop'[\s\S]*'opted_out'/);
  assert.match(migration, /p_action = 'start'[\s\S]*status = 'opted_out'[\s\S]*released_at is null/);
  assert.doesNotMatch(migration, /p_action = 'start'[\s\S]{0,500}status in \(/i);
});

test('spend reservations are serialized and provider breaker is checked inside the lock', () => {
  const lock = migration.indexOf("hashtextextended('sms-spend'");
  const breaker = migration.indexOf('sms_provider_breakers b');
  const insert = migration.indexOf('insert into private_auth.sms_spend_reservations');
  assert.ok(lock >= 0 && breaker > lock && insert > breaker);
  assert.match(migration, /where r\.period_day = v_period_day[\s\S]*r\.provider = p_provider[\s\S]*r\.released_at is null/);
});

test('public wrappers expose stable named PostgREST arguments', () => {
  assert.match(migration, /service_reserve_sms_spend\([\s\S]*p_reservation_id uuid,[\s\S]*p_reserved_cents integer,[\s\S]*p_daily_cap_cents integer/);
  assert.match(migration, /service_record_sms_inbound_control_event\([\s\S]*p_provider text,[\s\S]*p_provider_event_id text,[\s\S]*p_destination_fingerprint text/);
});
