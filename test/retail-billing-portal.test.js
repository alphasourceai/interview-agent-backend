'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const {createFakeSupabase} = require('./helpers/fakeSupabase');
const {buildRetailPackageSnapshot} = require('../src/services/membershipPackageCompatibility');
const {OFFER_VERSION, retailTermWindow} = require('../src/services/membershipOffers');
const DBPATH = require.resolve('../src/clients/supabase');
require.cache[DBPATH] = {id:DBPATH,filename:DBPATH,loaded:true,exports:{supabaseAdmin:{}}};
const C='44444444-4444-4444-8444-444444444444', A='2026-01-31T12:13:14.000Z';
const CONFIG='bpc_SYNTHETIC', CUSTOMER='cus_SYNTHETIC', RETURN='https://dev.invalid/dashboard?tab=billing';
const KEY='sk_test_SYNTHETIC_NO_PROVIDER';
function configuration(){return {id:CONFIG,object:'billing_portal.configuration',active:true,application:null,
  livemode:false,is_default:false,login_page:{enabled:false},features:{customer_update:{enabled:false},invoice_history:{enabled:true},
  payment_method_update:{enabled:true},subscription_cancel:{enabled:false},subscription_update:{enabled:false}}};}
function session(){return {object:'billing_portal.session',id:'bps_SYNTHETIC',customer:CUSTOMER,configuration:CONFIG,
  livemode:false,return_url:RETURN,flow:null,on_behalf_of:null,url:'https://billing.stripe.com/p/session/SYNTHETIC'};}
function fixture(months=3,payment='prepaid',plan='basic'){
 const pkg=structuredClone(buildRetailPackageSnapshot({planKey:plan,commitmentMonths:months,paymentOption:payment,
   channel:'sales',offerVersion:OFFER_VERSION}));
 const term=retailTermWindow({originalStart:A,commitmentMonths:months,termIndex:1});
 const client={id:C,parent_client_id:null,plan_tier:plan,billing_interval:pkg.billing_cadence,
   contract_start_at:term.term_start_at,contract_end_at:term.term_end_at,auto_renew:true,billing_status:'active',
   stripe_customer_id:CUSTOMER,stripe_subscription_id:'sub_SYNTHETIC',subscription_status:'active'};
 const agreement={id:'33333333-3333-4333-8333-333333333333',client_id:C,status:'signed',is_current:true,
   checkout_status:'paid',checkout_paid_at:A,membership_tier:plan,billing_option:pkg.billing_cadence,
   template_version:'membership_agreement_retail_terms_v2',template_snapshot:{template_version:'membership_agreement_retail_terms_v2',package_snapshot:pkg}};
 const tables={clients:[client],membership_agreements:[agreement]}, db=createFakeSupabase(tables),calls=[];
 const f={client,agreement,tables,db,calls,providerReads:[],config:configuration(),session:session()};
 f.subscription={id:'sub_SYNTHETIC',object:'subscription',customer:CUSTOMER,livemode:false,metadata:{membership_pricing_version:pkg.pricing_version}};
 f.subscriptions=[f.subscription];
 f.stripe={subscriptions:{retrieve:async id=>{f.providerReads.push({op:'retrieve',id});return structuredClone(f.subscription);},
   list:async payload=>{f.providerReads.push({op:'list',payload});
    const start=payload.starting_after?f.subscriptions.findIndex(s=>s.id===payload.starting_after)+1:0;
    return {object:'list',has_more:start+100<f.subscriptions.length,data:structuredClone(f.subscriptions.slice(start,start+100))};}},
   billingPortal:{configurations:{retrieve:async id=>{calls.push({op:'read',id});if(f.onRead)await f.onRead();return structuredClone(f.config);}},
   sessions:{create:async payload=>{calls.push({op:'create',payload});if(f.onCreate)await f.onCreate();return structuredClone(f.session);}}}};
 return f;
}
function service(f,overrides={}){return require('../src/services/retailBillingPortal').createClientBillingPortalSession({
 db:f.db,stripe:f.stripe,clientId:C,customerId:CUSTOMER,returnUrl:RETURN,authorizeRetail:true,
 configurationId:CONFIG,stripeKey:KEY,...overrides});}
test('all12 accepted offers use the restricted explicit portal and preserve accepted amounts',async()=>{
 for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments']){
  const f=fixture(months,payment,plan),before=structuredClone(f.tables),result=await service(f);
  assert.equal(result.url,f.session.url);assert.deepEqual(f.tables,before);
  assert.deepEqual(f.calls,[{op:'read',id:CONFIG},{op:'create',payload:{customer:CUSTOMER,return_url:RETURN,configuration:CONFIG}},{op:'read',id:CONFIG}]);
 }
});
test('actual API2023 portal accepts only the known disabled optional pause control',async()=>{
 const f=fixture();f.config.features.subscription_pause={enabled:false};
 assert.equal((await service(f)).url,f.session.url);
 assert.equal(f.calls.filter(x=>x.op==='create').length,1);
 for(const pause of [{enabled:true},{},{enabled:'false'},null,[]]){
  const g=fixture();g.config.features.subscription_pause=pause;
  await assert.rejects(service(g),{code:'RETAIL_PORTAL_UNAVAILABLE'});
  assert.equal(g.calls.some(x=>x.op==='create'),false);
 }
 const unknown=fixture();unknown.config.features.future_feature={enabled:false};
 await assert.rejects(service(unknown),{code:'RETAIL_PORTAL_UNAVAILABLE'});
 assert.equal(unknown.calls.some(x=>x.op==='create'),false);
});
test('genuine legacy and unmarked Enterprise preserve exact existing default-portal payload',async()=>{
 for(const plan of ['basic','enterprise']){
  const f=fixture();f.client.plan_tier=plan;f.client.billing_interval='monthly';f.tables.membership_agreements=[];f.subscription.metadata={};
  assert.equal((await service(f,{configurationId:'',authorizeRetail:false})).url,f.session.url);
  assert.deepEqual(f.calls,[{op:'create',payload:{customer:CUSTOMER,return_url:RETURN}},{op:'read',id:CONFIG}]);
 }
});
test('pending, malformed, missing and read-error marked sources never fall back to default portal',async()=>{
 for(const mutate of [f=>{f.agreement.checkout_status='pending_payment';},f=>{f.agreement.checkout_paid_at=null;},
  f=>{f.agreement.template_snapshot.package_snapshot.membership_terms.commitment_months=9;},
  f=>{f.tables.membership_agreements=[];},f=>{f.db=createFakeSupabase(f.tables,{failOn:{membership_agreements:{op:'select'}}});}]){
  const f=fixture();mutate(f);await assert.rejects(service(f));assert.deepEqual(f.calls,[]);
 }
});
test('unconfirmed authorization, child owner, stale customer and missing server config stop before provider calls',async()=>{
 for(const overrides of [{authorizeRetail:false},{authorizeRetail:null},{customerId:'cus_FOREIGN'},
  {configurationId:''},{configurationId:'invalid'},{stripeKey:''},{stripeKey:'unknown'}]){
  const f=fixture();await assert.rejects(service(f,overrides));assert.deepEqual(f.calls,[]);
 }
 const f=fixture();f.client.parent_client_id='55555555-5555-4555-8555-555555555555';
 await assert.rejects(service(f));assert.deepEqual(f.calls,[]);
});
test('unsafe, ambiguous and wrong-mode portal features stop before creating a session',async()=>{
 for(const mutate of [f=>{f.config.id='bpc_OTHER';},f=>{f.config.object='customer';},f=>{f.config.active=false;},
  f=>{f.config.is_default=true;},f=>{delete f.config.is_default;},
  f=>{f.config.livemode=true;},f=>{delete f.config.livemode;},f=>{f.config.application='ca_OTHER';},
  f=>{f.config.login_page.enabled=true;},f=>{delete f.config.login_page;},
  ...['customer_update','subscription_cancel','subscription_update'].map(k=>f=>{f.config.features[k].enabled=true;}),
  ...['invoice_history','payment_method_update'].map(k=>f=>{f.config.features[k].enabled=false;}),
  ...['customer_update','subscription_cancel','subscription_update','invoice_history','payment_method_update'].map(k=>f=>{delete f.config.features[k].enabled;}),
  f=>{f.config.features.future_feature={enabled:true};}]){
  const f=fixture();mutate(f);await assert.rejects(service(f),{code:'RETAIL_PORTAL_UNAVAILABLE'});
  assert.equal(f.calls.some(x=>x.op==='create'),false);
 }
});
test('changed source, parent or preference during configuration read cannot issue a session',async()=>{
 for(const mutate of [f=>{f.client.stripe_customer_id='cus_OTHER';},f=>{f.client.stripe_subscription_id='sub_OTHER';},
  f=>{f.client.auto_renew=false;},f=>{f.client.parent_client_id='OTHER';},f=>{f.agreement.id='OTHER';},
  f=>{f.agreement.checkout_status='pending_payment';},f=>{f.agreement.template_snapshot.package_snapshot.membership_terms.offer_version='changed';}]){
  const f=fixture();f.onRead=()=>{f.onRead=null;mutate(f);};await assert.rejects(service(f));
  assert.equal(f.calls.some(x=>x.op==='create'),false);
 }
});
test('created session wrong binding, redirect, host, flow or mode never returns a portal URL',async()=>{
 for(const mutate of [f=>{f.session.configuration='bpc_OTHER';},f=>{f.session.customer='cus_OTHER';},
  f=>{f.session.object='checkout.session';},f=>{f.session.id='cs_OTHER';},f=>{f.session.livemode=true;},
  f=>{f.session.return_url='https://foreign.invalid';},f=>{f.session.flow={type:'subscription_cancel'};},
  f=>{f.session.on_behalf_of='acct_OTHER';},f=>{f.session.url='http://billing.stripe.com/p/session/SYNTHETIC';},
  f=>{f.session.url='https://billing.stripe.com.foreign.invalid/p/session/SYNTHETIC';},
  f=>{f.session.url='https://user@billing.stripe.com/p/session/SYNTHETIC';},
  f=>{f.session.url='https://billing.stripe.com/p/session/SYNTHETIC?redirect=foreign';},
  f=>{f.session.url='https://billing.stripe.com/p/session/SYNTHETIC#foreign';},
  f=>{f.session.url='https://billing.stripe.com:444/p/session/SYNTHETIC';},f=>{f.session.url='https://billing.stripe.com';}]){
  const f=fixture();mutate(f);await assert.rejects(service(f),{code:'RETAIL_PORTAL_UNAVAILABLE'});
  assert.equal(f.calls.filter(x=>x.op==='create').length,1);
 }
});
test('configuration/source edits after session creation hold instead of returning the session or creating another',async()=>{
 for(const mutate of [f=>{f.config.features.subscription_cancel.enabled=true;},f=>{f.client.auto_renew=false;}]){
  const f=fixture();f.onCreate=()=>mutate(f);await assert.rejects(service(f));
  assert.equal(f.calls.filter(x=>x.op==='create').length,1);
 }
});
test('provider read/create failures have no fallback session and no provider detail disclosure',async()=>{
 for(const stage of ['read','create']){
  const f=fixture();f.stripe.billingPortal[stage==='read'?'configurations':'sessions'][stage==='read'?'retrieve':'create']=async()=>{throw Error('secret_provider_detail');};
  await assert.rejects(service(f),e=>e.code==='RETAIL_PORTAL_UNAVAILABLE'&&!e.message.includes('secret_provider_detail'));
 }
});
test('metadata-only retail, duplicate database customers and marked foreign provider subscriptions cannot use default portal',async()=>{
 for(const mutate of [f=>{f.client.billing_interval='monthly';f.tables.membership_agreements=[];},
  f=>{f.tables.clients.push({...f.client,id:'55555555-5555-4555-8555-555555555555'});},
  f=>{f.subscriptions.push({...f.subscription,id:'sub_OTHER'});},
  f=>{f.subscription.customer='cus_OTHER';}]){
  const f=fixture();mutate(f);await assert.rejects(service(f));assert.equal(f.calls.some(x=>x.op==='create'),false);
 }
});
test('a child with an unmarked row cannot use the accepted parent customer through the legacy branch',async()=>{
 const f=fixture(),child='55555555-5555-4555-8555-555555555555';
 f.tables.clients.push({id:child,parent_client_id:C,stripe_customer_id:CUSTOMER,billing_interval:'monthly'});
 await assert.rejects(service(f,{clientId:child}));assert.equal(f.calls.some(x=>x.op==='create'),false);
});
test('unmarked legacy parent preserves child portal with its own unique customer and clean census',async()=>{
 const f=fixture(),child='55555555-5555-4555-8555-555555555555',customer='cus_CHILD';
 f.client.billing_interval='monthly';f.tables.membership_agreements=[];f.subscription.metadata={};
 f.tables.clients.push({id:child,parent_client_id:C,stripe_customer_id:customer,billing_interval:'monthly',stripe_subscription_id:null});
 f.subscriptions=[{id:'sub_CHILD_HISTORY',object:'subscription',customer,livemode:false,metadata:{}}];
 f.session.customer=customer;
 assert.equal((await service(f,{clientId:child,customerId:customer})).url,f.session.url);
 assert.deepEqual(f.calls.find(x=>x.op==='create').payload,{customer,return_url:RETURN});
 assert.equal(f.calls.filter(x=>x.op==='create').length,1);
});
test('the same unique legacy child with a marked provider subscription cannot create a default portal',async()=>{
 const f=fixture(),child='55555555-5555-4555-8555-555555555555',customer='cus_CHILD';
 f.client.billing_interval='monthly';f.tables.membership_agreements=[];f.subscription.metadata={};
 f.tables.clients.push({id:child,parent_client_id:C,stripe_customer_id:customer,billing_interval:'monthly',stripe_subscription_id:null});
 f.subscriptions=[{id:'sub_CHILD_HISTORY',object:'subscription',customer,livemode:false,metadata:{membership_pricing_version:'marked'}}];
 await assert.rejects(service(f,{clientId:child,customerId:customer}),{code:'RETAIL_PORTAL_UNAVAILABLE'});
 assert.equal(f.calls.some(x=>x.op==='create'),false);
});
test('legacy-null to retail transition between reads refuses the default session',async()=>{
 const f=fixture(),accepted=structuredClone(f.agreement);f.client.billing_interval='monthly';f.tables.membership_agreements=[];f.subscription.metadata={};
 const originalList=f.stripe.subscriptions.list;let reads=0;
 f.stripe.subscriptions.list=async payload=>{const result=await originalList(payload);if(++reads===1){
  f.client.billing_interval='prepaid';f.tables.membership_agreements.push(accepted);f.subscription.metadata={membership_pricing_version:'marked'};
 }return result;};
 await assert.rejects(service(f));assert.equal(f.calls.some(x=>x.op==='create'),false);
});
test('complete customer census rejects pagination errors, repeated ids and late marked subscriptions',async()=>{
 for(const mutate of [f=>{f.stripe.subscriptions.list=async()=>({object:'list',has_more:true,data:[]});},
  f=>{f.stripe.subscriptions.list=async()=>({object:'list',data:[f.subscription]});},
  f=>{f.subscriptions.push({...f.subscription});},
  f=>{f.subscriptions=Array.from({length:101},(_,i)=>({...f.subscription,id:`sub_SYNTHETIC${i}`,metadata:{}}));f.subscriptions[100].metadata={membership_pricing_version:'marked'};}]){
  const f=fixture();mutate(f);await assert.rejects(service(f));assert.equal(f.calls.some(x=>x.op==='create'),false);
 }
});
test('a complete multi-page unmarked legacy census preserves default portal, but capped census refuses',async()=>{
 const f=fixture();f.client.billing_interval='monthly';f.tables.membership_agreements=[];f.subscription.metadata={};
 f.subscriptions=[f.subscription,...Array.from({length:100},(_,i)=>({...f.subscription,id:`sub_HISTORY${i}`}))];
 assert.equal((await service(f)).url,f.session.url);
 assert.ok(f.providerReads.filter(x=>x.op==='list').some(x=>x.payload.starting_after));
 assert.ok(f.providerReads.filter(x=>x.op==='list').every(x=>x.payload.status==='all'&&x.payload.customer===CUSTOMER));
 f.calls.length=0;f.subscriptions=[f.subscription,...Array.from({length:999},(_,i)=>({...f.subscription,id:`sub_CAPPED${i}`}))];
 await assert.rejects(service(f));assert.equal(f.calls.some(x=>x.op==='create'),false);
});
test('legacy session readback mismatch and post-create source transition also withhold URL without a retry',async()=>{
 for(const mutate of [f=>{f.session.flow={type:'subscription_cancel'};},f=>{f.session.return_url='https://foreign.invalid';},
  f=>{f.onCreate=()=>{f.subscription.metadata={membership_pricing_version:'marked'};};}]){
  const f=fixture();f.client.billing_interval='monthly';f.tables.membership_agreements=[];f.subscription.metadata={};mutate(f);
  await assert.rejects(service(f),{code:'RETAIL_PORTAL_UNAVAILABLE'});assert.equal(f.calls.filter(x=>x.op==='create').length,1);
 }
});
test('invoice-only unmarked customers require a clean census and do not invent a subscription',async()=>{
 const f=fixture();f.client.billing_interval='monthly';f.client.stripe_subscription_id=null;f.tables.membership_agreements=[];f.subscriptions=[];
 assert.equal((await service(f)).url,f.session.url);assert.equal(f.providerReads.some(x=>x.op==='retrieve'),false);
 f.calls.length=0;f.subscriptions=[f.subscription];
 await assert.rejects(service(f));assert.equal(f.calls.some(x=>x.op==='create'),false);
});
function appFor(f,role='manager',ids=[C],adminFlags={}){
 const root=path.resolve(__dirname,'..');
 const inject=(file,exports)=>{const id=path.join(root,file);require.cache[id]={id,filename:id,loaded:true,exports};};
 inject('src/clients/supabase.js',{supabaseAdmin:f.db});inject('src/clients/stripe.js',f.stripe);
 inject('src/middleware/auth.js',{requireAuth:(_req,_res,next)=>next(),withClientScope:(req,_res,next)=>{
  req.client_memberships=ids;req.memberships=[{client_id:C,role}];req.clientScope={effectiveRolesByClientId:{[C]:[role]},clientById:{[C]:f.client}};next();}});
 const authId=path.join(root,'src/middleware/auth.js');
 const withScope=require.cache[authId].exports.withClientScope;
 require.cache[authId].exports.withClientScope=(req,res,next)=>withScope(req,res,()=>{Object.assign(req,adminFlags);next();});
 const file=path.join(root,'src/routes/client/billing.js');delete require.cache[file];
 const app=express();app.use(express.json());app.use(require(file));return app;
}
test('mounted route denies foreign/member requests and ignores browser configuration, flow and return URL',async()=>{
 process.env.STRIPE_RETAIL_PORTAL_CONFIGURATION_ID=CONFIG;process.env.STRIPE_SECRET_KEY=KEY;
 for(const [role,clientId] of [['member',C],['manager','FOREIGN']]){
  const f=fixture(),r=await request(appFor(f,role)).post('/clients/billing/portal-session').send({client_id:clientId});
  assert.equal(r.status,403);assert.equal(f.calls.length,0);
 }
 const f=fixture();f.onCreate=()=>{f.session.return_url=f.calls.find(x=>x.op==='create').payload.return_url;};
 const r=await request(appFor(f)).post('/clients/billing/portal-session').send({client_id:C,configuration:'bpc_UNSAFE',
  flow_data:{type:'subscription_cancel'},return_url:'https://foreign.invalid'});
 assert.equal(r.status,200);assert.equal(r.body.url,f.session.url);
 const payload=f.calls.find(x=>x.op==='create').payload;
 assert.equal(payload.configuration,CONFIG);assert.equal(Object.hasOwn(payload,'flow_data'),false);
 assert.equal(payload.return_url.includes('foreign.invalid'),false);
 delete process.env.STRIPE_RETAIL_PORTAL_CONFIGURATION_ID;delete process.env.STRIPE_SECRET_KEY;
});
test('mounted missing/unsafe config returns safe503 without returning private provider data',async()=>{
 process.env.STRIPE_SECRET_KEY=KEY;delete process.env.STRIPE_RETAIL_PORTAL_CONFIGURATION_ID;
 const f=fixture(),r=await request(appFor(f)).post('/clients/billing/portal-session').send({client_id:C});
 assert.equal(r.status,503);assert.equal(r.body.code,'RETAIL_PORTAL_UNAVAILABLE');assert.deepEqual(f.calls,[]);
 assert.equal(JSON.stringify(r.body).includes(CUSTOMER),false);delete process.env.STRIPE_SECRET_KEY;
});
test('the route first client lookup and SDK construction errors also have stable safe responses',async()=>{
 const f=fixture();f.db=createFakeSupabase(f.tables,{failOn:{clients:{op:'select',error:{message:'PRIVATE_DATABASE_DETAILS'}}}});
 const r=await request(appFor(f)).post('/clients/billing/portal-session').send({client_id:C});
 assert.equal(r.status,503);assert.equal(r.body.code,'RETAIL_PORTAL_UNAVAILABLE');
 assert.equal(JSON.stringify(r.body).includes('PRIVATE_DATABASE_DETAILS'),false);
 const g=fixture(),app=appFor(g);
 const stripeId=require.resolve('../src/clients/stripe');
 require.cache[stripeId]=Object.defineProperty({id:stripeId,filename:stripeId,loaded:true},'exports',{
  get(){throw new Error('PRIVATE_CONSTRUCTOR_DETAILS');}});
 try{
  const response=await request(app).post('/clients/billing/portal-session').send({client_id:C});
  assert.equal(response.status,503);assert.equal(response.body.code,'RETAIL_PORTAL_UNAVAILABLE');
  assert.equal(JSON.stringify(response.body).includes('PRIVATE_CONSTRUCTOR_DETAILS'),false);
 }finally{require.cache[stripeId]={id:stripeId,filename:stripeId,loaded:true,exports:g.stripe};}
});
test('global/isAdmin use the restricted server configuration; owner-only role is not granted new write access',async()=>{
 process.env.STRIPE_RETAIL_PORTAL_CONFIGURATION_ID=CONFIG;process.env.STRIPE_SECRET_KEY=KEY;
 try{
  for(const flags of [{isGlobalAdmin:true},{isAdmin:true}]){
   const f=fixture();f.onCreate=()=>{f.session.return_url=f.calls.find(x=>x.op==='create').payload.return_url;};
   const r=await request(appFor(f,'member',[C],flags)).post('/clients/billing/portal-session').send({client_id:C});
   assert.equal(r.status,200);assert.equal(f.calls.find(x=>x.op==='create').payload.configuration,CONFIG);
  }
  const f=fixture(),r=await request(appFor(f,'owner')).post('/clients/billing/portal-session').send({client_id:C});
  assert.equal(r.status,403);assert.equal(f.calls.length,0);
 }finally{delete process.env.STRIPE_RETAIL_PORTAL_CONFIGURATION_ID;delete process.env.STRIPE_SECRET_KEY;}
});
test('accepted, pending and malformed owners refuse child targets with the same safe forbidden code',async()=>{
 for(const state of ['accepted','pending','malformed']){
  const f=fixture(),child='55555555-5555-4555-8555-555555555555';
  f.tables.clients.push({id:child,parent_client_id:C,stripe_customer_id:CUSTOMER,billing_interval:'monthly'});
  if(state==='pending')f.agreement.checkout_status='pending_payment';
  if(state==='malformed')f.agreement.template_version='other';
  await assert.rejects(service(f,{clientId:child}),{code:'RETAIL_PORTAL_FORBIDDEN'});
  assert.equal(f.calls.some(x=>x.op==='create'),false);
 }
});
test('expanded Session configuration is validated and unknown or changed safe fields refuse',async()=>{
 const f=fixture();f.session.configuration=configuration();assert.equal((await service(f)).url,f.session.url);
 for(const mutate of [c=>{c.features.subscription_update.enabled=true;},c=>{c.id='bpc_OTHER';},c=>{c.is_default=true;}]){
  const g=fixture();g.session.configuration=configuration();mutate(g.session.configuration);await assert.rejects(service(g));
 }
});
test('installed Supabase SDK exact count is independent of the bounded two-row response',async()=>{
 const http=require('node:http'),{createClient}=require('@supabase/supabase-js');let observed;
 const server=http.createServer((req,res)=>{observed={path:req.url,prefer:req.headers.prefer};
  res.setHeader('content-type','application/json');res.setHeader('content-range','0-0/1');res.end(JSON.stringify([{id:C}]));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 try{
  const db=createClient(`http://127.0.0.1:${server.address().port}`,'synthetic-local-only',
   {auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  const result=await db.from('clients').select('id',{count:'exact'}).eq('stripe_customer_id',CUSTOMER).limit(2);
  assert.equal(result.error,null);assert.equal(result.count,1);assert.deepEqual(result.data,[{id:C}]);
  const url=new URL(observed.path,'http://localhost');assert.equal(url.searchParams.get('limit'),'2');
  assert.equal(observed.prefer,'count=exact');
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('installed SDK16/API2023 serializes only restricted portal fields using loopback, never provider access',async()=>{
 const http=require('node:http'),Stripe=require('stripe'),f=fixture(),requests=[];
 const server=http.createServer(async(req,res)=>{
  const body=[];for await(const chunk of req)body.push(chunk);
  requests.push({method:req.method,path:req.url,version:req.headers['stripe-version'],body:Buffer.concat(body).toString()});
  let payload;
  if(req.url==='/v1/subscriptions/sub_SYNTHETIC')payload=f.subscription;
  else if(req.url.startsWith('/v1/subscriptions?'))payload={object:'list',has_more:false,data:f.subscriptions};
  else if(req.url==='/v1/billing_portal/configurations/bpc_SYNTHETIC')payload=f.config;
  else if(req.url==='/v1/billing_portal/sessions')payload=f.session;
  else {res.statusCode=400;payload={error:{message:'Unexpected synthetic request'}};}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(payload));
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 try{
  const stripe=new Stripe(KEY,{apiVersion:'2023-10-16',host:'127.0.0.1',port:server.address().port,protocol:'http',maxNetworkRetries:0});
  assert.equal((await service(f,{stripe})).url,f.session.url);
  assert.ok(requests.every(r=>r.version==='2023-10-16'));
  const writes=requests.filter(r=>r.method!=='GET');assert.equal(writes.length,1);
  assert.equal(writes[0].path,'/v1/billing_portal/sessions');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(writes[0].body)),{customer:CUSTOMER,return_url:RETURN,configuration:CONFIG});
 }finally{await new Promise(resolve=>server.close(resolve));}
});
