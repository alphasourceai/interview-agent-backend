'use strict';
const assert=require('node:assert/strict'),{test}=require('node:test'),express=require('express'),request=require('supertest'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const client='11111111-1111-4111-8111-111111111111';
const version='retail-stripe-terms-2026-10-14-v2',marker='membership_agreement_retail_terms_v2';
function stub(name,exports){const filename=path.join(root,name);require.cache[filename]={id:filename,filename,loaded:true,exports};}
class Query{
  constructor(db,table){this.db=db;this.table=table;this.predicates=[];this.mode='select';}
  select(){return this} order(){return this} limit(){return this}
  eq(k,v){this.predicates.push(r=>r[k]===v);return this}
  is(k,v){this.predicates.push(r=>(r[k]??null)===v);return this}
  neq(k,v){this.predicates.push(r=>r[k]!==v);return this}
  ilike(k,v){this.predicates.push(r=>String(r[k]||'').toLowerCase()===String(v).toLowerCase());return this}
  in(k,v){this.predicates.push(r=>v.includes(r[k]));return this}
  insert(v){this.mode='insert';this.payload=v;return this}
  update(v){this.mode='update';this.payload=v;return this}
  delete(){this.mode='delete';return this}
  run(){
    if(this.table==='sales_reps' && this.db.repLookupError)throw Error('private fake lookup failure');
    const all=this.db.rows[this.table]??(this.db.rows[this.table]=[]);
    let matches=all.filter(r=>this.predicates.every(p=>p(r)));
    if(this.mode==='insert'){const row={id:require('node:crypto').randomUUID(),...this.payload};all.push(row);matches=[row];this.db.writes.push({table:this.table,payload:this.payload});}
    if(this.mode==='update'){matches.forEach(r=>Object.assign(r,this.payload));this.db.writes.push({table:this.table,payload:this.payload});}
    if(this.mode==='delete')this.db.rows[this.table]=all.filter(r=>!matches.includes(r));
    return {data:matches,error:null};
  }
  async maybeSingle(){const r=this.run();return {...r,data:r.data[0]||null}}
  async single(){return this.maybeSingle()}
  then(resolve,reject){return Promise.resolve(this.run()).then(resolve,reject)}
}
function db(){return {rows:{sales_reps:[{user_id:'rep',active:true}],admins:[{id:'admin',email:'owner@example.invalid',is_active:true}],clients:[{id:client,name:'Synthetic Client',email:'other@example.invalid',parent_client_id:null}]},
  writes:[],uploads:[],emails:[],from(table){return new Query(this,table)},storage:{from(){return {upload:async()=>({error:null}),
    createSignedUrl:async()=>({data:{signedUrl:'https://example.invalid/preview'},error:null}),remove:async()=>({error:null})}}}};}
const keys=(months=3,payment='prepaid')=>({commitment_months:months,payment_option:payment,offer_version:version});
const salesBody={company_legal_name:'Synthetic Company',buyer_first_name:'QA',buyer_last_name:'Buyer',buyer_email:'buyer@example.invalid',
  buyer_phone:'5555550100',buyer_title:'Owner',candidate_assistance_name:'QA Buyer',candidate_assistance_email:'buyer@example.invalid',plan_key:'basic'};
async function gate(fn){const prior=process.env.MEMBERSHIP_PRICING_TERMS_ENABLED;process.env.MEMBERSHIP_PRICING_TERMS_ENABLED='true';
  try{return await fn()}finally{if(prior===undefined)delete process.env.MEMBERSHIP_PRICING_TERMS_ENABLED;else process.env.MEMBERSHIP_PRICING_TERMS_ENABLED=prior}}
function salesApp(d,accessRole='sales_rep'){stub('src/clients/supabase.js',{supabaseAdmin:d});
  const {createSalesRouter}=require('../src/routes/sales');const app=express();app.use(express.json());
  app.use((req,res,next)=>{req.salesRep={user_id:'rep',email:'rep@example.invalid',access_role:accessRole};next()});
  app.use('/sales',createSalesRouter({db:d,rateLimit:async()=>({allowed:true}),renderPdf:async()=>{d.uploads.push('render');return Buffer.from('synthetic')},
    sendAgreementEmail:async(...args)=>{d.emails.push(args);return {skipped:false}},buildSignUrl:()=> 'https://example.invalid/sign'}));return app;}
function adminApp(d){
  stub('src/clients/supabase.js',{supabaseAdmin:d,supabaseAnon:{auth:{getUser:async()=>({data:{user:{id:'admin',email:'owner@example.invalid'}},error:null})}}});
  stub('src/clients/stripe.js',{});stub('src/render/pdfRenderer.js',{htmlToPdf:async()=>{d.uploads.push('render');return Buffer.from('synthetic')}});
  stub('src/clients/sendgrid.js',{sendMembershipAgreementEmail:async(...args)=>d.emails.push(args),sendMembershipAgreementInternalNotification:async()=>{}});
  delete require.cache[require.resolve('../src/routes/admin/billingRouter')];
  const app=express();app.use(express.json());app.use('/billing',require('../src/routes/admin/billingRouter'));return app;
}
test('unmapped global admin cannot issue a new assisted quote; mapped actor remains eligible regardless role label',async()=>gate(async()=>{
  const d=db();d.rows.sales_reps=[];const app=salesApp(d,'global_admin');
  const response=await request(app).post('/sales/deals/preview').set('Idempotency-Key','synthetic-no-rep').send({...salesBody,...keys(),access_role:'sales_rep'});
  assert.equal(response.status,409);assert.equal(response.body.code,'retail_sales_attribution_required');
  assert.match(response.body.detail,/Admin Billing/);assert.equal(d.writes.length,0);assert.equal(d.uploads.length,0);assert.equal(d.emails.length,0);
  d.rows.sales_reps.push({user_id:'rep',active:true});
  assert.equal((await request(app).post('/sales/deals/preview').set('Idempotency-Key','synthetic-mapped-admin').send({...salesBody,...keys()})).status,201);
}));
test('create rechecks stored new preview before any durable work and does not poison idempotency on409',async()=>gate(async()=>{
  const d=db(),app=salesApp(d),body={...salesBody,...keys()};
  const preview=await request(app).post('/sales/deals/preview').set('Idempotency-Key','synthetic-preview-recheck').send(body);
  assert.equal(preview.status,201);const writes=d.writes.length,uploads=d.uploads.length;
  d.rows.sales_reps=[];
  const payload={...body,preview_id:preview.body.preview_id};
  const denied=await request(app).post('/sales/deals').set('Idempotency-Key','synthetic-retry-same-key').send(payload);
  assert.equal(denied.status,409);assert.equal(d.writes.length,writes);assert.equal(d.uploads.length,uploads);assert.equal(d.emails.length,0);
  assert.equal(d.rows.sales_idempotency_keys?.length||0,0);assert.equal(d.rows.public_purchase_intents?.length||0,0);
  d.rows.sales_reps.push({user_id:'rep',active:true});
  assert.equal((await request(app).post('/sales/deals').set('Idempotency-Key','synthetic-retry-same-key').send(payload)).status,201);
  assert.equal(d.emails.length,1);
}));
test('new assisted attribution read errors503 and inactive409 produce no artifact or email',async()=>gate(async()=>{
  for(const error of [true,false]){
    const d=db();d.repLookupError=error;d.rows.sales_reps[0].active=false;
    const response=await request(salesApp(d)).post('/sales/deals/preview').set('Idempotency-Key','synthetic-failed-rep').send({...salesBody,...keys()});
    assert.equal(response.status,error?503:409);assert.equal(d.writes.length,0);assert.equal(d.uploads.length,0);assert.equal(d.emails.length,0);
    assert.ok(!JSON.stringify(response.body).includes('private'));
  }
}));
test('legacy global-admin quote preview remains available without sales attribution row',async()=>{
  const prior=process.env.MEMBERSHIP_PRICING_TERMS_ENABLED;process.env.MEMBERSHIP_PRICING_TERMS_ENABLED='false';
  try{const d=db();d.rows.sales_reps=[];d.repLookupError=true;
    const response=await request(salesApp(d,'global_admin')).post('/sales/deals/preview').set('Idempotency-Key','synthetic-legacy-admin')
      .send({...salesBody,billing_cadence:'monthly'});
    assert.equal(response.status,201,JSON.stringify(response.body));
  }finally{if(prior===undefined)delete process.env.MEMBERSHIP_PRICING_TERMS_ENABLED;else process.env.MEMBERSHIP_PRICING_TERMS_ENABLED=prior;}
});
test('existing staff preview and idempotent send persist new terms and markers; no actual email',async()=>gate(async()=>{
  for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments']){
    const d=db(),app=salesApp(d),body={...salesBody,...keys(months,payment)};
    const preview=await request(app).post('/sales/deals/preview').set('Idempotency-Key',`preview-${months}-${payment}`).send(body);
    assert.equal(preview.status,201,JSON.stringify(preview.body));
    const saved=d.rows.sales_deal_previews[0];
    // New term dates do not come from the legacy preview calendar fields.
    saved.agreement_effective_date=null;saved.agreement_renewal_date=null;
    const createBody={...body,preview_id:preview.body.preview_id};
    const response=await request(app).post('/sales/deals').set('Idempotency-Key','synthetic-create').send(createBody);
    assert.equal(response.status,201,JSON.stringify(response.body));
    const intent=d.rows.public_purchase_intents[0],a=d.rows.membership_agreements[0];
    assert.equal(intent.protocol,'fenced_v2');assert.equal(intent.term_start_basis,'successful_payment');
    assert.equal(a.template_version,marker);assert.equal(a.template_snapshot.template_version,marker);
    assert.equal(a.initial_term_start,null);assert.equal(a.initial_renewal_date,null);
    assert.equal(a.agreement_expires_at,saved.agreement_expires_at);assert.equal(a.auto_renew,true);
    assert.equal(a.template_snapshot.values.commitment_months,months);
    assert.equal(d.emails.length,1);
    const replay=await request(app).post('/sales/deals').set('Idempotency-Key','synthetic-create').send(createBody);
    assert.equal(replay.status,201);assert.equal(d.emails.length,1);assert.equal(d.rows.membership_agreements.length,1);
  }
}));
test('existing admin retail send ignores browser prices and derives accepted quote with null dates',async()=>gate(async()=>{
  for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments']){
    const d=db(),app=adminApp(d),body={client_id:client,client_legal_name:'Synthetic Client',primary_admin_name:'QA Buyer',
      admin_email:'buyer@example.invalid',membership_tier:'basic',platform_fee:1,per_role_fee:1,...keys(months,payment)};
    const response=await request(app).post('/billing/agreements/send').set('Authorization','Bearer synthetic').send(body);
    assert.equal(response.status,200,JSON.stringify(response.body));
    const a=d.rows.membership_agreements[0];assert.equal(a.template_version,marker);
    assert.equal(a.initial_term_start,null);assert.equal(a.initial_renewal_date,null);
    assert.equal(a.template_snapshot.values.per_role_fee,'399');assert.equal(a.template_snapshot.values.scored_question_count,'5');
    assert.equal(a.template_snapshot.package_snapshot.commitment_months,months);
    assert.equal(a.template_snapshot.values.billing_option,payment==='prepaid'?'prepaid':'monthly');
    assert.ok(a.template_snapshot.package_snapshot.platform_fee_cents>1);assert.equal(d.emails.length,1);
  }
}));
test('admin stale selector refuses before client or PDF/storage/mail side effects',async()=>gate(async()=>{
  const d=db(),app=adminApp(d);
  const r=await request(app).post('/billing/agreements/send').set('Authorization','Bearer synthetic').send({membership_tier:'basic',...keys(),offer_version:'old'});
  assert.equal(r.status,400);assert.equal(r.body.code,'stale_offer_version');assert.equal(d.writes.length,0);assert.equal(d.uploads.length,0);assert.equal(d.emails.length,0);
}));
test('sales catalog preserves package rows and adds complete keyed offers and optional role prices',async()=>gate(async()=>{
  const d=db(),app=salesApp(d),r=await request(app).get('/sales/packages');
  assert.equal(r.status,200);assert.equal(r.body.items.length,2);
  assert.equal(r.body.items[0].platform_monthly_fee_cents,29900);
  assert.equal(r.body.pricing_version,version);assert.equal(r.body.offers.length,12);
  assert.deepEqual(r.body.first_role_prepay_prices,{basic:35900,pro:62900});
  assert.ok(r.body.offers.every(o=>o.scored_question_count>0 && o.per_role_fee_cents>0));
}));
test('admin catalog uses existing authentication and no hosted or persistent actions',async()=>gate(async()=>{
  const d=db(),app=adminApp(d);
  assert.equal((await request(app).get('/billing/membership-options')).status,401);
  const r=await request(app).get('/billing/membership-options').set('Authorization','Bearer synthetic');
  assert.equal(r.status,200);assert.equal(r.body.offers.length,12);
  assert.deepEqual(r.body.first_role_prepay_prices,{basic:35900,pro:62900});
  assert.equal(d.writes.length,0);assert.equal(d.emails.length,0);assert.equal(d.uploads.length,0);
}));

async function guardedPreview(fn) {
  const old=process.env.APP_ENV;process.env.APP_ENV='development';
  try { return await gate(fn); }
  finally { if(old==null)delete process.env.APP_ENV;else process.env.APP_ENV=old; }
}
test('guarded dev plain sales previews retain all12 term/payment choices with no provider/mail effects',async()=>guardedPreview(async()=>{
  for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const plan of ['basic','pro']) {
    const d=db(),app=salesApp(d);
    const r=await request(app).post('/sales/deals/preview').set('Idempotency-Key',`dev-preview-${months}-${payment}-${plan}`).send({...salesBody,plan_key:plan,...keys(months,payment)});
    assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(d.emails.length,0);
    assert.equal(d.rows.sales_deal_previews.length,1);assert.equal(d.rows.public_purchase_intents?.length||0,0);
    assert.equal(d.rows.membership_agreements?.length||0,0);
  }
}));
test('guarded dev sales promo and GHL-import branches hold before native reads or provider validation',async()=>guardedPreview(async()=>{
  for(const extra of [{promotion_code:'SYNTHETIC'},{ghl_import_id:'synthetic-binding'}]) {
    const d=db(),app=salesApp(d);let nativeReads=0;
    d.from=()=>{nativeReads++;throw Error('native read must not occur');};
    const r=await request(app).post('/sales/deals/preview').set('Idempotency-Key','dev-held-preview').send({...salesBody,...keys(),...extra});
    assert.equal(r.status,503);assert.equal(r.body.code,'GUARDED_DEV_BILLING_HOLD');
    assert.equal(nativeReads,0);assert.equal(d.writes.length,0);assert.equal(d.uploads.length,0);assert.equal(d.emails.length,0);
  }
}));
test('guarded dev authenticated admin preview HTML/PDF remains usable without agreement or email creation',async()=>guardedPreview(async()=>{
  for(const endpoint of ['preview-html','preview-pdf','preview']) {
    const d=db(),app=adminApp(d),body={client_id:client,client_legal_name:'Synthetic Client',primary_admin_name:'QA Buyer',admin_email:'buyer@example.invalid',membership_tier:'basic',...keys()};
    const r=await request(app).post(`/billing/agreements/${endpoint}`).set('Authorization','Bearer synthetic').send(body);
    assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(d.emails.length,0);
    assert.equal(d.rows.membership_agreements?.length||0,0);
  }
}));
