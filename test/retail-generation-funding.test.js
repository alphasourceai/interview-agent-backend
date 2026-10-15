'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture}=require('./fixtures/existing-retail-funding-fixture');
const {buildRetailPackageSnapshot}=require('../src/services/membershipPackageCompatibility');
const {GENERATION_DATE_OFFER_VERSION,retailGenerationTermDates,retailGenerationCollectionSchedule}=require('../src/services/membershipOffers');
const {verifyExistingRetailFunding:verify}=require('../src/services/existingRetailCheckoutFunding');
const GENERATED='2026-01-31T10:00:00.000Z',PAID='2026-02-02T11:00:20.000Z',A=Date.parse(PAID)/1000;
function funding(plan='basic',months=3,payment='prepaid',role=false,{discount=false,tax=false}={}){
  const f=fixture(plan,months,payment,role),pkg=buildRetailPackageSnapshot({planKey:plan,commitmentMonths:months,
    paymentOption:payment,firstRolePrepaySelected:role,channel:'sales',offerVersion:GENERATION_DATE_OFFER_VERSION});
  const offer=pkg.membership_terms,dates=retailGenerationTermDates({generatedAt:GENERATED,commitmentMonths:months});
  const schedule=retailGenerationCollectionSchedule({offer,generatedAt:GENERATED,initialTermStart:dates.initial_term_start,
    initialRenewalDate:dates.initial_renewal_date,now:new Date((A-20)*1000).toISOString()});
  const recurring=f.cl[0].price,initial={...recurring,id:'price_INITIAL_PLATFORM',type:'one_time',recurring:null};
  const entries=[{id:'li_INITIAL_PLATFORM',price:initial,amount:offer.platform_payment_cents},
    {id:'li_RECURRING',price:recurring,amount:0},
    ...(role?[{id:'li_ROLE',price:f.cl[1].price,amount:offer.first_role_prepay.amount_cents}]:[])];
  const checkoutLines=entries.map(e=>({id:e.id,object:'item',currency:'usd',quantity:1,price:e.price,
    amount_subtotal:e.amount,amount_discount:discount?Math.round(e.amount/10):0,
    amount_tax:tax&&e.amount?100:0,amount_total:e.amount-(discount?Math.round(e.amount/10):0)+(tax&&e.amount?100:0)}));
  const invoiceLines=entries.map((e,n)=>({id:n===0?'il_INITIAL_PLATFORM':n===1?'il_RECURRING':'il_ROLE',object:'line_item',price:e.price,
    currency:'usd',quantity:1,amount:e.amount,type:n===1?'subscription':'invoiceitem',subscription:f.s.id,
    subscription_item:n===1?'si_SYNTHETIC':null,proration:false,
    period:{start:A-10,end:n===1?schedule.trial_end:A-10},
    discount_amounts:discount&&e.amount?[{discount:'di_SYNTHETIC',amount:Math.round(e.amount/10)}]:[],
    tax_amounts:tax&&e.amount?[{tax_rate:'txr_SYNTHETIC',inclusive:false,amount:100}]:[]}));
  const disc=checkoutLines.reduce((s,l)=>s+l.amount_discount,0),taxes=checkoutLines.reduce((s,l)=>s+l.amount_tax,0);
  const total=offer.initial_payment_cents-disc+taxes;
  Object.assign(f.cs,{created:A-20,amount_subtotal:offer.initial_payment_cents,amount_total:total});
  Object.assign(f.s,{status:'trialing',start_date:A-10,trial_start:A-10,trial_end:schedule.trial_end,
    billing_cycle_anchor:schedule.trial_end,current_period_start:A-10,current_period_end:schedule.trial_end,
    schedule:null,pause_collection:null,cancel_at:null,cancel_at_period_end:false});
  Object.assign(f.inv,{created:A-10,status_transitions:{paid_at:A},subtotal:offer.initial_payment_cents,
    total,amount_due:total,amount_paid:total,total_discount_amounts:discount?[{discount:'di_SYNTHETIC',amount:disc}]:[],
    total_tax_amounts:tax?[{tax_rate:'txr_SYNTHETIC',inclusive:false,amount:taxes}]:[]});
  Object.assign(f.pi,{amount:total,amount_received:total});Object.assign(f.ch,{amount:total,amount_captured:total});
  const list=data=>({object:'list',data,has_more:false});
  return {offer,checkout:f.cs,checkoutLines:list(checkoutLines),subscription:f.s,
    subscriptionItems:list([{...f.s.items.data[0],object:'subscription_item'}]),invoice:f.inv,invoiceLines:list(invoiceLines),
    paymentIntent:f.pi,charge:f.ch,expected:{checkoutId:f.cs.id,customerId:f.c.stripe_customer_id,
      subscriptionId:f.s.id,eventLivemode:false,signedAt:'2026-02-02T10:00:00.000Z',agreementDeadline:'2026-02-07T10:00:00.000Z',
      intentDeadline:'2026-02-07T10:00:00.000Z',generatedAt:GENERATED,initialTermStart:dates.initial_term_start,
      initialRenewalDate:dates.initial_renewal_date,prices:{initial_platform_price_id:initial.id,
        recurring_platform_price_id:recurring.id,first_role_price_id:role?'price_ROLE':null}}};
}
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
test(`generation-date initial cash ${plan}/${months}/${payment}/role:${role}`,()=>{
  const input=funding(plan,months,payment,role),before=structuredClone(input),proof=verify(input);
  assert.equal(proof.paidAt,PAID);assert.equal(proof.platformNetCents,input.offer.platform_payment_cents);
  assert.equal(proof.roleNetCents,input.offer.first_role_prepay.amount_cents);
  assert.equal(proof.initialProviderSchedule.initial_term_start,'2026-01-31');
  assert.equal(proof.initialProviderSchedule.initial_renewal_date,input.expected.initialRenewalDate);
  assert.equal(proof.initialProviderSchedule.paid_at,PAID);
  assert.equal(proof.initialProviderSchedule.initial_platform_price_id,'price_INITIAL_PLATFORM');
  assert.equal(proof.initialProviderSchedule.recurring_platform_price_id,'price_PLATFORM');
  assert.equal(Object.hasOwn(proof,'initialProviderPeriod'),false,'trial interval never masquerades as the v2 funded recurring period');
  assert.deepEqual(input,before);
});
test('monthly discounts and tax reconcile actual platform versus role cash, not all one-time cash as role',()=>{
  const input=funding('basic',6,'monthly_installments',true,{discount:true,tax:true}),proof=verify(input);
  assert.equal(proof.platformDiscountCents,3990);assert.equal(proof.platformNetCents,35910);
  assert.equal(proof.roleDiscountCents,3590);assert.equal(proof.roleNetCents,32310);
  assert.equal(proof.taxCents,200);assert.equal(proof.cashCents,68420);
  assert.throws(()=>verify(funding('basic',3,'prepaid',true,{discount:true})),{code:'retail_funding_checkout_line_mismatch'});
});
test('only full initial paid invoice plus captured money can qualify; scheduling, IDs, dates and zero-cash mutations all fail',()=>{
  const mutations=[
    i=>i.expected.prices=null,i=>i.expected.prices.initial_platform_price_id='price_OTHER',
    i=>i.expected.prices.initial_platform_price_id=i.expected.prices.recurring_platform_price_id,
    i=>i.expected.prices.first_role_price_id=null,i=>i.expected.eventLivemode=true,
    i=>i.checkout.payment_status='unpaid',i=>i.checkout.payment_status='no_payment_required',i=>i.subscription.status='incomplete',
    i=>i.subscription.status='past_due',i=>i.subscription.trial_end++,i=>i.subscription.billing_cycle_anchor++,
    i=>i.subscription.trial_start--,i=>i.subscription.current_period_start--,i=>i.subscription.current_period_end++,
    i=>i.subscription.schedule='sub_sched_OTHER',i=>i.subscription.pause_collection={},i=>i.subscription.cancel_at=A+100,
    i=>i.subscription.cancel_at_period_end=true,i=>i.expected.initialTermStart='2026-02-02',
    i=>i.expected.generatedAt='2026-02-02T10:00:00.000Z',i=>i.expected.initialRenewalDate='2026-05-02',
    i=>i.expected.signedAt='2026-02-03T00:00:00.000Z',i=>i.expected.agreementDeadline=PAID,i=>i.expected.intentDeadline=PAID,
    i=>i.invoice.billing_reason='subscription_cycle',i=>i.invoice.customer='cus_OTHER',i=>i.invoice.subscription='sub_OTHER',
    i=>i.invoice.amount_paid--,i=>i.invoice.amount_remaining=1,i=>i.invoice.paid=false,i=>i.invoice.status='open',
    i=>i.invoice.starting_balance=1,i=>i.invoice.ending_balance=1,i=>i.invoice.paid_out_of_band=true,
    i=>i.invoice.pre_payment_credit_notes_amount=1,i=>i.invoice.post_payment_credit_notes_amount=1,
    i=>i.invoiceLines.has_more=true,i=>i.checkoutLines.has_more=true,i=>i.subscriptionItems.has_more=true,
    i=>i.invoiceLines.data[1].amount=1,i=>i.invoiceLines.data[1].period.end++,i=>i.invoiceLines.data[0].type='subscription',
    i=>i.invoiceLines.data[0].price.id='price_ROLE',i=>i.invoiceLines.data[0].quantity=2,
    i=>i.checkoutLines.data[1].amount_subtotal=1,i=>i.checkoutLines.data[0].price.unit_amount--,
    i=>i.paymentIntent.status='requires_action',i=>i.paymentIntent.amount_received--,
    i=>i.charge.amount_captured--,i=>i.charge.refunded=true,i=>i.charge.disputed=true,i=>i.charge.paid=false,
    i=>i.invoice.total=0
  ];
  for(const mutate of mutations){const input=structuredClone(funding('pro',3,'prepaid',true));mutate(input);
    assert.throws(()=>verify(input),e=>typeof e.code==='string'&&/^retail_/.test(e.code),String(mutate));}
});
test('late webhook may observe active subscription but still proves original paid cash and fixed initial schedule',()=>{
  const input=funding();input.subscription.status='active';
  input.subscription.current_period_start=input.subscription.trial_end;
  input.subscription.current_period_end=input.subscription.trial_end+90*86400;
  assert.equal(verify(input).paidAt,PAID);
});
