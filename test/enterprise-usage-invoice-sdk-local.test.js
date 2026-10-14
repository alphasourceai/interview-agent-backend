'use strict';
// Installed SDK transport over local loopback ONLY. No Stripe account or cash.
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const file=require.resolve('../src/clients/supabase');require.cache[file]={id:file,filename:file,loaded:true,exports:{supabaseAdmin:{}}};
const Stripe=require('stripe'),p=require('../src/services/enterpriseExistingUsageInvoiceProof');
test('installed Stripe16/API2023 sends existing invoice/item/finalize/pay shapes and reads local full census',async()=>{
 const b={batch_id:'11111111-1111-4111-8111-111111111111',owner_id:'22222222-2222-4222-8222-222222222222',
  account_id:'acct_SYNTHETIC',customer_id:'cus_SYNTHETIC',subscription_id:'sub_SYNTHETIC',livemode:false,
  period:{start:1790812800,end:1793491200},groups:[{role_id:'33333333-3333-4333-8333-333333333333',
   quantity:2,unit_price_cents:2500,amount_cents:5000,interview_ids:['44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555'],
   description:'Interviews — Synthetic Role [open] (October 2026)'}]};
 const requests=[],invoice={object:'invoice',id:'in_SYNTHETIC',customer:b.customer_id,livemode:false,subscription:null};
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  const u=new URL(req.url,'http://127.0.0.1'),data=new URLSearchParams(body);
  requests.push({method:req.method,path:u.pathname,query:u.searchParams,body:data,key:req.headers['idempotency-key'],version:req.headers['stripe-version']});
  let value;if(req.method==='GET'){
   if(u.pathname==='/v1/account')value={object:'account',id:b.account_id};
   else if(u.pathname==='/v1/invoices')value={object:'list',data:[invoice],has_more:false};
   else if(u.pathname==='/v1/invoices/in_SYNTHETIC')value=invoice;
   else if(['/v1/invoiceitems','/v1/invoices/in_SYNTHETIC/lines'].includes(u.pathname))value={object:'list',data:[],has_more:false};
  }else if(req.method==='POST'){
   if(u.pathname==='/v1/invoiceitems')value={object:'invoiceitem',id:'ii_SYNTHETIC'};
   else if(['/v1/invoices','/v1/invoices/in_SYNTHETIC/finalize','/v1/invoices/in_SYNTHETIC/pay'].includes(u.pathname))value=invoice;
  }
  if(!value){res.writeHead(400,{'content-type':'application/json'});return res.end(JSON.stringify({error:{message:'unapproved local path'}}));}
  res.writeHead(200,{'content-type':'application/json','request-id':'req_LOCAL_ONLY'});res.end(JSON.stringify(value));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const stripe=new Stripe('sk_test_SYNTHETIC_LOCAL_ONLY',{apiVersion:'2023-10-16',host:'127.0.0.1',port:server.address().port,protocol:'http',maxNetworkRetries:0});
  const create=p.usageInvoiceCreateRequest(b),item=p.usageInvoiceItemRequest(b,invoice.id,b.groups[0].role_id),
   finalize=p.usageInvoiceFinalizeRequest(b,invoice.id),pay=p.usageInvoicePayRequest(b,invoice.id,'pm_SYNTHETIC');
  await stripe.invoices.create(create.body,{idempotencyKey:create.key});
  await stripe.invoiceItems.create(item.body,{idempotencyKey:item.key});
  await stripe.invoices.finalizeInvoice(invoice.id,finalize.body,{idempotencyKey:finalize.key});
  await stripe.invoices.pay(invoice.id,pay.body,{idempotencyKey:pay.key});
  const result=await p.readUsageInvoiceCensus({stripe,binding:b,invoiceId:invoice.id});
  assert.equal(result.invoice.id,invoice.id);assert.equal(result.payroll_authorized,false);assert.equal(result.paid_access_authorized,false);
  const writes=requests.filter(r=>r.method==='POST');assert.equal(writes.length,4);
  assert.deepEqual(writes.map(r=>r.key),[create.key,item.key,finalize.key,pay.key]);
  assert.ok(requests.every(r=>r.version==='2023-10-16'));
  assert.equal(writes[0].body.get('pending_invoice_items_behavior'),'exclude');assert.equal(writes[0].body.get('auto_advance'),'false');
  assert.equal(writes[0].body.has('subscription'),false);assert.equal(writes[0].body.has('default_payment_method'),false);
  assert.equal(writes[1].body.get('unit_amount'),'2500');assert.equal(writes[1].body.get('quantity'),'2');
  assert.equal(writes[1].body.get('period[start]'),'1790812800');assert.equal(writes[1].body.get('period[end]'),'1793491200');
  assert.equal(writes[2].body.get('auto_advance'),'false');assert.equal(writes[3].body.get('off_session'),'true');
  assert.equal(writes[3].body.get('payment_method'),'pm_SYNTHETIC');assert.equal(writes[3].body.has('paid_out_of_band'),false);
  assert.equal(requests.some(r=>/\/payment_intents|\/subscriptions|\/customers/.test(r.path)),false);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
