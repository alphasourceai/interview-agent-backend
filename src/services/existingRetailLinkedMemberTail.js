'use strict';
// Internal trusted seam for the ORIGINAL post-payment account helper. No new
// Auth engine or provider writes. Native initial-period proof is not renewal.
const { isDeepStrictEqual } = require('node:util');
const { snapshotStripeSdkData, snapshotEnterpriseUsageCensusData: contractSnapshot } = require('./enterprisePoolPaymentProof');
const { applyExistingRetailLinkedBilling } = require('./existingRetailLinkedBillingAdapter');
const plain = v => JSON.parse(JSON.stringify(v));
const equal = (a, b) => a === undefined || b === undefined ? a === b : isDeepStrictEqual(contractSnapshot(a), contractSnapshot(b));
const id = v => typeof v === 'string' ? v : v?.id;
const contextKeys = 'agreement_id,billing_applied_at,buyer_email,claim,client_id,current,digest,intent_id,receipt,source';
// Native closed JSON currently has TEN fields (SQL is the authority), not an
// invented status field. Never silently accept an extra eleventh field.
function fail(code = 'retail_linked_member_tail_unknown', status = 503) {
  const e = new Error(code); e.code = code; e.status = status;
  if (status === 409 || status === 410) e.permanentFailure = true;
  throw e;
}
const check = (v, code) => { if (!v) fail(code); };
function normalizeError(e) {
  if (e?.code === 'public_purchase_activation_guard_lost' || typeof e?.code === 'string'
    && /^retail_linked_(?:member_tail|billing)_[a-z_]+$/.test(e.code) && e.message === e.code) throw e;
  fail();
}
const conflicts = new Set(['retail_linked_member_source_denied', 'retail_linked_member_receipt_denied',
  'retail_linked_member_current_subscription_denied', 'retail_linked_member_current_access_denied',
  'retail_linked_member_billing_denied', 'retail_linked_member_user_denied', 'retail_linked_member_buyer_denied',
  'retail_linked_member_identity_conflict', 'retail_linked_member_binding_conflict',
  'retail_linked_member_commit_binding_denied', 'retail_linked_member_commit_identity_denied']);
async function native(db, name, args) {
  const r = await db.rpc(name, args), message = r?.error?.message;
  if (['retail_linked_member_claim_denied', 'retail_funding_claim_denied'].includes(message)) {
    const e = new Error('public_purchase_activation_guard_lost'); e.code = e.message; e.status = 503; throw e;
  }
  if (message === 'retail_linked_member_paid_period_ended') fail('retail_linked_member_tail_period_ended', 410);
  if (conflicts.has(message)) fail('retail_linked_member_tail_conflict', 409);
  check(r && !r.error && r.data, 'retail_linked_member_tail_ack_unknown');
  // The native context includes the complete accepted contract/source.
  return name === 'retail_linked_existing_member_context' ? contractSnapshot(r.data) : snapshotStripeSdkData(r.data);
}
function memberAck(r) {
  check(r && !Array.isArray(r) && Object.keys(r).sort().join(',') === 'role,status'
    && ['created', 'existing', 'updated'].includes(r.status) && typeof r.role === 'string'
    && r.role.length > 0 && r.role === r.role.trim().toLowerCase(), 'retail_linked_member_tail_ack_unknown');
  return r;
}
function fundingSame(a, b) {
  return a?.agreementId === b?.agreementId && a?.clientId === b?.clientId && a?.sourceIntentId === b?.sourceIntentId
    && a?.paidAt === b?.paidAt && a?.customerId === b?.customerId && a?.checkoutSessionId === b?.checkoutSessionId
    && a?.sourceTemplateVersion === b?.sourceTemplateVersion && equal(a?.packageSnapshot, b?.packageSnapshot)
    && equal(a?.sourceTemplate, b?.sourceTemplate) && equal(a?.initialProviderPeriod, b?.initialProviderPeriod)
    && equal(a?.initialProviderSchedule,b?.initialProviderSchedule) && equal(a?.sourceCheckoutPrices,b?.sourceCheckoutPrices);
}
async function prepare(options) {
  const { db, assertFence = async () => {} } = options;
  const billing = await applyExistingRetailLinkedBilling(options);
  if (!billing) return null;
  const funding = billing.funding; let originalContext;
  async function ready() {
    await assertFence();
    // This SAME adapter traverses existingRetailFundingReplay, performing a new
    // subscriptions.retrieve outside native locks on EVERY readiness check.
    const currentBilling = await applyExistingRetailLinkedBilling(options);
    check(currentBilling?.status === 'already_applied' && currentBilling.digest === billing.digest
      && fundingSame(currentBilling.funding, funding), 'retail_linked_member_tail_source_unknown');
    const s = snapshotStripeSdkData(currentBilling.currentProviderSubscription);
    check(Object.hasOwn(s, 'cancel_at') && Object.hasOwn(s, 'pause_collection') && typeof s.cancel_at_period_end === 'boolean'
      && Number.isSafeInteger(s.current_period_end) && s.current_period_end > 0 && s.current_period_end <= 253402300799,
    'retail_linked_member_tail_subscription_unknown');
    const current = { id: s.id, customer: id(s.customer), status: s.status, current_period_end: s.current_period_end,
      cancel_at_period_end: s.cancel_at_period_end, cancel_at: s.cancel_at, pause_collection: s.pause_collection };
    const args = { p_intent: options.intentId, p_claim: options.claimKey, p_digest: billing.digest, p_current: plain(current) };
    await assertFence();
    const context = await native(db, 'retail_linked_existing_member_context', args);
    check(context && !Array.isArray(context) && Object.keys(context).sort().join(',') === contextKeys
      && context.intent_id === options.intentId && context.agreement_id === options.agreementId && context.client_id === funding.clientId
      && context.claim === options.claimKey && context.digest === billing.digest && typeof context.billing_applied_at === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(context.billing_applied_at)
      && Number.isFinite(Date.parse(context.billing_applied_at)) && Date.parse(context.billing_applied_at) <= Date.now()
      && context.source?.intent?.id === options.intentId && context.source.agreement_id === options.agreementId
      && context.source.client_id === funding.clientId && equal(context.source.template_snapshot, funding.sourceTemplate)
      && equal(context.receipt?.proof?.period, funding.initialProviderSchedule||funding.initialProviderPeriod) && equal(context.current, current)
      && typeof context.buyer_email === 'string' && context.buyer_email.length > 0
      && context.buyer_email === context.buyer_email.trim().toLowerCase(), 'retail_linked_member_tail_readback_unknown');
    const stable = plain(context); delete stable.current;
    if (originalContext) check(equal(stable, originalContext), 'retail_linked_member_tail_source_unknown');
    else originalContext = stable; // Keep native original applied stamp, including microseconds.
    await assertFence(); return { args, context };
  }
  await ready(); // No account-side effect before current native admission.
  return Object.freeze({ billing, buyerEmail: originalContext.buyer_email,
    async assertReady() { try { await ready(); } catch (e) { normalizeError(e); } },
    async ensureMember({ userId, name }) {
      try {
        const before = await ready();
        const first = memberAck(await native(db, 'ensure_retail_existing_linked_buyer_member', { ...before.args, p_user: userId, p_name: name }));
        const after = await ready();
        const row = await db.from('client_members').select('*').eq('client_id', funding.clientId).eq('user_id', userId).maybeSingle();
        check(row && !row.error && row.data, 'retail_linked_member_tail_readback_unknown');
        const m = snapshotStripeSdkData(row.data);
        check(m.client_id === funding.clientId && m.user_id === userId && m.user_id_uuid === userId && m.role === first.role
          && typeof m.email === 'string' && m.email.trim().toLowerCase() === after.context.buyer_email,
        'retail_linked_member_tail_readback_unknown');
        await assertFence();
        const confirmed = memberAck(await native(db, 'ensure_retail_existing_linked_buyer_member', { ...after.args, p_user: userId, p_name: name }));
        check(confirmed.status === 'existing' && confirmed.role === first.role, 'retail_linked_member_tail_readback_unknown');
        await ready(); return Object.freeze(plain(first));
      } catch (e) { normalizeError(e); }
    }
  });
}
async function prepareExistingRetailLinkedMemberTail(options) {
  try { return await prepare(options); } catch (e) { normalizeError(e); }
}
module.exports = { prepareExistingRetailLinkedMemberTail };
