'use strict';
// Reuses the existing invoice and membership-state writers. No initial
// activation, account setup, subscription mutation or notification is called.
const {isDeepStrictEqual}=require('node:util');
const {snapshotStripeSdkData:snapshot}=require('./enterprisePoolPaymentProof');
const {readExistingRetailRecurringFunding}=require('./existingRetailCheckoutFunding');
const {readRetailPackageOffer}=require('./membershipPackageCompatibility');
const {STRIPE_RECURRING_OFFER_VERSION}=require('./membershipOffers');
function unknown(){const e=new Error('retail_recurring_record_unknown');e.code=e.message;e.status=503;throw e;}
async function rpc(db,name,args){
  let r;try{r=snapshot(await db.rpc(name,args));}catch(_){unknown();}
  if(!r || r.error || !r.data)unknown();return r.data;
}
async function completeExistingRetailRecurringPayment(input){
  const {source,proof}=await readExistingRetailRecurringFunding(input);
  const r=await rpc(input.db,'record_retail_existing_paid_period',{
    p_agreement:source.agreement_id,p_client:source.client_id,p_source:source,p_proof:proof});
  const receipt=r.receipt;
  if(!['recorded','already_recorded'].includes(r.status)
    || !/^[0-9a-f-]{36}$/.test(r.invoice_id||'')
    || receipt?.version!=='retail_existing_paid_period_receipt_v1'
    || !isDeepStrictEqual(receipt.source,snapshot(source)) || !isDeepStrictEqual(receipt.proof,snapshot(proof))
    || !/^[0-9a-f]{32}$/.test(receipt.source_digest||'')
    || typeof receipt.recorded_at!=='string' || !Number.isFinite(Date.parse(receipt.recorded_at)))unknown();
  // Always refresh even on duplicate payment_succeeded/invoice.paid events.
  // A lost refresh ACK leaves the caller retryable rather than completed.
  const coverage=await rpc(input.db,'refresh_retail_existing_paid_coverage',{
    p_agreement:source.agreement_id,p_client:source.client_id});
  if(!['refreshed','manual_override'].includes(coverage.status))unknown();
  return{status:r.status,invoiceId:r.invoice_id,receipt,coverage};
}
async function refreshExistingRetailCoverage({db,agreementId,clientId}){
  const r=await rpc(db,'refresh_retail_existing_paid_coverage',{p_agreement:agreementId,p_client:clientId});
  if(!['refreshed','manual_override'].includes(r.status))unknown();return r;
}
async function classifyExistingRetailRecurringEvent({db,event}){
  const paid=['invoice.paid','invoice.payment_succeeded'].includes(event?.type),
    failed=event?.type==='invoice.payment_failed',
    sub=['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'].includes(event?.type);
  if(!paid&&!failed&&!sub)return null;
  const obj=event.data?.object||{},customerId=typeof obj.customer==='string'?obj.customer:obj.customer?.id,
    subscriptionId=sub?obj.id:(typeof obj.subscription==='string'?obj.subscription:obj.subscription?.id);
  if(paid&&obj.billing_reason==='subscription_create')return null;
  if(!customerId||!subscriptionId)return null;
  const {data:c,error:ce}=await db.from('clients').select('id,plan_tier,stripe_customer_id,stripe_subscription_id')
    .eq('stripe_customer_id',customerId).maybeSingle();if(ce)unknown();if(!c||c.plan_tier==='enterprise')return null;
  const {data:a,error:ae}=await db.from('membership_agreements')
    .select('id,client_id,template_snapshot,template_version,checkout_status,is_current,status')
    .eq('client_id',c.id).eq('is_current',true).maybeSingle();if(ae)unknown();
  if(a?.template_snapshot?.package_snapshot?.membership_terms?.offer_version!==STRIPE_RECURRING_OFFER_VERSION)return null;
  const offer=readRetailPackageOffer(a.template_snapshot.package_snapshot);
  if(offer?.offer_version!==STRIPE_RECURRING_OFFER_VERSION)unknown();
  // Initial Checkout activation remains on its existing path. An unpaid
  // cyclic event cannot become a generic subscription-status activation.
  const base={agreementId:a.id,clientId:c.id,subscriptionId,customerId,requiresReentry:true};
  if(c.stripe_subscription_id!==subscriptionId || a.checkout_status!=='paid'
    || !['signed','active'].includes(a.status) || a.template_version!=='membership_agreement_retail_terms_v2'
    || (!sub&&obj.billing_reason!=='subscription_cycle'))return{...base,action:'held'};
  return{...base,action:paid?'paid':'refresh'};
}
module.exports={completeExistingRetailRecurringPayment,refreshExistingRetailCoverage,classifyExistingRetailRecurringEvent};
