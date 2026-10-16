'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const dbPath=require.resolve('../src/clients/supabase');
require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{supabaseAdmin:{from(){throw Error('default DB forbidden');}}}};
const fixture=require('./helpers/enterprise-status-observation-fixture');
const {readExistingEnterpriseSubscriptionStatus:read}=require('../src/services/existingEnterprisePlatformPeriodReader');
for(const cadence of ['monthly','annual'])for(const initial of [true,false])test(`GET-only status observes ${cadence} initial=${initial} without funding/access mutation`,async t=>{
 const f=await fixture(t,{cadence,initial}),before=structuredClone(f.native.db.tables),r=await read(f.statusArgs);
 assert.equal(r.proof.subscription_status,'active');assert.equal(r.proof.provider_period_end,f.sub.current_period_end);
 assert.equal(r.billingReceipt.version,'enterprise_existing_billing_v1');assert.ok(Object.isFrozen(r.proof));
 assert.deepEqual(f.native.db.tables,before);assert.ok(f.rpcCalls.every(x=>x.name==='read_enterprise_existing_billing'));
});
for(const status of ['past_due','unpaid','canceled','incomplete','incomplete_expired','paused'])test(`fresh ${status} is only provider projection, not loss of funded access`,async t=>{
 const f=await fixture(t);f.sub.status=status;f.sub.cancel_at_period_end=true;const r=await read(f.statusArgs);
 assert.equal(r.proof.subscription_status,status);assert.equal(r.proof.cancel_at_term_end,true);
 assert.equal(f.native.client.billing_status,'active');assert.equal(f.native.client.auto_renew,true);
});
for(const [name,change]of [
 ['foreign account',f=>{f.x.account.id='acct_FOREIGN';}],['foreign customer',f=>{f.sub.customer='cus_FOREIGN';}],
 ['foreign subscription',f=>{f.sub.id='sub_FOREIGN';}],['mode',f=>{f.sub.livemode=true;}],['price',f=>{f.sub.items.data[0].price.unit_amount--;}],
 ['item',f=>{f.sub.items.data[0].id='si_FOREIGN';}],['quantity',f=>{f.sub.items.data[0].quantity=2;}],
 ['truncated items',f=>{f.sub.items.has_more=true;}],['second item',f=>{f.sub.items.data.push(structuredClone(f.sub.items.data[0]));}],
 ['period geometry',f=>{f.sub.current_period_end--;}],['future start',f=>{f.sub.current_period_start=f.sub.current_period_end;}],
 ['foreign anchor',f=>{f.sub.billing_cycle_anchor++;}],['unknown status',f=>{f.sub.status='synthetic';}],
 ['explicit cancellation awaiting journal',f=>{f.sub.cancel_at=f.sub.current_period_end-1;}],['schedule',f=>{f.sub.schedule='sub_sched_FOREIGN';}],
 ['test clock',f=>{f.sub.test_clock='clock_LOCAL';}],['trial',f=>{f.sub.trial_start=f.sub.created;}],
 ['pause',f=>{f.sub.pause_collection={behavior:'void'};}],['wrong API',f=>{f.stripe.getApiField=()=> '2026-01-01';}]
])test(`status reader holds ${name}`,async t=>{
 const f=await fixture(t);change(f);await assert.rejects(read(f.statusArgs),{code:'enterprise_platform_period_unverified'});
 assert.ok(f.rpcCalls.every(x=>x.name==='read_enterprise_existing_billing'));assert.equal(f.persisted,0);assert.equal(f.refreshes,0);
});
test('provider second read drift and native projection CAS drift stay held',async t=>{
 const f=await fixture(t);f.onSubscriptionRead=n=>{if(n===2)f.sub.status='unpaid';};
 await assert.rejects(read(f.statusArgs),{status:503});f.sub.status='active';
 f.onSubscriptionRead=n=>{if(n===4)f.native.client.subscription_status='canceled';};
 await assert.rejects(read(f.statusArgs),{status:503});
});
test('status observer refuses caller clocks and accessors without invoking them',async t=>{
 const f=await fixture(t);let calls=0;const args={...f.statusArgs,now(){calls++;}};
 await assert.rejects(read(args),{status:503});assert.equal(calls,0);
 const accessor={...f.statusArgs};Object.defineProperty(accessor,'clientId',{get(){calls++;throw Error('unexpected');},enumerable:true});
 await assert.rejects(read(accessor),{status:503});assert.equal(calls,0);
});
