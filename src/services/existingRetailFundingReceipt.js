'use strict';
// UNMOUNTED trusted SDK -> existing agreement evidence only. No paid/access/
// Auth/settings/credit/provider effects. Historical replay enrollment is held.
const {isDeepStrictEqual}=require('node:util');
const {readExistingRetailCheckoutFunding,assertExistingRetailFundingSource}=require('./existingRetailCheckoutFunding');
const {snapshotStripeSdkData}=require('./enterprisePoolPaymentProof');
const {GENERATION_DATE_OFFER_VERSION}=require('./membershipOffers');
function fail(code='retail_funding_receipt_ack_unknown'){const e=new Error(code);e.code=code;e.status=503;throw e;}
const check=(v,code)=>{if(!v)fail(code);};
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
async function source(db,funding){
 let r;try{r=await db.from('membership_agreements').select('*').eq('id',funding.agreementId).maybeSingle();}catch(_){fail();}
 check(r&&!r.error&&r.data,'retail_funding_receipt_source_unknown');const a=r.data;
 check(a.id===funding.agreementId&&a.client_id===funding.clientId&&a.is_current===true&&a.status==='signed'
  &&a.checkout_status==='pending_payment'&&a.checkout_paid_at==null&&!a.superseded_by_agreement_id&&!a.superseded_at&&!a.voided_at
  &&a.checkout_session_id===funding.checkoutSessionId&&isDeepStrictEqual(a.template_snapshot,funding.sourceTemplate)
  &&a.template_version===funding.sourceTemplateVersion&&a.checkout_attempt_source?.version==='retail_existing_checkout_attempt_v1'
  &&a.checkout_attempt_source.customer_id===funding.customerId
  &&a.checkout_attempt_source.client_id===funding.clientId&&a.checkout_attempt_source.agreement_id===funding.agreementId
  &&isDeepStrictEqual(a.checkout_attempt_source.template_snapshot,funding.sourceTemplate),'retail_funding_receipt_source_unknown');
 let owners;try{owners=await db.from('billing_customers').select('id,client_id,stripe_customer_id',{count:'exact'})
  .eq('stripe_customer_id',funding.customerId);}catch(_){fail();}
 check(owners&&!owners.error&&owners.count===1&&Array.isArray(owners.data)&&owners.data.length===1
  &&owners.data[0].client_id===funding.clientId&&owners.data[0].stripe_customer_id===funding.customerId,
 'retail_funding_receipt_owner_unknown');return a;
}
async function recordExistingRetailFunding({db,stripe,agreementId,intentId,eventSessionId,eventSubscriptionId,eventInvoiceId,eventLivemode,
 claimKey=null,assertFence=async()=>{}}){
 check(typeof stripe?.getApiField==='function'&&stripe.getApiField('version')==='2023-10-16','retail_funding_receipt_api_mismatch');
 let funding;try{funding=await readExistingRetailCheckoutFunding({db,stripe,agreementId,intentId,eventSessionId,eventSubscriptionId,eventInvoiceId,eventLivemode,assertFence});}
 catch(e){if(typeof e.code==='string'&&e.message===e.code&&/^(retail_|package_|agreement_|purchase_intent_)[a-z_]+$/.test(e.code))throw e;fail();}
 if(!funding)return null;
 const generation=funding.packageSnapshot?.membership_terms?.offer_version===GENERATION_DATE_OFFER_VERSION;
 const period=generation?funding.initialProviderSchedule:funding.initialProviderPeriod;
 check(!funding.replay&&period && (generation?funding.initialProviderPeriod==null:funding.initialProviderSchedule==null)
  && period.version===(generation?'retail_generation_initial_schedule_v1':'retail_initial_provider_period_v1'),
 'retail_funding_receipt_historical_enrollment_held');
 check(funding.sourceIntentId ? typeof claimKey==='string'&&claimKey.length>=32 : claimKey===null,'retail_funding_receipt_claim_required');
 await assertFence();await assertExistingRetailFundingSource({db,funding});const a=await source(db,funding);
 await assertFence();let account;try{account=snapshotStripeSdkData(await stripe.accounts.retrieve());}catch(_){fail();}
 check(account?.object==='account'&&/^acct_[A-Za-z0-9_]{1,250}$/.test(account.id||''),'retail_funding_receipt_account_unknown');
 const proof=snapshotStripeSdkData({provider_account_id:account.id,period,
  payment_intent_id:funding.paymentIntentId,charge_id:funding.chargeId,
  checkout_created:funding.checkoutCreatedEpoch,invoice_created:funding.invoiceCreatedEpoch,
  platform_gross_cents:funding.platformGrossCents,platform_discount_cents:funding.platformDiscountCents,platform_net_cents:funding.platformNetCents,
  role_gross_cents:funding.roleGrossCents,role_discount_cents:funding.roleDiscountCents,role_net_cents:funding.roleNetCents,
  tax_cents:funding.taxCents,cash_cents:funding.cashCents});
 await assertFence();await assertExistingRetailFundingSource({db,funding});const before=await source(db,funding);
 check(isDeepStrictEqual(before.checkout_attempt_source,a.checkout_attempt_source),'retail_funding_receipt_source_unknown');
 let result;try{result=await db.rpc('record_retail_existing_funding',{p_agreement:funding.agreementId,p_client:funding.clientId,
  p_claim:claimKey,p_source:a.checkout_attempt_source,p_proof:proof});}catch(_){fail();}
 check(result&&!result.error&&result.data);let receipt;try{receipt=snapshotStripeSdkData(result.data);}catch(_){fail();}
 check(receipt&&Object.keys(receipt).sort().join(',')==='proof,recorded_at,version'
  &&receipt.version==='retail_existing_funding_v1'&&isDeepStrictEqual(receipt.proof,proof)
  &&typeof receipt.recorded_at==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(receipt.recorded_at)
  &&Number.isFinite(Date.parse(receipt.recorded_at))&&Date.parse(receipt.recorded_at)>=Date.parse(funding.paidAt)
  &&new Date(Date.parse(receipt.recorded_at)).toISOString()===receipt.recorded_at.replace(/(\.\d{3})\d{3}Z$/,'$1Z'));
 await assertFence();await assertExistingRetailFundingSource({db,funding});const saved=await source(db,funding);
 check(isDeepStrictEqual(saved.checkout_attempt_source,a.checkout_attempt_source)
  &&isDeepStrictEqual(snapshotStripeSdkData(saved.retail_funding_receipt),receipt));await assertFence();
 return freeze({receipt,funding,native_receipt_required:true,membership_activation_required:true,credits_spendable:false});
}
module.exports={recordExistingRetailFunding};
