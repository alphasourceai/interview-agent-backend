'use strict';
// Existing manual payroll action only. Native INSERT guard re-verifies under
// root locks; a read response is not settlement evidence or permission to pay.
const {readExistingEnterpriseCheckoutScope}=require('./existingEnterpriseCheckoutFunding');
const {anchoredMonthInstant}=require('./membershipOffers');
const {snapshotStripeSdkData:snapshot}=require('./enterprisePoolPaymentProof');
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const closed=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
function fail(code='enterprise_commission_unverified',status=503){throw Object.assign(new Error(code),{code,status});}
const check=v=>{if(!v)fail();};
function stamp(v){
 check(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(v));
 const time=Date.parse(v);check(Number.isFinite(time)&&new Date(time).toISOString()===v.replace(/(\.\d{3})\d{3}Z$/,'$1Z'));
 return time;
}
async function loadExistingEnterpriseCommissionTerms(db,{agreementId,paymentId,repUserId=null,originalRepAttested=false}){
 if(!uuid(agreementId)||typeof paymentId!=='string'||!/^in_[A-Za-z0-9_]+$/.test(paymentId)||paymentId.length>200
  ||(repUserId!==null&&!uuid(repUserId))||typeof originalRepAttested!=='boolean')fail('invalid_enterprise_commission_input',422);
 const n=await readExistingEnterpriseCheckoutScope({db,agreementId});
 check(n?.a.id===agreementId&&n.a.checkout_status==='paid'&&n.billingReceipt);
 let result;
 try{result=await db.rpc('read_enterprise_existing_commission_payment',{p_agreement:agreementId,p_client:n.client.id,
  p_invoice:paymentId,p_rep:repUserId,p_attested:originalRepAttested});}catch(_){fail();}
 if(result?.error){
  const code=String(result.error.message||'');
  if(result.error.code==='P0001'&&/^enterprise_commission_(?:original_rep_(?:attestation_required|mismatch)|rep_denied|client_denied|invoice_required|invoice_denied|payment_denied|identity_denied|usage_denied)$/.test(code))fail(code,409);
  fail();
 }
 const p=snapshot(result?.data),q=p?.qualification,f=n.billingReceipt.funding_receipt.proof;
 check(closed(p,['version','qualification','provider_payment_id','gross_membership_cents','discount_cents','payment_success_at','ordinal',
  'provider_effect_authorized','paid_access_authorized','payroll_authorized','settlement_verified'])
  &&p.version==='enterprise_existing_commission_payment_v1'&&p.provider_payment_id===paymentId
  &&p.provider_effect_authorized===false&&p.paid_access_authorized===false&&p.payroll_authorized===false&&p.settlement_verified===false
  &&Number.isSafeInteger(p.ordinal)&&p.ordinal>=0&&p.ordinal<=999
  &&Number.isSafeInteger(p.gross_membership_cents)&&p.gross_membership_cents>0
  &&Number.isSafeInteger(p.discount_cents)&&p.discount_cents>=0&&p.discount_cents<p.gross_membership_cents);
 check(closed(q,['version','agreement_id','client_id','rep_user_id','billing_source_digest','original_paid_at','original_term_end_at',
  'commission_window_end_at','qualification_closed_at','client_legal_name','original_rep_attested','payment_kind','payroll_authorized'])
  &&q.version==='enterprise_existing_commission_qualification_v1'&&q.agreement_id===agreementId&&q.client_id===n.client.id&&uuid(q.rep_user_id)
  &&(repUserId===null||q.rep_user_id===repUserId)&&q.original_rep_attested===true&&q.payroll_authorized===false
  &&/^[a-f0-9]{32}$/.test(q.billing_source_digest)&&typeof q.client_legal_name==='string'&&q.client_legal_name.trim().length>0
  &&q.client_legal_name===n.a.enterprise_checkout_source.material.template_snapshot.values.client_legal_name
  &&q.payment_kind===(f.platform_interval==='year'?'paid_in_full':'monthly'));
 const a=stamp(q.original_paid_at),end=stamp(q.original_term_end_at),close=stamp(q.qualification_closed_at),window=stamp(q.commission_window_end_at),paid=stamp(p.payment_success_at);
 const six=value=>new Date(value).toISOString().replace(/Z$/,'000Z');
 check(q.original_paid_at===six(f.payment_success_at)&&q.original_term_end_at===n.billingReceipt.client_initial.contract_end_at
  &&q.qualification_closed_at===q.original_paid_at&&q.commission_window_end_at===six(anchoredMonthInstant(new Date(a).toISOString(),12))
  &&p.payment_success_at===six(p.payment_success_at)&&a===Date.parse(f.payment_success_at)&&end===Date.parse(n.billingReceipt.client_initial.contract_end_at)&&end>a&&close===a
  &&window===Date.parse(anchoredMonthInstant(new Date(a).toISOString(),12))&&paid>=a&&paid<window
  &&p.gross_membership_cents===(p.ordinal===0?f.platform_line_cents:f.platform_nominal_cents)
  &&(p.ordinal!==0||paid===a&&p.discount_cents===0));
 return{clientId:n.client.id,repUserId:q.rep_user_id,paymentKind:q.payment_kind,platformPaymentCents:p.gross_membership_cents,
  paymentProof:{provider_payment_id:p.provider_payment_id,gross_membership_cents:p.gross_membership_cents,discount_cents:p.discount_cents,
   payment_success_at:new Date(paid).toISOString()},qualificationClosedAt:new Date(close).toISOString(),firstTermStartAt:new Date(a).toISOString(),firstTermEndAt:new Date(end).toISOString(),
  policyInput:{membership_terms_protocol:'enterprise_existing_terms_v1',original_membership_start_at:new Date(a).toISOString(),original_term_end_at:new Date(end).toISOString(),
   original_salesperson_user_id:q.rep_user_id,sales_rep_user_id:q.rep_user_id,original_qualification_closed_at:new Date(close).toISOString(),original_qualification_verified:true},
  ledgerFields:{membership_terms_protocol:'enterprise_existing_terms_v1',enterprise_agreement_id:agreementId,enterprise_commission_source:q,
   membership_contract_id:null,membership_contract_version:null,sales_qualification_id:null,policy_version:'enterprise-existing-commission-v1'}};
}
module.exports={loadExistingEnterpriseCommissionTerms};
