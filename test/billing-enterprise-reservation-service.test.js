'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createFakeSupabase}=require('./helpers/fakeSupabase');
const {createEnterpriseCheckoutReservationService:create}=require('../src/services/enterpriseCheckoutReservation');
const {prepareEnterprisePoolTerms}=require('../src/services/enterprisePoolSnapshot');
const owner='10000000-0000-4000-8000-000000000001',client='10000000-0000-4000-8000-000000000002';
const agreement='10000000-0000-4000-8000-000000000003',project='s'.repeat(20);
const token='SYNTHETIC_NOT_A_REAL_TOKEN_0000000000';
const subject={accessToken:token},request={agreementId:agreement,idempotencyKey:'synthetic-request-key-0001'};
function fixture(options={}){
 const tables={membership_agreements:[{id:agreement,client_id:client,admin_email:'synthetic@example.invalid'}],
  clients:[{id:client,parent_client_id:null,archived_at:null,stripe_customer_id:'cus_SYNTHETIC'}]};
 const db=createFakeSupabase(tables),events=[];
 db.supabaseUrl=`https://${project}.supabase.co`;
 let authCalls=0,writes=0,reads=0,stored;
 const principal={id:owner,email:'synthetic@example.invalid',is_anonymous:false,email_confirmed_at:'2020-01-01T00:00:00Z'};
 db.auth={async getUser(value){events.push('auth');authCalls++;assert.equal(value,token);
  if(options.authHook)await options.authHook({calls:authCalls,db,tables});
  if(options.authErrorAt===authCalls)return {error:Error('SYNTHETIC failure')};
  const user=structuredClone(principal);if(options.userHook)options.userHook(user,authCalls);return {data:{user}};
 }};
 db.rpc=async(name,args)=>{
  events.push(name);
  if(name==='enterprise_v2_reserve_checkout'){
   writes++;if(options.sqlError)return {error:{code:options.sqlError}};
   if(!stored){const p=prepareEnterprisePoolTerms({membership_tier:'enterprise',billing_model:'usage',pool_quantity:30,usage_interview_fee_cents:2500});
    const now=new Date(Math.floor(Date.now()/1000)*1000),expiry=new Date(+now+3600000).toISOString();
    const source={protocol:'enterprise_signed_source_v2',document_fields:{id:agreement,client_id:client,admin_email:principal.email,
     membership_tier:'enterprise',billing_option:options.annual?'annual':'monthly',agreement_expires_at:new Date(+now+86400000).toISOString()},
     signature_fields:{signer_accepted:true,signature_sha256:'b'.repeat(64)},template_snapshot:{values:{...p,platform_fee:options.fee??100}}};
    const o={id:args.p_id,pool_id:args.p_pool,agreement_id:agreement,client_id:client,billing_owner_user_id:owner,environment:args.p_environment,
     expected_provider_account_id:args.p_account,expected_livemode:args.p_mode,expected_customer_id:args.p_customer,request_key_hash:args.p_key_hash,
     source_snapshot:source,source_digest:'a'.repeat(64),pool_offer_snapshot:p.pool_offer_snapshot,pool_offer_digest:p.pool_offer_digest,
     platform_cents:options.cents??10000,platform_interval:options.annual?'year':'month',created_at:now.toISOString(),expires_at:expiry,
     calendar_anchor_at:new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1)).toISOString(),
     checkout_creation_authorized:false,provider_binding_verified:false,source_artifacts_verified:false,credits_spendable:false};
    stored={operation:o,pool:{id:o.pool_id,client_id:client,checkout_operation_id:o.id,status:'pending',created_at:o.created_at,
     stripe_checkout_session_id:null,stripe_payment_intent_id:null,paid_at:null,quantity_purchased:p.pool_offer_snapshot.quantity,
     unit_price_cents:p.pool_offer_snapshot.unit_price_cents,discount_pct:p.pool_offer_snapshot.automatic_discount_percent,total_cents:p.pool_offer_snapshot.net_cents,
     offer_snapshot:p.pool_offer_snapshot,offer_digest:p.pool_offer_digest}};
   }
   if(options.lostAck)throw Error('SYNTHETIC lost commit acknowledgment');
   const result={action:writes===1?'reserved':'already_reserved',operation_id:stored.operation.id,pool_id:stored.pool.id};
   if(options.ackHook)options.ackHook(result);return {data:result};
  }
  assert.equal(name,'enterprise_v2_read_checkout');reads++;
  if(options.readError)return {error:Error('SYNTHETIC native scope/read denied')};
  const value=structuredClone(stored);if(options.readHook)options.readHook(value);return {data:value};
 };
 const configuration={projectRef:project,environment:'dev',providerAccountId:'acct_SYNTHETIC',livemode:false};
 return {db,tables,events,configuration,service:create({db,configuration}),stats:()=>({writes,reads,authCalls})};
}
test('passive service performs four fresh getUser checks and one mutation plus one scoped READ; returns no buyer/token/provider data',async()=>{
 const f=fixture(),r=await f.service.reserve(subject,request);
 assert.deepEqual(f.stats(),{writes:1,reads:1,authCalls:4});assert.deepEqual(f.events,['auth','auth','enterprise_v2_reserve_checkout','auth','enterprise_v2_read_checkout','auth']);
 assert.equal(r.pool_net_cents,69750);assert.equal(r.platform_cents,10000);assert.equal(r.persistence,'verified');assert.ok(Object.isFrozen(r));
 for(const flag of ['checkout_creation_authorized','provider_binding_verified','source_artifacts_verified','credits_spendable'])assert.equal(r[flag],false);
 for(const text of [token,'synthetic@example.invalid','cus_SYNTHETIC','acct_SYNTHETIC'])assert.ok(!JSON.stringify(r).includes(text));
});
test('known matching replay and lost commit reply keep same owned IDs; no second mutation per invocation or old fallback',async()=>{
 for(const lostAck of [false,true]){
  const f=fixture({lostAck}),a=await f.service.reserve(subject,request),b=await f.service.reserve(subject,request);
  assert.equal(a.operation_id,b.operation_id);assert.equal(a.pool_id,b.pool_id);assert.equal(a.created_at,b.created_at);
  assert.equal(f.stats().writes,2);assert.equal(f.stats().reads,2);
  if(lostAck)assert.equal(a.persistence,'recovered_unknown_commit');
 }
});
test('exact decimal cents use integer arithmetic, preserve annual recurrence, do not round',async()=>{
 const f=fixture({annual:true,fee:'970.14',cents:97014}),r=await f.service.reserve(subject,request);assert.equal(r.platform_cents,97014);assert.equal(r.platform_interval,'year');
 const bad=fixture({fee:'100.009',cents:10000});await assert.rejects(bad.service.reserve(subject,request),/readback_unverified/);
});
for(const bad of [{is_anonymous:true},{email_confirmed_at:null},{deleted_at:'2026-01-01Z'},
 {banned_until:'9999-01-01Z'},{email:'other@example.invalid'},{id:'not-a-valid-auth-uuid'}]){
 test(`initial Auth rejects ${Object.keys(bad).join(',')} before native mutation`,async()=>{
  const f=fixture({userHook:u=>Object.assign(u,bad)});
  await assert.rejects(f.service.reserve(subject,request),/scope_denied|enterprise_reservation_denied/);
  assert.equal(f.stats().writes,0);
 });
}
for(const step of [2,3,4])test(`fresh principal change at Auth check ${step} holds without another mutation`,async()=>{
 const f=fixture({userHook:(u,n)=>{if(n===step)u.email='changed@example.invalid';}});
 await assert.rejects(f.service.reserve(subject,request),/scope_changed/);assert.equal(f.stats().writes,step===2?0:1);
});
test('missing/wrong project, mutable configuration, direct-child/archive/customer absence hold',async()=>{
 const f=fixture();f.db.supabaseUrl='https://other.supabase.co';await assert.rejects(f.service.reserve(subject,request),/project_mismatch/);
 const cfg=fixture();cfg.configuration.providerAccountId='acct_CHANGED';const r=await cfg.service.reserve(subject,request);assert.equal(r.checkout_creation_authorized,false);
 for(const patch of [{parent_client_id:crypto.randomUUID()},{archived_at:'2026-01-01Z'},{stripe_customer_id:null}]){
  const x=fixture();Object.assign(x.tables.clients[0],patch);await assert.rejects(x.service.reserve(subject,request),/scope_denied/);assert.equal(x.stats().writes,0);
 }
});
test('strict request shape rejects getters/proxies/unknown money/normalized or short keys without effects',async()=>{
 let invoked=false;const getter={agreementId:agreement,get idempotencyKey(){invoked=true;return request.idempotencyKey;}};
 for(const input of [getter,new Proxy(request,{}),{...request,platformCents:1},{...request,idempotencyKey:'short'},{...request,idempotencyKey:'bad key not normalized'}]){
  const f=fixture();await assert.rejects(f.service.reserve(subject,input),/invalid_request/);assert.equal(f.stats().writes,0);
 }assert.equal(invoked,false);
});
for(const corrupt of [v=>v.operation.expected_provider_account_id='acct_WRONG',v=>v.operation.expected_livemode=true,
 v=>v.operation.request_key_hash='0'.repeat(64),v=>v.operation.client_id=crypto.randomUUID(),v=>v.operation.checkout_creation_authorized=true,
 v=>v.operation.provider_binding_verified=true,v=>v.operation.source_artifacts_verified=true,v=>v.operation.credits_spendable=true,
 v=>v.operation.platform_cents=1,v=>v.operation.platform_interval='year',v=>v.operation.source_snapshot.document_fields.admin_email='other@example.invalid',
 v=>v.operation.calendar_anchor_at=v.operation.expires_at,v=>v.pool.id=crypto.randomUUID(),v=>v.pool.checkout_operation_id=crypto.randomUUID(),
 v=>v.pool.total_cents=1,v=>v.pool.status='paid',v=>v.pool.stripe_checkout_session_id='cs_WRONG',v=>v.pool.paid_at='2026-01-01Z',
 v=>v.pool.offer_digest='0'.repeat(64),v=>v.pool.offer_snapshot.net_cents=1]){
 test(`native readback corruption ${String(corrupt)} cannot become usable checkout or trigger retry`,async()=>{
  const f=fixture({readHook:corrupt});await assert.rejects(f.service.reserve(subject,request),/readback_unverified|invalid_enterprise_pool_snapshot/);
  assert.equal(f.stats().writes,1);assert.equal(f.stats().reads,1);
 });
}
test('bad known ack, definite native error or failed unknown-ACK readback hold without fallback/retry',async()=>{
 for(const options of [{ackHook:r=>r.operation_id=crypto.randomUUID()},{sqlError:'23505'},{sqlError:'42501'},
  {lostAck:true,readError:true},{authErrorAt:3}]){
  const f=fixture(options);await assert.rejects(f.service.reserve(subject,request));assert.equal(f.stats().writes,1);
 }
});
test('source service imports no Stripe/sender/access/legacy checkout and cannot enable flags',()=>{
 const source=require('node:fs').readFileSync(require.resolve('../src/services/enterpriseCheckoutReservation'),'utf8');
 assert.ok(!/require\(['"](?:stripe|.*subscriptionCheckout|.*sendgrid|.*PaymentActivation|.*mailer)/.test(source));
});
