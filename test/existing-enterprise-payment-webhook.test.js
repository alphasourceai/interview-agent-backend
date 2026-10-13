'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
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
test('classifies settled existing agreement Checkout from native pin and fresh provider graph',async()=>{
 const f=ready(),r=await classify({db:f.db,stripe:f.stripe,event:event(f,'checkout.session.completed',{
  id:f.a.checkout_session_id,object:'checkout.session',mode:'subscription',status:'complete',payment_status:'paid',
  customer:f.client.stripe_customer_id,subscription:f.p.subscription.id,metadata:structuredClone(f.p.checkout.metadata)})});
 assert.equal(r.action,'initial_paid');assert.equal(r.agreementId,f.a.id);assert.equal(r.requiresReentry,true);
});
test('classifies initial invoice.created with missing metadata through unique customer and pinned Checkout',async()=>{
 const f=ready(),r=await classify({db:f.db,stripe:f.stripe,event:event(f,'invoice.created',{
  id:'in_synthetic',object:'invoice',billing_reason:'subscription_create',status:'draft',amount_paid:0,
  customer:f.client.stripe_customer_id,subscription:f.p.subscription.id,metadata:{}})});
 assert.equal(r.action,'initial_noop');assert.equal(r.sessionId,f.a.checkout_session_id);
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
