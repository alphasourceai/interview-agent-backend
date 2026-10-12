'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {quoteEnterprisePoolOffer}=require('../src/services/enterprisePoolOffers');
const {quoteEnterprisePool}=require('../src/services/enterprisePoolPricing');
const {prepareEnterprisePoolTerms:prepare,validateEnterprisePoolSnapshot:validate,enterprisePoolCheckoutQuote:checkout,readEnterprisePoolSnapshot:read}=require('../src/services/enterprisePoolSnapshot');
const fields=['offer_version','currency','quantity','unit_price_cents','gross_cents','automatic_discount_percent','automatic_discount_cents','coupon_cents','net_cents'];
const canonical=s=>JSON.stringify(Object.fromEntries(fields.map(k=>[k,s[k]])));
const digest=s=>crypto.createHash('sha256').update(canonical(s)).digest('hex');
const input={membership_tier:'enterprise',billing_model:'usage',pool_quantity:'51',usage_interview_fee_cents:5};
test('new transport charges net once; legacy half-cent arithmetic is unchanged',()=>{
  const p=prepare(input),s=p.pool_offer_snapshot;assert.equal(s.automatic_discount_percent,10);assert.equal(s.gross_cents,255);
  assert.equal(s.automatic_discount_cents,26);assert.equal(s.net_cents,229);assert.equal(checkout(p).total_cents,229);
  assert.equal(quoteEnterprisePool({quantity:51,unitPriceCents:5,discountPct:10}).total_cents,230);
  const tiny=quoteEnterprisePoolOffer({quantity:5,acceptedUnitPriceCents:1,authorizedAutomaticPercent:10});
  assert.equal(validate(tiny,digest(tiny)).net_cents,4);assert.equal(quoteEnterprisePool({quantity:5,unitPriceCents:1,discountPct:10}).total_cents,5);
});
test('server prepares fixed bands and overwrites browser discount/coupon/version/snapshot claims',()=>{
  for(const [q,pct] of [[1,0],[19,0],[20,5],[29,5],[30,7],[49,7],[50,10],[51,10]]){
    const p=prepare({...input,pool_quantity:q,pool_discount_pct:90,pool_total_cents:1,coupon_cents:999,pool_offer_snapshot:{forged:true},pool_offer_digest:'forged'});
    assert.equal(p.pool_offer_snapshot.automatic_discount_percent,pct);assert.equal(p.pool_offer_snapshot.coupon_cents,0);
    assert.equal(p.pool_offer_digest,digest(p.pool_offer_snapshot));assert.ok(Object.isFrozen(p.pool_offer_snapshot));
  }
});
test('fixed canonical digest survives reordered jsonb-style readback; strings/fractions/extra fields hold',()=>{
  const p=prepare(input),s=p.pool_offer_snapshot,reordered=Object.fromEntries(Object.entries(s).reverse());assert.deepEqual(validate(reordered,p.pool_offer_digest),s);
  assert.equal(p.pool_offer_digest,digest(reordered));
  for(const changed of [{quantity:'51'},{unit_price_cents:5.5},{currency:null},{offer_version:'unknown'},{extra:true},{net_cents:230}])
    assert.throws(()=>validate({...s,...changed},p.pool_offer_digest),e=>e.code==='invalid_enterprise_pool_snapshot');
  assert.throws(()=>read({pool_offer_snapshot:s,pool_offer_digest:null}));assert.throws(()=>read({pool_offer_snapshot:null,pool_offer_digest:p.pool_offer_digest}));
  assert.equal(read({pool_offer_snapshot:null,pool_offer_digest:null}),null);assert.equal(read({}),null);
});
test('nonusage model clears stale pool fields, nonenterprise marked template and mismatched scalar held',()=>{
  const p=prepare(input),cleared=prepare({...p,billing_model:'fixed'});
  assert.equal(cleared.pool_quantity,'');assert.equal(cleared.pool_offer_snapshot,null);assert.equal(cleared.pool_offer_digest,null);assert.equal(cleared.pool_total_cents,null);
  const {normalizeMembershipAgreementInput}=require('../src/render/membershipAgreement');
  assert.throws(()=>normalizeMembershipAgreementInput({...p,membership_tier:'basic'}));assert.throws(()=>normalizeMembershipAgreementInput({...p,billing_model:'fixed'}));
  assert.equal(checkout({...p,pool_discount_pct:'10.00'}).total_cents,229);
  for(const changed of [{pool_discount_pct:'10.50'},{pool_total_cents:230},{pool_quantity:50},{usage_interview_fee_cents:6},{pool_total_cents:null},{pool_discount_pct:''}])assert.throws(()=>checkout({...p,...changed}));
});
test('integer-column bound and nonpositive/invalid unit amounts hold before any provider dependency',()=>{
  for(const changed of [{pool_quantity:2147483647,usage_interview_fee_cents:2},{usage_interview_fee_cents:0},{usage_interview_fee_cents:'invalid'}])assert.throws(()=>prepare({...input,...changed}));
});
test('closed data descriptors reject hidden/getter/symbol/proxy snapshot fields without invoking getters',()=>{
  const p=prepare(input);let invoked=0;const s={...p.pool_offer_snapshot};Object.defineProperty(s,'quantity',{enumerable:true,get(){invoked++;return 51;}});
  assert.throws(()=>validate(s,p.pool_offer_digest));assert.equal(invoked,0);
  assert.throws(()=>validate(new Proxy(p.pool_offer_snapshot,{}),p.pool_offer_digest));
  const hidden={...p.pool_offer_snapshot};Object.defineProperty(hidden,'hidden',{value:1});assert.throws(()=>validate(hidden,p.pool_offer_digest));
});
test('separate coupon math is retained only in explicit server-owned accepted snapshots, not draft request claims',()=>{
  const s=quoteEnterprisePoolOffer({quantity:51,acceptedUnitPriceCents:5,authorizedAutomaticPercent:10,authorizedCouponCents:29});
  assert.equal(validate(s,digest(s)).net_cents,200);assert.equal(prepare({...input,coupon_cents:29}).pool_offer_snapshot.net_cents,229);
});
