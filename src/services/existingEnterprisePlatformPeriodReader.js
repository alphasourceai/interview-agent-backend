'use strict';

// Internal GET-only adapter. Reuses the original native scope and
// payment proof; this is not an invoice receipt, writer or effect reservation.
const {isDeepStrictEqual,types:{isProxy}}=require('node:util');
const {readExistingEnterpriseCheckoutScope}=require('./existingEnterpriseCheckoutFunding');
const {proveExistingEnterprisePlatformPeriod}=require('./existingEnterprisePlatformPeriodProof');
const {snapshotStripeSdkData:snapshot,snapshotEnterpriseUsageCensusData:nativeSnapshot}=require('./enterprisePoolPaymentProof');
const {collect}=require('./existingRetailCheckoutFunding');
const {freeze}=require('./existingEnterpriseBillingReceipt');
const {anchoredMonthInstant}=require('./membershipOffers');
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const id=(v,p)=>typeof v==='string'&&v.length<=255&&new RegExp(`^${p}_[A-Za-z0-9_]+$`).test(v);
function hold(){throw Object.assign(new Error('enterprise_platform_period_unverified'),{code:'enterprise_platform_period_unverified',status:503});}
const check=v=>{if(!v)hold();};
const pick=(v,keys)=>Object.fromEntries(keys.map(k=>[k,v[k]??null]));
function sourceProjection(n){
 // This is a native sealed agreement (including rendered HTML), not an SDK response.
 // Reuse the bounded native profile; provider/proof snapshots remain unchanged.
 return nativeSnapshot({version:'enterprise_existing_platform_period_source_v1',agreement_id:n.a.id,client_id:n.client.id,
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
  check(Reflect.ownKeys(d).length===required.length&&Reflect.ownKeys(d).every(k=>required.includes(k))&&required.every(k=>d[k])
   &&Object.values(d).every(v=>v.enumerable&&Object.hasOwn(v,'value')));
  const {db,stripe,agreementId,clientId,invoiceId}=Object.fromEntries(Object.entries(d).map(([k,v])=>[k,v.value]));
  check(uuid(agreementId)&&uuid(clientId)&&id(invoiceId,'in'));
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
  const refunds=await refundList(),observed=Date.now();check(Number.isSafeInteger(observed));
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
const providerTuple=c=>snapshot({subscription_status:c.subscription_status??null,current_term_end:c.current_term_end??null,
 stripe_subscription_schedule_id:c.stripe_subscription_schedule_id??null,cancel_at_term_end:c.cancel_at_term_end??null});
async function ownedCancellationJournal(db,agreementId,clientId,w,cancelAt){
 const result=snapshot(await db.rpc('change_enterprise_existing_renewal',{p_agreement:agreementId,p_client:clientId,
  p_billing:w,p_action:'read',p_auto_renew:null})),state=result?.data,r=state?.operation;
 check(!result?.error&&state?.provider_effect_authorized===false&&state.paid_access_authorized===false&&state.payroll_authorized===false
  &&r?.version==='enterprise_existing_renewal_change_v2'&&uuid(r.operation_id)&&isDeepStrictEqual(r.source,snapshot(w))
  &&Date.parse(r.effective_at)===cancelAt*1000&&typeof r.requested_auto_renew==='boolean');
 const carried=uuid(r.provider_cancel_operation_id)&&r.provider_cancel_operation_id!==r.operation_id;
 const off=r.requested_auto_renew===false&&(['claimed','unknown','held','applied'].includes(r.status)&&typeof r.sent_at==='string'
  ||r.status==='applied'&&carried);
 const on=r.requested_auto_renew===true&&['waiting','held','unknown'].includes(r.status)&&carried;
 // Applied ON retains only HISTORICAL provenance. Claimed ON is in-flight;
 // retry the observer after its setting operation settles, never infer owner.
 check(off||on);return r;
}
// Internal observer. Provider state is not funding, a legal
// contract window or renewal consent. Native CAS may project four fields only.
async function readExistingEnterpriseSubscriptionStatus(input){
 try{
  check(input&&typeof input==='object'&&!isProxy(input)&&[Object.prototype,null].includes(Object.getPrototypeOf(input)));
  const d=Object.getOwnPropertyDescriptors(input),keys=['db','stripe','agreementId','clientId'];
  check(Reflect.ownKeys(d).length===keys.length&&keys.every(k=>d[k])
   &&Reflect.ownKeys(d).every(k=>keys.includes(k))&&Object.values(d).every(v=>v.enumerable&&Object.hasOwn(v,'value')));
  const {db,stripe,agreementId,clientId}=Object.fromEntries(Object.entries(d).map(([k,v])=>[k,v.value]));
  check(uuid(agreementId)&&uuid(clientId));
  const api=()=>check(typeof stripe?.getApiField==='function'&&stripe.getApiField('version')==='2023-10-16');api();
  const load=async()=>{
   const n=await readExistingEnterpriseCheckoutScope({db,agreementId});
   check(n&&n.client.id===clientId&&n.a.client_id===clientId&&n.a.checkout_status==='paid'&&n.billingReceipt);return n;
  };
  const n=await load(),source=sourceProjection(n),expected=providerTuple(n.client),w=n.billingReceipt,p=w.funding_receipt.proof;
  const get=async fn=>{api();const value=snapshot(await fn());api();return value;};
  const account=await get(()=>stripe.accounts.retrieve());check(account?.object==='account'&&account.id===p.provider_account_id);
  const sub=await get(()=>stripe.subscriptions.retrieve(p.subscription_id)),item=sub?.items?.data?.[0],price=item?.price;
  check(sub?.object==='subscription'&&sub.id===p.subscription_id&&sub.customer===p.customer_id&&sub.livemode===p.livemode
   &&sub.currency==='usd'&&sub.collection_method==='charge_automatically'
   &&['active','past_due','unpaid','canceled','incomplete','incomplete_expired','paused'].includes(sub.status)
   &&sub.items?.object==='list'&&sub.items.has_more===false&&Array.isArray(sub.items.data)&&sub.items.data.length===1
   &&item?.object==='subscription_item'&&item.id===p.platform_item_id&&item.subscription===p.subscription_id&&item.quantity===1
   &&price?.object==='price'&&price.id===p.platform_price_id&&price.livemode===p.livemode&&price.currency==='usd'
   &&price.unit_amount===p.platform_nominal_cents&&price.type==='recurring'&&price.billing_scheme==='per_unit'
   &&price.recurring?.interval===p.platform_interval&&price.recurring.interval_count===1&&price.recurring.usage_type==='licensed'
   &&price.transform_quantity===null&&price.tiers_mode===null&&price.custom_unit_amount===null
   &&sub.schedule===null&&sub.pause_collection===null&&sub.trial_start===null&&sub.trial_end===null&&sub.test_clock===null
   &&(sub.cancel_at===null||Number.isSafeInteger(sub.cancel_at)&&sub.cancel_at>0&&sub.cancel_at<=253402300799)
   &&typeof sub.cancel_at_period_end==='boolean'&&sub.billing_cycle_anchor===w.subscription.current_period_end);
  const start=sub.current_period_start,end=sub.current_period_end,anchor=w.subscription.current_period_end;
  const epoch=v=>Number.isSafeInteger(v)&&v>0&&v<=253402300799;
  const now=Date.now();check(Number.isSafeInteger(now)&&epoch(start)&&epoch(end)&&end>start&&start*1000<=now
   &&epoch(sub.created)&&sub.created>=Math.floor(Date.parse(n.a.enterprise_checkout_source.created_at)/1000)
   &&sub.created*1000<=Date.parse(p.payment_success_at));
  let journal=null;
  if(sub.cancel_at!==null){
   check(start>=anchor&&end===sub.cancel_at&&['active','past_due','unpaid','canceled'].includes(sub.status));
   journal=await ownedCancellationJournal(db,agreementId,clientId,w,sub.cancel_at);
  }
  if(start<anchor){check(sub.cancel_at===null&&end===anchor&&start>=Math.floor(Date.parse(n.a.enterprise_checkout_source.created_at)/1000)
   &&start*1000<=Date.parse(p.payment_success_at));}
  else{
   const a=new Date(anchor*1000),s=new Date(start*1000),offset=(s.getUTCFullYear()-a.getUTCFullYear())*12+s.getUTCMonth()-a.getUTCMonth();
   const span=p.platform_interval==='month'?1:12;
   check(offset>=0&&offset%span===0&&offset/span<=999
    &&Date.parse(anchoredMonthInstant(a.toISOString(),offset))===start*1000
    &&(journal?Date.parse(anchoredMonthInstant(a.toISOString(),offset+span))>=end*1000
     :Date.parse(anchoredMonthInstant(a.toISOString(),offset+span))===end*1000));
  }
  check(isDeepStrictEqual(account,await get(()=>stripe.accounts.retrieve()))
   &&isDeepStrictEqual(sub,await get(()=>stripe.subscriptions.retrieve(p.subscription_id))));
  const final=await load();check(isDeepStrictEqual(source,sourceProjection(final))&&isDeepStrictEqual(expected,providerTuple(final.client)));api();
  if(journal)check(isDeepStrictEqual(journal,await ownedCancellationJournal(db,agreementId,clientId,w,sub.cancel_at)));
  return freeze({source,billingReceipt:w,expected,proof:{version:journal?'enterprise_existing_subscription_status_proof_v2':'enterprise_existing_subscription_status_proof_v1',
   agreement_id:agreementId,client_id:clientId,provider_account_id:p.provider_account_id,livemode:p.livemode,currency:'usd',
   customer_id:p.customer_id,subscription_id:p.subscription_id,subscription_item_id:p.platform_item_id,price_id:p.platform_price_id,
   platform_nominal_cents:p.platform_nominal_cents,platform_interval:p.platform_interval,billing_cycle_anchor:anchor,
   provider_period_start:start,provider_period_end:end,subscription_status:sub.status,cancel_at_term_end:sub.cancel_at_period_end,
   stripe_subscription_schedule_id:null,observed_at:new Date(now).toISOString(),
   ...(journal?{provider_cancel_at:sub.cancel_at,renewal_operation_id:journal.operation_id}:{})}});
 }catch(_){hold();}
}
module.exports={readExistingEnterprisePlatformPeriod,readExistingEnterpriseSubscriptionStatus};
