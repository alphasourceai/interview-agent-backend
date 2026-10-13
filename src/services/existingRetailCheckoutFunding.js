'use strict';

// Readback/proof adapter for the EXISTING accepted agreement + Checkout record.
// No provider mutation, contract/version store, account setup or receipt writes.
const { readSavedRetailCheckoutTerms } = require('./savedMembershipCheckoutTerms');
const { isDeepStrictEqual } = require('node:util');
function fail(code, permanent = false) { const e = new Error(code); e.code = code; e.status = 409; if(permanent)e.permanentFailure=true; throw e; }
function check(value, code = 'retail_funding_mismatch') { if (!value) fail(code); }
const id = value => typeof value === 'string' ? value : value?.id;
const cents = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const epoch = value => Number.isSafeInteger(value) && value > 0 && value <= 253402300799;
function sum(values) { const n=values.reduce((a,b)=>a+b,0);check(cents(n),'retail_funding_amount_invalid');return n; }
function list(value) { check(value?.object==='list' && value.has_more===false && Array.isArray(value.data),'retail_funding_list_incomplete');return value.data; }
async function collect(fetch, assertFence) {
  const data=[],seen=new Set();let after;
  // Bounded, complete pagination, not an implicit first-page receipt. Overflow
  // refuses/retries rather than truncating and claiming financial acceptance.
  for(let page=0;page<100;page++) {
    await assertFence();const r=await fetch(after);
    check(r?.object==='list' && typeof r.has_more==='boolean' && Array.isArray(r.data),'retail_funding_list_incomplete');
    for(const item of r.data){check(typeof item?.id==='string' && item.id && !seen.has(item.id),'retail_funding_list_identity');seen.add(item.id);data.push(item);}
    if(!r.has_more)return{object:'list',data,has_more:false};
    check(r.data.length>0,'retail_funding_list_incomplete');after=r.data.at(-1).id;
  }
  fail('retail_funding_list_incomplete');
}
function discounts(value) {
  check(Array.isArray(value),'retail_funding_discounts_unverified');
  return sum(value.map(d=>{check(cents(d?.amount) && typeof id(d.discount)==='string' && id(d.discount).startsWith('di_'),'retail_funding_discounts_unverified');return d.amount;}));
}
function taxes(value) {
  check(Array.isArray(value),'retail_funding_tax_unverified');
  return sum(value.map(t=>{check(cents(t?.amount) && t.inclusive===false && typeof id(t.tax_rate)==='string','retail_funding_tax_unverified');return t.amount;}));
}
function priceMatches(price, amount, recurring) {
  return price?.object==='price' && typeof price.id==='string' && price.id.startsWith('price_') && price.currency==='usd'
    && price.unit_amount===amount && price.type===(recurring?'recurring':'one_time')
    && (recurring ? price.recurring?.interval==='month' && price.recurring.interval_count===recurring.interval_count
      && price.recurring.usage_type==='licensed' : price.recurring===null);
}
function sessionIdentity({checkout,subscription,expected,eventLivemode,eventSubscriptionId}) {
  check(checkout?.object==='checkout.session' && checkout.id===expected.checkoutId && checkout.mode==='subscription'
    && checkout.status==='complete' && checkout.currency==='usd' && typeof checkout.livemode==='boolean'
    && id(checkout.customer)===expected.customerId && id(checkout.subscription)===subscription?.id,'retail_funding_session_identity');
  check(typeof eventLivemode==='boolean' && eventLivemode===checkout.livemode,'retail_funding_livemode_mismatch');
  check(!eventSubscriptionId || eventSubscriptionId===subscription.id,'retail_funding_subscription_mismatch');
  check(subscription?.object==='subscription' && subscription.currency==='usd' && subscription.livemode===checkout.livemode
    && id(subscription.customer)===expected.customerId,'retail_funding_subscription_mismatch');
}
function verifyExistingRetailFunding({offer,checkout,checkoutLines,subscription,subscriptionItems,invoice,invoiceLines,paymentIntent,charge,expected}) {
  check((checkout.payment_status==='paid' || invoice?.total===0 && checkout.payment_status==='no_payment_required')
    && subscription.status==='active','retail_funding_not_settled');
  check(invoice?.object==='invoice' && invoice.billing_reason==='subscription_create' && invoice.currency==='usd'
    && invoice.livemode===checkout.livemode && id(invoice.customer)===expected.customerId
    && id(invoice.subscription)===subscription.id && (!id(checkout.invoice)||id(checkout.invoice)===invoice.id),'retail_funding_invoice_identity');
  const paid=invoice.status_transitions?.paid_at;
  check(epoch(paid) && epoch(invoice.created) && epoch(checkout.created) && invoice.created>=checkout.created
    && invoice.created<=paid && Number.isFinite(Date.parse(expected.signedAt)) && paid*1000>=Date.parse(expected.signedAt)
    && paid*1000<Date.parse(expected.agreementDeadline)
    && (!expected.intentDeadline || paid*1000<Date.parse(expected.intentDeadline)),'retail_funding_paid_clock_invalid');
  const csLines=list(checkoutLines),subItems=list(subscriptionItems),lines=list(invoiceLines);
  check(csLines.length===(offer.first_role_prepay.selected?2:1) && lines.length===csLines.length && subItems.length===1,'retail_funding_unexpected_lines');
  const platform=csLines.filter(l=>priceMatches(l.price,offer.platform_payment_cents,offer.stripe_recurrence));
  const role=csLines.filter(l=>priceMatches(l.price,offer.first_role_prepay.amount_cents,null));
  check(platform.length===1 && role.length===(offer.first_role_prepay.selected?1:0),'retail_funding_price_mismatch');
  check(csLines.every(l=>l.quantity===1 && l.currency==='usd' && l.amount_subtotal===l.price.unit_amount
    && cents(l.amount_discount) && cents(l.amount_tax) && cents(l.amount_total)),'retail_funding_checkout_line_mismatch');
  const item=subItems[0];
  check(item.quantity===1 && id(item.subscription)===subscription.id && id(item.price)===platform[0].price.id
    && priceMatches(item.price,offer.platform_payment_cents,offer.stripe_recurrence),'retail_funding_price_mismatch');
  const totals=[];let platformNet,roleNet=0,platformDiscount,roleDiscount=0,lineTaxes=0;
  for(const l of lines) {
    const isPlatform=id(l.price)===platform[0].price.id,isRole=role[0] && id(l.price)===role[0].price.id;
    check((isPlatform||isRole) && l.quantity===1 && l.currency==='usd' && l.proration===false
      && l.amount===(isPlatform?offer.platform_payment_cents:offer.first_role_prepay.amount_cents)
      && (isPlatform ? l.type==='subscription' && id(l.subscription)===subscription.id && id(l.subscription_item)===item.id
        : l.type==='invoiceitem' && !l.subscription_item && (!l.subscription || id(l.subscription)===subscription.id)), 'retail_funding_invoice_line_mismatch');
    const d=discounts(l.discount_amounts),t=taxes(l.tax_amounts);
    const csLine=isPlatform?platform[0]:role[0];
    check(csLine.amount_discount===d && csLine.amount_tax===t && csLine.amount_total===l.amount-d+t,'retail_funding_checkout_line_mismatch');
    check(d<=l.amount && (offer.payment_option!=='prepaid' || d===0),'retail_funding_discount_mismatch');
    totals.push(d);lineTaxes+=t;
    if(isPlatform){check(platformNet===undefined,'retail_funding_unexpected_lines');platformNet=l.amount-d;platformDiscount=d;}
    else{check(roleNet===0,'retail_funding_unexpected_lines');roleNet=l.amount-d;roleDiscount=d;}
  }
  check(platformNet!==undefined,'retail_funding_unexpected_lines');
  const invoiceDiscount=discounts(invoice.total_discount_amounts),tax=taxes(invoice.total_tax_amounts);
  check(invoiceDiscount===sum(totals) && tax===lineTaxes && invoice.subtotal===offer.initial_payment_cents
    && invoice.total===invoice.subtotal-invoiceDiscount+tax && cents(invoice.total)
    && checkout.amount_subtotal===invoice.subtotal && checkout.amount_total===invoice.total,'retail_funding_invoice_amount_mismatch');
  check(invoice.paid===true && invoice.status==='paid' && invoice.amount_remaining===0 && invoice.paid_out_of_band===false
    && invoice.starting_balance===0 && invoice.ending_balance===0 && invoice.pre_payment_credit_notes_amount===0
    && invoice.post_payment_credit_notes_amount===0 && invoice.amount_due===invoice.total && invoice.amount_paid===invoice.total,'retail_funding_cash_mismatch');
  if(invoice.total===0)fail('retail_funding_zero_cash_requires_review',true);
  check(paymentIntent?.object==='payment_intent' && charge?.object==='charge'
    && paymentIntent.livemode===checkout.livemode && charge.livemode===checkout.livemode
    && paymentIntent.currency==='usd' && charge.currency==='usd'
    && id(paymentIntent.customer)===expected.customerId && id(charge.customer)===expected.customerId
    && id(invoice.payment_intent)===paymentIntent.id && id(invoice.charge)===charge.id
    && id(paymentIntent.invoice)===invoice.id && id(paymentIntent.latest_charge)===charge.id
    && id(charge.invoice)===invoice.id && id(charge.payment_intent)===paymentIntent.id,'retail_funding_charge_identity');
  check(paymentIntent.status==='succeeded' && paymentIntent.amount===invoice.total && paymentIntent.amount_received===invoice.total
    && charge.status==='succeeded' && charge.paid===true && charge.captured===true
    && charge.amount===invoice.total && charge.amount_captured===invoice.total
    && charge.amount_refunded===0 && charge.refunded===false && charge.disputed===false,'retail_funding_cash_mismatch');
  return {paidAt:new Date(paid*1000).toISOString(),invoiceId:invoice.id,paymentIntentId:paymentIntent.id,chargeId:charge.id,
    platformGrossCents:offer.platform_payment_cents,platformDiscountCents:platformDiscount,platformNetCents:platformNet,
    roleGrossCents:offer.first_role_prepay.amount_cents,roleDiscountCents:roleDiscount,roleNetCents:roleNet,taxCents:tax,cashCents:invoice.total};
}
async function readExistingRetailCheckoutFunding({db,stripe,agreementId,intentId,eventSessionId,eventSubscriptionId,eventInvoiceId,eventLivemode,assertFence=async()=>{}}) {
  await assertFence();
  const {data:agreement,error:aError}=await db.from('membership_agreements').select('*').eq('id',agreementId).maybeSingle();
  if(aError)throw new Error(aError.message||'retail_funding_source_read_failed');
  const {data:intent,error:iError}=await db.from('public_purchase_intents').select('*').eq(intentId?'id':'agreement_id',intentId||agreementId).maybeSingle();
  if(iError)throw new Error(iError.message||'retail_funding_source_read_failed');
  if(intent?.status==='canceled'||intent?.canceled_at||agreement?.superseded_by_agreement_id||intent?.protocol==='legacy_complete')return null;
  const terms=readSavedRetailCheckoutTerms({agreement,intent,deadlineMode:'stored'});
  if(!terms)return null; // Existing activate still independently checks legacy sources.
  const linked=!!intent || !!agreement?.template_snapshot?.purchase_intent;
  check(agreement?.id===agreementId && agreement.is_current===true && ['signed','active'].includes(agreement.status)
    && (!linked || intent?.id && intent.agreement_id===agreementId),'retail_funding_source_mismatch');
  const checkoutId=agreement.checkout_session_id;
  check(typeof checkoutId==='string' && checkoutId.startsWith('cs_') && (!linked || checkoutId===intent.stripe_checkout_session_id)
    && (!eventSessionId || eventSessionId===checkoutId),'retail_funding_session_mismatch');
  check(agreement.client_id && (!linked || agreement.client_id===intent.client_id),'retail_funding_client_mismatch');
  const {data:client,error:cError}=await db.from('clients').select('id,stripe_customer_id,stripe_subscription_id').eq('id',agreement.client_id).maybeSingle();
  if(cError)throw new Error(cError.message||'retail_funding_client_read_failed');
  const {data:customers,error:bError,count:bCount}=await db.from('billing_customers').select('id,stripe_customer_id',{count:'exact'}).eq('client_id',agreement.client_id);
  if(bError)throw new Error(bError.message||'retail_funding_customer_read_failed');
  check(typeof client?.stripe_customer_id==='string' && client.stripe_customer_id.startsWith('cus_') && Array.isArray(customers)
    && customers.length>0 && customers.length===bCount && customers.every(c=>c.stripe_customer_id===client.stripe_customer_id),'retail_funding_customer_mismatch');
  const expected={checkoutId,customerId:client.stripe_customer_id,signedAt:agreement.signed_at,
    agreementDeadline:agreement.agreement_expires_at,intentDeadline:intent?.expires_at};
  const source={agreementId,clientId:agreement.client_id,packageSnapshot:structuredClone(terms.packageSnapshot),
    sourceTemplate:structuredClone(agreement.template_snapshot),sourceTemplateVersion:agreement.template_version,
    sourceIntentId:intent?.id || null};
  await assertFence();const checkout=await stripe.checkout.sessions.retrieve(checkoutId);
  check(typeof id(checkout?.subscription)==='string','retail_funding_subscription_mismatch');
  await assertFence();const subscription=await stripe.subscriptions.retrieve(id(checkout.subscription));
  sessionIdentity({checkout,subscription,expected,eventLivemode,eventSubscriptionId});
  const applied=agreement.checkout_paid_at||intent?.activated_at;
  if(applied) {
    check((!linked || agreement.checkout_paid_at===intent.activated_at) && Number.isFinite(Date.parse(applied))
      && agreement.checkout_status==='paid' && client.stripe_subscription_id===subscription.id,'retail_funding_original_clock_mismatch');
    return {...source,paidAt:new Date(applied).toISOString(),checkoutSessionId:checkoutId,subscription,customerId:expected.customerId,replay:true};
  }
  let invoice;
  if(id(checkout.invoice)){await assertFence();invoice=await stripe.invoices.retrieve(id(checkout.invoice));}
  else {
    const all=await collect(after=>stripe.invoices.list({subscription:subscription.id,limit:100,...(after?{starting_after:after}:{})}),assertFence);
    const initial=all.data.filter(i=>i.billing_reason==='subscription_create' && epoch(i.created) && epoch(i.status_transitions?.paid_at)
      && i.created>=checkout.created && i.created<=i.status_transitions.paid_at);
    check(initial.length===1,'retail_funding_initial_invoice_ambiguous');await assertFence();invoice=await stripe.invoices.retrieve(initial[0].id);
  }
  check(!eventInvoiceId || eventInvoiceId===invoice.id,'retail_funding_invoice_identity');
  const checkoutLines=await collect(after=>stripe.checkout.sessions.listLineItems(checkoutId,{limit:100,...(after?{starting_after:after}:{})}),assertFence);
  const invoiceLines=await collect(after=>stripe.invoices.listLineItems(invoice.id,{limit:100,...(after?{starting_after:after}:{})}),assertFence);
  const subscriptionItems=await collect(after=>stripe.subscriptionItems.list({subscription:subscription.id,limit:100,...(after?{starting_after:after}:{})}),assertFence);
  if(invoice.total===0)verifyExistingRetailFunding({offer:terms.offer,checkout,checkoutLines,subscription,subscriptionItems,invoice,invoiceLines,expected});
  check(typeof id(invoice.payment_intent)==='string' && typeof id(invoice.charge)==='string','retail_funding_charge_identity');
  await assertFence();const paymentIntent=await stripe.paymentIntents.retrieve(id(invoice.payment_intent));
  await assertFence();const charge=await stripe.charges.retrieve(id(invoice.charge));
  const proof=verifyExistingRetailFunding({offer:terms.offer,checkout,checkoutLines,subscription,subscriptionItems,invoice,invoiceLines,paymentIntent,charge,expected});
  await assertFence();return{...source,...proof,checkoutSessionId:checkoutId,subscription,customerId:expected.customerId,replay:false};
}
async function assertExistingRetailFundingSource({db,funding}) {
  const {data:a,error:ae}=await db.from('membership_agreements').select('*').eq('id',funding.agreementId).maybeSingle();
  if(ae)throw new Error(ae.message||'retail_funding_source_read_failed');
  const {data:i,error:ie}=await db.from('public_purchase_intents').select('*').eq('agreement_id',funding.agreementId).maybeSingle();
  if(ie)throw new Error(ie.message||'retail_funding_source_read_failed');
  check(a?.is_current===true && ['signed','active'].includes(a.status) && !a.superseded_by_agreement_id && !i?.canceled_at && i?.status!=='canceled'
    && a.client_id===funding.clientId && a.checkout_session_id===funding.checkoutSessionId
    && a.template_version===funding.sourceTemplateVersion && isDeepStrictEqual(a.template_snapshot,funding.sourceTemplate)
    && (i?.id || null)===funding.sourceIntentId,'retail_funding_source_changed');
  const current=readSavedRetailCheckoutTerms({agreement:a,intent:i,deadlineMode:'stored'});
  check(current && isDeepStrictEqual(current.packageSnapshot,funding.packageSnapshot)
    && (!a.checkout_paid_at || new Date(a.checkout_paid_at).toISOString()===funding.paidAt),'retail_funding_source_changed');
  const {data:c,error:ce}=await db.from('clients').select('id,stripe_customer_id,stripe_subscription_id').eq('id',funding.clientId).maybeSingle();
  if(ce)throw new Error(ce.message||'retail_funding_client_read_failed');
  const {data:customers,error:be,count:bCount}=await db.from('billing_customers').select('id,stripe_customer_id',{count:'exact'}).eq('client_id',funding.clientId);
  if(be)throw new Error(be.message||'retail_funding_customer_read_failed');
  check(c?.stripe_customer_id===funding.customerId && Array.isArray(customers) && customers.length>0 && customers.length===bCount
    && customers.every(b=>b.stripe_customer_id===funding.customerId)
    && (!funding.replay || c.stripe_subscription_id===funding.subscription.id),'retail_funding_source_changed');
}
module.exports={readExistingRetailCheckoutFunding,verifyExistingRetailFunding,collect,assertExistingRetailFundingSource};
