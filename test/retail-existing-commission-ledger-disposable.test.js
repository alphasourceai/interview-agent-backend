'use strict';
// Actual PG17 on a fresh task-owned Unix socket; no linked/hosted DB/provider.
const {test,before}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');
const {buildRetailPackageSnapshot}=require('../src/services/membershipPackageCompatibility');
const {buildRetailOffer,OFFER_VERSION,anchoredMonthInstant}=require('../src/services/membershipOffers');
const enabled=process.env.RETAIL_EXISTING_COMMISSION_DISPOSABLE==='true';const options={skip:!enabled};
const root=path.resolve(__dirname,'..'),pg='/opt/homebrew/opt/postgresql@17/bin/psql';
const A='2026-01-31T15:45:00.000Z',rep='77777777-7777-4777-8777-777777777777',other='88888888-8888-4888-8888-888888888888';
const owner='99999999-9999-4999-8999-999999999999';let sequence=1000;
const databases=['retail_commission_legacy_test','retail_commission_versioned_test','retail_commission_drift_test','retail_commission_mercury_test'];
const literal=v=>v==null?'null':typeof v==='boolean'||typeof v==='number'?String(v):`'${String(v).replaceAll("'","''")}'`;
const json=v=>`${literal(JSON.stringify(v))}::jsonb`;
const migration='20261013045835_retail_existing_commission_receipts.sql';
function sql(text,db){assert.ok([...databases,'postgres'].includes(db));return execFileSync(pg,['-X','-q','-At','-d',db,'-v','ON_ERROR_STOP=1'],{input:text,encoding:'utf8'}).trim();}
function file(name,db){return sql(fs.readFileSync(path.join(root,'supabase/migrations',name),'utf8'),db);}
function insert(table,row){return `insert into public.${table}(${Object.keys(row).join(',')}) values(${Object.values(row).map(literal).join(',')});`;}
function uid(){return `11111111-1111-4111-8111-${String(++sequence).padStart(12,'0')}`;}
function bootstrap(db,versioned=false){
  sql(`create database ${db} template template0;`,'postgres');
  sql(fs.readFileSync(path.join(__dirname,'fixtures/qa-activation-fence-disposable-bootstrap.sql'),'utf8'),db);
  sql(`alter role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key);
    insert into auth.users values('${owner}'),('${rep}'),('${other}');
    alter table public.membership_agreements add column membership_tier text,add column billing_option text,add column auto_renew boolean,
      add column signer_accepted boolean,add column template_version text,add column template_snapshot jsonb,
      add column signed_at timestamptz,add column agreement_expires_at timestamptz;
    alter table public.public_purchase_intents add column expires_at timestamptz,add column channel text,add column created_by_user_id uuid;
    create table public.sales_reps(user_id uuid primary key,active boolean,display_name text,email text);
    insert into public.sales_reps(user_id,active) values('${rep}',true),('${other}',true);
    create table public.sales_commission_adjustments(id uuid primary key);
    create schema private_auth;
    create table public.retail_signup_email_verifications(billing_cadence text constraint retail_signup_email_verifications_billing_cadence_check check(billing_cadence in('monthly','annual')));
    create table private_auth.retail_signup_sms_verifications(billing_cadence text constraint retail_signup_sms_verifications_billing_cadence_check check(billing_cadence in('monthly','annual')));
    alter table public.client_plan_settings add constraint client_plan_settings_billing_interval_check check(billing_interval in('monthly','annual'));
    alter table public.membership_agreements add constraint membership_agreements_billing_option_check check(billing_option in('monthly','annual'));
    grant usage on schema public,auth,extensions to service_role;grant select,update on all tables in schema public to service_role;`,db);
  for(const name of ['20261001131612_qa_public_purchase_activation_fences.sql','20261009120000_billing_models.sql',
    '20261011130000_client_plan_settings_interview_settings.sql','20261012230107_retail_existing_flow_pricing_terms.sql',
    '20261013032659_retail_existing_initial_plan_features.sql','20261013044440_retail_existing_sales_qualification.sql',
    '20261003113317_qa_sales_receipt_ledger.sql'])file(name,db);
  if(versioned)for(const name of ['20261011163625_membership_v2_contract_store.sql','20261011171728_membership_v2_sales_commission_window.sql'])file(name,db);
}
function setup(db,months=3,payment='monthly_installments',role=true,apply=true,paid=A){
  const s=buildRetailPackageSnapshot({planKey:'basic',commitmentMonths:months,paymentOption:payment,firstRolePrepaySelected:role,channel:'sales',offerVersion:OFFER_VERSION});
  const id=uid(),agreement=uid(),client=uid(),cs=`cs_Synthetic_${sequence}`,claim=`SYNTHETIC_RETAIL_PAYROLL_CLAIM_${sequence}`;
  const snapshot={source:'sales_assisted',template_version:'membership_agreement_retail_terms_v2',package_snapshot:s,purchase_intent:{id},values:{
    membership_tier:s.plan_key,billing_option:s.billing_cadence,commitment_months:months,payment_option:payment,pricing_version:s.pricing_version,
    term_start_basis:'successful_payment',auto_renew:true,platform_fee:String(s.platform_fee),per_role_fee:String(s.per_role_fee),
    additional_interview_fee:String(s.additional_interview_fee),included_interviews_per_role:String(s.included_interviews_per_role),
    max_interview_minutes:String(s.max_interview_minutes),first_role_prepay:s.first_role_prepay}};
  sql(`insert into public.membership_agreements(id,membership_tier,billing_option,auto_renew,signer_accepted,template_version,template_snapshot,signed_at,agreement_expires_at)
    values('${agreement}','basic',${literal(s.billing_cadence)},true,true,'membership_agreement_retail_terms_v2',${json(snapshot)},
      '${new Date(Date.parse(paid)-30*86400000).toISOString()}','${new Date(Date.parse(paid)+15*86400000).toISOString()}');
    insert into public.public_purchase_intents(id,agreement_id,status,protocol,selected_plan_key,selected_billing_cadence,package_snapshot,
      first_role_prepay_selected,first_role_prepay_credit_type,first_role_prepay_amount_cents,first_role_normal_role_fee_cents,
      first_role_prepay_discount_percent,term_start_basis,stripe_checkout_session_id,buyer_email,company_legal_name,expires_at,channel,created_by_user_id)
    values('${id}','${agreement}','checkout_pending','fenced_v2','basic',${literal(s.billing_cadence)},${json(s)},${role},
      ${literal(role?'first_role_prepay':null)},${literal(role?s.first_role_prepay.discounted_credit_amount_cents:null)},
      ${literal(role?s.first_role_prepay.normal_role_fee_cents:null)},${literal(role?10:null)},'successful_payment','${cs}',
      'native-payroll@example.invalid','Synthetic Retail Payroll','${new Date(Date.parse(paid)+15*86400000).toISOString()}','sales_assisted','${rep}');
    select public.claim_public_purchase_activation('${agreement}','${claim}');
    select public.complete_public_purchase_activation('${agreement}','${claim}','${paid}','${cs}','${client}',true,'basic',${literal(s.billing_cadence)},
      '${paid.slice(0,10)}','${anchoredMonthInstant(paid,months).slice(0,10)}');`,db);
  if(apply)sql(`select public.apply_public_purchase_billing('${id}','${claim}','${client}','${client}','cus_Synthetic','sub_Synthetic',
    'active','active',${literal(s.billing_cadence)},'basic','${anchoredMonthInstant(paid,months)}',false,true,null,'${paid}','${anchoredMonthInstant(paid,months)}',
    ${s.platform_fee},${s.per_role_fee},${s.included_interviews_per_role},${s.additional_interview_fee},${s.max_interview_minutes},${role},
    ${literal(role?'first_role_prepay':null)},${literal(role?s.first_role_prepay.normal_role_fee_cents:null)},
    ${literal(role?s.first_role_prepay.discounted_credit_amount_cents:null)},${literal(role?10:null)},${role?'true,false':'null,null'});`,db);
  return {id,agreement,client,s,months,paid};
}
function receipt(r,changes={}){const id=uid();return {id,purchase_intent_id:r.id,rep_user_id:rep,provider:'stripe',provider_payment_id:`pi_${id}`,
  payment_kind:r.s.membership_terms.payment_option==='prepaid'?'paid_in_full':'monthly',currency:'usd',
  payment_success_at:'2026-08-01T00:00:00Z',funds_received_at:'2026-08-02T00:00:00Z',qualification_closed_at:r.paid,first_term_start_at:r.paid,
  first_term_end_at:anchoredMonthInstant(r.paid,r.months),gross_membership_cents:r.s.membership_terms.platform_payment_cents,
  discount_cents:1500,provider_fee_cents:101,statement_week_start:'2026-08-03',evidence_reference:'synthetic manually reviewed platform funds',
  reviewed_by_user_id:owner,membership_terms_protocol:'retail_existing_terms_v2',sales_qualification_id:r.id,
  policy_version:'retail-existing-terms-v2-commission-v1',...changes};}
before(()=>{if(!enabled)return;
  assert.match(process.env.PGHOST||'',/^\/private\/tmp\/alphascreen-retail-commission-pg\.[A-Za-z0-9]+$/);
  assert.equal(process.env.PGPORT,'55450');assert.equal(process.env.PGUSER,'postgres');assert.equal(process.env.PGPASSWORD,undefined);
  for(const [db,versioned] of [[databases[0],false],[databases[1],true],[databases[2],false],[databases[3],false]]){
    bootstrap(db,versioned);
    if(db===databases[3]){
      file('20261003113321_qa_sales_mercury_import.sql',db);
      assert.equal(sql("select md5(prosrc) from pg_proc where oid='public.check_sales_commission_receipt_balance()'::regprocedure;",db),'9076bbf8ad26c2a27a09e8efef9c584f');
      assert.equal(sql("select md5(prosrc) from pg_proc where oid='public.sales_commission_effective_paid(uuid)'::regprocedure;",db),'246336636dd04aabc37bbf44e9a8b143');
      const candidate=fs.readFileSync(path.join(root,'supabase/migrations',migration),'utf8');
      const helperDefinition=sql("select pg_get_functiondef('public.sales_commission_effective_paid(uuid)'::regprocedure);",db)+';';
      const legacyGuard=fs.readFileSync(path.join(root,'supabase/migrations/20261003113317_qa_sales_receipt_ledger.sql'),'utf8')
        .match(/create or replace function public.check_sales_commission_receipt_balance\(\)[\s\S]*?\n\$\$;/)[0];
      const mutations=[
        "create or replace function public.check_sales_commission_receipt_balance() returns trigger language plpgsql as $$begin return new;end;$$;",
        "create or replace function public.sales_commission_effective_paid(p_receipt_id uuid) returns bigint language sql as $$select 0::bigint$$;",
        "drop function public.sales_commission_effective_paid(uuid) cascade;",
        "alter function public.sales_commission_effective_paid(uuid) security definer;",
        "alter function public.sales_commission_effective_paid(uuid) set search_path=public;",
        "alter function public.sales_commission_effective_paid(uuid) volatile;",
        "grant execute on function public.sales_commission_effective_paid(uuid) to anon;",
        "grant execute on function public.sales_commission_effective_paid(uuid) to authenticated;",
        "revoke execute on function public.sales_commission_effective_paid(uuid) from service_role;",
        "drop index public.sales_commission_payout_bank_receipt_uniq;",
        "alter table public.sales_commission_payouts alter column bank_transaction_id set not null;",
        "drop table public.sales_commission_bank_reversals cascade;",
        "drop table public.sales_commission_bank_api_bindings cascade;",
        "alter table public.sales_commission_bank_reversals disable trigger sales_commission_bank_reversals_immutable;",
        "alter table public.sales_commission_bank_transactions disable trigger sales_commission_bank_transactions_immutable;",
        "alter table public.sales_commission_bank_api_bindings disable trigger sales_commission_bank_api_bindings_immutable;",
        "alter table public.sales_commission_payouts drop constraint sales_commission_payouts_bank_transaction_id_fkey;",
        "alter table public.sales_commission_bank_reversals drop constraint sales_commission_bank_reversals_pkey;",
        "alter table public.sales_commission_bank_api_bindings drop constraint sales_commission_bank_api_bindings_mercury_transaction_id_key;",
        "set local check_function_bodies=false;"+helperDefinition.replace('LANGUAGE sql','LANGUAGE plpgsql'),
        "set local check_function_bodies=false;drop function public.sales_commission_effective_paid(uuid) cascade;"+
          helperDefinition.replace('p_receipt_id uuid','p_receipt_id text'),
        "set local check_function_bodies=false;drop function public.sales_commission_effective_paid(uuid) cascade;"+
          helperDefinition.replace('RETURNS bigint','RETURNS integer'),
        legacyGuard
      ];
      // Mutations must be valid catalog changes: each expected failure comes
      // from the recognition gate, not invalid fixture DDL. All roll back.
      for(const change of mutations){
        assert.throws(()=>sql(`begin;${change}\n${candidate}`,db),/retail_commission_existing_guard_drift/,change);
        assert.equal(sql("select count(*) from pg_attribute where attrelid='public.sales_commission_receipts'::regclass and attname='sales_qualification_id' and not attisdropped;",db),'0');
      }
    }
    if(db!==databases[2])file(migration,db);
  }
});
for(const db of [...databases.slice(0,2),databases[3]]){
  test(`${db}: all3/6/12 bothoptions actual receipt commissions exclude role and preserve original first year`,options,()=>{
    for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments']){
      const r=setup(db,months,payment),row=receipt(r);sql(`set role service_role;${insert('sales_commission_receipts',row)}`,db);
      assert.equal(sql(`select commission_cents from public.sales_commission_receipts where id='${row.id}';`,db),String(Math.round((row.gross_membership_cents-1601)/2)));
      assert.equal(sql(`select public.retail_existing_commission_source('${r.id}');`,db),'retail_existing_terms_v2');
    }
  });
  test(`${db}: partial native billing cannot admit a receipt`,options,()=>{
    const r=setup(db,3,'monthly_installments',true,false);
    // An existing active customer does not turn completion-only into billing
    // proof, and the admin review list must not present that incomplete source.
    sql(`update public.clients set billing_status='active',subscription_status='active' where id='${r.client}';`,db);
    assert.equal(sql(`select count(*) from public.sales_commission_review_candidates where id='${r.id}';`,db),'0');
    assert.throws(()=>sql(`set role service_role;${insert('sales_commission_receipts',receipt(r))}`,db),/retail_commission_activation_incomplete/);
    assert.equal(sql(`select count(*) from public.sales_commission_receipts where purchase_intent_id='${r.id}';`,db),'0');
  });
  test(`${db}: source cap kind original rep window policy and protocol cannot be forged`,options,()=>{
    const r=setup(db);
    for(const changes of [{gross_membership_cents:r.s.membership_terms.initial_payment_cents},{payment_kind:'paid_in_full'},
      {rep_user_id:other},{first_term_end_at:anchoredMonthInstant(A,12)},{qualification_closed_at:'2026-01-01T00:00:00Z'},
      {payment_success_at:anchoredMonthInstant(A,12),funds_received_at:'2027-02-01T00:00:00Z'},
      {payment_success_at:'2026-01-31T15:44:59Z'},{policy_version:'fake_policy'},
      {membership_terms_protocol:'legacy_receipt_v1',sales_qualification_id:null,first_term_end_at:'2027-01-31T15:45:00Z'},
      {sales_qualification_id:uid()},{membership_contract_id:uid(),membership_contract_version:1}]){
      assert.throws(()=>sql(`set role service_role;${insert('sales_commission_receipts',receipt(r,changes))}`,db),/retail_commission_receipt_source_conflict|membership_commission_protocol_required/);
    }
  });
  test(`${db}: reassignment retains original receipt attribution and linked refunds/payout checks`,options,()=>{
    const r=setup(db),row=receipt(r);sql(`set role service_role;${insert('sales_commission_receipts',row)}`,db);
    sql(`update public.public_purchase_intents set created_by_user_id='${other}',channel='self_service' where id='${r.id}';`,db);
    assert.equal(sql(`set role service_role;select created_by_user_id from public.sales_commission_review_candidates where id='${r.id}';`,db),rep);
    sql(`set role service_role;${insert('sales_commission_receipts',receipt(r))}`,db);
    // Original attribution also survives inactive client for correcting an ALREADY
    // reviewed receipt. New receipts remain subject to the active-client rule.
    sql(`update public.clients set billing_status='inactive' where id='${r.client}';`,db);
    sql(`set role service_role;${insert('sales_commission_adjustments',{receipt_id:row.id,adjustment_type:'refund',provider_event_id:`evt_${row.id}`,
      net_membership_delta_cents:-100,commission_delta_cents:0,effective_at:'2026-09-01T00:00:00Z',statement_week_start:'2026-09-07',
      evidence_reference:'synthetic original receipt refund',reviewed_by_user_id:owner})}`,db);
    assert.equal(sql(`select commission_delta_cents from public.sales_commission_adjustments where receipt_id='${row.id}';`,db),'-50');
    sql(`set role service_role;select public.lock_sales_commission_statement('${rep}','2026-08-03','${owner}');`,db);
    sql(`set role service_role;select public.lock_sales_commission_statement('${rep}','2026-09-07','${owner}');`,db);
    sql(`set role service_role;${insert('sales_commission_payouts',{receipt_id:row.id,amount_cents:100,ach_reference:`ach_allowed_${row.id}`,
      paid_at:'2026-09-15T00:00:00Z',evidence_reference:'synthetic reviewed paid receipt allocation',recorded_by_user_id:owner})}`,db);
    assert.throws(()=>sql(`set role service_role;${insert('sales_commission_payouts',{receipt_id:row.id,amount_cents:999999,ach_reference:`ach_${row.id}`,
      paid_at:'2026-09-15T00:00:00Z',evidence_reference:'synthetic overpay denied',recorded_by_user_id:owner})}`,db),/exceeds_unpaid|unrecovered_commission_debit/);
  });
  test(`${db}: original first-year cutoff rejects exact PAST anniversary, not merely future timestamps`,options,()=>{
    const r=setup(db,3,'monthly_installments',false,true,'2025-01-31T15:45:00.000Z');
    sql(`set role service_role;${insert('sales_commission_receipts',receipt(r,{payment_success_at:'2026-01-31T15:44:59Z',
      funds_received_at:'2026-02-02T00:00:00Z',statement_week_start:'2026-02-02'}))}`,db);
    assert.throws(()=>sql(`set role service_role;${insert('sales_commission_receipts',receipt(r,{payment_success_at:'2026-01-31T15:45:00Z',
      funds_received_at:'2026-02-02T00:00:00Z',statement_week_start:'2026-02-02'}))}`,db),/retail_commission_receipt_source_conflict/);
  });
}
test('Mercury reversal-aware guard preserves unpaid balance, locks and overpayment refusal after pricing migration',options,()=>{
  const db=databases[3],r=setup(db),row=receipt(r,{gross_membership_cents:20000,discount_cents:0,provider_fee_cents:0,
    payment_success_at:'2026-10-01T00:00:00Z',funds_received_at:'2026-10-02T00:00:00Z',statement_week_start:'2026-10-05'});
  sql(`set role service_role;${insert('sales_commission_receipts',row)}
    ${insert('sales_commission_adjustments',{receipt_id:row.id,adjustment_type:'refund',provider_event_id:`evt_${row.id}`,
      net_membership_delta_cents:-2000,commission_delta_cents:0,effective_at:'2026-10-03T00:00:00Z',statement_week_start:'2026-10-05',
      evidence_reference:'synthetic source-linked adjustment',reviewed_by_user_id:owner})}`,db);
  const payout=(amount,bank=null)=>insert('sales_commission_payouts',{receipt_id:row.id,amount_cents:amount,
    bank_transaction_id:bank,ach_reference:`synthetic_ach_${uid()}`,paid_at:'2026-10-13T12:00:00Z',
    evidence_reference:'synthetic verified payment allocation',recorded_by_user_id:owner});
  assert.throws(()=>sql(`set role service_role;${payout(3000)}`,db),/source_statement_not_locked/);
  sql(`set role service_role;select public.lock_sales_commission_statement('${rep}','2026-10-05','${owner}');`,db);
  assert.throws(()=>sql(`set role service_role;${insert('sales_commission_receipts',receipt(r,{statement_week_start:'2026-10-05'}))}`,db),/sales_commission_statement_week_locked/);
  assert.throws(()=>sql(`set role service_role;${insert('sales_commission_payouts',{receipt_id:row.id,amount_cents:1,
    ach_reference:'synthetic_before_tuesday',paid_at:'2026-10-13T05:00:00Z',
    evidence_reference:'synthetic early payment refusal',recorded_by_user_id:owner})}`,db),/ach_before_following_tuesday/);
  // Existing bank writes use the reviewed definer RPC, not table grants.
  assert.throws(()=>sql(`set role service_role;insert into public.sales_commission_bank_transactions(id) values('${uid()}');`,db),/permission denied/);
  const bank=sql(`set role service_role;select (public.import_sales_commission_bank_transaction(
    '${'a'.repeat(64)}','${String(sequence).padStart(15,'0')}','2026-10-13','2026-10-13T12:00:00Z',4000,'${rep}',
    'Synthetic Rep','Synthetic local Mercury bank evidence only','${owner}',${json([{receipt_id:row.id,amount_cents:4000}])})).id;`,db);
  sql(`set role service_role;${payout(3000)}`,db);
  assert.equal(sql(`select public.sales_commission_effective_paid('${row.id}');`,db),'7000');
  assert.throws(()=>sql(`set role service_role;${payout(6000)}`,db),/commission_payout_exceeds_unpaid_verified_source/);
  sql(`set role service_role;select public.reverse_sales_commission_bank_transaction('${bank}',
    '2026-10-13T13:00:00Z','synthetic bank reversal','${owner}');`,db);
  assert.equal(sql(`select public.sales_commission_effective_paid('${row.id}');`,db),'3000');
  sql(`set role service_role;${payout(6000)}`,db);
  assert.equal(sql(`select public.sales_commission_effective_paid('${row.id}');`,db),'9000');
  assert.throws(()=>sql(`set role service_role;${payout(1)}`,db),/commission_payout_exceeds_unpaid_verified_source/);
  assert.equal(sql("select md5(prosrc) from pg_proc where oid='public.check_sales_commission_receipt_balance()'::regprocedure;",db),'9076bbf8ad26c2a27a09e8efef9c584f');
  assert.equal(sql("select md5(prosrc) from pg_proc where oid='public.sales_commission_effective_paid(uuid)'::regprocedure;",db),'246336636dd04aabc37bbf44e9a8b143');
});
test('Mercury bank reversal clears cross-receipt debit and departed refund gate without changing adjustment caps',options,()=>{
  const db=databases[3],r=setup(db),r2=setup(db);
  const source=receipt(r,{gross_membership_cents:20000,discount_cents:0,provider_fee_cents:0,
    payment_success_at:'2026-09-17T00:00:00Z',funds_received_at:'2026-09-18T00:00:00Z',statement_week_start:'2026-09-21'});
  const target=receipt(r2,{...source,id:uid(),purchase_intent_id:r2.id,sales_qualification_id:r2.id,provider_payment_id:`pi_${uid()}`});
  sql(`set role service_role;${insert('sales_commission_receipts',source)}${insert('sales_commission_receipts',target)}
    select public.lock_sales_commission_statement('${rep}','2026-09-21','${owner}');`,db);
  const importBank=()=>sql(`set role service_role;select (public.import_sales_commission_bank_transaction(
    '${'b'.repeat(64)}','${String(++sequence).padStart(15,'0')}','2026-09-29','2026-09-29T12:00:00Z',9000,'${rep}',
    'Synthetic Rep','Synthetic local Mercury evidence only','${owner}',${json([{receipt_id:source.id,amount_cents:9000}])})).id;`,db);
  const reverse=bank=>sql(`set role service_role;select public.reverse_sales_commission_bank_transaction('${bank}',
    '2026-10-07T12:00:00Z','synthetic bank reversal','${owner}');`,db);
  const adjust=(amount,week='2026-09-28')=>insert('sales_commission_adjustments',{receipt_id:source.id,adjustment_type:'refund',
    provider_event_id:`evt_${uid()}`,net_membership_delta_cents:amount,commission_delta_cents:0,
    effective_at:'2026-10-01T00:00:00Z',statement_week_start:week,
    evidence_reference:'synthetic source-linked debit/refund',reviewed_by_user_id:owner});
  const payout=()=>insert('sales_commission_payouts',{receipt_id:target.id,amount_cents:1,ach_reference:`ach_${uid()}`,
    paid_at:'2026-10-06T12:00:00Z',evidence_reference:'synthetic debit gate payment',recorded_by_user_id:owner});
  const bank1=importBank();
  sql(`set role service_role;${adjust(-4000)}`,db);
  assert.throws(()=>sql(`set role service_role;${payout()}`,db),/representative_has_unrecovered_commission_debit/);
  reverse(bank1);
  sql(`set role service_role;${payout()}`,db);
  assert.throws(()=>sql(`set role service_role;${adjust(-20000)}`,db),/commission_adjustments_outside_source_balance/);
  sql(`set role service_role;select public.lock_sales_commission_statement('${rep}','2026-09-28','${owner}');`,db);
  // A new bank payout up to the adjusted cap is valid, but a departed
  // refund cannot reverse amounts already effectively paid.
  const bank2=sql(`set role service_role;select (public.import_sales_commission_bank_transaction(
    '${'c'.repeat(64)}','${String(++sequence).padStart(15,'0')}','2026-10-06','2026-10-06T12:00:00Z',8000,'${rep}',
    'Synthetic Rep','Synthetic local Mercury evidence only','${owner}',${json([{receipt_id:source.id,amount_cents:8000}])})).id;`,db);
  sql(`insert into public.sales_commission_departures(rep_user_id,final_day,reviewed_by_user_id,evidence_reference)
    values('${rep}','2026-09-29','${owner}','synthetic departure cutoff');`,db);
  assert.throws(()=>sql(`set role service_role;${adjust(-2000,'2026-10-12')}`,db),/post_departure_reversal_exceeds_unpaid_source/);
  reverse(bank2);
  sql(`set role service_role;${adjust(-2000,'2026-10-12')}`,db);
});
test('native older real-contract cohort still qualifies and persists without using new qualification IDs',options,()=>{
  const db=databases[1],id=uid(),intent=uid(),client=uid(),offer=buildRetailOffer({planKey:'basic',commitmentMonths:3,
    paymentOption:'prepaid',channel:'sales',offerVersion:OFFER_VERSION,firstRolePrepaySelected:false});
  sql(`insert into public.clients(id,name,email,billing_status,subscription_status) values('${client}','Old Synthetic Client','old@example.invalid','active','active');
    insert into public.membership_agreements(id,client_id,status,checkout_status,signed_at,checkout_paid_at) values('${id}','${client}','signed','paid','2026-01-01Z','${A}');
    insert into public.public_purchase_intents(id,client_id,agreement_id,created_by_user_id,status,channel,activated_at)
    values('${intent}','${client}','${id}','${other}','completed','sales_assisted','${A}');
    set role service_role;
    insert into public.membership_v2_contracts(id,contract_version,client_id,billing_owner_user_id,agreement_id,offer_snapshot,
      acceptance_digest,accepted_at,original_salesperson_user_id) values('${id}',1,'${client}','${owner}','${id}',${json(offer)},repeat('a',64),'2026-01-01Z','${other}');
    insert into public.membership_v2_provider_bindings(contract_id,contract_version,provider_account_id,livemode,customer_id,checkout_session_id,
      subscription_id,platform_price_id,platform_item_id,first_role_price_id)
    values('${id}',1,'acct_Synthetic',false,'cus_Synthetic','cs_${sequence}','sub_${sequence}','price_${sequence}','si_${sequence}',null);`,db);
  const proof={contract_id:id,contract_version:1,offer_version:offer.offer_version,currency:'usd',livemode:false,
    customer_id:'cus_Synthetic',checkout_session_id:`cs_${sequence}`,subscription_id:`sub_${sequence}`,platform_price_id:`price_${sequence}`,
    platform_item_id:`si_${sequence}`,first_role_price_id:null,invoice_id:`in_${sequence}`,payment_intent_id:`pi_${sequence}`,charge_id:`ch_${sequence}`,
    platform_line_id:`il_${sequence}`,payment_success_at:A,collected_cents:offer.initial_payment_cents,platform_payment_cents:offer.platform_payment_cents,
    first_role_payment_cents:0,tax_cents:0};
  sql(`set role service_role;select public.membership_v2_reserve_initial_payment('${id}',1,'${client}','${owner}','acct_Synthetic',${json(proof)});
    ${insert('membership_v2_sales_qualifications',{contract_id:id,contract_version:1,purchase_intent_id:intent,rep_user_id:other,
      original_start_at:A,original_term_end_at:anchoredMonthInstant(A,3),commission_window_end_at:anchoredMonthInstant(A,12),
      qualification_closed_at:A,reviewed_by_user_id:owner,evidence_reference:'synthetic historical protocol qualification'})}`,db);
  const row=receipt({id:intent,s:{membership_terms:offer},months:3,paid:A},{rep_user_id:other,membership_terms_protocol:'retail_terms_v2',
    sales_qualification_id:null,membership_contract_id:id,membership_contract_version:1,policy_version:'retail-terms-v2-commission-v1'});
  sql(`set role service_role;${insert('sales_commission_receipts',row)}`,db);
  assert.equal(sql(`select public.retail_existing_commission_source('${intent}');`,db),'retail_terms_v2');
  assert.equal(sql(`select sales_qualification_id is null and membership_contract_id='${id}' from public.sales_commission_receipts where id='${row.id}';`,db),'t');
});
test('native legacy first-term receipt default and commissions remain unchanged on both schema arms',options,()=>{
  for(const db of databases.slice(0,2)){
    const id=uid();sql(`insert into public.public_purchase_intents(id,created_by_user_id,status,channel)
      values('${id}','${other}','completed','sales_assisted');`,db);
    const row={id:uid(),purchase_intent_id:id,rep_user_id:other,provider:'stripe',provider_payment_id:`pi_legacy_${sequence}`,
      payment_kind:'monthly',currency:'usd',payment_success_at:'2025-03-01T00:00:00Z',funds_received_at:'2025-03-02T00:00:00Z',
      qualification_closed_at:'2025-01-02T00:00:00Z',first_term_start_at:'2025-01-01T00:00:00Z',first_term_end_at:'2026-01-01T00:00:00Z',
      gross_membership_cents:29900,statement_week_start:'2025-03-03',evidence_reference:'synthetic legacy manual receipt',reviewed_by_user_id:owner};
    sql(`set role service_role;${insert('sales_commission_receipts',row)}`,db);
    assert.equal(sql(`select membership_terms_protocol,net_membership_cents,commission_cents,sales_qualification_id is null from public.sales_commission_receipts where id='${row.id}';`,db),'legacy_receipt_v1|29900|14950|t');
    assert.equal(sql(`select public.retail_existing_commission_source('${id}');`,db),'legacy_receipt_v1');
  }
});
test('unexpected native attribution/schema/ACL drift aborts adapter DDL and keeps source unchanged',options,()=>{
  const db=databases[2],sig='public.require_sales_commission_sales_assisted()';
  const source=sql(`select pg_get_functiondef('${sig}'::regprocedure);`,db);
  sql(`grant execute on function ${sig} to anon;`,db);assert.throws(()=>file(migration,db),/retail_commission_attribution_source_drift/);
  assert.equal(sql("select count(*) from pg_attribute where attrelid='public.sales_commission_receipts'::regclass and attname='sales_qualification_id' and not attisdropped;",db),'0');
  sql(`revoke all on function ${sig} from anon;`,db);
  sql('alter table public.sales_commission_receipts add constraint synthetic_unknown_rule check(gross_membership_cents>1);',db);
  assert.throws(()=>file(migration,db),/retail_commission_baseline_constraint_drift/);
  sql('alter table public.sales_commission_receipts drop constraint synthetic_unknown_rule;',db);
  sql('alter table public.sales_commission_receipts disable trigger sales_commission_receipt_week_guard;',db);
  assert.throws(()=>file(migration,db),/retail_commission_existing_trigger_drift/);
  sql('alter table public.sales_commission_receipts enable trigger sales_commission_receipt_week_guard;',db);
  sql(source.replace("i.channel = 'sales_assisted'","i.channel <> 'sales_assisted'"),db);
  assert.throws(()=>file(migration,db),/retail_commission_attribution_source_drift/);sql(source,db);
  file(migration,db);assert.throws(()=>file(migration,db),/retail_commission_schema_prerequisite/);
});
