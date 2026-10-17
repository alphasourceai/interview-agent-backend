'use strict';
// Actual renderer + authored native/provider reads only. Never hosted cash.
const {test}=require('node:test'),assert=require('node:assert/strict');
const dbPath=require.resolve('../src/clients/supabase');
require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{supabaseAdmin:{from(){throw Error('default DB forbidden');}}}};
const fixture=require('./helpers/enterprise-status-observation-fixture');
const {buildMembershipAgreementHtml}=require('../src/render/membershipAgreement');
const {readExistingEnterpriseSubscriptionStatus:read}=require('../src/services/existingEnterprisePlatformPeriodReader');
const {observeExistingEnterpriseSubscription:observe}=require('../src/services/existingEnterprisePaymentCompletion');
const {snapshotStripeSdkData}=require('../src/services/enterprisePoolPaymentProof');
function install(f,html){
 const n=f.native;
 for(const target of [n.a.template_snapshot,n.seal.source_snapshot,
  n.a.enterprise_checkout_source.material.template_snapshot,n.a.enterprise_checkout_source.material.execution_seal.source_snapshot])
  target.rendered_html=html;
}
async function large(t){
 const f=await fixture(t),{html}=buildMembershipAgreementHtml({...f.native.a.template_snapshot.values,
  client_legal_name:'Synthetic Large Agreement',primary_admin_name:'Synthetic Owner',admin_email:'owner@example.invalid'});
 assert.ok(html.length>8192);install(f,html);return f;
}
test('status reader accepts actual rendered large native agreement without provider/funding writes',async t=>{
 const f=await large(t),before=structuredClone(f.native.db.tables),r=await read(f.statusArgs);
 assert.equal(r.proof.subscription_status,'active');assert.ok(Object.isFrozen(r.source.agreement));
 assert.deepEqual(f.native.db.tables,before);assert.ok(f.rpcCalls.every(x=>x.name==='read_enterprise_existing_billing'));
 assert.equal(f.observations,undefined);assert.equal(f.refreshes,0);
});
test('status completion observes large source once and preserves agreement/pool/receipt bytes',async t=>{
 const f=await large(t),a=structuredClone(f.native.a),p=structuredClone(f.native.pool),r=await observe(f.statusArgs);
 assert.equal(r.status,'observed');assert.equal(f.observations,1);assert.equal(f.refreshes,1);assert.equal(f.persisted,0);
 assert.deepEqual(f.native.a,a);assert.deepEqual(f.native.pool,p);
});
test('large native HTML changed between loads remains held before observation',async t=>{
 const f=await large(t);f.onSubscriptionRead=n=>{if(n===2)install(f,f.native.a.template_snapshot.rendered_html+'<!-- changed -->');};
 await assert.rejects(read(f.statusArgs),{code:'enterprise_platform_period_unverified'});
 assert.equal(f.observations,undefined);assert.equal(f.refreshes,0);
});
for(const [label,make]of [
 ['over16MiB',()=> 'x'.repeat(16777217)],['undefined',()=>undefined],
 ['getter',()=>{const x={};Object.defineProperty(x,'value',{enumerable:true,get(){throw Error('getter must not execute');}});return x;}],
 ['proxy',()=>new Proxy({value:'x'},{get(){throw Error('proxy must not execute');}})],
 ['cycle',()=>{const x={};x.self=x;return x;}]
])test(`native ${label} remains held before provider calls`,async t=>{
 const f=await large(t);f.native.a.template_snapshot.invalid_graph=make();
 await assert.rejects(read(f.statusArgs),{code:'enterprise_platform_period_unverified'});
 assert.equal(f.calls.length,0);assert.equal(f.observations,undefined);
});
test('provider 8193-character value and direct SDK snapshot still rejected',async t=>{
 const f=await large(t);f.x.account.description='x'.repeat(8193);
 await assert.rejects(read(f.statusArgs),{code:'enterprise_platform_period_unverified'});
 assert.throws(()=>snapshotStripeSdkData({description:'x'.repeat(8193)}),{code:'pool_proof_invalid_graph'});
 assert.equal(f.observations,undefined);
});
test('unrelated large-source reader denial keeps existing observer error',async t=>{
 const f=await large(t);f.sub.customer='cus_FOREIGN';
 await assert.rejects(observe(f.statusArgs),{code:'enterprise_subscription_observation_unknown'});
 assert.equal(f.observations,undefined);
});
