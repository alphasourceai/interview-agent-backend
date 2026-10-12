'use strict';
// Actual loader's SELECT projection, not a handwritten loader assumption.
const {test}=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),crypto=require('node:crypto');
const {createEnterpriseAgreementExecution}=require('../src/services/enterpriseAgreementExecution');
const {signature}=require('./fixtures/retail-signature');
test('real token loader projects every field needed to prepare and verify sealed signing',async()=>{
 const id=crypto.randomUUID(),token='a'.repeat(64),selected=[],pdf=Buffer.from('%PDF-1.7\nSYNTHETIC ONLY\n%%EOF'),files=new Map();let sealed;
 let row={id,client_id:null,status:'sent',membership_tier:'enterprise',signer_token_hash:token,admin_email:'synthetic@example.invalid',
  signer_token_expires_at:new Date(Date.now()+3600000).toISOString(),agreement_expires_at:new Date(Date.now()+3600000).toISOString(),
  signed_at:null,template_snapshot:{values:{pool_offer_snapshot:{}}}};
 const db={async rpc(){return {data:new Date().toISOString(),error:null};},from(table){
  return {select(fields){selected.push(fields);return {eq(){return this;},async maybeSingle(){
   const source=table==='membership_agreements'?row:sealed;return {data:Object.fromEntries(fields.split(',').map(k=>[k,source[k]??null])),error:null};}};},
  async insert(p){sealed={...p,signed_at:p.execution.signed_at,recorded_at:new Date().toISOString()};
   row={...row,status:'signed',is_current:true,signed_at:p.execution.signed_at,signer_accepted:true,signer_typed_name:p.execution.signer_typed_name,
    signature_image_path:p.execution.signature_image_path,signature_sha256:p.execution.signature_sha256,executed_pdf_path:p.execution.executed_pdf_path,
    signer_ip:p.execution.signer_ip,signer_user_agent:p.execution.signer_user_agent,template_snapshot:{...p.source_snapshot,execution:p.execution}};
   return {data:null,error:null,status:201};}
  };
 }};
 const index=require.resolve('../src/services/membershipAgreements/index'),load=Module._load;delete require.cache[index];
 Module._load=function(request,parent,isMain){
  if(request.includes('clients/supabase'))return {supabaseAdmin:db};
  if(parent?.filename===index && (request.includes('clients/sendgrid')||request.includes('middleware/auth')||request==='../subscriptionCheckout'))return {};
  return load.apply(this,arguments);
 };
 let actual;try{actual=require(index);}finally{Module._load=load;delete require.cache[index];}
 const service=createEnterpriseAgreementExecution({db,loadByTokenHash:actual.loadAgreementByTokenHash,renderExecution:async()=>pdf,
  artifacts:{async putIfAbsent(p,b){files.set(p,Buffer.from(b));},async readPrivate(p){return files.get(p);}}});
 const result=await service.sign({agreement:await actual.loadAgreementByTokenHash(token),tokenHash:token,typedName:'Synthetic Buyer',consent:true,signatureDataUrl:signature()});
 assert.equal(result.agreement.status,'signed');assert.equal(result.notify,true);
 const projection=selected[0].split(',');for(const key of ['signer_token_hash','signer_accepted','signature_image_path','signature_sha256','signer_ip','signer_user_agent'])assert.ok(projection.includes(key));
 assert.equal(result.agreement.signer_token_hash,token);
});
