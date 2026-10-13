'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {createFakeSupabase}=require('./helpers/fakeSupabase');
const {buildRetailPackageSnapshot}=require('../src/services/membershipPackageCompatibility');
const {OFFER_VERSION}=require('../src/services/membershipOffers');
const {normalizeSalesDraft,agreementInputFromDraft}=require('../src/services/salesWorkspace');
const {buildMembershipAgreementHtml}=require('../src/render/membershipAgreement');
const {readExistingRetailCheckoutFunding:read,assertExistingRetailFundingSource:current,collect}=require('../src/services/existingRetailCheckoutFunding');
const {readSavedRetailCheckoutTerms}=require('../src/services/savedMembershipCheckoutTerms');
const {fixture,PAID,A,C}=require('./fixtures/existing-retail-funding-fixture');
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
  test(`existing funding ${plan}/${months}/${payment}/role:${role}`,async()=>{
    const f=fixture(plan,months,payment,role),r=await read(f.options);assert.equal(r.paidAt,PAID);assert.equal(r.platformNetCents,f.pkg.platform_fee_cents);
    assert.equal(r.roleNetCents,role?f.pkg.first_role_prepay.discounted_credit_amount_cents:0);assert.equal(r.replay,false);
    assert.equal(r.invoiceId,'in_INITIAL');assert.equal(r.checkoutSessionId,'cs_SYNTHETIC');assert.ok(f.fences>=8);await current({db:f.db,funding:r});
    assert.equal(f.db.calls.some(c=>['update','insert','upsert'].includes(c.op)),false);
  });
test('monthly actual discount and exclusive-tax allocations reconcile without a new receipt write',async()=>{
  const f=fixture('basic',6,'monthly_installments',true,{promo:true,tax:true}),r=await read(f.options);
  assert.equal(r.platformDiscountCents,3990);assert.equal(r.platformNetCents,35910);assert.equal(r.roleDiscountCents,3590);
  assert.equal(r.roleNetCents,32310);assert.equal(r.taxCents,200);assert.equal(r.cashCents,68420);
});
test('stored-deadline mode accepts timely cash after webhook delay; Checkout still refuses expired stored quote',async()=>{
  const f=fixture();assert.throws(()=>readSavedRetailCheckoutTerms({agreement:f.g,intent:f.i}),{code:'agreement_expired'});
  assert.equal((await read(f.options)).paidAt,PAID);
});
test('null Session invoice finds unique initial invoice rather than later subscription latest_invoice',async()=>{
  const f=fixture();f.cs.invoice=null;assert.equal((await read({...f.options,eventSessionId:null,eventInvoiceId:'in_INITIAL'})).invoiceId,'in_INITIAL');
  assert.equal(f.calls.some(c=>c[0]==='invoice'&&c[1]==='in_LATER_ZERO'),false);
});
test('all provider list pages are read with a fence, not trusted as a truncated first page',async()=>{
  const f=fixture('pro',12,'prepaid',true);let pages=0;
  f.sdk.checkout.sessions.listLineItems=async(_id,p)=>{pages++;return{object:'list',data:[structuredClone(f.cl[p.starting_after?1:0])],has_more:!p.starting_after}};
  assert.equal((await read(f.options)).paidAt,PAID);assert.equal(pages,2);
  await assert.rejects(collect(async()=>({object:'list',data:[],has_more:true}),async()=>{}),{code:'retail_funding_list_incomplete'});
  await assert.rejects(collect(async()=>({object:'list',data:[{id:'same'}],has_more:true}),async()=>{}),{code:'retail_funding_list_identity'});
});
test('admin no-intent source uses only agreement Session ID and does not create an intent or paired clock',async()=>{
  const f=fixture('pro',3,'prepaid',true,{admin:true}),r=await read(f.options);assert.equal(r.paidAt,PAID);assert.equal(r.sourceIntentId,null);
  assert.equal(f.tables.public_purchase_intents.length,0);await current({db:f.db,funding:r});
});
test('already-paid linked and admin replays skip monetary revalidation/refunds and preserve stored clock',async()=>{
  for(const admin of [false,true]){const f=fixture('basic',3,'prepaid',false,{admin});f.g.checkout_paid_at=PAID;f.g.checkout_status='paid';
    if(!admin)f.i.activated_at=PAID;f.c.stripe_subscription_id=f.s.id;f.ch.refunded=true;f.ch.amount_refunded=f.ch.amount;
    f.sdk.invoices.retrieve=async()=>{throw Error('Do not recompute initial receipt')};
    const r=await read(f.options);assert.equal(r.paidAt,PAID);assert.equal(r.replay,true);await current({db:f.db,funding:r});}
});
test('linked completion-before-billing crash resumes stored-clock tail without requiring a client subscription id',async()=>{
  const f=fixture();f.g.checkout_paid_at=PAID;f.g.checkout_status='paid';f.i.activated_at=PAID;f.c.stripe_subscription_id=null;
  f.ch.refunded=true;f.sdk.invoices.retrieve=async()=>{throw Error('No new first-money proof on paired-clock retry')};
  const r=await read(f.options);assert.equal(r.replay,true);assert.equal(r.paidAt,PAID);await current({db:f.db,funding:r});
});
test('admin paid-clock-only retry reproves original cash and finishes tail, never invents another clock',async()=>{
  const f=fixture('basic',3,'prepaid',false,{admin:true});f.g.checkout_paid_at=PAID;f.g.checkout_status='paid';
  const r=await read(f.options);assert.equal(r.replay,false);assert.equal(r.paidAt,PAID);await current({db:f.db,funding:r});
  f.inv.status_transitions.paid_at=A+1;await assert.rejects(read(f.options),{code:'retail_funding_original_clock_mismatch'});
});
test('terminal sources bypass proof so current activate can retain its original terminal result',async()=>{
  for(const change of [f=>f.i.status='canceled',f=>f.g.superseded_by_agreement_id='superseded',f=>f.i.protocol='legacy_complete']){
    const f=fixture();change(f);assert.equal(await read(f.options),null);assert.deepEqual(f.calls,[]);}
});
test('identity, funding, tax, discounts, deadlines and truncation mutations all refuse with zero write effects',async()=>{
  const mutations=[f=>f.options.eventLivemode=true,f=>f.options.eventSessionId='cs_OTHER',f=>f.options.eventInvoiceId='in_OTHER',
    f=>f.options.eventSubscriptionId='sub_OTHER',f=>f.cs.customer='cus_OTHER',f=>f.s.customer='cus_OTHER',f=>f.inv.customer='cus_OTHER',
    f=>f.pi.customer='cus_OTHER',f=>f.ch.customer='cus_OTHER',f=>f.pi.livemode=true,f=>f.ch.livemode=true,
    f=>f.inv.livemode=true,f=>f.cs.mode='payment',f=>f.cs.payment_status='unpaid',f=>f.s.status='trialing',
    f=>f.cl[0].price.unit_amount=1,f=>f.cl[0].quantity=2,f=>f.il[0].proration=true,
    f=>f.inv.paid_out_of_band=true,f=>f.inv.starting_balance=1,f=>f.inv.ending_balance=1,
    f=>f.inv.pre_payment_credit_notes_amount=1,f=>f.inv.amount_paid--,f=>f.pi.amount_received--,f=>f.ch.amount_captured--,
    f=>f.inv.status_transitions.paid_at=null,f=>f.inv.status_transitions.paid_at=A+40*86400,f=>f.inv.status_transitions.paid_at=A-40*86400,
    f=>f.inv.total_discount_amounts=null,f=>f.il[0].discount_amounts=null,f=>f.il[0].tax_amounts=null,
    f=>f.inv.total_tax_amounts=[{amount:1,inclusive:true,tax_rate:'txr_QA'}],f=>f.inv.payment_intent=null,
    f=>f.inv.charge=null,f=>f.ch.disputed=true,f=>f.ch.refunded=true,f=>f.ch.amount_refunded=1,
    f=>f.tables.billing_customers.push({id:'other',client_id:C,stripe_customer_id:'cus_SYNTHETIC'}),f=>f.i.stripe_checkout_session_id='cs_OTHER',
    f=>f.sdk.subscriptionItems.list=async()=>({object:'list',data:[],has_more:true}),f=>f.sdk.charges.retrieve=async()=>{throw Error('synthetic provider unavailable')},
    f=>f.options.assertFence=async()=>{throw Error('synthetic fence lost')}];
  for(const mutate of mutations){const f=fixture();mutate(f);await assert.rejects(read(f.options),e=>
    !(e instanceof ReferenceError || e instanceof TypeError) &&
    (typeof e.code==='string' && /retail_|package_snapshot|agreement_|purchase_intent_/.test(e.code) || /^synthetic /.test(e.message)));
    assert.equal(f.db.calls.some(c=>['update','insert','upsert'].includes(c.op)),false);}
});
test('prepaid extra discounts and missing accepted source never become a cheaper fallback',async()=>{
  const f=fixture('basic',3,'prepaid',false,{promo:true});await assert.rejects(read(f.options));
  const bad=fixture();bad.g.template_snapshot.package_snapshot={pricing_protocol:'bad'};await assert.rejects(read(bad.options));
  const erased=fixture('basic',3,'monthly_installments');
  erased.g.template_snapshot.package_snapshot={plan_key:'basic',billing_cadence:'monthly',platform_fee:299};
  erased.i.package_snapshot=structuredClone(erased.g.template_snapshot.package_snapshot);
  await assert.rejects(read(erased.options),{code:'package_snapshot_missing'});
});
test('source reread rejects commercial, session or customer changes during readback',async()=>{
  for(const mutate of [f=>f.g.checkout_session_id='cs_OTHER',f=>f.g.template_snapshot.values.platform_fee='1',
    f=>f.c.stripe_customer_id='cus_OTHER',f=>f.g.client_id='other',f=>f.i.canceled_at=PAID]){
    const f=fixture(),r=await read(f.options);mutate(f);await assert.rejects(current({db:f.db,funding:r}));
  }
});
test('truncated matching billing-customer reads cannot hide an ambiguous current customer beyond the REST row cap',async()=>{
  const f=fixture();f.tables.billing_customers.push({id:'hidden',client_id:C,stripe_customer_id:'cus_SYNTHETIC'});
  f.options.db=createFakeSupabase(f.tables,{maxRows:1});
  await assert.rejects(read(f.options),{code:'retail_funding_customer_mismatch'});
});
test('actual paid cash proof accepts current profile alongside historical profiles without rewriting them',async()=>{
  const f=fixture();f.tables.billing_customers.push({id:'HISTORICAL',client_id:C,stripe_customer_id:'cus_OLD'});
  const before=structuredClone(f.tables.billing_customers),result=await read(f.options);
  assert.equal(result.paidAt,PAID);await current({db:f.db,funding:result});assert.deepEqual(f.tables.billing_customers,before);
});
test('funding current-profile correspondence holds for absent, duplicate, another owner and changed customer',async()=>{
  for(const kind of ['absent','duplicate','owner','customer']) {
    const f=fixture();
    if(kind==='absent')f.tables.billing_customers.splice(0);
    if(kind==='duplicate')f.tables.billing_customers.push({...f.tables.billing_customers[0],id:'DUPLICATE'});
    if(kind==='owner')f.tables.billing_customers[0].client_id='OTHER';
    if(kind==='customer')f.tables.billing_customers[0].stripe_customer_id='cus_OTHER';
    await assert.rejects(read(f.options),{code:'retail_funding_customer_mismatch'});
  }
});
module.exports={fixture,PAID};
