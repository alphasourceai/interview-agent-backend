'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {generationFixture}=require('./fixtures/generation-retail-funding-fixture');
const {readExistingRetailCheckoutFunding}=require('../src/services/existingRetailCheckoutFunding');
const {inspectExistingRetailRecurringPeriods:inspect}=require('../src/services/existingRetailRecurringPeriods');
const {anchoredMonthInstant,retailTermWindow}=require('../src/services/membershipOffers');
async function fixture(plan='basic',months=3,payment='prepaid',role=false,settings){
 const f=generationFixture(plan,months,payment,role,settings),funding=await readExistingRetailCheckoutFunding(f.options);
 const p=funding.initialProviderSchedule,interval=f.offer.stripe_recurrence.interval_count;
 const invoices=[structuredClone(f.inv)];
 for(let n=1;n<=14;n++){
  const start=anchoredMonthInstant(p.first_collection_at,(n-1)*interval),end=anchoredMonthInstant(p.first_collection_at,n*interval);
  invoices.push({id:'in_CYCLE'+n,object:'invoice',currency:'usd',livemode:false,customer:p.customer_id,
   subscription:p.subscription_id,billing_reason:'subscription_cycle',lines:{object:'list',has_more:false,data:[{
    ...structuredClone(f.il[1]),id:'il_CYCLE'+n,price:f.s.items.data[0].price,amount:f.offer.platform_payment_cents,
    period:{start:Date.parse(start)/1000,end:Date.parse(end)/1000}}]}});
 }
 return {f,p,input:{packageSnapshot:f.pkg,originalPeriod:p,originalProviderAccountId:'acct_SYNTHETIC',providerAccountId:'acct_SYNTHETIC',
  invoices:{object:'list',data:invoices,has_more:false}}};
}
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
 test(`existing chronology distinguishes native collection and fixed contract ${plan}/${months}/${payment}/role=${role}`,async()=>{
  const {f,p,input}=await fixture(plan,months,payment,role),before=structuredClone(input),r=inspect(input);
  assert.equal(r.version,'retail_generation_recurring_period_observation_v1');assert.equal(r.cycle_count,14);
  for(const flag of ['effect_authorized','collection_ready','paid_access_authorized','collection_absence_proven','provider_effect_absence_proven'])assert.equal(r[flag],false);
  for(const c of r.cycles){const n=c.ordinal,interval=f.offer.stripe_recurrence.interval_count;
   assert.equal(c.provider_period_start,Date.parse(anchoredMonthInstant(p.first_collection_at,(n-1)*interval))/1000);
   assert.equal(c.observed_generation_period_start,anchoredMonthInstant('2026-01-31T00:00:00.000Z',n*interval));
   assert.equal(c.observed_generation_period_end,anchoredMonthInstant('2026-01-31T00:00:00.000Z',(n+1)*interval));
   assert.equal(c.observed_original_a_period_start,undefined,'never relabel cash-clock windows');
   const index=payment==='prepaid'?n:Math.floor(n/months),term=retailTermWindow({originalStart:'2026-01-31T00:00:00.000Z',commitmentMonths:months,termIndex:index});
   assert.equal(c.term_index,index);assert.equal(c.installment_index,payment==='prepaid'?1:n%months+1);
   assert.equal(c.observed_term_start_at,term.term_start_at);assert.equal(c.observed_term_end_at,term.term_end_at);
  }
  assert.equal(p.paid_at,'2026-02-02T11:00:20.000Z');assert.deepEqual(input,before);
  assert.ok(Object.isFrozen(r.cycles[0]));
 });
test('January31 monthly native March28 is not rewritten to contractual March31',async()=>{
 const {input}=await fixture(),monthly=await fixture('basic',3,'monthly_installments');
 const c=inspect(monthly.input).cycles[1];
 assert.equal(new Date(c.provider_period_start*1000).toISOString(),'2026-03-28T00:00:00.000Z');
 assert.equal(c.observed_generation_period_start,'2026-03-31T00:00:00.000Z');
 const prepaid=inspect(input).cycles[1];
 assert.equal(new Date(prepaid.provider_period_start*1000).toISOString(),'2026-07-30T00:00:00.000Z');
 assert.equal(prepaid.observed_generation_period_start,'2026-07-31T00:00:00.000Z');
});
test('leap-year generation remains February29 on the original contract calendar, not the native February28 collection anchor',async()=>{
 const {input}=await fixture('pro',12,'prepaid',true,{generatedAt:'2028-02-29T10:00:00.000Z',paidAt:'2028-03-02T11:00:20.000Z'});
 const r=inspect(input),cycle=r.cycles[3];
 assert.equal(new Date(cycle.provider_period_start*1000).toISOString(),'2032-02-28T00:00:00.000Z');
 assert.equal(cycle.observed_generation_period_start,'2032-02-29T00:00:00.000Z');
 assert.equal(cycle.observed_term_start_at,'2032-02-29T00:00:00.000Z');
 assert.equal(input.originalPeriod.paid_at,'2028-03-02T11:00:20.000Z');
});
test('schedule/source/price/line/calendar/version mutations and missing cycles fail without partial observations',async()=>{
 const {input}=await fixture('pro',3,'monthly_installments',true);
 for(const mutate of [i=>i.originalPeriod.version='retail_initial_provider_period_v1',
  i=>i.originalPeriod.generated_at='2026-02-02T10:00:00.000Z',i=>i.originalPeriod.initial_term_start='2026-02-02',
  i=>i.originalPeriod.first_collection_at='2026-03-01T00:00:00.000Z',i=>i.originalPeriod.provider_trial_end++,
  i=>i.originalPeriod.billing_cycle_anchor++,i=>i.originalPeriod.recurring_platform_price_id=i.originalPeriod.initial_platform_price_id,
  i=>i.originalPeriod.first_role_price_id=null,i=>i.originalPeriod.paid_at='2026-03-01T00:00:00.000Z',
  i=>i.originalPeriod.extra=true,i=>i.providerAccountId='acct_OTHER',i=>i.invoices.has_more=true,
  i=>i.invoices.data.splice(1,1),i=>i.invoices.data[1].lines.data[0].period.start++,
  i=>i.invoices.data[1].lines.data[0].price.id='price_INITIAL_PLATFORM',
  i=>i.invoices.data[1].lines.data[0].subscription_item='si_OTHER']){
  const bad=structuredClone(input);mutate(bad);assert.throws(()=>inspect(bad),e=>/^retail_recurring_period_/.test(e.code));
 }
});
