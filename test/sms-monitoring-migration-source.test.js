'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260818145611_sms_monitoring_admin_snapshot.sql'),
  'utf8',
);

test('monitoring snapshot remains service-only and private-table access is not granted', () => {
  assert.match(migration, /security definer/g);
  assert.match(migration, /set search_path = ''/g);
  assert.match(migration, /revoke all on function public\.service_get_sms_monitoring_snapshot[\s\S]*from public, anon, authenticated;/);
  assert.match(migration, /grant execute on function public\.service_get_sms_monitoring_snapshot[\s\S]*to service_role;/);
  assert.doesNotMatch(migration, /grant execute[\s\S]{0,180}to (anon|authenticated)/i);
});

test('production-only safety capabilities are feature-detected without schema drift', () => {
  for (const table of [
    'sms_spend_reservations',
    'sms_line_type_cache',
    'sms_inbound_control_events',
    'sms_provider_breakers',
  ]) {
    assert.match(migration, new RegExp(`to_regclass\\('private_auth\\.${table}'\\)`));
  }
});

test('snapshot output is aggregate and excludes sensitive SMS identifiers', () => {
  for (const allowed of ['requested', 'delivered', 'failure_category', 'consent', 'suppressions']) {
    assert.match(migration, new RegExp(`'${allowed}'`));
  }
  const returnBlock = migration.slice(migration.indexOf("return jsonb_build_object("));
  for (const forbidden of [
    "'phone'",
    "'phone_e164'",
    "'destination_fingerprint'",
    "'provider_message_id'",
    "'challenge_id'",
    "'candidate_id'",
    "'verifier_hmac_hex'",
  ]) {
    assert.equal(returnBlock.includes(forbidden), false);
  }
});
