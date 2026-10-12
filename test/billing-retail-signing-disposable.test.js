'use strict';
// Real private PostgreSQL parent migrations + new session/accept wrapper. Fake
// private files/renderer only in this suite; actual PDF copying tested separately.
const assert=require('node:assert/strict'),{test}=require('node:test'),crypto=require('node:crypto');
const h=require('./fixtures/retail-signing-pg'),{sha}=require('./fixtures/retail-review-fixture'),{signature}=require('./fixtures/retail-signature');
const {createMembershipRetailSigningService}=require('../src/services/membershipRetailSigning');
const PDF=Buffer.from('%PDF-1.7\nSYNTHETIC SQL FIXTURE ONLY\n%%EOF');
function setup(hooks={}){
  const f=h.setup(),token='T'.repeat(43),files=new Map(),calls=[];
  f.p.preview_pdf_sha256=sha(PDF);f.p.preview_pdf_size=PDF.length;
  f.p.signer_token_hash=sha(`retail-signing-v2\n${f.p.id}\n${f.sourceFingerprint}\n${token}`);f.issue();files.set(f.p.preview_pdf_path,Buffer.from(PDF));
  const db={from(table){return {select(columns){let where;return {eq(k,v){where=`${k}=${h.literal(v)}`;return {async maybeSingle(){
    const text=h.sql(`set role service_role;select row_to_json(t) from (select ${columns} from ${table} where ${where}) t;`);return {data:text?JSON.parse(text):null,error:null};}};}};}};},
    async rpc(name,p){calls.push(name);if(hooks.beforeRPC)await hooks.beforeRPC(name,p);
      const ordered={membership_v2_signing_session:['p_document','p_token_hash'],membership_v2_read_acceptance_attempt:['p_document','p_token_hash','p_attempt'],
        membership_v2_accept_png_document:['p_acceptance','p_pixels_hash','p_width','p_height']}[name];assert.ok(ordered);
      const abort=name==='membership_v2_accept_png_document' && hooks.abortOnce; if(abort)hooks.abortOnce=false;
      const query=`${abort?'begin;':''}set role service_role;select coalesce(json_agg(t),'[]'::json) from ${name}(${ordered.map(k=>h.literal(p[k])).join(',')}) t;${abort?'rollback;':''}`;
      const r=hooks.concurrent && name==='membership_v2_accept_png_document'?await h.asyncSQL(query).done:h.run(query);
      const status=r.status,output=r.out||r.stdout,err=r.err||r.stderr;
      if(status){const match=err.match(/ERROR:\s+([0-9A-Z]{5}):\s+([^\n]+)/);return {error:{code:match?.[1]||'SQLERR',message:match?.[2]||'synthetic SQL failure'}};}
      if(abort)return {error:{code:'NETWORK',message:'synthetic lost aborted response'}};
      if(name==='membership_v2_accept_png_document' && hooks.unknown){if(hooks.unknown==='thrown')throw Error('synthetic lost reply');return {error:{code:'NETWORK',message:'synthetic lost reply'}};}
      const rows=JSON.parse(output);if(hooks.afterRPC)return hooks.afterRPC(name,p,rows);return {data:rows,error:null};
    }};
  const service=createMembershipRetailSigningService({db,artifacts:{async readPrivate(p){return files.get(p);},async putIfAbsent(p,b,o){
    assert.equal(o.upsert,false);assert.ok(!files.has(p));files.set(p,Buffer.from(b));if(hooks.afterUpload)await hooks.afterUpload(p);}},
    renderExecution:async()=>{if(hooks.afterRender)await hooks.afterRender(f);return {pdf_bytes:Buffer.from(PDF)};}});
  return {f,files,calls,service,input:{documentId:f.p.id,token,typedName:'Demo Buyer',consent:true,signatureDataUrl:signature()}};
}
test('native session token/current source/expiry authorization, exact safe preview bytes',h.opts,async()=>{
  const x=setup(),session=await x.service.session({documentId:x.input.documentId,token:x.input.token});assert.equal(session.session.state,'signable');assert.deepEqual(session.pdf_bytes,PDF);
  await assert.rejects(()=>x.service.session({documentId:x.input.documentId,token:'Z'.repeat(43)}),e=>e.code==='retail_signing_denied');
  h.denied(`set role anon;select * from membership_v2_signing_session('${x.f.p.id}','${x.f.p.signer_token_hash}');`,/permission denied/);
});
test('real signer records acceptance AND immutable pixel identity atomically, exact replay has no second write',h.opts,async()=>{
  const x=setup(),first=await x.service.sign(x.input),next=await x.service.sign(x.input);
  assert.equal(next.attempt_id,first.attempt_id);assert.equal(next.historical_readback,true);
  assert.equal(x.calls.filter(n=>n==='membership_v2_accept_png_document').length,1);assert.equal(x.files.size,3);
  assert.equal(h.sql(`select count(*) from membership_v2_signature_pixels where document_id='${x.f.p.id}';`),'1');
  h.denied(`update membership_v2_signature_pixels set width=width where document_id='${x.f.p.id}';`,/immutable/);
  h.denied('truncate membership_v2_signature_pixels cascade;',/immutable/);
});
test('unknown commit returned/thrown gets one exact attempt+pixel readback, no retry or duplicate objects',h.opts,async()=>{
  for(const unknown of ['returned','thrown']){
    const x=setup({unknown}),r=await x.service.sign(x.input);assert.equal(r.state,'accepted');
    assert.equal(x.calls.filter(n=>n==='membership_v2_accept_png_document').length,1);
    assert.equal(x.calls.filter(n=>n==='membership_v2_read_acceptance_attempt').length,1);assert.equal(x.files.size,3);
  }
});
test('authoritative rollback absence503 ends first call; later explicit request can safely use a fresh immutable attempt',h.opts,async()=>{
  const x=setup({abortOnce:true});await assert.rejects(()=>x.service.sign(x.input),e=>e.status===503);
  assert.equal(x.calls.filter(n=>n==='membership_v2_accept_png_document').length,1);assert.equal(x.files.size,3);
  assert.equal(h.sql(`select count(*) from membership_v2_document_acceptances where document_id='${x.f.p.id}';`),'0');
  assert.equal(h.sql(`select count(*) from membership_v2_signature_pixels where document_id='${x.f.p.id}';`),'0');
  const r=await x.service.sign(x.input);assert.equal(r.state,'accepted');assert.equal(x.files.size,5);
  assert.equal(x.calls.filter(n=>n==='membership_v2_accept_png_document').length,2);
  assert.equal(h.sql(`select count(*) from membership_v2_document_acceptances where document_id='${x.f.p.id}';`),'1');
});
test('native session waiting behind acceptance re-reads committed history and pixel proof',h.opts,async()=>{
  const x=setup(),a=h.acceptance(x.f),q=`membership_v2_accept_png_document(${h.literal(a)},'${sha('SYNTHETIC PIXELS')}',300,100)`;
  const writer=h.asyncSQL(`/* SIGNER_HEAD_HELD */begin;set role service_role;select document_id from ${q};select pg_sleep(0.8);commit;`);
  await h.sleeping('SIGNER_HEAD_HELD');const reader=h.asyncSQL(`/* SIGNER_SESSION_WAIT */set role service_role;select row_to_json(t) from
    membership_v2_signing_session('${x.f.p.id}','${x.f.p.signer_token_hash}') t;`);
  await h.blocked('SIGNER_SESSION_WAIT');const [w,r]=await Promise.all([writer.done,reader.done]);
  assert.equal(w.status,0,w.err);assert.equal(r.status,0,r.err);const result=JSON.parse(r.out);
  assert.equal(result.state,'accepted');assert.equal(result.signature_proof.attempt_id,a.attempt_id);assert.equal(result.acceptance.attempt_id,a.attempt_id);
});
test('two real simultaneous signer attempts have one winner, loser409 and no artifact overwrite',h.opts,async()=>{
  let arrivals=0,release;const barrier=new Promise(resolve=>release=resolve);
  const x=setup({concurrent:true,beforeRPC:async n=>{if(n==='membership_v2_accept_png_document'){if(++arrivals===2)release();await barrier;}}});
  const r=await Promise.allSettled([x.service.sign(x.input),x.service.sign(x.input)]);
  assert.equal(r.filter(a=>a.status==='fulfilled').length,1);assert.equal(r.find(a=>a.status==='rejected').reason.code,'retail_signing_conflict');
  const winner=r.find(a=>a.status==='fulfilled').value;assert.equal(h.sql(`select attempt_id from membership_v2_document_acceptances where document_id='${x.f.p.id}';`),winner.attempt_id);
  assert.equal(x.files.size,5);assert.equal(h.sql(`select count(*) from membership_v2_signature_pixels where document_id='${x.f.p.id}';`),'1');
});
test('legal revocation during PDF preparation prevents upload/acceptance',h.opts,async()=>{
  const x=setup({afterRender:f=>h.sql(`set role service_role;insert into membership_v2_legal_revocations(version,reason) values('${f.p.legal_version}','Synthetic test');`)});
  await assert.rejects(()=>x.service.sign(x.input),e=>e.code==='retail_signing_denied');assert.equal(x.files.size,1);
  assert.equal(h.sql(`select count(*) from membership_v2_document_acceptances where document_id='${x.f.p.id}';`),'0');
});
test('source replacement during preparation invalidates old cap and leaves no new signature objects',h.opts,async()=>{
  const x=setup({afterRender:f=>{const next=h.source({},f.sourceId,f.scopeId);h.sql(`set role service_role;${next.register}`);}});
  await assert.rejects(()=>x.service.sign(x.input),e=>e.code==='retail_signing_denied');assert.equal(x.files.size,1);
});
test('offboarded rep does not invalidate issued customer signing; exact accepted history survives revocation',h.opts,async()=>{
  const x=setup();h.sql(`update sales_reps set active=false where user_id='${h.rep}';`);
  try{const r=await x.service.sign(x.input);h.sql(`set role service_role;insert into membership_v2_legal_revocations(version,reason) values('${x.f.p.legal_version}','Synthetic test');`);
    assert.equal((await x.service.sign(x.input)).attempt_id,r.attempt_id);}
  finally{h.sql(`update sales_reps set active=true where user_id='${h.rep}';`);}
});
test('invalid pixel proof rolls back whole native acceptance; no metadata-only success',h.opts,()=>{
  const x=setup(),a=h.acceptance(x.f);
  h.denied(`set role service_role;select * from membership_v2_accept_png_document(${h.literal(a)},'${sha('pixels')}',0,100);`,/check constraint/);
  assert.equal(h.sql(`select count(*) from membership_v2_document_acceptances where document_id='${x.f.p.id}';`),'0');
});
test('old metadata-only acceptance without pixel proof is held, not upgraded by signer',h.opts,async()=>{
  const x=setup();h.accept(h.acceptance(x.f));await assert.rejects(()=>x.service.sign(x.input),e=>e.code==='retail_signing_store_unverified');
  assert.equal(x.files.size,1);assert.equal(h.sql(`select count(*) from membership_v2_signature_pixels where document_id='${x.f.p.id}';`),'0');
});
test('expired native document denies new signature before rendering',h.opts,async()=>{
  const x=setup();h.sql(`alter table membership_v2_issued_documents disable trigger membership_v2_issued_documents_immutable;
    update membership_v2_issued_documents set issued_at=issued_at-interval '2 days',expires_at=membership_v2_signing_deadline(issued_at-interval '2 days') where id='${x.f.p.id}';
    alter table membership_v2_issued_documents enable trigger membership_v2_issued_documents_immutable;`);
  await assert.rejects(()=>x.service.sign(x.input),e=>e.code==='retail_signing_denied');assert.equal(x.files.size,1);
});
test('native signing code has no Auth/client/contract/provider changes and no browser execute grants',h.opts,()=>{
  assert.equal(h.sql('select count(*) from auth.users;'),'2');assert.equal(h.sql('select count(*) from membership_v2_contracts;'),'0');
  assert.equal(h.sql('select count(*) from clients;'),'1');
  for(const fn of ['membership_v2_signing_session(uuid,text)','membership_v2_read_acceptance_attempt(uuid,text,uuid)','membership_v2_accept_png_document(jsonb,text,integer,integer)'])
    for(const role of ['anon','authenticated'])assert.equal(h.sql(`select has_function_privilege('${role}','${fn}','EXECUTE');`),'f');
  assert.equal(h.sql("select relrowsecurity from pg_class where oid='membership_v2_signature_pixels'::regclass;"),'t');
});
