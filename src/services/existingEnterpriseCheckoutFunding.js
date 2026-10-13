'use strict';

// UNMOUNTED read-only adapter for the existing agreement + native pending pool.
// No provider creates, native writes, Auth, activation or spendable credits.
const {isDeepStrictEqual}=require('node:util');
const {collect}=require('./existingRetailCheckoutFunding');
const {dollarsToCents,metadataFor}=require('./existingEnterpriseCheckoutAttempt');
const {enterprisePoolCheckoutQuote}=require('./enterprisePoolSnapshot');
const {validateEnterpriseSettings}=require('./enterpriseSettings');
const {proveEnterprisePoolPayment,snapshotStripeSdkData}=require('./enterprisePoolPaymentProof');
const {readVerifiedEnterpriseBillingReceipt}=require('./existingEnterpriseBillingReceipt');
const {verifyEnterprisePaymentRows}=require('./existingEnterprisePaymentRows');
const id=v=>typeof v==='string'?v:v?.id;
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const nativeId=(v,p)=>typeof v==='string'&&new RegExp(`^${p}_[A-Za-z0-9_]+$`).test(v);
const epoch=v=>Number.isSafeInteger(v)&&v>0&&v<=253402300799;
const date=v=>typeof v==='string'?Date.parse(v):NaN;
const exactKeys=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)
 &&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
function fail(code,status=409){const e=new Error(code);e.code=code;e.status=status;throw e;}
function check(v,code='enterprise_funding_source_mismatch'){if(!v)fail(code);}
function mapsEqual(actual,expected){return exactKeys(actual,Object.keys(expected))&&Object.keys(expected).every(k=>actual[k]===expected[k]);}
function freeze(v){if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
async function one(db,table,key,value){
 const r=await db.from(table).select('*').eq(key,value).maybeSingle();
 if(r?.error)fail('enterprise_funding_native_read_failed',503);
 check(r?.data&&!Array.isArray(r.data),'enterprise_funding_native_missing');return structuredClone(r.data);
}

async function nativeScope(db,agreementId){
 check(uuid(agreementId));const a=await one(db,'membership_agreements','id',agreementId);
 if(a.enterprise_checkout_source==null&&a.enterprise_checkout_pool_id==null){
  check(a.enterprise_checkout_prices==null&&a.enterprise_billing_receipt==null,'enterprise_funding_untracked_attempt');return null;
 }
 const s=a.enterprise_checkout_source;
 check(exactKeys(s,['version','material','pool_id','created_at','expires_at','embedded','replacement_id','config'])
  &&s.version==='enterprise_existing_pending_v1'&&typeof s.embedded==='boolean'
  &&uuid(s.pool_id)&&a.enterprise_checkout_pool_id===s.pool_id&&a.id===agreementId&&uuid(a.client_id)
  &&a.status==='signed'&&a.is_current===true&&!a.superseded_at&&!a.superseded_by_agreement_id
  &&((a.checkout_status==='pending_payment'&&a.checkout_paid_at==null)||a.checkout_status==='paid')
  &&a.checkout_attempt_source==null&&a.checkout_embedded==null
  &&a.membership_tier==='enterprise'&&a.signer_accepted===true&&nativeId(a.checkout_session_id,'cs')
  &&(s.replacement_id===null||nativeId(s.replacement_id,'sub'))&&a.replaces_stripe_subscription_id===s.replacement_id
  &&(a.replacement_policy??null)===(s.replacement_id?'immediate_cancel':null));
 const billingReceipt=a.enterprise_billing_receipt==null?null:await readVerifiedEnterpriseBillingReceipt({db,agreement:a});
 const client=await one(db,'clients','id',a.client_id),seal=await one(db,'enterprise_v2_execution_seals','agreement_id',a.id);
 const pool=await one(db,'client_interview_pools','id',s.pool_id),prices=a.enterprise_checkout_prices;
 check(client.id===a.client_id&&!client.parent_client_id&&!client.archived_at&&nativeId(client.stripe_customer_id,'cus')
  &&(billingReceipt?client.stripe_subscription_id===billingReceipt.funding_receipt.proof.subscription_id
    &&client.stripe_customer_id===billingReceipt.funding_receipt.proof.customer_id
    :!client.stripe_subscription_id||client.stripe_subscription_id===s.replacement_id),'enterprise_funding_parent_mismatch');
 check(exactKeys(prices,['platform_price_id','pool_price_id'])&&Object.values(prices).every(v=>nativeId(v,'price'))
  &&prices.platform_price_id!==prices.pool_price_id,'enterprise_funding_prices_mismatch');
 const {execution,...unsigned}=a.template_snapshot||{},v=a.template_snapshot?.values;
 check(seal.agreement_id===a.id&&seal.token_hash===a.signer_token_hash&&isDeepStrictEqual(seal.source_snapshot,unsigned)
  &&isDeepStrictEqual(seal.execution,execution)&&execution?.version==='enterprise_execution_v2'
  &&seal.attempt_id===execution.attempt_id&&Number.isFinite(date(a.signed_at))
  &&date(seal.signed_at)===date(a.signed_at)&&date(execution.signed_at)===date(a.signed_at),'enterprise_funding_seal_mismatch');
 for(const k of ['signer_typed_name','signature_image_path','signature_sha256','executed_pdf_path','signer_ip','signer_user_agent'])
  check(a[k]===execution[k],'enterprise_funding_seal_mismatch');
 const quote=enterprisePoolCheckoutQuote(v),settings=validateEnterpriseSettings(v,{planTier:'enterprise'});
 check(quote?.total_cents>0&&v?.membership_tier==='enterprise'&&v.billing_model==='usage'&&v.pool_discount_priced===true
  &&v.billing_option===a.billing_option&&['monthly','annual'].includes(a.billing_option)&&settings.ok);
 for(const k of ['per_role_fee','included_interviews_per_role','additional_interview_fee'])check(/^0+(\.0{1,2})?$/.test(String(v[k])));
 const t={pool:quote,platform:dollarsToCents(v.platform_fee),settings:settings.settings};
 const m=s.material;
 check(exactKeys(m,['agreement_id','client_id','customer_id','template_snapshot','template_version','membership_tier',
  'billing_option','auto_renew','signer_token_hash','agreement_expires_at','execution_seal'])
  &&m.agreement_id===a.id&&m.client_id===client.id&&m.customer_id===client.stripe_customer_id
  &&isDeepStrictEqual(m.template_snapshot,a.template_snapshot)&&m.template_version===a.template_version
  &&m.membership_tier===a.membership_tier&&m.billing_option===a.billing_option&&m.auto_renew===a.auto_renew
  &&m.signer_token_hash===a.signer_token_hash&&date(m.agreement_expires_at)===date(a.agreement_expires_at)
  &&isDeepStrictEqual(m.execution_seal,seal),'enterprise_funding_material_mismatch');
 const b=date(s.created_at),deadline=date(a.agreement_expires_at),expiry=date(s.expires_at);
 check(Number.isFinite(b)&&Number.isFinite(deadline)&&Number.isFinite(expiry)&&date(a.signed_at)<=b&&b<deadline
  &&date(a.checkout_created_at)===b,'enterprise_funding_clock_mismatch');
 const d=new Date(b),anchor=Math.floor(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)/1000);
 check(Math.floor(expiry/1000)===Math.floor(Math.min(deadline,anchor*1000-1000,b+86400000-1000)/1000)
  &&expiry>b,'enterprise_funding_clock_mismatch');
 check(exactKeys(s.config,['public_backend_base','public_sign_base'])&&Object.values(s.config).every(x=>
  typeof x==='string'&&x.length<=2048&&/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~/-]+)?$/.test(x)));
 if(a.checkout_status==='paid'){
  check(billingReceipt!==null,'enterprise_funding_paid_receipt_missing');
  verifyEnterprisePaymentRows({agreement:a,pool,billingReceipt});
 }
 check(pool.id===s.pool_id&&pool.agreement_id===a.id&&pool.client_id===client.id
  &&(a.checkout_status==='paid'||pool.status==='pending'&&pool.paid_at==null&&pool.stripe_payment_intent_id==null)
  &&pool.stripe_checkout_session_id===a.checkout_session_id
  &&isDeepStrictEqual(pool.offer_snapshot,v.pool_offer_snapshot)&&pool.offer_digest===v.pool_offer_digest
  &&pool.quantity_purchased===quote.quantity&&pool.unit_price_cents===quote.unit_price_cents
  &&pool.discount_pct===quote.discount_pct&&pool.total_cents===quote.total_cents,'enterprise_funding_pool_mismatch');
 const intents=await db.from('public_purchase_intents').select('id',{count:'exact'}).eq('agreement_id',a.id);
 check(!intents?.error&&intents?.count===0&&Array.isArray(intents.data)&&intents.data.length===0);
 // Global provider-customer owner, not a client-filtered accidental duplicate.
 const owners=await db.from('billing_customers').select('id,client_id,stripe_customer_id',{count:'exact'}).eq('stripe_customer_id',client.stripe_customer_id);
 check(!owners?.error&&owners?.count===1&&Array.isArray(owners.data)&&owners.data.length===1
  &&owners.data[0].client_id===client.id&&owners.data[0].stripe_customer_id===client.stripe_customer_id,'enterprise_funding_customer_owner_mismatch');
 return {a,seal,pool,client,owner:structuredClone(owners.data[0]),t,anchor,b,deadline,expiry,billingReceipt};
}

async function readExistingEnterpriseCheckoutScope({db,agreementId}){
 check(uuid(agreementId),'enterprise_funding_agreement_invalid',503);
 return nativeScope(db,agreementId);
}

async function readExistingEnterpriseCheckoutFunding({db,stripe,agreementId,eventSessionId,eventSubscriptionId,eventInvoiceId,
 eventLivemode,assertFence=async()=>{},now=Date.now}){
 await assertFence();const n=await nativeScope(db,agreementId);if(!n)return null;
 const {a,t,client,pool}=n,s=a.enterprise_checkout_source,metadata=metadataFor(a,t,s),prices=a.enterprise_checkout_prices;
 check(typeof stripe?.getApiField==='function'&&stripe.getApiField('version')==='2023-10-16','enterprise_funding_api_version_mismatch');
 const read=async fn=>{await assertFence();const v=snapshotStripeSdkData(await fn());await assertFence();return v;};
 const pages=fn=>collect(after=>read(()=>fn(after)),assertFence);
 const account=await read(()=>stripe.accounts.retrieve());check(nativeId(account?.id,'acct')&&account.object==='account','enterprise_funding_account_mismatch');
 const customer=await read(()=>stripe.customers.retrieve(client.stripe_customer_id));
 const zeroMap=x=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.values(x).every(v=>v===0);
 check(customer?.object==='customer'&&customer.id===client.stripe_customer_id&&customer.deleted!==true&&customer.discount===null
  &&customer.balance===0&&typeof customer.livemode==='boolean'
  &&(!Object.hasOwn(customer,'discounts')||customer.discounts===null||Array.isArray(customer.discounts)&&customer.discounts.length===0)
  &&(customer.invoice_credit_balance==null||zeroMap(customer.invoice_credit_balance))
  &&(customer.cash_balance==null||typeof customer.cash_balance==='object'&&!Array.isArray(customer.cash_balance)
   &&(customer.cash_balance.available==null||zeroMap(customer.cash_balance.available))),'enterprise_funding_customer_adjustment_denied');
 const checkout=await read(()=>stripe.checkout.sessions.retrieve(a.checkout_session_id));
 check(checkout?.object==='checkout.session'&&checkout.id===a.checkout_session_id&&checkout.status==='complete'
  &&checkout.payment_status==='paid'&&checkout.mode==='subscription'&&checkout.livemode===customer.livemode
  &&id(checkout.customer)===client.stripe_customer_id&&nativeId(id(checkout.subscription),'sub')
  &&epoch(checkout.created)&&checkout.created>=Math.floor(n.b/1000)&&checkout.created<checkout.expires_at
  &&checkout.expires_at===Math.floor(n.expiry/1000)
  &&checkout.ui_mode===(s.embedded?'embedded':'hosted')&&checkout.allow_promotion_codes===false
  &&mapsEqual(checkout.metadata,metadata.session),'enterprise_funding_session_mismatch');
 const success=`${s.config.public_backend_base}/checkout/subscription-success?session_id={CHECKOUT_SESSION_ID}&client_id=${encodeURIComponent(client.id)}`;
 check(s.embedded?checkout.return_url===success:checkout.success_url===success,'enterprise_funding_session_mismatch');
 check(s.embedded?checkout.success_url==null&&checkout.cancel_url==null:checkout.return_url==null,'enterprise_funding_session_mismatch');
 if(!s.embedded){let cancel;try{cancel=new URL(checkout.cancel_url);}catch(_){}
  check(cancel&&checkout.cancel_url.startsWith(`${s.config.public_sign_base}/membership-agreement/sign/`)
   &&!cancel.username&&!cancel.password&&!cancel.search&&!cancel.hash,'enterprise_funding_session_mismatch');
  const token=cancel.pathname.split('/').at(-1),hash=require('node:crypto').createHash('sha256').update(token).digest('hex');
  check(token&&checkout.cancel_url===`${s.config.public_sign_base}/membership-agreement/sign/${token}`
   &&hash===a.signer_token_hash,'enterprise_funding_session_mismatch');
 }
 check(eventSessionId==null||eventSessionId===checkout.id,'enterprise_funding_event_mismatch');
 check(eventLivemode==null||typeof eventLivemode==='boolean'&&eventLivemode===checkout.livemode,'enterprise_funding_event_mismatch');
 const subscription=await read(()=>stripe.subscriptions.retrieve(id(checkout.subscription)));
 check(subscription?.id===id(checkout.subscription)&&epoch(subscription.created)&&subscription.created>=checkout.created
  &&subscription.billing_cycle_anchor===n.anchor
  &&mapsEqual(subscription.metadata,metadata.session),'enterprise_funding_subscription_mismatch');
 check(eventSubscriptionId==null||eventSubscriptionId===subscription.id,'enterprise_funding_event_mismatch');
 const subscriptionItems=await pages(after=>stripe.subscriptionItems.list({subscription:subscription.id,limit:100,...(after?{starting_after:after}:{})}));
 const checkoutLines=await pages(after=>stripe.checkout.sessions.listLineItems(checkout.id,{limit:100,...(after?{starting_after:after}:{})}));
 let invoice;
 if(checkout.invoice===null){
  const all=await pages(after=>stripe.invoices.list({subscription:subscription.id,limit:100,...(after?{starting_after:after}:{})}));
  const initial=all.data.filter(x=>x.billing_reason==='subscription_create');
  check(initial.length===1&&nativeId(initial[0].id,'in'),'enterprise_funding_initial_invoice_ambiguous');
  invoice=await read(()=>stripe.invoices.retrieve(initial[0].id));check(invoice.id===initial[0].id,'enterprise_funding_invoice_mismatch');
 }else{
  check(nativeId(id(checkout.invoice),'in'),'enterprise_funding_invoice_mismatch');
  invoice=await read(()=>stripe.invoices.retrieve(id(checkout.invoice)));check(invoice.id===id(checkout.invoice),'enterprise_funding_invoice_mismatch');
 }
 check(eventInvoiceId==null||eventInvoiceId===invoice.id,'enterprise_funding_event_mismatch');
 // Parentage is this authenticated collection request, NOT nonexistent row.invoice.
 const invoiceLines=await pages(after=>stripe.invoices.listLineItems(invoice.id,{limit:100,...(after?{starting_after:after}:{})}));
 const actualPrices={};
 for(const [key,map]of [['platform_price_id',metadata.platform],['pool_price_id',metadata.pool]]){
  const p=await read(()=>stripe.prices.retrieve(prices[key]));check(p.id===prices[key]&&mapsEqual(p.metadata,map),'enterprise_funding_price_mismatch');actualPrices[p.id]=p;
 }
 for(const l of [...subscriptionItems.data,...checkoutLines.data,...invoiceLines.data]){
  const p=actualPrices[id(l.price)];check(p,'enterprise_funding_price_mismatch');
  if(typeof l.price==='string')l.price=p;else check(isDeepStrictEqual(l.price,p),'enterprise_funding_expanded_price_mismatch');
 }
 check(subscriptionItems.data.length===1&&subscriptionItems.data[0].object==='subscription_item','enterprise_funding_subscription_mismatch');
 check(nativeId(id(invoice.payment_intent),'pi')&&nativeId(id(invoice.charge),'ch'),'enterprise_funding_invoice_mismatch');
 const paymentIntent=await read(()=>stripe.paymentIntents.retrieve(id(invoice.payment_intent))),charge=await read(()=>stripe.charges.retrieve(id(invoice.charge)));
 const refunds=await pages(after=>stripe.refunds.list({charge:charge.id,limit:100,...(after?{starting_after:after}:{})}));
 const paid=invoice.status_transitions?.paid_at,observedAt=Math.floor(now()/1000);
 check(epoch(paid)&&epoch(observedAt)&&paid>=Math.ceil(n.b/1000)&&paid*1000>=date(a.signed_at)
  &&epoch(invoice.created)&&invoice.created>=checkout.created&&paid>=invoice.created&&paid<=observedAt&&paid*1000<n.deadline,
 'enterprise_funding_paid_clock_mismatch');
 const proof=proveEnterprisePoolPayment({binding:{poolId:pool.id,clientId:client.id,providerAccountId:account.id,livemode:customer.livemode,
  customerId:customer.id,checkoutSessionId:checkout.id,subscriptionId:subscription.id,platformItemId:subscriptionItems.data[0]?.id,
  platformPriceId:prices.platform_price_id,poolPriceId:prices.pool_price_id,platformCents:t.platform,platformInterval:a.billing_option==='annual'?'year':'month',
  snapshot:pool.offer_snapshot,digest:pool.offer_digest},account,checkout,checkoutLines,subscription:{...subscription,items:subscriptionItems},
  invoice:{...invoice,lines:invoiceLines},paymentIntent,charge,refunds,observedAt});
 await assertFence();const current=await nativeScope(db,agreementId);
 check(current&&isDeepStrictEqual(current,n),'enterprise_funding_source_changed');await assertFence();
 return freeze({...proof,agreementId:a.id,customerId:customer.id,checkoutSessionId:checkout.id,sourceTemplate:a.template_snapshot,
  sourceTemplateVersion:a.template_version,sourceCheckout:s,sourcePrices:prices,sourceSeal:n.seal,sourcePool:pool,subscription,
  sourceBillingReceipt:n.billingReceipt,sourceFundingReceipt:a.enterprise_funding_receipt??null});
}

module.exports={readExistingEnterpriseCheckoutFunding,readExistingEnterpriseCheckoutScope};
