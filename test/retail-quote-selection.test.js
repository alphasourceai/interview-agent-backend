'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {OFFER_VERSION} = require('../src/services/membershipOffers');
const {buildRetailPackageSnapshot} = require('../src/services/membershipPackageCompatibility');
const {normalizeRetailQuoteSelection,retailQuoteCatalog,validateRetailIntentSource,validateRetailAgreementSource,RETAIL_TEMPLATE}
  = require('../src/services/retailQuoteSelection');
const {normalizeSalesDraft,validateSalesDraft,calculatePricing,agreementInputFromDraft,fingerprint} = require('../src/services/salesWorkspace');
const {buildMembershipAgreementHtml} = require('../src/render/membershipAgreement');
const on = {MEMBERSHIP_PRICING_TERMS_ENABLED:'true'}, off = {};
const keys = (months=3,payment='prepaid') => ({plan_key:'basic',commitment_months:months,payment_option:payment,offer_version:OFFER_VERSION});
const identity = {company_legal_name:'Synthetic Only',buyer_first_name:'QA',buyer_last_name:'Buyer',buyer_email:'buyer@example.invalid',
  buyer_phone:'555-555-0100',buyer_title:'Owner',candidate_assistance_name:'QA Buyer',candidate_assistance_email:'buyer@example.invalid'};
test('quote gate is exact default-off and legacy selection unchanged',()=>{
  assert.equal(normalizeRetailQuoteSelection({plan_key:'basic',billing_cadence:'monthly'},{channel:'public',env:off}),null);
  assert.equal(retailQuoteCatalog('public',off),null);
  for(const env of [off,{MEMBERSHIP_PRICING_TERMS_ENABLED:'TRUE'}])
    assert.throws(()=>normalizeRetailQuoteSelection(keys(),{channel:'public',env}),{code:'retail_pricing_not_enabled'});
});
test('public catalog prepaid only and staff catalog both payment choices from same factory',()=>{
  assert.equal(retailQuoteCatalog('public',on).offers.length,6);
  assert.equal(retailQuoteCatalog('sales',on).offers.length,12);
  assert.equal(retailQuoteCatalog('admin',on).pricing_version,OFFER_VERSION);
  assert.ok(retailQuoteCatalog('public',on).offers.every(o=>o.payment_option==='prepaid'));
});
test('enabled selection refuses missing stale forbidden or conflicting keys',()=>{
  const bad=[{},keys(4),{...keys(),offer_version:'old'},keys(3,'monthly_installments'),
    {...keys(),billing_cadence:'annual'},{...keys(),commitmentMonths:6},
    {...keys(),paymentOption:'monthly_installments'},{...keys(),pricingVersion:'old'},{...keys(),plan:'pro'}];
  for(const body of bad) assert.throws(()=>normalizeRetailQuoteSelection(body,{channel:'public',env:on}));
  assert.equal(normalizeRetailQuoteSelection({...keys(),commitmentMonths:'3',billing_cadence:'prepaid'},{channel:'public',env:on}).commitment_months,3);
});
test('staff matrix reuses current draft/pricing/render structure without inventing start dates',()=>{
  let count=0;
  for(const plan_key of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true]){
    const draft=validateSalesDraft(normalizeSalesDraft({...identity,...keys(months,payment),plan_key,first_role_prepay_selected:role},{env:on}));
    const {package_snapshot:s,pricing}=calculatePricing(draft);
    assert.equal(s.commitment_months,months);assert.equal(s.payment_option,payment);
    assert.equal(pricing.initial_payment_cents,s.platform_fee_cents+(role?s.first_role_prepay.discounted_credit_amount_cents:0));
    assert.equal(pricing.platform_commitment_total_cents,s.platform_fee_cents*(payment==='prepaid'?1:months));
    const input=agreementInputFromDraft(draft,s);
    assert.equal(input.initial_term_start,null);assert.equal(input.initial_renewal_date,null);
    assert.equal(input.term_start_basis,'successful_payment');
    assert.match(buildMembershipAgreementHtml(input,{packageSnapshot:s}).html,new RegExp(`initial term of ${months} calendar months`));
    assert.equal(normalizeSalesDraft(draft,{savedPackageSnapshot:s,env:off}).commitment_months,months);
    count++;
  }
  assert.equal(count,24);
  assert.notEqual(fingerprint(normalizeSalesDraft({...identity,...keys(3)},{env:on})),fingerprint(normalizeSalesDraft({...identity,...keys(6)},{env:on})));
});
test('new prepaid promotions refused before generating a preview; legacy/monthly policy retained',()=>{
  const draft=normalizeSalesDraft({...identity,...keys(),promotion_code:'SAVE10'},{env:on});
  assert.throws(()=>calculatePricing(draft),{code:'retail_prepaid_promotions_not_supported'});
  const monthly=normalizeSalesDraft({...identity,...keys(3,'monthly_installments')},{env:on});
  assert.equal(calculatePricing(monthly,{code:'SAVE10',percent_off:10}).pricing.promotion_discount_cents,4490);
});
test('saved retail intent and agreement require protocol columns markers and matching accepted snapshots',()=>{
  const s=buildRetailPackageSnapshot({planKey:'basic',commitmentMonths:3,paymentOption:'prepaid',offerVersion:OFFER_VERSION,channel:'public'});
  const intent={id:'intent',agreement_id:'agreement',protocol:'fenced_v2',selected_plan_key:'basic',selected_billing_cadence:'prepaid',package_snapshot:s,
    first_role_prepay_selected:false,first_role_prepay_amount_cents:null,first_role_normal_role_fee_cents:null,
    first_role_prepay_discount_percent:null,first_role_prepay_credit_type:null};
  assert.equal(validateRetailIntentSource(intent).commitment_months,3);
  for(const override of [{protocol:'legacy_complete'},{selected_billing_cadence:'annual'}, {selected_plan_key:'pro'},
    {first_role_prepay_selected:true},{first_role_prepay_amount_cents:0}])
    assert.throws(()=>validateRetailIntentSource({...intent,...override}),{code:'retail_quote_source_mismatch'});
  const {normalized}=buildMembershipAgreementHtml(agreementInputFromDraft(normalizeSalesDraft({...identity,...keys()},{env:on}),s),{packageSnapshot:s});
  const agreement={id:'agreement',membership_tier:'basic',billing_option:'prepaid',auto_renew:true,notice_deadline_days:30,template_version:RETAIL_TEMPLATE,
    template_snapshot:{template_version:RETAIL_TEMPLATE,package_snapshot:s,values:normalized}};
  assert.equal(validateRetailAgreementSource(agreement,intent).commitment_months,3);
  assert.throws(()=>validateRetailAgreementSource({...agreement,auto_renew:false},intent),{code:'retail_agreement_terms_mismatch'});
  assert.throws(()=>validateRetailAgreementSource(agreement,{...intent,agreement_id:'other'}),{code:'retail_quote_source_mismatch'});
  assert.throws(()=>validateRetailAgreementSource({...agreement,template_snapshot:{...agreement.template_snapshot,
    values:{...normalized,platform_fee:'1'}}},intent),{code:'retail_agreement_terms_mismatch'});
});
