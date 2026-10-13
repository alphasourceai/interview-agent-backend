'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express'),request=require('supertest');
const {fixture,PAID,C,G,I,A}=require('./fixtures/existing-retail-funding-fixture');
function inject(p,value){const f=require.resolve(p);require.cache[f]={id:f,filename:f,loaded:true,exports:value};}
function load(f,options={}){
  const rpcs=[],activations=[];let currentEvent;
  f.tables.billing_events=[];f.tables.billing_invoices=[];
  f.db.rpc=async(name,args)=>{rpcs.push({name,args});
    if(name==='claim_public_purchase_activation')return{data:{status:options.claimStatus||(f.tables.public_purchase_intents.length?'claimed':'purchase_intent_missing'),intent_id:I},error:null};
    if(name==='heartbeat_public_purchase_activation')return{data:!options.loseFence,error:null};
    if(name==='release_public_purchase_activation')return{data:true,error:null};throw Error('Unexpected native mock '+name);};
  inject('../src/clients/supabase',{supabaseAdmin:f.db});
  const activate=async args=>{
    activations.push(args);
    if(f.i.status==='canceled'||f.i.canceled_at)return{ok:false,status:'purchase_canceled'};
    if(f.g.superseded_by_agreement_id)return{ok:false,status:'agreement_superseded'};
    if(f.i.protocol==='legacy_complete')return{ok:false,status:'historical_complete'};
    // Synthetic consumer callback only, not a real DB/Auth/native activation.
    f.g.checkout_paid_at=args.paidAt;f.g.checkout_status='paid';f.i.activated_at=args.paidAt;f.c.stripe_subscription_id=args.subscription.id;
    return{ok:true,status:'activated'};
  };
  inject('../src/services/publicPurchaseActivation',{activatePublicPurchaseAgreementCheckout:activate});
  f.sdk.webhooks={constructEvent:()=>currentEvent};inject('../src/clients/stripe',f.sdk);
  const route=require.resolve('../src/routes/webhooks/stripe');delete require.cache[route];
  const router=require(route),app=express();app.use('/webhook/stripe',express.raw({type:'application/json'}),router);
  function event(type,eventId){const source={source:'agreement_checkout',agreement_id:G,client_id:C,plan_tier:f.pkg.plan_key,billing_interval:f.pkg.billing_cadence};
    f.s.metadata=source;
    return{id:eventId,type,created:A+10000,livemode:false,data:{object:{...structuredClone(type.startsWith('invoice.')?f.inv:f.cs),metadata:source}}};}
  const post=async(type,eventId)=>{currentEvent=event(type,eventId);return request(app).post('/webhook/stripe').set('content-type','application/json').send('{}');};
  return{router,app,activations,rpcs,post,mark:router.markAgreementCheckoutPaid,activate};
}
for(const order of [['checkout.session.completed','invoice.payment_succeeded'],['invoice.payment_succeeded','checkout.session.async_payment_succeeded']])
  test(`mounted existing webhook first-paid clock for event order ${order.join(' then ')}`,async()=>{
    const f=fixture(),l=load(f);
    for(const [n,type] of order.entries())assert.equal((await l.post(type,`evt_SYNTHETIC_${n}`)).status,200);
    assert.equal(l.activations.length,2);for(const call of l.activations){assert.equal(call.paidAt,PAID);
      assert.equal(call.checkoutSessionId,'cs_SYNTHETIC');assert.equal(call.retailFunding.customerId,'cus_SYNTHETIC');}
    assert.equal(l.rpcs.filter(r=>r.name==='release_public_purchase_activation').length,2);
    assert.equal(f.tables.billing_events.every(e=>e.processed_ok===true),true);
  });
test('mounted proof errors stay retryable and release claim with no activate; claim races read no provider',async()=>{
  for(const tweak of [f=>f.pi.amount_received--,f=>f.sdk.charges.retrieve=async()=>{throw Error('synthetic provider unavailable')}]){
    const f=fixture();tweak(f);const l=load(f),res=await l.post('checkout.session.completed','evt_SYNTHETIC_BAD');
    assert.equal(res.status,503);assert.deepEqual(l.activations,[]);assert.equal(f.tables.billing_events[0].processed_ok,false);
    assert.equal(l.rpcs.at(-1).name,'release_public_purchase_activation');}
  const f=fixture(),l=load(f,{claimStatus:'activation_in_progress'});
  const r=await l.mark(G,{db:f.db,stripe:f.sdk,eventLivemode:false});assert.equal(r.status,'activation_in_progress');assert.deepEqual(f.calls,[]);
});
test('mounted lost heartbeat and source change before activation grant no effect',async()=>{
  const f=fixture(),l=load(f,{loseFence:true});await assert.rejects(l.mark(G,{db:f.db,stripe:f.sdk,eventLivemode:false}),{code:'activation_fence_lost'});
  assert.deepEqual(l.activations,[]);assert.deepEqual(f.calls,[]);
  const changed=fixture(),other=load(changed),old=changed.sdk.charges.retrieve;
  changed.sdk.charges.retrieve=async(...args)=>{const result=await old(...args);changed.g.checkout_session_id='cs_OTHER';return result;};
  await assert.rejects(other.mark(G,{db:changed.db,stripe:changed.sdk,eventLivemode:false}),{code:'retail_funding_source_changed'});
  assert.deepEqual(other.activations,[]);
});
test('zero funded cash uses permanent incomplete-event path with no activation',async()=>{
  const f=fixture('basic',3,'monthly_installments');f.inv.total=f.inv.amount_paid=f.inv.amount_due=0;f.cs.amount_total=0;
  f.cs.payment_status='no_payment_required';f.il[0].discount_amounts=[{amount:f.inv.subtotal,discount:'di_SYNTHETIC_ZERO'}];
  f.inv.total_discount_amounts=[{amount:f.inv.subtotal,discount:'di_SYNTHETIC_ZERO'}];
  f.cl[0].amount_discount=f.inv.subtotal;f.cl[0].amount_total=0;f.inv.payment_intent=null;f.inv.charge=null;
  const l=load(f),res=await l.post('checkout.session.completed','evt_SYNTHETIC_ZERO');
  assert.equal(res.status,200);assert.deepEqual(l.activations,[]);assert.equal(f.tables.billing_events[0].processed_ok,false);
  assert.match(f.tables.billing_events[0].error||f.tables.billing_events[0].error_text||'',/retail_funding_zero_cash/);
});
test('admin mounted proof does not require or create a public intent',async()=>{
  const f=fixture('pro',6,'prepaid',true,{admin:true}),l=load(f);
  const r=await l.mark(G,{db:f.db,stripe:f.sdk,eventLivemode:false,activate:l.activate});assert.equal(r.ok,true);
  assert.equal(l.activations[0].paidAt,PAID);assert.equal(l.activations[0].retailFunding.sourceIntentId,null);
  assert.equal(f.tables.public_purchase_intents.length,0);
});
