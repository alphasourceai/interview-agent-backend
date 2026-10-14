'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,PAID}=require('./fixtures/existing-retail-funding-fixture');
const {recordExistingRetailFunding}=require('../src/services/existingRetailFundingReceipt');
const {readExistingRetailFundingReceipt:read}=require('../src/services/existingRetailFundingReplay');
async function setup(plan='basic',months=3,payment='prepaid',role=false,admin=false,lostAck=false){
 const f=fixture(plan,months,payment,role,{admin});
 f.g.checkout_attempt_source={version:'retail_existing_checkout_attempt_v1',agreement_id:f.g.id,client_id:f.c.id,
  customer_id:f.c.stripe_customer_id,template_snapshot:structuredClone(f.g.template_snapshot)};
 f.sdk.getApiField=()=> '2023-10-16';f.sdk.accounts={retrieve:async()=>({object:'account',id:'acct_SYNTHETIC'})};
 f.rpcs=[];f.db.rpc=async(name,args)=>{f.rpcs.push({name,args:structuredClone(args)});
  if(name==='record_retail_existing_funding'){
   f.g.retail_funding_receipt={version:'retail_existing_funding_v1',proof:structuredClone(args.p_proof),recorded_at:'2026-10-13T23:00:00.000000Z'};
   if(lostAck)throw Error('Simulated committed receipt then lost ACK');
   return{data:structuredClone(f.g.retail_funding_receipt),error:null};
  }
  assert.equal(name,'read_retail_existing_funding');return{data:{version:'retail_existing_funding_read_v1',
   phase:f.g.checkout_paid_at?'paid':'pending',receipt:structuredClone(f.g.retail_funding_receipt)},error:null};
 };
 f.readOptions={...f.options,claimKey:admin?null:'SYNTHETIC_CLAIM_000000000000000000000000'};
 if(lostAck)await assert.rejects(recordExistingRetailFunding(f.readOptions),{code:'retail_funding_receipt_ack_unknown'});
 else await recordExistingRetailFunding(f.readOptions);
 f.rpcs.length=0;f.calls.length=0;
 f.sdk.invoices=new Proxy({},{get(){throw Error('No historical invoice reproof');}});
 f.sdk.paymentIntents=new Proxy({},{get(){throw Error('No historical PI reproof');}});
 f.sdk.charges=new Proxy({},{get(){throw Error('No historical charge reproof');}});
 f.sdk.subscriptionItems=new Proxy({},{get(){throw Error('No historical item reproof');}});
 return f;
}
function paid(f){f.g.checkout_status='paid';f.g.checkout_paid_at=PAID;if(f.tables.public_purchase_intents.length){f.i.status='completed';f.i.activated_at=PAID;}}
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
test(`persisted receipt retry ${plan}/${months}/${payment}/role:${role}`,async()=>{
 const f=await setup(plan,months,payment,role),before=structuredClone(f.tables),r=await read(f.readOptions);
 assert.equal(r.funding.paidAt,PAID);assert.equal(r.funding.replay,false);assert.equal(r.funding.receiptReplay,true);
 assert.equal(r.credits_spendable,false);assert.equal(r.funding.cashCents,f.inv.total);
 assert.deepEqual(f.tables,before);assert.deepEqual(f.rpcs.map(r=>r.name),['read_retail_existing_funding','read_retail_existing_funding']);
 assert.deepEqual(f.calls.map(c=>c[0]),['session','subscription']);assert.equal(Object.isFrozen(r.funding.initialProviderPeriod),true);
});
test('paid linked completion-before-billing retry retains A/B with absent client subscription and later/refunded provider data',async()=>{
 const f=await setup();paid(f);f.readOptions.eventInvoiceId='in_LATER';f.ch.refunded=true;f.ch.amount_refunded=f.ch.amount;
 f.s.latest_invoice='in_LATER';f.s.current_period_end=Date.now()/1000+999999;const b=structuredClone(f.g.retail_funding_receipt.proof.period);
 const r=await read(f.readOptions);assert.equal(r.funding.replay,true);assert.equal(r.funding.paidAt,PAID);
 assert.deepEqual(JSON.parse(JSON.stringify(r.funding.initialProviderPeriod)),b);assert.equal(f.c.stripe_subscription_id,null);
 assert.equal(f.rpcs.length,2);
});
test('committed receipt/lost ACK then refund resumes by read only, without another receipt key or money request',async()=>{
 const f=await setup('basic',3,'prepaid',false,false,true),saved=structuredClone(f.g.retail_funding_receipt);
 f.ch.refunded=true;f.ch.amount_refunded=f.ch.amount;const r=await read(f.readOptions);
 assert.deepEqual(JSON.parse(JSON.stringify(r.receipt)),saved);assert.equal(r.funding.paidAt,PAID);
 assert.equal(f.rpcs.length,2);assert.ok(f.rpcs.every(x=>x.name==='read_retail_existing_funding'));
});
test('admin pending and paid-clock-only tails use persisted receipt with no fabricated intent',async()=>{
 const f=await setup('pro',6,'prepaid',true,true);
 assert.equal((await read(f.readOptions)).funding.sourceIntentId,null);paid(f);
 const r=await read(f.readOptions);assert.equal(r.funding.replay,true);assert.equal(r.funding.paidAt,PAID);assert.equal(f.c.stripe_subscription_id,null);
});
test('no persisted receipt cannot enroll historical rows or call native/provider',async()=>{
 const f=await setup();delete f.g.retail_funding_receipt;paid(f);
 await assert.rejects(read(f.readOptions),{code:'retail_funding_replay_receipt_required'});assert.equal(f.rpcs.length,0);assert.equal(f.calls.length,0);
});
test('API/event/account/Session/subscription identity drift refuses without writes or money reads',async()=>{
 for(const mutate of [f=>f.sdk.getApiField=()=> 'other',f=>f.readOptions.eventLivemode=true,f=>f.readOptions.eventSessionId='cs_OTHER',
  f=>f.readOptions.eventSubscriptionId='sub_OTHER',f=>f.readOptions.eventInvoiceId='in_OTHER',f=>f.readOptions.intentId='OTHER',
  f=>f.sdk.accounts.retrieve=async()=>({object:'account',id:'acct_OTHER'}),f=>f.cs.customer='cus_OTHER',f=>f.cs.invoice='in_OTHER',
  f=>f.cs.status='open',f=>f.s.customer='cus_OTHER',f=>f.s.id='sub_OTHER',f=>f.s.livemode=true]){
  const f=await setup();mutate(f);await assert.rejects(read(f.readOptions));assert.ok(f.rpcs.every(r=>r.name==='read_retail_existing_funding'));
 }
});
test('unknown native ACK, changed second phase/receipt, and source/fence drift refuse safely',async()=>{
 for(const stage of ['ack','phase','receipt','source','fence']){
  const f=await setup(),old=f.db.rpc;f.db.rpc=async(...args)=>{const r=await old(...args);
   if(stage==='ack')r.data.extra=true;
   if(f.rpcs.length===2){if(stage==='phase')r.data.phase='paid';if(stage==='receipt')r.data.receipt.proof.cash_cents++;
    if(stage==='source')f.g.is_current=false;}
   return r;};
  if(stage==='fence')f.readOptions.assertFence=async()=>{const e=Error('Fence lost');e.code='public_purchase_activation_guard_lost';throw e;};
  await assert.rejects(read(f.readOptions));
 }
});
test('native/provider/source failures never disclose raw detail',async()=>{
 for(const stage of ['native','account','subscription','source']){
  const f=await setup();if(stage==='native')f.db.rpc=async()=>{throw Error('PRIVATE_DETAIL');};
  if(stage==='account')f.sdk.accounts.retrieve=async()=>{throw Error('PRIVATE_DETAIL');};
  if(stage==='subscription')f.sdk.subscriptions.retrieve=async()=>{throw Error('PRIVATE_DETAIL');};
  if(stage==='source')f.db.from=()=>{throw Error('PRIVATE_DETAIL');};
  await assert.rejects(read(f.readOptions),e=>!e.message.includes('PRIVATE_DETAIL')&&e.code==='retail_funding_replay_unknown');
 }
});
