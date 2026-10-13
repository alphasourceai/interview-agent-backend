'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {fixture,PAID,A}=require('./fixtures/existing-retail-funding-fixture');
const {readExistingRetailCheckoutFunding:read}=require('../src/services/existingRetailCheckoutFunding');
const {anchoredMonthInstant}=require('../src/services/membershipOffers');

function seedPeriod(f) {
  // Synthetic provider response; deliberately different from the cash date A.
  // The producer must preserve these raw values, not calculate a new term.
  const start=A-10,end=Date.parse(anchoredMonthInstant(new Date(start*1000).toISOString(),f.pkg.membership_terms.stripe_recurrence.interval_count))/1000;
  f.il[0].period={start,end};
  if(f.il[1])f.il[1].period={start:1,end:1};
  return {start,end};
}
const writes=f=>f.db.calls.filter(c=>['update','insert','upsert','delete','rpc'].includes(c.op));
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
test(`original platform period ${plan}/${months}/${payment}/role:${role}`,async()=>{
  const f=fixture(plan,months,payment,role),b=seedPeriod(f),r=await read(f.options);
  assert.deepEqual(r.initialProviderPeriod,{version:'retail_initial_provider_period_v1',api_version:'2023-10-16',
    invoice_id:'in_INITIAL',platform_invoice_line_id:'il_PLATFORM',price_id:'price_PLATFORM',subscription_id:'sub_SYNTHETIC',
    subscription_item_id:'si_SYNTHETIC',customer_id:'cus_SYNTHETIC',checkout_session_id:'cs_SYNTHETIC',livemode:false,
    paid_at:PAID,provider_period_start:b.start,provider_period_end:b.end});
  assert.equal(Object.isFrozen(r.initialProviderPeriod),true);
  assert.throws(()=>{r.initialProviderPeriod.provider_period_start=A;},TypeError);
  assert.equal(r.paidAt,PAID);assert.notEqual(r.initialProviderPeriod.provider_period_start,A);
  assert.equal(r.invoiceId,r.initialProviderPeriod.invoice_id);assert.deepEqual(writes(f),[]);
});
test('raw original period ignores current provider dates, latest invoice and role-line period',async()=>{
 const f=fixture('pro',6,'monthly_installments',true),b=seedPeriod(f);
 f.s.current_period_start=1;f.s.current_period_end=2;f.s.billing_cycle_anchor=3;f.s.start_date=4;
 f.s.latest_invoice='in_OTHER';f.il[1].period=null;f.cs.invoice=null;
 const r=await read(f.options);assert.equal(r.initialProviderPeriod.provider_period_start,b.start);
 assert.equal(r.initialProviderPeriod.provider_period_end,b.end);assert.equal(r.initialProviderPeriod.invoice_id,'in_INITIAL');
 assert.equal(f.calls.some(c=>c[0]==='invoice'&&c[1]==='in_OTHER'),false);assert.deepEqual(writes(f),[]);
});
test('delayed first cash after provider period end retains actual payment clock instead of shifting B',async()=>{
 const f=fixture('basic',3,'monthly_installments'),b=seedPeriod(f),late='2026-03-03T12:13:14.000Z';
 f.g.agreement_expires_at=f.i.expires_at='2026-03-15T00:00:00.000Z';f.inv.status_transitions.paid_at=Date.parse(late)/1000;
 const r=await read(f.options);assert.equal(r.paidAt,late);assert.equal(r.initialProviderPeriod.paid_at,late);
 assert.equal(r.initialProviderPeriod.provider_period_end,b.end);assert.ok(Date.parse(late)/1000>b.end);assert.deepEqual(writes(f),[]);
});
test('original platform period rejects absent, malformed, non-integer, reversed and future-start evidence without writes',async()=>{
 const changes=[f=>delete f.il[0].period,f=>f.il[0].period=null,f=>f.il[0].period={},
  ...[0,-1,NaN,Infinity,1.5,'1',253402300800,Number.MAX_SAFE_INTEGER].flatMap(v=>[
   f=>f.il[0].period.start=v,f=>f.il[0].period.end=v]),
  f=>f.il[0].period.end=f.il[0].period.start,f=>f.il[0].period.end=f.il[0].period.start-1,
  f=>f.il[0].period.start=A,f=>f.il[0].object='invoiceitem',f=>f.il[0].id='li_OTHER',f=>f.il[0].id='il_'];
 for(const mutate of changes){const f=fixture();seedPeriod(f);mutate(f);
  await assert.rejects(read(f.options),{code:'retail_funding_initial_period_invalid'});assert.deepEqual(writes(f),[]);
 }
});
test('original zero-cash permanent hold precedes invalid period; no tuple grants settlement',async()=>{
 const f=fixture('basic',3,'monthly_installments');delete f.il[0].period;
 f.inv.total=f.inv.amount_paid=f.inv.amount_due=0;f.cs.amount_total=0;f.cs.payment_status='no_payment_required';
 f.il[0].discount_amounts=[{amount:f.inv.subtotal,discount:'di_ZERO'}];f.inv.total_discount_amounts=[{amount:f.inv.subtotal,discount:'di_ZERO'}];
 f.cl[0].amount_discount=f.inv.subtotal;f.cl[0].amount_total=0;f.inv.payment_intent=f.inv.charge=null;
 await assert.rejects(read(f.options),e=>e.code==='retail_funding_zero_cash_requires_review'&&e.permanentFailure===true);
 assert.deepEqual(writes(f),[]);
});
test('period tuple has concrete scalar provider identifiers, never a missing subscription item id',async()=>{
 const f=fixture();seedPeriod(f);delete f.s.items.data[0].id;delete f.il[0].subscription_item;
 // Complete provider pagination rejects a missing id before tuple projection.
 await assert.rejects(read(f.options),{code:'retail_funding_list_identity'});assert.deepEqual(writes(f),[]);
 const g=fixture();seedPeriod(g);g.s.items.data[0].id='si_';g.il[0].subscription_item='si_';
 await assert.rejects(read(g.options),{code:'retail_funding_initial_period_invalid'});assert.deepEqual(writes(g),[]);
});
test('already-applied and completion-before-billing replay omit period instead of recomputing initial cash',async()=>{
 for(const admin of [false,true])for(const assigned of [false,true]){
  if(admin&&!assigned)continue; // Unassigned admin tail intentionally reproves cash, not a replay.
  const f=fixture('basic',3,'prepaid',false,{admin});f.g.checkout_paid_at=PAID;f.g.checkout_status='paid';
  if(!admin)f.i.activated_at=PAID;f.c.stripe_subscription_id=assigned?f.s.id:null;
  f.il[0].period=null;f.ch.refunded=true;f.sdk.invoices.retrieve=async()=>{throw Error('Must not reread first cash');};
  const r=await read(f.options);assert.equal(r.replay,true);assert.equal(r.paidAt,PAID);
  assert.equal(Object.hasOwn(r,'initialProviderPeriod'),false);assert.deepEqual(writes(f),[]);
 }
});
test('installed Stripe16/API2023 retains original line period across complete pagination using loopback only',async()=>{
 const http=require('node:http'),Stripe=require('stripe'),f=fixture('basic',3,'monthly_installments',true),b=seedPeriod(f),requests=[];
 const server=http.createServer((req,res)=>{
  requests.push({method:req.method,path:req.url,version:req.headers['stripe-version']});
  const url=new URL(req.url,'http://localhost');let payload;
  if(url.pathname==='/v1/checkout/sessions/cs_SYNTHETIC')payload=f.cs;
  else if(url.pathname==='/v1/subscriptions/sub_SYNTHETIC')payload=f.s;
  else if(url.pathname==='/v1/invoices/in_INITIAL')payload=f.inv;
  else if(url.pathname==='/v1/checkout/sessions/cs_SYNTHETIC/line_items')payload={object:'list',has_more:false,data:f.cl};
  else if(url.pathname==='/v1/invoices/in_INITIAL/lines'){
   const later=url.searchParams.get('starting_after')==='il_PLATFORM';
   payload={object:'list',has_more:!later,data:[f.il[later?1:0]]};
  }else if(url.pathname==='/v1/subscription_items')payload=f.s.items;
  else if(url.pathname==='/v1/payment_intents/pi_SYNTHETIC')payload=f.pi;
  else if(url.pathname==='/v1/charges/ch_SYNTHETIC')payload=f.ch;
  else{res.statusCode=400;payload={error:{message:'Unexpected synthetic request'}};}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(payload));
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 try{
  const stripe=new Stripe('sk_test_SYNTHETIC_NO_PROVIDER',{apiVersion:'2023-10-16',host:'127.0.0.1',port:server.address().port,protocol:'http',maxNetworkRetries:0});
  const r=await read({...f.options,stripe});assert.equal(r.initialProviderPeriod.provider_period_start,b.start);
  assert.equal(r.initialProviderPeriod.provider_period_end,b.end);
  assert.ok(requests.length>=9);assert.ok(requests.every(r=>r.method==='GET'&&r.version==='2023-10-16'));
  const pages=requests.filter(r=>r.path.startsWith('/v1/invoices/in_INITIAL/lines'));
  assert.equal(pages.length,2);assert.equal(new URL(pages[1].path,'http://localhost').searchParams.get('starting_after'),'il_PLATFORM');
  assert.deepEqual(writes(f),[]);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
