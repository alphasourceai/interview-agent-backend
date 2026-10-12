'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createEnterpriseAgreementExecution,isMarkedEnterpriseAgreement}=require('../src/services/enterpriseAgreementExecution');
const {signature}=require('./fixtures/retail-signature');
const PDF=Buffer.from('%PDF-1.7\nSYNTHETIC TEST ONLY\n%%EOF');
function fixture(hooks={}){
 const files=new Map(),calls=[],id=crypto.randomUUID(),hash='a'.repeat(64);
 let source={id,client_id:crypto.randomUUID(),membership_tier:'enterprise',admin_email:'synthetic@example.invalid',status:'sent',signed_at:null,
  signer_token_hash:hash,signer_token_expires_at:new Date(Date.now()+3600000).toISOString(),agreement_expires_at:new Date(Date.now()+3600000).toISOString(),
  is_current:false,template_snapshot:{values:{pool_offer_snapshot:{protocol:'synthetic'},platform_fee:123},rendered_html:'SYNTHETIC'}};
 let seal=null,reads=0;
 const db={async rpc(name,p){assert.equal(name,'enterprise_v2_execution_clock');assert.equal(p.p_agreement,id);assert.equal(p.p_token_hash,hash);
   calls.push('clock');return hooks.clock||{data:new Date().toISOString(),error:null};},from(table){assert.equal(table,'enterprise_v2_execution_seals');return {
  async insert(p){calls.push('insert');if(hooks.definite)return {error:{code:'42501',message:'secret'}};
   seal=structuredClone(p);seal.recorded_at=new Date().toISOString();seal.signed_at=p.execution.signed_at;
   source={...source,status:'signed',is_current:true,signed_at:p.execution.signed_at,signer_typed_name:p.execution.signer_typed_name,signer_accepted:true,
    signature_image_path:p.execution.signature_image_path,signature_sha256:p.execution.signature_sha256,executed_pdf_path:p.execution.executed_pdf_path,
    signer_ip:p.execution.signer_ip,signer_user_agent:p.execution.signer_user_agent,template_snapshot:{...p.source_snapshot,execution:p.execution}};
   if(hooks.unknown==='throw')throw Error('secret transport');return hooks.unknown?{error:{code:'NETWORK',message:'secret'}}:{data:null,error:null,status:201};
  },select(){return {eq(){return this;},async maybeSingle(){calls.push('seal_read');return {data:hooks.missing?null:hooks.seal?hooks.seal(structuredClone(seal)):seal,error:null};}};}
 };}};
 const service=createEnterpriseAgreementExecution({db,loadByTokenHash:async()=>{calls.push('source_read');reads++;
   if(hooks.source)source=hooks.source(source,reads);return structuredClone(source);},
  renderExecution:async (a,e)=>{calls.push('render');assert.equal(a.template_snapshot.rendered_html,'SYNTHETIC');assert.equal(e.accepted,true);
   assert.match(e.signature_image_src,/^data:image\/png;base64,/);return hooks.pdf||PDF;},
  artifacts:{async putIfAbsent(p,b,o){calls.push('upload');assert.equal(o.upsert,false);assert.equal(files.has(p),false);
    if(hooks.upload)throw Error('secret');files.set(p,Buffer.from(b));},async readPrivate(p){calls.push('download');return hooks.read?hooks.read(p,files):files.get(p);}}});
 return {service,calls,files,input:{agreement:structuredClone(source),tokenHash:hash,typedName:'Synthetic Buyer',consent:true,signatureDataUrl:signature(),ip:'192.0.2.1',userAgent:'SYNTHETIC'},
  getSeal:()=>seal,getSource:()=>source};
}
test('marker does not silently fall back for malformed/nonenterprise sources',()=>{
 assert.equal(isMarkedEnterpriseAgreement({template_snapshot:{values:{}}}),false);
 for(const marker of [false,'bad',[]])assert.throws(()=>isMarkedEnterpriseAgreement({membership_tier:'enterprise',template_snapshot:{values:{pool_offer_snapshot:marker}}}));
 assert.throws(()=>isMarkedEnterpriseAgreement({membership_tier:'pro',template_snapshot:{values:{pool_offer_snapshot:{}}}}));
});
test('mounted execution service uses two nonoverwriting files, one seal insert and verified native readback',async()=>{
 const f=fixture(),result=await f.service.sign(f.input),e=f.getSeal().execution;
 assert.equal(result.agreement.status,'signed');assert.equal(result.agreement.is_current,true);assert.deepEqual(result.executedPdf,PDF);
 assert.equal(result.notify,true);
 assert.equal(f.calls.filter(v=>v==='upload').length,2);assert.equal(f.calls.filter(v=>v==='insert').length,1);
 assert.equal(f.calls.filter(v=>v==='seal_read').length,1);assert.match(e.signature_image_path,/^enterprise-v2\/.*\/attempts\/.*\/signature.png$/);
 assert.equal(e.executed_pdf_sha256,crypto.createHash('sha256').update(PDF).digest('hex'));assert.equal(e.executed_pdf_size,PDF.length);
 assert.equal(e.version,'enterprise_execution_v2');assert.equal(e.encoding,'png_rgba_v1');assert.equal(e.pixels_sha256.length,64);
});
test('signed historical source cannot upload, insert or send again',async()=>{
 const f=fixture();await f.service.sign(f.input);const before=f.calls.length;
 await assert.rejects(()=>f.service.sign({...f.input,agreement:f.getSource()}),e=>e.code==='enterprise_execution_source_changed');
 assert.deepEqual(f.calls.slice(before),['source_read']);
});
for(const change of [{consent:'true'},{consent:false},{typedName:'<script>'},{typedName:'x\u202ey'},
 {typedName:'x'.repeat(161)},{signatureDataUrl:'data:image/png;base64,bad='},{ip:12}]){
 test(`invalid signature/consent ${JSON.stringify(change)} has zero effects`,async()=>{
  const f=fixture();await assert.rejects(()=>f.service.sign({...f.input,...change}),e=>e.code==='invalid_enterprise_signature');assert.equal(f.calls.length,0);
 });
}
for(const n of [1,2,3]){
 test(`token/source revocation at fresh source check ${n} prevents native signing`,async()=>{
  const f=fixture({source:(s,read)=>read===n?{...s,signer_token_hash:'b'.repeat(64)}:s});
  await assert.rejects(()=>f.service.sign(f.input),e=>e.code==='enterprise_execution_source_changed');assert.ok(!f.calls.includes('insert'));
  assert.equal(f.calls.filter(v=>v==='upload').length,n===3?2:0);
 });
}
test('altered actual bytes fail before native commit with no fallback uploads',async()=>{
 const f=fixture({read:()=>Buffer.from('wrong')});await assert.rejects(()=>f.service.sign(f.input),e=>e.code==='enterprise_execution_artifact_unverified');
 assert.equal(f.calls.filter(v=>v==='upload').length,1);assert.ok(!f.calls.includes('insert'));
});
test('bad PDF body and write denial fail closed before any seal',async()=>{
 for(const hooks of [{pdf:Buffer.from('bad')},{upload:true}]){const f=fixture(hooks);await assert.rejects(()=>f.service.sign(f.input));assert.ok(!f.calls.includes('insert'));}
});
test('thrown/returned ambiguous commit reads same attempt once, never repeats insert',async()=>{
 for(const unknown of ['throw','returned']){const f=fixture({unknown}),result=await f.service.sign(f.input);assert.equal(result.agreement.status,'signed');assert.equal(result.notify,false);
  assert.equal(f.calls.filter(v=>v==='insert').length,1);assert.equal(f.calls.filter(v=>v==='seal_read').length,1);}
});
test('known denial has no recovery read; missing/altered winning seal has no success',async()=>{
 const f=fixture({definite:true});await assert.rejects(()=>f.service.sign(f.input),e=>e.code==='enterprise_execution_commit_failed');assert.ok(!f.calls.includes('seal_read'));
 for(const hooks of [{missing:true},{seal:s=>({...s,execution:{...s.execution,executed_pdf_sha256:'b'.repeat(64)}})}]){
  const f=fixture(hooks);await assert.rejects(()=>f.service.sign(f.input),e=>e.code==='enterprise_execution_commit_unverified');assert.equal(f.calls.filter(v=>v==='insert').length,1);
 }
});
test('missing/denied/invalid native clock produces no storage or signing mutation',async()=>{
 for(const clock of [{data:null,error:null},{data:'bad',error:null},{data:new Date().toISOString(),error:{code:'P0001'}},
  {data:'2026-10-12T12:00:00Z',error:null}]){const f=fixture({clock});await assert.rejects(()=>f.service.sign(f.input),e=>e.code==='enterprise_execution_clock_invalid');
  assert.ok(!f.calls.includes('upload'));assert.ok(!f.calls.includes('insert'));}
});
test('native seal signed/recorded clock mismatch or extra fields do not authorize success',async()=>{
 for(const seal of [s=>({...s,signed_at:'2000-01-01T00:00:00.000Z'}),s=>({...s,recorded_at:'2099-01-01T00:00:00.000Z'}),s=>({...s,extra:true})]){
  const f=fixture({seal});await assert.rejects(()=>f.service.sign(f.input),e=>e.code==='enterprise_execution_commit_unverified');
 }
});
