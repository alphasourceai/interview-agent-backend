'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {generationRecurringFixture,generationCycle}=require('./fixtures/generation-retail-recurring-funding-fixture');
const {verifyExistingRetailRecurringFunding:verify}=require('../src/services/existingRetailCheckoutFunding');
const {canonicalExistingRetailCommissionPayment:commission}=require('../src/services/existingRetailCommissionPaymentProof');
const {readExistingRetailRecurringSource}=require('../src/services/existingRetailRecurringSource');
const {renewalBillingCutoff,renewalSubscriptionProjection,requestExistingRetailRenewal,readExistingRetailRenewalSummary}=require('../src/services/existingRetailRenewalPreference');
const {anchoredMonthInstant}=require('../src/services/membershipOffers');
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
test(`generation recurring cash and commission ${plan}/${months}/${payment}/role=${role}`,async()=>{
 const {f,source,initialReceipt}=generationRecurringFixture(plan,months,payment,role),span=f.offer.stripe_recurrence.interval_count;
 const before=structuredClone(source);
 assert.equal(commission({source,initialReceipt,periodRows:[],paymentId:f.pi.id}).payment_success_at,source.original_period.paid_at);
 const db={rpc:async()=>({data:source,error:null})};
 assert.deepEqual(structuredClone(await readExistingRetailRecurringSource({db,agreementId:source.agreement_id,clientId:source.client_id})),source);
 for(const ordinal of [1,2,11,12]){
  const input=generationCycle(f,source,ordinal),proof=verify(input);
  assert.equal(proof.ordinal,ordinal);assert.equal(proof.price_id,source.original_period.recurring_platform_price_id);
  const periodRows=[{id:'synthetic-'+ordinal,stripe_invoice_id:proof.invoice_id,
   retail_period_receipt:{version:'retail_existing_paid_period_receipt_v1',source,proof}}];
  const invoke=()=>commission({source,initialReceipt,periodRows,paymentId:proof.invoice_id});
  if(ordinal*span>=12||Date.parse(proof.paid_at)>=Date.parse(anchoredMonthInstant(source.original_period.paid_at,12)))
   assert.throws(invoke,{code:'outside_original_first_year'});
  else assert.equal(invoke().gross_membership_cents,f.offer.platform_payment_cents);
 }
 assert.deepEqual(source,before);
});
test('generation recurring rejects zero cash, wrong recurring price, both initial line IDs and altered C/B clocks',()=>{
 const {f,source}=generationRecurringFixture(),good=generationCycle(f,source);
 for(const mutate of [x=>x.invoiceLines.data[0].price.id=x.source.original_period.initial_platform_price_id,
  x=>x.invoiceLines.data[0].id=x.source.original_period.initial_platform_invoice_line_id,
  x=>x.invoiceLines.data[0].id=x.source.original_period.recurring_invoice_line_id,
  x=>x.cycle.observed_generation_period_start='2026-04-29T00:00:00.000Z',
  x=>x.source.original_period.provider_trial_end++,x=>x.source.original_period.billing_cycle_anchor++,
  x=>x.source.original_period.initial_term_start='2026-02-02']){
  const bad=structuredClone(good);mutate(bad);assert.throws(()=>verify(bad));
 }
 assert.throws(()=>verify(generationCycle(f,source,1,{discount:f.offer.platform_payment_cents})));
 assert.throws(()=>verify(generationCycle(f,source,1,{discount:1})),'prepaid recurring platform cannot be silently discounted');
});
for(const payment of ['prepaid','monthly_installments'])test(`generation ${payment} cancellation arms native next-term boundary with no collector`,async()=>{
 const generatedAt=new Date(Date.now()-3*3600000).toISOString(),paidAt=new Date(Math.floor(Date.now()/1000)*1000).toISOString();
 const {f,source}=generationRecurringFixture('basic',3,payment,false,{generatedAt,paidAt}),writes=[];
 const cutoff=renewalBillingCutoff(source),sub={...f.s,canceled_at:null,test_clock:null};let op=null;
 const db={async rpc(name,a){
  if(name==='read_retail_existing_recurring_source')return{data:source,error:null};
  assert.equal(name,'change_retail_existing_renewal');
  if(a.p_action==='request')op={operation_id:randomUUID(),source,generation:0,status:'waiting',requested_auto_renew:a.p_auto_renew,billing_cutoff_at:cutoff};
  if(a.p_action==='claim'){op.generation++;op.status='claimed';op.observation=a.p_observation;}
  if(a.p_action==='finish')op.status='applied';
  return{data:{status:op?.status||'none',operation:op,billing_cutoff_at:cutoff},error:null};
 }};
 f.sdk.subscriptions={retrieve:async()=>structuredClone(sub),update:async(id,body,options)=>{
  writes.push({id,body,options});sub.cancel_at=body.cancel_at;return structuredClone(sub);
 }};
 f.sdk.invoices.list=async()=>({object:'list',has_more:false,data:[structuredClone(f.inv)]});
 f.sdk.invoiceItems={list:async()=>({object:'list',has_more:false,data:[]})};
 const input={db,stripe:f.sdk,agreementId:source.agreement_id,clientId:source.client_id,effectsEnabled:true};
 assert.equal(renewalSubscriptionProjection(sub,source).status,'trialing');
 assert.equal((await requestExistingRetailRenewal({...input,autoRenew:false})).status,'applied');
 assert.equal(writes.length,1);assert.deepEqual(writes[0].body,{cancel_at:Date.parse(cutoff)/1000,proration_behavior:'none'});
 assert.equal((await readExistingRetailRenewalSummary(input)).stripe_renewal_billing_cutoff_at,cutoff);
 assert.equal(source.original_period.paid_at,paidAt);
});
test('January31 cancellation cutoff is native April28 monthly, not contractual April30 or next installment',()=>{
 const {source}=generationRecurringFixture('basic',3,'monthly_installments');
 assert.equal(renewalBillingCutoff(source,Date.parse('2026-02-10T10:00:00Z')),'2026-04-28T00:00:00.000Z');
});
