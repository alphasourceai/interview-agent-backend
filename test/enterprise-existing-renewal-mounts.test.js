'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),express=require('express'),request=require('supertest');
const inject=(path,exports)=>{const f=require.resolve(path);require.cache[f]={id:f,filename:f,loaded:true,exports};};
inject('../src/clients/supabase',{supabaseAdmin:{}});
const fixture=require('./helpers/enterprise-renewal-mount-fixture'),{createFakeSupabase}=require('./helpers/fakeSupabase');
const {processContractRenewals:scan}=require('../src/services/contracts/contractRenewals');
const {readClientRetailBillingSummary:billing}=require('../src/services/clientRetailBillingSummary');
const {refreshExistingEnterpriseLegalWindow:refreshLegal}=require('../src/services/existingEnterpriseLegalWindow');
const markers=['enterprise_checkout_source','enterprise_checkout_pool_id','enterprise_checkout_prices','enterprise_funding_receipt','enterprise_billing_receipt'];
const clone=v=>structuredClone(v);
function settingGate(t,on=false){const prior=process.env.RETAIL_STRIPE_RENEWAL_CONTROL_ENABLED;
 process.env.RETAIL_STRIPE_RENEWAL_CONTROL_ENABLED=String(on);t.after(()=>{if(prior===undefined)delete process.env.RETAIL_STRIPE_RENEWAL_CONTROL_ENABLED;else process.env.RETAIL_STRIPE_RENEWAL_CONTROL_ENABLED=prior;});}
function appFor(f){
 inject('../src/clients/supabase',{supabaseAdmin:f.native.db});inject('../src/clients/stripe',f.stripe);
 inject('../src/middleware/auth',{requireAuth:(req,res,next)=>req.get('Authorization')?next():res.sendStatus(401)});
 inject('../src/middleware/requireAdmin',{requireAdmin:(req,res,next)=>req.get('X-Fixture-Admin')==='yes'?next():res.sendStatus(403)});
 inject('../src/services/admin/adminHelpers',{rejectChildClientForAdminBilling:async(req,res)=>{
  if(req.params.id==='synthetic-child'){res.sendStatus(403);return null;}return{ok:true};}});
 const file=require.resolve('../src/routes/admin/clients');delete require.cache[file];const app=express();app.use(express.json());app.use('/admin',require(file));return app;
}
const send=(app,id,auto_renew=false)=>request(app).patch(`/admin/clients/${id}/auto-renew`).set('Authorization','Bearer synthetic').set('X-Fixture-Admin','yes').send({auto_renew});
test('existing admin PATCH saves only accepted Enterprise preference with setting gate off, no legacy/provider write or source leak',async t=>{
 settingGate(t);const f=await fixture(t),app=appFor(f),r=await send(app,f.native.client.id);
 assert.equal(r.status,200);assert.equal(r.body.ok,true);assert.equal(r.body.renewal.status,'waiting');assert.equal(r.body.renewal.requested_auto_renew,false);
 assert.equal(r.body.renewal.stripe_renewal_billing_cutoff_at,f.legal.term_end_at);assert.equal(r.body.renewal.renewal_notice_cutoff_at,f.legal.notice_cutoff_at);
 assert.equal(f.native.client.auto_renew,false);assert.equal(f.calls.length,0);assert.deepEqual(f.native.db.updates,[]);
 assert.deepEqual(f.nativeActions.map(x=>x.args.p_action),['request']);
 const raw=JSON.stringify(r.body);for(const word of ['enterprise_existing_billing_v1','signer_token_hash','cus_','sub_','funding_receipt'])assert.equal(raw.includes(word),false);
 const selected=f.queryReads.find(x=>x.table==='membership_agreements').columns;for(const key of markers)assert.ok(selected.split(',').includes(key));
});
test('existing admin PATCH gate on defers future Enterprise E without canceling owed installments',async t=>{
 settingGate(t,true);const f=await fixture(t),r=await send(appFor(f),f.native.client.id);
 assert.equal(r.status,200);assert.equal(r.body.renewal.status,'waiting');assert.ok(f.calls.length>0);
 assert.ok(f.nativeActions.every(x=>x.name!=='advance_enterprise_existing_renewal'));
});
for(const status of ['busy','held'])test(`existing admin PATCH preserves ${status} rejection including null prior journal without false ok`,async t=>{
 settingGate(t);const f=await fixture(t);f.onNative=(name,args)=>args.p_action==='request'?{data:{status,
  reason:status==='held'?'request_deadline_passed':null,operation:null,legal_term_end:f.legal.term_end_at,notice_cutoff_at:f.legal.notice_cutoff_at,
  provider_effect_authorized:false,paid_access_authorized:false,payroll_authorized:false},error:null}:null;
 const r=await send(appFor(f),f.native.client.id);assert.equal(r.status,409);assert.equal(r.body.ok,false);assert.equal(r.body.renewal.status,status);
 assert.equal(r.body.renewal.requested_auto_renew,null);assert.equal(f.native.client.auto_renew,true);assert.equal(f.calls.length,0);
 assert.deepEqual(f.nativeActions.map(x=>x.args.p_action),['request']);
});
test('existing admin PATCH every partial/unpaid/malformed Enterprise source holds even without subscription id',async t=>{
 settingGate(t);for(const marker of markers){const f=await fixture(t),keep=f.native.a[marker];
  for(const key of markers)f.native.a[key]=key===marker?keep:null;
  f.native.client.stripe_subscription_id=null;
  const r=await send(appFor(f),f.native.client.id);assert.equal(r.status,503,marker);assert.equal(f.calls.length,0);assert.equal(f.native.client.auto_renew,true);
 }
 for(const change of [f=>{f.native.a.checkout_status='pending_payment';},f=>{f.native.a.enterprise_checkout_source.material.customer_id='cus_FOREIGN';}]){
  const f=await fixture(t);change(f);assert.equal((await send(appFor(f),f.native.client.id)).status,503);assert.equal(f.calls.length,0);
 }
});
test('existing admin PATCH auth/admin/child checks remain before renewal source reads',async t=>{
 settingGate(t);const f=await fixture(t),app=appFor(f),url=`/admin/clients/${f.native.client.id}/auto-renew`;
 assert.equal((await request(app).patch(url).send({auto_renew:false})).status,401);
 assert.equal((await request(app).patch(url).set('Authorization','Bearer synthetic').send({auto_renew:false})).status,403);
 assert.equal((await send(app,'synthetic-child')).status,403);assert.equal(f.queryReads.length,0);
});
test('legacy admin annual control retains its existing provider/client writes when no Enterprise or retail marker exists',async t=>{
 settingGate(t);const f=await fixture(t);f.native.db.tables.membership_agreements=[];
 Object.assign(f.native.client,{billing_interval:'annual',subscription_status:'active'});const writes=[];
 f.stripe.subscriptions.update=async(id,body)=>{writes.push({id,body});return{id};};
 const r=await send(appFor(f),f.native.client.id);assert.equal(r.status,200);assert.equal(r.body.item.auto_renew,false);
 assert.deepEqual(writes,[{id:f.native.client.stripe_subscription_id,body:{cancel_at_period_end:true}}]);
});
test('existing Retail admin branch remains selected, with no Enterprise operation or legacy setting write',async t=>{
 settingGate(t);const f=await fixture(t),a=f.native.a,client=f.native.client;
 const {buildRetailPackageSnapshot}=require('../src/services/membershipPackageCompatibility');
 const {STRIPE_RECURRING_OFFER_VERSION,anchoredMonthInstant}=require('../src/services/membershipOffers');
 const pkg=clone(buildRetailPackageSnapshot({planKey:'basic',commitmentMonths:3,paymentOption:'monthly_installments',channel:'sales',offerVersion:STRIPE_RECURRING_OFFER_VERSION}));
 for(const key of markers)a[key]=null;
 Object.assign(a,{membership_tier:'basic',billing_option:'monthly',template_version:'membership_agreement_retail_terms_v2',
  template_snapshot:{template_version:'membership_agreement_retail_terms_v2',package_snapshot:pkg}});
 Object.assign(client,{plan_tier:'basic',billing_interval:'monthly',contract_start_at:a.checkout_paid_at,contract_end_at:anchoredMonthInstant(a.checkout_paid_at,3)});
 const file=require.resolve('../src/services/existingRetailRenewalPreference'),saved=require.cache[file],calls=[];
 inject('../src/services/existingRetailRenewalPreference',{...saved.exports,requestExistingRetailRenewal:async input=>{
  calls.push(input);return{status:'waiting',operation:{requested_auto_renew:false,billing_cutoff_at:client.contract_end_at}};}});
 try{const r=await send(appFor(f),client.id);assert.equal(r.status,200);assert.equal(r.body.renewal.status,'waiting');
  assert.equal(calls.length,1);assert.equal(calls[0].agreementId,a.id);assert.equal(calls[0].autoRenew,false);
  assert.deepEqual(f.nativeActions,[]);assert.deepEqual(f.native.db.updates,[]);assert.equal(f.calls.length,0);
 }finally{require.cache[file]=saved;}
});
test('mounted Enterprise Billing summary exposes native terms only to authorized manager without provider identifiers',async t=>{
 const f=await fixture(t),db=createFakeSupabase(f.native.db.tables);db.rpc=f.native.db.rpc.bind(f.native.db);
 inject('../src/clients/supabase',{supabaseAdmin:db});
 inject('../src/middleware/auth',{requireAuth:(_req,_res,next)=>next(),withClientScope:(req,_res,next)=>{
  req.client_memberships=[f.native.client.id];req.clientScope={effectiveRolesByClientId:{[f.native.client.id]:['manager']},clientById:{[f.native.client.id]:f.native.client}};next();}});
 const file=require.resolve('../src/routes/client/billing');delete require.cache[file];const app=express();app.use(require(file));
 const r=await request(app).get(`/clients/billing/summary?client_id=${f.native.client.id}`);
 assert.equal(r.status,200);assert.equal(r.body.items[0].membership_terms.kind,'enterprise');
 assert.equal(r.body.items[0].membership_terms.current_term_end_at,f.legal.term_end_at);
 const raw=JSON.stringify(r.body);assert.equal(raw.includes(f.native.client.stripe_customer_id),false);assert.equal(raw.includes(f.native.client.stripe_subscription_id),false);
 assert.equal((await request(app).get('/clients/billing/summary?client_id=FOREIGN')).status,403);
});
for(const manual of [false,true])test(`existing scanner manualOverride=${manual} refreshes legal window and coverage, dispatcher disabled, no legacy action`,async t=>{
 settingGate(t);const f=await fixture(t);f.native.db.tables.contract_processing_runs=[];f.native.client.manual_active_override=manual;
 const original=f.native.db.rpc;f.native.db.rpc=async(name,args)=>{const r=await original(name,args);
  if(name==='refresh_enterprise_existing_paid_coverage'&&manual){r.data.status='manual_override';r.data.computed_billing_status=r.data.billing_status;delete r.data.billing_status;}return r;};
 const r=await scan({}, {db:f.native.db,stripe:f.stripe,now:new Date(Date.now())});
 assert.equal(r.summary.errors,0);assert.equal(r.summary.skipped_manual_override,0);assert.equal(r.summary.skipped_no_action,1);
 assert.equal(r.items[0].legal_window_status,'unchanged');assert.equal(r.items[0].renewal_request_status,'disabled');assert.equal(f.calls.length,0);
 assert.equal(f.native.client.manual_active_override,manual);assert.equal(f.native.client.billing_status,'active');
 assert.ok(f.nativeActions.some(x=>x.name==='refresh_enterprise_existing_legal_window'));
 assert.deepEqual(f.native.db.updates,[]);
});
test('existing scanner same accepted future OFF is reconciled when gate enabled, manual override does not suppress it',async t=>{
 settingGate(t,true);const f=await fixture(t);f.native.db.tables.contract_processing_runs=[];f.native.client.manual_active_override=true;
 await f.native.db.rpc('change_enterprise_existing_renewal',{p_agreement:f.native.a.id,p_client:f.native.client.id,p_billing:f.native.a.enterprise_billing_receipt,p_action:'request',p_auto_renew:false});
 const r=await scan({}, {db:f.native.db,stripe:f.stripe,now:new Date(Date.now())});
 assert.equal(r.summary.errors,0);assert.equal(r.items[0].renewal_request_status,'waiting');assert.ok(f.calls.length>0);
 assert.equal(f.native.client.auto_renew,false);assert.equal(f.native.client.manual_active_override,true);assert.equal(f.native.client.billing_status,'active');
});
test('legal refresh and Billing native proof failures do not become fabricated terms or legacy processing',async t=>{
 settingGate(t);const f=await fixture(t);f.native.db.tables.contract_processing_runs=[];
 f.onNative=(name)=>name==='refresh_enterprise_existing_legal_window'?{data:null,error:{message:'authored missing migration'}}:null;
 await assert.rejects(refreshLegal({db:f.native.db,agreementId:f.native.a.id,clientId:f.native.client.id}),{code:'enterprise_legal_window_unverified'});
 const r=await scan({}, {db:f.native.db,stripe:f.stripe,now:new Date(Date.now())});assert.equal(r.summary.errors,1);assert.equal(r.summary.renewed,0);assert.equal(r.summary.deactivated,0);
 f.onNative=name=>name==='read_enterprise_existing_legal_window'?{data:{...clone(f.legal),term_end_at:'2099-01-01T00:00:00.000000Z'},error:null}:null;
 await assert.rejects(billing({db:f.native.db,client:f.native.client}));
});
test('Enterprise Billing displays accepted price and native legal E, never mutable provider end or fake retail obligation',async t=>{
 const f=await fixture(t),before=clone(f.native.db.tables);f.native.client.current_term_end='2090-01-01T00:00:00Z';
 f.native.db.tables.client_plan_settings=[{client_id:f.native.client.id,platform_fee:999999}]; // Not a price authority.
 const r=await billing({db:f.native.db,client:f.native.client});
 assert.equal(r.kind,'enterprise');assert.equal(r.platform_payment_cents,99999);assert.equal(r.current_term_end_at,f.legal.term_end_at);
 assert.equal(r.renewal_notice_cutoff_at,f.legal.notice_cutoff_at);assert.equal(r.auto_renew,true);assert.equal(r.renewal_request_status,'none');
 for(const key of ['commitment_months','installment_count','platform_commitment_total_cents','stripe_customer_id','stripe_subscription_id'])assert.equal(Object.hasOwn(r,key),false);
 assert.deepEqual(f.native.db.tables.membership_agreements,before.membership_agreements);assert.equal(f.calls.length,0);
});
test('Enterprise Billing waiting OFF differs honestly from true provider flag and rejects concurrent preference drift',async t=>{
 const f=await fixture(t);await f.native.db.rpc('change_enterprise_existing_renewal',{p_agreement:f.native.a.id,p_client:f.native.client.id,p_billing:f.native.a.enterprise_billing_receipt,p_action:'request',p_auto_renew:false});
 const r=await billing({db:f.native.db,client:f.native.client});assert.equal(r.auto_renew,false);assert.equal(r.requested_auto_renew,false);assert.equal(r.renewal_request_status,'waiting');
 assert.equal(f.native.client.cancel_at_term_end,false);
 const stale={...f.native.client,auto_renew:true};await assert.rejects(billing({db:f.native.db,client:stale}),/billing_terms_changed/);
});
