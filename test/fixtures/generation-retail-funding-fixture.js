'use strict';
// Authored provider shapes for the existing SDK reader; no live SDK/network.
const {fixture}=require('./existing-retail-funding-fixture');
const {buildRetailPackageSnapshot}=require('../../src/services/membershipPackageCompatibility');
const {GENERATION_DATE_OFFER_VERSION,retailGenerationTermDates,retailGenerationCollectionSchedule}=require('../../src/services/membershipOffers');
const {retailAgreementTerms}=require('../../src/services/retailQuoteSelection');
const {buildMembershipAgreementHtml}=require('../../src/render/membershipAgreement');
const GENERATED='2026-01-31T10:00:00.000Z',PAID='2026-02-02T11:00:20.000Z';
function generationFixture(plan='basic',months=3,payment='prepaid',role=false,{admin=false,generatedAt=GENERATED,paidAt=PAID}={}){
 const A=Date.parse(paidAt)/1000,deadline=new Date((A+5*86400)*1000).toISOString();
 const f=fixture(plan,months,payment,role,{admin});
 const pkg=buildRetailPackageSnapshot({planKey:plan,commitmentMonths:months,paymentOption:payment,
  firstRolePrepaySelected:role,channel:'sales',offerVersion:GENERATION_DATE_OFFER_VERSION});
 const dates=retailGenerationTermDates({generatedAt,commitmentMonths:months});
 const {normalized}=buildMembershipAgreementHtml({...retailAgreementTerms(pkg,{generatedAt}),
  client_legal_name:'SYNTHETIC ONLY',primary_admin_name:'Synthetic Buyer',admin_email:'buyer@example.invalid'},
  {packageSnapshot:pkg,generatedAt});
 const schedule=retailGenerationCollectionSchedule({offer:pkg.membership_terms,generatedAt,
  initialTermStart:dates.initial_term_start,initialRenewalDate:dates.initial_renewal_date,now:new Date((A-20)*1000).toISOString()});
 Object.assign(f.g,{...dates,signed_at:new Date((A-3600)*1000).toISOString(),agreement_expires_at:deadline,
  template_snapshot:{source:admin?'admin':'sales_assisted',template_version:f.g.template_version,generated_at:generatedAt,
   package_snapshot:pkg,values:normalized,...(admin?{}:{purchase_intent:{id:f.i.id}})}});
 f.g.checkout_attempt_source={version:'retail_existing_checkout_attempt_v1',agreement_id:f.g.id,client_id:f.c.id,
  customer_id:f.c.stripe_customer_id,template_snapshot:structuredClone(f.g.template_snapshot)};
 Object.assign(f.i,{package_snapshot:pkg,term_start_basis:'generation_date',expires_at:deadline});
 const recurring=f.cl[0].price,initial={...recurring,id:'price_INITIAL_PLATFORM',type:'one_time',recurring:null};
 const rolePrice=role?f.cl[1].price:null;
 const entries=[{id:'li_INITIAL_PLATFORM',price:initial,amount:pkg.platform_fee_cents},
  {id:'li_RECURRING',price:recurring,amount:0},...(role?[{id:'li_ROLE',price:rolePrice,amount:pkg.first_role_prepay.discounted_credit_amount_cents}]:[])];
 f.cl.splice(0,f.cl.length,...entries.map(e=>({id:e.id,object:'item',currency:'usd',quantity:1,price:e.price,
  amount_subtotal:e.amount,amount_discount:0,amount_tax:0,amount_total:e.amount})));
 f.il.splice(0,f.il.length,...entries.map((e,n)=>({id:n===0?'il_INITIAL_PLATFORM':n===1?'il_RECURRING':'il_ROLE',
  object:'line_item',currency:'usd',quantity:1,price:e.price,type:n===1?'subscription':'invoiceitem',
  subscription:f.s.id,subscription_item:n===1?'si_SYNTHETIC':null,proration:false,amount:e.amount,
  period:{start:A-10,end:schedule.trial_end},discount_amounts:[],tax_amounts:[]})));
 Object.assign(f.cs,{created:A-20});
 Object.assign(f.s,{status:'trialing',start_date:A-10,trial_start:A-10,trial_end:schedule.trial_end,
  billing_cycle_anchor:schedule.trial_end,current_period_start:A-10,current_period_end:schedule.trial_end,
  schedule:null,pause_collection:null,cancel_at:null,cancel_at_period_end:false});
 f.s.items.data[0].object='subscription_item';
 Object.assign(f.inv,{created:A-10,status_transitions:{paid_at:A}});
 f.g.retail_checkout_prices={initial_platform_price_id:initial.id,recurring_platform_price_id:recurring.id,
  first_role_price_id:role?rolePrice.id:null};
 f.sdk.getApiField=k=>k==='version'?'2023-10-16':null;
 f.sdk.accounts={retrieve:async()=>({object:'account',id:'acct_SYNTHETIC'})};
 return {...f,pkg,offer:pkg.membership_terms,dates,schedule};
}
module.exports={generationFixture,GENERATED,PAID};
