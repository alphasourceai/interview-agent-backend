'use strict';
// Opt-in real full empty QA schema + curated16 migrations, private Unix socket.
const {test,before}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {buildRetailPackageSnapshot}=require('../src/services/membershipPackageCompatibility');
const {OFFER_VERSION,anchoredMonthInstant}=require('../src/services/membershipOffers');
const enabled=process.env.RETAIL_FUNDING_RECEIPT_DISPOSABLE==='true',opts={skip:!enabled};
const migration=path.resolve(__dirname,'../supabase/migrations/20261013231615_retail_existing_initial_funding_receipt.sql');
const lit=v=>v==null?'null':typeof v==='object'?`'${JSON.stringify(v).replaceAll("'","''")}'::jsonb`:typeof v==='boolean'||typeof v==='number'?String(v):`'${String(v).replaceAll("'","''")}'`;
function run(q){return cp.spawnSync('/opt/homebrew/opt/postgresql@17/bin/psql',['-X','-q','-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'});}
function sql(q){const r=run(q);assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function denied(q,pattern=/retail_funding_/){const r=run(q);assert.notEqual(r.status,0);assert.match(r.stderr,pattern);}
const acl=()=>sql("select jsonb_agg(jsonb_build_array(relname,relacl::text,relrowsecurity) order by relname) from pg_class where oid in('clients'::regclass,'membership_agreements'::regclass,'public_purchase_intents'::regclass,'billing_customers'::regclass);");
let priorAcl,legacyBefore;const legacyId=crypto.randomUUID();
before(()=>{if(!enabled)return;assert.match(process.env.PGHOST||'',/^\/private\/tmp\/alphascreen-retail-funding-pg\.[A-Za-z0-9]+$/);
 assert.equal(process.env.PGPORT,'55456');assert.equal(process.env.PGUSER,'postgres');assert.equal(process.env.PGDATABASE,'postgres');assert.equal(process.env.PGPASSWORD,undefined);
 sql(`insert into membership_agreements(id,status,is_current,client_legal_name,primary_admin_name,admin_email,membership_tier,billing_option,
  template_snapshot,draft_pdf_path,signer_token_hash,signer_token_expires_at,checkout_paid_at,checkout_status)
  values(${lit(legacyId)},'signed',true,'Synthetic Legacy','QA','legacy@example.invalid','basic','monthly','{}','legacy.pdf',
  ${lit(crypto.createHash('sha256').update(legacyId).digest('hex'))},clock_timestamp()+interval '7 days','2026-01-01Z','paid');`);
 legacyBefore=sql(`select to_jsonb(a) from membership_agreements a where id=${lit(legacyId)};`);
 priorAcl=acl();sql(fs.readFileSync(migration,'utf8'));
 sql(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261013232342_retail_existing_purchase_intent_prepaid.sql'),'utf8'));
});
function fixture(plan='basic',months=3,payment='prepaid',role=false,linked=true){
 const id=crypto.randomUUID(),client=crypto.randomUUID(),intent=crypto.randomUUID(),key='SYNTHETIC_CLAIM_'+crypto.randomUUID(),suffix=id.replaceAll('-','');
 const customer='cus_'+suffix,session='cs_'+suffix,pkg=buildRetailPackageSnapshot({planKey:plan,commitmentMonths:months,paymentOption:payment,firstRolePrepaySelected:role,offerVersion:OFFER_VERSION,channel:'sales'});
 const snapshot={template_version:'membership_agreement_retail_terms_v2',source:linked?'sales_assisted':'admin',package_snapshot:pkg,
  ...(linked?{purchase_intent:{id:intent}}:{}),values:{membership_tier:plan,billing_option:pkg.billing_cadence,auto_renew:true,
   commitment_months:months,payment_option:payment,pricing_version:pkg.pricing_version,term_start_basis:'successful_payment',platform_fee:String(pkg.platform_fee),
   per_role_fee:String(pkg.per_role_fee),additional_interview_fee:String(pkg.additional_interview_fee),included_interviews_per_role:String(pkg.included_interviews_per_role),
   max_interview_minutes:String(pkg.max_interview_minutes),first_role_prepay:pkg.first_role_prepay}};
 sql(`set role service_role;insert into clients(id,name,email,stripe_customer_id) values(${lit(client)},'Synthetic Native Funding','buyer@example.invalid',${lit(customer)});
  insert into billing_customers(client_id,name,primary_contact_email,stripe_customer_id) values(${lit(client)},'Synthetic Native Funding','buyer@example.invalid',${lit(customer)});
  insert into membership_agreements(id,client_id,status,is_current,client_legal_name,primary_admin_name,admin_email,membership_tier,billing_option,
   auto_renew,signer_accepted,template_version,template_snapshot,draft_pdf_path,signer_token_hash,signer_token_expires_at,signed_at,agreement_expires_at)
  values(${lit(id)},${lit(client)},'signed',true,'Synthetic Native Funding','QA','buyer@example.invalid',${lit(plan)},${lit(pkg.billing_cadence)},true,true,
   'membership_agreement_retail_terms_v2',${lit(snapshot)},'synthetic.pdf',${lit(crypto.createHash('sha256').update(id).digest('hex'))},clock_timestamp()+interval '7 days',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '7 days');`);
 if(linked)sql(`set role service_role;insert into public_purchase_intents(id,agreement_id,client_id,status,protocol,selected_plan_key,selected_billing_cadence,
  package_snapshot,first_role_prepay_selected,first_role_prepay_amount_cents,first_role_normal_role_fee_cents,first_role_prepay_discount_percent,
  first_role_prepay_credit_type,term_start_basis,expires_at,company_legal_name,buyer_first_name,buyer_last_name,buyer_email)
  values(${lit(intent)},${lit(id)},${lit(client)},'checkout_pending','fenced_v2',${lit(plan)},${lit(pkg.billing_cadence)},${lit(pkg)},${role},
  ${lit(role?pkg.first_role_prepay.discounted_credit_amount_cents:null)},${lit(role?pkg.first_role_prepay.normal_role_fee_cents:null)},${lit(role?10:null)},
  ${lit(role?'first_role_prepay':null)},'successful_payment',clock_timestamp()+interval '7 days','Synthetic Native Funding','QA','Buyer','buyer@example.invalid');`);
 const config={public_backend_base:'https://api.example.invalid',public_sign_base:'https://site.example.invalid'};
 const attempt=JSON.parse(sql(`set role service_role;select claim_retail_existing_checkout_attempt(${[id,client,snapshot,customer,false,null,config].map(lit).join(',')});`));
 sql(`set role service_role;select pin_retail_existing_checkout_session(${[id,client,attempt,session].map(lit).join(',')});`);
 if(linked)sql(`set role service_role;select claim_public_purchase_activation(${lit(id)},${lit(key)});`);
 const source=JSON.parse(sql(`select checkout_attempt_source from membership_agreements where id=${lit(id)};`));
 const created=Math.floor(Date.parse(attempt.created_at)/1000),paid=new Date(created*1000).toISOString();
 const proof={provider_account_id:'acct_SYNTHETIC',period:{version:'retail_initial_provider_period_v1',api_version:'2023-10-16',invoice_id:'in_'+suffix,
  platform_invoice_line_id:'il_'+suffix,price_id:'price_'+suffix,subscription_id:'sub_'+suffix,subscription_item_id:'si_'+suffix,customer_id:customer,
  checkout_session_id:session,livemode:false,paid_at:paid,provider_period_start:created,provider_period_end:Date.parse(anchoredMonthInstant(paid,pkg.membership_terms.stripe_recurrence.interval_count))/1000},
  payment_intent_id:'pi_'+suffix,charge_id:'ch_'+suffix,checkout_created:created,invoice_created:created,
  platform_gross_cents:pkg.platform_fee_cents,platform_discount_cents:0,platform_net_cents:pkg.platform_fee_cents,
  role_gross_cents:pkg.first_role_prepay.discounted_credit_amount_cents,role_discount_cents:0,role_net_cents:pkg.first_role_prepay.discounted_credit_amount_cents,
  tax_cents:0,cash_cents:pkg.membership_terms.initial_payment_cents};
 return{id,client,intent,key:linked?key:null,proof,source,pkg};
}
function call(f,proof=f.proof,source=f.source,key=f.key){return `select record_retail_existing_funding(${[f.id,f.client,key,source,proof].map(lit).join(',')});`;}
const record=f=>JSON.parse(sql('set role service_role;'+call(f)));
const row=f=>JSON.parse(sql(`select to_jsonb(a) from membership_agreements a where id=${lit(f.id)};`));
test('full schema migration preserves old table ACL/RLS and cannot overwrite prior application',opts,()=>{
 assert.equal(acl(),priorAcl);denied(fs.readFileSync(migration,'utf8'),/retail_funding_schema_drift/);
 assert.equal(sql(`select to_jsonb(a)-'retail_funding_receipt' from membership_agreements a where id=${lit(legacyId)};`),legacyBefore);
 assert.equal(sql(`select retail_funding_receipt is null from membership_agreements where id=${lit(legacyId)};`),'t');
 assert.equal(sql("select bool_and(not prosecdef) from pg_proc where proname like 'retail_existing_funding%' or proname='record_retail_existing_funding';"),'t');
});
for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true])
test(`native first funding ${plan}/${months}/${payment}/role:${role}`,opts,()=>{
 const f=fixture(plan,months,payment,role),before=row(f),client=sql(`select to_jsonb(c) from clients c where id=${lit(f.client)};`),a=record(f),b=record(f);
 assert.deepEqual(a,b);assert.deepEqual(a.proof,f.proof);assert.equal(a.version,'retail_existing_funding_v1');
 assert.equal(Date.parse(a.recorded_at)>=Date.parse(f.proof.period.paid_at),true);
 assert.deepEqual(row(f).retail_funding_receipt,a);assert.deepEqual({...row(f),retail_funding_receipt:null},before);
 assert.equal(sql(`select to_jsonb(c) from clients c where id=${lit(f.client)};`),client);
});
test('admin no-intent receipt does not fabricate intent or paid/access state',opts,()=>{
 const f=fixture('pro',6,'prepaid',true,false);assert.deepEqual(record(f).proof,f.proof);
 assert.equal(sql(`select count(*) from public_purchase_intents where agreement_id=${lit(f.id)};`),'0');assert.equal(row(f).checkout_paid_at,null);
});
test('malformed IDs/mode/period, clocks, cents, source, role fee and proof shapes record nothing',opts,()=>{
 for(const mutate of [p=>p.cash_cents=0,p=>p.cash_cents++,p=>p.platform_gross_cents++,p=>p.platform_discount_cents=1,
  p=>p.role_gross_cents=1,p=>p.tax_cents='0',p=>p.charge_id=null,p=>p.provider_account_id='acct_',p=>p.extra=true,
  p=>p.period.livemode='false',p=>p.period.provider_period_end=p.period.provider_period_start,p=>p.period.provider_period_start=1.5,
  p=>p.period.paid_at='2099-01-01T00:00:00.000Z',p=>p.period.paid_at='2025-01-01T00:00:00.000Z',p=>p.invoice_created--,
  p=>p.period.customer_id='cus_OTHER',p=>p.period.checkout_session_id='cs_OTHER']){
  const f=fixture(),p=structuredClone(f.proof);mutate(p);denied('set role service_role;'+call(f,p));assert.equal(row(f).retail_funding_receipt,null);
 }
 const f=fixture();denied('set role service_role;'+call(f,f.proof,{...f.source,customer_id:'cus_OTHER'}));assert.equal(row(f).retail_funding_receipt,null);
});
test('expired/lost claim and changed customer or terminal source cannot record',opts,()=>{
 for(const patch of ['expired','key','customer','superseded']){
  const f=fixture();if(patch==='expired')sql(`update public_purchase_intents set activation_claimed_at=clock_timestamp()-interval '6 minutes' where id=${lit(f.intent)};`);
  if(patch==='key')sql(`update public_purchase_intents set activation_claim_key='OTHER_SYNTHETIC_CLAIM_00000000000000000' where id=${lit(f.intent)};`);
  if(patch==='customer')sql(`update clients set stripe_customer_id='cus_OTHER' where id=${lit(f.client)};`);
  if(patch==='superseded')sql(`update membership_agreements set is_current=false where id=${lit(f.id)};`);
  denied('set role service_role;'+call(f));assert.equal(row(f).retail_funding_receipt,null);
 }
});
test('browser roles and direct first service writes cannot bypass record RPC; receipt cannot edit/delete',opts,()=>{
 const f=fixture();for(const role of ['anon','authenticated'])denied(`set role ${role};`+call(f),/permission denied/);
 denied(`set role service_role;update membership_agreements set retail_funding_receipt=${lit({version:'retail_existing_funding_v1',proof:f.proof,recorded_at:null})} where id=${lit(f.id)};`);
 record(f);for(const patch of ['null',"retail_funding_receipt||'{\"extra\":1}'::jsonb"])
  denied(`set role service_role;update membership_agreements set retail_funding_receipt=${patch} where id=${lit(f.id)};`);
 denied(`set role service_role;delete from membership_agreements where id=${lit(f.id)};`,/retail_checkout_attempt_immutable/);
 const p=structuredClone(f.proof);p.period.provider_period_end++;
 denied('set role service_role;'+call(f,p),/receipt_conflict/);
});
test('later agreement and linked activated clocks must be original A, and cannot be cleared or moved',opts,()=>{
 const f=fixture();record(f);denied(`set role service_role;update membership_agreements set checkout_paid_at='2099-01-01Z' where id=${lit(f.id)};`);
 denied(`set role service_role;update public_purchase_intents set activated_at='2099-01-01Z' where id=${lit(f.intent)};`);
 sql(`set role service_role;update membership_agreements set checkout_paid_at=${lit(f.proof.period.paid_at)} where id=${lit(f.id)};
  update public_purchase_intents set activated_at=${lit(f.proof.period.paid_at)} where id=${lit(f.intent)};`);
 denied(`set role service_role;update membership_agreements set checkout_paid_at=null where id=${lit(f.id)};`);
 denied(`set role service_role;update public_purchase_intents set activated_at=null where id=${lit(f.intent)};`);
});
function parallel(q){return new Promise((resolve,reject)=>{const c=cp.spawn('/opt/homebrew/opt/postgresql@17/bin/psql',['-X','-q','-At','-v','ON_ERROR_STOP=1','-c',q]);let out='',err='';
 c.stdout.on('data',v=>out+=v);c.stderr.on('data',v=>err+=v);c.once('error',reject);c.once('close',code=>resolve({code,out,err}));});}
test('concurrent same proof writers serialize to one identical immutable receipt',opts,async()=>{
 const f=fixture(),[a,b]=await Promise.all([parallel('set role service_role;begin;'+call(f)+'select pg_sleep(0.1);commit;'),parallel('set role service_role;'+call(f))]);
 assert.equal(a.code,0,a.err);assert.equal(b.code,0,b.err);
 const parse=r=>JSON.parse(r.out.split('\n').find(s=>s.startsWith('{')));assert.deepEqual(parse(a),parse(b));assert.deepEqual(row(f).retail_funding_receipt,parse(a));
});
test('claim expiring while waiting for intent lock is rejected using post-lock native time',opts,async()=>{
 const f=fixture(),[a,b]=await Promise.all([
  parallel(`begin;select id from public_purchase_intents where id=${lit(f.intent)} for update;
   update public_purchase_intents set activation_claimed_at=clock_timestamp()-interval '299.85 seconds' where id=${lit(f.intent)};
   select pg_sleep(0.3);commit;`),
  parallel('set role service_role;select pg_sleep(0.04);'+call(f))]);
 assert.equal(a.code,0,a.err);assert.notEqual(b.code,0);assert.match(b.err,/retail_funding_claim_denied/);assert.equal(row(f).retail_funding_receipt,null);
});
test('prepaid cadence amendment preserves annual/monthly legacy values and refuses unknown schema',opts,()=>{
 const name='public_purchase_intents_billing_check',def=sql(`select pg_get_constraintdef(oid) from pg_constraint where conrelid='public_purchase_intents'::regclass and conname='${name}';`);
 assert.match(def,/'monthly'.*'annual'.*'prepaid'/);assert.equal(acl(),priorAcl);
 denied(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20261013232342_retail_existing_purchase_intent_prepaid.sql'),'utf8'),/retail_intent_cadence_constraint_drift/);
});
test('real SDK16/API2023 loopback feeds actual native RPC and fresh DB ACK/readback with no provider writes',opts,async()=>{
 const http=require('node:http'),Stripe=require('stripe'),{fixture:fundingFixture}=require('./fixtures/existing-retail-funding-fixture');
 const f=fixture('basic',3,'monthly_installments',true),v=fundingFixture('basic',3,'monthly_installments',true),p=f.proof,requests=[],writes=[];
 const nativeDb={from(table){assert.ok(['membership_agreements','public_purchase_intents','clients','billing_customers'].includes(table));const filters=[];
  const query={select(){return query;},eq(k,val){assert.match(k,/^[a-z_]+$/);filters.push(`${k}=${lit(val)}`);return query;},
   async maybeSingle(){const r=read();assert.ok(r.data.length<=1);return{...r,data:r.data[0]||null};},then(resolve,reject){return Promise.resolve().then(read).then(resolve,reject);}};
  function read(){const data=JSON.parse(sql(`set role service_role;select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.${table} t${filters.length?' where '+filters.join(' and '):''};`));
   return{data,count:data.length,error:null};}return query;},
  async rpc(name,a){assert.equal(name,'record_retail_existing_funding');writes.push(structuredClone(a));
   const data=JSON.parse(sql('set role service_role;'+`select record_retail_existing_funding(${[a.p_agreement,a.p_client,a.p_claim,a.p_source,a.p_proof].map(lit).join(',')});`));return{data,error:null};}};
 Object.assign(v.cs,{id:p.period.checkout_session_id,customer:p.period.customer_id,subscription:p.period.subscription_id,invoice:p.period.invoice_id,created:p.checkout_created});
 Object.assign(v.s,{id:p.period.subscription_id,customer:p.period.customer_id});
 Object.assign(v.s.items.data[0],{id:p.period.subscription_item_id,subscription:p.period.subscription_id});
 // The original authored fixture shares the same Price across Session/line/item.
 v.il[0].price.id=p.period.price_id;
 Object.assign(v.il[0],{id:p.period.platform_invoice_line_id,subscription:p.period.subscription_id,subscription_item:p.period.subscription_item_id,
  period:{start:p.period.provider_period_start,end:p.period.provider_period_end}});
 v.il[1].subscription=p.period.subscription_id;
 Object.assign(v.inv,{id:p.period.invoice_id,customer:p.period.customer_id,subscription:p.period.subscription_id,created:p.invoice_created,
  status_transitions:{paid_at:Date.parse(p.period.paid_at)/1000},payment_intent:p.payment_intent_id,charge:p.charge_id});
 Object.assign(v.pi,{id:p.payment_intent_id,customer:p.period.customer_id,invoice:p.period.invoice_id,latest_charge:p.charge_id});
 Object.assign(v.ch,{id:p.charge_id,customer:p.period.customer_id,invoice:p.period.invoice_id,payment_intent:p.payment_intent_id});
 const server=http.createServer((req,res)=>{requests.push({method:req.method,path:req.url,version:req.headers['stripe-version']});
  const url=new URL(req.url,'http://localhost');let body;
  if(url.pathname==='/v1/account')body={object:'account',id:p.provider_account_id};
  else if(url.pathname===`/v1/checkout/sessions/${v.cs.id}`)body=v.cs;
  else if(url.pathname===`/v1/checkout/sessions/${v.cs.id}/line_items`)body={object:'list',has_more:false,data:v.cl};
  else if(url.pathname===`/v1/subscriptions/${v.s.id}`)body=v.s;
  else if(url.pathname==='/v1/subscription_items')body=v.s.items;
  else if(url.pathname===`/v1/invoices/${v.inv.id}`)body=v.inv;
  else if(url.pathname===`/v1/invoices/${v.inv.id}/lines`)body={object:'list',has_more:false,data:v.il};
  else if(url.pathname===`/v1/payment_intents/${v.pi.id}`)body=v.pi;
  else if(url.pathname===`/v1/charges/${v.ch.id}`)body=v.ch;
  else{res.statusCode=400;body={error:{message:'Unexpected synthetic request'}};}
  res.setHeader('content-type','application/json');res.end(JSON.stringify(body));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 try{
  const stripe=new Stripe('sk_test_SYNTHETIC_NO_PROVIDER',{apiVersion:'2023-10-16',host:'127.0.0.1',port:server.address().port,protocol:'http',maxNetworkRetries:0});
  const {recordExistingRetailFunding}=require('../src/services/existingRetailFundingReceipt');
  const r=await recordExistingRetailFunding({db:nativeDb,stripe,agreementId:f.id,intentId:f.intent,eventSessionId:v.cs.id,eventLivemode:false,claimKey:f.key});
  assert.deepEqual(JSON.parse(JSON.stringify(r.receipt)),row(f).retail_funding_receipt);assert.equal(writes.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(r.receipt.proof)),p);assert.equal(row(f).checkout_paid_at,null);
  assert.equal(requests.length,9);assert.ok(requests.every(x=>x.method==='GET'&&x.version==='2023-10-16'));
 }finally{await new Promise(resolve=>server.close(resolve));}
});
