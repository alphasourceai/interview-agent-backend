'use strict';
// LOCAL candidate wired only into the existing manual receipt action. Requires
// the offer-scoped native INSERT guard; no settlement, payroll or access grant.
const { isDeepStrictEqual } = require('node:util');
const { snapshotStripeSdkData: snapshot } = require('./enterprisePoolPaymentProof');
const { readRetailPackageOffer } = require('./membershipPackageCompatibility');
const { STRIPE_RECURRING_OFFER_VERSION } = require('./membershipOffers');
function fail(code = 'native_commission_proof_unavailable', status = 409) {
  throw Object.assign(new Error(code), { code, status });
}
const check = value => { if (!value) fail(); };
const id = value => typeof value === 'string' && /^(?:in|pi|ch)_[A-Za-z0-9_]+$/.test(value) && value.length <= 200;
const cents = value => Number.isSafeInteger(value) && value >= 0;
function canonicalExistingRetailCommissionPayment(input) {
  let data; try { data = snapshot(input); } catch (_) { fail(); }
  const { source, initialReceipt, periodRows, paymentId } = data;
  const offer = readRetailPackageOffer(source?.package_snapshot), b = source?.original_period;
  check(offer?.offer_version === STRIPE_RECURRING_OFFER_VERSION && id(paymentId)
    && Array.isArray(periodRows) && periodRows.length <= 1000
    && initialReceipt?.version === 'retail_existing_funding_v1'
    && isDeepStrictEqual(initialReceipt.proof?.period, b)
    && initialReceipt.proof.provider_account_id === source.original_provider_account_id);
  const original = initialReceipt.proof;
  const candidates = [{ ordinal: 0, invoice_id: b.invoice_id, payment_intent_id: original.payment_intent_id,
    charge_id: original.charge_id, paid_at: b.paid_at, platform_gross_cents: original.platform_gross_cents,
    platform_discount_cents: original.platform_discount_cents }];
  const rows = new Set();
  for (const row of periodRows) {
    check(row && typeof row.id === 'string' && !rows.has(row.id)); rows.add(row.id);
    if (row.retail_period_receipt === null) continue; // Not another native proof.
    const receipt = row.retail_period_receipt, p = receipt?.proof;
    check(receipt?.version === 'retail_existing_paid_period_receipt_v1' && p
      && isDeepStrictEqual(receipt.source, source) && p.agreement_id === source.agreement_id && p.client_id === source.client_id
      && p.offer_version === offer.offer_version && p.provider_account_id === source.original_provider_account_id
      && p.livemode === b.livemode && p.customer_id === b.customer_id && p.subscription_id === b.subscription_id
      && p.price_id === b.price_id && p.subscription_item_id === b.subscription_item_id
      && row.stripe_invoice_id === p.invoice_id && Number.isSafeInteger(p.ordinal) && p.ordinal > 0);
    candidates.push(p);
  }
  const matching = candidates.filter(p => [p.invoice_id, p.payment_intent_id, p.charge_id].includes(paymentId));
  check(matching.length === 1);
  const p = matching[0];
  check(id(p.invoice_id) && p.invoice_id.startsWith('in_') && cents(p.platform_gross_cents)
    && p.platform_gross_cents === offer.platform_payment_cents && cents(p.platform_discount_cents)
    && p.platform_discount_cents <= p.platform_gross_cents && typeof p.paid_at === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(p.paid_at) && Number.isFinite(Date.parse(p.paid_at)));
  // These local candidates cannot claim global identity uniqueness. The native
  // INSERT guard must perform that census atomically before accepting a receipt.
  for (const field of ['invoice_id','payment_intent_id','charge_id']) if (p[field] != null)
    check(candidates.filter(candidate => candidate[field] === p[field]).length === 1);
  if (p.ordinal * offer.stripe_recurrence.interval_count >= 12) fail('outside_original_first_year', 422);
  return { provider_payment_id: p.invoice_id, gross_membership_cents: p.platform_gross_cents,
    discount_cents: p.platform_discount_cents, payment_success_at: p.paid_at,
    ordinal: p.ordinal, settlement_verified: false, payroll_authorized: false };
}
function assertCommissionPaymentInput(proof, { gross, discount, paymentAt }) {
  if (proof.gross_membership_cents !== gross || proof.discount_cents !== discount
    || !Number.isFinite(Date.parse(paymentAt)) || Date.parse(proof.payment_success_at) !== Date.parse(paymentAt))
    fail('native_commission_proof_conflict', 422);
  return proof;
}
async function loadExistingRetailCommissionPayment(db, intent, paymentId) {
  check(id(paymentId)); // Also bounds the PostgREST expression below.
  let read;
  try { read = await db.rpc('read_retail_existing_recurring_source', { p_agreement: intent.agreement_id, p_client: intent.client_id }); }
  catch (_) { fail('native_commission_read_failed', 503); }
  if (read?.error) {
    if (read.error.code === 'P0001' && /^retail_recurring_source_(?!schema_|prerequisite_|trigger_|server_)/.test(read.error.message || '')) fail();
    fail('native_commission_read_failed', 503);
  }
  const source = read?.data;
  check(source?.version === 'retail_existing_recurring_source_v1' && source.source_intent_id === intent.id
    && source.agreement_id === intent.agreement_id && source.client_id === intent.client_id);
  let agreement, invoices;
  try {
    agreement = await db.from('membership_agreements').select('retail_funding_receipt').eq('id', intent.agreement_id).maybeSingle();
    // IDs are strictly validated, not free-form user filter expressions. Read
    // all matching aliases globally, never a truncated customer's prefix.
    invoices = await db.from('billing_invoices').select('id,stripe_invoice_id,retail_period_receipt')
      .or(`stripe_invoice_id.eq.${paymentId},retail_period_receipt->proof->>payment_intent_id.eq.${paymentId},retail_period_receipt->proof->>charge_id.eq.${paymentId}`)
      .limit(2);
  } catch (_) { fail('native_commission_read_failed', 503); }
  if (!agreement || agreement.error || !invoices || invoices.error || !Array.isArray(invoices.data)) fail('native_commission_read_failed', 503);
  check(agreement.data && invoices.data.length < 2);
  return canonicalExistingRetailCommissionPayment({ source, initialReceipt: agreement.data.retail_funding_receipt,
    periodRows: invoices.data, paymentId });
}
module.exports = { canonicalExistingRetailCommissionPayment, assertCommissionPaymentInput, loadExistingRetailCommissionPayment };
