'use strict';
// Empty curated schema clone, never a hosted project or copied customer/Auth.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {buildRetailPackageSnapshot}=require('../src/services/membershipPackageCompatibility');
const {GENERATION_DATE_OFFER_VERSION,STRIPE_RECURRING_OFFER_VERSION,OFFER_VERSION,retailGenerationTermDates}=require('../src/services/membershipOffers');
const enabled=process.env.RETAIL_GENERATION_CHECKOUT_DISPOSABLE==='true',opts={skip:!enabled};
const socket=process.env.PGHOST||'',port='55458',bin='/opt/homebrew/opt/postgresql@17/bin/';
const database=`retail_generation_checkout_${process.pid}`;
const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261015165725_retail_generation_checkout_compat.sql'),'utf8');
const lit=v=>v==null?'null':typeof v==='object'?`'${JSON.stringify(v).replaceAll("'","''")}'::jsonb`
 :typeof v==='boolean'||typeof v==='number'?String(v):`'${String(v).replaceAll("'","''")}'`;
const run=q=>cp.spawnSync(bin+'psql',['-h',socket,'-p',port,'-U','postgres','-d',database,'-X','-q','-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'});
function sql(q){const r=run(q);assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function denied(q,re=/retail_|check constraint/){const r=run(q);assert.notEqual(r.status,0,'must refuse');assert.match(r.stderr,re);}
const json=q=>JSON.parse(sql(q));
const config={public_backend_base:'https://api.example.invalid',public_sign_base:'https://site.example.invalid'};
const acl=()=>sql(`select jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,p.proacl::text,p.prosecdef,p.proconfig) order by p.oid::regprocedure::text)
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like '%retail%'
 and p.proname not in ('retail_generation_calendar','retail_generation_prices_valid');`);
let beforeAcl,legacy,beforeRow;const oldCases=[];
function fixture({plan='basic',months=3,payment='prepaid',role=false,source='admin',generation=true,
 generatedAt=new Date(Date.now()-3600000).toISOString(),version=STRIPE_RECURRING_OFFER_VERSION}={}){
 const id=crypto.randomUUID(),client=crypto.randomUUID(),intent=crypto.randomUUID(),customer='cus_'+client.replaceAll('-','');
 const pkg=buildRetailPackageSnapshot({planKey:plan,commitmentMonths:months,paymentOption:payment,
  firstRolePrepaySelected:role,channel:'sales',offerVersion:generation?GENERATION_DATE_OFFER_VERSION:version});
 const dates=generation?retailGenerationTermDates({generatedAt,commitmentMonths:months}):{initial_term_start:null,initial_renewal_date:null};
 const basis=generation?'generation_date':'successful_payment';
 const snapshot={source,template_version:'membership_agreement_retail_terms_v2',package_snapshot:pkg,
  ...(generation?{generated_at:generatedAt}:{}),values:{membership_tier:plan,billing_option:pkg.billing_cadence,
   commitment_months:months,payment_option:payment,pricing_version:pkg.pricing_version,term_start_basis:basis,
   auto_renew:true,platform_fee:pkg.platform_fee,per_role_fee:pkg.per_role_fee,additional_interview_fee:pkg.additional_interview_fee,
   included_interviews_per_role:pkg.included_interviews_per_role,max_interview_minutes:pkg.max_interview_minutes,
   first_role_prepay:pkg.first_role_prepay,...dates}};
 if(source!=='admin')snapshot.purchase_intent={id:intent};
 sql(`set role service_role;insert into clients(id,name,email,stripe_customer_id) values(${lit(client)},'SYNTHETIC ONLY',${lit(client+'@example.invalid')},${lit(customer)});
  insert into membership_agreements(id,client_id,status,is_current,client_legal_name,primary_admin_name,admin_email,
   membership_tier,billing_option,auto_renew,signer_accepted,template_version,template_snapshot,signed_at,
   agreement_expires_at,signer_token_hash,signer_token_expires_at,draft_pdf_path,initial_term_start,initial_renewal_date)
  values(${lit(id)},${lit(client)},'signed',true,'SYNTHETIC ONLY','Synthetic Buyer','buyer@example.invalid',${lit(plan)},
   ${lit(pkg.billing_cadence)},true,true,'membership_agreement_retail_terms_v2',${lit(snapshot)},clock_timestamp()-interval '30 minutes',
   clock_timestamp()+interval '7 days',${lit(crypto.createHash('sha256').update(id).digest('hex'))},clock_timestamp()+interval '7 days','synthetic/unused.pdf',
   ${lit(dates.initial_term_start)},${lit(dates.initial_renewal_date)});`);
 if(source!=='admin')sql(`set role service_role;insert into public_purchase_intents(id,agreement_id,client_id,status,protocol,
  selected_plan_key,selected_billing_cadence,package_snapshot,company_legal_name,buyer_first_name,buyer_last_name,buyer_email,
  first_role_prepay_selected,first_role_prepay_credit_type,first_role_normal_role_fee_cents,first_role_prepay_amount_cents,
  first_role_prepay_discount_percent,term_start_basis,expires_at)
  values(${lit(intent)},${lit(id)},${lit(client)},'agreement_pending','fenced_v2',${lit(plan)},${lit(pkg.billing_cadence)},${lit(pkg)},
  'SYNTHETIC ONLY','Synthetic','Buyer','buyer@example.invalid',${role},${lit(role?'first_role_prepay':null)},
  ${lit(role?pkg.first_role_prepay.normal_role_fee_cents:null)},${lit(role?pkg.first_role_prepay.discounted_credit_amount_cents:null)},
  ${lit(role?10:null)},${lit(basis)},clock_timestamp()+interval '7 days');`);
 return {id,client,intent,customer,pkg,snapshot,dates};
}
const claimSql=r=>`select claim_retail_existing_checkout_attempt(${[r.id,r.client,r.snapshot,r.customer,false,null,config].map(lit).join(',')});`;
const claim=r=>json(`set role service_role;${claimSql(r)}`);
const prices=role=>({initial_platform_price_id:'price_INITIAL',recurring_platform_price_id:'price_RECURRING',first_role_price_id:role?'price_ROLE':null});
const pinSql=(r,a,session='cs_SYNTHETIC')=>`select pin_retail_existing_checkout_session(${[r.id,r.client,a,session].map(lit).join(',')});`;
const row=r=>json(`select to_jsonb(t) from membership_agreements t where id=${lit(r.id)};`);
before(()=>{
 if(!enabled)return;
 assert.match(socket,/^\/private\/tmp\/alphascreen-generation-schema\.[A-Za-z0-9]+$/);
 assert.equal(process.env.PGPASSWORD,undefined);
 const r=cp.spawnSync(bin+'createdb',['-h',socket,'-p',port,'-U','postgres','-T','postgres',database],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 beforeAcl=acl();legacy=fixture({generation:false});beforeRow=row(legacy);
 for(const version of [OFFER_VERSION,STRIPE_RECURRING_OFFER_VERSION])for(const plan of ['basic','pro'])for(const months of [3,6,12])
  for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
   for(const source of payment==='prepaid'?['admin','public_purchase_intent','sales_assisted']:['admin','sales_assisted']){
    const r=fixture({generation:false,version,plan,months,payment,role,source});
    const material=json(`set role service_role;select retail_existing_checkout_material(${lit(row(r))},
     ${source==='admin'?'null':`(select to_jsonb(t) from public_purchase_intents t where id=${lit(r.intent)})`},${lit(r.customer)});`);
    oldCases.push({r,material});
   }
 sql(migration);
});
after(()=>{if(enabled){const r=cp.spawnSync(bin+'dropdb',['-h',socket,'-p',port,'-U','postgres',database],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);}});

test('additive migration preserves old row bytes/ACL/RLS and repeated application fails atomically',opts,()=>{
 const now=row(legacy);delete now.retail_checkout_prices;assert.deepEqual(now,beforeRow);assert.equal(acl(),beforeAcl);
 denied(migration,/prerequisite_drift|schema_drift/);assert.equal(acl(),beforeAcl);
 for(const guard of ['retail_admin_existing_billing_schema_guard','retail_admin_existing_member_schema_guard','retail_linked_existing_member_schema_guard'])
  sql(`set role service_role;select ${guard}();`);
 for(const fn of ['retail_generation_calendar(jsonb)','retail_generation_prices_valid(jsonb,jsonb)']){
  assert.equal(sql(`select has_function_privilege('anon',${lit('public.'+fn)},'execute') or has_function_privilege('authenticated',${lit('public.'+fn)},'execute');`),'f');
 }
});

for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
 test(`native generation claim/pin/retry ${plan}/${months}/${payment}/role=${role}`,opts,()=>{
  for(const source of payment==='prepaid'?['admin','public_purchase_intent','sales_assisted']:['admin','sales_assisted']){
   const r=fixture({plan,months,payment,role,source}),a=claim(r),binding=prices(role);
   assert.equal(a.prices,undefined);assert.equal(row(r).checkout_paid_at,null);
   const pinned=json(`set role service_role;${pinSql(r,{...a,prices:binding})}`);
   assert.deepEqual(pinned.prices,binding);assert.equal(pinned.checkout_session_id,'cs_SYNTHETIC');
   assert.deepEqual(claim(r),pinned);assert.deepEqual(json(`set role service_role;${pinSql(r,pinned)}`),pinned);
   const saved=row(r);assert.deepEqual(saved.retail_checkout_prices,binding);
   assert.equal(saved.initial_term_start,r.dates.initial_term_start);assert.equal(saved.initial_renewal_date,r.dates.initial_renewal_date);
   assert.equal(saved.checkout_paid_at,null);assert.equal(saved.retail_funding_receipt,null);
   if(source!=='admin')assert.equal(sql(`select stripe_checkout_session_id from public_purchase_intents where id=${lit(r.intent)};`),'cs_SYNTHETIC');
   denied(`set role service_role;${pinSql(r,{...pinned,prices:{...binding,initial_platform_price_id:'price_OTHER'}})}`,/pin_prices_changed/);
   denied(`set role service_role;update membership_agreements set retail_checkout_prices=null where id=${lit(r.id)};`,/prices_immutable/);
   denied(`set role service_role;update membership_agreements set initial_term_start=initial_term_start+1 where id=${lit(r.id)};`,/calendar_immutable/);
  }
 });

test('old first-payment sources remain usable with no generation prices or calendar writes',opts,()=>{
 const a=claim(legacy),pinned=json(`set role service_role;${pinSql(legacy,a,'cs_LEGACY')}`);
 assert.equal(pinned.prices,undefined);assert.equal(row(legacy).retail_checkout_prices,null);
 assert.equal(row(legacy).initial_term_start,null);
 denied(`set role service_role;${pinSql(legacy,{...pinned,prices:prices(false)},'cs_LEGACY')}`,/pin_prices_changed/);
});

test('all120 legacy v1/v2 commercial/source variants preserve their exact material and claim/pin/retry behavior',opts,()=>{
 assert.equal(oldCases.length,120);
 for(const {r,material} of oldCases){
  const a=claim(r);assert.deepEqual({...a.source,config:undefined},{...material,config:undefined});
  const session='cs_'+r.id.replaceAll('-',''),pinned=json(`set role service_role;${pinSql(r,a,session)}`);
  assert.deepEqual(claim(r),pinned);assert.equal(pinned.prices,undefined);
  assert.equal(row(r).initial_term_start,null);assert.equal(row(r).retail_checkout_prices,null);
 }
});

test('new offer acceptance does not permit a generation schedule to qualify as an old funded-period receipt',opts,()=>{
 const f=require('./fixtures/existing-retail-funding-fixture').fixture();
 const offer=f.pkg.membership_terms;
 const verified=require('../src/services/existingRetailCheckoutFunding').verifyExistingRetailFunding({offer,checkout:f.cs,
  checkoutLines:{object:'list',has_more:false,data:f.cl},subscription:f.s,subscriptionItems:f.s.items,invoice:f.inv,
  invoiceLines:{object:'list',has_more:false,data:f.il},paymentIntent:f.pi,charge:f.ch,
  expected:{customerId:f.c.stripe_customer_id,checkoutId:f.cs.id,signedAt:f.g.signed_at,agreementDeadline:f.g.agreement_expires_at}});
 const p={provider_account_id:'acct_SYNTHETIC',period:verified.initialProviderPeriod,payment_intent_id:verified.paymentIntentId,
  charge_id:verified.chargeId,checkout_created:verified.checkoutCreatedEpoch,invoice_created:verified.invoiceCreatedEpoch,
  platform_gross_cents:verified.platformGrossCents,platform_discount_cents:verified.platformDiscountCents,platform_net_cents:verified.platformNetCents,
  role_gross_cents:verified.roleGrossCents,role_discount_cents:verified.roleDiscountCents,role_net_cents:verified.roleNetCents,
  tax_cents:verified.taxCents,cash_cents:verified.cashCents};
 const w={version:'retail_existing_funding_v1',proof:p,recorded_at:'2026-10-15T23:00:00.000000Z'};
 const source={template_snapshot:structuredClone(f.g.template_snapshot),customer_id:f.c.stripe_customer_id,
  signed_at:f.g.signed_at,agreement_expires_at:f.g.agreement_expires_at,intent:{expires_at:f.i.expires_at}};
 assert.equal(sql(`set role service_role;select retail_existing_funding_receipt_valid(${lit(w)},${lit(source)});`),'t');
 source.template_snapshot.package_snapshot=buildRetailPackageSnapshot({planKey:offer.plan_key,commitmentMonths:offer.commitment_months,
  paymentOption:offer.payment_option,firstRolePrepaySelected:offer.first_role_prepay.selected,channel:'sales',offerVersion:GENERATION_DATE_OFFER_VERSION});
 assert.equal(sql(`set role service_role;select retail_existing_funding_receipt_valid(${lit(w)},${lit(source)});`),'f');
});

test('existing fingerprint enforcement still refuses altered helper bodies after the migration',opts,()=>{
 denied(`begin;do $x$declare d text;begin select pg_get_functiondef('retail_existing_valid_offer(jsonb)'::regprocedure) into d;
  execute replace(d,'declare v_months','-- SYNTHETIC DRIFT'||chr(10)||'declare v_months');end $x$;
  set role service_role;select retail_admin_existing_billing_schema_guard();commit;`,/prerequisite_drift/);
 sql('set role service_role;select retail_admin_existing_billing_schema_guard();');
 for(const fn of ['retail_generation_calendar(jsonb)','retail_generation_prices_valid(jsonb,jsonb)']){
  denied(`begin;do $x$declare d text;begin select pg_get_functiondef(${lit(fn)}::regprocedure) into d;
   execute replace(d,'AS $function$','AS $function$'||chr(10)||'-- SYNTHETIC DRIFT');end $x$;
   set role service_role;select retail_linked_existing_member_schema_guard();commit;`,/prerequisite_drift/);
  denied(`begin;grant execute on function ${fn} to public;set role service_role;
   select retail_admin_existing_billing_schema_guard();commit;`,/prerequisite_drift/);
 }
 sql('set role service_role;select retail_linked_existing_member_schema_guard();');
});

test('native generation calendar matches UTC/original month-end and rejects source/version/date mutations',opts,()=>{
 for(const [generatedAt,months] of [['2026-01-31T23:59:59.999Z',3],['2027-08-31T01:00:00.000Z',6],['2028-02-29T01:00:00.000Z',12]]){
  const r=fixture({generatedAt,months}),a=row(r),c=json(`set role service_role;select retail_generation_calendar(${lit(a)});`);
  assert.equal(c.initial_term_start,r.dates.initial_term_start);assert.equal(c.initial_renewal_date,r.dates.initial_renewal_date);
  for(const mutate of [x=>x.initial_term_start='2026-01-01',x=>x.initial_renewal_date='2030-01-01',
   x=>x.template_snapshot.generated_at='2026-02-30T00:00:00.000Z',x=>x.template_snapshot.generated_at=undefined,
   x=>x.template_snapshot.values.initial_term_start='2026-01-01',
   x=>x.template_snapshot.package_snapshot.membership_terms.term_start_basis='first_payment_success',
   x=>x.template_snapshot.package_snapshot.membership_terms.offer_version=STRIPE_RECURRING_OFFER_VERSION]){
   const bad=structuredClone(a);mutate(bad);denied(`set role service_role;select retail_generation_calendar(${lit(bad)});`,/retail_|date\/time/);
  }
 }
});

test('invalid/missing/extra/duplicate price bindings and invented dates never pin a session',opts,()=>{
 const r=fixture({source:'sales_assisted'}),a=claim(r);
 for(const binding of [undefined,{}, {...prices(false),extra:'price_EXTRA'}, {...prices(false),first_role_price_id:'price_ROLE'},
  {...prices(false),initial_platform_price_id:'price_RECURRING'}, {...prices(false),initial_platform_price_id:'bad'},
  {...prices(false),recurring_platform_price_id:null}]){
  denied(`set role service_role;${pinSql(r,{...a,prices:binding})}`,/pin_prices_changed/);
  assert.equal(row(r).checkout_session_id,null);
 }
 denied(`set role service_role;update membership_agreements set checkout_session_id='cs_FORGED' where id=${lit(r.id)};`,/prices_pin_required/);
 denied(`set role service_role;update membership_agreements set retail_checkout_prices=${lit(prices(false))} where id=${lit(r.id)};`,/prices_pin_required/);
 denied(`set role service_role;update membership_agreements set initial_renewal_date=initial_renewal_date+1 where id=${lit(r.id)};`,/calendar_immutable/);
});

test('elapsed/near collection and future generation cannot claim or mint a native attempt',opts,()=>{
 for(const generatedAt of ['2026-01-01T00:00:00.000Z',new Date(Date.now()+86400000).toISOString()]){
  const r=fixture({generatedAt});denied(`set role service_role;${claimSql(r)}`,/window_closed/);
  assert.equal(row(r).checkout_attempt_source,null);
 }
});

test('public generation basis constraint does not allow missing or mixed source markers',opts,()=>{
 const r=fixture({source:'public_purchase_intent'});
 denied(`set role service_role;update public_purchase_intents set package_snapshot='{}'::jsonb where id=${lit(r.intent)};`,/check constraint/);
 denied(`set role authenticated;${claimSql(r)}`,/permission denied|server_only/);
 denied(`set role anon;select retail_generation_calendar('{}'::jsonb);`,/permission denied/);
});
