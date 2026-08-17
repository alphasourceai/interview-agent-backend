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
const SMS_B_MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260817201934_sms_b_e164_cross_channel_foundation_prod.sql');
const SMS_C0_RPC_MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260817201935_sms_c0_provider_delivery_recording_rpc_prod.sql');
const SMS_C1_CALLBACK_MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260817201937_sms_c1_provider_delivery_callback_rpc_prod.sql');
let preFixCrossChannelActiveCount = null;

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

function issuePreFix(challengeId, channel, bindingFingerprint, verifier = 'a') {
  return `set role service_role; select challenge_id from public.service_issue_otp_challenge(
    '${challengeId}','interview_access','${channel}',1::smallint,repeat('${verifier}',64),repeat('${bindingFingerprint}',64),
    '${FIXTURE.candidate}','${FIXTURE.client}','${FIXTURE.role}','${FIXTURE.submission}',
    '${FIXTURE.interview}','${FIXTURE.recovery}',repeat('c',64),600,5,'pending');`;
}

function issueSms(challengeId, bindingFingerprint, verifier = 'a') {
  return `set role service_role; select challenge_id from public.service_issue_sms_otp_challenge(
    '${challengeId}','interview_access',1::smallint,repeat('${verifier}',64),repeat('${bindingFingerprint}',64),
    '${FIXTURE.candidate}','${FIXTURE.client}','${FIXTURE.role}','${FIXTURE.submission}',
    '${FIXTURE.interview}','${FIXTURE.recovery}',repeat('d',64),600,5,'pending',
    statement_timestamp(),'sms-qa-v1');`;
}

before(() => {
  if (!ENABLED) return;
  command('dropdb', ['-h', SOCKET, '-p', PORT, '-U', USER, '--if-exists', DATABASE]);
  const created = command('createdb', ['-h', SOCKET, '-p', PORT, '-U', USER, DATABASE]);
  assert.equal(created.status, 0, created.stderr);
  apply(BOOTSTRAP);
  apply(MIGRATION);
  apply(SINGLE_ACTIVE_MIGRATION);
  sql(issuePreFix('82000000-0000-4000-8000-000000000071', 'email', '1', '1'));
  sql(issuePreFix('82000000-0000-4000-8000-000000000072', 'sms', '2', '2'));
  preFixCrossChannelActiveCount = Number(sql(`select count(*) from private_auth.otp_challenges
    where challenge_id in ('82000000-0000-4000-8000-000000000071','82000000-0000-4000-8000-000000000072')
      and consumed_at is null and superseded_at is null;`).stdout);
  apply(SMS_B_MIGRATION);
  apply(SMS_C0_RPC_MIGRATION);
  apply(SMS_C1_CALLBACK_MIGRATION);
});

after(() => {
  if (!ENABLED) return;
  command('dropdb', ['-h', SOCKET, '-p', PORT, '-U', USER, '--if-exists', DATABASE]);
});

test('migration redacts every retained legacy plaintext OTP without changing its row count', { skip: !ENABLED }, () => {
  assert.equal(sql("select count(*)||'|'||min(code)||'|'||bool_and(used and invalidated_at is not null) from public.otp_tokens;").stdout, '1|[removed]|true');
});

test('pre-fix catalog permits one active email and one active SMS challenge for one resource', { skip: !ENABLED }, () => {
  assert.equal(preFixCrossChannelActiveCount, 2);
});

test('SMS-B upgrade deterministically collapses a pre-existing cross-channel dual-active resource', { skip: !ENABLED }, () => {
  assert.equal(
    sql(`select count(*) filter(where consumed_at is null and superseded_at is null)||'|'||
                count(*) filter(where superseded_at is not null and superseded_reason='cross_channel_replaced')
         from private_auth.otp_challenges
         where challenge_id in ('82000000-0000-4000-8000-000000000071','82000000-0000-4000-8000-000000000072');`).stdout,
    '1|1',
  );
});

test('private schema and table are inaccessible to client roles', { skip: !ENABLED }, () => {
  assert.equal(sql("select has_schema_privilege('anon','private_auth','USAGE'),has_schema_privilege('authenticated','private_auth','USAGE'),has_schema_privilege('service_role','private_auth','USAGE');").stdout, 'f|f|f');
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.notEqual(sql(`set role ${role}; select count(*) from private_auth.otp_challenges;`, { allowFailure: true }).status, 0);
    assert.notEqual(sql(`set role ${role}; select count(*) from private_auth.sms_destination_suppressions;`, { allowFailure: true }).status, 0);
  }
});

test('service wrappers are executable only by service_role among application roles', { skip: !ENABLED }, () => {
  assert.equal(sql("select has_function_privilege('anon','public.service_consume_otp_challenge(uuid,boolean)','EXECUTE'),has_function_privilege('authenticated','public.service_consume_otp_challenge(uuid,boolean)','EXECUTE'),has_function_privilege('service_role','public.service_consume_otp_challenge(uuid,boolean)','EXECUTE');").stdout, 'f|f|t');
  assert.equal(sql("select has_function_privilege('anon','public.service_is_sms_destination_suppressed(text,text)','EXECUTE'),has_function_privilege('authenticated','public.service_is_sms_destination_suppressed(text,text)','EXECUTE'),has_function_privilege('service_role','public.service_is_sms_destination_suppressed(text,text)','EXECUTE');").stdout, 'f|f|t');
});

test('final active-resource index excludes channel and preserves the accepted active predicate', { skip: !ENABLED }, () => {
  assert.equal(sql("select pg_get_indexdef(indexrelid) from pg_index where indexrelid='private_auth.otp_challenges_one_active_resource_uidx'::regclass;").stdout,
    'CREATE UNIQUE INDEX otp_challenges_one_active_resource_uidx ON private_auth.otp_challenges USING btree (purpose, candidate_id, client_id, role_id) WHERE ((consumed_at IS NULL) AND (superseded_at IS NULL))');
});

test('legacy issuance boundary cannot issue SMS without consent evidence', { skip: !ENABLED }, () => {
  assert.notEqual(sql(issuePreFix('82000000-0000-4000-8000-000000000073', 'sms', '3', '3'), { allowFailure: true }).status, 0);
  assert.equal(sql("select count(*) from private_auth.otp_challenges where challenge_id='82000000-0000-4000-8000-000000000073';").stdout, '0');
});

test('email to SMS and SMS to email each supersede the prior channel immediately', { skip: !ENABLED }, () => {
  sql(issue('82000000-0000-4000-8000-000000000074', '4', '4'));
  sql(issueSms('82000000-0000-4000-8000-000000000075', '5', '5'));
  assert.equal(sql("select channel||'|'||(superseded_at is not null) from private_auth.otp_challenges where challenge_id='82000000-0000-4000-8000-000000000074';").stdout, 'email|true');
  assert.equal(sql("select channel||'|'||(superseded_at is null) from private_auth.otp_challenges where challenge_id='82000000-0000-4000-8000-000000000075';").stdout, 'sms|true');
  sql(issue('82000000-0000-4000-8000-000000000076', '6', '6'));
  assert.equal(sql("select channel||'|'||(superseded_at is not null) from private_auth.otp_challenges where challenge_id='82000000-0000-4000-8000-000000000075';").stdout, 'sms|true');
  assert.equal(sql("select count(*) from private_auth.otp_challenges where candidate_id='82000000-0000-4000-8000-000000000021' and consumed_at is null and superseded_at is null;").stdout, '1');
});

test('all concurrent email/SMS permutations leave exactly one active resource challenge', { skip: !ENABLED }, async () => {
  const cases = [
    [issue('82000000-0000-4000-8000-000000000081', 'a', 'a'), issueSms('82000000-0000-4000-8000-000000000082', 'b', 'b')],
    [issueSms('82000000-0000-4000-8000-000000000083', 'c', 'c'), issue('82000000-0000-4000-8000-000000000084', 'd', 'd')],
    [issue('82000000-0000-4000-8000-000000000085', 'e', 'e'), issue('82000000-0000-4000-8000-000000000086', 'f', 'f')],
    [issueSms('82000000-0000-4000-8000-000000000087', '1', '1'), issueSms('82000000-0000-4000-8000-000000000088', '2', '2')],
  ];
  for (const pair of cases) {
    const results = await Promise.all(pair.map(sqlAsync));
    assert.deepEqual(results.map((result) => result.status), [0, 0], results.map((result) => result.stderr).join('\n'));
    assert.equal(sql("select count(*) from private_auth.otp_challenges where candidate_id='82000000-0000-4000-8000-000000000021' and consumed_at is null and superseded_at is null;").stdout, '1');
  }
});

test('old cross-channel challenges remain invalid and late delivery telemetry cannot unsupersede them', { skip: !ENABLED }, () => {
  sql(issue('82000000-0000-4000-8000-000000000089', '3', '3'));
  sql(issueSms('82000000-0000-4000-8000-000000000090', '4', '4'));
  assert.equal(sql("set role service_role; select status from public.service_consume_otp_challenge('82000000-0000-4000-8000-000000000089',true);").stdout, 'superseded');
  sql("update private_auth.otp_challenges set provider='provider_a',provider_message_id='late-message',provider_delivery_status='delivered',delivered_at=statement_timestamp() where challenge_id='82000000-0000-4000-8000-000000000089';");
  assert.equal(sql("select (superseded_at is not null)||'|'||provider_delivery_status from private_auth.otp_challenges where challenge_id='82000000-0000-4000-8000-000000000089';").stdout, 'true|delivered');
});

test('provider message binding is generic, unique when present, and nullable before send', { skip: !ENABLED }, () => {
  assert.equal(sql("select count(*) from private_auth.otp_challenges where provider_message_id is null;").stdout > '0', true);
  sql("update private_auth.otp_challenges set provider='provider_b',provider_message_id='external-1' where challenge_id='82000000-0000-4000-8000-000000000090';");
  assert.notEqual(sql("update private_auth.otp_challenges set provider='provider_b',provider_message_id='external-1' where challenge_id='82000000-0000-4000-8000-000000000089';", { allowFailure: true }).status, 0);
});

test('trusted SMS metadata boundary records requested and accepted events idempotently', { skip: !ENABLED }, () => {
  sql(issueSms('82000000-0000-4000-8000-000000000091', '5', '5'));
  assert.match(
    sql("set role service_role; select provider||'|'||(send_requested_at is not null) from public.service_record_otp_sms_delivery_metadata('82000000-0000-4000-8000-000000000091','send_requested','provider_c',null,null,null);").stdout,
    /^provider_c\|true$/,
  );
  const accepted = sql("set role service_role; select provider||'|'||provider_message_id||'|'||provider_delivery_status||'|'||(provider_accepted_at is not null) from public.service_record_otp_sms_delivery_metadata('82000000-0000-4000-8000-000000000091','provider_accepted','provider_c','opaque-message-1','queued',null);").stdout;
  assert.equal(accepted, 'provider_c|opaque-message-1|queued|true');
  assert.equal(
    sql("set role service_role; select provider||'|'||provider_message_id||'|'||provider_delivery_status||'|'||(provider_accepted_at is not null) from public.service_record_otp_sms_delivery_metadata('82000000-0000-4000-8000-000000000091','provider_accepted','provider_c','opaque-message-1','queued',null);").stdout,
    accepted,
  );
});

test('provider and provider-message bindings are immutable and globally unique', { skip: !ENABLED }, () => {
  assert.notEqual(sql("set role service_role; select * from public.service_record_otp_sms_delivery_metadata('82000000-0000-4000-8000-000000000091','provider_accepted','provider_c','different-message','queued',null);", { allowFailure: true }).status, 0);
  assert.notEqual(sql("set role service_role; select * from public.service_record_otp_sms_delivery_metadata('82000000-0000-4000-8000-000000000091','send_requested','different_provider',null,null,null);", { allowFailure: true }).status, 0);
  sql(issueSms('82000000-0000-4000-8000-000000000092', '6', '6'));
  sql("set role service_role; select * from public.service_record_otp_sms_delivery_metadata('82000000-0000-4000-8000-000000000092','send_requested','provider_c',null,null,null);");
  assert.notEqual(sql("set role service_role; select * from public.service_record_otp_sms_delivery_metadata('82000000-0000-4000-8000-000000000092','provider_accepted','provider_c','opaque-message-1','queued',null);", { allowFailure: true }).status, 0);
});

test('trusted metadata input is strictly bounded and rejects raw provider text', { skip: !ENABLED }, () => {
  const calls = [
    "'82000000-0000-4000-8000-000000000092','send_requested','',null,null,null",
    "'82000000-0000-4000-8000-000000000092','send_requested',repeat('a',41),null,null,null",
    "'82000000-0000-4000-8000-000000000092','send_requested','Provider A',null,null,null",
    "'82000000-0000-4000-8000-000000000092','provider_accepted','provider_c','', 'queued',null",
    "'82000000-0000-4000-8000-000000000092','provider_accepted','provider_c',repeat('m',256),'queued',null",
    "'82000000-0000-4000-8000-000000000092','provider_accepted','provider_c',E'message\\nraw','queued',null",
    "'82000000-0000-4000-8000-000000000092','send_outcome','provider_c',null,'failed','raw provider response body'",
  ];
  for (const args of calls) {
    assert.notEqual(sql(`set role service_role; select * from public.service_record_otp_sms_delivery_metadata(${args});`, { allowFailure: true }).status, 0, args);
  }
});

test('bounded send outcomes are accepted with deterministic normalized status', { skip: !ENABLED }, () => {
  const cases = [
    ['93', 'invalid_destination', 'rejected', true],
    ['94', 'blocked_destination', 'rejected', true],
    ['95', 'provider_rejected', 'rejected', true],
    ['96', 'transient_preacceptance', 'failed', true],
    ['97', 'misconfigured', 'failed', true],
    ['98', 'ambiguous_outcome', null, false],
  ];
  for (const [suffix, category, status, failedAtExpected] of cases) {
    const id = `82000000-0000-4000-8000-0000000000${suffix}`;
    sql(issueSms(id, suffix[0], suffix[0]));
    sql(`set role service_role; select * from public.service_record_otp_sms_delivery_metadata('${id}','send_requested','provider_d',null,null,null);`);
    const statusSql = status == null ? 'null' : `'${status}'`;
    assert.equal(
      sql(`set role service_role; select coalesce(provider_delivery_status,'NULL')||'|'||failure_category||'|'||(failed_at is not null) from public.service_record_otp_sms_delivery_metadata('${id}','send_outcome','provider_d',null,${statusSql},'${category}');`).stdout,
      `${status || 'NULL'}|${category}|${failedAtExpected}`,
    );
  }
});

test('delivery metadata cannot mutate any challenge authentication authority', { skip: !ENABLED }, () => {
  const id = '82000000-0000-4000-8000-000000000099';
  sql(issueSms(id, '9', '9'));
  const authority = `select json_build_object(
    'verifier',encode(verifier_hmac,'hex'),'pepper',pepper_version,'purpose',purpose,'channel',channel,
    'candidate',candidate_id,'client',client_id,'role',role_id,'submission',submission_id,
    'interview',interview_attempt_id,'recovery',recovery_authorization_id,'expires',expires_at,
    'attempts',attempt_count,'max',max_attempts,'consumed',consumed_at,'superseded',superseded_at,
    'destination',destination_fingerprint)::text from private_auth.otp_challenges where challenge_id='${id}';`;
  const before = sql(authority).stdout;
  sql(`set role service_role; select * from public.service_record_otp_sms_delivery_metadata('${id}','send_requested','provider_e',null,null,null);`);
  sql(`set role service_role; select * from public.service_record_otp_sms_delivery_metadata('${id}','provider_accepted','provider_e','authority-message','queued',null);`);
  assert.equal(sql(authority).stdout, before);
  assert.equal(sql(`select consumed_at is null and superseded_at is null and attempt_count=0 from private_auth.otp_challenges where challenge_id='${id}';`).stdout, 't');
});

test('late telemetry preserves expired, superseded, and consumed terminal state', { skip: !ENABLED }, () => {
  const expired = '82000000-0000-4000-8000-000000000101';
  sql(issueSms(expired, 'a', 'a'));
  sql(`update private_auth.otp_challenges set expires_at=statement_timestamp()-interval '1 second' where challenge_id='${expired}';`);
  sql(`set role service_role; select * from public.service_record_otp_sms_delivery_metadata('${expired}','send_requested','provider_f',null,null,null);`);
  assert.equal(sql(`set role service_role; select status from public.service_consume_otp_challenge('${expired}',true);`).stdout, 'expired');

  const superseded = '82000000-0000-4000-8000-000000000102';
  sql(issueSms(superseded, 'b', 'b'));
  sql(issueSms('82000000-0000-4000-8000-000000000103', 'c', 'c'));
  sql(`set role service_role; select * from public.service_record_otp_sms_delivery_metadata('${superseded}','send_requested','provider_f',null,null,null);`);
  assert.equal(sql(`select superseded_at is not null from private_auth.otp_challenges where challenge_id='${superseded}';`).stdout, 't');

  const consumed = '82000000-0000-4000-8000-000000000104';
  sql(issueSms(consumed, 'd', 'd'));
  assert.match(sql(`set role service_role; select status from public.service_consume_otp_challenge('${consumed}',true);`).stdout, /^(verified|consumed)$/);
  sql(`set role service_role; select * from public.service_record_otp_sms_delivery_metadata('${consumed}','send_requested','provider_f',null,null,null);`);
  assert.equal(sql(`select consumed_at is not null from private_auth.otp_challenges where challenge_id='${consumed}';`).stdout, 't');
});

test('new metadata functions retain exact owner, search path, and service-only execution', { skip: !ENABLED }, () => {
  const signature = 'public.service_record_otp_sms_delivery_metadata(uuid,text,text,text,text,text)';
  assert.equal(sql(`select has_function_privilege('anon','${signature}','EXECUTE'),has_function_privilege('authenticated','${signature}','EXECUTE'),has_function_privilege('service_role','${signature}','EXECUTE');`).stdout, 'f|f|t');
  assert.equal(sql("select coalesce(bool_or(x.grantee=0),false) from pg_proc p cross join lateral aclexplode(p.proacl) x where p.oid='public.service_record_otp_sms_delivery_metadata(uuid,text,text,text,text,text)'::regprocedure;").stdout, 'f');
  assert.equal(sql("select bool_and(pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and p.proconfig @> array['search_path=\"\"']) from pg_proc p where p.oid in ('private_auth.record_otp_sms_delivery_metadata(uuid,text,text,text,text,text)'::regprocedure,'public.service_record_otp_sms_delivery_metadata(uuid,text,text,text,text,text)'::regprocedure);").stdout, 't');
  assert.equal(sql("select has_function_privilege('service_role','private_auth.record_otp_sms_delivery_metadata(uuid,text,text,text,text,text)','EXECUTE');").stdout, 'f');
  assert.notEqual(sql("set role service_role; update private_auth.otp_challenges set provider='bypass';", { allowFailure: true }).status, 0);
});

test('delivery callback boundary is service-only, private, and provider-neutral', { skip: !ENABLED }, () => {
  const signature = 'public.service_record_otp_sms_delivery_event(text,text,text,timestamptz,text)';
  assert.equal(sql(`select has_function_privilege('anon','${signature}','EXECUTE'),has_function_privilege('authenticated','${signature}','EXECUTE'),has_function_privilege('service_role','${signature}','EXECUTE');`).stdout, 'f|f|t');
  assert.equal(sql("select has_function_privilege('service_role','private_auth.record_otp_sms_delivery_event(text,text,text,timestamptz,text)','EXECUTE');").stdout, 'f');
  assert.equal(sql("select bool_and(pg_get_userbyid(p.proowner)='postgres' and p.prosecdef and p.proconfig @> array['search_path=\"\"']) from pg_proc p where p.oid in ('private_auth.record_otp_sms_delivery_event(text,text,text,timestamptz,text)'::regprocedure,'public.service_record_otp_sms_delivery_event(text,text,text,timestamptz,text)'::regprocedure);").stdout, 't');
  assert.match(sql("select pg_get_indexdef('private_auth.otp_challenges_provider_event_uidx'::regclass);").stdout, /\(provider, last_provider_event_id\).*last_provider_event_id IS NOT NULL/i);
});

test('delivery callbacks bind by provider/message and advance monotonically with replay safety', { skip: !ENABLED }, () => {
  const id = '82000000-0000-4000-8000-000000000105';
  sql(issueSms(id, 'e', 'e'));
  sql(`set role service_role; select * from public.service_record_otp_sms_delivery_metadata('${id}','send_requested','provider_g',null,null,null);`);
  sql(`set role service_role; select * from public.service_record_otp_sms_delivery_metadata('${id}','provider_accepted','provider_g','callback-message','queued',null);`);
  assert.equal(
    sql("set role service_role; select provider_delivery_status||'|'||applied||'|'||replayed from public.service_record_otp_sms_delivery_event('provider_g','callback-message','callback-event-1','2026-08-12T12:00:01Z','sent');").stdout,
    'sent|true|false',
  );
  assert.equal(
    sql("set role service_role; select provider_delivery_status||'|'||applied||'|'||replayed from public.service_record_otp_sms_delivery_event('provider_g','callback-message','callback-event-1','2026-08-12T12:00:01Z','sent');").stdout,
    'sent|false|true',
  );
  assert.equal(
    sql("set role service_role; select provider_delivery_status||'|'||applied from public.service_record_otp_sms_delivery_event('provider_g','callback-message','callback-event-old','2026-08-12T12:00:00Z','queued');").stdout,
    'sent|false',
  );
  assert.equal(
    sql("set role service_role; select provider_delivery_status||'|'||applied from public.service_record_otp_sms_delivery_event('provider_g','callback-message','callback-event-2','2026-08-12T12:00:02Z','delivered');").stdout,
    'delivered|true',
  );
  assert.equal(
    sql("set role service_role; select provider_delivery_status||'|'||applied from public.service_record_otp_sms_delivery_event('provider_g','callback-message','callback-event-3','2026-08-12T12:00:03Z','failed');").stdout,
    'delivered|false',
  );
  assert.equal(sql("set role service_role; select count(*) from public.service_record_otp_sms_delivery_event('provider_g','unknown-message','unknown-event','2026-08-12T12:00:04Z','sent');").stdout, '0');
});

test('callback event identity is globally unique per provider and late telemetry preserves authority', { skip: !ENABLED }, () => {
  const first = '82000000-0000-4000-8000-000000000106';
  const second = '82000000-0000-4000-8000-000000000107';
  sql(issueSms(first, 'f', 'f'));
  sql(`set role service_role; select * from public.service_record_otp_sms_delivery_metadata('${first}','send_requested','provider_h',null,null,null);`);
  sql(`set role service_role; select * from public.service_record_otp_sms_delivery_metadata('${first}','provider_accepted','provider_h','callback-message-a','queued',null);`);
  sql(issueSms(second, '7', '7'));
  sql(`set role service_role; select * from public.service_record_otp_sms_delivery_metadata('${second}','send_requested','provider_h',null,null,null);`);
  sql(`set role service_role; select * from public.service_record_otp_sms_delivery_metadata('${second}','provider_accepted','provider_h','callback-message-b','queued',null);`);
  sql("set role service_role; select * from public.service_record_otp_sms_delivery_event('provider_h','callback-message-a','shared-event','2026-08-12T12:01:00Z','delivered');");
  assert.notEqual(sql("set role service_role; select * from public.service_record_otp_sms_delivery_event('provider_h','callback-message-b','shared-event','2026-08-12T12:01:01Z','sent');", { allowFailure: true }).status, 0);
  assert.equal(sql(`select (superseded_at is not null)||'|'||provider_delivery_status from private_auth.otp_challenges where challenge_id='${first}';`).stdout, 'true|delivered');
  assert.equal(sql(`select consumed_at is null and attempt_count=0 from private_auth.otp_challenges where challenge_id='${first}';`).stdout, 't');
});

test('SMS consent is explicit while email consent fields remain null', { skip: !ENABLED }, () => {
  assert.equal(sql("select (sms_selection_at is not null)||'|'||consent_copy_version from private_auth.otp_challenges where challenge_id='82000000-0000-4000-8000-000000000090';").stdout, 'true|sms-qa-v1');
  assert.equal(sql("select bool_and(sms_selection_at is null and consent_copy_version is null) from private_auth.otp_challenges where channel='email';").stdout, 't');
});

test('suppression ledger is fingerprint-only and release has bounded semantics', { skip: !ENABLED }, () => {
  sql("insert into private_auth.sms_destination_suppressions(destination_fingerprint,status,reason,source) values(repeat('a',64),'opted_out','synthetic','qa_test');");
  assert.equal(sql("set role service_role; select public.service_is_sms_destination_suppressed(repeat('a',64),'authentication');").stdout, 't');
  sql("update private_auth.sms_destination_suppressions set released_at=statement_timestamp(),updated_at=statement_timestamp() where destination_fingerprint=repeat('a',64);");
  assert.equal(sql("set role service_role; select public.service_is_sms_destination_suppressed(repeat('a',64),'authentication');").stdout, 'f');
  assert.equal(sql("select count(*) from information_schema.columns where table_schema='private_auth' and table_name='sms_destination_suppressions' and column_name in ('phone','phone_e164','to_e164');").stdout, '0');
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
  assert.equal(sql("select count(*) filter(where consumed_at is null and superseded_at is null)||'|'||count(*) filter(where superseded_at is not null) from private_auth.otp_challenges where challenge_id in ('82000000-0000-4000-8000-000000000061','82000000-0000-4000-8000-000000000062');").stdout, '1|1');
});

test('superseded OTP challenge cannot be consumed', { skip: !ENABLED }, () => {
  const oldId = sql("select challenge_id from private_auth.otp_challenges where challenge_id in ('82000000-0000-4000-8000-000000000061','82000000-0000-4000-8000-000000000062') and superseded_at is not null;").stdout;
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
  apply(SMS_B_MIGRATION);
  apply(SMS_C0_RPC_MIGRATION);
  apply(SMS_C1_CALLBACK_MIGRATION);
  assert.equal(sql("select count(*) from pg_indexes where schemaname='private_auth' and tablename='otp_challenges';").stdout, '6');
  assert.equal(sql("select count(*) from pg_policies where schemaname='private_auth' and tablename='otp_challenges';").stdout, '0');
});
