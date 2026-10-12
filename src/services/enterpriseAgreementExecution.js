'use strict';
const crypto=require('node:crypto');
const {parseRetailSignature}=require('./retailSignaturePng');
const {retailFontSupports}=require('../render/retailSignerFont');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const canonical=v=>v && typeof v==='object'?(Array.isArray(v)?`[${v.map(canonical).join(',')}]`:
 `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`):JSON.stringify(v);
const uuid=/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function fail(code='enterprise_execution_denied',status=503){const e=new Error('');e.code=code;e.status=status;throw e;}
function check(v,c,s){if(!v)fail(c,s);}
function isMarkedEnterpriseAgreement(a){
 const marker=a?.template_snapshot?.values?.pool_offer_snapshot;
 if(marker===null || marker===undefined)return false;
 check(a.membership_tier==='enterprise' && typeof marker==='object' && !Array.isArray(marker),'enterprise_execution_source_invalid');
 return true;
}
function configuredArtifacts(db){
 return require('../clients/supabase').createEnterpriseAgreementArtifacts(db);
}
function createEnterpriseAgreementExecution({db,loadByTokenHash,renderExecution,artifacts}={}){
 check(typeof db?.from==='function' && typeof db.rpc==='function' && typeof loadByTokenHash==='function' && typeof renderExecution==='function',
  'enterprise_execution_configuration_invalid');
 const store=artifacts||configuredArtifacts(db);
 check(typeof store.putIfAbsent==='function' && typeof store.readPrivate==='function','enterprise_execution_configuration_invalid');
 async function fresh(original,tokenHash){
  let row;try{row=await loadByTokenHash(tokenHash);}catch(_){fail('enterprise_execution_source_unavailable');}
  check(row && row.id===original.id && row.signer_token_hash===tokenHash && row.status==='sent' && !row.signed_at
   && isMarkedEnterpriseAgreement(row) && canonical(row.template_snapshot)===canonical(original.template_snapshot)
   && row.client_id===original.client_id && row.admin_email===original.admin_email
   && Date.parse(row.signer_token_expires_at)>Date.now() && Date.parse(row.agreement_expires_at)>Date.now(),
   'enterprise_execution_source_changed',409);return row;
 }
 async function readFile(path,bytes){let actual;try{actual=await store.readPrivate(path);}catch(_){fail('enterprise_execution_artifact_unverified');}
  check((Buffer.isBuffer(actual)||actual instanceof Uint8Array) && Buffer.from(actual).equals(bytes),'enterprise_execution_artifact_unverified');}
 async function put(path,bytes,mime){try{await store.putIfAbsent(path,Buffer.from(bytes),Object.freeze({contentType:mime,upsert:false}));}
  catch(_){fail('enterprise_execution_artifact_unverified');}await readFile(path,bytes);}
 return Object.freeze({async sign({agreement,tokenHash,typedName,consent,signatureDataUrl,ip=null,userAgent=null}){
  // Capture the full server-loaded source before awaiting/rendering. No browser
  // paths, attempt IDs, hashes, amounts, dates or owner claims are accepted.
  const original=structuredClone(agreement);
  check(original && uuid.test(original.id) && /^[0-9a-f]{64}$/.test(tokenHash) && isMarkedEnterpriseAgreement(original),
   'enterprise_execution_denied',403);
  check(consent===true && typeof typedName==='string','invalid_enterprise_signature',400);
  const name=typedName.normalize('NFC').trim();
  check([...name].length>=1 && [...name].length<=160 && retailFontSupports(name)
   && !/[\p{Cc}\p{Cs}<>\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(name),'invalid_enterprise_signature',400);
  check((ip===null || typeof ip==='string' && ip.length<=128) && (userAgent===null || typeof userAgent==='string' && userAgent.length<=1024),
   'invalid_enterprise_signature',400);
  let signature;try{signature=parseRetailSignature(signatureDataUrl);}catch(_){fail('invalid_enterprise_signature',400);}
  await fresh(original,tokenHash);
  let clock;try{clock=await db.rpc('enterprise_v2_execution_clock',{p_agreement:original.id,p_token_hash:tokenHash});}
  catch(_){fail('enterprise_execution_clock_invalid');}
  const signedAt=clock?.data;
  check(!clock?.error && typeof signedAt==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(signedAt)
   && Number.isFinite(Date.parse(signedAt)),'enterprise_execution_clock_invalid');
  const attempt=crypto.randomUUID(),prefix=`enterprise-v2/${original.id}/attempts/${attempt}/`;
  let output;try{output=await renderExecution(original,{accepted:true,signer_typed_name:name,signature_image_src:signature.dataUrl,signed_at:signedAt});}
  catch(_){fail('enterprise_execution_render_failed');}
  check(Buffer.isBuffer(output)||output instanceof Uint8Array,'enterprise_execution_render_failed');const pdf=Buffer.from(output);
  check(pdf.length>=16 && pdf.length<=12582912 && pdf.subarray(0,5).toString()==='%PDF-' && pdf.subarray(-1024).toString('latin1').includes('%%EOF'),
   'enterprise_execution_render_failed');
  await fresh(original,tokenHash);
  await put(prefix+'signature.png',signature.bytes,'image/png');await put(prefix+'executed.pdf',pdf,'application/pdf');
  await fresh(original,tokenHash);
  const execution={version:'enterprise_execution_v2',attempt_id:attempt,signed_at:signedAt,signer_typed_name:name,signer_accepted:true,
   signature_sha256:signature.sha256,signature_size:signature.bytes.length,signature_image_path:prefix+'signature.png',
   pixels_sha256:signature.pixels_sha256,width:signature.width,height:signature.height,encoding:'png_rgba_v1',
   executed_pdf_path:prefix+'executed.pdf',executed_pdf_sha256:sha(pdf),executed_pdf_size:pdf.length,signer_ip:ip,signer_user_agent:userAgent};
  const {execution:ignored,...source}=original.template_snapshot;
  const payload={agreement_id:original.id,attempt_id:attempt,token_hash:tokenHash,source_snapshot:source,execution};
  let ack;const definite=e=>typeof e?.code==='string' && (/^[0-9A-Z]{5}$/.test(e.code)||e.code.startsWith('PGRST'));
  try{ack=await db.from('enterprise_v2_execution_seals').insert(payload);}
  catch(e){if(definite(e))fail('enterprise_execution_commit_failed');}
  if(ack?.error && definite(ack.error))fail('enterprise_execution_commit_failed');
  // Whether ACK succeeds or is unknown, recover ONLY this exact attempt. No
  // insert retry, alternative path or backfill against an already-signed row.
  let seal,updated;try{
   seal=await db.from('enterprise_v2_execution_seals').select('agreement_id,attempt_id,token_hash,source_snapshot,execution,signed_at,recorded_at')
    .eq('agreement_id',original.id).eq('attempt_id',attempt).eq('token_hash',tokenHash).maybeSingle();
   updated=await loadByTokenHash(tokenHash);
  }catch(_){fail('enterprise_execution_commit_unverified');}
  const s=seal?.data,{signed_at:sealedAt,recorded_at:recordedAt,...identity}=s||{};
  check(!seal?.error && s && canonical(identity)===canonical(payload) && Date.parse(sealedAt)===Date.parse(signedAt)
   && Number.isFinite(Date.parse(recordedAt)) && Date.parse(recordedAt)>=Date.parse(signedAt) && Date.parse(recordedAt)-Date.parse(signedAt)<=300000
   && updated?.id===original.id && updated.status==='signed' && updated.is_current===true && updated.signer_accepted===true
   && Date.parse(updated.signed_at)===Date.parse(signedAt) && updated.signer_typed_name===name
   && updated.signature_image_path===execution.signature_image_path && updated.signature_sha256===execution.signature_sha256
   && updated.executed_pdf_path===execution.executed_pdf_path && updated.signer_ip===ip && updated.signer_user_agent===userAgent
   && canonical(updated.template_snapshot)===canonical({...source,execution}), 'enterprise_execution_commit_unverified');
  await readFile(execution.signature_image_path,signature.bytes);await readFile(execution.executed_pdf_path,pdf);
  return Object.freeze({agreement:structuredClone(updated),executedPdf:Buffer.from(pdf),execution:Object.freeze(execution),
   notify:ack?.status===201 && !ack?.error});
 }});
}
module.exports={createEnterpriseAgreementExecution,isMarkedEnterpriseAgreement};
