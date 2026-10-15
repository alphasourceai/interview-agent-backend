'use strict';
// Fake native ACK contract only. Native receipt validator still rejects v3;
// these tests do not establish SQL persistence, paid/access or hosted acceptance.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {generationFixture,PAID}=require('./fixtures/generation-retail-funding-fixture');
const {readExistingRetailCheckoutFunding}=require('../src/services/existingRetailCheckoutFunding');
const {readExistingRetailFundingReceipt:read}=require('../src/services/existingRetailFundingReplay');
async function fixture({admin=false,paid=false}={}){
 const f=generationFixture('pro',6,'monthly_installments',true,{admin}),r=await readExistingRetailCheckoutFunding(f.options);
 f.g.retail_funding_receipt={version:'retail_existing_funding_v1',recorded_at:'2026-10-15T17:00:00.000000Z',proof:{
  provider_account_id:'acct_SYNTHETIC',period:structuredClone(r.initialProviderSchedule),payment_intent_id:r.paymentIntentId,charge_id:r.chargeId,
  checkout_created:r.checkoutCreatedEpoch,invoice_created:r.invoiceCreatedEpoch,platform_gross_cents:r.platformGrossCents,
  platform_discount_cents:r.platformDiscountCents,platform_net_cents:r.platformNetCents,role_gross_cents:r.roleGrossCents,
  role_discount_cents:r.roleDiscountCents,role_net_cents:r.roleNetCents,tax_cents:r.taxCents,cash_cents:r.cashCents}};
 if(paid){f.g.checkout_status='paid';f.g.checkout_paid_at=PAID;if(!admin)f.i.activated_at=PAID;}
 f.calls.length=0;f.rpcs=[];
 f.db.rpc=async(name,args)=>{f.rpcs.push({name,args});assert.equal(name,'read_retail_existing_funding');
  return {data:{version:'retail_existing_funding_read_v1',phase:paid?'paid':'pending',receipt:structuredClone(f.g.retail_funding_receipt)},error:null};};
 // No initial invoice/charge reproof and no write is permitted on a replay.
 f.sdk.invoices.retrieve=async()=>{throw Error('must not reread initial cash');};
 f.sdk.paymentIntents.retrieve=async()=>{throw Error('must not recreate cash proof');};
 f.sdk.charges.retrieve=async()=>{throw Error('must not reprove initial cash');};
 return f;
}
for(const admin of [false,true])for(const paid of [false,true])test(`new schedule replay keeps original clocks admin=${admin}/paid=${paid}`,async()=>{
 const f=await fixture({admin,paid}),before=structuredClone(f.tables),r=await read(f.options);
 assert.equal(r.funding.paidAt,PAID);assert.equal(r.funding.initialProviderPeriod,undefined);
 assert.equal(r.funding.initialProviderSchedule.version,'retail_generation_initial_schedule_v1');
 assert.equal(r.funding.initialProviderSchedule.initial_term_start,'2026-01-31');
 assert.deepEqual(r.funding.sourceCheckoutPrices,f.g.retail_checkout_prices);assert.equal(r.funding.replay,paid);
 assert.equal(r.funding.receiptReplay,true);assert.equal(r.credits_spendable,false);
 assert.equal(f.rpcs.length,2);assert.deepEqual(f.tables,before);
});
test('old/new receipt type relabels cannot pass the accepted version pair',async()=>{
 const f=await fixture();f.g.retail_funding_receipt.proof.period.version='retail_initial_provider_period_v1';
 await assert.rejects(read(f.options),{code:'retail_funding_replay_ack_unknown'});assert.equal(f.calls.length,0);
});
test('a changed native replay ACK or source price binding fails without creating another charge/receipt',async()=>{
 for(const change of ['ack','price']){
  const f=await fixture(),rpc=f.db.rpc;
  f.db.rpc=async(...args)=>{const r=await rpc(...args);if(f.rpcs.length===2){
   if(change==='ack')r.data.receipt.proof.cash_cents++;
   else f.g.retail_checkout_prices.initial_platform_price_id='price_MOVED';}return r;};
  await assert.rejects(read(f.options),e=>e.code==='retail_funding_replay_ack_unknown'||e.code==='retail_funding_replay_unknown');
  assert.equal(f.rpcs.length,2);
 }
});
