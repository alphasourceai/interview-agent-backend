'use strict';
// Authored RPC replies exercise the real JS boundary, NOT native funding,
// historical legal admission, Stripe cash, hosted delivery or access.
const { test } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const fixture = require('./helpers/accepted-enterprise-usage-fixture');
const { verifyExistingEnterpriseLegalWindow: verify, readExistingEnterpriseLegalWindow: read } = require('../src/services/existingEnterpriseLegalWindow');
const { loadAcceptedEnterpriseUsageTerms: terms } = require('../src/services/acceptedEnterpriseUsageTerms');
const { computeUnbilledUsage } = require('../src/services/usageBilling');
const args = f => ({ agreement: f.a, billingReceipt: f.w });
function later(f) {
  Object.assign(f.legal, { term_index: 1, term_start_at: f.w.client_initial.contract_end_at,
    term_end_at: '2028-10-01T13:00:00.000000Z', notice_cutoff_at: '2028-09-01T13:00:00.000000Z',
    funded_through: '2027-11-01T00:00:00.000000Z', observed_at: '2027-10-02T00:00:00.000000Z' });
}
test('read-only native window consumer keeps original cash and source, exact RPC identity and no effects', async () => {
  const f = await fixture(), calls = [], rpc = f.db.rpc;
  f.db.rpc = async (name,p) => { calls.push({ name,p }); return rpc(name,p); };
  const before = structuredClone(f.legal), out = await read({ db: f.db, ...args(f) });
  assert.deepEqual(calls, [
    { name: 'read_enterprise_existing_legal_window', p: { p_agreement: f.a.id, p_client: f.client.id } },
    { name: 'read_enterprise_existing_billing', p: { p_agreement: f.a.id } }
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), before); assert.deepEqual(f.legal, before); assert.equal(Object.isFrozen(out),true);
  assert.equal(f.db.calls.some(c => ['insert','update','upsert','delete'].includes(c.op)),false);
});
test('later read-only usage keeps ORIGINAL S, pool and accepted rate while using native current E, not mutable client dates', async () => {
  const f = await fixture(); later(f);
  f.client.contract_start_at = f.legal.term_start_at; f.client.contract_end_at = '2099-01-01T00:00:00Z';
  f.plan.usage_interview_fee_cents = 1;
  const got = await terms({ db: f.db, clientId: f.client.id });
  assert.equal(got.start,Date.parse(f.w.client_initial.contract_start_at));
  assert.equal(got.end,Date.parse(f.legal.term_end_at)); assert.equal(got.poolId,f.w.funding_receipt.proof.pool_id);
  assert.equal(got.unitPriceCents,2500);
  f.allocation.entries.push({ ...f.entry, interview_id: 'later_synthetic', completed_at: '2027-10-01T13:00:00Z' });
  const result = await computeUnbilledUsage({ db:f.db, clientId:f.client.id, allocation:f.allocation, window:'all', asOf:'2027-11-01T00:00:00Z' });
  assert.equal(result.total_cents,5000); // Old owed usage survives alongside later usage.
  f.allocation.entries.at(-1).completed_at = f.legal.term_end_at;
  await assert.rejects(computeUnbilledUsage({ db:f.db, clientId:f.client.id, allocation:f.allocation, window:'all' }),{status:503});
});
test('accepted OFF in a later window retains continuous service and terminal E without inventing provider cancellation', async () => {
  const f = await fixture(); later(f);
  f.legal.auto_renew=false; f.legal.accepted_operation_id=crypto.randomUUID();
  f.legal.funded_through='2029-01-01T00:00:00.000000Z'; f.legal.observed_at='2028-11-01T00:00:00.000000Z';
  const out=verify(f.legal,args(f)); assert.equal(out.term_index,1); assert.equal(out.term_end_at,'2028-10-01T13:00:00.000000Z');
  assert.equal(out.provider_effect_authorized,false); assert.equal(Object.hasOwn(out,'cancel_at'),false);
});
test('original-end leap anniversaries retain microseconds rather than iteratively clamping', async () => {
  const f=await fixture();
  f.w.client_initial.contract_start_at='2019-02-28T12:13:14.123456Z'; f.w.client_initial.contract_end_at='2020-02-29T12:13:14.123456Z';
  f.w.funding_receipt.proof.payment_success_at='2019-03-01T13:00:00.000Z'; f.w.applied_at='2019-03-01T13:00:00.123456Z';
  Object.assign(f.legal,{term_index:4,initial_term_start:f.w.client_initial.contract_start_at,original_term_end:f.w.client_initial.contract_end_at,
    term_start_at:'2023-02-28T12:13:14.123456Z',term_end_at:'2024-02-29T12:13:14.123456Z',notice_cutoff_at:'2024-01-30T12:13:14.123456Z',
    observed_at:'2023-04-01T00:00:00.000000Z',funded_from:'2019-03-01T13:00:00.000000Z',funded_through:'2023-05-01T00:00:00.000000Z'});
  // Pure geometry composition only; original financial verifier is deliberately
  // not claimed for these authored historical dates.
  assert.equal(verify(f.legal,args(f)).term_end_at,'2024-02-29T12:13:14.123456Z');
});
for (const [name,change] of [
  ['extra authority',w=>{w.authorized=true;}],['wrong version',w=>{w.version='unknown';}],
  ['wrong agreement',w=>{w.agreement_id=crypto.randomUUID();}],['wrong owner',w=>{w.client_id=crypto.randomUUID();}],
  ['empty digest',w=>{w.billing_source_digest='';}],['string ordinal',w=>{w.term_index='0';}],
  ['negative ordinal',w=>{w.term_index=-1;}],['large ordinal',w=>{w.term_index=1000;}],
  ['missing original',w=>{delete w.initial_term_start;}],['changed original',w=>{w.original_term_end='2027-10-02T13:00:00.000000Z';}],
  ['initial reset',w=>{w.term_start_at=w.original_term_end;}],['future geometry',w=>{w.term_end_at='2099-01-01T00:00:00.000000Z';}],
  ['wrong notice',w=>{w.notice_cutoff_at=w.term_end_at;}],['missing journal',w=>{w.auto_renew=false;}],
  ['unknown operation',w=>{w.accepted_operation_id='';}],['cash reset',w=>{w.funded_from='2026-10-02T13:00:00.000000Z';}],
  ['no coverage',w=>{w.funded_through=w.funded_from;}],['old observation',w=>{w.observed_at='2026-10-01T13:00:00.000000Z';}],
  ['invalid date',w=>{w.observed_at='2026-02-30T00:00:00.000000Z';}],['ms-only native clock',w=>{w.observed_at='2026-10-16T06:00:00.000Z';}],
  ['provider authority',w=>{w.provider_effect_authorized=true;}],['access authority',w=>{w.paid_access_authorized=true;}],
  ['payroll authority',w=>{w.payroll_authorized=true;}]
]) test(`native window ${name} holds the reader and usage read without a legacy fallback`,async()=>{
  const f=await fixture();change(f.legal);assert.throws(()=>verify(f.legal,args(f)),{code:'enterprise_legal_window_unverified'});
  await assert.rejects(terms({db:f.db,clientId:f.client.id}),{status:503});
  assert.equal(f.db.calls.some(c=>['insert','update','upsert','delete'].includes(c.op)),false);
});
test('later-year unfunded boundary, premature observation or unadvanced term cannot create continuity',async()=>{
  for(const patch of [
    {funded_through:'2027-10-01T13:00:00.000000Z'},
    {observed_at:'2027-09-30T13:00:00.000000Z'},
    {term_index:0,term_start_at:'2026-10-01T13:00:00.000000Z',term_end_at:'2027-10-01T13:00:00.000000Z',notice_cutoff_at:'2027-09-01T13:00:00.000000Z'}
  ]){const f=await fixture();later(f);Object.assign(f.legal,patch);assert.throws(()=>verify(f.legal,args(f)),{status:503});}
});
test('missing or drifted frozen notice holds rather than inventing a default',async()=>{
  for(const change of [f=>{delete f.a.enterprise_checkout_source.material.template_snapshot.values.notice_deadline_plain;},
    f=>{f.a.notice_deadline_days=31;},f=>{f.a.enterprise_checkout_source.material.template_snapshot.values.notice_deadline_days='30 days';}]){
    const f=await fixture();change(f);assert.throws(()=>verify(f.legal,args(f)),{status:503});
  }
});
test('canonical producer notice snapshot without a display-only plain field retains accepted cutoff',async()=>{
  const f=await fixture(),v=f.a.enterprise_checkout_source.material.template_snapshot.values;
  delete v.notice_deadline_plain;v.notice_deadline_days='30';
  const before=structuredClone(v);
  assert.equal(verify(f.legal,args(f)).notice_cutoff_at,f.legal.notice_cutoff_at);
  assert.deepEqual(v,before);
});
test('canonical producer notice rejects absent, malformed, conflicting or out-of-range accepted days',async()=>{
  for(const value of [null,30.5,0,3661,true,'030','0','3661','30 days','',undefined]){
    const f=await fixture(),v=f.a.enterprise_checkout_source.material.template_snapshot.values;
    delete v.notice_deadline_plain;v.notice_deadline_days=value;
    assert.throws(()=>verify(f.legal,args(f)),{status:503});
  }
  for(const change of [v=>{v.notice_deadline_plain=null;v.notice_deadline_days='30';},
    v=>{v.notice_deadline_plain='31';v.notice_deadline_days='30';}]){
    const f=await fixture();change(f.a.enterprise_checkout_source.material.template_snapshot.values);
    assert.throws(()=>verify(f.legal,args(f)),{status:503});
  }
});
test('actual JSON-number producer notice retains the signed scalar and cutoff without rewriting',async()=>{
  const f=await fixture(),v=f.a.enterprise_checkout_source.material.template_snapshot.values;
  delete v.notice_deadline_plain;v.notice_deadline_days=30;
  const before=structuredClone(v);
  assert.equal(verify(f.legal,args(f)).notice_cutoff_at,f.legal.notice_cutoff_at);
  assert.deepEqual(v,before);
});
test('native unavailable or original receipt changing after the legal read holds without any write',async()=>{
  for(const error of [false,true]){
    const f=await fixture(),rpc=f.db.rpc;
    f.db.rpc=async(name,p)=>{if(name==='read_enterprise_existing_legal_window'&&!error)return{data:null,error:null};
      if(name==='read_enterprise_existing_billing'&&error){const r=await rpc(name,p);r.data.plan_initial.usage_interview_fee_cents=1;return r;}
      return rpc(name,p);};
    await assert.rejects(read({db:f.db,...args(f)}),{status:503});
  }
});
