'use strict';
// Installed SDK -> existing reader, loopback only. Real SDK response metadata,
// authored synthetic wire bodies, no provider account/cash or DB writes.
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const Stripe=require('stripe');
const {generationFixture,PAID}=require('./fixtures/generation-retail-funding-fixture');
const {readExistingRetailCheckoutFunding:read}=require('../src/services/existingRetailCheckoutFunding');

async function withSdk(f,run,{paginate=false}={}){
 const calls=[];
 const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://127.0.0.1');calls.push({method:req.method,path:u.pathname,version:req.headers['stripe-version']});
  const list=data=>paginate&&data.length>1
   ? {object:'list',data:u.searchParams.has('starting_after')?data.slice(1):data.slice(0,1),has_more:!u.searchParams.has('starting_after')}
   : {object:'list',data,has_more:false};
  const routes={
   ['/v1/checkout/sessions/'+f.cs.id]:f.cs,
   ['/v1/checkout/sessions/'+f.cs.id+'/line_items']:list(f.cl),
   ['/v1/subscriptions/'+f.s.id]:f.s,
   ['/v1/invoices/'+f.inv.id]:f.inv,
   ['/v1/invoices/'+f.inv.id+'/lines']:list(f.il),
   '/v1/subscription_items':list(f.s.items.data),
   ['/v1/payment_intents/'+f.pi.id]:f.pi,
   ['/v1/charges/'+f.ch.id]:f.ch
  };
  const value=req.method==='GET'?routes[u.pathname]:null;
  res.writeHead(value?200:400,{'content-type':'application/json','request-id':'req_LOCAL_SYNTHETIC'});
  res.end(JSON.stringify(value||{error:{message:'Unapproved local request'}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const stripe=new Stripe('sk_test_SYNTHETIC_LOCAL_ONLY',{apiVersion:'2023-10-16',host:'127.0.0.1',
   port:server.address().port,protocol:'http',maxNetworkRetries:0});
  await run(stripe,calls);
  assert.ok(calls.every(c=>c.method==='GET'&&c.version==='2023-10-16'));
 }finally{await new Promise(resolve=>server.close(resolve));}
}

test('installed SDK metadata crosses generation funding reader for all48 linked/admin commercial variants',async()=>{
 for(const plan of ['basic','pro'])for(const months of [3,6,12])
  for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])for(const admin of [false,true]){
   const f=generationFixture(plan,months,payment,role,{admin}),before=structuredClone(f.tables);
   await withSdk(f,async(stripe,calls)=>{
    const raw=await stripe.checkout.sessions.retrieve(f.cs.id),d=Object.getOwnPropertyDescriptor(raw,'lastResponse');
    assert.equal(d.enumerable,false);assert.equal(d.writable,false);assert.equal(d.configurable,false);
    const r=await read({...f.options,stripe});
    assert.equal(r.paidAt,PAID);assert.equal(r.cashCents,f.offer.initial_payment_cents);
    assert.equal(r.platformNetCents,f.offer.platform_payment_cents);assert.equal(r.roleNetCents,f.offer.first_role_prepay.amount_cents);
    assert.equal(r.initialProviderSchedule.initial_term_start,f.dates.initial_term_start);
    assert.equal(r.initialProviderSchedule.initial_renewal_date,f.dates.initial_renewal_date);
    assert.equal(calls.length,9);assert.deepEqual(f.tables,before);
   });
  }
});

test('SDK root projection does not admit nested response metadata or execute its getter',async()=>{
 const f=generationFixture();let reads=0;
 await withSdk(f,async stripe=>{
  const retrieve=stripe.subscriptions.retrieve.bind(stripe.subscriptions);
  stripe.subscriptions.retrieve=async(...args)=>{
   const value=await retrieve(...args);
   Object.defineProperty(value.items.data[0],'lastResponse',{get(){reads++;return{};}});
   return value;
  };
  await assert.rejects(read({...f.options,stripe}));assert.equal(reads,0);
 });
});

test('actual SDK root metadata handling never relaxes captured-cash validation',async()=>{
 const f=generationFixture('pro',6,'prepaid',true),before=structuredClone(f.tables);
 f.pi.amount_received=1;
 await withSdk(f,async stripe=>{
  await assert.rejects(read({...f.options,stripe}),{code:'retail_funding_cash_mismatch'});
  assert.deepEqual(f.tables,before);
 });
});

test('every real SDK list-page root is projected before complete pagination',async()=>{
 const f=generationFixture('basic',6,'prepaid',true),before=structuredClone(f.tables);
 await withSdk(f,async(stripe,calls)=>{
  const r=await read({...f.options,stripe});assert.equal(r.cashCents,230900);
  assert.equal(calls.length,10);assert.deepEqual(f.tables,before);
 },{paginate:true});
});

test('accepted legacy funding retains its installed-SDK raw-response behavior',async()=>{
 const f=require('./fixtures/existing-retail-funding-fixture').fixture('basic',3,'monthly_installments',true),before=structuredClone(f.tables);
 await withSdk(f,async stripe=>{
  const r=await read({...f.options,stripe});assert.equal(r.initialProviderPeriod.version,'retail_initial_provider_period_v1');
  assert.equal(r.initialProviderSchedule,undefined);assert.equal(r.cashCents,f.inv.total);assert.deepEqual(f.tables,before);
 });
});
