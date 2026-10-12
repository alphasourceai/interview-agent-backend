'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createMembershipPrivateArtifacts:create}=require('../src/services/membershipPrivateArtifacts');
const {png}=require('./fixtures/retail-signature');
const project='s'.repeat(20),origin=`https://${project}.supabase.co`;
const doc='10000000-0000-4000-8000-000000000001',attempt='10000000-0000-4000-8000-000000000002';
const preview=`retail-v2/${doc}/preview.pdf`,executed=`retail-v2/${doc}/attempts/${attempt}/executed.pdf`;
const signature=`retail-v2/${doc}/attempts/${attempt}/signature.png`;
const PDF=Buffer.concat([Buffer.from('%PDF-1.7\nSYNTHETIC ONLY\n'),Buffer.from([0,255]),Buffer.from('\n%%EOF')]);
const opts={contentType:'application/pdf',upsert:false};
function fixture(hooks={}){
 const config={projectRef:project,bucket:'agreements',namespace:'retail-v2',serviceKey:'SYNTHETIC_NOT_A_REAL_KEY'},events=[],files=new Map([[preview,Buffer.from(PDF)]]);
 const bucket={id:'agreements',name:'agreements',public:false};
 const fetchImplementation=async(target,init)=>{
  const u=new URL(String(target)),method=init.method||'GET',headers=new Headers(init.headers);
  assert.equal(u.origin,origin);assert.equal(u.search,'');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');
  assert.equal(headers.get('apikey'),'SYNTHETIC_NOT_A_REAL_KEY');
  if(u.pathname==='/storage/v1/bucket/agreements'){
   events.push('bucket');hooks.bucketHook?.({bucket,files,events});
   return Response.json(hooks.bucket??bucket);
  }
  const infoPrefix='/storage/v1/object/info/agreements/';
  if(u.pathname.startsWith(infoPrefix)){
   events.push('info');const path=u.pathname.slice(infoPrefix.length),bytes=files.get(path);
   if(!bytes)return Response.json({message:'SYNTHETIC SECRET',statusCode:'404'},{status:404});
   return Response.json(hooks.info??{name:path,bucket_id:'agreements',size:bytes.length,content_type:path.endsWith('.png')?'image/png':'application/pdf'});
  }
  assert.ok(u.pathname.startsWith('/storage/v1/object/agreements/'));const path=u.pathname.slice('/storage/v1/object/agreements/'.length);
  if(method==='POST'){
   events.push('upload');assert.equal(headers.get('x-upsert'),'false');assert.equal(headers.get('cache-control'),'no-store');
   assert.equal(headers.get('content-type'),path.endsWith('.png')?'image/png':'application/pdf');
   hooks.uploadHook?.({body:init.body,bucket,files,events});
   const canCommit=hooks.status==null||[408,425,429,500,502,503,504].includes(hooks.status);
   if(canCommit && !hooks.absent)files.set(path,Buffer.from(init.body));
   if(hooks.unknown==='throw')throw Error('SYNTHETIC SECRET');
   if(hooks.status)return Response.json({message:'SYNTHETIC SECRET',statusCode:String(hooks.status)},{status:hooks.status});
   return Response.json(hooks.malformedAck?{}:{Id:crypto.randomUUID(),Key:`agreements/${path}`});
  }
  assert.equal(method,'GET');events.push('download');hooks.downloadHook?.({bucket,files,events});
  const bytes=hooks.changed??files.get(path);return new Response(bytes,{headers:{'content-type':hooks.mime??(path.endsWith('.png')?'image/png':'application/pdf')}});
 };
 return {config,bucket,files,events,service:create({configuration:config,fetchImplementation})};
}
const code=expected=>e=>e.code===expected && e.message==='' && !('cause' in e);
test('actual installed SDK versions and private transport preserve binary bytes without exposing client/key',async()=>{
 assert.equal(JSON.parse(require('fs').readFileSync('node_modules/@supabase/supabase-js/package.json')).version,'2.55.0');
 assert.equal(JSON.parse(require('fs').readFileSync('node_modules/@supabase/storage-js/package.json')).version,'2.10.4');
 const f=fixture(),r=await f.service.putIfAbsent(executed,PDF,opts);assert.equal(r.persistence,'created');assert.ok(Object.isFrozen(r));
 assert.equal(r.sha256,crypto.createHash('sha256').update(PDF).digest('hex'));assert.equal(r.size,PDF.length);
 assert.deepEqual(f.events,['bucket','upload','bucket','info','download','bucket']);
 assert.deepEqual(Object.keys(f.service),['readPrivate','putIfAbsent']);assert.ok(Object.isFrozen(f.service));
 assert.ok(!JSON.stringify(r).includes('KEY'));const read=await f.service.readPrivate(executed);assert.deepEqual(read,PDF);
 read.fill(0);assert.deepEqual(f.files.get(executed),PDF);
 assert.equal((await f.service.putIfAbsent(signature,png(),{contentType:'image/png',upsert:false})).persistence,'created');
});
for(const status of [408,425,429,500,502,503,504])test(`recoverable HTTP${status} proves exact bytes without another POST`,async()=>{
 const f=fixture({status});assert.equal((await f.service.putIfAbsent(executed,PDF,opts)).persistence,'recovered_exact_bytes');
 assert.equal(f.events.filter(v=>v==='upload').length,1);assert.equal(f.events.filter(v=>v==='download').length,1);
});
for(const options of [{unknown:'throw'},{malformedAck:true}])test('transport/malformed acknowledgment recovers only same-path bytes',async()=>{
 const f=fixture(options);assert.equal((await f.service.putIfAbsent(executed,PDF,opts)).persistence,'recovered_exact_bytes');
 assert.equal(f.events.filter(v=>v==='upload').length,1);
});
for(const status of [400,401,403,404,409,411,413,415,422,501,505])test(`definite HTTP${status} holds with no info/download/retry`,async()=>{
 const f=fixture({status});await assert.rejects(f.service.putIfAbsent(executed,PDF,opts),code('membership_artifact_write_denied'));
 assert.deepEqual(f.events,['bucket','upload']);
});
for(const hooks of [{unknown:'throw',absent:true},{status:503,changed:Buffer.from('%PDF-1.7\nWRONG BYTES\n%%EOF')},
 {changed:Buffer.from('not an artifact')},{mime:'text/html'}])test('unknown/missing/corrupt/MIME readback never retries upload',async()=>{
 const f=fixture(hooks);await assert.rejects(f.service.putIfAbsent(executed,PDF,opts));assert.equal(f.events.filter(v=>v==='upload').length,1);
});
for(const path of ['../preview.pdf',preview.replace('retail-v2','enterprise-v2'),`${preview}?token=secret`,
 preview.replace(doc,'00000000-0000-0000-0000-000000000000'),preview.replace('/preview','//preview'),
 preview.replace('/preview','/%70review'),preview.replace('/preview','/other'),`membership-agreements/${doc}/signature.png`,
 `${origin}/${preview}`,executed.replace(attempt,'not-a-uuid')])test('noncanonical paths cause no request',async()=>{
 const f=fixture();await assert.rejects(f.service.readPrivate(path),code('membership_artifact_invalid_path'));assert.deepEqual(f.events,[]);
});
test('strict options accept plain/null prototype own data, never invoke accessors/proxies',async()=>{
 for(const options of [opts,Object.assign(Object.create(null),opts)]){
  const f=fixture();await f.service.putIfAbsent(executed,PDF,options);
 }
 let invoked=false;const getter={get contentType(){invoked=true;return 'application/pdf';},upsert:false};
 for(const options of [getter,new Proxy(opts,{}),{...opts,upsert:true},{...opts,contentType:'text/html'},{...opts,headers:{Authorization:'bad'}},{}]){
  const f=fixture();await assert.rejects(f.service.putIfAbsent(executed,PDF,options));assert.deepEqual(f.events,[]);
 }assert.equal(invoked,false);
});
test('binary input copies only native offset/length before any await; SharedArrayBuffer/proxies/size/shape hold',async()=>{
 let invoked=false;const bytes=Buffer.from(PDF);
 Object.defineProperty(bytes,'buffer',{get(){invoked=true;throw Error('getter');}});
 const f=fixture({uploadHook:()=>bytes.fill(0)});await f.service.putIfAbsent(executed,bytes,opts);
 assert.equal(invoked,false);assert.deepEqual(f.files.get(executed),PDF);
 const padded=Buffer.concat([Buffer.from('PAD'),PDF,Buffer.from('PAD')]);
 const view=new Uint8Array(padded.buffer,padded.byteOffset+3,PDF.length),g=fixture();await g.service.putIfAbsent(executed,view,opts);
 assert.deepEqual(g.files.get(executed),PDF);
 for(const body of [new Proxy(PDF,{}),'string',Buffer.from('bad'),Buffer.alloc(12582913),new Uint8Array(new SharedArrayBuffer(32))]){
  const x=fixture();await assert.rejects(x.service.putIfAbsent(executed,body,opts));assert.deepEqual(x.events,[]);
 }
});
test('upload callback cannot change retained bytes/hash to match a corrupted response',async()=>{
 const f=fixture({uploadHook:({body})=>body.fill(0)});await assert.rejects(f.service.putIfAbsent(executed,PDF,opts));
 assert.ok(PDF.subarray(-5).equals(Buffer.from('%%EOF')));
});
for(const bucket of [{id:'other',name:'agreements',public:false},{id:'agreements',name:'other',public:false},
 {id:'agreements',name:'agreements',public:true},{id:'agreements',name:'agreements',public:null},
 {id:'agreements',name:'agreements',public:false,file_size_limit:100},
 {id:'agreements',name:'agreements',public:false,allowed_mime_types:['image/png']}])test('private bucket identity/type/limits denied',async()=>{
 const f=fixture({bucket});await assert.rejects(f.service.readPrivate(preview),code('membership_artifact_bucket_denied'));assert.deepEqual(f.events,['bucket']);
});
for(const field of ['size','name','bucket_id','content_type'])for(const value of [null,'wrong'])test(`invalid info${field} denies BEFORE body download`,async()=>{
 const info={name:preview,bucket_id:'agreements',size:PDF.length,content_type:'application/pdf', [field]:value};
 const f=fixture({info});await assert.rejects(f.service.readPrivate(preview),code('membership_artifact_metadata_denied'));assert.deepEqual(f.events,['bucket','info']);
});
for(const size of [8388609,16.5,-1])test('preview metadata cap/integer checks precede download',async()=>{
 const f=fixture({info:{name:preview,bucket_id:'agreements',size,content_type:'application/pdf'}});
 await assert.rejects(f.service.readPrivate(preview),code('membership_artifact_metadata_denied'));assert.deepEqual(f.events,['bucket','info']);
});
test('preview8MiB and execution12MiB caps are distinct on upload; metadata/body race holds',async()=>{
 const f=fixture();await assert.rejects(f.service.putIfAbsent(preview,Buffer.alloc(8388609),opts));assert.deepEqual(f.events,[]);
 const g=fixture({info:{name:preview,bucket_id:'agreements',size:PDF.length+1,content_type:'application/pdf'}});
 await assert.rejects(g.service.readPrivate(preview),code('membership_artifact_read_unverified'));
});
test('bucket flips during body read/upload fail completion without retry/delete',async()=>{
 for(const stage of ['read','write']){
  const hooks=stage==='read'?{downloadHook:({bucket})=>bucket.public=true}:{uploadHook:({bucket})=>bucket.public=true};
  const f=fixture(hooks);await assert.rejects(stage==='read'?f.service.readPrivate(preview):f.service.putIfAbsent(executed,PDF,opts),code('membership_artifact_bucket_denied'));
  assert.equal(f.events.filter(v=>v==='upload').length,stage==='write'?1:0);
 }
});
test('immutable constructor config cannot redirect SDK or expose a DB/Auth handle',async()=>{
 const f=fixture();f.config.projectRef='x'.repeat(20);f.config.bucket='other';f.config.namespace='enterprise-v2';f.config.serviceKey='CHANGED';
 assert.deepEqual(await f.service.readPrivate(preview),PDF);assert.equal(f.service.db,undefined);
 for(const patch of [{projectRef:'bad'},{bucket:'bad/path'},{namespace:'legacy'},{serviceKey:'short'}]){
  const base={projectRef:project,bucket:'agreements',namespace:'retail-v2',serviceKey:'SYNTHETIC_NOT_A_REAL_KEY'};
  assert.throws(()=>create({configuration:{...base,...patch}}));
 }
});
