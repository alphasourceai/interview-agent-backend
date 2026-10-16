'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const dbPath=require.resolve('../src/clients/supabase');
require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{supabaseAdmin:{from(){throw Error('unscoped test DB forbidden');}}}};
const fixture=require('./helpers/enterprise-existing-funding-fixture');
const {classifyExistingEnterprisePaymentEvent:classify}=require('../src/services/existingEnterprisePaymentWebhook');
function event(f,type,object={}){return{id:'evt_SYNTHETIC',type,livemode:false,data:{object}};}
function ready(){
 const f=fixture(),a=f.a,cs=f.p.checkout,sub=f.p.subscription;
 Object.assign(cs,{status:'complete',payment_status:'paid',livemode:false,subscription:sub.id,customer:f.client.stripe_customer_id});
 Object.assign(sub,{id:'sub_synthetic',object:'subscription',customer:f.client.stripe_customer_id,metadata:structuredClone(cs.metadata)});
 f.stripe.checkout.sessions.retrieve=async id=>{assert.equal(id,a.checkout_session_id);return structuredClone(cs);};
 f.stripe.subscriptions.retrieve=async id=>{assert.equal(id,sub.id);return structuredClone(sub);};
 return f;
}
function checkoutEvent(f,{eventStatus='complete',eventPayment='paid'}={}){return event(f,'checkout.session.completed',{
 id:f.a.checkout_session_id,object:'checkout.session',mode:'subscription',status:eventStatus,payment_status:eventPayment,
 customer:f.client.stripe_customer_id,subscription:f.p.subscription.id,metadata:structuredClone(f.p.checkout.metadata)});}
test('classifies settled existing agreement Checkout from native pin and fresh provider graph',async()=>{
 const f=ready(),r=await classify({db:f.db,stripe:f.stripe,event:checkoutEvent(f)});
 assert.equal(r.action,'initial_paid');assert.equal(r.agreementId,f.a.id);assert.equal(r.requiresReentry,true);
});
test('holds conflicting stale event-unpaid versus fresh SDK-paid Checkout for retry',async()=>{
 const f=ready(),r=await classify({db:f.db,stripe:f.stripe,event:checkoutEvent(f,{eventPayment:'unpaid'})});
 assert.equal(r.action,'held');assert.equal(r.requiresReentry,true);
});
test('holds conflicting event-paid versus fresh SDK-unpaid Checkout for retry',async()=>{
 const f=ready();f.p.checkout.payment_status='unpaid';
 const r=await classify({db:f.db,stripe:f.stripe,event:checkoutEvent(f)});
 assert.equal(r.action,'held');assert.equal(r.requiresReentry,true);
});
test('holds conflicting completed event versus non-complete fresh Checkout for retry',async()=>{
 const f=ready();f.p.checkout.status='open';
 const r=await classify({db:f.db,stripe:f.stripe,event:checkoutEvent(f)});
 assert.equal(r.action,'held');assert.equal(r.requiresReentry,true);
});
test('classifies initial invoice.created with missing metadata through unique customer and pinned Checkout',async()=>{
 const f=ready(),r=await classify({db:f.db,stripe:f.stripe,event:event(f,'invoice.created',{
  id:'in_synthetic',object:'invoice',billing_reason:'subscription_create',status:'draft',amount_paid:0,
  customer:f.client.stripe_customer_id,subscription:f.p.subscription.id,metadata:{}})});
 assert.equal(r.action,'initial_noop');assert.equal(r.sessionId,f.a.checkout_session_id);
});
for(const type of ['invoice.payment_succeeded','invoice.paid'])test(`${type} initial uses the same full native activation path, never empty ACK`,async()=>{
 const f=ready(),raw={id:'in_synthetic',object:'invoice',billing_reason:'subscription_create',status:'paid',amount_paid:85192,
  customer:f.client.stripe_customer_id,subscription:f.p.subscription.id,metadata:{}};
 const r=await classify({db:f.db,stripe:f.stripe,event:event(f,type,raw)});
 assert.equal(r.action,'initial_paid');assert.equal(r.requiresReentry,true);
 for(const patch of [{amount_paid:'85192'},{amount_paid:0},{paid:false},{status:'open'}]){
  assert.equal((await classify({db:f.db,stripe:f.stripe,event:event(f,type,{...raw,...patch})})).action,'held');
 }
});
test('marked Enterprise cycle invoice.paid remains explicitly retryable until platform receipt writer exists',async()=>{
 const f=ready(),r=await classify({db:f.db,stripe:f.stripe,event:event(f,'invoice.paid',{
  id:'in_synthetic_cycle',object:'invoice',billing_reason:'subscription_cycle',status:'paid',amount_paid:30000,
  customer:f.client.stripe_customer_id,subscription:f.p.subscription.id,metadata:{}})});
 assert.equal(r.action,'held');assert.equal(r.requiresReentry,true);
});
test('classifies failed delayed Checkout as a no-write event and does not trust the event metadata alone',async()=>{
 const f=ready();f.p.checkout.payment_status='unpaid';
 const r=await classify({db:f.db,stripe:f.stripe,event:event(f,'checkout.session.async_payment_failed',{
  id:f.a.checkout_session_id,object:'checkout.session',mode:'subscription',status:'complete',payment_status:'unpaid',
  customer:f.client.stripe_customer_id,subscription:f.p.subscription.id,metadata:structuredClone(f.p.checkout.metadata)})});
 assert.equal(r.action,'pending_noop');
});
test('holds later marked subscription lifecycle events for explicit retry',async()=>{
 const f=ready(),r=await classify({db:f.db,stripe:f.stripe,event:event(f,'customer.subscription.updated',{
  id:f.p.subscription.id,object:'subscription',customer:f.client.stripe_customer_id,metadata:{}})});
 assert.equal(r.action,'held');assert.equal(r.requiresReentry,true);
});
test('unmarked legacy events preserve the existing classifier fallback',async()=>{
 const f=require('./helpers/enterprise-existing-checkout-fixture').fixture(),r=await classify({db:f.db,stripe:f.stripe,event:event(f,'invoice.created',{
  id:'in_legacy',object:'invoice',customer:f.client.stripe_customer_id,subscription:'sub_legacy',metadata:{}})});
 assert.equal(r,null);
});
test('metadata and pinned session disagreement fails closed for a marked source',async()=>{
 const f=ready();await assert.rejects(classify({db:f.db,stripe:f.stripe,event:event(f,'checkout.session.completed',{
  id:'cs_OTHER',object:'checkout.session',mode:'subscription',status:'complete',payment_status:'paid',
  customer:f.client.stripe_customer_id,subscription:f.p.subscription.id,
  metadata:{source:'agreement_checkout',agreement_id:f.a.id}})}),{status:503});
});
test('native version metadata cannot fall back when every native row marker is missing',async()=>{
 const f=ready();Object.assign(f.a,{enterprise_checkout_source:null,enterprise_checkout_pool_id:null,enterprise_checkout_prices:null,
  enterprise_funding_receipt:null,enterprise_billing_receipt:null});
 await assert.rejects(classify({db:f.db,stripe:f.stripe,event:checkoutEvent(f)}),{status:503});
});
async function withUsage(run,{type='invoice.payment_succeeded',processed=false,leafStatus='paid'}={}){
 const f=ready(),calls=[];Object.assign(f.client,{parent_client_id:null,archived_at:null});
 const p=require('../src/services/enterpriseExistingUsageInvoiceProof');
 const native=require('../src/services/enterpriseExistingUsageReservation');
 const oldRead=native.readEnterpriseExistingUsageProvider,oldProof=p.verifyUsageInvoicePaid;
 const b={owner_id:f.client.id,agreement_id:f.a.id,batch_id:randomUUID(),account_id:'acct_SYNTHETIC',livemode:false,
  customer_id:f.client.stripe_customer_id,subscription_id:f.p.subscription.id,total_cents:2500};
 const cash={invoice_id:'in_USAGE',payment_intent_id:'pi_USAGE',charge_id:'ch_USAGE',amount_cents:2500,
  paid_at:1793491203,provider_effect_authorized:false,paid_access_authorized:false,payroll_authorized:false};
 const request=p.usageInvoicePayRequest(b,cash.invoice_id,'pm_USAGE');
 const state={status:'read',binding:b,observed_at:'2026-11-01T00:00:10Z',batch:{id:b.batch_id,owner_id:b.owner_id,
  agreement_id:b.agreement_id,provider_operation:{status:leafStatus,invoice_id:cash.invoice_id,operations:{pay:{proof:cash,request}}}}};
 const invoice={object:'invoice',id:cash.invoice_id,customer:b.customer_id,livemode:false,currency:'usd',subscription:null,
  status:'paid',amount_paid:2500,payment_intent:cash.payment_intent_id,charge:cash.charge_id};
 const raw={...invoice,metadata:{client_id:b.owner_id,source:'usage_billing',enterprise_usage_batch_id:b.batch_id}};
 if(type==='invoice.created'){raw.status='draft';raw.amount_paid=0;}
 if(type==='invoice.payment_failed'){raw.status='open';raw.amount_paid=0;}
 const e={id:'evt_USAGE',type,livemode:false,data:{object:raw}};
 f.db.tables.billing_events=processed?[{stripe_event_id:e.id,processed_ok:true}]:[];
 let reads=0;
 native.readEnterpriseExistingUsageProvider=async args=>{
  assert.equal(args.db,f.db);assert.equal(args.billingClientId,b.owner_id);assert.equal(args.batchId,b.batch_id);
  calls.push('native_read');reads++;if(f.onNativeRead)f.onNativeRead(reads,state);return structuredClone(state);
 };
 p.verifyUsageInvoicePaid=args=>{
  calls.push('paid_proof');assert.equal(args.paymentMethodId,'pm_USAGE');assert.deepEqual(args.refunds,[]);
  return{...cash,payment_intent_id:args.paymentIntent.id,charge_id:args.charge.id,amount_cents:args.invoice.amount_paid};
 };
 const list=data=>({object:'list',has_more:false,data:structuredClone(data)});
 const account={object:'account',id:b.account_id};
 const stripe={getApiField:()=> '2023-10-16',accounts:{retrieve:async()=>{calls.push('account_get');return structuredClone(account);}},
  invoices:{list:async()=>{calls.push('invoice_list');return list([invoice]);},
   retrieve:async id=>{calls.push('invoice_get');assert.equal(id,cash.invoice_id);return structuredClone(invoice);},
   listLineItems:async()=>{calls.push('lines_list');return list([]);}},
  invoiceItems:{list:async()=>{calls.push('items_list');return list([]);}},
  paymentIntents:{retrieve:async id=>{calls.push('pi_get');assert.equal(id,invoice.payment_intent);return{id};}},
  charges:{retrieve:async id=>{calls.push('charge_get');assert.equal(id,invoice.charge);return{id};}},
  refunds:{list:async()=>{calls.push('refunds_list');return list([]);}}};
 const before=structuredClone(f.db.tables);
 try{await run({f,b,cash,state,invoice,e,raw,stripe,calls,account,before,
  classify:()=>classify({db:f.db,stripe,event:e})});}
 finally{native.readEnterpriseExistingUsageProvider=oldRead;p.verifyUsageInvoicePaid=oldProof;}
}
for(const type of ['invoice.payment_succeeded','invoice.paid'])for(const paid of ['absent',true])
test(`usage ${type} paid leaf ACK allows stored paid ${paid} without any writer`,async()=>withUsage(async x=>{
 if(paid!== 'absent')x.raw.paid=paid;const r=await x.classify();
 assert.equal(r.action,'usage_paid_ack');assert.equal(r.requiresReentry,true);assert.equal(r.clientId,x.b.owner_id);
 assert.equal(x.calls.filter(v=>v==='native_read').length,2);assert.ok(x.calls.includes('paid_proof'));
 assert.deepEqual(x.f.db.tables,x.before);
},{type}));
for(const type of ['invoice.created','invoice.payment_failed'])test(`usage stale ${type} ACK only after same paid proof`,async()=>withUsage(async x=>{
 const r=await x.classify();assert.equal(r.action,'usage_stale_ack');assert.equal(r.requiresReentry,true);
 assert.ok(x.calls.includes('paid_proof'));assert.deepEqual(x.f.db.tables,x.before);
},{type}));
for(const type of ['invoice.created','invoice.payment_failed','invoice.paid'])test(`usage ${type} unpaid native leaf stays retryable without provider reads`,async()=>withUsage(async x=>{
 const r=await x.classify();assert.equal(r.action,'usage_held');assert.equal(r.requiresReentry,true);
 assert.deepEqual(x.calls,['native_read']);assert.deepEqual(x.f.db.tables,x.before);
},{type,leafStatus:'pending'}));
for(const [label,change]of [
 ['parent owner',x=>{x.f.client.parent_client_id=randomUUID();}],['archived owner',x=>{x.f.client.archived_at='2026-11-01T00:00:00Z';}],
 ['owner metadata',x=>{x.raw.metadata.client_id=randomUUID();}],['bad batch',x=>{x.raw.metadata.enterprise_usage_batch_id='not-uuid';}],
 ['wrong source',x=>{x.raw.metadata.source='agreement_checkout';}],['extra metadata',x=>{x.raw.metadata.extra='not-accepted';}],
 ['foreign invoice',x=>{x.raw.id='in_OTHER';}],['mode',x=>{x.e.livemode=true;}],['currency',x=>{x.raw.currency='eur';}],
 ['amount',x=>{x.raw.amount_paid=2499;}],['false paid',x=>{x.raw.paid=false;}],['undefined paid',x=>{x.raw.paid=undefined;}],
 ['foreign account',x=>{x.account.id='acct_OTHER';}],['foreign PI',x=>{x.invoice.payment_intent='pi_OTHER';}],
 ['foreign charge',x=>{x.invoice.charge='ch_OTHER';}],['provider amount',x=>{x.invoice.amount_paid=1;}],
 ['provider source',x=>{x.raw.subscription='sub_OTHER';}],
 ['missing paid clock',x=>{delete x.state.batch.provider_operation.operations.pay.proof.paid_at;}],
 ['future paid clock',x=>{x.state.batch.provider_operation.operations.pay.proof.paid_at=1793491211;}],
 ['extra cash field',x=>{x.state.batch.provider_operation.operations.pay.proof.extra=true;}],
 ['changed paid leaf',x=>{x.f.onNativeRead=(n,s)=>{if(n===2)s.batch.provider_operation.operations.pay.proof.amount_cents=1;};}]
])test(`usage acknowledgement denies ${label} rather than falling through`,async()=>withUsage(async x=>{
 change(x);const before=structuredClone(x.f.db.tables);
 await assert.rejects(x.classify(),{code:'enterprise_usage_event_unverified',status:503});
 assert.deepEqual(x.f.db.tables,before);
}));
test('processed usage replay rechecks native scope/account but not invoice or proof',async()=>withUsage(async x=>{
 const r=await x.classify();assert.equal(r.action,'usage_paid_ack');assert.equal(r.requiresReentry,true);
 assert.deepEqual(x.calls,['native_read','account_get','native_read']);assert.deepEqual(x.f.db.tables,x.before);
},{processed:true}));
test('processed usage replay with regressed unpaid leaf fails scope and does not downgrade event',async()=>withUsage(async x=>{
 await assert.rejects(x.classify(),{code:'enterprise_usage_event_unverified',status:503});
 assert.deepEqual(x.calls,['native_read']);assert.deepEqual(x.f.db.tables,x.before);
},{processed:true,leafStatus:'pending'}));
for(const [label,change]of [
 ['foreign account',x=>{x.account.id='acct_OTHER';}],['wrong owner',x=>{x.raw.metadata.client_id=randomUUID();}],
 ['wrong mode',x=>{x.e.livemode=true;}],['missing paid clock',x=>{delete x.state.batch.provider_operation.operations.pay.proof.paid_at;}]
])test(`processed usage replay denies ${label} without touching the prior true row`,async()=>withUsage(async x=>{
 change(x);const before=structuredClone(x.f.db.tables);
 await assert.rejects(x.classify(),{code:'enterprise_usage_event_unverified',status:503});
 assert.equal(x.calls.includes('invoice_get'),false);assert.deepEqual(x.f.db.tables,before);
},{processed:true}));
