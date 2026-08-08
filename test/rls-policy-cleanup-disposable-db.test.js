'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');

const ENABLED = process.env.RLS_POLICY_CLEANUP_DISPOSABLE === 'true';
const APPLY_MIGRATION = process.env.RLS_POLICY_CLEANUP_APPLY_MIGRATION === 'true';
const DATABASE = `alphascreen_rls_cleanup_${process.pid}`;
const ROOT = path.resolve(__dirname, '..');
const BOOTSTRAP = path.join(__dirname, 'fixtures', 'rls-policy-cleanup-disposable-bootstrap.sql');
const MIGRATION_SUFFIX = '_manager_member_rls_policy_cleanup_prod.sql';
const TARGET_TABLES = ['roles', 'candidates', 'interviews', 'reports'];

const CLIENT_PARENT = '10000000-0000-0000-0000-000000000001';
const CLIENT_CHILD_1 = '10000000-0000-0000-0000-000000000002';
const CLIENT_CHILD_2 = '10000000-0000-0000-0000-000000000003';
const CLIENT_ARCHIVED_CHILD = '10000000-0000-0000-0000-000000000004';
const CLIENT_B = '20000000-0000-0000-0000-000000000001';
const HISTORICAL_CLIENT = '90000000-0000-0000-0000-000000000001';
const USER_MEMBER = '30000000-0000-0000-0000-000000000001';
const USER_PARENT_MANAGER = '30000000-0000-0000-0000-000000000002';
const USER_CHILD_MANAGER = '30000000-0000-0000-0000-000000000003';
const USER_CLIENT_ADMIN = '30000000-0000-0000-0000-000000000004';
const USER_OWNER = '30000000-0000-0000-0000-000000000005';
const USER_SUPER_ADMIN = '30000000-0000-0000-0000-000000000006';
const USER_UNAFFILIATED = '30000000-0000-0000-0000-000000000099';

const INSERT_IDS = {
  roles: '80000000-0000-0000-0000-000000000001',
  candidates: '80000000-0000-0000-0000-000000000002',
  interviews: '80000000-0000-0000-0000-000000000003',
  reports: '80000000-0000-0000-0000-000000000004',
};

function psqlArgs(database = DATABASE) {
  return ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-p', '5432', '-d', database, '-At'];
}

function sql(statement, options = {}) {
  const result = spawnSync('psql', [...psqlArgs(options.database || DATABASE), '-c', statement], { encoding: 'utf8' });
  if (!options.allowFailure && result.status !== 0) assert.fail(result.stderr || result.stdout);
  return {
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
  };
}

function applyFile(filename) {
  const result = spawnSync('psql', [...psqlArgs(), '-f', filename], { encoding: 'utf8' });
  if (result.status !== 0) assert.fail(`apply ${path.basename(filename)} failed: ${result.stderr || result.stdout}`);
}

function databaseCommand(command, database) {
  return spawnSync(command, ['-h', '/tmp', '-p', '5432', database], { encoding: 'utf8' });
}

function migrationPath() {
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations'))
    .filter((name) => name.endsWith(MIGRATION_SUFFIX));
  assert.equal(migrations.length, 1, `expected exactly one ${MIGRATION_SUFFIX} migration`);
  return path.join(ROOT, 'supabase', 'migrations', migrations[0]);
}

function asUser(userId, statement, options = {}) {
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' }).replaceAll("'", "''");
  return sql(`begin; set local role authenticated; set local request.jwt.claims='${claims}'; ${statement}; rollback;`, options);
}

function asRole(role, statement, options = {}) {
  return sql(`begin; set local role ${role}; ${statement}; rollback;`, options);
}

function assertNoRows(result, label) {
  if (result.status === 0) assert.ok(result.stdout === '' || result.stdout === '0', `${label}: ${result.stdout}`);
  else assert.match(result.stderr, /permission denied|row-level security|violates row-level security/i, label);
}

function assertAllowed(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  assert.notEqual(result.stdout, '', label);
  assert.notEqual(result.stdout, '0', label);
}

function insertTarget(table, clientId, returning = true) {
  const extraColumn = table === 'roles' ? 'title' : 'status';
  return `insert into public.${table}(id,client_id,${extraColumn}) values ('${INSERT_IDS[table]}','${clientId}','matrix-insert')${returning ? ' returning 1' : ''}`;
}

function updateTarget(table, clientId) {
  const column = table === 'roles' ? 'title' : 'status';
  return `update public.${table} set ${column}='matrix-update' where client_id='${clientId}' returning 1`;
}

before(() => {
  if (!ENABLED) return;
  databaseCommand('dropdb', DATABASE);
  const created = databaseCommand('createdb', DATABASE);
  assert.equal(created.status, 0, created.stderr);
  applyFile(BOOTSTRAP);
  if (APPLY_MIGRATION) {
    applyFile(migrationPath());
    applyFile(migrationPath());
  }
});

after(() => {
  if (!ENABLED) return;
  databaseCommand('dropdb', DATABASE);
});

test('migration is narrow, replay-safe, and declares the intended manager/member model', () => {
  const source = fs.readFileSync(migrationPath(), 'utf8');
  assert.match(source, /private\.client_scope_allows/i);
  assert.match(source, /revoke all privileges on table/i);
  assert.match(source, /grant select, insert, update, delete/i);
  assert.match(source, /to authenticated/i);
  assert.doesNotMatch(source, /alter default privileges/i);
  assert.doesNotMatch(source, /supabase_admin/i);
});

test('anonymous and unaffiliated users cannot access protected tenant rows', { skip: !ENABLED }, () => {
  assertNoRows(asRole('anon', `select count(*) from public.roles where client_id='${HISTORICAL_CLIENT}'`, { allowFailure: true }), 'anon historical role');
  for (const table of TARGET_TABLES) {
    assertNoRows(asUser(USER_UNAFFILIATED, `select count(*) from public.${table}`, { allowFailure: true }), `unaffiliated select ${table}`);
    assertNoRows(asUser(USER_UNAFFILIATED, insertTarget(table, CLIENT_PARENT), { allowFailure: true }), `unaffiliated insert ${table}`);
    assertNoRows(asUser(USER_UNAFFILIATED, updateTarget(table, CLIENT_PARENT), { allowFailure: true }), `unaffiliated update ${table}`);
    assertNoRows(asUser(USER_UNAFFILIATED, `delete from public.${table} where client_id='${CLIENT_PARENT}' returning 1`, { allowFailure: true }), `unaffiliated delete ${table}`);
  }
});

test('cross-client isolation denies every operation on every target', { skip: !ENABLED }, () => {
  for (const table of TARGET_TABLES) {
    assert.equal(asUser(USER_PARENT_MANAGER, `select count(*) from public.${table} where client_id='${CLIENT_B}'`).stdout, '0', `cross-client select ${table}`);
    assertNoRows(asUser(USER_PARENT_MANAGER, insertTarget(table, CLIENT_B), { allowFailure: true }), `cross-client insert ${table}`);
    assertNoRows(asUser(USER_PARENT_MANAGER, updateTarget(table, CLIENT_B), { allowFailure: true }), `cross-client update ${table}`);
    assertNoRows(asUser(USER_PARENT_MANAGER, `delete from public.${table} where client_id='${CLIENT_B}' returning 1`, { allowFailure: true }), `cross-client delete ${table}`);
  }
});

test('legacy auth.uid equals client_id policies cannot independently grant access', { skip: !ENABLED }, () => {
  for (const table of TARGET_TABLES) {
    assertNoRows(asUser(CLIENT_B, `select count(*) from public.${table} where client_id='${CLIENT_B}'`, { allowFailure: true }), `legacy select ${table}`);
  }
  assertNoRows(asUser(CLIENT_B, `insert into public.reports(id,client_id,status) values ('70000000-0000-0000-0000-000000000099','${CLIENT_B}','legacy-bypass') returning 1`, { allowFailure: true }), 'legacy report insert');
});

test('ordinary member is read-only inside direct scope', { skip: !ENABLED }, () => {
  for (const table of TARGET_TABLES) {
    assert.equal(asUser(USER_MEMBER, `select count(*) from public.${table} where client_id='${CLIENT_PARENT}'`).stdout, '1', `member select ${table}`);
    assert.equal(asUser(USER_MEMBER, `select count(*) from public.${table} where client_id in ('${CLIENT_CHILD_1}','${CLIENT_CHILD_2}')`).stdout, '0', `ordinary parent member cannot inherit child ${table}`);
    assertNoRows(asUser(USER_MEMBER, insertTarget(table, CLIENT_PARENT), { allowFailure: true }), `member insert ${table}`);
    assertNoRows(asUser(USER_MEMBER, updateTarget(table, CLIENT_PARENT), { allowFailure: true }), `member update ${table}`);
    assertNoRows(asUser(USER_MEMBER, `delete from public.${table} where client_id='${CLIENT_PARENT}' returning 1`, { allowFailure: true }), `member delete ${table}`);
  }
});

test('manager can manage direct and inherited active child scope', { skip: !ENABLED }, () => {
  for (const table of TARGET_TABLES) {
    assert.equal(asUser(USER_PARENT_MANAGER, `select count(*) from public.${table} where client_id in ('${CLIENT_PARENT}','${CLIENT_CHILD_1}','${CLIENT_CHILD_2}')`).stdout, '3', `parent manager select ${table}`);
    assertAllowed(asUser(USER_PARENT_MANAGER, insertTarget(table, CLIENT_CHILD_1), { allowFailure: true }), `parent manager insert child ${table}`);
    assertAllowed(asUser(USER_PARENT_MANAGER, updateTarget(table, CLIENT_CHILD_1), { allowFailure: true }), `parent manager update child ${table}`);
    assertAllowed(asUser(USER_PARENT_MANAGER, `${insertTarget(table, CLIENT_CHILD_1, false)}; delete from public.${table} where id='${INSERT_IDS[table]}' returning 1`, { allowFailure: true }), `parent manager delete child ${table}`);
  }
});

test('child-only manager cannot escape to parent or sibling scope', { skip: !ENABLED }, () => {
  for (const table of TARGET_TABLES) {
    assert.equal(asUser(USER_CHILD_MANAGER, `select count(*) from public.${table} where client_id='${CLIENT_CHILD_1}'`).stdout, '1', `child manager own select ${table}`);
    assert.equal(asUser(USER_CHILD_MANAGER, `select count(*) from public.${table} where client_id in ('${CLIENT_PARENT}','${CLIENT_CHILD_2}')`).stdout, '0', `child manager parent/sibling select ${table}`);
    assertNoRows(asUser(USER_CHILD_MANAGER, `update public.${table} set ${table === 'roles' ? 'title' : 'status'}='scope-escape' where client_id='${CLIENT_CHILD_2}' returning 1`, { allowFailure: true }), `child manager sibling update ${table}`);
  }
});

test('client admin can manage assigned and inherited child scope', { skip: !ENABLED }, () => {
  for (const table of TARGET_TABLES) {
    assert.equal(asUser(USER_CLIENT_ADMIN, `select count(*) from public.${table} where client_id in ('${CLIENT_PARENT}','${CLIENT_CHILD_1}','${CLIENT_CHILD_2}')`).stdout, '3', `client admin select ${table}`);
    assertAllowed(asUser(USER_CLIENT_ADMIN, insertTarget(table, CLIENT_CHILD_2), { allowFailure: true }), `client admin insert child ${table}`);
    assertAllowed(asUser(USER_CLIENT_ADMIN, updateTarget(table, CLIENT_CHILD_2), { allowFailure: true }), `client admin update child ${table}`);
    assertAllowed(asUser(USER_CLIENT_ADMIN, `${insertTarget(table, CLIENT_CHILD_2, false)}; delete from public.${table} where id='${INSERT_IDS[table]}' returning 1`, { allowFailure: true }), `client admin delete child ${table}`);
  }
});

test('owner and super_admin memberships retain manager-class direct-child CRUD', { skip: !ENABLED }, () => {
  for (const userId of [USER_OWNER, USER_SUPER_ADMIN]) {
    for (const table of TARGET_TABLES) {
      assert.equal(asUser(userId, `select count(*) from public.${table} where client_id in ('${CLIENT_PARENT}','${CLIENT_CHILD_1}','${CLIENT_CHILD_2}')`).stdout, '3', `${userId} select ${table}`);
      assertAllowed(asUser(userId, insertTarget(table, CLIENT_CHILD_1), { allowFailure: true }), `${userId} insert child ${table}`);
      assertAllowed(asUser(userId, updateTarget(table, CLIENT_CHILD_1), { allowFailure: true }), `${userId} update child ${table}`);
      assertAllowed(asUser(userId, `${insertTarget(table, CLIENT_CHILD_1, false)}; delete from public.${table} where id='${INSERT_IDS[table]}' returning 1`, { allowFailure: true }), `${userId} delete child ${table}`);
    }
  }
});

test('archived child is excluded from inherited manager-class scope', { skip: !ENABLED }, () => {
  for (const userId of [USER_PARENT_MANAGER, USER_CLIENT_ADMIN, USER_OWNER, USER_SUPER_ADMIN]) {
    for (const table of TARGET_TABLES) {
      assert.equal(asUser(userId, `select count(*) from public.${table} where client_id='${CLIENT_ARCHIVED_CHILD}'`).stdout, '0', `${userId} archived select ${table}`);
      assertNoRows(asUser(userId, insertTarget(table, CLIENT_ARCHIVED_CHILD), { allowFailure: true }), `${userId} archived insert ${table}`);
      assertNoRows(asUser(userId, updateTarget(table, CLIENT_ARCHIVED_CHILD), { allowFailure: true }), `${userId} archived update ${table}`);
      assertNoRows(asUser(userId, `delete from public.${table} where client_id='${CLIENT_ARCHIVED_CHILD}' returning 1`, { allowFailure: true }), `${userId} archived delete ${table}`);
    }
  }
});

test('service role remains fully functional', { skip: !ENABLED }, () => {
  for (const table of TARGET_TABLES) {
    assert.equal(asRole('service_role', `select count(*) >= 1 from public.${table}`).stdout, 't', table);
    assertAllowed(asRole('service_role', insertTarget(table, CLIENT_B)), `service insert ${table}`);
    assertAllowed(asRole('service_role', updateTarget(table, CLIENT_B)), `service update ${table}`);
    assertAllowed(asRole('service_role', `${insertTarget(table, CLIENT_B, false)}; delete from public.${table} where id='${INSERT_IDS[table]}' returning 1`), `service delete ${table}`);
  }
});

test('final target policies are unambiguous and client grants are least-privilege', { skip: !ENABLED || !APPLY_MIGRATION }, () => {
  for (const table of TARGET_TABLES) {
    assert.equal(sql(`select count(*) from pg_policies where schemaname='public' and tablename='${table}'`).stdout, '4', `${table} policy count`);
    assert.equal(sql(`select count(*) from pg_policies where schemaname='public' and tablename='${table}' and permissive='PERMISSIVE' and roles='{authenticated}'`).stdout, '4', `${table} authenticated policies`);
    assert.equal(sql(`select has_table_privilege('anon','public.${table}','SELECT,INSERT,UPDATE,DELETE')`).stdout, 'f');
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      assert.equal(sql(`select has_table_privilege('authenticated','public.${table}','${privilege}')`).stdout, 't', `${table} ${privilege}`);
      assert.equal(sql(`select has_table_privilege('service_role','public.${table}','${privilege}')`).stdout, 't', `${table} service ${privilege}`);
    }
    for (const privilege of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) {
      assert.equal(sql(`select has_table_privilege('authenticated','public.${table}','${privilege}')`).stdout, 'f', `${table} ${privilege}`);
    }
  }
  assert.equal(sql("select count(*) from pg_policies where schemaname='public' and tablename in ('roles','candidates','interviews','reports') and (coalesce(qual,'') ilike '%auth.uid() = client_id%' or coalesce(with_check,'') ilike '%auth.uid() = client_id%' or policyname ilike 'Client can%')").stdout, '0');
});

test('private scope helper is locked down and supported by membership indexes', { skip: !ENABLED || !APPLY_MIGRATION }, () => {
  assert.equal(sql("select p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname='client_scope_allows'").stdout, 't');
  assert.equal(sql("select p.provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname='client_scope_allows'").stdout, 's');
  assert.equal(sql("select pg_get_userbyid(p.proowner) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname='client_scope_allows'").stdout, 'postgres');
  assert.equal(sql("select p.proconfig = array['search_path=pg_catalog'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname='client_scope_allows'").stdout, 't');
  assert.equal(sql("select has_function_privilege('anon','private.client_scope_allows(uuid,boolean)','EXECUTE')").stdout, 'f');
  assert.equal(sql("select has_function_privilege('authenticated','private.client_scope_allows(uuid,boolean)','EXECUTE')").stdout, 't');
  assert.equal(sql("select has_function_privilege('service_role','private.client_scope_allows(uuid,boolean)','EXECUTE')").stdout, 'f');
  assert.equal(sql("select has_schema_privilege('authenticated','private','USAGE')").stdout, 't');
  assert.equal(sql("select has_schema_privilege('anon','private','USAGE')").stdout, 'f');
  assert.equal(sql("select has_schema_privilege('service_role','private','USAGE')").stdout, 'f');
  assert.equal(sql("select count(*) from pg_indexes where schemaname='public' and tablename='client_members' and indexdef ilike '%(user_id)%'").stdout, '1');
  assert.equal(sql("select count(*) from pg_indexes where schemaname='public' and tablename='clients' and indexdef ilike '%(parent_client_id)%'").stdout, '1');
  for (const table of TARGET_TABLES) {
    assert.equal(sql(`select count(*) from pg_indexes where schemaname='public' and tablename='${table}' and indexdef ilike '%(client_id)%'`).stdout, '1', `${table} client index`);
    const plan = asUser(USER_PARENT_MANAGER, `set local enable_seqscan=off; explain (costs off) select id from public.${table} where client_id='${CLIENT_PARENT}'`).stdout;
    assert.match(plan, /Index Scan|Bitmap Index Scan/, `${table} representative plan: ${plan}`);
  }
  const membershipPlan = sql(`set enable_seqscan=off; explain (costs off)
    select 1
    from public.client_members cm
    left join public.clients target_client on target_client.id='${CLIENT_CHILD_1}'
    where cm.user_id='${USER_PARENT_MANAGER}'
      and target_client.parent_client_id=cm.client_id`).stdout;
  assert.match(membershipPlan, /idx_client_members_user_id|client_members_pkey/, membershipPlan);
  assert.doesNotMatch(membershipPlan, /Seq Scan on client_members/, membershipPlan);
});
