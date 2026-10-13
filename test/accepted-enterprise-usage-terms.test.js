'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');
const fixture=require('./helpers/accepted-enterprise-usage-fixture');
const{loadAcceptedEnterpriseUsageTerms:load}=require('../src/services/acceptedEnterpriseUsageTerms');
const{computeUnbilledUsage:compute,applyUsageToInvoice:apply,createImmediateUsageInvoice:immediate,listBilledUsageInvoices}=require('../src/services/usageBilling');
const {readBillingForClient}=require('../src/services/billingReadModel');
const args=f=>({db:f.db,clientId:f.client.id,allocation:f.allocation,window:'all',asOf:'2026-11-01T00:00:00Z'});
test('strict actual verifier binds accepted historical rate and half-open window, not mutable settings',async()=>{
  for(const cadence of ['monthly','annual']) {
    const f=await fixture({cadence});assert.equal((await load(args(f))).unitPriceCents,2500);
    f.plan.usage_interview_fee_cents=1;const result=await compute(args(f));
    assert.equal(result.total_cents,2500);assert.equal(result.lines[0].unit_price_cents,2500);
    assert.deepEqual(result.missing_completed_at,[]);assert.equal(f.db.calls.some(c=>['update','insert','upsert'].includes(c.op)),false);
  }
});
test('child scope resolves the same parent and preserves entity label',async()=>{
  const f=await fixture();f.db.tables.clients.push({id:'synthetic_child',parent_client_id:f.client.id});
  assert.equal((await load({db:f.db,clientId:'synthetic_child'})).billingClientId,f.client.id);
  assert.equal((await compute({...args(f),clientId:'synthetic_child'})).total_cents,2500);
});
test('the verified accepted pool allocation stays included while only metered excess gets accepted rate',async()=>{
  const f=await fixture();f.allocation.entries.push({...f.entry,interview_id:'pool_iv',source:'pool',source_id:f.a.enterprise_checkout_pool_id});
  assert.equal((await compute(args(f))).total_cents,2500);
});
for(const [name,mutate] of [
  ['customer',f=>{f.client.stripe_customer_id='cus_OTHER';}],['subscription',f=>{f.client.stripe_subscription_id='sub_OTHER';}],
  ['source',f=>{f.a.enterprise_checkout_source.material.customer_id='cus_OTHER';}],
  ['rate',f=>{f.w.plan_initial.usage_interview_fee_cents=0;}],['window',f=>{f.w.client_initial.contract_end_at='2026-10-02T00:00:00.000000Z';}],
  ['unreadable',f=>{f.db.rpc=async()=>({error:{message:'synthetic outage'}});}],
  ['native empty',f=>{f.db.rpc=async()=>({data:null,error:null});}],['missing source',f=>{f.a.enterprise_checkout_source=null;}],
  ['pending',f=>{f.a.checkout_status='pending_payment';}],['notcurrent',f=>{f.a.is_current=false;}],
  ['owner',f=>{f.client.parent_client_id='missing_owner';}],
  ['hidden pending',f=>{f.db.tables.membership_agreements.push({id:'pending_other',client_id:f.client.id,is_current:false,enterprise_checkout_pool_id:'other'});}],
  ['current unmarked',f=>{f.a.is_current=false;f.db.tables.membership_agreements.push({id:'current_other',client_id:f.client.id,is_current:true});}],
  ['duplicate',f=>{f.db.tables.membership_agreements.push(structuredClone(f.a));}]
]) test(`${name} holds read and both writers before provider or ledger effects`,async()=>{
  const f=await fixture();mutate(f);await assert.rejects(load(args(f)),{status:503});
  await assert.rejects(compute(args(f)),{status:503});
  let calls=0;const stripe=new Proxy({}, {get(){calls++;throw Error('provider must remain untouched');}});
  for(const writer of [apply,immediate])await assert.rejects(writer({...args(f),stripe,invoiceId:'in_synthetic'}),{status:503});
  assert.equal(calls,0);assert.equal(f.db.calls.some(c=>c.table==='usage_billing_ledger'),false);
});
test('valid receipt writer fence also precedes already-billed/unstamped reconciliation and ignores mutable billing model',async()=>{
  const f=await fixture();f.plan.billing_model='fixed';f.db.tables.usage_billing_ledger.push({stripe_invoice_id:'in_synthetic',billed_at:null});
  const stripe=new Proxy({}, {get(){throw Error('provider touched');}});
  for(const writer of [apply,immediate])await assert.rejects(writer({...args(f),stripe,invoiceId:'in_synthetic'}),{code:'enterprise_usage_invoice_executor_pending',status:503});
  assert.equal(f.db.calls.some(c=>c.table==='usage_billing_ledger'),false);
  await assert.rejects(readBillingForClient(args(f)),{status:503});
});
for(const [name,mutate] of [
  ['missing time',f=>{f.entry.completed_at=null;}],['invalid time',f=>{f.entry.completed_at='invalid';}],
  ['before term',f=>{f.entry.completed_at='2026-10-01T12:59:59Z';}],['at end',f=>{f.entry.completed_at='2027-10-01T13:00:00Z';}],
  ['own allowance',f=>{f.allocation.included_per_role=1;}],['role allowance',f=>{f.allocation.allowance_by_role.set(f.role.id,1);}],
  ['changed model',f=>{f.allocation.billing_model='fixed';}],['mixed source',f=>{f.entry.source='unknown';}],
  ['foreign pool',f=>{f.entry.source='pool';f.entry.source_id='other_pool';}],['duplicate interview',f=>{f.allocation.entries.push({...f.entry});}],
  ['wrong entity',f=>{f.entry.client_id='foreign';}],['wrong role',f=>{f.entry.role_id='missing_role';}]
])test(`read-only allocation ${name} refuses payable zero or inferred timestamps`,async()=>{
  const f=await fixture();mutate(f);await assert.rejects(compute(args(f)),{status:503});
  assert.equal(f.db.calls.some(c=>['update','insert','upsert'].includes(c.op)),false);
});
test('actual UTC instant selects service month; initial instant included; stored historical ledger price unchanged',async()=>{
  const f=await fixture();f.entry.completed_at='2026-10-01T07:00:00-06:00';
  assert.equal((await compute({...args(f),window:'prior-month'})).total_cents,2500);
  f.db.tables.usage_billing_ledger.push({interview_id:f.entry.interview_id,client_id:f.client.id,role_id:f.role.id,
    unit_price_cents:1111,stripe_invoice_id:'in_historical',stripe_invoice_item_id:'ii_historical',billed_at:'2026-10-04T00:00:00Z',
    period_start:'2026-10-01T00:00:00Z',period_end:'2026-11-01T00:00:00Z'});
  assert.equal((await compute(args(f))).total_cents,0);
  const invoices=await listBilledUsageInvoices(args(f));assert.equal(invoices[0].amount_cents,1111);
});
test('truncated/unreadable census is a hold even with all returned rows unmarked',async()=>{
  const{createFakeSupabase}=require('./helpers/fakeSupabase');
  const rows=[{id:'one',client_id:'payer'},{id:'two',client_id:'payer',enterprise_checkout_pool_id:'marked'}];
  const db=createFakeSupabase({clients:[{id:'payer',parent_client_id:null}],membership_agreements:rows},{maxRows:1});
  await assert.rejects(load({db,clientId:'payer'}),{status:503});
  const old=db.from;db.from=t=>{const q=old(t);if(t==='membership_agreements')q.then=resolve=>resolve({data:[],error:{message:'synthetic outage'},count:null});return q;};
  await assert.rejects(load({db,clientId:'payer'}),{status:503});
});
