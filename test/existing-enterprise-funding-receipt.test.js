'use strict';
// RPC mocks here are NOT native receipt/seal/provider acceptance.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {recordExistingEnterpriseFunding:record,PROOF_KEYS}=require('../src/services/existingEnterpriseFundingReceipt');
const fixture=require('./helpers/enterprise-existing-funding-fixture');
const clone=v=>structuredClone(v);
function ready(){
 const f=fixture();f.writeCount=0;f.db.rpc=async(name,p)=>{
  assert.equal(name,'record_enterprise_existing_funding');assert.equal(p.p_agreement,f.a.id);assert.equal(p.p_client,f.a.client_id);
  assert.deepEqual(p.p_source,f.a.enterprise_checkout_source);assert.deepEqual(p.p_prices,f.a.enterprise_checkout_prices);
  assert.deepEqual(Object.keys(p.p_proof).sort(),[...PROOF_KEYS].sort());
  if(!f.a.enterprise_funding_receipt){f.writeCount++;f.a.enterprise_funding_receipt={version:'enterprise_existing_funding_v1',proof:clone(p.p_proof),recorded_at:'2026-10-13T12:00:00.123456Z'};}
  else assert.deepEqual(f.a.enterprise_funding_receipt.proof,p.p_proof);
  if(f.lostAck){f.lostAck=false;return{data:null,error:{message:'SYNTHETIC ACK lost after native commit'}};}
  let data=clone(f.a.enterprise_funding_receipt);if(f.ack)data=f.ack(data);
  if(f.after)f.after();return{data,error:null};
 };return f;
}
test('uses actual SDK reader and29-key pure projection; same receipt timestamp on retry; no paid/access changes',async()=>{
 const f=ready(),r=await record({...f.args,eventSessionId:'cs_synthetic',eventInvoiceId:'in_initial',eventSubscriptionId:'sub_synthetic',eventLivemode:false});
 assert.equal(PROOF_KEYS.length,29);assert.equal(r.receipt.proof.payment_success_at,'2026-10-01T13:00:00.000Z');assert.equal(r.credits_spendable,false);
 assert.equal(r.membership_activation_required,true);assert.equal(r.native_receipt_required,true);assert.ok(Object.isFrozen(r.receipt));
 const replay=await record(f.args);assert.deepEqual(replay.receipt,r.receipt);assert.equal(f.writeCount,1);
 assert.equal(f.a.checkout_status,'pending_payment');assert.equal(f.a.checkout_paid_at,null);assert.equal(f.pool.status,'pending');
 assert.equal(f.pool.paid_at,null);assert.equal(f.db.updates.length,0);assert.equal(f.db.inserts.length,0);
 for(const k of ['subscription','sourceTemplate','sourceCheckout','sourceSeal','agreementId'])assert.equal(Object.hasOwn(r.receipt.proof,k),false);
});
test('unknown native ACK after actual mock commit returns503, fresh reader + saved winner on retry',async()=>{
 const f=ready();f.lostAck=true;await assert.rejects(record(f.args),{status:503,code:'enterprise_funding_receipt_ack_unknown'});
 assert.equal(f.writeCount,1);const stored=clone(f.a.enterprise_funding_receipt),r=await record(f.args);
 assert.deepEqual(clone(r.receipt.proof),stored.proof);assert.equal(r.receipt.recorded_at,stored.recorded_at);assert.equal(f.writeCount,1);
});
for(const change of [x=>({...x,extra:true}),x=>({...x,version:'other'}),x=>({...x,recorded_at:null}),
 x=>({...x,recorded_at:'2026-10-13T12:00:00Z'}),x=>({...x,recorded_at:'2026-99-13T12:00:00.000000Z'}),
 x=>({...x,proof:{...x.proof,credits_spendable:true}}),x=>({...x,proof:{...x.proof,extra:true}})])
 test('corrupt/incomplete native ACK is not acceptance',async()=>{const f=ready();f.ack=change;await assert.rejects(record(f.args),{status:503});});
test('native readback changed/source superseded/receipt missing fails; no caller proof bypass',async()=>{
 for(const change of [f=>{f.a.enterprise_funding_receipt=null;},f=>{f.a.is_current=false;},f=>{f.a.enterprise_checkout_prices={};},
  f=>{f.a.checkout_session_id='cs_OTHER';}]){const f=ready();f.after=()=>change(f);await assert.rejects(record(f.args),{status:503});}
 const f=ready();f.p.paymentIntent.amount_received--;await assert.rejects(record({...f.args,proof:{paid:true}}));assert.equal(f.writeCount,0);
});
test('missing store function or event mismatch never returns a receipt',async()=>{
 const f=ready();f.db.rpc=undefined;await assert.rejects(record(f.args),{status:503});assert.equal(f.writeCount,0);
 const x=ready();await assert.rejects(record({...x.args,eventInvoiceId:'in_OTHER'}));assert.equal(x.writeCount,0);
});
test('impossible calendar ACK is not accepted even if a fake readback copies it',async()=>{
 const f=ready(),invalid='2026-11-31T12:00:00.000000Z';f.ack=w=>({...w,recorded_at:invalid});
 f.after=()=>{f.a.enterprise_funding_receipt.recorded_at=invalid;};await assert.rejects(record(f.args),{status:503});
});
