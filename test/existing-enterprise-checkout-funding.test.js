'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),Stripe=require('stripe');
const {readExistingEnterpriseCheckoutFunding:read}=require('../src/services/existingEnterpriseCheckoutFunding');
const fixture=require('./helpers/enterprise-existing-funding-fixture');
const clone=v=>structuredClone(v);
for(const cadence of ['monthly','annual'])for(const embedded of [true,false])for(const amount of [0,1,7000,99999])
 test(`read only ${cadence}/${embedded} initial platform${amount}, expired B window keeps original A`,async()=>{
  const f=fixture({cadence,embedded,platformAmount:amount}),before=clone(f.db.tables),proof=await read(f.args);
  assert.equal(proof.platform_line_cents,amount);assert.equal(proof.payment_success_at,'2026-10-01T13:00:00.000Z');
  assert.equal(proof.pool_paid_cents,69750);assert.equal(proof.credits_spendable,false);assert.equal(proof.membership_activation_required,true);
  assert.equal(proof.native_receipt_required,true);assert.ok(Object.isFrozen(proof.subscription));assert.ok(Object.isFrozen(proof.sourceTemplate));
  assert.deepEqual(f.db.tables,before);assert.equal(f.db.rpcCalls.length,0);assert.equal(f.db.updates.length,0);assert.equal(f.db.inserts.length,0);
  assert.deepEqual(f.calls.slice(0,6).map(x=>x.kind),['account','customer','checkout','subscription','subscriptionItems','checkoutLines']);
 });
test('legacy unmarked returns null; partial markers and source inconsistencies fail before any provider read',async()=>{
 const f=fixture();f.a.enterprise_checkout_source=null;f.a.enterprise_checkout_pool_id=null;f.a.enterprise_checkout_prices=null;
 assert.equal(await read(f.args),null);assert.equal(f.calls.length,0);
 for(const change of [x=>{x.a.enterprise_checkout_source=null;},x=>{x.a.enterprise_checkout_pool_id=null;},x=>{x.seal.execution={};},
  x=>{x.pool.stripe_checkout_session_id='cs_OTHER';},x=>{x.a.enterprise_checkout_prices=null;},x=>{x.client.parent_client_id=x.client.id;},
  x=>{x.a.status='active';},x=>{x.a.checkout_paid_at='2026-10-01T13:00:00Z';},x=>{x.pool.status='paid';},
  x=>{x.db.tables.public_purchase_intents.push({id:'synthetic',agreement_id:x.a.id});},
  x=>{x.db.tables.billing_customers.push({...x.db.tables.billing_customers[0],client_id:'FOREIGN'});},
  x=>{x.client.stripe_subscription_id='sub_OTHER';},x=>{x.a.enterprise_checkout_source.material.template_version='OTHER';}]){
  const x=fixture();change(x);await assert.rejects(read(x.args));assert.equal(x.calls.length,0);
 }
});
test('nullable CS invoice requires complete unique initial discovery, not latest_invoice or first paid candidate',async()=>{
 const f=fixture();f.p.checkout.invoice=null;f.p.subscription.latest_invoice='in_LATER';
 const proof=await read(f.args);assert.equal(proof.invoice_id,'in_initial');assert.ok(f.calls.some(x=>x.kind==='invoices'));
 for(const data of [[],[f.p.invoice,{...f.p.invoice,id:'in_SECOND',status:'open',paid:false,status_transitions:{paid_at:null}}]]){
  const x=fixture();x.p.checkout.invoice=null;x.stripe.invoices.list=async()=>({object:'list',has_more:false,data});
  await assert.rejects(read(x.args),{code:'enterprise_funding_initial_invoice_ambiguous'});
 }
});
test('real creation ordering: native B precedes two Price requests then actual CS creation',async()=>{
 const f=fixture();f.p.checkout.created+=5;f.p.subscription.created=f.p.checkout.created+2;
 f.p.invoice.created=f.p.checkout.created+2;f.p.paymentIntent.created=f.p.invoice.created;f.p.charge.created=f.p.invoice.created;
 const proof=await read(f.args);assert.equal(proof.payment_success_at,'2026-10-01T13:00:00.000Z');
 assert.equal(proof.sourceCheckout.created_at,'2026-10-01T12:00:00.000Z');
});
test('reverse event identities select same invoice/cash clock; conflicts held',async()=>{
 const f=fixture(),one=await read({...f.args,eventSessionId:'cs_synthetic',eventLivemode:false}),two=await read({...f.args,eventSubscriptionId:'sub_synthetic',eventInvoiceId:'in_initial',eventLivemode:false});
 assert.deepEqual(one,two);
 for(const event of [{eventSessionId:'cs_OTHER'},{eventSubscriptionId:'sub_OTHER'},{eventInvoiceId:'in_OTHER'},{eventLivemode:true},{eventLivemode:'false'}])await assert.rejects(read({...f.args,...event}));
});
for(const change of [f=>{f.p.checkout.created--;},f=>{f.p.checkout.expires_at++;},f=>{f.p.checkout.metadata.extra='OTHER';},
 f=>{f.p.checkout.created=f.p.checkout.expires_at;},f=>{f.p.subscription.created=f.p.checkout.created-1;},
 f=>{f.p.checkout.return_url='https://other.example.invalid/return';},
 f=>{f.p.checkout.ui_mode='custom';},f=>{f.p.subscription.metadata.client_id='OTHER';},f=>{f.p.subscription.billing_cycle_anchor++;},
 f=>{f.prices.price_pool.metadata.pool_offer_digest='OTHER';},f=>{f.p.invoice.lines.data[0].price.unit_amount--;},
 f=>{f.p.paymentIntent.amount_received--;},f=>{f.p.charge.disputed=true;},f=>{f.p.refunds.data=[{id:'re_PENDING'}];},
 f=>{f.p.invoice.status_transitions.paid_at=Date.parse(f.a.agreement_expires_at)/1000;},f=>{f.p.invoice.status_transitions.paid_at=f.p.checkout.created-1;},
 f=>{f.p.invoice.discounts=['di_OTHER'];},f=>{f.p.checkout.invoice=undefined;},f=>{f.stripe.getApiField=()=> '2026-08-26.dahlia';}])
 test('corrupt native provider graph cannot be called paid',async()=>{const f=fixture();change(f);await assert.rejects(read(f.args));assert.equal(f.db.updates.length,0);});
test('embedded paid read rejects conflicting hosted destinations',async()=>{
 for(const key of ['success_url','cancel_url']){const f=fixture({embedded:true});f.p.checkout[key]='https://other.example.invalid/return';await assert.rejects(read(f.args));}
});
test('source/profile/pool changed during provider reads fail final native readback',async()=>{
 for(const change of [f=>{f.a.is_current=false;},f=>{f.pool.stripe_checkout_session_id='cs_OTHER';},f=>{f.client.stripe_customer_id='cus_OTHER';},
  f=>{f.db.tables.billing_customers=[];},f=>{f.a.enterprise_checkout_source.replacement_id='sub_OTHER';}]){
  const f=fixture();f.onRead=kind=>{if(kind==='refunds')change(f);};await assert.rejects(read(f.args));
 }
});
test('all line/initial-invoice/refund collections paginate completely or hold on duplicate/truncation',async()=>{
 const f=fixture();f.p.checkout.invoice=null;
 const paged=data=>async(...args)=>{const p=args.at(-1);return{object:'list',data:p.starting_after?data.slice(1):data.slice(0,1),has_more:!p.starting_after};};
 f.stripe.checkout.sessions.listLineItems=paged(f.p.checkoutLines.data);f.stripe.invoices.listLineItems=paged(f.p.invoice.lines.data);
 f.stripe.invoices.list=paged([{id:'in_LATER',billing_reason:'subscription_cycle'},f.p.invoice]);
 assert.equal((await read(f.args)).invoice_id,'in_initial');
 for(const [owner,key]of [['checkout','listLineItems'],['invoices','listLineItems'],['subscriptionItems','list'],['refunds','list'],['invoices','list']]){
  const x=fixture();x.p.checkout.invoice=null;
  const api=owner==='checkout'?x.stripe.checkout.sessions:x.stripe[owner];
  api[key]=async()=>({object:'list',has_more:true,data:[]});await assert.rejects(read(x.args));
 }
 const x=fixture();x.stripe.invoices.listLineItems=async()=>({object:'list',has_more:false,data:[x.p.invoice.lines.data[0],x.p.invoice.lines.data[0]]});await assert.rejects(read(x.args));
});
test('opaque pinned Price ids are resolved freshly; altered expanded copy is not silently overwritten',async()=>{
 const f=fixture();for(const l of [...f.p.invoice.lines.data,...f.p.checkoutLines.data,...f.p.subscription.items.data])l.price=l.price.id;
 assert.equal((await read(f.args)).pool_paid_cents,69750);
 const x=fixture();x.p.checkoutLines.data[1].price.metadata={};await assert.rejects(read(x.args),{code:'enterprise_funding_expanded_price_mismatch'});
});
for(const providerShape of ['legacy','observed_API2023','observed_nonprorated_invoiceitem','observed_discounted_checkout'])
test(`installed SDK executes this adapter with GET-only API2023 ${providerShape} requests, no provider connection`,async()=>{
 const f=fixture({embedded:true}),requests=[];
 if(providerShape!=='legacy'){
  delete f.p.charge.refunds;
  Object.assign(f.p.invoice.lines.data[0],{type:'invoiceitem',invoice_item:'ii_platform'});
  for(const line of f.p.checkoutLines.data)delete line.discounts;
  if(providerShape==='observed_nonprorated_invoiceitem')f.p.invoice.lines.data[0].proration=false;
  if(providerShape==='observed_discounted_checkout')f.p.checkoutLines.data[0].amount_discount=1;
 }
 const server=http.createServer(async(req,res)=>{try{
  const u=new URL(req.url,'http://127.0.0.1'),p=Object.fromEntries(u.searchParams),path=u.pathname;
  requests.push({method:req.method,path,version:req.headers['stripe-version']});assert.equal(req.method,'GET');
  let data;
  if(path==='/v1/account')data=await f.stripe.accounts.retrieve();
  else if(path.startsWith('/v1/customers/'))data=await f.stripe.customers.retrieve(path.split('/').at(-1));
  else if(path.endsWith('/line_items'))data=await f.stripe.checkout.sessions.listLineItems(path.split('/').at(-2),p);
  else if(path.startsWith('/v1/checkout/sessions/'))data=await f.stripe.checkout.sessions.retrieve(path.split('/').at(-1));
  else if(path.startsWith('/v1/subscriptions/'))data=await f.stripe.subscriptions.retrieve(path.split('/').at(-1));
  else if(path==='/v1/subscription_items')data=await f.stripe.subscriptionItems.list(p);
  else if(path.endsWith('/lines'))data=await f.stripe.invoices.listLineItems(path.split('/').at(-2),p);
  else if(path.startsWith('/v1/invoices/'))data=await f.stripe.invoices.retrieve(path.split('/').at(-1));
  else if(path.startsWith('/v1/prices/'))data=await f.stripe.prices.retrieve(path.split('/').at(-1));
  else if(path.startsWith('/v1/payment_intents/'))data=await f.stripe.paymentIntents.retrieve(path.split('/').at(-1));
  else if(path.startsWith('/v1/charges/'))data=await f.stripe.charges.retrieve(path.split('/').at(-1));
  else if(path==='/v1/refunds')data=await f.stripe.refunds.list(p);else throw Error('Unexpected local route');
  res.setHeader('content-type','application/json');res.setHeader('request-id','req_SYNTHETIC');res.end(JSON.stringify(data));
 }catch(e){res.statusCode=500;res.end(JSON.stringify({error:{message:e.message}}));}});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 try{
  const stripe=new Stripe('sk_test_SYNTHETIC_NO_PROVIDER',{apiVersion:'2023-10-16',host:'127.0.0.1',port:server.address().port,protocol:'http',maxNetworkRetries:0});
  let proof;
  if(['observed_nonprorated_invoiceitem','observed_discounted_checkout'].includes(providerShape)){
   await assert.rejects(read({...f.args,stripe}),{code:providerShape==='observed_nonprorated_invoiceitem'
    ?'pool_proof_platform_line_mismatch':'pool_proof_checkout_line_mismatch',status:409});
   assert.equal(f.db.updates.length,0);assert.equal(f.db.inserts.length,0);assert.equal(f.db.rpcCalls.length,0);
  }else{
   proof=await read({...f.args,stripe});assert.equal(proof.pool_paid_cents,69750);assert.equal(proof.payment_success_at,'2026-10-01T13:00:00.000Z');
  }
  assert.ok(requests.length>=12);assert.ok(requests.every(r=>r.method==='GET'&&r.version==='2023-10-16'));
  if(proof){
   assert.equal(JSON.stringify(proof).includes('sk_test_'),false);assert.equal(JSON.stringify(proof).includes('lastResponse'),false);
  }else assert.ok(['observed_nonprorated_invoiceitem','observed_discounted_checkout'].includes(providerShape));
 }finally{await new Promise(resolve=>server.close(resolve));}
});
