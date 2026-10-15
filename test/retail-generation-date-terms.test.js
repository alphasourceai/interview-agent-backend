'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {STRIPE_RECURRING_OFFER_VERSION,retailGenerationTermDates}=require('../src/services/membershipOffers');
const {buildRetailPackageSnapshot,readRetailPackageOffer}=require('../src/services/membershipPackageCompatibility');
const {retailAgreementTerms,validateRetailAgreementSource,retailQuoteCatalog,normalizeRetailQuoteSelection,RETAIL_TEMPLATE}=require('../src/services/retailQuoteSelection');
const {buildMembershipAgreementHtml}=require('../src/render/membershipAgreement');
const VERSION='retail-stripe-terms-2026-10-15-v3';
const selection=(months,version=VERSION)=>({planKey:'basic',commitmentMonths:months,paymentOption:'prepaid',
  channel:'public',offerVersion:version,firstRolePrepaySelected:false});

for(const [generatedAt,months,start,end] of [
  ['2026-10-15T23:59:59.999Z',3,'2026-10-15','2027-01-15'],
  ['2026-01-31T09:30:00.000Z',3,'2026-01-31','2026-04-30'],
  ['2027-08-31T09:30:00.000Z',6,'2027-08-31','2028-02-29'],
  ['2028-02-29T09:30:00.000Z',12,'2028-02-29','2029-02-28']
])test(`new generation-dated agreement freezes ${start} through ${end}`,()=>{
  const pkg=buildRetailPackageSnapshot(selection(months));
  assert.equal(readRetailPackageOffer(pkg).term_start_basis,'generation_date');
  const terms=retailAgreementTerms(pkg,{generatedAt});
  assert.equal(terms.term_start_basis,'generation_date');
  assert.equal(terms.initial_term_start,start);
  assert.equal(terms.initial_renewal_date,end);
  const {html,normalized}=buildMembershipAgreementHtml({...terms,client_legal_name:'SYNTHETIC Generation Date',
    primary_admin_name:'SYNTHETIC Buyer',admin_email:'generation@example.invalid'},
    {packageSnapshot:pkg,generatedAt,timeZone:'UTC'});
  assert.equal(normalized.initial_term_start,start);
  assert.equal(normalized.initial_renewal_date,end);
  const text=html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
  assert.doesNotMatch(text,/Successful initial payment date|months after initial payment|signature or agreement preparation date does not start/);
  assert.match(text,/payment/i);
});

test('generation date helper uses the captured UTC day and original calendar clamp without reading a new clock',()=>{
  for(const [generatedAt,months,start,end] of [
    ['2026-10-15T23:59:59.999Z',3,'2026-10-15','2027-01-15'],
    ['2026-01-31T09:30:00.000Z',3,'2026-01-31','2026-04-30'],
    ['2027-08-31T09:30:00.000Z',6,'2027-08-31','2028-02-29'],
    ['2028-02-29T09:30:00.000Z',12,'2028-02-29','2029-02-28']
  ]) {
    const expected={generated_at:generatedAt,initial_term_start:start,initial_renewal_date:end};
    assert.deepEqual(retailGenerationTermDates({generatedAt,commitmentMonths:months}),expected);
    assert.ok(Object.isFrozen(retailGenerationTermDates({generatedAt,commitmentMonths:months})));
  }
  for(const generatedAt of [undefined,null,'2026-10-15','2026-02-30T00:00:00.000Z','2026-10-15T12:00:00-06:00'])
    assert.throws(()=>retailGenerationTermDates({generatedAt,commitmentMonths:3}),{code:'invalid_generation_instant'});
  assert.throws(()=>retailGenerationTermDates({generatedAt:'2026-10-15T12:00:00.000Z',commitmentMonths:9}),{code:'invalid_commitment_months'});
});

test('accepted native-Stripe v2 sources keep their original first-payment basis and dates policy',()=>{
  const pkg=buildRetailPackageSnapshot(selection(3,STRIPE_RECURRING_OFFER_VERSION));
  assert.equal(readRetailPackageOffer(pkg).term_start_basis,'first_payment_success');
  const terms=retailAgreementTerms(pkg,{generatedAt:'2026-10-15T12:00:00.000Z'});
  assert.equal(terms.term_start_basis,'successful_payment');
  assert.equal(terms.initial_term_start,null);
  assert.equal(terms.initial_renewal_date,null);
});

test('new version and generation basis are an exact pair; no relabeling of old sources',()=>{
  for(const version of [VERSION,STRIPE_RECURRING_OFFER_VERSION]){
    const pkg=structuredClone(buildRetailPackageSnapshot(selection(3,version)));
    pkg.membership_terms.term_start_basis=version===VERSION?'first_payment_success':'generation_date';
    assert.throws(()=>readRetailPackageOffer(pkg),{code:'invalid_retail_package_terms'});
  }
});

test('prospective dates render all 24 price/term/payment/role variants without moving accepted old defaults',()=>{
  for(const planKey of ['basic','pro'])for(const commitmentMonths of [3,6,12])
    for(const paymentOption of ['prepaid','monthly_installments'])for(const firstRolePrepaySelected of [false,true]){
      const pkg=buildRetailPackageSnapshot({planKey,commitmentMonths,paymentOption,firstRolePrepaySelected,
        channel:'sales',offerVersion:VERSION});
      const generatedAt='2026-10-15T23:59:59.999Z';
      const terms=retailAgreementTerms(pkg,{generatedAt});
      const rendered=buildMembershipAgreementHtml({...terms,client_legal_name:'SYNTHETIC ONLY'},
        {packageSnapshot:pkg,generatedAt,timeZone:'America/Denver'});
      assert.equal(rendered.normalized.initial_term_start,'2026-10-15');
      assert.equal(rendered.normalized.initial_renewal_date,commitmentMonths===3?'2027-01-15':commitmentMonths===6?'2027-04-15':'2027-10-15');
      const text=rendered.html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
      assert.match(text,/October 15, 2026/);
      assert.match(text,/does not take effect, and access is not activated, unless/);
      assert.match(text,/Signing or paying later does not move the stated term dates/);
      assert.match(text,/Collection dates do not change the fixed contractual term dates/);
      assert.equal(text.includes('First-Role Prepay Credit'),firstRolePrepaySelected);
    }
  const env={MEMBERSHIP_PRICING_TERMS_ENABLED:'true'};
  assert.equal(retailQuoteCatalog('public',env).pricing_version,STRIPE_RECURRING_OFFER_VERSION);
  assert.throws(()=>normalizeRetailQuoteSelection({plan_key:'basic',commitment_months:3,
    payment_option:'prepaid',offer_version:VERSION},{channel:'public',env}),{code:'stale_offer_version'});
});

test('stored generation instant, snapshot dates and row dates must agree; a later render clock cannot move them',()=>{
  const pkg=buildRetailPackageSnapshot(selection(3));
  const generatedAt='2026-10-15T23:59:59.999Z';
  const terms=retailAgreementTerms(pkg,{generatedAt});
  const {normalized}=buildMembershipAgreementHtml({...terms,client_legal_name:'SYNTHETIC ONLY'},
    {packageSnapshot:pkg,generatedAt});
  const agreement={id:'synthetic-only',membership_tier:'basic',billing_option:'prepaid',auto_renew:true,
    notice_deadline_days:30,template_version:RETAIL_TEMPLATE,initial_term_start:terms.initial_term_start,
    initial_renewal_date:terms.initial_renewal_date,template_snapshot:{template_version:RETAIL_TEMPLATE,
      generated_at:generatedAt,package_snapshot:pkg,values:normalized}};
  assert.equal(validateRetailAgreementSource(agreement).offer_version,VERSION);
  for(const changed of [
    {...agreement,initial_term_start:'2026-10-16'},
    {...agreement,initial_renewal_date:'2027-01-16'},
    {...agreement,template_snapshot:{...agreement.template_snapshot,generated_at:'2026-10-16T00:00:00.000Z'}},
    {...agreement,template_snapshot:{...agreement.template_snapshot,generated_at:undefined}}
  ])assert.throws(()=>validateRetailAgreementSource(changed),{code:'retail_agreement_terms_mismatch'});
  assert.throws(()=>buildMembershipAgreementHtml(normalized,{packageSnapshot:pkg,
    generatedAt:'2026-10-16T00:00:00.000Z'}),{code:'retail_agreement_terms_mismatch'});
});
