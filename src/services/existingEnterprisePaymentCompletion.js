'use strict';
// Complete the existing financial rows, reuse once-billing. The later-platform
// bridge below is UNMOUNTED until its webhook/status integration is reviewed.
// No new Auth/contract/pool ledger, provider writes or messages.
const { isDeepStrictEqual } = require('node:util');
const { applyExistingEnterpriseBilling } = require('./existingEnterpriseBillingAdapter');
const { readExistingEnterpriseCheckoutFunding } = require('./existingEnterpriseCheckoutFunding');
const { verifyEnterpriseBillingReceipt, readVerifiedEnterpriseBillingReceipt, freeze } = require('./existingEnterpriseBillingReceipt');
const { verifyEnterprisePaymentRows } = require('./existingEnterprisePaymentRows');
const { snapshotStripeSdkData } = require('./enterprisePoolPaymentProof');
const { readExistingEnterprisePlatformPeriod } = require('./existingEnterprisePlatformPeriodReader');
const { anchoredMonthInstant } = require('./membershipOffers');
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
const closed = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
function cycleFail() {
  throw Object.assign(new Error('enterprise_platform_period_ack_unknown'), {
    code: 'enterprise_platform_period_ack_unknown', status: 503
  });
}
const cycleCheck = v => { if (!v) cycleFail(); };
const cycleSame = (a, b) => isDeepStrictEqual(snapshotStripeSdkData(a), snapshotStripeSdkData(b));
function nativeStamp(value) {
  cycleCheck(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value));
  const millis = Date.parse(value);
  cycleCheck(Number.isFinite(millis) && new Date(millis).toISOString() === value.replace(/(\.\d{3})\d{3}Z$/, '$1Z'));
  return BigInt(millis) * 1000n + BigInt(value.slice(-4, -1));
}
// Existing paid-cycle path only. Re-read actual provider cash; the native writer
// owns receipt persistence and idempotency. No original activation/account tail,
// generic billing sync, collection, renewal preference or commission effect.
async function completeExistingEnterprisePlatformPeriod(input) {
  try {
    // The reader validates exactly five own data arguments; there is no caller
    // clock, event proof, source receipt or paid/access boolean to trust.
    const current = await readExistingEnterprisePlatformPeriod(input);
    const { db, agreementId, clientId, invoiceId } = input;
    const a = current.source.agreement;
    const result = await db.rpc('read_enterprise_existing_billing', { p_agreement: agreementId });
    cycleCheck(result && !result.error && result.data);
    const source = verifyEnterpriseBillingReceipt(result.data, { source: a.enterprise_checkout_source,
      prices: a.enterprise_checkout_prices, fundingReceipt: a.enterprise_funding_receipt });
    cycleCheck(cycleSame(source, a.enterprise_billing_receipt));
    const saved = await db.rpc('record_enterprise_existing_paid_period', {
      p_agreement: agreementId, p_client: clientId, p_billing: source, p_proof: current.proof
    });
    cycleCheck(saved && !saved.error && closed(saved.data, ['status', 'invoice_id', 'receipt'])
      && ['recorded', 'already_recorded'].includes(saved.data.status) && uuid(saved.data.invoice_id));
    const receipt = snapshotStripeSdkData(saved.data.receipt);
    cycleCheck(closed(receipt, ['version', 'source', 'source_digest', 'proof', 'recorded_at'])
      && receipt.version === 'enterprise_existing_paid_period_receipt_v1'
      && cycleSame(receipt.source, source) && cycleSame(receipt.proof, current.proof)
      && /^[0-9a-f]{32}$/.test(receipt.source_digest)
      && nativeStamp(receipt.recorded_at) >= BigInt(Date.parse(current.proof.paid_at)) * 1000n);
    const row = await db.from('billing_invoices').select('*').eq('id', saved.data.invoice_id).maybeSingle();
    cycleCheck(row && !row.error && row.data?.id === saved.data.invoice_id
      && row.data.stripe_invoice_id === invoiceId && row.data.billing_customer_id === current.source.owner.id
      && row.data.currency === 'usd' && row.data.amount_total_cents === current.proof.cash_cents
      && row.data.retail_period_receipt == null && cycleSame(row.data.enterprise_period_receipt, receipt));
    const refresh = await db.rpc('refresh_enterprise_existing_paid_coverage', { p_agreement: agreementId, p_client: clientId });
    cycleCheck(refresh && !refresh.error);
    const coverage = snapshotStripeSdkData(refresh.data), status = coverage?.status;
    cycleCheck(['refreshed', 'manual_override'].includes(status) && closed(coverage, [
      'version', 'agreement_id', 'client_id', 'billing_source_digest', 'contiguous_ordinal', 'funded_from',
      'funded_through', 'observed_at', 'provider_effect_authorized', 'paid_access_authorized', 'payroll_authorized',
      'status', status === 'manual_override' ? 'computed_billing_status' : 'billing_status'
    ]) && coverage.version === 'enterprise_existing_paid_coverage_v1'
      && coverage.agreement_id === agreementId && coverage.client_id === clientId
      && coverage.billing_source_digest === receipt.source_digest
      && Number.isSafeInteger(coverage.contiguous_ordinal) && coverage.contiguous_ordinal >= 0 && coverage.contiguous_ordinal <= 999
      && ['active', 'inactive'].includes(status === 'manual_override' ? coverage.computed_billing_status : coverage.billing_status)
      && coverage.provider_effect_authorized === false && coverage.paid_access_authorized === false && coverage.payroll_authorized === false
      && nativeStamp(coverage.observed_at) >= nativeStamp(receipt.recorded_at)
      && nativeStamp(coverage.funded_from) === BigInt(Date.parse(source.funding_receipt.proof.payment_success_at)) * 1000n);
    const span = source.funding_receipt.proof.platform_interval === 'year' ? 12 : 1;
    const expectedEnd = anchoredMonthInstant(new Date(source.subscription.current_period_end * 1000).toISOString(), coverage.contiguous_ordinal * span);
    cycleCheck(nativeStamp(coverage.funded_through) === BigInt(Date.parse(expectedEnd)) * 1000n);
    // This may succeed after an earlier lost response. Native replay is exact,
    // and coverage refresh still runs; a processed event is not funding proof.
    return freeze({ status: saved.data.status, invoiceId: saved.data.invoice_id, receipt, coverage });
  } catch (_) { cycleFail(); }
}
module.exports = { completeExistingEnterprisePayment, completeExistingEnterprisePlatformPeriod };
