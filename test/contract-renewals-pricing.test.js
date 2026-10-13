'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const clientPath = require.resolve('../src/clients/supabase');
require.cache[clientPath] = { id:clientPath, filename:clientPath, loaded:true, exports:{supabaseAdmin:{}} };
const { processContractRenewals, getRetailRenewalWindow } = require('../src/services/contracts/contractRenewals');
const { buildRetailPackageSnapshot } = require('../src/services/membershipPackageCompatibility');
const { OFFER_VERSION, retailTermWindow } = require('../src/services/membershipOffers');

const ORIGINAL = '2026-01-31T12:13:14.000Z';
const TEMPLATE = 'membership_agreement_retail_terms_v2';
function fixture(months = 3, payment = 'prepaid', index = 0) {
  const snapshot = structuredClone(buildRetailPackageSnapshot({planKey:'basic', commitmentMonths:months,
    paymentOption:payment, channel:'sales', offerVersion:OFFER_VERSION}));
  const term = retailTermWindow({originalStart:ORIGINAL, commitmentMonths:months, termIndex:index});
  return {
    client:{id:'synthetic-client', name:'Synthetic', plan_tier:'basic', billing_interval:snapshot.billing_cadence,
      contract_start_at:term.term_start_at, contract_end_at:term.term_end_at, auto_renew:true,
      billing_status:'active', stripe_subscription_id:'sub_SYNTHETIC', subscription_status:'active', cancel_at_term_end:false},
    agreement:{id:'synthetic-agreement', client_id:'synthetic-client', status:'signed', is_current:true,
      checkout_status:'paid', checkout_paid_at:ORIGINAL, membership_tier:'basic', billing_option:snapshot.billing_cadence,
      template_version:TEMPLATE, template_snapshot:{template_version:TEMPLATE, package_snapshot:snapshot}}
  };
}
function makeDb({client, agreement}, behavior = {}) {
  const db = {client:structuredClone(client), agreement:structuredClone(agreement), writes:[], subscriptionWrites:[], reads:[]};
  db.from = table => {
    const q = {filters:[], payload:null, selected:null,
      select(columns) { this.selected=columns; db.reads.push({table,columns}); return this; },
      eq(column,value) { this.filters.push([column,value]); return this; },
      insert(payload) { this.payload=payload; return this; },
      update(payload) { this.payload=payload; return this; },
      maybeSingle() { return this.run(true); },
      then(resolve,reject) { return this.run(false).then(resolve,reject); },
      async run(single) {
        if (table === 'contract_processing_runs') return {data:single?{id:'synthetic-run'}:null,error:null};
        if (table === 'membership_agreements') return {data:db.agreement,error:behavior.loadError?{message:'synthetic read failed'}:null};
        if (table !== 'clients') throw Error('Unexpected table');
        if (!this.payload) return {data:[structuredClone(db.client)],error:null};
        if (behavior.beforeUpdate) { behavior.beforeUpdate(db.client); behavior.beforeUpdate=null; }
        if (behavior.updateError) return {data:null,error:{message:'synthetic update failed'}};
        const matched = this.filters.every(([key,value])=>db.client[key]===value);
        if (matched) { db.writes.push({payload:structuredClone(this.payload),filters:this.filters}); Object.assign(db.client,this.payload); }
        return {data:single?(matched?{id:db.client.id}:null):(this.selected?(matched?[{id:db.client.id}]:[]):null),error:null};
      }
    };
    return q;
  };
  return db;
}
function deps(db, now = '2027-02-01T00:00:00.000Z') {
  return {db, now:new Date(now), stripe:{subscriptions:{update:async(id,payload)=>{db.subscriptionWrites.push({id,payload});return{id};}}}};
}

test('accepted 3/6/12 prepaid and installment renewals keep the original UTC anchor',()=>{
  for (const months of [3,6,12]) for (const payment of ['prepaid','monthly_installments']) for (const index of [0,1,3]) {
    const f=fixture(months,payment,index), next=getRetailRenewalWindow(f.client,f.agreement);
    assert.equal(next.term_start_at,f.client.contract_end_at);
    assert.equal(next.term_end_at,retailTermWindow({originalStart:ORIGINAL,commitmentMonths:months,termIndex:index+1}).term_end_at);
  }
  const f=fixture(3); assert.equal(getRetailRenewalWindow(f.client,f.agreement).term_end_at,'2026-07-31T12:13:14.000Z');
});

test('accepted historical prices are not re-priced by a renewal',async()=>{
  const f=fixture(); const s=f.agreement.template_snapshot.package_snapshot;
  s.platform_fee=1100; s.platform_fee_cents=110000; s.platform_commitment_total_cents=110000;
  s.membership_terms.platform_payment_cents=110000; s.membership_terms.platform_commitment_total_cents=110000;
  s.membership_terms.initial_payment_cents=110000;
  const db=makeDb(f), result=await processContractRenewals({},deps(db));
  assert.equal(result.summary.renewed,1); assert.equal(db.subscriptionWrites.length,0);
  assert.deepEqual(Object.keys(db.writes[0].payload).sort(),['contract_end_at','contract_start_at']);
});

test('existing processor renews each new term without creating payments or replacing Stripe prices',async()=>{
  for (const months of [3,6,12]) for (const payment of ['prepaid','monthly_installments']) {
    const f=fixture(months,payment), db=makeDb(f), result=await processContractRenewals({},deps(db));
    assert.equal(result.summary.renewed,1);
    assert.equal(db.client.contract_end_at,getRetailRenewalWindow(f.client,f.agreement).term_end_at);
    assert.equal(db.subscriptionWrites.length,0);
    assert.ok(db.writes[0].filters.some(([k,v])=>k==='auto_renew'&&v===true));
  }
});

test('legacy renewal and manual override retain their existing behavior',async()=>{
  const f=fixture(); f.client.billing_interval='monthly'; f.agreement=null;
  const db=makeDb(f), result=await processContractRenewals({},deps(db));
  assert.equal(result.summary.renewed,1); assert.equal(db.client.contract_end_at,'2027-04-30T12:13:14.000Z');
  const manual=fixture(); manual.client.manual_active_override=true;
  const m=makeDb(manual), r=await processContractRenewals({},deps(m));
  assert.equal(r.summary.skipped_manual_override,1); assert.equal(m.writes.length,0);
  assert.equal(m.reads.filter(x=>x.table==='membership_agreements').length,0);
});

test('invalid new accepted terms never fall back to a 12-month renewal',async()=>{
  const changes=[f=>{f.agreement=null;}, f=>{f.agreement.checkout_paid_at=null;},
    f=>{f.agreement.checkout_status='pending_payment';}, f=>{f.agreement.status='sent';},
    f=>{f.agreement.client_id='other';}, f=>{f.agreement.superseded_by_agreement_id='newer';},
    f=>{f.agreement.is_current=false;}, f=>{f.agreement.template_version='legacy';},
    f=>{f.agreement.template_snapshot.template_version='legacy';}, f=>{f.client.plan_tier='pro';},
    f=>{f.client.billing_interval='annual';}, f=>{f.client.contract_start_at='2026-02-01T12:13:14.000Z';},
    f=>{f.client.contract_end_at='2026-05-01T12:13:14.000Z';},
    f=>{f.agreement.template_snapshot.package_snapshot.membership_terms.commitment_months=9;}];
  for (const change of changes) {
    const f=fixture(); change(f); const db=makeDb(f), result=await processContractRenewals({},deps(db));
    assert.equal(result.summary.errors,1); assert.equal(db.writes.length,0); assert.equal(db.subscriptionWrites.length,0);
  }
});

test('new renewal concurrency no-ops are not counted as successful renewals',async()=>{
  for (const beforeUpdate of [c=>{c.auto_renew=false;},c=>{c.contract_end_at='2027-04-30T12:13:14.000Z';}]) {
    const db=makeDb(fixture(),{beforeUpdate}), result=await processContractRenewals({},deps(db));
    assert.equal(result.summary.renewed,0); assert.equal(result.summary.skipped_no_action,1); assert.equal(db.writes.length,0);
  }
});

test('a stale non-renewal decision cannot deactivate a changed term or cancel its Stripe subscription',async()=>{
  for (const beforeUpdate of [c=>{c.auto_renew=true;}, c=>{c.contract_end_at='2027-04-30T12:13:14.000Z';},
    c=>{c.contract_start_at='2026-04-30T12:13:14.000Z';}]) {
    const f=fixture(); f.client.auto_renew=false;
    const db=makeDb(f,{beforeUpdate}), result=await processContractRenewals({},deps(db));
    assert.equal(result.summary.deactivated,0); assert.equal(result.summary.skipped_no_action,1);
    assert.equal(db.writes.length,0); assert.equal(db.subscriptionWrites.length,0);
  }
});

test('database timestamp representations are compared as instants, including leap anchors',()=>{
  const f=fixture(3,'monthly_installments',1);
  f.agreement.checkout_paid_at='2026-01-31T12:13:14+00:00';
  f.client.contract_start_at='2026-04-30T06:13:14-06:00';
  f.client.contract_end_at='2026-07-31T12:13:14+00:00';
  assert.equal(getRetailRenewalWindow(f.client,f.agreement).term_end_at,'2026-10-31T12:13:14.000Z');
  const leap=fixture(12); leap.agreement.checkout_paid_at='2024-02-29T12:13:14+00:00';
  leap.client.contract_start_at='2027-02-28T12:13:14+00:00';
  leap.client.contract_end_at='2028-02-29T12:13:14+00:00';
  assert.equal(getRetailRenewalWindow(leap.client,leap.agreement).term_end_at,'2029-02-28T12:13:14.000Z');
});

test('read/write errors are recorded without provider effects',async()=>{
  for (const behavior of [{loadError:true},{updateError:true}]) {
    const db=makeDb(fixture(),behavior), result=await processContractRenewals({},deps(db));
    assert.equal(result.summary.errors,1); assert.equal(db.writes.length,0); assert.equal(db.subscriptionWrites.length,0);
  }
});

test('non-renewal preserves access until commitment end then uses existing deactivation',async()=>{
  const f=fixture(6,'monthly_installments'); f.client.auto_renew=false;
  const before=makeDb(f), early=await processContractRenewals({},deps(before,'2026-03-01T00:00:00.000Z'));
  assert.equal(early.summary.due,0); assert.equal(before.writes.length,0); assert.equal(before.subscriptionWrites.length,0);
  const after=makeDb(f), ended=await processContractRenewals({},deps(after));
  assert.equal(ended.summary.deactivated,1); assert.equal(after.client.billing_status,'inactive');
  assert.equal(after.client.cancel_effective_at,f.client.contract_end_at);
  assert.equal(after.subscriptionWrites.length,1);
});
