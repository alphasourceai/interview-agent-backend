'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildMembershipAgreementHtml}=require('../src/render/membershipAgreement');
const {buildRetailPackageSnapshot}=require('../src/services/membershipPackageCompatibility');
const {OFFER_VERSION}=require('../src/services/membershipOffers');
test('prospective prepaid terms remove redundant length bullet and define cancellation/refund exceptions',()=>{
 for(const months of [3,6,12]){
  const packageSnapshot=buildRetailPackageSnapshot({planKey:'basic',channel:'public',commitmentMonths:months,paymentOption:'prepaid',offerVersion:OFFER_VERSION});
  const {html,normalized}=buildMembershipAgreementHtml({client_legal_name:'Synthetic',primary_admin_name:'Synthetic',admin_email:'buyer@example.invalid'},
    {packageSnapshot,execution:{signed_at:'2026-10-13T12:00:00.000Z',signer_typed_name:'Synthetic',accepted:true}});
  assert.doesNotMatch(html,/Client acknowledges this is a 12-month Membership term/);
  assert.doesNotMatch(html,/Client acknowledges an initial term of/);
  assert.match(html,new RegExp(`initial term of ${months} calendar months`));
  assert.match(html,new RegExp(`full ${months}-month prepaid term`));
  assert.match(html,/cancellation means turning off automatic renewal, not ending the current term/);
  assert.match(html,/except under the applicable refund policy/);
  assert.equal(normalized.initial_term_start,'');assert.equal(normalized.initial_renewal_date,'');
  assert.match(html,/signature or agreement preparation date does not start the term/);
  assert.match(html,/Signed on October 13, 2026/);
 }
});
test('historical legacy commercial wording is unchanged, not silently rewritten by the prospective copy',()=>{
 const {html}=buildMembershipAgreementHtml({membership_tier:'enterprise',initial_term_start:'2026-10-13',initial_renewal_date:'2027-10-13',billing_option:'monthly',auto_renew:true});
 assert.match(html,/Client acknowledges this is a 12-month Membership term/);
 assert.match(html,/monthly billing is an installment option for the 12-month term/);
});
