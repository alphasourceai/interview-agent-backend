'use strict';
// Authored native journal replies + GET graphs, NOT SQL/cash/hosted acceptance.
const {test}=require('node:test'),assert=require('node:assert/strict');
const fixture=require('./helpers/enterprise-status-observation-fixture');
const {readExistingEnterpriseSubscriptionStatus:read}=require('../src/services/existingEnterprisePlatformPeriodReader');
const {observeExistingEnterpriseSubscription:observe}=require('../src/services/existingEnterprisePaymentCompletion');
const clone=v=>structuredClone(v),opId='10000000-0000-4000-8000-000000000091',oldId='10000000-0000-4000-8000-000000000090';
async function setup(t,{cadence='monthly',on=false,status='applied',sent=true,carried=false}={}){
 const f=await fixture(t,{cadence,ordinal:cadence==='monthly'?12:1}),w=f.native.a.enterprise_billing_receipt;
 const cutoff=Date.parse(w.client_initial.contract_end_at)/1000;
 f.sub.cancel_at=cutoff;f.sub.current_period_end=cutoff;f.fullEnd=f.x.line.period.end;
 f.journal={version:'enterprise_existing_renewal_change_v2',operation_id:opId,source:clone(w),requested_auto_renew:on,status,
  effective_at:w.client_initial.contract_end_at,sent_at:sent?new Date(Date.now()-1000).toISOString():null,
  provider_cancel_operation_id:carried?oldId:null};f.journalReads=0;
 const prior=f.native.db.rpc;f.native.db.rpc=async(name,args)=>{
  if(name!=='change_enterprise_existing_renewal')return prior(name,args);
  assert.equal(args.p_action,'read');assert.equal(args.p_auto_renew,null);assert.deepEqual(clone(args.p_billing),w);
  f.journalReads++;if(f.onJournalRead)f.onJournalRead(f.journalReads);
  return{data:{status:f.journal.status,operation:clone(f.journal),provider_effect_authorized:false,paid_access_authorized:false,payroll_authorized:false},error:null};
 };return f;
}
for(const cadence of ['monthly','annual'])test(`owned status ${cadence} v2 mirrors only ownE and keeps original full invoice and paid coverage distinct`,async t=>{
 const f=await setup(t,{cadence}),before=clone(f.native.db.tables),r=await read(f.statusArgs);
 assert.equal(Object.keys(r.proof).length,21);assert.equal(r.proof.version,'enterprise_existing_subscription_status_proof_v2');
 assert.equal(r.proof.provider_cancel_at,f.sub.cancel_at);assert.equal(r.proof.renewal_operation_id,opId);
 assert.equal(r.proof.provider_period_end,f.sub.cancel_at);assert.equal(f.journalReads,2);assert.ok(f.fullEnd>f.sub.cancel_at);
 assert.deepEqual(f.native.db.tables,before);assert.equal(f.persisted,0);
 const out=await observe(f.statusArgs);assert.equal(out.observation.projection.current_term_end,new Date(f.sub.cancel_at*1000).toISOString().replace(/Z$/,'000Z'));
 assert.equal(out.coverage.contiguous_ordinal,0);assert.equal(out.coverage.billing_status,'inactive');
 assert.equal(f.native.client.auto_renew,true);assert.equal(f.native.client.contract_end_at,before.clients[0].contract_end_at);
 assert.deepEqual(f.native.db.tables.membership_agreements,before.membership_agreements);
});
for(const status of ['waiting','held','unknown'])test(`owned status pendingON ${status} may observe actual older owned cancel while not yet cleared`,async t=>{
 const f=await setup(t,{on:true,status,carried:true,sent:status!=='waiting'});
 assert.equal((await read(f.statusArgs)).proof.renewal_operation_id,opId);assert.equal(f.calls.some(c=>c.kind==='update'),false);
});
test('owned status no-send appliedOFF with real carried writer is still legitimate',async t=>{
 const f=await setup(t,{sent:false,carried:true});assert.equal((await read(f.statusArgs)).proof.provider_cancel_at,f.sub.cancel_at);
});
for(const [name,change]of [
 ['foreign cancel',f=>{f.journal.sent_at=null;}],['appliedON historical owner',f=>{f.journal.requested_auto_renew=true;f.journal.provider_cancel_operation_id=oldId;}],
 ['claimedON in-flight',f=>{f.journal.requested_auto_renew=true;f.journal.status='claimed';f.journal.provider_cancel_operation_id=oldId;}],
 ['waitingOFF carried but not confirmed',f=>{f.journal.status='waiting';f.journal.sent_at=null;f.journal.provider_cancel_operation_id=oldId;}],
 ['same-id fake owner',f=>{f.journal.requested_auto_renew=true;f.journal.status='waiting';f.journal.sent_at=null;f.journal.provider_cancel_operation_id=opId;}],
 ['different nativeE',f=>{f.journal.effective_at=new Date((f.sub.cancel_at-1)*1000).toISOString();}],
 ['foreign native source',f=>{f.journal.source.client_initial.auto_renew=false;}],
 ['non-final provider status',f=>{f.sub.status='paused';}],
 ['end not equal cancel',f=>{f.sub.current_period_end++;}],['foreign shortened geometry',f=>{f.sub.current_period_start++;}]
])test(`owned status refuses ${name}, no projection or setting effect`,async t=>{
 const f=await setup(t);change(f);await assert.rejects(read(f.statusArgs),{code:'enterprise_platform_period_unverified'});
 assert.equal(f.observations,undefined);assert.equal(f.persisted,0);assert.equal(f.refreshes,0);
});
test('owned status journal identity/phase change between reads fails before native CAS',async t=>{
 const f=await setup(t);f.onJournalRead=n=>{if(n===2)f.journal.operation_id=oldId;};
 await assert.rejects(observe(f.statusArgs),{code:'enterprise_subscription_observation_unknown'});assert.equal(f.observations,undefined);
});
test('clear fullcalendar v1 still projects a true provider flag without owning cancellation or journal lookup',async t=>{
 const f=await fixture(t);f.sub.cancel_at_period_end=true;const r=await read(f.statusArgs);
 assert.equal(Object.keys(r.proof).length,19);assert.equal(r.proof.version,'enterprise_existing_subscription_status_proof_v1');
 assert.equal(r.proof.cancel_at_term_end,true);assert.ok(f.rpcCalls.every(x=>x.name==='read_enterprise_existing_billing'));
});
