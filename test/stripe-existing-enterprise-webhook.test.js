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
function load({action,duplicate=false,priorProcessed=false,activationFails=false,completionMissing=false,cycleFails=false,cycleMissing=false,cycleReplay=false}={}){
 const db=memoryDb({duplicate,priorProcessed}),calls=[];let current;
 inject('../src/clients/supabase',{supabaseAdmin:db});
 inject('../src/clients/stripe',{webhooks:{constructEvent:()=>current},subscriptions:{retrieve:async id=>({id})}});
 inject('../src/services/publicPurchaseActivation',{
  activatePublicPurchaseAgreementCheckout:async()=>{calls.push('legacyActivation');return{ok:true};},
  finishExistingEnterpriseAccountSetup:async x=>{calls.push({tail:x.agreementId});if(activationFails)throw Object.assign(new Error('synthetic tail failure'),{code:'synthetic_tail_failure'});return{ok:true,status:'activated_existing_enterprise'};}
 });
 inject('../src/services/existingEnterprisePaymentCompletion',{completeExistingEnterprisePayment:async x=>{
  calls.push({complete:x.agreementId,session:x.eventSessionId,subscription:x.eventSubscriptionId,invoice:x.eventInvoiceId});
  if(completionMissing)return null;
  return{billing_applied:true,paid_pool_recorded:true};
 },completeExistingEnterprisePlatformPeriod:async x=>{
  calls.push({cycle:x.agreementId,client:x.clientId,invoice:x.invoiceId});
  if(cycleFails)throw Object.assign(new Error('synthetic cash unverified'),{code:'enterprise_platform_period_unverified'});
  if(cycleMissing)return null;
  return{status:cycleReplay?'already_recorded':'recorded'};
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
  id:action==='cycle_paid'?'in_SYNTHETIC':'cs_SYNTHETIC',object:action==='cycle_paid'?'invoice':'checkout.session',mode:'subscription',status:'complete',payment_status:'paid',customer:'cus_SYNTHETIC',
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
test('marked payment completion returning null cannot fall through to legacy retail activation',async()=>{
 const f=load({action:'initial_paid',completionMissing:true}),r=await f.post();assert.equal(r.status,503);
 assert.equal(f.db.events[0].processed_ok,false);assert.equal(f.calls.length,1);
 assert.equal(f.calls.some(call=>call==='retailReader'||call==='legacyActivation'),false);
});
test('processed duplicate is acknowledged only after the native marked classifier reenters',async()=>{
 const f=load({action:'held',duplicate:true,priorProcessed:true}),r=await f.post('customer.subscription.updated');
 assert.equal(r.status,200);assert.equal(f.db.events.length,1);assert.deepEqual(f.calls,[]);
});
for(const type of ['invoice.paid','invoice.payment_succeeded'])for(const priorProcessed of [false,true])test(`${type} cycle always reenters native completion even processed=${priorProcessed}`,async()=>{
 const f=load({action:'cycle_paid',duplicate:true,priorProcessed,cycleReplay:true}),r=await f.post(type);
 assert.equal(r.status,200);assert.equal(f.db.events[0].processed_ok,true);
 assert.deepEqual(f.calls,[{cycle:'00000000-0000-4000-8000-000000000001',client:'00000000-0000-4000-8000-000000000002',invoice:'in_SYNTHETIC'}]);
 assert.deepEqual(f.db.rpcs,[]); // no activation claim/account tail/generic invoice sync
});
for(const priorProcessed of [false,true])for(const options of [{cycleFails:true},{cycleMissing:true}])test(`cycle hold/null cannot empty-ACK or fall through, processed=${priorProcessed} ${JSON.stringify(options)}`,async()=>{
 const f=load({action:'cycle_paid',duplicate:true,priorProcessed,...options}),r=await f.post('invoice.paid');
 assert.equal(r.status,503);assert.equal(f.calls.length,1);assert.ok(f.calls[0].cycle);assert.deepEqual(f.db.rpcs,[]);
 assert.equal(f.db.events[0].processed_ok,priorProcessed); // never downgrade true, but HTTP remains retryable
});
test('first cycle delivery records only billing event and native period, not initial account setup',async()=>{
 const f=load({action:'cycle_paid'}),r=await f.post('invoice.paid');assert.equal(r.status,200);
 assert.equal(f.calls.length,1);assert.ok(f.calls[0].cycle);assert.deepEqual(f.db.rpcs,[]);assert.equal(f.db.events[0].processed_ok,true);
});
for(const action of ['usage_paid_ack','usage_stale_ack'])test(`${action} only marks billing event; no invoice/account/financial writer`,async()=>{
 const f=load({action}),r=await f.post('invoice.paid');assert.equal(r.status,200);
 assert.deepEqual(f.calls,[]);assert.deepEqual(f.db.rpcs,[]);assert.equal(f.db.events[0].processed_ok,true);
 assert.deepEqual(f.db.writes.map(x=>x.op),['insert','update']);
});
test('usage held action retains unprocessed row and returns 503 without any writer',async()=>{
 const f=load({action:'usage_held'}),r=await f.post('invoice.payment_failed');assert.equal(r.status,503);
 assert.equal(f.db.events[0].processed_ok,false);assert.deepEqual(f.calls,[]);assert.deepEqual(f.db.rpcs,[]);
});
