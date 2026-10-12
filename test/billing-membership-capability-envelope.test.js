'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createMembershipCapabilityEnvelope:create}=require('../src/services/membershipCapabilityEnvelope');
const id='10000000-0000-4000-8000-000000000001',source='20000000-0000-4000-8000-000000000001';
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function fixture(purpose='retail_signer_v2',environment='dev'){
  const token=crypto.randomBytes(32).toString('base64url'),key=crypto.randomBytes(32),binding={purpose,environment,
    source_fingerprint:sha('SYNTHETIC SOURCE'),buyer_email:'demo+synthetic@example.invalid',token_hash:''};
  if(purpose==='retail_signer_v2')Object.assign(binding,{document_id:id,legal_version:'retail-membership-issued-synthetic-v1',
    html_sha256:sha('SYNTHETIC HTML'),preview_pdf_sha256:sha('SYNTHETIC PDF')});
  else binding.source_id=source;
  binding.token_hash=sha(purpose==='retail_signer_v2'?`retail-signing-v2\n${id}\n${binding.source_fingerprint}\n${token}`:`sales-email-link-v1\n${source}\n${token}`);
  return {token,key,binding,service:create({environment,activeKeyId:'k1',keys:{k1:key}})};
}
function canonical(v){return v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);}
const aad=e=>Buffer.from(canonical({protocol:e.protocol,key_id:e.key_id,purpose:e.binding.purpose,binding:e.binding}));
const denied=f=>assert.throws(f,e=>e.code==='membership_capability_invalid' && e.message===e.code && !e.cause);
test('both domains seal/open with independent crypto oracle and unique random nonces',()=>{
  for(const purpose of ['sales_email_link_v1','retail_signer_v2']){
    const x=fixture(purpose),e=x.service.seal({binding:x.binding,token:x.token}),other=x.service.seal({binding:x.binding,token:x.token});
    assert.notEqual(e.nonce,other.nonce);assert.notEqual(e.ciphertext,other.ciphertext);assert.equal(x.service.open({envelope:e,binding:x.binding}),x.token);
    const d=crypto.createDecipheriv('aes-256-gcm',x.key,Buffer.from(e.nonce,'base64url'),{authTagLength:16});
    d.setAAD(aad(e));d.setAuthTag(Buffer.from(e.tag,'base64url'));
    assert.equal(Buffer.concat([d.update(Buffer.from(e.ciphertext,'base64url')),d.final()]).toString(),x.token);
    assert.ok(!JSON.stringify(e).includes(x.token));assert.ok(Object.isFrozen(e)&&Object.isFrozen(e.binding));x.service.destroy();
  }
});
test('independently encrypted valid vector is accepted, authentication mutation never returns plaintext',()=>{
  const x=fixture(),e={protocol:'membership_capability_envelope_v1',key_id:'k1',binding:{...x.binding},nonce:crypto.randomBytes(12).toString('base64url')};
  const c=crypto.createCipheriv('aes-256-gcm',x.key,Buffer.from(e.nonce,'base64url'),{authTagLength:16});c.setAAD(aad(e));
  e.ciphertext=Buffer.concat([c.update(x.token),c.final()]).toString('base64url');e.tag=c.getAuthTag().toString('base64url');
  assert.equal(x.service.open({envelope:e,binding:x.binding}),x.token);
  for(const k of ['nonce','ciphertext','tag']){const b=Buffer.from(e[k],'base64url');b[0]^=1;denied(()=>x.service.open({envelope:{...e,[k]:b.toString('base64url')},binding:x.binding}));}
  x.service.destroy();
});
test('authenticated non-ASCII plaintext cannot exploit ASCII high-bit masking',()=>{
  const x=fixture(),e={protocol:'membership_capability_envelope_v1',key_id:'k1',binding:{...x.binding},nonce:crypto.randomBytes(12).toString('base64url')};
  const bad=Buffer.from(x.token);bad[0]|=128;
  const c=crypto.createCipheriv('aes-256-gcm',x.key,Buffer.from(e.nonce,'base64url'),{authTagLength:16});c.setAAD(aad(e));
  e.ciphertext=Buffer.concat([c.update(bad),c.final()]).toString('base64url');e.tag=c.getAuthTag().toString('base64url');
  denied(()=>x.service.open({envelope:e,binding:x.binding}));bad.fill(0);x.service.destroy();
});
test('every authoritative binding change, purpose/environment and key substitution holds',()=>{
  for(const purpose of ['sales_email_link_v1','retail_signer_v2']){
    const x=fixture(purpose),e=x.service.seal({binding:x.binding,token:x.token});
    for(const k of Object.keys(x.binding)){
      const altered={...x.binding,[k]:k==='environment'?'production':k==='purpose'?'unknown':k==='buyer_email'?'other@example.invalid':
        k==='legal_version'?'retail-membership-issued-synthetic-v2':k.endsWith('_id')?'30000000-0000-4000-8000-000000000001':'f'.repeat(64)};
      denied(()=>x.service.open({envelope:e,binding:altered}));
      denied(()=>x.service.open({envelope:{...e,binding:altered},binding:altered}));
    }
    denied(()=>x.service.open({envelope:{...e,key_id:'missing'},binding:x.binding}));
    const wrong=create({environment:'dev',activeKeyId:'k1',keys:{k1:crypto.randomBytes(32)}});denied(()=>wrong.open({envelope:e,binding:x.binding}));wrong.destroy();x.service.destroy();
  }
});
test('canonical fixed-size encodings, closed objects, bad token hashes and oversized input hold generically',()=>{
  const x=fixture(),e=x.service.seal({binding:x.binding,token:x.token});
  for(const k of ['nonce','ciphertext','tag'])for(const v of [e[k]+'=',e[k].slice(1),'!',null,'A'.repeat(500000)])
    denied(()=>x.service.open({envelope:{...e,[k]:v},binding:x.binding}));
  for(const v of [null,[],{...e,unknown:true},{...e,protocol:'other'},Object.assign(Object.create({}),e)])
    denied(()=>x.service.open({envelope:v,binding:x.binding}));
  const getter={...e};Object.defineProperty(getter,'tag',{get(){throw Error('must not call');}});denied(()=>x.service.open({envelope:getter,binding:x.binding}));
  denied(()=>x.service.seal({binding:{...x.binding,token_hash:'f'.repeat(64)},token:x.token}));
  denied(()=>x.service.seal({binding:x.binding,token:'T'.repeat(43)}));
  denied(()=>x.service.seal({binding:x.binding,token:x.token,unknown:true}));
  denied(()=>x.service.seal({binding:{...x.binding,buyer_email:'Demo@example.invalid'},token:x.token}));x.service.destroy();
});
test('unused base64url bits, same-key renamed AAD and nonzero-offset byte views stay exact',()=>{
  const x=fixture(),e=x.service.seal({binding:x.binding,token:x.token}),alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for(const k of ['ciphertext','tag']){const s=e[k],altered=s.slice(0,-1)+alphabet[alphabet.indexOf(s.at(-1))^1];
    assert.deepEqual(Buffer.from(s,'base64url'),Buffer.from(altered,'base64url'));denied(()=>x.service.open({envelope:{...e,[k]:altered},binding:x.binding}));}
  const renamed=create({environment:'dev',activeKeyId:'alias',keys:{alias:x.key}});
  denied(()=>renamed.open({envelope:{...e,key_id:'alias'},binding:x.binding}));
  const outer=crypto.randomBytes(80);outer.set(x.key,19);
  const view=create({environment:'dev',activeKeyId:'k1',keys:{k1:new Uint8Array(outer.buffer,outer.byteOffset+19,32)}});
  outer.fill(0);assert.equal(view.open({envelope:e,binding:x.binding}),x.token);
  const own=Object.create(null);own.constructor=x.key;own.__proto__=crypto.randomBytes(32);
  const special=create({environment:'dev',activeKeyId:'constructor',keys:own});
  assert.equal(special.open({envelope:special.seal({binding:x.binding,token:x.token}),binding:x.binding}),x.token);
  for(const s of [x.service,renamed,view,special])s.destroy();
});
test('keys and bindings are copied, explicit active-key rotation/retirement and destroy are deterministic',()=>{
  const x=fixture(),e=x.service.seal({binding:x.binding,token:x.token}),b={...x.binding};x.key.fill(0);x.binding.buyer_email='changed@example.invalid';
  assert.equal(x.service.open({envelope:e,binding:b}),x.token);assert.equal(e.binding.buyer_email,b.buyer_email);
  const oldKey=crypto.randomBytes(32),newKey=crypto.randomBytes(32),old=create({environment:'dev',activeKeyId:'old',keys:{old:oldKey}});
  const oldEnvelope=old.seal({binding:b,token:x.token}),rotated=create({environment:'dev',activeKeyId:'new',keys:{old:oldKey,new:newKey}});
  assert.equal(rotated.open({envelope:oldEnvelope,binding:b}),x.token);assert.equal(rotated.seal({binding:b,token:x.token}).key_id,'new');
  const retired=create({environment:'dev',activeKeyId:'new',keys:{new:newKey}});denied(()=>retired.open({envelope:oldEnvelope,binding:b}));
  for(const s of [x.service,old,rotated,retired]){s.destroy();s.destroy();denied(()=>s.seal({binding:b,token:x.token}));denied(()=>s.open({envelope:e,binding:b}));}
});
test('factory rejects missing, wrong, duplicate, excessive and accessor keys without ambient lookup',()=>{
  const key=crypto.randomBytes(32),config={environment:'dev',activeKeyId:'k1',keys:{k1:key}};
  const invalid=[undefined,{}, {...config,environment:'qa'}, {...config,activeKeyId:'unknown'}, {...config,keys:{}},
    {...config,keys:{k1:'not a byte key'}},{...config,keys:{k1:Buffer.alloc(31)}},{...config,keys:{k1:key,k2:key}},
    {...config,keys:Object.fromEntries([1,2,3,4,5].map(v=>['k'+v,crypto.randomBytes(32)]))}];
  for(const v of invalid)assert.throws(()=>create(v),e=>e.code==='membership_capability_not_configured' && e.message===e.code && !e.cause);
  const keys={};Object.defineProperty(keys,'k1',{get(){throw Error('must not call');}});
  assert.throws(()=>create({...config,keys}),e=>e.code==='membership_capability_not_configured');
});
test('unexpected reflection/getter failures cannot disclose underlying input or credential diagnostics',()=>{
  const x=fixture(),diagnostic='SYNTHETIC diagnostic MUST NOT ESCAPE',bad=new Proxy({}, {ownKeys(){throw Error(diagnostic);}});
  denied(()=>x.service.seal(bad));denied(()=>x.service.open(bad));
  assert.throws(()=>create(bad),e=>e.code==='membership_capability_not_configured' && e.message===e.code && !e.cause);
  x.service.destroy();
});
