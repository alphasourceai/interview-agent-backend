'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { after, before, test } = require('node:test')

const ENABLED = process.env.RETAIL_SMS_DISPOSABLE === 'true'
const SOCKET = process.env.RETAIL_SMS_PG_SOCKET || '/tmp'
const PORT = process.env.RETAIL_SMS_PG_PORT || '5432'
const USER = process.env.RETAIL_SMS_PG_USER || process.env.USER || 'postgres'
const DATABASE = `alphascreen_retail_sms_${process.pid}`
const ROOT = path.resolve(__dirname, '..')
const FIXTURE = path.join(__dirname, 'fixtures', 'durable-otp-bootstrap.sql')
const RETAIL_FIXTURE = path.join(__dirname, 'fixtures', 'retail-sms-bootstrap.sql')
const MIGRATIONS = [
  '20260810144400_durable_otp_challenge_architecture.sql',
  '20260810155800_durable_otp_single_active_resource.sql',
  '20260812013847_sms_b_e164_cross_channel_foundation.sql',
  '20260812141337_sms_c0_provider_delivery_recording_rpc.sql',
  '20260812160357_sms_c1_provider_delivery_callback_rpc.sql',
  '20260817212357_sms_production_safety_controls.sql',
  '20260818155900_sms_spend_reservation_candidate_index.sql',
].map((filename) => path.join(ROOT, 'supabase', 'migrations', filename))
const RETAIL_MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260827123000_retail_signup_sms_verification.sql')
const INTENT_ID = '870f3ec7-5f4c-4aa6-8ed7-0bc3fd00a184'
const VERIFICATION_ID = '870f3ec7-5f4c-4aa6-8ed7-0bc3fd00a186'

function args(database = DATABASE) {
  return ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', SOCKET, '-p', PORT, '-U', USER, '-d', database, '-At']
}

function command(name, commandArgs) {
  return spawnSync(name, commandArgs, { encoding: 'utf8' })
}

function sql(statement, { allowFailure = false } = {}) {
  const result = command('psql', [...args(), '-c', statement])
  if (!allowFailure) assert.equal(result.status, 0, result.stderr || result.stdout)
  return { status: result.status, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() }
}

function sqlAsync(statement) {
  return new Promise((resolve) => {
    const child = spawn('psql', [...args(), '-c', statement])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (status) => resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

function apply(filename) {
  const result = command('psql', [...args(), '-f', filename])
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

function issue() {
  return `set role service_role; select status||'|'||verification_id||'|'||(extract(epoch from expires_at-statement_timestamp()) between 599 and 601)||'|'||resend_after_seconds
    from public.service_issue_retail_signup_sms_verification(
      '${VERIFICATION_ID}','${INTENT_ID}',repeat('a',64),'basic','annual',1,repeat('b',64),statement_timestamp(),'sms-consent-v2'
    );`
}

before(() => {
  if (!ENABLED) return
  command('dropdb', ['-h', SOCKET, '-p', PORT, '-U', USER, '--if-exists', DATABASE])
  const created = command('createdb', ['-h', SOCKET, '-p', PORT, '-U', USER, DATABASE])
  assert.equal(created.status, 0, created.stderr)
  apply(FIXTURE)
  for (const migration of MIGRATIONS) apply(migration)
  apply(RETAIL_FIXTURE)
  apply(RETAIL_MIGRATION)
})

after(() => {
  if (!ENABLED) return
  command('dropdb', ['-h', SOCKET, '-p', PORT, '-U', USER, '--if-exists', DATABASE])
})

test('retail SMS migration applies with hardened private tables and service-only wrappers', { skip: !ENABLED }, () => {
  assert.equal(sql("select bool_and(c.relrowsecurity and pg_get_userbyid(c.relowner)='postgres') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private_auth' and c.relkind='r' and c.relname like 'retail%';").stdout, 't')
  assert.equal(sql("select has_function_privilege('anon','public.service_consume_retail_signup_sms_verification(uuid,boolean)','EXECUTE'),has_function_privilege('authenticated','public.service_consume_retail_signup_sms_verification(uuid,boolean)','EXECUTE'),has_function_privilege('service_role','public.service_consume_retail_signup_sms_verification(uuid,boolean)','EXECUTE');").stdout, 'f|f|t')
  assert.equal(sql("select bool_and(pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and p.proconfig @> array['search_path=\"\"']) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='private_auth' and p.proname like '%retail%sms%') or (n.nspname='public' and p.proname like 'service%retail%sms%');").stdout, 't')
  assert.notEqual(sql(`set role service_role; select * from private_auth.consume_retail_signup_sms_verification('${VERIFICATION_ID}',true);`, { allowFailure: true }).status, 0)
})

test('retail SMS issue binds consent and supersedes active email verification', { skip: !ENABLED }, () => {
  assert.match(sql(issue()).stdout, new RegExp(`^issued\\|${VERIFICATION_ID}\\|true\\|60$`))
  assert.equal(sql("select consent_copy_version||'|'||(sms_selection_at is not null)||'|'||(verifier_hmac_hex=repeat('b',64))||'|'||(destination_fingerprint=repeat('a',64)) from private_auth.retail_signup_sms_verifications;").stdout, 'sms-consent-v2|true|true|true')
  assert.equal(sql("select invalidation_reason from public.retail_signup_email_verifications;").stdout, 'channel_changed_to_sms')
  assert.equal(sql(`set role service_role; select verification_id||'|'||(verifier_hmac_hex=repeat('b',64))||'|'||verified||'|'||status from public.service_get_retail_signup_sms_verification('${INTENT_ID}',repeat('a',64));`).stdout, `${VERIFICATION_ID}|true|false|code_sent`)
})

test('retail SMS consume receives only a timing-safe boolean and atomically verifies once', { skip: !ENABLED }, async () => {
  assert.equal(sql(`set role service_role; select status from public.service_consume_retail_signup_sms_verification('${VERIFICATION_ID}',false);`).stdout, 'invalid')
  assert.equal(sql(`select attempt_count from private_auth.retail_signup_sms_verifications where id='${VERIFICATION_ID}';`).stdout, '1')
  const statement = `set role service_role; select status from public.service_consume_retail_signup_sms_verification('${VERIFICATION_ID}',true);`
  const results = await Promise.all([sqlAsync(statement), sqlAsync(statement)])
  assert.deepEqual(results.map((result) => result.status), [0, 0], results.map((result) => result.stderr).join('\n'))
  assert.deepEqual(results.map((result) => result.stdout.split('\n').at(-1)).sort(), ['already_used', 'verified'])
  assert.equal(sql(`select (phone_verified_at is not null)||'|'||(phone_verified_destination_fingerprint=repeat('a',64))||'|'||phone_verification_method from public.public_purchase_intents where id='${INTENT_ID}';`).stdout, 'true|true|retail_signup_sms_otp_v1')
})

test('candidate and retail reservations share one global provider spend cap', { skip: !ENABLED }, () => {
  assert.equal(sql("set role service_role; select allowed||'|'||reserved_total_cents from public.service_reserve_sms_spend('870f3ec7-5f4c-4aa6-8ed7-0bc3fd00a190',70,100,'telnyx','US',repeat('c',64),'82000000-0000-4000-8000-000000000021',repeat('d',64));").stdout, 'true|70')
  assert.equal(sql(`set role service_role; select allowed||'|'||reserved_total_cents from public.service_reserve_retail_sms_spend('870f3ec7-5f4c-4aa6-8ed7-0bc3fd00a191',40,100,'telnyx','US',repeat('e',64),'${INTENT_ID}',repeat('f',64));`).stdout, 'false|70')
  assert.equal(sql(`set role service_role; select allowed||'|'||reserved_total_cents from public.service_reserve_retail_sms_spend('870f3ec7-5f4c-4aa6-8ed7-0bc3fd00a192',30,100,'telnyx','US',repeat('e',64),'${INTENT_ID}',repeat('f',64));`).stdout, 'true|100')

  sql('delete from private_auth.sms_spend_reservations; delete from private_auth.retail_sms_spend_reservations;')
  assert.equal(sql(`set role service_role; select allowed||'|'||reserved_total_cents from public.service_reserve_retail_sms_spend('870f3ec7-5f4c-4aa6-8ed7-0bc3fd00a193',70,100,'telnyx','US',repeat('e',64),'${INTENT_ID}',repeat('f',64));`).stdout, 'true|70')
  assert.equal(sql("set role service_role; select allowed||'|'||reserved_total_cents from public.service_reserve_sms_spend('870f3ec7-5f4c-4aa6-8ed7-0bc3fd00a194',40,100,'telnyx','US',repeat('c',64),'82000000-0000-4000-8000-000000000021',repeat('d',64));").stdout, 'false|70')
  assert.equal(sql("set role service_role; select allowed||'|'||reserved_total_cents from public.service_reserve_sms_spend('870f3ec7-5f4c-4aa6-8ed7-0bc3fd00a195',30,100,'telnyx','US',repeat('c',64),'82000000-0000-4000-8000-000000000021',repeat('d',64));").stdout, 'true|100')
})

test('retail SMS migration replay is catalog-safe', { skip: !ENABLED }, () => {
  apply(RETAIL_MIGRATION)
  assert.equal(sql("select count(*) from pg_indexes where schemaname='private_auth' and tablename='retail_signup_sms_verifications';").stdout, '3')
  assert.equal(sql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'service%retail%sms%';").stdout, '9')
})
