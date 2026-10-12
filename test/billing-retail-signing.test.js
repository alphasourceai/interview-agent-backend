'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test'),crypto=require('node:crypto');
const {fixture,canonical,sha}=require('./fixtures/retail-review-fixture'),{signature}=require('./fixtures/retail-signature');
const {createMembershipRetailSigningService}=require('../src/services/membershipRetailSigning');
const PDF=Buffer.from('%PDF-1.7\nSYNTHETIC UNIT ONLY\n%%EOF');
function setup(hooks={}){
  const f=fixture(),id=crypto.randomUUID(),token='A'.repeat(43),files=new Map(),calls=[];
  const doc={id,source_id:f.sourceId,source_fingerprint:f.sourceReply.source_fingerprint,scope_id:f.sourceReply.source.scope_id,
    issuer_user_id:f.sourceReply.source.issuer_user_id,legal_version:'retail-membership-issued-synthetic-v1',source_snapshot:f.sourceReply.source,
    quote_snapshot:f.quoteReply.quote,legal_snapshot:{version:'retail-membership-issued-synthetic-v1'},rendered_html:'<html>SYNTHETIC UNIT</html>',
    html_sha256:sha('<html>SYNTHETIC UNIT</html>'),preview_pdf_path:`retail-v2/${id}/preview.pdf`,preview_pdf_sha256:sha(PDF),preview_pdf_size:PDF.length,
    signer_token_hash:sha(`retail-signing-v2\n${id}\n${f.sourceReply.source_fingerprint}\n${token}`),issued_at:'2026-10-11T12:00:00Z',expires_at:'2026-10-12T06:00:00Z'};
  files.set(doc.preview_pdf_path,Buffer.from(PDF));let accepted=null,proof=null,sessionCount=0;
  const db={from(){return {select(){return {eq(){return {async maybeSingle(){return {data:structuredClone(doc),error:null};}};}};}};},
    async rpc(name,p){calls.push(name);
      if(name==='membership_v2_signing_session'){
        sessionCount++;if(hooks.sessionError?.(sessionCount))return {error:{code:'P0001',message:'retail_signing_denied'}};
        return {data:[{document:structuredClone(doc),acceptance:structuredClone(accepted),signature_proof:structuredClone(proof),
          state:accepted?'accepted':'signable',observed_at:'2026-10-11T12:01:00Z'}],error:null};
      }
      if(name==='membership_v2_accept_png_document'){
        if(hooks.definite)return {error:{code:'42501',message:'secret SQL'}};
        accepted={...p.p_acceptance,scope_id:doc.scope_id,accepted_at:'2026-10-11T12:02:00Z'};
        proof={document_id:id,attempt_id:accepted.attempt_id,encoding:'png_rgba_v1',width:p.p_width,height:p.p_height,pixels_sha256:p.p_pixels_hash,recorded_at:'2026-10-11T12:02:00Z'};
        if(hooks.unknown==='thrown')throw Error('secret network');if(hooks.unknown)return {error:{code:'NETWORK',message:'secret network'}};
        return {data:[structuredClone(accepted)],error:null};
      }
      assert.equal(name,'membership_v2_read_acceptance_attempt');return {data:hooks.missing?[]:[{acceptance:structuredClone(accepted),signature_proof:structuredClone(proof)}],error:null};
    }};
  const service=createMembershipRetailSigningService({db,artifacts:{async readPrivate(p){calls.push('download');return hooks.read?hooks.read(p,files):files.get(p);},
    async putIfAbsent(p,b,o){calls.push('upload');assert.equal(o.upsert,false);assert.ok(!files.has(p));files.set(p,Buffer.from(b));}},
    renderExecution:async input=>{calls.push('render');assert.equal(input.document.rendered_html,doc.rendered_html);assert.equal(input.preparedAt,'2026-10-11T12:01:00Z');return {pdf_bytes:Buffer.from(PDF)};}});
  const input={documentId:id,token,typedName:'Demo Buyer',consent:true,signatureDataUrl:signature()};
  return {service,input,doc,files,calls,getAccepted:()=>accepted};
}
test('strict defaults and closed bodies; no browser identity/money/path/time/attempt or boolean string accepted',async()=>{
  assert.throws(()=>createMembershipRetailSigningService(),e=>e.code==='retail_signing_not_configured');
  for(const change of [{consent:'true'},{attemptId:crypto.randomUUID()},{preparedAt:'now'},{typedName:'署名'},{typedName:'Demo\u202eBuyer'}]){
    const f=setup();await assert.rejects(()=>f.service.sign({...f.input,...change}));assert.equal(f.calls.length,0);
  }
});
test('session verifies downloaded preview bytes and exposes no token/hash/path/HTML',async()=>{
  const f=setup(),result=await f.service.session({documentId:f.input.documentId,token:f.input.token});assert.deepEqual(result.pdf_bytes,PDF);
  for(const key of ['token','signer_token_hash','rendered_html','preview_pdf_path'])assert.ok(!(key in result.session));
  assert.equal(result.session.checkout_enabled,false);assert.equal(result.session.activation_enabled,false);
});
test('valid sign stages two immutable files, one atomic acceptance, exact single readback; historical replay has no writes',async()=>{
  const f=setup(),first=await f.service.sign(f.input);assert.equal(first.state,'accepted');assert.equal(first.checkout_enabled,false);
  assert.equal(f.calls.filter(c=>c==='upload').length,2);assert.equal(f.calls.filter(c=>c==='membership_v2_accept_png_document').length,1);
  assert.equal(f.calls.filter(c=>c==='membership_v2_read_acceptance_attempt').length,1);assert.equal(f.files.size,3);
  const before=f.calls.length,replayed=await f.service.sign(f.input);assert.equal(replayed.attempt_id,first.attempt_id);assert.equal(replayed.historical_readback,true);
  assert.ok(!f.calls.slice(before).includes('upload'));assert.ok(!f.calls.slice(before).includes('render'));
  await assert.rejects(()=>f.service.sign({...f.input,typedName:'Other Name'}),e=>e.code==='retail_signing_conflict');
});
test('wrong token/bad PNG deny before CPU render/upload; revoked before render holds',async()=>{
  for(const change of [{token:'B'.repeat(43)},{signatureDataUrl:'data:image/png;base64,bad='}]){
    const f=setup();await assert.rejects(()=>f.service.sign({...f.input,...change}),e=>e.code==='retail_signing_denied');assert.ok(!f.calls.includes('render'));assert.ok(!f.calls.includes('upload'));
  }
  const f=setup({sessionError:n=>n===2});await assert.rejects(()=>f.service.sign(f.input),e=>e.code==='retail_signing_denied');assert.ok(!f.calls.includes('render'));
});
test('postrender or postupload revocation prevents acceptance and never overwrites objects',async()=>{
  for(const n of [3,4]){const f=setup({sessionError:count=>count===n});await assert.rejects(()=>f.service.sign(f.input),e=>e.code==='retail_signing_denied');
    assert.equal(f.calls.includes('membership_v2_accept_png_document'),false);assert.equal(f.calls.filter(c=>c==='upload').length,n===3?0:2);}
});
test('missing/altered private bytes held before acceptance',async()=>{
  const f=setup({read:()=>Buffer.from('wrong')});await assert.rejects(()=>f.service.sign(f.input),e=>e.code==='retail_signing_artifact_unverified');
  assert.ok(!f.calls.includes('render'));assert.ok(!f.calls.includes('membership_v2_accept_png_document'));
});
test('thrown/returned unknown commit performs one same-attempt readback, no retry; missing result503',async()=>{
  for(const unknown of ['thrown','returned']){const f=setup({unknown});assert.equal((await f.service.sign(f.input)).state,'accepted');
    assert.equal(f.calls.filter(c=>c==='membership_v2_accept_png_document').length,1);assert.equal(f.calls.filter(c=>c==='membership_v2_read_acceptance_attempt').length,1);}
  const f=setup({unknown:'returned',missing:true});await assert.rejects(()=>f.service.sign(f.input),e=>e.status===503 && !e.message.includes('secret'));
});
test('definite SQL failure does not become unknown recovery',async()=>{
  const f=setup({definite:true});await assert.rejects(()=>f.service.sign(f.input),e=>e.code==='retail_signing_commit_failed');
  assert.equal(f.calls.filter(c=>c==='membership_v2_read_acceptance_attempt').length,0);
});
