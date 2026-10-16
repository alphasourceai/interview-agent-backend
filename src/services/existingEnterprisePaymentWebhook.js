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
const INVOICE_EVENTS=new Set(['invoice.created','invoice.payment_succeeded','invoice.paid','invoice.payment_failed']);
const SUBSCRIPTION_EVENTS=new Set(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted']);
function fail(code='enterprise_payment_event_unclassified'){
 const e=new Error(code);e.code=code;e.status=503;throw e;
}
function id(value){return typeof value==='string'?value:(value&&typeof value.id==='string'?value.id:null);}
function hasNativeMarker(row){return Boolean(row&&(row.enterprise_checkout_source!=null||row.enterprise_checkout_pool_id!=null
 ||row.enterprise_checkout_prices!=null||row.enterprise_funding_receipt!=null||row.enterprise_billing_receipt!=null));}
function sourceHint(meta){return String(meta?.source||'').trim().toLowerCase()==='agreement_checkout';}
function nativeVersionHint(meta){return /^enterprise_existing_/.test(String(meta?.enterprise_checkout_version||'').trim());}
function metadata(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
// A usage hint never authorizes an ACK or falls through to a legacy writer.
// Reuse the native paid leaf and existing GET-only invoice proof; no collection,
// allocation, access, account, commission or native leaf update occurs here.
async function classifyExistingEnterpriseUsageEvent({db,stripe,event}){
 const raw=event?.data?.object,meta=metadata(raw?.metadata);
 if(!Object.hasOwn(meta,'enterprise_usage_batch_id'))return null;
 const deny=()=>fail('enterprise_usage_event_unverified');
 const check=value=>{if(!value)deny();};
 const same=(a,b)=>isDeepStrictEqual(snapshotStripeSdkData(a),snapshotStripeSdkData(b));
 try{
  const o=snapshotStripeSdkData(raw),m=metadata(o.metadata),batchId=m.enterprise_usage_batch_id;
  const paidEvent=['invoice.payment_succeeded','invoice.paid'].includes(event.type);
  check(paidEvent||['invoice.created','invoice.payment_failed'].includes(event.type));
  check(/^evt_[A-Za-z0-9_]+$/.test(event.id||'')&&typeof event.livemode==='boolean'
   &&o.object==='invoice'&&/^in_[A-Za-z0-9_]+$/.test(o.id||'')&&STRIPE_ID.cus.test(id(o.customer)||'')
   &&o.subscription===null&&o.currency==='usd'&&o.livemode===event.livemode
   &&m.source==='usage_billing'&&UUID.test(batchId||'')&&UUID.test(m.client_id||'')
   &&Object.keys(m).sort().join(',')==='client_id,enterprise_usage_batch_id,source');
  const owner=await maybeOne(db,'clients','stripe_customer_id',id(o.customer));
  check(owner&&UUID.test(owner.id||'')&&owner.parent_client_id===null&&owner.archived_at===null
   &&owner.stripe_customer_id===id(o.customer)&&m.client_id===owner.id);
  const {readEnterpriseExistingUsageProvider:read}=require('./enterpriseExistingUsageReservation');
  const p=require('./enterpriseExistingUsageInvoiceProof');
  const load=async()=>{
   const s=await read({db,billingClientId:owner.id,batchId}),b=s?.binding;
   check(s?.status==='read'&&s.batch?.id===batchId&&s.batch.owner_id===owner.id
    &&b?.batch_id===batchId&&b.owner_id===owner.id&&b.agreement_id===s.batch.agreement_id
    &&b.customer_id===owner.stripe_customer_id&&b.livemode===event.livemode);
   return s;
  };
  const state=await load(),b=state.binding,leaf=state.batch.provider_operation;
  const base={cohort:'existing_enterprise_usage',agreementId:b.agreement_id,clientId:owner.id,
   batchId,invoiceId:o.id,requiresReentry:true};
  const prior=await maybeOne(db,'billing_events','stripe_event_id',event.id);
  if(leaf?.status!=='paid'){
   if(prior?.processed_ok===true)deny();
   return Object.freeze({...base,action:'usage_held'});
  }
  const original=leaf.operations?.pay?.proof,request=leaf.operations?.pay?.request;
  const pm=request?.body?.payment_method;
  check(leaf.invoice_id===o.id&&original?.invoice_id===o.id&&original.amount_cents===b.total_cents
   &&Object.keys(original).sort().join(',')===['invoice_id','payment_intent_id','charge_id','amount_cents','paid_at',
    'provider_effect_authorized','paid_access_authorized','payroll_authorized'].sort().join(',')
   &&Number.isSafeInteger(original.paid_at)&&original.paid_at>0&&original.paid_at<=253402300799
   &&original.paid_at*1000<=Date.parse(state.observed_at)
   &&original.provider_effect_authorized===false&&original.paid_access_authorized===false
   &&original.payroll_authorized===false&&/^pi_[A-Za-z0-9_]+$/.test(original.payment_intent_id||'')
   &&/^ch_[A-Za-z0-9_]+$/.test(original.charge_id||'')&&/^pm_[A-Za-z0-9_]+$/.test(pm||'')
   &&same(request,p.usageInvoicePayRequest(b,o.id,pm)));
  if(paidEvent)check(o.status==='paid'&&o.amount_paid===b.total_cents
   &&(!Object.hasOwn(o,'paid')||o.paid===true));
  else check(o.status===(event.type==='invoice.created'?'draft':'open')&&o.amount_paid===0
   &&(!Object.hasOwn(o,'paid')||o.paid===false));
  const api=()=>check(stripe?.getApiField('version')==='2023-10-16');
  const get=async fn=>{api();const value=snapshotStripeSdkData(await fn());api();return value;};
  const stable=async()=>{
   const current=await load(),nowLeaf=current.batch.provider_operation;
   check(nowLeaf?.status==='paid'&&nowLeaf.invoice_id===o.id&&same(current.binding,b)
    &&same(nowLeaf.operations?.pay?.proof,original)&&same(nowLeaf.operations?.pay?.request,request));
   return current;
  };
  if(prior?.processed_ok===true){
   const a=await get(()=>stripe.accounts.retrieve());check(a.object==='account'&&a.id===b.account_id);
   await stable();
   return Object.freeze({...base,action:paidEvent?'usage_paid_ack':'usage_stale_ack'});
  }
  const census=await p.readUsageInvoiceCensus({stripe,binding:b,invoiceId:o.id});
  check(typeof census.invoice?.payment_intent==='string'&&typeof census.invoice.charge==='string');
  const paymentIntent=await get(()=>stripe.paymentIntents.retrieve(census.invoice.payment_intent));
  const charge=await get(()=>stripe.charges.retrieve(census.invoice.charge));
  const refunds=await p.completePages(args=>get(()=>stripe.refunds.list({charge:charge.id,...args})),'re');
  const current=await stable();
  const proof=p.verifyUsageInvoicePaid({binding:b,invoiceId:o.id,invoice:census.invoice,
   items:census.items,lines:census.lines,paymentMethodId:pm,paymentIntent,charge,refunds,
   observationEpoch:Math.floor(Date.parse(current.observed_at)/1000)});
  check(same(proof,original));
  return Object.freeze({...base,action:paidEvent?'usage_paid_ack':'usage_stale_ack'});
 }catch(_){deny();}
}
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
 if(INVOICE_EVENTS.has(event.type)){
  if(id(eventObject?.subscription)!==subscription.id)return false;
 }
 return {scope,checkout,subscription};
}
function actionFor(event,checkout,scope){
 const type=event.type,o=event.data?.object||{};
 if(type==='checkout.session.completed'||type==='checkout.session.async_payment_succeeded'){
  const eventStatus=String(o.status||''),sdkStatus=String(checkout.status||'');
  const eventPayment=String(o.payment_status||''),sdkPayment=String(checkout.payment_status||'');
  // The signed event and fresh SDK snapshot are independent facts. Any
  // disagreement is retryable; never let a stale unpaid event ACK a paid SDK
  // Checkout (or let a paid event authorize an unpaid SDK Checkout).
  if(!eventStatus||!sdkStatus||eventStatus!==sdkStatus||!eventPayment||!sdkPayment||eventPayment!==sdkPayment)return'held';
  if(eventStatus!=='complete')return'held';
  if(eventPayment==='paid')return'initial_paid';
  if(type==='checkout.session.completed'&&['unpaid','no_payment_required'].includes(eventPayment))return'pending_noop';
  return'held';
 }
 if(type==='checkout.session.async_payment_failed'){
  const eventStatus=String(o.status||''),sdkStatus=String(checkout.status||'');
  const eventPayment=String(o.payment_status||''),sdkPayment=String(checkout.payment_status||'');
  if(!eventStatus||!sdkStatus||eventStatus!==sdkStatus||!eventPayment||!sdkPayment||eventPayment!==sdkPayment)return'held';
  if(eventPayment==='paid')return'held';
  return'pending_noop';
 }
 if(type==='invoice.created'&&o.billing_reason==='subscription_create')return'initial_noop';
 if(['invoice.payment_succeeded','invoice.paid'].includes(type)&&o.billing_reason==='subscription_create'
  &&o.status==='paid'&&Number.isSafeInteger(o.amount_paid)&&o.amount_paid>0
  &&(!Object.hasOwn(o,'paid')||o.paid===true))return'initial_paid';
 // Classification is not cash authority. Only a previously completed native
 // pair can enter the later-cycle GET proof/writer, never initial activation.
 if(['invoice.payment_succeeded','invoice.paid'].includes(type)&&o.billing_reason==='subscription_cycle'
  &&scope?.a.checkout_status==='paid'&&scope.billingReceipt
  &&checkout.status==='complete'&&checkout.payment_status==='paid'
  &&o.status==='paid'&&Number.isSafeInteger(o.amount_paid)&&o.amount_paid>0
  &&(!Object.hasOwn(o,'paid')||o.paid===true))return'cycle_paid';
 if(INVOICE_EVENTS.has(type)||SUBSCRIPTION_EVENTS.has(type))return'held';
 return null;
}
async function classifyExistingEnterprisePaymentEvent({db,stripe,event}){
 const usage=await classifyExistingEnterpriseUsageEvent({db,stripe,event});if(usage)return usage;
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
 // The version marker is only a denial signal. It never authorizes an event;
 // authorization still requires the native database source and fresh SDK graph.
 // If a native row lost every marker, do not let a redelivery fall back to the
 // legacy path and be acknowledged as already processed.
 if(!discovered.length&&(nativeVersionHint(eventMetadata)||nativeVersionHint(subMetadata)))
  fail('enterprise_payment_event_native_source_missing');
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
 const match=matches[0],action=actionFor(event,match.checkout,match.scope);
 if(!action)return null;
 return Object.freeze({cohort:'existing_enterprise',action,agreementId:match.candidate.id,clientId:match.candidate.client_id,
  sessionId:match.checkout.id,subscriptionId:match.subscription.id,customerId:match.scope.client.stripe_customer_id,
  subscription:match.subscription,requiresReentry:true});
}
module.exports={classifyExistingEnterprisePaymentEvent,classifyExistingEnterpriseUsageEvent,hasNativeMarker};
