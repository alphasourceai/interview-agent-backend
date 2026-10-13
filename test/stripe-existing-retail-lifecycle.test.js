'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const request = require('supertest');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { buildRetailPackageSnapshot } = require('../src/services/membershipPackageCompatibility');
const { OFFER_VERSION, retailTermWindow } = require('../src/services/membershipOffers');
const root = require('node:path').resolve(__dirname, '..');
const ORIGINAL = '2026-01-31T12:13:14.000Z';
const MARKER = 'membership_agreement_retail_terms_v2';
const CLIENT_ID = '44444444-4444-4444-8444-444444444444';
const AGREEMENT_ID = '33333333-3333-4333-8333-333333333333';
function fixture(months=3, payment='prepaid', plan='basic') {
  const pkg=structuredClone(buildRetailPackageSnapshot({planKey:plan, commitmentMonths:months,
    paymentOption:payment, channel:'sales', offerVersion:OFFER_VERSION}));
  const term=retailTermWindow({originalStart:ORIGINAL,commitmentMonths:months,termIndex:1});
  return {pkg, tables:{
    clients:[{id:CLIENT_ID,parent_client_id:null,plan_tier:plan,billing_interval:pkg.billing_cadence,
      stripe_customer_id:'cus_SYNTHETIC',stripe_subscription_id:'sub_SYNTHETIC',subscription_status:'active',
      billing_status:'active',auto_renew:false,cancel_at_term_end:false,cancel_effective_at:null,
      contract_start_at:term.term_start_at,contract_end_at:term.term_end_at}],
    membership_agreements:[{id:AGREEMENT_ID,client_id:CLIENT_ID,status:'signed',is_current:true,checkout_status:'paid',
      checkout_paid_at:ORIGINAL,membership_tier:plan,billing_option:pkg.billing_cadence,template_version:MARKER,
      template_snapshot:{template_version:MARKER,package_snapshot:pkg}}],
    public_purchase_intents:[],billing_events:[],billing_invoices:[],client_plan_settings:[{
      client_id:CLIENT_ID,plan_tier:plan,billing_interval:pkg.billing_cadence,
      platform_fee:pkg.platform_fee,per_role_fee:pkg.per_role_fee,included_interviews_per_role:pkg.included_interviews_per_role,
      additional_interview_fee:pkg.additional_interview_fee,max_interview_minutes:pkg.max_interview_minutes}]},
    subscription:{id:'sub_SYNTHETIC',object:'subscription',customer:'cus_SYNTHETIC',status:'active',currency:'usd',
      start_date:1769644800,current_period_end:1880000000,cancel_at_period_end:false,
      metadata:{source:'agreement_checkout',agreement_id:AGREEMENT_ID,client_id:CLIENT_ID,plan_tier:'pro',billing_interval:'annual'},
      items:{object:'list',has_more:false,data:[{id:'si_SYNTHETIC',subscription:'sub_SYNTHETIC',quantity:1,
        price:{id:'price_SYNTHETIC',object:'price',type:'recurring',currency:'usd',unit_amount:pkg.platform_fee_cents,
          recurring:{interval:'month',interval_count:pkg.membership_terms.stripe_recurrence.interval_count,usage_type:'licensed'}}}]}}
  };
}
function inject(name,exports) {
  const filename=require('node:path').join(root,name);
  require.cache[filename]={id:filename,filename,loaded:true,exports};
}
function load(f,eventType='customer.subscription.updated',options={}) {
  const db=createFakeSupabase(f.tables,options);
  // Project selected columns rather than returning extra fixture data. Also
  // emulate actual maybeSingle cardinality errors for current agreement reads.
  const from=db.from;
  db.from=table=>{
    const q=from(table),select=q.select,one=q.maybeSingle;let columns=null;
    q.select=value=>{columns=value;select(value);return q;};
    q.maybeSingle=async()=>{
      if(table==='membership_agreements'&&f.tables[table].filter(a=>a.client_id===CLIENT_ID&&a.is_current===true).length>1)
        return{data:null,error:{code:'PGRST116',message:'multiple current agreements'}};
      const result=await one();
      if(result.data&&columns&&columns!=='*') result.data=Object.fromEntries(columns.split(',').map(k=>[k,result.data[k]]));
      return result;
    };
    return q;
  };
  const calls=[];
  const sdk={webhooks:{constructEvent:()=>({id:'evt_SYNTHETIC',type:eventType,created:1900000000,
    data:{object:eventType.startsWith('invoice.')?{id:'in_SYNTHETIC',customer:'cus_SYNTHETIC',subscription:'sub_SYNTHETIC',
      billing_reason:'subscription_cycle',status:'paid',paid:true,amount_paid:f.pkg.platform_fee_cents,total:f.pkg.platform_fee_cents,
      currency:'usd',metadata:{}}:{...f.subscription,...options.eventOverride}}})},
    subscriptions:{retrieve:async id=>{calls.push(id);if(options.providerError)throw Error('synthetic provider unavailable');return structuredClone(f.subscription);}}};
  inject('src/clients/supabase.js',{supabaseAdmin:db,supabase:db,supabaseAnon:db});
  inject('src/clients/stripe.js',sdk);
  const routePath=require('node:path').join(root,'src/routes/webhooks/stripe.js'); delete require.cache[routePath];
  const app=express(); app.use('/webhook/stripe',express.raw({type:'application/json'}),require(routePath));
  return{app,db,calls};
}
const post=app=>request(app).post('/webhook/stripe').set('content-type','application/json').send('{}');
function commercialWrites(db){return db.calls.filter(c=>['clients','client_plan_settings'].includes(c.table)&&['update','upsert','insert'].includes(c.op));}

test('existing subscription updates preserve every accepted term, cadence and disabled renewal',async()=>{
  for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments']) {
    const f=fixture(months,payment,plan), before=structuredClone(f.tables.clients[0]), settingsBefore=structuredClone(f.tables.client_plan_settings),{app,db,calls}=load(f);
    assert.equal((await post(app)).status,200);
    const client=f.tables.clients[0];
    for(const key of ['contract_start_at','contract_end_at','auto_renew','cancel_at_term_end','cancel_effective_at','plan_tier','billing_interval'])
      assert.equal(client[key],before[key],key);
    assert.equal(commercialWrites(db).some(c=>c.table==='client_plan_settings'),false);
    assert.deepEqual(f.tables.client_plan_settings,settingsBefore);
    assert.equal(calls.length,1);
  }
});

test('ordinary paid renewal invoices do not rerun first activation or overwrite original contract dates',async()=>{
  const f=fixture(6,'monthly_installments'),before=structuredClone(f.tables.clients[0]),{app,db}=load(f,'invoice.payment_succeeded');
  assert.equal((await post(app)).status,200);
  for(const key of ['contract_start_at','contract_end_at','auto_renew','billing_interval'])assert.equal(f.tables.clients[0][key],before[key]);
  assert.equal(db.calls.some(c=>c.table==='client_members'||c.table==='client_role_credits'),false);
  assert.equal(db.calls.some(c=>c.table==='membership_agreements'&&c.op==='update'),false);
});

test('failed renewal and deleted-subscription sync retain contract and renewal preference',async()=>{
  for(const eventType of ['invoice.payment_failed','customer.subscription.deleted']) {
    const f=fixture(12,'monthly_installments'); f.subscription.status=eventType.startsWith('invoice.')?'past_due':'canceled';
    const before=structuredClone(f.tables.clients[0]),{app,db}=load(f,eventType);
    assert.equal((await post(app)).status,200);assert.equal(f.tables.clients[0].billing_status,'inactive');
    for(const key of ['contract_start_at','contract_end_at','auto_renew','billing_interval','cancel_at_term_end','cancel_effective_at'])
      assert.equal(f.tables.clients[0][key],before[key]);
    assert.equal(commercialWrites(db).some(c=>c.table==='client_plan_settings'),false);
  }
});

test('accepted historical amounts survive provider lifecycle without catalog repricing',async()=>{
  const f=fixture(),s=f.tables.membership_agreements[0].template_snapshot.package_snapshot;
  s.platform_fee=1100;s.platform_fee_cents=110000;s.platform_commitment_total_cents=110000;
  s.membership_terms.platform_payment_cents=110000;s.membership_terms.platform_commitment_total_cents=110000;
  s.membership_terms.initial_payment_cents=110000;
  f.tables.client_plan_settings[0].platform_fee=1100;f.subscription.items.data[0].price.unit_amount=110000;
  const {app,db}=load(f);assert.equal((await post(app)).status,200);
  assert.equal(f.tables.client_plan_settings[0].platform_fee,1100);
  assert.equal(commercialWrites(db).some(c=>c.table==='client_plan_settings'),false);
});

test('current provider readback, not an old event snapshot, controls new subscription status',async()=>{
  const f=fixture();f.subscription.status='past_due';
  const {app,db}=load(f,'customer.subscription.updated',{eventOverride:{status:'active'}});
  assert.equal((await post(app)).status,200);assert.equal(f.tables.clients[0].subscription_status,'past_due');
  assert.equal(f.tables.clients[0].billing_status,'inactive');assert.equal(f.tables.clients[0].auto_renew,false);
  assert.equal(commercialWrites(db).some(c=>c.table==='client_plan_settings'),false);
});

test('pending new agreements defer generic subscription grants to existing initial-payment activation',async()=>{
  const f=fixture();f.tables.membership_agreements[0].checkout_status='pending_payment';
  f.tables.membership_agreements[0].checkout_paid_at=null;
  const {app,db}=load(f);assert.equal((await post(app)).status,200);assert.equal(commercialWrites(db).length,0);
});

test('wrong new subscription or accepted-source details refuse without commercial writes',async()=>{
  const changes=[f=>{f.subscription.customer='cus_OTHER';},f=>{f.subscription.id='sub_OTHER';},
    f=>{f.subscription.items.has_more=true;},f=>{f.subscription.status='unexpected';},f=>{f.subscription.items.data[0].quantity=2;},
    f=>{f.subscription.items.data[0].price.unit_amount+=1;},f=>{f.subscription.items.data[0].price.currency='eur';},
    f=>{f.subscription.items.data[0].price.recurring.interval_count=1;},
    f=>{f.tables.membership_agreements[0].template_version='legacy';},
    f=>{f.tables.membership_agreements[0].checkout_paid_at=null;},f=>{f.tables.membership_agreements=[];},
    f=>{f.tables.membership_agreements[0].template_snapshot.package_snapshot.membership_terms.commitment_months=9;},
    f=>{f.tables.membership_agreements.push(structuredClone(f.tables.membership_agreements[0]));}];
  for(const change of changes){const f=fixture();change(f);const {app,db}=load(f,'customer.subscription.updated',{
    eventOverride:{id:'sub_SYNTHETIC',customer:'cus_SYNTHETIC'}});
    const result=await post(app);assert.equal(result.status,500);assert.equal(commercialWrites(db).length,0);}
});

test('new lifecycle provider failure stays retryable with no price/contract writes',async()=>{
  const {app,db}=load(fixture(),'customer.subscription.updated',{providerError:true});
  assert.equal((await post(app)).status,500);assert.equal(commercialWrites(db).length,0);
});

test('a concurrent subscription or contract replacement cannot be overwritten by the old event',async()=>{
  for(const change of [c=>{c.stripe_subscription_id='sub_REPLACED';},c=>{c.contract_end_at='2030-01-01T00:00:00Z';}]) {
    const f=fixture();const {app,db}=load(f,'customer.subscription.updated',{beforeUpdate(table,patch,rows){
      if(table==='clients')change(rows[0]);
    }});
    assert.equal((await post(app)).status,500);
    assert.equal(f.tables.clients[0].current_term_end,undefined);
    assert.equal(commercialWrites(db).some(c=>c.table==='client_plan_settings'),false);
    assert.equal(f.tables.billing_events.length,0);
  }
});

test('existing legacy subscription sync retains its old dates, defaults and metadata behavior',async()=>{
  const f=fixture();f.tables.membership_agreements=[];f.tables.clients[0].billing_interval='monthly';
  f.subscription.items.data[0].price.recurring.interval_count=1;
  delete f.subscription.metadata.agreement_id;f.subscription.metadata.source='admin_subscription_checkout';
  const {app,db}=load(f);assert.equal((await post(app)).status,200);
  assert.equal(f.tables.clients[0].auto_renew,true);assert.equal(f.tables.clients[0].plan_tier,'pro');
  assert.equal(f.tables.clients[0].billing_interval,'monthly');
  assert.equal(commercialWrites(db).find(c=>c.table==='client_plan_settings').payload.platform_fee,6499);
});
