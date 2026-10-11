'use strict';
// Actual task-owned Unix-socket PostgreSQL, no hosted DB or provider SDK.
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const {spawnSync}=require('node:child_process');const {before,after,test}=require('node:test');
const crypto=require('node:crypto');
const {OFFER_VERSION}=require('../src/services/membershipOffers');
const {createMembershipQuoteDraftService}=require('../src/services/membershipQuoteDrafts');
const ENABLED=process.env.MEMBERSHIP_V2_DISPOSABLE==='true';
const SOCKET=process.env.PGHOST || '', PORT=process.env.PGPORT || '55440';
const DATABASE=`alphascreen_membership_quote_${process.pid}`;
const PG='/opt/homebrew/opt/postgresql@17/bin/';const options={skip:!ENABLED};
const root=path.join(__dirname,'../supabase/migrations');
const migrations=['20261011163625_membership_v2_contract_store.sql','20261011194051_membership_v2_quote_drafts.sql'];
const rep='10000000-0000-4000-8000-000000000001',owner='10000000-0000-4000-8000-000000000002';
const client='10000000-0000-4000-8000-000000000003',scope='10000000-0000-4000-8000-000000000004';
const start='2026-10-11T12:00:00.000Z';
const choose={planKey:'basic',commitmentMonths:3,paymentOption:'prepaid',offerVersion:OFFER_VERSION};
function args(){return ['-h',SOCKET,'-p',PORT,'-U','postgres','-X','-q','-At','-v','ON_ERROR_STOP=1','-d',DATABASE];}
function run(statement){return spawnSync(`${PG}psql`,[...args(),'-c',statement],{encoding:'utf8'});}
function sql(statement){const result=run(statement);assert.equal(result.status,0,result.stderr);return result.stdout.trim();}
function literal(value){return value===null?'null':typeof value==='object'?`'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`:
  typeof value==='number'?String(value):`'${String(value).replaceAll("'","''")}'`;}
function insert(row){return `insert into membership_v2_quote_drafts(${Object.keys(row).join(',')}) values(${Object.values(row).map(literal).join(',')});`;}
function denied(statement,pattern){const r=run(statement);assert.notEqual(r.status,0,r.stdout);assert.match(r.stderr,pattern);}
function serviceDB(){return {from(table){assert.equal(table,'membership_v2_quote_drafts');return {
  async insert(row){const r=run(`set role service_role; ${insert(row)}`);return {error:r.status?{code:'sql_error'}:null};},
  select(){const filters={};const query={eq(key,value){filters[key]=value;return query;},is(key,value){filters[key]=value;return query;},
    async maybeSingle(){const clause=Object.entries(filters).map(([key,value])=>value===null?`${key} is null`:`${key}=${literal(value)}`).join(' and ');
      const r=run(`set role service_role; select row_to_json(q) from membership_v2_quote_drafts q where ${clause};`);
      return {data:r.stdout.trim()?JSON.parse(r.stdout):null,error:r.status?{code:'sql_error'}:null};}};return query;}
};}};}
function authorization(audience='sales',change={}){return {scope_id:scope,audience,issuer_user_id:audience==='public'?null:rep,
  original_salesperson_user_id:audience==='public'?null:rep,client_id:null,billing_owner_user_id:null,...change};}
async function create(audience='sales',input={},change={},id=crypto.randomUUID()){
  const service=createMembershipQuoteDraftService({db:serviceDB(),authorizeScope:async()=>authorization(audience,change),now:()=>start,newId:()=>id});
  const result=await service.createQuote('trusted fixture',{...choose,...input});
  const row=JSON.parse(sql(`select row_to_json(q) from membership_v2_quote_drafts q where id='${id}';`));
  return {result,row,service};
}
function recanonical(row){
  const doc=JSON.parse(row.canonical_quote);
  Object.assign(doc,{quote_id:row.id,scope_id:row.scope_id,audience:row.audience,issuer_user_id:row.issuer_user_id,
    original_salesperson_user_id:row.original_salesperson_user_id,client_id:row.client_id,billing_owner_user_id:row.billing_owner_user_id,
    offer:row.offer_snapshot,template_version:row.template_version,template_status:row.template_status,
    issued_at:new Date(row.issued_at).toISOString(),expires_at:new Date(row.expires_at).toISOString()});
  const stable=v=>v && typeof v==='object'?(Array.isArray(v)?`[${v.map(stable).join(',')}]`:
    `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`):JSON.stringify(v);
  row.canonical_quote=stable(doc);row.quote_digest=crypto.createHash('sha256').update(row.canonical_quote).digest('hex');
}
before(()=>{
  if(!ENABLED)return;
  assert.match(SOCKET,/^\/private\/tmp\/alphascreen-membership-v2-pg\.[A-Za-z0-9]+$/);
  const created=spawnSync(`${PG}createdb`,['-h',SOCKET,'-p',PORT,'-U','postgres',DATABASE],{encoding:'utf8'});assert.equal(created.status,0,created.stderr);
  sql(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create table auth.users(id uuid primary key);
    create table clients(id uuid primary key,platform_fee numeric,status text);
    create table membership_agreements(id uuid primary key,client_id uuid references clients(id));
    create table public_purchase_intents(id uuid primary key,client_id uuid references clients(id));
    insert into auth.users values('${rep}'),('${owner}');insert into clients values('${client}',299,'active');
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant select on membership_agreements,public_purchase_intents to service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
  for(const migration of migrations){const r=spawnSync(`${PG}psql`,[...args(),'-f',path.join(root,migration)],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);}
});
after(()=>{if(!ENABLED)return;const r=spawnSync(`${PG}dropdb`,['-h',SOCKET,'-p',PORT,'-U','postgres',DATABASE],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);});

test('quote migration does not change legacy data, create contracts/receipts or add schedules',options,()=>{
  assert.equal(sql('select platform_fee,status from clients;'),'299|active');
  for(const table of ['membership_agreements','public_purchase_intents','membership_v2_contracts','membership_v2_initial_receipts','membership_v2_paid_periods'])
    assert.equal(sql(`select count(*) from ${table};`),'0');
  assert.equal(sql("select count(*) from pg_tables where schemaname='cron';"),'0');
});
test('browser grants/RLS/function access denied; service has only INSERT/SELECT on quote ledger',options,()=>{
  assert.equal(sql("select relrowsecurity and relowner <> (select oid from pg_roles where rolname='service_role') from pg_class where oid='membership_v2_quote_drafts'::regclass;"),'t');
  assert.equal(sql("select rolsuper from pg_roles where rolname='service_role';"),'f');
  assert.equal(sql("select count(*) from pg_policies where tablename='membership_v2_quote_drafts';"),'0');
  for(const role of ['anon','authenticated']){
    for(const privilege of ['select','insert','update','delete','truncate'])assert.equal(sql(`select has_table_privilege('${role}','membership_v2_quote_drafts','${privilege}');`),'f');
    assert.equal(sql(`select has_function_privilege('${role}','membership_v2_quote_canonical(jsonb)','execute');`),'f');
    denied(`set role ${role};select * from membership_v2_quote_drafts;`,/permission denied/);
    // Even a rollback-only SELECT grant leaves RLS with zero visible rows.
    assert.equal(sql(`begin;grant select on membership_v2_quote_drafts to ${role};set local role ${role};select count(*) from membership_v2_quote_drafts;rollback;`),'0');
  }
  for(const privilege of ['select','insert','update','delete','truncate'])assert.equal(sql(`select has_table_privilege('service_role','membership_v2_quote_drafts','${privilege}');`),['select','insert'].includes(privilege)?'t':'f');
});
test('SQL and JS canonical bytes/digests agree for public explicit nulls and monthly first-role prepay',options,async()=>{
  const vectors=[['public',{},'20000000-0000-4000-8000-000000000001','82526feb00a5dcbd3691194c9793769adf0bd70340e0a81010b8b4f1bd6f7387'],
    ['sales',{planKey:'pro',commitmentMonths:6,paymentOption:'monthly_installments',firstRolePrepaySelected:true},'20000000-0000-4000-8000-000000000002','8b7050bbb145c47f95d55913d7d70acd8f0d4913ed665263a61cc2772cbe01ad']];
  for(const [audience,input,id,expectedDigest] of vectors){const {row,result}=await create(audience,input,{},id);
    assert.equal(sql(`set role service_role;select public.membership_v2_quote_canonical('${row.canonical_quote.replaceAll("'","''")}'::jsonb) = canonical_quote
      and encode(pg_catalog.sha256(convert_to(canonical_quote,'UTF8')),'hex') = quote_digest from membership_v2_quote_drafts where id='${id}';`),'t');
    assert.equal(row.quote_digest,result.quote_digest);
    assert.equal(row.quote_digest,expectedDigest);
  }
});
test('all12 server selections persist/read back full actual quote without payment or activation',options,async()=>{
  for(const planKey of ['basic','pro'])for(const commitmentMonths of [3,6,12])for(const paymentOption of ['prepaid','monthly_installments']){
    const {result,service}=await create('sales',{planKey,commitmentMonths,paymentOption});
    const read=await service.readQuote('trusted fixture',result.quote.quote_id);assert.deepEqual(read,result);
    assert.equal(result.signing_enabled,false);
  }
  assert.equal(sql('select platform_fee,status from clients;'),'299|active');
  assert.equal(sql('select count(*) from membership_v2_contracts;'),'0');
});
test('SQL rejects public issuer/rep/client/owner/installments and partial identity pairing',options,async()=>{
  const {row}=await create('public');
  for(const changed of [{issuer_user_id:rep},{original_salesperson_user_id:rep},{client_id:client,billing_owner_user_id:owner},
    {client_id:client},{billing_owner_user_id:owner}]){
    const attempt={...structuredClone(row),id:crypto.randomUUID(),...changed};recanonical(attempt);
    denied(`set role service_role;${insert(attempt)}`,/check constraint/);
  }
  const {row:installment}=await create('sales',{paymentOption:'monthly_installments'});
  installment.id=crypto.randomUUID();installment.audience='public';installment.issuer_user_id=null;installment.original_salesperson_user_id=null;recanonical(installment);
  denied(`set role service_role;${insert(installment)}`,/check constraint/);
});
test('immutable UPDATE/DELETE/TRUNCATE reject service and owner even under accidental granted privileges',options,async()=>{
  const {row}=await create();
  for(const statement of [`update membership_v2_quote_drafts set id=id where id='${row.id}';`,
    `delete from membership_v2_quote_drafts where id='${row.id}';`,'truncate membership_v2_quote_drafts;']){
    denied(`set role service_role;${statement}`,/permission denied/);
    denied(statement,/immutable_membership_record/);
    denied(`begin;grant update,delete,truncate on membership_v2_quote_drafts to service_role;set local role service_role;${statement}rollback;`,/immutable_membership_record/);
  }
});
test('canonical field order/whitespace, digest, different offer and unsigned markers cannot diverge',options,async()=>{
  const {row}=await create();
  for(const change of [r=>r.quote_digest='a'.repeat(64),r=>r.offer_snapshot.platform_payment_cents=1,
    r=>r.canonical_quote=JSON.stringify(JSON.parse(r.canonical_quote),null,2),r=>r.canonical_quote=r.canonical_quote.replace('"unsigned"','"signed"'),
    r=>r.canonical_quote=r.canonical_quote.replace('"signing_source_bound":false','"signing_source_bound":true')]){
    const attempt={...structuredClone(row),id:crypto.randomUUID()};recanonical(attempt);change(attempt);
    // Hash may be self-consistent but must still match the complete canonical row.
    attempt.quote_digest=crypto.createHash('sha256').update(attempt.canonical_quote).digest('hex');
    if(change.toString().includes('quote_digest'))attempt.quote_digest='a'.repeat(64);
    denied(`set role service_role;${insert(attempt)}`,/check constraint/);
  }
});
test('SQL checks complete capacity/financial terms, strict UTC expiry and supported months',options,async()=>{
  const {row}=await create();
  for(const change of [r=>r.offer_snapshot.commitment_months=4,r=>delete r.offer_snapshot.per_role_fee_cents,
    r=>r.offer_snapshot.renewal.default_auto_renew=false,r=>r.offer_snapshot.platform_payment_cents=null,
    r=>r.expires_at='2026-10-11T12:31:00.000Z',r=>r.issued_at='2026-10-11T12:00:00.000001Z']){
    const attempt={...structuredClone(row),id:crypto.randomUUID()};change(attempt);recanonical(attempt);
    denied(`set role service_role;${insert(attempt)}`,/check constraint/);
  }
  denied(`set role service_role;insert into membership_v2_quote_drafts select id,scope_id,audience,issuer_user_id,original_salesperson_user_id,
    client_id,billing_owner_user_id,offer_snapshot,template_version,template_status,'infinity',expires_at,canonical_quote,quote_digest from membership_v2_quote_drafts limit 1;`,/check constraint/);
});
test('tenant/Auth FK identity changes cannot silently rewrite quote bindings',options,async()=>{
  await create('admin',{}, {client_id:client,billing_owner_user_id:owner});
  denied(`delete from clients where id='${client}';`,/foreign key constraint/);
  denied(`update clients set id=gen_random_uuid() where id='${client}';`,/foreign key constraint/);
  denied(`delete from auth.users where id='${owner}';`,/foreign key constraint/);
  denied(`update auth.users set id=gen_random_uuid() where id='${owner}';`,/foreign key constraint/);
  assert.equal(sql(`select platform_fee,status from clients where id='${client}';`),'299|active');
});
