'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {generationFixture,PAID}=require('./fixtures/generation-retail-funding-fixture');
const {readExistingRetailCheckoutFunding:read,assertExistingRetailFundingSource:assertSource}=require('../src/services/existingRetailCheckoutFunding');
const {recordExistingRetailFunding:record}=require('../src/services/existingRetailFundingReceipt');
const {readSavedRetailCheckoutTerms}=require('../src/services/savedMembershipCheckoutTerms');
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
 test(`existing SDK reader generation cash ${plan}/${months}/${payment}/role=${role}`,async()=>{
  for(const admin of [false,true]){
   const f=generationFixture(plan,months,payment,role,{admin}),before=structuredClone(f.tables),r=await read(f.options);
   assert.equal(r.paidAt,PAID);assert.equal(r.initialProviderPeriod,undefined);
   assert.equal(r.initialProviderSchedule.version,'retail_generation_initial_schedule_v1');
   assert.equal(r.initialProviderSchedule.initial_term_start,'2026-01-31');
   assert.equal(r.initialProviderSchedule.initial_renewal_date,f.dates.initial_renewal_date);
   assert.equal(r.platformNetCents,f.offer.platform_payment_cents);assert.equal(r.roleNetCents,f.offer.first_role_prepay.amount_cents);
   assert.deepEqual(r.sourceCheckoutPrices,f.g.retail_checkout_prices);assert.deepEqual(f.tables,before);
   await assertSource({db:f.db,funding:r});assert.equal(r.sourceIntentId,admin?null:f.i.id);
  }
 });
test('saved generation rows require the exact rendered calendar and linked intent basis before provider reads',async()=>{
 for(const change of [f=>f.g.initial_term_start='2026-02-02',f=>f.g.initial_renewal_date='2026-05-02',
  f=>f.g.template_snapshot.generated_at='2026-02-02T10:00:00.000Z',f=>delete f.g.template_snapshot.generated_at,
  f=>f.g.template_snapshot.values.term_start_basis='successful_payment',f=>f.i.term_start_basis='successful_payment']){
  const f=generationFixture();change(f);await assert.rejects(read(f.options));assert.equal(f.calls.length,0);
 }
});
test('stored SDK reader binds each distinct pinned price; missing/changed/duplicate bindings fail',async()=>{
 for(const [change,code] of [
  [f=>f.g.retail_checkout_prices=null,'retail_generation_funding_price_binding_required'],
  [f=>delete f.g.retail_checkout_prices,'retail_generation_funding_price_binding_required'],
  [f=>f.g.retail_checkout_prices.initial_platform_price_id='price_OTHER','retail_funding_invoice_line_mismatch'],
  [f=>f.g.retail_checkout_prices.recurring_platform_price_id=f.g.retail_checkout_prices.initial_platform_price_id,'retail_generation_funding_price_binding_required'],
  [f=>f.g.retail_checkout_prices.first_role_price_id='price_UNSELECTED','retail_generation_funding_price_binding_required']]){
  const f=generationFixture();change(f);await assert.rejects(read(f.options),{code});
 }
});
test('a signature predating the frozen generation instant cannot qualify initial cash',async()=>{
 const f=generationFixture();f.g.signed_at='2026-01-30T10:00:00.000Z';
 await assert.rejects(read(f.options),{code:'retail_funding_paid_clock_invalid'});
});
test('price provenance is rechecked after SDK awaits; no source mutation is accepted',async()=>{
 const f=generationFixture(),r=await read(f.options);
 f.g.retail_checkout_prices.initial_platform_price_id='price_MOVED';
 await assert.rejects(assertSource({db:f.db,funding:r}),{code:'retail_funding_source_changed'});
});
test('generation writer sends the new typed schedule to the existing RPC without activating anything',async()=>{
 const f=generationFixture();let rpcs=0;f.db.rpc=async(name,args)=>{
  rpcs++;assert.equal(name,'record_retail_existing_funding');
  assert.equal(args.p_proof.period.version,'retail_generation_initial_schedule_v1');
  assert.equal(args.p_proof.period.provider_period_start,undefined);
  const receipt={version:'retail_existing_funding_v1',proof:structuredClone(args.p_proof),recorded_at:'2026-02-02T11:00:21.000000Z'};
  f.g.retail_funding_receipt=receipt;return{data:receipt,error:null};
 };
 const r=await record({...f.options,claimKey:'SYNTHETIC_CLAIM_000000000000000000000000'});
 assert.equal(r.receipt.proof.period.version,'retail_generation_initial_schedule_v1');
 assert.equal(rpcs,1);assert.equal(f.g.checkout_paid_at,null);assert.equal(f.i.activated_at,null);
 // This ACK is a stub; the disposable PG test owns actual native proof.
});
test('checking a saved generation source does not alter or replace the accepted snapshot',()=>{
 const f=generationFixture(),before=structuredClone(f.g);
 const t=readSavedRetailCheckoutTerms({agreement:f.g,intent:f.i,deadlineMode:'stored'});
 assert.equal(t.offer.term_start_basis,'generation_date');assert.deepEqual(f.g,before);
});
