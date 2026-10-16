'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const id=require.resolve('../src/clients/supabase');require.cache[id]={id,filename:id,loaded:true,exports:{supabaseAdmin:{from(){throw Error('default DB forbidden');}}}};
const fixture=require('./helpers/enterprise-status-observation-fixture');
const {observeExistingEnterpriseSubscription:observe,refreshExistingEnterpriseCoverage:refresh}=require('../src/services/existingEnterprisePaymentCompletion');
const statusCode={code:'enterprise_subscription_observation_unknown',status:503};
for(const cadence of ['monthly','annual'])test(`status bridge ${cadence} projects provider status but derives base access from native paid prefix`,async t=>{
 const f=await fixture(t,{cadence}),before=structuredClone(f.native.db.tables);f.sub.status='past_due';
 const r=await observe(f.statusArgs);assert.equal(r.status,'observed');assert.equal(r.observation.projection.subscription_status,'past_due');
 assert.equal(r.coverage.contiguous_ordinal,0);assert.equal(r.coverage.billing_status,'inactive');
 assert.equal(f.persisted,0);assert.equal(f.refreshes,1);assert.equal(f.observations,1);
 assert.equal(f.native.client.auto_renew,true);assert.equal(f.native.client.contract_start_at,before.clients[0].contract_start_at);
 assert.deepEqual(f.native.db.tables.membership_agreements,before.membership_agreements);
 assert.deepEqual(f.native.db.tables.client_interview_pools,before.client_interview_pools);
 assert.equal((await observe(f.statusArgs)).status,'observed');assert.equal(f.persisted,0);assert.equal(f.observations,2);
});
test('status bridge cannot project provider state after unverified GET scope',async t=>{
 const f=await fixture(t);f.sub.customer='cus_FOREIGN';await assert.rejects(observe(f.statusArgs),statusCode);assert.equal(f.observations,undefined);
});
for(const [name,change]of [
 ['lost ack',r=>{r.data=null;}],['error',r=>{r.error={message:'lost'};}],['status',r=>{r.data.status='ok';}],
 ['owner',r=>{r.data.client_id='00000000-0000-4000-8000-000000000099';}],['source digest',r=>{r.data.source_digest='foreign';}],
 ['mirror',r=>{r.data.projection.cancel_at_term_end=true;}],['end',r=>{r.data.projection.current_term_end='2090-01-01T00:00:00.000000Z';}],
 ['extra authority',r=>{r.data.paid_access_authorized=true;}],['old clock',r=>{r.data.observed_at='2020-01-01T00:00:00.000000Z';}]
])test(`status bridge holds ${name}, fresh same-source retry without rollback claim`,async t=>{
 const f=await fixture(t);f.onObservationResult=change;await assert.rejects(observe(f.statusArgs),statusCode);assert.equal(f.observations,1);
 f.onObservationResult=null;assert.equal((await observe(f.statusArgs)).status,'observed');assert.equal(f.persisted,0);
});
test('status coverage failure stays retryable after provider projection already saved',async t=>{
 const f=await fixture(t);f.onCoverageResult=r=>{r.data.billing_source_digest='f'.repeat(32);};
 await assert.rejects(observe(f.statusArgs),statusCode);assert.equal(f.observations,1);assert.equal(f.persisted,0);
 f.onCoverageResult=null;assert.equal((await observe(f.statusArgs)).status,'observed');
});
test('scanner refresh verifies native paid owner without any Stripe read or status rewrite',async t=>{
 const f=await fixture(t),before=structuredClone(f.native.db.tables),r=await refresh({db:f.native.db,agreementId:f.native.a.id,clientId:f.native.client.id});
 assert.equal(r.status,'refreshed');assert.equal(r.contiguous_ordinal,0);assert.equal(f.calls.length,0);assert.equal(f.observations,undefined);
 assert.deepEqual(f.native.db.tables,before);assert.equal(f.persisted,0);
 await assert.rejects(refresh({db:f.native.db,agreementId:f.native.a.id,clientId:'00000000-0000-4000-8000-000000000099'}),{code:'enterprise_paid_coverage_unknown'});
});
