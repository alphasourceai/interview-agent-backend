'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');

const ENABLED = process.env.DURABLE_OTP_DISPOSABLE === 'true';
const SOCKET = process.env.DURABLE_OTP_PG_SOCKET || '/tmp';
const PORT = process.env.DURABLE_OTP_PG_PORT || '5432';
const USER = process.env.DURABLE_OTP_PG_USER || process.env.USER || 'postgres';
const DATABASE = `alphascreen_durable_otp_${process.pid}`;
const ROOT = path.resolve(__dirname, '..');
const BOOTSTRAP = path.join(__dirname, 'fixtures', 'durable-otp-bootstrap.sql');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260810191316_durable_otp_challenge_architecture_prod.sql');
const SINGLE_ACTIVE_MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260810191320_durable_otp_single_active_resource_prod.sql');

const FIXTURE = {
  candidate: '82000000-0000-4000-8000-000000000021',
  client: '82000000-0000-4000-8000-000000000001',
  role: '82000000-0000-4000-8000-000000000011',
  submission: '82000000-0000-4000-8000-000000000031',
  interview: '82000000-0000-4000-8000-000000000041',
  recovery: '82000000-0000-4000-8000-000000000051',
};

function args(database = DATABASE) {
  return ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', SOCKET, '-p', PORT, '-U', USER, '-d', database, '-At'];
}

function command(name, commandArgs) {
  return spawnSync(name, commandArgs, { encoding: 'utf8' });
}

function sql(statement, { allowFailure = false } = {}) {
  const result = command('psql', [...args(), '-c', statement]);
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

function apply(filename) {
  const result = command('psql', [...args(), '-f', filename]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function issue(challengeId, bindingFingerprint, verifier = 'a', submissionId = FIXTURE.submission) {
  return `set role service_role; select challenge_id from public.service_issue_otp_challenge(
    '${challengeId}','interview_access','email',1::smallint,repeat('${verifier}',64),repeat('${bindingFingerprint}',64),
    '${FIXTURE.candidate}','${FIXTURE.client}','${FIXTURE.role}','${submissionId}',
    '${FIXTURE.interview}','${FIXTURE.recovery}',repeat('c',64),600,5,'pending');`;
}

before(() => {
  if (!ENABLED) return;
  command('dropdb', ['-h', SOCKET, '-p', PORT, '-U', USER, '--if-exists', DATABASE]);
  const created = command('createdb', ['-h', SOCKET, '-p', PORT, '-U', USER, DATABASE]);
  assert.equal(created.status, 0, created.stderr);
  apply(BOOTSTRAP);
  apply(MIGRATION);
  apply(SINGLE_ACTIVE_MIGRATION);
});

after(() => {
  if (!ENABLED) return;
  command('dropdb', ['-h', SOCKET, '-p', PORT, '-U', USER, '--if-exists', DATABASE]);
});

test('migration redacts every retained legacy plaintext OTP without changing its row count', { skip: !ENABLED }, () => {
  assert.equal(sql("select count(*)||'|'||min(code)||'|'||bool_and(used and invalidated_at is not null) from public.otp_tokens;").stdout, '1|[removed]|true');
});

test('private schema and table are inaccessible to client roles', { skip: !ENABLED }, () => {
  assert.equal(sql("select has_schema_privilege('anon','private_auth','USAGE'),has_schema_privilege('authenticated','private_auth','USAGE'),has_schema_privilege('service_role','private_auth','USAGE');").stdout, 'f|f|f');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.notEqual(sql(`set role ${role}; select count(*) from private_auth.otp_challenges;`, { allowFailure: true }).status, 0);
  }
});

test('service wrappers are executable only by service_role among application roles', { skip: !ENABLED }, () => {
  assert.equal(sql("select has_function_privilege('anon','public.service_consume_otp_challenge(uuid,boolean)','EXECUTE'),has_function_privilege('authenticated','public.service_consume_otp_challenge(uuid,boolean)','EXECUTE'),has_function_privilege('service_role','public.service_consume_otp_challenge(uuid,boolean)','EXECUTE');").stdout, 'f|f|t');
});

test('OTP table and boundary functions have explicit postgres ownership, SECURITY DEFINER, and an empty safe search_path', { skip: !ENABLED }, () => {
  assert.equal(sql("select pg_get_userbyid(c.relowner) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private_auth' and c.relname='otp_challenges';").stdout, 'postgres');
  assert.equal(sql("select bool_and(pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and p.proconfig @> array['search_path=\"\"']) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='private_auth' or (n.nspname='public' and p.proname like 'service%otp%')); ").stdout, 't');
});

test('concurrent resend issuance leaves exactly one active challenge', { skip: !ENABLED }, async () => {
  const first = issue('82000000-0000-4000-8000-000000000061', 'b', 'a');
  const second = issue('82000000-0000-4000-8000-000000000062', 'b', 'd');
  const results = await Promise.all([sqlAsync(first), sqlAsync(second)]);
  assert.deepEqual(results.map((result) => result.status), [0, 0], results.map((result) => result.stderr).join('\n'));
  assert.equal(sql("select count(*) filter(where consumed_at is null and superseded_at is null)||'|'||count(*) filter(where superseded_at is not null) from private_auth.otp_challenges where binding_fingerprint=repeat('b',64);").stdout, '1|1');
});

test('superseded OTP challenge cannot be consumed', { skip: !ENABLED }, () => {
  const oldId = sql("select challenge_id from private_auth.otp_challenges where binding_fingerprint=repeat('b',64) and superseded_at is not null;").stdout;
  assert.match(sql(`set role service_role; select status from public.service_consume_otp_challenge('${oldId}',true);`).stdout, /^superseded$/);
});

test('two simultaneous correct verifications produce one consume and one replay rejection', { skip: !ENABLED }, async () => {
  const activeId = sql("select challenge_id from private_auth.otp_challenges where binding_fingerprint=repeat('b',64) and superseded_at is null;").stdout;
  const statement = `set role service_role; select status from public.service_consume_otp_challenge('${activeId}',true);`;
  const results = await Promise.all([sqlAsync(statement), sqlAsync(statement)]);
  assert.deepEqual(results.map((result) => result.status), [0, 0]);
  assert.deepEqual(results.map((result) => result.stdout.split('\n').at(-1)).sort(), ['consumed', 'verified']);
  assert.equal(sql(`select consumed_at is not null from private_auth.otp_challenges where challenge_id='${activeId}';`).stdout, 't');
});

test('successful atomic consume updates only the bound candidate verification state', { skip: !ENABLED }, () => {
  assert.equal(sql(`select verified||'|'||(otp_verified_at is not null) from public.candidates where id='${FIXTURE.candidate}';`).stdout, 'true|true');
  assert.equal(sql("select verified from public.candidates where id='82000000-0000-4000-8000-000000000022';").stdout, 'f');
});

test('renewed submission binding supersedes the prior active resource challenge', { skip: !ENABLED }, () => {
  sql(issue('82000000-0000-4000-8000-000000000067', '7', '7'));
  sql(issue('82000000-0000-4000-8000-000000000068', '8', '8', '82000000-0000-4000-8000-000000000033'));
  assert.equal(
    sql(`select count(*) filter(where consumed_at is null and superseded_at is null)||'|'||count(*) filter(where superseded_at is not null)
         from private_auth.otp_challenges
         where challenge_id in ('82000000-0000-4000-8000-000000000067','82000000-0000-4000-8000-000000000068');`).stdout,
    '1|1',
  );
  assert.equal(
    sql("select superseded_reason from private_auth.otp_challenges where challenge_id='82000000-0000-4000-8000-000000000067';").stdout,
    'resource_replaced',
  );
});

test('failed attempts are atomic and the configured fifth failure locks the challenge', { skip: !ENABLED }, () => {
  sql(issue('82000000-0000-4000-8000-000000000063', 'e', 'e'));
  const statuses = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    statuses.push(sql("set role service_role; select status from public.service_consume_otp_challenge('82000000-0000-4000-8000-000000000063',false);").stdout);
  }
  assert.deepEqual(statuses, ['invalid', 'invalid', 'invalid', 'invalid', 'attempts_exhausted']);
  assert.equal(sql("select attempt_count||'|'||(superseded_at is not null) from private_auth.otp_challenges where challenge_id='82000000-0000-4000-8000-000000000063';").stdout, '5|true');
});

test('database-authoritative expiry rejects an otherwise matching challenge', { skip: !ENABLED }, () => {
  sql(issue('82000000-0000-4000-8000-000000000064', 'f', 'f'));
  sql("update private_auth.otp_challenges set expires_at=statement_timestamp()-interval '1 second' where challenge_id='82000000-0000-4000-8000-000000000064';");
  assert.equal(sql("set role service_role; select status from public.service_consume_otp_challenge('82000000-0000-4000-8000-000000000064',true);").stdout, 'expired');
});

test('cross-client candidate/role binding is rejected before insertion', { skip: !ENABLED }, () => {
  const statement = "set role service_role; select * from public.service_issue_otp_challenge('82000000-0000-4000-8000-000000000065','interview_access','email',1::smallint,repeat('a',64),repeat('9',64),'82000000-0000-4000-8000-000000000021','82000000-0000-4000-8000-000000000002','82000000-0000-4000-8000-000000000012',null,null,null,repeat('c',64),600,5,'pending');";
  assert.notEqual(sql(statement, { allowFailure: true }).status, 0);
  assert.equal(sql("select count(*) from private_auth.otp_challenges where challenge_id='82000000-0000-4000-8000-000000000065';").stdout, '0');
});

test('migration replay is catalog-safe and does not duplicate policies or indexes', { skip: !ENABLED }, () => {
  apply(MIGRATION);
  apply(SINGLE_ACTIVE_MIGRATION);
  assert.equal(sql("select count(*) from pg_indexes where schemaname='private_auth' and tablename='otp_challenges';").stdout, '4');
  assert.equal(sql("select count(*) from pg_policies where schemaname='private_auth' and tablename='otp_challenges';").stdout, '0');
});
