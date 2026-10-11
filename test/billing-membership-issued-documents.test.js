'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test'),crypto=require('node:crypto');
const {createMembershipIssuedDocumentService}=require('../src/services/membershipIssuedDocuments');
const {fixture,canonical,sha}=require('./fixtures/retail-review-fixture');
const PDF=Buffer.from('%PDF-1.7\nSYNTHETIC UNIT ONLY\n%%EOF');
function setup(hooks={}){
  const f=fixture(),calls=[],objects=new Map(),rows=new Map();f.sourceReply.email_verified=true;f.sourceReply.verified_at='2026-10-11T12:01:00.000Z';
  const ctx={scope_id:f.sourceReply.source.scope_id,audience:'sales',issuer_user_id:f.sourceReply.source.issuer_user_id,
    original_salesperson_user_id:f.sourceReply.source.issuer_user_id,client_id:null,billing_owner_user_id:null};
  const l={version:'retail-membership-issued-synthetic-v1',template_sha256:sha('SYNTHETIC TEMPLATE'),refund_policy_version:'synthetic-v1',
    refund_policy_reference:'https://example.invalid/policy',refund_policy_sha256:sha('SYNTHETIC POLICY'),
    approval_reference:'SYNTHETIC UNIT ONLY',approved_at:'2026-10-11T11:00:00.000Z'};
  let authCount=0;
  const deps={authorizeScope:async()=>{calls.push('auth');authCount++;if(hooks.authError?.(authCount))throw new Error('secret auth');return ctx;},
    loadSource:async()=>{calls.push('source');return f.sourceReply;},loadQuote:async()=>{calls.push('quote');return f.quoteReply;},
    legalVersion:l.version,loadPublishedLegal:async version=>{calls.push('legal');assert.equal(version,'retail-membership-issued-synthetic-v1');return l;},renderIssuedDocument:async data=>{calls.push('render');
      assert.ok(Object.isFrozen(data));assert.ok(Object.isFrozen(data.snapshot.source.buyer));
      const result={protocol:'retail_issued_artifact_v2',document_id:data.documentId,source_fingerprint:data.snapshot.source_fingerprint,
        quote_digest:data.snapshot.quote_digest,legal_version:data.legal.version,template_sha256:data.legal.template_sha256,
        html:'<html><body>SYNTHETIC unit issued content only</body></html>',pdf_bytes:Buffer.from(PDF)};
      if(hooks.render)hooks.render(result,data);return result;},
    artifacts:{async putIfAbsent(path,bytes,options){calls.push('upload');assert.equal(options.upsert,false);assert.equal(options.contentType,'application/pdf');
      assert.ok(!objects.has(path));objects.set(path,Buffer.from(bytes));if(hooks.upload)hooks.upload(path,bytes,options);},
      async readPrivate(path){calls.push('download');return hooks.readBytes?hooks.readBytes(objects.get(path)):objects.get(path);}},
    db:{from(table){assert.equal(table,'membership_v2_issued_documents');return {select(){const filters={};const q={eq(k,v){filters[k]=v;return q;},async maybeSingle(){calls.push('readback');
      let data=structuredClone(rows.get(filters.id));if(hooks.row)hooks.row(data);
      return {data:data && data.scope_id===filters.scope_id && data.issuer_user_id===filters.issuer_user_id?data:null,error:null};}};return q;}};},
      async rpc(name,{p_document:p}){calls.push('rpc');assert.equal(name,'membership_v2_issue_document');
        const row={...p,source_snapshot:structuredClone(f.sourceReply.source),quote_snapshot:structuredClone(f.quoteReply.quote),legal_snapshot:structuredClone(l),
          issued_at:'2026-10-11T12:02:00.000Z',expires_at:'2026-10-12T06:00:00.000Z'};rows.set(p.id,row);
        if(hooks.rpc)return hooks.rpc(row);return {data:[row],error:null};}}};
  const service=createMembershipIssuedDocumentService(deps);
  return {...f,l,ctx,calls,objects,rows,deps,service,issue:()=>service.issue({accessToken:'synthetic-token',scopeId:ctx.scope_id},{sourceId:f.sourceId})};
}
test('configuration fails closed; no default Auth/renderer/storage/legal or signing route',()=>{
  assert.throws(()=>createMembershipIssuedDocumentService(),e=>e.code==='issued_service_not_configured');
  const f=setup();assert.deepEqual(Object.keys(f.service),['issue']);
});
test('strict issue input accepts source identity only, rejects browser money/buyer/legal/path/token/clock',async()=>{
  for(const extra of ['buyer','money','legalVersion','path','token','issuedAt','documentId']){
    const f=setup();await assert.rejects(()=>f.service.issue({}, {sourceId:f.sourceId,[extra]:'browser claim'}),e=>e.code==='invalid_issued_request');assert.equal(f.calls.length,0);
  }
});
test('verified persistence retains exact bytes, private immutable path/hash, no token/capability in caller result',async()=>{
  const f=setup(),result=await f.issue(),row=f.rows.get(result.document_id);
  assert.equal(f.calls.filter(c=>c==='rpc').length,1);assert.equal(f.calls.filter(c=>c==='upload').length,1);
  assert.equal(f.calls.filter(c=>c==='download').length,1);assert.equal(result.signing_enabled,false);assert.equal(result.checkout_enabled,false);
  assert.equal(result.delivery,'not_configured');assert.equal(result.persistence,'verified');assert.ok(Object.isFrozen(result));
  assert.deepEqual(f.objects.get(row.preview_pdf_path),PDF);assert.equal(row.preview_pdf_path,`retail-v2/${row.id}/preview.pdf`);
  assert.equal(row.preview_pdf_sha256,sha(PDF));assert.equal(row.html_sha256,sha(row.rendered_html));
  assert.match(row.signer_token_hash,/^[0-9a-f]{64}$/);assert.equal(JSON.stringify(result).includes(row.signer_token_hash),false);
});
test('unverified source, stale/expired quote, cross rep/scope and rehashed crossing held before renderer',async()=>{
  for(const mutate of [f=>f.sourceReply.email_verified=false,f=>f.quoteReply.stale=true,f=>f.quoteReply.expired=true,
    f=>{f.sourceReply.source.scope_id=crypto.randomUUID();f.rehash();},
    f=>{f.quoteReply.quote.original_salesperson_user_id=crypto.randomUUID();f.rehash();}]){
    const f=setup();mutate(f);await assert.rejects(f.issue,e=>e.code==='issued_source_unverified');assert.ok(!f.calls.includes('render'));assert.ok(!f.calls.includes('rpc'));
  }
});
test('unpublished legal/draft renderer cannot convert review bundle by flag or rehash',async()=>{
  const f=setup();f.l.version='retail-membership-review-v1';await assert.rejects(f.issue,e=>e.code==='issued_legal_unavailable');
  for(const change of [{protocol:'retail_agreement_review_bundle_v1'},{html:'REVIEW DRAFT - NOT FOR SIGNATURE'},
    {template_sha256:sha('wrong')},{source_fingerprint:sha('wrong')},{extra:'browser field'}]){
    const g=setup({render:r=>Object.assign(r,change)});await assert.rejects(g.issue,e=>e.code==='issued_render_unverified');assert.ok(!g.calls.includes('upload'));
  }
});
test('malformed PDF, missing/changed private object or upload error never enter ledger',async()=>{
  for(const hooks of [{render:r=>r.pdf_bytes=Buffer.from('not a PDF')},{readBytes:()=>Buffer.from('wrong')},
    {readBytes:()=>null},{upload:()=>{throw new Error('secret storage key');}}]){
    const f=setup(hooks);await assert.rejects(f.issue,e=>['issued_pdf_invalid','issued_artifact_unverified'].includes(e.code) && !e.message.includes('secret'));
    assert.ok(!f.calls.includes('rpc'));
  }
});
test('SDK input buffer mutation cannot change the retained bytes or enter unverified hash',async()=>{
  const f=setup({upload:(_p,bytes)=>bytes.fill(0)});const r=await f.issue();assert.equal(r.preview_pdf_sha256,sha(PDF));
});
test('source/legal/Auth changes during rendering or private upload hold commit without retry',async()=>{
  for(const at of ['render','upload']){
    const g=setup({[at]:()=>{g.sourceReply.source.buyer.buyer_first_name='Changed';g.rehash();}});
    await assert.rejects(g.issue,e=>e.code==='issued_source_changed');assert.ok(!g.calls.includes('rpc'));
  }
  const f=setup({authError:n=>n>=2});await assert.rejects(f.issue,e=>e.code==='issued_scope_denied');assert.ok(!f.calls.includes('upload'));
});
test('returned/thrown unknown commit recover exactly one ID; definite errors never fall back or retry',async()=>{
  for(const mode of ['returned','thrown','definite']){
    const f=setup({rpc:()=>{if(mode==='thrown')throw new Error('secret transport');return {error:{code:mode==='definite'?'42501':'NETWORK',message:'secret transport'}};}});
    if(mode==='definite')await assert.rejects(f.issue,e=>e.code==='issued_create_failed' && !e.message.includes('secret'));
    else {const r=await f.issue();assert.equal(r.persistence,'recovered_unknown_commit');assert.equal(r.delivery,'not_configured');}
    assert.equal(f.calls.filter(c=>c==='rpc').length,1);assert.equal(f.calls.filter(c=>c==='upload').length,1);
    assert.equal(f.calls.filter(c=>c==='readback').length,mode==='definite'?0:1);
  }
});
test('exact row readback or final Auth failure holds response despite committed inert record',async()=>{
  for(const hooks of [{row:r=>r.preview_pdf_sha256=sha('wrong')},{row:r=>r.source_snapshot.buyer.buyer_first_name='Wrong'},
    {row:r=>r.legal_snapshot.approval_reference='Wrong'},{authError:n=>n>=4}]){
    const f=setup(hooks);await assert.rejects(f.issue,e=>['issued_readback_unverified','issued_scope_denied'].includes(e.code));
    assert.equal(f.rows.size,1);assert.equal(f.calls.filter(c=>c==='rpc').length,1);
  }
});
