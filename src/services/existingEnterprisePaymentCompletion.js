'use strict';
// UNMOUNTED: complete the existing financial rows, reuse once-billing. No new
// Auth/contract/pool ledger, provider writes, messages or global access claim.
const { isDeepStrictEqual } = require('node:util');
const { applyExistingEnterpriseBilling } = require('./existingEnterpriseBillingAdapter');
const { readExistingEnterpriseCheckoutFunding } = require('./existingEnterpriseCheckoutFunding');
const { verifyEnterpriseBillingReceipt, readVerifiedEnterpriseBillingReceipt, freeze } = require('./existingEnterpriseBillingReceipt');
const { verifyEnterprisePaymentRows } = require('./existingEnterprisePaymentRows');
const { snapshotStripeSdkData } = require('./enterprisePoolPaymentProof');
const PROOF_KEYS = require('./enterpriseExistingFundingKeys');
function fail() { const e = new Error('enterprise_payment_ack_unknown'); e.code = e.message; e.status = 503; throw e; }
function retryable(error) {
  if (error?.code === 'activation_fence_lost') throw error;
  const e = new Error(error?.message || 'enterprise_payment_funding_unverified');
  e.code = error?.code || 'enterprise_payment_funding_unverified'; e.status = 503; throw e;
}
async function completeExistingEnterprisePayment({ db, stripe, agreementId, eventSessionId, eventSubscriptionId,
  eventInvoiceId, eventLivemode, assertFence = async () => {}, now = Date.now }) {
  const args = { db, stripe, agreementId, eventSessionId, eventSubscriptionId, eventInvoiceId, eventLivemode, assertFence, now };
  let billing;
  try { billing = await applyExistingEnterpriseBilling(args); } catch (error) { retryable(error); }
  if (!billing) return null;
  // Revalidate the provider graph after billing, not a caller-supplied boolean
  // or stale webhook object. Both event orders must prove the same original A.
  let funding;
  try { funding = await readExistingEnterpriseCheckoutFunding(args); } catch (error) { retryable(error); }
  if (!funding) fail();
  const proof = snapshotStripeSdkData(Object.fromEntries(PROOF_KEYS.map(key => [key, funding?.[key]])));
  if (!isDeepStrictEqual(proof, billing.billingReceipt.funding_receipt.proof)
    || !isDeepStrictEqual(funding.sourceBillingReceipt, billing.billingReceipt)) fail();
  await assertFence();
  let result;
  try { result = await db.rpc('complete_enterprise_existing_payment', { p_agreement: funding.agreementId,
    p_client: funding.client_id, p_billing: billing.billingReceipt }); } catch (_) { fail(); }
  if (!result || result.error || !result.data) fail();
  try {
    const ack = verifyEnterpriseBillingReceipt(result.data, { source: funding.sourceCheckout, prices: funding.sourcePrices,
      fundingReceipt: funding.sourceFundingReceipt });
    if (!isDeepStrictEqual(ack, billing.billingReceipt)) fail();
    await assertFence();
    const saved = await db.from('membership_agreements').select('*').eq('id', funding.agreementId).maybeSingle();
    const pool = await db.from('client_interview_pools').select('*').eq('id', funding.pool_id).maybeSingle();
    if (!saved || saved.error || !pool || pool.error || !saved.data || !pool.data) fail();
    const readback = await readVerifiedEnterpriseBillingReceipt({ db, agreement: saved.data });
    if (!isDeepStrictEqual(readback, ack)) fail();
    verifyEnterprisePaymentRows({ agreement: saved.data, pool: pool.data, billingReceipt: readback });
  } catch (_) { fail(); }
  await assertFence();
  return freeze({ billingReceipt: billing.billingReceipt, funding, paid_pool_recorded: true,
    agreement_payment_recorded: true, membership_activation_required: true, native_receipt_required: true });
}
module.exports = { completeExistingEnterprisePayment };
