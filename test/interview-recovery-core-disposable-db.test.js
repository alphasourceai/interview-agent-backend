'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');

const DATABASE = process.env.RECOVERY_CORE_DISPOSABLE_DATABASE || '';
const ENABLED = DATABASE === 'alphascreen_recovery_core_disposable';
const TEMP_DATABASE = `alphascreen_recovery_core_${process.pid}`;
const ROOT = path.resolve(__dirname, '..');
const BOOTSTRAP = path.join(__dirname, 'fixtures', 'interview-recovery-core-disposable-bootstrap.sql');
const PHASE_B = path.join(ROOT, 'supabase', 'migrations', '20260717120000_candidate_incident_phase_b.sql');
const CORE = path.join(ROOT, 'supabase', 'migrations', '20260721160715_interview_recovery_core.sql');
const SERIALIZATION = path.join(ROOT, 'supabase', 'migrations', '20260724142720_final_transcript_reconciliation_serialization.sql');
const DIGEST_SCHEMA_COMPATIBILITY = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260727185302_fix_recovery_digest_schema_compatibility.sql',
);

const ID = {
  client: '71000000-0000-4000-8000-000000000001',
  role: '71000000-0000-4000-8000-000000000002',
  actor: '71000000-0000-4000-8000-000000000003',
  roj: '71000000-0000-4000-8000-000000000010',
  rojInterview: '71000000-0000-4000-8000-000000000011',
  brian: '71000000-0000-4000-8000-000000000020',
  brianInterview: '71000000-0000-4000-8000-000000000021',
  completed: '71000000-0000-4000-8000-000000000030',
  completedInterview: '71000000-0000-4000-8000-000000000031',
  race: '71000000-0000-4000-8000-000000000040',
  raceInterview: '71000000-0000-4000-8000-000000000041',
  exactReport: '71000000-0000-4000-8000-000000000050',
  exactReportInterview: '71000000-0000-4000-8000-000000000051',
  grandfathered: '71000000-0000-4000-8000-000000000060',
  grandfatheredPrior: '71000000-0000-4000-8000-000000000061',
  grandfatheredReset: '71000000-0000-4000-8000-000000000062',
  grandfatheredReplacement: '71000000-0000-4000-8000-000000000063',
  ambiguous: '71000000-0000-4000-8000-000000000070',
  ambiguousPrior: '71000000-0000-4000-8000-000000000071',
  definite: '71000000-0000-4000-8000-000000000080',
  definitePrior: '71000000-0000-4000-8000-000000000081',
  binding: '71000000-0000-4000-8000-000000000090',
  bindingPrior: '71000000-0000-4000-8000-000000000091',
  resolvedDefense: '71000000-0000-4000-8000-0000000000a0',
  resolvedDefensePrior: '71000000-0000-4000-8000-0000000000a1',
};

function psqlArgs(database = DATABASE) {
  return ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-p', '5432', '-d', database || 'postgres', '-At'];
}

function sql(statement, options = {}) {
  const result = spawnSync('psql', [...psqlArgs(options.database || TEMP_DATABASE), '-c', statement], { encoding: 'utf8' });
  if (!options.allowFailure && result.status !== 0) assert.fail(result.stderr || result.stdout);
  return {
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function sqlAsync(statement) {
  return new Promise((resolve) => {
    const child = spawn('psql', [...psqlArgs(TEMP_DATABASE), '-c', statement]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function applyFile(database, filename) {
  const result = spawnSync('psql', [...psqlArgs(database), '-f', filename], { encoding: 'utf8' });
  if (result.status !== 0) assert.fail(`apply ${path.basename(filename)} failed: ${result.stderr || result.stdout}`);
}

function databaseCommand(command, database) {
  return spawnSync(command, ['-h', '/tmp', '-p', '5432', database], { encoding: 'utf8' });
}

function authorize(candidateId, interviewId, key, overrides = {}) {
  const reason = overrides.reason || 'candidate_network_disconnect';
  const detail = overrides.detail === undefined ? 'Client confirmed the interrupted session.' : overrides.detail;
  const mode = overrides.mode || 'reset_only';
  const attested = overrides.attested === false ? 'false' : 'true';
  const approved = overrides.approved === false ? 'false' : 'true';
  return `set role service_role; select authorization_id,adjudication_id,prior_interview_id,replacement_interview_id,replayed,email_status
    from public.authorize_interview_replacement_core(
      '${candidateId}','${ID.role}','${ID.client}','${interviewId}','${ID.actor}',
      'admin@example.test','admin','authorize_one_video_replacement','${reason}',
      ${detail == null ? 'null' : `'${String(detail).replaceAll("'", "''")}'`},'${mode}',${attested},${approved},'${key}'
    );`;
}

function claim(candidateId) {
  return `set role service_role; select interview_id,attempt_number,authorized_replacement,start_claimed,claim_state,recovery_authorization_id,vendor_claim_token,vendor_external_reference,vendor_state
    from public.claim_candidate_interview_attempt_core('${candidateId}','${ID.role}','${ID.client}');`;
}

before(() => {
  if (!ENABLED) return;
  assert.equal(sql("select current_database()='alphascreen_recovery_core_disposable';", { database: DATABASE }).stdout, 't');
  databaseCommand('dropdb', TEMP_DATABASE);
  const created = databaseCommand('createdb', TEMP_DATABASE);
  assert.equal(created.status, 0, created.stderr);
  applyFile(TEMP_DATABASE, BOOTSTRAP);
  applyFile(TEMP_DATABASE, PHASE_B);
  sql(`
    insert into public.clients(id,name,email,archived_at,access_override_mode)
      values ('${ID.client}','Recovery Core','recovery@example.test',null,'inherit');
    insert into public.admins(id,user_id,email,is_active)
      values ('71000000-0000-4000-8000-000000000099','${ID.actor}','admin@example.test',true);
    insert into public.roles(id,client_id,title,slug_or_token,status)
      values ('${ID.role}','${ID.client}','Video role','video-role','active');
    insert into public.candidates(id,client_id,role_id,name,email,status,interview_status) values
      ('${ID.roj}','${ID.client}','${ID.role}','Roj fixture','roj@example.test','Verified','Analyzed'),
      ('${ID.brian}','${ID.client}','${ID.role}','Brian fixture','brian@example.test','Verified','ReadyForAnalysis'),
      ('${ID.completed}','${ID.client}','${ID.role}','Completed fixture','completed@example.test','Verified','Interview Completed'),
      ('${ID.race}','${ID.client}','${ID.role}','Race fixture','race@example.test','Verified','Analyzed'),
      ('${ID.exactReport}','${ID.client}','${ID.role}','Report fixture','report@example.test','Verified','Analyzed'),
      ('${ID.ambiguous}','${ID.client}','${ID.role}','Ambiguous fixture','ambiguous@example.test','Verified','Analyzed'),
      ('${ID.definite}','${ID.client}','${ID.role}','Definite fixture','definite@example.test','Verified','Analyzed'),
      ('${ID.binding}','${ID.client}','${ID.role}','Binding fixture','binding@example.test','Verified','Analyzed'),
      ('${ID.resolvedDefense}','${ID.client}','${ID.role}','Resolved defense fixture','resolved-defense@example.test','Verified','Analyzed');
    insert into public.interviews(id,candidate_id,client_id,role_id,status,attempt_number,is_active,has_substantive_response,transcript,recording_status,recording_metadata) values
      ('${ID.rojInterview}','${ID.roj}','${ID.client}','${ID.role}','Analyzed',1,false,true,'Partial answer preserved','ready','{"duration_seconds":90}'),
      ('${ID.brianInterview}','${ID.brian}','${ID.client}','${ID.role}','ReadyForAnalysis',1,false,false,'','pending','{}'),
      ('${ID.completedInterview}','${ID.completed}','${ID.client}','${ID.role}','Completed',1,false,true,'Complete interview','ready','{"duration_seconds":900}'),
      ('${ID.raceInterview}','${ID.race}','${ID.client}','${ID.role}','Analyzed',1,false,true,'Partial race answer','ready','{"duration_seconds":60}'),
      ('${ID.exactReportInterview}','${ID.exactReport}','${ID.client}','${ID.role}','Analyzed',1,false,true,'Partial report answer','ready','{"duration_seconds":60}'),
      ('${ID.ambiguousPrior}','${ID.ambiguous}','${ID.client}','${ID.role}','Analyzed',1,false,true,'Prior evidence unchanged','ready','{"duration_seconds":60}'),
      ('${ID.definitePrior}','${ID.definite}','${ID.client}','${ID.role}','Analyzed',1,false,true,'Definite prior unchanged','ready','{"duration_seconds":60}'),
      ('${ID.bindingPrior}','${ID.binding}','${ID.client}','${ID.role}','Analyzed',1,false,true,'Binding prior unchanged','ready','{"duration_seconds":60}'),
      ('${ID.resolvedDefensePrior}','${ID.resolvedDefense}','${ID.client}','${ID.role}','Analyzed',1,false,true,'Resolved defense prior unchanged','ready','{"duration_seconds":60}');
    insert into public.reports(candidate_id,client_id,role_id,resume_score,resume_breakdown)
      values ('${ID.roj}','${ID.client}','${ID.role}',82,'{"source":"resume"}');
  `);
});

after(() => {
  if (!ENABLED) return;
  databaseCommand('dropdb', TEMP_DATABASE);
});

test('Recovery Core DB 1. migration applies, reapplies, and leaves historical evidence unclassified', { skip: !ENABLED }, () => {
  const beforeState = sql(`select status||'|'||transcript||'|'||recording_metadata::text from public.interviews where id='${ID.rojInterview}';`).stdout;
  applyFile(TEMP_DATABASE, CORE);
  applyFile(TEMP_DATABASE, CORE);
  applyFile(TEMP_DATABASE, SERIALIZATION);
  applyFile(TEMP_DATABASE, DIGEST_SCHEMA_COMPATIBILITY);
  applyFile(TEMP_DATABASE, DIGEST_SCHEMA_COMPATIBILITY);
  const afterState = sql(`select status||'|'||transcript||'|'||recording_metadata::text from public.interviews where id='${ID.rojInterview}';`).stdout;
  assert.equal(afterState, beforeState);
  assert.equal(sql(`select (attempt_mode is null)::text from public.interviews where id='${ID.rojInterview}';`).stdout, 'true');
  assert.equal(sql("select to_regprocedure('public.digest(bytea,text)') is null;").stdout, 't');
  assert.equal(sql("select to_regprocedure('extensions.digest(bytea,text)') is not null;").stdout, 't');
  assert.equal(sql(`
    select pg_catalog.pg_get_functiondef(
      'public.authorize_interview_replacement_core(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text,boolean,boolean,uuid)'::regprocedure
    ) like '%pg_catalog.sha256(%';`).stdout, 't');
});

test('Recovery Core DB 2. Roj-style Analyzed partial attempt is manually eligible without reclassification', { skip: !ENABLED }, () => {
  const eligibility = JSON.parse(sql(`set role service_role; select public.get_interview_recovery_core_eligibility('${ID.roj}','${ID.role}','${ID.client}','${ID.rojInterview}');`).stdout);
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.prior_interview.status, 'Analyzed');
  assert.equal(eligibility.prior_interview.transcript_present, true);
  assert.equal(eligibility.prior_interview.recording_present, true);
});

test('Recovery Core DB 3. authorization is immutable, idempotent, and does not create attempt two', { skip: !ENABLED }, () => {
  const key = '71000000-0000-4000-8000-000000000101';
  const first = sql(authorize(ID.roj, ID.rojInterview, key)).stdout;
  const replay = sql(authorize(ID.roj, ID.rojInterview, key)).stdout;
  assert.equal(first.split('|')[0], replay.split('|')[0]);
  assert.equal(replay.split('|')[4], 't');
  assert.equal(sql(`select count(*) from public.interviews where candidate_id='${ID.roj}';`).stdout, '1');
  assert.equal(sql(`select count(*) from public.interview_adjudications where candidate_id='${ID.roj}';`).stdout, '1');
  const conflict = sql(authorize(ID.roj, ID.rojInterview, key, { reason: 'partial_interview' }), { allowFailure: true });
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /reset_request_conflict/i);
  const mutation = sql(`update public.interview_adjudications set reason_code='other' where candidate_id='${ID.roj}';`, { allowFailure: true });
  assert.notEqual(mutation.status, 0);
  assert.match(mutation.stderr, /audit_record_immutable/i);
});

test('Recovery Core DB 4. concurrent Start creates one replacement and one vendor-start claim', { skip: !ENABLED }, async () => {
  const [one, two] = await Promise.all([sqlAsync(claim(ID.roj)), sqlAsync(claim(ID.roj))]);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(two.status, 0, two.stderr);
  const rows = [one.stdout, two.stdout].map((value) => value.split('|'));
  assert.equal(new Set(rows.map((row) => row[0])).size, 1);
  assert.equal(rows.filter((row) => row[3] === 't').length, 1);
  assert.equal(rows.filter((row) => row[3] === 'f').length, 1);
  assert.equal(sql(`select count(*) from public.interviews where candidate_id='${ID.roj}';`).stdout, '2');
  assert.equal(sql(`select count(*) from public.interviews where candidate_id='${ID.roj}' and attempt_number=2;`).stdout, '1');
});

test('Recovery Core DB 5. vendor failure retries the same attempt and successful retry cannot create attempt three', { skip: !ENABLED }, () => {
  const binding = sql(`select replacement_interview_id||'|'||id from public.interview_reset_events where candidate_id='${ID.roj}';`).stdout.split('|');
  const [replacementId, authorizationId] = binding;
  const firstClaim = sql(`select vendor_create_claim_token||'|'||vendor_external_reference from public.interviews where id='${replacementId}';`).stdout.split('|');
  assert.equal(sql(`set role service_role; select public.complete_interview_recovery_start_core(
    '${replacementId}','${authorizationId}',false,'mock_vendor_failure',null,null,null,null,null,
    'definite_pre_acceptance','${firstClaim[1]}',null,'${firstClaim[0]}','db5-definite-1');`).stdout, 'failed_retryable');
  const retry = sql(claim(ID.roj)).stdout.split('|');
  assert.equal(retry[0], replacementId);
  assert.equal(retry[1], '2');
  assert.equal(retry[3], 't');
  assert.equal(sql(`set role service_role; select public.complete_interview_recovery_start_core(
    '${replacementId}','${authorizationId}',true,null,'conv-retry','https://tavus.daily.co/conv-retry',null,null,null,
    null,'${retry[7]}','create_response','${retry[6]}','db5-success-2');`).stdout, 'started');
  const third = sql(claim(ID.roj), { allowFailure: true });
  assert.notEqual(third.status, 0);
  assert.match(third.stderr, /active_interview_attempt_exists/i);
  assert.equal(sql(`select count(*) from public.interviews where candidate_id='${ID.roj}';`).stdout, '2');
  assert.equal(sql(`select count(*) from public.interview_admin_audit_logs where related_reset_id='${authorizationId}' and action='vendor_create_definite_failure';`).stdout, '1');
});

test('Recovery Core DB 5a. ambiguous acceptance pauses Start, serializes reconciliation, and stale writers cannot regress success', { skip: !ENABLED }, async () => {
  const authorization = sql(authorize(ID.ambiguous, ID.ambiguousPrior, '71000000-0000-4000-8000-000000000072')).stdout.split('|')[0];
  const claimed = sql(claim(ID.ambiguous)).stdout.split('|');
  const replacementId = claimed[0];
  const createToken = claimed[6];
  const externalReference = claimed[7];
  assert.equal(claimed[1], '2');
  assert.equal(sql(`set role service_role; select public.complete_interview_recovery_start_core(
    '${replacementId}','${authorization}',false,'mock_timeout',null,null,null,null,null,
    'ambiguous_acceptance','${externalReference}',null,'${createToken}','db5a-ambiguous');`).stdout, 'reconciliation_required');
  const blocked = sql(claim(ID.ambiguous)).stdout.split('|');
  assert.equal(blocked[0], replacementId);
  assert.equal(blocked[3], 'f');
  assert.equal(blocked[4], 'replacement_reconciliation_required');
  assert.equal(sql(`select start_attempt_count from public.interview_reset_events where id='${authorization}';`).stdout, '1');

  const reconcileSql = `set role service_role; select claimed,claim_token,vendor_external_reference,ambiguous_at,reconciliation_attempt_count,state
    from public.claim_interview_recovery_reconciliation_core('${replacementId}','${authorization}','db5a-reconcile');`;
  const [one, two] = await Promise.all([sqlAsync(reconcileSql), sqlAsync(reconcileSql)]);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(two.status, 0, two.stderr);
  const reconciliationRows = [one.stdout, two.stdout].map((value) => value.split('|'));
  assert.equal(reconciliationRows.filter((row) => row[0] === 't').length, 1);
  const winner = reconciliationRows.find((row) => row[0] === 't');
  assert.equal(sql(`set role service_role; select public.complete_interview_recovery_reconciliation_core(
    '${replacementId}','${authorization}','${winner[1]}','resolved','conv-ambiguous','https://tavus.daily.co/conv-ambiguous',
    'db5a-resolved',array['conv-ambiguous'],1,1,false,true,'complete',1,1,1);`).stdout, 'started');
  assert.equal(sql(`set role service_role; select public.complete_interview_recovery_start_core(
    '${replacementId}','${authorization}',false,'stale_failure',null,null,null,null,null,
    'definite_pre_acceptance','${externalReference}',null,'${createToken}','db5a-stale-failure');`).stdout, 'started');
  assert.equal(sql(`set role service_role; select public.complete_interview_recovery_reconciliation_core(
    '${replacementId}','${authorization}','${winner[1]}','unavailable',null,null,
    'db5a-stale-reconcile',null,null,0,false,false,'unavailable',1,0,null);`).stdout, 'started');
  assert.equal(sql(`select attempt_number||'|'||tavus_conversation_id||'|'||vendor_start_state from public.interviews where id='${replacementId}';`).stdout, '2|conv-ambiguous|started');
  assert.equal(sql(`select transcript from public.interviews where id='${ID.ambiguousPrior}';`).stdout, 'Prior evidence unchanged');
  assert.equal(sql(`select count(*) from public.interviews where candidate_id='${ID.ambiguous}';`).stdout, '2');
});

test('Recovery Core DB 5b. three total definite create invocations terminate and a fourth claim is impossible', { skip: !ENABLED }, () => {
  const authorization = sql(authorize(ID.definite, ID.definitePrior, '71000000-0000-4000-8000-000000000082')).stdout.split('|')[0];
  let claimed = sql(claim(ID.definite)).stdout.split('|');
  const replacementId = claimed[0];
  for (let invocation = 1; invocation <= 3; invocation += 1) {
    const status = sql(`set role service_role; select public.complete_interview_recovery_start_core(
      '${replacementId}','${authorization}',false,'definite-${invocation}',null,null,null,null,null,
      'definite_pre_acceptance','${claimed[7]}',null,'${claimed[6]}','db5b-${invocation}');`).stdout;
    assert.equal(status, invocation < 3 ? 'failed_retryable' : 'failed_terminal');
    if (invocation < 3) {
      claimed = sql(claim(ID.definite)).stdout.split('|');
      assert.equal(claimed[0], replacementId);
      assert.equal(claimed[1], '2');
    }
  }
  const fourth = sql(claim(ID.definite), { allowFailure: true });
  assert.notEqual(fourth.status, 0);
  assert.match(fourth.stderr, /replacement_start_retry_exhausted/i);
  assert.equal(sql(`select start_attempt_count from public.interview_reset_events where id='${authorization}';`).stdout, '3');
  assert.equal(sql(`select count(*) from public.interviews where candidate_id='${ID.definite}';`).stdout, '2');
});

test('Recovery Core DB 5c. known provider success survives bind failure and database-only recovery is concurrent-safe', { skip: !ENABLED }, async () => {
  const authorization = sql(authorize(ID.binding, ID.bindingPrior, '71000000-0000-4000-8000-000000000092')).stdout.split('|')[0];
  const claimed = sql(claim(ID.binding)).stdout.split('|');
  const replacementId = claimed[0];
  assert.equal(sql(`set role service_role; select public.record_interview_recovery_binding_failure_core(
    '${replacementId}','${authorization}','${claimed[6]}','${claimed[7]}',
    'conv-binding','https://tavus.daily.co/conv-binding',null,null,null,
    'mock_database_bind_failure','db5c-record');`).stdout, 'vendor_binding_recovery_required');
  const blocked = sql(claim(ID.binding)).stdout.split('|');
  assert.equal(blocked[3], 'f');
  assert.equal(blocked[4], 'replacement_binding_recovery_required');

  const recoverSql = `set role service_role; select status,conversation_id
    from public.recover_interview_vendor_binding_core(
      '${replacementId}','${authorization}','${ID.actor}','admin@example.test','db5c-recover');`;
  const [one, two] = await Promise.all([sqlAsync(recoverSql), sqlAsync(recoverSql)]);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(two.status, 0, two.stderr);
  assert.equal(one.stdout, 'started|conv-binding');
  assert.equal(two.stdout, 'started|conv-binding');
  assert.equal(sql(`select tavus_conversation_id||'|'||vendor_start_state from public.interviews where id='${replacementId}';`).stdout, 'conv-binding|started');
  assert.equal(sql(`select count(*) from public.interviews where candidate_id='${ID.binding}';`).stdout, '2');
  assert.equal(sql(`select count(*) from private.interview_vendor_binding_recovery where interview_id='${replacementId}' and resolved_at is not null;`).stdout, '1');
  assert.equal(sql(`select count(*) from public.interview_admin_audit_logs where related_reset_id='${authorization}' and action='provider_create_succeeded_bind_failed';`).stdout, '1');
  assert.equal(sql(`select count(*) from public.interview_admin_audit_logs where related_reset_id='${authorization}' and action='vendor_binding_recovery_resolved';`).stdout, '1');

  assert.equal(sql(`set role service_role; select public.record_interview_recovery_binding_failure_core(
    '${replacementId}','${authorization}','${claimed[6]}','${claimed[7]}',
    'conv-conflict','https://tavus.daily.co/conv-conflict',null,null,null,
    'stale_database_bind_failure','db5c-stale');`).stdout, 'vendor_binding_recovery_conflict');
  assert.equal(sql(`select tavus_conversation_id||'|'||vendor_start_state from public.interviews where id='${replacementId}';`).stdout, 'conv-binding|started');
  assert.equal(sql(`select start_status from public.interview_reset_events where id='${authorization}';`).stdout, 'started');
});

test('Recovery Core DB 5d. resolved reconciliation diagnostics fail closed at the RPC boundary', { skip: !ENABLED }, async (t) => {
  const authorization = sql(authorize(
    ID.resolvedDefense,
    ID.resolvedDefensePrior,
    '71000000-0000-4000-8000-0000000000a2',
  )).stdout.split('|')[0];
  const claimed = sql(claim(ID.resolvedDefense)).stdout.split('|');
  const replacementId = claimed[0];
  assert.equal(claimed[1], '2');
  assert.equal(sql(`set role service_role; select public.complete_interview_recovery_start_core(
    '${replacementId}','${authorization}',false,'mock_timeout',null,null,null,null,null,
    'ambiguous_acceptance','${claimed[7]}',null,'${claimed[6]}','db5d-ambiguous');`).stdout, 'reconciliation_required');
  const reconciliation = sql(`set role service_role; select claimed,claim_token
    from public.claim_interview_recovery_reconciliation_core(
      '${replacementId}','${authorization}','db5d-reconcile');`).stdout.split('|');
  assert.equal(reconciliation[0], 't');
  const claimToken = reconciliation[1];

  function completeResolved(overrides = {}) {
    const references = overrides.references === undefined ? ['conv-resolved-defense'] : overrides.references;
    const referenceSql = references === null
      ? 'null'
      : `array[${references.map((value) => `'${value}'`).join(',')}]`;
    const exactCount = overrides.exactCount === undefined ? 1 : overrides.exactCount;
    const storedCount = overrides.storedCount === undefined ? references?.length || 0 : overrides.storedCount;
    const truncated = overrides.truncated === undefined ? false : overrides.truncated;
    const pagesRequested = overrides.pagesRequested === undefined ? 1 : overrides.pagesRequested;
    const pagesCompleted = overrides.pagesCompleted === undefined ? 1 : overrides.pagesCompleted;
    const totalCount = overrides.totalCount === undefined ? 1 : overrides.totalCount;
    const sqlValue = (value) => value === null ? 'null' : String(value);
    return sql(`set role service_role; select public.complete_interview_recovery_reconciliation_core(
      '${replacementId}','${authorization}','${claimToken}','resolved',
      'conv-resolved-defense','https://tavus.daily.co/conv-resolved-defense',
      'db5d-resolved',${referenceSql},${sqlValue(exactCount)},${sqlValue(storedCount)},
      ${truncated ? 'true' : 'false'},true,'complete',${sqlValue(pagesRequested)},
      ${sqlValue(pagesCompleted)},${sqlValue(totalCount)});`, { allowFailure: true });
  }

  async function rejects(name, overrides) {
    await t.test(name, () => {
      const result = completeResolved(overrides);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /recovery_start_result_conflict/i);
      assert.equal(sql(`select vendor_start_state from public.interviews where id='${replacementId}';`).stdout, 'reconciling');
    });
  }

  await rejects('DB defense 43. resolved rejects pages_requested other than one', { pagesRequested: 2 });
  await rejects('DB defense 44. resolved rejects pages_completed other than one', { pagesCompleted: 0 });
  await rejects('DB defense 45. resolved rejects total_count_reported above one page', { totalCount: 101 });
  for (const totalCount of [null, 0, -1]) {
    await rejects(`DB defense 46. resolved rejects invalid total_count_reported ${totalCount}`, { totalCount });
  }
  for (const exactCount of [0, 2]) {
    await rejects(`DB defense 47. resolved rejects exact-match count ${exactCount}`, { exactCount });
  }
  await rejects('DB defense 48a. resolved rejects zero stored references', {
    references: null,
    storedCount: 0,
  });
  await rejects('DB defense 48b. resolved rejects multiple stored references', {
    references: ['conv-resolved-defense', 'conv-resolved-defense-duplicate'],
    storedCount: 2,
  });
  await rejects('DB defense 49. resolved rejects truncated match references', { truncated: true });

  await t.test('DB defense 50. valid resolved diagnostics still succeed', () => {
    const result = completeResolved();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'started');
    assert.equal(sql(`select attempt_number||'|'||tavus_conversation_id||'|'||vendor_start_state
      from public.interviews where id='${replacementId}';`).stdout, '2|conv-resolved-defense|started');
    assert.equal(sql(`select transcript from public.interviews where id='${ID.resolvedDefensePrior}';`).stdout, 'Resolved defense prior unchanged');
    assert.equal(sql(`select count(*) from public.interviews where candidate_id='${ID.resolvedDefense}';`).stdout, '2');
  });
});

test('Recovery Core DB 6. Brian-style inconclusive attempt requires attestation and preserves the prior row', { skip: !ENABLED }, () => {
  const eligibility = JSON.parse(sql(`set role service_role; select public.get_interview_recovery_core_eligibility('${ID.brian}','${ID.role}','${ID.client}','${ID.brianInterview}');`).stdout);
  assert.equal(eligibility.eligible, true);
  const missing = sql(authorize(ID.brian, ID.brianInterview, '71000000-0000-4000-8000-000000000102', { attested: false }), { allowFailure: true });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /recovery_attestation_required/i);
  sql(authorize(ID.brian, ID.brianInterview, '71000000-0000-4000-8000-000000000103'));
  assert.equal(sql(`select status||'|'||coalesce(transcript,'') from public.interviews where id='${ID.brianInterview}';`).stdout, 'ReadyForAnalysis|');
  assert.equal(sql(`select count(*) from public.otp_tokens where candidate_id='${ID.brian}';`).stdout, '0');
});

test('Recovery Core DB 7. completed marker and exact complete report block replacement', { skip: !ENABLED }, () => {
  const completed = JSON.parse(sql(`set role service_role; select public.get_interview_recovery_core_eligibility('${ID.completed}','${ID.role}','${ID.client}','${ID.completedInterview}');`).stdout);
  assert.equal(completed.eligible, false);
  assert.ok(completed.blockers.includes('completed_interview_retake_blocked'));
  sql(`insert into public.reports(candidate_id,client_id,role_id,interview_id,attempt_number,report_kind)
    values ('${ID.exactReport}','${ID.client}','${ID.role}','${ID.exactReportInterview}',1,'complete_interview');`);
  const reportBlocked = JSON.parse(sql(`set role service_role; select public.get_interview_recovery_core_eligibility('${ID.exactReport}','${ID.role}','${ID.client}','${ID.exactReportInterview}');`).stdout);
  assert.equal(reportBlocked.eligible, false);
  assert.ok(reportBlocked.blockers.includes('complete_report_bound'));
});

test('Recovery Core DB 8. concurrent authorization yields one adjudication and authorization', { skip: !ENABLED }, async () => {
  const key = '71000000-0000-4000-8000-000000000104';
  const [one, two] = await Promise.all([
    sqlAsync(authorize(ID.race, ID.raceInterview, key)),
    sqlAsync(authorize(ID.race, ID.raceInterview, key)),
  ]);
  assert.equal(one.status, 0, one.stderr);
  assert.equal(two.status, 0, two.stderr);
  assert.equal(one.stdout.split('|')[0], two.stdout.split('|')[0]);
  assert.equal(sql(`select count(*) from public.interview_reset_events where candidate_id='${ID.race}';`).stdout, '1');
  assert.equal(sql(`select count(*) from public.interview_adjudications where candidate_id='${ID.race}';`).stdout, '1');
});

test('Recovery Core DB 9. exact report binding rejects a cross-attempt identity and keeps legacy rows accessible', { skip: !ENABLED }, () => {
  const replacementId = sql(`select replacement_interview_id from public.interview_reset_events where candidate_id='${ID.roj}';`).stdout;
  sql(`insert into public.reports(candidate_id,client_id,role_id,interview_id,attempt_number,report_kind,resume_score)
    values ('${ID.roj}','${ID.client}','${ID.role}','${replacementId}',2,'complete_interview',82);`);
  const mismatch = sql(`insert into public.reports(candidate_id,client_id,role_id,interview_id,attempt_number,report_kind)
    values ('${ID.brian}','${ID.client}','${ID.role}','${replacementId}',2,'partial_diagnostic');`, { allowFailure: true });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /attempt_bound_report_binding_mismatch/i);
  assert.equal(sql(`select count(*) from public.reports where candidate_id='${ID.roj}' and interview_id is null and report_kind is null;`).stdout, '1');
});

test('Recovery Core DB 10. application roles cannot write recovery tables and RPC grants are narrow', { skip: !ENABLED }, () => {
  for (const role of ['anon', 'authenticated']) {
    const direct = sql(`set role ${role}; insert into public.interview_admin_audit_logs(actor_role,client_id,action,request_id,success) values ('admin','${ID.client}','replacement_authorized','forbidden-${role}',true);`, { allowFailure: true });
    assert.notEqual(direct.status, 0);
    assert.match(direct.stderr, /permission denied/i);
  }
  assert.equal(sql("select has_function_privilege('service_role','public.claim_candidate_interview_attempt_core(uuid,uuid,uuid)','execute');").stdout, 't');
  assert.equal(sql("select has_function_privilege('anon','public.claim_candidate_interview_attempt_core(uuid,uuid,uuid)','execute');").stdout, 'f');
  assert.equal(sql("select has_function_privilege('authenticated','public.authorize_interview_replacement_core(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text,boolean,boolean,uuid)','execute');").stdout, 'f');
});

test('Recovery Core DB 11. a pre-Core Phase B authorization remains claimable with stable attempt identity', { skip: !ENABLED }, () => {
  sql(`
    insert into public.candidates(id,client_id,role_id,name,email,status,interview_status)
      values ('${ID.grandfathered}','${ID.client}','${ID.role}','Grandfathered fixture','grandfathered@example.test','Verified','Analyzed');
    insert into public.interviews(id,candidate_id,client_id,role_id,status,attempt_number,is_active,has_substantive_response)
      values ('${ID.grandfatheredPrior}','${ID.grandfathered}','${ID.client}','${ID.role}','Analyzed',1,false,true);
    insert into public.interview_reset_events(id,candidate_id,role_id,client_id,previous_interview_id,actor_user_id,actor_email,reason_code,reason_detail,reset_mode,idempotency_key,email_status)
      values ('${ID.grandfatheredReset}','${ID.grandfathered}','${ID.role}','${ID.client}','${ID.grandfatheredPrior}','${ID.actor}','admin@example.test','technical_issue','Pre-Core authorization','reset_only','71000000-0000-4000-8000-000000000064','not_requested');
    insert into public.interviews(id,candidate_id,client_id,role_id,status,attempt_number,attempt_mode,is_active,has_substantive_response,previous_attempt_id,replacement_authorization_id)
      values ('${ID.grandfatheredReplacement}','${ID.grandfathered}','${ID.client}','${ID.role}','Authorized',2,'video',true,false,'${ID.grandfatheredPrior}','${ID.grandfatheredReset}');
    update public.interview_reset_events set replacement_interview_id='${ID.grandfatheredReplacement}' where id='${ID.grandfatheredReset}';
  `);
  const claimed = sql(claim(ID.grandfathered)).stdout.split('|');
  assert.equal(claimed[0], ID.grandfatheredReplacement);
  assert.equal(claimed[1], '2');
  assert.equal(claimed[3], 't');
  assert.equal(claimed[4], 'grandfathered_replacement_claimed');
  assert.equal(sql(`select count(*) from public.interviews where candidate_id='${ID.grandfathered}';`).stdout, '2');
});
