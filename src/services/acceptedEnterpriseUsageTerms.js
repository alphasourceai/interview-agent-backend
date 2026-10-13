'use strict';

// Read-only boundary for prospective existing-agreement Enterprise Usage.
// Null is a successfully resolved, completely scanned, unmarked legacy owner.
// A marked source is never handed to the legacy invoice writers.
const { resolveBillingOwnerForScope } = require('./clientBillingScope');
const { readVerifiedEnterpriseBillingReceipt } = require('./existingEnterpriseBillingReceipt');
const MARKERS = ['enterprise_checkout_source', 'enterprise_checkout_pool_id', 'enterprise_checkout_prices',
  'enterprise_funding_receipt', 'enterprise_billing_receipt'];
function hold(reason = 'enterprise_usage_terms_unavailable') {
  const error = new Error(reason); error.code = reason; error.status = 503; throw error;
}
async function loadAcceptedEnterpriseUsageTerms({ db, clientId } = {}) {
  try {
    const scope = await resolveBillingOwnerForScope(db, clientId);
    if (!scope.ok || !scope.billingClientId || !scope.billingClient) hold();
    const owner = scope.billingClient;
    // Exact count proves the returned rows are the complete owner census;
    // truncated responses hold instead of hiding a pending/noncurrent marker.
    const select = ['id','client_id','is_current','status','membership_tier','signed_at','checkout_status','checkout_paid_at',...MARKERS].join(',');
    const scan = await db.from('membership_agreements').select(select, { count: 'exact' }).eq('client_id', scope.billingClientId);
    if (scan.error || !Array.isArray(scan.data) || !Number.isSafeInteger(scan.count)
      || scan.count !== scan.data.length || scan.count < 0) hold();
    const rows = scan.data;
    if (rows.some(a => !a || a.client_id !== scope.billingClientId || !a.id)
      || new Set(rows.map(a => a.id)).size !== rows.length) hold();
    const marked = rows.filter(a => MARKERS.some(k => a[k] != null));
    if (!marked.length) return null;
    if (marked.length !== 1 || rows.filter(a => a.is_current === true).length !== 1) hold();
    const a = marked[0];
    if (a.is_current !== true || a.status !== 'signed' || a.membership_tier !== 'enterprise'
      || a.checkout_status !== 'paid' || !a.signed_at || !a.checkout_paid_at
      || MARKERS.some(k => a[k] == null)) hold();
    const receipt = await readVerifiedEnterpriseBillingReceipt({ db, agreement: a });
    if (!receipt || receipt.client_initial.stripe_customer_id !== owner.stripe_customer_id
      || receipt.client_initial.stripe_subscription_id !== owner.stripe_subscription_id
      || receipt.funding_receipt.proof.client_id !== scope.billingClientId
      || a.enterprise_checkout_pool_id !== receipt.funding_receipt.proof.pool_id
      || receipt.funding_receipt.proof.currency !== 'usd') hold();
    const unit = receipt.plan_initial.usage_interview_fee_cents;
    const start = Date.parse(receipt.client_initial.contract_start_at), end = Date.parse(receipt.client_initial.contract_end_at);
    if (!Number.isSafeInteger(unit) || unit <= 0 || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) hold();
    return Object.freeze({ billingClientId: scope.billingClientId, agreementId: a.id,
      unitPriceCents: unit, start, end, poolId: receipt.funding_receipt.proof.pool_id });
  } catch (error) {
    // No read failure becomes a zero amount or a legacy source.
    if (error?.status === 503) throw error;
    hold();
  }
}
async function fenceAcceptedEnterpriseUsageWriter({ db, clientId }) {
  if (await loadAcceptedEnterpriseUsageTerms({ db, clientId }) !== null) hold('enterprise_usage_invoice_executor_pending');
}
module.exports = { loadAcceptedEnterpriseUsageTerms, fenceAcceptedEnterpriseUsageWriter, hold };
