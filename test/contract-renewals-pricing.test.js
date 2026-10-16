'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const clientPath = require.resolve('../src/clients/supabase');
require.cache[clientPath] = { id:clientPath, filename:clientPath, loaded:true, exports:{supabaseAdmin:{}} };
const { processContractRenewals, getRetailRenewalWindow } = require('../src/services/contracts/contractRenewals');
const { buildRetailPackageSnapshot } = require('../src/services/membershipPackageCompatibility');
const { OFFER_VERSION, retailTermWindow } = require('../src/services/membershipOffers');
const {STRIPE_RECURRING_OFFER_VERSION,GENERATION_DATE_OFFER_VERSION}=require('../src/services/membershipOffers');

const ORIGINAL = '2026-01-31T12:13:14.000Z';
const TEMPLATE = 'membership_agreement_retail_terms_v2';
test('notice held or fault leaves current v2 contract accounting unchanged and cannot enter legacy processing',async()=>{
 const names=['../src/services/contracts/contractRenewals','../src/services/existingRetailRecurringPayment',
  '../src/services/existingRetailRenewalPreference','../src/services/contracts/retailRenewalNotice'];
 const files=names.map(require.resolve),saved=files.map(f=>require.cache[f]);
 const readRecipients=require('../src/services/contracts/retailRenewalNotice').configuredNoticeRecipients;
 const priorRecipients=process.env.RETAIL_RENEWAL_NOTICE_ALLOW_RECIPIENTS;
 process.env.RETAIL_RENEWAL_NOTICE_ALLOW_RECIPIENTS='["owner@example.invalid"]';
 try{
  for(const outcome of ['held','throw'])for(const override of [undefined,[],['other@example.invalid'],null]){
   let calls=0,received;
   const exports=[null,{refreshExistingRetailCoverage:async()=>({status:'active'})},
    {reconcileExistingRetailRenewal:async()=>({status:'disabled'})},
    {configuredNoticeRecipients:readRecipients,processRetailRenewalNotice:async args=>{calls++;received=args.allowRecipients;if(outcome==='throw')throw Error('SYNTHETIC mail fault');return{status:'held'};}}];
   delete require.cache[files[0]];
   for(let n=1;n<files.length;n++)require.cache[files[n]]={id:files[n],filename:files[n],loaded:true,exports:exports[n]};
   const f=fixture();f.agreement.template_snapshot.package_snapshot.pricing_version=STRIPE_RECURRING_OFFER_VERSION;
   f.agreement.template_snapshot.package_snapshot.membership_terms.offer_version=STRIPE_RECURRING_OFFER_VERSION;
   const db=makeDb(f),result=await require(names[0]).processContractRenewals({}, {db,now:new Date('2026-03-01T00:00:00Z'),
    ...(override===undefined?{}:{renewalNoticeAllowRecipients:override})});
   assert.deepEqual(received,override===undefined?['owner@example.invalid']:override);
   assert.equal(calls,1);assert.equal(result.summary.skipped_no_action,1);assert.equal(result.summary.errors,0);
   assert.equal(result.summary.renewed,0);assert.equal(result.summary.deactivated,0);assert.equal(db.writes.length,0);
   assert.equal(result.items[0].action,'paid_coverage_refreshed');
  }
 }finally{files.forEach((f,n)=>{if(saved[n])require.cache[f]=saved[n];else delete require.cache[f];});
  if(priorRecipients===undefined)delete process.env.RETAIL_RENEWAL_NOTICE_ALLOW_RECIPIENTS;else process.env.RETAIL_RENEWAL_NOTICE_ALLOW_RECIPIENTS=priorRecipients;}
});
function fixture(months = 3, payment = 'prepaid', index = 0, plan = 'basic') {
  const snapshot = structuredClone(buildRetailPackageSnapshot({planKey:plan, commitmentMonths:months,
    paymentOption:payment, channel:'sales', offerVersion:OFFER_VERSION}));
  const term = retailTermWindow({originalStart:ORIGINAL, commitmentMonths:months, termIndex:index});
  return {
    client:{id:'synthetic-client', name:'Synthetic', plan_tier:plan, billing_interval:snapshot.billing_cadence,
      contract_start_at:term.term_start_at, contract_end_at:term.term_end_at, auto_renew:true,
      billing_status:'active', stripe_subscription_id:'sub_SYNTHETIC', subscription_status:'active', cancel_at_term_end:false},
    agreement:{id:'synthetic-agreement', client_id:'synthetic-client', status:'signed', is_current:true,
      checkout_status:'paid', checkout_paid_at:ORIGINAL, membership_tier:plan, billing_option:snapshot.billing_cadence,
      template_version:TEMPLATE, template_snapshot:{template_version:TEMPLATE, package_snapshot:snapshot}}
  };
}
function makeDb({client, agreement}, behavior = {}) {
  const db = {client:structuredClone(client), agreement:structuredClone(agreement), writes:[], subscriptionWrites:[], reads:[]};
  const keys='contract_start_at,contract_end_at,auto_renew,manual_active_override,billing_status,subscription_status,stripe_subscription_id,stripe_customer_id,cancel_at_term_end,cancel_effective_at,plan_tier,billing_interval,parent_client_id,archived_at'.split(',');
  const projection=()=>({id:db.client.id,...Object.fromEntries(keys.map(k=>[k,db.client[k]??null]))});
  db.rpc=async(name,args)=>{
    assert.equal(name,'apply_legacy_contract_action');
    if(behavior.beforeUpdate){behavior.beforeUpdate(db.client);behavior.beforeUpdate=null;}
    const before=projection(),expected={...before};delete expected.id;
    const result=status=>({data:{status,client:projection()},error:null});
    if(JSON.stringify(expected)!==JSON.stringify(args.p_expected))return result('changed');
    if(behavior.updateError)return{data:null,error:{message:'synthetic update failed'}};
    let payload;
    if(args.p_action==='renew'){
      const start=new Date(db.client.contract_end_at).toISOString(),end=new Date(start);end.setUTCMonth(end.getUTCMonth()+12);
      payload={contract_start_at:start,contract_end_at:end.toISOString()};
    }else if(args.p_action==='deactivate'){
      if(db.client.billing_status==='inactive'&&db.client.cancel_effective_at)return result('unchanged');
      payload={billing_status:'inactive',cancel_effective_at:new Date(db.client.contract_end_at).toISOString()};
    }else if(args.p_action==='check_cancel')return result('permitted');
    else if(args.p_action==='record_cancel')payload={cancel_at_term_end:true};
    else throw Error('Unexpected synthetic action');
    db.writes.push({payload:structuredClone(payload),filters:[['id',db.client.id]]});Object.assign(db.client,payload);
    if(behavior.afterNativeWrite)return behavior.afterNativeWrite(result('applied'),db);
    return result('applied');
  };
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
test('current paid Enterprise scanner refreshes real native coverage bridge before legal expiry without legacy or provider writes',async t=>{
 const f=await require('./helpers/enterprise-renewal-mount-fixture')(t),db=f.native.db;
 db.tables.contract_processing_runs=[];const before=structuredClone(db.tables);
 const result=await processContractRenewals({}, {db,now:new Date('2026-11-01T00:01:03Z'),stripe:f.stripe});
 assert.equal(result.summary.due,0);assert.equal(result.summary.errors,0);assert.equal(result.summary.skipped_no_action,1);
 assert.equal(result.items[0].action,'paid_coverage_refreshed');assert.equal(f.refreshes,1);assert.equal(f.calls.length,0);
 assert.equal(result.items[0].legal_window_status,'unchanged');assert.equal(result.items[0].renewal_request_status,'disabled');
 assert.ok(f.rpcCalls.every(x=>['read_enterprise_existing_billing','refresh_enterprise_existing_paid_coverage'].includes(x.name)));
 assert.deepEqual(db.tables.membership_agreements,before.membership_agreements);assert.deepEqual(db.updates,[]);
});
test('every partial Enterprise marker holds the existing scanner before any legacy action',async()=>{
 for(const field of ['enterprise_checkout_source','enterprise_checkout_pool_id','enterprise_checkout_prices','enterprise_funding_receipt','enterprise_billing_receipt']){
  const f=fixture();f.agreement[field]={synthetic:true};const db=makeDb(f),r=await processContractRenewals({},deps(db));
  assert.equal(r.summary.errors,1);assert.equal(r.summary.renewed,0);assert.equal(r.summary.deactivated,0);
  assert.deepEqual(db.writes,[]);assert.deepEqual(db.subscriptionWrites,[]);
  const selected=db.reads.find(x=>x.table==='membership_agreements').columns;
  for(const marker of ['enterprise_checkout_source','enterprise_checkout_pool_id','enterprise_checkout_prices','enterprise_funding_receipt','enterprise_billing_receipt'])assert.ok(selected.split(',').includes(marker));
 }
});

for(const version of [STRIPE_RECURRING_OFFER_VERSION,GENERATION_DATE_OFFER_VERSION])test(`native ${version} coverage is refreshed before monthly expiry; old scanner retained`,async()=>{
  const f=fixture(3,'monthly_installments'),s=f.agreement.template_snapshot.package_snapshot;
  s.pricing_version=version;s.membership_terms.offer_version=version;
  const db=makeDb(f),calls=[];
  db.rpc=async(name,args)=>{calls.push({name,args});assert.equal(name,'refresh_retail_existing_paid_coverage');
    return{data:{status:'refreshed',billing_status:'inactive',contiguous_ordinal:0},error:null};};
  const result=await processContractRenewals({},deps(db,'2026-02-28T12:13:14.000Z'));
  assert.equal(result.summary.due,0);assert.equal(calls.length,1);assert.equal(result.items[0].action,'paid_coverage_refreshed');
  assert.deepEqual(db.subscriptionWrites,[]);assert.deepEqual(db.writes,[]);
  const old=makeDb(fixture(3,'monthly_installments'));const prior=await processContractRenewals({},deps(old,'2026-02-28T12:13:14.000Z'));
  assert.equal(prior.summary.due,0);assert.deepEqual(old.writes,[]);assert.deepEqual(old.subscriptionWrites,[]);
});

test('held retail renewal retains accepted historical prices without advancing dates',async()=>{
  const f=fixture(); const s=f.agreement.template_snapshot.package_snapshot;
  s.platform_fee=1100; s.platform_fee_cents=110000; s.platform_commitment_total_cents=110000;
  s.membership_terms.platform_payment_cents=110000; s.membership_terms.platform_commitment_total_cents=110000;
  s.membership_terms.initial_payment_cents=110000;
  const db=makeDb(f), result=await processContractRenewals({},deps(db));
  assert.equal(result.summary.held_retail_payment,1);assert.equal(result.summary.renewed,0);
  assert.equal(db.subscriptionWrites.length,0);assert.deepEqual(db.writes,[]);
  assert.deepEqual(db.client,f.client);assert.deepEqual(db.agreement,f.agreement);
});

test('existing scanner holds all retail terms and renewal choices without payment or access claims',async()=>{
  for(const plan of ['basic','pro']) for(const months of [3,6,12])
  for(const payment of ['prepaid','monthly_installments']) for(const renew of [true,false]) {
    const f=fixture(months,payment,0,plan);f.client.auto_renew=renew;
    const db=makeDb(f),d=deps(db);
    d.stripe.subscriptions.retrieve=async()=>{throw Error('No provider read is authorized by this hold');};
    const result=await processContractRenewals({},d);
    assert.deepEqual(result.summary,{scanned:1,due:1,renewed:0,deactivated:0,held_retail_payment:1,
      skipped_manual_override:0,skipped_no_action:0,errors:0});
    assert.deepEqual(result.items,[{id:f.client.id,name:f.client.name,action:'held_retail_payment',
      contract_end_at_before:f.client.contract_end_at,detail:'retail_paid_period_processor_required'}]);
    assert.deepEqual(db.client,f.client);assert.deepEqual(db.agreement,f.agreement);
    assert.deepEqual(db.writes,[]);assert.deepEqual(db.subscriptionWrites,[]);
  }
});

test('legacy renewal and manual override retain their existing behavior',async()=>{
  const f=fixture(); f.client.billing_interval='monthly'; f.agreement=null;
  const db=makeDb(f), result=await processContractRenewals({},deps(db));
  assert.equal(result.summary.renewed,1); assert.equal(db.client.contract_end_at,'2027-04-30T12:13:14.000Z');
  const manual=fixture(); manual.client.manual_active_override=true;
  const m=makeDb(manual), r=await processContractRenewals({},deps(m));
  assert.equal(r.summary.skipped_manual_override,1); assert.equal(m.writes.length,0);
  assert.equal(m.reads.filter(x=>x.table==='membership_agreements').length,1); // Classify before legacy-only override skip.
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

test('retail hold does not enter the legacy client CAS at all',async()=>{
  for (const beforeUpdate of [c=>{c.auto_renew=false;},c=>{c.contract_end_at='2027-04-30T12:13:14.000Z';}]) {
    const f=fixture(),db=makeDb(f,{beforeUpdate}), result=await processContractRenewals({},deps(db));
    assert.equal(result.summary.renewed,0);assert.equal(result.summary.held_retail_payment,1);
    assert.equal(result.summary.skipped_no_action,0);assert.equal(db.writes.length,0);
    assert.deepEqual(db.client,f.client); // The fake update hook was never entered; not a native race test.
  }
});

test('retail hold applies even if local inactive state would otherwise request Stripe alignment',async()=>{
  for(const inactive of [false,true]) for(const canceled of [false,true]) {
    const f=fixture();f.client.auto_renew=false;f.client.cancel_at_term_end=canceled;
    if(inactive){f.client.billing_status='inactive';f.client.cancel_effective_at=f.client.contract_end_at;}
    const db=makeDb(f),result=await processContractRenewals({},deps(db));
    assert.equal(result.summary.deactivated,0);assert.equal(result.summary.held_retail_payment,1);
    assert.equal(result.summary.skipped_no_action,0);assert.deepEqual(db.client,f.client);
    assert.equal(db.writes.length,0);assert.equal(db.subscriptionWrites.length,0);
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

test('retail read and legacy write errors are recorded without provider effects',async()=>{
  for (const behavior of [{loadError:true},{updateError:true}]) {
    const f=fixture();if(behavior.updateError){f.client.billing_interval='monthly';f.agreement=null;}
    const db=makeDb(f,behavior), result=await processContractRenewals({},deps(db));
    assert.equal(result.summary.errors,1); assert.equal(db.writes.length,0); assert.equal(db.subscriptionWrites.length,0);
  }
});

test('retail nonrenewal stays unchanged before expiry and holds after expiry rather than canceling obligations',async()=>{
  const f=fixture(6,'monthly_installments'); f.client.auto_renew=false;
  const before=makeDb(f), early=await processContractRenewals({},deps(before,'2026-03-01T00:00:00.000Z'));
  assert.equal(early.summary.due,0); assert.equal(before.writes.length,0); assert.equal(before.subscriptionWrites.length,0);
  const after=makeDb(f), ended=await processContractRenewals({},deps(after));
  assert.equal(ended.summary.held_retail_payment,1);assert.equal(ended.summary.deactivated,0);
  assert.deepEqual(after.client,f.client);assert.deepEqual(after.writes,[]);assert.deepEqual(after.subscriptionWrites,[]);
});

test('legacy nonrenewal still deactivates and aligns Stripe; provider failure is recorded',async()=>{
  for(const failure of [false,true]){
    const f=fixture();f.client.billing_interval='monthly';f.client.auto_renew=false;f.agreement=null;
    const db=makeDb(f),d=deps(db);if(failure)d.stripe.subscriptions.update=async(id,payload)=>{
      db.subscriptionWrites.push({id,payload});throw Error('synthetic legacy provider failure');};
    const result=await processContractRenewals({},d);
    assert.equal(result.summary.held_retail_payment,0);assert.equal(result.summary.deactivated,1);
    assert.equal(result.summary.errors,failure?1:0);assert.equal(db.client.billing_status,'inactive');
    assert.equal(db.client.cancel_effective_at,f.client.contract_end_at);assert.equal(db.subscriptionWrites.length,1);
    assert.deepEqual(db.subscriptionWrites[0],{id:f.client.stripe_subscription_id,payload:{cancel_at_period_end:true}});
    assert.equal(result.items[0].action,'deactivated');
    if(failure)assert.equal(result.items[0].stripe_alignment_error,'synthetic legacy provider failure');
    else assert.equal(db.client.cancel_at_term_end,true);
  }
});

test('legacy lost/corrupt native ACK stops before Stripe without pretending the local commit rolled back',async()=>{
 for(const extra of [false,true]){
  const f=fixture();f.client.billing_interval='monthly';f.client.auto_renew=false;f.agreement=null;
  const db=makeDb(f,{afterNativeWrite:r=>extra?{data:{...r.data,unknown:true},error:null}:{data:null,error:{message:'synthetic ACK loss'}}});
  const r=await processContractRenewals({},deps(db));assert.equal(r.summary.errors,1);
  assert.equal(r.summary.deactivated,0);assert.deepEqual(db.subscriptionWrites,[]);
  assert.equal(db.client.billing_status,'inactive');assert.equal(db.writes.length,1);
 }
});
