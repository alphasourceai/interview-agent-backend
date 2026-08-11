'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { after, before, beforeEach, test } = require('node:test');

const ENABLED = process.env.SUPPORT_VOICE_DISPOSABLE === 'true';
const SOCKET = process.env.SUPPORT_VOICE_PG_SOCKET || '/tmp';
const PORT = process.env.SUPPORT_VOICE_PG_PORT || '5432';
const USER = process.env.SUPPORT_VOICE_PG_USER || process.env.USER || 'postgres';
const DATABASE = `alphascreen_support_voice_${process.pid}`;
const MIGRATION = path.join(__dirname, '..', 'supabase', 'migrations', '20260811232000_durable_support_voice_sessions_prod.sql');

const sessionId = (index) => String(index).padStart(22, 'A').slice(-22);
const hex64 = (index) => Number(index).toString(16).padStart(64, '0');

function args(database = DATABASE) {
  return ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', SOCKET, '-p', PORT, '-U', USER, '-d', database, '-At'];
}

function command(name, commandArgs) {
  return spawnSync(name, commandArgs, { encoding: 'utf8' });
}

function sql(statement, { allowFailure = false, database = DATABASE } = {}) {
  const result = command('psql', [...args(database), '-c', statement]);
  if (!allowFailure) assert.equal(result.status, 0, result.stderr || result.stdout);
  return { status: result.status, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
}

function sqlAsync(statement) {
  return new Promise((resolve) => {
    const child = spawn('psql', [...args(), '-c', statement]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function apply() {
  const result = command('psql', [...args(), '-f', MIGRATION]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function reserve(index, user = 101) {
  return `set role service_role; select status from public.service_reserve_support_voice_session('${sessionId(index)}','${hex64(index)}','${hex64(user)}');`;
}

before(() => {
  if (!ENABLED) return;
  command('dropdb', ['-h', SOCKET, '-p', PORT, '-U', USER, '--if-exists', DATABASE]);
  const created = command('createdb', ['-h', SOCKET, '-p', PORT, '-U', USER, DATABASE]);
  assert.equal(created.status, 0, created.stderr);
  sql(`do $$ begin
    if not exists (select 1 from pg_roles where rolname='postgres') then create role postgres superuser; end if;
    if not exists (select 1 from pg_roles where rolname='anon') then create role anon noinherit; end if;
    if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated noinherit; end if;
    if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role noinherit; end if;
  end $$;`, { database: DATABASE });
  apply();
});

beforeEach(() => {
  if (!ENABLED) return;
  sql('truncate table private_support.support_voice_sessions;');
});

after(() => {
  if (!ENABLED) return;
  command('dropdb', ['-h', SOCKET, '-p', PORT, '-U', USER, '--if-exists', DATABASE]);
});

test('dedicated schema/table are inaccessible to every application role', { skip: !ENABLED }, () => {
  assert.equal(sql("select has_schema_privilege('anon','private_support','USAGE'),has_schema_privilege('authenticated','private_support','USAGE'),has_schema_privilege('service_role','private_support','USAGE');").stdout, 'f|f|f');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.notEqual(sql(`set role ${role}; select count(*) from private_support.support_voice_sessions;`, { allowFailure: true }).status, 0);
  }
  assert.equal(sql("select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private_support' and c.relname='support_voice_sessions';").stdout, 't');
  assert.equal(sql("select count(*) from pg_policies where schemaname='private_support' and tablename='support_voice_sessions';").stdout, '0');
});

test('only service_role can execute public wrappers and every boundary is hardened', { skip: !ENABLED }, () => {
  assert.equal(sql("select has_function_privilege('public','public.service_support_voice_session_health()','EXECUTE'),has_function_privilege('anon','public.service_support_voice_session_health()','EXECUTE'),has_function_privilege('authenticated','public.service_support_voice_session_health()','EXECUTE'),has_function_privilege('service_role','public.service_support_voice_session_health()','EXECUTE');").stdout, 'f|f|f|t');
  assert.equal(sql("select bool_and(pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and p.proconfig @> array['search_path=\"\"']) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('private_support','public') and (n.nspname='private_support' or p.proname like 'service%support_voice%');").stdout, 't');
  assert.equal(sql("select pg_get_userbyid(c.relowner) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private_support' and c.relname='support_voice_sessions';").stdout, 'postgres');
});

test('same-user concurrent reserves serialize to one created and one conflict', { skip: !ENABLED }, async () => {
  const results = await Promise.all([sqlAsync(reserve(1, 101)), sqlAsync(reserve(2, 101))]);
  assert.deepEqual(results.map((result) => result.status), [0, 0], results.map((result) => result.stderr).join('\n'));
  assert.deepEqual(results.map((result) => result.stdout.split('\n').at(-1)).sort(), ['conflict', 'created']);
  assert.equal(sql("select count(*) from private_support.support_voice_sessions where phase in ('pending','active');").stdout, '1');
});

test('global capacity remains exactly twenty under concurrent reserve pressure', { skip: !ENABLED }, async () => {
  const results = await Promise.all(Array.from({ length: 21 }, (_, index) => sqlAsync(reserve(index + 1, 1000 + index))));
  assert.ok(results.every((result) => result.status === 0), results.map((result) => result.stderr).join('\n'));
  const statuses = results.map((result) => result.stdout.split('\n').at(-1));
  assert.equal(statuses.filter((status) => status === 'created').length, 20);
  assert.equal(statuses.filter((status) => status === 'capacity').length, 1);
});

test('one credential is consumed once even through concurrent RPC calls', { skip: !ENABLED }, async () => {
  assert.equal(sql(reserve(1, 101)).stdout, 'created');
  const statement = `set role service_role; select status from public.service_consume_support_voice_session('${hex64(1)}');`;
  const results = await Promise.all([sqlAsync(statement), sqlAsync(statement)]);
  assert.deepEqual(results.map((result) => result.status), [0, 0]);
  assert.deepEqual(results.map((result) => result.stdout.split('\n').at(-1)).sort(), ['consumed', 'invalid']);
  assert.equal(sql("select phase||'|'||(credential_digest is null)||'|'||(consumed_at is not null) from private_support.support_voice_sessions;").stdout, 'active|true|true');
});

test('database owns pending and active TTLs and closes expired credentials', { skip: !ENABLED }, () => {
  assert.equal(sql(reserve(1, 101)).stdout, 'created');
  const pendingSeconds = Number(sql("select extract(epoch from expires_at-created_at)::integer from private_support.support_voice_sessions;").stdout);
  assert.ok(pendingSeconds >= 59 && pendingSeconds <= 61);
  assert.equal(sql(`set role service_role; select status from public.service_consume_support_voice_session('${hex64(1)}');`).stdout, 'consumed');
  const activeSeconds = Number(sql("select extract(epoch from expires_at-consumed_at)::integer from private_support.support_voice_sessions;").stdout);
  assert.ok(activeSeconds >= 599 && activeSeconds <= 601);

  sql("update private_support.support_voice_sessions set phase='pending',credential_digest=decode(repeat('2',64),'hex'),consumed_at=null,expires_at=clock_timestamp()-interval '1 second' where session_id='AAAAAAAAAAAAAAAAAAAAA1';");
  assert.equal(sql(`set role service_role; select status from public.service_consume_support_voice_session('${'2'.repeat(64)}');`).stdout, 'expired');
  assert.equal(sql("select phase||'|'||(credential_digest is null)||'|'||close_reason from private_support.support_voice_sessions;").stdout, 'closed|true|expired');
});

test('close and close-pending are idempotent and scope-safe', { skip: !ENABLED }, () => {
  assert.equal(sql(reserve(1, 101)).stdout, 'created');
  assert.equal(sql("set role service_role; select status from public.service_close_support_voice_session('AAAAAAAAAAAAAAAAAAAAA1','ended');").stdout, 'closed');
  assert.equal(sql("set role service_role; select status from public.service_close_support_voice_session('AAAAAAAAAAAAAAAAAAAAA1','ended');").stdout, 'closed');
  assert.equal(sql(reserve(2, 102)).stdout, 'created');
  assert.equal(sql(`set role service_role; select public.service_close_pending_support_voice_sessions('${hex64(101)}','abandoned');`).stdout, '0');
  assert.equal(sql(`set role service_role; select public.service_close_pending_support_voice_sessions('${hex64(102)}','abandoned');`).stdout, '1');
});

test('invalid identifiers and reasons fail before mutation', { skip: !ENABLED }, () => {
  assert.notEqual(sql("set role service_role; select * from public.service_reserve_support_voice_session('bad',repeat('a',64),repeat('b',64));", { allowFailure: true }).status, 0);
  assert.equal(sql('select count(*) from private_support.support_voice_sessions;').stdout, '0');
  assert.equal(sql(reserve(1, 101)).stdout, 'created');
  assert.notEqual(sql("set role service_role; select * from public.service_close_support_voice_session('AAAAAAAAAAAAAAAAAAAAA1','arbitrary');", { allowFailure: true }).status, 0);
  assert.equal(sql("select phase from private_support.support_voice_sessions;").stdout, 'pending');
});

test('migration replay is catalog-safe and preserves exact policy/index counts', { skip: !ENABLED }, () => {
  apply();
  assert.equal(sql("select count(*) from pg_indexes where schemaname='private_support' and tablename='support_voice_sessions';").stdout, '4');
  assert.equal(sql("select count(*) from pg_policies where schemaname='private_support' and tablename='support_voice_sessions';").stdout, '0');
  assert.equal(sql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'service%support_voice%';").stdout, '5');
});
