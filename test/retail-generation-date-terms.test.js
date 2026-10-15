'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {STRIPE_RECURRING_OFFER_VERSION,retailGenerationTermDates,retailGenerationCollectionSchedule}=require('../src/services/membershipOffers');
const {buildRetailPackageSnapshot,readRetailPackageOffer}=require('../src/services/membershipPackageCompatibility');
const {retailAgreementTerms,validateRetailAgreementSource,retailQuoteCatalog,normalizeRetailQuoteSelection,RETAIL_TEMPLATE,retailAgreementTermWindow}=require('../src/services/retailQuoteSelection');
const {buildMembershipAgreementHtml}=require('../src/render/membershipAgreement');
const VERSION='retail-stripe-terms-2026-10-15-v3';
const {retailSigningRenewalNotice}=require('../src/services/retailQuoteSelection');
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
  assert.equal(retailQuoteCatalog('public',env).pricing_version,VERSION);
  assert.equal(normalizeRetailQuoteSelection({plan_key:'basic',commitment_months:3,
    payment_option:'prepaid',offer_version:VERSION},{channel:'public',env}).offer_version,VERSION);
  assert.throws(()=>normalizeRetailQuoteSelection({plan_key:'basic',commitment_months:3,
    payment_option:'prepaid',offer_version:STRIPE_RECURRING_OFFER_VERSION},{channel:'public',env}),{code:'stale_offer_version'});
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

function agreementFixture(months=3,payment='prepaid',generatedAt='2026-01-31T23:59:59.999Z') {
  const pkg=buildRetailPackageSnapshot({...selection(months),channel:'sales',paymentOption:payment});
  const terms=retailAgreementTerms(pkg,{generatedAt});
  const {normalized}=buildMembershipAgreementHtml({...terms,client_legal_name:'SYNTHETIC ONLY'},
    {packageSnapshot:pkg,generatedAt});
  return {pkg,offer:readRetailPackageOffer(pkg),agreement:{id:'synthetic-only',client_id:'synthetic-client',
    membership_tier:'basic',billing_option:pkg.billing_cadence,auto_renew:true,notice_deadline_days:30,
    template_version:RETAIL_TEMPLATE,initial_term_start:terms.initial_term_start,initial_renewal_date:terms.initial_renewal_date,
    template_snapshot:{template_version:RETAIL_TEMPLATE,generated_at:generatedAt,package_snapshot:pkg,values:normalized}}};
}

test('signer reminder-only classification requires the validated accepted retail source, not a plan label',()=>{
  const {agreement}=agreementFixture();
  assert.equal(retailSigningRenewalNotice(agreement),'reminder_only');
  for(const changed of [
    {membership_tier:'basic',notice_deadline_days:30},
    {membership_tier:'enterprise',notice_deadline_days:30},
    {...agreement,initial_renewal_date:'2027-01-01'},
    {...agreement,template_version:'legacy'},
    {...agreement,notice_deadline_days:60},
    {...agreement,template_snapshot:{...agreement.template_snapshot,generated_at:null}}
  ]) assert.equal(retailSigningRenewalNotice(changed),null);
});

test('delayed payment cannot move the fixed term or month-end renewals; actual cash date stays separate',()=>{
  for(const payment of ['prepaid','monthly_installments'])for(const months of [3,6,12]){
    const {agreement}=agreementFixture(months,payment),before=structuredClone(agreement);
    const first=retailAgreementTermWindow({agreement,paidAt:'2026-02-07T12:00:00.000Z'});
    assert.equal(first.term_start_at,'2026-01-31T00:00:00.000Z');
    assert.equal(first.term_end_at,`${agreement.initial_renewal_date}T00:00:00.000Z`);
    const second=retailAgreementTermWindow({agreement,paidAt:'2026-02-07T12:00:00.000Z',termIndex:1});
    assert.equal(second.term_start_at,first.term_end_at);
    assert.equal(second.term_end_at,months===3?'2026-07-31T00:00:00.000Z':months===6?'2027-01-31T00:00:00.000Z':'2028-01-31T00:00:00.000Z');
    assert.deepEqual(agreement,before);
    for(const paidAt of [undefined,'not-a-date','2026-01-31T23:59:59.000Z',`${agreement.initial_renewal_date}T00:00:00.000Z`])
      assert.throws(()=>retailAgreementTermWindow({agreement,paidAt}),{code:'retail_original_payment_time_required'});
  }
});

test('native first recurring boundary uses the generated calendar, not later payment, without adding a billing anchor',()=>{
  for(const payment of ['prepaid','monthly_installments'])for(const months of [3,6,12]){
    const {agreement,offer}=agreementFixture(months,payment);
    const args={offer,generatedAt:agreement.template_snapshot.generated_at,initialTermStart:agreement.initial_term_start,
      initialRenewalDate:agreement.initial_renewal_date,now:'2026-02-07T12:00:00.000Z'};
    const schedule=retailGenerationCollectionSchedule(args);
    assert.equal(schedule.first_collection_at,payment==='prepaid'
      ? `${agreement.initial_renewal_date}T00:00:00.000Z`:'2026-02-28T00:00:00.000Z');
    assert.equal(schedule.trial_end,Date.parse(schedule.first_collection_at)/1000);
    assert.ok(Object.isFrozen(schedule));
    assert.deepEqual(Object.keys(schedule).sort(),['first_collection_at','initial_renewal_date','initial_term_start','trial_end']);
    for(const change of [{initialTermStart:'2026-02-07'},{initialRenewalDate:'2027-02-07'}])
      assert.throws(()=>retailGenerationCollectionSchedule({...args,...change}),{code:'retail_agreement_terms_mismatch'});
    assert.throws(()=>retailGenerationCollectionSchedule({...args,now:schedule.first_collection_at}),{code:'retail_checkout_window_closed'});
    assert.throws(()=>retailGenerationCollectionSchedule({...args,now:'2026-01-31T00:00:00.000Z'}),{code:'invalid_checkout_instant'});
    assert.throws(()=>retailGenerationCollectionSchedule({...args,now:undefined}),{code:'invalid_checkout_instant'});
  }
  const old=readRetailPackageOffer(buildRetailPackageSnapshot(selection(3,STRIPE_RECURRING_OFFER_VERSION)));
  assert.throws(()=>retailGenerationCollectionSchedule({offer:old}),{code:'generation_date_offer_required'});
});

test('existing public and sales quote adapters reuse the same captured generation instant',()=>{
  const clientPath=require.resolve('../src/clients/supabase');
  const saved=require.cache[clientPath];
  require.cache[clientPath]={id:clientPath,filename:clientPath,loaded:true,exports:{supabaseAdmin:{}}};
  try{
    const {buildAgreementInputFromPurchaseIntent}=require('../src/services/alphaScreen');
    const {agreementInputFromDraft}=require('../src/services/salesWorkspace');
    const {buildClientActivationPayload}=require('../src/services/publicPurchaseActivation');
    const {getRetailRenewalWindow}=require('../src/services/contracts/contractRenewals');
    const generatedAt='2028-02-29T23:59:59.999Z';
    const {pkg}=agreementFixture(12,'prepaid',generatedAt);
    const intent={package_snapshot:pkg,selected_billing_cadence:'prepaid',company_legal_name:'SYNTHETIC',
      buyer_first_name:'Synthetic',buyer_last_name:'Buyer',buyer_email:'buyer@example.invalid'};
    const draft={company_legal_name:'SYNTHETIC',plan_key:'basic',billing_cadence:'prepaid',
      buyer_first_name:'Synthetic',buyer_last_name:'Buyer',buyer_email:'buyer@example.invalid'};
    const schedule={effective_date:'2099-01-01',renewal_date:'2100-01-01',expires_at:'2028-03-07T00:00:00.000Z'};
    for(const input of [buildAgreementInputFromPurchaseIntent(intent,{generatedAt}),
      agreementInputFromDraft(draft,pkg,schedule,{generatedAt})]){
      assert.equal(input.initial_term_start,'2028-02-29');
      assert.equal(input.initial_renewal_date,'2029-02-28');
      const {normalized}=buildMembershipAgreementHtml(input,{packageSnapshot:pkg,generatedAt});
      assert.equal(normalized.initial_term_start,input.initial_term_start);
      assert.equal(normalized.initial_renewal_date,input.initial_renewal_date);
    }
    const {pkg:paidPkg,agreement}=agreementFixture();
    const paidAt='2026-02-07T12:00:00.000Z';
    const payload=buildClientActivationPayload({agreement,packageSnapshot:paidPkg,planKey:'basic',billingInterval:'prepaid',paidAt,
      subscription:{id:'sub_SYNTHETIC',customer:'cus_SYNTHETIC',status:'trialing',
        start_date:Date.parse(paidAt)/1000,current_period_end:Date.parse('2026-04-30T00:00:00.000Z')/1000}});
    assert.equal(payload.contract_start_at,'2026-01-31T00:00:00.000Z');
    assert.equal(payload.contract_end_at,'2026-04-30T00:00:00.000Z');
    assert.equal(agreement.checkout_paid_at,undefined,'calendar mapping never manufactures received cash');
    const next=getRetailRenewalWindow({...payload,id:agreement.client_id},{...agreement,status:'active',is_current:true,
      checkout_status:'paid',checkout_paid_at:paidAt});
    assert.equal(next.term_start_at,'2026-04-30T00:00:00.000Z');
    assert.equal(next.term_end_at,'2026-07-31T00:00:00.000Z');
  }finally{if(saved)require.cache[clientPath]=saved;else delete require.cache[clientPath];}
});
