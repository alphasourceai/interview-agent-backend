'use strict';
// LOCAL/unmounted; capability authorization only. No rep Auth, delivery, client,
// contract, provider, welcome, access or checkout side effect/default SDK.
const crypto=require('node:crypto');
const {parseRetailSignature}=require('./retailSignaturePng');
const {retailFontSupports}=require('../render/retailSignerFont');
const UUID=/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const DKEYS='id,source_id,source_fingerprint,scope_id,issuer_user_id,legal_version,source_snapshot,quote_snapshot,legal_snapshot,rendered_html,html_sha256,preview_pdf_path,preview_pdf_sha256,preview_pdf_size,signer_token_hash,issued_at,expires_at'.split(',');
const AKEYS='document_id,source_id,scope_id,attempt_id,signer_token_hash,source_fingerprint,html_sha256,preview_pdf_sha256,consent,typed_name,signature_path,signature_sha256,signature_size,executed_pdf_path,executed_pdf_sha256,executed_pdf_size,accepted_at'.split(',');
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const canonical=v=>v && typeof v==='object'?(Array.isArray(v)?`[${v.map(canonical).join(',')}]`:
  `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`):JSON.stringify(v);
const tokenHash=(id,fingerprint,token)=>sha(`retail-signing-v2\n${id}\n${fingerprint}\n${token}`);
function fail(code='retail_signing_denied',status=403){const e=new Error(code);e.code=code;e.status=status;throw e;}
function check(ok,code,status){if(!ok)fail(code,status);}
function plain(v,keys){return v && typeof v==='object' && !Array.isArray(v)
  && [Object.prototype,null].includes(Object.getPrototypeOf(v)) && Object.keys(v).every(k=>keys.includes(k));}
function exact(v,keys){return plain(v,keys) && Object.keys(v).length===keys.length;}
function frozen(v){if(v && typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;}
const definite=e=>typeof e?.code==='string' && (/^[0-9A-Z]{5}$/.test(e.code)||e.code.startsWith('PGRST'));
function name(value){check(typeof value==='string','invalid_retail_signature',400);const v=value.normalize('NFC').trim();
  check([...v].length>=1 && [...v].length<=160 && !/[\p{Cc}\p{Cs}<>\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(v)
    && retailFontSupports(v),'invalid_retail_signature',400);return v;}
function validateDocument(d,id){
  check(exact(d,DKEYS) && d.id===id && [d.id,d.source_id,d.scope_id,d.issuer_user_id].every(v=>typeof v==='string' && UUID.test(v))
    && [d.source_fingerprint,d.html_sha256,d.preview_pdf_sha256,d.signer_token_hash].every(v=>typeof v==='string' && HASH.test(v))
    && d.source_snapshot?.source_id===d.source_id && d.source_snapshot.scope_id===d.scope_id && d.source_snapshot.issuer_user_id===d.issuer_user_id
    && sha(canonical(d.source_snapshot))===d.source_fingerprint && d.quote_snapshot?.quote_id===d.source_snapshot.quote_id
    && sha(canonical(d.quote_snapshot))===d.source_snapshot.quote_digest && d.quote_snapshot.scope_id===d.scope_id
    && d.quote_snapshot.original_salesperson_user_id===d.issuer_user_id && d.legal_snapshot?.version===d.legal_version
    && /^retail-membership-issued-[A-Za-z0-9._-]{1,100}$/.test(d.legal_version) && !/draft|review/i.test(d.legal_version)
    && typeof d.rendered_html==='string' && Buffer.byteLength(d.rendered_html)>=1 && Buffer.byteLength(d.rendered_html)<=2097152
    && sha(d.rendered_html)===d.html_sha256 && d.preview_pdf_path===`retail-v2/${id}/preview.pdf`
    && Number.isInteger(d.preview_pdf_size) && d.preview_pdf_size>=16 && d.preview_pdf_size<=8388608
    && Number.isFinite(Date.parse(d.issued_at)) && Number.isFinite(Date.parse(d.expires_at)) && Date.parse(d.expires_at)>Date.parse(d.issued_at),
    'retail_signing_store_unverified',503);
  return d;
}
function validateAcceptance(a,d){check(exact(a,AKEYS) && a.document_id===d.id && a.source_id===d.source_id && a.scope_id===d.scope_id
  && UUID.test(a.attempt_id) && a.signer_token_hash===d.signer_token_hash && a.source_fingerprint===d.source_fingerprint
  && a.html_sha256===d.html_sha256 && a.preview_pdf_sha256===d.preview_pdf_sha256 && a.consent===true && name(a.typed_name)===a.typed_name
  && a.signature_path===`retail-v2/${d.id}/attempts/${a.attempt_id}/signature.png`
  && a.executed_pdf_path===`retail-v2/${d.id}/attempts/${a.attempt_id}/executed.pdf`
  && [a.signature_sha256,a.executed_pdf_sha256].every(v=>typeof v==='string' && HASH.test(v))
  && Number.isInteger(a.signature_size) && a.signature_size>=16 && a.signature_size<=2097152
  && Number.isInteger(a.executed_pdf_size) && a.executed_pdf_size>=16 && a.executed_pdf_size<=12582912
  && Number.isFinite(Date.parse(a.accepted_at)) && Date.parse(a.accepted_at)>=Date.parse(d.issued_at),
  'retail_signing_store_unverified',503);return a;}
function validInput(input,sign=false){const keys=sign?['documentId','token','typedName','consent','signatureDataUrl']:['documentId','token'];
  check(exact(input,keys) && typeof input.documentId==='string' && UUID.test(input.documentId)
    && typeof input.token==='string' && /^[A-Za-z0-9_-]{43}$/.test(input.token),sign?'invalid_retail_signature':'retail_signing_denied',sign?400:403);
  if(sign)check(input.consent===true && typeof input.signatureDataUrl==='string' && input.signatureDataUrl.length<=2097152,'invalid_retail_signature',400);
}
function pdf(bytes,max=12582912){check(Buffer.isBuffer(bytes)||bytes instanceof Uint8Array,'retail_signing_artifact_unverified',503);const b=Buffer.from(bytes);
  check(b.length>=16 && b.length<=max && b.subarray(0,5).toString()==='%PDF-' && b.subarray(-1024).toString('latin1').includes('%%EOF'),
    'retail_signing_artifact_unverified',503);return b;}
function createMembershipRetailSigningService({db,artifacts,renderExecution}={}){
  check(typeof db?.from==='function' && typeof db.rpc==='function' && typeof artifacts?.readPrivate==='function'
    && typeof artifacts.putIfAbsent==='function' && typeof renderExecution==='function','retail_signing_not_configured',503);
  async function rpc(name,params){let r;try{r=await db.rpc(name,params);}catch(_){fail('retail_signing_store_unavailable',503);}
    if(r?.error){if(r.error.code==='P0001' && r.error.message==='retail_signing_denied')fail();fail('retail_signing_store_unavailable',503);}return r?.data;}
  async function load(input){let r;try{r=await db.from('membership_v2_issued_documents').select(DKEYS.join(',')).eq('id',input.documentId).maybeSingle();}
    catch(_){fail('retail_signing_store_unavailable',503);}check(!r?.error,'retail_signing_store_unavailable',503);check(r?.data);
    const d=validateDocument(structuredClone(r.data),input.documentId),hashed=tokenHash(d.id,d.source_fingerprint,input.token);
    check(crypto.timingSafeEqual(Buffer.from(hashed,'hex'),Buffer.from(d.signer_token_hash,'hex')));
    const rows=await rpc('membership_v2_signing_session',{p_document:d.id,p_token_hash:hashed});
    check(Array.isArray(rows) && rows.length===1 && exact(rows[0],['document','acceptance','signature_proof','state','observed_at'])
      && canonical(rows[0].document)===canonical(d) && Number.isFinite(Date.parse(rows[0].observed_at)),
      'retail_signing_store_unverified',503);
    const facts=rows[0];check((facts.state==='signable' && facts.acceptance===null)
      || (facts.state==='accepted' && facts.acceptance!==null),'retail_signing_store_unverified',503);
    if(facts.acceptance){validateAcceptance(facts.acceptance,d);validateProof(facts.signature_proof,facts.acceptance);}
    return frozen({...facts,document:d});
  }
  async function download(path,hash,size,isPdf=true){let value;try{value=await artifacts.readPrivate(path);}catch(_){fail('retail_signing_artifact_unverified',503);}
    check(Buffer.isBuffer(value)||value instanceof Uint8Array,'retail_signing_artifact_unverified',503);
    const bytes=isPdf?pdf(value):Buffer.from(value);check(bytes.length===size && sha(bytes)===hash,'retail_signing_artifact_unverified',503);return bytes;}
  async function upload(path,bytes,type){try{await artifacts.putIfAbsent(path,Buffer.from(bytes),Object.freeze({contentType:type,upsert:false}));}
    catch(_){fail('retail_signing_artifact_unverified',503);}await download(path,sha(bytes),bytes.length,type==='application/pdf');}
  function result(a,replay=false){return frozen({document_id:a.document_id,attempt_id:a.attempt_id,accepted_at:a.accepted_at,
    executed_pdf_sha256:a.executed_pdf_sha256,state:'accepted',historical_readback:replay,checkout_enabled:false,activation_enabled:false});}
  async function verifyWinning(a){await download(a.signature_path,a.signature_sha256,a.signature_size,false);
    await download(a.executed_pdf_path,a.executed_pdf_sha256,a.executed_pdf_size);}
  return Object.freeze({
    async session(input){validInput(input);const f=await load(input),d=f.document;
      const bytes=f.acceptance?await download(f.acceptance.executed_pdf_path,f.acceptance.executed_pdf_sha256,f.acceptance.executed_pdf_size):
        await download(d.preview_pdf_path,d.preview_pdf_sha256,d.preview_pdf_size);
      return Object.freeze({session:frozen({document_id:d.id,company:d.source_snapshot.buyer.company_legal_name,
        offer:structuredClone(d.quote_snapshot.offer),state:f.state,expires_at:d.expires_at,accepted_at:f.acceptance?.accepted_at||null,
        checkout_enabled:false,activation_enabled:false}),pdf_bytes:Buffer.from(bytes)});
    },
    async sign(input){validInput(input,true);const typed=name(input.typedName),first=await load(input),d=first.document;
      let signature;try{signature=parseRetailSignature(input.signatureDataUrl);}catch(_){fail();}
      if(first.acceptance){check(first.acceptance.typed_name===typed && first.signature_proof.pixels_sha256===signature.pixels_sha256,
        'retail_signing_conflict',409);await verifyWinning(first.acceptance);return result(first.acceptance,true);}
      const preview=await download(d.preview_pdf_path,d.preview_pdf_sha256,d.preview_pdf_size),attempt=crypto.randomUUID();let execution;
      check((await load(input)).state==='signable','retail_signing_conflict',409);
      try{execution=await renderExecution({document:structuredClone(d),previewBytes:Buffer.from(preview),
        signature:{...signature,bytes:Buffer.from(signature.bytes)},name:typed,attemptId:attempt,preparedAt:first.observed_at});}
      catch(_){fail('retail_signing_render_failed',503);}
      const executed=pdf(execution?.pdf_bytes);
      for(const stage of ['before_upload','after_upload']){
        const fresh=await load(input);check(fresh.state==='signable' && canonical(fresh.document)===canonical(d),'retail_signing_conflict',409);
        if(stage==='before_upload'){
          await upload(`retail-v2/${d.id}/attempts/${attempt}/signature.png`,signature.bytes,'image/png');
          await upload(`retail-v2/${d.id}/attempts/${attempt}/executed.pdf`,executed,'application/pdf');
        }
      }
      const payload={document_id:d.id,source_id:d.source_id,attempt_id:attempt,signer_token_hash:d.signer_token_hash,
        source_fingerprint:d.source_fingerprint,html_sha256:d.html_sha256,preview_pdf_sha256:d.preview_pdf_sha256,
        consent:true,typed_name:typed,signature_path:`retail-v2/${d.id}/attempts/${attempt}/signature.png`,signature_sha256:signature.sha256,
        signature_size:signature.bytes.length,executed_pdf_path:`retail-v2/${d.id}/attempts/${attempt}/executed.pdf`,
        executed_pdf_sha256:sha(executed),executed_pdf_size:executed.length};
      let ack,unknown=false;try{ack=await db.rpc('membership_v2_accept_png_document',{p_acceptance:payload,
        p_pixels_hash:signature.pixels_sha256,p_width:signature.width,p_height:signature.height});}
      catch(e){if(definite(e))fail('retail_signing_commit_failed',503);unknown=true;}
      if(ack?.error){if(ack.error.code==='P0001' && ack.error.message==='document_acceptance_conflict')fail('retail_signing_conflict',409);
        if(ack.error.code==='P0001' && ack.error.message==='document_acceptance_denied')fail();
        if(definite(ack.error))fail('retail_signing_commit_failed',503);unknown=true;}
      if(!unknown)check(Array.isArray(ack?.data) && ack.data.length===1 && ack.data[0].attempt_id===attempt,'retail_signing_commit_unverified',503);
      const rows=await rpc('membership_v2_read_acceptance_attempt',{p_document:d.id,p_token_hash:d.signer_token_hash,p_attempt:attempt});
      check(Array.isArray(rows) && rows.length===1 && exact(rows[0],['acceptance','signature_proof']),'retail_signing_commit_unverified',503);
      const a=validateAcceptance(rows[0].acceptance,d);validateProof(rows[0].signature_proof,a);
      const {accepted_at,scope_id,...evidence}=a;check(canonical(evidence)===canonical(payload),'retail_signing_commit_unverified',503);
      check(rows[0].signature_proof.pixels_sha256===signature.pixels_sha256 && rows[0].signature_proof.width===signature.width
        && rows[0].signature_proof.height===signature.height,'retail_signing_commit_unverified',503);
      await verifyWinning(a);return result(a);
    }
  });
}
function validateProof(p,a){check(exact(p,['document_id','attempt_id','encoding','width','height','pixels_sha256','recorded_at'])
  && p.document_id===a.document_id && p.attempt_id===a.attempt_id && p.encoding==='png_rgba_v1'
  && Number.isInteger(p.width) && p.width>=1 && p.width<=2048 && Number.isInteger(p.height) && p.height>=1 && p.height<=1024
  && p.width*p.height<=1048576 && HASH.test(p.pixels_sha256) && Number.isFinite(Date.parse(p.recorded_at))
  && Date.parse(p.recorded_at)>=Date.parse(a.accepted_at),'retail_signing_store_unverified',503);}
module.exports={createMembershipRetailSigningService};
