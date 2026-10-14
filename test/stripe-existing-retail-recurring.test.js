'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express'),request=require('supertest');
const {recurringFixture}=require('./fixtures/existing-retail-recurring-funding-fixture');
const {createFakeSupabase}=require('./helpers/fakeSupabase');
const {anchoredMonthInstant}=require('../src/services/membershipOffers');
function inject(name,value){const p=require.resolve(name);require.cache[p]={id:p,filename:p,loaded:true,exports:value};}
function setup(options={}){
  const f=recurringFixture('basic',3,'monthly_installments',true),s=f.source,p=s.original_period,
    client={id:s.client_id,stripe_customer_id:p.customer_id,stripe_subscription_id:p.subscription_id,
      plan_tier:'basic',billing_interval:'monthly',billing_status:'inactive',auto_renew:true,subscription_status:'past_due',
      contract_start_at:p.paid_at,contract_end_at:anchoredMonthInstant(p.paid_at,3)},
    agreement={id:s.agreement_id,client_id:s.client_id,is_current:true,status:'signed',checkout_status:'paid',checkout_paid_at:p.paid_at,
      membership_tier:'basic',billing_option:'monthly',template_version:'membership_agreement_retail_terms_v2',
      template_snapshot:{template_version:'membership_agreement_retail_terms_v2',package_snapshot:s.package_snapshot}};
  const tables={clients:[client],membership_agreements:[agreement],public_purchase_intents:[],billing_events:[],billing_invoices:[],
    client_members:[],client_plan_settings:[],client_role_credits:[]},db=createFakeSupabase(tables),rpcs=[],records=new Map();
  let lost=options.lostAck===true,failedRefresh=options.failedRefresh===true,event;
  db.rpc=async(name,args)=>{
    rpcs.push({name,args:structuredClone(args)});
    if(name==='read_retail_existing_recurring_source')return{data:structuredClone(s),error:null};
    if(name==='record_retail_existing_paid_period'){
      let r=records.get(args.p_proof.invoice_id),status='already_recorded';
      if(!r){status='recorded';r={invoice_id:crypto.randomUUID(),receipt:{version:'retail_existing_paid_period_receipt_v1',
        source:structuredClone(args.p_source),source_digest:'a'.repeat(32),proof:structuredClone(args.p_proof),recorded_at:new Date().toISOString()}};
        records.set(args.p_proof.invoice_id,r);}
      if(lost){lost=false;throw Error('synthetic lost native ACK');}return{data:{...r,status},error:null};
    }
    if(name==='refresh_retail_existing_paid_coverage'){
      if(failedRefresh){failedRefresh=false;throw Error('synthetic refresh ACK');}
      client.billing_status=options.coverageStatus||'active';return{data:{status:'refreshed',billing_status:client.billing_status},error:null};
    }
    throw Error('Initial activation/Auth RPC forbidden: '+name);
  };
  f.sdk.subscriptions={async retrieve(){return {id:p.subscription_id,object:'subscription',customer:p.customer_id,status:options.providerStatus||'active',
    currency:'usd',current_period_end:f.cycle.provider_period_end,items:{object:'list',has_more:false,data:[{id:p.subscription_item_id,
      subscription:p.subscription_id,quantity:1,price:structuredClone(f.invoiceLines.data[0].price)}]}};}};
  f.sdk.webhooks={constructEvent:()=>event};
  inject('../src/clients/supabase',{supabaseAdmin:db});inject('../src/clients/stripe',f.sdk);
  inject('../src/services/publicPurchaseActivation',{activatePublicPurchaseAgreementCheckout(){throw Error('No initial activation');}});
  inject('../src/services/existingEnterprisePaymentWebhook',{classifyExistingEnterprisePaymentEvent:async()=>null});
  const path=require.resolve('../src/routes/webhooks/stripe');delete require.cache[path];
  const app=express();app.use('/webhook/stripe',express.raw({type:'application/json'}),require(path));
  const post=async(type,id='evt_CYCLE')=>{
    event={id,type,livemode:false,data:{object:type.startsWith('customer.subscription.')?
      {id:p.subscription_id,customer:p.customer_id,status:'trialing'}:structuredClone(f.invoice)}};
    return request(app).post('/webhook/stripe').set('content-type','application/json').send('{}');
  };
  return{f,db,tables,records,rpcs,client,agreement,post};
}
for(const order of [['invoice.paid','invoice.payment_succeeded'],['invoice.payment_succeeded','invoice.paid']])
test(`new native recurring ${order.join(' then ')} stores once, refreshes twice, creates no account`,async()=>{
  const x=setup();for(const[type,id]of order.map((t,i)=>[t,'evt_'+i]))assert.equal((await x.post(type,id)).status,200);
  assert.equal(x.records.size,1);assert.equal(x.rpcs.filter(r=>r.name==='record_retail_existing_paid_period').length,2);
  assert.equal(x.rpcs.filter(r=>r.name==='refresh_retail_existing_paid_coverage').length,2);
  assert.ok(x.tables.billing_events.every(e=>e.processed_ok===true));
  assert.equal(x.db.calls.filter(c=>['client_members','client_role_credits','client_plan_settings'].includes(c.table)).length,0);
});
for(const mode of ['lostAck','failedRefresh'])test(`new recurring ${mode} retains incomplete event and original receipt on retry`,async()=>{
  const x=setup({[mode]:true});assert.equal((await x.post('invoice.paid')).status,503);
  assert.equal(x.tables.billing_events.length,1);assert.equal(x.tables.billing_events[0].processed_ok,false);assert.equal(x.records.size,1);
  const original=structuredClone([...x.records.values()][0]);assert.equal((await x.post('invoice.paid')).status,200);
  assert.deepEqual([...x.records.values()][0],original);assert.equal(x.tables.billing_events[0].processed_ok,true);
});
test('provider failure, foreign pointer and malformed new cohort hold before legacy status writers',async()=>{
  for(const kind of ['provider','pointer','pending','bad']){
    const x=setup();if(kind==='provider')x.f.sdk.charges.retrieve=async()=>{throw Error('PRIVATE_TOKEN');};
    if(kind==='pointer')x.client.stripe_subscription_id='sub_OTHER';
    if(kind==='pending')x.agreement.checkout_status='pending_payment';
    if(kind==='bad')x.agreement.template_snapshot.package_snapshot.membership_terms.commitment_months=9;
    const r=await x.post('invoice.payment_succeeded');assert.equal(r.status,503);
    assert.equal(x.records.size,0);assert.equal(x.client.billing_status,'inactive');
    assert.equal(x.db.calls.filter(c=>c.table==='clients'&&c.op==='update').length,0);
    assert.ok(!JSON.stringify(r.body).includes('PRIVATE_TOKEN'));
  }
});
for(const type of ['customer.subscription.updated','customer.subscription.deleted','invoice.payment_failed'])
test(`${type} cannot grant new version access from Stripe active/trialing`,async()=>{
  const x=setup({coverageStatus:'inactive',providerStatus:'active'}),before=structuredClone(x.client);
  assert.equal((await x.post(type)).status,200);assert.equal(x.client.billing_status,'inactive');
  for(const k of ['contract_start_at','contract_end_at','auto_renew','plan_tier','billing_interval'])assert.equal(x.client[k],before[k]);
  assert.equal(x.client.subscription_status,'active');
  const updates=x.db.calls.filter(c=>c.table==='clients'&&c.op==='update');
  assert.ok(updates.every(c=>!Object.hasOwn(c.payload||{},'billing_status')));
  assert.equal(x.records.size,0);assert.equal(x.rpcs.filter(r=>r.name==='refresh_retail_existing_paid_coverage').length,1);
});
