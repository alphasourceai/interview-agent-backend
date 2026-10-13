'use strict';

// UNMOUNTED trusted SDK -> existing native agreement receipt only.
// No paid state, client/settings, Auth, access, credits or provider writes.
const {isDeepStrictEqual}=require('node:util');
const {readExistingEnterpriseCheckoutFunding}=require('./existingEnterpriseCheckoutFunding');
const {snapshotStripeSdkData}=require('./enterprisePoolPaymentProof');
const PROOF_KEYS=require('./enterpriseExistingFundingKeys');
function fail(){const e=new Error('enterprise_funding_receipt_ack_unknown');e.code=e.message;e.status=503;throw e;}
function check(v){if(!v)fail();}
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
async function recordExistingEnterpriseFunding({db,stripe,agreementId,eventSessionId,eventSubscriptionId,eventInvoiceId,eventLivemode,
 assertFence=async()=>{},now=Date.now}){
 // Proof is obtained here from the real server reader, not supplied by a caller.
 const funding=await readExistingEnterpriseCheckoutFunding({db,stripe,agreementId,eventSessionId,eventSubscriptionId,eventInvoiceId,eventLivemode,assertFence,now});
 if(!funding)return null;
 const proof=Object.fromEntries(PROOF_KEYS.map(k=>[k,funding[k]]));
 await assertFence();let result;
 try{result=await db.rpc('record_enterprise_existing_funding',{p_agreement:funding.agreementId,p_client:funding.client_id,
  p_source:funding.sourceCheckout,p_prices:funding.sourcePrices,p_proof:proof});}catch(_){fail();}
 check(result&&!result.error&&result.data);
 let receipt;try{receipt=snapshotStripeSdkData(result.data);}catch(_){fail();}
 check(receipt&&Object.keys(receipt).sort().join(',')==='proof,recorded_at,version'
  &&receipt.version==='enterprise_existing_funding_v1'&&isDeepStrictEqual(receipt.proof,snapshotStripeSdkData(proof))
  &&typeof receipt.recorded_at==='string'&&/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/.test(receipt.recorded_at)
  &&Number.isFinite(Date.parse(receipt.recorded_at))&&Date.parse(receipt.recorded_at)>=Date.parse(proof.payment_success_at));
 // Date.parse can normalize an impossible day (e.g. November31). Preserve the
 // native microsecond text but require an exact millisecond calendar roundtrip.
 check(new Date(Date.parse(receipt.recorded_at)).toISOString()===receipt.recorded_at.replace(/(\.\d{3})\d{3}Z$/,'$1Z'));
 await assertFence();let saved;
 try{saved=await db.from('membership_agreements').select('id,client_id,status,is_current,superseded_at,superseded_by_agreement_id,checkout_status,checkout_paid_at,checkout_session_id,enterprise_checkout_source,enterprise_checkout_prices,enterprise_funding_receipt')
  .eq('id',funding.agreementId).maybeSingle();}catch(_){fail();}
 check(saved&&!saved.error&&saved.data?.id===funding.agreementId&&saved.data.client_id===funding.client_id
  &&saved.data.is_current===true&&saved.data.status==='signed'&&!saved.data.superseded_at&&!saved.data.superseded_by_agreement_id
  &&saved.data.checkout_status==='pending_payment'&&saved.data.checkout_paid_at==null&&saved.data.checkout_session_id===funding.checkout_session_id
  &&isDeepStrictEqual(saved.data.enterprise_checkout_source,funding.sourceCheckout)
  &&isDeepStrictEqual(saved.data.enterprise_checkout_prices,funding.sourcePrices));
 let readback;try{readback=snapshotStripeSdkData(saved.data.enterprise_funding_receipt);}catch(_){fail();}
 check(isDeepStrictEqual(readback,receipt));await assertFence();
 return freeze({receipt,funding,credits_spendable:false,membership_activation_required:true,native_receipt_required:true});
}
module.exports={recordExistingEnterpriseFunding,PROOF_KEYS};
