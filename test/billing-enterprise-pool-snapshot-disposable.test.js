'use strict';
// Actual private disposable PostgreSQL only, synthetic rows, no providers.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const {prepareEnterprisePoolTerms:prepare}=require('../src/services/enterprisePoolSnapshot');
const enabled=process.env.ENTERPRISE_POOL_DISPOSABLE==='true',opts={skip:!enabled};
const socket=process.env.PGHOST||'',port='55441',bin='/opt/homebrew/opt/postgresql@17/bin/',database=`alphascreen_pool_snapshot_${process.pid}`;
const root=path.join(__dirname,'../supabase/migrations'),migration='20261012032211_enterprise_pool_offer_snapshots.sql';
const client='10000000-0000-4000-8000-000000000001',oldPool='10000000-0000-4000-8000-000000000002',oldAgreement='10000000-0000-4000-8000-000000000003';
let baseline,grants;
function run(q){return spawnSync(`${bin}psql`,['-h',socket,'-p',port,'-U','postgres','-X','-q','-At','-v','ON_ERROR_STOP=1','-d',database,'-c',q],{encoding:'utf8'});}
function sql(q){const r=run(q);assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
const lit=v=>v==null?'null':typeof v==='object'?`'${JSON.stringify(v).replaceAll("'","''")}'::jsonb`:typeof v==='number'?String(v):`'${String(v).replaceAll("'","''")}'`;
function denied(q,re){const r=run(q);assert.notEqual(r.status,0);assert.match(r.stderr,re);}
function apply(){sql(fs.readFileSync(path.join(root,migration),'utf8'));}
function oldState(){return sql(`select jsonb_build_object('pool',(select row_to_json(t) from(select id,client_id,quantity_purchased,unit_price_cents,discount_pct,total_cents,status,created_at,paid_at from client_interview_pools where id='${oldPool}')t),
  'agreement',(select row_to_json(t) from membership_agreements t where id='${oldAgreement}'));`);}
function permissions(){return sql(`select jsonb_agg(jsonb_build_object('name',relname,'acl',relacl::text,'rls',relrowsecurity) order by relname) from pg_class where oid in('client_interview_pools'::regclass,'membership_agreements'::regclass,'clients'::regclass);`);}
before(()=>{if(!enabled)return;assert.match(socket,/^\/private\/tmp\/alphascreen-pool-pg\.[A-Za-z0-9]+$/);
  let r=spawnSync(`${bin}createdb`,['-h',socket,'-p',port,'-U','postgres',database],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  sql(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    grant usage on schema public to anon,authenticated,service_role;
    create table clients(id uuid primary key,name text);insert into clients values('${client}','SYNTHETIC ONLY');
    create table membership_agreements(id uuid primary key,client_id uuid,membership_tier text,status text,template_snapshot jsonb);
    alter table membership_agreements enable row level security;grant select,insert,update,delete on clients,membership_agreements to service_role;
    insert into membership_agreements values('${oldAgreement}','${client}','enterprise','signed','{"values":{"membership_tier":"enterprise","pool_quantity":"51","pool_discount_pct":"10","pool_total_cents":230}}');`);
  sql(fs.readFileSync(path.join(root,'20261009180000_client_interview_pools.sql'),'utf8'));
  sql(`insert into client_interview_pools(id,client_id,quantity_purchased,unit_price_cents,discount_pct,total_cents,status,created_at,paid_at)
    values('${oldPool}','${client}',51,5,10,230,'paid','2026-09-01Z','2026-09-01Z');`);
  baseline=oldState();grants=permissions();apply();
});
after(()=>{if(!enabled)return;const r=spawnSync(`${bin}dropdb`,['-h',socket,'-p',port,'-U','postgres',database],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);});
function terms(q=51,u=5){return prepare({membership_tier:'enterprise',billing_model:'usage',pool_quantity:q,usage_interview_fee_cents:u});}
function poolInsert(p=terms(),id=crypto.randomUUID(),overrides={}){const s=p.pool_offer_snapshot,row={id,client_id:client,quantity_purchased:s.quantity,unit_price_cents:s.unit_price_cents,
  discount_pct:s.automatic_discount_percent,total_cents:s.net_cents,offer_snapshot:s,offer_digest:p.pool_offer_digest,status:'pending',...overrides};
  return {id,row,stmt:`insert into client_interview_pools(${Object.keys(row).join(',')}) values(${Object.values(row).map(lit).join(',')});`};}
function agreementInsert(p=terms(),id=crypto.randomUUID(),overrides={}){const row={id,client_id:client,membership_tier:'enterprise',status:'draft',template_snapshot:{values:p},...overrides};
  return {id,row,stmt:`insert into membership_agreements(${Object.keys(row).join(',')}) values(${Object.values(row).map(lit).join(',')});`};}
test('additive migration applies/replays without changing legacy accepted rows, grants or RLS',opts,()=>{
  assert.equal(oldState(),baseline);assert.equal(permissions(),grants);apply();assert.equal(oldState(),baseline);assert.equal(permissions(),grants);
  assert.equal(sql(`select offer_snapshot is null and offer_digest is null from client_interview_pools where id='${oldPool}';`),'t');
});
test('native fixed digest and real jsonb round-trip match JavaScript for all bands and half-cent tie',opts,()=>{
  for(const q of [1,19,20,29,30,49,50,51,100])for(const u of [1,5,2500]){const p=terms(q,u),x=poolInsert(p);sql(`set role service_role;${x.stmt}`);
    const r=JSON.parse(sql(`set role service_role;select row_to_json(t) from client_interview_pools t where id='${x.id}';`));
    assert.deepEqual(r.offer_snapshot,p.pool_offer_snapshot);assert.equal(r.offer_digest,p.pool_offer_digest);
    assert.equal(sql(`set role service_role;select enterprise_pool_v2_offer_digest(${lit(r.offer_snapshot)});`),p.pool_offer_digest);}
});
test('extra/missing/null/string/fractional/version/currency and forged digest cannot create native v2 row',opts,()=>{
  const p=terms();for(const change of [{quantity:'51'},{unit_price_cents:5.5},{currency:null},{offer_version:null},{offer_version:'unknown'},{net_cents:230},{extra:true}]){
    const x=poolInsert(p,undefined,{offer_snapshot:{...p.pool_offer_snapshot,...change}});denied(`set role service_role;${x.stmt}`,/snapshot_check|invalid input/);}
  for(const override of [{offer_digest:'a'.repeat(64)},{offer_snapshot:null},{offer_digest:null},{quantity_purchased:50},{discount_pct:10.5},{total_cents:230}]){
    const x=poolInsert(p,undefined,override);denied(`set role service_role;${x.stmt}`,/snapshot_check/);}
});
test('native quote scalar column bounds, pending state and real client are enforced',opts,()=>{
  const p=terms();for(const override of [{status:'paid'},{paid_at:'2026-10-12Z'},{stripe_payment_intent_id:'pi_synthetic'}]){
    const x=poolInsert(p,undefined,override);denied(`set role service_role;${x.stmt}`,/pending_required/);}
  const x=poolInsert(p,undefined,{client_id:crypto.randomUUID()});denied(`set role service_role;${x.stmt}`,/client_denied/);
});
test('new commercial snapshot is immutable, cannot be stripped/deleted, legacy cannot be upgraded',opts,()=>{
  const x=poolInsert();sql(`set role service_role;${x.stmt}`);
  for(const patch of ["total_cents=230","discount_pct=0","client_id='"+crypto.randomUUID()+"'","offer_snapshot=null,offer_digest=null"])
    denied(`set role service_role;update client_interview_pools set ${patch} where id='${x.id}';`,/immutable/);
  denied(`set role service_role;delete from client_interview_pools where id='${x.id}';`,/immutable/);
  const p=terms();denied(`set role service_role;update client_interview_pools set offer_snapshot=${lit(p.pool_offer_snapshot)},offer_digest='${p.pool_offer_digest}',total_cents=229 where id='${oldPool}';`,/backfill_denied/);
  assert.equal(oldState(),baseline);
});
test('v2 paid update is held natively; failed/voided and legacy pending-to-paid retain meaning',opts,()=>{
  const x=poolInsert();sql(`set role service_role;${x.stmt}`);
  denied(`set role service_role;update client_interview_pools set status='paid',paid_at=clock_timestamp() where id='${x.id}';`,/PAYMENT_PROOF_REQUIRED/);
  sql(`set role service_role;update client_interview_pools set stripe_checkout_session_id='cs_synthetic',status='failed' where id='${x.id}';`);
  assert.equal(sql(`select status from client_interview_pools where id='${x.id}';`),'failed');
  const id=crypto.randomUUID();sql(`set role service_role;insert into client_interview_pools(id,client_id,quantity_purchased,unit_price_cents,total_cents) values('${id}','${client}',1,0,0);
    update client_interview_pools set status='paid',paid_at=clock_timestamp(),stripe_payment_intent_id='pi_legacy' where id='${id}' and offer_snapshot is null and offer_digest is null;`);
  assert.equal(sql(`select status from client_interview_pools where id='${id}';`),'paid');
});
test('actual agreement quote frozen across signing/execution metadata; legacy not backfilled',opts,()=>{
  const a=agreementInsert();sql(`set role service_role;${a.stmt}update membership_agreements set status='signed',template_snapshot=template_snapshot||'{"execution":{"synthetic":true}}' where id='${a.id}';`);
  const p=terms(30);denied(`set role service_role;update membership_agreements set template_snapshot=${lit({values:p})} where id='${a.id}';`,/agreement_immutable/);
  denied(`set role service_role;update membership_agreements set template_snapshot=${lit({values:terms()})} where id='${oldAgreement}';`,/agreement_backfill_denied/);
  assert.equal(oldState(),baseline);
});
test('invalid/both-null marker, wrong model/plan/scalar/digest and forged signed insertion are held',opts,()=>{
  for(const patch of [{billing_model:'fixed'},{membership_tier:'basic'},{pool_quantity:50},{pool_total_cents:230},{pool_offer_digest:null},{pool_offer_snapshot:null},{pool_discount_priced:false}]){
    const a=agreementInsert({...terms(),...patch});denied(`set role service_role;${a.stmt}`,/agreement_denied|invalid input/);}
  const a=agreementInsert(terms(),undefined,{status:'signed'});denied(`set role service_role;${a.stmt}`,/draft_required/);
});
test('browser roles cannot read/write pools or call new invoker functions, parent grants remain unchanged',opts,()=>{
  for(const role of ['anon','authenticated']){
    denied(`set role ${role};select * from client_interview_pools;`,/permission denied/);
    denied(`set role ${role};select enterprise_pool_v2_valid_offer('{}');`,/permission denied/);}
  for(const fn of ['enterprise_pool_v2_valid_offer','enterprise_pool_v2_canonical','enterprise_pool_v2_offer_digest','enterprise_pool_v2_guard_pool','enterprise_pool_v2_guard_agreement']){
    assert.equal(sql(`select prosecdef from pg_proc where pronamespace='public'::regnamespace and proname='${fn}';`),'f');}
  assert.equal(permissions(),grants);
});
