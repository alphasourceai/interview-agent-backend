'use strict';
// Authored graphs and memory/native-shaped reads; never provider cash or hosted acceptance.
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),Stripe=require('stripe');
const dbPath=require.resolve('../src/clients/supabase');
require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{supabaseAdmin:{from(){throw Error('default DB forbidden');}}}};
const accepted=require('./helpers/accepted-enterprise-usage-fixture');
const {readExistingEnterprisePlatformPeriod:read}=require('../src/services/existingEnterprisePlatformPeriodReader');
const clone=v=>structuredClone(v);
async function fixture(t,{tax=0,discount=0,cadence='monthly',offset=0}={}){
 const f=await accepted({cadence}),p=f.w.funding_receipt.proof,originalAnchor=f.w.subscription.current_period_end;
 const {anchoredMonthInstant}=require('../src/services/membershipOffers'),span=cadence==='annual'?12:1;
 const anchor=Date.parse(anchoredMonthInstant(new Date(originalAnchor*1000).toISOString(),offset*span))/1000;
 Object.assign(f.a,{superseded_by_agreement_id:null});
 const price={object:'price',id:p.platform_price_id,livemode:p.livemode,currency:'usd',unit_amount:p.platform_nominal_cents,
  type:'recurring',recurring:{interval:p.platform_interval,interval_count:1,usage_type:'licensed'},billing_scheme:'per_unit',
  transform_quantity:null,tiers_mode:null,custom_unit_amount:null};
 const discounts=discount?[{amount:discount,discount:'di_LOCAL_PLATFORM'}]:[],taxes=tax?[{amount:tax,tax_rate:'txr_LOCAL_PLATFORM',inclusive:false}]:[];
 const gross=p.platform_nominal_cents,total=gross-discount+tax,paid=anchor+60;
 const invoice={object:'invoice',id:'in_LOCAL_PLATFORM_PERIOD',customer:p.customer_id,subscription:p.subscription_id,livemode:p.livemode,
  currency:'usd',billing_reason:'subscription_cycle',collection_method:'charge_automatically',subtotal:gross,total,amount_due:total,
  amount_paid:total,amount_remaining:0,paid:true,status:'paid',paid_out_of_band:false,starting_balance:0,ending_balance:0,
  pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0,application_fee_amount:null,transfer_data:null,
  on_behalf_of:null,shipping_cost:null,total_discount_amounts:discounts,total_tax_amounts:taxes,created:anchor,
  status_transitions:{paid_at:paid},payment_intent:'pi_LOCAL_PLATFORM_PERIOD',charge:'ch_LOCAL_PLATFORM_PERIOD'};
 const end=Date.parse(anchoredMonthInstant(new Date(originalAnchor*1000).toISOString(),(offset+1)*span))/1000;
 const line={object:'line_item',id:'il_LOCAL_PLATFORM_PERIOD',type:'subscription',proration:false,quantity:1,currency:'usd',
  subscription:p.subscription_id,subscription_item:p.platform_item_id,price,amount:gross,period:{start:anchor,end},
  discount_amounts:discounts,tax_amounts:taxes};
 const common={customer:p.customer_id,livemode:p.livemode,currency:'usd',amount:total,created:anchor,
  invoice:invoice.id,payment_method:'pm_LOCAL_PLATFORM_PERIOD'};
 const paymentIntent={...common,object:'payment_intent',id:invoice.payment_intent,latest_charge:invoice.charge,
  status:'succeeded',amount_received:total};
 const charge={...common,object:'charge',id:invoice.charge,payment_intent:paymentIntent.id,status:'succeeded',paid:true,captured:true,
  amount_captured:total,amount_refunded:0,refunded:false,disputed:false};
 const x={agreement:f.a,invoice,invoiceLines:[line],paymentIntent,charge,refunds:[],providerAccountId:p.provider_account_id,
  observedAt:new Date((paid+1)*1000).toISOString()};
 const native=f.nativeFixture;
 Object.assign(native.pool,{status:'paid',paid_at:p.payment_success_at,stripe_payment_intent_id:p.payment_intent_id});
 native.db.rpc=async(name,args)=>{assert.equal(name,'read_enterprise_existing_billing');assert.equal(args.p_agreement,native.a.id);
  return{data:clone(native.a.enterprise_billing_receipt),error:null};};
 const calls=[],counts=new Map(),state={x,native,calls};
 const get=(kind,reader)=>async(...args)=>{
  calls.push({kind,args});counts.set(kind,(counts.get(kind)||0)+1);
  if(state.onRead)await state.onRead(kind,counts.get(kind));return clone(reader(...args));
 };
 const list=data=>({object:'list',has_more:false,data});
 const forbidden=()=>{throw Error('provider mutation forbidden');};
 const stripe={getApiField:()=> '2023-10-16',
  accounts:{retrieve:get('account',()=>({object:'account',id:x.providerAccountId}))},
  invoices:{retrieve:get('invoice',()=>x.invoice),listLineItems:get('lines',()=>list(x.invoiceLines)),pay:forbidden,create:forbidden,update:forbidden},
  paymentIntents:{retrieve:get('pi',()=>x.paymentIntent),create:forbidden},
  charges:{retrieve:get('charge',()=>x.charge)},refunds:{list:get('refunds',()=>list(x.refunds))},
  subscriptions:{update:forbidden,cancel:forbidden}};
 state.stripe=stripe;state.args={db:native.db,stripe,agreementId:native.a.id,clientId:native.client.id,invoiceId:invoice.id};
 t.mock.method(Date,'now',()=>Date.parse(x.observedAt));
 return state;
}
for(const cadence of ['monthly','annual'])test(`GET-only ${cadence} platform period reuses native scope and exact proof without effects`,async(t)=>{
 const f=await fixture(t,{cadence}),before=clone(f.native.db.tables),r=await read(f.args);
 assert.equal(r.proof.ordinal,1);assert.equal(r.proof.platform_net_cents,99999);
 assert.equal(r.source.agreement_id,f.native.a.id);assert.ok(Object.isFrozen(r.source.agreement));
 for(const key of ['provider_effect_authorized','paid_access_authorized','payroll_authorized']){
  assert.equal(r.source[key],false);assert.equal(r.proof[key],false);
 }
 assert.deepEqual(f.native.db.tables,before);assert.equal(f.native.db.inserts.length,0);assert.equal(f.native.db.updates.length,0);
 assert.deepEqual(f.calls.map(c=>c.kind),['account','invoice','lines','pi','charge','refunds','account','invoice','lines','pi','charge','refunds']);
});
test('platform period reader accepts actual large rendered native agreement without writes',async(t)=>{
 const f=await fixture(t),{html}=require('../src/render/membershipAgreement').buildMembershipAgreementHtml({
  ...f.native.a.template_snapshot.values,client_legal_name:'Synthetic Large Agreement',
  primary_admin_name:'Synthetic Owner',admin_email:'owner@example.invalid'});
 assert.ok(html.length>8192);
 for(const target of [f.native.a.template_snapshot,f.native.seal.source_snapshot,
  f.native.a.enterprise_checkout_source.material.template_snapshot,
  f.native.a.enterprise_checkout_source.material.execution_seal.source_snapshot])target.rendered_html=html;
 const before=clone(f.native.db.tables),r=await read(f.args);
 assert.equal(r.proof.ordinal,1);assert.deepEqual(f.native.db.tables,before);
 assert.equal(f.native.db.inserts.length,0);assert.equal(f.native.db.updates.length,0);
});
for(const [name,change]of [
 ['active agreement',f=>{f.native.a.status='active';}],
 ['unpaid source',f=>{f.native.a.checkout_status='pending_payment';}],
 ['wrong requested owner',f=>{f.args.clientId='00000000-0000-4000-8000-000000000099';}],
 ['initial invoice',f=>{f.args.invoiceId=f.native.a.enterprise_funding_receipt.proof.invoice_id;}],
 ['missing native receipt',f=>{f.native.a.enterprise_billing_receipt=null;}],
 ['API mismatch',f=>{f.stripe.getApiField=()=> '2026-08-26.dahlia';}]
])test(`reader refuses ${name} before any provider call`,async(t)=>{
 const f=await fixture(t);change(f);await assert.rejects(read(f.args),{code:'enterprise_platform_period_unverified'});assert.equal(f.calls.length,0);
});
for(const [name,change]of [
 ['account',f=>{f.x.providerAccountId='acct_FOREIGN';}],
 ['mode',f=>{f.x.invoice.livemode=true;}],
 ['customer',f=>{f.x.invoice.customer='cus_FOREIGN';}],
 ['subscription',f=>{f.x.invoice.subscription='sub_FOREIGN';}],
 ['refund',f=>{f.x.refunds=[{id:'re_RETURNED'}];}],
 ['cash',f=>{f.x.charge.amount_captured--;}],
 ['tax',f=>{f.x.invoice.total_tax_amounts=[{amount:1,tax_rate:'txr_LOCAL',inclusive:false}];}]
])test(`reader holds foreign or changed ${name} proof`,async(t)=>{
 const f=await fixture(t);change(f);await assert.rejects(read(f.args),{code:'enterprise_platform_period_unverified'});
});
for(const kind of ['invoice','lines','pi','charge','refunds','account'])test(`reader holds ${kind} second read drift`,async(t)=>{
 const f=await fixture(t);f.onRead=(k,n)=>{if(k===kind&&n===2){
  if(k==='account')f.x.providerAccountId='acct_FOREIGN';
  else if(k==='invoice')f.x.invoice.amount_paid++;
  else if(k==='lines')f.x.invoiceLines[0].amount++;
  else if(k==='pi')f.x.paymentIntent.amount_received++;
  else if(k==='charge')f.x.charge.amount_captured++;
  else f.x.refunds.push({id:'re_LATE'});
 }};
 await assert.rejects(read(f.args),{code:'enterprise_platform_period_unverified'});
});
for(const field of ['is_current','checkout_session_id','enterprise_checkout_prices','owner'])test(`reader holds final native ${field} drift`,async(t)=>{
 const f=await fixture(t);f.onRead=(k,n)=>{if(k==='refunds'&&n===2){
  if(field==='is_current')f.native.a.is_current=false;
  else if(field==='checkout_session_id')f.native.a.checkout_session_id='cs_FOREIGN';
  else if(field==='enterprise_checkout_prices')f.native.a.enterprise_checkout_prices.platform_price_id='price_FOREIGN';
  else f.native.db.tables.billing_customers[0].id='00000000-0000-4000-8000-000000000099';
 }};
 await assert.rejects(read(f.args),{code:'enterprise_platform_period_unverified'});
});
test('unrelated live contract/status fields cannot replace the frozen payment source',async(t)=>{
 const f=await fixture(t);f.onRead=(k,n)=>{if(k==='refunds'&&n===2)Object.assign(f.native.client,{
  contract_start_at:'2030-01-01T00:00:00Z',contract_end_at:'2031-01-01T00:00:00Z',billing_status:'past_due',auto_renew:false});};
 const r=await read(f.args);assert.equal(r.proof.ordinal,1);assert.ok(!Object.hasOwn(r.source.client,'contract_end_at'));
});
for(const kind of ['lines','refunds'])for(const shape of ['truncated','duplicate','lost'])test(`reader refuses ${kind} ${shape} collection`,async(t)=>{
 const f=await fixture(t),target=kind==='lines'?f.stripe.invoices:f.stripe.refunds,key=kind==='lines'?'listLineItems':'list';
 target[key]=async(t)=>{if(shape==='lost')throw Error('local read lost');
  const item=kind==='lines'?f.x.invoiceLines[0]:{id:'re_DUPLICATE'};
  return{object:'list',has_more:shape==='truncated',data:shape==='duplicate'?[item,clone(item)]:[]};};
 await assert.rejects(read(f.args),{code:'enterprise_platform_period_unverified'});
});
test('reader rejects input accessor without invoking it',async(t)=>{
 const f=await fixture(t);let touched=false;Object.defineProperty(f.args,'invoiceId',{enumerable:true,get(){touched=true;throw Error('getter');}});
 await assert.rejects(read(f.args),{code:'enterprise_platform_period_unverified'});assert.equal(touched,false);assert.equal(f.calls.length,0);
});
test('caller clock injection is rejected before any read or clock callback',async(t)=>{
 const f=await fixture(t);let touched=false;
 await assert.rejects(read({...f.args,now:()=>{touched=true;return Date.parse('2099-01-01');}}),{code:'enterprise_platform_period_unverified'});
 assert.equal(touched,false);assert.equal(f.calls.length,0);
});
test('actual server observation clock refuses future provider cash',async(t)=>{
 const f=await fixture(t);t.mock.method(Date,'now',()=>Date.parse(f.x.observedAt)-2000);
 await assert.rejects(read(f.args),{code:'enterprise_platform_period_unverified'});
});
test('installed SDK uses only local GET requests and pinned API2023',async(t)=>{
 const f=await fixture(t),requests=[];
 const server=http.createServer(async(req,res)=>{try{
  requests.push({method:req.method,path:req.url,version:req.headers['stripe-version']});assert.equal(req.method,'GET');
  const u=new URL(req.url,'http://127.0.0.1');let data;
  if(u.pathname==='/v1/account')data=await f.stripe.accounts.retrieve();
  else if(u.pathname.endsWith('/lines'))data=await f.stripe.invoices.listLineItems();
  else if(u.pathname.startsWith('/v1/invoices/'))data=await f.stripe.invoices.retrieve();
  else if(u.pathname.startsWith('/v1/payment_intents/'))data=await f.stripe.paymentIntents.retrieve();
  else if(u.pathname.startsWith('/v1/charges/'))data=await f.stripe.charges.retrieve();
  else if(u.pathname==='/v1/refunds')data=await f.stripe.refunds.list();
  else throw Error('unexpected path');
  res.setHeader('content-type','application/json');res.end(JSON.stringify(data));
 }catch(e){res.statusCode=500;res.end(JSON.stringify({error:{message:e.message}}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const stripe=new Stripe('sk_test_SYNTHETIC_ONLY',{apiVersion:'2023-10-16',host:'127.0.0.1',port:server.address().port,protocol:'http',maxNetworkRetries:0});
  const r=await read({...f.args,stripe});assert.equal(r.proof.cash_cents,99999);
  assert.equal(requests.length,12);assert.ok(requests.every(r=>r.method==='GET'&&r.version==='2023-10-16'));
 }finally{await new Promise(r=>server.close(r));}
});
test('platform reader is internal: only the existing completion service imports it',()=>{
 const fs=require('node:fs'),path=require('node:path'),root=path.resolve(__dirname,'../src');
 const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  const p=path.join(dir,e.name);if(e.isDirectory())walk(p);
  else if(e.name.endsWith('.js')&&!['existingEnterprisePlatformPeriodReader.js','existingEnterprisePaymentCompletion.js'].includes(e.name))assert.ok(!fs.readFileSync(p,'utf8').includes('existingEnterprisePlatformPeriodReader'),p);
 }};walk(root);
});

