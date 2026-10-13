'use strict';
const assert=require('node:assert/strict');
const {createFakeSupabase}=require('../helpers/fakeSupabase');
const {buildRetailPackageSnapshot}=require('../../src/services/membershipPackageCompatibility');
const {OFFER_VERSION}=require('../../src/services/membershipOffers');
const {normalizeSalesDraft,agreementInputFromDraft}=require('../../src/services/salesWorkspace');
const {buildMembershipAgreementHtml}=require('../../src/render/membershipAgreement');
const PAID='2026-01-31T12:13:14.000Z',A=Date.parse(PAID)/1000,C='44444444-4444-4444-8444-444444444444',G='33333333-3333-4333-8333-333333333333',I='11111111-1111-4111-8111-111111111111';
function fixture(plan='basic',months=3,payment='prepaid',role=false,{admin=false,promo=false,tax=false}={}){
  const pkg=buildRetailPackageSnapshot({planKey:plan,commitmentMonths:months,paymentOption:payment,firstRolePrepaySelected:role,offerVersion:OFFER_VERSION,channel:'sales'});
  const draft=normalizeSalesDraft({plan_key:plan,commitment_months:months,payment_option:payment,offer_version:OFFER_VERSION,
    first_role_prepay_selected:role,company_legal_name:'Synthetic',buyer_first_name:'QA',buyer_last_name:'Buyer',
    buyer_email:'buyer@example.invalid',buyer_phone:'synthetic',buyer_title:'Owner'}, {env:{MEMBERSHIP_PRICING_TERMS_ENABLED:'true'}});
  const {normalized}=buildMembershipAgreementHtml(agreementInputFromDraft(draft,pkg),{packageSnapshot:pkg});
  const g={id:G,client_id:C,membership_tier:plan,billing_option:pkg.billing_cadence,auto_renew:true,notice_deadline_days:30,
    status:'signed',is_current:true,signer_accepted:true,superseded_by_agreement_id:null,checkout_status:'pending_payment',checkout_session_id:'cs_SYNTHETIC',
    checkout_paid_at:null,signed_at:'2026-01-01T00:00:00Z',agreement_expires_at:'2026-02-15T00:00:00Z',template_version:'membership_agreement_retail_terms_v2',
    template_snapshot:{template_version:'membership_agreement_retail_terms_v2',package_snapshot:pkg,values:normalized,
      ...(admin?{}:{source:'sales_assisted',purchase_intent:{id:I}})}};
  const i={id:I,agreement_id:G,client_id:C,status:'checkout_pending',protocol:'fenced_v2',selected_plan_key:plan,selected_billing_cadence:pkg.billing_cadence,
    package_snapshot:pkg,stripe_checkout_session_id:'cs_SYNTHETIC',term_start_basis:'successful_payment',first_role_prepay_selected:role,
    first_role_prepay_amount_cents:role?pkg.first_role_prepay.discounted_credit_amount_cents:null,
    first_role_normal_role_fee_cents:role?pkg.first_role_prepay.normal_role_fee_cents:null,first_role_prepay_discount_percent:role?10:null,
    first_role_prepay_credit_type:role?'first_role_prepay':null,activated_at:null,expires_at:'2026-02-15T00:00:00Z'};
  const c={id:C,stripe_customer_id:'cus_SYNTHETIC',stripe_subscription_id:null};
  const price={id:'price_PLATFORM',object:'price',currency:'usd',type:'recurring',unit_amount:pkg.platform_fee_cents,
    recurring:{interval:'month',interval_count:pkg.membership_terms.stripe_recurrence.interval_count,usage_type:'licensed'}};
  const rolePrice={id:'price_ROLE',object:'price',currency:'usd',type:'one_time',unit_amount:pkg.first_role_prepay.discounted_credit_amount_cents,recurring:null};
  const entries=[{id:'li_PLATFORM',price,amount:price.unit_amount},...(role?[{id:'li_ROLE',price:rolePrice,amount:rolePrice.unit_amount}]:[])];
  const il=entries.map((e,n)=>({id:n?'il_ROLE':'il_PLATFORM',object:'line_item',price:e.price,currency:'usd',quantity:1,proration:false,
    type:n?'invoiceitem':'subscription',subscription:'sub_SYNTHETIC',subscription_item:n?null:'si_SYNTHETIC',amount:e.amount,
    discount_amounts:promo?[{discount:'di_SYNTHETIC',amount:Math.round(e.amount/10)}]:[],
    tax_amounts:tax?[{tax_rate:'txr_SYNTHETIC',inclusive:false,amount:100}]:[]}));
  const cl=entries.map((e,n)=>({id:e.id,object:'item',currency:'usd',quantity:1,price:e.price,amount_subtotal:e.amount,
    amount_discount:il[n].discount_amounts.reduce((s,d)=>s+d.amount,0),amount_tax:tax?100:0,
    amount_total:e.amount-il[n].discount_amounts.reduce((s,d)=>s+d.amount,0)+(tax?100:0)}));
  const discounts=cl.reduce((s,l)=>s+l.amount_discount,0),taxes=cl.reduce((s,l)=>s+l.amount_tax,0),total=pkg.membership_terms.initial_payment_cents-discounts+taxes;
  const cs={id:'cs_SYNTHETIC',object:'checkout.session',livemode:false,mode:'subscription',status:'complete',payment_status:'paid',currency:'usd',
    customer:'cus_SYNTHETIC',subscription:'sub_SYNTHETIC',invoice:'in_INITIAL',created:A-20,amount_subtotal:pkg.membership_terms.initial_payment_cents,amount_total:total};
  const s={id:'sub_SYNTHETIC',object:'subscription',livemode:false,customer:'cus_SYNTHETIC',currency:'usd',status:'active',latest_invoice:'in_LATER_ZERO',
    start_date:A-10,current_period_end:A+1000,items:{object:'list',data:[{id:'si_SYNTHETIC',price,quantity:1,subscription:'sub_SYNTHETIC'}],has_more:false}};
  const inv={id:'in_INITIAL',object:'invoice',livemode:false,customer:'cus_SYNTHETIC',currency:'usd',subscription:s.id,billing_reason:'subscription_create',
    created:A-10,status_transitions:{paid_at:A},status:'paid',paid:true,amount_remaining:0,paid_out_of_band:false,starting_balance:0,ending_balance:0,
    pre_payment_credit_notes_amount:0,post_payment_credit_notes_amount:0,subtotal:pkg.membership_terms.initial_payment_cents,total,amount_due:total,amount_paid:total,
    total_discount_amounts:promo?[{discount:'di_SYNTHETIC',amount:discounts}]:[],total_tax_amounts:tax?[{tax_rate:'txr_SYNTHETIC',inclusive:false,amount:taxes}]:[],
    payment_intent:'pi_SYNTHETIC',charge:'ch_SYNTHETIC',lines:{object:'list',data:il,has_more:false}};
  const pi={id:'pi_SYNTHETIC',object:'payment_intent',livemode:false,customer:'cus_SYNTHETIC',currency:'usd',invoice:inv.id,latest_charge:'ch_SYNTHETIC',
    status:'succeeded',amount:total,amount_received:total};
  const ch={id:'ch_SYNTHETIC',object:'charge',livemode:false,customer:'cus_SYNTHETIC',currency:'usd',invoice:inv.id,payment_intent:pi.id,
    status:'succeeded',paid:true,captured:true,amount:total,amount_captured:total,amount_refunded:0,refunded:false,disputed:false};
  const tables={membership_agreements:[g],public_purchase_intents:admin?[]:[i],clients:[c],billing_customers:[{id:'customer',client_id:C,stripe_customer_id:c.stripe_customer_id}]};
  const db=createFakeSupabase(tables),calls=[];let fences=0;
  const array=(data)=>({object:'list',data:structuredClone(data),has_more:false});
  const sdk={checkout:{sessions:{retrieve:async key=>{calls.push(['session',key]);return structuredClone(cs)},listLineItems:async()=>array(cl)}},
    subscriptions:{retrieve:async key=>{calls.push(['subscription',key]);return structuredClone(s)}},
    subscriptionItems:{list:async()=>array(s.items.data)},
    invoices:{retrieve:async key=>{calls.push(['invoice',key]);assert.equal(key,'in_INITIAL');return structuredClone(inv)},
      list:async()=>array([{id:'in_LATER_ZERO',billing_reason:'subscription_cycle',created:A+100,status_transitions:{paid_at:A+100}},inv]),
      listLineItems:async()=>array(il)},paymentIntents:{retrieve:async()=>structuredClone(pi)},charges:{retrieve:async()=>structuredClone(ch)}};
  const options={db,stripe:sdk,agreementId:G,intentId:admin?null:I,eventSessionId:cs.id,eventSubscriptionId:s.id,eventLivemode:false,assertFence:async()=>{fences++}};
  return{pkg,g,i,c,cs,s,inv,pi,ch,il,cl,tables,db,sdk,calls,options,get fences(){return fences}};
}
module.exports={fixture,PAID,A,C,G,I};

