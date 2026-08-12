'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');

const ENABLED = process.env.PRONUNCIATION_DISPOSABLE === 'true';
const SOCKET = process.env.PRONUNCIATION_PG_SOCKET || '/tmp';
const PORT = process.env.PRONUNCIATION_PG_PORT || '5432';
const USER = process.env.PRONUNCIATION_PG_USER || process.env.USER || 'postgres';
const DATABASE = `alphascreen_pronunciation_${process.pid}`;
const ROOT = path.resolve(__dirname, '..');
const BOOTSTRAP = path.join(__dirname, 'fixtures', 'durable-otp-bootstrap.sql');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260812203858_pronunciation_registry_foundation_prod.sql');
const CORRECTION = path.join(ROOT, 'supabase', 'migrations', '20260812203904_pronunciation_ipa_correction_prod.sql');
const TARGETED_CORRECTION = path.join(ROOT, 'supabase', 'migrations', '20260812203909_pronunciation_targeted_phoneme_correction_prod.sql');
const GINGIVA_STRESS_CORRECTION = path.join(ROOT, 'supabase', 'migrations', '20260812203914_pronunciation_gingiva_stress_correction_prod.sql');
const GINGIVA_ALIAS_CORRECTION = path.join(ROOT, 'supabase', 'migrations', '20260812203918_pronunciation_gingiva_continuous_alias_prod.sql');

function command(name, args) {
  return spawnSync(name, args, { encoding: 'utf8' });
}

function args(database = DATABASE) {
  return ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', SOCKET, '-p', PORT, '-U', USER, '-d', database, '-At'];
}

function apply(filename) {
  const result = command('psql', [...args(), '-f', filename]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function sql(statement, { allowFailure = false } = {}) {
  const result = command('psql', [...args(), '-c', statement]);
  if (!allowFailure) assert.equal(result.status, 0, result.stderr || result.stdout);
  return { status: result.status, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
}

before(() => {
  if (!ENABLED) return;
  command('dropdb', ['-h', SOCKET, '-p', PORT, '-U', USER, '--if-exists', DATABASE]);
  const created = command('createdb', ['-h', SOCKET, '-p', PORT, '-U', USER, DATABASE]);
  assert.equal(created.status, 0, created.stderr);
  apply(BOOTSTRAP);
  apply(MIGRATION);
  apply(CORRECTION);
  apply(TARGETED_CORRECTION);
  apply(GINGIVA_STRESS_CORRECTION);
  apply(GINGIVA_ALIAS_CORRECTION);
});

after(() => {
  if (!ENABLED) return;
  command('dropdb', ['-h', SOCKET, '-p', PORT, '-U', USER, '--if-exists', DATABASE]);
});

test('migration replays idempotently and seeds only the reviewed verified subset', { skip: !ENABLED }, () => {
  apply(MIGRATION);
  apply(CORRECTION);
  apply(TARGETED_CORRECTION);
  apply(GINGIVA_STRESS_CORRECTION);
  apply(GINGIVA_ALIAS_CORRECTION);
  assert.equal(sql("select count(*)||'|'||count(*) filter(where verification_status='verified') from public.pronunciation_terms;").stdout, '9|9');
  assert.equal(sql("select count(*)||'|'||count(*) filter(where pronunciation_method='ipa') from public.pronunciation_terms where verification_status='verified';").stdout, '9|7');
  assert.equal(sql("select count(*) from public.pronunciation_terms where verification_status='verified' and version=2;").stdout, '6');
  assert.equal(sql("select string_agg(canonical_term,',' order by canonical_term) from public.pronunciation_terms where verification_status='verified' and version=3;").stdout, 'orthodontics,prophylaxis');
  assert.equal(sql("select string_agg(canonical_term,',' order by canonical_term) from public.pronunciation_terms where verification_status='verified' and version=5;").stdout, 'gingiva');
  assert.equal(sql("select pronunciation_method||'|'||pronunciation_value from public.pronunciation_terms where canonical_term='gingiva' and scope_type='industry' and industry_key='dental';").stdout, 'alias|jinjivuh');
});

test('registry and sync binding are private, RLS-enabled, and service-only', { skip: !ENABLED }, () => {
  assert.equal(sql("select relrowsecurity from pg_class where oid='public.pronunciation_terms'::regclass;").stdout, 't');
  assert.equal(sql("select relrowsecurity from pg_class where oid='public.pronunciation_dictionary_syncs'::regclass;").stdout, 't');
  assert.equal(sql("select has_table_privilege('anon','public.pronunciation_terms','select'),has_table_privilege('authenticated','public.pronunciation_terms','select'),has_table_privilege('service_role','public.pronunciation_terms','select,insert,update,delete');").stdout, 'f|f|t');
  assert.equal(sql("select has_table_privilege('anon','public.pronunciation_dictionary_syncs','select'),has_table_privilege('authenticated','public.pronunciation_dictionary_syncs','select'),has_table_privilege('service_role','public.pronunciation_dictionary_syncs','select,insert,update,delete');").stdout, 'f|f|t');
  for (const role of ['anon', 'authenticated']) {
    assert.notEqual(sql(`set role ${role}; select count(*) from public.pronunciation_terms;`, { allowFailure: true }).status, 0);
    assert.notEqual(sql(`set role ${role}; select count(*) from public.pronunciation_dictionary_syncs;`, { allowFailure: true }).status, 0);
  }
});

test('global, industry, and tenant terms can coexist without cross-client access', { skip: !ENABLED }, () => {
  sql(`set role service_role;
    insert into public.pronunciation_terms(canonical_term,normalized_term,pronunciation_method,pronunciation_value,scope_type,source,verification_status,verified_at)
      values ('SyntheticTerm','syntheticterm','alias','global','global','manual','verified',now());
    insert into public.pronunciation_terms(canonical_term,normalized_term,pronunciation_method,pronunciation_value,scope_type,industry_key,source,verification_status,verified_at)
      values ('SyntheticTerm','syntheticterm','alias','industry','industry','dental','manual','verified',now());
    insert into public.pronunciation_terms(canonical_term,normalized_term,pronunciation_method,pronunciation_value,scope_type,client_id,source,verification_status,verified_at)
      values ('SyntheticTerm','syntheticterm','alias','client','client','82000000-0000-4000-8000-000000000001','client_admin','verified',now());`);
  assert.equal(sql("select count(*) from public.pronunciation_terms where normalized_term='syntheticterm';").stdout, '3');
  assert.notEqual(sql("set role authenticated; select * from public.pronunciation_terms where client_id='82000000-0000-4000-8000-000000000001';", { allowFailure: true }).status, 0);
});

test('bounded states, scope binding, and provider identity uniqueness fail closed', { skip: !ENABLED }, () => {
  assert.notEqual(sql("insert into public.pronunciation_terms(canonical_term,normalized_term,pronunciation_method,pronunciation_value,scope_type,source,verification_status) values('bad','bad','alias','bad','industry','manual','verified');", { allowFailure: true }).status, 0);
  assert.notEqual(sql("insert into public.pronunciation_terms(canonical_term,normalized_term,pronunciation_method,pronunciation_value,scope_type,industry_key,source,verification_status) values('bad','bad','alias','bad','industry','','manual','suggested');", { allowFailure: true }).status, 0);
  assert.notEqual(sql("insert into public.pronunciation_terms(canonical_term,normalized_term,pronunciation_method,pronunciation_value,scope_type,industry_key,client_id,source,verification_status) values('bad','bad','alias','bad','client','dental','82000000-0000-4000-8000-000000000001','client_admin','suggested');", { allowFailure: true }).status, 0);
  sql("set role service_role; insert into public.pronunciation_dictionary_syncs(dictionary_key,environment,provider,provider_dictionary_id) values('one','production','tavus','provider-1');");
  assert.notEqual(sql("set role service_role; insert into public.pronunciation_dictionary_syncs(dictionary_key,environment,provider,provider_dictionary_id) values('two','production','tavus','provider-1');", { allowFailure: true }).status, 0);
});
