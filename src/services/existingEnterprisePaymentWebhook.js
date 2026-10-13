'use strict';

// Internal classifier for the already-signed Enterprise agreement checkout.
// Native rows identify the cohort; fresh read-only Stripe objects bind each event.
const {isDeepStrictEqual}=require('node:util');
const {readExistingEnterpriseCheckoutScope}=require('./existingEnterpriseCheckoutFunding');
const {metadataFor}=require('./existingEnterpriseCheckoutAttempt');
const {snapshotStripeSdkData}=require('./enterprisePoolPaymentProof');

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRIPE_ID={cs:/^cs_[A-Za-z0-9_]+$/,sub:/^sub_[A-Za-z0-9_]+$/,cus:/^cus_[A-Za-z0-9_]+$/};
const CHECKOUT_EVENTS=new Set(['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed']);
const INVOICE_EVENTS=new Set(['invoice.created','invoice.payment_succeeded','invoice.payment_failed']);
const SUBSCRIPTION_EVENTS=new Set(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted']);
function fail(code='enterprise_payment_event_unclassified'){
 const e=new Error(code);e.code=code;e.status=503;throw e;
}
function id(value){return typeof value==='string'?value:(value&&typeof value.id==='string'?value.id:null);}
function hasNativeMarker(row){return Boolean(row&&(row.enterprise_checkout_source!=null||row.enterprise_checkout_pool_id!=null
 ||row.enterprise_checkout_prices!=null||row.enterprise_funding_receipt!=null||row.enterprise_billing_receipt!=null));}
function sourceHint(meta){return String(meta?.source||'').trim().toLowerCase()==='agreement_checkout';}
function metadata(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
function eventKind(type){
 if(CHECKOUT_EVENTS.has(type))return'checkout';
 if(INVOICE_EVENTS.has(type))return'invoice';
 if(SUBSCRIPTION_EVENTS.has(type))return'subscription';
 return null;
}
async function maybeOne(db,table,field,value){
 const r=await db.from(table).select('*').eq(field,value).maybeSingle();
 if(r?.error)fail('enterprise_payment_event_native_read_failed');
 return r?.data||null;
}
async function candidateRows(db,{agreementId,sessionId,customerId}){
 const found=new Map();let unmarkedAgreementHint=null;
 if(UUID.test(String(agreementId||''))){
  const row=await maybeOne(db,'membership_agreements','id',agreementId);
  if(hasNativeMarker(row))found.set(row.id,row);
  else unmarkedAgreementHint=row;
 }
 if(STRIPE_ID.cs.test(String(sessionId||''))){
  const row=await maybeOne(db,'membership_agreements','checkout_session_id',sessionId);
  if(hasNativeMarker(row))found.set(row.id,row);
 }
 if(STRIPE_ID.cus.test(String(customerId||''))){
  const client=await maybeOne(db,'clients','stripe_customer_id',customerId);
  if(client?.id){
   const r=await db.from('membership_agreements').select('*').eq('client_id',client.id).eq('membership_tier','enterprise');
   if(r?.error||!Array.isArray(r?.data))fail('enterprise_payment_event_native_read_failed');
   for(const row of r.data)if(hasNativeMarker(row))found.set(row.id,row);
  }
 }
 return {rows:[...found.values()],unmarkedAgreementHint};
}
function metadataConflict(hint,actual){
 const h=String(hint?.agreement_id||'').trim(),s=String(hint?.source||'').trim().toLowerCase();
 return (h&&h!==actual.id)||(s&&s!=='agreement_checkout');
}
async function matchCandidate({db,stripe,event,eventObject,eventSub,eventCustomer,eventSessionId,eventSubscriptionId,candidate}){
 let scope;
 try{scope=await readExistingEnterpriseCheckoutScope({db,agreementId:candidate.id});}catch(_){fail('enterprise_payment_event_native_source_denied');}
 if(!scope)fail('enterprise_payment_event_native_source_missing');
 const {a,client,t}=scope,source=a.enterprise_checkout_source;
 if(!STRIPE_ID.cs.test(String(a.checkout_session_id||''))||source?.version!=='enterprise_existing_pending_v1')
  fail('enterprise_payment_event_checkout_pin_missing');
 if(metadataConflict(metadata(eventObject?.metadata),a)||metadataConflict(metadata(eventSub?.metadata),a))
  fail('enterprise_payment_event_metadata_conflict');
 let checkout,subscription;
 try{
  checkout=snapshotStripeSdkData(await stripe.checkout.sessions.retrieve(a.checkout_session_id));
  const checkoutSubId=id(checkout?.subscription);
  if(!STRIPE_ID.sub.test(String(checkoutSubId||'')))fail('enterprise_payment_event_subscription_missing');
  subscription=snapshotStripeSdkData(await stripe.subscriptions.retrieve(checkoutSubId));
 }catch(error){if(error?.status===503)throw error;fail('enterprise_payment_event_provider_read_failed');}
 const expected=metadataFor(a,t,source);
 if(checkout?.object!=='checkout.session'||checkout.id!==a.checkout_session_id||checkout.mode!=='subscription'
  ||id(checkout.customer)!==client.stripe_customer_id||checkout.livemode!==event.livemode
  ||!isDeepStrictEqual(snapshotStripeSdkData(metadata(checkout.metadata)),snapshotStripeSdkData(expected.session))
  ||subscription?.id!==id(checkout.subscription)||id(subscription.customer)!==client.stripe_customer_id
  ||!isDeepStrictEqual(snapshotStripeSdkData(metadata(subscription.metadata)),snapshotStripeSdkData(expected.session))
  ||(eventCustomer&&eventCustomer!==client.stripe_customer_id)
  ||(eventSessionId&&eventSessionId!==checkout.id)
  ||(eventSubscriptionId&&eventSubscriptionId!==subscription.id)
  ||(eventSub&&eventSub.id!==subscription.id))return false;
 if(event.type==='invoice.payment_succeeded'||event.type==='invoice.payment_failed'||event.type==='invoice.created'){
  if(id(eventObject?.subscription)!==subscription.id)return false;
 }
 return {scope,checkout,subscription};
}
function actionFor(event,checkout){
 const type=event.type,o=event.data?.object||{};
 if(type==='checkout.session.completed'||type==='checkout.session.async_payment_succeeded'){
  if(o.status!=='complete'&&checkout.status!=='complete')return'held';
  if(o.payment_status==='paid'&&checkout.payment_status==='paid')return'initial_paid';
  if(type==='checkout.session.completed'&&['unpaid','no_payment_required'].includes(String(o.payment_status||checkout.payment_status)))return'pending_noop';
  return'held';
 }
 if(type==='checkout.session.async_payment_failed'){
  if(checkout.payment_status==='paid'||o.payment_status==='paid')return'held';
  return'pending_noop';
 }
 if(type==='invoice.created'&&o.billing_reason==='subscription_create')return'initial_noop';
 if(type==='invoice.payment_succeeded'&&o.billing_reason==='subscription_create'
  &&o.status==='paid'&&Number(o.amount_paid)>0)return'initial_paid';
 if(INVOICE_EVENTS.has(type)||SUBSCRIPTION_EVENTS.has(type))return'held';
 return null;
}
async function classifyExistingEnterprisePaymentEvent({db,stripe,event}){
 const kind=eventKind(event?.type);if(!kind)return null;
 const eventObject=event?.data?.object||{};
 const eventMetadata=metadata(eventObject.metadata);
 let eventSub=kind==='subscription'?eventObject:null;
 let eventSubscriptionId=kind==='subscription'?id(eventObject):kind==='invoice'?id(eventObject.subscription):id(eventObject.subscription);
 let eventCustomer=id(eventObject.customer);
 if(eventSubscriptionId&&kind!=='subscription'){
  try{eventSub=snapshotStripeSdkData(await stripe.subscriptions.retrieve(eventSubscriptionId));}
  catch(_){if(sourceHint(eventMetadata))fail('enterprise_payment_event_provider_read_failed');}
  if(eventSub)eventCustomer=eventCustomer||id(eventSub.customer);
 }
 const subMetadata=metadata(eventSub?.metadata);
 const agreementHint=eventMetadata.agreement_id||subMetadata.agreement_id||null;
 const sessionId=kind==='checkout'?id(eventObject):null;
 const {rows:discovered,unmarkedAgreementHint}=await candidateRows(db,{agreementId:agreementHint,sessionId,customerId:eventCustomer});
 const candidates=discovered.filter(row=>{
  const proofSub=row.enterprise_funding_receipt?.proof?.subscription_id;
  const billingSub=row.enterprise_billing_receipt?.funding_receipt?.proof?.subscription_id;
  return row.id===agreementHint||row.checkout_session_id===sessionId
   ||eventSubscriptionId&&(proofSub===eventSubscriptionId||billingSub===eventSubscriptionId)
   ||row.is_current===true&&row.status==='signed';
 });
 if(!candidates.length)return null;
 const matches=[];
 for(const candidate of candidates){
  const sessionCandidate=await matchCandidate({db,stripe,event,eventObject,eventSub,eventCustomer,
   eventSessionId:sessionId,eventSubscriptionId,candidate});
  if(sessionCandidate)matches.push({candidate,...sessionCandidate});
 }
 if(matches.length===0){
  if(unmarkedAgreementHint&&!candidates.some(row=>row.checkout_session_id===sessionId))return null;
  if(sourceHint(eventMetadata)||sourceHint(subMetadata)||UUID.test(String(agreementHint||''))||sessionId&&candidates.some(x=>x.checkout_session_id===sessionId))
   fail('enterprise_payment_event_binding_mismatch');
  return null;
 }
 if(matches.length!==1)fail('enterprise_payment_event_binding_ambiguous');
 const match=matches[0],action=actionFor(event,match.checkout);
 if(!action)return null;
 return Object.freeze({cohort:'existing_enterprise',action,agreementId:match.candidate.id,clientId:match.candidate.client_id,
  sessionId:match.checkout.id,subscriptionId:match.subscription.id,customerId:match.scope.client.stripe_customer_id,
  subscription:match.subscription,requiresReentry:true});
}
module.exports={classifyExistingEnterprisePaymentEvent,hasNativeMarker};
