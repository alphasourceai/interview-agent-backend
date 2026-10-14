'use strict';
const {fixture}=require('./existing-retail-funding-fixture');
const {verifyExistingRetailFunding}=require('../../src/services/existingRetailCheckoutFunding');
const {STRIPE_RECURRING_OFFER_VERSION,anchoredMonthInstant}=require('../../src/services/membershipOffers');
const {inspectExistingRetailRecurringPeriods:inspect}=require('../../src/services/existingRetailRecurringPeriods');
function recurringFixture(plan='basic',months=3,payment='monthly_installments',role=false,{ordinal=1,discount=0,tax=0}={}) {
  const f=fixture(plan,months,payment,role),o=f.pkg.membership_terms;
  const initial=verifyExistingRetailFunding({offer:o,checkout:f.cs,checkoutLines:{object:'list',has_more:false,data:f.cl},
    subscription:f.s,subscriptionItems:f.s.items,invoice:f.inv,invoiceLines:f.inv.lines,paymentIntent:f.pi,charge:f.ch,
    expected:{customerId:f.c.stripe_customer_id,signedAt:f.g.signed_at,agreementDeadline:f.g.agreement_expires_at}});
  const pkg=structuredClone(f.pkg);pkg.pricing_version=STRIPE_RECURRING_OFFER_VERSION;pkg.membership_terms.offer_version=STRIPE_RECURRING_OFFER_VERSION;
  const source={version:'retail_existing_recurring_source_v1',agreement_id:f.g.id,client_id:f.c.id,source_intent_id:f.i.id,
    package_snapshot:pkg,original_period:structuredClone(initial.initialProviderPeriod),original_provider_account_id:'acct_SYNTHETIC',
    effect_authorized:false,collection_ready:false,paid_access_authorized:false,payroll_authorized:false};
  const b=new Date(source.original_period.provider_period_start*1000).toISOString(),interval=o.stripe_recurrence.interval_count;
  const invs=[{...structuredClone(f.inv),lines:undefined}],lineById=new Map(),cashById=new Map();
  for(let n=1;n<=ordinal;n++) {
    const l=structuredClone(f.il[0]);l.id=`il_CYCLE_${n}`;
    l.period={start:Date.parse(anchoredMonthInstant(b,n*interval))/1000,end:Date.parse(anchoredMonthInstant(b,(n+1)*interval))/1000};
    const d=n===ordinal?discount:0,t=n===ordinal?tax:0,total=o.platform_payment_cents-d+t;
    l.discount_amounts=d?[{discount:'di_SYNTHETIC',amount:d}]:[];
    l.tax_amounts=t?[{tax_rate:'txr_SYNTHETIC',inclusive:false,amount:t}]:[];
    const i={...structuredClone(f.inv),id:`in_CYCLE_${n}`,billing_reason:'subscription_cycle',
      created:l.period.start,status_transitions:{paid_at:l.period.start+7},
      subtotal:o.platform_payment_cents,total,amount_due:total,amount_paid:total,
      total_discount_amounts:structuredClone(l.discount_amounts),total_tax_amounts:structuredClone(l.tax_amounts),
      payment_intent:total?`pi_CYCLE_${n}`:null,charge:total?`ch_CYCLE_${n}`:null,lines:{object:'list',has_more:false,data:[l]}};
    const pi=total?{...structuredClone(f.pi),id:i.payment_intent,invoice:i.id,latest_charge:i.charge,amount:total,amount_received:total}:null;
    const ch=total?{...structuredClone(f.ch),id:i.charge,invoice:i.id,payment_intent:i.payment_intent,amount:total,amount_captured:total}:null;
    invs.push(i);lineById.set(i.id,i.lines);cashById.set(i.id,{pi,ch});
  }
  const cycle=inspect({packageSnapshot:pkg,originalPeriod:source.original_period,originalProviderAccountId:source.original_provider_account_id,
    providerAccountId:source.original_provider_account_id,invoices:{object:'list',has_more:false,data:invs}}).cycles.at(-1);
  const invoice=invs.at(-1),cash=cashById.get(invoice.id),calls=[],db={async rpc(name,args){calls.push(['rpc',name,args]);return{data:structuredClone(source),error:null};}};
  const sdk={getApiField:()=> '2023-10-16',accounts:{async retrieve(){calls.push(['account']);return{object:'account',id:'acct_SYNTHETIC'};}},
    invoices:{async list(args){calls.push(['list',args]);return{object:'list',has_more:false,data:structuredClone(invs)};},
      async retrieve(id){calls.push(['invoice',id]);return structuredClone(invs.find(i=>i.id===id));},
      async listLineItems(id,args){calls.push(['lines',id,args]);return structuredClone(lineById.get(id));}},
    paymentIntents:{async retrieve(id){calls.push(['pi',id]);return structuredClone([...cashById.values()].find(c=>c.pi?.id===id)?.pi);}},
    charges:{async retrieve(id){calls.push(['charge',id]);return structuredClone([...cashById.values()].find(c=>c.ch?.id===id)?.ch);}}};
  return{source,cycle,invoice,invoiceLines:lineById.get(invoice.id),paymentIntent:cash.pi,charge:cash.ch,
    providerAccountId:source.original_provider_account_id,db,sdk,calls,invs,
    options:{db,stripe:sdk,agreementId:f.g.id,clientId:f.c.id,invoiceId:invoice.id}};
}
function proofInput(f){return Object.fromEntries(['source','cycle','invoice','invoiceLines','paymentIntent','charge','providerAccountId'].map(k=>[k,f[k]]));}
module.exports={recurringFixture,proofInput};
