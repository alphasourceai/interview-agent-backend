'use strict';
// Authored native legal/journal acknowledgments for real service/route wiring.
// Not database locking, actual consent, provider cash or hosted acceptance.
const assert=require('node:assert/strict'),fixture=require('./enterprise-status-observation-fixture');
const clone=v=>structuredClone(v),iso6=v=>new Date(v).toISOString().replace(/Z$/,'000Z');
module.exports=async function(t,options={}){
 const f=await fixture(t,options),w=f.native.a.enterprise_billing_receipt,p=w.funding_receipt.proof;
 f.legal={version:'enterprise_existing_legal_window_v1',agreement_id:f.native.a.id,client_id:f.native.client.id,
  billing_source_digest:'a'.repeat(32),term_index:0,initial_term_start:w.client_initial.contract_start_at,
  original_term_end:w.client_initial.contract_end_at,term_start_at:w.client_initial.contract_start_at,term_end_at:w.client_initial.contract_end_at,
  notice_cutoff_at:iso6(Date.parse(w.client_initial.contract_end_at)-30*86400000),auto_renew:true,accepted_operation_id:null,
  funded_from:iso6(p.payment_success_at),funded_through:iso6(w.subscription.current_period_end*1000),observed_at:iso6(Date.now()),
  provider_effect_authorized:false,paid_access_authorized:false,payroll_authorized:false};
 f.renewalOp=null;f.nativeActions=[];f.queryReads=[];
 const from=f.native.db.from.bind(f.native.db);f.native.db.from=table=>{
  const q=from(table),select=q.select;q.select=(columns,...args)=>{f.queryReads.push({table,columns});return select.call(q,columns,...args);};return q;
 };
 const previous=f.native.db.rpc;f.native.db.rpc=async(name,args)=>{
  if(!['read_enterprise_existing_legal_window','refresh_enterprise_existing_legal_window','change_enterprise_existing_renewal'].includes(name))return previous(name,args);
  f.nativeActions.push({name,args:clone(args)});assert.equal(args.p_agreement,f.native.a.id);assert.equal(args.p_client,f.native.client.id);
  if(f.onNative){const result=await f.onNative(name,args);if(result)return result;}
  if(name==='read_enterprise_existing_legal_window')return{data:clone(f.legal),error:null};
  if(name==='refresh_enterprise_existing_legal_window'){
   const changed=Date.parse(f.native.client.contract_end_at)!==Date.parse(f.legal.term_end_at);
   Object.assign(f.native.client,{contract_start_at:f.legal.term_start_at,contract_end_at:f.legal.term_end_at});
   return{data:{...clone(f.legal),status:changed?'refreshed':'unchanged'},error:null};
  }
  assert.deepEqual(clone(args.p_billing),w);
  if(args.p_action==='request'){
   f.renewalOp={version:'enterprise_existing_renewal_change_v2',operation_id:'10000000-0000-4000-8000-000000000093',source:clone(w),
    requested_auto_renew:args.p_auto_renew,accepted_at:new Date(Date.now()).toISOString(),effective_at:f.legal.term_end_at,
    notice_cutoff_at:f.legal.notice_cutoff_at,status:'waiting',generation:0,sent_at:null,provider_cancel_operation_id:null};
   f.legal.auto_renew=args.p_auto_renew;f.legal.accepted_operation_id=f.renewalOp.operation_id;f.native.client.auto_renew=args.p_auto_renew;
  }
  assert.ok(['read','request'].includes(args.p_action));
  return{data:{status:f.renewalOp?.status||'none',operation:clone(f.renewalOp),legal_term_end:f.legal.term_end_at,
   notice_cutoff_at:f.legal.notice_cutoff_at,provider_effect_authorized:false,paid_access_authorized:false,payroll_authorized:false},error:null};
 };
 f.stripe.invoices.list=async()=>({object:'list',has_more:false,data:[clone(f.x.invoice)]});
 f.x.invoice.status_transitions.finalized_at=f.x.invoice.created;
 f.stripe.invoiceItems={list:async()=>({object:'list',has_more:false,data:[]})};
 return f;
};
