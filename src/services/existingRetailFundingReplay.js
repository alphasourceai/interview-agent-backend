'use strict';
// UNMOUNTED persisted-original-evidence reader. No first receipt, paid state,
// access/Auth/settings/credit/provider writes, or historical money reproof.
const {isDeepStrictEqual}=require('node:util');
const {snapshotStripeSdkData}=require('./enterprisePoolPaymentProof');
const {readSavedRetailCheckoutTerms}=require('./savedMembershipCheckoutTerms');
const {assertExistingRetailFundingSource}=require('./existingRetailCheckoutFunding');
function fail(code='retail_funding_replay_unknown'){const e=new Error(code);e.code=code;e.status=503;throw e;}
const check=(v,code)=>{if(!v)fail(code);};
const equal=(a,b)=>isDeepStrictEqual(snapshotStripeSdkData(a),snapshotStripeSdkData(b));
const id=v=>typeof v==='string'?v:v?.id;
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
async function row(db,table,key,value){
 try{const r=await db.from(table).select('*').eq(key,value).maybeSingle();check(r&&!r.error);return snapshotStripeSdkData(r.data);}
 catch(_){fail();}
}
function envelope(v,receipt){
 check(v&&Object.keys(v).sort().join(',')==='phase,receipt,version'&&v.version==='retail_existing_funding_read_v1'
  &&['pending','paid'].includes(v.phase)&&equal(v.receipt,receipt),'retail_funding_replay_ack_unknown');return v;
}
async function readReceipt({db,stripe,agreementId,intentId,eventSessionId,eventSubscriptionId,eventInvoiceId,eventLivemode,
 claimKey=null,assertFence=async()=>{}}){
 check(typeof stripe?.getApiField==='function'&&stripe.getApiField('version')==='2023-10-16','retail_funding_replay_api_mismatch');
 await assertFence();const a=await row(db,'membership_agreements','id',agreementId);
 check(a?.id===agreementId&&a.retail_funding_receipt,'retail_funding_replay_receipt_required');
 const i=await row(db,'public_purchase_intents','agreement_id',agreementId);
 check(!intentId||i?.id===intentId,'retail_funding_replay_intent_mismatch');
 let terms;try{terms=readSavedRetailCheckoutTerms({agreement:a,intent:i,deadlineMode:'stored'});}catch(_){fail('retail_funding_replay_source_invalid');}
 check(terms&&a.client_id&&a.checkout_attempt_source,'retail_funding_replay_source_invalid');
 async function locked(){
  await assertFence();let r;try{r=await db.rpc('read_retail_existing_funding',{p_agreement:agreementId,p_client:a.client_id,
   p_claim:claimKey,p_source:a.checkout_attempt_source});}catch(_){fail();}
  check(r&&!r.error&&r.data);let data;try{data=snapshotStripeSdkData(r.data);}catch(_){fail();}
  return envelope(data,a.retail_funding_receipt);
 }
 const first=await locked(),p=first.receipt.proof,b=p?.period;
 check(first.receipt.version==='retail_existing_funding_v1'&&b?.version==='retail_initial_provider_period_v1',
  'retail_funding_replay_ack_unknown');
 check(typeof eventLivemode==='boolean'&&eventLivemode===b.livemode
  &&(!eventSessionId||eventSessionId===b.checkout_session_id)
  &&(!eventSubscriptionId||eventSubscriptionId===b.subscription_id)
  &&(first.phase==='paid'||!eventInvoiceId||eventInvoiceId===b.invoice_id),'retail_funding_replay_event_mismatch');
 let account,checkout,subscription;
 try{
  await assertFence();account=snapshotStripeSdkData(await stripe.accounts.retrieve());
  await assertFence();checkout=snapshotStripeSdkData(await stripe.checkout.sessions.retrieve(b.checkout_session_id));
  await assertFence();subscription=snapshotStripeSdkData(await stripe.subscriptions.retrieve(b.subscription_id));
 }catch(e){if(e?.code==='public_purchase_activation_guard_lost')throw e;fail();}
 check(account?.object==='account'&&account.id===p.provider_account_id,'retail_funding_replay_account_mismatch');
 check(checkout?.object==='checkout.session'&&checkout.id===b.checkout_session_id&&checkout.mode==='subscription'
  &&checkout.status==='complete'&&checkout.currency==='usd'&&checkout.livemode===b.livemode
  &&id(checkout.customer)===b.customer_id&&id(checkout.subscription)===b.subscription_id
  &&(!id(checkout.invoice)||id(checkout.invoice)===b.invoice_id)
  &&subscription?.object==='subscription'&&subscription.id===b.subscription_id&&subscription.currency==='usd'
  &&subscription.livemode===b.livemode&&id(subscription.customer)===b.customer_id,'retail_funding_replay_provider_mismatch');
 const last=await locked();check(equal(last,first),'retail_funding_replay_source_changed');
 const current=await row(db,'membership_agreements','id',agreementId);
 check(equal(current?.retail_funding_receipt,first.receipt)&&equal(current?.checkout_attempt_source,a.checkout_attempt_source),
  'retail_funding_replay_source_changed');
 // Existing activation assertions compare ordinary JSON prototypes. Safe SDK/
 // DB snapshots were already validated; project only these JSON fields back
 // into plain data rather than weaken that established correspondence check.
 const plain=v=>JSON.parse(JSON.stringify(v));
 const funding={agreementId,clientId:a.client_id,packageSnapshot:plain(terms.packageSnapshot),sourceTemplate:plain(a.template_snapshot),
  sourceTemplateVersion:a.template_version,sourceIntentId:i?.id||null,paidAt:b.paid_at,
  checkoutSessionId:b.checkout_session_id,customerId:b.customer_id,subscription,
  replay:first.phase==='paid',initialProviderPeriod:b,receiptReplay:true,
  invoiceId:b.invoice_id,paymentIntentId:p.payment_intent_id,chargeId:p.charge_id,
  checkoutCreatedEpoch:p.checkout_created,invoiceCreatedEpoch:p.invoice_created,
  platformGrossCents:p.platform_gross_cents,platformDiscountCents:p.platform_discount_cents,platformNetCents:p.platform_net_cents,
  roleGrossCents:p.role_gross_cents,roleDiscountCents:p.role_discount_cents,roleNetCents:p.role_net_cents,
  taxCents:p.tax_cents,cashCents:p.cash_cents};
 // Native reader owns paid admin tails before the client subscription is set;
 // existing assertion deliberately assumes applied admin billing for replay.
 await assertExistingRetailFundingSource({db,funding:{...funding,replay:false}});await assertFence();
 return freeze({receipt:first.receipt,funding,native_receipt_required:true,membership_activation_required:true,credits_spendable:false});
}
async function readExistingRetailFundingReceipt(options){
 try{return await readReceipt(options);}catch(e){
  if(e?.code==='public_purchase_activation_guard_lost'||typeof e?.code==='string'
   &&/^retail_funding_replay_[a-z_]+$/.test(e.code)&&e.message===e.code)throw e;
  fail();
 }
}
module.exports={readExistingRetailFundingReceipt};
