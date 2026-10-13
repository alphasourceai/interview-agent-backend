'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildAlphaScreenPackageSnapshot:build,buildAlphaScreenPlanSettingsPayload:settings}=require('../src/services/alphaScreenPackages');
const {readRetailPackageOffer:read}=require('../src/services/membershipPackageCompatibility');
const {OFFER_VERSION,RETAIL_PRICES_CENTS}=require('../src/services/membershipOffers');
function fixture(planKey='basic',months=3,payment='prepaid',role=false,channel='sales') {
  return build(planKey,payment==='prepaid'?'prepaid':'monthly',{commitmentMonths:months,paymentOption:payment,
    firstRolePrepaySelected:role,channel,offerVersion:OFFER_VERSION});
}
test('all 24 pricing/role variants adapt to the existing package shape with no annual mislabel',()=>{
  for(const plan of ['basic','pro'])for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])for(const role of [false,true]){
    const s=fixture(plan,months,payment,role),o=read(s),amount=RETAIL_PRICES_CENTS[plan][months][payment];
    assert.equal(o.platform_payment_cents,amount);assert.equal(s.platform_fee_cents,amount);assert.equal(s.platform_fee,amount/100);
    assert.equal(s.commitment_months,months);assert.equal(s.billing_cadence,payment==='prepaid'?'prepaid':'monthly');
    assert.equal(s.platform_commitment_total_cents,amount*(payment==='prepaid'?1:months));assert.equal(o.initial_payment_cents,amount+(role?(plan==='basic'?35900:62900):0));
    assert.equal(s.first_role_prepay.selected,role);assert.ok(!s.billing_cadence_display_name.includes('Annual'));
    assert.ok(Object.isFrozen(s)&&Object.isFrozen(o));const p=settings({clientId:'existing-client',planKey:plan,billingInterval:s.billing_cadence,packageSnapshot:s});
    assert.equal(p.platform_fee,amount/100);assert.equal(p.per_role_fee,plan==='basic'?399:699);assert.equal(p.included_interviews_per_role,plan==='basic'?20:30);
    assert.equal(p.max_interview_minutes,plan==='basic'?10:12);assert.equal(p.additional_interview_fee,plan==='basic'?25:30);
    assert.equal(p.scored_question_count,plan==='basic'?5:6);assert.equal(p.billing_model,plan==='basic'?'fixed':'rollover');
    assert.equal(Object.hasOwn(p,'rollover_days'),plan==='pro');if(plan==='pro')assert.equal(p.rollover_days,90);
  }
});
test('legacy plan projection remains deep-equal to the exact prior working source',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module'),{execFileSync}=require('node:child_process');
  const file=require.resolve('../src/services/alphaScreenPackages');
  const prior=execFileSync('git',['show','af7fe71bbc61881b1b6e9b6032938c91e8b79669:src/services/alphaScreenPackages.js'],{encoding:'utf8'});
  const module={exports:{}};vm.runInNewContext(prior,{module,exports:module.exports,require:createRequire(file),process,console});
  for(const plan of ['basic','pro'])for(const cadence of ['monthly','annual'])for(const snapshot of [undefined,build(plan,cadence)]){
    const input={clientId:'synthetic',planKey:plan,billingInterval:cadence,packageSnapshot:snapshot};
    assert.deepEqual(settings(input),JSON.parse(JSON.stringify(module.exports.buildAlphaScreenPlanSettingsPayload(input))));
  }
  const activation=fs.readFileSync(require.resolve('../src/services/publicPurchaseActivation'),'utf8');
  assert.match(activation,/const \{ billing_model: explicitBillingModel = null, \.\.\.planSettingsPayload \} = canonicalPlanSettings/);
  assert.match(activation,/recordExplicitBillingModel\(\{ db, clientId, billingModel: explicitBillingModel \}\)/);
});
test('public remains prepaid only; existing monthly and annual builders remain byte-compatible',()=>{
  for(const months of [3,6,12])assert.equal(read(fixture('basic',months,'prepaid',false,'public')).commitment_months,months);
  assert.throws(()=>fixture('basic',3,'monthly_installments',false,'public'),/public_installments_not_available/);
  const old=build('basic','monthly');assert.equal(old.platform_fee,299);assert.equal(read(old),null);
  assert.equal(build('pro','annual').platform_fee,6499);assert.equal(build('basic','prepaid'),null);
  assert.equal(settings({clientId:'c',planKey:'basic',billingInterval:'monthly'}).platform_fee,299);
  assert.equal(settings({clientId:'c',planKey:'pro',billingInterval:'annual'}).platform_fee,6499);
});
test('frozen accepted prices/capacity survive catalog versions without repricing',()=>{
  const s=structuredClone(fixture('basic',6,'monthly_installments'));
  s.pricing_version=s.membership_terms.offer_version='previous-accepted-version';
  s.membership_terms.platform_payment_cents=s.platform_fee_cents=41225;s.platform_fee=412.25;
  s.membership_terms.initial_payment_cents=41225;s.platform_commitment_total_cents=s.membership_terms.platform_commitment_total_cents=41225*6;
  assert.equal(read(s).platform_payment_cents,41225);
  assert.equal(settings({clientId:'c',planKey:'basic',billingInterval:'monthly',packageSnapshot:s}).platform_fee,412.25);
});
test('malformed/disagreeing discriminators, amounts, commitments, role and capacity never fall back to legacy',()=>{
  const s=fixture();for(const edit of [x=>x.pricing_protocol='wrong',x=>delete x.membership_terms,x=>x.platform_fee=1,
    x=>x.membership_terms.commitment_months=4,x=>x.membership_terms.platform_commitment_total_cents=1,x=>x.membership_terms.initial_payment_cents=1,
    x=>x.membership_terms.stripe_recurrence.interval_count=1,x=>x.membership_terms.scored_question_count=9,x=>x.first_role_prepay.selected=true,
    x=>x.membership_terms.renewal.ends_installments_early=true,x=>x.membership_terms.renewal.default_auto_renew=false,x=>x.membership_terms.platform_payment_cents=NaN,
    x=>x.membership_terms.platform_payment_cents=Number.MAX_SAFE_INTEGER+1,x=>x.extra=true]){
    const copy=structuredClone(s);edit(copy);assert.throws(()=>read(copy),/invalid_retail_package_terms/);
    assert.throws(()=>settings({clientId:'c',planKey:'basic',billingInterval:'prepaid',packageSnapshot:copy}),/invalid_retail_package_terms/);
  }
  assert.equal(settings({clientId:'c',planKey:'pro',billingInterval:'prepaid',packageSnapshot:s}),null);
  assert.equal(settings({clientId:'c',planKey:'basic',billingInterval:'annual',packageSnapshot:s}),null);
});
test('data-only snapshots reject getters/proxies without side effects, secret defaults or client/account authority',()=>{
  const s=structuredClone(fixture());let calls=0;
  Object.defineProperty(s,'membership_terms',{enumerable:true,get(){calls++;throw Error('do not invoke');}});
  assert.throws(()=>read(s),/invalid_retail_package_terms/);assert.equal(calls,0);
  assert.throws(()=>read(new Proxy(fixture(),{get(){calls++;throw Error('do not invoke');}})),/invalid_retail_package_terms/);assert.equal(calls,0);
  assert.doesNotMatch(JSON.stringify(fixture()),/action_link|access_token|user_id|client_id|STRIPE_PRICE_|sk_live|sk_test/);
});
