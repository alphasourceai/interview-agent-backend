'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express'),request=require('supertest');
const guard=require('../src/config/guardedPricingDev');
const prior={...process.env};
const pins={APP_ENV:'development',SUPABASE_URL:guard.DEV_DATABASE_URL,FRONTEND_URL:guard.DEV_FRONTEND_URL,
 RENDER_SERVICE_ID:guard.DEV_SERVICE_ID,RENDER_EXTERNAL_URL:guard.DEV_BACKEND_URL,
 DEV_PRICING_SANDBOX_ENABLED:'true',DEV_STRIPE_ACCOUNT_ID:guard.DEV_STRIPE_ACCOUNT_ID,
 STRIPE_SECRET_KEY:'rk_test_SYNTHETIC_LOCAL_ONLY',STRIPE_WEBHOOK_SECRET:'whsec_SYNTHETIC_LOCAL_ONLY'};
function reset(){for(const k of Object.keys(process.env))if(!Object.hasOwn(prior,k))delete process.env[k];Object.assign(process.env,prior);}
function env(){for(const k of [...guard.OFF_FLAGS,...guard.FORBIDDEN_CREDENTIALS,...Object.keys(process.env).filter(k=>k.startsWith('STRIPE_'))])delete process.env[k];Object.assign(process.env,pins);}
function fake(patch={}){
 const data={account:{id:guard.DEV_STRIPE_ACCOUNT_ID},balance:{livemode:false},endpoint:{id:'we_SYNTHETIC',status:'enabled',livemode:false,
  url:guard.DEV_BACKEND_URL+'/webhook/stripe',api_version:'2023-10-16'},...patch};const calls=[];
 class Stripe{constructor(key,options){calls.push(['constructor',key,options]);this.accounts={retrieve:async()=>{calls.push(['account']);return data.account;}};
  this.balance={retrieve:async()=>data.balance};this.webhookEndpoints={list:async()=>data.list||{data:[data.endpoint],has_more:false}};
  this.prices={retrieve:async id=>data.price||{id,livemode:false}};}}
 return{Stripe,calls};
}
test('preview default has no bootstrap SDK/provider call; malformed mode and copied pins/keys refuse',async()=>{
 try{
  env();delete process.env.DEV_PRICING_SANDBOX_ENABLED;const f=fake();await guard.initializeDevBillingSandbox({Stripe:f.Stripe});
  assert.equal(f.calls.length,0);assert.equal(guard.isDevBillingSandbox(),false);
  for(const patch of [{DEV_PRICING_SANDBOX_ENABLED:'TRUE'},{DEV_STRIPE_ACCOUNT_ID:'acct_QA'},
   {RENDER_SERVICE_ID:''},{RENDER_EXTERNAL_URL:'https://ia-backend-qa.onrender.com'},
   {STRIPE_SECRET_KEY:'sk_live_SYNTHETIC'},{STRIPE_SECRET_KEY:'rkcs_test_BOOTSTRAP_NOT_HOSTED'},
   {STRIPE_WEBHOOK_SECRET:''},{SENDGRID_API_KEY:'SG.SYNTHETIC'},{RETAIL_RENEWAL_NOTICE_ENABLED:'true'},{USAGE_BILLING_CRON_SECRET:'synthetic'}]){
    env();Object.assign(process.env,patch);const x=fake();await assert.rejects(guard.initializeDevBillingSandbox({Stripe:x.Stripe}));assert.equal(x.calls.length,0);
   }
 }finally{reset();}
});
test('one dedicated account/balance/endpoint/price verification unlocks only billing and invalidates on env drift',async()=>{
 try{
  env();process.env.STRIPE_PRICE_PLATFORM='price_LOCAL';process.env.ENTERPRISE_MONTHLY_USAGE_ENABLED='true';
  process.env.RETAIL_STRIPE_RENEWAL_CONTROL_ENABLED='true';const f=fake();
  await guard.initializeDevBillingSandbox({Stripe:f.Stripe});assert.equal(f.calls.length,2);
  assert.deepEqual(f.calls[0][2],{apiVersion:'2023-10-16',timeout:10000,maxNetworkRetries:0});
  assert.equal(guard.isDevBillingSandbox(),true);guard.assertGuardedDevOutboundAllowed('billing');
  assert.throws(()=>guard.assertGuardedDevOutboundAllowed(),{code:guard.CODE});
  const caps=guard.guardedPricingCapabilities();assert.equal(caps.initial_checkout,true);assert.equal(caps.agreement_signing,true);assert.equal(caps.agreement_sending,false);
  const Real=require('stripe'),Factory=require('../src/clients/stripeFactory')();
  const sdk=new Factory(process.env.STRIPE_SECRET_KEY,{apiVersion:'2023-10-16'});assert.ok(sdk instanceof Real);assert.equal(typeof sdk.invoices.retrieve,'function');
  process.env.STRIPE_WEBHOOK_SECRET='whsec_CHANGED';assert.equal(guard.isDevBillingSandbox(),false);
  assert.throws(()=>guard.assertGuardedDevOutboundAllowed('billing'),{code:guard.CODE});
  const locked=new Factory(process.env.STRIPE_SECRET_KEY);assert.throws(()=>locked.invoices,{code:guard.CODE});
 }finally{reset();}
});
test('wrong account, live balance, copied/duplicate/overflow endpoints and foreign prices never latch',async()=>{
 try{
  const base=fake();const endpoint={id:'we_LOCAL',status:'enabled',livemode:false,url:guard.DEV_BACKEND_URL+'/webhook/stripe',api_version:'2023-10-16'};
  for(const patch of [{account:{id:'acct_QA'}},{balance:{livemode:true}},
   {endpoint:{...endpoint,url:'https://api.alphasourceai.com/webhook/stripe'}},{endpoint:{...endpoint,livemode:true}},
   {endpoint:{...endpoint,api_version:'2026-09-30.endive'}},{list:{data:[endpoint,endpoint],has_more:false}},
   {list:{data:[],has_more:true}},{list:{data:[],has_more:false}},{price:{id:'price_OTHER',livemode:false}},{price:{id:'price_LOCAL',livemode:true}}]){
   env();process.env.STRIPE_PRICE_PLATFORM='price_LOCAL';const f=fake(patch);
   await assert.rejects(guard.initializeDevBillingSandbox({Stripe:f.Stripe}),/sandbox_verification_failed/);assert.equal(guard.isDevBillingSandbox(),false);
  }
 }finally{reset();}
});
test('same exact HTTP paths lift after verification; sends, overrides, schedulers and nested variants stay fenced',async()=>{
 try{
  env();await guard.initializeDevBillingSandbox({Stripe:fake().Stripe});
  const app=express();app.use(guard.guardedPricingDevFence);app.use((_q,r)=>r.status(209).json({downstream:true}));
  const id='11111111-1111-4111-8111-111111111111';
  for(const path of ['/membership-agreements/session','/membership-agreements/sign','/membership-agreements/checkout-session',
   '/clients/billing/portal-session','/clients/billing/additional-interviews/checkout-session','/clients/roles/checkout-session',
   '/admin/billing/customers','/admin/billing/invoices/sync',`/admin/billing/agreements/${id}/void`,
   ...['billing/checkout-session','subscription-checkout','subscription-invoice','usage-invoice','cancel-contract'].map(x=>`/admin/clients/${id}/${x}`)])
   assert.equal((await request(app).post(path)).status,209,path);
  assert.equal((await request(app).patch(`/admin/clients/${id}/auto-renew`)).status,209);
  for(const path of ['/sales/deals','/admin/billing/agreements/send','/admin/billing/invoices/send','/internal/billing/usage-invoices',
   '/admin/contracts/process-renewals','/clients/invite','/api/alphascreen/purchase-intents',
   `/admin/clients/${id}/nested/subscription-checkout`,`/admin/clients/${id}/access-override`,
   '/membership-agreements/%73ign','/membership-agreements/sign?_method=DELETE'])
   assert.equal((await request(app).post(path)).status,503,path);
  assert.equal((await request(app).post('/membership-agreements/sign').set('X-HTTP-Method-Override','GET')).status,503);
  assert.throws(()=>require('../src/clients/sendgridFactory')().send({to:'synthetic@example.invalid'}),{code:guard.CODE});
 }finally{reset();}
});
