'use strict';

// Actual PostgreSQL on a task-owned Unix socket. Never a hosted database.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { before, after, test } = require('node:test');
const { buildRetailOffer, OFFER_VERSION, anchoredMonthInstant } = require('../src/services/membershipOffers');
const { calculateReceiptCommission } = require('../src/services/salesCommissionPolicy');
const enabled = process.env.MEMBERSHIP_V2_DISPOSABLE === 'true';
const socket = process.env.PGHOST || '';
const port = process.env.PGPORT || '55440';
const dbName = `alphascreen_commission_v2_${process.pid}`;
const pg = '/opt/homebrew/opt/postgresql@17/bin/';
const options = { skip: !enabled };
const owner = '10000000-0000-4000-8000-000000000001';
const rep = '10000000-0000-4000-8000-000000000002';
const otherRep = '10000000-0000-4000-8000-000000000003';
const client = '10000000-0000-4000-8000-000000000004';
const original = '2025-01-31T14:20:30.000Z';
const closed = '2025-01-31T14:20:40.000Z';
let counter = 10;
function args(database=dbName) { return ['-h',socket,'-p',port,'-U','postgres','-X','-q','-At','-v','ON_ERROR_STOP=1','-d',database]; }
function run(sql) { return spawnSync(`${pg}psql`,[...args(),'-c',sql],{encoding:'utf8'}); }
function sql(statement) { const r=run(statement); assert.equal(r.status,0,r.stderr); return r.stdout.trim(); }
function service(statement) { return sql(`set role service_role; ${statement}`); }
function fails(statement,error) { const r=run(statement); assert.notEqual(r.status,0,r.stdout); assert.match(r.stderr,error); }
function literal(value) { return `'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`; }
function uid() { return `20000000-0000-4000-8000-${String(++counter).padStart(12,'0')}`; }
function setup({months=3,payment='prepaid',firstRole=false,qualify=true,sourceChanges='',snapshotChanges={},repUserId=rep}={}) {
  const id=uid(), intent=uid(), n=counter;
  const offer={...buildRetailOffer({planKey:'basic',commitmentMonths:months,paymentOption:payment,
    channel:'sales',offerVersion:OFFER_VERSION,firstRolePrepaySelected:firstRole}),...snapshotChanges};
  sql(`insert into membership_agreements(id,client_id,status,checkout_status,signed_at,checkout_paid_at)
    values('${id}','${client}','signed','paid','2025-01-15T00:00:00Z','${original}');
    insert into public_purchase_intents(id,client_id,agreement_id,created_by_user_id,status,channel,activated_at)
    values('${intent}','${client}','${id}','${repUserId}','completed','sales_assisted','${closed}'); ${sourceChanges.replaceAll('$id',id).replaceAll('$intent',intent)}`);
  service(`insert into membership_v2_contracts(id,contract_version,client_id,billing_owner_user_id,agreement_id,
      offer_snapshot,acceptance_digest,accepted_at,original_salesperson_user_id)
    values('${id}',1,'${client}','${owner}','${id}',${literal(offer)},repeat('a',64),'2025-01-01T00:00:00Z','${repUserId}');
    insert into membership_v2_provider_bindings(contract_id,contract_version,provider_account_id,livemode,
      customer_id,checkout_session_id,subscription_id,platform_price_id,platform_item_id,first_role_price_id)
    values('${id}',1,'acct_Synthetic',false,'cus_Shared','cs_${n}','sub_${n}','price_${n}','si_${n}',${firstRole?`'price_role_${n}'`:'null'});`);
  const proof={contract_id:id,contract_version:1,offer_version:offer.offer_version,currency:'usd',livemode:false,
    customer_id:'cus_Shared',checkout_session_id:`cs_${n}`,subscription_id:`sub_${n}`,platform_price_id:`price_${n}`,
    platform_item_id:`si_${n}`,first_role_price_id:firstRole?`price_role_${n}`:null,
    invoice_id:`in_${n}`,payment_intent_id:`pi_${n}`,charge_id:`ch_${n}`,platform_line_id:`il_${n}`,
    payment_success_at:original,collected_cents:offer.initial_payment_cents,
    platform_payment_cents:offer.platform_payment_cents,first_role_payment_cents:offer.first_role_prepay.amount_cents,tax_cents:0};
  service(`select membership_v2_reserve_initial_payment('${id}',1,'${client}','${owner}','acct_Synthetic',${literal(proof)});`);
  const c={id,intent,n,months,payment,offer,repUserId};
  if (qualify) service(qualification(c));
  return c;
}
function qualification(c,changes={}) {
  const values={contract_id:c.id,contract_version:1,purchase_intent_id:c.intent,rep_user_id:c.repUserId,
    original_start_at:original,original_term_end_at:anchoredMonthInstant(original,c.months),
    commission_window_end_at:anchoredMonthInstant(original,12),qualification_closed_at:closed,
    reviewed_by_user_id:owner,evidence_reference:'synthetic original sale reviewed',...changes};
  return insert('membership_v2_sales_qualifications',values);
}
function insert(table,row) {
  const val=v=>v==null?'null':typeof v==='number'?String(v):typeof v==='boolean'?String(v):`'${String(v).replaceAll("'","''")}'`;
  return `insert into public.${table}(${Object.keys(row).join(',')}) values(${Object.values(row).map(val).join(',')});`;
}
function receipt(c,changes={}) {
  return {id:uid(),purchase_intent_id:c.intent,rep_user_id:c.repUserId||rep,provider:'stripe',provider_payment_id:`pi_receipt_${counter}`,
    payment_kind:c.payment==='prepaid'?'paid_in_full':'monthly',currency:'usd',
    payment_success_at:'2025-08-01T00:00:00Z',funds_received_at:'2025-08-02T00:00:00Z',
    qualification_closed_at:closed,first_term_start_at:original,
    first_term_end_at:anchoredMonthInstant(original,c.months),rep_final_day:null,
    gross_membership_cents:c.offer.platform_payment_cents,discount_cents:0,provider_fee_cents:101,
    statement_week_start:'2025-08-04',evidence_reference:'synthetic provider receipt reviewed',reviewed_by_user_id:owner,
    membership_terms_protocol:'retail_terms_v2',membership_contract_id:c.id,membership_contract_version:1,
    policy_version:'retail-terms-v2-commission-v1',...changes};
}
before(()=>{
  if (!enabled) return;
  assert.match(socket,/^\/private\/tmp\/alphascreen-membership-v2-pg\.[A-Za-z0-9]+$/);
  const created=spawnSync(`${pg}createdb`,['-h',socket,'-p',port,'-U','postgres',dbName],{encoding:'utf8'});
  assert.equal(created.status,0,created.stderr);
  sql(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create table public.clients(id uuid primary key,billing_status text,subscription_status text);
    create table public.membership_agreements(id uuid primary key,client_id uuid,status text,checkout_status text,
      signed_at timestamptz,checkout_paid_at timestamptz);
    create table public.public_purchase_intents(id uuid primary key,client_id uuid,agreement_id uuid,
      company_legal_name text,buyer_email text,selected_plan_key text,selected_billing_cadence text,
      created_by_user_id uuid,activated_at timestamptz,status text,channel text);
    create table public.sales_reps(user_id uuid primary key,active boolean);
    create table public.sales_commission_adjustments(id uuid primary key);
    insert into auth.users values('${owner}'),('${rep}'),('${otherRep}');
    insert into clients values('${client}','active','active');
    insert into sales_reps values('${rep}',true),('${otherRep}',true);
    grant usage on schema public,auth to service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
    grant select on all tables in schema public to service_role;
    -- Existing ledger balance guard takes a row lock on the rep; model its
    -- existing service-role UPDATE privilege, not extra browser privileges.
    grant update on public.sales_reps to service_role;`);
  for (const name of ['20261003113317_qa_sales_receipt_ledger.sql','20261011163625_membership_v2_contract_store.sql']) {
    const r=spawnSync(`${pg}psql`,[...args(),'-f',path.join(__dirname,'../supabase/migrations',name)],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
  }
  // Seed a real legacy row BEFORE the additive migration, then verify unchanged.
  sql(`insert into public_purchase_intents(id,created_by_user_id,status,channel)
      values('30000000-0000-4000-8000-000000000001','${rep}','completed','sales_assisted');`);
  service(insert('sales_commission_receipts',{id:'30000000-0000-4000-8000-000000000002',
    purchase_intent_id:'30000000-0000-4000-8000-000000000001',rep_user_id:rep,provider:'stripe',provider_payment_id:'pi_legacy',payment_kind:'monthly',
    payment_success_at:'2025-03-01T00:00:00Z',funds_received_at:'2025-03-02T00:00:00Z',qualification_closed_at:'2025-01-02T00:00:00Z',
    first_term_start_at:'2025-01-01T00:00:00Z',first_term_end_at:'2026-01-01T00:00:00Z',gross_membership_cents:29900,
    statement_week_start:'2025-03-03',evidence_reference:'synthetic legacy receipt',reviewed_by_user_id:owner}));
  const r=spawnSync(`${pg}psql`,[...args(),'-f',path.join(__dirname,'../supabase/migrations/20261011171728_membership_v2_sales_commission_window.sql')],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  const regression=spawnSync(`${pg}psql`,[...args(),'-f',path.join(__dirname,'sales-commission-postgres-regression.sql')],{encoding:'utf8'});
  assert.equal(regression.status,0,regression.stderr);
});
after(()=>{
  if (!enabled) return;
  const r=spawnSync(`${pg}dropdb`,['-h',socket,'-p',port,'-U','postgres',dbName],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
});

test('legacy receipt defaults, values and first-term exclusion survive migration unchanged',options,()=>{
  assert.equal(service(`select membership_terms_protocol,net_membership_cents,commission_cents,policy_version,
    membership_contract_id is null from sales_commission_receipts where provider_payment_id='pi_legacy';`),
  'legacy_receipt_v1|29900|14950|2026-10-02-receipt-v1|t');
  const c={intent:'30000000-0000-4000-8000-000000000001',id:uid(),months:12,payment:'monthly_installments',offer:{platform_payment_cents:29900}};
  const r=receipt(c,{membership_terms_protocol:'legacy_receipt_v1',membership_contract_id:null,membership_contract_version:null,
    first_term_start_at:'2025-01-01T00:00:00Z',first_term_end_at:'2026-01-01T00:00:00Z',qualification_closed_at:'2025-01-02T00:00:00Z',
    payment_success_at:'2026-01-01T00:00:00Z',funds_received_at:'2026-01-02T00:00:00Z'});
  fails(`set role service_role; ${insert('sales_commission_receipts',r)}`,/versioned_payment_window/);
});
test('qualification is service-only, immutable, RLS protected, security-invoker, no browser or truncate privileges',options,()=>{
  const c=setup();
  assert.equal(sql("select relrowsecurity from pg_class where oid='membership_v2_sales_qualifications'::regclass"),'t');
  for (const role of ['anon','authenticated']) {
    assert.equal(sql(`select has_table_privilege('${role}','membership_v2_sales_qualifications','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')`),'f');
    assert.equal(sql(`select bool_and(not has_function_privilege('${role}',oid,'EXECUTE')) from pg_proc
      where proname in ('membership_v2_check_sales_qualification','membership_v2_check_commission_receipt','require_sales_commission_sales_assisted')`),'t');
  }
  assert.equal(sql("select has_table_privilege('service_role','membership_v2_sales_qualifications','UPDATE,DELETE,TRUNCATE')"),'f');
  fails(`update membership_v2_sales_qualifications set rep_user_id=rep_user_id where contract_id='${c.id}'`,/immutable_membership_record/);
  fails(`delete from membership_v2_sales_qualifications where contract_id='${c.id}'`,/immutable_membership_record/);
  assert.equal(sql("select bool_and(not prosecdef) from pg_proc where proname in ('membership_v2_check_sales_qualification','membership_v2_check_commission_receipt','require_sales_commission_sales_assisted')"),'t');
});
test('qualification freezes original accepted commitment and calendar-year window, not catalog or later state',options,()=>{
  const c=setup({months:6});
  assert.equal(service(`select original_start_at='${original}' and original_term_end_at='2025-07-31T14:20:30Z'
    and commission_window_end_at='2026-01-31T14:20:30Z' from membership_v2_sales_qualifications where contract_id='${c.id}'`),'t');
  for (const change of [{original_start_at:'2025-02-01T00:00:00Z'},
    {original_term_end_at:'2026-01-31T14:20:30Z'},{commission_window_end_at:'2027-01-31T14:20:30Z'},
    {qualification_closed_at:'2025-03-01T00:00:00Z'},{rep_user_id:otherRep},{contract_version:2}]) {
    const unqualified=setup({qualify:false});
    fails(`set role service_role; ${qualification(unqualified,change)}`,/qualification_(source|window)_conflict/);
  }
});
test('unsigned, unpaid, wrong-owner, wrong-channel and unactivated sales cannot qualify',options,()=>{
  for (const change of ["update membership_agreements set status='draft' where id='$id';",
    "update membership_agreements set checkout_status='pending' where id='$id';",
    "update membership_agreements set signed_at='2025-02-01T00:00:00Z' where id='$id';",
    "update membership_agreements set checkout_paid_at='2025-02-01T00:00:00Z' where id='$id';",
    `update public_purchase_intents set created_by_user_id='${otherRep}' where id='$intent';`,
    "update public_purchase_intents set channel='self_service' where id='$intent';",
    "update public_purchase_intents set activated_at=null where id='$intent';"]) {
    const c=setup({qualify:false,sourceChanges:change});
    fails(`set role service_role; ${qualification(c)}`,/qualification_source_conflict/);
  }
});
test('3/6-month prepaid and monthly renewals inside original year persist actual receipt commission',options,()=>{
  for (const months of [3,6]) for (const payment of ['prepaid','monthly_installments']) {
    const c=setup({months,payment});const r=receipt(c);
    service(insert('sales_commission_receipts',r));
    const expected=calculateReceiptCommission({...r,membership_terms_protocol:'retail_terms_v2',payment_succeeded:true,
      original_membership_start_at:original,original_commitment_months:months,original_salesperson_user_id:rep,sales_rep_user_id:rep,
      original_qualification_closed_at:closed,original_qualification_verified:true});
    assert.equal(expected.status,'payable');
    assert.equal(service(`select commission_cents from sales_commission_receipts where id='${r.id}'`),String(expected.commission_cents));
  }
});
test('original first-year boundary excludes exact anniversary and 12-month renewal, including leap clamp',options,()=>{
  for (const months of [3,6,12]) {
    const c=setup({months});
    service(insert('sales_commission_receipts',receipt(c,{payment_success_at:'2026-01-31T14:20:29Z',funds_received_at:'2026-02-01T00:00:00Z'})));
    fails(`set role service_role; ${insert('sales_commission_receipts',receipt(c,{payment_success_at:'2026-01-31T14:20:30Z',funds_received_at:'2026-02-01T00:00:00Z'}))}`,/snapshot_conflict|versioned_payment_window/);
  }
  assert.equal(sql("select membership_v2_month_anchor('2024-02-29T12:00:00Z',12)='2025-02-28T12:00:00Z'"),'t');
});
test('receipt cannot rewrite term, qualification, rep, version, payment type or include first-role credit',options,()=>{
  const c=setup({months:3,firstRole:true});
  for (const change of [{first_term_start_at:'2025-02-01T00:00:00Z'},
    {first_term_end_at:'2026-01-31T14:20:30Z'},{qualification_closed_at:'2025-08-01T00:00:00Z'},
    {rep_user_id:otherRep},{membership_contract_version:2},{payment_kind:'monthly'},
    {gross_membership_cents:c.offer.initial_payment_cents},{payment_success_at:'2025-01-31T14:20:29Z'},
    {payment_success_at:'infinity',funds_received_at:'infinity'}]) {
    fails(`set role service_role; ${insert('sales_commission_receipts',receipt(c,change))}`,/snapshot_conflict|versioned_payment_window/);
  }
});
test('a v2 sale cannot fall back to legacy dates, even before qualification is registered',options,()=>{
  for (const qualify of [true,false]) {
    const c=setup({qualify});
    fails(`set role service_role; ${insert('sales_commission_receipts',receipt(c,{membership_terms_protocol:'legacy_receipt_v1',
      membership_contract_id:null,membership_contract_version:null,first_term_end_at:'2027-01-31T14:20:30Z'}))}`,/protocol_required/);
  }
});
test('v2 frozen attribution survives later reassignment; linked effective-date adjustments remain valid',options,()=>{
  const c=setup(),r=receipt(c);service(insert('sales_commission_receipts',r));
  sql(`update public_purchase_intents set created_by_user_id='${otherRep}',channel='self_service' where id='${c.intent}'`);
  const later=receipt(c,{payment_success_at:'2025-09-01T00:00:00Z',funds_received_at:'2025-09-02T00:00:00Z',statement_week_start:'2025-09-08'});
  service(insert('sales_commission_receipts',later));
  service(insert('sales_commission_adjustments',{receipt_id:r.id,adjustment_type:'refund',provider_event_id:'evt_effective_date_v2',
    net_membership_delta_cents:-100,commission_delta_cents:0,effective_at:'2026-04-01T00:00:00Z',statement_week_start:'2026-04-06',
    evidence_reference:'synthetic later refund',reviewed_by_user_id:owner}));
  assert.equal(service(`select commission_delta_cents,statement_week_start from sales_commission_adjustments where receipt_id='${r.id}'`),'-50|2026-04-06');
  assert.equal(service(`select count(*) from sales_commission_receipts where purchase_intent_id='${c.intent}' and rep_user_id='${rep}'`),'2');
});
test('existing append-only, duplicate payment, locked-week, departure and payout guards stay in force',options,()=>{
  const c=setup(),r=receipt(c);service(insert('sales_commission_receipts',r));
  fails(`update sales_commission_receipts set gross_membership_cents=1 where id='${r.id}'`,/append_only/);
  fails(`set role service_role; ${insert('sales_commission_receipts',{...r,id:uid()})}`,/duplicate key/);
  service(`select lock_sales_commission_statement('${rep}','2025-08-04','${owner}')`);
  fails(`set role service_role; ${insert('sales_commission_receipts',receipt(c))}`,/week_locked/);
  fails(`set role service_role; ${insert('sales_commission_payouts',{receipt_id:r.id,amount_cents:999999,ach_reference:'ach_overpay_v2',
    paid_at:'2025-08-20T00:00:00Z',evidence_reference:'synthetic overpay',recorded_by_user_id:owner})}`,/exceeds_unpaid/);
  // Separate rep so other tests' legitimate late receipts do not prevent the
  // append-only final-day entry. Payment is inside the year, after departure.
  const departed=setup({repUserId:otherRep});
  sql(`insert into sales_commission_departures(rep_user_id,final_day,reviewed_by_user_id,evidence_reference)
    values('${otherRep}','2025-03-31','${owner}','synthetic departure reviewed')`);
  fails(`set role service_role; ${insert('sales_commission_receipts',receipt(departed,{rep_final_day:'2025-03-31'}))}`,/exceeds_departure_cutoff/);
});
