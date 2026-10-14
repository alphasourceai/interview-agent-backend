'use strict';
// Internal seam for the ORIGINAL post-payment account helper. Not a new Auth
// engine. SDK reads/native guards are not hosted account/email acceptance.
const { isDeepStrictEqual } = require('node:util');
const { snapshotStripeSdkData } = require('./enterprisePoolPaymentProof');
const { applyExistingRetailAdminBilling } = require('./existingRetailAdminBillingAdapter');
const plain = v => JSON.parse(JSON.stringify(v));
const equal = (a, b) => isDeepStrictEqual(snapshotStripeSdkData(a), snapshotStripeSdkData(b));
const id = v => typeof v === 'string' ? v : v?.id;
const roles = new Set(['manager', 'admin', 'owner', 'super_admin']);
function fail(code = 'retail_admin_member_tail_unknown', status = 503) {
  const e = new Error(code); e.code = code; e.status = status;
  if (status === 409 || status === 410) e.permanentFailure = true;
  throw e;
}
const check = (v, code) => { if (!v) fail(code); };
function normalizeError(e) {
  if (e?.code === 'public_purchase_activation_guard_lost' || typeof e?.code === 'string'
    && /^retail_admin_(?:member_tail|billing_adapter)_[a-z_]+$/.test(e.code) && e.message === e.code) throw e;
  fail();
}
async function native(db, name, args) {
  const r = await db.rpc(name, args);
  if (r?.error?.message === 'retail_admin_member_paid_period_ended') fail('retail_admin_member_tail_period_ended', 410);
  if (['retail_admin_member_source_denied', 'retail_admin_member_receipt_denied', 'retail_admin_member_current_subscription_denied',
    'retail_admin_member_current_access_denied', 'retail_admin_member_user_denied', 'retail_admin_member_buyer_denied',
    'retail_admin_member_identity_conflict', 'retail_admin_member_binding_conflict', 'retail_admin_member_commit_identity_denied',
    'retail_admin_billing_source_denied', 'retail_admin_billing_owner_denied', 'retail_funding_customer_denied',
    'retail_funding_source_denied', 'retail_funding_paid_source_denied', 'retail_funding_source_changed'].includes(r?.error?.message))
    fail('retail_admin_member_tail_conflict', 409);
  check(r && !r.error && r.data, 'retail_admin_member_tail_ack_unknown');
  return snapshotStripeSdkData(r.data);
}
function memberAck(r) {
  check(r && !Array.isArray(r) && Object.keys(r).sort().join(',') === 'role,status'
    && ['created', 'existing', 'updated'].includes(r.status) && roles.has(r.role), 'retail_admin_member_tail_ack_unknown');
  return r;
}
async function prepare(options) {
  const { db, assertFence = async () => {} } = options;
  const billing = await applyExistingRetailAdminBilling(options);
  if (!billing) return null;
  const receipt = snapshotStripeSdkData(billing.receipt), source = receipt.source, period = receipt.funding_receipt.proof.period;
  async function ready() {
    await assertFence();
    // Completed financial replay is ZERO DML; actual current SDK sub stays
    // separate. Never substitute historical active/B into a live access check.
    const currentBilling = await applyExistingRetailAdminBilling(options);
    check(currentBilling?.status === 'already_applied' && equal(currentBilling.receipt, receipt), 'retail_admin_member_tail_source_unknown');
    const s = snapshotStripeSdkData(currentBilling.currentProviderSubscription);
    check(Object.hasOwn(s, 'cancel_at') && Object.hasOwn(s, 'pause_collection') && typeof s.cancel_at_period_end === 'boolean'
      && Number.isSafeInteger(s.current_period_end) && s.current_period_end > 0 && s.current_period_end <= 253402300799,
    'retail_admin_member_tail_subscription_unknown');
    const projected = { id: s.id, customer: id(s.customer), status: s.status, current_period_end: s.current_period_end,
      cancel_at_period_end: s.cancel_at_period_end, cancel_at: s.cancel_at, pause_collection: s.pause_collection };
    await assertFence();
    const args = { p_agreement: options.agreementId, p_source: plain(source), p_receipt: plain(receipt), p_current: plain(projected) };
    const response = await native(db, 'retail_admin_existing_member_context', args);
    // Composite table return: ordinary RPC array or singular representation.
    // No invented JSON status envelope; require exactly one native row.
    const a = Array.isArray(response) && response.length === 1 ? response[0] : response;
    check(a && !Array.isArray(a) && a.id === options.agreementId && a.client_id === source.client_id
      && a.is_current === true && ['signed', 'active'].includes(a.status) && !a.superseded_at && !a.superseded_by_agreement_id && !a.voided_at
      && a.template_version === source.template_version && equal(a.template_snapshot, source.template_snapshot)
      && equal(a.checkout_attempt_source, source) && equal(a.retail_funding_receipt, receipt.funding_receipt)
      && equal(a.retail_admin_billing_receipt, receipt) && a.checkout_status === 'paid'
      && a.checkout_session_id === period.checkout_session_id && new Date(a.checkout_paid_at).toISOString() === period.paid_at,
    'retail_admin_member_tail_readback_unknown');
    await assertFence(); return { args, agreement: a };
  }
  await ready(); // No account-side effect before native current-access admission.
  return Object.freeze({ billing,
    async assertReady() { try { await ready(); } catch (e) { normalizeError(e); } },
    async ensureMember({ userId, name }) {
      try {
        const before = await ready();
        const args = { ...before.args, p_user: userId, p_name: name };
        const first = memberAck(await native(db, 'ensure_retail_existing_admin_buyer_member', args));
        const after = await ready();
        const row = await db.from('client_members').select('*').eq('client_id', source.client_id).eq('user_id', userId).maybeSingle();
        check(row && !row.error && row.data, 'retail_admin_member_tail_readback_unknown');
        const m = snapshotStripeSdkData(row.data);
        check(m.client_id === source.client_id && m.user_id === userId && m.user_id_uuid === userId && m.role === first.role
          && typeof m.email === 'string' && m.email.trim().toLowerCase() === after.agreement.admin_email?.trim().toLowerCase(),
        'retail_admin_member_tail_readback_unknown');
        await assertFence();
        // Identity/cardinality/current-clock authority stays native under locks.
        // This second call must be no-DML existing, not another first grant.
        const confirmed = memberAck(await native(db, 'ensure_retail_existing_admin_buyer_member', { ...after.args, p_user: userId, p_name: name }));
        check(confirmed.status === 'existing' && confirmed.role === first.role, 'retail_admin_member_tail_readback_unknown');
        await ready(); return Object.freeze(plain(first));
      } catch (e) { normalizeError(e); }
    }
  });
}
async function prepareExistingRetailAdminMemberTail(options) {
  try { return await prepare(options); } catch (e) { normalizeError(e); }
}
module.exports = { prepareExistingRetailAdminMemberTail };
