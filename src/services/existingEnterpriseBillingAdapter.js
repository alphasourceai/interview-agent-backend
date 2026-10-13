'use strict';
// UNMOUNTED: trusted fresh SDK -> once client/plan billing only.
// No paid pool/agreement, Auth, communications, provider writes or access claim.
const { isDeepStrictEqual } = require('node:util');
const { readExistingEnterpriseCheckoutFunding } = require('./existingEnterpriseCheckoutFunding');
const { recordExistingEnterpriseFunding } = require('./existingEnterpriseFundingReceipt');
const { snapshotStripeSdkData } = require('./enterprisePoolPaymentProof');
const { verifyEnterpriseBillingReceipt, readVerifiedEnterpriseBillingReceipt, freeze } = require('./existingEnterpriseBillingReceipt');
const PROOF_KEYS = require('./enterpriseExistingFundingKeys');
function fail() { const e = new Error('enterprise_billing_ack_unknown'); e.code = e.message; e.status = 503; throw e; }
const proofOf = funding => Object.fromEntries(PROOF_KEYS.map(key => [key, funding[key]]));
async function applyExistingEnterpriseBilling({ db, stripe, agreementId, eventSessionId, eventSubscriptionId, eventInvoiceId,
  eventLivemode, assertFence = async () => {}, now = Date.now }) {
  const args = { db, stripe, agreementId, eventSessionId, eventSubscriptionId, eventInvoiceId, eventLivemode, assertFence, now };
  let funding = await readExistingEnterpriseCheckoutFunding(args);
  if (!funding) return null;
  const initialProof = snapshotStripeSdkData(proofOf(funding));
  let receipt, subscription;
  if (funding.sourceBillingReceipt) {
    receipt = funding.sourceFundingReceipt;
    if (!isDeepStrictEqual(initialProof, snapshotStripeSdkData(receipt?.proof))) fail();
    // This is the immutable INITIAL provider projection, not live provider state.
    subscription = funding.sourceBillingReceipt.subscription;
  } else {
    const recorded = await recordExistingEnterpriseFunding(args);
    if (!recorded || !isDeepStrictEqual(initialProof, snapshotStripeSdkData(proofOf(recorded.funding)))) fail();
    funding = recorded.funding; receipt = recorded.receipt;
    const current = snapshotStripeSdkData(funding.subscription);
    subscription = { id: current.id, customer: typeof current.customer === 'string' ? current.customer : current.customer?.id,
      status: current.status, current_period_end: current.current_period_end, cancel_at_period_end: current.cancel_at_period_end };
  }
  await assertFence();
  let result;
  try {
    result = await db.rpc('apply_enterprise_existing_billing', { p_agreement: funding.agreementId, p_client: funding.client_id,
      p_source: funding.sourceCheckout, p_prices: funding.sourcePrices, p_funding: receipt, p_subscription: subscription });
  } catch (_) { fail(); }
  if (!result || result.error || !result.data) fail();
  let billingReceipt;
  try {
    billingReceipt = verifyEnterpriseBillingReceipt(result.data, { source: funding.sourceCheckout, prices: funding.sourcePrices,
      fundingReceipt: receipt, expectedSubscription: subscription });
    await assertFence();
    const saved = await db.from('membership_agreements').select('*').eq('id', funding.agreementId).maybeSingle();
    if (!saved || saved.error || saved.data?.client_id !== funding.client_id
      || !isDeepStrictEqual(saved.data.enterprise_checkout_source, funding.sourceCheckout)
      || !isDeepStrictEqual(saved.data.enterprise_checkout_prices, funding.sourcePrices)) fail();
    const verified = await readVerifiedEnterpriseBillingReceipt({ db, agreement: saved.data });
    if (!isDeepStrictEqual(verified, billingReceipt)) fail();
  } catch (_) { fail(); }
  await assertFence();
  return freeze({ billingReceipt, funding, billing_applied: true, credits_spendable: false,
    membership_activation_required: true, native_receipt_required: true });
}
module.exports = { applyExistingEnterpriseBilling };
