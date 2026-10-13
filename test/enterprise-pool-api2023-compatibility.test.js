'use strict';
// Historical API shapes and loopback SDK are synthetic, not provider acceptance.
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const Stripe=require('stripe');
const {proveEnterprisePoolPayment:prove,snapshotStripeSdkData}=require('../src/services/enterprisePoolPaymentProof');
const fixture=require('./helpers/enterprise-pool-payment-fixture');
function historical(){
 const p=fixture();delete p.subscription.discounts;delete p.subscription.items.data[0].discounts;
 p.invoice.discounts=null;p.invoice.total_discount_amounts=null;
 for(const line of p.invoice.lines.data){delete line.invoice;line.discounts=null;line.discount_amounts=null;}
 delete p.charge.dispute;p.charge.refunds=null;p.refunds={object:'list',has_more:false,data:[]};return p;
}
test('actual2023 nullable/absent fields prove same captured synthetic cash without invented invoice relations',()=>{
 const p=historical(),before=structuredClone(p),r=prove(p);assert.equal(r.pool_paid_cents,69750);
 assert.equal(r.credits_spendable,false);assert.deepEqual(p,before);
});
test('explicit null Checkout invoice permits only independently supplied initial invoice proof',()=>{
 const p=historical();p.checkout.invoice=null;assert.equal(prove(p).invoice_id,p.invoice.id);
 delete p.checkout.invoice;assert.throws(()=>prove(p));
});
for(const change of [p=>{delete p.invoice.discounts;},p=>{p.invoice.total_discount_amounts=undefined;},
 p=>{delete p.invoice.lines.data[0].discount_amounts;},p=>{p.invoice.lines.data[1].discounts=undefined;},
 p=>{p.refunds.has_more=true;},p=>{p.refunds.data=[{id:'re_PENDING',status:'pending'}];},
 p=>{p.subscription.discounts=['di_HIDDEN'];},p=>{p.subscription.items.data[0].discounts=['di_HIDDEN'];},
 p=>{p.invoice.lines.data[1].invoice='in_FOREIGN';},p=>{p.charge.dispute='dp_FOREIGN';},
 p=>{delete p.refunds;},p=>{p.paymentIntent.amount_received--;},p=>{p.charge.disputed=true;}])
 test('API2023 missing/positive/foreign evidence remains held',()=>{const p=historical();change(p);assert.throws(()=>prove(p));});
test('SDK projection ignores ONLY root inert lastResponse; strict pure input remains unchanged',()=>{
 const p=historical(),sdk=p.invoice;let accessed=0;
 const raw=new Proxy({}, {get(){accessed++;throw Error('Do not inspect response headers');}});
 Object.defineProperty(sdk,'lastResponse',{enumerable:false,writable:false,value:raw});
 assert.throws(()=>prove(p),{code:'pool_proof_invalid_graph'});
 const copy=snapshotStripeSdkData(sdk);assert.equal(Object.hasOwn(copy,'lastResponse'),false);assert.equal(accessed,0);
 p.invoice=copy;assert.equal(prove(p).pool_paid_cents,69750);assert.equal(accessed,0);
});
test('SDK projection does not run getters/proxies/toJSON or permit hidden financial facts',()=>{
 let accessed=0;
 for(const value of [new Proxy({}, {ownKeys(){accessed++;throw Error('trap');}}),
  Object.defineProperty({object:'invoice'},'lastResponse',{get(){accessed++;return {};}}),
  Object.defineProperty({object:'invoice'},'paid',{value:true,enumerable:false}),
  Object.defineProperty({object:'invoice'},'lastResponse',{value:{},enumerable:false,configurable:true}),
  Object.defineProperty({object:'invoice'},'lastResponse',{value:{},enumerable:false,writable:true}),
  {object:'invoice',toJSON(){accessed++;return {};}}])assert.throws(()=>snapshotStripeSdkData(value));
 const nested={object:'invoice',child:{}};Object.defineProperty(nested.child,'lastResponse',{value:{},enumerable:false});
 assert.throws(()=>snapshotStripeSdkData(nested));assert.equal(accessed,0);
 assert.throws(()=>snapshotStripeSdkData({object:'invoice',child:{lastResponse:{}}}));
});
test('installed SDK16.12/API2023 actual GET response carries hidden metadata safely excluded',async()=>{
 const p=historical(),requests=[];
 const server=http.createServer((req,res)=>{requests.push({method:req.method,path:req.url,version:req.headers['stripe-version']});
  res.setHeader('content-type','application/json');res.setHeader('request-id','req_SYNTHETIC');res.end(JSON.stringify(p.invoice));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 try{
  const stripe=new Stripe('sk_test_SYNTHETIC_NO_PROVIDER',{apiVersion:'2023-10-16',host:'127.0.0.1',port:server.address().port,protocol:'http',maxNetworkRetries:0});
  const raw=await stripe.invoices.retrieve('in_initial'),d=Object.getOwnPropertyDescriptor(raw,'lastResponse');
  assert.equal(d.enumerable,false);assert.equal(d.writable,false);assert.equal(Object.hasOwn(d,'value'),true);
  p.invoice=snapshotStripeSdkData(raw);assert.equal(Object.hasOwn(p.invoice,'lastResponse'),false);
  assert.equal(prove(p).invoice_id,'in_initial');assert.deepEqual(requests,[{method:'GET',path:'/v1/invoices/in_initial',version:'2023-10-16'}]);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
