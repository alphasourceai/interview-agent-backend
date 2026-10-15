'use strict';
// Authored SDK graphs only. No Stripe call, invoice issuance or money movement.
const {generationFixture}=require('./generation-retail-funding-fixture');
const {verifyExistingRetailFunding}=require('../../src/services/existingRetailCheckoutFunding');
const {inspectExistingRetailRecurringPeriods:inspect}=require('../../src/services/existingRetailRecurringPeriods');
const {anchoredMonthInstant}=require('../../src/services/membershipOffers');
function generationRecurringFixture(plan='basic',months=3,payment='prepaid',role=false,options={}){
 const f=generationFixture(plan,months,payment,role,options);
 const funding=verifyExistingRetailFunding({offer:f.offer,checkout:f.cs,checkoutLines:{object:'list',has_more:false,data:f.cl},
  subscription:f.s,subscriptionItems:f.s.items,invoice:f.inv,invoiceLines:f.inv.lines,paymentIntent:f.pi,charge:f.ch,
  expected:{checkoutId:f.cs.id,subscriptionId:f.s.id,customerId:f.c.stripe_customer_id,eventLivemode:false,
   signedAt:f.g.signed_at,agreementDeadline:f.g.agreement_expires_at,
   generatedAt:f.g.template_snapshot.generated_at,initialTermStart:f.g.initial_term_start,initialRenewalDate:f.g.initial_renewal_date,
   prices:f.g.retail_checkout_prices}});
 const source={version:'retail_existing_recurring_source_v1',agreement_id:f.g.id,client_id:f.c.id,source_intent_id:f.i.id,
  package_snapshot:f.pkg,original_period:funding.initialProviderSchedule,original_provider_account_id:'acct_SYNTHETIC',
  effect_authorized:false,collection_ready:false,paid_access_authorized:false,payroll_authorized:false};
 return {f,source,funding,initialReceipt:{version:'retail_existing_funding_v1',proof:{period:source.original_period,
  provider_account_id:'acct_SYNTHETIC',payment_intent_id:f.pi.id,charge_id:f.ch.id,
  platform_gross_cents:funding.platformGrossCents,platform_discount_cents:funding.platformDiscountCents}}};
}
function generationCycle(f,source,ordinal=1,{paidAt,discount=0,tax=0}={}){
 const b=source.original_period,o=source.package_snapshot.membership_terms,span=o.stripe_recurrence.interval_count;
 const start=Date.parse(anchoredMonthInstant(b.first_collection_at,(ordinal-1)*span))/1000,
  end=Date.parse(anchoredMonthInstant(b.first_collection_at,ordinal*span))/1000;
 const paid=paidAt?Date.parse(paidAt)/1000:start+7,total=o.platform_payment_cents-discount+tax;
 const key=b.subscription_id.slice(4)+'_'+ordinal;
 const line={...structuredClone(f.il.find(l=>l.type==='subscription')),id:'il_CYCLE_'+key,
  price:structuredClone(f.s.items.data[0].price),amount:o.platform_payment_cents,period:{start,end},
  discount_amounts:discount?[{discount:'di_SYNTHETIC',amount:discount}]:[],
  tax_amounts:tax?[{tax_rate:'txr_SYNTHETIC',inclusive:false,amount:tax}]:[]};
 const invoice={...structuredClone(f.inv),id:'in_CYCLE_'+key,billing_reason:'subscription_cycle',created:paid,
  status_transitions:{paid_at:paid},subtotal:o.platform_payment_cents,total,amount_due:total,amount_paid:total,
  total_discount_amounts:line.discount_amounts,total_tax_amounts:line.tax_amounts,
  payment_intent:'pi_CYCLE_'+key,charge:'ch_CYCLE_'+key,lines:{object:'list',has_more:false,data:[line]}};
 const paymentIntent={...structuredClone(f.pi),id:invoice.payment_intent,invoice:invoice.id,latest_charge:invoice.charge,amount:total,amount_received:total};
 const charge={...structuredClone(f.ch),id:invoice.charge,invoice:invoice.id,payment_intent:invoice.payment_intent,amount:total,amount_captured:total};
 // Chronology's contiguous invoice census is authored separately; this one
 // cycle can be recorded out of order, but cannot extend a gap's coverage.
 const invoices=[{...f.inv,lines:undefined}];
 for(let n=1;n<=ordinal;n++)invoices.push(n===ordinal?invoice:{...invoice,id:'in_CENSUS_'+key+'_'+n,
  lines:{object:'list',has_more:false,data:[{...line,id:'il_CENSUS_'+key+'_'+n,period:{
   start:Date.parse(anchoredMonthInstant(b.first_collection_at,(n-1)*span))/1000,
   end:Date.parse(anchoredMonthInstant(b.first_collection_at,n*span))/1000}}]}});
 const cycle=inspect({packageSnapshot:source.package_snapshot,originalPeriod:b,originalProviderAccountId:source.original_provider_account_id,
  providerAccountId:source.original_provider_account_id,invoices:{object:'list',data:invoices,has_more:false}}).cycles.at(-1);
 return {source,cycle,invoice,invoiceLines:invoice.lines,paymentIntent,charge,providerAccountId:source.original_provider_account_id};
}
module.exports={generationRecurringFixture,generationCycle};
