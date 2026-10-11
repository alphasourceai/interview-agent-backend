'use strict';
// LOCAL/unmounted. No default legal publisher, renderer, storage, Auth, sender,
// contract linkage or signing route. REVIEW bundles are never issued artifacts.
const crypto=require('node:crypto');
const UUID=/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const canonical=v=>v && typeof v==='object'?(Array.isArray(v)?`[${v.map(canonical).join(',')}]`:
  `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`):JSON.stringify(v);
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const signerHash=(id,sourceFingerprint,token)=>sha(`retail-signing-v2\n${id}\n${sourceFingerprint}\n${token}`);
function fail(code,status=409){const e=new Error(code);e.code=code;e.status=status;throw e;}
function check(ok,code,status){if(!ok)fail(code,status);}
function plain(v,keys){return v && typeof v==='object' && !Array.isArray(v)
  && [Object.prototype,null].includes(Object.getPrototypeOf(v)) && Object.keys(v).every(k=>keys.includes(k));}
function frozen(v){if(v && typeof v==='object'){Object.values(v).forEach(frozen);Object.freeze(v);}return v;}
const definite=e=>typeof e?.code==='string' && (/^[0-9A-Z]{5}$/.test(e.code)||e.code.startsWith('PGRST'));
const DOCUMENTS='membership_v2_issued_documents';
const FIELDS='id,source_id,source_fingerprint,scope_id,issuer_user_id,legal_version,source_snapshot,quote_snapshot,legal_snapshot,rendered_html,html_sha256,preview_pdf_path,preview_pdf_sha256,preview_pdf_size,signer_token_hash,issued_at,expires_at';
function pdf(value){check(Buffer.isBuffer(value)||value instanceof Uint8Array,'issued_pdf_invalid',503);
  const bytes=Buffer.from(value);check(bytes.length>=16 && bytes.length<=8388608 && bytes.subarray(0,5).toString()==='%PDF-'
    && bytes.subarray(-1024).toString('latin1').includes('%%EOF'),'issued_pdf_invalid',503);return bytes;}
function scope(v){check(plain(v,['scope_id','audience','issuer_user_id','original_salesperson_user_id','client_id','billing_owner_user_id'])
  && Object.keys(v).length===6 && UUID.test(v.scope_id) && UUID.test(v.issuer_user_id) && v.audience==='sales'
  && v.issuer_user_id===v.original_salesperson_user_id && v.client_id===null && v.billing_owner_user_id===null,'issued_scope_denied',403);return v;}
function legal(v){check(plain(v,['version','template_sha256','refund_policy_version','refund_policy_reference','refund_policy_sha256','approval_reference','approved_at'])
  && Object.keys(v).length===7 && /^retail-membership-issued-[A-Za-z0-9._-]{1,100}$/.test(v.version)
  && !/draft|review/i.test(v.version)
  && HASH.test(v.template_sha256) && HASH.test(v.refund_policy_sha256)
  && typeof v.refund_policy_version==='string' && v.refund_policy_version.length>0 && v.refund_policy_version.length<=120
  && typeof v.refund_policy_reference==='string' && /^https:\/\/[^\s<>]+$/.test(v.refund_policy_reference) && v.refund_policy_reference.length<=500
  && typeof v.approval_reference==='string' && v.approval_reference.length>0 && v.approval_reference.length<=200
  && v.approval_reference===v.approval_reference.trim() && typeof v.approved_at==='string' && Number.isFinite(Date.parse(v.approved_at)),
  'issued_legal_unavailable',503);return v;}

function createMembershipIssuedDocumentService({db,authorizeScope,loadSource,loadQuote,legalVersion,loadPublishedLegal,renderIssuedDocument,artifacts}={}){
  check(typeof db?.from==='function' && typeof db.rpc==='function' && [authorizeScope,loadSource,loadQuote,loadPublishedLegal,renderIssuedDocument].every(f=>typeof f==='function')
    && typeof legalVersion==='string' && /^retail-membership-issued-[A-Za-z0-9._-]{1,100}$/.test(legalVersion) && !/draft|review/i.test(legalVersion)
    && typeof artifacts?.putIfAbsent==='function' && typeof artifacts.readPrivate==='function','issued_service_not_configured',503);
  async function auth(subject){try{return structuredClone(scope(await authorizeScope(subject)));}catch(_){fail('issued_scope_denied',403);}}
  async function read(ctx,id){let r;try{r=await db.from(DOCUMENTS).select(FIELDS).eq('id',id).eq('scope_id',ctx.scope_id).eq('issuer_user_id',ctx.issuer_user_id).maybeSingle();}
    catch(_){fail('issued_store_unavailable',503);}check(!r?.error,'issued_store_unavailable',503);return r?.data||null;}
  async function pair(subject,ctx,id){let s,q;try{s=structuredClone(await loadSource(subject,id));q=structuredClone(await loadQuote(subject,s?.source?.quote_id));}
    catch(_){fail('issued_source_denied',403);}
    check(s?.email_verified===true && typeof s.verified_at==='string' && Number.isFinite(Date.parse(s.verified_at))
      && s.signing_enabled===false && s.checkout_enabled===false && s.source?.protocol==='retail_sales_prospect_v2'
      && s.source.acceptance_state==='unsigned' && s.source.source_id===id && s.source.scope_id===ctx.scope_id
      && s.source.issuer_user_id===ctx.issuer_user_id && s.source.original_salesperson_user_id===ctx.issuer_user_id
      && HASH.test(s.source_fingerprint) && s.source_fingerprint===sha(canonical(s.source))
      && q?.expired===false && q.stale===false && q.signing_enabled===false && q.quote?.protocol==='retail_quote_draft_v2'
      && q.quote.acceptance_state==='unsigned' && q.quote.quote_id===s.source.quote_id && q.quote.scope_id===ctx.scope_id
      && q.quote.issuer_user_id===ctx.issuer_user_id && q.quote.original_salesperson_user_id===ctx.issuer_user_id
      && q.quote.client_id===null && q.quote.billing_owner_user_id===null && q.quote.audience==='sales'
      && q.quote.signing_source_bound===false && HASH.test(q.quote_digest) && q.quote_digest===s.source.quote_digest
      && q.quote_digest===sha(canonical(q.quote)),'issued_source_unverified',503);
    return frozen({source:s.source,source_fingerprint:s.source_fingerprint,quote:q.quote,quote_digest:q.quote_digest,
      email_verified:true,verified_at:s.verified_at});
  }
  async function publication(){try{const descriptor=legal(await loadPublishedLegal(legalVersion));check(descriptor.version===legalVersion,'issued_legal_unavailable',503);
    return frozen(structuredClone(descriptor));}catch(_){fail('issued_legal_unavailable',503);}}
  async function upload(path,bytes,contentType){try{
    // Own independent buffers: an SDK/callback cannot mutate the retained body.
    await artifacts.putIfAbsent(path,Buffer.from(bytes),Object.freeze({contentType,upsert:false}));
    const stored=await artifacts.readPrivate(path);
    check((Buffer.isBuffer(stored)||stored instanceof Uint8Array) && Buffer.from(stored).equals(bytes),'issued_artifact_unverified',503);
  }catch(_){fail('issued_artifact_unverified',503);}}
  function validate(row,ctx,pairSnapshot,payload,l){check(plain(row,FIELDS.split(',')) && Object.keys(row).length===FIELDS.split(',').length
    && row.id===payload.id && row.scope_id===ctx.scope_id && row.issuer_user_id===ctx.issuer_user_id
    && row.source_id===pairSnapshot.source.source_id && row.source_fingerprint===pairSnapshot.source_fingerprint
    && canonical(row.source_snapshot)===canonical(pairSnapshot.source) && canonical(row.quote_snapshot)===canonical(pairSnapshot.quote)
    && canonical(row.legal_snapshot)===canonical(l) && row.legal_version===l.version
    && ['rendered_html','html_sha256','preview_pdf_path','preview_pdf_sha256','preview_pdf_size','signer_token_hash'].every(k=>row[k]===payload[k])
    && Number.isFinite(Date.parse(row.issued_at)) && Number.isFinite(Date.parse(row.expires_at)) && Date.parse(row.expires_at)>Date.parse(row.issued_at),
    'issued_readback_unverified',503);return row;}
  return Object.freeze({async issue(subject,input){
    check(plain(input,['sourceId']) && Object.keys(input).length===1 && UUID.test(input.sourceId),'invalid_issued_request',400);
    const ctx=await auth(subject),first=await pair(subject,ctx,input.sourceId),l=await publication();
    const id=crypto.randomUUID(),token=crypto.randomBytes(32).toString('base64url');let rendered;
    try{rendered=await renderIssuedDocument(frozen({documentId:id,snapshot:structuredClone(first),legal:structuredClone(l)}));}
    catch(_){fail('issued_render_failed',503);}
    check(plain(rendered,['protocol','document_id','source_fingerprint','quote_digest','legal_version','template_sha256','html','pdf_bytes'])
      && Object.keys(rendered).length===8 && rendered.protocol==='retail_issued_artifact_v2' && rendered.document_id===id
      && rendered.source_fingerprint===first.source_fingerprint && rendered.quote_digest===first.quote_digest
      && rendered.legal_version===l.version && rendered.template_sha256===l.template_sha256
      && typeof rendered.html==='string' && Buffer.byteLength(rendered.html)>=1 && Buffer.byteLength(rendered.html)<=2097152
      && !/review draft|not for signature|draft_only|retail-agreement-2026-10-11-draft-v1/i.test(rendered.html),'issued_render_unverified',503);
    const html=rendered.html,bytes=pdf(rendered.pdf_bytes),preview=`retail-v2/${id}/preview.pdf`;
    check(canonical(await auth(subject))===canonical(ctx),'issued_scope_denied',403);
    check(canonical(await pair(subject,ctx,input.sourceId))===canonical(first) && canonical(await publication())===canonical(l),'issued_source_changed');
    await upload(preview,bytes,'application/pdf');
    check(canonical(await auth(subject))===canonical(ctx),'issued_scope_denied',403);
    check(canonical(await pair(subject,ctx,input.sourceId))===canonical(first) && canonical(await publication())===canonical(l),'issued_source_changed');
    const payload={id,source_id:input.sourceId,source_fingerprint:first.source_fingerprint,scope_id:ctx.scope_id,issuer_user_id:ctx.issuer_user_id,
      legal_version:l.version,rendered_html:html,html_sha256:sha(html),preview_pdf_path:preview,preview_pdf_sha256:sha(bytes),
      preview_pdf_size:bytes.length,signer_token_hash:signerHash(id,first.source_fingerprint,token)};
    let ack,unknown=false;try{ack=await db.rpc('membership_v2_issue_document',{p_document:payload});}
    catch(e){if(definite(e))fail('issued_create_failed',503);unknown=true;}
    if(ack?.error){if(definite(ack.error))fail('issued_create_failed',503);unknown=true;}
    if(!unknown)check(Array.isArray(ack?.data) && ack.data.length===1 && ack.data[0].id===id,'issued_create_unverified',503);
    check(canonical(await auth(subject))===canonical(ctx),'issued_scope_denied',403);
    const stored=validate(await read(ctx,id),ctx,first,payload,l);
    // Recover only persistence after unknown commit; NEVER resend/retry/return
    // raw capability. Delivery registry/outbox integration is still required.
    check(canonical(await auth(subject))===canonical(ctx),'issued_scope_denied',403);
    return frozen({document_id:stored.id,source_id:stored.source_id,source_fingerprint:stored.source_fingerprint,
      legal_version:stored.legal_version,html_sha256:stored.html_sha256,preview_pdf_sha256:stored.preview_pdf_sha256,
      issued_at:stored.issued_at,expires_at:stored.expires_at,delivery:'not_configured',
      signing_enabled:false,checkout_enabled:false,persistence:unknown?'recovered_unknown_commit':'verified'});
  }});
}
module.exports={createMembershipIssuedDocumentService};
