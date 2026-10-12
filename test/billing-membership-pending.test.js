'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture,canonical,sha}=require('./fixtures/retail-review-fixture');
const {createMembershipPendingPurchase}=require('../src/services/membershipPendingPurchase');
const PDF=Buffer.from('%PDF-1.7\nSYNTHETIC PENDING UNIT\n%%EOF');
function setup(hooks={}){
 const f=fixture(),id=crypto.randomUUID(),token='T'.repeat(43),attempt=crypto.randomUUID(),calls=[];let reserved=null,sessions=0;
 const fingerprint=f.sourceReply.source_fingerprint,hash=sha(`retail-signing-v2\n${id}\n${fingerprint}\n${token}`);
 const now=new Date().toISOString(),expires=new Date(Date.now()+3600000).toISOString();
 const d={id,source_id:f.sourceId,scope_id:f.sourceReply.source.scope_id,issuer_user_id:f.sourceReply.source.issuer_user_id,
  source_fingerprint:fingerprint,html_sha256:sha('html'),preview_pdf_sha256:sha(PDF),issued_at:now,expires_at:expires};
 const a={document_id:id,source_id:d.source_id,scope_id:d.scope_id,attempt_id:attempt,signer_token_hash:hash,source_fingerprint:fingerprint,
  html_sha256:d.html_sha256,preview_pdf_sha256:d.preview_pdf_sha256,consent:true,accepted_at:now,
  signature_path:`retail-v2/${id}/attempts/${attempt}/signature.png`,executed_pdf_path:`retail-v2/${id}/attempts/${attempt}/executed.pdf`,
  executed_pdf_sha256:sha(PDF),executed_pdf_size:PDF.length};
 const snapshot={protocol:'retail_pending_purchase_v2',schema_version:2,document:d,source:f.sourceReply.source,quote:f.quoteReply.quote,
  legal:{version:'retail-membership-issued-synthetic'},acceptance:a,
  signature_proof:{document_id:id,attempt_id:attempt,encoding:'png_rgba_v1',width:300,height:100,pixels_sha256:sha('pixels'),recorded_at:now}};
 // Opaque native JSONB digest; unit fake does not claim to recreate its layout.
 const context={snapshot,digest:sha('SYNTHETIC NATIVE CHECKSUM'),observed_at:now};
 const db={from(){return {select(){return {eq(){return this;},async maybeSingle(){calls.push('document');return {data:{id,source_fingerprint:fingerprint,signer_token_hash:hash},error:null};}};}};},
  async rpc(name,p){calls.push(name);
   if(name==='membership_v2_pending_source')return {data:hooks.context?hooks.context(structuredClone(context)):structuredClone(context),error:null};
   if(name==='membership_v2_reserve_pending_purchase'){
    if(hooks.definite)return {error:{code:'42501'}};
    const replay=!!reserved;
    reserved=reserved||{id:p.p_id,document_id:id,source_id:d.source_id,scope_id:d.scope_id,original_salesperson_user_id:d.issuer_user_id,
     acceptance_attempt_id:attempt,environment:'dev',source_snapshot:snapshot,source_digest:context.digest,created_at:now,expires_at:expires,
     state:'awaiting_payment_and_account',provider_effects_enabled:false,account_ownership_verified:false,activation_enabled:false};
    if(hooks.unique)return {error:{code:'23505'}};if(hooks.unknown==='throw')throw Error('SYNTHETIC');
    if(hooks.unknown)return {error:{code:'NETWORK'}};
    return {data:{action:replay?'already_reserved':'reserved',purchase_id:reserved.id},error:null};
   }
   assert.equal(name,'membership_v2_read_pending_purchase');const c=structuredClone(context);c.observed_at=new Date().toISOString();
   return {data:hooks.missing?null:hooks.read?hooks.read({purchase:structuredClone(reserved),context:c,historical_identity_only:true}):
    {purchase:structuredClone(reserved),context:c,historical_identity_only:true},error:null};
  }};
 const signing={async session(){calls.push('session');sessions++;if(hooks.sessionThrow)throw Error('SYNTHETIC');
  const r={session:{document_id:id,state:'accepted',accepted_at:now,offer:f.quoteReply.quote.offer,checkout_enabled:false,activation_enabled:false},pdf_bytes:PDF};
  return hooks.session?hooks.session(r,sessions):r;}};
 return {service:createMembershipPendingPurchase({db,signing,environment:'dev'}),input:{documentId:id,token},calls,snapshot};
}
test('no default configuration, wrong environments and closed own-property bodies fail',async()=>{
 assert.throws(()=>createMembershipPendingPurchase(),e=>e.code==='pending_purchase_not_configured');
 for(const change of [{token:'bad'},{documentId:crypto.randomUUID().toUpperCase()},{clientId:crypto.randomUUID()},{environment:'production'},{amount:0}]){
  const x=setup();await assert.rejects(()=>x.service.reserve({...x.input,...change}),e=>e.code==='invalid_pending_purchase');assert.equal(x.calls.length,0);
 }
 const x=setup(),bad={documentId:x.input.documentId};Object.defineProperty(bad,'token',{enumerable:true,get(){throw Error('must not run');}});
 await assert.rejects(()=>x.service.reserve(bad),e=>e.code==='invalid_pending_purchase');assert.equal(x.calls.length,0);
});
test('fresh and matching repeat return persistence only, no owner/checkout/payment/access claims',async()=>{
 const x=setup(),a=await x.service.reserve(x.input),b=await x.service.reserve(x.input);
 assert.equal(a.disposition,'recorded_pending_linkage');assert.equal(b.disposition,'historical_inert');assert.equal(a.purchase_id,b.purchase_id);assert.equal(a.created_at,b.created_at);
 for(const result of [a,b]){assert.equal(result.provider_effects_enabled,false);assert.equal(result.account_ownership_verified,false);assert.equal(result.activation_enabled,false);
  for(const key of ['buyer_email','source_snapshot','token','paid','checkout_enabled','contract_id','client_id','owner_id','access_enabled'])assert.equal(key in result,false);}
});
test('known denial does not become recovery; unknown/23505 reads once and never repeats reserve',async()=>{
 const x=setup({definite:true});await assert.rejects(()=>x.service.reserve(x.input),e=>e.code==='pending_purchase_commit_failed');assert.ok(!x.calls.includes('membership_v2_read_pending_purchase'));
 for(const hooks of [{unknown:'throw'},{unknown:'returned'},{unique:true}]){const x=setup(hooks),r=await x.service.reserve(x.input);
  assert.equal(r.disposition,'historical_inert');assert.equal(r.persistence,'recovered_unknown_commit');
  assert.equal(x.calls.filter(n=>n==='membership_v2_reserve_pending_purchase').length,1);assert.equal(x.calls.filter(n=>n==='membership_v2_read_pending_purchase').length,1);}
});
test('capability, unsigned or changed session holds before reservation',async()=>{
 for(const hooks of [{sessionThrow:true},{session:r=>({...r,session:{...r.session,state:'signable'}})},
  {session:(r,n)=>n===2?{...r,session:{...r.session,accepted_at:'2000-01-01T00:00:00Z'}}:r}]){
  const x=setup(hooks);await assert.rejects(()=>x.service.reserve(x.input));assert.ok(!x.calls.includes('membership_v2_reserve_pending_purchase'));
 }
 const x=setup();await assert.rejects(()=>x.service.reserve({...x.input,token:'Z'.repeat(43)}),e=>e.code==='pending_purchase_capability_denied');
 assert.ok(!x.calls.includes('membership_v2_reserve_pending_purchase'));
});
for(const contextChange of [c=>({...c,snapshot:{...c.snapshot,acceptance:{...c.snapshot.acceptance,consent:false}}}),
 c=>({...c,snapshot:{...c.snapshot,source:{...c.snapshot.source,original_salesperson_user_id:crypto.randomUUID()}}}),
 c=>({...c,snapshot:{...c.snapshot,acceptance:{...c.snapshot.acceptance,executed_pdf_sha256:sha('other')}}}),
 c=>({...c,snapshot:{...c.snapshot,signature_proof:null}}),c=>({...c,snapshot:{...c.snapshot,quote:{...c.snapshot.quote,offer:{amount:0}}}})]){
 test('altered actual source/native signature/accepted terms fail closed before a reserve',async()=>{
  const x=setup({context:contextChange});await assert.rejects(()=>x.service.reserve(x.input),e=>e.code==='pending_purchase_source_unverified');
  assert.ok(!x.calls.includes('membership_v2_reserve_pending_purchase'));
 });
}
for(const read of [r=>({...r,purchase:{...r.purchase,environment:'production'}}),r=>({...r,purchase:{...r.purchase,activation_enabled:true}}),
 r=>({...r,purchase:{...r.purchase,source_digest:sha('other')}}),r=>({...r,purchase:{...r.purchase,expires_at:'2099-01-01Z'}})]){
 test('wrong-env/effect/checksum/deadline readback cannot report success or initiate repair',async()=>{
  const x=setup({read});await assert.rejects(()=>x.service.reserve(x.input),e=>e.code==='pending_purchase_readback_unverified');
  assert.equal(x.calls.filter(n=>n==='membership_v2_reserve_pending_purchase').length,1);
 });
}
test('ambiguous commit with no matching record stays503 without reinsert',async()=>{
 const x=setup({unknown:true,missing:true});await assert.rejects(()=>x.service.reserve(x.input),e=>e.status===503);
 assert.equal(x.calls.filter(n=>n==='membership_v2_reserve_pending_purchase').length,1);
});
