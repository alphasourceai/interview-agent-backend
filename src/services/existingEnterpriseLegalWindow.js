'use strict';

// Read-only consumer of the existing native legal-window RPC. This is not a
// renewal, cash or access writer. Client dates and browser clocks never select
// the service window. The native source digest is opaque: JS JSON rendering
// cannot recreate PostgreSQL jsonb numeric/text canonicalization.
const { isDeepStrictEqual } = require('node:util');
const { snapshotStripeSdkData } = require('./enterprisePoolPaymentProof');
const { readVerifiedEnterpriseBillingReceipt, freeze } = require('./existingEnterpriseBillingReceipt');
const { anchoredMonthInstant } = require('./membershipOffers');
const KEYS = ['version','agreement_id','client_id','billing_source_digest','term_index','initial_term_start',
  'original_term_end','term_start_at','term_end_at','notice_cutoff_at','auto_renew','accepted_operation_id',
  'funded_from','funded_through','observed_at','provider_effect_authorized','paid_access_authorized','payroll_authorized'];
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function hold() {
  throw Object.assign(new Error('enterprise_legal_window_unverified'), { code: 'enterprise_legal_window_unverified', status: 503 });
}
const check = value => { if (!value) hold(); };
function stamp(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value));
  const millis = Date.parse(value);
  check(Number.isFinite(millis) && new Date(millis).toISOString() === value.replace(/(\.\d{3})\d{3}Z$/, '$1Z'));
  return BigInt(millis) * 1000n + BigInt(value.slice(-4,-1));
}
function anchor(value, months) {
  stamp(value);
  return anchoredMonthInstant(new Date(value).toISOString(), months).replace(/(\.\d{3})Z$/, '$1' + value.slice(-4));
}
function verifyExistingEnterpriseLegalWindow(raw, { agreement, billingReceipt }) {
  try {
    const w = snapshotStripeSdkData(raw), source = billingReceipt, initial = source?.client_initial;
    check(w && Object.keys(w).sort().join(',') === [...KEYS].sort().join(',')
      && w.version === 'enterprise_existing_legal_window_v1' && UUID.test(agreement?.id || '')
      && UUID.test(agreement?.client_id || '') && w.agreement_id === agreement.id && w.client_id === agreement.client_id
      && w.client_id === source?.funding_receipt?.proof?.client_id && /^[0-9a-f]{32}$/.test(w.billing_source_digest)
      && Number.isSafeInteger(w.term_index) && w.term_index >= 0 && w.term_index <= 999
      && typeof w.auto_renew === 'boolean' && (w.accepted_operation_id === null || UUID.test(w.accepted_operation_id))
      && w.provider_effect_authorized === false && w.paid_access_authorized === false && w.payroll_authorized === false
      && w.initial_term_start === initial?.contract_start_at && w.original_term_end === initial?.contract_end_at);
    const originalStart = stamp(w.initial_term_start), originalEnd = stamp(w.original_term_end);
    check(originalEnd > originalStart && w.term_start_at === (w.term_index === 0 ? w.initial_term_start : anchor(w.original_term_end, 12*(w.term_index-1)))
      && w.term_end_at === anchor(w.original_term_end, 12*w.term_index));
    const start = stamp(w.term_start_at), end = stamp(w.term_end_at), from = stamp(w.funded_from), through = stamp(w.funded_through), at = stamp(w.observed_at);
    const cash = new Date(source.funding_receipt.proof.payment_success_at).toISOString().replace(/(\.\d{3})Z$/, '$1000Z');
    check(from === stamp(cash) && through > from && at >= from && at >= stamp(source.applied_at)
      && (w.term_index === 0 || (at >= start && from <= start && through > start)));
    const values = agreement.enterprise_checkout_source?.material?.template_snapshot?.values;
    check(typeof values?.notice_deadline_plain === 'string' && /^[1-9][0-9]{0,3}$/.test(values.notice_deadline_plain));
    const days = Number(values.notice_deadline_plain);
    check(days <= 3660 && values.notice_deadline_days === `${days} Days` && agreement.notice_deadline_days === days
      && stamp(w.notice_cutoff_at) === end - BigInt(days)*86400000000n);
    // A null journal means the original frozen preference, not mutable client
    // auto_renew. A later window requires already-funded native continuity.
    check(w.accepted_operation_id !== null || w.auto_renew === initial.auto_renew);
    check(!w.auto_renew || at < end || from > end || through <= end);
    return freeze(w);
  } catch (_) { hold(); }
}
async function readExistingEnterpriseLegalWindow({ db, agreement, billingReceipt }) {
  try {
    const result = await db.rpc('read_enterprise_existing_legal_window', { p_agreement: agreement.id, p_client: agreement.client_id });
    check(result && !result.error);
    const window = verifyExistingEnterpriseLegalWindow(result.data, { agreement, billingReceipt });
    // The original paid source must still be the one read before the RPC. Do
    // not hash a JS round-trip or substitute current mutable plan settings.
    const after = await readVerifiedEnterpriseBillingReceipt({ db, agreement });
    check(isDeepStrictEqual(after, snapshotStripeSdkData(billingReceipt)));
    return window;
  } catch (_) { hold(); }
}
module.exports = { verifyExistingEnterpriseLegalWindow, readExistingEnterpriseLegalWindow };
