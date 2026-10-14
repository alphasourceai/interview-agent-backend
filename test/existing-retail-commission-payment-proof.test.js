'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { recurringFixture } = require('./fixtures/existing-retail-recurring-funding-fixture');
const { verifyExistingRetailRecurringFunding } = require('../src/services/existingRetailCheckoutFunding');
const { proofInput } = require('./fixtures/existing-retail-recurring-funding-fixture');
const { canonicalExistingRetailCommissionPayment: canonical, assertCommissionPaymentInput: verify, loadExistingRetailCommissionPayment: load } = require('../src/services/existingRetailCommissionPaymentProof');
function fixture(months = 3, payment = 'prepaid', ordinal = 1) {
  const f = recurringFixture('basic', months, payment, true, { ordinal }), p = verifyExistingRetailRecurringFunding(proofInput(f));
  const b = f.source.original_period, amount = f.source.package_snapshot.membership_terms.platform_payment_cents;
  const initial = { version: 'retail_existing_funding_v1', proof: { period: structuredClone(b),
    provider_account_id: f.source.original_provider_account_id, platform_gross_cents: amount, platform_discount_cents: 0,
    payment_intent_id: 'pi_INITIAL', charge_id: 'ch_INITIAL' } };
  const row = { id: 'synthetic-invoice-row', stripe_invoice_id: p.invoice_id,
    retail_period_receipt: { version: 'retail_existing_paid_period_receipt_v1', source: structuredClone(f.source), proof: structuredClone(p) } };
  return { source: f.source, initialReceipt: initial, periodRows: [row], paymentId: p.invoice_id, p };
}
test('invoice, PI and charge lookup all canonicalize to the same platform-only payment', () => {
  const f = fixture(), before = structuredClone(f);
  const results = [f.p.invoice_id, f.p.payment_intent_id, f.p.charge_id].map(paymentId => canonical({ ...f, paymentId }));
  assert.deepEqual(results[0], results[1]); assert.deepEqual(results[0], results[2]);
  assert.equal(results[0].gross_membership_cents, 120000); assert.equal(results[0].settlement_verified, false);
  assert.equal(results[0].payroll_authorized, false); assert.deepEqual(f, before);
});
for (const [months, payment, ordinal] of [[3,'prepaid',3],[6,'prepaid',1],[12,'monthly_installments',11]])
test(`${months}/${payment} ordinal${ordinal} retains first-year service eligibility`, () => {
  const f = fixture(months, payment, ordinal); assert.equal(canonical(f).ordinal, ordinal);
});
for (const [months, payment, ordinal] of [[3,'prepaid',4],[6,'prepaid',2],[12,'prepaid',1],[12,'monthly_installments',12]])
test(`${months}/${payment} ordinal${ordinal} is outside original first twelve service months`, () => {
  assert.throws(() => canonical(fixture(months, payment, ordinal)), { code: 'outside_original_first_year', status: 422 });
});
test('initial payment uses its period clock and excludes role prepay, tax and cash totals', () => {
  const f = fixture(), b = f.source.original_period;
  f.initialReceipt.proof.role_gross_cents = 35900; f.initialReceipt.proof.cash_cents = 999999;
  const p = canonical({ ...f, paymentId: 'pi_INITIAL' });
  assert.equal(p.provider_payment_id, b.invoice_id); assert.equal(p.payment_success_at, b.paid_at);
  assert.equal(p.gross_membership_cents, 120000); assert.equal(p.ordinal, 0);
});
test('mismatched UI money or payment clock cannot override native proof', () => {
  const p = canonical(fixture());
  assert.equal(verify(p, { gross: p.gross_membership_cents, discount: p.discount_cents, paymentAt: p.payment_success_at }), p);
  for (const changed of [{ gross: 1 }, { discount: 1 }, { paymentAt: '2026-01-01Z' }])
    assert.throws(() => verify(p, { gross: p.gross_membership_cents, discount: p.discount_cents, paymentAt: p.payment_success_at, ...changed }),
      { code: 'native_commission_proof_conflict', status: 422 });
});
for (const [name, change] of [['foreign source', f => { f.periodRows[0].retail_period_receipt.source.client_id = 'FOREIGN'; }],
  ['wrong invoice row', f => { f.periodRows[0].stripe_invoice_id = 'in_FOREIGN'; }],
  ['missing proof', f => { f.periodRows = []; }], ['duplicate proof', f => { f.periodRows.push({ ...f.periodRows[0], id: 'other-row' }); }]])
test(`${name} is a hold, not a legacy fallback`, () => {
  const f = fixture(); change(f); assert.throws(() => canonical(f), { code: 'native_commission_proof_unavailable', status: 409 });
});
function stored(f){
 const calls=[];
 const db={async rpc(name,args){calls.push([name,args]);return {data:f.source,error:null};},from(table){
  calls.push([table]);const query={select(){return query;},eq(){return query;},
   async maybeSingle(){return {data:{retail_funding_receipt:f.initialReceipt},error:null};},
   or(expression){calls.push(['filter',expression]);return query;},async limit(value){calls.push(['limit',value]);return {data:f.periodRows,error:null};}};
  return query;
 }};return{db,calls,intent:{id:f.source.source_intent_id,agreement_id:f.source.agreement_id,client_id:f.source.client_id}};
}
test('stored proof loader uses native source plus bounded global alias lookup, not Stripe or client-prefix reads',async()=>{
 const f=fixture(),{db,calls,intent}=stored(f);
 for(const key of [f.p.invoice_id,f.p.payment_intent_id,f.p.charge_id])assert.equal((await load(db,intent,key)).provider_payment_id,f.p.invoice_id);
 assert.ok(calls.some(c=>c[0]==='limit'&&c[1]===2));assert.ok(calls.some(c=>c[0]==='filter'&&c[1].includes('charge_id.eq.')));
 await assert.rejects(load(db,intent,'in_BAD,customer.eq.anything'),{code:'native_commission_proof_unavailable',status:409});
});
test('stored loader distinguishes denied source from failed reads and holds absent/ambiguous proofs',async()=>{
 const f=fixture();
 for(const [rpc,status] of [[async()=>{throw Error('private');},503],[async()=>({data:null,error:{code:'42883'}}),503],
  [async()=>({data:null,error:{code:'P0001',message:'retail_recurring_source_changed'}}),409],
  [async()=>({data:null,error:{code:'P0001',message:'retail_recurring_source_schema_drift'}}),503],
  [async()=>({data:null,error:null}),409]]){
  const {db,intent}=stored(f);db.rpc=rpc;await assert.rejects(load(db,intent,f.paymentId),{status});
 }
 for(const rows of [[],[f.periodRows[0],{...f.periodRows[0],id:'other'}]]){
  const {db,intent}=stored({...f,periodRows:rows});await assert.rejects(load(db,intent,f.paymentId),{status:409});
 }
});
