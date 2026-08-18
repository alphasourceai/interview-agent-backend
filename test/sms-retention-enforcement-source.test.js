'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const migration = fs.readFileSync(path.join(
  __dirname, '..', 'supabase', 'migrations', '20260818163902_sms_retention_enforcement.sql'
), 'utf8');

test('retention schedule encodes each approved duration and preserves active suppressions', () => {
  assert.match(migration, /sms_selection_at[\s\S]*interval '4 years'/);
  assert.match(migration, /provider_delivery_status[\s\S]*interval '13 months'/);
  assert.match(migration, /sms_destination_suppressions[\s\S]*released_at is not null[\s\S]*interval '4 years'/);
  assert.match(migration, /sms_inbound_control_events[\s\S]*interval '4 years'/);
  assert.match(migration, /sms_line_type_cache[\s\S]*expires_at <= p_now/);
  assert.match(migration, /sms_line_type_cache_max_ttl_check[\s\S]*interval '30 days'/);
  assert.match(migration, /p_ttl_seconds not between 3600 and 2592000/);
  assert.match(migration, /sms_spend_reservations[\s\S]*interval '13 months'/);
  assert.match(migration, /sms_provider_breakers[\s\S]*active = false[\s\S]*interval '13 months'/);
  assert.doesNotMatch(migration, /delete from private_auth\.sms_destination_suppressions[\s\S]{0,180}released_at is null/i);
});

test('retention evidence is aggregate-only and private', () => {
  assert.match(migration, /sms_retention_runs/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table private_auth\.sms_retention_runs from public, anon, authenticated, service_role/);
  assert.match(migration, /revoke all on function private_auth\.enforce_sms_retention[\s\S]*service_role/);
  assert.match(migration, /grant execute on function public\.service_get_sms_retention_snapshot\(\)[\s\S]*to service_role/);
  assert.doesNotMatch(migration, /\b(phone|phone_e164|to_e164|message_body|otp_code)\s+text\b/i);
});

test('retention uses supported named cron scheduling without direct cron catalog mutation', () => {
  assert.match(migration, /create extension if not exists pg_cron with schema pg_catalog/);
  assert.match(migration, /cron\.schedule\([\s\S]*'alphascreen-sms-retention-daily'[\s\S]*'25 3 \* \* \*'/);
  assert.match(migration, /named cron\.schedule as an upsert/);
  assert.match(migration, /private_auth\.enforce_sms_retention\(statement_timestamp\(\), false\)/);
  assert.doesNotMatch(migration, /(insert into|update|delete from)\s+cron\.job\b/i);
});

test('retention exposes a bounded dry run and serializes execution', () => {
  assert.match(migration, /p_dry_run boolean default false/);
  assert.match(migration, /pg_try_advisory_xact_lock/);
  assert.match(migration, /'status', case when p_dry_run then 'dry_run' else 'succeeded' end/);
  assert.match(migration, /completed_at >= statement_timestamp\(\) - interval '36 hours'/);
  assert.match(migration, /cron\.job_run_details/);
});
