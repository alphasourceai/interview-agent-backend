'use strict';
// Local HTTP/DB/Stripe doubles. No hosted requests or financial observations.
const {test}=require('node:test'),assert=require('node:assert/strict');
const express=require('express'),request=require('supertest');
const guard=require('../src/config/guardedPricingDev');
const {createFakeSupabase}=require('./helpers/fakeSupabase');
const OWNER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const SECRET='a'.repeat(64),prior={...process.env};
const paths=['../src/clients/supabase','../src/clients/stripe','../src/services/usageBilling','../src/routes/internal/usageBilling'].map(require.resolve);
const saved=new Map(paths.map(p=>[p,require.cache[p]]));
function reset(){for(const k of Object.keys(process.env))if(!Object.hasOwn(prior,k))delete process.env[k];Object.assign(process.env,prior);for(const [p,m] of saved)if(m)require.cache[p]=m;else delete require.cache[p];}
function env(){for(const k of [...guard.OFF_FLAGS,...guard.FORBIDDEN_CREDENTIALS,...Object.keys(process.env).filter(k=>k.startsWith('STRIPE_'))])delete process.env[k];Object.assign(process.env,{
 APP_ENV:'development',RENDER_SERVICE_ID:guard.DEV_SERVICE_ID,RENDER_EXTERNAL_URL:guard.DEV_BACKEND_URL,
 SUPABASE_URL:guard.DEV_DATABASE_URL,FRONTEND_URL:guard.DEV_FRONTEND_URL,DEV_PRICING_SANDBOX_ENABLED:'true',
 DEV_STRIPE_ACCOUNT_ID:guard.DEV_STRIPE_ACCOUNT_ID,STRIPE_SECRET_KEY:'rk_test_LOCAL_ONLY',STRIPE_WEBHOOK_SECRET:'whsec_LOCAL_ONLY',
 DEV_USAGE_BILLING_CLIENT_ID:OWNER,USAGE_BILLING_CRON_SECRET:SECRET,ENTERPRISE_MONTHLY_USAGE_ENABLED:'true'});}
class FakeStripe{constructor(){this.accounts={retrieve:async()=>({id:guard.DEV_STRIPE_ACCOUNT_ID})};this.balance={retrieve:async()=>({livemode:false})};this.webhookEndpoints={list:async()=>({has_more:false,data:[{id:'we_LOCAL',status:'enabled',livemode:false,url:guard.DEV_BACKEND_URL+'/webhook/stripe',api_version:'2023-10-16'}]})};}}
function dbFixture(){return{membership_agreements:[{id:'a',client_id:OWNER,enterprise_checkout_source:{}},{id:'b',client_id:OTHER,enterprise_checkout_source:{}}],
 client_plan_settings:[OWNER,OTHER].map(client_id=>({client_id,plan_tier:'enterprise',billing_model:'usage'})),
 clients:[OWNER,OTHER].map(id=>({id,name:'Scheduler SOFTWARE TEST Synthetic',billing_interval:'annual',stripe_customer_id:'cus_LOCAL_'+id}))};}
function appFor(tables,options={}){
 const db=createFakeSupabase(tables,options),calls=[];
 const inject=(p,exports)=>{require.cache[p]={id:p,filename:p,loaded:true,exports};};
 inject(paths[0],{supabaseAdmin:db});inject(paths[1],{});
 inject(paths[2],{createImmediateUsageInvoice:async args=>{calls.push(args.clientId);return{invoice_id:'in_LOCAL',total_cents:2500};}});
 delete require.cache[paths[3]];const app=express();app.use(express.json());app.use(guard.guardedPricingDevFence);app.use('/internal',require(paths[3]));
 return{app,calls,db};
}
const run=(app,secret=SECRET)=>request(app).post('/internal/billing/usage-invoices').set('x-cron-secret',secret).send({asOf:'1900-01-01',client_id:OTHER});
test('dev usage credential pair is mandatory, strong and included in the verified fingerprint',async()=>{
 try{
  for(const patch of [{DEV_USAGE_BILLING_CLIENT_ID:undefined},{USAGE_BILLING_CRON_SECRET:undefined},{DEV_USAGE_BILLING_CLIENT_ID:'00000000-0000-0000-0000-000000000000'},{DEV_USAGE_BILLING_CLIENT_ID:' '+OWNER},
   {DEV_USAGE_BILLING_CLIENT_ID:OWNER+','+OTHER},{DEV_USAGE_BILLING_CLIENT_ID:OWNER.toUpperCase().replace('111','ABC')},
   {USAGE_BILLING_CRON_SECRET:'weak'},{USAGE_BILLING_CRON_SECRET:'A'.repeat(64)}]){
   env();for(const [k,v]of Object.entries(patch))if(v===undefined)delete process.env[k];else process.env[k]=v;
   await assert.rejects(guard.initializeDevBillingSandbox({Stripe:FakeStripe}),/usage_scope_invalid/);
  }
  env();process.env.ENTERPRISE_MONTHLY_USAGE_ENABLED='false';await guard.initializeDevBillingSandbox({Stripe:FakeStripe});
  assert.equal(guard.devUsageBillingClientId(),OWNER);assert.throws(()=>guard.assertGuardedDevUsageOwner(OWNER),{code:guard.CODE});
  process.env.DEV_USAGE_BILLING_CLIENT_ID=OTHER;assert.throws(()=>guard.devUsageBillingClientId(),{code:guard.CODE});
  env();await guard.initializeDevBillingSandbox({Stripe:FakeStripe});process.env.USAGE_BILLING_CRON_SECRET='b'.repeat(64);
  assert.throws(()=>guard.devUsageBillingClientId(),{code:guard.CODE});
  env();process.env.DEV_PRICING_SANDBOX_ENABLED='false';assert.throws(()=>guard.assertGuardedPricingDevConfiguration(),/usage_scope_invalid/);
 }finally{reset();}
});
test('existing cron authenticates, uses only pinned marked owner, and ignores caller body',async()=>{
 try{env();await guard.initializeDevBillingSandbox({Stripe:FakeStripe});const tables=dbFixture(),before=structuredClone(tables),x=appFor(tables);
  assert.equal((await run(x.app,'wrong')).status,403);assert.deepEqual(x.calls,[]);
  const r=await run(x.app);assert.equal(r.status,200);assert.equal(r.body.considered,1);assert.equal(r.body.invoiced,1);assert.deepEqual(x.calls,[OWNER]);assert.deepEqual(tables,before);
  assert.throws(()=>guard.assertGuardedDevUsageOwner(OTHER),{code:guard.CODE});
  assert.equal((await request(x.app).post(`/admin/clients/${OTHER}/usage-invoice`)).status,503);
  assert.equal((await request(x.app).post('/internal/billing/usage-invoices').set('X-HTTP-Method-Override','GET')).status,503);
 }finally{reset();}
});
test('missing marker, missing scope client, non-synthetic label, census failure, off flag and runtime drift never collect',async()=>{
 try{
  for(const kind of ['marker','client','name','census','off','drift']){
   env();if(kind==='off')process.env.ENTERPRISE_MONTHLY_USAGE_ENABLED='false';await guard.initializeDevBillingSandbox({Stripe:FakeStripe});
   const tables=dbFixture();if(kind==='marker')tables.membership_agreements=tables.membership_agreements.filter(a=>a.client_id!==OWNER);
   if(kind==='client')tables.clients=tables.clients.filter(c=>c.id!==OWNER);if(kind==='name')tables.clients[0].name='Not a test';
   const x=appFor(tables,kind==='census'?{failOn:{membership_agreements:{op:'select',error:{message:'unavailable'}}}}:{});
   if(kind==='drift')process.env.DEV_USAGE_BILLING_CLIENT_ID=OTHER;
   assert.equal((await run(x.app)).status,503,kind);assert.deepEqual(x.calls,[],kind);
  }
 }finally{reset();}
});
test('QA ignores a leaked dev pin and retains full authenticated legacy/marked census',async()=>{
 const RealDate=Date;
 try{env();process.env.APP_ENV='qa';delete process.env.RENDER_SERVICE_ID;assert.equal(guard.devUsageBillingClientId(),null);
  global.Date=class extends RealDate{constructor(...args){super(...(args.length?args:['2026-10-01T03:00:00Z']));}static now(){return Date.parse('2026-10-01T03:00:00Z');}};
  const tables=dbFixture();tables.clients.forEach(c=>c.name='Legacy QA');const x=appFor(tables);const r=await run(x.app);
  assert.equal(r.status,200);assert.equal(r.body.considered,2);assert.deepEqual(x.calls,[OWNER,OTHER]);
 }finally{global.Date=RealDate;reset();}
});
test('ordinary unassigned retail agreements do not block marked Enterprise owner census in dev or QA',async()=>{
 try{for(const mode of ['dev','qa']){
  env();if(mode==='qa'){process.env.APP_ENV='qa';delete process.env.RENDER_SERVICE_ID;}else await guard.initializeDevBillingSandbox({Stripe:FakeStripe});
  const tables=dbFixture();tables.membership_agreements.push({id:'c',client_id:null});
  const x=appFor(tables),r=await run(x.app);assert.equal(r.status,200,mode);
  assert.deepEqual(x.calls,mode==='dev'?[OWNER]:[OWNER,OTHER],mode);
 }}finally{reset();}
});
test('marked agreements without owners and malformed non-null owners still hold before collection',async()=>{
 try{for(const mode of ['dev','qa'])for(const row of [
  {id:'c',client_id:null,enterprise_checkout_source:{}},
  {id:'c',client_id:null,enterprise_billing_receipt:{}},
  {id:'c',client_id:''},
  {id:'c',client_id:' '}
 ]){
  env();if(mode==='qa'){process.env.APP_ENV='qa';delete process.env.RENDER_SERVICE_ID;}else await guard.initializeDevBillingSandbox({Stripe:FakeStripe});
  const tables=dbFixture();tables.membership_agreements.push(row);
  const x=appFor(tables),r=await run(x.app);assert.equal(r.status,503,mode);assert.deepEqual(x.calls,[],mode);
 }}finally{reset();}
});
test('both existing invoice service entry points refuse other dev owners before database or provider effects',async()=>{
 try{env();await guard.initializeDevBillingSandbox({Stripe:FakeStripe});
  const usage=require('../src/services/usageBilling');
  for(const name of ['applyUsageToInvoice','createImmediateUsageInvoice'])
   await assert.rejects(usage[name]({clientId:OTHER}),{code:guard.CODE});
 }finally{reset();}
});
