'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync,spawn}=require('node:child_process');const {before,after,test}=require('node:test');
const ENABLED=process.env.MEMBERSHIP_V2_DISPOSABLE==='true';const options={skip:!ENABLED};
const SOCKET=process.env.PGHOST||'',PORT=process.env.PGPORT||'55440';
const PG='/opt/homebrew/opt/postgresql@17/bin/',DATABASE=`alphascreen_sales_scopes_${process.pid}`;
const rep='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const key=crypto.createHash('sha256').update('synthetic-sql-key').digest('hex');
const fp=actor=>crypto.createHash('sha256').update(`manual-prospect-scope-v1\n${actor}\nsales\nmanual_prospect`).digest('hex');
const root=path.join(__dirname,'../supabase/migrations');
let baselineSnapshot;
function parentSnapshot(){return sql(`select jsonb_build_object('grants',(
  select jsonb_agg(jsonb_build_object('table',relname,'acl',relacl::text,'rls',relrowsecurity) order by relname)
  from pg_class where oid in ('sales_reps'::regclass,'membership_v2_quote_drafts'::regclass,'clients'::regclass,'membership_agreements'::regclass,'public_purchase_intents'::regclass)),
  'constraints',(select jsonb_agg(jsonb_build_object('table',conrelid::regclass::text,'name',conname,'definition',pg_get_constraintdef(oid)) order by conname)
  from pg_constraint where conrelid in ('sales_reps'::regclass,'membership_v2_quote_drafts'::regclass,'clients'::regclass,'membership_agreements'::regclass,'public_purchase_intents'::regclass)));`);}
function args(){return ['-h',SOCKET,'-p',PORT,'-U','postgres','-X','-q','-At','-v','ON_ERROR_STOP=1','-d',DATABASE];}
function run(statement){return spawnSync(`${PG}psql`,[...args(),'-c',statement],{encoding:'utf8'});}
function sql(statement){const r=run(statement);assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function denied(statement,pattern){const r=run(statement);assert.notEqual(r.status,0,r.stdout);assert.match(r.stderr,pattern);}
function rpc(actor=rep,keyHash=key,fingerprint=fp(actor)){return `public.membership_v2_reserve_sales_quote_scope('${actor}','${keyHash}','${fingerprint}')`;}
function asyncSQL(statement){let out='',err='';const child=spawn(`${PG}psql`,[...args(),'-c',statement]);
 const done=new Promise((resolve,reject)=>{child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);
 child.on('error',reject);child.on('close',status=>resolve({status,out:out.trim(),err}));});return {child,done};}
before(()=>{
 if(!ENABLED)return;assert.match(SOCKET,/^\/private\/tmp\/alphascreen-membership-v2-pg\.[A-Za-z0-9]+$/);
 const r=spawnSync(`${PG}createdb`,['-h',SOCKET,'-p',PORT,'-U','postgres',DATABASE],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 sql(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
 create schema auth;create table auth.users(id uuid primary key);create table clients(id uuid primary key,status text);
 create table membership_agreements(id uuid primary key,client_id uuid references clients(id),status text);
 create table public_purchase_intents(id uuid primary key,client_id uuid references clients(id),protocol text);
 insert into auth.users values('${rep}'),('${other}');insert into clients values(gen_random_uuid(),'active');
 insert into public_purchase_intents values(gen_random_uuid(),null,'fenced_v2');
 insert into membership_agreements values('20000000-0000-4000-8000-000000000001',null,'signed');
 grant usage on schema public,auth to anon,authenticated,service_role;
 grant select on membership_agreements,public_purchase_intents to service_role;
 alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
 alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
 // Actual sales_reps CREATE TABLE definition, not an invented parent grant.
 const sales=fs.readFileSync(path.join(root,'20260918195401_sales_workspace.sql'),'utf8');
 sql(sales.slice(0,sales.indexOf('alter table public.public_purchase_intents')));
 sql(`alter table sales_reps enable row level security;revoke all on sales_reps from public,anon,authenticated,service_role;
 grant select,update on sales_reps to service_role;
 insert into sales_reps(user_id,email,display_name) values('${rep}','rep@example.invalid','Synthetic Rep'),('${other}','other@example.invalid','Synthetic Other');`);
 for(const file of ['20261011163625_membership_v2_contract_store.sql','20261011194051_membership_v2_quote_drafts.sql',
 '20261011201754_membership_v2_sales_quote_scopes.sql']){
  if(file==='20261011201754_membership_v2_sales_quote_scopes.sql')baselineSnapshot=parentSnapshot();
  const r=spawnSync(`${PG}psql`,[...args(),'-f',path.join(root,file)],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 }
});
after(()=>{if(!ENABLED)return;const r=spawnSync(`${PG}dropdb`,['-h',SOCKET,'-p',PORT,'-U','postgres',DATABASE],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);});

test('migration preserves legacy clients/activation protocol; no acceptance, receipts or cron',options,()=>{
 assert.equal(sql('select status from clients;'),'active');assert.equal(sql('select protocol from public_purchase_intents;'),'fenced_v2');
 assert.equal(sql("select id,status from membership_agreements;"),'20000000-0000-4000-8000-000000000001|signed');
 assert.equal(parentSnapshot(),baselineSnapshot);
 for(const table of ['membership_v2_contracts','membership_v2_initial_receipts','membership_v2_paid_periods'])
  assert.equal(sql(`select count(*) from ${table};`),'0');
 assert.equal(sql("select count(*) from pg_tables where schemaname='cron';"),'0');
});
test('service-only non-owner grants, invoker/search_path and RLS deny browsers even after accidental grant',options,()=>{
 assert.equal(sql("select relrowsecurity and relowner<>(select oid from pg_roles where rolname='service_role') from pg_class where oid='membership_v2_sales_quote_scopes'::regclass;"),'t');
 assert.equal(sql("select rolsuper from pg_roles where rolname='service_role';"),'f');
 assert.equal(sql("select count(*) from pg_policies where tablename='membership_v2_sales_quote_scopes';"),'0');
 assert.equal(sql("select not prosecdef and proconfig @> array['search_path=pg_catalog'] from pg_proc where oid='membership_v2_reserve_sales_quote_scope(uuid,text,text)'::regprocedure;"),'t');
 for(const role of ['anon','authenticated']){
  for(const privilege of ['select','insert','update','delete','truncate'])assert.equal(sql(`select has_table_privilege('${role}','membership_v2_sales_quote_scopes','${privilege}');`),'f');
  assert.equal(sql(`select has_function_privilege('${role}','membership_v2_reserve_sales_quote_scope(uuid,text,text)','execute');`),'f');
  denied(`set role ${role};select * from ${rpc()};`,/permission denied/);
  assert.equal(sql(`begin;grant select on membership_v2_sales_quote_scopes to ${role};set local role ${role};select count(*) from membership_v2_sales_quote_scopes;rollback;`),'0');
 }
 for(const privilege of ['select','insert','update','delete','truncate'])assert.equal(sql(`select has_table_privilege('service_role','membership_v2_sales_quote_scopes','${privilege}');`),['select','insert'].includes(privilege)?'t':'f');
});
test('real reservation/replay returns identical immutable scope and server/SQL fingerprint',options,()=>{
 const first=JSON.parse(sql(`set role service_role;select row_to_json(s) from ${rpc()} s;`));
 const replay=JSON.parse(sql(`set role service_role;select row_to_json(s) from ${rpc()} s;`));
 assert.deepEqual(replay,first);assert.equal(first.request_fingerprint,fp(rep));assert.equal(first.source_verified,false);
 assert.equal(sql(`select count(*) from membership_v2_sales_quote_scopes where issuer_user_id='${rep}' and idempotency_key_hash='${key}';`),'1');
});
test('different actors using same key never share attribution or scope',options,()=>{
 const a=JSON.parse(sql(`set role service_role;select row_to_json(s) from ${rpc()} s;`));
 const b=JSON.parse(sql(`set role service_role;select row_to_json(s) from ${rpc(other)} s;`));
 assert.notEqual(a.id,b.id);assert.equal(b.issuer_user_id,other);
 assert.equal(sql(`set role service_role;select count(*) from membership_v2_sales_quote_scopes where id='${a.id}' and issuer_user_id='${other}';`),'0');
});
test('actual concurrent identical reservations create one row',options,async()=>{
 const concurrentKey=crypto.createHash('sha256').update('concurrency-synthetic').digest('hex');
 const results=await Promise.all(Array.from({length:8},()=>asyncSQL(`set role service_role;select id from ${rpc(rep,concurrentKey)};`).done));
 results.forEach(r=>assert.equal(r.status,0,r.err));assert.equal(new Set(results.map(r=>r.out)).size,1);
 assert.equal(sql(`select count(*) from membership_v2_sales_quote_scopes where issuer_user_id='${rep}' and idempotency_key_hash='${concurrentKey}';`),'1');
});
test('inactive, absent, nil rep and altered fingerprint/unsupported audience cannot reserve',options,()=>{
 sql(`update sales_reps set active=false where user_id='${other}';`);
 denied(`set role service_role;select * from ${rpc(other)};`,/sales_scope_denied/);
 sql(`update sales_reps set active=true where user_id='${other}';`);
 denied(`set role service_role;select * from ${rpc('10000000-0000-4000-8000-000000000099')};`,/sales_scope_denied/);
 denied(`set role service_role;select * from ${rpc('00000000-0000-0000-0000-000000000000')};`,/invalid_sales_scope_request/);
 denied(`set role service_role;select * from ${rpc(rep,key,'a'.repeat(64))};`,/sales_scope_conflict/);
 denied(`set role service_role;insert into membership_v2_sales_quote_scopes(issuer_user_id,audience,idempotency_key_hash,request_fingerprint)
 values('${rep}','admin','${'b'.repeat(64)}','${fp(rep)}');`,/check constraint/);
 denied(`set role service_role;insert into membership_v2_sales_quote_scopes(issuer_user_id,source_verified,idempotency_key_hash,request_fingerprint)
 values('${rep}',true,'${'c'.repeat(64)}','${fp(rep)}');`,/check constraint/);
});
test('immutable update/delete/truncate reject owner and accidentally granted service operations',options,()=>{
 for(const statement of ['update membership_v2_sales_quote_scopes set id=id;','delete from membership_v2_sales_quote_scopes;','truncate membership_v2_sales_quote_scopes;']){
  denied(`set role service_role;${statement}`,/permission denied/);denied(statement,/immutable_membership_record/);
  denied(`begin;grant update,delete,truncate on membership_v2_sales_quote_scopes to service_role;set local role service_role;${statement}rollback;`,/immutable_membership_record/);
 }
});
test('original rep FK prevents identity deletion/rewrite but permits deactivation',options,()=>{
 denied(`delete from sales_reps where user_id='${rep}';`,/foreign key constraint/);
 denied(`update sales_reps set user_id=gen_random_uuid() where user_id='${rep}';`,/foreign key constraint/);
 denied(`delete from auth.users where id='${rep}';`,/foreign key constraint/);
 sql(`update sales_reps set active=false where user_id='${rep}';`);
 denied(`set role service_role;select * from ${rpc()};`,/sales_scope_denied/);
 sql(`update sales_reps set active=true where user_id='${rep}';`);
});
test('reservation holds rep lock through commit; concurrent deactivation is blocked then prevents replay',options,async()=>{
 const holding=asyncSQL(`set role service_role;begin;select id from ${rpc()};select pg_sleep(1);commit;`);
 let held=false;
 for(let i=0;i<30;i++){if(sql("select exists(select 1 from pg_locks where relation='sales_reps'::regclass and mode='RowShareLock' and granted);")==='t'){held=true;break;}}
 assert.equal(held,true,'reservation did not acquire expected relation lock');
 const deactivation=asyncSQL(`set role service_role;update sales_reps set active=false where user_id='${rep}';`);
 let blocked=false;
 for(let i=0;i<30;i++){if(sql("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%update sales_reps set active=false%');")==='t'){blocked=true;break;}}
 const results=await Promise.all([holding.done,deactivation.done]);results.forEach(r=>assert.equal(r.status,0,r.err));
 assert.equal(blocked,true,'deactivation must wait for reservation commit');
 denied(`set role service_role;select * from ${rpc()};`,/sales_scope_denied/);
 sql(`update sales_reps set active=true where user_id='${rep}';`);
});
test('scope schema allowlist, malformed hashes, nulls and manual-kind invariant enforced',options,()=>{
 assert.equal(sql("select string_agg(column_name,',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='membership_v2_sales_quote_scopes';"),
 'id,issuer_user_id,audience,scope_kind,source_verified,idempotency_key_hash,request_fingerprint,created_at');
 for(const fields of ["null,'"+fp(rep)+"'","'"+'A'.repeat(64)+"','"+fp(rep)+"'","'"+'d'.repeat(64)+"',null"])
  denied(`set role service_role;insert into membership_v2_sales_quote_scopes(issuer_user_id,idempotency_key_hash,request_fingerprint) values('${rep}',${fields});`,/not-null|check constraint/);
 denied(`set role service_role;insert into membership_v2_sales_quote_scopes(issuer_user_id,scope_kind,idempotency_key_hash,request_fingerprint)
 values('${rep}','ghl','${'e'.repeat(64)}','${fp(rep)}');`,/check constraint/);
});
test('schema shadowing does not authorize an absent rep',options,()=>{
 const fake='10000000-0000-4000-8000-000000000099';
 sql(`create schema scope_decoy;create table scope_decoy.sales_reps(user_id uuid,active boolean);
 insert into scope_decoy.sales_reps values('${fake}',true);grant usage on schema scope_decoy to service_role;
 grant select on scope_decoy.sales_reps to service_role;`);
 denied(`set role service_role;set search_path=scope_decoy,public,pg_catalog;select * from ${rpc(fake)};`,/sales_scope_denied/);
});
test('a rep with no scope remains deletable; failed deletion and deactivation leave frozen scope unchanged',options,()=>{
 const unscoped='10000000-0000-4000-8000-000000000077';
 sql(`insert into auth.users values('${unscoped}');insert into sales_reps(user_id,email,display_name) values('${unscoped}','unscoped@example.invalid','Synthetic No Scope');
 delete from auth.users where id='${unscoped}';`);
 assert.equal(sql(`select count(*) from sales_reps where user_id='${unscoped}';`),'0');
 const before=sql(`select row_to_json(s) from membership_v2_sales_quote_scopes s where issuer_user_id='${rep}' and idempotency_key_hash='${key}';`);
 denied(`delete from auth.users where id='${rep}';`,/foreign key constraint/);
 assert.equal(sql(`select count(*) from auth.users where id='${rep}';`),'1');
 sql(`update sales_reps set active=false where user_id='${rep}';`);
 assert.equal(sql(`select row_to_json(s) from membership_v2_sales_quote_scopes s where issuer_user_id='${rep}' and idempotency_key_hash='${key}';`),before);
 sql(`update sales_reps set active=true where user_id='${rep}';`);
});
