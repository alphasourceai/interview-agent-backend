'use strict';
// UNMOUNTED trusted SDK -> SAME original 28-argument billing writer/digest.
// Historical financial replay is not current access, Auth or renewal proof.
const { isDeepStrictEqual } = require('node:util');
const { snapshotStripeSdkData } = require('./enterprisePoolPaymentProof');
const { readExistingRetailActivationFunding } = require('./existingRetailActivationFunding');
const { buildAlphaScreenPlanSettingsPayload } = require('./alphaScreenPackages');
const plain = v => JSON.parse(JSON.stringify(v));
const equal = (a, b) => isDeepStrictEqual(snapshotStripeSdkData(a), snapshotStripeSdkData(b));
const id = v => typeof v === 'string' ? v : v?.id;
function fail(code = 'retail_linked_billing_unknown', status = 503) {
  const e = new Error(code); e.code = code; e.status = status;
  if (status === 409 || status === 410) e.permanentFailure = true;
  throw e;
}
const check = (v, code) => { if (!v) fail(code); };
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function stamp(v) {
  const m = typeof v === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(v);
  check(m && Number.isFinite(Date.parse(m[1] + m[3])) && Number.isFinite(Date.parse(m[1] + 'Z'))
    && new Date(m[1] + 'Z').toISOString().slice(0, 19) === m[1], 'retail_linked_billing_marker_unknown');
  return BigInt(Date.parse(m[1] + m[3])) * 1000n + BigInt((m[2] || '').padEnd(6, '0'));
}
const iso = v => { stamp(v); return new Date(v).toISOString(); };
function marker(i) {
  const at = i?.billing_applied_at, digest = i?.billing_apply_digest;
  if (at == null && digest == null) return null;
  check(at != null && typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 'retail_linked_billing_marker_unknown');
  stamp(at); return { at, digest };
}
async function row(db, table, key, value) {
  const r = await db.from(table).select('*').eq(key, value).maybeSingle();
  check(r && !r.error); return snapshotStripeSdkData(r.data);
}
const conflicts = new Set(['retail_funding_billing_source_denied', 'retail_funding_billing_customer_denied',
  'invalid_billing_payload', 'credit_selection_mismatch', 'package_snapshot_mismatch', 'credit_payload_mismatch',
  'unexpected_credit_payload', 'billing_payload_conflict', 'existing_client_plan_conflict', 'billing_identity_conflict',
  'retail_terms_source_mismatch', 'retail_role_source_mismatch', 'retail_original_clock_mismatch', 'retail_original_term_mismatch',
  'credit_checkout_session_conflict',
  'existing_plan_conflict', 'existing_credit_conflict', 'retail_existing_terms_source_denied', 'retail_existing_terms_payload_denied',
  'billing_intent_manual_review', 'billing_agreement_manual_review', 'billing_client_missing']);
async function apply(options) {
  const { db, stripe, agreementId, assertFence = async () => {} } = options;
  await assertFence();
  const a = await row(db, 'membership_agreements', 'id', agreementId);
  const i = await row(db, 'public_purchase_intents', 'agreement_id', agreementId);
  if (!a || a.template_version !== 'membership_agreement_retail_terms_v2' || !a.retail_funding_receipt
    || !i || i.protocol === 'legacy_complete' || [undefined, null, 'admin'].includes(a.template_snapshot?.source)) return null;
  check(['public_purchase_intent', 'sales_assisted'].includes(a.template_snapshot?.source), 'retail_linked_billing_source_unknown');
  check(i.protocol === 'fenced_v2' && i.status === 'completed' && !i.canceled_at && i.agreement_id === agreementId
    && i.client_id === a.client_id && a.client_id && a.checkout_status === 'paid'
    && a.checkout_attempt_source?.intent?.id === i.id && a.template_snapshot.purchase_intent?.id === i.id
    && (!options.intentId || options.intentId === i.id), 'retail_linked_billing_source_unknown');
  const prior = marker(i);
  const funding = await readExistingRetailActivationFunding({ ...options, intentId: i.id });
  check(funding?.receiptReplay === true && funding.replay === true && funding.sourceIntentId === i.id
    && funding.agreementId === a.id && funding.clientId === a.client_id, 'retail_linked_billing_source_unknown');
  const period = a.retail_funding_receipt.proof.period;
  check(iso(a.checkout_paid_at) === period.paid_at && iso(i.activated_at) === period.paid_at
    && equal(funding.initialProviderPeriod, period) && equal(funding.sourceTemplate, a.template_snapshot)
    && funding.sourceTemplateVersion === a.template_version, 'retail_linked_billing_source_unknown');
  await assertFence();
  const checkout = snapshotStripeSdkData(await stripe.checkout.sessions.retrieve(period.checkout_session_id));
  check(checkout?.object === 'checkout.session' && checkout.id === period.checkout_session_id && checkout.status === 'complete'
    && checkout.payment_status === 'paid' && checkout.mode === 'subscription' && checkout.currency === 'usd'
    && checkout.livemode === period.livemode && id(checkout.customer) === period.customer_id
    && id(checkout.subscription) === period.subscription_id && id(checkout.invoice) === period.invoice_id,
  'retail_linked_billing_checkout_unknown');
  const current = snapshotStripeSdkData(funding.subscription);
  if (!prior) {
    check(current?.status === 'active' && current.id === period.subscription_id && id(current.customer) === period.customer_id
      && current.cancel_at_period_end === false && Object.hasOwn(current, 'cancel_at') && current.cancel_at === null
      && Object.hasOwn(current, 'pause_collection') && current.pause_collection === null
      && Number.isSafeInteger(current.current_period_end) && current.current_period_end > 0
      && current.current_period_end <= 253402300799 && current.current_period_end === period.provider_period_end,
    'retail_linked_billing_subscription_unknown');
    if (current.current_period_end <= Date.now() / 1000) fail('retail_linked_billing_period_ended', 410);
  }
  // Financial INITIAL projection only. Do not replace the separately returned
  // actual CURRENT subscription with this historical active/B snapshot.
  const initialSub = { id: period.subscription_id, customer: period.customer_id, status: 'active',
    current_period_end: period.provider_period_end, cancel_at_period_end: false };
  const pkg = funding.packageSnapshot;
  const { buildClientActivationPayload } = require('./publicPurchaseActivation');
  const clientInitial = buildClientActivationPayload({ agreement: plain(a), subscription: initialSub,
    planKey: pkg.plan_key, billingInterval: pkg.billing_cadence, packageSnapshot: pkg, paidAt: period.paid_at });
  const planInitial = buildAlphaScreenPlanSettingsPayload({ clientId: a.client_id, planKey: pkg.plan_key,
    billingInterval: pkg.billing_cadence, packageSnapshot: pkg });
  check(planInitial && equal(pkg, a.template_snapshot.package_snapshot), 'retail_linked_billing_source_unknown');
  const credit = pkg.first_role_prepay, selected = credit?.selected === true;
  const args = { p_intent_id: i.id, p_claim_key: options.claimKey, p_client_id: a.client_id, p_billing_client_id: a.client_id,
    p_stripe_customer_id: clientInitial.stripe_customer_id, p_stripe_subscription_id: clientInitial.stripe_subscription_id,
    p_subscription_status: clientInitial.subscription_status, p_billing_status: clientInitial.billing_status,
    p_billing_interval: clientInitial.billing_interval, p_plan_tier: clientInitial.plan_tier,
    p_current_term_end: clientInitial.current_term_end, p_cancel_at_term_end: clientInitial.cancel_at_term_end,
    p_auto_renew: clientInitial.auto_renew, p_cancel_effective_at: clientInitial.cancel_effective_at,
    p_contract_start_at: clientInitial.contract_start_at, p_contract_end_at: clientInitial.contract_end_at,
    p_platform_fee: planInitial.platform_fee, p_per_role_fee: planInitial.per_role_fee,
    p_included_interviews_per_role: planInitial.included_interviews_per_role, p_additional_interview_fee: planInitial.additional_interview_fee,
    p_max_interview_minutes: planInitial.max_interview_minutes, p_credit_selected: selected,
    p_credit_type: selected ? credit.credit_type : null, p_credit_normal_role_fee_cents: selected ? credit.normal_role_fee_cents : null,
    p_credit_discounted_amount_cents: selected ? credit.discounted_credit_amount_cents : null,
    p_credit_discount_percent: selected ? credit.discount_percent : null, p_credit_non_refundable: selected ? credit.non_refundable === true : null,
    p_credit_expires: selected ? credit.expires === true : null };
  async function native() {
    await assertFence(); const r = await db.rpc('apply_public_purchase_billing', args);
    if (['retail_funding_billing_claim_denied', 'activation_fence_lost'].includes(r?.error?.message) || r?.data?.status === 'activation_fence_lost') {
      const e = new Error('public_purchase_activation_guard_lost'); e.code = e.message; e.status = 503; throw e;
    }
    if (conflicts.has(r?.error?.message) || conflicts.has(r?.data?.status)) fail('retail_linked_billing_conflict', 409);
    check(r && !r.error && r.data, 'retail_linked_billing_ack_unknown');
    const ack = snapshotStripeSdkData(r.data);
    check(ack && Object.keys(ack).sort().join(',') === 'digest,status' && ['applied', 'already_applied'].includes(ack.status)
      && typeof ack.digest === 'string' && /^[a-f0-9]{64}$/.test(ack.digest), 'retail_linked_billing_ack_unknown');
    if (prior) check(ack.status === 'already_applied' && ack.digest === prior.digest, 'retail_linked_billing_ack_unknown');
    return ack;
  }
  const first = await native();
  await assertFence();
  const read = await db.rpc('read_retail_existing_funding', { p_agreement: a.id, p_client: a.client_id,
    p_claim: options.claimKey, p_source: plain(a.checkout_attempt_source) });
  check(read && !read.error && read.data, 'retail_linked_billing_readback_unknown');
  const locked = snapshotStripeSdkData(read.data);
  check(Object.keys(locked).sort().join(',') === 'phase,receipt,version' && locked.phase === 'paid'
    && locked.version === 'retail_existing_funding_read_v1' && equal(locked.receipt, a.retail_funding_receipt),
  'retail_linked_billing_readback_unknown');
  const after = await row(db, 'membership_agreements', 'id', a.id), afterIntent = await row(db, 'public_purchase_intents', 'id', i.id);
  const client = await row(db, 'clients', 'id', a.client_id), saved = marker(afterIntent);
  check(saved && saved.digest === first.digest && stamp(saved.at) >= stamp(a.retail_funding_receipt.recorded_at)
    && stamp(saved.at) <= BigInt(Date.now()) * 1000n && (!prior || stamp(saved.at) === stamp(prior.at))
    && after?.id === a.id && after.client_id === a.client_id && after.is_current === true && ['signed', 'active'].includes(after.status)
    && !after.superseded_at && !after.superseded_by_agreement_id && !after.voided_at && after.checkout_status === 'paid'
    && after.checkout_session_id === period.checkout_session_id && iso(after.checkout_paid_at) === period.paid_at
    && equal(after.checkout_attempt_source, a.checkout_attempt_source) && equal(after.retail_funding_receipt, a.retail_funding_receipt)
    && equal(after.template_snapshot, a.template_snapshot) && after.template_version === a.template_version
    && afterIntent.id === i.id && afterIntent.agreement_id === a.id && afterIntent.client_id === a.client_id
    && afterIntent.status === 'completed' && afterIntent.protocol === 'fenced_v2' && !afterIntent.canceled_at
    && iso(afterIntent.activated_at) === period.paid_at && afterIntent.stripe_checkout_session_id === period.checkout_session_id
    && equal(afterIntent.package_snapshot, i.package_snapshot)
    && client?.id === a.client_id && client.parent_client_id === null && client.archived_at === null
    && client.stripe_customer_id === period.customer_id && client.stripe_subscription_id === period.subscription_id,
  'retail_linked_billing_readback_unknown');
  const confirmed = await native();
  check(confirmed.status === 'already_applied' && confirmed.digest === saved.digest, 'retail_linked_billing_readback_unknown');
  await assertFence();
  return freeze({ status: first.status, digest: first.digest, clientInitial: plain(clientInitial), planInitial: plain(planInitial),
    funding, currentProviderSubscription: plain(current), billing_applied: true, membership_activation_required: true, credits_spendable: false });
}
async function applyExistingRetailLinkedBilling(options) {
  try { return await apply(options); } catch (e) {
    if (e?.code === 'public_purchase_activation_guard_lost' || typeof e?.code === 'string'
      && /^retail_linked_billing_[a-z_]+$/.test(e.code) && e.message === e.code) throw e;
    fail(); // Keep provider/DB messages, URLs and credentials out of this seam.
  }
}
module.exports = { applyExistingRetailLinkedBilling };
