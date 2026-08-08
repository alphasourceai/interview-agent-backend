'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');

const ENABLED = process.env.RLS_POLICY_CLEANUP_ROLLBACK_DISPOSABLE === 'true';
const DATABASE = `alphascreen_rls_rollback_${process.pid}`;
const ROOT = path.resolve(__dirname, '..');
const BOOTSTRAP = path.join(__dirname, 'fixtures', 'rls-policy-cleanup-disposable-bootstrap.sql');
const MIGRATION = path.join(ROOT, 'supabase', 'migrations', '20260808213805_manager_member_rls_policy_cleanup_prod.sql');
const ROLLBACK = path.join(ROOT, 'docs', 'rollback', 'manager-member-rls-policy-cleanup-prod.sql');
const TARGETS = ['roles', 'candidates', 'interviews', 'reports'];

function args(database = DATABASE) {
  return ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '/tmp', '-p', '5432', '-d', database, '-At'];
}

function run(command, commandArgs) {
  return spawnSync(command, commandArgs, { encoding: 'utf8' });
}

function apply(filename) {
  const result = run('psql', [...args(), '-f', filename]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function sql(statement) {
  const result = run('psql', [...args(), '-c', statement]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return String(result.stdout || '').trim();
}

before(() => {
  if (!ENABLED) return;
  run('dropdb', ['-h', '/tmp', '-p', '5432', DATABASE]);
  const created = run('createdb', ['-h', '/tmp', '-p', '5432', DATABASE]);
  assert.equal(created.status, 0, created.stderr);
  apply(BOOTSTRAP);
  apply(MIGRATION);
  apply(ROLLBACK);
});

after(() => {
  if (ENABLED) run('dropdb', ['-h', '/tmp', '-p', '5432', DATABASE]);
});

test('reviewed rollback restores the exact legacy policy/grant shape without data loss', { skip: !ENABLED }, () => {
  const expectedPolicyCounts = { roles: '8', candidates: '7', interviews: '8', reports: '7' };
  const expectedRowCounts = { roles: '6', candidates: '5', interviews: '5', reports: '5' };

  for (const table of TARGETS) {
    assert.equal(sql(`select count(*) from pg_policies where schemaname='public' and tablename='${table}'`), expectedPolicyCounts[table]);
    assert.equal(sql(`select count(*) from pg_policies where schemaname='public' and tablename='${table}' and policyname like '%scoped_authenticated' or schemaname='public' and tablename='${table}' and policyname like '%manager_scoped'`), '0');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) {
        assert.equal(sql(`select has_table_privilege('${role}','public.${table}','${privilege}')`), 't', `${role} ${table} ${privilege}`);
      }
    }
    assert.equal(sql(`select count(*) from public.${table}`), expectedRowCounts[table]);
  }

  assert.equal(sql("select to_regprocedure('private.client_scope_allows(uuid,boolean)') is null"), 't');
  assert.equal(sql("select has_schema_privilege('authenticated','private','usage')"), 'f');
  assert.equal(sql("select count(*) from pg_policies where schemaname='public' and tablename='client_members'"), '3');
});
