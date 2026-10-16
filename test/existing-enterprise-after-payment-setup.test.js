'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {exactPaymentTime}=require('../src/services/existingEnterprisePaymentRows');
function inject(path,exports){const file=require.resolve(path);require.cache[file]={id:file,filename:file,loaded:true,exports};}
const paidAt='2026-10-13T12:00:00.000000Z';
const proof={client_id:'00000000-0000-4000-8000-000000000002',customer_id:'cus_SYNTHETIC',subscription_id:'sub_SYNTHETIC',payment_success_at:paidAt};
function fixture({existingMember=false}={}){
 const agreement={id:'00000000-0000-4000-8000-000000000001',client_id:proof.client_id,status:'signed',is_current:true,
  checkout_status:'paid',checkout_session_id:'cs_SYNTHETIC',checkout_paid_at:paidAt,primary_admin_name:'Synthetic Owner',
  admin_email:'owner@example.invalid',client_legal_name:'Synthetic Client LLC',membership_tier:'enterprise',billing_option:'monthly',
  auto_renew:true,template_snapshot:{values:{}},superseded_at:null,superseded_by_agreement_id:null,
  enterprise_checkout_pool_id:'00000000-0000-4000-8000-000000000003',
  enterprise_checkout_source:{version:'enterprise_existing_pending_v1'},enterprise_checkout_prices:{platform_price_id:'price_SYNTHETIC'},
  enterprise_funding_receipt:{version:'enterprise_existing_funding_v1'},enterprise_billing_receipt:{version:'enterprise_existing_billing_v1'}};
 const client={id:proof.client_id,parent_client_id:null,archived_at:null,stripe_customer_id:proof.customer_id,
  stripe_subscription_id:proof.subscription_id,billing_status:'active',subscription_status:'active',manual_active_override:'force_inactive',access_override_mode:'manual'};
 const pool={id:'00000000-0000-4000-8000-000000000003',agreement_id:agreement.id,client_id:client.id,status:'paid',paid_at:paidAt,
  stripe_checkout_session_id:'cs_SYNTHETIC',stripe_payment_intent_id:'pi_SYNTHETIC'};
 const rows={membership_agreements:[agreement],clients:[client],client_interview_pools:[pool],billing_customers:[{id:'00000000-0000-4000-8000-000000000004',client_id:client.id,stripe_customer_id:client.stripe_customer_id}],
  client_members:existingMember?[{client_id:client.id,user_id:'user_SYNTHETIC',email:'owner@example.invalid',name:'Owner',role:'admin'}]:[]};
 class Query{
  constructor(table){this.table=table;this.filters=[];this.op='select';this.payload=null;}
  select(columns){this.columns=columns&&columns!=='*'?columns.split(','):null;return this;}eq(k,v){this.filters.push([k,v]);return this;}
  insert(value){this.op='insert';this.payload=value;return this;}
  update(value){this.op='update';this.payload=value;return this;}
  async exec(){const target=rows[this.table];if(this.op==='insert'){target.push(structuredClone(this.payload));return{data:[structuredClone(this.payload)],error:null};}
   const found=target.filter(row=>this.filters.every(([key,value])=>row[key]===value));
   if(this.op==='update')for(const row of found)Object.assign(row,structuredClone(this.payload));
   return{data:structuredClone(this.columns?found.map(row=>Object.fromEntries(this.columns.map(key=>[key,row[key]]))):found),error:null,count:found.length};}
  then(ok,bad){return this.exec().then(ok,bad);}async maybeSingle(){const r=await this.exec();return{data:r.data[0]||null,error:r.error};}
 }
 const db={rows,from(table){return new Query(table);}};
 inject('../src/clients/supabase',{supabaseAdmin:db});
 inject('../src/services/existingEnterpriseBillingReceipt',{readVerifiedEnterpriseBillingReceipt:async({agreement:a})=>{
  assert.equal(a.enterprise_billing_receipt.version,'enterprise_existing_billing_v1');return{funding_receipt:{proof}};
 }});
 inject('../src/services/existingEnterprisePaymentRows',{exactPaymentTime,verifyEnterprisePaymentRows:({agreement:a,pool:p,billingReceipt})=>{
  assert.equal(a.checkout_status,'paid');assert.equal(p.status,'paid');assert.equal(billingReceipt.funding_receipt.proof.subscription_id,proof.subscription_id);
  assert.equal(a.enterprise_checkout_pool_id,p.id,'setup projection must retain the existing native pool binding');
 }});
 const path=require.resolve('../src/services/publicPurchaseActivation');delete require.cache[path];
 const service=require(path);return{db,rows,service,client};
}
test('existing Enterprise paid tail verifies paid rows then reuses password-after-payment member setup without activation writes',async()=>{
 const f=fixture(),fences=[];const r=await f.service.finishExistingEnterpriseAccountSetup({db:f.db,agreementId:f.rows.membership_agreements[0].id,
  authAdmin:{listUsers:async()=>({data:{users:[]},error:null})},ensureRecovery:async()=>({userId:'user_NEW_SYNTHETIC',method:'created_user',actionLink:null}),
  sendRecoveryEmail:async()=>{throw Error('must not send in local test');},requireParentClient:async(_db,id)=>({ok:true,clientId:id}),
  assertActivationFence:async()=>fences.push('assert'),logger:{}});
 assert.equal(r.ok,true);assert.equal(r.status,'activated_existing_enterprise');assert.equal(r.auth_status,'created_user');
 assert.equal(r.setup_email_status,'link_unavailable');assert.equal(r.welcome_email_status,'not_sent_not_public_purchase');
 assert.equal(f.rows.client_members.length,1);assert.equal(f.rows.client_members[0].role,'manager');
 assert.equal(f.rows.clients[0].manual_active_override,'force_inactive');assert.equal(f.rows.clients[0].subscription_status,'active');
 assert.ok(fences.length>=2);
});
test('retry preserves an existing privileged client role and never sends a password reset',async()=>{
 const f=fixture({existingMember:true}),r=await f.service.finishExistingEnterpriseAccountSetup({db:f.db,agreementId:f.rows.membership_agreements[0].id,
  authAdmin:{listUsers:async()=>({data:{users:[{id:'user_SYNTHETIC',email:'owner@example.invalid'}]},error:null})},
  ensureRecovery:async()=>{throw Error('existing user must not get setup email');},sendRecoveryEmail:async()=>{throw Error('no send');},
  requireParentClient:async(_db,id)=>({ok:true,clientId:id}),logger:{}});
 assert.equal(r.auth_status,'existing_user');assert.equal(r.setup_email_status,'not_sent_existing_user');
 assert.equal(f.rows.client_members.length,1);assert.equal(f.rows.client_members[0].role,'admin');
});
for(const timestamp of ['2026-10-13T12:00:00+00:00','2026-10-13T06:00:00-06:00','2026-10-13T12:00:00.000Z'])
test(`existing Enterprise setup accepts equivalent PostgreSQL paid timestamp ${timestamp}`,async()=>{
 const f=fixture({existingMember:true});f.rows.membership_agreements[0].checkout_paid_at=timestamp;
 const before=structuredClone(f.rows);
 const r=await f.service.finishExistingEnterpriseAccountSetup({db:f.db,agreementId:f.rows.membership_agreements[0].id,
  authAdmin:{listUsers:async()=>({data:{users:[{id:'user_SYNTHETIC',email:'owner@example.invalid'}]},error:null})},
  ensureRecovery:async()=>{throw Error('no new account or recovery');},sendRecoveryEmail:async()=>{throw Error('no mail');},
  requireParentClient:async(_db,id)=>({ok:true,clientId:id}),logger:{}});
 assert.equal(r.ok,true);assert.equal(r.auth_status,'existing_user');assert.equal(r.setup_email_status,'not_sent_existing_user');
 assert.deepEqual(f.rows,before);
});
for(const timestamp of [null,'','not-a-date','2026-10-13T12:00:00.000001Z','2026-10-13T12:00:00.001Z','2026-10-13T12:00:01Z','2026-10-14T12:00:00Z'])
test(`existing Enterprise setup still denies missing/invalid/different paid instant ${timestamp}`,async()=>{
 const f=fixture({existingMember:true});f.rows.membership_agreements[0].checkout_paid_at=timestamp;
 const before=structuredClone(f.rows);
 await assert.rejects(f.service.finishExistingEnterpriseAccountSetup({db:f.db,agreementId:f.rows.membership_agreements[0].id,
  authAdmin:{listUsers:async()=>{throw Error('no auth access');}},ensureRecovery:async()=>{throw Error('no recovery');},
  sendRecoveryEmail:async()=>{throw Error('no mail');},requireParentClient:async()=>{throw Error('no parent continuation');},logger:{}}),
  {message:'enterprise_payment_scope_changed'});
 assert.deepEqual(f.rows,before);
});
