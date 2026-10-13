'use strict';
// SDK orchestration mocks are NOT native SQL/provider acceptance. Actual native
// sealed rows/pins are independently exercised by the opt-in PostgreSQL fixture.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),http=require('node:http');
const {prepareEnterprisePoolTerms}=require('../../src/services/enterprisePoolSnapshot');
const TOKEN='SYNTHETIC_ENTERPRISE_SIGNER_TOKEN',config={public_backend_base:'https://api.example.invalid',public_sign_base:'https://site.example.invalid'};
const clone=v=>structuredClone(v),litClient='10000000-0000-4000-8000-000000000001';
class Query{
 constructor(db,table){this.db=db;this.table=table;this.filters=[];}
 select(){return this;}eq(k,v){this.filters.push([k,v]);return this;}is(k,v){return this.eq(k,v);}order(){return this;}
 update(p){this.change=p;return this;}insert(p){this.add=p;return this;}
 async exec(){
  const rows=this.db.tables[this.table];assert.ok(rows,'Unexpected table '+this.table);
  if(this.add){assert.equal(this.table,'billing_customers');if(rows.some(r=>r.stripe_customer_id===this.add.stripe_customer_id))return{data:[],error:{code:'23505'}};
   const r={id:crypto.randomUUID(),...clone(this.add)};rows.push(r);this.db.inserts.push(clone(r));return{data:[clone(r)],error:null,count:1};}
  const found=rows.filter(r=>this.filters.every(([k,v])=>(r[k]??null)===(v??null)));
  if(this.change){if(this.db.failSave)return{data:[],error:{message:'SYNTHETIC CAS failure'}};for(const r of found)Object.assign(r,clone(this.change));this.db.updates.push({table:this.table,change:clone(this.change)});}
  return{data:clone(found),error:null,count:found.length};
 }
 then(resolve,reject){return this.exec().then(resolve,reject);}async maybeSingle(){const r=await this.exec();return{data:r.data?.[0]||null,error:r.error};}async single(){return this.maybeSingle();}
}
function fixture({cadence='monthly',embedded=false,platformSubtotal,emptyProfile=false}={}){
 const aid=crypto.randomUUID(),attemptId=crypto.randomUUID(),signedAt=new Date(Date.now()-1000).toISOString(),prefix=`enterprise-v2/${aid}/attempts/${attemptId}/`;
 const fees=prepareEnterprisePoolTerms({membership_tier:'enterprise',billing_model:'usage',billing_option:cadence,platform_fee:'999.99',per_role_fee:'0',
  included_interviews_per_role:'0',additional_interview_fee:'0',usage_interview_fee_cents:2500,pool_quantity:30,rollover_days:'',max_interview_minutes:'20',scored_question_count:'5'});
 const execution={version:'enterprise_execution_v2',attempt_id:attemptId,signed_at:signedAt,signer_typed_name:'SYNTHETIC OWNER',signer_accepted:true,
  signature_sha256:'a'.repeat(64),signature_image_path:prefix+'signature.png',executed_pdf_path:prefix+'executed.pdf',signer_ip:null,signer_user_agent:'SYNTHETIC'};
 const unsigned={values:fees,rendered_html:'SYNTHETIC ONLY'},a={id:aid,client_id:litClient,membership_tier:'enterprise',billing_option:cadence,template_version:'membership_agreement_v2_phase1',
  template_snapshot:{...clone(unsigned),execution},status:'signed',is_current:true,signer_accepted:true,signed_at:signedAt,agreement_expires_at:new Date(Date.now()+7*86400000).toISOString(),
  signer_token_hash:crypto.createHash('sha256').update(TOKEN).digest('hex'),...Object.fromEntries(['signer_typed_name','signature_image_path','signature_sha256','executed_pdf_path','signer_ip','signer_user_agent'].map(k=>[k,execution[k]])),
  enterprise_checkout_source:null,enterprise_checkout_pool_id:null,enterprise_checkout_prices:null,checkout_session_id:null};
 const seal={agreement_id:aid,attempt_id:attemptId,token_hash:a.signer_token_hash,source_snapshot:unsigned,execution:clone(execution),signed_at:signedAt};
 const client={id:litClient,name:'SYNTHETIC ONLY',email:'owner@example.invalid',client_admin_name:'SYNTHETIC OWNER',stripe_customer_id:'cus_SYNTHETIC',parent_client_id:null,archived_at:null};
 const db={tables:{membership_agreements:[a],enterprise_v2_execution_seals:[seal],clients:[client],public_purchase_intents:[],client_interview_pools:[],billing_customers:emptyProfile?[]:[{id:crypto.randomUUID(),client_id:litClient,stripe_customer_id:client.stripe_customer_id}]},inserts:[],updates:[],rpcCalls:[],
  from(table){return new Query(this,table);},async rpc(name,p){this.rpcCalls.push({name,p:clone(p)});assert.equal(p.p_agreement,a.id);assert.equal(p.p_client,a.client_id);
   if(name==='prepare_enterprise_existing_checkout'){
    assert.deepEqual(p.p_expected_snapshot,a.template_snapshot);if(!a.enterprise_checkout_source){const b=Date.now(),d=new Date(b),first=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1);
     const poolid=crypto.randomUUID();a.enterprise_checkout_pool_id=poolid;a.enterprise_checkout_source={version:'enterprise_existing_pending_v1',material:{agreement_id:a.id,client_id:a.client_id,customer_id:client.stripe_customer_id,
      template_snapshot:clone(a.template_snapshot),template_version:a.template_version,billing_option:a.billing_option,signer_token_hash:a.signer_token_hash,agreement_expires_at:a.agreement_expires_at},
      pool_id:poolid,created_at:new Date(b).toISOString(),expires_at:new Date(Math.min(Date.parse(a.agreement_expires_at),b+86400000-1000,first-1000)).toISOString(),embedded:p.p_embedded,replacement_id:p.p_replacement,config:clone(p.p_config)};
     const v=a.template_snapshot.values,o=v.pool_offer_snapshot;db.tables.client_interview_pools.push({id:poolid,agreement_id:a.id,client_id:a.client_id,
      quantity_purchased:o.quantity,unit_price_cents:o.unit_price_cents,discount_pct:o.automatic_discount_percent,total_cents:o.net_cents,
      offer_snapshot:clone(o),offer_digest:v.pool_offer_digest,status:'pending',paid_at:null,stripe_checkout_session_id:null,stripe_payment_intent_id:null});}
   }else{assert.deepEqual(p.p_source,a.enterprise_checkout_source);
    if(name==='pin_enterprise_existing_checkout_prices'){assert.ok(!a.enterprise_checkout_prices||JSON.stringify(a.enterprise_checkout_prices)===JSON.stringify(p.p_prices));a.enterprise_checkout_prices=clone(p.p_prices);}
    else{assert.equal(name,'pin_enterprise_existing_checkout_session');assert.deepEqual(p.p_prices,a.enterprise_checkout_prices);assert.ok(!a.checkout_session_id||a.checkout_session_id===p.p_session);a.checkout_session_id=p.p_session;
     a.checkout_created_at=a.enterprise_checkout_source.created_at;a.checkout_status='pending_payment';a.replaces_stripe_subscription_id=a.enterprise_checkout_source.replacement_id;
     a.replacement_policy=a.replaces_stripe_subscription_id?'immediate_cancel':null;}
    if(name==='pin_enterprise_existing_checkout_session')db.tables.client_interview_pools[0].stripe_checkout_session_id=a.checkout_session_id;
   }
   if(db.failAck===name){db.failAck=null;return{data:null,error:{message:'SYNTHETIC ACK lost after commit'}};}
   return{data:{source:clone(a.enterprise_checkout_source),prices:clone(a.enterprise_checkout_prices),checkout_session_id:a.checkout_session_id},error:null};
  }};
 const calls=[],priceStore=new Map(),sessionStore=new Map(),keys=new Map(),products=new Map(),customer={id:client.stripe_customer_id,object:'customer',discount:null,balance:0,livemode:false};
 const stripe={customers:{async retrieve(id){calls.push({kind:'customer',id});return{...customer,id};}},subscriptions:{async list(p){calls.push({kind:'sublist',p:clone(p)});return{object:'list',data:[],has_more:false};}},
  products:{async retrieve(id){calls.push({kind:'product',id});return clone(products.get(id));}},prices:{async create(body,opt){calls.push({kind:'priceCreate',body:clone(body),opt:clone(opt)});
   let p=keys.get(opt.idempotencyKey);if(p){assert.deepEqual(p.body,body);p=p.result;}else{const k=body.recurring?'PLATFORM':'POOL',id='price_SYNTHETIC_'+k,product='prod_SYNTHETIC_'+k;
    p={id,object:'price',active:true,billing_scheme:'per_unit',currency:'usd',unit_amount:body.unit_amount,unit_amount_decimal:String(body.unit_amount),livemode:false,type:body.recurring?'recurring':'one_time',
     recurring:body.recurring?clone(body.recurring):null,product,metadata:clone(body.metadata)};priceStore.set(id,p);products.set(product,{id:product,object:'product',active:true,livemode:false,name:body.product_data.name});keys.set(opt.idempotencyKey,{body:clone(body),result:p});}
   if(stripe.failPrice&&(stripe.failPrice===body.recurring?.interval||stripe.failPrice==='pool'&&!body.recurring)){stripe.failPrice=null;throw Error('SYNTHETIC lost price ACK');}return clone(p);},
   async retrieve(id){calls.push({kind:'priceRead',id});return clone(priceStore.get(id));}},checkout:{sessions:{async create(body,opt){calls.push({kind:'sessionCreate',body:clone(body),opt:clone(opt)});
    let old=keys.get(opt.idempotencyKey);if(old){assert.deepEqual(old.body,body);}else{const platform=platformSubtotal??priceStore.get(body.line_items[0].price).unit_amount,pool=priceStore.get(body.line_items[1].price).unit_amount;
     const cs={id:'cs_SYNTHETIC',object:'checkout.session',customer:body.customer,mode:'subscription',status:'open',payment_status:'unpaid',subscription:null,currency:'usd',livemode:false,expires_at:body.expires_at,
      ui_mode:body.ui_mode||'hosted',return_url:body.return_url??null,success_url:body.success_url??null,cancel_url:body.cancel_url??null,url:'https://checkout.stripe.com/c/SYNTHETIC',client_secret:body.ui_mode==='embedded'?'SYNTHETIC_SECRET':null,
      allow_promotion_codes:false,metadata:clone(body.metadata),amount_subtotal:platform+pool,amount_total:platform+pool,total_details:{amount_discount:0,amount_shipping:0,amount_tax:0}};
     const lines=body.line_items.map((l,i)=>({id:'li_SYNTHETIC_'+i,object:'item',quantity:1,currency:'usd',price:clone(priceStore.get(l.price)),amount_subtotal:i?pool:platform,
      amount_discount:0,amount_tax:0,amount_total:i?pool:platform}));sessionStore.set(cs.id,{cs,lines});old={body:clone(body),result:cs};keys.set(opt.idempotencyKey,old);}
    if(stripe.failSession){stripe.failSession=false;throw Error('SYNTHETIC lost CS ACK');}return clone(old.result);},
   async retrieve(id){calls.push({kind:'sessionRead',id});let cs=clone(sessionStore.get(id)?.cs);return stripe.mutateSession?stripe.mutateSession(cs):cs;},
   async listLineItems(id,p){calls.push({kind:'lineRead',id,p:clone(p)});let lines=clone(sessionStore.get(id)?.lines);if(stripe.mutateLines)lines=stripe.mutateLines(lines);return{object:'list',has_more:false,data:lines};}}}};
 let factoryCalls=0,resolverCalls=0;
 const args={db,client:clone(client),agreement:clone(a),fees:clone(fees),billingInterval:cadence,embedded,cancelUrl:`${config.public_sign_base}/membership-agreement/sign/${TOKEN}`,
  key:`agreement_checkout:${aid}:enterprise:${cadence}`,config,stripeFactory:()=>{factoryCalls++;return stripe;},resolveCustomer:async p=>{resolverCalls++;assert.equal(p.skipCustomerUpdate,true);return client.stripe_customer_id;}};
 return{db,a,client,seal,args,stripe,calls,keys,priceStore,sessionStore,products,customer,getFactoryCalls:()=>factoryCalls,getResolverCalls:()=>resolverCalls};
}

module.exports={fixture,TOKEN,config};
