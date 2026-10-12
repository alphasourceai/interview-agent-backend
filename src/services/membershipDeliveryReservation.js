'use strict';
// INTERNAL/unmounted producer. No sender, default keys, environment or route.
const crypto=require('node:crypto');
const {isProxy}=require('node:util').types;
const canonical=v=>v && typeof v==='object'?(Array.isArray(v)?`[${v.map(canonical).join(',')}]`:
  `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`):JSON.stringify(v);
const JOB_FIELDS='id,purpose,source_id,document_id,subject_id,scope_id,issuer_user_id,environment,key_id,nonce,sealed_envelope,queued_at';
function fail(){const e=new Error('membership_delivery_reservation_held');e.code='membership_delivery_reservation_held';e.status=503;throw e;}
function check(v){if(!v)fail();}
function exact(v,keys){if(!v || typeof v!=='object' || Array.isArray(v) || isProxy(v)
  || ![Object.prototype,null].includes(Object.getPrototypeOf(v)))return false;
  const d=Object.getOwnPropertyDescriptors(v);return Reflect.ownKeys(d).length===keys.length
    && Reflect.ownKeys(d).every(k=>typeof k==='string' && keys.includes(k) && d[k].enumerable && Object.hasOwn(d[k],'value'));}
function createMembershipDeliveryReservation({db,delivery}={}){
  check(typeof db?.from==='function' && exact(delivery,['environment','envelope'])
    && ['dev','staging','production'].includes(delivery.environment)
    && typeof delivery.envelope?.seal==='function' && typeof delivery.envelope.keyIdentity==='function'
    && delivery.envelope.environment===delivery.environment);
  const {environment,envelope}=delivery;
  async function one(table,fields,filters){let r;try{let q=db.from(table).select(fields);
    for(const [k,v] of Object.entries(filters))q=v===null?q.is(k,null):q.eq(k,v);r=await q.maybeSingle();}catch(_){fail();}
    check(!r?.error && r?.data);return structuredClone(r.data);}
  async function identity(keyId,remaining){let identity;try{identity=envelope.keyIdentity(keyId);}catch(_){fail();}
    check(exact(identity,['environment','key_id','physical_key_fingerprint']) && identity.environment===environment && identity.key_id===keyId);
    const k=await one('membership_v2_delivery_keys','environment,key_id,physical_key_fingerprint,seal_limit,used_count,retired',
      {environment,key_id:keyId});
    check(k.environment===environment && k.key_id===keyId && k.physical_key_fingerprint===identity.physical_key_fingerprint
      && Number.isInteger(k.seal_limit) && k.seal_limit>=1 && Number.isInteger(k.used_count)
      && k.used_count>=(remaining?0:1) && k.used_count<=k.seal_limit && typeof k.retired==='boolean'
      && (!remaining || (!k.retired && k.used_count<k.seal_limit)));return identity;
  }
  return Object.freeze({environment,
    async prepare(binding,token){let sealed;try{sealed=envelope.seal({binding,token});}catch(_){fail();}
      check(sealed.binding?.environment===environment);const owned=await identity(sealed.key_id,true);
      return Object.freeze({job_id:crypto.randomUUID(),sealed_envelope:sealed,key_identity:owned});},
    validateAck(ack,reservation,expected){check(Array.isArray(ack) && ack.length===1);
      const a=ack[0];check(exact(a,['job_id','source_id','document_id','purpose','environment','queued_at'])
        && a.job_id===reservation.job_id && a.source_id===expected.source_id && a.document_id===expected.document_id
        && a.purpose===reservation.sealed_envelope.binding.purpose && a.environment===environment
        && typeof a.queued_at==='string' && Number.isFinite(Date.parse(a.queued_at)));return a.queued_at;},
    async verify(reservation,expected,ackTime=null){
      const j=await one('membership_v2_delivery_jobs',JOB_FIELDS,{id:reservation.job_id,scope_id:expected.scope_id,issuer_user_id:expected.issuer_user_id});
      const e=reservation.sealed_envelope;check(exact(j,JOB_FIELDS.split(',')) && j.id===reservation.job_id
        && j.purpose===e.binding.purpose && j.source_id===expected.source_id && j.document_id===expected.document_id
        && j.subject_id===(expected.document_id||expected.source_id) && j.scope_id===expected.scope_id
        && j.issuer_user_id===expected.issuer_user_id && j.environment===environment && j.key_id===e.key_id
        && j.nonce===e.nonce && canonical(j.sealed_envelope)===canonical(e)
        && typeof j.queued_at==='string' && Number.isFinite(Date.parse(j.queued_at))
        && (ackTime===null || j.queued_at===ackTime));
      // Immutable persistence only. A postcommit retirement is NOT erased or
      // called delivery eligibility; the worker independently rechecks it.
      const current=await identity(e.key_id,false);check(canonical(current)===canonical(reservation.key_identity));
      return Object.freeze({delivery_job_id:j.id,delivery:'reserved',recipient_delivery_confirmed:false,automatic_retry_allowed:false});
    }
  });
}
module.exports={createMembershipDeliveryReservation};
