'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express'),request=require('supertest');
function inject(path,value){const file=require.resolve(path);require.cache[file]={id:file,filename:file,loaded:true,exports:value};}
function memoryDb({duplicate=false,priorProcessed=false}={}){
 const events=duplicate?[{stripe_event_id:'evt_SYNTHETIC',processed_ok:priorProcessed,error:null}]:[],writes=[],rpcs=[];
 class Query{
  constructor(){this.filters=[];this.op='select';this.payload=null;}
  select(){return this;}eq(k,v){this.filters.push([k,v,false]);return this;}neq(k,v){this.filters.push([k,v,true]);return this;}
  insert(v){this.op='insert';this.payload=v;return this;}update(v){this.op='update';this.payload=v;return this;}
  delete(){this.op='delete';return this;}
  async exec(){
   if(this.op==='insert'){
    if(events.some(x=>x.stripe_event_id===this.payload.stripe_event_id))return{error:{code:'23505'},data:null};
    events.push(structuredClone(this.payload));writes.push({op:'insert',row:structuredClone(this.payload)});return{data:[structuredClone(this.payload)],error:null};
   }
   let rows=events.filter(row=>this.filters.every(([k,v,neg])=>neg?row[k]!==v:row[k]===v));
   if(this.op==='update')for(const row of rows)Object.assign(row,structuredClone(this.payload));
   if(this.op==='delete')for(const row of rows)events.splice(events.indexOf(row),1);
   if(this.op!=='select')writes.push({op:this.op,rows:structuredClone(rows),payload:structuredClone(this.payload)});
   return{data:structuredClone(rows),error:null,count:rows.length};
  }
  then(ok,bad){return this.exec().then(ok,bad);}
  async maybeSingle(){const r=await this.exec();return{data:r.data?.[0]||null,error:r.error};}
 }
 return{events,writes,rpcs,from(table){assert.equal(table,'billing_events');return new Query();},async rpc(name,args){rpcs.push({name,args});
  if(name==='claim_public_purchase_activation')return{data:{status:'purchase_intent_missing',intent_id:null},error:null};
  if(name==='release_public_purchase_activation')return{data:true,error:null};
  throw Error('Unexpected RPC '+name);
 }};
}
function load({action,duplicate=false,priorProcessed=false,activationFails=false}={}){
 const db=memoryDb({duplicate,priorProcessed}),calls=[];let current;
 inject('../src/clients/supabase',{supabaseAdmin:db});
 inject('../src/clients/stripe',{webhooks:{constructEvent:()=>current},subscriptions:{retrieve:async id=>({id})}});
 inject('../src/services/publicPurchaseActivation',{
  activatePublicPurchaseAgreementCheckout:async()=>{calls.push('legacyActivation');return{ok:true};},
  finishExistingEnterpriseAccountSetup:async x=>{calls.push({tail:x.agreementId});if(activationFails)throw Object.assign(new Error('synthetic tail failure'),{code:'synthetic_tail_failure'});return{ok:true,status:'activated_existing_enterprise'};}
 });
 inject('../src/services/existingEnterprisePaymentCompletion',{completeExistingEnterprisePayment:async x=>{
  calls.push({complete:x.agreementId,session:x.eventSessionId,subscription:x.eventSubscriptionId,invoice:x.eventInvoiceId});
  return{billing_applied:true,paid_pool_recorded:true};
 }});
 inject('../src/services/existingRetailCheckoutFunding',{readExistingRetailCheckoutFunding:async()=>{calls.push('retailReader');return null;},
  assertExistingRetailFundingSource:async()=>{calls.push('retailSourceAssert');}});
 inject('../src/services/existingEnterprisePaymentWebhook',{classifyExistingEnterprisePaymentEvent:async()=>action?{
  cohort:'existing_enterprise',action,agreementId:'00000000-0000-4000-8000-000000000001',clientId:'00000000-0000-4000-8000-000000000002',
  sessionId:'cs_SYNTHETIC',subscriptionId:'sub_SYNTHETIC',customerId:'cus_SYNTHETIC',subscription:{id:'sub_SYNTHETIC'},requiresReentry:true
 }:null});
 const routerPath=require.resolve('../src/routes/webhooks/stripe');delete require.cache[routerPath];const router=require(routerPath);
 const app=express();app.use('/webhook/stripe',express.raw({type:'application/json'}),router);
 return{db,calls,post:async(type='checkout.session.completed')=>{current={id:'evt_SYNTHETIC',type,created:1,livemode:false,data:{object:{
  id:'cs_SYNTHETIC',object:'checkout.session',mode:'subscription',status:'complete',payment_status:'paid',customer:'cus_SYNTHETIC',
  subscription:'sub_SYNTHETIC',metadata:{source:'agreement_checkout',agreement_id:'00000000-0000-4000-8000-000000000001'}}}};
  return request(app).post('/webhook/stripe').set('content-type','application/json').send('{}');}};
}
test('initial paid webhook early-dispatches once and records success without generic handling',async()=>{
 const f=load({action:'initial_paid'}),r=await f.post();assert.equal(r.status,200);
 assert.deepEqual(f.calls,[{complete:'00000000-0000-4000-8000-000000000001',session:'cs_SYNTHETIC',subscription:'sub_SYNTHETIC',invoice:null},
  {tail:'00000000-0000-4000-8000-000000000001'}]);
 assert.equal(f.db.events[0].processed_ok,true);assert.equal(f.calls.includes('legacyActivation'),false);
});
test('unsettled checkout is acknowledged as no-write and never invokes payment/account setup',async()=>{
 const f=load({action:'pending_noop'}),r=await f.post();assert.equal(r.status,200);assert.deepEqual(f.calls,[]);assert.equal(f.db.events[0].processed_ok,true);
});
test('marked lifecycle failure keeps the dedupe row false and returns retryable 503',async()=>{
 const f=load({action:'held'}),r=await f.post('customer.subscription.updated');assert.equal(r.status,503);
 assert.equal(f.db.events.length,1);assert.equal(f.db.events[0].processed_ok,false);assert.deepEqual(f.calls,[]);
});
test('account-tail failure leaves marked event retryable after payment completion',async()=>{
 const f=load({action:'initial_paid',activationFails:true}),r=await f.post();assert.equal(r.status,503);
 assert.equal(f.db.events[0].processed_ok,false);assert.equal(f.calls.length,2);
});
test('processed duplicate is acknowledged only after the native marked classifier reenters',async()=>{
 const f=load({action:'held',duplicate:true,priorProcessed:true}),r=await f.post('customer.subscription.updated');
 assert.equal(r.status,200);assert.equal(f.db.events.length,1);assert.deepEqual(f.calls,[]);
});
