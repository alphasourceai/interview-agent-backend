'use strict';
// Isolated native policy test. Source/financial attribution guards have their
// own integration suites; this fixture does not claim provider acceptance.
const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync,spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const enabled=process.env.SALES_RENEWAL_POLICY_DISPOSABLE==='true';
const pg='/opt/homebrew/opt/postgresql@17/bin/psql';
const actor='11111111-1111-4111-8111-111111111111';
function sql(s){return execFileSync(pg,['-X','-qAt','-v','ON_ERROR_STOP=1','-d','postgres'],{input:s,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}
function denied(s,match){assert.throws(()=>sql(s),e=>match.test(String(e.stderr)));}
function set(value,version){return sql(`set role service_role;select public.set_sales_renewal_commissions(${value},${version},'${actor}');`);}
function receipt(protocol,paid,end='2026-04-01T00:00:00Z'){return `set role service_role;insert into public.sales_commission_receipts(membership_terms_protocol,payment_success_at,first_term_end_at) values('${protocol}','${paid}','${end}');`;}
before(()=>{
  if(!enabled)return;
  assert.ok(process.env.PGHOST?.startsWith('/private/tmp/renewal-policy-'));
  sql(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create table auth.users(id uuid primary key);insert into auth.users values('${actor}');
    create table public.sales_commission_receipts(id bigint generated always as identity primary key,
    membership_terms_protocol text not null,payment_success_at timestamptz not null,first_term_end_at timestamptz not null,
    purchase_intent_id uuid,enterprise_agreement_id uuid,enterprise_commission_source jsonb,rep_user_id uuid,provider_payment_id text);
    create table public.membership_agreements(id uuid primary key,retail_funding_receipt jsonb);
    create table public.public_purchase_intents(id uuid primary key,agreement_id uuid,package_snapshot jsonb);
    create table public.billing_invoices(stripe_invoice_id text primary key,retail_period_receipt jsonb,enterprise_period_receipt jsonb);
    create table public.test_enterprise_proofs(invoice_id text primary key,proof jsonb);
    -- Proof-verification adapters are deliberate stubs in this isolated policy
    -- harness; real source guards are unchanged and tested in existing suites.
    create function public.retail_existing_assert_commission_receipt(jsonb,boolean) returns void language plpgsql as $$begin return;end$$;
    create function public.enterprise_existing_assert_commission_receipt(jsonb,boolean) returns void language plpgsql as $$begin return;end$$;
    create function public.read_enterprise_existing_commission_payment(uuid,uuid,text,uuid,boolean) returns jsonb language sql as $$select proof from public.test_enterprise_proofs where invoice_id=$3$$;
    grant select on public.membership_agreements,public.public_purchase_intents,public.billing_invoices,public.test_enterprise_proofs to service_role;
    grant usage on schema public to service_role;grant select,insert on public.sales_commission_receipts to service_role;
    grant usage on sequence public.sales_commission_receipts_id_seq to service_role;`);
  sql(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261019211919_sales_renewal_commission_policy.sql'),'utf8'));
});
test('native policy default OFF preserves initial-term monthly installments, blocks exact renewal boundary',{skip:!enabled},()=>{
  for(const protocol of ['retail_terms_v2']){
    for(const months of [3,6,12]){
      const end=`2026-${months===12?'12':String(months+1).padStart(2,'0')}-01T00:00:00Z`;
      sql(receipt(protocol,'2026-02-01T00:00:00Z',end));
      denied(receipt(protocol,end,end),/renewal_commissions_disabled/);
    }
  }
  assert.equal(sql('select count(*) from public.sales_commission_receipts;'),'3');
});
test('native ON/OFF records actor/history; old receipt dollars/history are never recomputed',{skip:!enabled},()=>{
  const on=JSON.parse(set(true,0));assert.equal(on.enabled,true);assert.equal(on.version,1);
  sql(receipt('retail_terms_v2','2026-04-01T00:00:00Z'));
  const before=sql('select md5(jsonb_agg(to_jsonb(r) order by id)::text) from public.sales_commission_receipts r;');
  const off=JSON.parse(set(false,1));assert.equal(off.enabled,false);assert.equal(off.version,2);
  denied(receipt('retail_terms_v2','2026-05-01T00:00:00Z'),/renewal_commissions_disabled/);
  assert.equal(sql('select md5(jsonb_agg(to_jsonb(r) order by id)::text) from public.sales_commission_receipts r;'),before);
  assert.equal(sql(`select count(*) from public.sales_renewal_commission_policy_events where changed_by_user_id='${actor}';`),'2');
  assert.equal(JSON.parse(set(false,2)).version,2); // no duplicate audit for no-op
  denied(`set role service_role;select public.set_sales_renewal_commissions(true,1,'${actor}');`,/renewal_commission_policy_changed/);
});
test('native table/function access is service-only; history immutable and missing actors rejected',{skip:!enabled},()=>{
  for(const role of ['anon','authenticated']){
    denied(`set role ${role};select * from public.sales_renewal_commission_policy_events;`,/permission denied/);
    denied(`set role ${role};select public.set_sales_renewal_commissions(true,2,'${actor}');`,/permission denied/);
  }
  denied('update public.sales_renewal_commission_policy_events set enabled=true;',/renewal_commission_policy_immutable/);
  denied('delete from public.sales_renewal_commission_policy_events;',/renewal_commission_policy_immutable/);
  denied(`set role service_role;select public.set_sales_renewal_commissions(true,2,null);`,/invalid_renewal_commission_confirmation/);
});
test('native shared admission lock serializes a policy change until receipt transaction ends',{skip:!enabled},async()=>{
  const child=spawn(pg,['-X','-qAt','-v','ON_ERROR_STOP=1','-d','postgres'],{stdio:['pipe','pipe','pipe']});
  const locked=new Promise((resolve,reject)=>{child.stdout.on('data',chunk=>{if(String(chunk).includes('LOCKED'))resolve();});child.on('error',reject);});
  const ended=new Promise(resolve=>child.on('close',resolve));
  child.stdin.end("begin;select pg_advisory_xact_lock_shared(17673944,3192026);select 'LOCKED';select pg_sleep(1.5);commit;");
  await locked;const start=Date.now();const on=JSON.parse(set(true,2));
  assert.ok(Date.now()-start>=1000,'exclusive policy change must wait for receipt admission');
  assert.equal(await ended,0);assert.equal(on.version,3);assert.equal(JSON.parse(set(false,3)).version,4);
});

test('current Retail uses receipt ordinal, not cash date or mutable coverage, for every term/payment option',{skip:!enabled},()=>{
  const intent='22222222-2222-4222-8222-222222222222',agreement='33333333-3333-4333-8333-333333333333';
  sql(`insert into public.membership_agreements values('${agreement}','{"proof":{"period":{"invoice_id":"in_INITIAL"}}}');
    insert into public.public_purchase_intents values('${intent}','${agreement}','{}');
    insert into public.billing_invoices(stripe_invoice_id,retail_period_receipt) values('in_PERIOD','{}');`);
  for(const version of ['retail-stripe-terms-2026-10-14-v2','retail-stripe-terms-2026-10-15-v3'])
    for(const months of [3,6,12])for(const option of ['prepaid','monthly_installments']){
      sql(`update public.public_purchase_intents set package_snapshot='${JSON.stringify({membership_terms:{offer_version:version,commitment_months:months,payment_option:option}})}' where id='${intent}';`);
      const row={membership_terms_protocol:'retail_existing_terms_v2',purchase_intent_id:intent,
        provider_payment_id:'in_PERIOD',payment_success_at:'2026-04-01T01:00:00Z',first_term_end_at:'2026-04-01T00:40:00Z'};
      const check=(r)=>sql(`set role service_role;select public.sales_commission_receipt_is_renewal('${JSON.stringify(r)}');`);
      assert.equal(check({...row,provider_payment_id:'in_INITIAL'}),'f');
      sql(`update public.billing_invoices set retail_period_receipt='{"proof":{"ordinal":${option==='prepaid'?0:months-1}}}' where stripe_invoice_id='in_PERIOD';`);
      assert.equal(check(row),'f','late initial-term installment is not a renewal');
      sql(`update public.billing_invoices set retail_period_receipt='{"proof":{"ordinal":${option==='prepaid'?1:months}}}' where stripe_invoice_id='in_PERIOD';`);
      assert.equal(check({...row,payment_success_at:'2026-04-01T00:00:01Z'}),'t','first renewal precedes the old cash cutoff but is still renewal');
      denied(`set role service_role;insert into public.sales_commission_receipts(membership_terms_protocol,purchase_intent_id,provider_payment_id,payment_success_at,first_term_end_at)
        values('retail_existing_terms_v2','${intent}','in_PERIOD','2026-04-01T00:00:01Z','2026-04-01T00:40:00Z');`,/renewal_commissions_disabled/);
    }
});
test('Enterprise uses frozen legal end and verified provider period, not delayed payment time',{skip:!enabled},()=>{
  const end=Date.parse('2026-07-01T00:00:00Z')/1000,agreement='44444444-4444-4444-8444-444444444444';
  sql(`insert into public.test_enterprise_proofs values('in_ENTERPRISE','{"ordinal":1,"qualification":{"original_term_end_at":"2026-07-01T00:00:00Z"}}');
    insert into public.billing_invoices(stripe_invoice_id,enterprise_period_receipt) values('in_ENTERPRISE','{"proof":{"provider_period_start":${end-86400}}}');`);
  const r={membership_terms_protocol:'enterprise_existing_terms_v1',enterprise_agreement_id:agreement,
    enterprise_commission_source:{client_id:actor},rep_user_id:actor,provider_payment_id:'in_ENTERPRISE',
    payment_success_at:'2026-08-01T00:00:00Z',first_term_end_at:'2026-07-01T00:00:00Z'};
  const check=()=>sql(`set role service_role;select public.sales_commission_receipt_is_renewal('${JSON.stringify(r)}');`);
  assert.equal(check(),'f','late initial-term invoice stays initial');
  sql(`update public.billing_invoices set enterprise_period_receipt='{"proof":{"provider_period_start":${end}}}' where stripe_invoice_id='in_ENTERPRISE';`);
  assert.equal(check(),'t','period beginning at legal end is renewal');
  sql(`update public.test_enterprise_proofs set proof='{"ordinal":0}' where invoice_id='in_ENTERPRISE';`);
  assert.equal(check(),'f','original checkout always initial');
});
