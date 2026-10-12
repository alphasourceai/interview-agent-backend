'use strict';
// PURE/internal. No environment lookup, keys, provider, storage, sender or route.
// An envelope is secret-bearing private data, NOT permission to send a link.
const crypto=require('node:crypto');
const {isProxy}=require('node:util').types;
const {validMembershipBuyerEmail,validIssuedMembershipVersion}=require('./membershipCapabilityPredicates');
const PROTOCOL='membership_capability_envelope_v1';
const UUID=/^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/,KEY=/^[A-Za-z0-9._-]{1,64}$/;
const COMMON=['purpose','environment','source_fingerprint','buyer_email','token_hash'];
function fail(code='membership_capability_invalid'){const e=new Error(code);e.code=code;throw e;}
function check(ok,code){if(!ok)fail(code);}
function guarded(fn){return (...args)=>{try{return fn(...args);}catch(_){fail();}};}
function descriptors(v){check(v && typeof v==='object' && !Array.isArray(v) && !isProxy(v)
  && [Object.prototype,null].includes(Object.getPrototypeOf(v)));return Object.getOwnPropertyDescriptors(v);}
function snapshot(v,keys,d=descriptors(v)){check(Reflect.ownKeys(d).length===keys.length
  && Reflect.ownKeys(d).every(k=>typeof k==='string' && keys.includes(k) && d[k].enumerable===true && Object.hasOwn(d[k],'value')));
  return Object.fromEntries(keys.map(k=>[k,d[k].value]));}
const canonical=v=>v && typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
function binding(input,environment){
  const d=descriptors(input),purpose=d.purpose?.value;
  const keys=purpose==='sales_email_link_v1'?[...COMMON,'source_id']:
    purpose==='retail_signer_v2'?[...COMMON,'document_id','legal_version','html_sha256','preview_pdf_sha256']:[];
  check(keys.length);input=snapshot(input,keys,d);
  check(input.environment===environment && validMembershipBuyerEmail(input.buyer_email)
    && typeof input.source_fingerprint==='string' && HASH.test(input.source_fingerprint)
    && typeof input.token_hash==='string' && HASH.test(input.token_hash));
  if(purpose==='sales_email_link_v1')check(typeof input.source_id==='string' && UUID.test(input.source_id));
  else check(typeof input.document_id==='string' && UUID.test(input.document_id)
    && validIssuedMembershipVersion(input.legal_version)
    && [input.html_sha256,input.preview_pdf_sha256].every(v=>typeof v==='string' && HASH.test(v)));
  return Object.freeze({...input});
}
function decode(value,bytes){check(typeof value==='string' && value.length===Math.ceil(bytes*8/6) && /^[A-Za-z0-9_-]+$/.test(value));
  const b=Buffer.from(value,'base64url');if(b.length!==bytes || b.toString('base64url')!==value){b.fill(0);fail();}return b;}
function verifyToken(token,b){const raw=decode(token,32);raw.fill(0);
  const preimage=b.purpose==='sales_email_link_v1'?`sales-email-link-v1\n${b.source_id}\n${token}`:
    `retail-signing-v2\n${b.document_id}\n${b.source_fingerprint}\n${token}`;
  const actual=crypto.createHash('sha256').update(preimage,'utf8').digest();
  const expected=Buffer.from(b.token_hash,'hex');try{check(crypto.timingSafeEqual(actual,expected));}finally{actual.fill(0);expected.fill(0);}
}
function aad(keyId,b){return Buffer.from(canonical({protocol:PROTOCOL,key_id:keyId,purpose:b.purpose,binding:b}),'utf8');}
function createMembershipCapabilityEnvelope(config){
  const code='membership_capability_not_configured';
  config=snapshot(config,['environment','activeKeyId','keys']);
  check(['dev','staging','production'].includes(config.environment)
    && typeof config.activeKeyId==='string' && KEY.test(config.activeKeyId),code);
  const {environment,activeKeyId}=config,owned=new Map();let destroyed=false;
  try{
    const d=descriptors(config.keys),ids=Reflect.ownKeys(d);check(ids.length>=1 && ids.length<=4 && ids.every(id=>typeof id==='string' && KEY.test(id)),code);
    const keys=snapshot(config.keys,ids,d);
    for(const id of ids){const key=keys[id];check((Buffer.isBuffer(key)||key instanceof Uint8Array) && key.length===32,code);
      const copy=Buffer.from(key);if([...owned.values()].some(k=>crypto.timingSafeEqual(k,copy))){copy.fill(0);fail(code);}owned.set(id,copy);
    }
    check(owned.has(activeKeyId),code);
  }catch(_){for(const key of owned.values())key.fill(0);fail(code);}
  function alive(){check(!destroyed);}
  return Object.freeze({
    environment, // Immutable public configuration label; never a key/secret.
    keyIdentity:guarded(function(id){alive();check(typeof id==='string' && KEY.test(id) && owned.has(id));
      return Object.freeze({environment,key_id:id,physical_key_fingerprint:crypto.createHash('sha256').update(owned.get(id)).digest('hex')});}),
    seal:guarded(function(input){alive();input=snapshot(input,['binding','token']);const b=binding(input.binding,environment);verifyToken(input.token,b);
      const nonce=crypto.randomBytes(12),plain=Buffer.from(input.token,'ascii');let additional,ciphertext,tag;
      try{const cipher=crypto.createCipheriv('aes-256-gcm',owned.get(activeKeyId),nonce,{authTagLength:16});
        additional=aad(activeKeyId,b);cipher.setAAD(additional);ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);tag=cipher.getAuthTag();
        return Object.freeze({protocol:PROTOCOL,key_id:activeKeyId,binding:b,nonce:nonce.toString('base64url'),
          ciphertext:ciphertext.toString('base64url'),tag:tag.toString('base64url')});
      }catch(_){fail();}finally{for(const bytes of [plain,nonce,additional,ciphertext,tag])bytes?.fill(0);}
    }),
    open:guarded(function(input){alive();input=snapshot(input,['envelope','binding']);const b=binding(input.binding,environment),e=snapshot(input.envelope,['protocol','key_id','binding','nonce','ciphertext','tag']);
      check(e.protocol===PROTOCOL
        && typeof e.key_id==='string' && KEY.test(e.key_id) && owned.has(e.key_id)
        && canonical(binding(e.binding,environment))===canonical(b));
      let nonce,encrypted,tag,additional,partial,tail,plain;
      try{nonce=decode(e.nonce,12);encrypted=decode(e.ciphertext,43);tag=decode(e.tag,16);
        const decipher=crypto.createDecipheriv('aes-256-gcm',owned.get(e.key_id),nonce,{authTagLength:16});
        additional=aad(e.key_id,b);decipher.setAAD(additional);decipher.setAuthTag(tag);partial=decipher.update(encrypted);
        tail=decipher.final();plain=Buffer.concat([partial,tail]);check(plain.length===43);
        // ASCII decoding masks the high bit, which could accept a non-ASCII
        // plaintext as an otherwise valid token. UTF8+canonical alphabet rejects.
        const token=plain.toString('utf8');verifyToken(token,b);return token;
      }catch(_){fail();}finally{for(const bytes of [nonce,encrypted,tag,additional,partial,tail,plain])bytes?.fill(0);}
    }),
    destroy(){if(!destroyed){destroyed=true;for(const key of owned.values())key.fill(0);owned.clear();}}
  });
}
module.exports={createMembershipCapabilityEnvelope(config){try{return createMembershipCapabilityEnvelope(config);}
  catch(_){fail('membership_capability_not_configured');}}};
