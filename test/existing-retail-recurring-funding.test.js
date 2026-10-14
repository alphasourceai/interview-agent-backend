'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');
const{verifyExistingRetailRecurringFunding:verify,readExistingRetailRecurringFunding:read}=require('../src/services/existingRetailCheckoutFunding');
const{recurringFixture:fixture,proofInput}=require('./fixtures/existing-retail-recurring-funding-fixture');
const{OFFER_VERSION,STRIPE_RECURRING_OFFER_VERSION,RETAIL_PRICES_CENTS}=require('../src/services/membershipOffers');
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
test(`cycle cash on existing price ${plan}/${months}/${payment}/first-role:${role}`,async()=>{
  const f=fixture(plan,months,payment,role,{ordinal:3}),before=structuredClone(proofInput(f)),p=verify(proofInput(f));
  assert.equal(p.cash_cents,RETAIL_PRICES_CENTS[plan][months][payment]);assert.equal(p.platform_net_cents,p.cash_cents);
  assert.equal(p.ordinal,3);assert.equal(p.original_paid_at,f.source.original_period.paid_at);
  assert.equal(p.paid_at,new Date(f.invoice.status_transitions.paid_at*1000).toISOString());
  assert.equal(Object.isFrozen(p),true);assert.deepEqual(proofInput(f),before);
  const result=await read(f.options);assert.deepEqual(result.proof,p);assert.equal(Object.isFrozen(result.source),true);
  assert.ok(f.calls.every(c=>!['create','update','pay','finalize','activate'].includes(c[0])));
  assert.ok(f.calls.filter(c=>c[0]==='invoice').every(c=>c[1]!==f.source.original_period.invoice_id));
});
for(const payment of ['prepaid','monthly_installments'])test(`zero and discounted ${payment} cycle uses actual net cash`,async()=>{
  const amount=RETAIL_PRICES_CENTS.basic[3][payment],f=fixture('basic',3,payment,true,{discount:amount});
  const p=verify(proofInput(f));assert.equal(p.cash_cents,0);assert.equal(p.platform_net_cents,0);
  assert.equal(p.payment_intent_id,null);assert.equal(p.charge_id,null);
  assert.deepEqual((await read(f.options)).proof,p);assert.equal(f.calls.filter(c=>['pi','charge'].includes(c[0])).length,0);
  const partial=fixture('basic',3,payment,false,{discount:100,tax:25}),r=verify(proofInput(partial));
  assert.equal(r.platform_net_cents,amount-100);assert.equal(r.cash_cents,amount-75);assert.equal(r.tax_cents,25);
});
test('old offer constant and initial proof remain separate; old cohort refuses cycles',async()=>{
  assert.equal(OFFER_VERSION,'retail-terms-2026-10-11-v1');assert.notEqual(OFFER_VERSION,STRIPE_RECURRING_OFFER_VERSION);
  const f=fixture();f.source.package_snapshot.pricing_version=OFFER_VERSION;f.source.package_snapshot.membership_terms.offer_version=OFFER_VERSION;
  assert.throws(()=>verify(proofInput(f)),{code:'retail_recurring_funding_source_mismatch'});
  await assert.rejects(read(f.options),{code:'retail_recurring_funding_source_mismatch'});assert.equal(f.calls.filter(c=>c[0]!=='rpc').length,0);
});
const changes=[
 ['invoice-id',f=>f.invoice.id='in_FOREIGN'],['initial-id',f=>f.invoice.id=f.source.original_period.invoice_id],
 ['reason',f=>f.invoice.billing_reason='subscription_create'],['customer',f=>f.invoice.customer='cus_OTHER'],
 ['sub',f=>f.invoice.subscription='sub_OTHER'],['mode',f=>f.invoice.livemode=true],['currency',f=>f.invoice.currency='eur'],
 ['extra-line',f=>f.invoiceLines.data.push(structuredClone(f.invoiceLines.data[0]))],['partial',f=>f.invoiceLines.has_more=true],
 ['count',f=>f.invoiceLines.total_count=2],['role',f=>f.invoiceLines.data[0].type='invoiceitem'],
 ['price',f=>f.invoiceLines.data[0].price.id='price_FOREIGN'],['price-cadence',f=>f.invoiceLines.data[0].price.recurring.interval_count=12],
 ['item',f=>f.invoiceLines.data[0].subscription_item='si_OTHER'],['quantity',f=>f.invoiceLines.data[0].quantity=2],
 ['proration',f=>f.invoiceLines.data[0].proration=true],['line-clock',f=>f.invoiceLines.data[0].period.end++],
 ['ordinal',f=>f.cycle={...f.cycle,ordinal:2}],['contract-clock',f=>f.cycle={...f.cycle,observed_original_a_period_end:'2027-01-01T00:00:00.000Z'}],
 ['account',f=>f.providerAccountId='acct_OTHER'],['paid',f=>f.invoice.paid=false],['status',f=>f.invoice.status='open'],
 ['outofband',f=>f.invoice.paid_out_of_band=true],['paid-clock',f=>f.invoice.status_transitions.paid_at=0],
 ['created-clock',f=>f.invoice.created=f.invoice.status_transitions.paid_at+1],
 ['balance',f=>f.invoice.starting_balance=1],['end-balance',f=>f.invoice.ending_balance=1],
 ['credit-before',f=>f.invoice.pre_payment_credit_notes_amount=1],['credit-after',f=>f.invoice.post_payment_credit_notes_amount=1],
 ['remaining',f=>f.invoice.amount_remaining=1],['paid-amount',f=>f.invoice.amount_paid--],['due',f=>f.invoice.amount_due--],
 ['subtotal',f=>f.invoice.subtotal--],['discount',f=>f.invoice.total_discount_amounts=[{discount:'di_BAD',amount:1}]],
 ['tax',f=>f.invoice.total_tax_amounts=[{tax_rate:'txr_BAD',inclusive:false,amount:1}]],
 ['pi-link',f=>f.paymentIntent.invoice='in_OTHER'],['charge-link',f=>f.charge.payment_intent='pi_OTHER'],
 ['pi-mode',f=>f.paymentIntent.livemode=true],['charge-mode',f=>f.charge.livemode=true],['pi-cash',f=>f.paymentIntent.amount_received--],
 ['charge-cash',f=>f.charge.amount_captured--],['capture',f=>f.charge.captured=false],['refund',f=>f.charge.amount_refunded=1],
 ['refund-flag',f=>f.charge.refunded=true],['dispute',f=>f.charge.disputed=true]
];
for(const[name,change]of changes)test(`cycle funding rejects ${name}`,()=>{
  const f=fixture();f.cycle=structuredClone(f.cycle);change(f);
  assert.throws(()=>verify(proofInput(f)),e=>e.status===409);
});
test('zero requires explicit no payment/charge, balanced full discount and no tax',()=>{
  for(const change of [f=>f.invoice.payment_intent='pi_UNEXPECTED',f=>delete f.invoice.charge,
    f=>f.paymentIntent={},f=>f.invoice.total_discount_amounts=[],f=>f.invoice.starting_balance=100]){
    const f=fixture('basic',3,'prepaid',false,{discount:120000});change(f);assert.throws(()=>verify(proofInput(f)),e=>e.status===409);
  }
});
test('hostile graphs execute no accessor or proxy',async()=>{
  let reads=0;const f=fixture();Object.defineProperty(f.invoice,'paid',{enumerable:true,get(){reads++;throw Error('private');}});
  assert.throws(()=>verify(proofInput(f)),{code:'retail_recurring_funding_invalid_graph'});assert.equal(reads,0);
  const g=fixture();Object.defineProperty(g.options,'invoiceId',{enumerable:true,get(){reads++;throw Error('private');}});
  await assert.rejects(read(g.options),{code:'retail_recurring_funding_invalid_input'});assert.equal(reads,0);
});
test('fresh financial re-read, account/source/API fences and sanitized transport hold',async()=>{
  for(const stage of ['invoice','line','pi','charge','account','source','api','transport','gap']){
    const f=fixture();let reads=0;
    if(stage==='invoice'){const old=f.sdk.invoices.retrieve;f.sdk.invoices.retrieve=async id=>{const r=await old(id);if(++reads===2)r.amount_paid--;return r;};}
    if(stage==='line'){const old=f.sdk.invoices.listLineItems;f.sdk.invoices.listLineItems=async(...args)=>{const r=await old(...args);if(++reads===3)r.data[0].amount--;return r;};}
    if(stage==='pi'){const old=f.sdk.paymentIntents.retrieve;f.sdk.paymentIntents.retrieve=async id=>{const r=await old(id);if(++reads===2)r.status='processing';return r;};}
    if(stage==='charge'){const old=f.sdk.charges.retrieve;f.sdk.charges.retrieve=async id=>{const r=await old(id);if(++reads===2)r.disputed=true;return r;};}
    if(stage==='account')f.sdk.accounts.retrieve=async()=>({object:'account',id:++reads===4?'acct_OTHER':'acct_SYNTHETIC'});
    if(stage==='source'){const old=f.db.rpc;f.db.rpc=async(...args)=>{const r=await old(...args);if(++reads===4)r.data.source_intent_id=null;return r;};}
    if(stage==='api')f.sdk.getApiField=()=> ++reads>8?'2024-06-20':'2023-10-16';
    if(stage==='transport')f.sdk.charges.retrieve=async()=>{throw Error('PRIVATE_URL_TOKEN');};
    if(stage==='gap')f.invs.pop();
    await assert.rejects(read(f.options),e=>[409,503].includes(e.status)&&!e.message.includes('PRIVATE'));
  }
});
