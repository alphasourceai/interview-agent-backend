'use strict';

// Internal, UNMOUNTED GET-only adapter. Reuses the original native scope and
// payment proof; this is not an invoice receipt, writer or effect reservation.
const {isDeepStrictEqual,types:{isProxy}}=require('node:util');
const {readExistingEnterpriseCheckoutScope}=require('./existingEnterpriseCheckoutFunding');
const {proveExistingEnterprisePlatformPeriod}=require('./existingEnterprisePlatformPeriodProof');
const {snapshotStripeSdkData:snapshot}=require('./enterprisePoolPaymentProof');
const {collect}=require('./existingRetailCheckoutFunding');
const {freeze}=require('./existingEnterpriseBillingReceipt');
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const id=(v,p)=>typeof v==='string'&&v.length<=255&&new RegExp(`^${p}_[A-Za-z0-9_]+$`).test(v);
function hold(){throw Object.assign(new Error('enterprise_platform_period_unverified'),{code:'enterprise_platform_period_unverified',status:503});}
const check=v=>{if(!v)hold();};
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]??null]));
function sourceProjection(n){
 return snapshot({version:'enterprise_existing_platform_period_source_v1',agreement_id:n.a.id,client_id:n.client.id,
  agreement:pick(n.a,['id','client_id','status','is_current','superseded_at','superseded_by_agreement_id','voided_at',
   'membership_tier','billing_option','template_version','template_snapshot','checkout_status','checkout_session_id',
   'checkout_paid_at','enterprise_checkout_source','enterprise_checkout_pool_id','enterprise_checkout_prices',
   'enterprise_funding_receipt','enterprise_billing_receipt']),
  pool:pick(n.pool,['id','agreement_id','client_id','status','paid_at','stripe_checkout_session_id','stripe_payment_intent_id',
   'offer_snapshot','offer_digest','quantity_purchased','unit_price_cents','discount_pct','total_cents']),
  client:pick(n.client,['id','stripe_customer_id','stripe_subscription_id','parent_client_id','archived_at']),
  owner:pick(n.owner,['id','client_id','stripe_customer_id']),
  provider_effect_authorized:false,paid_access_authorized:false,payroll_authorized:false});
}
async function readExistingEnterprisePlatformPeriod(input){
 try{
  check(input&&typeof input==='object'&&!isProxy(input)&&[Object.prototype,null].includes(Object.getPrototypeOf(input)));
  const d=Object.getOwnPropertyDescriptors(input),required=['db','stripe','agreementId','clientId','invoiceId'];
  check(Reflect.ownKeys(d).every(k=>[...required,'now'].includes(k))&&required.every(k=>d[k])
   &&Object.values(d).every(v=>v.enumerable&&Object.hasOwn(v,'value')));
  const {db,stripe,agreementId,clientId,invoiceId}=Object.fromEntries(Object.entries(d).map(([k,v])=>[k,v.value]));
  const now=d.now?.value??Date.now;
  check(uuid(agreementId)&&uuid(clientId)&&id(invoiceId,'in')&&typeof now==='function');
  const api=()=>check(typeof stripe?.getApiField==='function'&&stripe.getApiField('version')==='2023-10-16');
  api();
  const load=async()=>{
   const n=await readExistingEnterpriseCheckoutScope({db,agreementId});
   check(n&&n.a.id===agreementId&&n.client.id===clientId&&n.a.client_id===clientId
    &&n.a.status==='signed'&&n.a.checkout_status==='paid'&&n.billingReceipt);
   return n;
  };
  const n=await load(),source=sourceProjection(n),p=n.billingReceipt.funding_receipt.proof;
  check(invoiceId!==p.invoice_id);
  const get=async fn=>{api();const value=snapshot(await fn());api();return value;};
  const pages=fn=>collect(after=>get(()=>fn(after)),async()=>api());
  const account=async()=>{
   const a=await get(()=>stripe.accounts.retrieve());check(a?.object==='account'&&a.id===p.provider_account_id);return a;
  };
  const originalAccount=await account();
  const invoice=await get(()=>stripe.invoices.retrieve(invoiceId));
  check(invoice?.id===invoiceId&&id(invoice.payment_intent,'pi')&&id(invoice.charge,'ch'));
  const lineList=()=>pages(after=>stripe.invoices.listLineItems(invoiceId,{limit:100,...(after?{starting_after:after}:{})}));
  const lines=await lineList();
  const paymentIntent=await get(()=>stripe.paymentIntents.retrieve(invoice.payment_intent));
  const charge=await get(()=>stripe.charges.retrieve(invoice.charge));
  check(charge?.id===invoice.charge);
  const refundList=()=>pages(after=>stripe.refunds.list({charge:charge.id,limit:100,...(after?{starting_after:after}:{})}));
  const refunds=await refundList(),observed=now();check(Number.isSafeInteger(observed));
  const proof=proveExistingEnterprisePlatformPeriod({agreement:n.a,invoice,invoiceLines:lines.data,paymentIntent,charge,
   refunds:refunds.data,providerAccountId:p.provider_account_id,observedAt:new Date(observed).toISOString()});
  check(isDeepStrictEqual(originalAccount,await account())
   &&isDeepStrictEqual(invoice,await get(()=>stripe.invoices.retrieve(invoiceId)))
   &&isDeepStrictEqual(lines,await lineList())
   &&isDeepStrictEqual(paymentIntent,await get(()=>stripe.paymentIntents.retrieve(invoice.payment_intent)))
   &&isDeepStrictEqual(charge,await get(()=>stripe.charges.retrieve(invoice.charge)))
   &&isDeepStrictEqual(refunds,await refundList()));
  check(isDeepStrictEqual(source,sourceProjection(await load())));api();
  return freeze({source,proof});
 }catch(_){hold();}
}
module.exports={readExistingEnterprisePlatformPeriod};
