'use strict';
// Authored graphs/RPC replies only, not SQL or provider cash.
const assert=require('node:assert/strict'),cycleFixture=require('./enterprise-platform-cycle-fixture');
const clone=v=>structuredClone(v),iso6=s=>new Date(s*1000).toISOString().replace(/Z$/,'000Z');
module.exports=async function fixture(t,{cadence='monthly',initial=false,ordinal=1}={}){
 const f=await cycleFixture(t,{cadence,prefix:0,ordinal}),p=f.native.a.enterprise_funding_receipt.proof;
 f.sub={object:'subscription',id:p.subscription_id,customer:p.customer_id,livemode:p.livemode,currency:'usd',
  collection_method:'charge_automatically',metadata:clone(f.native.p.subscription.metadata),created:Math.floor(Date.parse(f.native.a.enterprise_checkout_source.created_at)/1000),
  status:'active',billing_cycle_anchor:f.native.a.enterprise_billing_receipt.subscription.current_period_end,
  current_period_start:initial?Math.floor(Date.parse(p.payment_success_at)/1000):f.x.line.period.start,
  current_period_end:initial?f.native.a.enterprise_billing_receipt.subscription.current_period_end:f.x.line.period.end,
  items:{object:'list',has_more:false,data:[{object:'subscription_item',id:p.platform_item_id,subscription:p.subscription_id,
   quantity:1,price:clone(f.x.line.price)}]},schedule:null,pause_collection:null,trial_start:null,trial_end:null,
  test_clock:null,cancel_at:null,cancel_at_period_end:false};
 let count=0;f.stripe.subscriptions.retrieve=async id=>{
  assert.equal(id,p.subscription_id);count++;if(f.onSubscriptionRead)f.onSubscriptionRead(count);return clone(f.sub);
 };
 const rpc=f.native.db.rpc,tuple=()=>Object.fromEntries(['subscription_status','current_term_end','stripe_subscription_schedule_id','cancel_at_term_end']
  .map(k=>[k,f.native.client[k]??null]));
 f.native.db.rpc=async(name,args)=>{
  if(name!=='record_enterprise_existing_subscription_observation'){
   const r=await rpc(name,args);
   if(name==='refresh_enterprise_existing_paid_coverage'){
    r.data.observed_at=iso6(Math.floor(Date.now()/1000)+2);
    if(f.onCoverageResult)f.onCoverageResult(r);
   }
   return r;
  }
  f.rpcCalls.push({name,args:clone(args)});assert.deepEqual(clone(args.p_billing),f.native.a.enterprise_billing_receipt);
  assert.deepEqual(clone(args.p_expected),tuple());
  const proof=args.p_proof,projection={subscription_status:proof.subscription_status,current_term_end:iso6(proof.provider_period_end),
   stripe_subscription_schedule_id:null,cancel_at_term_end:proof.cancel_at_term_end};
  Object.assign(f.native.client,projection);f.observations=(f.observations||0)+1;
  const r={data:{status:'observed',agreement_id:f.native.a.id,client_id:f.native.client.id,source_digest:'0123456789abcdef0123456789abcdef',
   projection,observed_at:iso6(Math.floor(Date.now()/1000)+1)},error:null};
  if(f.onObservationResult)f.onObservationResult(r);return r;
 };
 f.statusArgs={db:f.native.db,stripe:f.stripe,agreementId:f.native.a.id,clientId:f.native.client.id};return f;
};
