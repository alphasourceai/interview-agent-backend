'use strict';
// Synthetic scalar/native fixture on the EMPTY actual QA schema. No Stripe,
// Auth, email, hosted access or claim that these authored observations are cash.
const crypto=require('node:crypto');
const {prepareEnterprisePoolTerms}=require('../../src/services/enterprisePoolSnapshot');
const {anchoredMonthInstant}=require('../../src/services/membershipOffers');
const {proveEnterprisePoolPayment}=require('../../src/services/enterprisePoolPaymentProof');
const paidFixture=require('./enterprise-pool-payment-fixture');
const lit=v=>v==null?'null':typeof v==='object'?`'${JSON.stringify(v).replaceAll("'","''")}'::jsonb`:
 typeof v==='boolean'||typeof v==='number'?String(v):`'${String(v).replaceAll("'","''")}'`;
module.exports=async function fixture(sql,{cadence='monthly',ordinal=1,initialPeriodSeconds=86400}={}){
 const id=crypto.randomUUID(),client=crypto.randomUUID(),attempt=crypto.randomUUID(),suffix=id.replaceAll('-','');
 const customer='cus_PERIOD_'+suffix,token=crypto.createHash('sha256').update(id).digest('hex');
 const start=sql("select to_char(current_date,'YYYY-MM-DD')"),end=sql("select to_char(current_date+interval '1 year','YYYY-MM-DD')");
 const values=prepareEnterprisePoolTerms({membership_tier:'enterprise',billing_model:'usage',billing_option:cadence,platform_fee:'999.99',
  per_role_fee:'0',included_interviews_per_role:'0',additional_interview_fee:'0',pool_quantity:30,usage_interview_fee_cents:2500,
  max_interview_minutes:'20',scored_question_count:'5',term_start_basis:'agreement_date',initial_term_start:start,initial_renewal_date:end});
 const unsigned={values,rendered_html:'SYNTHETIC ONLY'};
 sql(`set role service_role;insert into clients(id,name,email,stripe_customer_id) values(${lit(client)},'Synthetic Period','period@example.invalid',${lit(customer)});
  insert into membership_agreements(id,client_id,status,client_legal_name,primary_admin_name,admin_email,membership_tier,initial_term_start,
   initial_renewal_date,billing_option,template_snapshot,signer_token_hash,signer_token_expires_at,agreement_expires_at,draft_pdf_path)
  values(${lit(id)},${lit(client)},'draft','SYNTHETIC','SYNTHETIC OWNER','period@example.invalid','enterprise',${lit(start)},${lit(end)},
   ${lit(cadence)},${lit(unsigned)},${lit(token)},clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day','synthetic/preview.pdf');
  update membership_agreements set status='sent' where id=${lit(id)};`);
 const signed=sql(`set role service_role;select enterprise_v2_execution_clock(${lit(id)},${lit(token)})`),prefix=`enterprise-v2/${id}/attempts/${attempt}/`;
 const execution={version:'enterprise_execution_v2',attempt_id:attempt,signed_at:signed,signer_typed_name:'SYNTHETIC OWNER',signer_accepted:true,
  signature_sha256:'a'.repeat(64),signature_size:100,signature_image_path:prefix+'signature.png',pixels_sha256:'b'.repeat(64),width:10,height:10,
  encoding:'png_rgba_v1',executed_pdf_path:prefix+'executed.pdf',executed_pdf_sha256:'c'.repeat(64),executed_pdf_size:1000,signer_ip:null,signer_user_agent:'SYNTHETIC'};
 sql(`set role service_role;insert into enterprise_v2_execution_seals(agreement_id,attempt_id,token_hash,source_snapshot,execution,signed_at)
  values(${[id,attempt,token,unsigned,execution,signed].map(lit).join(',')});`);
 const snapshot={...unsigned,execution},config={public_backend_base:'https://api.example.invalid',public_sign_base:'https://site.example.invalid'};
 const pending=JSON.parse(sql(`set role service_role;select prepare_enterprise_existing_checkout(${[id,client,snapshot,customer,false,null,config].map(lit).join(',')});`));
 const prices={platform_price_id:'price_PLATFORM_'+suffix,pool_price_id:'price_POOL_'+suffix};
 sql(`set role service_role;select pin_enterprise_existing_checkout_prices(${[id,client,pending.source,prices].map(lit).join(',')});
  select pin_enterprise_existing_checkout_session(${[id,client,pending.source,prices,'cs_PERIOD_'+suffix].map(lit).join(',')});
  insert into billing_customers(client_id,name,primary_contact_email,stripe_customer_id) values(${lit(client)},'SYNTHETIC','period@example.invalid',${lit(customer)});`);
 await new Promise(r=>setTimeout(r,1100)); // actual provider-second observation, not a caller DB clock
 const a=JSON.parse(sql(`select to_jsonb(a) from membership_agreements a where id=${lit(id)}`));
 const now=Number(sql('select floor(extract(epoch from clock_timestamp()))'));
 const funding={...proveEnterprisePoolPayment(paidFixture({platformCents:99999,platformInterval:cadence==='annual'?'year':'month'})),
  pool_id:a.enterprise_checkout_pool_id,client_id:client,provider_account_id:'acct_PERIOD',customer_id:customer,
  checkout_session_id:a.checkout_session_id,subscription_id:'sub_PERIOD_'+suffix,invoice_id:'in_INITIAL_'+suffix,
  payment_intent_id:'pi_INITIAL_'+suffix,charge_id:'ch_INITIAL_'+suffix,platform_price_id:prices.platform_price_id,pool_price_id:prices.pool_price_id,
  payment_success_at:new Date(now*1000).toISOString()};
 const saved=JSON.parse(sql(`set role service_role;select record_enterprise_existing_funding(${[id,client,pending.source,prices,funding].map(lit).join(',')});`));
 const sub={id:funding.subscription_id,customer,status:'active',current_period_end:now+initialPeriodSeconds,cancel_at_period_end:false};
 const billing=JSON.parse(sql(`set role service_role;select apply_enterprise_existing_billing(${[id,client,pending.source,prices,saved,sub].map(lit).join(',')});`));
 sql(`set role service_role;select complete_enterprise_existing_payment(${[id,client,billing].map(lit).join(',')});`);
 const span=cadence==='annual'?12:1,anchor=new Date(sub.current_period_end*1000).toISOString();
 const proof={version:'enterprise_existing_platform_period_proof_v1',agreement_id:id,client_id:client,provider_account_id:funding.provider_account_id,
  livemode:false,currency:'usd',invoice_id:'in_CYCLE_'+suffix,line_id:'il_CYCLE_'+suffix,subscription_id:funding.subscription_id,
  subscription_item_id:funding.platform_item_id,customer_id:customer,price_id:prices.platform_price_id,ordinal,
  provider_period_start:Date.parse(anchoredMonthInstant(anchor,(ordinal-1)*span))/1000,
  provider_period_end:Date.parse(anchoredMonthInstant(anchor,ordinal*span))/1000,platform_gross_cents:99999,platform_discount_cents:0,
  platform_net_cents:99999,tax_cents:0,cash_cents:99999,original_paid_at:funding.payment_success_at,paid_at:funding.payment_success_at,
  payment_intent_id:'pi_CYCLE_'+suffix,charge_id:'ch_CYCLE_'+suffix,provider_effect_authorized:false,paid_access_authorized:false,payroll_authorized:false};
 return{id,client,customer,billing,funding,proof};
};
