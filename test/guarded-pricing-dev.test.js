'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const crypto = require('node:crypto');
const guard = require('../src/config/guardedPricingDev');
const code = guard.CODE;
const priorEnv = { ...process.env };
function guarded(fn) {
  process.env.APP_ENV = 'development';
  return Promise.resolve().then(fn).finally(() => {
    if (priorEnv.APP_ENV == null) delete process.env.APP_ENV; else process.env.APP_ENV = priorEnv.APP_ENV;
  });
}
const pins = { APP_ENV: 'development', SUPABASE_URL: guard.DEV_DATABASE_URL, FRONTEND_URL: guard.DEV_FRONTEND_URL };
let effects = 0;
const poison = () => { effects++; throw Error('unexpected external/native effect'); };
const db = { from: poison, rpc: poison, storage: new Proxy({}, { get: poison }) };
function stub(relative, value) {
  const file = path.join(__dirname, '..', relative);
  require.cache[file] = { id: file, filename: file, loaded: true, exports: value };
}
stub('src/clients/supabase.js', { supabaseAdmin: db, supabaseAnon: {} });

test('exact dev startup pins, live-key refusal, closed credential/flag inventory, no enable override', () => {
  guard.assertGuardedPricingDevConfiguration(pins);
  guard.assertGuardedPricingDevConfiguration({ ...pins, RENDER_SERVICE_ID: guard.DEV_SERVICE_ID });
  for (const bad of [
    { APP_ENV: '' }, { APP_ENV: 'production' }, { SUPABASE_URL: 'https://yjjxzxoghlpguquknyso.supabase.co' },
    { SUPABASE_URL: 'https://rytlclkkcvvnkoncfaid.supabase.co' }, { FRONTEND_URL: 'http://localhost:4173' },
    { RENDER_SERVICE_ID: 'srv-dalm95942hec73cvjbv0' }, { RENDER_SERVICE_ID: 'unrecognized-service' }
  ]) assert.throws(() => guard.assertGuardedPricingDevConfiguration({ ...pins, RENDER_SERVICE_ID: guard.DEV_SERVICE_ID, ...bad }));
  assert.throws(() => guard.assertGuardedPricingDevConfiguration({ RENDER_SERVICE_ID: 'srv-dalm95942hec73cvjbv0', APP_ENV: 'production' }));
  for (const flag of guard.OFF_FLAGS) assert.throws(() => guard.assertGuardedPricingDevConfiguration({ ...pins, [flag]: 'true' }));
  for (const key of guard.FORBIDDEN_CREDENTIALS) assert.throws(() => guard.assertGuardedPricingDevConfiguration({ ...pins, [key]: 'synthetic-only' }));
  for (const prefix of ['sk_live_', 'rk_live_', 'pk_live_']) assert.throws(() => guard.assertGuardedPricingDevConfiguration({ ...pins, STRIPE_SECRET_KEY: prefix+'not-a-real-key' }));
  assert.equal(guard.guardedPricingCapabilities({ ...pins, PRICING_DEV_CHECKOUT_ENABLED: 'true' }).initial_checkout, false);
  guard.assertGuardedPricingDevConfiguration({ APP_ENV: 'production', SUPABASE_URL: 'unchanged' });
});

test('default deny precedes every router/body parser; safe reads/previews only; override/path variants hold', async () => guarded(async () => {
  let downstream = 0;
  const app = express(); app.use(guard.guardedPricingDevFence);
  app.use((_req, res) => { downstream++; res.status(209).json({ native_preview_only: true }); });
  const paths = ['/clients/billing/portal-session', '/clients/roles/checkout-session', '/admin/clients/a/auto-renew',
    '/admin/clients/a/cancel-contract', '/admin/contracts/process-renewals', '/internal/billing/usage-invoices',
    '/admin/billing/invoices/send', '/membership-agreements/checkout-session', '/api/support/voice/session',
    '/api/support/phone-handoff', '/api/sales/voice-handoff', '/webhooks/ghl/sales-ready', '/webhook/tavus',
    '/admin/billing/new-unlisted-mutator', '/sales/deals', '/api/alphascreen/purchase-intents'];
  for (const method of ['post','patch','put','delete']) for (const uri of paths) {
    const r = await request(app)[method](uri).set('Origin', guard.DEV_FRONTEND_URL).send('invalid JSON does not reach parser');
    assert.equal(r.status,503); assert.equal(r.body.code,code); assert.equal(r.headers['access-control-allow-origin'],guard.DEV_FRONTEND_URL);
  }
  assert.equal(downstream,0);
  for (const uri of ['/sales/deals/preview','/admin/billing/agreements/preview','/admin/billing/agreements/preview-html','/admin/billing/agreements/preview-pdf']) {
    assert.equal((await request(app).post(uri)).status,209);
  }
  assert.equal((await request(app).get('/clients')).status,209);
  assert.equal((await request(app).post('/webhook/stripe')).status,209);
  for (const uri of ['/admin/billing/agreements/preview%2fpdf','/admin/billing/agreements/preview?_method=DELETE']) assert.equal((await request(app).post(uri)).status,503);
  assert.equal((await request(app).get('/clients').set('X-HTTP-Method-Override','POST')).status,503);
  const hostile=await request(app).post('/sales/deals').set('Origin','https://untrusted.invalid');
  assert.equal(hostile.headers['access-control-allow-origin'],undefined);
}));

test('all four billing service entries hold before even native lookup/audit/provider construction', async () => guarded(async () => {
  const { processContractRenewals }=require('../src/services/contracts/contractRenewals');
  const usage=require('../src/services/usageBilling');
  const { createSubscriptionCheckoutSession }=require('../src/services/subscriptionCheckout');
  effects=0;
  await assert.rejects(processContractRenewals({}, { db, stripe:new Proxy({}, {get:poison}) }), {status:503,code});
  for (const writer of [usage.applyUsageToInvoice,usage.createImmediateUsageInvoice]) await assert.rejects(writer({db,stripe:new Proxy({}, {get:poison}),clientId:'synthetic',invoiceId:'in_synthetic'}),{status:503,code});
  await assert.rejects(createSubscriptionCheckoutSession({}),{status:503,code});
  assert.equal(effects,0);
}));

test('SDK Stripe factory refuses reads/writes with synthetic Sandbox key but permits local HMAC validation', async () => guarded(async () => {
  const Stripe=require('../src/clients/stripeFactory')();
  const sdk=new Stripe('sk_test_synthetic_not_a_credential',{apiVersion:'2023-10-16'});
  for(const key of ['customers','subscriptions','prices','checkout','invoices','balance']) assert.throws(()=>sdk[key],{status:503,code});
  const payload=JSON.stringify({id:'evt_synthetic',type:'invoice.created',data:{object:{}}}),secret='synthetic-only-signature-secret';
  const t=Math.floor(Date.now()/1000), v=crypto.createHmac('sha256',secret).update(`${t}.${payload}`).digest('hex');
  assert.equal(sdk.webhooks.constructEvent(Buffer.from(payload),`t=${t},v1=${v}`,secret).id,'evt_synthetic');
  assert.throws(()=>sdk.webhooks.generateTestHeaderString,{status:503,code});
}));

test('SendGrid and raw SendGrid/Slack/GHL/Telnyx/Tavus transports hold even with injected credentials/providers', async () => guarded(async () => {
  effects=0;
  const mail=require('../src/clients/sendgridFactory')();
  for(const send of [()=>mail.send({}),()=>mail.sendMultiple({}),()=>mail.client.request({})]) assert.throws(send,{status:503,code});
  const support=require('../src/services/supportHandoff').createSupportHandoff({env:{SUPPORT_HANDOFF_ENABLED:'true',SENDGRID_API_KEY:'synthetic-only'},fetch:poison,rateLimit:poison});
  await assert.rejects(support.send({},{}),{status:503,code});
  const voice=require('../src/services/salesVoiceHandoff').createSalesVoiceHandoff({env:{SALES_VOICE_HANDOFF_ENABLED:'true'},fetch:poison,rateLimit:poison});
  await assert.rejects(voice.send({},{}),{status:503,code});
  await assert.rejects(require('../src/services/salesIntegrations').postSlackMessage({}, {env:{SLACK_SALES_WON_BOT_TOKEN:'synthetic-only'},fetchImpl:poison}),{status:503,code});
  await assert.rejects(require('../src/services/salesIntegrations').processSalesIntegrationDeliveries({db,fetchImpl:poison}),{status:503,code,retryable:false});
  await assert.rejects(require('../src/services/salesTeamProviderSync').syncSalesTeamProviders({db,record:{},env:{SALES_TEAM_PROVIDER_SYNC_ENABLED:'true'},fetchImpl:poison}),{status:503,code});
  await assert.rejects(require('../src/services/ghlSalesIntegration').ghlRequest('/opportunities/a',{config:{token:'synthetic-only'},fetchImpl:poison}),{status:503,code});
  assert.throws(()=>require('../src/clients/telnyx').requestTelnyxMessage({apiKey:'synthetic-only',body:{},httpsModule:{request:poison}}),{status:503,code});
  const sms=require('../src/clients/telnyx').createTelnyxSmsProvider({env:{SMS_ENABLED:'true',TELNYX_API_KEY:'synthetic-only'},transport:poison});
  await assert.rejects(sms.sendOtpSms({}),{status:503,code});
  const lookup=require('../src/services/telnyxNumberLookup');
  assert.throws(()=>lookup.requestTelnyxNumberLookup({toE164:'+15555550100',apiKey:'synthetic-only',httpsModule:{request:poison}}),{status:503,code});
  await assert.rejects(lookup.lookupSmsLineType({db,transport:poison,env:{SMS_LOOKUP_ENABLED:'true'}}),{status:503,code});
  const tavus=require('../src/clients/tavus').createTavusHttpClient({apiKey:'synthetic-only',transport:poison});
  await assert.rejects(tavus.listConversations(),{status:503,code});
  await assert.rejects(tavus.createConversation({}),{status:503,code});
  const gateway=require('../src/services/supportVoiceGateway').createSupportVoiceGateway({requireAuth:poison,serviceDb:db,rateLimit:poison,env:{NODE_ENV:'test',SUPPORT_VOICE_ENABLED:'true',XAI_API_KEY:'synthetic-only'},WebSocketClient:poison});
  assert.throws(()=>gateway.attach({on:poison}),{status:503,code});
  const canary=require('../src/services/supportVoiceProviderCanary').createSupportVoiceProviderCanary({env:{SUPPORT_VOICE_ENABLED:'true',XAI_API_KEY:'synthetic-only'},WebSocketClient:poison});
  assert.throws(()=>canary.start(),{status:503,code});
  assert.equal(effects,0);
}));

test('Stripe webhook checks signature locally then holds without classifier, provider or billing_events access', async () => guarded(async () => {
  const secret='synthetic-only-signature-secret',before=process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET=secret;
  try {
    const app=express();app.use('/webhook/stripe',express.raw({type:'application/json'}),require('../src/routes/webhooks/stripe'));
    effects=0;
    const payload=JSON.stringify({id:'evt_synthetic',type:'checkout.session.completed',data:{object:{metadata:{source:'agreement_checkout'}}}});
    const t=Math.floor(Date.now()/1000),v=crypto.createHmac('sha256',secret).update(`${t}.${payload}`).digest('hex');
    const valid=await request(app).post('/webhook/stripe').set('Content-Type','application/json').set('Stripe-Signature',`t=${t},v1=${v}`).send(payload);
    assert.equal(valid.status,503);assert.equal(valid.body.code,code);
    const bad=await request(app).post('/webhook/stripe').set('Content-Type','application/json').set('Stripe-Signature','bad').send(payload);
    assert.equal(bad.status,400);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    assert.equal((await request(app).post('/webhook/stripe').set('Content-Type','application/json').send(payload)).status,400);
    assert.equal(effects,0);
  } finally { if(before==null)delete process.env.STRIPE_WEBHOOK_SECRET;else process.env.STRIPE_WEBHOOK_SECRET=before; }
}));

test('non-dev middleware passes mutations through unchanged',async()=>{
  const app=express();app.use(guard.guardedPricingDevFence);app.post('/clients/billing/portal-session',(_req,res)=>res.json({existing:true}));
  assert.equal((await request(app).post('/clients/billing/portal-session')).status,200);
});
