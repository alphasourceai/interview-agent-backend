'use strict';
// INTERNAL/unmounted. No sender/SDK/credential/environment fallback or logging.
const crypto=require('node:crypto');
const {validMembershipBuyerEmail,validIssuedMembershipVersion}=require('./membershipCapabilityPredicates');
const UUID=/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,HASH=/^[0-9a-f]{64}$/;
const HOSTS={dev:'interview-agent-frontend-qa.onrender.com',staging:'alphasourceai-com.onrender.com',production:'www.alphasourceai.com'};
const canonical=v=>v && typeof v==='object'?(Array.isArray(v)?`[${v.map(canonical).join(',')}]`:
  `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`):JSON.stringify(v);
function fail(code='membership_delivery_held'){const e=new Error(code);e.code=code;throw e;}
function check(v,code){if(!v)fail(code);}
function exact(v,keys){return v && typeof v==='object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v))
  && Object.keys(v).length===keys.length && Object.keys(v).every(k=>keys.includes(k));}
function copy(v){return structuredClone(v);}
function createMembershipDeliveryWorker({db,environment,origin,allowRecipients,envelope,send}={}){
  check(typeof db?.from==='function' && typeof db.rpc==='function' && Object.hasOwn(HOSTS,environment)
    && typeof envelope?.open==='function' && typeof envelope.keyIdentity==='function' && typeof send==='function'
    && Array.isArray(allowRecipients) && allowRecipients.length>=1 && allowRecipients.length<=100
    && allowRecipients.every(validMembershipBuyerEmail),'membership_delivery_not_configured');
  let url;try{url=new URL(origin);}catch(_){fail('membership_delivery_not_configured');}
  check(url.protocol==='https:' && url.hostname===HOSTS[environment] && !url.username && !url.password && !url.port
    && url.pathname==='/' && !url.search && !url.hash,'membership_delivery_not_configured');
  const pinnedOrigin=url.origin,recipients=new Set(allowRecipients);
  async function one(table,fields,id){let r;try{r=await db.from(table).select(fields).eq('id',id).maybeSingle();}catch(_){fail();}
    check(!r?.error && r?.data);return copy(r.data);}
  async function rpc(name,p){let r;try{r=await db.rpc(name,p);}catch(_){fail();}check(!r?.error);return copy(r.data);}
  async function loadJob(id){
    const j=await one('membership_v2_delivery_jobs','*',id);
    check(exact(j,['id','purpose','source_id','document_id','subject_id','scope_id','issuer_user_id','environment','key_id','nonce','sealed_envelope','queued_at'])
      && j.id===id && [j.id,j.source_id,j.scope_id,j.issuer_user_id].every(v=>typeof v==='string' && UUID.test(v))
      && j.environment===environment && Number.isFinite(Date.parse(j.queued_at))
      && ((j.purpose==='sales_email_link_v1' && j.document_id===null && j.subject_id===j.source_id)
        || (j.purpose==='retail_signer_v2' && typeof j.document_id==='string' && UUID.test(j.document_id) && j.subject_id===j.document_id)));
    const s=await one('membership_v2_sales_prospects','id,scope_id,issuer_user_id,source_fingerprint,buyer_snapshot',j.source_id);
    check(s.id===j.source_id && s.scope_id===j.scope_id && s.issuer_user_id===j.issuer_user_id && HASH.test(s.source_fingerprint)
      && validMembershipBuyerEmail(s.buyer_snapshot?.buyer_email));
    let binding={purpose:j.purpose,environment,source_fingerprint:s.source_fingerprint,buyer_email:s.buyer_snapshot.buyer_email};
    if(j.document_id){
      const d=await one('membership_v2_issued_documents','id,source_id,scope_id,issuer_user_id,source_fingerprint,source_snapshot,legal_version,html_sha256,preview_pdf_sha256,signer_token_hash',j.document_id);
      check(d.id===j.document_id && d.source_id===s.id && d.scope_id===s.scope_id && d.issuer_user_id===s.issuer_user_id
        && d.source_fingerprint===s.source_fingerprint && d.source_snapshot?.buyer?.buyer_email===binding.buyer_email
        && crypto.createHash('sha256').update(canonical(d.source_snapshot)).digest('hex')===d.source_fingerprint
        && validIssuedMembershipVersion(d.legal_version) && [d.html_sha256,d.preview_pdf_sha256,d.signer_token_hash].every(v=>typeof v==='string' && HASH.test(v)));
      binding={...binding,document_id:d.id,legal_version:d.legal_version,html_sha256:d.html_sha256,preview_pdf_sha256:d.preview_pdf_sha256,token_hash:d.signer_token_hash};
    }else{
      let r;try{r=await db.from('membership_v2_sales_email_challenges').select('source_id,source_fingerprint,token_hash').eq('source_id',s.id).maybeSingle();}catch(_){fail();}
      const c=r?.data;check(!r?.error && c?.source_id===s.id && c.source_fingerprint===s.source_fingerprint && typeof c.token_hash==='string' && HASH.test(c.token_hash));
      binding={...binding,source_id:s.id,token_hash:c.token_hash};
    }
    let kr;try{kr=await db.from('membership_v2_delivery_keys').select('*').eq('environment',environment).eq('key_id',j.key_id).maybeSingle();}catch(_){fail();}
    check(!kr?.error && kr?.data);const k=copy(kr.data),identity=envelope.keyIdentity(j.key_id);
    check(k.environment===environment && k.key_id===j.key_id && k.physical_key_fingerprint===identity.physical_key_fingerprint
      && identity.environment===environment && identity.key_id===j.key_id && k.retired===false
      && Number.isInteger(k.used_count) && k.used_count>=1 && k.used_count<=k.seal_limit
      && j.sealed_envelope?.key_id===j.key_id && j.sealed_envelope.nonce===j.nonce
      && canonical(j.sealed_envelope.binding)===canonical(binding) && recipients.has(binding.buyer_email));
    const token=envelope.open({envelope:j.sealed_envelope,binding});return {job:j,binding,token,identity};
  }
  const safe=(state)=>Object.freeze({state,provider_acknowledged:state==='accepted_by_provider',recipient_delivery_confirmed:false,
    automatic_retry_allowed:false,checkout_enabled:false,activation_enabled:false});
  async function readAttempt(job,id,identity,mustLive=true){const rows=await rpc('membership_v2_read_delivery_attempt',{p_job:job.id,p_attempt:id});
    check(Array.isArray(rows) && rows.length===1 && exact(rows[0],['job','attempt','result','key_identity']));const r=rows[0];
    check(canonical(r.job)===canonical(job) && exact(r.attempt,['job_id','attempt_id','disposition','claimed_at'])
      && r.attempt.job_id===job.id && r.attempt.attempt_id===id && ['send','skip_obsolete'].includes(r.attempt.disposition)
      && Number.isFinite(Date.parse(r.attempt.claimed_at)) && Date.parse(r.attempt.claimed_at)>=Date.parse(job.queued_at));
    check(r.key_identity?.key_id===job.key_id && r.key_identity.environment===environment
      && r.key_identity.physical_key_fingerprint===identity.physical_key_fingerprint && typeof r.key_identity.retired==='boolean'
      && (!mustLive || r.key_identity.retired===false));
    return r;
  }
  return Object.freeze({async process(input){
    check(exact(input,['jobId']) && typeof input.jobId==='string' && UUID.test(input.jobId));const first=await loadJob(input.jobId),j=first.job,id=crypto.randomUUID();
    let ack,unknown=false;try{ack=await db.rpc('membership_v2_claim_delivery',{p_job:j.id,p_attempt:id});}catch(_){unknown=true;}
    if(ack?.error){if(/^[0-9A-Z]{5}$/.test(ack.error.code||''))fail();unknown=true;}
    if(!unknown){check(Array.isArray(ack?.data));if(ack.data.length===0)return safe('already_attempted');
      check(ack.data.length===1 && ack.data[0].job_id===j.id && ack.data[0].attempt_id===id);}
    // One authoritative exact attempt read even if mutation ACK was lost.
    const read=await readAttempt(j,id,first.identity);check(read.result===null);
    if(read.attempt.disposition==='skip_obsolete')return safe('skipped_obsolete');
    let current;
    try{
      current=await loadJob(j.id);check(canonical(current.job)===canonical(j) && canonical(current.binding)===canonical(first.binding));
      check(await rpc('membership_v2_before_delivery_send',{p_job:j.id,p_attempt:id})===true);
    }catch(_){return safe('held_unknown');} // No callback and NO invented send result.
    let outcome='held_unknown',reference=null;
    try{
      // Current recipient, actual owned-key identity and decrypted hash checked.
      const path=j.document_id?`/membership-v2/sign/${j.document_id}`:`/membership-v2/verify/${j.source_id}`;
      const link=`${pinnedOrigin}${path}#token=${current.token}`;
      const provider=await send(Object.freeze({recipient:current.binding.buyer_email,purpose:j.purpose,sourceId:j.source_id,
        documentId:j.document_id,link,idempotencyKey:`membership-v2-delivery:${j.id}:${id}`}));
      if(exact(provider,['status','reference']) && provider.status==='accepted' && typeof provider.reference==='string'
        && /^[A-Za-z0-9._:-]{1,200}$/.test(provider.reference)){outcome='accepted_by_provider';reference=provider.reference;}
      else if(exact(provider,['status']) && provider.status==='rejected')outcome='rejected';
    }catch(_){/* Ambiguous/invalidated call held; NEVER retry sender. */}
    let resultAck;try{resultAck=await db.rpc('membership_v2_record_delivery_result',{p_job:j.id,p_attempt:id,p_outcome:outcome,p_reference:reference});}catch(_){/* Read once below, never resend. */}
    if(resultAck?.error && /^[0-9A-Z]{5}$/.test(resultAck.error.code||''))return safe('held_unknown');
    try{const r=await readAttempt(j,id,first.identity,false);check(exact(r.result,['job_id','attempt_id','outcome','provider_reference','recorded_at'])
      && r.result.job_id===j.id && r.result.attempt_id===id && r.result.outcome===outcome && r.result.provider_reference===reference
      && Number.isFinite(Date.parse(r.result.recorded_at)) && Date.parse(r.result.recorded_at)>=Date.parse(r.attempt.claimed_at));
      return safe(outcome);
    }catch(_){return safe('held_unknown');}
  }});
}
module.exports={createMembershipDeliveryWorker};
