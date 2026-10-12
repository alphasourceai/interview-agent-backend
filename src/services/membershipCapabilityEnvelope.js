'use strict';
// PURE/internal. No environment lookup, keys, provider, storage, sender or route.
// An envelope is secret-bearing private data, NOT permission to send a link.
const crypto=require('node:crypto');
const PROTOCOL='membership_capability_envelope_v1';
const UUID=/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/,KEY=/^[A-Za-z0-9._-]{1,64}$/;
const COMMON=['purpose','environment','source_fingerprint','buyer_email','token_hash'];
const EMAIL=/^[a-z0-9][a-z0-9.!#$%&'*+/=?^_`{|}~-]*@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
function fail(code='membership_capability_invalid'){const e=new Error(code);e.code=code;e.status=503;throw e;}
function check(ok,code){if(!ok)fail(code);}
function guarded(fn){return (...args)=>{try{return fn(...args);}catch(_){fail();}};}
function record(v,keys){return v && typeof v==='object' && !Array.isArray(v)
  && [Object.prototype,null].includes(Object.getPrototypeOf(v)) && Reflect.ownKeys(v).length===keys.length
  && Reflect.ownKeys(v).every(k=>typeof k==='string' && keys.includes(k)
    && Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));}
const canonical=v=>v && typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
function binding(input,environment){
  const purpose=Object.getOwnPropertyDescriptor(input||{},'purpose')?.value;
  const keys=purpose==='sales_email_link_v1'?[...COMMON,'source_id']:
    purpose==='retail_signer_v2'?[...COMMON,'document_id','legal_version','html_sha256','preview_pdf_sha256']:[];
  check(keys.length && record(input,keys));
  check(input.environment===environment && typeof input.buyer_email==='string' && input.buyer_email.length<=254
    && EMAIL.test(input.buyer_email) && !/\.\.|\.@/.test(input.buyer_email)
    && typeof input.source_fingerprint==='string' && HASH.test(input.source_fingerprint)
    && typeof input.token_hash==='string' && HASH.test(input.token_hash));
  if(purpose==='sales_email_link_v1')check(typeof input.source_id==='string' && UUID.test(input.source_id));
  else check(typeof input.document_id==='string' && UUID.test(input.document_id)
    && typeof input.legal_version==='string' && /^retail-membership-issued-[A-Za-z0-9._-]{1,100}$/.test(input.legal_version)
    && !/draft|review/i.test(input.legal_version)
    && [input.html_sha256,input.preview_pdf_sha256].every(v=>typeof v==='string' && HASH.test(v)));
  return Object.freeze({...input});
}
function decode(value,bytes){check(typeof value==='string' && value.length===Math.ceil(bytes*8/6) && /^[A-Za-z0-9_-]+$/.test(value));
  const b=Buffer.from(value,'base64url');if(b.length!==bytes || b.toString('base64url')!==value){b.fill(0);fail();}return b;}
function verifyToken(token,b){const raw=decode(token,32);raw.fill(0);
  const preimage=b.purpose==='sales_email_link_v1'?`sales-email-link-v1\n${b.source_id}\n${token}`:
    `retail-signing-v2\n${b.document_id}\n${b.source_fingerprint}\n${token}`;
  const actual=crypto.createHash('sha256').update(preimage,'utf8').digest();
  try{check(crypto.timingSafeEqual(actual,Buffer.from(b.token_hash,'hex')));}finally{actual.fill(0);}
}
function aad(keyId,b){return Buffer.from(canonical({protocol:PROTOCOL,key_id:keyId,purpose:b.purpose,binding:b}),'utf8');}
function createMembershipCapabilityEnvelope(config){
  const code='membership_capability_not_configured';
  check(record(config,['environment','activeKeyId','keys']) && ['dev','staging','production'].includes(config.environment)
    && typeof config.activeKeyId==='string' && KEY.test(config.activeKeyId),code);
  const {environment,activeKeyId}=config,owned=new Map();let destroyed=false;
  try{
    const keys=config.keys;
    check(keys && typeof keys==='object' && [Object.prototype,null].includes(Object.getPrototypeOf(keys))
      && Reflect.ownKeys(keys).length>=1 && Reflect.ownKeys(keys).length<=4,code);
    for(const id of Reflect.ownKeys(keys)){
      check(typeof id==='string' && KEY.test(id) && Object.hasOwn(Object.getOwnPropertyDescriptor(keys,id),'value'),code);
      const key=keys[id];check((Buffer.isBuffer(key)||key instanceof Uint8Array) && key.length===32,code);
      check(![...owned.values()].some(k=>crypto.timingSafeEqual(k,key)),code);owned.set(id,Buffer.from(key));
    }
    check(owned.has(activeKeyId),code);
  }catch(_){for(const key of owned.values())key.fill(0);fail(code);}
  function alive(){check(!destroyed);}
  return Object.freeze({
    seal:guarded(function(input){alive();check(record(input,['binding','token']));const b=binding(input.binding,environment);verifyToken(input.token,b);
      const nonce=crypto.randomBytes(12),plain=Buffer.from(input.token,'ascii');
      try{const cipher=crypto.createCipheriv('aes-256-gcm',owned.get(activeKeyId),nonce,{authTagLength:16});
        cipher.setAAD(aad(activeKeyId,b));const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
        return Object.freeze({protocol:PROTOCOL,key_id:activeKeyId,binding:b,nonce:nonce.toString('base64url'),
          ciphertext:ciphertext.toString('base64url'),tag:cipher.getAuthTag().toString('base64url')});
      }catch(_){fail();}finally{plain.fill(0);nonce.fill(0);}
    }),
    open:guarded(function(input){alive();check(record(input,['envelope','binding']));const b=binding(input.binding,environment),e=input.envelope;
      check(record(e,['protocol','key_id','binding','nonce','ciphertext','tag']) && e.protocol===PROTOCOL
        && typeof e.key_id==='string' && KEY.test(e.key_id) && owned.has(e.key_id)
        && canonical(binding(e.binding,environment))===canonical(b));
      const nonce=decode(e.nonce,12),encrypted=decode(e.ciphertext,43),tag=decode(e.tag,16);let partial,tail,plain;
      try{const decipher=crypto.createDecipheriv('aes-256-gcm',owned.get(e.key_id),nonce,{authTagLength:16});
        decipher.setAAD(aad(e.key_id,b));decipher.setAuthTag(tag);partial=decipher.update(encrypted);
        tail=decipher.final();plain=Buffer.concat([partial,tail]);check(plain.length===43);
        // ASCII decoding masks the high bit, which could accept a non-ASCII
        // plaintext as an otherwise valid token. UTF8+canonical alphabet rejects.
        const token=plain.toString('utf8');verifyToken(token,b);return token;
      }catch(_){fail();}finally{for(const bytes of [nonce,encrypted,tag,partial,tail,plain])bytes?.fill(0);}
    }),
    destroy(){if(!destroyed){for(const key of owned.values())key.fill(0);owned.clear();destroyed=true;}}
  });
}
module.exports={createMembershipCapabilityEnvelope(config){try{return createMembershipCapabilityEnvelope(config);}
  catch(_){fail('membership_capability_not_configured');}}};
