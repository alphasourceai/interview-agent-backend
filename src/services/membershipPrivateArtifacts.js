'use strict';
// UNMOUNTED server transport, not user/source authorization. Existing native
// issuer/signer services must establish scope and verify their frozen hashes.
const crypto=require('node:crypto'),{isProxy}=require('node:util').types;
const UUID='(?!00000000-0000-0000-0000-000000000000)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function fail(code,status=503){const e=new Error(code);e.code=code;e.status=status;throw e;}
function check(ok,code,status){if(!ok)fail(code,status);}
function own(v,keys){
 check(v && typeof v==='object' && !isProxy(v) && !Array.isArray(v)
  && [Object.prototype,null].includes(Object.getPrototypeOf(v)),'membership_artifact_invalid_input',400);
 const d=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(d);
 check(names.length===keys.length && names.every(k=>typeof k==='string' && keys.includes(k) && d[k].enumerable
  && Object.hasOwn(d[k],'value')),'membership_artifact_invalid_input',400);
 return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
function createMembershipPrivateArtifacts({db,configuration}={}){
 const config=own(configuration,['projectRef','bucket','namespace']);
 check(typeof config.projectRef==='string' && /^[a-z0-9]{20}$/.test(config.projectRef)
  && typeof config.bucket==='string' && /^[a-z][a-z0-9-]{0,62}$/.test(config.bucket)
  && ['retail-v2','enterprise-v2'].includes(config.namespace),'membership_artifact_configuration_invalid');
 Object.freeze(config);
 const origin=`https://${config.projectRef}.supabase.co`,storageUrl=`${origin}/storage/v1`;
 const pattern=new RegExp(`^${config.namespace}/${UUID}/(?:preview\\.pdf|attempts/${UUID}/(?:signature\\.png|executed\\.pdf))$`);
 function endpoint(){check(db && [origin,`${origin}/`].includes(db.supabaseUrl)
  && db.storageUrl instanceof URL && db.storageUrl.href===storageUrl
  && db.storage?.url===storageUrl && typeof db.storage.getBucket==='function'
  && typeof db.storage.from==='function','membership_artifact_project_mismatch');}
 endpoint();
 function pathInfo(path){
  check(typeof path==='string' && path.length<=220 && pattern.test(path),'membership_artifact_invalid_path',400);
  const png=path.endsWith('.png');return {type:png?'image/png':'application/pdf',max:png?2097152:12582912,png};
 }
 function validateBytes(bytes,info){
  check(bytes.length>=16 && bytes.length<=info.max && (info.png
   ?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
   :bytes.subarray(0,5).toString()==='%PDF-' && bytes.subarray(-1024).toString('latin1').includes('%%EOF')),
   'membership_artifact_bytes_invalid');return bytes;
 }
 async function bucket(){
  endpoint();let r;try{r=await db.storage.getBucket(config.bucket);}catch(_){fail('membership_artifact_bucket_unavailable');}
  endpoint();check(!r?.error && r?.data?.id===config.bucket && r.data.name===config.bucket
   && r.data.public===false,'membership_artifact_bucket_denied');
 }
 function files(){endpoint();const api=db.storage.from(config.bucket);
  check(api && api.url===storageUrl && api.bucketId===config.bucket && typeof api.upload==='function'
   && typeof api.download==='function','membership_artifact_project_mismatch');return api;}
 async function download(path,info){
  await bucket();let r;try{r=await files().download(path);}catch(_){fail('membership_artifact_read_unavailable');}
  endpoint();check(!r?.error && r?.data instanceof Blob && Number.isSafeInteger(r.data.size)
   && r.data.size>=16 && r.data.size<=info.max
   && [info.type,'application/octet-stream'].includes(r.data.type),'membership_artifact_read_unverified');
  // Supabase download has already buffered a Blob. This bounds the subsequent
  // allocation, not the SDK's transport-buffer memory; no streaming claim.
  let body;try{body=await r.data.arrayBuffer();}catch(_){fail('membership_artifact_read_unavailable');}
  check(body instanceof ArrayBuffer && body.byteLength===r.data.size && body.byteLength<=info.max,
   'membership_artifact_read_unverified');
  const bytes=validateBytes(Buffer.from(body),info);await bucket();return Buffer.from(bytes);
 }
 return Object.freeze({
  async readPrivate(path){return download(path,pathInfo(path));},
  async putIfAbsent(path,value,options){
   const info=pathInfo(path),opts=own(options,['contentType','upsert']);
   check(opts.contentType===info.type && opts.upsert===false,'membership_artifact_invalid_input',400);
   check(value && !isProxy(value) && (Buffer.isBuffer(value) || (value instanceof Uint8Array
    && Object.getPrototypeOf(value)===Uint8Array.prototype)),'membership_artifact_invalid_input',400);
   // Intrinsic typed-array accessors avoid caller-supplied length/buffer getters.
   const native=Object.getPrototypeOf(Uint8Array.prototype);
   let bytes;try{
    const backing=Object.getOwnPropertyDescriptor(native,'buffer').get.call(value);
    const offset=Object.getOwnPropertyDescriptor(native,'byteOffset').get.call(value);
    const length=Object.getOwnPropertyDescriptor(native,'byteLength').get.call(value);
    check(backing instanceof ArrayBuffer && length>=16 && length<=info.max,'membership_artifact_invalid_input',400);
    bytes=Buffer.from(new Uint8Array(backing,offset,length));
   }catch(_){fail('membership_artifact_invalid_input',400);}
   validateBytes(bytes,info);const digest=sha(bytes);
   await bucket();let ack,unknown=false;
   try{ack=await files().upload(path,Buffer.from(bytes),{contentType:info.type,upsert:false});}
   catch(e){const status=Number(e?.statusCode??e?.status);if(status>=400 && status<500)fail('membership_artifact_write_denied');unknown=true;}
   endpoint();
   if(ack?.error){const status=Number(ack.error.statusCode??ack.error.status);
    if(status>=400 && status<500)fail('membership_artifact_write_denied');unknown=true;}
   if(!unknown && (ack?.data?.path!==path || (ack.data.fullPath!=null && ack.data.fullPath!==`${config.bucket}/${path}`)))unknown=true;
   // Unknown response recovers only the exact copied bytes at this same path.
   // No second upload, replacement, alternate bucket/path or delete fallback.
   const stored=await download(path,info);
   check(stored.length===bytes.length && sha(stored)===digest && stored.equals(bytes),'membership_artifact_write_unverified');
   return Object.freeze({path,sha256:digest,size:bytes.length,persistence:unknown?'verified_bytes_after_unknown_ack':'verified_bytes'});
  }
 });
}
module.exports={createMembershipPrivateArtifacts};
