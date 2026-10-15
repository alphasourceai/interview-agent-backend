'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {snapshotStripeSdkData:sdk,snapshotEnterpriseUsageCensusData:contract}=require('../src/services/enterprisePoolPaymentProof');
const {generationFixture}=require('./fixtures/generation-retail-funding-fixture');
const {buildMembershipAgreementHtml}=require('../src/render/membershipAgreement');
function rendered(){const f=generationFixture('basic',6,'prepaid',true);
 f.g.template_snapshot.rendered_html=buildMembershipAgreementHtml(f.g.template_snapshot.values,
  {packageSnapshot:f.pkg,generatedAt:f.g.template_snapshot.generated_at}).html;
 assert.ok(f.g.template_snapshot.rendered_html.length>8192);return f;
}
test('existing bounded native profile copies full renderer output without changing any field',()=>{
 const f=rendered(),before=JSON.stringify(f.g);assert.throws(()=>sdk(f.g),{code:'pool_proof_invalid_graph'});
 assert.equal(JSON.stringify(contract(f.g)),before);assert.equal(JSON.stringify(f.g),before);
 // Provider policy is still small, not widened globally by contract support.
 assert.throws(()=>sdk({description:'x'.repeat(8193)}),{code:'pool_proof_invalid_graph'});
});
test('native contract profile rejects getters/proxies/cycles/hidden SDK metadata/undefined/oversize',()=>{
 let reads=0;const getter={};Object.defineProperty(getter,'x',{enumerable:true,get(){reads++;return 'x';}});
 const cycle={};cycle.self=cycle;
 const metadata={};Object.defineProperty(metadata,'lastResponse',{value:{},enumerable:false,writable:false,configurable:false});
 for(const value of [getter,new Proxy({a:1},{}),cycle,{nested:metadata},{bad:undefined},{html:'x'.repeat(16777217)}])
  assert.throws(()=>contract(value),{code:'pool_proof_invalid_graph'});
 assert.equal(reads,0);
});
test('full synthetic contract crosses linked row reader before any provider or native write',async()=>{
 const f=rendered(),calls=[];
 // Real application adapter must read the entire source without rejecting its
 // rendered HTML. The intentional mismatched source then holds before effects.
 Object.assign(f.g,{retail_funding_receipt:{version:'synthetic'},checkout_status:'paid'});
 const db={from(table){calls.push(table);return{select(){return this;},eq(){return this;},async maybeSingle(){
  return{data:table==='membership_agreements'?f.g:f.i,error:null};}};},rpc(){throw Error('no RPC authorized');}};
 const {applyExistingRetailLinkedBilling}=require('../src/services/existingRetailLinkedBillingAdapter');
 await assert.rejects(applyExistingRetailLinkedBilling({db,stripe:{},agreementId:f.g.id}),
  {code:'retail_linked_billing_source_unknown'});
 assert.deepEqual(calls,['membership_agreements','public_purchase_intents']);
});
