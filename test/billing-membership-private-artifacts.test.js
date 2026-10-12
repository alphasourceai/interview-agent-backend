'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createClient}=require('@supabase/supabase-js');
const {createMembershipPrivateArtifacts:create}=require('../src/services/membershipPrivateArtifacts');
const {png}=require('./fixtures/retail-signature');
const project='s'.repeat(20),origin=`https://${project}.supabase.co`,url=`${origin}/storage/v1`;
const doc='10000000-0000-4000-8000-000000000001',attempt='10000000-0000-4000-8000-000000000002';
const preview=`retail-v2/${doc}/preview.pdf`,executed=`retail-v2/${doc}/attempts/${attempt}/executed.pdf`;
const signature=`retail-v2/${doc}/attempts/${attempt}/signature.png`,PDF=Buffer.from('%PDF-1.7\nSYNTHETIC ONLY\n%%EOF');
const opts={contentType:'application/pdf',upsert:false};
function fixture(hooks={}){
 const config={projectRef:project,bucket:'agreements',namespace:'retail-v2'},events=[],files=new Map([[preview,Buffer.from(PDF)]]);
 let checks=0;const db={supabaseUrl:origin,storageUrl:new URL(url)};
 db.storage={url,async getBucket(name){events.push('bucket');checks++;hooks.bucketHook?.({db,checks,files});
  return hooks.bucketResult??{data:{id:name,name,public:false},error:null};},from(bucketId){
  return {url:hooks.fileUrl??url,bucketId,async upload(path,body,options){events.push('upload');assert.equal(options.upsert,false);
   assert.equal(options.contentType,path.endsWith('.png')?'image/png':'application/pdf');hooks.uploadHook?.({body,db,files});
   if(hooks.definite)return {error:{statusCode:String(hooks.definite),message:'SYNTHETIC SECRET'}};
   if(!hooks.absent)files.set(path,Buffer.from(body));
   if(hooks.unknown==='throw')throw Error('SYNTHETIC SECRET');
   if(hooks.unknown==='return')return {error:{statusCode:'503',message:'SYNTHETIC SECRET'}};
   return {data:hooks.ack??{path,fullPath:`${bucketId}/${path}`},error:null};},
   async download(path){events.push('download');hooks.downloadHook?.({db,files});
    if(hooks.readResult)return hooks.readResult;
    const body=hooks.changed??files.get(path);
    return body?{data:new Blob([body],{type:path.endsWith('.png')?'image/png':'application/pdf'}),error:null}:{error:{message:'SYNTHETIC SECRET'}};
   }};
 }};
 return {db,config,files,events,service:create({db,configuration:config})};
}
test('private read and verified create copy bytes, pin bucket/project/namespace and expose no SDK credential',async()=>{
 const f=fixture(),read=await f.service.readPrivate(preview);assert.deepEqual(read,PDF);read.fill(0);assert.deepEqual(f.files.get(preview),PDF);
 const r=await f.service.putIfAbsent(executed,PDF,opts);assert.equal(r.persistence,'verified_bytes');assert.ok(Object.isFrozen(r));
 assert.equal(r.sha256,crypto.createHash('sha256').update(PDF).digest('hex'));assert.equal(r.size,PDF.length);
 assert.equal(f.events.filter(v=>v==='upload').length,1);assert.ok(f.events.filter(v=>v==='bucket').length>=5);
 const p=await f.service.putIfAbsent(signature,png(),{contentType:'image/png',upsert:false});assert.equal(p.persistence,'verified_bytes');
});
for(const unknown of ['throw','return','malformedAck'])test(`unknown ${unknown} recovers exact same bytes with only one upload`,async()=>{
 const f=fixture(unknown==='malformedAck'?{ack:{path:'wrong'}}:{unknown});
 assert.equal((await f.service.putIfAbsent(executed,PDF,opts)).persistence,'verified_bytes_after_unknown_ack');
 assert.equal(f.events.filter(v=>v==='upload').length,1);assert.equal(f.events.filter(v=>v==='download').length,1);
});
for(const status of [400,401,403,409,429])test(`definite SDK${status} holds without recovery or another write`,async()=>{
 const f=fixture({definite:status});await assert.rejects(f.service.putIfAbsent(executed,PDF,opts),e=>e.code==='membership_artifact_write_denied'&&!e.message.includes('SECRET'));
 assert.deepEqual(f.events,['bucket','upload']);
});
for(const options of [{unknown:'throw',absent:true},{unknown:'return',changed:Buffer.from('%PDF-1.7\nCORRUPTED SAME PATH\n%%EOF')},
 {changed:Buffer.from('not an artifact')},{ack:{path:executed,fullPath:'foreign/path'},absent:true}]){
 test(`missing/corrupted readback holds ${JSON.stringify(options)}`,async()=>{
  const f=fixture(options);await assert.rejects(f.service.putIfAbsent(executed,PDF,opts),e=>e.code.startsWith('membership_artifact_'));
  assert.equal(f.events.filter(v=>v==='upload').length,1);
 });
}
for(const path of ['../preview.pdf',preview.replace('retail-v2','enterprise-v2'),`${preview}?token=secret`,
 preview.replace(doc,'00000000-0000-0000-0000-000000000000'),preview.replace('/preview','//preview'),
 preview.replace('/preview','/%70review'),preview.replace('/preview','/other'),`membership-agreements/${doc}/signature.png`,
 `${origin}/${preview}`,executed.replace(attempt,'not-a-uuid')])test(`noncanonical artifact path denied ${path}`,async()=>{
 const f=fixture();await assert.rejects(f.service.readPrivate(path),e=>e.status===400);assert.deepEqual(f.events,[]);
});
test('invalid options/getters/proxy/shape/body denied before SDK; getter never invoked',async()=>{
 let invoked=false;
 const getter={get contentType(){invoked=true;return 'application/pdf';},upsert:false};
 for(const options of [getter,new Proxy(opts,{}),{...opts,upsert:true},{...opts,contentType:'text/html'},{...opts,headers:{Authorization:'bad'}},{}]){
  const f=fixture();await assert.rejects(f.service.putIfAbsent(executed,PDF,options));assert.deepEqual(f.events,[]);
 }assert.equal(invoked,false);
 for(const body of [new Proxy(PDF,{}),'string',Buffer.from('bad'),Buffer.alloc(12582913),new Uint8Array(new SharedArrayBuffer(32))]){
  const f=fixture();await assert.rejects(f.service.putIfAbsent(executed,body,opts));assert.deepEqual(f.events,[]);
 }
});
test('intrinsic byte snapshot ignores Buffer getters and caller mutation during upload',async()=>{
 let invoked=false;const body=Buffer.from(PDF);
 Object.defineProperty(body,'buffer',{get(){invoked=true;throw Error('do not invoke');}});
 const f=fixture({uploadHook:()=>{body.fill(0);}});await f.service.putIfAbsent(executed,body,opts);
 assert.equal(invoked,false);assert.deepEqual(f.files.get(executed),PDF);
});
test('SDK cannot mutate retained upload bytes and get a different verified hash',async()=>{
 const f=fixture({uploadHook:({body})=>{body.fill(0);}});
 await assert.rejects(f.service.putIfAbsent(executed,PDF,opts));assert.deepEqual(PDF,Buffer.from('%PDF-1.7\nSYNTHETIC ONLY\n%%EOF'));
});
for(const data of [{id:'other',name:'agreements',public:false},{id:'agreements',name:'other',public:false},
 {id:'agreements',name:'agreements',public:true},{id:'agreements',name:'agreements',public:null}])test(`private bucket metadata fail-closed ${JSON.stringify(data)}`,async()=>{
 const f=fixture({bucketResult:{data,error:null}});await assert.rejects(f.service.readPrivate(preview),/bucket_denied/);assert.deepEqual(f.events,['bucket']);
});
test('mutable configuration cannot redirect and SDK endpoint changes hold before/after effect',async()=>{
 const frozen=fixture();frozen.config.bucket='other';frozen.config.namespace='enterprise-v2';assert.deepEqual(await frozen.service.readPrivate(preview),PDF);
 for(const patch of [db=>{db.supabaseUrl='https://other.supabase.co';},db=>{db.storageUrl=new URL('https://other.supabase.co/storage/v1');},db=>{db.storage.url='https://other.supabase.co/storage/v1';}]){
  const f=fixture();patch(f.db);await assert.rejects(f.service.readPrivate(preview),/project_mismatch/);assert.deepEqual(f.events,[]);
  const during=fixture({uploadHook:({db})=>patch(db)});await assert.rejects(during.service.putIfAbsent(executed,PDF,opts),/project_mismatch/);
  assert.equal(during.events.filter(v=>v==='upload').length,1);
 }
 const api=fixture({fileUrl:'https://other.supabase.co/storage/v1'});await assert.rejects(api.service.readPrivate(preview),/project_mismatch/);
});
test('bucket becoming public during read/upload stops completion without delete or retry',async()=>{
 for(const stage of ['read','write']){
  let became=false;const f=fixture({bucketHook:({db})=>{if(became)db.storage.getBucket=async()=>({data:{id:'agreements',name:'agreements',public:true}});},
   ...(stage==='read'?{downloadHook:()=>{became=true;}}:{uploadHook:()=>{became=true;}})});
  await assert.rejects(stage==='read'?f.service.readPrivate(preview):f.service.putIfAbsent(executed,PDF,opts),/bucket_denied/);
  assert.equal(f.events.filter(v=>v==='upload').length,stage==='write'?1:0);
 }
});
for(const blob of [new Blob([PDF],{type:'text/html'}),new Blob([Buffer.alloc(12582913)],{type:'application/pdf'}),
 {size:PDF.length,type:'application/pdf',arrayBuffer:async()=>PDF.buffer}])test('SDK returned bad MIME/over-size/non-native Blob holds',async()=>{
 const f=fixture({readResult:{data:blob,error:null}});await assert.rejects(f.service.readPrivate(preview),/read_unverified/);
});
test('real installed SDK uses only pinned private endpoint, headers and no-upsert; intercepted fetch is synthetic',async()=>{
 const calls=[],files=new Map();
 const db=createClient(origin,'SYNTHETIC_NOT_A_REAL_KEY',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
  global:{async fetch(target,init){
   const u=new URL(String(target)),method=init?.method||'GET',headers=new Headers(init?.headers);calls.push({url:u.href,method,headers});
   assert.equal(u.origin,origin);
   if(u.pathname==='/storage/v1/bucket/agreements')return Response.json({id:'agreements',name:'agreements',public:false});
   assert.equal(u.pathname,`/storage/v1/object/agreements/${executed}`);
   if(method==='POST'){
    assert.equal(headers.get('x-upsert'),'false');assert.equal(headers.get('content-type'),'application/pdf');
    files.set(executed,Buffer.from(init.body));return Response.json({Id:crypto.randomUUID(),Key:`agreements/${executed}`});
   }
   assert.equal(method,'GET');return new Response(files.get(executed),{headers:{'content-type':'application/pdf'}});
  }}});
 const service=create({db,configuration:{projectRef:project,bucket:'agreements',namespace:'retail-v2'}});
 assert.equal((await service.putIfAbsent(executed,PDF,opts)).persistence,'verified_bytes');
 assert.deepEqual(await service.readPrivate(executed),PDF);assert.equal(calls.filter(v=>v.method==='POST').length,1);
 assert.ok(calls.every(v=>v.url.startsWith(`${origin}/storage/v1/`)));
});
