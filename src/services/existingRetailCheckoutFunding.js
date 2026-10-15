'use strict';

// Readback/proof adapter for the EXISTING accepted agreement + Checkout record.
// No provider mutation, contract/version store, account setup or receipt writes.
const { readSavedRetailCheckoutTerms } = require('./savedMembershipCheckoutTerms');
const { isDeepStrictEqual } = require('node:util');
const { snapshotStripeSdkData: snapshot } = require('./enterprisePoolPaymentProof');
const { readRetailPackageOffer } = require('./membershipPackageCompatibility');
const { STRIPE_RECURRING_OFFER_VERSION, GENERATION_DATE_OFFER_VERSION, anchoredMonthInstant, retailTermWindow,
  retailGenerationCollectionSchedule, buildRetailOffer } = require('./membershipOffers');
const { readExistingRetailRecurringSource } = require('./existingRetailRecurringSource');
const { readExistingRetailRecurringCensus } = require('./existingRetailRecurringCensus');
function fail(code, permanent = false) { const e = new Error(code); e.code = code; e.status = 409; if(permanent)e.permanentFailure=true; throw e; }
function check(value, code = 'retail_funding_mismatch') { if (!value) fail(code); }
const id = value => typeof value === 'string' ? value : value?.id;
const cents = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const epoch = value => Number.isSafeInteger(value) && value > 0 && value <= 253402300799;
const providerId = (value,prefix) => typeof value==='string' && value.startsWith(prefix) && value.length>prefix.length;
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
  if (offer?.offer_version === GENERATION_DATE_OFFER_VERSION) return verifyGenerationRetailFunding({offer,checkout,checkoutLines,
    subscription,subscriptionItems,invoice,invoiceLines,paymentIntent,charge,expected});
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
  const totals=[];let platformLine,platformNet,roleNet=0,platformDiscount,roleDiscount=0,lineTaxes=0;
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
    if(isPlatform){check(platformNet===undefined,'retail_funding_unexpected_lines');platformLine=l;platformNet=l.amount-d;platformDiscount=d;}
    else{check(roleNet===0,'retail_funding_unexpected_lines');roleNet=l.amount-d;roleDiscount=d;}
  }
  check(platformNet!==undefined,'retail_funding_unexpected_lines');
  const tax=verifyInitialRetailSettlement({offer,checkout,invoice,paymentIntent,charge,expected,lineDiscounts:totals,lineTaxes});
  // Preserve the ORIGINAL platform invoice-line period B, separately from real
  // first cash A. Current subscription dates and role-line periods are not an
  // original-period receipt. Raw Stripe inclusive endpoints are not converted
  // into contract/access/collection dates here. Persistence is a separate step.
  const period=platformLine.period;
  check(platformLine.object==='line_item' && providerId(platformLine.id,'il_')
    && providerId(invoice.id,'in_') && providerId(platform[0].price.id,'price_')
    && providerId(subscription.id,'sub_') && providerId(item.id,'si_')
    && providerId(expected.customerId,'cus_') && providerId(checkout.id,'cs_')
    && epoch(period?.start) && epoch(period?.end) && period.end>period.start
    && period.start<=invoice.created && period.start<=paid,'retail_funding_initial_period_invalid');
  const initialProviderPeriod=Object.freeze({version:'retail_initial_provider_period_v1',api_version:'2023-10-16',
    invoice_id:invoice.id,platform_invoice_line_id:platformLine.id,price_id:platform[0].price.id,
    subscription_id:subscription.id,subscription_item_id:item.id,customer_id:expected.customerId,
    checkout_session_id:checkout.id,livemode:checkout.livemode,paid_at:new Date(paid*1000).toISOString(),
    provider_period_start:period.start,provider_period_end:period.end});
  return {paidAt:new Date(paid*1000).toISOString(),invoiceId:invoice.id,paymentIntentId:paymentIntent.id,chargeId:charge.id,
    checkoutCreatedEpoch:checkout.created,invoiceCreatedEpoch:invoice.created,
    platformGrossCents:offer.platform_payment_cents,platformDiscountCents:platformDiscount,platformNetCents:platformNet,
    roleGrossCents:offer.first_role_prepay.amount_cents,roleDiscountCents:roleDiscount,roleNetCents:roleNet,taxCents:tax,cashCents:invoice.total,initialProviderPeriod};
}
// Shared existing cash proof, without normalizing or inventing any provider
// objects. Both accepted cohorts must reconcile the same actual captured money.
function verifyInitialRetailSettlement({offer,checkout,invoice,paymentIntent,charge,expected,lineDiscounts,lineTaxes}) {
  const invoiceDiscount=discounts(invoice.total_discount_amounts),tax=taxes(invoice.total_tax_amounts);
  check(invoiceDiscount===sum(lineDiscounts) && tax===lineTaxes && invoice.subtotal===offer.initial_payment_cents
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
  return tax;
}

// Prospective native initial-invoice shape. A zero recurring trial line is a
// schedule, NOT a funded recurring period. Classify cash using the distinct
// IDs pinned on the existing attempt, never by "one_time" alone.
function verifyGenerationRetailFunding(input) {
  let saved;
  try{saved=snapshot(input);}catch(_){fail('retail_generation_funding_source_mismatch');}
  const {offer,checkout,checkoutLines,subscription,subscriptionItems,invoice,invoiceLines,paymentIntent,charge,expected}=saved;
  check(offer?.offer_version===GENERATION_DATE_OFFER_VERSION && offer.term_start_basis==='generation_date',
    'retail_generation_funding_source_mismatch');
  let canonical;
  try{canonical=buildRetailOffer({planKey:offer.plan_key,commitmentMonths:offer.commitment_months,paymentOption:offer.payment_option,
    firstRolePrepaySelected:offer.first_role_prepay?.selected,channel:'sales',offerVersion:GENERATION_DATE_OFFER_VERSION});}
  catch(_){fail('retail_generation_funding_source_mismatch');}
  check(isDeepStrictEqual(offer,snapshot(canonical)),'retail_generation_funding_source_mismatch');
  const prices=expected?.prices;
  check(prices && Object.keys(prices).sort().join(',')==='first_role_price_id,initial_platform_price_id,recurring_platform_price_id'
    && [prices.initial_platform_price_id,prices.recurring_platform_price_id].every(p=>/^price_[A-Za-z0-9_]+$/.test(p||''))
    && (offer.first_role_prepay.selected ? /^price_[A-Za-z0-9_]+$/.test(prices.first_role_price_id||'') : prices.first_role_price_id===null)
    && new Set(Object.values(prices).filter(Boolean)).size===Object.values(prices).filter(Boolean).length,
    'retail_generation_funding_price_binding_required');
  check(checkout && subscription && invoice && epoch(checkout.created)
    && /^cs_[A-Za-z0-9_]{1,250}$/.test(expected.checkoutId||'')
    && /^sub_[A-Za-z0-9_]{1,250}$/.test(expected.subscriptionId||'')
    && /^cus_[A-Za-z0-9_]{1,250}$/.test(expected.customerId||'')
    && /^pi_[A-Za-z0-9_]{1,250}$/.test(paymentIntent?.id||'')
    && /^ch_[A-Za-z0-9_]{1,250}$/.test(charge?.id||''),'retail_generation_funding_source_mismatch');
  sessionIdentity({checkout,subscription,expected,eventLivemode:expected.eventLivemode,eventSubscriptionId:expected.subscriptionId});
  check(checkout.payment_status==='paid' && ['trialing','active'].includes(subscription.status), 'retail_funding_not_settled');
  let schedule;
  try{schedule=retailGenerationCollectionSchedule({offer,generatedAt:expected.generatedAt,
    initialTermStart:expected.initialTermStart,initialRenewalDate:expected.initialRenewalDate,
    now:new Date(checkout.created*1000).toISOString()});}catch(_){fail('retail_generation_funding_calendar_mismatch');}
  const paid=invoice.status_transitions?.paid_at;
  check(invoice.object==='invoice' && /^in_[A-Za-z0-9_]+$/.test(invoice.id||'') && invoice.billing_reason==='subscription_create'
    && invoice.currency==='usd' && invoice.livemode===checkout.livemode && id(invoice.customer)===expected.customerId
    && id(invoice.subscription)===subscription.id && id(checkout.invoice)===invoice.id,'retail_funding_invoice_identity');
  check(epoch(paid) && epoch(invoice.created) && invoice.created>=checkout.created && invoice.created<=paid
    && paid*1000>=Date.parse(expected.signedAt) && paid*1000<Date.parse(expected.agreementDeadline)
    && (!expected.intentDeadline || paid*1000<Date.parse(expected.intentDeadline))
    && paid<schedule.trial_end,'retail_funding_paid_clock_invalid');
  check(epoch(subscription.trial_start) && subscription.trial_start>=checkout.created
    && subscription.start_date===subscription.trial_start && subscription.trial_start<=invoice.created
    && subscription.trial_end===schedule.trial_end && subscription.billing_cycle_anchor===schedule.trial_end
    && subscription.schedule===null && subscription.pause_collection===null && subscription.cancel_at===null
    && subscription.cancel_at_period_end===false,'retail_generation_funding_schedule_mismatch');
  if(subscription.status==='trialing')check(subscription.current_period_start===subscription.trial_start
    && subscription.current_period_end===schedule.trial_end,'retail_generation_funding_schedule_mismatch');
  const cs=list(checkoutLines),items=list(subscriptionItems),lines=list(invoiceLines),n=offer.first_role_prepay.selected?3:2;
  check(cs.length===n && lines.length===n && items.length===1
    && new Set(cs.map(l=>l.id)).size===n && new Set(lines.map(l=>l.id)).size===n
    && new Set(cs.map(l=>id(l.price))).size===n && new Set(lines.map(l=>id(l.price))).size===n,'retail_funding_unexpected_lines');
  const item=items[0];
  check(item.object==='subscription_item' && /^si_[A-Za-z0-9_]+$/.test(item.id||'') && item.quantity===1
    && id(item.subscription)===subscription.id && id(item.price)===prices.recurring_platform_price_id
    && priceMatches(item.price,offer.platform_payment_cents,offer.stripe_recurrence),'retail_funding_price_mismatch');
  let platformLine,recurringLine,platformNet,platformDiscount,roleNet=0,roleDiscount=0,lineTaxes=0;
  const lineDiscounts=[];
  for(const l of lines){
    const priceId=id(l.price),initial=priceId===prices.initial_platform_price_id,
      recurring=priceId===prices.recurring_platform_price_id,role=prices.first_role_price_id!==null&&priceId===prices.first_role_price_id;
    const amount=initial?offer.platform_payment_cents:role?offer.first_role_prepay.amount_cents:0;
    const priceAmount=recurring?offer.platform_payment_cents:amount;
    const csLine=cs.find(c=>id(c.price)===priceId);
    check((initial||recurring||role) && csLine && l.object==='line_item' && /^il_[A-Za-z0-9_]+$/.test(l.id||'')
      && l.quantity===1 && l.currency==='usd' && l.proration===false && l.amount===amount
      && priceMatches(l.price,priceAmount,recurring?offer.stripe_recurrence:null)
      && priceMatches(csLine.price,priceAmount,recurring?offer.stripe_recurrence:null)
      && csLine.quantity===1 && csLine.currency==='usd' && csLine.amount_subtotal===amount
      && (recurring ? l.type==='subscription' && id(l.subscription)===subscription.id && id(l.subscription_item)===item.id
        && l.period?.start===subscription.trial_start && l.period?.end===schedule.trial_end
        : l.type==='invoiceitem' && !l.subscription_item && (!l.subscription||id(l.subscription)===subscription.id)),
      'retail_funding_invoice_line_mismatch');
    const d=discounts(l.discount_amounts),t=taxes(l.tax_amounts);
    check(d<=amount && (offer.payment_option!=='prepaid'||d===0) && (!recurring||(d===0&&t===0))
      && csLine.amount_discount===d && csLine.amount_tax===t && csLine.amount_total===amount-d+t,
      'retail_funding_checkout_line_mismatch');
    lineDiscounts.push(d);lineTaxes+=t;
    if(initial){platformLine=l;platformNet=amount-d;platformDiscount=d;}
    if(recurring)recurringLine=l;
    if(role){roleNet=amount-d;roleDiscount=d;}
  }
  check(platformLine && recurringLine && platformNet>0,'retail_funding_not_settled');
  const tax=verifyInitialRetailSettlement({offer,checkout,invoice,paymentIntent,charge,expected,lineDiscounts,lineTaxes});
  const initialProviderSchedule=Object.freeze({version:'retail_generation_initial_schedule_v1',api_version:'2023-10-16',
    generated_at:expected.generatedAt,initial_term_start:schedule.initial_term_start,initial_renewal_date:schedule.initial_renewal_date,
    first_collection_at:schedule.first_collection_at,invoice_id:invoice.id,initial_platform_invoice_line_id:platformLine.id,
    recurring_invoice_line_id:recurringLine.id,initial_platform_price_id:prices.initial_platform_price_id,
    recurring_platform_price_id:prices.recurring_platform_price_id,first_role_price_id:prices.first_role_price_id,
    subscription_id:subscription.id,subscription_item_id:item.id,customer_id:expected.customerId,checkout_session_id:checkout.id,
    livemode:checkout.livemode,paid_at:new Date(paid*1000).toISOString(),provider_trial_start:subscription.trial_start,
    provider_trial_end:schedule.trial_end,billing_cycle_anchor:subscription.billing_cycle_anchor});
  return {paidAt:new Date(paid*1000).toISOString(),invoiceId:invoice.id,paymentIntentId:paymentIntent.id,chargeId:charge.id,
    checkoutCreatedEpoch:checkout.created,invoiceCreatedEpoch:invoice.created,platformGrossCents:offer.platform_payment_cents,
    platformDiscountCents:platformDiscount,platformNetCents:platformNet,roleGrossCents:offer.first_role_prepay.amount_cents,
    roleDiscountCents:roleDiscount,roleNetCents:roleNet,taxCents:tax,cashCents:invoice.total,initialProviderSchedule};
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
  const {data:customers,error:bError,count:bCount}=await db.from('billing_customers').select('id,client_id,stripe_customer_id',{count:'exact'})
    .eq('client_id',agreement.client_id).eq('stripe_customer_id',client?.stripe_customer_id || '');
  if(bError)throw new Error(bError.message||'retail_funding_customer_read_failed');
  check(typeof client?.stripe_customer_id==='string' && client.stripe_customer_id.startsWith('cus_') && Array.isArray(customers)
    && customers.length===1 && bCount===1 && customers.every(c=>c.client_id===agreement.client_id && c.stripe_customer_id===client.stripe_customer_id),'retail_funding_customer_mismatch');
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
      && agreement.checkout_status==='paid','retail_funding_original_clock_mismatch');
    // Linked completion writes both clocks BEFORE the billing RPC assigns the
    // subscription. Its durable native tail must resume even if that id is
    // still absent; the trusted Session/subscription/customer graph owns it.
    if(linked || client.stripe_subscription_id===subscription.id) {
      return {...source,paidAt:new Date(applied).toISOString(),checkoutSessionId:checkoutId,subscription,customerId:expected.customerId,replay:true};
    }
    // An admin paid-clock-only retry is NOT an already-applied replay. Reprove
    // the original cash, then finish its existing unfenced tail without setting
    // another clock. An unrelated existing subscription must not be replaced.
    check(!client.stripe_subscription_id || agreement.replaces_stripe_subscription_id===client.stripe_subscription_id,
      'retail_funding_original_clock_mismatch');
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
  check(!applied || proof.paidAt===new Date(applied).toISOString(),'retail_funding_original_clock_mismatch');
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
  const {data:customers,error:be,count:bCount}=await db.from('billing_customers').select('id,client_id,stripe_customer_id',{count:'exact'})
    .eq('client_id',funding.clientId).eq('stripe_customer_id',funding.customerId);
  if(be)throw new Error(be.message||'retail_funding_customer_read_failed');
  check(c?.stripe_customer_id===funding.customerId && Array.isArray(customers) && customers.length===1 && bCount===1
    && customers.every(b=>b.client_id===funding.clientId && b.stripe_customer_id===funding.customerId)
    && (!funding.replay || funding.sourceIntentId || c.stripe_subscription_id===funding.subscription.id),'retail_funding_source_changed');
}
// Sibling of the original Checkout proof. Never reconstruct an initial
// subscription_create receipt or repeat the first-role purchase on a cycle.
// SDK authentication and a complete census belong to the trusted adapter;
// this pure verifier alone is not database or payment-effect authority.
function verifyExistingRetailRecurringFunding(raw) {
  let input;
  try { input=snapshot(raw); } catch (_) { fail('retail_recurring_funding_invalid_graph'); }
  const keys=['source','cycle','invoice','invoiceLines','paymentIntent','charge','providerAccountId'];
  check(input && Object.keys(input).length===keys.length && keys.every(k=>Object.hasOwn(input,k)),
    'retail_recurring_funding_invalid_input');
  const {source,cycle,invoice,invoiceLines,paymentIntent,charge,providerAccountId}=input;
  const offer=readRetailPackageOffer(source?.package_snapshot), p=source?.original_period;
  check(offer?.offer_version===STRIPE_RECURRING_OFFER_VERSION
    && source?.version==='retail_existing_recurring_source_v1'
    && ['effect_authorized','collection_ready','paid_access_authorized','payroll_authorized'].every(k=>source[k]===false)
    && providerId(providerAccountId,'acct_') && providerAccountId===source.original_provider_account_id,
    'retail_recurring_funding_source_mismatch');
  const cycleKeys=['ordinal','invoice_id','line_id','provider_period_start','provider_period_end',
    'observed_original_a_period_start','observed_original_a_period_end','term_index','installment_index',
    'observed_term_start_at','observed_term_end_at'];
  check(cycle && Object.keys(cycle).length===cycleKeys.length && cycleKeys.every(k=>Object.hasOwn(cycle,k))
    && Number.isSafeInteger(cycle.ordinal) && cycle.ordinal>0 && cycle.ordinal<=999
    && p?.version==='retail_initial_provider_period_v1' && p.api_version==='2023-10-16'
    && typeof p.livemode==='boolean' && epoch(p.provider_period_start) && epoch(p.provider_period_end)
    && Number.isFinite(Date.parse(p.paid_at)) && Date.parse(p.paid_at)/1000>=p.provider_period_start,
    'retail_recurring_funding_period_mismatch');
  const interval=offer.stripe_recurrence.interval_count, offset=cycle.ordinal*interval;
  const b=new Date(p.provider_period_start*1000).toISOString();
  const termIndex=offer.payment_option==='prepaid'?cycle.ordinal:Math.floor(cycle.ordinal/offer.commitment_months);
  const term=retailTermWindow({originalStart:p.paid_at,commitmentMonths:offer.commitment_months,termIndex});
  check(p.provider_period_end===Date.parse(anchoredMonthInstant(b,interval))/1000
    && cycle.provider_period_start===Date.parse(anchoredMonthInstant(b,offset))/1000
    && cycle.provider_period_end===Date.parse(anchoredMonthInstant(b,offset+interval))/1000
    && cycle.observed_original_a_period_start===anchoredMonthInstant(p.paid_at,offset)
    && cycle.observed_original_a_period_end===anchoredMonthInstant(p.paid_at,offset+interval)
    && cycle.term_index===termIndex && cycle.observed_term_start_at===term.term_start_at
    && cycle.observed_term_end_at===term.term_end_at
    && cycle.installment_index===(offer.payment_option==='prepaid'?1:cycle.ordinal%offer.commitment_months+1),
    'retail_recurring_funding_period_mismatch');
  check(invoice?.object==='invoice' && providerId(invoice.id,'in_') && invoice.id===cycle.invoice_id
    && invoice.id!==p.invoice_id && invoice.billing_reason==='subscription_cycle' && invoice.currency==='usd'
    && invoice.livemode===p.livemode && invoice.customer===p.customer_id && invoice.subscription===p.subscription_id,
    'retail_recurring_funding_invoice_identity');
  const lines=list(invoiceLines), paid=invoice.status_transitions?.paid_at;
  check(lines.length===1 && (!Object.hasOwn(invoiceLines,'total_count') || invoiceLines.total_count===1),
    'retail_recurring_funding_unexpected_lines');
  const line=lines[0];
  check(line?.object==='line_item' && providerId(line.id,'il_') && line.id===cycle.line_id
    && line.id!==p.platform_invoice_line_id && line.type==='subscription' && line.proration===false
    && line.quantity===1 && line.currency==='usd' && line.subscription===p.subscription_id
    && line.subscription_item===p.subscription_item_id && id(line.price)===p.price_id
    && priceMatches(line.price,offer.platform_payment_cents,offer.stripe_recurrence)
    && line.amount===offer.platform_payment_cents
    && line.period?.start===cycle.provider_period_start && line.period?.end===cycle.provider_period_end,
    'retail_recurring_funding_line_mismatch');
  // A recurring draft may exist or be paid before its future service window.
  // Its original B geometry remains exact; creation is not the cycle start.
  check(epoch(paid) && epoch(invoice.created) && invoice.created<=paid && paid*1000>=Date.parse(p.paid_at),
    'retail_recurring_funding_paid_clock_invalid');
  const discount=discounts(line.discount_amounts),tax=taxes(line.tax_amounts),gross=offer.platform_payment_cents;
  const net=gross-discount,total=net+tax;
  check(discount<=gross && cents(net) && cents(total) && total<=2147483647
    && discounts(invoice.total_discount_amounts)===discount && taxes(invoice.total_tax_amounts)===tax
    && invoice.subtotal===gross && invoice.total===total,
    'retail_recurring_funding_amount_mismatch');
  check(invoice.paid===true && invoice.status==='paid' && invoice.amount_remaining===0 && invoice.paid_out_of_band===false
    && invoice.starting_balance===0 && invoice.ending_balance===0 && invoice.pre_payment_credit_notes_amount===0
    && invoice.post_payment_credit_notes_amount===0 && invoice.amount_due===total && invoice.amount_paid===total,
    'retail_recurring_funding_cash_mismatch');
  if(total===0) {
    check(discount===gross && tax===0 && invoice.payment_intent===null && invoice.charge===null
      && paymentIntent===null && charge===null,'retail_recurring_funding_zero_unverified');
  } else {
    check(paymentIntent?.object==='payment_intent' && charge?.object==='charge'
      && providerId(paymentIntent.id,'pi_') && providerId(charge.id,'ch_')
      && paymentIntent.livemode===p.livemode && charge.livemode===p.livemode
      && paymentIntent.currency==='usd' && charge.currency==='usd'
      && paymentIntent.customer===p.customer_id && charge.customer===p.customer_id
      && invoice.payment_intent===paymentIntent.id && invoice.charge===charge.id
      && paymentIntent.invoice===invoice.id && paymentIntent.latest_charge===charge.id
      && charge.invoice===invoice.id && charge.payment_intent===paymentIntent.id,
      'retail_recurring_funding_charge_identity');
    check(paymentIntent.status==='succeeded' && paymentIntent.amount===total && paymentIntent.amount_received===total
      && charge.status==='succeeded' && charge.paid===true && charge.captured===true && charge.amount===total
      && charge.amount_captured===total && charge.amount_refunded===0 && charge.refunded===false && charge.disputed===false,
      'retail_recurring_funding_cash_mismatch');
  }
  const result={version:'retail_existing_recurring_funding_proof_v1',agreement_id:source.agreement_id,client_id:source.client_id,
    offer_version:offer.offer_version,provider_account_id:providerAccountId,livemode:p.livemode,currency:'usd',
    ordinal:cycle.ordinal,invoice_id:invoice.id,line_id:line.id,price_id:p.price_id,subscription_id:p.subscription_id,
    subscription_item_id:p.subscription_item_id,customer_id:p.customer_id,original_paid_at:p.paid_at,
    paid_at:new Date(paid*1000).toISOString(),invoice_created:invoice.created,
    provider_period_start:cycle.provider_period_start,provider_period_end:cycle.provider_period_end,
    platform_gross_cents:gross,platform_discount_cents:discount,platform_net_cents:net,tax_cents:tax,cash_cents:total,
    payment_intent_id:paymentIntent?.id||null,charge_id:charge?.id||null};
  return Object.freeze(result);
}
async function readExistingRetailRecurringFunding(input) {
  const invalid=code=>fail(code||'retail_recurring_funding_invalid_input');
  const unknown=()=>{const e=new Error('retail_recurring_funding_unknown');e.code=e.message;e.status=503;throw e;};
  try {
    const {isProxy}=require('node:util').types;
    check(input && typeof input==='object' && !isProxy(input)
      && [Object.prototype,null].includes(Object.getPrototypeOf(input)), 'retail_recurring_funding_invalid_input');
    const fields=Object.getOwnPropertyDescriptors(input),keys=['db','stripe','agreementId','clientId','invoiceId'];
    check(Reflect.ownKeys(fields).length===keys.length && keys.every(k=>fields[k]?.enumerable && Object.hasOwn(fields[k],'value')),
      'retail_recurring_funding_invalid_input');
    const db=fields.db.value,stripe=fields.stripe.value,agreementId=fields.agreementId.value,
      clientId=fields.clientId.value,invoiceId=fields.invoiceId.value;
    check(typeof invoiceId==='string' && /^in_[A-Za-z0-9_]{1,250}$/.test(invoiceId) && invoiceId.length<=255,
      'retail_recurring_funding_invoice_identity');
    const api=()=>check(typeof stripe?.getApiField==='function' && stripe.getApiField('version')==='2023-10-16',
      'retail_recurring_funding_api_mismatch');
    async function provider(fn) {api();try{return snapshot(await fn());}catch(e){if(e?.code==='pool_proof_invalid_graph')invalid('retail_recurring_funding_invalid_graph');unknown();}}
    async function source(){try{return await readExistingRetailRecurringSource({db,agreementId,clientId});}catch(e){
      if(e?.code==='retail_recurring_source_invalid')invalid('retail_recurring_funding_source_mismatch');unknown();}}
    api();const original=await source(),p=original.original_period;
    check(readRetailPackageOffer(original.package_snapshot)?.offer_version===STRIPE_RECURRING_OFFER_VERSION,
      'retail_recurring_funding_source_mismatch');
    const account=async()=>{const a=await provider(()=>stripe.accounts.retrieve());
      check(a?.object==='account' && a.id===original.original_provider_account_id,'retail_recurring_funding_source_mismatch');};
    await account();
    const census=await readExistingRetailRecurringCensus({db,stripe,agreementId,clientId});
    const cycle=census.cycles.find(c=>c.invoice_id===invoiceId);
    check(cycle && invoiceId!==p.invoice_id,'retail_recurring_funding_invoice_identity');
    const invoice=await provider(()=>stripe.invoices.retrieve(invoiceId));
    const invoiceLines=await provider(()=>stripe.invoices.listLineItems(invoiceId,{limit:100}));
    let paymentIntent=null,charge=null;
    if(invoice.total!==0){
      check(typeof invoice.payment_intent==='string' && /^pi_[A-Za-z0-9_]{1,250}$/.test(invoice.payment_intent)
        && typeof invoice.charge==='string' && /^ch_[A-Za-z0-9_]{1,250}$/.test(invoice.charge),
        'retail_recurring_funding_charge_identity');
      paymentIntent=await provider(()=>stripe.paymentIntents.retrieve(invoice.payment_intent));
      charge=await provider(()=>stripe.charges.retrieve(invoice.charge));
    }
    const proof=verifyExistingRetailRecurringFunding({source:original,cycle,invoice,invoiceLines,paymentIntent,charge,
      providerAccountId:original.original_provider_account_id});
    // Refresh the same financial objects, not the initial receipt. A mutable
    // provider graph can never be reserved across the subsequent native write.
    check(isDeepStrictEqual(invoice,await provider(()=>stripe.invoices.retrieve(invoiceId)))
      && isDeepStrictEqual(invoiceLines,await provider(()=>stripe.invoices.listLineItems(invoiceId,{limit:100}))),
      'retail_recurring_funding_provider_changed');
    if(paymentIntent)check(isDeepStrictEqual(paymentIntent,await provider(()=>stripe.paymentIntents.retrieve(paymentIntent.id)))
      && isDeepStrictEqual(charge,await provider(()=>stripe.charges.retrieve(charge.id))),
      'retail_recurring_funding_provider_changed');
    await account();check(isDeepStrictEqual(original,await source()),'retail_recurring_funding_source_mismatch');api();
    return Object.freeze({source:original,proof});
  } catch(e) {
    if(typeof e?.code==='string' && /^retail_recurring_/.test(e.code) && [409,503].includes(e.status))throw e;
    unknown();
  }
}
module.exports={readExistingRetailCheckoutFunding,verifyExistingRetailFunding,verifyGenerationRetailFunding,collect,assertExistingRetailFundingSource,
  verifyExistingRetailRecurringFunding,readExistingRetailRecurringFunding};
