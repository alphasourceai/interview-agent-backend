'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {prepareEnterprisePoolTerms}=require('../src/services/enterprisePoolSnapshot');
const enabled=process.env.ENTERPRISE_RESERVATION_DISPOSABLE==='true',opts={skip:!enabled};
const socket=process.env.PGHOST||'',port='55443',bin='/opt/homebrew/opt/postgresql@17/bin/';
const database=`enterprise_reservation_${process.pid}`,root=path.join(__dirname,'../supabase/migrations');
const migration='20261012103610_enterprise_checkout_reservations.sql';
const owner='10000000-0000-4000-8000-000000000001',client='10000000-0000-4000-8000-000000000002';
const customer='cus_SYNTHETIC',account='acct_SYNTHETIC';
const lit=v=>v==null?'null':typeof v==='object'?`'${JSON.stringify(v).replaceAll("'","''")}'::jsonb`:
 typeof v==='boolean'||typeof v==='number'?String(v):`'${String(v).replaceAll("'","''")}'`;
function run(q){return cp.spawnSync(`${bin}psql`,['-h',socket,'-p',port,'-U','postgres','-X','-q','-At','-v','ON_ERROR_STOP=1','-d',database,'-c',q],{encoding:'utf8'});}
function sql(q){const r=run(q);assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function denied(q,re){const r=run(q);assert.notEqual(r.status,0);assert.match(r.stderr,re);}
function apply(name){sql(fs.readFileSync(path.join(root,name),'utf8'));}
function source({target=client,fee=100,interval='monthly',expiry='7 days',signed=true,netZero=false}={}){
 const id=crypto.randomUUID(),p=prepareEnterprisePoolTerms({membership_tier:'enterprise',billing_model:'usage',pool_quantity:30,usage_interview_fee_cents:2500});
 if(netZero){p.pool_offer_snapshot={...p.pool_offer_snapshot,coupon_cents:p.pool_offer_snapshot.net_cents,net_cents:0};
  p.pool_offer_digest=sql(`select enterprise_pool_v2_offer_digest(${lit(p.pool_offer_snapshot)});`);p.pool_total_cents=0;}
 p.platform_fee=fee;p.per_role_fee=0;p.included_interviews_per_role=0;p.additional_interview_fee=0;
 const timestamp=sql(`select to_char(clock_timestamp()-interval '10 minutes','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');`);
 const execution={signed_at:timestamp,signer_typed_name:'SYNTHETIC OWNER',signer_accepted:true,
  signature_image_path:`synthetic/${id}/signature.png`,signature_sha256:'a'.repeat(64),
  signer_ip:null,signer_user_agent:'SYNTHETIC',executed_pdf_path:`synthetic/${id}/executed.pdf`};
 const snapshot={values:p,generated_at:timestamp,legal:{synthetic:true}};
 sql(`set role service_role;insert into membership_agreements(id,client_id,status,client_legal_name,primary_admin_name,admin_email,membership_tier,
  initial_term_start,initial_renewal_date,billing_option,template_snapshot,draft_pdf_path,signer_token_hash,signer_token_expires_at,agreement_expires_at)
 values('${id}','${target}','draft','SYNTHETIC ONLY','SYNTHETIC OWNER','synthetic@example.invalid','enterprise',current_date,current_date+365,
 ${lit(interval)},${lit(snapshot)},'synthetic/${id}/draft.pdf','${crypto.randomBytes(32).toString('hex')}',clock_timestamp()+interval '7 days',clock_timestamp()+interval '${expiry}');`);
 if(signed)sql(`set role service_role;update membership_agreements set status='sent' where id='${id}';
  select id from complete_membership_agreement_signing('${id}',${lit(timestamp)},null,'SYNTHETIC OWNER',${lit(execution.signature_image_path)},
  '${'a'.repeat(64)}',null,'SYNTHETIC',${lit(execution.executed_pdf_path)},${lit({...snapshot,execution})});`);
 return id;
}
function parameters(agreement,overrides={}){return {p_id:crypto.randomUUID(),p_pool:crypto.randomUUID(),p_agreement:agreement,p_owner:owner,
 p_environment:'dev',p_account:account,p_mode:false,p_customer:customer,p_key_hash:crypto.randomBytes(32).toString('hex'),...overrides};}
const reserve=p=>`select enterprise_v2_reserve_checkout(${Object.values(p).map(lit).join(',')});`;
const read=p=>`select enterprise_v2_read_checkout(${['p_agreement','p_owner','p_environment','p_account','p_mode','p_customer','p_key_hash'].map(k=>lit(p[k])).join(',')});`;
const pair=p=>JSON.parse(sql(`set role service_role;${read(p)}`));
function parallelSql(q){return new Promise((resolve,reject)=>{
 const child=cp.spawn(`${bin}psql`,['-h',socket,'-p',port,'-U','postgres','-X','-q','-At','-v','ON_ERROR_STOP=1','-d',database,'-c',q]);
 let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);
 child.on('close',code=>resolve({code,out:out.trim(),err}));
});}
function counts(){return sql(`select jsonb_build_object('operations',(select count(*) from enterprise_v2_checkout_operations),'ownedpools',(select count(*) from client_interview_pools where checkout_operation_id is not null));`);}
let grants;
before(()=>{if(!enabled)return;assert.match(socket,/^\/private\/tmp\/alphascreen-reservation-pg\.[A-Za-z0-9]+$/);
 const r=cp.spawnSync(`${bin}createdb`,['-h',socket,'-p',port,'-U','postgres',database],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 sql(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
 create schema auth;grant usage on schema public,auth to service_role;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean,deleted_at timestamptz,banned_until timestamptz);
 create table clients(id uuid primary key,name text,parent_client_id uuid,archived_at timestamptz,stripe_customer_id text);
 create table client_members(id uuid primary key default gen_random_uuid(),client_id uuid,user_id text,user_id_uuid uuid,role text);
 grant select,insert,update,delete on auth.users,clients,client_members to service_role;
 insert into auth.users values('${owner}','synthetic@example.invalid',clock_timestamp()-interval '1 day',false,null,null);
 insert into clients values('${client}','SYNTHETIC ONLY',null,null,'${customer}');
 insert into client_members(client_id,user_id,user_id_uuid,role) values('${client}','${owner}','${owner}','manager');`);
 for(const name of ['20260418130000_membership_agreements.sql','20260418170000_membership_agreements_signing_pass2.sql',
  '20260420102000_membership_agreements_current_model.sql','20260422113000_membership_agreements_checkout_state.sql',
  '20260427112000_membership_agreement_voided_status.sql','20261009180000_client_interview_pools.sql'])apply(name);
 sql(`alter table membership_agreements add column agreement_expires_at timestamptz;alter table membership_agreements enable row level security;
  grant select,insert,update,delete on membership_agreements to service_role;`);
 for(const name of ['20261012032211_enterprise_pool_offer_snapshots.sql','20261012051946_enterprise_pool_source_immutability.sql'])apply(name);
 grants=sql(`select jsonb_agg(jsonb_build_object('name',relname,'acl',relacl::text,'rls',relrowsecurity) order by relname)
  from pg_class where oid in('membership_agreements'::regclass,'client_interview_pools'::regclass,'clients'::regclass,'auth.users'::regclass);`);
 apply(migration);
});
after(()=>{if(!enabled)return;const r=cp.spawnSync(`${bin}dropdb`,['-h',socket,'-p',port,'-U','postgres',database],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);});

test('one native transaction freezes original source/money/cadence/time and reciprocal pending pool with all authority flags false',opts,()=>{
 const p=parameters(source()),ack=JSON.parse(sql(`set role service_role;${reserve(p)}`)),{operation:o,pool}=pair(p);
 assert.deepEqual(ack,{action:'reserved',operation_id:p.p_id,pool_id:p.p_pool});assert.equal(o.platform_cents,10000);assert.equal(o.platform_interval,'month');
 assert.equal(o.source_snapshot.document_fields.id,p.p_agreement);assert.equal(o.source_digest.length,64);
 assert.equal(Date.parse(o.expires_at)-Date.parse(o.created_at),3600000);assert.ok(Date.parse(o.created_at)<=Date.now());
 const anchor=new Date(o.calendar_anchor_at);assert.equal(anchor.getUTCDate(),1);assert.equal(anchor.getUTCHours(),0);
 assert.equal(pool.checkout_operation_id,o.id);assert.equal(pool.created_at,o.created_at);assert.equal(pool.status,'pending');assert.equal(pool.total_cents,69750);
 for(const k of ['checkout_creation_authorized','provider_binding_verified','source_artifacts_verified','credits_spendable'])assert.equal(o[k],false);
});
test('matching retry retains original IDs/time/window without another pool; another key/config conflicts',opts,()=>{
 const p=parameters(source());sql(`set role service_role;${reserve(p)}`);const before=pair(p),beforeCounts=counts();
 const retried={...p,p_id:crypto.randomUUID(),p_pool:crypto.randomUUID()};
 const ack=JSON.parse(sql(`set role service_role;${reserve(retried)}`));assert.equal(ack.action,'already_reserved');assert.equal(ack.operation_id,p.p_id);
 assert.deepEqual(pair(p),before);assert.equal(counts(),beforeCounts);
 for(const patch of [{p_key_hash:'b'.repeat(64)},{p_account:'acct_DIFFERENT'},{p_environment:'staging'}])
  denied(`set role service_role;${reserve({...retried,...patch})}`,/reservation_conflict/);
 assert.equal(counts(),beforeCounts);
});
test('two simultaneous same-source/owner/key requests commit ONE operation/pool with original identity',opts,async()=>{
 const p=parameters(source()),other={...p,p_id:crypto.randomUUID(),p_pool:crypto.randomUUID()},before=JSON.parse(counts());
 const results=await Promise.all([parallelSql(`set role service_role;${reserve(p)}`),parallelSql(`set role service_role;${reserve(other)}`)]);
 for(const r of results)assert.equal(r.code,0,r.err);
 const acks=results.map(r=>JSON.parse(r.out));assert.deepEqual(acks.map(v=>v.action).sort(),['already_reserved','reserved']);
 assert.equal(acks[0].operation_id,acks[1].operation_id);assert.equal(acks[0].pool_id,acks[1].pool_id);
 const after=JSON.parse(counts());assert.equal(after.operations,before.operations+1);assert.equal(after.ownedpools,before.ownedpools+1);
});
test('native opaque source checksum and JSONB replay survive session TimeZone change without altering accepted source',opts,()=>{
 const p=parameters(source());sql(`set role service_role;set timezone='UTC';${reserve(p)}`);
 const utc=JSON.parse(sql(`set role service_role;set timezone='UTC';${read(p)}`));
 const denver=JSON.parse(sql(`set role service_role;set timezone='America/Denver';${read(p)}`));
 assert.deepEqual(utc.operation.source_snapshot,denver.operation.source_snapshot);
 assert.equal(utc.operation.source_digest,denver.operation.source_digest);
 assert.equal(Date.parse(utc.operation.created_at),Date.parse(denver.operation.created_at));
});
test('same owner/environment/key on a different current source conflicts without orphan pool',opts,()=>{
 const a=parameters(source());sql(`set role service_role;${reserve(a)}`);
 const other=crypto.randomUUID();sql(`insert into clients values('${other}','SYNTHETIC OTHER',null,null,'${customer}');
  insert into client_members(client_id,user_id,user_id_uuid,role) values('${other}','${owner}','${owner}','manager');`);
 const b=parameters(source({target:other}),{p_key_hash:a.p_key_hash}),before=counts();
 denied(`set role service_role;${reserve(b)}`,/duplicate key/);assert.equal(counts(),before);
});
test('Auth/table read permissions missing fail closed; no definer or grants bypass is added',opts,()=>{
 const p=parameters(source()),before=counts();
 denied(`begin;revoke select on auth.users from service_role;set role service_role;${reserve(p)}`,/permission denied/);
 assert.equal(counts(),before);
});
test('accepted annual platform cadence and exact two-decimal dollar conversion remain year, not monthly reprice',opts,()=>{
 const p=parameters(source({fee:'100.25',interval:'annual'}));sql(`set role service_role;${reserve(p)}`);
 assert.equal(pair(p).operation.platform_interval,'year');assert.equal(pair(p).operation.platform_cents,10025);
});
for(const fee of [0,-1,0.009,'NaN','1e2','100.001',21474836.48]){
 test(`native malformed/zero/overflow platform fee ${fee} holds atomically`,opts,()=>{
  const p=parameters(source({fee})),before=counts();denied(`set role service_role;${reserve(p)}`,/price_denied/);assert.equal(counts(),before);
 });
}
test('zero-net pool, unsigned source and short/expired source window hold before any operation/pool commit',opts,()=>{
 for(const settings of [{netZero:true},{signed:false},{expiry:'30 minutes'},{expiry:'-1 minute'}]){
  const p=parameters(source(settings)),before=counts();denied(`set role service_role;${reserve(p)}`,/source_denied|window_denied/);assert.equal(counts(),before);
 }
});
test('native source supersession/void prevents a new reservation or recovery of obsolete intent',opts,()=>{
 const old=parameters(source());sql(`set role service_role;${reserve(old)}`);source();const before=counts();
 denied(`set role service_role;${read(old)}`,/source_denied/);denied(`set role service_role;${reserve(old)}`,/source_denied/);
 const p=parameters(source());sql(`set role service_role;update membership_agreements set status='voided',is_current=false where id='${p.p_agreement}';`);
 denied(`set role service_role;${reserve(p)}`,/source_denied/);assert.equal(counts(),before);
});
for(const change of ["is_anonymous=true","email_confirmed_at=null","email_confirmed_at=clock_timestamp()+interval '1 day'",
 "deleted_at=clock_timestamp()","banned_until=clock_timestamp()+interval '1 day'","email='other@example.invalid'"]){
 test(`native Auth ${change} blocks reservation and owned readback`,opts,()=>{
  const p=parameters(source());sql(`set role service_role;${reserve(p)}`);const before=counts();
  denied(`set role service_role;begin;update auth.users set ${change} where id='${owner}';${read(p)}`,/scope_denied|source_denied/);
  denied(`set role service_role;begin;update auth.users set ${change} where id='${owner}';${reserve(p)}`,/scope_denied|source_denied/);
  assert.equal(counts(),before);
 });
}
test('parent/archived/customer pointer and direct native member role/identity changes hold, not global-admin/email bypass',opts,()=>{
 const p=parameters(source());sql(`set role service_role;${reserve(p)}`);
 for(const change of ["parent_client_id='20000000-0000-4000-8000-000000000001'","archived_at=clock_timestamp()","stripe_customer_id='cus_OTHER'"])
  denied(`set role service_role;begin;update clients set ${change} where id='${client}';${read(p)}`,/scope_denied/);
 for(const change of ["role='member'","role='tester'","user_id='20000000-0000-4000-8000-000000000001'",
  "user_id_uuid='20000000-0000-4000-8000-000000000001'","user_id=null,user_id_uuid=null"])
  denied(`set role service_role;begin;update client_members set ${change} where client_id='${client}';${read(p)}`,/scope_denied/);
 sql(`set role service_role;begin;update client_members set user_id_uuid=null where client_id='${client}';${read(p)}rollback;`);
 sql(`set role service_role;begin;update client_members set user_id=null where client_id='${client}';${read(p)}rollback;`);
});
test('raw operation insert cannot invent price/source/clock; reciprocal pool still required at commit',opts,()=>{
 const p=parameters(source()),before=counts();
 const row={id:p.p_id,pool_id:p.p_pool,agreement_id:p.p_agreement,billing_owner_user_id:owner,environment:'dev',
  expected_provider_account_id:account,expected_livemode:false,expected_customer_id:customer,request_key_hash:p.p_key_hash,
  client_id:client,source_snapshot:{forged:true},pool_offer_snapshot:{forged:true},pool_offer_digest:'b'.repeat(64),
  platform_cents:1,platform_interval:'year',created_at:'2000-01-01Z',expires_at:'2000-01-01Z',calendar_anchor_at:'2000-01-01Z'};
 const stmt=`insert into enterprise_v2_checkout_operations(${Object.keys(row).join(',')}) values(${Object.values(row).map(lit).join(',')})`;
 const v=JSON.parse(sql(`set role service_role;begin;${stmt};select row_to_json(t) from enterprise_v2_checkout_operations t where id='${p.p_id}';rollback;`));
 assert.equal(v.platform_cents,10000);assert.equal(v.platform_interval,'month');assert.equal(v.source_snapshot.protocol,'enterprise_signed_source_v2');
 assert.ok(Date.parse(v.created_at)>Date.parse('2000-01-01Z'));
 denied(`set role service_role;${stmt};`,/pool_denied|foreign key/);assert.equal(counts(),before);
});
test('mismatched/pre-existing pool and forced operation-pool FK fail with full rollback',opts,()=>{
 const p=parameters(source()),before=counts();
 const stmt=`insert into enterprise_v2_checkout_operations(id,pool_id,agreement_id,billing_owner_user_id,environment,expected_provider_account_id,expected_livemode,expected_customer_id,request_key_hash)
 values('${p.p_id}','${p.p_pool}','${p.p_agreement}','${owner}','dev','${account}',false,'${customer}','${p.p_key_hash}');`;
 denied(`set role service_role;begin;${stmt}set constraints all immediate;`,/pool_denied|foreign key/);
 denied(`set role service_role;begin;${stmt}insert into client_interview_pools(id,client_id,quantity_purchased,unit_price_cents,total_cents,status,checkout_operation_id)
  values('${p.p_pool}','${client}',1,0,0,'pending','${p.p_id}');`,/pool_denied/);
 assert.equal(counts(),before);
});
test('owned operation and pool bindings immutable; authority/provider IDs cannot be granted; paid credit hold persists',opts,()=>{
 const p=parameters(source());sql(`set role service_role;${reserve(p)}`);const before=pair(p);
 denied(`set role service_role;update enterprise_v2_checkout_operations set platform_cents=1 where id='${p.p_id}';`,/permission denied/);
 denied(`update enterprise_v2_checkout_operations set platform_cents=1 where id='${p.p_id}';`,/immutable/);
 denied(`delete from enterprise_v2_checkout_operations where id='${p.p_id}';`,/immutable/);
 denied('truncate enterprise_v2_checkout_operations cascade;',/immutable/);
 for(const change of ["checkout_operation_id=null","stripe_checkout_session_id='cs_SYNTHETIC'","stripe_payment_intent_id='pi_SYNTHETIC'"])
  denied(`set role service_role;update client_interview_pools set ${change} where id='${p.p_pool}';`,/backfill_denied|no_authority/);
 denied(`set role service_role;update client_interview_pools set status='paid',paid_at=clock_timestamp() where id='${p.p_pool}';`,/PAYMENT_PROOF_REQUIRED|no_authority/);
 assert.deepEqual(pair(p),before);
});
test('owned failed/voided bookkeeping is permitted but neither becomes recoverable/spendable',opts,()=>{
 for(const status of ['failed','voided']){
  const p=parameters(source());sql(`set role service_role;${reserve(p)}update client_interview_pools set status='${status}' where id='${p.p_pool}';`);
  denied(`set role service_role;${read(p)}`,/readback_denied/);
  assert.equal(sql(`select checkout_creation_authorized or credits_spendable from enterprise_v2_checkout_operations where id='${p.p_id}';`),'f');
 }
});
test('new authority true cannot be inserted; wrong environment/mode rejects whole pair',opts,()=>{
 const p=parameters(source()),before=counts();
 for(const patch of [{p_mode:true},{p_environment:'production'},{p_environment:'unknown'},{p_id:'00000000-0000-0000-0000-000000000000'}])
  denied(`set role service_role;${reserve({...p,...patch})}`,/check constraint/);
 assert.equal(counts(),before);
 for(const flag of ['checkout_creation_authorized','provider_binding_verified','source_artifacts_verified','credits_spendable']){
  denied(`set role service_role;insert into enterprise_v2_checkout_operations(id,pool_id,agreement_id,billing_owner_user_id,environment,
  expected_provider_account_id,expected_livemode,expected_customer_id,request_key_hash,${flag})
  values('${crypto.randomUUID()}','${crypto.randomUUID()}','${p.p_agreement}','${owner}','dev','${account}',false,'${customer}','${p.p_key_hash}',true);`,/no_authority/);
 }
 assert.equal(counts(),before);
});
test('legacy/unowned pools remain mutable without adding operation authority; cannot backfill owner binding',opts,()=>{
 const id=crypto.randomUUID();sql(`set role service_role;insert into client_interview_pools(id,client_id,quantity_purchased,unit_price_cents,total_cents)
 values('${id}','${client}',1,0,0);update client_interview_pools set status='paid',paid_at=clock_timestamp(),stripe_payment_intent_id='pi_LEGACY' where id='${id}';`);
 denied(`set role service_role;update client_interview_pools set checkout_operation_id='20000000-0000-4000-8000-000000000001' where id='${id}';`,/backfill_denied/);
 sql(`set role service_role;delete from client_interview_pools where id='${id}';`);
});
test('browser read/RPC/new functions denied, invoker and pinned searchpath, all old ACL/RLS unchanged',opts,()=>{
 assert.equal(sql(`select jsonb_agg(jsonb_build_object('name',relname,'acl',relacl::text,'rls',relrowsecurity) order by relname)
  from pg_class where oid in('membership_agreements'::regclass,'client_interview_pools'::regclass,'clients'::regclass,'auth.users'::regclass);`),grants);
 for(const role of ['anon','authenticated'])denied(`set role ${role};select * from enterprise_v2_checkout_operations;`,/permission denied/);
 const rows=JSON.parse(sql(`select jsonb_agg(jsonb_build_object('name',proname,'definer',prosecdef,'config',proconfig,
  'anon',has_function_privilege('anon',oid,'execute'),'authenticated',has_function_privilege('authenticated',oid,'execute')))
  from pg_proc where pronamespace='public'::regnamespace and proname like 'enterprise_v2_%';`));
 assert.equal(rows.length,6);for(const row of rows){assert.equal(row.definer,false);assert.deepEqual(row.config,['search_path=pg_catalog']);assert.equal(row.anon,false);assert.equal(row.authenticated,false);}
});
