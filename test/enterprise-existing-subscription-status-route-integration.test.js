'use strict';
// Actual route/classifier/GET reader/bridge with authored native RPC replies.
// Not SQL/cash/hosted acceptance. No external request or provider mutation.
const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express'),request=require('supertest');
const inject=(path,value)=>{const id=require.resolve(path);require.cache[id]={id,filename:id,loaded:true,exports:value};};
inject('../src/clients/supabase',{supabaseAdmin:{from(){throw Error('default DB forbidden');}}});
const fixture=require('./helpers/enterprise-status-observation-fixture'),{createFakeSupabase}=require('./helpers/fakeSupabase');
for(const type of ['invoice.created','invoice.payment_failed','customer.subscription.updated','customer.subscription.deleted'])
test(`real ${type} observes fresh native-owned subscription and never enters legacy billing`,async t=>{
 const f=await fixture(t),db=f.native.db,events=createFakeSupabase({billing_events:[]},{unique:{billing_events:r=>r.stripe_event_id}});
 const from=db.from.bind(db);db.from=table=>table==='billing_events'?events.from(table):from(table);
 const raw=type.startsWith('invoice.')?{...structuredClone(f.x.invoice),status:type==='invoice.created'?'draft':'open',amount_paid:0,paid:false}:
  structuredClone(f.sub);
 if(type==='customer.subscription.updated')raw.status='unpaid'; // stale event is not current provider projection
 if(type==='customer.subscription.deleted'){f.sub.status='canceled';raw.status='canceled';}
 const stripe={...f.stripe,checkout:f.native.stripe.checkout,webhooks:{constructEvent:()=>({id:'evt_LOCAL_STATUS',type,livemode:false,data:{object:raw}})}};
 inject('../src/clients/supabase',{supabaseAdmin:db});inject('../src/clients/stripe',stripe);
 const forbidden=()=>{throw Error('initial activation/account tail forbidden');};
 inject('../src/services/publicPurchaseActivation',{activatePublicPurchaseAgreementCheckout:forbidden,finishExistingEnterpriseAccountSetup:forbidden});
 const path=require.resolve('../src/routes/webhooks/stripe');delete require.cache[path];const app=express();
 app.use('/webhook/stripe',express.raw({type:'application/json'}),require(path));
 const post=()=>request(app).post('/webhook/stripe').set('content-type','application/json').send('{}');
 const before=structuredClone(db.tables);
 assert.equal((await post()).status,200);assert.equal(f.observations,1);assert.equal(f.refreshes,1);assert.equal(f.persisted,0);
 assert.equal(f.native.client.subscription_status,f.sub.status);assert.equal(f.native.client.auto_renew,true);
 assert.deepEqual(db.tables.membership_agreements,before.membership_agreements);assert.deepEqual(db.tables.client_interview_pools,before.client_interview_pools);
 assert.equal(events.tables.billing_events[0].processed_ok,true);
 assert.equal((await post()).status,200);assert.equal(f.observations,2);assert.equal(f.refreshes,2);assert.equal(f.persisted,0);
 f.sub.currency='eur';assert.equal((await post()).status,503);assert.equal(f.observations,2);assert.equal(f.refreshes,2);
 assert.ok(f.rpcCalls.every(x=>['read_enterprise_existing_billing','record_enterprise_existing_subscription_observation','refresh_enterprise_existing_paid_coverage'].includes(x.name)));
});
