'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,PAID}=require('./fixtures/existing-retail-funding-fixture');
const {recordExistingRetailFunding:record}=require('../src/services/existingRetailFundingReceipt');
function setup(plan='basic',months=3,payment='prepaid',role=false,admin=false){
 const f=fixture(plan,months,payment,role,{admin});f.g.checkout_attempt_source={version:'retail_existing_checkout_attempt_v1',agreement_id:f.g.id,
  client_id:f.c.id,customer_id:f.c.stripe_customer_id,template_snapshot:structuredClone(f.g.template_snapshot)};
 f.sdk.getApiField=k=>k==='version'?'2023-10-16':null;f.sdk.accounts={retrieve:async()=>({object:'account',id:'acct_SYNTHETIC'})};
 f.rpcs=[];f.db.rpc=async(name,args)=>{f.rpcs.push({name,args});
  const w={version:'retail_existing_funding_v1',proof:structuredClone(args.p_proof),recorded_at:'2026-10-13T23:00:00.000000Z'};
  f.g.retail_funding_receipt=structuredClone(w);return {data:w,error:null};};
 f.recordOptions={...f.options,claimKey:admin?null:'SYNTHETIC_CLAIM_000000000000000000000000'};return f;
}
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
test(`closed existing receipt adapter ${plan}/${months}/${payment}/role:${role}`,async()=>{
 const f=setup(plan,months,payment,role),before=structuredClone(f.tables),r=await record(f.recordOptions);
 assert.equal(r.receipt.proof.period.paid_at,PAID);assert.equal(r.receipt.proof.cash_cents,f.inv.total);
 assert.equal(r.receipt.proof.provider_account_id,'acct_SYNTHETIC');assert.equal(r.credits_spendable,false);assert.equal(r.membership_activation_required,true);
 assert.equal(Object.isFrozen(r.receipt.proof.period),true);assert.equal(f.rpcs.length,1);assert.equal(f.rpcs[0].name,'record_retail_existing_funding');
 assert.deepEqual(f.tables.clients,before.clients);assert.deepEqual(f.tables.public_purchase_intents,before.public_purchase_intents);
 assert.deepEqual({...f.g,retail_funding_receipt:undefined},{...before.membership_agreements[0],retail_funding_receipt:undefined});
});
test('admin requires no fabricated activation claim or purchase intent',async()=>{
 const f=setup('pro',12,'prepaid',true,true),r=await record(f.recordOptions);assert.equal(f.rpcs[0].args.p_claim,null);
 assert.equal(r.funding.sourceIntentId,null);assert.equal(f.tables.public_purchase_intents.length,0);
});
test('API/account/source/global owner/funding failures stop before native record',async()=>{
 for(const mutate of [f=>f.sdk.getApiField=()=> '2026-08-26.dahlia',f=>f.sdk.accounts.retrieve=async()=>({object:'account',id:'acct_'}),
  f=>delete f.g.checkout_attempt_source,f=>f.g.checkout_attempt_source.customer_id='cus_OTHER',f=>f.recordOptions.claimKey=null,
  f=>f.tables.billing_customers.push({id:'foreign',client_id:'OTHER',stripe_customer_id:f.c.stripe_customer_id}),f=>f.ch.amount_refunded=1]){
  const f=setup();mutate(f);await assert.rejects(record(f.recordOptions));assert.equal(f.rpcs.length,0);
 }
});
test('already-applied clock never enrolls historical period, re-proves charge or records a first receipt',async()=>{
 const f=setup();f.g.checkout_paid_at=PAID;f.g.checkout_status='paid';f.i.activated_at=PAID;
 f.sdk.charges.retrieve=async()=>{throw Error('Must not read historical money');};
 await assert.rejects(record(f.recordOptions),{code:'retail_funding_receipt_historical_enrollment_held'});assert.equal(f.rpcs.length,0);
});
test('unknown/changed ACK and absent/wrong DB reread hold after exactly one record attempt',async()=>{
 for(const mutate of [w=>w.version='other',w=>w.extra=true,w=>w.proof.cash_cents++,w=>w.recorded_at='2026-11-31T00:00:00.000000Z',
  w=>w.recorded_at='2025-01-01T00:00:00.000000Z']){
  const f=setup(),old=f.db.rpc;f.db.rpc=async(...args)=>{const r=await old(...args);mutate(r.data);return r;};
  await assert.rejects(record(f.recordOptions),{code:'retail_funding_receipt_ack_unknown'});assert.equal(f.rpcs.length,1);
 }
 const f=setup(),old=f.db.rpc;f.db.rpc=async(...args)=>{const r=await old(...args);f.g.retail_funding_receipt=null;return r;};
 await assert.rejects(record(f.recordOptions),{code:'retail_funding_receipt_ack_unknown'});assert.equal(f.rpcs.length,1);
});
test('lost native acknowledgment does not create another key or erase persisted synthetic receipt; exact retry stable proof',async()=>{
 const f=setup(),old=f.db.rpc;f.db.rpc=async(...args)=>{await old(...args);throw Error('Private native timeout');};
 await assert.rejects(record(f.recordOptions),{code:'retail_funding_receipt_ack_unknown'});const saved=structuredClone(f.g.retail_funding_receipt);
 f.db.rpc=old;const r=await record(f.recordOptions);assert.deepEqual(JSON.parse(JSON.stringify(r.receipt)),saved);assert.equal(f.rpcs.length,2);
 assert.deepEqual(f.rpcs[0].args,f.rpcs[1].args);
});
test('raw provider/database exceptions stay generic, never leak private detail',async()=>{
 for(const stage of ['funding','account','rpc']){
  const f=setup();if(stage==='funding')f.sdk.charges.retrieve=async()=>{throw Error('PRIVATE_PROVIDER_VALUE');};
  if(stage==='account')f.sdk.accounts.retrieve=async()=>{throw Error('PRIVATE_PROVIDER_VALUE');};
  if(stage==='rpc')f.db.rpc=async()=>{throw Error('PRIVATE_PROVIDER_VALUE');};
  await assert.rejects(record(f.recordOptions),e=>e.code==='retail_funding_receipt_ack_unknown'&&!e.message.includes('PRIVATE'));
 }
});
