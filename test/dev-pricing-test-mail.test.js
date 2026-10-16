'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express'),request=require('supertest');
const policy=require('../src/config/devPricingTestMail'),guard=require('../src/config/guardedPricingDev');
const a='jason+pricingdev-essential-3-prepaid@alphasourceai.com',b='jason+pricingdev-enterprise-pool@alphasourceai.com';
const msg={from:'info@alphasourceai.com',to:a,subject:'SYNTHETIC DEV ONLY',text:'Synthetic test'};
test('configured recipient set is exact, bounded and only owner-controlled dev aliases',()=>{
 assert.deepEqual(policy.ownerMailRecipients(undefined),[]);assert.deepEqual(policy.ownerMailRecipients(''),[]);
 assert.deepEqual(policy.ownerMailRecipients(' '+a+', '+b+' '),[a,b]);
 assert.deepEqual(policy.ownerMailRecipients(a+',jason+devcorp@alphasourceai.com'),[a,'jason+devcorp@alphasourceai.com']);
 for(const raw of [a.toUpperCase(),a+',',a+','+a,'jason@alphasourceai.com','jason+salesbuyerqa@alphasourceai.com',
  'michael@alphasourceai.com','jason+devcorp-other@alphasourceai.com','jason+devcorp@untrusted.invalid',
  'jason+pricingdev-test@untrusted.invalid','jason+pricingdev-*','Name <'+a+'>',a+'\r\nBcc:'+b,
  Array.from({length:31},(_,i)=>`jason+pricingdev-${i}@alphasourceai.com`).join(',')])assert.throws(()=>policy.ownerMailRecipients(raw));
});
test('devcorp is eligible for explicit configuration, never implicitly allowed to receive mail',()=>{
 const devcorp='jason+devcorp@alphasourceai.com';
 assert.throws(()=>policy.assertOwnerOnlyMail({...msg,to:devcorp},[a,b]),{code:'DEV_PRICING_TEST_MAIL_DENIED'});
 policy.assertOwnerOnlyMail({...msg,to:devcorp},[a,b,devcorp]);
});
test('actual installed SendGrid canonicalization covers each real to/cc/bcc and personalization before send',()=>{
 for(const value of [msg,{...msg,to:[a,b],cc:{email:b,name:'Owner QA'}},
  {from:msg.from,personalizations:[{to:a,bcc:b},{to:{email:b,name:'Synthetic buyer'}}],text:'Synthetic'},
  [{...msg,to:a},{...msg,to:b}],{...msg,from:{email:msg.from,name:'alphaScreen'},to:{email:a,name:'QA Owner'}}])
  policy.assertOwnerOnlyMail(value,[a,b]);
 for(const value of [{...msg,to:'michael@alphasourceai.com'},{...msg,cc:'other@example.invalid'},
  {...msg,bcc:'other@example.invalid'},{...msg,personalizations:[{to:a,bcc:'other@example.invalid'}]},
  {...msg,personalizations:[{to:a},{to:'other@example.invalid'}]},
  {...msg,mail_settings:{bcc:{enable:true,email:'other@example.invalid'}}},
  {...msg,mailSettings:{bcc:{enable:true,email:'other@example.invalid'}}},
  {...msg,headers:{BCC:'other@example.invalid'}},{...msg,headers:{'X-Test':'synthetic'}},{...msg,to:'QA Owner <'+a+'>'},
  {...msg,reply_to:'other@example.invalid'},{...msg,to:[]},{...msg,personalizations:[]},
  {...msg,from:'other@alphasourceai.com'},[msg,{...msg,to:'other@example.invalid'}]])
  assert.throws(()=>policy.assertOwnerOnlyMail(value,[a,b]));
});
const prior={...process.env};
function reset(){for(const k of Object.keys(process.env))if(!Object.hasOwn(prior,k))delete process.env[k];Object.assign(process.env,prior);}
function setEnv(){
 for(const k of [...guard.OFF_FLAGS,...guard.FORBIDDEN_CREDENTIALS,...Object.keys(process.env).filter(k=>k.startsWith('STRIPE_'))])delete process.env[k];
 Object.assign(process.env,{APP_ENV:'development',SUPABASE_URL:guard.DEV_DATABASE_URL,FRONTEND_URL:guard.DEV_FRONTEND_URL,
 RENDER_SERVICE_ID:guard.DEV_SERVICE_ID,RENDER_EXTERNAL_URL:guard.DEV_BACKEND_URL,DEV_PRICING_SANDBOX_ENABLED:'true',
 DEV_STRIPE_ACCOUNT_ID:guard.DEV_STRIPE_ACCOUNT_ID,STRIPE_SECRET_KEY:'rk_test_SYNTHETIC_ONLY',STRIPE_WEBHOOK_SECRET:'whsec_SYNTHETIC',
 DEV_USAGE_BILLING_CLIENT_ID:'11111111-1111-4111-8111-111111111111',USAGE_BILLING_CRON_SECRET:'a'.repeat(64),
 SENDGRID_API_KEY:'SG.SYNTHETIC.LOCAL_ONLY',SENDGRID_FROM:'info@alphasourceai.com',DEV_PRICING_EMAIL_RECIPIENTS:a+','+b});
}
class FakeStripe{constructor(){this.accounts={retrieve:async()=>({id:guard.DEV_STRIPE_ACCOUNT_ID})};this.balance={retrieve:async()=>({livemode:false})};
 this.webhookEndpoints={list:async()=>({has_more:false,data:[{id:'we_LOCAL',status:'enabled',livemode:false,url:guard.DEV_BACKEND_URL+'/webhook/stripe',api_version:'2023-10-16'}]})};}}
test('only the verified dev tuple permits existing SendGrid send; no raw request or foreign recipient',async()=>{
 const name=require.resolve('@sendgrid/mail'),old=require.cache[name],mailFile=require.resolve('../src/clients/sendgrid'),oldMailer=require.cache[mailFile],calls=[];
 try{
  setEnv();require.cache[name]={id:name,filename:name,loaded:true,exports:{setApiKey(){},send:value=>{calls.push(value);return[{statusCode:202}];},sendMultiple:value=>{calls.push(value);return[{statusCode:202}];},client:{setDefaultRequest(){},request(){throw Error('unexpected raw request');}}}};
  const send=require('../src/clients/sendgridFactory')();
  assert.throws(()=>send.send(msg));await guard.initializeDevBillingSandbox({Stripe:FakeStripe});
  assert.equal(guard.isDevPricingTestMail(),true);assert.equal(guard.guardedPricingCapabilities().agreement_sending,true);
  send.send(msg);send.sendMultiple([{...msg,to:b}]);assert.equal(calls.length,2);
  for(const fn of [()=>send.send({...msg,to:'michael@alphasourceai.com'}),()=>send.sendMultiple([msg,{...msg,to:'other@example.invalid'}]),()=>send.client.request({method:'POST',url:'/v3/mail/send',body:msg})])assert.throws(fn);
  assert.equal(calls.length,2);
  delete require.cache[mailFile];const mailer=require('../src/clients/sendgrid');
  assert.equal((await mailer.sendMembershipAgreementEmail(a,'https://interview-agent-frontend-qa.onrender.com/membership-agreement/sign/SYNTHETIC',{})).statusCode,202);
  assert.equal(calls.length,3);
  assert.deepEqual(await mailer.sendMembershipAgreementInternalNotification('memberships@alphasourceai.com',{}),
   {skipped:true,reason:'dev_internal_notification_disabled'});
  assert.equal(calls.length,3); // Accepted buyer send stays accepted; no internal send claimed.
  process.env.DEV_PRICING_EMAIL_RECIPIENTS=a;assert.throws(()=>send.send(msg),{code:guard.CODE});
  assert.equal(calls.length,3);
 }finally{reset();if(old)require.cache[name]=old;else delete require.cache[name];if(oldMailer)require.cache[mailFile]=oldMailer;else delete require.cache[mailFile];}
});
test('owner-only mode lifts existing buyer email paths, never SMS/unrelated internal/invites/invoice sends',async()=>{
 try{
  setEnv();await guard.initializeDevBillingSandbox({Stripe:FakeStripe});const app=express();app.use(guard.guardedPricingDevFence);app.use((_q,r)=>r.status(209).end());
  const id='11111111-1111-4111-8111-111111111111';
  for(const p of ['/api/alphascreen/purchase-intents','/admin/billing/agreements/send','/sales/deals',
   ...['agreement','email-verification/send','email-verification/verify'].map(s=>`/api/alphascreen/purchase-intents/${id}/${s}`),
   ...['resend-agreement','send-payment-reminder','cancel'].map(s=>`/sales/deals/${id}/${s}`)])assert.equal((await request(app).post(p)).status,209,p);
  for(const p of [`/api/alphascreen/purchase-intents/${id}/sms-verification/send`,'/admin/billing/invoices/send',
   '/admin/contracts/process-renewals','/sales/enterprise-handoffs','/clients/invite','/admin/clients',`/sales/deals/${id}/nested/resend-agreement`])
   assert.equal((await request(app).post(p)).status,503,p);
  assert.equal((await request(app).post('/sales/deals').set('X-HTTP-Method-Override','DELETE')).status,503);
 }finally{reset();}
});
test('mail key without exact recipients/mode/from refuses startup, preserving mail-off preview',()=>{
 try{
  for(const patch of [{DEV_PRICING_EMAIL_RECIPIENTS:''},{DEV_PRICING_SANDBOX_ENABLED:''},{SENDGRID_FROM:'sender@example.invalid'},
   {DEV_PRICING_EMAIL_RECIPIENTS:'michael@alphasourceai.com'},{SENDGRID_API_KEY:''}]){
   setEnv();Object.assign(process.env,patch);assert.throws(()=>guard.assertGuardedPricingDevConfiguration());
  }
 }finally{reset();}
});
