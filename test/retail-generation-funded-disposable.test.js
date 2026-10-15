'use strict';
// Real private PG, empty curated schema. Authored provider data, no external
// SDK/mail/Auth/payment effects; not hosted or bank/recipient acceptance.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {generationFixture}=require('./fixtures/generation-retail-funding-fixture');
const {fixture:legacyFixture}=require('./fixtures/existing-retail-funding-fixture');
const {buildRetailPackageSnapshot}=require('../src/services/membershipPackageCompatibility');
const {anchoredMonthInstant,STRIPE_RECURRING_OFFER_VERSION}=require('../src/services/membershipOffers');
const {verifyExistingRetailFunding}=require('../src/services/existingRetailCheckoutFunding');
const {verifyExistingRetailRecurringFunding}=require('../src/services/existingRetailCheckoutFunding');
const {generationCycle,generationRecurringFixture}=require('./fixtures/generation-retail-recurring-funding-fixture');
const {renewalSubscriptionProjection}=require('../src/services/existingRetailRenewalPreference');
const enabled=process.env.RETAIL_GENERATION_FUNDED_DISPOSABLE==='true',opts={skip:!enabled};
const socket=process.env.PGHOST||'',port='55458',bin='/opt/homebrew/opt/postgresql@17/bin/';
const database=`retail_generation_funded_${process.pid}`,root=path.join(__dirname,'../supabase/migrations');
const lit=v=>v==null?'null':typeof v==='object'?`'${JSON.stringify(v).replaceAll("'","''")}'::jsonb`
 :typeof v==='boolean'||typeof v==='number'?String(v):`'${String(v).replaceAll("'","''")}'`;
// Full rendered agreements exceed the OS argv limit. Feed local SQL on stdin;
// retain exact native statements and no external network/provider effects.
const run=q=>cp.spawnSync(bin+'psql',['-h',socket,'-p',port,'-U','postgres','-d',database,'-X','-q','-At','-v','ON_ERROR_STOP=1','-f','-'],{input:q,encoding:'utf8',maxBuffer:16777216});
function sql(q){const r=run(q);assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
const json=q=>JSON.parse(sql(q));
function denied(q,re=/retail_|constraint/){const r=run(q);assert.notEqual(r.status,0);assert.match(r.stderr,re);}
const migration=fs.readFileSync(path.join(root,'20261015172617_retail_generation_funding_coverage.sql'),'utf8');
const rpc=(name,args)=>`select coalesce(to_jsonb(${name}(${Object.entries(args).map(([k,v])=>k+'=>'+lit(v)).join(',')})),'null'::jsonb);`;
const call=(name,args)=>json('set role service_role;'+rpc(name,args));
const agreement=r=>json(`select to_jsonb(t) from membership_agreements t where id=${lit(r.g.id)};`);
const client=r=>json(`select to_jsonb(t) from clients t where id=${lit(r.c.id)};`);
const config={public_backend_base:'https://api.example.invalid',public_sign_base:'https://site.example.invalid'};

// Same application JS adapters against REAL native RPCs/rows. This shim only
// translates their existing read API to a private Unix-socket test connection;
// no stubbed RPC ACK or application/table writes are supplied by the shim.
function nativeDb(){const rpcErrors=[];return{rpcErrors,
 async rpc(name,args){assert.match(name,/^[a-z_]+$/);const out=run('set role service_role;'+rpc(name,args));
  if(out.status){rpcErrors.push({name,error:out.stderr.split('\n')[0]});return{data:null,error:{message:out.stderr}};}
  return{data:JSON.parse(out.stdout),error:null};},
 from(table){assert.ok(['membership_agreements','public_purchase_intents','clients','billing_customers','client_members'].includes(table));
  const filters=[];let counted=false;
  const query={select(_columns,options={}){counted=options.count==='exact';return query;},
   eq(key,value){assert.match(key,/^[a-z_]+$/);filters.push(key+'='+lit(value));return query;},
   async maybeSingle(){const r=await execute();assert.ok(r.data.length<=1);return{data:r.data[0]||null,error:null};},
   then(resolve,reject){return execute().then(resolve,reject);}};
  async function execute(){const rows=json(`set role service_role;select coalesce(jsonb_agg(to_jsonb(t)),'[]') from ${table} t${filters.length?' where '+filters.join(' and '):''};`);
   return{data:rows,error:null,...(counted?{count:rows.length}:{})};}
  return query;
 }
};}
function authoredSdk(r){const list=data=>({object:'list',has_more:false,data:structuredClone(data)});
 return{getApiField:key=>key==='version'?'2023-10-16':null,
  accounts:{retrieve:async()=>({object:'account',id:'acct_SYNTHETIC'})},
  checkout:{sessions:{retrieve:async()=>structuredClone(r.cs),listLineItems:async()=>list(r.cl)}},
  subscriptions:{retrieve:async()=>structuredClone(r.s)},subscriptionItems:{list:async()=>list(r.s.items.data)},
  invoices:{retrieve:async()=>structuredClone(r.inv),listLineItems:async()=>list(r.il)},
  paymentIntents:{retrieve:async()=>structuredClone(r.pi)},charges:{retrieve:async()=>structuredClone(r.ch)}};
}

function setup({plan='basic',months=3,payment='prepaid',role=false,admin=false,generation=true,legacyVersion,sales=false,replacement=false,largeContract=false}={}){
 const now=Date.now(),generatedAt=new Date(now-3*3600000).toISOString(),paidAt=new Date(Math.floor(now/1000)*1000).toISOString();
 const f=generation?generationFixture(plan,months,payment,role,{admin,generatedAt,paidAt}):legacyFixture(plan,months,payment,role,{admin});
 if(!generation){
  if(legacyVersion){f.pkg=buildRetailPackageSnapshot({planKey:plan,commitmentMonths:months,paymentOption:payment,
   firstRolePrepaySelected:role,channel:'sales',offerVersion:legacyVersion});
   f.g.template_snapshot.package_snapshot=f.pkg;f.g.template_snapshot.values.pricing_version=legacyVersion;f.i.package_snapshot=f.pkg;}
  f.g.signed_at=new Date(now-3600000).toISOString();f.g.agreement_expires_at=new Date(now+5*86400000).toISOString();f.i.expires_at=f.g.agreement_expires_at;
 }
 const key=crypto.randomUUID().replaceAll('-',''),G=crypto.randomUUID(),C=crypto.randomUUID(),I=crypto.randomUUID();
 Object.assign(f.g,{id:G,client_id:C,initial_term_start:generation?f.g.initial_term_start:null,initial_renewal_date:generation?f.g.initial_renewal_date:null});
 Object.assign(f.i,{id:I,client_id:C,agreement_id:G});Object.assign(f.c,{id:C,stripe_customer_id:'cus_'+key});
 if(!admin)f.g.template_snapshot.purchase_intent.id=I;
 if(largeContract){
  const rendered=require('../src/render/membershipAgreement').buildMembershipAgreementHtml(
   f.g.template_snapshot.values,{packageSnapshot:f.pkg,generatedAt:f.g.template_snapshot.generated_at});
  assert.ok(rendered.html.length>8192);f.g.template_snapshot.rendered_html=rendered.html;
 }
 Object.assign(f.cs,{id:'cs_'+key,customer:f.c.stripe_customer_id,subscription:'sub_'+key,invoice:'in_'+key});
 Object.assign(f.s,{id:'sub_'+key,customer:f.c.stripe_customer_id});
 Object.assign(f.inv,{id:'in_'+key,customer:f.c.stripe_customer_id,subscription:f.s.id,payment_intent:'pi_'+key,charge:'ch_'+key});
 Object.assign(f.pi,{id:'pi_'+key,customer:f.c.stripe_customer_id,invoice:f.inv.id,latest_charge:'ch_'+key});
 Object.assign(f.ch,{id:'ch_'+key,customer:f.c.stripe_customer_id,invoice:f.inv.id,payment_intent:f.pi.id});
 Object.assign(f.s.items.data[0],{id:'si_'+key,subscription:f.s.id});
 f.il.forEach((l,n)=>Object.assign(l,{id:'il_'+key+n,subscription:f.s.id,subscription_item:l.type==='subscription'?'si_'+key:null}));
 sql(`set role service_role;insert into clients(id,name,email,stripe_customer_id,billing_status,subscription_status,plan_tier,billing_interval)
  values(${lit(C)},'SYNTHETIC ONLY',${lit(key+'@example.invalid')},${lit(f.c.stripe_customer_id)},'inactive','incomplete',null,null);
  insert into billing_customers(client_id,name,primary_contact_email,stripe_customer_id)
  values(${lit(C)},'SYNTHETIC ONLY',${lit(key+'@example.invalid')},${lit(f.c.stripe_customer_id)});
  insert into membership_agreements(id,client_id,status,is_current,client_legal_name,primary_admin_name,admin_email,
   membership_tier,billing_option,auto_renew,signer_accepted,template_version,template_snapshot,signed_at,
   agreement_expires_at,signer_token_hash,signer_token_expires_at,draft_pdf_path,initial_term_start,initial_renewal_date)
  values(${lit(G)},${lit(C)},'signed',true,'SYNTHETIC ONLY','Synthetic Buyer',${lit(key+'@example.invalid')},${lit(plan)},
   ${lit(f.pkg.billing_cadence)},true,true,${lit(f.g.template_version)},${lit(f.g.template_snapshot)},${lit(f.g.signed_at)},
   ${lit(f.g.agreement_expires_at)},${lit(crypto.createHash('sha256').update(key).digest('hex'))},${lit(f.g.agreement_expires_at)},
   'synthetic/unused.pdf',${lit(f.g.initial_term_start)},${lit(f.g.initial_renewal_date)});`);
 if(!admin)sql(`set role service_role;insert into public_purchase_intents(id,agreement_id,client_id,status,protocol,selected_plan_key,
  selected_billing_cadence,package_snapshot,company_legal_name,buyer_first_name,buyer_last_name,buyer_email,
  first_role_prepay_selected,first_role_prepay_credit_type,first_role_normal_role_fee_cents,first_role_prepay_amount_cents,
  first_role_prepay_discount_percent,term_start_basis,expires_at)
  values(${lit(I)},${lit(G)},${lit(C)},'agreement_pending','fenced_v2',${lit(plan)},${lit(f.pkg.billing_cadence)},${lit(f.pkg)},
  'SYNTHETIC ONLY','Synthetic','Buyer',${lit(key+'@example.invalid')},${role},${lit(role?'first_role_prepay':null)},
  ${lit(role?f.pkg.first_role_prepay.normal_role_fee_cents:null)},${lit(role?f.pkg.first_role_prepay.discounted_credit_amount_cents:null)},
  ${lit(role?10:null)},${lit(generation?'generation_date':'successful_payment')},${lit(f.i.expires_at)});`);
 let rep=null,reviewer=null;
 if(sales){assert.equal(admin,false);rep=crypto.randomUUID();reviewer=crypto.randomUUID();
  sql(`insert into auth.users(id,email) values(${lit(rep)},${lit('rep-'+key+'@example.invalid')}),
   (${lit(reviewer)},${lit('admin-'+key+'@example.invalid')});
   insert into sales_reps(user_id,email,display_name,active) values(${lit(rep)},${lit('rep-'+key+'@example.invalid')},'Synthetic Rep',true);
   update public_purchase_intents set channel='sales_assisted',created_by_user_id=${lit(rep)} where id=${lit(I)};`);
 }
 const replacementId=replacement?'sub_OLD_'+key:null;
 if(replacement)sql(`set role service_role;update clients set stripe_subscription_id=${lit(replacementId)} where id=${lit(C)};`);
 const attempt=call('claim_retail_existing_checkout_attempt',{p_agreement:G,p_client:C,p_expected_template:f.g.template_snapshot,
  p_customer:f.c.stripe_customer_id,p_embedded:false,p_replacement:replacementId,p_config:config});
 const prices=generation?{initial_platform_price_id:f.cl[0].price.id,recurring_platform_price_id:f.cl[1].price.id,
  first_role_price_id:role?f.cl[2].price.id:null}:undefined;
 call('pin_retail_existing_checkout_session',{p_agreement:G,p_client:C,p_attempt:{...attempt,...(generation?{prices}:{})},p_session:f.cs.id});
 const claimKey='SYNTHETIC_CLAIM_'+key;
 if(!admin)assert.equal(call('claim_public_purchase_activation',{p_agreement_id:G,p_claim_key:claimKey}).status,'claimed');
 const A=Math.floor(Date.now()/1000),created=Math.floor(Date.parse(attempt.created_at)/1000);
 f.cs.created=created;Object.assign(f.inv,{created:A,status_transitions:{paid_at:A}});
 const span=f.pkg.membership_terms.stripe_recurrence.interval_count;
 if(generation)Object.assign(f.s,{start_date:A,trial_start:A,current_period_start:A});
 else{const end=Date.parse(anchoredMonthInstant(new Date(A*1000).toISOString(),span))/1000;
  f.s.start_date=A;f.s.current_period_start=A;f.s.current_period_end=end;
  f.il.filter(l=>l.type==='subscription').forEach(l=>l.period={start:A,end});}
 if(generation)f.il.forEach(l=>l.period={start:A,end:f.s.trial_end});
 Object.assign(f.s,{cancel_at_period_end:false,cancel_at:null,pause_collection:null});
 const list=data=>({object:'list',data,has_more:false});
 const funding=verifyExistingRetailFunding({offer:f.pkg.membership_terms,checkout:f.cs,checkoutLines:list(f.cl),subscription:f.s,
  subscriptionItems:f.s.items,invoice:f.inv,invoiceLines:list(f.il),paymentIntent:f.pi,charge:f.ch,
  expected:{checkoutId:f.cs.id,customerId:f.c.stripe_customer_id,subscriptionId:f.s.id,eventLivemode:false,signedAt:f.g.signed_at,
   agreementDeadline:f.g.agreement_expires_at,intentDeadline:admin?undefined:f.i.expires_at,
   ...(generation?{generatedAt,initialTermStart:f.g.initial_term_start,initialRenewalDate:f.g.initial_renewal_date,prices}:{})}});
 const proof={provider_account_id:'acct_SYNTHETIC',period:funding.initialProviderSchedule||funding.initialProviderPeriod,
  payment_intent_id:funding.paymentIntentId,charge_id:funding.chargeId,checkout_created:funding.checkoutCreatedEpoch,invoice_created:funding.invoiceCreatedEpoch,
  platform_gross_cents:funding.platformGrossCents,platform_discount_cents:funding.platformDiscountCents,platform_net_cents:funding.platformNetCents,
  role_gross_cents:funding.roleGrossCents,role_discount_cents:funding.roleDiscountCents,role_net_cents:funding.roleNetCents,
  tax_cents:funding.taxCents,cash_cents:funding.cashCents};
 return {...f,admin,generation,claimKey:admin?null:claimKey,attempt,proof,paidAt:funding.paidAt,key,rep,reviewer,replacementId};
}
function record(r,proof=r.proof){return call('record_retail_existing_funding',{p_agreement:r.g.id,p_client:r.c.id,
 p_claim:r.claimKey,p_source:r.attempt.source,p_proof:proof});}
function complete(r){
 const start=r.generation?r.g.initial_term_start:r.paidAt.slice(0,10),end=r.generation?r.g.initial_renewal_date:
  anchoredMonthInstant(r.paidAt,r.pkg.commitment_months).slice(0,10);
 if(r.admin)sql(`set role service_role;update membership_agreements set checkout_status='paid',checkout_paid_at=${lit(r.paidAt)} where id=${lit(r.g.id)};`);
 else assert.equal(call('complete_public_purchase_activation',{p_agreement_id:r.g.id,p_claim_key:r.claimKey,p_paid_at:r.paidAt,
  p_checkout_session_id:r.cs.id,p_client_id:r.c.id,p_create_client:false,p_plan_key:r.pkg.plan_key,
  p_billing_interval:r.pkg.billing_cadence,p_term_start:start,p_renewal_date:end}).status,'completed');
}
function initial(r){
 const clientPath=require.resolve('../src/clients/supabase'),saved=require.cache[clientPath];
 if(!saved)require.cache[clientPath]={id:clientPath,filename:clientPath,loaded:true,exports:{supabaseAdmin:{}}};
 try{const {buildClientActivationPayload}=require('../src/services/publicPurchaseActivation');
  return buildClientActivationPayload({agreement:agreement(r),subscription:r.s,planKey:r.pkg.plan_key,
   billingInterval:r.pkg.billing_cadence,packageSnapshot:r.pkg,paidAt:r.paidAt});
 }finally{if(!saved)delete require.cache[clientPath];}
}
function bill(r){
 const a=agreement(r),p=initial(r),sub={id:r.s.id,customer:r.c.stripe_customer_id,status:r.s.status,
  current_period_end:r.s.current_period_end,cancel_at_period_end:false};
 if(r.admin)return call('apply_retail_existing_admin_billing',{p_agreement:r.g.id,p_client:r.c.id,p_source:r.attempt.source,
  p_funding:a.retail_funding_receipt,p_initial:p,p_subscription:sub});
 const c=r.pkg.first_role_prepay,selected=c.selected;
 return call('apply_public_purchase_billing',{p_intent_id:r.i.id,p_claim_key:r.claimKey,p_client_id:r.c.id,p_billing_client_id:r.c.id,
  p_stripe_customer_id:p.stripe_customer_id,p_stripe_subscription_id:p.stripe_subscription_id,p_subscription_status:p.subscription_status,
  p_billing_status:p.billing_status,p_billing_interval:p.billing_interval,p_plan_tier:p.plan_tier,p_current_term_end:p.current_term_end,
  p_cancel_at_term_end:p.cancel_at_term_end,p_auto_renew:p.auto_renew,p_cancel_effective_at:p.cancel_effective_at,
  p_contract_start_at:p.contract_start_at,p_contract_end_at:p.contract_end_at,p_platform_fee:r.pkg.platform_fee,p_per_role_fee:r.pkg.per_role_fee,
  p_included_interviews_per_role:r.pkg.included_interviews_per_role,p_additional_interview_fee:r.pkg.additional_interview_fee,
  p_max_interview_minutes:r.pkg.max_interview_minutes,p_credit_selected:selected,p_credit_type:selected?c.credit_type:null,
  p_credit_normal_role_fee_cents:selected?c.normal_role_fee_cents:null,p_credit_discounted_amount_cents:selected?c.discounted_credit_amount_cents:null,
  p_credit_discount_percent:selected?c.discount_percent:null,p_credit_non_refundable:selected?c.non_refundable:null,p_credit_expires:selected?c.expires:null});
}
before(()=>{
 if(!enabled)return;assert.match(socket,/^\/private\/tmp\/alphascreen-generation-schema\.[A-Za-z0-9]+$/);assert.equal(process.env.PGPASSWORD,undefined);
 const r=cp.spawnSync(bin+'createdb',['-h',socket,'-p',port,'-U','postgres','-T','postgres',database],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 // Restore the hosted baseline's existing extension access omitted by the
 // empty local schema bootstrap. This is NOT a migration grant/change.
 sql('grant usage on schema extensions to service_role;');
 sql(fs.readFileSync(path.join(root,'20261015165725_retail_generation_checkout_compat.sql'),'utf8'));sql(migration);
 if(process.env.RETAIL_GENERATION_REPLACEMENT_COMPAT==='true')
  sql(fs.readFileSync(path.join(root,'20261015180910_retail_generation_replacement_compat.sql'),'utf8'));
});
after(()=>{if(enabled){const r=cp.spawnSync(bin+'dropdb',['-h',socket,'-p',port,'-U','postgres',database],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);}});
test('combined native migration composes on the39-migration empty baseline, with all guard chains live',opts,()=>{
 for(const guard of ['retail_existing_funding_schema_guard','retail_admin_existing_billing_schema_guard',
  'retail_admin_existing_member_schema_guard','retail_linked_existing_member_schema_guard'])sql(`set role service_role;select ${guard}();`);
 assert.deepEqual(json('select jsonb_build_object(\'clients\',(select count(*) from clients),\'agreements\',(select count(*) from membership_agreements),\'auth\',(select count(*) from auth.users));'),
  {clients:0,agreements:0,auth:0});
 denied(migration,/prerequisite_drift|schema_drift/);
});
for(const cohort of ['v1','v2','v3'])for(const plan of ['basic','pro'])for(const months of [3,6,12])
 for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
 test(`native funded activation and replay ${cohort}/${plan}/${months}/${payment}/role=${role}`,opts,()=>{
  const generation=cohort==='v3';
  for(const admin of [false,true]){
   const r=setup({generation,plan,months,payment,role,admin,legacyVersion:cohort==='v2'?STRIPE_RECURRING_OFFER_VERSION:undefined});
   assert.equal(client(r).billing_status,'inactive');
   const receipt=record(r);assert.deepEqual(record(r),receipt);assert.equal(agreement(r).checkout_paid_at,null);
   complete(r);const result=bill(r);assert.equal(result.status,'applied');assert.equal(bill(r).status,'already_applied');
   const c=client(r),a=agreement(r);assert.equal(new Date(a.checkout_paid_at).toISOString(),r.paidAt);
   assert.equal(new Date(c.contract_start_at).toISOString(),generation?r.g.initial_term_start+'T00:00:00.000Z':r.paidAt);
   assert.equal(new Date(c.contract_end_at).toISOString(),generation?r.g.initial_renewal_date+'T00:00:00.000Z':anchoredMonthInstant(r.paidAt,months));
   assert.equal(c.subscription_status,generation?'trialing':'active');assert.equal(c.billing_status,'active');
   const credits=json(`select coalesce(jsonb_agg(to_jsonb(t)),'[]') from client_role_credits t where source_membership_agreement_id=${lit(r.g.id)};`);
   assert.equal(credits.length,role?1:0);if(role)assert.ok(Date.parse(credits[0].created_at)>=Date.parse(r.paidAt));
   const current={...r.s,customer:r.c.stripe_customer_id};
   const projected={id:current.id,customer:current.customer,status:current.status,current_period_end:current.current_period_end,
    cancel_at_period_end:false,cancel_at:null,pause_collection:null};
   if(admin)sql('set role service_role;'+rpc('retail_admin_existing_member_context',{p_agreement:r.g.id,p_source:r.attempt.source,p_receipt:agreement(r).retail_admin_billing_receipt,p_current:projected}));
   else{const i=json(`select to_jsonb(t) from public_purchase_intents t where id=${lit(r.i.id)};`);
    sql('set role service_role;'+rpc('retail_linked_existing_member_context',{p_intent:r.i.id,p_claim:r.claimKey,p_digest:i.billing_apply_digest,p_current:projected}));}
   if(generation){const s=call('read_retail_existing_recurring_source',{p_agreement:r.g.id,p_client:r.c.id});
    const g=call('retail_generation_coverage',{s,clock_:new Date().toISOString()});
    assert.equal(g.contiguous_ordinal,0);assert.equal(new Date(g.contract_start_at).toISOString(),r.g.initial_term_start+'T00:00:00.000Z');
    assert.equal(new Date(g.funded_through).getTime(),r.s.trial_end*1000);}
  }
 });

for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])
test(`native generation recurring prefix and renewal ${plan}/${months}/${payment}`,opts,()=>{
 const r=setup({plan,months,payment});record(r);complete(r);bill(r);
 const s=call('read_retail_existing_recurring_source',{p_agreement:r.g.id,p_client:r.c.id});
 const args={p_agreement:r.g.id,p_client:r.c.id,p_source:s};
 const proof=n=>verifyExistingRetailRecurringFunding(generationCycle(r,s,n,{paidAt:r.paidAt}));
 const save=p=>call('record_retail_existing_paid_period',{...args,p_proof:p});
 const refresh=()=>call('refresh_retail_existing_paid_coverage',{p_agreement:r.g.id,p_client:r.c.id});
 const p1=proof(1),p2=proof(2);assert.equal(save(p2).status,'recorded');
 assert.equal(refresh().contiguous_ordinal,0,'later paid proof cannot bridge an unpaid gap');
 assert.equal(save(p1).status,'recorded');assert.equal(save(p1).status,'already_recorded');
 const coverage=refresh(),span=r.pkg.membership_terms.stripe_recurrence.interval_count;
 assert.equal(coverage.contiguous_ordinal,2);
 assert.equal(new Date(coverage.funded_through).toISOString(),anchoredMonthInstant(r.g.initial_term_start+'T00:00:00.000Z',3*span));
 assert.equal(new Date(coverage.contract_start_at).toISOString(),r.g.initial_term_start+'T00:00:00.000Z','early future-period cash does not advance today’s contract');
 for(const zone of ['UTC','America/Denver','Pacific/Kiritimati']){
  const zoned=json(`set time zone ${lit(zone)};set role service_role;`+
   rpc('refresh_retail_existing_paid_coverage',{p_agreement:r.g.id,p_client:r.c.id}));
  assert.equal(new Date(zoned.contract_start_at).getTime(),Date.parse(coverage.contract_start_at));
  assert.equal(new Date(zoned.contract_end_at).getTime(),Date.parse(coverage.contract_end_at));
  assert.equal(new Date(zoned.funded_through).getTime(),Date.parse(coverage.funded_through));
 }
 for(const bad of [{...p1,invoice_id:'in_FORGED',line_id:s.original_period.initial_platform_invoice_line_id},
  {...p1,invoice_id:'in_FORGED',line_id:s.original_period.recurring_invoice_line_id},
  {...p1,invoice_id:'in_FORGED',line_id:'il_FORGED',payment_intent_id:r.proof.payment_intent_id},
  {...p1,price_id:s.original_period.initial_platform_price_id},
  {...p1,paid_at:anchoredMonthInstant(r.paidAt,1)},
  {...p1,platform_discount_cents:p1.platform_gross_cents,platform_net_cents:0,cash_cents:0}])
  denied('set role service_role;'+rpc('record_retail_existing_paid_period',{...args,p_proof:bad}));
 const readCoverage=call('retail_generation_coverage',{s,clock_:new Date().toISOString()});
 assert.equal(readCoverage.contiguous_ordinal,2);
 assert.equal(new Date(readCoverage.funded_through).toISOString(),new Date(coverage.funded_through).toISOString());
 const change=(action,extra={})=>call('change_retail_existing_renewal',{...args,p_action:action,p_auto_renew:null,
  p_operation:null,p_generation:null,p_observation:null,...extra});
 const requested=change('request',{p_auto_renew:false}),op=requested.operation;
 const cutoff=anchoredMonthInstant(s.original_period.first_collection_at,months-span);
 assert.equal(op.billing_cutoff_at,cutoff);
 const sub={...r.s,canceled_at:null,test_clock:null};
 const before=renewalSubscriptionProjection(sub,s);
 assert.equal(call('retail_existing_renewal_projection_valid',{p:before,s}),true,
  sql("select prosrc from pg_proc where oid='retail_existing_renewal_projection_valid(jsonb,jsonb)'::regprocedure"));
 const claim=change('claim',{p_operation:op.operation_id,p_generation:0,p_observation:before});
 assert.equal(claim.status,'claimed');
 const claimed={p_operation:op.operation_id,p_generation:claim.operation.generation,p_observation:before};
 assert.equal(change('send',claimed).status,'claimed');
 const after={...before,cancel_at:Date.parse(cutoff)/1000,cancel_at_period_end:false};
 assert.equal(change('finish',{...claimed,p_observation:after}).status,'applied');
 assert.equal(client(r).auto_renew,false);assert.equal(client(r).billing_status,'active');
 assert.equal(refresh().billing_status,'active','nonrenewal does not revoke earned access');
 assert.equal(new Date(client(r).contract_end_at).toISOString(),r.g.initial_renewal_date+'T00:00:00.000Z');
 assert.equal(change('read').billing_cutoff_at,cutoff);
 sql(`set role service_role;update clients set subscription_status='canceled' where id=${lit(r.c.id)};`);
 assert.equal(refresh().billing_status,'active','a canceled provider label does not remove earned paid days');
 assert.equal(client(r).subscription_status,'canceled','never fabricate active provider status');
});

for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])
test(`native v3 qualification preserves actual cash and first-year commission ${months}/${payment}`,opts,()=>{
 const r=setup({months,payment,role:true,sales:true});record(r);complete(r);bill(r);
 const q=json(`select to_jsonb(q) from retail_existing_sales_qualifications q where purchase_intent_id=${lit(r.i.id)};`);
 assert.equal(new Date(q.original_start_at).toISOString(),r.paidAt);
 assert.equal(new Date(q.original_term_end_at).toISOString(),anchoredMonthInstant(r.paidAt,months));
 assert.equal(new Date(q.commission_window_end_at).toISOString(),anchoredMonthInstant(r.paidAt,12));
 const s=call('read_retail_existing_recurring_source',{p_agreement:r.g.id,p_client:r.c.id});
 const row=p=>({id:crypto.randomUUID(),purchase_intent_id:r.i.id,rep_user_id:r.rep,provider:'stripe',
  provider_payment_id:p.period?.invoice_id||p.invoice_id,payment_kind:q.payment_kind,currency:'usd',
  payment_success_at:r.paidAt,funds_received_at:r.paidAt,qualification_closed_at:q.qualification_closed_at,
  first_term_start_at:q.original_start_at,first_term_end_at:q.original_term_end_at,gross_membership_cents:p.platform_gross_cents,
  discount_cents:p.platform_discount_cents,provider_fee_cents:101,
  statement_week_start:require('../src/services/salesCommissionPolicy').weekRangeForTimestamp(new Date()).date_from,
  evidence_reference:'SYNTHETIC reviewed bank evidence - no real settlement',reviewed_by_user_id:r.reviewer,
  membership_terms_protocol:'retail_existing_terms_v2',sales_qualification_id:r.i.id,
  policy_version:'retail-existing-terms-v2-commission-v1'});
 const insert=v=>`insert into sales_commission_receipts(${Object.keys(v).join(',')}) values(${Object.values(v).map(lit).join(',')});`;
 const initial=row(r.proof);
 sql('set role service_role;'+insert(initial));
 const earned=json(`select to_jsonb(t) from sales_commission_receipts t where id=${lit(initial.id)};`);
 assert.equal(earned.net_membership_cents,r.proof.platform_gross_cents-101);
 assert.equal(earned.commission_cents,Math.round((r.proof.platform_gross_cents-101)/2));
 const span=r.pkg.membership_terms.stripe_recurrence.interval_count;
 for(const n of [...new Set([1,Math.ceil(12/span)])]){
  const p=verifyExistingRetailRecurringFunding(generationCycle(r,s,n,{paidAt:r.paidAt}));
  assert.equal(call('record_retail_existing_paid_period',{p_agreement:r.g.id,p_client:r.c.id,p_source:s,p_proof:p}).status,'recorded');
  const v=row(p);
  if(n*span>=12)denied('set role service_role;'+insert(v),/outside_original_first_year/);
  else sql('set role service_role;'+insert(v));
 }
 denied('set role service_role;'+insert({...initial,id:crypto.randomUUID(),provider_payment_id:r.proof.payment_intent_id}),/native_commission_/);
});

test('native v3 same cash concurrent delivery records once; foreign source and helper drift fail closed',opts,async()=>{
 const r=setup();record(r);complete(r);bill(r);
 const s=call('read_retail_existing_recurring_source',{p_agreement:r.g.id,p_client:r.c.id});
 const p=verifyExistingRetailRecurringFunding(generationCycle(r,s,1,{paidAt:r.paidAt}));
 const query='set role service_role;'+rpc('record_retail_existing_paid_period',{p_agreement:r.g.id,p_client:r.c.id,p_source:s,p_proof:p});
 const concurrent=()=>new Promise((resolve,reject)=>{
  const child=cp.spawn(bin+'psql',['-h',socket,'-p',port,'-U','postgres','-d',database,'-X','-q','-At','-v','ON_ERROR_STOP=1','-c',query]);
  let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
  child.on('error',reject);child.on('close',code=>code?reject(Error(err)):resolve(JSON.parse(out).status));
 });
 assert.deepEqual((await Promise.all([concurrent(),concurrent()])).sort(),['already_recorded','recorded']);
 const foreign={...s,client_id:crypto.randomUUID()};
 denied('set role service_role;'+rpc('record_retail_existing_paid_period',{p_agreement:r.g.id,p_client:r.c.id,p_source:foreign,p_proof:p}));
 for(const role of ['anon','authenticated'])denied(`set role ${role};`+rpc('retail_generation_coverage',{s,clock_:new Date().toISOString()}),/permission denied/);
 const definition=sql("select pg_get_functiondef('retail_generation_funding_valid(jsonb,jsonb)'::regprocedure)");
 denied('begin;'+definition.replace('declare p jsonb', '-- SYNTHETIC DRIFT\ndeclare p jsonb')+
  'set role service_role;select retail_existing_funding_schema_guard();rollback;',/dependency_drift/);
 assert.equal(call('refresh_retail_existing_paid_coverage',{p_agreement:r.g.id,p_client:r.c.id}).contiguous_ordinal,1);
});

for(const generatedAt of ['2026-01-31T10:00:00.000Z','2028-02-29T10:00:00.000Z'])
for(const payment of ['prepaid','monthly_installments'])test(`native pure date/cash validation ${generatedAt}/${payment}`,opts,()=>{
 // Pure authored vectors, NOT insertion of historical native receipts or
 // proof of a hosted provider event. Actual native writers are tested above.
 const paidAt=new Date(Date.parse(generatedAt)+2*86400000).toISOString();
 const {f,source,funding:u}=generationRecurringFixture('basic',3,payment,true,{generatedAt,paidAt});
 const p={provider_account_id:source.original_provider_account_id,period:u.initialProviderSchedule,
  payment_intent_id:u.paymentIntentId,charge_id:u.chargeId,checkout_created:u.checkoutCreatedEpoch,invoice_created:u.invoiceCreatedEpoch,
  platform_gross_cents:u.platformGrossCents,platform_discount_cents:u.platformDiscountCents,platform_net_cents:u.platformNetCents,
  role_gross_cents:u.roleGrossCents,role_discount_cents:u.roleDiscountCents,role_net_cents:u.roleNetCents,
  tax_cents:u.taxCents,cash_cents:u.cashCents};
 const s={...f.g.checkout_attempt_source,signed_at:f.g.signed_at,agreement_expires_at:f.g.agreement_expires_at,
  intent:{expires_at:f.i.expires_at}},w={version:'retail_existing_funding_v1',proof:p,recorded_at:paidAt.replace('.000Z','.000000Z')};
 assert.equal(call('retail_generation_funding_valid',{w,s}),true);
 for(const change of [b=>b.provider_period_start=b.provider_trial_start,b=>b.initial_term_start=paidAt.slice(0,10),
  b=>b.provider_trial_end++,b=>b.version='retail_initial_provider_period_v1']){
  const bad=structuredClone(w);change(bad.proof.period);assert.equal(call('retail_generation_funding_valid',{w:bad,s}),false);
 }
 for(const n of [1,2,3,12]){
  const proof=verifyExistingRetailRecurringFunding(generationCycle(f,source,n));
  assert.equal(call('retail_existing_period_proof_valid',{p:proof,s:source}),true);
  assert.equal(call('retail_existing_period_proof_valid',{p:{...proof,provider_period_start:proof.provider_period_start+86400},s:source}),false);
 }
});

for(const admin of [false,true])test(`application funding/billing adapter + actual native database admin=${admin}`,opts,async()=>{
 const r=setup({plan:'pro',months:6,payment:'monthly_installments',role:true,admin}),db=nativeDb(),stripe=authoredSdk(r);
 const options={db,stripe,agreementId:r.g.id,intentId:admin?null:r.i.id,claimKey:r.claimKey,
  eventSessionId:r.cs.id,eventSubscriptionId:r.s.id,eventLivemode:false};
 const {recordExistingRetailFunding}=require('../src/services/existingRetailFundingReceipt');
 const recorded=await recordExistingRetailFunding(options);
 assert.equal(recorded.receipt.proof.period.version,'retail_generation_initial_schedule_v1');
 assert.equal(agreement(r).checkout_paid_at,null);
 complete(r);initial(r); // Load the existing pure client builder with no hosted client.
 const apply=admin?require('../src/services/existingRetailAdminBillingAdapter').applyExistingRetailAdminBilling:
  require('../src/services/existingRetailLinkedBillingAdapter').applyExistingRetailLinkedBilling;
 const result=await apply(options);assert.equal(result.status,'applied');
 assert.equal((await apply(options)).status,'already_applied');
 assert.equal(client(r).billing_status,'active');assert.equal(client(r).subscription_status,'trialing');
 assert.equal(new Date(client(r).contract_start_at).toISOString(),r.g.initial_term_start+'T00:00:00.000Z');
 assert.equal(sql(`select count(*) from client_role_credits where source_membership_agreement_id=${lit(r.g.id)};`),'1');
 const prepare=admin?require('../src/services/existingRetailAdminMemberTail').prepareExistingRetailAdminMemberTail:
  require('../src/services/existingRetailLinkedMemberTail').prepareExistingRetailLinkedMemberTail;
 const tail=await prepare(options);await tail.assertReady();
 const userId=crypto.randomUUID();
 sql(`insert into auth.users(id,email) values(${lit(userId)},${lit(agreement(r).admin_email)});`);
 assert.equal((await tail.ensureMember({userId,name:'Synthetic Buyer'})).status,'created');
 assert.equal((await tail.ensureMember({userId,name:'Synthetic Buyer'})).status,'existing');
 assert.equal(sql(`select count(*) from client_members where client_id=${lit(r.c.id)} and user_id=${lit(userId)};`),'1');
});

for(const cohort of ['v1','v2','v3'])for(const payment of ['prepaid','monthly_installments'])for(const admin of [false,true])
test(`full rendered agreement traverses original native billing and member tail ${cohort}/${payment}/admin=${admin}`,opts,async()=>{
 const r=setup({plan:'basic',months:6,payment,role:true,admin,generation:cohort==='v3',
  legacyVersion:cohort==='v2'?STRIPE_RECURRING_OFFER_VERSION:undefined,largeContract:true}),db=nativeDb(),stripe=authoredSdk(r);
 const options={db,stripe,agreementId:r.g.id,intentId:admin?null:r.i.id,claimKey:r.claimKey,
  eventSessionId:r.cs.id,eventSubscriptionId:r.s.id,eventLivemode:false};
 await require('../src/services/existingRetailFundingReceipt').recordExistingRetailFunding(options);
 complete(r);initial(r);
 const original=agreement(r),prepare=admin?require('../src/services/existingRetailAdminMemberTail').prepareExistingRetailAdminMemberTail
  :require('../src/services/existingRetailLinkedMemberTail').prepareExistingRetailLinkedMemberTail;
 const tail=await prepare(options);await tail.assertReady();
 const userId=crypto.randomUUID();sql(`insert into auth.users(id,email) values(${lit(userId)},${lit(original.admin_email)});`);
 assert.equal((await tail.ensureMember({userId,name:'Synthetic Buyer'})).status,'created');
 assert.equal((await tail.ensureMember({userId,name:'Synthetic Buyer'})).status,'existing');
 const after=agreement(r);assert.deepEqual(after.template_snapshot,original.template_snapshot);
 assert.deepEqual(after.checkout_attempt_source,original.checkout_attempt_source);
 assert.equal(new Date(after.checkout_paid_at).toISOString(),r.paidAt);
 assert.equal(client(r).billing_status,'active');
 assert.equal(sql(`select count(*) from client_role_credits where source_membership_agreement_id=${lit(r.g.id)};`),'1');
 assert.equal(sql(`select count(*) from client_members where client_id=${lit(r.c.id)} and user_id=${lit(userId)};`),'1');
});

const replacementOpts={skip:!enabled||process.env.RETAIL_GENERATION_REPLACEMENT_COMPAT!=='true'};
for(const cohort of ['v1','v2','v3'])for(const payment of ['prepaid','monthly_installments'])
test(`replacement application/native compatibility ${cohort}/${payment}`,replacementOpts,async()=>{
 const r=setup({generation:cohort==='v3',legacyVersion:cohort==='v2'?STRIPE_RECURRING_OFFER_VERSION:undefined,
  payment,role:true,replacement:true,largeContract:true}),db=nativeDb(),stripe=authoredSdk(r);
 const options={db,stripe,agreementId:r.g.id,intentId:r.i.id,claimKey:r.claimKey,
  eventSessionId:r.cs.id,eventSubscriptionId:r.s.id,eventLivemode:false};
 let deletes=0;const old={object:'subscription',id:r.replacementId,customer:r.c.stripe_customer_id,currency:'usd',
  livemode:false,status:'active',canceled_at:null};
 stripe.subscriptions.retrieve=async id=>structuredClone(id===old.id?old:r.s);
 stripe.subscriptions.cancel=async(id,body)=>{assert.equal(id,old.id);assert.deepEqual(body,{invoice_now:false,prorate:false});
  deletes++;old.status='canceled';old.canceled_at=Math.floor(Date.now()/1000);
  if(r.generation&&payment==='monthly_installments')throw Error('SYNTHETIC lost DELETE acknowledgment');
  return structuredClone(old);};
 // Real DB admission and existing app orchestration; SDK DELETE is authored
 // only and must NEVER reach a provider (external preload blocks networking).
 await require('../src/services/existingRetailFundingReceipt').recordExistingRetailFunding(options);
 complete(r);initial(r);
 const {executeExistingRetailReplacementCancellation:cancel}=require('../src/services/existingRetailReplacementCancellation');
 if(r.generation){const original=structuredClone(r.s);
  for(const patch of [{current_period_start:r.s.current_period_start+1},{trial_start:r.s.trial_start+1},
   {trial_end:r.s.trial_end+1},{billing_cycle_anchor:r.s.billing_cycle_anchor+1},{status:'active'},{status:'canceled'},
   {current_period_end:r.s.current_period_end+1},{customer:'cus_FOREIGN'}]){
   Object.assign(r.s,patch);await assert.rejects(cancel(options));
   Object.assign(r.s,structuredClone(original));assert.equal(deletes,0);
  }
  await assert.rejects(cancel({...options,claimKey:'SYNTHETIC_WRONG_CLAIM_000000000000000000'}));assert.equal(deletes,0);
  assert.equal(sql(`select count(*) from private_retail_replacement.reservations where agreement_id=${lit(r.g.id)};`),'0');
 }
 try{await require('../src/services/existingRetailReplacementPreflight').prepareExistingRetailReplacement(options);}
 catch(error){throw Error('SYNTHETIC preflight diagnostic '+error.code+' '+JSON.stringify(db.rpcErrors));}
 assert.equal((await cancel(options)).status,'observed');
 const apply=require('../src/services/existingRetailLinkedBillingAdapter').applyExistingRetailLinkedBilling;
 assert.equal((await apply(options)).status,'applied');
 assert.equal((await cancel(options)).status,'existing');assert.equal(deletes,1);
 assert.equal((await apply(options)).status,'already_applied');
 assert.equal(client(r).stripe_subscription_id,r.s.id);
 assert.equal(new Date(client(r).contract_start_at).toISOString(),r.generation?r.g.initial_term_start+'T00:00:00.000Z':r.paidAt);
 assert.equal(sql(`select count(*) from client_role_credits where source_membership_agreement_id=${lit(r.g.id)};`),'1');
});
