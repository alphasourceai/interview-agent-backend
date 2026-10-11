'use strict';
const assert=require('node:assert/strict');const {test}=require('node:test');
const {calculateReceiptCommission}=require('../src/services/salesCommissionPolicy');
const {anchoredMonthInstant}=require('../src/services/membershipOffers');
const rep='10000000-0000-4000-8000-000000000001';
function receipt(months=3,change={}) {
  const original='2026-01-31T12:13:14.000Z';
  return {membership_terms_protocol:'retail_terms_v2',currency:'usd',payment_kind:'monthly',payment_succeeded:true,
    gross_membership_cents:44900,discount_cents:0,provider_fee_cents:1347,
    original_membership_start_at:original,original_commitment_months:months,
    original_salesperson_user_id:rep,sales_rep_user_id:rep,
    original_qualification_closed_at:'2026-01-31T12:14:00Z',original_qualification_verified:true,
    qualification_closed_at:'2030-01-01T00:00:00Z',qualification_verified:false,
    first_term_start_at:original,first_term_end_at:anchoredMonthInstant(original,months),
    payment_success_at:'2026-10-31T12:13:14Z',funds_received_at:'2026-11-02T00:00:00Z',...change};
}
for(const months of [3,6])test(`${months}-month renewal receipt earns commission within original year, using original qualification`,()=>{
  const result=calculateReceiptCommission(receipt(months));
  assert.equal(result.status,'payable');assert.equal(result.net_membership_cents,43553);
  assert.equal(result.commission_cents,21777);
});
test('one year is half-open; payment at original anniversary is not commissionable for any term',()=>{
  for(const months of [3,6,12]) {
    const before=calculateReceiptCommission(receipt(months,{payment_success_at:'2027-01-31T12:13:13Z',funds_received_at:'2027-02-01T00:00:00Z'}));
    assert.equal(before.status,'payable');
    const at=calculateReceiptCommission(receipt(months,{payment_success_at:'2027-01-31T12:13:14Z',funds_received_at:'2027-02-01T00:00:00Z'}));
    assert.equal(at.reason,'outside_original_first_year');assert.equal(at.commission_cents,0);
  }
});
test('12-month renewal is outside original year and does not restart the rep commission window',()=>{
  const result=calculateReceiptCommission(receipt(12,{payment_success_at:'2027-01-31T12:13:14Z',funds_received_at:'2027-02-01T00:00:00Z'}));
  assert.equal(result.status,'ineligible');assert.equal(result.reason,'outside_original_first_year');
});
test('leap-day first-year window clamps once from original UTC anchor',()=>{
  const original='2024-02-29T12:13:14.000Z';
  const base=receipt(6,{original_membership_start_at:original,first_term_start_at:original,
    first_term_end_at:anchoredMonthInstant(original,6),original_qualification_closed_at:'2024-02-29T12:14:00Z',
    payment_success_at:'2025-02-28T12:13:13Z',funds_received_at:'2025-03-01T00:00:00Z'});
  assert.equal(calculateReceiptCommission(base).status,'payable');
  assert.equal(calculateReceiptCommission({...base,payment_success_at:'2025-02-28T12:13:14Z'}).reason,'outside_original_first_year');
});
test('pending receipts earn nothing; settlement later than anniversary does not re-date a valid payment',()=>{
  assert.equal(calculateReceiptCommission(receipt(3,{funds_received_at:null})).status,'awaiting_funds');
  const settled=calculateReceiptCommission(receipt(3,{payment_success_at:'2027-01-31T12:13:13Z',funds_received_at:'2027-02-08T19:00:00Z'}));
  assert.equal(settled.status,'payable');assert.equal(settled.statement_week.date_from,'2027-02-08');
  assert.equal(calculateReceiptCommission(receipt(3,{payment_succeeded:false})).reason,'payment_not_successful');
});
test('no future annualization; each prepaid renewal earns only its actual net receipt',()=>{
  const result=calculateReceiptCommission(receipt(3,{payment_kind:'paid_in_full',gross_membership_cents:120000,provider_fee_cents:3600}));
  assert.equal(result.commission_cents,58200);assert.equal(result.net_membership_cents,116400);
});
test('renewal qualification cannot overwrite an unverified original sale or change salesperson',()=>{
  assert.equal(calculateReceiptCommission(receipt(3,{original_qualification_verified:false,qualification_verified:true})).reason,'sale_not_verified');
  assert.throws(()=>calculateReceiptCommission(receipt(3,{sales_rep_user_id:'10000000-0000-4000-8000-000000000002'})),/original_salesperson_mismatch/);
  assert.equal(calculateReceiptCommission(receipt(3,{original_qualification_closed_at:'2026-10-31T12:13:14Z'})).reason,'outside_original_first_year');
});
test('missing original metadata, unsupported protocol and forged later term cannot reset eligibility',()=>{
  for(const change of [{original_commitment_months:9},{original_membership_start_at:null},
    {original_salesperson_user_id:null},{original_qualification_closed_at:null},
    {membership_terms_protocol:'retail_terms_v3'},{first_term_start_at:'2026-10-31T12:13:14Z'},
    {first_term_end_at:'2027-01-31T12:13:14Z'}]) {
    assert.throws(()=>calculateReceiptCommission(receipt(3,change)));
  }
  assert.equal(calculateReceiptCommission(receipt(3,{payment_success_at:'2026-01-31T12:13:13Z',funds_received_at:'2026-02-01T00:00:00Z'})).reason,'outside_original_first_year');
});
test('existing departure cutoff still applies to renewal payment, not delayed settlement',()=>{
  assert.equal(calculateReceiptCommission(receipt(3,{rep_final_day:'2026-09-01'})).reason,'after_departure_window');
  assert.equal(calculateReceiptCommission(receipt(3,{rep_final_day:'2026-10-01',
    payment_success_at:'2026-10-31T12:13:14Z',funds_received_at:'2026-11-05T00:00:00Z'})).status,'payable');
});
test('legacy callers retain first-term cutoff and prior qualification fields exactly',()=>{
  const legacy=receipt();delete legacy.membership_terms_protocol;
  legacy.qualification_closed_at='2026-01-31T12:14:00Z';legacy.qualification_verified=true;
  assert.equal(calculateReceiptCommission(legacy).reason,'outside_first_term');
  assert.equal(calculateReceiptCommission({...legacy,payment_success_at:'2026-02-28T12:13:14Z',funds_received_at:'2026-03-01T00:00:00Z'}).status,'payable');
});
