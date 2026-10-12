'use strict';
// UNMOUNTED pending linkage only. Contact/signature capability is NOT Auth
// ownership. No SDK default, payment, account/client/access or mail effects.
const crypto=require('node:crypto'),{isProxy}=require('node:util').types;
const UUID=/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const canonical=v=>v && typeof v==='object'?(Array.isArray(v)?`[${v.map(canonical).join(',')}]`:
 `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`):JSON.stringify(v);
function fail(code='pending_purchase_unverified',status=503){const e=new Error('');e.code=code;e.status=status;throw e;}
function check(ok,c,s){if(!ok)fail(c,s);}
function exact(o,keys){return o && typeof o==='object' && !isProxy(o) && [Object.prototype,null].includes(Object.getPrototypeOf(o))
 && Reflect.ownKeys(o).length===keys.length && Object.entries(Object.getOwnPropertyDescriptors(o)).every(([k,d])=>keys.includes(k) && d.enumerable && Object.hasOwn(d,'value'));}
const definite=e=>typeof e?.code==='string' && (/^[0-9A-Z]{5}$/.test(e.code)||e.code.startsWith('PGRST'));
function createMembershipPendingPurchase({db,signing,environment}={}){
 check(typeof db?.from==='function' && typeof db.rpc==='function' && typeof signing?.session==='function'
  && ['dev','qa','production'].includes(environment),'pending_purchase_not_configured');
 async function session(input){let r;try{r=await signing.session(input);}catch(_){fail('pending_purchase_capability_denied',403);}
  check(r?.session?.document_id===input.documentId && r.session.state==='accepted'
   && r.session.checkout_enabled===false && r.session.activation_enabled===false
   && Number.isFinite(Date.parse(r.session.accepted_at)) && (Buffer.isBuffer(r.pdf_bytes)||r.pdf_bytes instanceof Uint8Array),
   'pending_purchase_acceptance_required',409);
  const bytes=Buffer.from(r.pdf_bytes);check(bytes.length>=16 && bytes.length<=12582912 && bytes.subarray(0,5).toString()==='%PDF-'
   && bytes.subarray(-1024).toString('latin1').includes('%%EOF'),'pending_purchase_artifact_unverified');
  return {accepted_at:r.session.accepted_at,pdf_sha256:sha(bytes),pdf_size:bytes.length,offer:structuredClone(r.session.offer)};
 }
 async function rpc(name,p){let r;try{r=await db.rpc(name,p);}catch(_){fail('pending_purchase_store_unavailable');}
  check(!r?.error,'pending_purchase_store_unavailable');return r?.data;}
 function context(c,document,proof){const s=c?.snapshot,a=s?.acceptance,d=s?.document,p=s?.signature_proof,q=s?.quote,b=s?.source;
  check(exact(c,['snapshot','digest','observed_at']) && HASH.test(c.digest||'') && Number.isFinite(Date.parse(c.observed_at))
   && s?.protocol==='retail_pending_purchase_v2' && s.schema_version===2 && d && a && p && q && b && d.id===document.id
   && d.source_fingerprint===document.source_fingerprint && UUID.test(d.source_id||'') && UUID.test(d.scope_id||'') && UUID.test(d.issuer_user_id||'')
   && a.document_id===d.id && a.source_id===d.source_id && a.scope_id===d.scope_id && a.signer_token_hash===document.signer_token_hash
   && a.source_fingerprint===d.source_fingerprint && a.html_sha256===d.html_sha256 && a.preview_pdf_sha256===d.preview_pdf_sha256
   && a.consent===true && UUID.test(a.attempt_id||'') && p.document_id===d.id && p.attempt_id===a.attempt_id && p.encoding==='png_rgba_v1'
   && HASH.test(p.pixels_sha256||'') && Number.isInteger(p.width) && p.width>=1 && p.width<=2048 && Number.isInteger(p.height) && p.height>=1
   && p.height<=1024 && p.width*p.height<=1048576 && Date.parse(a.accepted_at)===Date.parse(proof.accepted_at)
   && a.executed_pdf_sha256===proof.pdf_sha256 && a.executed_pdf_size===proof.pdf_size
   && a.signature_path===`retail-v2/${d.id}/attempts/${a.attempt_id}/signature.png`
   && a.executed_pdf_path===`retail-v2/${d.id}/attempts/${a.attempt_id}/executed.pdf`
   && b.source_id===d.source_id && b.scope_id===d.scope_id && b.original_salesperson_user_id===d.issuer_user_id
   && b.issuer_user_id===d.issuer_user_id && b.quote_id===q.quote_id && b.quote_digest===sha(canonical(q))
   && q.scope_id===d.scope_id && q.original_salesperson_user_id===d.issuer_user_id && q.issuer_user_id===d.issuer_user_id
   && q.client_id===null && q.billing_owner_user_id===null && canonical(q.offer)===canonical(proof.offer),
   'pending_purchase_source_unverified');return c;
 }
 function purchase(reply,c,document,ack){const p=reply?.purchase;
  check(exact(reply,['purchase','context','historical_identity_only']) && reply.historical_identity_only===true
   && p && UUID.test(p.id||'') && (!ack || ack.purchase_id===p.id)
   && p.document_id===document.id && p.source_id===c.snapshot.document.source_id && p.scope_id===c.snapshot.document.scope_id
   && p.original_salesperson_user_id===c.snapshot.document.issuer_user_id && p.acceptance_attempt_id===c.snapshot.acceptance.attempt_id
   && p.environment===environment && p.source_digest===c.digest && canonical(p.source_snapshot)===canonical(c.snapshot)
   && p.state==='awaiting_payment_and_account' && p.provider_effects_enabled===false && p.account_ownership_verified===false && p.activation_enabled===false
   && Number.isFinite(Date.parse(p.created_at)) && Date.parse(p.created_at)>=Date.parse(c.snapshot.acceptance.accepted_at)
   && Date.parse(p.created_at)<=Date.parse(reply.context?.observed_at) && Date.parse(p.expires_at)===Date.parse(c.snapshot.document.expires_at)
   && Date.parse(p.expires_at)>Date.parse(p.created_at),'pending_purchase_readback_unverified');return p;
 }
 return Object.freeze({async reserve(input){
  check(exact(input,['documentId','token']) && typeof input.documentId==='string' && UUID.test(input.documentId)
   && typeof input.token==='string' && /^[A-Za-z0-9_-]{43}$/.test(input.token),'invalid_pending_purchase',400);
  const proof=await session(input);let loaded;
  try{loaded=await db.from('membership_v2_issued_documents').select('id,source_fingerprint,signer_token_hash').eq('id',input.documentId).maybeSingle();}
  catch(_){fail('pending_purchase_store_unavailable');}
  const d=loaded?.data;
  check(!loaded?.error && exact(d,['id','source_fingerprint','signer_token_hash']) && d.id===input.documentId
   && HASH.test(d.source_fingerprint||'') && HASH.test(d.signer_token_hash||''),'pending_purchase_source_unverified');
  const tokenHash=sha(`retail-signing-v2\n${d.id}\n${d.source_fingerprint}\n${input.token}`);
  check(crypto.timingSafeEqual(Buffer.from(tokenHash,'hex'),Buffer.from(d.signer_token_hash,'hex')),'pending_purchase_capability_denied',403);
  const params={p_document:d.id,p_token_hash:tokenHash,p_environment:environment};
  const first=context(await rpc('membership_v2_pending_source',{p_document:d.id,p_token_hash:tokenHash,p_current:false}),d,proof);
  const fresh=await session(input);check(canonical(fresh)===canonical(proof),'pending_purchase_source_changed',409);
  const proposal=crypto.randomUUID();let ack,unknown=false;
  try{ack=await db.rpc('membership_v2_reserve_pending_purchase',{p_id:proposal,...params});}
  catch(e){if(definite(e) && e.code!=='23505')fail('pending_purchase_commit_failed');unknown=true;}
  if(ack?.error){if(definite(ack.error) && ack.error.code!=='23505')fail('pending_purchase_commit_failed');unknown=true;}
  const a=ack?.data;
  if(!unknown)check(exact(a,['action','purchase_id']) && ['reserved','already_reserved'].includes(a.action) && UUID.test(a.purchase_id||'')
   && (a.action!=='reserved'||a.purchase_id===proposal),'pending_purchase_commit_unverified');
  const read=await rpc('membership_v2_read_pending_purchase',params);
  const c=context(read?.context,d,proof);check(c.digest===first.digest && canonical(c.snapshot)===canonical(first.snapshot),'pending_purchase_source_changed',409);
  const p=purchase(read,c,d,unknown?null:a);
  return Object.freeze({purchase_id:p.id,document_id:p.document_id,environment:p.environment,created_at:p.created_at,expires_at:p.expires_at,
   disposition:!unknown && a.action==='reserved'?'recorded_pending_linkage':'historical_inert',
   persistence:unknown?'recovered_unknown_commit':'verified',historical_identity_only:true,
   provider_effects_enabled:false,account_ownership_verified:false,activation_enabled:false});
 }});
}
module.exports={createMembershipPendingPurchase};
