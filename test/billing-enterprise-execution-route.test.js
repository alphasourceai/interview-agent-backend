'use strict';
// Exercise the actual Express /sign handler, with isolated synthetic dependencies.
const {test}=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),crypto=require('node:crypto');
const {isMarkedEnterpriseAgreement}=require('../src/services/enterpriseAgreementExecution');
function setup({marked=true,notify=true,error=null,classification=null,classifyError=false,classifyThrow=false}={}){
 const calls=[],agreement={id:crypto.randomUUID(),membership_tier:'enterprise',client_legal_name:'SYNTHETIC',admin_email:'synthetic@example.invalid',
  status:'sent',template_snapshot:{values:marked?{pool_offer_snapshot:{}}:{}}};
 const pdf=Buffer.from('%PDF-1.7\nSYNTHETIC\n%%EOF'),path='enterprise-v2/SYNTHETIC/attempts/SYNTHETIC/executed.pdf';
 const updated={...agreement,status:'signed',signed_at:'2026-10-12T12:00:00.000Z',signer_typed_name:'Synthetic Buyer'};
 const helpers={AGREEMENTS_BUCKET:'synthetic',crypto,readToken:req=>req.body.token,hashToken:()=> 'a'.repeat(64),
  normalizeAccepted:v=>v===true||v==='true',parseSignaturePayload:()=>({buffer:Buffer.from('SYNTHETIC'),mime:'image/png',ext:'png',dataUrl:'SYNTHETIC'}),
  loadAgreementByTokenHash:async()=>agreement,validateSignableAgreement:()=>({ok:true}),requireAgreementClientWhenPresent:async()=>({ok:true}),
  publicAgreementTokenRateLimit:(req,res,next)=>next(),slugify:()=> 'synthetic',getClientIp:()=> '192.0.2.1',
  buildExecutedMembershipAgreementHtml:()=>({html:'SYNTHETIC'}),htmlToPdf:async()=>pdf,
  createAgreementSignedUrl:async p=>{calls.push('signed_url');return 'https://example.invalid/SYNTHETIC';},
  sendMembershipAgreementSignedCopyEmail:async()=>{calls.push('copy_email');return {statusCode:202};},
  sendMembershipAgreementCompletedInternalNotification:async()=>{calls.push('internal_email');},
  supabaseAdmin:{storage:{from(){return {async upload(p,b,o){calls.push('legacy_upload');assert.equal(o.upsert,true);return {data:{path:p},error:null};}};}},
   async rpc(name){if(name==='enterprise_v2_classify_signing_source'){calls.push('classify');if(classifyThrow)throw Error('SYNTHETIC transport timeout');
    return {data:classification|| (marked?'marked':'unmarked'),error:classifyError?{code:'PGRST',message:'SYNTHETIC'}:null};}
    calls.push('legacy_rpc');return {data:[updated],error:null};}}};
 const routePath=require.resolve('../src/routes/public/membershipAgreements/signing'),original=Module._load;
 delete require.cache[routePath];
 Module._load=function(request,parent,isMain){
  if(parent?.filename===routePath){
   if(request==='../../../services/membershipAgreements/index')return helpers;
   if(request==='../../../middleware/auth')return {};
   if(request==='../../../services/enterpriseAgreementExecution')return {isMarkedEnterpriseAgreement,createEnterpriseAgreementExecution:()=>({
    async sign(input){calls.push('sealed_sign');assert.equal(input.consent,true);assert.equal(input.ip,'192.0.2.1');
     if(error){const e=new Error('');e.code=error;e.status=503;throw e;}
     return {agreement:updated,executedPdf:pdf,execution:{executed_pdf_path:path,signed_at:updated.signed_at},notify};}
   })};
  }return original.apply(this,arguments);
 };
 let router;try{router=require(routePath);}finally{Module._load=original;delete require.cache[routePath];}
 const handle=router.stack.find(l=>l.route?.path==='/sign').route.stack.at(-1).handle;
 async function invoke(){const req={body:{token:'SYNTHETIC TOKEN',typed_name:'Synthetic Buyer',accepted:true,signature_image:'SYNTHETIC'},headers:{},ip:'192.0.2.1'};
  const res={statusCode:200,status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;}};await handle(req,res);return res;}
 return {calls,invoke};
}
test('actual marked route uses sealed service, never legacy upload/RPC, then existing copy/internal email on verified ACK',async()=>{
 const f=setup(),r=await f.invoke();assert.equal(r.statusCode,200);assert.equal(r.body.ok,true);assert.equal(r.body.agreement.status,'signed');
 assert.ok(!f.calls.includes('legacy_upload'));assert.ok(!f.calls.includes('legacy_rpc'));
 assert.deepEqual(f.calls,['classify','sealed_sign','signed_url','signed_url','copy_email','internal_email']);
});
test('actual unknown-but-recovered signing route emits no email, still returns committed signed record',async()=>{
 const f=setup({notify:false}),r=await f.invoke();assert.equal(r.statusCode,200);assert.equal(r.body.ok,true);
 assert.deepEqual(f.calls,['classify','sealed_sign','signed_url','signed_url']);
});
test('actual sealed failure is held503 with no legacy fallback, signed URL or email',async()=>{
 const f=setup({error:'enterprise_execution_commit_unverified'}),r=await f.invoke();assert.equal(r.statusCode,503);assert.equal(r.body.error,'enterprise_execution_commit_unverified');
 assert.deepEqual(f.calls,['classify','sealed_sign']);
});
test('actual unmarked route retains legacy signing RPC/uploads and emails',async()=>{
 const f=setup({marked:false}),r=await f.invoke();assert.equal(r.statusCode,200);
 assert.equal(f.calls.filter(v=>v==='legacy_upload').length,2);assert.equal(f.calls.filter(v=>v==='legacy_rpc').length,1);
 assert.ok(!f.calls.includes('sealed_sign'));assert.ok(f.calls.includes('copy_email'));assert.ok(f.calls.includes('internal_email'));
});
for(const config of [{marked:true,classification:'unmarked'},{marked:false,classification:'marked'},
 {classification:'malformed'},{classification:'unknown'},{classifyError:true},{classifyThrow:true}]){
 test(`actual native/JS classifier mismatch or unavailable ${JSON.stringify(config)} is503/no effects`,async()=>{
  const f=setup(config),r=await f.invoke();assert.equal(r.statusCode,503);assert.deepEqual(f.calls,['classify']);
 });
}
