'use strict';
// SDK orchestration and loopback are not native SQL/provider acceptance.
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),http=require('node:http');
const InstalledStripe=require('stripe');
const {createExistingEnterpriseCheckout,dollarsToCents}=require('../src/services/existingEnterpriseCheckoutAttempt');
const {fixture,TOKEN,config}=require('./helpers/enterprise-existing-checkout-fixture');
const clone=v=>structuredClone(v);
const run=f=>createExistingEnterpriseCheckout(f.args);
for(const cadence of ['monthly','annual'])for(const embedded of [true,false])test(`existing Enterprise ${cadence}/${embedded} fixed body, oneCS/pool, pinned replay no recreate`,async()=>{
 const f=fixture({cadence,embedded,platformSubtotal:0}),result=await run(f);assert.equal(result.enterpriseAttemptLinked,true);assert.equal(result.fallbackSession,null);
 const creates=f.calls.filter(c=>c.kind==='sessionCreate');assert.equal(creates.length,1);assert.equal(creates[0].body.allow_promotion_codes,false);assert.equal(creates[0].body.discounts,undefined);
 assert.equal(creates[0].body.subscription_data.proration_behavior,'create_prorations');assert.equal(creates[0].body.subscription_data.billing_cycle_anchor%86400,0);
 assert.equal(creates[0].opt.idempotencyKey,f.args.key+(embedded?':embedded':''));
 assert.equal(f.calls.filter(c=>c.kind==='priceCreate').length,2);assert.equal(f.getResolverCalls(),1);
 const again=await run(f);assert.equal(again.session.id,result.session.id);assert.equal(f.calls.filter(c=>c.kind==='sessionCreate').length,1);assert.equal(f.calls.filter(c=>c.kind==='priceCreate').length,2);
 assert.equal(f.getResolverCalls(),1);assert.equal(f.calls.filter(c=>c.kind==='sublist').length,1);
});
test('exact native cents conversion has no rounding/magnitude/exponent acceptance',()=>{
 for(const [s,n]of [['999.99',99999],['1',100],['1.1',110],['0001.01',101],['21474836.47',2147483647]])assert.equal(dollarsToCents(s),n);
 for(const s of ['0','1.001','1e3','-1','Infinity','21474836.48',null])assert.throws(()=>dollarsToCents(s),/money_invalid/);
});
test('fresh native seal/fullsource/intent/untracked partial state refuses BEFORE SDK factory',async()=>{
 for(const mutate of [f=>{f.seal.execution={};},f=>{f.a.status='sent';},f=>{f.a.is_current=false;},f=>{f.a.checkout_session_id='cs_OLD';},
  f=>{f.a.enterprise_checkout_prices={};},f=>{f.db.tables.public_purchase_intents.push({id:crypto.randomUUID(),agreement_id:f.a.id});},f=>{f.args.fees.platform_fee='1';}]){
  const f=fixture();mutate(f);await assert.rejects(run(f));assert.equal(f.getFactoryCalls(),0);assert.equal(f.calls.length,0);
 }
});
test('first profile prep/readback no Auth/history overwrite; retry missing owner profile holds',async()=>{
 const f=fixture({emptyProfile:true});await run(f);assert.equal(f.db.inserts.length,1);assert.deepEqual(Object.keys(f.db.inserts[0]).sort(),['client_id','id','name','primary_contact_email','primary_contact_name','stripe_customer_id']);
 f.db.tables.billing_customers=[];const before=f.calls.length;await assert.rejects(run(f),/owner_missing/);assert.equal(f.calls.length,before);assert.equal(f.db.inserts.length,1);
});
test('strict client CAS save failure yields no Prices/CS',async()=>{
 const f=fixture();f.db.failSave=true;await assert.rejects(run(f),/customer_save_failed/);assert.equal(f.calls.filter(c=>c.kind==='priceCreate'||c.kind==='sessionCreate').length,0);
});
test('full subscription pagination, one frozen replacement; ambiguous/foreign/truncated list holds',async()=>{
 const f=fixture();f.stripe.subscriptions.list=async p=>({object:'list',data:p.starting_after?[{id:'sub_BLOCKING',object:'subscription',customer:f.client.stripe_customer_id,status:'active'}]:
  [{id:'sub_OLD',object:'subscription',customer:f.client.stripe_customer_id,status:'canceled'}],has_more:!p.starting_after});
 await run(f);assert.equal(f.a.enterprise_checkout_source.replacement_id,'sub_BLOCKING');f.stripe.subscriptions.list=()=>{throw Error('Must not relist');};await run(f);
 for(const data of [[{id:'sub_OTHER',object:'subscription',customer:'cus_OTHER',status:'active'}],['active','past_due'].map((status,i)=>({id:'sub_'+i,object:'subscription',customer:'cus_SYNTHETIC',status}))]){
  const x=fixture();x.stripe.subscriptions.list=async()=>({object:'list',data,has_more:false});await assert.rejects(run(x));assert.equal(x.calls.filter(c=>c.kind==='priceCreate').length,0);
 }
 const x=fixture();x.stripe.subscriptions.list=async()=>({object:'list',data:[],has_more:true});await assert.rejects(run(x),/list_incomplete/);
});
for(const failPrice of ['month','pool'])test(`unknown ${failPrice} Price ACK retries exact body/key, no second CS`,async()=>{
 const f=fixture();f.stripe.failPrice=failPrice;await assert.rejects(run(f),/price_ack_unknown/);await run(f);
 assert.equal([...f.keys.keys()].filter(k=>k.endsWith('_price')).length,2);assert.equal(f.calls.filter(c=>c.kind==='sessionCreate').length,1);
});
test('unknown CS ACK retries SAME session; no fallback, unchanged B and prices',async()=>{
 const f=fixture({embedded:true});f.stripe.failSession=true;await assert.rejects(run(f),/checkout_ack_unknown/);const b=f.a.enterprise_checkout_source.created_at;await run(f);
 assert.equal(f.calls.filter(c=>c.kind==='sessionCreate').length,2);assert.equal(f.calls.filter(c=>c.kind==='priceCreate').length,2);assert.equal(f.a.enterprise_checkout_source.created_at,b);
 assert.equal([...f.keys.keys()].filter(k=>!k.endsWith('_price')).length,1);
});
for(const name of ['pin_enterprise_existing_checkout_prices','pin_enterprise_existing_checkout_session'])test(`unknown ${name} native ACK returns no URL; replay reads persisted winner`,async()=>{
 const f=fixture();f.db.failAck=name;await assert.rejects(run(f),/store_hold/);await run(f);assert.equal(f.calls.filter(c=>c.kind==='priceCreate').length,2);
 assert.equal(f.calls.filter(c=>c.kind==='sessionCreate').length,1);
});
for(const mutation of [s=>({...s,status:'complete',payment_status:'paid'}),s=>({...s,status:'expired'}),s=>({...s,customer:'cus_OTHER'}),
 s=>({...s,metadata:{...s.metadata,extra:'bad'}}),s=>({...s,expires_at:s.expires_at+1}),s=>({...s,allow_promotion_codes:true}),s=>({...s,amount_total:s.amount_total+1})])
 test('corrupted SDK Session holds without native CS pin or new payable fallback',async()=>{
  const f=fixture();f.stripe.mutateSession=mutation;await assert.rejects(run(f));assert.equal(f.a.checkout_session_id,null);assert.equal(f.calls.filter(c=>c.kind==='sessionCreate').length,1);
 });
test('corrupted/duplicate/pool-discounted/foreign Prices and current customer change hold',async()=>{
 for(const change of [l=>[l[0],clone(l[0])],l=>{l[1].amount_subtotal--;l[1].amount_total--;return l;},l=>{l[1].price.currency='eur';return l;},l=>{l[0].amount_discount=1;return l;}]){
  const f=fixture();f.stripe.mutateLines=change;await assert.rejects(run(f));assert.equal(f.a.checkout_session_id,null);
 }
 const f=fixture();await run(f);f.client.stripe_customer_id='cus_OTHER';const n=f.calls.length;await assert.rejects(run(f),/customer_changed/);assert.equal(f.calls.length,n);
});
test('known partial trace/config/mode refuses before SDK; unknown customer credits are held, not cleared',async()=>{
 for(const mutate of [f=>{f.a.enterprise_checkout_prices=null;},f=>{f.a.checkout_created_at=null;},f=>{f.args.embedded=true;},f=>{f.args.config={...config,public_sign_base:'https://other.example.invalid'};}]){
  const f=fixture();await run(f);mutate(f);const n=f.calls.length;await assert.rejects(run(f));assert.equal(f.calls.length,n);
 }
 for(const patch of [{invoice_credit_balance:5},{cash_balance:'cb_UNKNOWN'},{invoice_credit_balance:{usd:1}},{cash_balance:{available:{usd:1}}}]){
  const f=fixture();Object.assign(f.customer,patch);await assert.rejects(run(f),/customer_adjustment_denied/);assert.equal(f.calls.filter(c=>c.kind==='priceCreate').length,0);
 }
});
test('installed Stripe16.12/API2023 serializer drives same existing helper over local HTTP, no account access',async()=>{
 for(const cadence of ['monthly','annual'])for(const embedded of [true,false]){
  const f=fixture({cadence,embedded,platformSubtotal:0}),requests=[];
  const server=http.createServer(async(req,res)=>{try{let raw='';for await(const chunk of req)raw+=chunk;const params=new URLSearchParams(raw),url=new URL(req.url,'http://127.0.0.1');
   requests.push({method:req.method,path:url.pathname,version:req.headers['stripe-version'],key:req.headers['idempotency-key'],params:Object.fromEntries(params)});
   const meta=p=>Object.fromEntries([...params].filter(([k])=>k.startsWith(p+'[')).map(([k,v])=>[k.slice(p.length+1,-1),v]));
   let result;const pathname=url.pathname;
   if(pathname.startsWith('/v1/customers/'))result=await f.stripe.customers.retrieve(pathname.split('/').at(-1));
   else if(pathname==='/v1/subscriptions')result=await f.stripe.subscriptions.list(Object.fromEntries(url.searchParams));
   else if(pathname.startsWith('/v1/products/'))result=await f.stripe.products.retrieve(pathname.split('/').at(-1));
   else if(pathname==='/v1/prices'&&req.method==='POST')result=await f.stripe.prices.create({currency:params.get('currency'),unit_amount:Number(params.get('unit_amount')),
    ...(params.has('recurring[interval]')?{recurring:{interval:params.get('recurring[interval]'),interval_count:Number(params.get('recurring[interval_count]')),usage_type:params.get('recurring[usage_type]')}}:{}),
    product_data:{name:params.get('product_data[name]')},metadata:meta('metadata')},{idempotencyKey:req.headers['idempotency-key']});
   else if(pathname.startsWith('/v1/prices/'))result=await f.stripe.prices.retrieve(pathname.split('/').at(-1));
   else if(pathname==='/v1/checkout/sessions'&&req.method==='POST')result=await f.stripe.checkout.sessions.create({mode:params.get('mode'),customer:params.get('customer'),
    line_items:[0,1].map(i=>({price:params.get(`line_items[${i}][price]`),quantity:Number(params.get(`line_items[${i}][quantity]`))})),allow_promotion_codes:params.get('allow_promotion_codes')==='true',
    metadata:meta('metadata'),subscription_data:{metadata:meta('subscription_data[metadata]'),billing_cycle_anchor:Number(params.get('subscription_data[billing_cycle_anchor]')),proration_behavior:params.get('subscription_data[proration_behavior]')},
    expires_at:Number(params.get('expires_at')),...(params.has('ui_mode')?{ui_mode:params.get('ui_mode'),return_url:params.get('return_url')}:{success_url:params.get('success_url'),cancel_url:params.get('cancel_url')})},
    {idempotencyKey:req.headers['idempotency-key']});
   else if(pathname.endsWith('/line_items'))result=await f.stripe.checkout.sessions.listLineItems(pathname.split('/').at(-2),{});
   else if(pathname.startsWith('/v1/checkout/sessions/'))result=await f.stripe.checkout.sessions.retrieve(pathname.split('/').at(-1));
   else throw Error('Unexpected local SDK route');
   res.setHeader('content-type','application/json');res.end(JSON.stringify(result));
  }catch(e){res.statusCode=500;res.end(JSON.stringify({error:{message:e.message}}));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{f.args.stripeFactory=()=>new InstalledStripe('sk_test_SYNTHETIC_NO_PROVIDER',{apiVersion:'2023-10-16',host:'127.0.0.1',port:server.address().port,protocol:'http',maxNetworkRetries:0});
   await run(f);await run(f);assert.ok(requests.every(r=>r.version==='2023-10-16'));
   const cs=requests.filter(r=>r.method==='POST'&&r.path==='/v1/checkout/sessions');assert.equal(cs.length,1);assert.equal(cs[0].params.allow_promotion_codes,'false');
   assert.equal(cs[0].params['subscription_data[proration_behavior]'],'create_prorations');assert.equal(cs[0].params['subscription_data[billing_cycle_anchor_config]'],undefined);
   assert.equal(requests.filter(r=>r.method==='POST'&&r.path==='/v1/prices').length,2);
  }finally{await new Promise(resolve=>server.close(resolve));}
 }
});
