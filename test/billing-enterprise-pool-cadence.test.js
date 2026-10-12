'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {proveEnterprisePoolPayment:prove}=require('../src/services/enterprisePoolPaymentProof');
const fixture=require('./helpers/enterprise-pool-payment-fixture');

for(const interval of ['month','year'])for(const amount of [0,1,84000,97014]){
 test(`accepted ${interval} nominal97014 remains exact with fully collected initial platform${amount}`,()=>{
  const input=fixture({platformInterval:interval,platformCents:97014,platformAmount:amount}),before=structuredClone(input);
  const result=prove(input);assert.equal(result.platform_interval,interval);assert.equal(result.platform_nominal_cents,97014);
  assert.equal(result.platform_line_cents,amount);assert.equal(result.pool_paid_cents,69750);
  assert.equal(result.collected_cents,69750+amount);assert.equal(result.credits_spendable,false);
  assert.equal(result.membership_activation_required,true);assert.equal(result.native_receipt_required,true);
  assert.deepEqual(input,before);assert.ok(Object.isFrozen(result));
 });
}
test('annual nonprorated price equals accepted customnominal; no x12 or monthly inference',()=>{
 const full=fixture({platformInterval:'year',platformCents:97014,platformAmount:97014,proration:false});
 assert.equal(prove(full).platform_line_cents,97014);
 const partial=fixture({platformInterval:'year',platformCents:97014,platformAmount:84000,proration:false});
 assert.throws(()=>prove(partial),{code:'pool_proof_platform_line_mismatch'});
});
test('annual platform/pool exclusive tax reconciles on actual collected lines',()=>{
 const result=prove(fixture({platformInterval:'year',platformCents:120000,platformAmount:84000,tax:8400,poolTax:6975}));
 assert.equal(result.platform_nominal_cents,120000);assert.equal(result.tax_cents,15375);
 assert.equal(result.collected_cents,169125);assert.equal(result.pool_tax_cents,6975);
});
for(const [name,change] of [
 ['missing interval',b=>{delete b.platformInterval;}],['null interval',b=>{b.platformInterval=null;}],
 ['week interval',b=>{b.platformInterval='week';}],['month12 alias',b=>{b.platformInterval='month12';}],
 ['day interval',b=>{b.platformInterval='day';}],['empty interval',b=>{b.platformInterval='';}],
 ['case changed interval',b=>{b.platformInterval='YEAR';}],['snake alias only',b=>{b.platform_interval=b.platformInterval;delete b.platformInterval;}],
 ['missing nominal',b=>{delete b.platformCents;}],['zero nominal',b=>{b.platformCents=0;}],
 ['fractional nominal',b=>{b.platformCents=97014.1;}],['string nominal',b=>{b.platformCents='97014';}],
 ['ambiguous oldmonthly',b=>{b.platformMonthlyCents=b.platformCents;}],
 ['oldmonthly even undefined',b=>{b.platformMonthlyCents=undefined;}],
 ['oldmonthly null',b=>{b.platformMonthlyCents=null;}],
 ['old shape only',b=>{b.platformMonthlyCents=b.platformCents;delete b.platformCents;delete b.platformInterval;}]
])test(`${name} cannot become an accepted annual proof`,()=>{
 const input=fixture({platformInterval:'year',platformCents:97014});change(input.binding);
 assert.throws(()=>prove(input),{code:'pool_proof_invalid_binding'});
});
const copies=[p=>p.subscription.items.data[0],p=>p.invoice.lines.data[0],p=>p.checkoutLines.data[0]];
for(const [index,select] of copies.entries())for(const bad of [
 {interval:'month',interval_count:1,usage_type:'licensed'},
 {interval:'month',interval_count:12,usage_type:'licensed'},
 {interval:'year',interval_count:2,usage_type:'licensed'},
 {interval:'year',interval_count:1,usage_type:'metered'},
 {interval:'year',usage_type:'licensed'},
 {interval:'year',interval_count:1},
 {interval:'year',interval_count:'1',usage_type:'licensed'}
])test(`annual Price copy${index} requires exactaccepted cadence/count/licensed ${JSON.stringify(bad)}`,()=>{
 const input=fixture({platformInterval:'year'}),target=select(input);
 target.price={...target.price,recurring:bad};
 assert.throws(()=>prove(input),{code:'pool_proof_price_mismatch'});
});
for(const [index,select] of copies.entries())for(const amount of [10000,1440000]){
 test(`annual Price copy${index} cannot replace accepted120000 with${amount}`,()=>{
  const input=fixture({platformInterval:'year',platformCents:120000}),target=select(input);
  target.price={...target.price,unit_amount:amount,unit_amount_decimal:String(amount)};
  assert.throws(()=>prove(input),{code:'pool_proof_price_mismatch'});
 });
}
for(const [name,change] of [
 ['foreign account',p=>{p.account.id='acct_OTHER';}],['foreign mode',p=>{p.checkout.livemode=true;}],
 ['incomplete invoice',p=>{p.invoice.lines.has_more=true;}],['extra invoice line',p=>{p.invoice.lines.data.push({...p.invoice.lines.data[1],id:'il_EXTRA'});}],
 ['underpayment',p=>{p.paymentIntent.amount_received-=1;}],['refund',p=>{p.charge.refunded=true;}],
 ['discount',p=>{p.subscription.discounts=['di_SYNTHETIC'];}],['unpaid',p=>{p.checkout.payment_status='unpaid';}],
 ['wrong native interval',p=>{p.binding.platformInterval='month';}],['pool price recurring',p=>{p.invoice.lines.data[1].price.recurring={interval:'year',interval_count:1,usage_type:'licensed'};}],
 ['platform overnominal',p=>{p.invoice.lines.data[0].amount=10001;}]
])test(`annual extension still holds ${name}`,()=>{
 const input=fixture({platformInterval:'year'});change(input);assert.throws(()=>prove(input),e=>e.status===409);
});
