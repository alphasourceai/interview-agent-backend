'use strict';
// Pure policy arithmetic only. Native original attribution/payment admission
// and admin settlement evidence are separate gates; this does not grant cash.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {calculateReceiptCommission:calculate}=require('../src/services/salesCommissionPolicy');
const {anchoredMonthInstant}=require('../src/services/membershipOffers');
const rep='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const a='2026-01-31T12:13:14.000Z',e='2026-06-19T00:00:00.000Z';
const receipt=(patch={})=>({membership_terms_protocol:'enterprise_existing_terms_v1',currency:'usd',payment_kind:'monthly',
 payment_succeeded:true,gross_membership_cents:33333,discount_cents:333,provider_fee_cents:1001,
 original_membership_start_at:a,original_term_end_at:e,original_salesperson_user_id:rep,sales_rep_user_id:rep,
 original_qualification_closed_at:a,original_qualification_verified:true,qualification_closed_at:'2030-01-01Z',qualification_verified:false,
 first_term_start_at:a,first_term_end_at:e,payment_success_at:'2026-10-31T12:13:14Z',funds_received_at:'2026-11-02T00:00:00Z',...patch});
for(const kind of ['monthly','paid_in_full'])test(`Enterprise ${kind} uses actual net platform payment after custom first term within ORIGINAL cash year`,()=>{
 const r=calculate(receipt({payment_kind:kind}));assert.equal(r.status,'payable');assert.equal(r.net_membership_cents,31999);
 assert.equal(r.commission_cents,16000);assert.equal(r.statement_week.date_from,'2026-10-26'); // UTC midnight is Sunday in Denver.
});
test('Enterprise first-year cutoff is half-open and does not become current legal E',()=>{
 assert.equal(calculate(receipt({payment_success_at:'2027-01-31T12:13:13Z',funds_received_at:'2027-02-05T00:00:00Z'})).status,'payable');
 for(const time of ['2027-01-31T12:13:14Z','2026-01-31T12:13:13Z'])assert.equal(calculate(receipt({payment_success_at:time,
  funds_received_at:'2027-02-05T00:00:00Z'})).reason,'outside_original_first_year');
 for(const patch of [{original_term_end_at:'2027-06-19T00:00:00Z'},{first_term_end_at:'2027-06-19T00:00:00Z'},
  {first_term_start_at:'2026-02-19T00:00:00Z'},{original_commitment_months:6},
  {original_qualification_closed_at:'2026-02-01T00:00:00Z'}])assert.throws(()=>calculate(receipt(patch)),/original_membership_term_mismatch/);
});
test('Enterprise initial prorated platform and later annual platform are not annualized or pool/tax amounts',()=>{
 const initial=calculate(receipt({payment_success_at:a,funds_received_at:a,gross_membership_cents:12345,discount_cents:0,provider_fee_cents:345}));
 assert.equal(initial.commission_cents,6000);
 const annual=calculate(receipt({payment_kind:'paid_in_full',gross_membership_cents:110003,discount_cents:2000,provider_fee_cents:3000}));
 assert.equal(annual.net_membership_cents,105003);assert.equal(annual.commission_cents,52502);
});
test('Enterprise leap day uses original UTC twelve-month anchor, with settlement on actual received week',()=>{
 const original='2024-02-29T12:13:14.000Z',end=anchoredMonthInstant(original,12);
 const x=receipt({original_membership_start_at:original,first_term_start_at:original,original_qualification_closed_at:original,
  original_term_end_at:end,first_term_end_at:end,payment_success_at:'2025-02-28T12:13:13Z',funds_received_at:'2025-03-10T00:00:00Z'});
 assert.equal(calculate(x).status,'payable');assert.equal(calculate(x).statement_week.date_from,'2025-03-03');
 assert.equal(calculate({...x,payment_success_at:end}).reason,'outside_original_first_year');
});
test('Enterprise requires frozen original rep/qualification, actual funds, original E and supported source',()=>{
 assert.throws(()=>calculate(receipt({sales_rep_user_id:other})),/original_salesperson_mismatch/);
 assert.equal(calculate(receipt({original_qualification_verified:false,qualification_verified:true})).reason,'sale_not_verified');
 assert.equal(calculate(receipt({funds_received_at:null})).status,'awaiting_funds');
 assert.equal(calculate(receipt({payment_succeeded:false})).reason,'payment_not_successful');
 for(const patch of [{original_membership_start_at:null},{original_term_end_at:null},{original_salesperson_user_id:null},
  {original_qualification_closed_at:null},{original_term_end_at:a,first_term_end_at:a},
  {membership_terms_protocol:'enterprise_existing_terms_v2'},{payment_kind:'financed_checkout'}])assert.throws(()=>calculate(receipt(patch)));
 assert.equal(calculate(receipt({rep_final_day:'2026-09-01'})).reason,'after_departure_window');
 assert.equal(calculate(receipt({rep_final_day:'2026-10-01'})).status,'payable');
});
