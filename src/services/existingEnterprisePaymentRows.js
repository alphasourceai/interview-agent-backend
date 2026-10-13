'use strict';
// Financial row readback only; not client access, allocation, Auth or delivery.
const { isDeepStrictEqual } = require('node:util');
const { verifyEnterpriseBillingReceipt } = require('./existingEnterpriseBillingReceipt');
const { snapshotStripeSdkData } = require('./enterprisePoolPaymentProof');
function fail() { const e = new Error('enterprise_payment_rows_unverified'); e.code = e.message; e.status = 503; throw e; }
function exactPaymentTime(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  // PostgreSQL may serialize 0..6 fractional digits and an offset. Do not
  // discard sub-millisecond differences while comparing the original cash A.
  const fraction = value.match(/T\d{2}:\d{2}:\d{2}(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:\d{2})$/);
  return Boolean(fraction && !/[1-9]/.test((fraction[1] || '').padEnd(6, '0').slice(3))
    && Number.isFinite(Date.parse(value)) && Date.parse(value) === Date.parse(expected));
}
function verifyEnterprisePaymentRows({ agreement: a, pool: p, billingReceipt }) {
  try {
    const w = verifyEnterpriseBillingReceipt(billingReceipt, { source: a.enterprise_checkout_source,
      prices: a.enterprise_checkout_prices, fundingReceipt: a.enterprise_funding_receipt });
    const proof = w.funding_receipt.proof;
    if (!isDeepStrictEqual(w, snapshotStripeSdkData(a.enterprise_billing_receipt)) || proof.client_id !== a.client_id
      || proof.pool_id !== p.id || a.enterprise_checkout_pool_id !== p.id || p.agreement_id !== a.id
      || p.client_id !== a.client_id || a.checkout_session_id !== proof.checkout_session_id
      || p.stripe_checkout_session_id !== proof.checkout_session_id || a.checkout_status !== 'paid'
      || p.status !== 'paid' || p.stripe_payment_intent_id !== proof.payment_intent_id
      || !exactPaymentTime(a.checkout_paid_at, proof.payment_success_at)
      || !exactPaymentTime(p.paid_at, proof.payment_success_at)
      || !isDeepStrictEqual(p.offer_snapshot, a.template_snapshot.values.pool_offer_snapshot)
      || p.offer_digest !== a.template_snapshot.values.pool_offer_digest) fail();
    return w;
  } catch (_) { fail(); }
}
module.exports = { exactPaymentTime, verifyEnterprisePaymentRows };
