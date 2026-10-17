'use strict';

// LOCAL/UNMOUNTED proof for the existing Enterprise subscription's platform
// invoice. Does not collect, grant pool credits/access, qualify payroll or write.
// Native receipt and GET-only reader/writer gates remain separate requirements.
const {snapshotStripeSdkData:snapshot,snapshotEnterpriseUsageCensusData:nativeSnapshot}=require('./enterprisePoolPaymentProof');
const {verifyEnterpriseBillingReceipt}=require('./existingEnterpriseBillingReceipt');
const {exactPaymentTime}=require('./existingEnterprisePaymentRows');
const {isDeepStrictEqual}=require('node:util');
const {anchoredMonthInstant}=require('./membershipOffers');
const epoch=n=>Number.isSafeInteger(n)&&n>0&&n<=253402300799;
const cents=n=>Number.isSafeInteger(n)&&n>=0&&n<=2147483647;
const id=(v,p)=>typeof v==='string'&&v.length<=255&&new RegExp(`^${p}_[A-Za-z0-9_]+$`).test(v);
function hold(){throw Object.assign(new Error('enterprise_platform_period_unverified'),{code:'enterprise_platform_period_unverified',status:503});}
const check=v=>{if(!v)hold();};
function sum(values,kind){check(Array.isArray(values));return values.reduce((n,v)=>{
 check(cents(v?.amount)&&cents(n+v.amount));
 const ref=kind==='tax'?v.tax_rate:v.discount,refId=typeof ref==='string'?ref:ref?.id;
 check(id(refId,kind==='tax'?'txr':'di')&&(kind!=='tax'||v.inclusive===false));
 return n+v.amount;
},0);}
function proveExistingEnterprisePlatformPeriod(raw){
 try{
  // Snapshot before destructuring so caller getters/proxies never execute.
  // Only the native agreement uses the larger bounded profile; every provider
  // field is checked again under the unchanged SDK limits before proof use.
  const whole=nativeSnapshot(raw),{agreement,...provider}=whole;
  const x={...snapshot(provider),agreement},a=x.agreement,i=x.invoice,lines=x.invoiceLines,pi=x.paymentIntent,ch=x.charge;
  check(a?.checkout_status==='paid'&&['signed','active'].includes(a.status)&&a.is_current===true
   &&a.superseded_by_agreement_id===null&&a.voided_at==null);
  const w=verifyEnterpriseBillingReceipt(a.enterprise_billing_receipt,{source:a.enterprise_checkout_source,
   prices:a.enterprise_checkout_prices,fundingReceipt:a.enterprise_funding_receipt});
  const p=w.funding_receipt.proof,material=a.enterprise_checkout_source.material;
  check(a.id===material.agreement_id&&a.client_id===material.client_id&&p.client_id===a.client_id
   &&a.membership_tier==='enterprise'&&a.billing_option===material.billing_option
   &&a.checkout_session_id===p.checkout_session_id&&a.enterprise_checkout_pool_id===p.pool_id
   &&exactPaymentTime(a.checkout_paid_at,p.payment_success_at)&&isDeepStrictEqual(a.template_snapshot,material.template_snapshot));
  const span=p.platform_interval==='month'?1:p.platform_interval==='year'?12:0;
  const anchor=w.subscription.current_period_end,observed=Math.floor(Date.parse(x.observedAt)/1000);
  check(typeof x.observedAt==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(x.observedAt)
   &&span>0&&epoch(anchor)&&epoch(observed)&&x.providerAccountId===p.provider_account_id);
  check(i?.object==='invoice'&&id(i.id,'in')&&i.id!==p.invoice_id&&i.customer===p.customer_id
   &&i.subscription===p.subscription_id&&i.livemode===p.livemode&&i.currency==='usd'
   &&i.billing_reason==='subscription_cycle'&&i.collection_method==='charge_automatically'
   &&Array.isArray(lines)&&lines.length===1);
  const l=lines[0],price=l?.price,start=l?.period?.start,end=l?.period?.end;
  check(l?.object==='line_item'&&id(l.id,'il')&&![p.pool_line_id].includes(l.id)
   &&l.type==='subscription'&&l.proration===false&&l.quantity===1&&l.currency==='usd'
   &&l.subscription===p.subscription_id&&l.subscription_item===p.platform_item_id
   &&(!Object.hasOwn(l,'invoice')||l.invoice===null||l.invoice===i.id)
   &&price?.object==='price'&&price.id===p.platform_price_id&&price.livemode===p.livemode
   &&price.currency==='usd'&&price.unit_amount===p.platform_nominal_cents&&price.type==='recurring'
   &&price.recurring?.interval===p.platform_interval&&price.recurring.interval_count===1
   &&price.recurring.usage_type==='licensed'&&price.billing_scheme==='per_unit'
   &&price.transform_quantity===null&&price.tiers_mode===null&&price.custom_unit_amount===null
   &&l.amount===p.platform_nominal_cents&&epoch(start)&&epoch(end));
  const first=new Date(anchor*1000),current=new Date(start*1000);
  const offset=(current.getUTCFullYear()-first.getUTCFullYear())*12+current.getUTCMonth()-first.getUTCMonth();
  check(offset>=0&&offset%span===0&&offset/span<=999
   &&Date.parse(anchoredMonthInstant(first.toISOString(),offset))/1000===start
   &&Date.parse(anchoredMonthInstant(first.toISOString(),offset+span))/1000===end);
  const gross=p.platform_nominal_cents,discount=sum(l.discount_amounts,'discount'),tax=sum(l.tax_amounts,'tax'),net=gross-discount,total=net+tax;
  check(cents(gross)&&gross>0&&cents(net)&&net>0&&cents(total)&&sum(i.total_discount_amounts,'discount')===discount
   &&sum(i.total_tax_amounts,'tax')===tax&&i.subtotal===gross&&i.total===total&&i.amount_due===total
   &&i.amount_paid===total&&i.amount_remaining===0&&i.paid===true&&i.status==='paid'
   &&i.paid_out_of_band===false&&i.starting_balance===0&&i.ending_balance===0
   &&i.pre_payment_credit_notes_amount===0&&i.post_payment_credit_notes_amount===0
   &&i.application_fee_amount===null&&i.transfer_data===null&&i.on_behalf_of===null&&i.shipping_cost===null);
  const paid=i.status_transitions?.paid_at;
  check(epoch(paid)&&epoch(i.created)&&i.created<=paid&&paid<=observed&&paid*1000>=Date.parse(p.payment_success_at));
  check(id(pi?.id,'pi')&&id(ch?.id,'ch')&&pi.id!==p.payment_intent_id&&ch.id!==p.charge_id
   &&i.payment_intent===pi.id&&i.charge===ch.id&&pi.object==='payment_intent'&&ch.object==='charge'
   &&pi.invoice===i.id&&pi.latest_charge===ch.id&&ch.invoice===i.id&&ch.payment_intent===pi.id
   &&id(pi.payment_method,'pm')&&pi.payment_method===ch.payment_method);
  for(const o of [pi,ch])check(o.customer===p.customer_id&&o.livemode===p.livemode&&o.currency==='usd'
   &&o.amount===total&&epoch(o.created)&&o.created<=paid);
  check(pi.status==='succeeded'&&pi.amount_received===total&&ch.status==='succeeded'&&ch.paid===true
   &&ch.captured===true&&ch.amount_captured===total&&ch.amount_refunded===0&&ch.refunded===false&&ch.disputed===false
   &&(!Object.hasOwn(ch,'dispute')||ch.dispute===null)&&Array.isArray(x.refunds)&&x.refunds.length===0
   &&(!Object.hasOwn(ch,'refunds')||ch.refunds===null||ch.refunds?.object==='list'&&ch.refunds.has_more===false
    &&Array.isArray(ch.refunds.data)&&ch.refunds.data.length===0));
  return Object.freeze({version:'enterprise_existing_platform_period_proof_v1',agreement_id:a.id,client_id:a.client_id,
   provider_account_id:p.provider_account_id,livemode:p.livemode,currency:'usd',invoice_id:i.id,line_id:l.id,
   subscription_id:p.subscription_id,subscription_item_id:p.platform_item_id,customer_id:p.customer_id,price_id:p.platform_price_id,
   ordinal:offset/span+1,provider_period_start:start,provider_period_end:end,platform_gross_cents:gross,
   platform_discount_cents:discount,platform_net_cents:net,tax_cents:tax,cash_cents:total,
   original_paid_at:p.payment_success_at,paid_at:new Date(paid*1000).toISOString(),payment_intent_id:pi.id,charge_id:ch.id,
   provider_effect_authorized:false,paid_access_authorized:false,payroll_authorized:false});
 }catch(_){hold();}
}
module.exports={proveExistingEnterprisePlatformPeriod};
