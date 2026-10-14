'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');
const {buildRetailPackageSnapshot}=require('../src/services/membershipPackageCompatibility');
const {OFFER_VERSION,STRIPE_RECURRING_OFFER_VERSION}=require('../src/services/membershipOffers');
const {buildMembershipAgreementHtml}=require('../src/render/membershipAgreement');
for(const months of [3,6,12])for(const payment of ['prepaid','monthly_installments'])
test(`saved ${months}/${payment} selects prospective native billing body; older body remains unchanged`,()=>{
  const pkg=version=>buildRetailPackageSnapshot({planKey:'basic',commitmentMonths:months,paymentOption:payment,offerVersion:version,channel:'sales'});
  const render=version=>buildMembershipAgreementHtml({client_legal_name:'Synthetic',membership_tier:'basic',billing_option:payment==='prepaid'?'prepaid':'monthly'},
    {packageSnapshot:pkg(version),generatedAt:'2026-10-14T00:00:00.000Z'}).html;
  const old=render(OFFER_VERSION),current=render(STRIPE_RECURRING_OFFER_VERSION);
  assert.ok(old.includes('Turn off any time before term end'));assert.ok(!old.includes("Stripe's existing billing schedule"));
  assert.ok(current.includes("Stripe's existing billing schedule"));assert.ok(current.includes('actual successful initial payment date'));
  assert.ok(current.includes('Stripe renewal billing date shown in the account'));assert.ok(!current.includes('Turn off any time before term end'));
  assert.ok(current.includes(`${months}-month`));assert.ok(!current.includes('All Memberships are 12 months'));
  assert.ok(current.includes(payment==='prepaid'?'access remains available for the full':'remaining installment payments'));
});
