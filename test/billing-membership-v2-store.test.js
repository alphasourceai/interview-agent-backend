'use strict';

// Real PostgreSQL, task-owned Unix socket only. No hosted DB/provider/key.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { before, after, test } = require('node:test');
const { buildRetailOffer, OFFER_VERSION, anchoredMonthInstant } = require('../src/services/membershipOffers');
const ENABLED = process.env.MEMBERSHIP_V2_DISPOSABLE === 'true';
const SOCKET = process.env.PGHOST || '';
const PORT = process.env.PGPORT || '55440';
const DATABASE = `alphascreen_membership_v2_${process.pid}`;
const PG = '/opt/homebrew/opt/postgresql@17/bin/';
const migration = path.join(__dirname,'../supabase/migrations/20261011163625_membership_v2_contract_store.sql');
const owner = '10000000-0000-4000-8000-000000000001';
const client = '10000000-0000-4000-8000-000000000002';
const otherClient = '10000000-0000-4000-8000-000000000003';
const options = { skip: !ENABLED };
const tables = ['contracts','provider_bindings','initial_receipts','contract_state','paid_periods'].map(n=>`membership_v2_${n}`);
let sequence = 10;
function args(database = DATABASE) { return ['-h',SOCKET,'-p',PORT,'-U','postgres','-X','-q','-At','-v','ON_ERROR_STOP=1','-d',database]; }
function run(statement) { return spawnSync(`${PG}psql`,[...args(),'-c',statement],{encoding:'utf8'}); }
function sql(statement) { const r = run(statement); assert.equal(r.status,0,r.stderr); return r.stdout.trim(); }
function service(statement) { return sql(`set role service_role; ${statement}`); }
function literal(value) { return `'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`; }
function fails(statement, expected) { const r = run(statement); assert.notEqual(r.status,0,r.stdout); assert.match(r.stderr,expected); }
function offer(paymentOption='prepaid',commitmentMonths=3) {
  return buildRetailOffer({planKey:'basic',paymentOption,commitmentMonths,channel:'sales',offerVersion:OFFER_VERSION});
}
function setup({paymentOption='prepaid',months=3,changes={},sourceClient=client}={}) {
  const n = ++sequence; const id = `20000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const snapshot = {...offer(paymentOption,months),...changes};
  sql(`insert into membership_agreements(id,client_id) values('${id}',${sourceClient ? `'${sourceClient}'` : 'null'});`);
  service(`insert into membership_v2_contracts(id,contract_version,client_id,billing_owner_user_id,agreement_id,
    offer_snapshot,acceptance_digest,accepted_at) values('${id}',1,'${client}','${owner}','${id}',${literal(snapshot)},
    repeat('a',64),'2026-01-01T00:00:00Z');`);
  return {id,n,snapshot};
}
function bind(c,{account='acct_Synthetic',mode=false,subscription=`sub_${c.n}`,checkout=`cs_${c.n}`}={}) {
  service(`insert into membership_v2_provider_bindings(contract_id,contract_version,provider_account_id,livemode,
    customer_id,checkout_session_id,subscription_id,platform_price_id,platform_item_id)
    values('${c.id}',1,'${account}',${mode},'cus_Shared','${checkout}','${subscription}','price_${c.n}','si_${c.n}');`);
  return {account,mode,subscription,checkout};
}
function receipt(c,b,extra={}) {
  return { contract_id:c.id,contract_version:1,offer_version:c.snapshot.offer_version,currency:'usd',livemode:b.mode,
    customer_id:'cus_Shared',checkout_session_id:b.checkout,subscription_id:b.subscription,
    platform_price_id:`price_${c.n}`,platform_item_id:`si_${c.n}`,first_role_price_id:null,
    invoice_id:`in_${c.n}`,payment_intent_id:`pi_${c.n}`,charge_id:`ch_${c.n}`,platform_line_id:`il_${c.n}`,
    payment_success_at:'2026-01-31T14:20:30.000Z',collected_cents:c.snapshot.initial_payment_cents,
    platform_payment_cents:c.snapshot.platform_payment_cents,first_role_payment_cents:0,tax_cents:0,...extra };
}
function call(c,b,r,overrides={}) {
  return `select membership_v2_reserve_initial_payment('${c.id}',${overrides.version ?? 1},
    '${overrides.client ?? client}','${overrides.owner ?? owner}','${overrides.account ?? b.account}',${literal(r)});`;
}
function asyncSQL(statement) {
  return new Promise(resolve=>{const child = spawn(`${PG}psql`,[...args(),'-c',statement]); let out='',err='';
    child.stdout.on('data',d=>out+=d); child.stderr.on('data',d=>err+=d);
    child.on('close',status=>resolve({status,out,err}));});
}
before(()=>{
  if (!ENABLED) return;
  assert.match(SOCKET,/^\/private\/tmp\/alphascreen-membership-v2-pg\.[A-Za-z0-9]+$/);
  const created = spawnSync(`${PG}createdb`,['-h',SOCKET,'-p',PORT,'-U','postgres',DATABASE],{encoding:'utf8'});
  assert.equal(created.status,0,created.stderr);
  sql(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create table clients(id uuid primary key,platform_fee numeric,legacy_terms text);
    create table membership_agreements(id uuid primary key,client_id uuid references clients(id));
    create table public_purchase_intents(id uuid primary key,client_id uuid references clients(id));
    insert into auth.users values('${owner}');
    insert into clients values('${client}',299,'legacy annual'),('${otherClient}',499,'custom signed');
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant select on membership_agreements,public_purchase_intents to service_role;
    -- Emulate older Supabase automatic grants; the migration must revoke them.
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;`);
  const result = spawnSync(`${PG}psql`,[...args(),'-f',migration],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
after(()=>{
  if (!ENABLED) return;
  const dropped = spawnSync(`${PG}dropdb`,['-h',SOCKET,'-p',PORT,'-U','postgres',DATABASE],{encoding:'utf8'});
  assert.equal(dropped.status,0,dropped.stderr);
});

test('additive schema leaves all synthetic legacy clients and prices unchanged',options,()=>{
  assert.equal(sql('select count(*) from membership_v2_contracts'),'0');
  assert.equal(sql('select string_agg(platform_fee::text || legacy_terms,\',\' order by platform_fee) from clients'),'299legacy annual,499custom signed');
});
test('all public v2 objects deny anon/authenticated grants; RLS enabled; no SECURITY DEFINER',options,()=>{
  for (const table of tables) {
    assert.equal(sql(`select relrowsecurity from pg_class where oid='public.${table}'::regclass`),'t');
    for (const role of ['anon','authenticated']) {
      assert.equal(sql(`select has_table_privilege('${role}','public.${table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`),'f');
      fails(`set role ${role}; select * from public.${table};`,/permission denied/);
    }
    assert.equal(sql(`select has_table_privilege('service_role','public.${table}','DELETE,TRUNCATE')`),'f');
  }
  assert.equal(sql("select bool_and(not prosecdef) from pg_proc where proname like 'membership_v2_%'"),'t');
  assert.equal(sql("select bool_and(not has_function_privilege('authenticated',oid,'EXECUTE') and not has_function_privilege('anon',oid,'EXECUTE')) from pg_proc where proname like 'membership_v2_%'"),'t');
  fails("set role authenticated; select membership_v2_month_anchor(now(),3)",/permission denied/);
});
test('SQL calendar anchors match JS original-anchor arithmetic across month ends/leap years/timezones',options,()=>{
  for (const anchor of ['2026-01-31T14:20:30.000Z','2024-02-29T00:00:00.000Z','2026-08-31T23:59:59.000Z']) {
    for (const month of [0,1,2,3,6,12,24]) {
      const actual = service(`set timezone='America/Denver'; select to_char(membership_v2_month_anchor('${anchor}',${month}) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');`);
      assert.equal(actual,anchoredMonthInstant(anchor,month));
    }
  }
  fails("select membership_v2_month_anchor('infinity',3)",/invalid_membership_anchor/);
  fails("select membership_v2_month_anchor('9999-12-31T00:00:00Z',3)",/invalid_membership_anchor/);
});
test('offer storage rejects missing/negative/fraction/string/unsafe values but retains accepted future-version price',options,()=>{
  for (const changes of [{plan_key:null},{payment_option:null},{schema_version:'2'},
    {platform_payment_cents:-1},{platform_payment_cents:1.5},{platform_payment_cents:'120000'},
    {platform_payment_cents:9007199254740992},{platform_payment_cents:null},{commitment_months:4},
    {renewal:{}},{renewal:{...offer().renewal,default_auto_renew:'true'}},
    {per_role_fee_cents:null},{display_name:null},{scored_question_count:20},
    {first_role_prepay:{selected:false,amount_cents:null}}]) {
    assert.equal(service(`select membership_v2_valid_offer(${literal({...offer(),...changes})});`),'f');
  }
  const c = setup({changes:{offer_version:'accepted-future-v2',platform_payment_cents:130000,
    initial_payment_cents:130000,platform_commitment_total_cents:130000}});
  assert.equal(service(`select offer_snapshot->>'platform_payment_cents' from membership_v2_contracts where id='${c.id}';`),'130000');
});
test('source client mismatch and ambiguous source linkage are rejected',options,()=>{
  assert.throws(()=>setup({sourceClient:otherClient}),/membership_source_owner_conflict/);
  const c = setup();
  sql(`insert into public_purchase_intents values('${c.id}','${client}');`);
  fails(`set role service_role; insert into membership_v2_contracts select gen_random_uuid(),contract_version,
    client_id,billing_owner_user_id,agreement_id,'${c.id}',offer_snapshot,acceptance_digest,accepted_at,
    original_salesperson_user_id,created_at from membership_v2_contracts where id='${c.id}';`,/check constraint/);
});
test('accepted snapshot, binding, receipts and paid periods are immutable',options,()=>{
  const c = setup(), b=bind(c); service(call(c,b,receipt(c,b)));
  for (const table of ['contracts','provider_bindings','initial_receipts','paid_periods']) {
    const idColumn = table==='contracts' ? 'id' : 'contract_id';
    fails(`update membership_v2_${table} set ${idColumn}=${idColumn} where ${idColumn}='${c.id}';`,/immutable_membership_record/);
    fails(`delete from membership_v2_${table} where ${idColumn}='${c.id}';`,/immutable_membership_record/);
  }
});
test('prepaid reservation writes exactly one receipt/state/period with whole commitment access; no client activation',options,()=>{
  const c=setup({months:6}),b=bind(c);
  const result=JSON.parse(service(call(c,b,receipt(c,b))));
  assert.equal(result.action,'initial_payment_reserved'); assert.equal(result.renewal_ready,false);
  assert.equal(service(`select term_end_at= '2026-07-31T14:20:30Z' and not renewal_ready and provider_alignment='pending' from membership_v2_contract_state where contract_id='${c.id}'`),'t');
  assert.equal(service(`select starts_at='2026-01-31T14:20:30Z' and ends_at='2026-07-31T14:20:30Z' from membership_v2_paid_periods where contract_id='${c.id}'`),'t');
  assert.equal(sql(`select platform_fee,legacy_terms from clients where id='${client}'`),'299|legacy annual');
});
test('installment commitment and paid access are distinct; no unearned full-term access',options,()=>{
  const c=setup({paymentOption:'monthly_installments',months:12}),b=bind(c);service(call(c,b,receipt(c,b)));
  assert.equal(service(`select term_end_at='2027-01-31T14:20:30Z' from membership_v2_contract_state where contract_id='${c.id}'`),'t');
  assert.equal(service(`select ends_at='2026-02-28T14:20:30Z' from membership_v2_paid_periods where contract_id='${c.id}'`),'t');
});
test('matching replay is identity-only and does not restart terms/preferences/receipt timestamps',options,()=>{
  const c=setup(),b=bind(c),r=receipt(c,b);service(call(c,b,r));
  const before = service(`select row_to_json(r) from membership_v2_initial_receipts r where contract_id='${c.id}';`);
  service(`update membership_v2_contract_state set auto_renew=false,revision=2,preference_version=2 where contract_id='${c.id}';`);
  const result=JSON.parse(service(`set timezone='UTC'; ${call(c,b,{...r,collected_cents:0,tax_cents:1000})}`));
  assert.deepEqual(Object.keys(result).sort(),['action','identity']);assert.equal(result.action,'already_reserved');
  assert.equal(service(`select row_to_json(r) from membership_v2_initial_receipts r where contract_id='${c.id}';`),before);
  assert.equal(service(`select not auto_renew and preference_version=2 and revision=2 from membership_v2_contract_state where contract_id='${c.id}'`),'t');
  fails(`set role service_role; ${call(c,b,{...r,charge_id:'ch_Different'})}`,/membership_initial_receipt_conflict/);
});
test('owner/client/version/provider/binding mismatch never creates any receipt',options,()=>{
  const c=setup(),b=bind(c),r=receipt(c,b);
  for (const override of [{version:2},{client:otherClient},{owner:otherClient},{account:'acct_Other'}]) {
    fails(`set role service_role; ${call(c,b,r,override)}`,/membership_contract_scope_conflict|membership_binding_missing/);
  }
  for (const change of [{livemode:true},{platform_item_id:'si_Unknown'},{customer_id:'cus_Other'},{contract_version:null}]) {
    fails(`set role service_role; ${call(c,b,{...r,...change})}`,/membership_receipt_binding_conflict/);
  }
  assert.equal(service(`select count(*) from membership_v2_initial_receipts where contract_id='${c.id}'`),'0');
});
test('each invoice, PI or charge can belong to only one contract per provider account/mode; failed transaction writes nothing',options,()=>{
  const first=setup(),fb=bind(first),fr=receipt(first,fb);service(call(first,fb,fr));
  for (const key of ['invoice_id','payment_intent_id','charge_id']) {
    const c=setup(),b=bind(c);fails(`set role service_role; ${call(c,b,receipt(c,b,{[key]:fr[key]}))}`,/duplicate key/);
    assert.equal(service(`select count(*) from membership_v2_initial_receipts where contract_id='${c.id}'`),'0');
    assert.equal(service(`select count(*) from membership_v2_contract_state where contract_id='${c.id}'`),'0');
    assert.equal(service(`select count(*) from membership_v2_paid_periods where contract_id='${c.id}'`),'0');
  }
  for (const key of ['subscription','checkout']) {
    const c=setup();assert.throws(()=>bind(c,{[key]:fb[key]}),/duplicate key/);
  }
});
test('provider account and mode are part of identity, customers may be reused',options,()=>{
  const c=setup(),b=bind(c),r=receipt(c,b);service(call(c,b,r));
  for (const config of [{account:'acct_Other',subscription:b.subscription,checkout:b.checkout},
    {mode:true,subscription:b.subscription,checkout:b.checkout}]) {
    const next=setup(),nb=bind(next,config);service(call(next,nb,receipt(next,nb,{
      invoice_id:r.invoice_id,payment_intent_id:r.payment_intent_id,charge_id:r.charge_id})));
  }
});
test('malformed/unpaid/mismatched amounts/timestamps roll back without reserving identifiers',options,()=>{
  const c=setup(),b=bind(c),r=receipt(c,b);
  for (const change of [{collected_cents:0},{collected_cents:120001},{platform_payment_cents:119999},
    {first_role_payment_cents:1},{tax_cents:null},{tax_cents:1.5},{tax_cents:'0'},
    {payment_success_at:'infinity'},{payment_success_at:'2025-12-31T00:00:00Z'},
    {payment_success_at:'9999-01-01T00:00:00Z'},{payment_success_at:'2026-01-31T14:20:30.123Z'},
    {platform_line_id:null},{invoice_id:'not-a-native-id'}]) {
    const result=run(`set role service_role; ${call(c,b,{...r,...change})}`); assert.notEqual(result.status,0);
  }
  assert.equal(service(`select count(*) from membership_v2_initial_receipts where contract_id='${c.id}'`),'0');
});
test('first-role prepayment and native tax remain separate from platform revenue/access',options,()=>{
  const selected=buildRetailOffer({planKey:'pro',paymentOption:'prepaid',commitmentMonths:3,channel:'sales',
    offerVersion:OFFER_VERSION,firstRolePrepaySelected:true});
  const c=setup({changes:selected});
  service(`insert into membership_v2_provider_bindings(contract_id,contract_version,provider_account_id,livemode,
    customer_id,checkout_session_id,subscription_id,platform_price_id,platform_item_id,first_role_price_id)
    values('${c.id}',1,'acct_Synthetic',false,'cus_Shared','cs_${c.n}','sub_${c.n}','price_${c.n}','si_${c.n}','price_Role');`);
  const b={account:'acct_Synthetic',mode:false,checkout:`cs_${c.n}`,subscription:`sub_${c.n}`};
  service(call(c,b,receipt(c,b,{first_role_price_id:'price_Role',first_role_payment_cents:selected.first_role_prepay.amount_cents,
    tax_cents:1234,collected_cents:selected.initial_payment_cents+1234})));
  assert.equal(service(`select platform_cents,first_role_cents,tax_cents,collected_cents from membership_v2_initial_receipts where contract_id='${c.id}'`),'210000|62900|1234|274134');
  assert.equal(service(`select platform_cents from membership_v2_paid_periods where contract_id='${c.id}'`),'210000');
});
test('failure after receipt insertion rolls back the whole reservation, then a retry succeeds',options,()=>{
  const c=setup(),b=bind(c),r=receipt(c,b);
  sql(`create function public.synthetic_fail_state() returns trigger language plpgsql as $$ begin
    raise exception 'synthetic_late_transaction_failure'; end $$;
    create trigger synthetic_failure before insert on membership_v2_contract_state for each row execute function synthetic_fail_state();`);
  fails(`set role service_role; ${call(c,b,r)}`,/synthetic_late_transaction_failure/);
  for (const table of ['initial_receipts','contract_state','paid_periods']) {
    assert.equal(service(`select count(*) from membership_v2_${table} where contract_id='${c.id}'`),'0');
  }
  sql('drop trigger synthetic_failure on membership_v2_contract_state; drop function synthetic_fail_state();');
  assert.equal(JSON.parse(service(call(c,b,r))).action,'initial_payment_reserved');
});
test('state updates cannot change original anchor, advance unpaid term or enable unverified alignment',options,()=>{
  const c=setup(),b=bind(c);service(call(c,b,receipt(c,b)));
  for(const clause of ["original_paid_at=original_paid_at+interval '1 day'",'term_index=1',
    "term_end_at=term_end_at+interval '3 months'","provider_alignment='verified',renewal_ready=true",'auto_renew=false']) {
    fails(`set role service_role; update membership_v2_contract_state set ${clause} where contract_id='${c.id}'`,/membership_state_writer_not_ready/);
  }
});
test('simultaneous valid initial webhooks serialize to one write and one identity-only replay',options,async()=>{
  const c=setup(),b=bind(c),r=receipt(c,b);
  const results = await Promise.all([
    asyncSQL(`set role service_role; begin; select id from membership_v2_contracts where id='${c.id}' for update; select pg_sleep(0.2); ${call(c,b,r)} commit;`),
    asyncSQL(`set role service_role; ${call(c,b,r)}`)
  ]);
  for(const result of results) assert.equal(result.status,0,result.err);
  const actions=results.map(result=>JSON.parse(result.out.trim().split('\n').find(line=>line.startsWith('{'))).action).sort();
  assert.deepEqual(actions,['already_reserved','initial_payment_reserved']);
  for (const table of ['initial_receipts','contract_state','paid_periods']) {
    assert.equal(service(`select count(*) from membership_v2_${table} where contract_id='${c.id}'`),'1');
  }
});
test('concurrent competing contracts cannot both reserve the same provider invoice',options,async()=>{
  const first=setup(),fb=bind(first),second=setup(),sb=bind(second);
  const results=await Promise.all([
    asyncSQL(`set role service_role; ${call(first,fb,receipt(first,fb))}`),
    asyncSQL(`set role service_role; ${call(second,sb,receipt(second,sb,{invoice_id:`in_${first.n}`}))}`)
  ]);
  assert.equal(results.filter(r=>r.status===0).length,1);
  assert.match(results.find(r=>r.status!==0).err,/duplicate key/);
  assert.equal(service(`select count(*) from membership_v2_initial_receipts where contract_id in ('${first.id}','${second.id}')`),'1');
  assert.equal(service(`select count(*) from membership_v2_contract_state where contract_id in ('${first.id}','${second.id}')`),'1');
});

test('migration remains additive and contains no external delivery or legacy client update',()=>{
  const source=fs.readFileSync(migration,'utf8');
  assert.doesNotMatch(source,/security\s+definer|update\s+public\.clients|insert\s+into\s+public\.clients|cron\.schedule/i);
  assert.match(source,/security invoker/);
});
