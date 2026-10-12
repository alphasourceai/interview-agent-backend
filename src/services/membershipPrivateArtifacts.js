'use strict';
// UNMOUNTED server transport, not user/source authorization. Existing native
// issuer/signer services must establish scope and verify their frozen hashes.
const crypto=require('node:crypto'),{isProxy}=require('node:util').types;
const {createClient}=require('@supabase/supabase-js');
const {AsyncLocalStorage}=require('node:async_hooks');
const UUID='(?!00000000-0000-0000-0000-000000000000)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const recoverable=new Set([408,425,429,500,502,503,504]);
function fail(code,status=503){const e=new Error('');e.code=code;e.status=status;throw e;}
function check(ok,code,status){if(!ok)fail(code,status);}
function own(v,keys){
 check(v && typeof v==='object' && !isProxy(v) && !Array.isArray(v)
  && [Object.prototype,null].includes(Object.getPrototypeOf(v)),'membership_artifact_invalid_input',400);
 const d=Object.getOwnPropertyDescriptors(v),names=Reflect.ownKeys(d);
 check(names.length===keys.length && names.every(k=>typeof k==='string' && keys.includes(k) && d[k].enumerable
  && Object.hasOwn(d[k],'value')),'membership_artifact_invalid_input',400);
 return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
function createMembershipPrivateArtifacts({configuration,fetchImplementation=globalThis.fetch}={}){
 const config=own(configuration,['projectRef','bucket','namespace','serviceKey']);
 check(typeof config.projectRef==='string' && /^[a-z0-9]{20}$/.test(config.projectRef)
  && typeof config.bucket==='string' && /^[a-z][a-z0-9-]{0,62}$/.test(config.bucket)
  && ['retail-v2','enterprise-v2'].includes(config.namespace)
  && typeof config.serviceKey==='string' && config.serviceKey.length>=20 && config.serviceKey.length<=8192
  && !/\s/.test(config.serviceKey) && typeof fetchImplementation==='function','membership_artifact_configuration_invalid');
 Object.freeze(config);
 const origin=`https://${config.projectRef}.supabase.co`,storageUrl=`${origin}/storage/v1`;
 const writeContext=new AsyncLocalStorage();
 const pattern=new RegExp(`^${config.namespace}/${UUID}/(?:preview\\.pdf|attempts/${UUID}/(?:signature\\.png|executed\\.pdf))$`);
 function pathInfo(path){
  check(typeof path==='string' && path.length<=220 && pattern.test(path),'membership_artifact_invalid_path',400);
  const png=path.endsWith('.png');return {type:png?'image/png':'application/pdf',max:png?2097152:path.endsWith('/preview.pdf')?8388608:12582912,png};
 }
 async function guardedFetch(target,init={}){
  let u;try{u=new URL(typeof target==='string'?target:target.url);}catch(_){fail('membership_artifact_request_denied');}
  const method=init.method||'GET',base='/storage/v1/';
  check(u.origin===origin && !u.username && !u.password && !u.search && !u.hash && u.pathname.startsWith(base),'membership_artifact_request_denied');
  const route=u.pathname.slice(base.length);
  if(route===`bucket/${config.bucket}`)check(method==='GET','membership_artifact_request_denied');
  else{
   const meta=route.startsWith(`object/info/${config.bucket}/`),prefix=meta?`object/info/${config.bucket}/`:`object/${config.bucket}/`;
   check(route.startsWith(prefix) && (meta?method==='GET':['GET','POST'].includes(method)),'membership_artifact_request_denied');
   const info=pathInfo(route.slice(prefix.length)),headers=new Headers(init.headers);
   if(method==='POST')check(headers.get('x-upsert')==='false' && headers.get('content-type')===info.type
    && headers.get('cache-control')==='no-store','membership_artifact_request_denied');
  }
  if(method==='POST'){
   const context=writeContext.getStore();
   check(context && ++context.posts===1,'membership_artifact_request_denied');
  }
  const response=await fetchImplementation(target,{...init,redirect:'error',cache:'no-store'});
  if(method==='POST'){
   const context=writeContext.getStore();
   check(Number.isInteger(response?.status) && response.status>=200 && response.status<=599,'membership_artifact_request_denied');
   // Capture before the SDK parses JSON: a malformed error body otherwise
   // becomes StorageUnknownError and loses a known denial's HTTP status.
   context.httpStatus=response.status;
  }
  return response;
 }
 // Own narrow SDK client; a request cannot supply a DB/Auth handle.
 const db=createClient(origin,config.serviceKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
  storage:{useNewHostname:false},global:{fetch:guardedFetch}});
 function endpoint(){check(db.supabaseUrl===origin && db.storageUrl instanceof URL && db.storageUrl.href===storageUrl
  && db.storage.url===storageUrl,'membership_artifact_project_mismatch');}
 endpoint();
 function validateBytes(bytes,info){
  check(bytes.length>=16 && bytes.length<=info.max && (info.png
   ?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
   :bytes.subarray(0,5).toString()==='%PDF-' && bytes.subarray(-1024).toString('latin1').includes('%%EOF')),
   'membership_artifact_bytes_invalid');return bytes;
 }
 async function bucket(info){
  endpoint();let r;try{r=await db.storage.getBucket(config.bucket);}catch(_){fail('membership_artifact_bucket_unavailable');}
  endpoint();check(!r?.error && r?.data?.id===config.bucket && r.data.name===config.bucket
   && r.data.public===false
   && (r.data.file_size_limit==null || (Number.isSafeInteger(r.data.file_size_limit) && r.data.file_size_limit>=info.max))
   && (r.data.allowed_mime_types==null || (Array.isArray(r.data.allowed_mime_types) && r.data.allowed_mime_types.includes(info.type))),
   'membership_artifact_bucket_denied');
 }
 function files(){endpoint();const api=db.storage.from(config.bucket);
  check(api && api.url===storageUrl && api.bucketId===config.bucket && typeof api.upload==='function'
   && typeof api.download==='function','membership_artifact_project_mismatch');return api;}
 async function download(path,info){
  await bucket(info);const api=files();let metadata;
  try{metadata=await api.info(path);}catch(_){fail('membership_artifact_read_unavailable');}
  endpoint();const m=metadata?.data;
  check(!metadata?.error && m?.name===path && m.bucketId===config.bucket && Number.isSafeInteger(m.size)
   && m.size>=16 && m.size<=info.max && m.contentType===info.type,'membership_artifact_metadata_denied');
  let r;try{r=await api.download(path);}catch(_){fail('membership_artifact_read_unavailable');}
  endpoint();check(!r?.error && r?.data instanceof Blob && r.data.size===m.size && r.data.size<=info.max
   && r.data.type===info.type,'membership_artifact_read_unverified');
  // Metadata precedes download; an out-of-band replacement is still a race.
  // SDK download buffers internally, so this is not streamed-memory proof.
  let body;try{body=await r.data.arrayBuffer();}catch(_){fail('membership_artifact_read_unavailable');}
  check(body instanceof ArrayBuffer && body.byteLength===m.size,
   'membership_artifact_read_unverified');
  const bytes=validateBytes(Buffer.from(body),info);await bucket(info);return Buffer.from(bytes);
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
   await bucket(info);let ack,unknown=false;const context={httpStatus:null,posts:0};
   // SDK status is the HTTP response. statusCode comes from untrusted JSON and
   // must not turn a permission/conflict denial into transport recovery.
   function classify(error){const raw=context.httpStatus??error?.status;
    if(raw!=null && !(Number(raw)>=200 && Number(raw)<300) && !recoverable.has(Number(raw)))fail('membership_artifact_write_denied');return true;}
   try{ack=await writeContext.run(context,()=>files().upload(path,Buffer.from(bytes),{contentType:info.type,upsert:false,cacheControl:'0',headers:{'cache-control':'no-store'}}));}
   catch(e){unknown=classify(e);}
   endpoint();
   if(ack?.error)unknown=classify(ack.error);
   if(!unknown && (ack?.data?.path!==path || ack.data.fullPath!==`${config.bucket}/${path}`))unknown=true;
   // Unknown response recovers only the exact copied bytes at this same path.
   // No second upload, replacement, alternate bucket/path or delete fallback.
   const stored=await download(path,info);
   check(stored.length===bytes.length && sha(stored)===digest && stored.equals(bytes),'membership_artifact_write_unverified');
   return Object.freeze({path,sha256:digest,size:bytes.length,persistence:unknown?'recovered_exact_bytes':'created'});
  }
 });
}
module.exports={createMembershipPrivateArtifacts};
