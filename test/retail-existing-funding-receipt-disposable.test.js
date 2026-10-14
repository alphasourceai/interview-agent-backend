'use strict';
// Opt-in real full empty QA schema + curated16 migrations, private Unix socket.
const {test,before}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {buildRetailPackageSnapshot}=require('../src/services/membershipPackageCompatibility');
const {OFFER_VERSION,anchoredMonthInstant}=require('../src/services/membershipOffers');
const enabled=process.env.RETAIL_FUNDING_RECEIPT_DISPOSABLE==='true',opts={skip:!enabled};
const migration=path.resolve(__dirname,'../supabase/migrations/20261013231615_retail_existing_initial_funding_receipt.sql');
const linkedMemberMigrationPath=path.resolve(__dirname,'../supabase/migrations/20261014045836_retail_existing_linked_buyer_member.sql');
const customerIndex='CREATE UNIQUE INDEX billing_customers_stripe_customer_id_uniq ON public.billing_customers USING btree (stripe_customer_id) WHERE (stripe_customer_id IS NOT NULL)';
const lit=v=>v==null?'null':typeof v==='object'?`'${JSON.stringify(v).replaceAll("'","''")}'::jsonb`:typeof v==='boolean'||typeof v==='number'?String(v):`'${String(v).replaceAll("'","''")}'`;
function run(q){return cp.spawnSync('/opt/homebrew/opt/postgresql@17/bin/psql',['-X','-q','-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'});}
function sql(q){const r=run(q);assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function denied(q,pattern=/retail_funding_/){const r=run(q);assert.notEqual(r.status,0);assert.match(r.stderr,pattern);}
const acl=()=>sql("select jsonb_agg(jsonb_build_array(relname,relacl::text,relrowsecurity) order by relname) from pg_class where oid in('clients'::regclass,'membership_agreements'::regclass,'public_purchase_intents'::regclass,'billing_customers'::regclass);");
let priorAcl,legacyBefore,priorFunctions,historicalV2,historicalBillingV2,historicalBefore,historicalIntentBefore,linkedOriginalCatalog;const legacyId=crypto.randomUUID();
const linkedOriginalFunctions=()=>sql("select jsonb_agg(jsonb_build_array(oid::regprocedure::text,pg_get_functiondef(oid),proowner::regrole::text,proacl::text) order by oid::regprocedure::text) from pg_proc where proname in('apply_public_purchase_billing','ensure_public_purchase_buyer_member','locked_purchase_context');");
const functionCatalog=()=>sql("select jsonb_agg(jsonb_build_array(proname,md5(prosrc),provolatile,prosecdef,proconfig,proowner::regrole::text,proacl::text) order by proname) from pg_proc where proname in ('retail_existing_funding_context','record_retail_existing_funding');");
before(()=>{if(!enabled)return;assert.match(process.env.PGHOST||'',/^\/private\/tmp\/alphascreen-retail-funding-pg\.[A-Za-z0-9]+$/);
 assert.equal(process.env.PGPORT,'55456');assert.equal(process.env.PGUSER,'postgres');assert.equal(process.env.PGDATABASE,'postgres');assert.equal(process.env.PGPASSWORD,undefined);
 sql(`insert into membership_agreements(id,status,is_current,client_legal_name,primary_admin_name,admin_email,membership_tier,billing_option,
  template_snapshot,draft_pdf_path,signer_token_hash,signer_token_expires_at,checkout_paid_at,checkout_status)
  values(${lit(legacyId)},'signed',true,'Synthetic Legacy','QA','legacy@example.invalid','basic','monthly','{}','legacy.pdf',
  ${lit(crypto.createHash('sha256').update(legacyId).digest('hex'))},clock_timestamp()+interval '7 days','2026-01-01Z','paid');`);
 legacyBefore=sql(`select to_jsonb(a) from membership_agreements a where id=${lit(legacyId)};`);
 priorAcl=acl();sql(fs.readFileSync(migration,'utf8'));
 sql(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261013232342_retail_existing_purchase_intent_prepaid.sql'),'utf8'));
 const amendment=fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261013235104_retail_existing_funding_prerequisites.sql'),'utf8');
 priorFunctions=functionCatalog();
 for(const name of ['retail_existing_funding_context','record_retail_existing_funding']){
  const definition=sql(`select pg_get_functiondef(oid) from pg_proc where proname='${name}';`);
  try{sql(definition.replace('\nbegin\n','\nbegin\n -- disposable drift sentinel\n'));
   denied(amendment,/retail_funding_prerequisite_drift/);
   assert.equal(sql("select to_regprocedure('public.retail_existing_funding_schema_guard()') is null;"),'t');
   assert.equal(acl(),priorAcl);
  }finally{sql(definition);}
  assert.equal(functionCatalog(),priorFunctions);
 }
 // Migration must roll back even after creating the new helper. Deliberately
 // remove only this disposable existing index, then restore its exact DDL.
 try{sql('drop index public.billing_customers_stripe_customer_id_uniq;');
  denied(amendment,/retail_funding_schema_drift/);
  assert.equal(functionCatalog(),priorFunctions);assert.equal(acl(),priorAcl);
  assert.equal(sql("select to_regprocedure('public.retail_existing_funding_schema_guard()') is null;"),'t');
 }finally{sql(customerIndex+';');}
 sql(amendment);
 sql(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261014000816_retail_existing_funding_replay_read.sql'),'utf8'));
 // Explicit synthetic already-paid V2 cohort BEFORE the new admission gate,
 // using actual original completion. Never infer an original period/backfill.
 historicalV2=fixture('basic',3,'monthly_installments');nativeComplete(historicalV2);
 historicalBillingV2=fixture('basic',3,'monthly_installments');nativeComplete(historicalBillingV2);
 historicalBefore=sql(`select to_jsonb(a) from membership_agreements a where id=${lit(historicalV2.id)};`);
 historicalIntentBefore=sql(`select to_jsonb(i) from public_purchase_intents i where id=${lit(historicalV2.intent)};`);
 sql(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261014001920_retail_existing_receipt_activation_admission.sql'),'utf8'));
 const billingMigration=fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261014004904_retail_existing_billing_receipt_fence.sql'),'utf8');
 const billingCatalog=()=>sql("select jsonb_agg(jsonb_build_array(oid::regprocedure::text,md5(prosrc),prosecdef,provolatile,proconfig,proowner::regrole::text,proacl::text)) from pg_proc where proname='apply_public_purchase_billing';");
 const originalBilling=billingCatalog(),definition=sql("select pg_get_functiondef(oid) from pg_proc where proname='apply_public_purchase_billing';");
 try{sql(definition.replace('\nbegin\n','\nbegin\n -- disposable original writer drift sentinel\n'));
  denied(billingMigration,/retail_funding_billing_prerequisite_drift/);
  assert.equal(acl(),priorAcl);
 }finally{sql(definition);}
 assert.equal(billingCatalog(),originalBilling);
 sql(billingMigration);
 const adminMigration=fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261014010430_retail_existing_admin_client_write.sql'),'utf8');
 try{sql("create function public.apply_retail_existing_admin_client(uuid,uuid,jsonb,jsonb,jsonb) returns void language sql as 'select null::void';");
  denied(adminMigration,/retail_admin_client_schema_drift/);assert.equal(acl(),priorAcl);
 }finally{sql('drop function public.apply_retail_existing_admin_client(uuid,uuid,jsonb,jsonb,jsonb);');}
 sql(adminMigration);
 const onceMigration=fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261014020146_retail_existing_admin_once_billing.sql'),'utf8');
 try{
  sql("create function public.apply_retail_existing_admin_billing(uuid) returns void language sql as 'select null::void';");
  denied(onceMigration,/retail_admin_billing_schema_drift/);
  assert.equal(sql("select count(*) from pg_attribute where attrelid='membership_agreements'::regclass and attname='retail_admin_billing_receipt' and not attisdropped;"),'0');
 }finally{sql('drop function public.apply_retail_existing_admin_billing(uuid);');}
 sql(onceMigration);
 const memberMigration=fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261014030734_retail_existing_admin_buyer_member.sql'),'utf8');
 try{
  sql("create function public.ensure_retail_existing_admin_buyer_member(uuid) returns void language sql as 'select null::void';");
  denied(memberMigration,/retail_admin_member_schema_drift/);
  assert.equal(sql("select to_regprocedure('public.retail_admin_existing_member_schema_guard()') is null;"),'t');
 }finally{sql('drop function public.ensure_retail_existing_admin_buyer_member(uuid);');}
 sql(memberMigration);
 const linkedMemberMigration=fs.readFileSync(linkedMemberMigrationPath,'utf8');
 linkedOriginalCatalog=linkedOriginalFunctions();
 try{sql("create function public.ensure_retail_existing_linked_buyer_member(uuid) returns void language sql as 'select null::void';");
  denied(linkedMemberMigration,/retail_linked_member_schema_drift/);
  assert.equal(sql("select to_regprocedure('retail_linked_existing_member_schema_guard()') is null;"),'t');
 }finally{sql('drop function public.ensure_retail_existing_linked_buyer_member(uuid);');}
 sql(linkedMemberMigration);
 assert.equal(linkedOriginalFunctions(),linkedOriginalCatalog);
 // Exact old-data oracles remain, with ONLY the new nullable receipt column.
 // Derive expected JSON from the prior saved oracle, not a fresh row read that
 // could hide migration DML or changes to an accepted historical agreement.
 legacyBefore=sql(`select (${lit(JSON.parse(legacyBefore))}||jsonb_build_object('retail_admin_billing_receipt',null))::text;`);
 historicalBefore=sql(`select (${lit(JSON.parse(historicalBefore))}||jsonb_build_object('retail_admin_billing_receipt',null))::text;`);
});
function fixture(plan='basic',months=3,payment='prepaid',role=false,linked=true,replacement=false,adminSource='admin',linkedSource='sales_assisted'){
 const id=crypto.randomUUID(),client=crypto.randomUUID(),intent=crypto.randomUUID(),key='SYNTHETIC_CLAIM_'+crypto.randomUUID(),suffix=id.replaceAll('-','');
 const customer='cus_'+suffix,session='cs_'+suffix,pkg=buildRetailPackageSnapshot({planKey:plan,commitmentMonths:months,paymentOption:payment,firstRolePrepaySelected:role,offerVersion:OFFER_VERSION,channel:linked&&linkedSource==='public_purchase_intent'?'public':'sales'});
 const snapshot={template_version:'membership_agreement_retail_terms_v2',source:linked?linkedSource:adminSource,package_snapshot:pkg,
  ...(linked?{purchase_intent:{id:intent}}:{}),values:{membership_tier:plan,billing_option:pkg.billing_cadence,auto_renew:true,
   commitment_months:months,payment_option:payment,pricing_version:pkg.pricing_version,term_start_basis:'successful_payment',platform_fee:String(pkg.platform_fee),
   per_role_fee:String(pkg.per_role_fee),additional_interview_fee:String(pkg.additional_interview_fee),included_interviews_per_role:String(pkg.included_interviews_per_role),
   max_interview_minutes:String(pkg.max_interview_minutes),first_role_prepay:pkg.first_role_prepay}};
 sql(`set role service_role;insert into clients(id,name,email,stripe_customer_id,plan_tier) values(${lit(client)},'Synthetic Native Funding','buyer@example.invalid',${lit(customer)},${lit(plan)});
  insert into billing_customers(client_id,name,primary_contact_email,stripe_customer_id) values(${lit(client)},'Synthetic Native Funding','buyer@example.invalid',${lit(customer)});
  insert into membership_agreements(id,client_id,status,is_current,client_legal_name,primary_admin_name,admin_email,membership_tier,billing_option,
   auto_renew,signer_accepted,template_version,template_snapshot,draft_pdf_path,signer_token_hash,signer_token_expires_at,signed_at,agreement_expires_at)
  values(${lit(id)},${lit(client)},'signed',true,'Synthetic Native Funding','QA','buyer@example.invalid',${lit(plan)},${lit(pkg.billing_cadence)},true,true,
   'membership_agreement_retail_terms_v2',${lit(snapshot)},'synthetic.pdf',${lit(crypto.createHash('sha256').update(id).digest('hex'))},clock_timestamp()+interval '7 days',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '7 days');`);
 if(linked)sql(`set role service_role;insert into public_purchase_intents(id,agreement_id,client_id,status,protocol,selected_plan_key,selected_billing_cadence,
  package_snapshot,first_role_prepay_selected,first_role_prepay_amount_cents,first_role_normal_role_fee_cents,first_role_prepay_discount_percent,
  first_role_prepay_credit_type,term_start_basis,expires_at,company_legal_name,buyer_first_name,buyer_last_name,buyer_email)
  values(${lit(intent)},${lit(id)},${lit(client)},'checkout_pending','fenced_v2',${lit(plan)},${lit(pkg.billing_cadence)},${lit(pkg)},${role},
  ${lit(role?pkg.first_role_prepay.discounted_credit_amount_cents:null)},${lit(role?pkg.first_role_prepay.normal_role_fee_cents:null)},${lit(role?10:null)},
  ${lit(role?'first_role_prepay':null)},'successful_payment',clock_timestamp()+interval '7 days','Synthetic Native Funding','QA','Buyer','buyer@example.invalid');`);
 const config={public_backend_base:'https://api.example.invalid',public_sign_base:'https://site.example.invalid'};
 const replacementId=replacement?'sub_ACCEPTED_'+suffix:null;
 if(replacement)sql(`set role service_role;update clients set stripe_subscription_id=${lit(replacementId)} where id=${lit(client)};`);
 const attempt=JSON.parse(sql(`set role service_role;select claim_retail_existing_checkout_attempt(${[id,client,snapshot,customer,false,replacementId,config].map(lit).join(',')});`));
 sql(`set role service_role;select pin_retail_existing_checkout_session(${[id,client,attempt,session].map(lit).join(',')});`);
 if(linked)sql(`set role service_role;select claim_public_purchase_activation(${lit(id)},${lit(key)});`);
 const source=JSON.parse(sql(`select checkout_attempt_source from membership_agreements where id=${lit(id)};`));
 const created=Math.floor(Date.parse(attempt.created_at)/1000),paid=new Date(created*1000).toISOString();
 const proof={provider_account_id:'acct_SYNTHETIC',period:{version:'retail_initial_provider_period_v1',api_version:'2023-10-16',invoice_id:'in_'+suffix,
  platform_invoice_line_id:'il_'+suffix,price_id:'price_'+suffix,subscription_id:'sub_'+suffix,subscription_item_id:'si_'+suffix,customer_id:customer,
  checkout_session_id:session,livemode:false,paid_at:paid,provider_period_start:created,provider_period_end:Date.parse(anchoredMonthInstant(paid,pkg.membership_terms.stripe_recurrence.interval_count))/1000},
  payment_intent_id:'pi_'+suffix,charge_id:'ch_'+suffix,checkout_created:created,invoice_created:created,
  platform_gross_cents:pkg.platform_fee_cents,platform_discount_cents:0,platform_net_cents:pkg.platform_fee_cents,
  role_gross_cents:pkg.first_role_prepay.discounted_credit_amount_cents,role_discount_cents:0,role_net_cents:pkg.first_role_prepay.discounted_credit_amount_cents,
  tax_cents:0,cash_cents:pkg.membership_terms.initial_payment_cents};
 return{id,client,intent,key:linked?key:null,proof,source,pkg};
}
function call(f,proof=f.proof,source=f.source,key=f.key){return `select record_retail_existing_funding(${[f.id,f.client,key,source,proof].map(lit).join(',')});`;}
const record=f=>JSON.parse(sql('set role service_role;'+call(f)));
const row=f=>JSON.parse(sql(`select to_jsonb(a) from membership_agreements a where id=${lit(f.id)};`));
const readCall=(f,key=f.key,source=f.source)=>`select read_retail_existing_funding(${[f.id,f.client,key,source].map(lit).join(',')});`;
const readReceipt=f=>JSON.parse(sql('set role service_role;'+readCall(f)));
function nativeComplete(f){
 const r=JSON.parse(sql('set role service_role;'+completeCall(f)));assert.equal(r.status,'completed');return r;
}
function completeCall(f){
 const start=f.proof.period.paid_at.slice(0,10),end=anchoredMonthInstant(f.proof.period.paid_at,f.pkg.membership_terms.commitment_months).slice(0,10);
 return 'select complete_public_purchase_activation('+[
  f.id,f.key,f.proof.period.paid_at,f.proof.period.checkout_session_id,f.client,false,f.pkg.plan_key,f.pkg.billing_cadence,start,end].map(lit).join(',')+');';
}
// Exercise the existing 28-argument writer, not a simulated billing callback.
function billingCall(f,patch={}){
 const p=f.pkg,c=p.first_role_prepay,a=f.proof.period;
 const args={intent:f.intent,key:f.key,client:f.client,billingClient:f.client,customer:a.customer_id,subscription:a.subscription_id,
  subscriptionStatus:'active',billingStatus:'active',cadence:p.billing_cadence,plan:p.plan_key,
  currentEnd:new Date(a.provider_period_end*1000).toISOString(),cancel:false,renew:true,cancelAt:null,
  start:a.paid_at,end:anchoredMonthInstant(a.paid_at,p.membership_terms.commitment_months),
  platform:p.platform_fee,role:p.per_role_fee,included:p.included_interviews_per_role,extra:p.additional_interview_fee,minutes:p.max_interview_minutes,
  credit:c.selected,type:c.selected?c.credit_type:null,normal:c.selected?c.normal_role_fee_cents:null,
  discounted:c.selected?c.discounted_credit_amount_cents:null,discount:c.selected?c.discount_percent:null,
  nonRefundable:c.selected?c.non_refundable:null,expires:c.selected?c.expires:null,...patch};
 return 'select apply_public_purchase_billing('+Object.values(args).map(lit).join(',')+');';
}
const nativeBilling=(f,patch)=>JSON.parse(sql('set role service_role;'+billingCall(f,patch)));
// Native linked membership delegates to the unchanged original four-arg RPC.
// User IDs/current provider data are synthetic, not hosted Auth acceptance.
function linkedMemberFixture(plan='basic',months=3,payment='prepaid',role=false,source='sales_assisted',seconds=null){
 const f=fixture(plan,months,payment,role,true,false,'admin',source);
 if(seconds!==null)f.proof.period.provider_period_end=Math.floor(Date.now()/1000)+seconds;
 record(f);nativeComplete(f);f.digest=nativeBilling(f).digest;f.user=crypto.randomUUID();return f;
}
const linkedMemberCurrent=f=>({...adminSubscription(f),cancel_at:null,pause_collection:null});
const linkedMemberCall=(f,user=f.user,current=linkedMemberCurrent(f),digest=f.digest,key=f.key,name='Synthetic Buyer')=>
 'select ensure_retail_existing_linked_buyer_member('+[f.intent,key,digest,current,user,name].map(lit).join(',')+');';
const nativeLinkedMember=(f,...args)=>JSON.parse(sql('set role service_role;'+linkedMemberCall(f,...args)));
const billingState=f=>sql(`select jsonb_build_object('client',(select to_jsonb(c) from clients c where id=${lit(f.client)}),
 'intent',(select to_jsonb(i) from public_purchase_intents i where id=${lit(f.intent)}),
 'plan',(select to_jsonb(p) from client_plan_settings p where client_id=${lit(f.client)}),
 'credits',(select jsonb_agg(to_jsonb(r) order by id) from client_role_credits r where source_client_id=${lit(f.client)}));`);
function markAdminPaid(f){
 sql(`set role service_role;update membership_agreements set checkout_status='paid',checkout_paid_at=${lit(f.proof.period.paid_at)} where id=${lit(f.id)};`);
}
function adminInitial(f){
 // Match the canonical activation tests: mock ONLY the unneeded hosted-client
 // module, never the original payload builder or the real native SQL writer.
 const clientPath=require.resolve('../src/clients/supabase');
 if(!require.cache[clientPath])require.cache[clientPath]={id:clientPath,filename:clientPath,loaded:true,
  exports:{supabaseAdmin:{auth:{admin:{}},from(){throw Error('hosted database forbidden');},rpc(){throw Error('hosted database forbidden');}}}};
 const {buildClientActivationPayload}=require('../src/services/publicPurchaseActivation');
 return buildClientActivationPayload({agreement:row(f),subscription:{id:f.proof.period.subscription_id,customer:f.proof.period.customer_id,status:'active',
  start_date:f.proof.period.provider_period_start,current_period_end:f.proof.period.provider_period_end,cancel_at_period_end:false},
  planKey:f.pkg.plan_key,billingInterval:f.pkg.billing_cadence,packageSnapshot:f.pkg,paidAt:f.proof.period.paid_at});
}
const adminSubscription=f=>({id:f.proof.period.subscription_id,customer:f.proof.period.customer_id,status:'active',current_period_end:f.proof.period.provider_period_end,cancel_at_period_end:false});
function adminCall(f,payload=adminInitial(f),source=f.source,receipt=row(f).retail_funding_receipt,sub=adminSubscription(f)){
 return 'select apply_retail_existing_admin_client('+[f.id,f.client,source,receipt,payload,sub].map(lit).join(',')+');';
}
const nativeAdmin=f=>JSON.parse(sql('set role service_role;'+adminCall(f)));
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
test(`admin original payload -> native client only ${plan}/${months}/${payment}/role:${role}`,opts,()=>{
 const f=fixture(plan,months,payment,role,false);record(f);markAdminPaid(f);const before=row(f),p=adminInitial(f);
 const result=nativeAdmin(f);assert.equal(result.status,'applied');assert.deepEqual(result.client_initial,p);
 const state=JSON.parse(billingState(f));assert.equal(state.plan,null);assert.equal(state.credits,null);assert.equal(state.intent,null);
 for(const field of Object.keys(p)){
  if(['current_term_end','contract_start_at','contract_end_at'].includes(field))assert.equal(Date.parse(state.client[field]),Date.parse(p[field]));
  else assert.deepEqual(state.client[field],p[field]);
 }
 const applied=billingState(f);assert.equal(nativeAdmin(f).status,'already_applied');assert.equal(billingState(f),applied);assert.deepEqual(row(f),before);
});
test('admin client primitive refuses linked source, historical no-receipt and pending unpaid state',opts,()=>{
 const linked=fixture();record(linked);nativeComplete(linked);const l=billingState(linked);
 denied('set role service_role;'+adminCall(linked),/retail_admin_client_/);assert.equal(billingState(linked),l);
 const pending=fixture('basic',3,'prepaid',false,false);record(pending);const p=billingState(pending);
 denied('set role service_role;'+adminCall(pending),/retail_admin_client_/);assert.equal(billingState(pending),p);
 denied('set role service_role;'+adminCall(historicalV2),/retail_admin_client_/);
});
test('admin native write rechecks moved owner/archive/parent/customer/sub/current/voided state after proof and paid CAS',opts,()=>{
 for(const change of ['profile','archive','parent','customer','subscription','current','void']){
  const f=fixture('basic',3,'prepaid',false,false);record(f);markAdminPaid(f);
  if(change==='profile')sql(`update billing_customers set stripe_customer_id=null where client_id=${lit(f.client)};`);
  if(change==='archive')sql(`update clients set archived_at=clock_timestamp() where id=${lit(f.client)};`);
  if(change==='parent'){const id=crypto.randomUUID();sql(`insert into clients(id,name,email) values(${lit(id)},'Synthetic Parent','parent@example.invalid');update clients set parent_client_id=${lit(id)} where id=${lit(f.client)};`);}
  if(change==='customer')sql(`update clients set stripe_customer_id='cus_CHANGED' where id=${lit(f.client)};`);
  if(change==='subscription')sql(`update clients set stripe_subscription_id=${lit('sub_ADMIN_CHANGED_'+f.client.replaceAll('-',''))} where id=${lit(f.client)};`);
  if(change==='current')sql(`update membership_agreements set is_current=false where id=${lit(f.id)};`);
  if(change==='void')sql(`update membership_agreements set voided_at=clock_timestamp() where id=${lit(f.id)};`);
  const before=billingState(f);denied('set role service_role;'+adminCall(f),/retail_admin_client_/);assert.equal(billingState(f),before);
 }
});
test('admin initial projection refuses injected or changed fields and source/receipt mismatch',opts,()=>{
 const f=fixture('pro',6,'prepaid',true,false);record(f);markAdminPaid(f);const before=billingState(f);
 for(const patch of [{stripe_customer_id:'cus_CHANGED'},{stripe_subscription_id:'sub_CHANGED'},{subscription_status:'trialing'},
  {billing_status:'inactive'},{auto_renew:false},{cancel_at_term_end:true},{contract_end_at:'2099-01-01T00:00:00.000Z'},
  {contract_start_at:'2026-01-01T00:00:00.000Z'},{current_term_end:'2099-01-01T00:00:00.000Z'},{extra:true}]){
  denied('set role service_role;'+adminCall(f,{...adminInitial(f),...patch}),/retail_admin_client_payload_denied/);assert.equal(billingState(f),before);
 }
 const missing=adminInitial(f);delete missing.plan_tier;denied('set role service_role;'+adminCall(f,missing),/retail_admin_client_payload_denied/);
 denied('set role service_role;'+adminCall(f,adminInitial(f),{...f.source,customer_id:'cus_OTHER'}),/retail_admin_client_source_denied/);
 denied('set role service_role;'+adminCall(f,adminInitial(f),f.source,{...row(f).retail_funding_receipt,extra:true}),/retail_admin_client_source_denied/);
 assert.equal(billingState(f),before);
});
test('admin identical client retry does not reset changed renewal preferences or overwrite unrelated contract',opts,()=>{
 const f=fixture('basic',3,'prepaid',false,false);record(f);markAdminPaid(f);nativeAdmin(f);
 sql(`update clients set auto_renew=false,cancel_at_term_end=true where id=${lit(f.client)};`);const before=billingState(f);
 denied('set role service_role;'+adminCall(f),/retail_admin_client_existing_state_conflict/);assert.equal(billingState(f),before);
});
test('admin current subscription cannot be replaced by the original builder active-status fallback or newer unpaid period',opts,()=>{
 const f=fixture('pro',6,'monthly_installments',false,false);record(f);markAdminPaid(f);const before=billingState(f);
 for(const patch of [{status:'canceled'},{status:'past_due'},{status:'trialing'},{cancel_at_period_end:true},
  {id:'sub_OTHER'},{customer:'cus_OTHER'},{current_period_end:f.proof.period.provider_period_end+86400},{extra:true}]){
  denied('set role service_role;'+adminCall(f,adminInitial(f),f.source,row(f).retail_funding_receipt,{...adminSubscription(f),...patch}),/retail_admin_client_subscription_denied/);
  assert.equal(billingState(f),before);
 }
});
test('admin substituted receipt lacking B refuses before client write without weakening immutable receipt validation',opts,()=>{
 const f=fixture('basic',3,'prepaid',false,false);record(f);markAdminPaid(f);
 const p=structuredClone(row(f).retail_funding_receipt);p.proof.period.provider_period_end=null;
 const before=billingState(f);denied('set role service_role;'+adminCall(f,adminInitial(f),f.source,p),/retail_admin_client_source_denied/);assert.equal(billingState(f),before);
});
test('admin pinned existing native month anchor matches original JS month-end and leap-year terms',opts,()=>{
 for(const a of ['2024-01-31T12:34:56.000Z','2024-02-29T12:34:56.000Z','2026-08-31T12:34:56.000Z'])for(const months of [3,6,12]){
  const native=sql(`set role service_role;select public.retail_existing_month_anchor(${lit(a)},${months});`);
  assert.equal(new Date(native).toISOString(),anchoredMonthInstant(a,months));
 }
});
test('admin concurrent same tuple writers serialize to one client apply and one no-op',opts,async()=>{
 const f=fixture('basic',3,'prepaid',false,false);record(f);markAdminPaid(f);
 const [a,b]=await Promise.all([parallel('set role service_role;begin;'+adminCall(f)+'select pg_sleep(0.1);commit;'),parallel('set role service_role;'+adminCall(f))]);
 assert.equal(a.code,0,a.err);assert.equal(b.code,0,b.err);
 const statuses=[a,b].map(r=>JSON.parse(r.out.split('\n').find(s=>s.startsWith('{'))).status).sort();assert.deepEqual(statuses,['already_applied','applied']);
});
test('native sealed admin source rejects phantom intent insert during admin client transaction',opts,async()=>{
 const f=fixture('basic',3,'prepaid',false,false);record(f);markAdminPaid(f);const id=crypto.randomUUID();
 const insert=`insert into public_purchase_intents(id,agreement_id,selected_plan_key,selected_billing_cadence,company_legal_name,buyer_first_name,buyer_last_name,buyer_email)
  values(${lit(id)},${lit(f.id)},'basic','monthly','Synthetic Phantom','QA','Buyer','phantom@example.invalid');`;
 const [writer,link]=await Promise.all([parallel('set role service_role;begin;'+adminCall(f)+'select pg_sleep(0.4);commit;'),
  parallel('set role service_role;select pg_sleep(0.07);'+insert)]);
 assert.equal(writer.code,0,writer.err);assert.notEqual(link.code,0);assert.match(link.err,/retail_admin_client_intent_link_denied/);
 assert.equal(sql(`select count(*) from public_purchase_intents where agreement_id=${lit(f.id)};`),'0');
});
test('admin RPC is invoker/browser denied and migration reapply leaves original state intact',opts,()=>{
 assert.equal(sql("select not prosecdef and proconfig=array['search_path=pg_catalog','lock_timeout=10s'] from pg_proc where proname='apply_retail_existing_admin_client';"),'t');
 const f=fixture('basic',3,'prepaid',false,false);record(f);markAdminPaid(f);const before=billingState(f);
 for(const role of ['anon','authenticated'])denied('set role '+role+';'+adminCall(f),/permission denied/);
 denied(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261014010430_retail_existing_admin_client_write.sql'),'utf8'),/retail_admin_client_schema_drift/);
 assert.equal(billingState(f),before);assert.equal(acl(),priorAcl);
 try{sql('alter table public.public_purchase_intents disable trigger retail_existing_funding_intent_clock_guard;');
  denied('set role service_role;'+adminCall(f),/retail_admin_client_trigger_drift/);assert.equal(billingState(f),before);
 }finally{sql('alter table public.public_purchase_intents enable trigger retail_existing_funding_intent_clock_guard;');}
});
test('admin primitive checks paid-period expiry after a blocked profile lock, before first client write',opts,async()=>{
 const f=fixture('basic',3,'monthly_installments',false,false);f.proof.period.provider_period_end=Math.floor(Date.now()/1000)+2;
 // Synthetic native receipt fixture only, not proof of a provider recurrence.
 record(f);markAdminPaid(f);const before=billingState(f);
 const [holder,writer]=await Promise.all([
  parallel(`begin;select 1 from billing_customers where client_id=${lit(f.client)} for update;select pg_sleep(2.5);commit;`),
  parallel('set role service_role;select pg_sleep(0.07);'+adminCall(f))]);
 assert.equal(holder.code,0,holder.err);assert.notEqual(writer.code,0);assert.match(writer.err,/retail_admin_client_paid_period_ended/);
 assert.equal(billingState(f),before);
});
test('actual billing writer refuses a moved global owner after valid receipt and native completion',opts,()=>{
 const f=fixture();record(f);nativeComplete(f);
 sql(`update billing_customers set stripe_customer_id=null where client_id=${lit(f.client)};`);
 const before=billingState(f);denied('set role service_role;'+billingCall(f),/retail_funding_billing_/);assert.equal(billingState(f),before);
});
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
test(`actual native billing ${plan}/${months}/${payment}/role:${role}`,opts,()=>{
 const f=fixture(plan,months,payment,role);record(f);nativeComplete(f);
 const applied=nativeBilling(f);assert.equal(applied.status,'applied');assert.equal(nativeBilling(f).status,'already_applied');
 const state=JSON.parse(billingState(f)),p=state.plan,c=state.client;
 assert.equal(c.stripe_customer_id,f.proof.period.customer_id);assert.equal(c.stripe_subscription_id,f.proof.period.subscription_id);
 assert.equal(Date.parse(c.contract_start_at),Date.parse(f.proof.period.paid_at));
 assert.equal(Date.parse(c.contract_end_at),Date.parse(anchoredMonthInstant(f.proof.period.paid_at,months)));
 for(const field of ['platform_fee','per_role_fee','included_interviews_per_role','additional_interview_fee','max_interview_minutes'])assert.equal(p[field],f.pkg[field]);
 for(const field of ['scored_question_count','billing_model'])assert.equal(p[field],f.pkg.membership_terms[field]);
 if(plan==='pro')assert.equal(p.rollover_days,90);
 assert.equal((state.credits||[]).length,role?1:0);if(role){assert.equal(state.credits[0].status,'unused');assert.equal(state.credits[0].discounted_credit_amount_cents,f.pkg.first_role_prepay.discounted_credit_amount_cents);}
 assert.equal(state.intent.billing_apply_digest,applied.digest);assert.ok(state.intent.billing_applied_at);
});
test('billing receipt identity cannot be replaced by plausible caller customer or subscription parameters',opts,()=>{
 for(const patch of [{customer:'cus_CALLER_CHANGED'},{subscription:'sub_CALLER_CHANGED'}]){
  const f=fixture();record(f);nativeComplete(f);const before=billingState(f);
  denied('set role service_role;'+billingCall(f,patch),/retail_funding_billing_/);assert.equal(billingState(f),before);
 }
});
test('native billing rejects post-completion archive, parent, profile, customer and unrelated subscription changes',opts,()=>{
 for(const change of ['archive','parent','profile','customer','subscription']){
  const f=fixture();record(f);nativeComplete(f);
  if(change==='archive')sql(`update clients set archived_at=clock_timestamp() where id=${lit(f.client)};`);
  if(change==='parent'){const parent=crypto.randomUUID();sql(`insert into clients(id,name,email) values(${lit(parent)},'Synthetic Parent','parent@example.invalid');update clients set parent_client_id=${lit(parent)} where id=${lit(f.client)};`);}
  if(change==='profile')sql(`update billing_customers set stripe_customer_id=null where client_id=${lit(f.client)};`);
  if(change==='customer')sql(`update clients set stripe_customer_id='cus_CHANGED' where id=${lit(f.client)};`);
  if(change==='subscription')sql(`update clients set stripe_subscription_id='sub_CHANGED' where id=${lit(f.client)};`);
  const before=billingState(f);denied('set role service_role;'+billingCall(f),/retail_funding_billing_/);assert.equal(billingState(f),before);
 }
});
test('billing receipt replay after consumed credit is a true no-op; lost ACK cannot duplicate credit',opts,()=>{
 const f=fixture('pro',6,'prepaid',true);record(f);nativeComplete(f);const first=nativeBilling(f);
 const role=crypto.randomUUID();sql(`insert into roles(id,client_id,title,slug_or_token) values(${lit(role)},${lit(f.client)},'Synthetic Consumed Credit',${lit('synthetic-'+role)});
  update client_role_credits set status='used',used_at=clock_timestamp(),used_by_role_id=${lit(role)} where source_client_id=${lit(f.client)};
  update client_plan_settings set platform_fee=123 where client_id=${lit(f.client)};`);
 const before=billingState(f),replay=nativeBilling(f);assert.equal(replay.status,'already_applied');assert.equal(replay.digest,first.digest);assert.equal(billingState(f),before);
 sql(`update billing_customers set stripe_customer_id=null where client_id=${lit(f.client)};`);
 const moved=billingState(f);denied('set role service_role;'+billingCall(f),/retail_funding_billing_/);assert.equal(billingState(f),moved);
});
test('historical V2 no-receipt billing remains on original writer and does not backfill evidence',opts,()=>{
 assert.equal(row(historicalBillingV2).retail_funding_receipt,null);assert.equal(nativeBilling(historicalBillingV2).status,'applied');
 const before=billingState(historicalBillingV2);assert.equal(nativeBilling(historicalBillingV2).status,'already_applied');assert.equal(billingState(historicalBillingV2),before);
 assert.equal(row(historicalBillingV2).retail_funding_receipt,null);
});
test('accepted replacement receipt does not bypass existing first-apply billing identity conflict',opts,()=>{
 const f=fixture('basic',3,'prepaid',false,true,true);record(f);nativeComplete(f);const before=billingState(f);
 denied('set role service_role;'+billingCall(f),/billing_identity_conflict/);assert.equal(billingState(f),before);
});
test('billing migration preserves exact original security/ACL/signature; unknown/reapplied source refuses',opts,()=>{
 const catalog=JSON.parse(sql("select jsonb_build_object('owner',proowner::regrole::text,'definer',prosecdef,'config',proconfig,'acl',proacl::text,'args',pronargs) from pg_proc where proname='apply_public_purchase_billing';"));
 assert.deepEqual(catalog,{owner:'postgres',definer:true,config:['search_path=""'],acl:'{postgres=X/postgres,service_role=X/postgres}',args:28});
 denied(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261014004904_retail_existing_billing_receipt_fence.sql'),'utf8'),/retail_funding_billing_prerequisite_drift/);
 assert.equal(acl(),priorAcl);
 const f=fixture();record(f);nativeComplete(f);
 for(const role of ['anon','authenticated'])denied('set role '+role+';'+billingCall(f),/permission denied/);
});
for(const target of ['client','profile','plan','credit'])
test(`billing lease expiration during ${target} lock wait aborts before first write`,opts,async()=>{
 const f=fixture('basic',3,'prepaid',target==='credit');record(f);nativeComplete(f);
 if(target==='plan')sql(`insert into client_plan_settings(client_id,plan_tier,billing_interval,platform_fee,per_role_fee,
  included_interviews_per_role,additional_interview_fee,max_interview_minutes) values(${[f.client,'basic','prepaid',f.pkg.platform_fee,f.pkg.per_role_fee,
   f.pkg.included_interviews_per_role,f.pkg.additional_interview_fee,f.pkg.max_interview_minutes].map(lit).join(',')});`);
 if(target==='credit'){const c=f.pkg.first_role_prepay;sql(`insert into client_role_credits(billing_client_id,source_client_id,source_public_purchase_intent_id,
  source_membership_agreement_id,source_stripe_checkout_session_id,credit_type,membership_key,normal_role_fee_cents,discounted_credit_amount_cents,
  discount_percent,status,metadata) values(${[f.client,f.client,f.intent,f.id,f.proof.period.checkout_session_id,'first_role_prepay','basic',c.normal_role_fee_cents,
   c.discounted_credit_amount_cents,c.discount_percent,'unused',{non_refundable:c.non_refundable,expires:c.expires}].map(lit).join(',')});`);}
 sql(`update public_purchase_intents set activation_claimed_at=clock_timestamp()-interval '299.7 seconds' where id=${lit(f.intent)};`);
 const before=billingState(f),table={client:'clients',profile:'billing_customers',plan:'client_plan_settings',credit:'client_role_credits'}[target];
 const predicate=target==='client'?`id=${lit(f.client)}`:`${target==='credit'?'source_client_id':'client_id'}=${lit(f.client)}`;
 const [holder,writer]=await Promise.all([
  parallel(`begin;select 1 from ${table} where ${predicate} for update;select pg_sleep(0.6);commit;`),
  parallel('set role service_role;select pg_sleep(0.07);'+billingCall(f))]);
 assert.equal(holder.code,0,holder.err);assert.notEqual(writer.code,0,writer.out);assert.match(writer.err,/retail_funding_billing_claim_denied/);
 assert.equal(billingState(f),before);
});
test('owner profile move cannot acquire its lock during native billing transaction',opts,async()=>{
 const f=fixture();record(f);nativeComplete(f);
 const [writer,mover]=await Promise.all([
  parallel('set role service_role;begin;'+billingCall(f)+'select pg_sleep(0.5);commit;'),
  parallel(`select pg_sleep(0.1);set lock_timeout='150ms';update billing_customers set stripe_customer_id=null where client_id=${lit(f.client)};`)]);
 assert.equal(writer.code,0,writer.err);assert.notEqual(mover.code,0);assert.match(mover.err,/lock timeout/);
 assert.equal(nativeBilling(f).status,'already_applied');
});
test('same digest cannot hide cleared subscription or voided agreement at billing replay boundary',opts,()=>{
 for(const change of ['subscription','void']){
  const f=fixture();record(f);nativeComplete(f);nativeBilling(f);
  if(change==='subscription')sql(`update clients set stripe_subscription_id=null where id=${lit(f.client)};`);
  if(change==='void')sql(`update membership_agreements set voided_at=clock_timestamp() where id=${lit(f.id)};`);
  const before=billingState(f);denied('set role service_role;'+billingCall(f),/retail_funding_billing_/);assert.equal(billingState(f),before);
 }
});
test('fresh retail complete/direct paid/activated writes require a prior receipt and leave all state unchanged',opts,()=>{
 const f=fixture(),a=row(f),i=sql(`select to_jsonb(i) from public_purchase_intents i where id=${lit(f.intent)};`),c=sql(`select to_jsonb(c) from clients c where id=${lit(f.client)};`);
 denied('set role service_role;'+completeCall(f),/retail_funding_receipt_required/);
 denied(`set role service_role;update membership_agreements set checkout_paid_at=${lit(f.proof.period.paid_at)} where id=${lit(f.id)};`,/retail_funding_receipt_required/);
 denied(`set role service_role;update public_purchase_intents set activated_at=${lit(f.proof.period.paid_at)} where id=${lit(f.intent)};`,/retail_funding_receipt_required/);
 assert.deepEqual(row(f),a);assert.equal(sql(`select to_jsonb(i) from public_purchase_intents i where id=${lit(f.intent)};`),i);
 assert.equal(sql(`select to_jsonb(c) from clients c where id=${lit(f.client)};`),c);
 record(f);assert.equal(nativeComplete(f).status,'completed');
});
test('native grant rechecks receipt owner and archived client after proof, not just presence of receipt',opts,()=>{
 for(const change of ['customer','profile','archive']){
  const f=fixture();record(f);
  if(change==='customer')sql(`update clients set stripe_customer_id='cus_CHANGED_AFTER_PROOF' where id=${lit(f.client)};`);
  if(change==='profile')sql(`update billing_customers set stripe_customer_id=null where client_id=${lit(f.client)};`);
  if(change==='archive')sql(`update clients set archived_at=clock_timestamp() where id=${lit(f.client)};`);
  const before=row(f),client=sql(`select to_jsonb(c) from clients c where id=${lit(f.client)};`);
  denied('set role service_role;'+completeCall(f),/retail_funding_/);
  assert.deepEqual(row(f),before);assert.equal(sql(`select to_jsonb(c) from clients c where id=${lit(f.client)};`),client);
 }
});
test('migration preserves previously paid V2 without receipt; original completion replay changes only audit timestamps',opts,()=>{
 assert.equal(sql(`select to_jsonb(a) from membership_agreements a where id=${lit(historicalV2.id)};`),historicalBefore);
 assert.equal(sql(`select to_jsonb(i) from public_purchase_intents i where id=${lit(historicalV2.intent)};`),historicalIntentBefore);
 assert.equal(row(historicalV2).retail_funding_receipt,null);nativeComplete(historicalV2);
 assert.equal(row(historicalV2).retail_funding_receipt,null);
 const beforeA=JSON.parse(historicalBefore),afterA=row(historicalV2);
 const beforeI=JSON.parse(historicalIntentBefore),afterI=JSON.parse(sql(`select to_jsonb(i) from public_purchase_intents i where id=${lit(historicalV2.intent)};`));
 for(const [before,after] of [[beforeA,afterA],[beforeI,afterI]]){
  assert.ok(Date.parse(after.updated_at)>=Date.parse(before.updated_at));
  delete before.updated_at;delete after.updated_at;assert.deepEqual(after,before);
 }
});
test('admission migration rejects reapplication without changing table ACL/RLS or existing historical row',opts,()=>{
 const before=sql(`select to_jsonb(a) from membership_agreements a where id=${lit(historicalV2.id)};`);
 denied(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261014001920_retail_existing_receipt_activation_admission.sql'),'utf8'),/retail_funding_admission_prerequisite_drift/);
 assert.equal(acl(),priorAcl);assert.equal(sql(`select to_jsonb(a) from membership_agreements a where id=${lit(historicalV2.id)};`),before);
});
test('full schema migration preserves old table ACL/RLS and cannot overwrite prior application',opts,()=>{
 assert.equal(acl(),priorAcl);denied(fs.readFileSync(migration,'utf8'),/retail_funding_schema_drift/);
 assert.equal(sql(`select to_jsonb(a)-'retail_funding_receipt' from membership_agreements a where id=${lit(legacyId)};`),legacyBefore);
 assert.equal(sql(`select retail_funding_receipt is null from membership_agreements where id=${lit(legacyId)};`),'t');
 assert.equal(sql("select bool_and(not prosecdef) from pg_proc where proname like 'retail_existing_funding%' or proname='record_retail_existing_funding';"),'t');
});
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
test(`native first funding ${plan}/${months}/${payment}/role:${role}`,opts,()=>{
 const f=fixture(plan,months,payment,role),before=row(f),client=sql(`select to_jsonb(c) from clients c where id=${lit(f.client)};`),a=record(f),b=record(f);
 assert.deepEqual(a,b);assert.deepEqual(a.proof,f.proof);assert.equal(a.version,'retail_existing_funding_v1');
 assert.equal(Date.parse(a.recorded_at)>=Date.parse(f.proof.period.paid_at),true);
 assert.deepEqual(row(f).retail_funding_receipt,a);assert.deepEqual({...row(f),retail_funding_receipt:null},before);
 assert.equal(sql(`select to_jsonb(c) from clients c where id=${lit(f.client)};`),client);
});
test('admin no-intent receipt does not fabricate intent or paid/access state',opts,()=>{
 const f=fixture('pro',6,'prepaid',true,false);assert.deepEqual(record(f).proof,f.proof);
 assert.equal(sql(`select count(*) from public_purchase_intents where agreement_id=${lit(f.id)};`),'0');assert.equal(row(f).checkout_paid_at,null);
});
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
test(`native locked retry ${plan}/${months}/${payment}/role:${role} across actual completion`,opts,()=>{
 const f=fixture(plan,months,payment,role),receipt=record(f),before=row(f),intent=sql(`select to_jsonb(i) from public_purchase_intents i where id=${lit(f.intent)};`);
 const pending=readReceipt(f);assert.equal(pending.phase,'pending');assert.deepEqual(pending.receipt,receipt);
 assert.deepEqual(row(f),before);assert.equal(sql(`select to_jsonb(i) from public_purchase_intents i where id=${lit(f.intent)};`),intent);
 nativeComplete(f);const completed=row(f),paid=readReceipt(f);assert.equal(paid.phase,'paid');assert.deepEqual(paid.receipt,receipt);
 assert.deepEqual(row(f),completed);
 assert.equal(sql(`select stripe_subscription_id is null from clients where id=${lit(f.client)};`),'t');
 assert.equal(sql(`select activated_at=checkout_paid_at from public_purchase_intents i join membership_agreements a on i.agreement_id=a.id where i.id=${lit(f.intent)};`),'t');
 sql(`set role service_role;update clients set stripe_subscription_id=${lit(f.proof.period.subscription_id)} where id=${lit(f.client)};`);
 assert.deepEqual(readReceipt(f),paid);
});
test('native admin retry reads original receipt before and after paid CAS without an invented claim',opts,()=>{
 const f=fixture('pro',6,'prepaid',true,false),receipt=record(f);assert.equal(readReceipt(f).phase,'pending');
 sql(`set role service_role;update membership_agreements set checkout_status='paid',checkout_paid_at=${lit(f.proof.period.paid_at)} where id=${lit(f.id)};`);
 const paid=readReceipt(f);assert.equal(paid.phase,'paid');assert.deepEqual(paid.receipt,receipt);
 assert.equal(sql(`select stripe_subscription_id is null from clients where id=${lit(f.client)};`),'t');
 denied('set role service_role;'+readCall(f,'FAKE_CLAIM_000000000000000000000000'),/retail_funding_admin_claim_denied/);
});
test('existing accepted replacement stays valid across linked completion-before-billing; unrelated replacement refuses',opts,()=>{
 const f=fixture('basic',3,'prepaid',false,true,true),receipt=record(f);
 assert.ok(row(f).replaces_stripe_subscription_id);assert.equal(readReceipt(f).phase,'pending');
 nativeComplete(f);const paid=readReceipt(f);assert.equal(paid.phase,'paid');assert.deepEqual(paid.receipt,receipt);
 assert.equal(sql(`select stripe_subscription_id from clients where id=${lit(f.client)};`),row(f).replaces_stripe_subscription_id);
 sql(`set role service_role;update clients set stripe_subscription_id='sub_NOT_ACCEPTED' where id=${lit(f.client)};`);
 denied('set role service_role;'+readCall(f),/retail_funding_customer_denied/);
});
test('native replay has no enrollment and browser/owner impersonation/claim/source drift is refused',opts,()=>{
 const f=fixture();denied('set role service_role;'+readCall(f),/retail_funding_receipt_unavailable/);
 assert.equal(row(f).retail_funding_receipt,null);record(f);
 for(const role of ['anon','authenticated'])denied(`set role ${role};`+readCall(f),/permission denied/);
 denied(readCall(f),/retail_funding_server_only/);
 denied('set role service_role;'+readCall(f,'WRONG_CLAIM_000000000000000000000000'),/retail_funding_claim_denied/);
 denied('set role service_role;'+readCall(f,f.key,{...f.source,customer_id:'cus_OTHER'}),/retail_funding_source_denied/);
 nativeComplete(f);sql(`set role service_role;update clients set stripe_subscription_id='sub_OTHER' where id=${lit(f.client)};`);
 denied('set role service_role;'+readCall(f),/retail_funding_customer_denied/);
});
test('native paid replay rejects expired lease, cancellation/archive and lost customer ownership',opts,()=>{
 for(const change of ['lease','cancel','archive','customer']){
  const f=fixture();record(f);nativeComplete(f);
  if(change==='lease')sql(`update public_purchase_intents set activation_claimed_at=clock_timestamp()-interval '6 minutes' where id=${lit(f.intent)};`);
  if(change==='cancel')sql(`update public_purchase_intents set canceled_at=clock_timestamp() where id=${lit(f.intent)};`);
  if(change==='archive')sql(`update clients set archived_at=clock_timestamp() where id=${lit(f.client)};`);
  if(change==='customer')sql(`update billing_customers set stripe_customer_id=null where client_id=${lit(f.client)};`);
  const before=row(f);denied('set role service_role;'+readCall(f));assert.deepEqual(row(f),before);
 }
});
test('native read migration refuses reapplication and changes no prior functions/table grants',opts,()=>{
 assert.equal(acl(),priorAcl);
 denied(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261014000816_retail_existing_funding_replay_read.sql'),'utf8'),/retail_funding_replay_schema_drift/);
 assert.equal(sql("select bool_and(not prosecdef and proconfig=array['search_path=pg_catalog','lock_timeout=10s'] and not has_function_privilege('anon',oid,'EXECUTE') and not has_function_privilege('authenticated',oid,'EXECUTE')) from pg_proc where proname='read_retail_existing_funding';"),'t');
});
test('native reader samples lease freshness after its shared intent lock wait',opts,async()=>{
 const f=fixture();record(f);nativeComplete(f);
 const [a,b]=await Promise.all([
  parallel(`begin;select id from public_purchase_intents where id=${lit(f.intent)} for update;
   update public_purchase_intents set activation_claimed_at=clock_timestamp()-interval '299.85 seconds' where id=${lit(f.intent)};
   select pg_sleep(0.3);commit;`),
  parallel('set role service_role;select pg_sleep(0.04);'+readCall(f))]);
 assert.equal(a.code,0,a.err);assert.notEqual(b.code,0);assert.match(b.err,/retail_funding_claim_denied/);
});
const checkoutTrigger=()=>sql("select jsonb_build_array(tgenabled,pg_get_triggerdef(oid),tgfoid::regprocedure::text) from pg_trigger where tgrelid='public.membership_agreements'::regclass and tgname='retail_existing_checkout_attempt_guard';");
function agedFixture(missingDeadline=false){
 const f=fixture(),now=Math.floor(Date.now()/1000),signed=now-5*86400,created=now-4*86400,paid=now-3*86400,expiry=now-2*86400;
 // Disposable-owner fixture time travel ONLY, before any funding exists. A
 // native claim/pin was actually obtained above. Restore its exact original
 // immutability trigger before calling the receipt RPC; no hosted backfill.
 const trigger=checkoutTrigger();
 try{sql(`begin;alter table membership_agreements disable trigger retail_existing_checkout_attempt_guard;
  update public_purchase_intents set expires_at=to_timestamp(${expiry}) where id=${lit(f.intent)};
  update membership_agreements set signed_at=to_timestamp(${signed}),agreement_expires_at=to_timestamp(${expiry}),
   checkout_created_at=to_timestamp(${created}) where id=${lit(f.id)};
  update membership_agreements a set checkout_attempt_source=retail_existing_checkout_material(to_jsonb(a),
   (select to_jsonb(i) from public_purchase_intents i where i.id=${lit(f.intent)}),${lit(f.proof.period.customer_id)})
   ||jsonb_build_object('config',a.checkout_attempt_source->'config') where a.id=${lit(f.id)};
  set constraints all immediate;
  ${missingDeadline?`update membership_agreements set agreement_expires_at=null where id=${lit(f.id)};`:''}
  alter table membership_agreements enable trigger retail_existing_checkout_attempt_guard;commit;`);
 }finally{assert.equal(checkoutTrigger(),trigger);}
 denied(`set role service_role;update membership_agreements set signed_at=clock_timestamp() where id=${lit(f.id)};`,/retail_checkout_attempt_immutable/);
 f.source=row(f).checkout_attempt_source;
 Object.assign(f.proof,{checkout_created:created,invoice_created:created});
 Object.assign(f.proof.period,{paid_at:new Date(paid*1000).toISOString(),provider_period_start:created,provider_period_end:created+90*86400});
 // Fresh native activation lease immediately before record (old deadlines
 // concern actual payment A, never the processing clock or lease timestamp).
 assert.equal(sql(`set role service_role;select release_public_purchase_activation(${lit(f.intent)},${lit(f.key)});`),'t');
 const claim=JSON.parse(sql(`set role service_role;select claim_public_purchase_activation(${lit(f.id)},${lit(f.key)});`));
 assert.equal(claim.status,'claimed');
 return{f,expiry,paid,trigger};
}
test('late processing stores actual paid A before expired legal deadline, without granting access',opts,()=>{
 const {f,expiry,paid,trigger}=agedFixture(),rawB=structuredClone(f.proof.period);
 const client=sql(`select to_jsonb(c) from clients c where id=${lit(f.client)};`),r=record(f);
 assert.equal(r.proof.period.paid_at,new Date(paid*1000).toISOString());
 assert.ok(Date.parse(r.recorded_at)>expiry*1000);assert.deepEqual(r.proof,f.proof);
 assert.deepEqual(r.proof.period,rawB);assert.deepEqual(record(f),r);assert.equal(checkoutTrigger(),trigger);
 assert.equal(row(f).checkout_paid_at,null);assert.equal(row(f).checkout_status,'pending_payment');
 assert.equal(sql(`select activated_at is null from public_purchase_intents where id=${lit(f.intent)};`),'t');
 assert.equal(sql(`select to_jsonb(c) from clients c where id=${lit(f.client)};`),client);
});
test('late delivery rejects equal/after deadline and absent A/deadline without a receipt',opts,()=>{
 for(const shape of ['equal','after','no_paid','no_deadline']){
  const {f,expiry,trigger}=agedFixture(shape==='no_deadline');
  f.proof.period.paid_at=shape==='no_paid'?null:new Date((shape==='after'?expiry+1:expiry)*1000).toISOString();
  const before=row(f);denied('set role service_role;'+call(f),/retail_funding_|retail_checkout_source_mismatch/);
  assert.deepEqual(row(f),before);assert.equal(row(f).retail_funding_receipt,null);assert.equal(checkoutTrigger(),trigger);
 }
});
test('fixture construction error rolls trigger disable back before any record is possible',opts,()=>{
 const f=fixture(),trigger=checkoutTrigger();
 denied(`begin;alter table membership_agreements disable trigger retail_existing_checkout_attempt_guard;
  select 1/0;commit;`,/division by zero/);
 assert.equal(checkoutTrigger(),trigger);
 denied(`set role service_role;update membership_agreements set signed_at=clock_timestamp() where id=${lit(f.id)};`,/retail_checkout_attempt_immutable/);
 assert.equal(row(f).retail_funding_receipt,null);
});
test('missing global customer uniqueness refuses receipt and restores the existing index exactly',opts,()=>{
 const f=fixture();assert.equal(sql("select pg_get_indexdef('public.billing_customers_stripe_customer_id_uniq'::regclass);"),customerIndex);
 try{sql('drop index public.billing_customers_stripe_customer_id_uniq;');
  const before=row(f),grants=acl();denied('set role service_role;'+call(f),/retail_funding_schema_drift/);
  assert.deepEqual(row(f),before);assert.equal(acl(),grants);assert.equal(row(f).retail_funding_receipt,null);
 }finally{sql(customerIndex+';');}
});
test('each missing SELECT or UPDATE lock prerequisite refuses without broadening table grants',opts,()=>{
 const f=fixture();
 for(const table of ['membership_agreements','public_purchase_intents','clients','billing_customers'])for(const privilege of ['SELECT','UPDATE']){
  const prior=acl();
  try{sql(`revoke ${privilege} on public.${table} from service_role;`);
   assert.equal(sql(`select has_table_privilege('service_role','public.${table}','${privilege}');`),'f');
   denied('set role service_role;select retail_existing_funding_schema_guard();',/retail_funding_schema_drift/);
   denied('set role service_role;'+call(f),/retail_funding_schema_drift/);
   denied('set role service_role;'+readCall(f),/retail_funding_schema_drift/);assert.equal(row(f).retail_funding_receipt,null);
  }finally{sql(`grant ${privilege} on public.${table} to service_role;`);}
  assert.equal(acl(),prior);
 }
 for(const role of ['anon','authenticated'])denied(`set role ${role};select retail_existing_funding_schema_guard();`,/permission denied/);
});
test('prerequisite migration refuses reapplication and preserves RLS and original table ACL',opts,()=>{
 denied(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261013235104_retail_existing_funding_prerequisites.sql'),'utf8'),/retail_funding_prerequisite_drift/);
 assert.equal(acl(),priorAcl);
 assert.equal(sql("select count(*) from pg_proc where proname in ('retail_existing_funding_context','record_retail_existing_funding') and not prosecdef and position('perform public.retail_existing_funding_schema_guard();' in prosrc)>0;"),'2');
 const after=JSON.parse(functionCatalog()),before=JSON.parse(priorFunctions);
 const original=fs.readFileSync(migration,'utf8');
 for(let n=0;n<after.length;n++){
  assert.deepEqual(after[n].slice(2),before[n].slice(2));
  const body=original.split('create function public.'+after[n][0]+'(')[1].split('as $$')[1].split('end $$;')[0]+'end ';
  const patched=body.replace('\nbegin\n','\nbegin\n perform public.retail_existing_funding_schema_guard();\n');
  assert.equal(after[n][1],crypto.createHash('md5').update(patched).digest('hex'));
 }
 assert.equal(sql("select current_user;"),'postgres');
 assert.equal(sql("set role service_role;select current_user;"),'service_role');
 assert.equal(sql("select jsonb_build_array(rolsuper,rolbypassrls) from pg_roles where rolname='service_role';"),'[false, true]');
 assert.equal(sql("select bool_and(grantee in ((select oid from pg_roles where rolname='service_role'),(select oid from pg_roles where rolname='postgres'))) from pg_proc p cross join lateral aclexplode(p.proacl) where proname='retail_existing_funding_schema_guard';"),'t');
});
test('malformed IDs/mode/period, clocks, cents, source, role fee and proof shapes record nothing',opts,()=>{
 for(const mutate of [p=>p.cash_cents=0,p=>p.cash_cents++,p=>p.platform_gross_cents++,p=>p.platform_discount_cents=1,
  p=>p.role_gross_cents=1,p=>p.tax_cents='0',p=>p.charge_id=null,p=>p.provider_account_id='acct_',p=>p.extra=true,
  p=>p.period.livemode='false',p=>p.period.provider_period_end=p.period.provider_period_start,p=>p.period.provider_period_start=1.5,
  p=>p.period.paid_at='2099-01-01T00:00:00.000Z',p=>p.period.paid_at='2025-01-01T00:00:00.000Z',p=>p.invoice_created--,
  p=>p.period.customer_id='cus_OTHER',p=>p.period.checkout_session_id='cs_OTHER']){
  const f=fixture(),p=structuredClone(f.proof);mutate(p);denied('set role service_role;'+call(f,p));assert.equal(row(f).retail_funding_receipt,null);
 }
 const f=fixture();denied('set role service_role;'+call(f,f.proof,{...f.source,customer_id:'cus_OTHER'}));assert.equal(row(f).retail_funding_receipt,null);
});
test('expired/lost claim and changed customer or terminal source cannot record',opts,()=>{
 for(const patch of ['expired','key','customer','superseded']){
  const f=fixture();if(patch==='expired')sql(`update public_purchase_intents set activation_claimed_at=clock_timestamp()-interval '6 minutes' where id=${lit(f.intent)};`);
  if(patch==='key')sql(`update public_purchase_intents set activation_claim_key='OTHER_SYNTHETIC_CLAIM_00000000000000000' where id=${lit(f.intent)};`);
  if(patch==='customer')sql(`update clients set stripe_customer_id='cus_OTHER' where id=${lit(f.client)};`);
  if(patch==='superseded')sql(`update membership_agreements set is_current=false where id=${lit(f.id)};`);
  denied('set role service_role;'+call(f));assert.equal(row(f).retail_funding_receipt,null);
 }
});
test('browser roles and direct first service writes cannot bypass record RPC; receipt cannot edit/delete',opts,()=>{
 const f=fixture();for(const role of ['anon','authenticated'])denied(`set role ${role};`+call(f),/permission denied/);
 denied(`set role service_role;update membership_agreements set retail_funding_receipt=${lit({version:'retail_existing_funding_v1',proof:f.proof,recorded_at:null})} where id=${lit(f.id)};`);
 record(f);for(const patch of ['null',"retail_funding_receipt||'{\"extra\":1}'::jsonb"])
  denied(`set role service_role;update membership_agreements set retail_funding_receipt=${patch} where id=${lit(f.id)};`);
 denied(`set role service_role;delete from membership_agreements where id=${lit(f.id)};`,/retail_checkout_attempt_immutable/);
 const p=structuredClone(f.proof);p.period.provider_period_end++;
 denied('set role service_role;'+call(f,p),/receipt_conflict/);
});
test('later agreement and linked activated clocks must be original A, and cannot be cleared or moved',opts,()=>{
 const f=fixture();record(f);denied(`set role service_role;update membership_agreements set checkout_paid_at='2099-01-01Z' where id=${lit(f.id)};`);
 denied(`set role service_role;update public_purchase_intents set activated_at='2099-01-01Z' where id=${lit(f.intent)};`);
 // Inconsistent standalone timestamp-only bookkeeping now refuses; use the
 // actual existing completion's paired paid status/clock transition as the
 // positive case, retaining every original wrong/clear-clock refusal.
 denied(`set role service_role;update membership_agreements set checkout_paid_at=${lit(f.proof.period.paid_at)} where id=${lit(f.id)};`,/retail_funding_admission_paid_status_required/);
 nativeComplete(f);
 denied(`set role service_role;update membership_agreements set checkout_paid_at=null where id=${lit(f.id)};`);
 denied(`set role service_role;update public_purchase_intents set activated_at=null where id=${lit(f.intent)};`);
});
function parallel(q){return new Promise((resolve,reject)=>{const c=cp.spawn('/opt/homebrew/opt/postgresql@17/bin/psql',['-X','-q','-At','-v','ON_ERROR_STOP=1','-c',q]);let out='',err='';
 c.stdout.on('data',v=>out+=v);c.stderr.on('data',v=>err+=v);c.once('error',reject);c.once('close',code=>resolve({code,out,err}));});}
test('concurrent same proof writers serialize to one identical immutable receipt',opts,async()=>{
 const f=fixture(),[a,b]=await Promise.all([parallel('set role service_role;begin;'+call(f)+'select pg_sleep(0.1);commit;'),parallel('set role service_role;'+call(f))]);
 assert.equal(a.code,0,a.err);assert.equal(b.code,0,b.err);
 const parse=r=>JSON.parse(r.out.split('\n').find(s=>s.startsWith('{')));assert.deepEqual(parse(a),parse(b));assert.deepEqual(row(f).retail_funding_receipt,parse(a));
});
test('claim expiring while waiting for intent lock is rejected using post-lock native time',opts,async()=>{
 const f=fixture(),[a,b]=await Promise.all([
  parallel(`begin;select id from public_purchase_intents where id=${lit(f.intent)} for update;
   update public_purchase_intents set activation_claimed_at=clock_timestamp()-interval '299.85 seconds' where id=${lit(f.intent)};
   select pg_sleep(0.3);commit;`),
  parallel('set role service_role;select pg_sleep(0.04);'+call(f))]);
 assert.equal(a.code,0,a.err);assert.notEqual(b.code,0);assert.match(b.err,/retail_funding_claim_denied/);assert.equal(row(f).retail_funding_receipt,null);
});
test('prepaid cadence amendment preserves annual/monthly legacy values and refuses unknown schema',opts,()=>{
 const name='public_purchase_intents_billing_check',def=sql(`select pg_get_constraintdef(oid) from pg_constraint where conrelid='public_purchase_intents'::regclass and conname='${name}';`);
 assert.match(def,/'monthly'.*'annual'.*'prepaid'/);assert.equal(acl(),priorAcl);
 denied(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261013232342_retail_existing_purchase_intent_prepaid.sql'),'utf8'),/retail_intent_cadence_constraint_drift/);
});
async function sdkNativeBridge(loseAck=false){
 const http=require('node:http'),Stripe=require('stripe'),{fixture:fundingFixture}=require('./fixtures/existing-retail-funding-fixture');
 const f=fixture('basic',3,'monthly_installments',true),v=fundingFixture('basic',3,'monthly_installments',true),p=f.proof,requests=[],writes=[],reads=[];
 let receiptExists=false;
 const nativeDb={from(table){assert.ok(['membership_agreements','public_purchase_intents','clients','billing_customers'].includes(table));const filters=[];
  const query={select(){return query;},eq(k,val){assert.match(k,/^[a-z_]+$/);filters.push(`${k}=${lit(val)}`);return query;},
   async maybeSingle(){const r=read();assert.ok(r.data.length<=1);return{...r,data:r.data[0]||null};},then(resolve,reject){return Promise.resolve().then(read).then(resolve,reject);}};
  function read(){const data=JSON.parse(sql(`set role service_role;select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.${table} t${filters.length?' where '+filters.join(' and '):''};`));
   return{data,count:data.length,error:null};}return query;},
  async rpc(name,a){if(name==='read_retail_existing_funding'){
    reads.push(structuredClone(a));return{data:JSON.parse(sql('set role service_role;select read_retail_existing_funding('+[a.p_agreement,a.p_client,a.p_claim,a.p_source].map(lit).join(',')+');')),error:null};
   }
   assert.equal(name,'record_retail_existing_funding');writes.push(structuredClone(a));
   const data=JSON.parse(sql('set role service_role;'+`select record_retail_existing_funding(${[a.p_agreement,a.p_client,a.p_claim,a.p_source,a.p_proof].map(lit).join(',')});`));
   if(loseAck)throw Error('Simulated native commit then lost ACK');return{data,error:null};}};
 Object.assign(v.cs,{id:p.period.checkout_session_id,customer:p.period.customer_id,subscription:p.period.subscription_id,invoice:p.period.invoice_id,created:p.checkout_created});
 Object.assign(v.s,{id:p.period.subscription_id,customer:p.period.customer_id});
 Object.assign(v.s.items.data[0],{id:p.period.subscription_item_id,subscription:p.period.subscription_id});
 // The original authored fixture shares the same Price across Session/line/item.
 v.il[0].price.id=p.period.price_id;
 Object.assign(v.il[0],{id:p.period.platform_invoice_line_id,subscription:p.period.subscription_id,subscription_item:p.period.subscription_item_id,
  period:{start:p.period.provider_period_start,end:p.period.provider_period_end}});
 v.il[1].subscription=p.period.subscription_id;
 Object.assign(v.inv,{id:p.period.invoice_id,customer:p.period.customer_id,subscription:p.period.subscription_id,created:p.invoice_created,
  status_transitions:{paid_at:Date.parse(p.period.paid_at)/1000},payment_intent:p.payment_intent_id,charge:p.charge_id});
 Object.assign(v.pi,{id:p.payment_intent_id,customer:p.period.customer_id,invoice:p.period.invoice_id,latest_charge:p.charge_id});
 Object.assign(v.ch,{id:p.charge_id,customer:p.period.customer_id,invoice:p.period.invoice_id,payment_intent:p.payment_intent_id});
 const server=http.createServer((req,res)=>{requests.push({method:req.method,path:req.url,version:req.headers['stripe-version']});
  const url=new URL(req.url,'http://localhost');let body;
  if(url.pathname==='/v1/account')body={object:'account',id:p.provider_account_id};
  else if(url.pathname===`/v1/checkout/sessions/${v.cs.id}`)body=v.cs;
  else if(url.pathname===`/v1/checkout/sessions/${v.cs.id}/line_items`)body={object:'list',has_more:false,data:v.cl};
  else if(url.pathname===`/v1/subscriptions/${v.s.id}`)body=v.s;
  else if(url.pathname==='/v1/subscription_items')body=v.s.items;
  else if(url.pathname===`/v1/invoices/${v.inv.id}`)body=v.inv;
  else if(url.pathname===`/v1/invoices/${v.inv.id}/lines`)body={object:'list',has_more:false,data:v.il};
  else if(url.pathname===`/v1/payment_intents/${v.pi.id}`)body=v.pi;
  else if(url.pathname===`/v1/charges/${v.ch.id}`)body=v.ch;
  else{res.statusCode=400;body={error:{message:'Unexpected synthetic request'}};}
  if(receiptExists&&!['/v1/account',`/v1/checkout/sessions/${v.cs.id}`,`/v1/subscriptions/${v.s.id}`].includes(url.pathname)){
   res.statusCode=400;body={error:{message:'Historical money reproof forbidden on receipt replay'}};
  }
  res.setHeader('content-type','application/json');res.end(JSON.stringify(body));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 try{
  const stripe=new Stripe('sk_test_SYNTHETIC_NO_PROVIDER',{apiVersion:'2023-10-16',host:'127.0.0.1',port:server.address().port,protocol:'http',maxNetworkRetries:0});
  const {recordExistingRetailFunding}=require('../src/services/existingRetailFundingReceipt');
  const recordOptions={db:nativeDb,stripe,agreementId:f.id,intentId:f.intent,eventSessionId:v.cs.id,eventLivemode:false,claimKey:f.key};
  if(loseAck)await assert.rejects(recordExistingRetailFunding(recordOptions),{code:'retail_funding_receipt_ack_unknown'});
  else{const r=await recordExistingRetailFunding(recordOptions);assert.deepEqual(JSON.parse(JSON.stringify(r.receipt)),row(f).retail_funding_receipt);}
  assert.equal(writes.length,1);assert.deepEqual(row(f).retail_funding_receipt.proof,p);assert.equal(row(f).checkout_paid_at,null);
  assert.equal(requests.length,9);assert.ok(requests.every(x=>x.method==='GET'&&x.version==='2023-10-16'));
  receiptExists=true;Object.assign(v.ch,{refunded:true,amount_refunded:v.ch.amount});v.s.latest_invoice='in_LATER';v.s.current_period_end+=90000;
  const {readExistingRetailFundingReceipt}=require('../src/services/existingRetailFundingReplay');
  const options={db:nativeDb,stripe,agreementId:f.id,intentId:f.intent,eventSessionId:v.cs.id,eventLivemode:false,claimKey:f.key};
  const pending=await readExistingRetailFundingReceipt(options);assert.equal(pending.funding.replay,false);
  assert.deepEqual(JSON.parse(JSON.stringify(pending.receipt)),row(f).retail_funding_receipt);
  nativeComplete(f);const paid=await readExistingRetailFundingReceipt({...options,eventInvoiceId:'in_LATER'});assert.equal(paid.funding.replay,true);
  assert.equal(paid.funding.paidAt,p.period.paid_at);assert.deepEqual(JSON.parse(JSON.stringify(paid.funding.initialProviderPeriod)),p.period);
  assert.equal(writes.length,1);assert.equal(reads.length,4);assert.equal(requests.length,15);
  assert.ok(requests.every(x=>x.method==='GET'&&x.version==='2023-10-16'));
  assert.ok(requests.slice(9).every(x=>['/v1/account',`/v1/checkout/sessions/${v.cs.id}`,`/v1/subscriptions/${v.s.id}`].includes(x.path)));
 }finally{await new Promise(resolve=>server.close(resolve));}
}
test('real SDK16/API2023 loopback feeds actual native RPC and fresh DB ACK/readback with no provider writes',opts,()=>sdkNativeBridge());
test('real SDK/native commit with lost ACK and subsequent refund replays original receipt without historical money calls',opts,()=>sdkNativeBridge(true));

// Real installed current SDK GET -> real native admin CLIENT-write seam. The
// initial receipt/CAS here are actual previously-tested native synthetic paths,
// not a live provider money claim. No historical money reproof on this retry.
async function adminSdkBridge(plan='basic',months=3,payment='prepaid',role=false,fullBilling=false,initialPaid=true,linkedSource=null){
 const http=require('node:http'),Stripe=require('stripe');
 const f=fixture(plan,months,payment,role,Boolean(linkedSource),false,'admin',linkedSource||'sales_assisted');record(f);
 if(linkedSource)nativeComplete(f);else{if(initialPaid)markAdminPaid(f);adminInitial(f);}
 const p=f.proof,requests=[],writes=[],reads=[],memberCalls=[],contextCalls=[];
 const current={object:'subscription',id:p.period.subscription_id,customer:p.period.customer_id,currency:'usd',livemode:false,
  status:'active',current_period_end:p.period.provider_period_end,start_date:p.period.provider_period_start,
  cancel_at_period_end:false,cancel_at:null,pause_collection:null};
 const checkout={object:'checkout.session',id:p.period.checkout_session_id,customer:p.period.customer_id,
  subscription:p.period.subscription_id,invoice:p.period.invoice_id,currency:'usd',livemode:false,mode:'subscription',status:'complete',payment_status:'paid'};
 const hooks={};
 const db={from(table){assert.ok(['membership_agreements','public_purchase_intents','clients','billing_customers','client_members'].includes(table));
  let patch=null;
  const filters=[],query={select(){return query;},eq(k,val){assert.match(k,/^[a-z_]+$/);filters.push(`${k}=${lit(val)}`);return query;},
   is(k,val){assert.match(k,/^[a-z_]+$/);filters.push(`${k} is ${lit(val)}`);return query;},order(){return query;},limit(){return query;},
   update(v){assert.equal(table,'membership_agreements','New native path must not write old client/settings/member rows');
    assert.ok(Object.keys(v).every(k=>['checkout_status','checkout_paid_at'].includes(k)));patch=v;return query;},
   async maybeSingle(){const r=read();assert.ok(r.data.length<=1);return{...r,data:r.data[0]||null};},then(resolve,reject){return Promise.resolve().then(read).then(resolve,reject);}};
  function read(){const where=filters.length?' where '+filters.join(' and '):'';
   const statement=patch?`with changed as(update public.${table} set ${Object.entries(patch).map(([k,v])=>k+'='+lit(v)).join(',')}${where} returning *) select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from changed t;`
    :`select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.${table} t${where};`;
   const data=JSON.parse(sql('set role service_role;'+statement));
   return{data:hooks.afterRows?hooks.afterRows(table,data):data,count:data.length,error:null};}return query;},
  async rpc(name,a){let q;
   if(name==='retail_admin_existing_member_context'){
    contextCalls.push(structuredClone(a));
    q='select to_jsonb(retail_admin_existing_member_context('+[a.p_agreement,a.p_source,a.p_receipt,a.p_current].map(lit).join(',')+'));';
   }else if(name==='ensure_retail_existing_admin_buyer_member'){
    memberCalls.push(structuredClone(a));
    await hooks.beforeMember?.(a);
    q='select ensure_retail_existing_admin_buyer_member('+[a.p_agreement,a.p_source,a.p_receipt,a.p_current,a.p_user,a.p_name].map(lit).join(',')+');';
   }else if(name==='read_retail_existing_funding'){
    reads.push(structuredClone(a));q='select read_retail_existing_funding('+[a.p_agreement,a.p_client,a.p_claim,a.p_source].map(lit).join(',')+');';
   }else if(name==='apply_public_purchase_billing'){
    assert.ok(linkedSource,'Original admin tests cannot call linked billing');
    const keys=['p_intent_id','p_claim_key','p_client_id','p_billing_client_id','p_stripe_customer_id','p_stripe_subscription_id',
     'p_subscription_status','p_billing_status','p_billing_interval','p_plan_tier','p_current_term_end','p_cancel_at_term_end',
     'p_auto_renew','p_cancel_effective_at','p_contract_start_at','p_contract_end_at','p_platform_fee','p_per_role_fee',
     'p_included_interviews_per_role','p_additional_interview_fee','p_max_interview_minutes','p_credit_selected','p_credit_type',
     'p_credit_normal_role_fee_cents','p_credit_discounted_amount_cents','p_credit_discount_percent','p_credit_non_refundable','p_credit_expires'];
    assert.deepEqual(Object.keys(a).sort(),[...keys].sort());writes.push(structuredClone(a));await hooks.beforeApply?.(a);
    q='select apply_public_purchase_billing('+keys.map(k=>lit(a[k])).join(',')+');';
   }else{
    assert.equal(name,fullBilling?'apply_retail_existing_admin_billing':'apply_retail_existing_admin_client');writes.push(structuredClone(a));
    await hooks.beforeApply?.(a);
    q='select '+name+'('+[a.p_agreement,a.p_client,a.p_source,a.p_funding,a.p_initial,a.p_subscription].map(lit).join(',')+');';
   }
   const r=run('set role service_role;'+q);
   if(r.status!==0)return{data:null,error:{message:(r.stderr.match(/ERROR:\s+([^\n]+)/)||[])[1]||'native synthetic error'}};
   const data=JSON.parse(r.stdout.trim());
   if(name==='retail_admin_existing_member_context')return hooks.afterContext?await hooks.afterContext(data):{data,error:null};
   if(name==='ensure_retail_existing_admin_buyer_member')return hooks.afterMember?await hooks.afterMember(data):{data,error:null};
   if(name==='apply_retail_existing_admin_client'||name==='apply_retail_existing_admin_billing'||name==='apply_public_purchase_billing')return hooks.afterApply?await hooks.afterApply(data,writes.length):{data,error:null};
   return hooks.afterRead?await hooks.afterRead(data,reads.length):{data,error:null};}};
 const server=http.createServer((req,res)=>{requests.push({method:req.method,path:req.url,version:req.headers['stripe-version']});let body;
  if(req.method==='GET'&&req.url==='/v1/account')body={object:'account',id:p.provider_account_id};
  else if(req.method==='GET'&&req.url===`/v1/checkout/sessions/${checkout.id}`)body=checkout;
  else if(req.method==='GET'&&req.url===`/v1/subscriptions/${current.id}`)body=current;
  else{res.statusCode=400;body={error:{message:'Unexpected request; native admin retry is GET-only'}};}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(body));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const stripe=new Stripe('sk_test_SYNTHETIC_NO_PROVIDER',{apiVersion:'2023-10-16',host:'127.0.0.1',port:server.address().port,protocol:'http',maxNetworkRetries:0});
 const applyAdapter=linkedSource?require('../src/services/existingRetailLinkedBillingAdapter').applyExistingRetailLinkedBilling:fullBilling?require('../src/services/existingRetailAdminBillingAdapter').applyExistingRetailAdminBilling
  :require('../src/services/existingRetailAdminClientAdapter').applyExistingRetailAdminClient;
 const options={db,stripe,agreementId:f.id,eventSessionId:checkout.id,eventLivemode:false,...(linkedSource?{claimKey:f.key,intentId:f.intent}:{})};
 return{f,current,checkout,hooks,db,requests,writes,reads,memberCalls,contextCalls,options,
  apply:patch=>applyAdapter({...options,...patch}),close:()=>new Promise(resolve=>server.close(resolve))};
}
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
test(`admin current SDK -> native client ACK/readback ${plan}/${months}/${payment}/role:${role}`,opts,async()=>{
 const b=await adminSdkBridge(plan,months,payment,role);
 try{
  const before=row(b.f),result=await b.apply();assert.equal(result.status,'applied');assert.equal(result.client_update_applied,true);
  assert.equal(result.billing_completion_required,true);assert.equal(result.membership_activation_required,true);assert.equal(result.credits_spendable,false);
  assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.clientInitial)&&Object.isFrozen(result.funding));
  assert.deepEqual(result.clientInitial,adminInitial(b.f));assert.deepEqual(row(b.f),before);
  const state=billingState(b.f);assert.equal((await b.apply()).status,'already_applied');assert.equal(billingState(b.f),state);
  const data=JSON.parse(state);assert.equal(data.plan,null);assert.equal(data.credits,null);assert.equal(data.intent,null);
  assert.equal(b.requests.length,8);assert.equal(b.writes.length,2);assert.equal(b.reads.length,6);
  assert.ok(b.requests.every(r=>r.method==='GET'&&r.version==='2023-10-16'));
 }finally{await b.close();}
});
test('admin SDK seam rejects canceled/trialing/pastdue/cancel/pause/current period mismatch without native client writes',opts,async()=>{
 for(const patch of [{status:'canceled'},{status:'trialing'},{status:'past_due'},{cancel_at_period_end:true},{cancel_at:2000000000},
  {pause_collection:{behavior:'keep_as_draft'}},{current_period_end:1},{current_period_end:Date.now()},
  {current_period_end:2000000000.5},{customer:'cus_OTHER'},{current_period_end:undefined}]){
  const b=await adminSdkBridge();try{
   Object.assign(b.current,patch);const before=billingState(b.f);
   await assert.rejects(b.apply(),e=>/^retail_admin_adapter_/.test(e.code));assert.equal(b.writes.length,0);assert.equal(billingState(b.f),before);
  }finally{await b.close();}
 }
 const b=await adminSdkBridge();try{
  b.current.current_period_end+=1;await assert.rejects(b.apply(),{code:'retail_admin_adapter_subscription_unknown'});assert.equal(b.writes.length,0);
 }finally{await b.close();}
});
test('admin SDK seam refuses unpaid pinned Checkout and mismatched event session before native client write',opts,async()=>{
 const b=await adminSdkBridge();try{
  b.checkout.payment_status='unpaid';const before=billingState(b.f);
  await assert.rejects(b.apply(),{code:'retail_admin_adapter_checkout_unknown'});assert.equal(b.writes.length,0);assert.equal(billingState(b.f),before);
  b.checkout.payment_status='paid';await assert.rejects(b.apply({eventSessionId:'cs_OTHER'}),{code:'retail_admin_adapter_unknown'});assert.equal(b.writes.length,0);
 }finally{await b.close();}
});
test('admin SDK seam requires exact pinned invoice identity before client RPC',opts,async()=>{
 for(const invoice of [null,'','in_OTHER']){
  const b=await adminSdkBridge();try{
   b.checkout.invoice=invoice;const before=billingState(b.f);
   await assert.rejects(b.apply(),e=>/^retail_admin_adapter_/.test(e.code));assert.equal(b.writes.length,0);assert.equal(billingState(b.f),before);
  }finally{await b.close();}
 }
});
test('admin SDK seam catches pre-RPC persisted session read transport drift without entering native client writer',opts,async()=>{
 const b=await adminSdkBridge();try{
  // Fault injection of the final pre-write DB response, NOT SQL success/money
  // proof or a claim this transport corruption exists in a hosted database.
  let drifted=false;
  b.hooks.afterRows=(table,data)=>{
   if(table==='membership_agreements'&&b.requests.length===4&&!drifted){drifted=true;return data.map(a=>({...a,checkout_session_id:'cs_OTHER'}));}
   return data;
  };
  const before=billingState(b.f);await assert.rejects(b.apply(),{code:'retail_admin_adapter_source_unknown'});
  assert.equal(drifted,true);assert.equal(b.writes.length,0);assert.equal(billingState(b.f),before);
 }finally{await b.close();}
});
test('admin SDK seam preserves native commit on lost/unknown ACK, then exact no-op resumes without plan or credit claims',opts,async()=>{
 for(const bad of ['lost','extra','wrong','empty']){
  const b=await adminSdkBridge('pro',6,'prepaid',true);try{
   b.hooks.afterApply=async data=>{if(bad==='lost')throw Error('synthetic lost ACK with private provider details');
    return{data:bad==='extra'?{...data,unexpected:true}:bad==='wrong'?{...data,client_initial:{...data.client_initial,plan_tier:'basic'}}:null,error:null};};
   await assert.rejects(b.apply(),e=>/^retail_admin_adapter_/.test(e.code)&&!e.message.includes('private'));
   const committed=billingState(b.f);assert.equal(JSON.parse(committed).client.stripe_subscription_id,b.f.proof.period.subscription_id);
   delete b.hooks.afterApply;assert.equal((await b.apply()).status,'already_applied');assert.equal(billingState(b.f),committed);
   assert.equal(JSON.parse(committed).plan,null);assert.equal(JSON.parse(committed).credits,null);
  }finally{await b.close();}
 }
});
test('admin SDK seam rechecks native owner/client after write and rejects unknown receipt read ACK',opts,async()=>{
 for(const mode of ['archive','preference','extra-read']){
  const b=await adminSdkBridge();try{
   if(mode==='extra-read')b.hooks.afterRead=async(data,count)=>({data:count===3?{...data,unexpected:true}:data,error:null});
   else b.hooks.afterApply=async data=>{sql(`set role service_role;update clients set ${mode==='archive'?"archived_at=clock_timestamp()":'auto_renew=false'} where id=${lit(b.f.client)};`);return{data,error:null};};
   await assert.rejects(b.apply(),e=>/^retail_admin_adapter_/.test(e.code));assert.equal(b.writes.length,1);
   assert.equal(JSON.parse(billingState(b.f)).plan,null);
  }finally{await b.close();}
 }
});
test('admin SDK seam native owner/source mismatch before client update leaves original tuple untouched',opts,async()=>{
 const b=await adminSdkBridge();try{
  b.hooks.beforeApply=async()=>sql(`set role service_role;update clients set archived_at=clock_timestamp() where id=${lit(b.f.client)};`);
  await assert.rejects(b.apply(),e=>e.code==='retail_admin_adapter_conflict'&&e.status===409&&e.permanentFailure===true);
  assert.equal(JSON.parse(billingState(b.f)).client.contract_start_at,null);
 }finally{await b.close();}
});
test('admin SDK seam known native preference conflict is terminal manual review, not a retryable lost ACK',opts,async()=>{
 const b=await adminSdkBridge();try{
  await b.apply();sql(`set role service_role;update clients set auto_renew=false where id=${lit(b.f.client)};`);
  const before=billingState(b.f);await assert.rejects(b.apply(),e=>e.code==='retail_admin_adapter_conflict'&&e.status===409&&e.permanentFailure===true);
  assert.equal(billingState(b.f),before);
 }finally{await b.close();}
});
test('admin SDK seam out-of-cohort is null without SDK or writes; pending paid CAS refuses and fencing propagates',opts,async()=>{
 const b=await adminSdkBridge();try{
  const linked=fixture();record(linked);
  for(const agreementId of [linked.id,historicalV2.id,legacyId,crypto.randomUUID()])assert.equal(await b.apply({agreementId}),null);
  assert.equal(b.requests.length,0);assert.equal(b.writes.length,0);
  const pending=fixture('basic',3,'prepaid',false,false);record(pending);
  await assert.rejects(b.apply({agreementId:pending.id}),{code:'retail_admin_adapter_source_unknown'});assert.equal(b.requests.length,0);
  const sentinel=Object.assign(Error('guard lost'),{code:'public_purchase_activation_guard_lost'});
  await assert.rejects(b.apply({assertFence:async()=>{throw sentinel;}}),e=>e===sentinel);assert.equal(b.requests.length,0);
 }finally{await b.close();}
});
test('admin SDK seam expiry is terminal before write or after a committed client tuple, never reported as rollback',opts,async()=>{
 for(const when of ['before','after']){
  const b=await adminSdkBridge(),now=Date.now;
  try{
   const future=()=>b.f.proof.period.provider_period_end*1000+1000;
   if(when==='before')Date.now=future;
   else b.hooks.afterApply=async data=>{Date.now=future;return{data,error:null};};
   await assert.rejects(b.apply(),e=>e.code==='retail_admin_adapter_period_ended'&&e.status===410&&e.permanentFailure===true);
   assert.equal(b.writes.length,when==='before'?0:1);
   assert.equal(JSON.parse(billingState(b.f)).client.contract_start_at!==null,when==='after');
  }finally{Date.now=now;await b.close();}
 }
});
test('admin client SDK adapter remains absent from mounted application imports',()=>{
 const root=path.resolve(__dirname,'../src');
 function scan(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,entry.name);if(entry.isDirectory())scan(file);
  else if(file.endsWith('.js')&&!file.endsWith('/existingRetailAdminClientAdapter.js'))assert.ok(!fs.readFileSync(file,'utf8').includes('existingRetailAdminClientAdapter'),file);
 }}scan(root);
});

function adminOnceCall(f,initial=adminInitial(f),source=f.source,funding=row(f).retail_funding_receipt,sub=adminSubscription(f)){
 return 'select apply_retail_existing_admin_billing('+[f.id,f.client,source,funding,initial,sub].map(lit).join(',')+');';
}
const nativeAdminOnce=f=>JSON.parse(sql('set role service_role;'+adminOnceCall(f)));
const adminOnceState=f=>sql(`select jsonb_build_object('billing',${lit(JSON.parse(billingState(f)))},
 'agreement',(select to_jsonb(a) from membership_agreements a where id=${lit(f.id)}));`);
function originalPlan(f){
 return require('../src/services/alphaScreenPackages').buildAlphaScreenPlanSettingsPayload({clientId:f.client,planKey:f.pkg.plan_key,
  billingInterval:f.pkg.billing_cadence,packageSnapshot:f.pkg});
}
function onceFixture(plan='basic',months=3,payment='prepaid',role=false){const f=fixture(plan,months,payment,role,false);record(f);markAdminPaid(f);return f;}
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
test(`admin atomic original client/settings/once credit ${plan}/${months}/${payment}/role:${role}`,opts,()=>{
 const f=onceFixture(plan,months,payment,role),initial=adminInitial(f),result=nativeAdminOnce(f),w=result.receipt;
 assert.equal(result.status,'applied');assert.deepEqual(w.client_initial,initial);assert.deepEqual(w.source,f.source);
 assert.deepEqual(w.funding_receipt,row(f).retail_funding_receipt);assert.deepEqual(w.subscription,adminSubscription(f));
 const expected=originalPlan(f);for(const key of Object.keys(expected))assert.deepEqual(w.plan_initial[key],expected[key]);
 assert.equal(w.plan_initial.rollover_days,90);assert.ok(Date.parse(w.applied_at)>=Date.parse(w.funding_receipt.recorded_at));
 const data=JSON.parse(billingState(f));for(const key of Object.keys(w.plan_initial))assert.deepEqual(data.plan[key],w.plan_initial[key]);
 assert.equal(data.intent,null);assert.equal((data.credits||[]).length,role?1:0);
 if(role){const credit=data.credits[0];assert.equal(credit.id,w.credit_id);
  for(const key of Object.keys(w.credit_initial)){
   if(['created_at','updated_at'].includes(key))assert.equal(new Date(credit[key]).toISOString(),w.credit_initial[key]);
   else assert.deepEqual(credit[key],w.credit_initial[key]);
  }
  assert.equal(w.credit_initial.status,'unused');assert.equal(w.credit_initial.metadata.source,'public_purchase_activation');
  assert.equal(w.credit_initial.discounted_credit_amount_cents,f.pkg.first_role_prepay.discounted_credit_amount_cents);
 }else{assert.equal(w.credit_id,null);assert.equal(w.credit_initial,null);}
 const before=adminOnceState(f);assert.deepEqual(nativeAdminOnce(f),{status:'already_applied',receipt:w});assert.equal(adminOnceState(f),before);
});
test('admin atomic initial settings preserve sticky model and fixed omitted rollover while keeping original Pro rollout default',opts,()=>{
 for(const plan of ['basic','pro']){
  const f=onceFixture(plan);sql(`set role service_role;insert into client_plan_settings(client_id,plan_tier,billing_interval,platform_fee,per_role_fee,
   included_interviews_per_role,additional_interview_fee,max_interview_minutes,billing_model,rollover_days,usage_interview_fee_cents)
   values(${lit(f.client)},'pro','monthly',123,699,30,30,12,'usage',37,456);`);
  const w=nativeAdminOnce(f).receipt,p=JSON.parse(billingState(f)).plan;assert.equal(w.plan_initial.billing_model,'usage');assert.equal(p.billing_model,'usage');
  assert.equal(p.usage_interview_fee_cents,456);assert.equal(p.rollover_days,plan==='pro'?90:37);
 }
});
test('admin atomic partial exact client-only tuple is not completion; settings/credit marker finish exactly once',opts,()=>{
 const f=onceFixture('pro',6,'monthly_installments',true);nativeAdmin(f);assert.equal(row(f).retail_admin_billing_receipt,null);
 assert.equal(JSON.parse(billingState(f)).plan,null);assert.equal(nativeAdminOnce(f).status,'applied');
 assert.equal(JSON.parse(billingState(f)).credits.length,1);assert.equal(nativeAdminOnce(f).status,'already_applied');
});
test('admin atomic billing replay preserves admin fee/model/renewal changes and does not replenish consumed credit',opts,()=>{
 const f=onceFixture('pro',6,'prepaid',true),w=nativeAdminOnce(f).receipt,role=crypto.randomUUID();
 sql(`set role service_role;insert into roles(id,client_id,title,slug_or_token) values(${lit(role)},${lit(f.client)},'Synthetic consumed credit role',${lit('SYNTHETIC_'+role)});
  update client_role_credits set status='used',used_at=clock_timestamp(),used_by_role_id=${lit(role)},updated_at=clock_timestamp() where id=${lit(w.credit_id)};
  update client_plan_settings set platform_fee=123,billing_model='fixed',rollover_days=37 where client_id=${lit(f.client)};
  update clients set auto_renew=false,cancel_at_term_end=true where id=${lit(f.client)};`);
 const before=adminOnceState(f);assert.equal(nativeAdminOnce(f).status,'already_applied');assert.equal(adminOnceState(f),before);
 assert.equal(JSON.parse(billingState(f)).credits[0].status,'used');
});
test('admin atomic replay does not recreate deleted mutable plan or consumed-credit ledger',opts,()=>{
 const f=onceFixture('basic',3,'prepaid',true);nativeAdminOnce(f);
 sql(`set role service_role;delete from client_plan_settings where client_id=${lit(f.client)};delete from client_role_credits where source_membership_agreement_id=${lit(f.id)};`);
 const before=adminOnceState(f);assert.equal(nativeAdminOnce(f).status,'already_applied');assert.equal(adminOnceState(f),before);
 assert.equal(JSON.parse(billingState(f)).plan,null);assert.equal(JSON.parse(billingState(f)).credits,null);
});
test('admin atomic conflicting previous client preference or credit aborts without settings or marker',opts,()=>{
 const f=onceFixture('pro',6,'prepaid',true);nativeAdmin(f);sql(`set role service_role;update clients set auto_renew=false where id=${lit(f.client)};`);
 const before=adminOnceState(f);denied('set role service_role;'+adminOnceCall(f),/retail_admin_client_existing_state_conflict/);assert.equal(adminOnceState(f),before);
});
test('admin atomic guarded receipt cannot be forged/cleared/rewritten and first-transaction mutations roll back',opts,()=>{
 const f=onceFixture('basic',3,'prepaid',true),before=adminOnceState(f);
 denied(`set role service_role;update membership_agreements set retail_admin_billing_receipt='{}' where id=${lit(f.id)};`,/retail_admin_billing_record_required/);
 assert.equal(adminOnceState(f),before);
 for(const mutation of [`update client_plan_settings set platform_fee=1 where client_id=${lit(f.client)};`,
  `update clients set auto_renew=false where id=${lit(f.client)};`,
  `delete from client_role_credits where source_membership_agreement_id=${lit(f.id)};`]){
  denied('set role service_role;begin;'+adminOnceCall(f)+mutation+'commit;',/retail_admin_billing_commit_state_denied/);assert.equal(adminOnceState(f),before);
 }
 nativeAdminOnce(f);const complete=adminOnceState(f);
 for(const value of ['null',"'{}'::jsonb"])denied(`set role service_role;update membership_agreements set retail_admin_billing_receipt=${value} where id=${lit(f.id)};`,/retail_admin_billing_immutable/);
 assert.equal(adminOnceState(f),complete);
});
test('admin atomic concurrent writers serialize to one receipt and one optional credit',opts,async()=>{
 const f=onceFixture('pro',6,'prepaid',true),q=adminOnceCall(f);
 const [a,b]=await Promise.all([parallel('set role service_role;begin;'+q+'select pg_sleep(0.1);commit;'),parallel('set role service_role;'+q)]);
 assert.equal(a.code,0,a.err);assert.equal(b.code,0,b.err);
 const states=[a,b].map(v=>JSON.parse(v.out.split('\n').find(s=>s.startsWith('{'))).status).sort();assert.deepEqual(states,['already_applied','applied']);
 assert.equal(JSON.parse(billingState(f)).credits.length,1);
});
test('admin atomic new RPC browser denied, prerequisite source drift/reapply refuses without data or ACL changes',opts,()=>{
 const f=onceFixture(),before=adminOnceState(f),m=fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261014020146_retail_existing_admin_once_billing.sql'),'utf8');
 for(const role of ['anon','authenticated'])denied('set role '+role+';'+adminOnceCall(f),/permission denied/);
 denied(m,/retail_admin_billing_schema_drift/);assert.equal(adminOnceState(f),before);assert.equal(acl(),priorAcl);
 const original=sql("select pg_get_functiondef(oid) from pg_proc where proname='apply_retail_existing_admin_client';");
 try{sql(original.replace('\nbegin\n','\nbegin\n -- synthetic drift\n'));denied('set role service_role;'+adminOnceCall(f),/retail_admin_billing_prerequisite_drift/);assert.equal(adminOnceState(f),before);}
 finally{sql(original);}
});
function seedAdminCredit(f,patch={}){
 const role=f.pkg.first_role_prepay,p={billing_client_id:f.client,source_client_id:f.client,source_public_purchase_intent_id:null,
  source_membership_agreement_id:f.id,source_stripe_checkout_session_id:f.proof.period.checkout_session_id,
  credit_type:'first_role_prepay',membership_key:f.pkg.plan_key,normal_role_fee_cents:role.normal_role_fee_cents,
  discounted_credit_amount_cents:role.discounted_credit_amount_cents||35900,discount_percent:10,status:'unused',
  metadata:{source:'public_purchase_activation',non_refundable:true,expires:false,purchase_intent_id:null,membership_agreement_id:f.id},
  created_at:f.proof.period.paid_at,updated_at:f.proof.period.paid_at,...patch};
 return sql('set role service_role;insert into client_role_credits('+Object.keys(p).join(',')+') values('+Object.values(p).map(lit).join(',')+') returning id;');
}
test('admin atomic existing original unused credit is adopted only with exact immutable provenance',opts,()=>{
 const f=onceFixture('pro',6,'monthly_installments',true),id=seedAdminCredit(f),w=nativeAdminOnce(f).receipt;
 assert.equal(w.credit_id,id);assert.equal(JSON.parse(billingState(f)).credits.length,1);
 assert.equal(nativeAdminOnce(f).status,'already_applied');
});
test('admin atomic wrong prior credit metadata/session/amount and duplicate agreement credit refuse all billing DML',opts,()=>{
 for(const mode of ['metadata','session','amount','duplicate','unselected']){
  const f=onceFixture('pro',6,'prepaid',mode!=='unselected');
  if(mode==='metadata')seedAdminCredit(f,{metadata:{non_refundable:false}});
  else if(mode==='session')seedAdminCredit(f,{source_stripe_checkout_session_id:'cs_OTHER_'+crypto.randomUUID().replaceAll('-','')});
  else if(mode==='amount')seedAdminCredit(f,{discounted_credit_amount_cents:1});
  else{seedAdminCredit(f);if(mode==='duplicate')seedAdminCredit(f,{source_stripe_checkout_session_id:'cs_OTHER_'+crypto.randomUUID().replaceAll('-','')});}
  const before=adminOnceState(f);denied('set role service_role;'+adminOnceCall(f),/retail_admin_billing_credit_conflict/);assert.equal(adminOnceState(f),before);
 }
});
test('admin atomic owner/archive/source/payload/subscription refusal writes no plan/credit or completion marker',opts,()=>{
 for(const mode of ['archive','owner','payload','source','subscription']){
  const f=onceFixture('pro',6,'prepaid',true);let q=adminOnceCall(f);
  if(mode==='archive')sql(`set role service_role;update clients set archived_at=clock_timestamp() where id=${lit(f.client)};`);
  if(mode==='owner')sql(`set role service_role;update billing_customers set stripe_customer_id=null where client_id=${lit(f.client)};`);
  if(mode==='payload')q=adminOnceCall(f,{...adminInitial(f),auto_renew:false});
  if(mode==='source')q=adminOnceCall(f,adminInitial(f),{...f.source,customer_id:'cus_OTHER'});
  if(mode==='subscription')q=adminOnceCall(f,adminInitial(f),f.source,row(f).retail_funding_receipt,{...adminSubscription(f),current_period_end:f.proof.period.provider_period_end+1});
  const before=adminOnceState(f);denied('set role service_role;'+q,/retail_admin_billing_|retail_funding_/);assert.equal(adminOnceState(f),before);
 }
});
test('admin atomic actual downstream plan/credit lock wait expires first B and rolls all billing writes back',opts,async()=>{
 for(const target of ['plan','credit']){
  const f=fixture('basic',3,'monthly_installments',target==='credit',false);f.proof.period.provider_period_end=Math.floor(Date.now()/1000)+2;
  // Synthetic original-B short native fixture, NOT a Stripe recurrence claim.
  record(f);markAdminPaid(f);
  if(target==='plan'){
   const p=originalPlan(f);delete p.billing_model;
   sql('set role service_role;insert into client_plan_settings('+Object.keys(p).join(',')+') values('+Object.values(p).map(lit).join(',')+');');
  }else seedAdminCredit(f);
  const before=adminOnceState(f),table=target==='plan'?'client_plan_settings':'client_role_credits';
  const where=target==='plan'?`client_id=${lit(f.client)}`:`source_membership_agreement_id=${lit(f.id)}`;
  const [holder,writer]=await Promise.all([parallel(`begin;select 1 from ${table} where ${where} for update;select pg_sleep(2.5);commit;`),
   parallel('set role service_role;select pg_sleep(0.07);'+adminOnceCall(f))]);
  assert.equal(holder.code,0,holder.err);assert.notEqual(writer.code,0);assert.match(writer.err,/retail_admin_client_paid_period_ended/);assert.equal(adminOnceState(f),before);
 }
});
test('admin atomic real transaction commit after B expires rolls back; historical receipt replay after expiry stays financial-only',opts,()=>{
 const f=fixture('basic',3,'monthly_installments',true,false);f.proof.period.provider_period_end=Math.floor(Date.now()/1000)+2;
 record(f);markAdminPaid(f);const before=adminOnceState(f);
 denied('set role service_role;begin;'+adminOnceCall(f)+'select pg_sleep(2.5);commit;',/retail_admin_billing_commit_state_denied/);assert.equal(adminOnceState(f),before);
 const r=fixture('basic',3,'monthly_installments',true,false);r.proof.period.provider_period_end=Math.floor(Date.now()/1000)+2;
 record(r);markAdminPaid(r);const w=nativeAdminOnce(r).receipt,applied=adminOnceState(r);sql('select pg_sleep(2.5);');
 assert.deepEqual(nativeAdminOnce(r),{status:'already_applied',receipt:w});assert.equal(adminOnceState(r),applied);
});
test('admin atomic nullable marker does not enroll accepted legacy or already-paid V2 without original receipt',opts,()=>{
 for(const f of [historicalV2,historicalBillingV2]){
  const before=row(f);denied('set role service_role;'+adminOnceCall(f),/retail_admin_billing_source_denied/);assert.deepEqual(row(f),before);
  assert.equal(row(f).retail_admin_billing_receipt,null);
 }
 assert.equal(sql(`select retail_admin_billing_receipt is null from membership_agreements where id=${lit(legacyId)};`),'t');
});
test('admin atomic every newly pinned projection/source helper drift refuses before billing DML',opts,()=>{
 const f=onceFixture('pro',6,'prepaid',true),before=adminOnceState(f);
 for(const name of ['retail_existing_package','retail_existing_valid_offer','retail_existing_month_anchor','retail_existing_closed_object',
  'retail_existing_checkout_material','retail_existing_checkout_config_valid','retail_existing_funding_schema_guard']){
  const definition=sql(`select pg_get_functiondef(oid) from pg_proc where proname=${lit(name)};`);
  const changed=definition.replace(/\nAS \$function\$\n/,'\nAS $function$\n -- disposable helper drift sentinel\n');
  assert.notEqual(changed,definition);
  try{sql(changed);denied('set role service_role;'+adminOnceCall(f),/retail_admin_billing_prerequisite_drift/);assert.equal(adminOnceState(f),before);}
  finally{sql(definition);}
 }
});
test('admin atomic missing plan/credit insert privilege or RLS refuses rather than adding grants',opts,()=>{
 const f=onceFixture('pro',6,'prepaid',true),before=adminOnceState(f);
 const old=sql("select jsonb_agg(jsonb_build_array(relname,relacl::text,relrowsecurity) order by relname) from pg_class where oid in('client_plan_settings'::regclass,'client_role_credits'::regclass);");
 for(const table of ['client_plan_settings','client_role_credits']){
  try{sql(`revoke insert on public.${table} from service_role;`);denied('set role service_role;'+adminOnceCall(f),/retail_admin_billing_schema_drift/);assert.equal(adminOnceState(f),before);}
  finally{sql(`grant insert on public.${table} to service_role;`);}
  try{sql(`alter table public.${table} disable row level security;`);denied('set role service_role;'+adminOnceCall(f),/retail_admin_billing_schema_drift/);assert.equal(adminOnceState(f),before);}
  finally{sql(`alter table public.${table} enable row level security;`);}
 }
 assert.equal(sql("select jsonb_agg(jsonb_build_array(relname,relacl::text,relrowsecurity) order by relname) from pg_class where oid in('client_plan_settings'::regclass,'client_role_credits'::regclass);"),old);
});
test('native JSONb numeric scale equivalence is exact, not an amount comparison waiver',opts,()=>{
 assert.equal(sql("select '299'::jsonb='299.00'::jsonb and to_jsonb(299::numeric(10,2))='299'::jsonb;"),'t');
});
test('admin atomic native boundary refuses unknown non-admin source despite a valid native receipt',opts,()=>{
 const f=fixture('pro',6,'prepaid',true,false,false,'unknown_source');record(f);markAdminPaid(f);
 const before=adminOnceState(f);denied('set role service_role;'+adminOnceCall(f),/retail_admin_billing_source_denied/);assert.equal(adminOnceState(f),before);
});

// Full adapter uses the installed SDK16/API2023 and actual native atomic RPC,
// never the earlier client-only adapter. No hosted/provider/Auth claim.
const fullAdminBridge=(...args)=>adminSdkBridge(...args,true);
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
test(`admin full SDK/native billing ACK/readback ${plan}/${months}/${payment}/role:${role}`,opts,async()=>{
 const b=await fullAdminBridge(plan,months,payment,role);
 try{
  const before=row(b.f),result=await b.apply();assert.equal(result.status,'applied');assert.equal(result.billing_applied,true);
  assert.equal(result.membership_activation_required,true);assert.equal(result.credits_spendable,false);
  assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.receipt)&&Object.isFrozen(result.currentProviderSubscription));
  assert.deepEqual(result.receipt,row(b.f).retail_admin_billing_receipt);assert.deepEqual(result.receipt.client_initial,adminInitial(b.f));
  assert.equal(row(b.f).checkout_paid_at,before.checkout_paid_at);assert.deepEqual(row(b.f).retail_funding_receipt,before.retail_funding_receipt);
  const data=JSON.parse(billingState(b.f));assert.equal(data.intent,null);assert.equal(data.plan.platform_fee,b.f.pkg.platform_fee);
  assert.equal((data.credits||[]).length,role?1:0);const state=adminOnceState(b.f);
  const retry=await b.apply();assert.equal(retry.status,'already_applied');assert.deepEqual(retry.receipt,result.receipt);
  assert.equal(adminOnceState(b.f),state);assert.equal(b.writes.length,4);assert.equal(b.reads.length,6);
  assert.equal(b.requests.length,8);assert.ok(b.requests.every(r=>r.method==='GET'&&r.version==='2023-10-16'));
 }finally{await b.close();}
});
test('full SDK initial billing refuses current inactive/canceled/paused/newer state without financial DML',opts,async()=>{
 for(const patch of [{status:'canceled'},{status:'trialing'},{status:'past_due'},{cancel_at_period_end:true},{cancel_at:2000000000},
  {pause_collection:{behavior:'keep_as_draft'}},{current_period_end:1},{current_period_end:2000000000.5},{current_period_end:undefined}]){
  const b=await fullAdminBridge('basic',3,'prepaid',false);try{
   Object.assign(b.current,patch);const before=adminOnceState(b.f);await assert.rejects(b.apply(),{code:'retail_admin_billing_adapter_subscription_unknown'});
   assert.equal(b.writes.length,0);assert.equal(adminOnceState(b.f),before);
  }finally{await b.close();}
 }
 const b=await fullAdminBridge('basic',3,'prepaid',false);try{
  b.current.current_period_end+=1;const before=adminOnceState(b.f);await assert.rejects(b.apply(),{code:'retail_admin_billing_adapter_subscription_unknown'});
  assert.equal(b.writes.length,0);assert.equal(adminOnceState(b.f),before);
 }finally{await b.close();}
});
test('full SDK historical replay keeps actual newer/inactive/cancel/pause subscription separate and never resets preferences/settings/used credit',opts,async()=>{
 const b=await fullAdminBridge('pro',6,'monthly_installments',true);try{
  const first=await b.apply(),w=first.receipt;
  const usedRole=crypto.randomUUID();
  sql(`set role service_role;insert into roles(id,client_id,title,slug_or_token) values(${lit(usedRole)},${lit(b.f.client)},'Synthetic full SDK credit use',${lit('SYNTHETIC_'+usedRole)});
   update clients set auto_renew=false,cancel_at_term_end=true,current_term_end=current_term_end+interval '1 month' where id=${lit(b.f.client)};
   update client_plan_settings set platform_fee=123,billing_model='usage' where client_id=${lit(b.f.client)};
   update client_role_credits set status='used',used_at=clock_timestamp(),used_by_role_id=${lit(usedRole)} where id=${lit(w.credit_id)};`);
  const state=adminOnceState(b.f);
  for(const patch of [{current_period_end:b.current.current_period_end+90000},{status:'canceled',cancel_at_period_end:true,cancel_at:2000000000},
   {status:'past_due',pause_collection:{behavior:'keep_as_draft'}}]){
   Object.assign(b.current,patch);const r=await b.apply();assert.equal(r.status,'already_applied');assert.deepEqual(r.receipt,w);
   assert.deepEqual(r.currentProviderSubscription,b.current);assert.equal(r.credits_spendable,false);assert.equal(r.membership_activation_required,true);
   assert.equal(adminOnceState(b.f),state);
  }
  sql(`set role service_role;delete from client_role_credits where id=${lit(w.credit_id)};delete from client_plan_settings where client_id=${lit(b.f.client)};`);
  const deleted=adminOnceState(b.f);assert.equal((await b.apply()).status,'already_applied');assert.equal(adminOnceState(b.f),deleted);
 }finally{await b.close();}
});
test('full SDK historical expiry verifies billing without claiming current access; first write expiry is terminal',opts,async()=>{
 const b=await fullAdminBridge('basic',3,'prepaid',false),now=Date.now;
 try{
  const first=await b.apply(),state=adminOnceState(b.f);Date.now=()=>b.current.current_period_end*1000+1000;
  const r=await b.apply();assert.equal(r.status,'already_applied');assert.deepEqual(r.receipt,first.receipt);assert.equal(adminOnceState(b.f),state);
  assert.equal(r.membership_activation_required,true);assert.equal(r.credits_spendable,false);
 }finally{Date.now=now;await b.close();}
 const p=await fullAdminBridge('basic',3,'prepaid',false);
 try{Date.now=()=>p.current.current_period_end*1000+1000;const before=adminOnceState(p.f);
  await assert.rejects(p.apply(),e=>e.code==='retail_admin_billing_adapter_period_ended'&&e.status===410&&e.permanentFailure===true);
  assert.equal(p.writes.length,0);assert.equal(adminOnceState(p.f),before);
 }finally{Date.now=now;await p.close();}
});
test('full SDK billing lost or malformed ACK preserves native commit and recovers once with no duplicate credit',opts,async()=>{
 for(const bad of ['lost','extra','empty','status','receipt','plan','credit','timestamp']){
  const b=await fullAdminBridge('pro',6,'prepaid',true);try{
   b.hooks.afterApply=async data=>{
    if(bad==='lost')throw Error('private provider details must not leak');
    const r=structuredClone(data);
    if(bad==='extra')r.extra=true;if(bad==='empty')return{data:null,error:null};if(bad==='status')r.status='unknown';
    if(bad==='receipt')r.receipt.extra=true;if(bad==='plan')r.receipt.plan_initial.platform_fee+=1;
    if(bad==='credit')r.receipt.credit_initial.metadata.expires=true;if(bad==='timestamp')r.receipt.applied_at='2099-01-01T00:00:00.000000Z';
    return{data:r,error:null};};
   await assert.rejects(b.apply(),e=>/^retail_admin_billing_adapter_/.test(e.code)&&e.status===503&&!e.message.includes('private'));
   const state=adminOnceState(b.f);assert.ok(row(b.f).retail_admin_billing_receipt);assert.equal(JSON.parse(billingState(b.f)).credits.length,1);
   delete b.hooks.afterApply;assert.equal((await b.apply()).status,'already_applied');assert.equal(adminOnceState(b.f),state);
  }finally{await b.close();}
 }
});
test('full SDK financial receipt strictness refuses tampered historical initial data before native replay',opts,async()=>{
 for(const field of ['source','subscription','client','plan','credit','id','stamp','keys']){
  const b=await fullAdminBridge('pro',6,'prepaid',true);try{
   await b.apply();b.writes.length=0;
   b.hooks.afterRows=(table,data)=>table!=='membership_agreements'?data:data.map(a=>{
    const r=structuredClone(a.retail_admin_billing_receipt);
    if(field==='source')r.source.customer_id='cus_OTHER';if(field==='subscription')r.subscription.status='canceled';
    if(field==='client')r.client_initial.auto_renew=false;if(field==='plan')r.plan_initial.rollover_days=91;
    if(field==='credit')r.credit_initial.discounted_credit_amount_cents+=1;if(field==='id')r.credit_id='wrong';
    if(field==='stamp')r.applied_at='2026-02-30T00:00:00.000001Z';if(field==='keys')r.extra=true;
    return{...a,retail_admin_billing_receipt:r};});
   const state=adminOnceState(b.f);await assert.rejects(b.apply(),{code:'retail_admin_billing_adapter_receipt_unknown'});
   assert.equal(b.writes.length,0);assert.equal(adminOnceState(b.f),state);
  }finally{await b.close();}
 }
});
test('full SDK financial receipt preserves original sticky model and omitted Basic rollover',opts,async()=>{
 for(const plan of ['basic','pro'])for(const model of ['fixed','rollover','usage']){
  const b=await fullAdminBridge(plan,3,'prepaid',false);try{
   sql(`set role service_role;insert into client_plan_settings(client_id,plan_tier,billing_interval,platform_fee,per_role_fee,
    included_interviews_per_role,additional_interview_fee,max_interview_minutes,billing_model,rollover_days,usage_interview_fee_cents)
    values(${lit(b.f.client)},${lit(plan)},'monthly',123,699,30,30,12,${lit(model)},45,456);`);
   const r=await b.apply();assert.equal(r.receipt.plan_initial.billing_model,model);assert.equal(r.receipt.plan_initial.rollover_days,plan==='pro'?90:45);
   assert.equal(JSON.parse(billingState(b.f)).plan.usage_interview_fee_cents,456);
   const state=adminOnceState(b.f);assert.equal((await b.apply()).status,'already_applied');assert.equal(adminOnceState(b.f),state);
  }finally{await b.close();}
 }
});
test('full SDK refuses unpaid Checkout or wrong invoice/session without native billing and preserves lost-fence sentinel',opts,async()=>{
 const b=await fullAdminBridge('basic',3,'prepaid',false);try{
  const before=adminOnceState(b.f);b.checkout.payment_status='unpaid';await assert.rejects(b.apply(),{code:'retail_admin_billing_adapter_checkout_unknown'});
  b.checkout.payment_status='paid';b.checkout.invoice='in_OTHER';await assert.rejects(b.apply(),e=>/^retail_/.test(e.code));
  b.checkout.invoice=b.f.proof.period.invoice_id;await assert.rejects(b.apply({eventSessionId:'cs_OTHER'}),{code:'retail_admin_billing_adapter_unknown'});
  assert.equal(b.writes.length,0);assert.equal(adminOnceState(b.f),before);
  const sentinel=Object.assign(Error('guard lost'),{code:'public_purchase_activation_guard_lost'});
  await assert.rejects(b.apply({assertFence:async()=>{throw sentinel;}}),e=>e===sentinel);
 }finally{await b.close();}
});
test('full SDK requires persisted exact marker before second native no-op and locked current owner readback',opts,async()=>{
 for(const mode of ['marker-missing','marker-extra','archive','customer','second-applied','read-extra']){
  const b=await fullAdminBridge('basic',3,'prepaid',false);try{
   b.hooks.afterApply=async(data,count)=>{
    if(count===1&&['archive','customer'].includes(mode))sql(`set role service_role;update clients set ${mode==='archive'?'archived_at=clock_timestamp()':"stripe_customer_id='cus_OTHER'"} where id=${lit(b.f.client)};`);
    return{data:count===2&&mode==='second-applied'?{...data,status:'applied'}:data,error:null};};
   b.hooks.afterRows=(table,data)=>table!=='membership_agreements'||!b.writes.length?data:data.map(a=>mode==='marker-missing'
    ?{...a,retail_admin_billing_receipt:null}:mode==='marker-extra'?{...a,retail_admin_billing_receipt:{...a.retail_admin_billing_receipt,extra:true}}:a);
   if(mode==='read-extra')b.hooks.afterRead=(data,count)=>({data:count===3?{...data,extra:true}:data,error:null});
   await assert.rejects(b.apply(),e=>/^retail_admin_billing_adapter_/.test(e.code));
   assert.equal(b.writes.length,mode==='second-applied'?2:1);assert.ok(row(b.f).retail_admin_billing_receipt);
  }finally{await b.close();}
 }
});
test('full SDK native source/owner/credit conflicts are terminal and prerequisite drift stays retryable without DML',opts,async()=>{
 for(const mode of ['archive','credit','helper']){
  const b=await fullAdminBridge('pro',3,'prepaid',false);let definition;
  try{
   b.hooks.beforeApply=()=>{
    if(mode==='archive')sql(`set role service_role;update clients set archived_at=clock_timestamp() where id=${lit(b.f.client)};`);
    if(mode==='credit')sql(`insert into client_role_credits(billing_client_id,source_client_id,source_membership_agreement_id,source_stripe_checkout_session_id,
      credit_type,membership_key,normal_role_fee_cents,discounted_credit_amount_cents,discount_percent,status)
      values(${[b.f.client,b.f.client,b.f.id,b.f.proof.period.checkout_session_id,'first_role_prepay','pro',69900,62900,10,'unused'].map(lit).join(',')});`);
    if(mode==='helper'){definition=sql("select pg_get_functiondef('retail_existing_package(jsonb)'::regprocedure);");
     sql(definition.replace(/\nAS \$function\$\n/,'\nAS $function$\n -- adapter drift\n'));}};
   await assert.rejects(b.apply(),e=>e.code===(mode==='helper'?'retail_admin_billing_adapter_ack_unknown':'retail_admin_billing_adapter_conflict')
    &&e.status===(mode==='helper'?503:409));assert.equal(row(b.f).retail_admin_billing_receipt,null);
   assert.equal(JSON.parse(billingState(b.f)).client.contract_start_at,null);
  }finally{if(definition)sql(definition);await b.close();}
 }
});
test('full SDK adapter leaves legacy/linked/non-admin/missing cohorts untouched and requires paid CAS',opts,async()=>{
 const b=await fullAdminBridge('basic',3,'prepaid',false);try{
  const linked=fixture();record(linked);const other=fixture('pro',6,'prepaid',true,false,false,'unknown_source');record(other);markAdminPaid(other);
  for(const agreementId of [legacyId,historicalV2.id,linked.id,other.id,crypto.randomUUID()])assert.equal(await b.apply({agreementId}),null);
  assert.equal(b.requests.length,0);assert.equal(b.writes.length,0);
  const pending=fixture('basic',3,'prepaid',false,false);record(pending);await assert.rejects(b.apply({agreementId:pending.id}),{code:'retail_admin_billing_adapter_source_unknown'});
  assert.equal(b.requests.length,0);assert.equal(b.writes.length,0);
 }finally{await b.close();}
});
test('full SDK completes an existing exact client-only partial tuple atomically without calling client-only SDK adapter',opts,async()=>{
 const b=await fullAdminBridge('pro',12,'monthly_installments',true);try{
  nativeAdmin(b.f);assert.equal(row(b.f).retail_admin_billing_receipt,null);assert.equal(JSON.parse(billingState(b.f)).plan,null);
  const r=await b.apply();assert.equal(r.status,'applied');assert.equal(JSON.parse(billingState(b.f)).credits.length,1);
  assert.equal(b.writes.length,2);const state=adminOnceState(b.f);assert.equal((await b.apply()).status,'already_applied');assert.equal(adminOnceState(b.f),state);
 }finally{await b.close();}
});
test('full SDK second locked financial readback catches owner loss after the ordinary client read',opts,async()=>{
 const b=await fullAdminBridge('basic',3,'prepaid',false);try{
  b.hooks.beforeApply=()=>{if(b.writes.length===2)sql(`set role service_role;update clients set archived_at=clock_timestamp() where id=${lit(b.f.client)};`);};
  await assert.rejects(b.apply(),e=>e.code==='retail_admin_billing_adapter_conflict'&&e.status===409&&e.permanentFailure===true);
  assert.equal(b.writes.length,2);assert.ok(row(b.f).retail_admin_billing_receipt);
  assert.equal(JSON.parse(billingState(b.f)).plan.platform_fee,b.f.pkg.platform_fee);
 }finally{await b.close();}
});
test('full admin billing SDK adapter is imported only by its reviewed internal member seam',()=>{
 const root=path.resolve(__dirname,'../src');function scan(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,entry.name);if(entry.isDirectory())scan(file);
  else if(file.endsWith('.js')&&!['existingRetailAdminBillingAdapter.js','existingRetailAdminMemberTail.js'].includes(path.basename(file)))assert.ok(!fs.readFileSync(file,'utf8').includes('existingRetailAdminBillingAdapter'),file);
 }}scan(root);
});

// Native membership ONLY. User IDs are authored synthetic identities; no
// hosted Auth/user/password/email operation is exercised or claimed.
function memberFixture(plan='basic',months=3,payment='prepaid',role=false){
 const f=onceFixture(plan,months,payment,role);f.w=nativeAdminOnce(f).receipt;f.user=crypto.randomUUID();return f;
}
const memberCurrent=f=>({...adminSubscription(f),cancel_at:null,pause_collection:null});
function memberCall(f,user=f.user,current=memberCurrent(f),source=f.source,receipt=f.w,name='Synthetic Buyer'){
 return 'select ensure_retail_existing_admin_buyer_member('+[f.id,source,receipt,current,user,name].map(lit).join(',')+');';
}
const nativeMember=(f,...args)=>JSON.parse(sql('set role service_role;'+memberCall(f,...args)));
const members=f=>JSON.parse(sql(`select coalesce(jsonb_agg(to_jsonb(m) order by user_id),'[]'::jsonb) from client_members m where client_id=${lit(f.client)};`));
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
test(`native original admin buyer membership ${plan}/${months}/${payment}/role:${role}`,opts,()=>{
 const f=memberFixture(plan,months,payment,role),financial=adminOnceState(f);
 assert.deepEqual(nativeMember(f),{status:'created',role:'manager'});const first=members(f);
 assert.equal(first.length,1);assert.equal(first[0].user_id,f.user);assert.equal(first[0].user_id_uuid,f.user);
 assert.equal(first[0].email,'buyer@example.invalid');assert.equal(first[0].name,'Synthetic Buyer');
 assert.deepEqual(nativeMember(f),{status:'existing',role:'manager'});assert.deepEqual(members(f),first);assert.equal(adminOnceState(f),financial);
});
test('native member preserves original privileged roles/names/emails and fills empty values without reassigning identity',opts,()=>{
 for(const role of ['manager','admin','owner','super_admin','member']){
  const f=memberFixture();sql(`insert into client_members(client_id,user_id,email,name,role) values(${lit(f.client)},${lit(f.user)},' BUYER@example.invalid ','Original Name',${lit(role)});`);
  const r=nativeMember(f),m=members(f)[0];assert.equal(r.role,role==='member'?'manager':role);assert.equal(m.name,'Original Name');assert.equal(m.email,' BUYER@example.invalid ');
  const saved=members(f);assert.equal(nativeMember(f).status,'existing');assert.deepEqual(members(f),saved);
 }
 const f=memberFixture();sql(`insert into client_members(client_id,user_id,email,name,role) values(${lit(f.client)},${lit(f.user)},null,null,'member');`);
 assert.equal(nativeMember(f).status,'updated');assert.equal(members(f)[0].email,'buyer@example.invalid');assert.equal(members(f)[0].name,'Synthetic Buyer');
});
test('native member rejects ambiguous or different user/email identity before changing existing members',opts,()=>{
 for(const mode of ['same-email-other-user','same-user-other-email','ambiguous']){
  const f=memberFixture(),other=crypto.randomUUID();
  const email=mode==='same-user-other-email'?'other@example.invalid':'buyer@example.invalid',user=mode==='same-user-other-email'?f.user:other;
  sql(`insert into client_members(client_id,user_id,email,role) values(${lit(f.client)},${lit(user)},${lit(email)},'member');`);
  if(mode==='ambiguous')sql(`insert into client_members(client_id,user_id,email,role) values(${lit(f.client)},${lit(f.user)},null,'member');`);
  const before=members(f);denied('set role service_role;'+memberCall(f),/retail_admin_member_identity_conflict/);assert.deepEqual(members(f),before);
 }
});
test('native member current nonrenewal preference allows initial paid access without rewriting preferences or consumed credit/settings',opts,()=>{
 const f=memberFixture('pro',6,'monthly_installments',true),used=crypto.randomUUID();
 sql(`insert into roles(id,client_id,title,slug_or_token) values(${lit(used)},${lit(f.client)},'Synthetic member credit use',${lit('SYNTHETIC_'+used)});
  update client_role_credits set status='used',used_at=clock_timestamp(),used_by_role_id=${lit(used)} where id=${lit(f.w.credit_id)};
  update client_plan_settings set platform_fee=17,billing_model='usage' where client_id=${lit(f.client)};
  update clients set auto_renew=false,cancel_at_term_end=true where id=${lit(f.client)};`);
 const financial=adminOnceState(f);assert.equal(nativeMember(f,f.user,{...memberCurrent(f),cancel_at_period_end:true}).status,'created');assert.equal(adminOnceState(f),financial);
});
test('native member refuses unknown/current inactive/newer/cancel/pause provider projection; marker is not current proof',opts,()=>{
 const f=memberFixture();for(const patch of [{status:'canceled'},{status:'past_due'},{status:'trialing'},{id:'sub_OTHER'},{customer:'cus_OTHER'},
  {current_period_end:f.proof.period.provider_period_end+1},{current_period_end:'2000000000'},{cancel_at_period_end:null},
  {cancel_at:f.proof.period.provider_period_end-1},{cancel_at:253402300800},{cancel_at:'later'},{cancel_at:2000000000.5},
  {pause_collection:{behavior:'keep_as_draft'}},{extra:true}]){
  denied('set role service_role;'+memberCall(f,f.user,{...memberCurrent(f),...patch}),/retail_admin_member_current_subscription_denied/);assert.deepEqual(members(f),[]);
 }
});
test('native member requires same live native first period/root owner/source/current agreement and no force-inactive override',opts,()=>{
 for(const mode of ['archive','parent','customer','subscription','profile','status','billing','period','start','end','override','superseded','voided','current']){
  const f=memberFixture();
  if(mode==='parent'){const p=crypto.randomUUID();sql(`insert into clients(id,name,email) values(${lit(p)},'Synthetic other parent','parent@example.invalid');update clients set parent_client_id=${lit(p)} where id=${lit(f.client)};`);}
  else if(mode==='profile')sql(`update billing_customers set stripe_customer_id=null where client_id=${lit(f.client)};`);
  else if(['superseded','voided','current'].includes(mode))sql(`update membership_agreements set ${mode==='superseded'?'superseded_at=clock_timestamp()':mode==='voided'?'voided_at=clock_timestamp()':'is_current=false'} where id=${lit(f.id)};`);
  else{const fields={archive:'archived_at=clock_timestamp()',customer:'stripe_customer_id='+lit('cus_OTHER_'+f.id.replaceAll('-','')),subscription:'stripe_subscription_id='+lit('sub_OTHER_'+f.id.replaceAll('-','')),
   status:"subscription_status='past_due'",billing:"billing_status='inactive'",period:"current_term_end=current_term_end+interval '1 month'",
   start:"contract_start_at=contract_start_at+interval '1 second'",end:"contract_end_at=contract_end_at+interval '1 second'",override:"access_override_mode='force_inactive'"};
   sql(`update clients set ${fields[mode]} where id=${lit(f.client)};`);}
  const before=adminOnceState(f);denied('set role service_role;'+memberCall(f),/retail_admin_member_|retail_funding_|retail_admin_billing_/);
  assert.deepEqual(members(f),[]);assert.equal(adminOnceState(f),before);
 }
});
test('native member refuses missing/altered/full receipt/source/user and partial client-only billing',opts,()=>{
 const f=memberFixture();for(const [source,receipt,user] of [[{...f.source,customer_id:'cus_OTHER'},f.w,f.user],[f.source,{...f.w,extra:true},f.user],
  [f.source,null,f.user],[f.source,f.w,null],[f.source,f.w,'00000000-0000-0000-0000-000000000000']]){
  denied('set role service_role;'+memberCall(f,user,memberCurrent(f),source,receipt),/retail_admin_member_/);assert.deepEqual(members(f),[]);
 }
 const p=onceFixture();nativeAdmin(p);p.user=crypto.randomUUID();p.w=null;
 denied('set role service_role;'+memberCall(p),/retail_admin_member_source_denied/);assert.deepEqual(members(p),[]);
});
test('native member same-client same-email DIFFERENT users serialize on root FOR UPDATE: one grant and one refusal',opts,async()=>{
 const f=memberFixture(),u2=crypto.randomUUID();
 const [a,b]=await Promise.all([parallel('set role service_role;begin;'+memberCall(f)+'select pg_sleep(0.25);commit;'),
  parallel('set role service_role;select pg_sleep(0.03);'+memberCall(f,u2))]);
 assert.equal(a.code,0,a.err);assert.notEqual(b.code,0);assert.match(b.err,/retail_admin_member_identity_conflict/);
 assert.equal(members(f).length,1);assert.equal(members(f)[0].user_id,f.user);
});
test('native member same identity concurrent calls create once then return exact existing without another grant',opts,async()=>{
 const f=memberFixture();const [a,b]=await Promise.all([parallel('set role service_role;begin;'+memberCall(f)+'select pg_sleep(0.15);commit;'),
  parallel('set role service_role;'+memberCall(f))]);assert.equal(a.code,0,a.err);assert.equal(b.code,0,b.err);
 const statuses=[a,b].map(v=>JSON.parse(v.out.split('\n').find(s=>s.startsWith('{'))).status).sort();assert.deepEqual(statuses,['created','existing']);assert.equal(members(f).length,1);
});
test('native membership differing-user concurrency actually blocks on the first transaction, not an empty candidate gap',opts,async()=>{
 const f=memberFixture(),other=crypto.randomUUID(),tag='SYNTHETIC_MEMBER_'+f.id.replaceAll('-','');
 const [holder,writer,observer]=await Promise.all([
  parallel(`set application_name=${lit(tag+'_holder')};set role service_role;begin;${memberCall(f)}select pg_sleep(1.0);commit;`),
  parallel(`set application_name=${lit(tag+'_writer')};set role service_role;select pg_sleep(0.1);${memberCall(f,other)}`),
  parallel(`select pg_sleep(0.35);select exists(select 1 from pg_stat_activity w join pg_stat_activity h
    on h.pid=any(pg_blocking_pids(w.pid)) where w.application_name=${lit(tag+'_writer')} and h.application_name=${lit(tag+'_holder')} and w.wait_event_type='Lock');`)
 ]);
 assert.equal(holder.code,0,holder.err);assert.notEqual(writer.code,0);assert.match(writer.err,/retail_admin_member_identity_conflict/);
 assert.equal(observer.code,0,observer.err);assert.equal(observer.out.trim(),'t');assert.equal(members(f).length,1);
});
test('native member fresh clock after an actual member lock wait refuses before UPDATE at original B expiry',opts,async()=>{
 const f=fixture('basic',3,'monthly_installments',false,false);f.proof.period.provider_period_end=Math.floor(Date.now()/1000)+2;
 record(f);markAdminPaid(f);f.w=nativeAdminOnce(f).receipt;f.user=crypto.randomUUID();
 sql(`insert into client_members(client_id,user_id,email,name,role) values(${lit(f.client)},${lit(f.user)},'buyer@example.invalid',null,'member');`);
 const before=members(f),financial=adminOnceState(f);
 const [holder,writer]=await Promise.all([parallel(`begin;select 1 from client_members where client_id=${lit(f.client)} and user_id=${lit(f.user)} for update;select pg_sleep(2.5);commit;`),
  parallel('set role service_role;select pg_sleep(0.07);'+memberCall(f))]);assert.equal(holder.code,0,holder.err);assert.notEqual(writer.code,0);
 assert.match(writer.err,/retail_admin_member_paid_period_ended/);assert.deepEqual(members(f),before);assert.equal(adminOnceState(f),financial);
});
test('native member delayed real COMMIT after B expiry rolls membership back, financial completion remains',opts,()=>{
 const f=fixture('basic',3,'monthly_installments',false,false);f.proof.period.provider_period_end=Math.floor(Date.now()/1000)+2;
 record(f);markAdminPaid(f);f.w=nativeAdminOnce(f).receipt;f.user=crypto.randomUUID();const financial=adminOnceState(f);
 denied('set role service_role;begin;'+memberCall(f)+'select pg_sleep(2.5);commit;',/retail_admin_member_paid_period_ended/);
 assert.deepEqual(members(f),[]);assert.equal(adminOnceState(f),financial);
});
test('native member deferred commit checks catch same-tx client/identity/role/source changes and roll back',opts,()=>{
 for(const mode of ['inactive','archive','identity','role','current']){
  const f=memberFixture(),financial=adminOnceState(f);const change=mode==='identity'?`update client_members set email='other@example.invalid' where client_id=${lit(f.client)};`
   :mode==='role'?`update client_members set role='owner' where client_id=${lit(f.client)};`
   :mode==='current'?`update membership_agreements set is_current=false where id=${lit(f.id)};`
   :`update clients set ${mode==='archive'?'archived_at=clock_timestamp()':"billing_status='inactive'"} where id=${lit(f.client)};`;
  denied('set role service_role;begin;'+memberCall(f)+change+'commit;',/retail_admin_member_|retail_admin_billing_|retail_funding_customer_denied/);
  assert.deepEqual(members(f),[]);assert.equal(adminOnceState(f),financial);
 }
});
test('native deferred member map independently validates two different client keys and refuses divergent same-key binding',opts,()=>{
 const a=memberFixture(),b=memberFixture();sql('set role service_role;begin;'+memberCall(a)+memberCall(b)+'commit;');
 assert.equal(members(a).length,1);assert.equal(members(b).length,1);
 const f=memberFixture();denied('set role service_role;begin;'+memberCall(f)+memberCall(f,f.user,{...memberCurrent(f),cancel_at_period_end:true})+'commit;',/retail_admin_member_binding_conflict/);assert.deepEqual(members(f),[]);
});
test('native member guard leaves unmarked legacy member writes unchanged and new SQL adds no table/column/browser grants',opts,()=>{
 const client=crypto.randomUUID(),user=crypto.randomUUID();sql(`insert into clients(id,name,email) values(${lit(client)},'Synthetic unmarked legacy','unmarked@example.invalid');
  insert into client_members(client_id,user_id,email,role) values(${lit(client)},${lit(user)},'legacy@example.invalid','member');`);
 assert.equal(sql(`select role from client_members where client_id=${lit(client)};`),'member');
 const f=memberFixture(),before=adminOnceState(f),aclBefore=sql("select relacl::text from pg_class where oid='client_members'::regclass;");
 for(const role of ['anon','authenticated'])denied('set role '+role+';'+memberCall(f),/permission denied/);
 denied(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261014030734_retail_existing_admin_buyer_member.sql'),'utf8'),/retail_admin_member_schema_drift/);
 assert.equal(aclBefore,sql("select relacl::text from pg_class where oid='client_members'::regclass;"));assert.equal(adminOnceState(f),before);assert.deepEqual(members(f),[]);
 assert.equal(sql("select prosecdef from pg_proc where oid='ensure_retail_existing_admin_buyer_member(uuid,jsonb,jsonb,jsonb,uuid,text)'::regprocedure;"),'f');
});
test('native member refuses pinned old billing/helper/member trigger drift and missing member privileges/RLS',opts,()=>{
 const f=memberFixture();for(const name of ['retail_admin_existing_billing_schema_guard','retail_admin_existing_billing_context','retail_admin_existing_billing_receipt_valid',
  'retail_admin_existing_billing_guard','retail_admin_existing_billing_commit_guard','apply_retail_existing_admin_billing','client_members_sync_user_uuid',
  'retail_admin_existing_member_context','retail_admin_existing_member_commit_guard','ensure_retail_existing_admin_buyer_member']){
  const definition=sql(`select pg_get_functiondef(oid) from pg_proc where proname=${lit(name)};`);
  try{sql(definition.replace(/\nAS \$function\$\n/,'\nAS $function$\n -- native member drift\n'));
   denied('set role service_role;'+memberCall(f),/retail_admin_member_|retail_admin_billing_/);assert.deepEqual(members(f),[]);
  }finally{sql(definition);}
 }
 for(const privilege of ['SELECT','INSERT','UPDATE']){
  try{sql('revoke '+privilege+' on public.client_members from service_role;');denied('set role service_role;'+memberCall(f),/retail_admin_member_schema_drift/);assert.deepEqual(members(f),[]);}
  finally{sql('grant '+privilege+' on public.client_members to service_role;');}
 }
 try{sql('alter table public.client_members disable row level security;');denied('set role service_role;'+memberCall(f),/retail_admin_member_schema_drift/);}
 finally{sql('alter table public.client_members enable row level security;');}
 for(const [table,trigger] of [['client_members','trg_client_members_sync_user_uuid'],['membership_agreements','retail_admin_existing_billing_guard'],['membership_agreements','retail_admin_existing_billing_commit_guard'],['client_members','retail_admin_existing_member_commit_guard']]){
  try{sql(`alter table public.${table} disable trigger ${trigger};`);denied('set role service_role;'+memberCall(f),/retail_admin_member_trigger_drift/);}
  finally{sql(`alter table public.${table} enable trigger ${trigger};`);}
 }
 assert.deepEqual(members(f),[]);
 try{sql("create function public.ensure_retail_existing_admin_buyer_member(uuid) returns void language sql as 'select null::void';");
  denied('set role service_role;'+memberCall(f),/retail_admin_member_prerequisite_drift/);assert.deepEqual(members(f),[]);
 }finally{sql('drop function public.ensure_retail_existing_admin_buyer_member(uuid);');}
});
test('native admin membership RPC is called only by its reviewed internal member seam',()=>{
 const root=path.resolve(__dirname,'../src');function scan(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  const f=path.join(dir,e.name);if(e.isDirectory())scan(f);else if(f.endsWith('.js')&&path.basename(f)!=='existingRetailAdminMemberTail.js')assert.ok(!fs.readFileSync(f,'utf8').includes('ensure_retail_existing_admin_buyer_member'),f);
 }}scan(root);
});
test('internal admin member seam is mounted only in the original activation service',()=>{
 const root=path.resolve(__dirname,'../src');function scan(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  const f=path.join(dir,e.name);if(e.isDirectory())scan(f);else if(f.endsWith('.js')&&!['existingRetailAdminMemberTail.js','publicPurchaseActivation.js'].includes(path.basename(f)))assert.ok(!fs.readFileSync(f,'utf8').includes('existingRetailAdminMemberTail'),f);
 }}scan(root);
});
test('native member future cancellation at or after original B retains initial paid access without resetting nonrenewal',opts,()=>{
 for(const offset of [0,86400]){
  const f=memberFixture();sql(`update clients set auto_renew=false,cancel_at_term_end=true where id=${lit(f.client)};`);
  const financial=adminOnceState(f);assert.equal(nativeMember(f,f.user,{...memberCurrent(f),cancel_at_period_end:true,cancel_at:f.proof.period.provider_period_end+offset}).status,'created');
  assert.equal(adminOnceState(f),financial);
 }
});

async function mountedAdmin(b,existing=false,hook=null){
 const {readExistingRetailActivationFunding}=require('../src/services/existingRetailActivationFunding');
 const funding=await readExistingRetailActivationFunding(b.options),user=crypto.randomUUID(),users=existing?[{id:user,email:'buyer@example.invalid'}]:[];
 const effects=[];
 const args={...b.options,db:b.db,agreementId:b.f.id,checkoutSessionId:b.checkout.id,subscription:b.current,paidAt:funding.paidAt,
  fallbackCustomerId:funding.customerId,retailFunding:funding,eventLivemode:false,
  requireParentClient:async()=>({ok:true,clientId:b.f.client}),logger:{info(){},warn(){},error(){}},
  authAdmin:{listUsers:async()=>({data:{users},error:null})},
  ensureRecovery:async()=>{effects.push('recovery');users.push({id:user,email:'buyer@example.invalid'});await hook?.('recovery');return{userId:user,method:'recovery',actionLink:'https://account.example.invalid/reset'};},
  sendRecoveryEmail:async()=>{effects.push('setup_email_provider_mock');await hook?.('email');return{statusCode:202};},
  sendWelcomeEmail:async()=>{effects.push('welcome_provider_mock');return{statusCode:202};}};
 return{user,effects,args,activate:patch=>require('../src/services/publicPurchaseActivation').activatePublicPurchaseAgreementCheckout({...args,...patch})};
}
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
test(`MOUNTED original admin paid CAS -> SDK/native billing/member -> original account ${plan}/${months}/${payment}/role:${role}`,opts,async()=>{
 const b=await adminSdkBridge(plan,months,payment,role,true,false);
 try{
  const a=await mountedAdmin(b,role),before=row(b.f);assert.equal(before.checkout_paid_at,null);
  // Exercise original FIRST native-funding descriptor too: no replay flag is
  // needed to enroll a PERSISTED receipt. No caller-controlled downgrade.
  const fresh={...a.args.retailFunding};delete fresh.receiptReplay;
  const r=await a.activate({retailFunding:fresh});assert.equal(r.ok,true);assert.equal(r.client_id,b.f.client);assert.equal(r.member_role,'manager');
  assert.equal(r.member_status,'created');assert.equal(r.setup_email_status,role?'not_sent_existing_user':'sent');
  assert.deepEqual(a.effects,role?[]:['recovery','setup_email_provider_mock']);assert.equal(members(b.f).length,1);assert.equal(members(b.f)[0].user_id,a.user);
  assert.equal(new Date(row(b.f).checkout_paid_at).toISOString(),b.f.proof.period.paid_at);assert.deepEqual(row(b.f).retail_funding_receipt,before.retail_funding_receipt);
  assert.equal(JSON.parse(billingState(b.f)).credits?.length||0,role?1:0);const state=adminOnceState(b.f),m=members(b.f);
  const retry=await a.activate();assert.equal(retry.ok,true);assert.equal(retry.member_status,'existing');assert.equal(retry.setup_email_status,'not_sent_existing_user');
  assert.equal(adminOnceState(b.f),state);assert.deepEqual(members(b.f),m);assert.deepEqual(a.effects,role?[]:['recovery','setup_email_provider_mock']);
  assert.equal(b.memberCalls.length,4);assert.ok(b.contextCalls.length>0);assert.ok(b.requests.every(r=>r.method==='GET'&&r.version==='2023-10-16'));
 }finally{await b.close();}
});
test('mounted admin original account tail refuses source/current loss after mocked recovery/email without claiming provider rollback',opts,async()=>{
 for(const when of ['recovery','email']){
  const b=await fullAdminBridge('pro',6,'prepaid',true);try{
   const a=await mountedAdmin(b,false,phase=>{if(phase===when)b.current.status='past_due';});
   await assert.rejects(a.activate(),e=>e.code==='retail_admin_member_tail_conflict'&&e.status===409&&e.permanentFailure);
   assert.deepEqual(members(b.f),[]);assert.ok(row(b.f).retail_admin_billing_receipt);assert.ok(a.effects.includes('recovery'));
   assert.equal(a.effects.includes('setup_email_provider_mock'),when==='email');assert.equal(b.memberCalls.length,0);
  }finally{await b.close();}
 }
});
test('mounted admin later period/inactive/pause/expired/forcedinactive does not recreate membership from historical billing',opts,async()=>{
 for(const mode of ['newer','inactive','pause','expired','override']){
  const b=await fullAdminBridge('basic',3,'monthly_installments',false);try{
   await b.apply();const a=await mountedAdmin(b,true),state=adminOnceState(b.f);
   if(mode==='newer')b.current.current_period_end+=86400;
   if(mode==='inactive')b.current.status='canceled';if(mode==='pause')b.current.pause_collection={behavior:'keep_as_draft'};
   if(mode==='expired')b.current.current_period_end=1;
   if(mode==='override')sql(`update clients set access_override_mode='force_inactive' where id=${lit(b.f.client)};`);
   const before=adminOnceState(b.f);await assert.rejects(a.activate(),e=>/^retail_admin_/.test(e.code));assert.deepEqual(members(b.f),[]);
   assert.equal(adminOnceState(b.f),before);assert.deepEqual(a.effects,[]);assert.equal(b.memberCalls.length,0);
   if(mode!=='override')assert.equal(before,state);
  }finally{await b.close();}
 }
});
test('mounted admin nonrenewal and scheduled cancellation preserve current preferences, settings and spent credit on retry',opts,async()=>{
 const b=await fullAdminBridge('pro',6,'monthly_installments',true);try{
  const a=await mountedAdmin(b,true);await a.activate();const w=row(b.f).retail_admin_billing_receipt,usedRole=crypto.randomUUID();
  sql(`insert into roles(id,client_id,title,slug_or_token) values(${lit(usedRole)},${lit(b.f.client)},'Synthetic mounted credit use',${lit('SYNTHETIC_'+usedRole)});
   update client_role_credits set status='used',used_at=clock_timestamp(),used_by_role_id=${lit(usedRole)} where id=${lit(w.credit_id)};
   update clients set auto_renew=false,cancel_at_term_end=true where id=${lit(b.f.client)};
   update client_plan_settings set platform_fee=77,billing_model='usage' where client_id=${lit(b.f.client)};`);
  b.current.cancel_at_period_end=true;b.current.cancel_at=b.current.current_period_end;
  const before=adminOnceState(b.f),m=members(b.f);const r=await a.activate();assert.equal(r.member_status,'existing');assert.equal(r.first_role_credit_status,'already_created');
  assert.equal(adminOnceState(b.f),before);assert.deepEqual(members(b.f),m);assert.deepEqual(a.effects,[]);
 }finally{await b.close();}
});
test('mounted admin lost/corrupt member ACK preserves committed membership; original existing-user retry recovers without new recovery email',opts,async()=>{
 for(const bad of ['lost','extra','missing','role']){
  const b=await fullAdminBridge('basic',3,'prepaid',false);try{
   const a=await mountedAdmin(b,false);b.hooks.afterMember=data=>{
    if(bad==='lost')throw Error('private native/provider details');
    return{data:bad==='extra'?{...data,extra:true}:bad==='missing'?null:{...data,role:'global_admin'},error:null};};
   await assert.rejects(a.activate(),e=>/^retail_admin_member_tail_/.test(e.code)&&e.status===503&&!e.message.includes('private'));
   const state=adminOnceState(b.f),m=members(b.f);assert.equal(m.length,1);delete b.hooks.afterMember;
   const r=await a.activate();assert.equal(r.member_status,'existing');assert.equal(adminOnceState(b.f),state);assert.deepEqual(members(b.f),m);
   assert.deepEqual(a.effects,['recovery','setup_email_provider_mock']);
  }finally{await b.close();}
 }
});
test('mounted admin verifies composite native rows, refuses malformed/current-source response, and keeps guard-lost sentinel',opts,async()=>{
 for(const mode of ['array','extra-row','missing','source']){
  const b=await fullAdminBridge('basic',3,'prepaid',false);try{
   const a=await mountedAdmin(b,true);b.hooks.afterContext=data=>({data:mode==='array'?[data]:mode==='extra-row'?[data,data]:mode==='missing'?[]:{...data,checkout_attempt_source:{...data.checkout_attempt_source,customer_id:'cus_OTHER'}},error:null});
   if(mode==='array')assert.equal((await a.activate()).member_status,'created');
   else{await assert.rejects(a.activate(),{code:'retail_admin_member_tail_readback_unknown'});assert.deepEqual(members(b.f),[]);assert.equal(b.memberCalls.length,0);}
   assert.deepEqual(a.effects,[]);
  }finally{await b.close();}
 }
 const b=await fullAdminBridge('basic',3,'prepaid',false);try{
  const a=await mountedAdmin(b,true),sentinel=Object.assign(Error('guard lost'),{code:'public_purchase_activation_guard_lost'});
  await assert.rejects(a.activate({assertActivationFence:async()=>{throw sentinel;}}),e=>e===sentinel);assert.deepEqual(members(b.f),[]);
 }finally{await b.close();}
});
test('mounted admin requires explicit current SDK cancel/pause fields before original account side effects',opts,async()=>{
 for(const field of ['cancel_at','pause_collection']){
  const b=await fullAdminBridge('basic',3,'prepaid',false);try{
   await b.apply();const a=await mountedAdmin(b,true);delete b.current[field];
   await assert.rejects(a.activate(),{code:'retail_admin_member_tail_subscription_unknown'});assert.deepEqual(members(b.f),[]);assert.deepEqual(a.effects,[]);
  }finally{await b.close();}
 }
});
test('mounted admin installed Supabase SDK transports composite RPC/member ACK against an authored loopback native gateway',opts,async()=>{
 const http=require('node:http'),{createClient}=require('@supabase/supabase-js');
 const b=await fullAdminBridge('pro',6,'prepaid',true),requests=[];
 const gateway=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://127.0.0.1');requests.push({method:req.method,path:url.pathname});let result;
   if(req.method==='POST'&&url.pathname.startsWith('/rest/v1/rpc/')){
    let body='';for await(const chunk of req)body+=chunk;result=await b.db.rpc(url.pathname.split('/').at(-1),JSON.parse(body));
    // Model the native COMPOSITE's ordinary PostgREST array representation.
    if(url.pathname.endsWith('/retail_admin_existing_member_context')&&!result.error)result={...result,data:[result.data]};
   }else if(req.method==='GET'&&url.pathname.startsWith('/rest/v1/')){
    const table=url.pathname.split('/').at(-1);let query=b.db.from(table).select('*');
    for(const [key,value] of url.searchParams){if(key==='select'||key==='order'||key==='limit')continue;
     if(value.startsWith('eq.'))query=query.eq(key,value.slice(3));else if(value==='is.null')query=query.is(key,null);else throw Error('Unsupported synthetic gateway filter');}
    result=await query;res.setHeader('content-range',result.data.length?`0-${result.data.length-1}/${result.count}`:'*/0');
   }else throw Error('Unsupported synthetic gateway request');
   res.setHeader('content-type','application/json');res.statusCode=result.error?400:200;
   res.end(JSON.stringify(result.error||result.data));
  }catch(e){res.statusCode=500;res.end(JSON.stringify({message:'Synthetic native gateway error'}));}
 });
 await new Promise((resolve,reject)=>{gateway.once('error',reject);gateway.listen(0,'127.0.0.1',resolve);});
 try{
  const db=createClient(`http://127.0.0.1:${gateway.address().port}`,'SYNTHETIC_NO_PROVIDER_KEY',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const a=await mountedAdmin(b,true);const r=await a.activate({db});assert.equal(r.ok,true);assert.equal(r.member_status,'created');assert.equal(members(b.f).length,1);
  assert.ok(requests.some(r=>r.path.endsWith('/retail_admin_existing_member_context')));
  assert.ok(requests.some(r=>r.path.endsWith('/ensure_retail_existing_admin_buyer_member')));
  assert.ok(requests.every(r=>r.method==='GET'||r.method==='POST'&&r.path.startsWith('/rest/v1/rpc/')));
  assert.deepEqual(a.effects,[]);assert.ok(b.requests.every(r=>r.method==='GET'&&r.version==='2023-10-16'));
  // Installed SDK wire/shape exercise against our authored gateway, NOT a
  // real PostgREST instance or hosted Auth/authorization/provider acceptance.
 }finally{await new Promise(resolve=>gateway.close(resolve));await b.close();}
});

// New linked seam is financial ONLY and intentionally UNMOUNTED. Original
// completion/claim/receipt are real native fixtures; no account/Auth/email.
const linkedBridge=(plan='basic',months=3,payment='prepaid',role=false,source='sales_assisted')=>adminSdkBridge(plan,months,payment,role,false,true,source);
const linkedCatalog=()=>sql("select jsonb_agg(jsonb_build_array(oid::regprocedure::text,md5(prosrc),proowner::regrole::text,prosecdef,provolatile,proconfig,proacl::text) order by oid::regprocedure::text) from pg_proc where proname='apply_public_purchase_billing';");
for(const source of ['sales_assisted','public_purchase_intent'])for(const plan of ['basic','pro'])for(const months of [3,6,12])
for(const payment of source==='sales_assisted'?['prepaid','monthly_installments']:['prepaid'])for(const role of [false,true])
test(`UNMOUNTED linked installed SDK -> SAME original native digest ${source}/${plan}/${months}/${payment}/role:${role}`,opts,async()=>{
 const b=await linkedBridge(plan,months,payment,role,source);try{
  const catalog=linkedCatalog();assert.match(catalog,/6ed48e7c15548a4521417b99ee213bd7/);
  const before=row(b.f),r=await b.apply();assert.equal(r.status,'applied');assert.match(r.digest,/^[a-f0-9]{64}$/);
  assert.equal(r.membership_activation_required,true);assert.equal(r.credits_spendable,false);assert.equal(r.billing_applied,true);
  assert.ok(Object.isFrozen(r)&&Object.isFrozen(r.clientInitial)&&Object.isFrozen(r.currentProviderSubscription));
  assert.equal(r.currentProviderSubscription.status,'active');assert.equal(r.clientInitial.contract_start_at,b.f.proof.period.paid_at);
  assert.equal(r.clientInitial.contract_end_at,anchoredMonthInstant(b.f.proof.period.paid_at,months));
  assert.deepEqual(row(b.f),before);assert.equal(b.memberCalls.length,0);assert.equal(b.contextCalls.length,0);
  const state=billingState(b.f),data=JSON.parse(state);assert.equal(data.credits?.length||0,role?1:0);
  assert.equal(data.intent.billing_apply_digest,r.digest);assert.ok(data.intent.billing_applied_at);
  assert.equal(new Date(data.intent.activated_at).toISOString(),b.f.proof.period.paid_at);
  assert.equal(data.plan.platform_fee,b.f.pkg.platform_fee);assert.equal(data.plan.per_role_fee,b.f.pkg.per_role_fee);
  const retry=await b.apply();assert.equal(retry.status,'already_applied');assert.equal(retry.digest,r.digest);
  assert.equal(billingState(b.f),state);assert.equal(linkedCatalog(),catalog);assert.equal(b.writes.length,4);
  assert.ok(b.requests.every(r=>r.method==='GET'&&r.version==='2023-10-16'));
  if(!role)for(const a of b.writes)for(const k of ['p_credit_type','p_credit_normal_role_fee_cents','p_credit_discounted_amount_cents','p_credit_discount_percent','p_credit_non_refundable','p_credit_expires'])assert.equal(a[k],null);
 }finally{await b.close();}
});
test('linked financial replay keeps later SDK period/status/pause separate and never resets preferences/settings/used credits',opts,async()=>{
 for(const patch of [{current_period_end:2100000000},{status:'canceled'},{status:'past_due'},{pause_collection:{behavior:'keep_as_draft'}},
  {cancel_at_period_end:true,cancel_at:2100000000}]){
  const b=await linkedBridge('pro',6,'monthly_installments',true);try{
   const first=await b.apply(),role=crypto.randomUUID();
   sql(`insert into roles(id,client_id,title,slug_or_token) values(${lit(role)},${lit(b.f.client)},'Synthetic linked spent credit',${lit('SYNTHETIC_'+role)});
    update client_role_credits set status='used',used_at=clock_timestamp(),used_by_role_id=${lit(role)} where source_public_purchase_intent_id=${lit(b.f.intent)};
    update clients set auto_renew=false,cancel_at_term_end=true,subscription_status='past_due',billing_status='past_due',current_term_end='2099-01-01Z' where id=${lit(b.f.client)};
    update client_plan_settings set platform_fee=77,billing_model='usage' where client_id=${lit(b.f.client)};`);
   Object.assign(b.current,patch);const state=billingState(b.f),r=await b.apply();assert.equal(r.status,'already_applied');assert.equal(r.digest,first.digest);
   for(const [k,v] of Object.entries(patch))assert.deepEqual(r.currentProviderSubscription[k],v);
   assert.equal(r.clientInitial.subscription_status,'active');assert.equal(r.clientInitial.auto_renew,true);assert.equal(r.planInitial.platform_fee,b.f.pkg.platform_fee);
   assert.equal(r.credits_spendable,false);assert.equal(r.membership_activation_required,true);assert.equal(billingState(b.f),state);assert.equal(b.memberCalls.length,0);
  }finally{await b.close();}
 }
});
test('linked first financial apply refuses inactive/paused/missing/current-period drift before writer',opts,async()=>{
 for(const patch of [{status:'past_due'},{status:'trialing'},{status:'canceled'},{cancel_at_period_end:true},{cancel_at:2100000000},
  {pause_collection:{behavior:'keep_as_draft'}},{cancel_at:undefined},{pause_collection:undefined},{current_period_end:1},{current_period_end:2100000000.5}]){
  const b=await linkedBridge();try{
   Object.assign(b.current,patch);const before=billingState(b.f);
   await assert.rejects(b.apply(),e=>/^retail_linked_billing_/.test(e.code));assert.equal(b.writes.length,0);assert.equal(billingState(b.f),before);
  }finally{await b.close();}
 }
});
test('linked lost/malformed native ACK leaves financial commit and same original retry recovers without duplicate credit',opts,async()=>{
 for(const mode of ['lost','empty','extra','digest','status']){
  const b=await linkedBridge('pro',12,'prepaid',true);try{
   b.hooks.afterApply=(data,count)=>{if(count!==1)return{data,error:null};if(mode==='lost')throw Error('PRIVATE provider/token details');
    return{data:mode==='empty'?null:mode==='extra'?{...data,extra:true}:mode==='digest'?{...data,digest:'bad'}:{...data,status:'completed'},error:null};};
   await assert.rejects(b.apply(),e=>e.status===503&&/^retail_linked_billing_/.test(e.code)&&!e.message.includes('PRIVATE'));
   const before=billingState(b.f),data=JSON.parse(before);assert.match(data.intent.billing_apply_digest,/^[a-f0-9]{64}$/);assert.equal(data.credits.length,1);
   delete b.hooks.afterApply;b.current.current_period_end+=86400;
   assert.equal((await b.apply()).status,'already_applied');assert.equal(billingState(b.f),before);assert.equal(b.memberCalls.length,0);
  }finally{await b.close();}
 }
});
test('linked original writer native clock/term/package/digest/credit conflicts map to permanent safe 409',opts,async()=>{
 for(const mode of ['clock','term','package','credit','digest']){
  const b=await linkedBridge('pro',6,'monthly_installments',true);try{
   if(mode==='digest')await b.apply();const before=billingState(b.f);
   b.hooks.beforeApply=a=>{if(mode==='clock')a.p_contract_start_at='2026-01-01Z';if(mode==='term')a.p_contract_end_at='2099-01-01Z';
    if(mode==='package')a.p_platform_fee+=1;if(mode==='credit')a.p_credit_normal_role_fee_cents+=1;
    if(mode==='digest')a.p_auto_renew=false;};
   await assert.rejects(b.apply(),e=>e.code==='retail_linked_billing_conflict'&&e.status===409&&e.permanentFailure);
   assert.equal(billingState(b.f),before);assert.equal(b.memberCalls.length,0);
  }finally{await b.close();}
 }
});
test('linked native guard rejects owner/source loss before first writer and after ordinary readback',opts,async()=>{
 for(const when of ['first','second']){
  const b=await linkedBridge('basic',3,'prepaid',false);try{
   let changed=false;b.hooks.beforeApply=()=>{if(b.writes.length===(when==='first'?1:2)&&!changed){changed=true;sql(`update clients set archived_at=clock_timestamp() where id=${lit(b.f.client)};`);}};
   await assert.rejects(b.apply(),e=>e.code==='retail_linked_billing_conflict'&&e.status===409&&e.permanentFailure);
   const state=JSON.parse(billingState(b.f));assert.equal(Boolean(state.intent.billing_applied_at),when==='second');assert.equal(b.memberCalls.length,0);
  }finally{await b.close();}
 }
});
test('linked paired marker/ACK/readback mismatch refuses without a first-write fallback',opts,async()=>{
 for(const mode of ['pair','bad-digest','bad-date','future','different-digest','after-missing','after-source']){
  const b=await linkedBridge();try{
   if(mode==='different-digest'||mode==='future')await b.apply();
   const before=billingState(b.f);b.hooks.afterRows=(table,data)=>{
    if(table==='public_purchase_intents')return data.map(i=>{
     if(mode==='pair')return{...i,billing_applied_at:'2026-01-01T00:00:00Z'};
     if(mode==='bad-digest')return{...i,billing_applied_at:'2026-01-01T00:00:00Z',billing_apply_digest:'BAD'};
     if(mode==='bad-date')return{...i,billing_applied_at:'2026-02-30T00:00:00Z',billing_apply_digest:'a'.repeat(64)};
     if(mode==='future')return{...i,billing_applied_at:'2099-01-01T00:00:00Z'};
     if(mode==='different-digest')return{...i,billing_apply_digest:'a'.repeat(64)};
     if(mode==='after-missing'&&b.writes.length)return{...i,billing_applied_at:null,billing_apply_digest:null};return i;
    });
    if(table==='membership_agreements'&&mode==='after-source'&&b.writes.length)return data.map(a=>({...a,checkout_attempt_source:{...a.checkout_attempt_source,customer_id:'cus_OTHER'}}));
    return data;
   };
   await assert.rejects(b.apply(),e=>e.status===503&&/^retail_linked_billing_/.test(e.code));
   if(['pair','bad-digest','bad-date'].includes(mode)){assert.equal(b.writes.length,0);assert.equal(billingState(b.f),before);}
   if(mode==='different-digest')assert.equal(billingState(b.f),before);
   if(mode.startsWith('after'))assert.ok(JSON.parse(billingState(b.f)).intent.billing_applied_at);
  }finally{await b.close();}
 }
});
test('linked seam refuses wrong API/mode/session/sub/invoice/claim identity and preserves guard-lost sentinel',opts,async()=>{
 for(const patch of [{stripe:{getApiField:()=> '2099-01-01'}},{eventLivemode:true},{eventSessionId:'cs_OTHER'},
  {eventSubscriptionId:'sub_OTHER'},{intentId:crypto.randomUUID()},{claimKey:'bad'}]){
  const b=await linkedBridge();try{
   const before=billingState(b.f);await assert.rejects(b.apply(patch),e=>/^retail_linked_billing_/.test(e.code));assert.equal(b.writes.length,0);assert.equal(billingState(b.f),before);
  }finally{await b.close();}
 }
 const b=await linkedBridge();try{
  for(const invoice of [null,'in_OTHER']){b.checkout.invoice=invoice;await assert.rejects(b.apply(),e=>/^retail_linked_billing_/.test(e.code));assert.equal(b.writes.length,0);}
  b.checkout.invoice=b.f.proof.period.invoice_id;b.checkout.payment_status='unpaid';await assert.rejects(b.apply(),{code:'retail_linked_billing_checkout_unknown'});
  const sentinel=Object.assign(Error('existing guard lost'),{code:'public_purchase_activation_guard_lost'});
  await assert.rejects(b.apply({assertFence:async()=>{throw sentinel;}}),e=>e===sentinel);
 }finally{await b.close();}
});
test('linked original native lease loss is retryable guard-lost and not hidden by financial no-op',opts,async()=>{
 const b=await linkedBridge();try{
  await b.apply();const before=billingState(b.f);b.hooks.beforeApply=a=>{a.p_claim_key='SYNTHETIC_WRONG_'+crypto.randomUUID();};
  await assert.rejects(b.apply(),{code:'public_purchase_activation_guard_lost'});assert.equal(billingState(b.f),before);
 }finally{await b.close();}
});
test('linked adapter stays unmounted and does not call account/member/admin/Checkout mutation engines',()=>{
 const root=path.resolve(__dirname,'../src');function scan(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  const f=path.join(dir,e.name);if(e.isDirectory())scan(f);else if(f.endsWith('.js')&&path.basename(f)!=='existingRetailLinkedBillingAdapter.js')assert.ok(!fs.readFileSync(f,'utf8').includes('existingRetailLinkedBillingAdapter'),f);
 }}scan(root);
 const source=fs.readFileSync(path.join(root,'services/existingRetailLinkedBillingAdapter.js'),'utf8');
 for(const forbidden of ['ensureBuyerAccountSetup','ensureRecovery','sendWelcome','enqueueSalesWon','apply_retail_existing_admin','ensure_public_purchase_buyer_member','complete_public_purchase_activation','.update(','.upsert(','.insert('])assert.ok(!source.includes(forbidden),forbidden);
});
test('linked adapter leaves original admin/legacy cohorts alone, refuses enrolled protocol drift and public monthly',opts,async()=>{
 const apply=require('../src/services/existingRetailLinkedBillingAdapter').applyExistingRetailLinkedBilling;
 const admin=await adminSdkBridge();try{assert.equal(await apply(admin.options),null);assert.equal(admin.writes.length,0);}finally{await admin.close();}
 const b=await linkedBridge();try{
  b.hooks.afterRows=(table,data)=>table==='public_purchase_intents'?data.map(i=>({...i,protocol:'legacy_complete'})):data;
  assert.equal(await b.apply(),null);assert.equal(b.writes.length,0);
  b.hooks.afterRows=(table,data)=>table==='public_purchase_intents'?data.map(i=>({...i,protocol:'unknown'})):data;
  await assert.rejects(b.apply(),{code:'retail_linked_billing_source_unknown'});assert.equal(b.writes.length,0);
  delete b.hooks.afterRows;
  b.hooks.afterRows=(table,data)=>table==='membership_agreements'?data.map(a=>({...a,template_snapshot:{...a.template_snapshot,source:'public_purchase_intent',package_snapshot:{...a.template_snapshot.package_snapshot,membership_terms:{...a.template_snapshot.package_snapshot.membership_terms,payment_option:'monthly_installments'}}}})):data;
  await assert.rejects(b.apply(),e=>/^retail_linked_billing_/.test(e.code));assert.equal(b.writes.length,0);
 }finally{await b.close();}
});
test('linked JS first-period clock expiry refuses fresh billing but historical financial replay stays no-DML',opts,async()=>{
 const first=await linkedBridge(),historical=await linkedBridge(),now=Date.now;try{
  await historical.apply();const freshBefore=billingState(first.f),oldBefore=billingState(historical.f);
  Date.now=()=>Math.max(first.current.current_period_end,historical.current.current_period_end)*1000+1000;
  await assert.rejects(first.apply(),e=>e.code==='retail_linked_billing_period_ended'&&e.status===410&&e.permanentFailure);
  assert.equal(first.writes.length,0);assert.equal(billingState(first.f),freshBefore);
  const r=await historical.apply();assert.equal(r.status,'already_applied');assert.equal(r.membership_activation_required,true);assert.equal(r.credits_spendable,false);
  assert.equal(billingState(historical.f),oldBefore);
  // Controlled JS clock only. Native lock/commit clock tests remain separate;
  // financial replay is not expired-period membership or full-term access.
 }finally{Date.now=now;await first.close();await historical.close();}
});
test('linked native fresh lease refusal and unknown enrolled source fail closed without billing fallback',opts,async()=>{
 const b=await linkedBridge();try{
  b.hooks.afterRows=(table,data)=>table==='membership_agreements'?data.map(a=>({...a,template_snapshot:{...a.template_snapshot,source:'unknown'}})):data;
  await assert.rejects(b.apply(),{code:'retail_linked_billing_source_unknown'});assert.equal(b.writes.length,0);delete b.hooks.afterRows;
  b.hooks.beforeApply=()=>sql(`update public_purchase_intents set activation_claimed_at=clock_timestamp()-interval '6 minutes' where id=${lit(b.f.intent)};`);
  await assert.rejects(b.apply(),{code:'public_purchase_activation_guard_lost'});
  const state=JSON.parse(billingState(b.f));assert.equal(state.intent.billing_applied_at,null);assert.equal(state.plan,null);assert.equal(state.credits,null);
 }finally{await b.close();}
});
test('linked installed Supabase SDK transports SAME original digest RPC through authored native loopback gateway',opts,async()=>{
 const http=require('node:http'),{createClient}=require('@supabase/supabase-js'),b=await linkedBridge('pro',12,'prepaid',true),requests=[];
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://127.0.0.1');requests.push({method:req.method,path:url.pathname});let result;
   if(req.method==='POST'&&url.pathname.startsWith('/rest/v1/rpc/')){
    const name=url.pathname.split('/').at(-1);assert.ok(['apply_public_purchase_billing','read_retail_existing_funding'].includes(name));
    let body='';for await(const chunk of req)body+=chunk;result=await b.db.rpc(name,JSON.parse(body));
   }else if(req.method==='GET'&&url.pathname.startsWith('/rest/v1/')){
    let query=b.db.from(url.pathname.split('/').at(-1)).select('*');
    for(const [key,value] of url.searchParams){if(['select','order','limit'].includes(key))continue;
     if(value.startsWith('eq.'))query=query.eq(key,value.slice(3));else if(value==='is.null')query=query.is(key,null);else throw Error('Unsupported synthetic filter');}
    result=await query;res.setHeader('content-range',result.data.length?`0-${result.data.length-1}/${result.count}`:'*/0');
   }else throw Error('Unexpected synthetic request');
   res.setHeader('content-type','application/json');res.statusCode=result.error?400:200;res.end(JSON.stringify(result.error||result.data));
  }catch(e){res.statusCode=500;res.end(JSON.stringify({message:'Synthetic native gateway error'}));}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 try{
  const db=createClient(`http://127.0.0.1:${server.address().port}`,'SYNTHETIC_NO_PROVIDER_KEY',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const first=await b.apply({db});assert.equal(first.status,'applied');const before=billingState(b.f);
  assert.equal((await b.apply({db})).status,'already_applied');assert.equal(billingState(b.f),before);assert.equal(b.writes.length,4);
  assert.equal(b.memberCalls.length,0);assert.ok(requests.some(r=>r.path.endsWith('/apply_public_purchase_billing')));
  assert.ok(requests.every(r=>r.method==='GET'||r.method==='POST'&&r.path.startsWith('/rest/v1/rpc/')));
  // Actual installed SDK/real native SQL, authored gateway only. No real
  // PostgREST instance, hosted authorization, account or provider acceptance.
 }finally{await new Promise(resolve=>server.close(resolve));await b.close();}
});

for(const source of ['sales_assisted','public_purchase_intent'])for(const plan of ['basic','pro'])for(const months of [3,6,12])
for(const payment of source==='sales_assisted'?['prepaid','monthly_installments']:['prepaid'])for(const credit of [false,true])
test(`native SAME original linked buyer RPC ${source}/${plan}/${months}/${payment}/credit:${credit}`,opts,()=>{
 const f=linkedMemberFixture(plan,months,payment,credit,source),financial=billingState(f);
 assert.deepEqual(nativeLinkedMember(f),{status:'created',role:'manager'});const first=members(f);
 assert.equal(first.length,1);assert.equal(first[0].user_id,f.user);assert.equal(first[0].user_id_uuid,f.user);
 assert.equal(first[0].email,'buyer@example.invalid');assert.equal(first[0].name,'Synthetic Buyer');
 const tuple=sql(`select xmin::text from client_members where client_id=${lit(f.client)} and user_id=${lit(f.user)};`);
 assert.deepEqual(nativeLinkedMember(f),{status:'existing',role:'manager'});assert.deepEqual(members(f),first);
 assert.equal(sql(`select xmin::text from client_members where client_id=${lit(f.client)} and user_id=${lit(f.user)};`),tuple);
 assert.equal(billingState(f),financial);assert.equal(linkedOriginalFunctions(),linkedOriginalCatalog);
});
test('linked member retains ORIGINAL legacy viewer/other and valid privileged roles; no-DML existing, blank becomes manager',opts,()=>{
 const check=sql("select pg_get_constraintdef(oid) from pg_constraint where conrelid='client_members'::regclass and conname='client_members_role_chk';");
 for(const role of ['manager','admin','owner','super_admin','viewer','member','other','']){
  const f=linkedMemberFixture();
  // NOT VALID permits historical out-of-enum rows, but not new invalid rows.
  // Author only such a synthetic legacy row, restoring the exact constraint
  // before invoking the ORIGINAL routine. No production constraint change.
  try{sql('alter table client_members drop constraint client_members_role_chk;');
   sql(`insert into client_members(client_id,user_id,email,name,role) values(${lit(f.client)},${lit(f.user)},' BUYER@example.invalid ','Original Name',${lit(role)});`);
  }finally{sql('alter table client_members add constraint client_members_role_chk '+check+';');}
  assert.equal(nativeLinkedMember(f).role,role.trim().toLowerCase()||'manager');const m=members(f)[0];
  assert.equal(m.name,'Original Name');assert.equal(m.email,' BUYER@example.invalid ');
  const prior=members(f);assert.equal(nativeLinkedMember(f).status,'existing');assert.deepEqual(members(f),prior);
 }
 const f=linkedMemberFixture();sql(`insert into client_members(client_id,user_id,email,name,role) values(${lit(f.client)},${lit(f.user)},null,null,'member');`);
 assert.deepEqual(nativeLinkedMember(f),{status:'updated',role:'member'});assert.equal(members(f)[0].name,'Synthetic Buyer');
 assert.equal(members(f)[0].email,'buyer@example.invalid');
});
test('linked member refuses foreign/ambiguous identities and missing/zero user; no rebinding',opts,()=>{
 for(const mode of ['foreign-user','foreign-email','ambiguous']){
  const f=linkedMemberFixture(),other=crypto.randomUUID();sql(`insert into client_members(client_id,user_id,email,role)
   values(${lit(f.client)},${lit(mode==='foreign-email'?f.user:other)},${lit(mode==='foreign-email'?'other@example.invalid':'buyer@example.invalid')},'member');`);
  if(mode==='ambiguous')sql(`insert into client_members(client_id,user_id,role) values(${lit(f.client)},${lit(f.user)},'member');`);
  const before=members(f);denied('set role service_role;'+linkedMemberCall(f),/retail_linked_member_identity_conflict/);assert.deepEqual(members(f),before);
 }
 const f=linkedMemberFixture();for(const user of [null,'00000000-0000-0000-0000-000000000000'])
  denied('set role service_role;'+linkedMemberCall(f,user),/retail_linked_member_user_denied/);
 assert.deepEqual(members(f),[]);
});
test('linked member actual current closed7 rejects unknown/inactive/trialing/paused/newer periods and early cancellation',opts,()=>{
 const f=linkedMemberFixture();for(const patch of [{status:'trialing'},{status:'canceled'},{status:'past_due'},{status:'paused'},
  {id:'sub_OTHER'},{customer:'cus_OTHER'},{current_period_end:f.proof.period.provider_period_end+1},{current_period_end:'2000000000'},
  {current_period_end:null},{cancel_at_period_end:null},{cancel_at:f.proof.period.provider_period_end-1},
  {cancel_at:253402300800},{cancel_at:'later'},{cancel_at:2000000000.5},{pause_collection:{behavior:'keep_as_draft'}},{extra:true}]){
  denied('set role service_role;'+linkedMemberCall(f,f.user,{...linkedMemberCurrent(f),...patch}),/retail_linked_member_current_subscription_denied/);
  assert.deepEqual(members(f),[]);
 }
 const missing=linkedMemberCurrent(f);delete missing.pause_collection;
 denied('set role service_role;'+linkedMemberCall(f,f.user,missing),/retail_linked_member_current_subscription_denied/);
});
test('linked member keeps nonrenewal/future cancellation, mutable plan and consumed credits without financial reset',opts,()=>{
 const f=linkedMemberFixture('pro',6,'monthly_installments',true),used=crypto.randomUUID();
 sql(`insert into roles(id,client_id,title,slug_or_token) values(${lit(used)},${lit(f.client)},'Synthetic linked credit use',${lit('SYNTHETIC_'+used)});
  update client_role_credits set status='used',used_at=clock_timestamp(),used_by_role_id=${lit(used)} where source_public_purchase_intent_id=${lit(f.intent)};
  update client_plan_settings set platform_fee=17,billing_model='usage' where client_id=${lit(f.client)};
  update clients set auto_renew=false,cancel_at_term_end=true where id=${lit(f.client)};`);
 const before=billingState(f);assert.equal(nativeLinkedMember(f,f.user,{...linkedMemberCurrent(f),cancel_at_period_end:true,cancel_at:f.proof.period.provider_period_end}).status,'created');
 assert.equal(billingState(f),before);
});
test('linked member current native source/client/owner/paid clock/digest/claim refusal before membership',opts,()=>{
 const fields={archive:'archived_at=clock_timestamp()',customer:"stripe_customer_id='cus_OTHER'",subscription:"stripe_subscription_id='sub_OTHER'",
  status:"subscription_status='past_due'",billing:"billing_status='inactive'",period:"current_term_end=current_term_end+interval '1 second'",
  start:"contract_start_at=contract_start_at+interval '1 second'",end:"contract_end_at=contract_end_at+interval '1 second'",override:"access_override_mode='force_inactive'"};
 for(const mode of [...Object.keys(fields),'profile','active-agreement','voided','current','digest','stamp','future-claim','expired-claim','plan']){
  const f=linkedMemberFixture();
  if(mode==='active-agreement'){
   // Current table enum disallows active; author that unknown legacy state
   // only inside a transaction that MUST roll back the DDL and record edit.
   const before=billingState(f);denied(`begin;alter table membership_agreements drop constraint membership_agreements_status_check;
    update membership_agreements set status='active' where id=${lit(f.id)};set role service_role;${linkedMemberCall(f)}commit;`,/retail_linked_member_source_denied/);
   assert.deepEqual(members(f),[]);assert.equal(billingState(f),before);continue;
  }
  if(fields[mode])sql(`update clients set ${fields[mode].replace("'sub_OTHER'",lit('sub_OTHER_'+f.id.replaceAll('-',''))).replace("'cus_OTHER'",lit('cus_OTHER_'+f.id.replaceAll('-','')))} where id=${lit(f.client)};`);
  else if(mode==='profile')sql(`update billing_customers set stripe_customer_id=null where client_id=${lit(f.client)};`);
  else if(mode==='plan')sql(`delete from client_plan_settings where client_id=${lit(f.client)};`);
  else if(['active-agreement','voided','current'].includes(mode))sql(`update membership_agreements set ${mode==='active-agreement'?"status='active'":mode==='voided'?'voided_at=clock_timestamp()':'is_current=false'} where id=${lit(f.id)};`);
  else sql(`update public_purchase_intents set ${{digest:"billing_apply_digest=repeat('0',64)",stamp:"billing_applied_at=clock_timestamp()+interval '1 minute'",'future-claim':"activation_claimed_at=clock_timestamp()+interval '1 minute'",'expired-claim':"activation_claimed_at=clock_timestamp()-interval '6 minutes'"}[mode]} where id=${lit(f.intent)};`);
  const before=billingState(f);denied('set role service_role;'+linkedMemberCall(f),/retail_linked_member_|retail_funding_/);
  assert.deepEqual(members(f),[]);assert.equal(billingState(f),before);
 }
 const f=linkedMemberFixture();for(const digest of [null,'short'])denied('set role service_role;'+linkedMemberCall(f,f.user,linkedMemberCurrent(f),digest),/retail_linked_member_billing_denied/);
 denied('set role service_role;'+linkedMemberCall(f,f.user,linkedMemberCurrent(f),f.digest,'WRONG_CLAIM'),/retail_linked_member_|retail_funding_claim_denied/);
});
test('linked member same/different user concurrency uses retained root lock with actual blocking observer',opts,async()=>{
 for(const same of [true,false]){
  const f=linkedMemberFixture(),user=same?f.user:crypto.randomUUID(),tag='SYNTHETIC_LINKED_'+f.id.replaceAll('-','');
  const [holder,writer,observer]=await Promise.all([
   parallel(`set application_name=${lit(tag+'_holder')};set role service_role;begin;${linkedMemberCall(f)}select pg_sleep(1);commit;`),
   parallel(`set application_name=${lit(tag+'_writer')};set role service_role;select pg_sleep(0.1);${linkedMemberCall(f,user)}`),
   parallel(`select pg_sleep(0.35);select exists(select 1 from pg_stat_activity w join pg_stat_activity h on h.pid=any(pg_blocking_pids(w.pid))
    where w.application_name=${lit(tag+'_writer')} and h.application_name=${lit(tag+'_holder')} and w.wait_event_type='Lock');`)]);
  assert.equal(holder.code,0,holder.err);assert.equal(observer.code,0,observer.err);assert.equal(observer.out.trim(),'t');
  if(same){assert.equal(writer.code,0,writer.err);assert.equal(JSON.parse(writer.out.split('\n').find(s=>s.startsWith('{'))).status,'existing');}
  else{assert.notEqual(writer.code,0);assert.match(writer.err,/retail_linked_member_identity_conflict/);}
  assert.equal(members(f).length,1);assert.equal(members(f)[0].user_id,f.user);
 }
});
test('linked member native clock rejects actual member wait past B and delayed deferred COMMIT, financial work remains',opts,async()=>{
 const f=linkedMemberFixture('basic',3,'monthly_installments',false,'sales_assisted',2);
 sql(`insert into client_members(client_id,user_id,email,name,role) values(${lit(f.client)},${lit(f.user)},'buyer@example.invalid',null,'member');`);
 const before=members(f),financial=billingState(f);
 const [holder,writer]=await Promise.all([parallel(`begin;select 1 from client_members where client_id=${lit(f.client)} for update;select pg_sleep(2.5);commit;`),
  parallel('set role service_role;select pg_sleep(0.07);'+linkedMemberCall(f))]);
 assert.equal(holder.code,0,holder.err);assert.notEqual(writer.code,0);assert.match(writer.err,/retail_linked_member_paid_period_ended/);
 assert.deepEqual(members(f),before);assert.equal(billingState(f),financial);
 const g=linkedMemberFixture('basic',3,'monthly_installments',false,'sales_assisted',2),saved=billingState(g);
 denied('set role service_role;begin;'+linkedMemberCall(g)+'select pg_sleep(2.5);commit;',/retail_linked_member_paid_period_ended/);
 assert.deepEqual(members(g),[]);assert.equal(billingState(g),saved);
});
test('linked member native clock rejects expired lease after member wait and deferred COMMIT',opts,async()=>{
 for(const wait of [true,false]){
  const f=linkedMemberFixture();sql(`update public_purchase_intents set activation_claimed_at=clock_timestamp()-interval '298 seconds' where id=${lit(f.intent)};`);
  if(wait)sql(`insert into client_members(client_id,user_id,email,name,role) values(${lit(f.client)},${lit(f.user)},'buyer@example.invalid',null,'member');`);
  const before=members(f);let writer;
  if(wait){const results=await Promise.all([parallel(`begin;select 1 from client_members where client_id=${lit(f.client)} for update;select pg_sleep(2.5);commit;`),
   parallel('set role service_role;select pg_sleep(0.07);'+linkedMemberCall(f))]);assert.equal(results[0].code,0,results[0].err);writer=results[1];}
  else writer=await parallel('set role service_role;begin;'+linkedMemberCall(f)+'select pg_sleep(2.5);commit;');
  assert.notEqual(writer.code,0);assert.match(writer.err,/retail_linked_member_claim_denied|retail_funding_claim_denied/);assert.deepEqual(members(f),before);
 }
});
test('linked member deferred COMMIT binding/source/identity catches same-tx changes; independent contexts and divergent same-key',opts,()=>{
 for(const mode of ['client','role','identity','claim','current']){
  const f=linkedMemberFixture(),before=billingState(f);
  const change={client:`update clients set billing_status='inactive' where id=${lit(f.client)};`,role:`update client_members set role='owner' where client_id=${lit(f.client)};`,
   identity:`update client_members set email='other@example.invalid' where client_id=${lit(f.client)};`,claim:`update public_purchase_intents set activation_claim_key='CHANGED' where id=${lit(f.intent)};`,
   current:`update membership_agreements set is_current=false where id=${lit(f.id)};`}[mode];
  denied('set role service_role;begin;'+linkedMemberCall(f)+change+'commit;',/retail_linked_member_|retail_funding_/);assert.deepEqual(members(f),[]);assert.equal(billingState(f),before);
 }
 const a=linkedMemberFixture(),b=linkedMemberFixture();sql('set role service_role;begin;'+linkedMemberCall(a)+linkedMemberCall(b)+'commit;');
 assert.equal(members(a).length,1);assert.equal(members(b).length,1);
 const f=linkedMemberFixture();denied('set role service_role;begin;'+linkedMemberCall(f)+linkedMemberCall(f,f.user,{...linkedMemberCurrent(f),cancel_at_period_end:true})+'commit;',/retail_linked_member_binding_conflict/);assert.deepEqual(members(f),[]);
});
test('linked member early IMMEDIATE nested DEFINER execution fails safely; explicit deferred flush succeeds',opts,()=>{
 const f=linkedMemberFixture();denied('set role service_role;begin;set constraints all immediate;'+linkedMemberCall(f)+'commit;',/retail_linked_member_commit_binding_denied/);
 assert.deepEqual(members(f),[]);
 sql('set role service_role;begin;'+linkedMemberCall(f)+'set constraints all immediate;commit;');assert.equal(members(f).length,1);
 assert.equal(sql("select proconfig::text from pg_proc where oid='retail_linked_existing_member_commit_guard()'::regprocedure;"),'{search_path=pg_catalog,lock_timeout=10s}');
});
test('linked member real original PK adoption preserves role and post-adoption full candidate count refuses ambiguity',opts,async()=>{
 // Test-only sleep at the actual original INSERT. A privileged non-RPC
 // synthetic writer uses replica mode to bypass the root FK lock, emulating
 // the original routine's documented non-RPC PK-adoption race. This is not
 // an arbitrary privileged-writer security defense or normal app behavior.
 sql(`create function public.synthetic_linked_insert_wait() returns trigger language plpgsql as $$ begin
  if nullif(current_setting('private_sales.retail_linked_member_contexts',true),'') is not null then perform pg_sleep(0.8);end if;return new;end $$;
  create trigger synthetic_linked_insert_wait before insert on public.client_members for each row execute function public.synthetic_linked_insert_wait();`);
 try{for(const ambiguous of [false,true]){
  const f=linkedMemberFixture(),other=crypto.randomUUID();
  const [member,writer]=await Promise.all([
   parallel('set role service_role;'+linkedMemberCall(f)),
   parallel(`select pg_sleep(0.2);set session_replication_role=replica;
    insert into client_members(client_id,user_id,user_id_uuid,email,name,role)
     values(${lit(f.client)},${lit(f.user)},${lit(f.user)},'buyer@example.invalid','Racing Name','tester');
    ${ambiguous?`insert into client_members(client_id,user_id,user_id_uuid,email,role) values(${lit(f.client)},${lit(other)},${lit(other)},'buyer@example.invalid','member');`:''}`)]);
  assert.equal(writer.code,0,writer.err);
  if(ambiguous){assert.notEqual(member.code,0);assert.match(member.err,/retail_linked_member_identity_conflict/);assert.equal(members(f).length,2);}
  else{assert.equal(member.code,0,member.err);assert.deepEqual(JSON.parse(member.out),{status:'existing',role:'tester'});
   assert.equal(members(f)[0].name,'Racing Name');assert.equal(members(f).length,1);}
 }}finally{sql('drop trigger synthetic_linked_insert_wait on public.client_members;drop function public.synthetic_linked_insert_wait();');}
});
test('linked member ACL/RLS/sync/deferred/body drift and unknown overload/reapply fail without changing original routines',opts,()=>{
 const f=linkedMemberFixture();for(const role of ['anon','authenticated'])denied('set role '+role+';'+linkedMemberCall(f),/permission denied/);
 denied(fs.readFileSync(linkedMemberMigrationPath,'utf8'),/retail_linked_member_schema_drift/);
 for(const name of ['ensure_public_purchase_buyer_member','locked_purchase_context','apply_public_purchase_billing','retail_existing_terms_months',
  'retail_linked_existing_member_schema_guard','retail_linked_existing_member_context','retail_linked_existing_member_commit_guard','ensure_retail_existing_linked_buyer_member']){
  const definition=sql(`select pg_get_functiondef(oid) from pg_proc where proname=${lit(name)};`);
  try{sql(definition.replace(/\nAS \$function\$\n/,'\nAS $function$\n -- synthetic linked drift\n'));denied('set role service_role;'+linkedMemberCall(f),/retail_linked_member_prerequisite_drift/);}
  finally{sql(definition);}
 }
 for(const trigger of ['trg_client_members_sync_user_uuid','retail_linked_existing_member_commit_guard']){
  try{sql(`alter table client_members disable trigger ${trigger};`);denied('set role service_role;'+linkedMemberCall(f),/retail_.*member_trigger_drift/);}
  finally{sql(`alter table client_members enable trigger ${trigger};`);}
 }
 try{sql('alter table client_members disable row level security;');denied('set role service_role;'+linkedMemberCall(f),/retail_admin_member_schema_drift/);}
 finally{sql('alter table client_members enable row level security;');}
 for(const privilege of ['SELECT','INSERT','UPDATE']){
  try{sql('revoke '+privilege+' on client_members from service_role;');denied('set role service_role;'+linkedMemberCall(f),/retail_admin_member_schema_drift/);}
  finally{sql('grant '+privilege+' on client_members to service_role;');}
 }
 try{sql("grant execute on function ensure_public_purchase_buyer_member(uuid,text,uuid,text) to authenticated;");denied('set role service_role;'+linkedMemberCall(f),/retail_linked_member_prerequisite_drift/);}
 finally{sql('revoke execute on function ensure_public_purchase_buyer_member(uuid,text,uuid,text) from authenticated;');}
 try{sql("create function ensure_retail_existing_linked_buyer_member(uuid) returns void language sql as 'select null::void';");denied('set role service_role;'+linkedMemberCall(f),/retail_linked_member_prerequisite_drift/);}
 finally{sql('drop function ensure_retail_existing_linked_buyer_member(uuid);');}
 assert.equal(linkedOriginalFunctions(),linkedOriginalCatalog);assert.deepEqual(members(f),[]);
});
test('linked member guard is UNMOUNTED and adds no member mutation/definer/tables/browser grants',()=>{
 const source=fs.readFileSync(linkedMemberMigrationPath,'utf8');assert.doesNotMatch(source,/security definer|create table|alter table|insert into|update public\.client_members/i);
 assert.match(source,/ack:=public\.ensure_public_purchase_buyer_member\(p_intent,p_claim,p_user,p_name\)/);
 const root=path.resolve(__dirname,'../src');function scan(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,e.name);if(e.isDirectory())scan(file);else if(file.endsWith('.js'))assert.ok(!fs.readFileSync(file,'utf8').includes('ensure_retail_existing_linked_buyer_member'),file);
 }}scan(root);
});
