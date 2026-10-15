'use strict';
// Internal trusted existing SDK/receipt -> SAME native original billing.
// Historical financial completion is never current access/Auth/renewal proof.
const { isDeepStrictEqual } = require('node:util');
const { snapshotStripeSdkData, snapshotEnterpriseUsageCensusData: contractSnapshot } = require('./enterprisePoolPaymentProof');
const { readExistingRetailActivationFunding } = require('./existingRetailActivationFunding');
const { buildAlphaScreenPlanSettingsPayload } = require('./alphaScreenPackages');
const {retailInitialEvidenceGeometry}=require('./membershipOffers');
const plain = v => JSON.parse(JSON.stringify(v));
const equal = (a, b) => a === undefined || b === undefined ? a === b : isDeepStrictEqual(contractSnapshot(a), contractSnapshot(b));
const id = v => typeof v === 'string' ? v : v?.id;
const closed = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
function fail(code = 'retail_admin_billing_adapter_unknown', status = 503) {
  const e = new Error(code); e.code = code; e.status = status;
  if (status === 409 || status === 410) e.permanentFailure = true;
  throw e;
}
const check = (v, code) => { if (!v) fail(code); };
function freeze(v) {
  if (v && typeof v === 'object') { for (const x of Object.values(v)) freeze(x); Object.freeze(v); }
  return v;
}
function stamp(v) {
  const m = typeof v === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(v);
  check(m, 'retail_admin_billing_adapter_receipt_unknown');
  const ms = Date.parse(m[1] + 'Z');
  check(Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === m[1], 'retail_admin_billing_adapter_receipt_unknown');
  return BigInt(ms) * 1000n + BigInt((m[2] || '').padEnd(6, '0'));
}
async function row(db, table, key, value) {
  const r = await db.from(table).select('*').eq(key, value).maybeSingle();
  check(r && !r.error); return contractSnapshot(r.data);
}
function initialSubscription(period,pkg) {
  const g=retailInitialEvidenceGeometry({offer:pkg.membership_terms,evidence:period});
  return { id: period.subscription_id, customer: period.customer_id, status:g.initialSubscriptionStatus,
    current_period_end:g.initialCoverageEndEpoch, cancel_at_period_end: false };
}
function initialClient(agreement, funding, subscription) {
  // SAME original pure builder. This initial projection is financial only.
  const { buildClientActivationPayload } = require('./publicPurchaseActivation');
  return buildClientActivationPayload({ agreement: plain(agreement), subscription: plain(subscription),
    planKey: funding.packageSnapshot.plan_key, billingInterval: funding.packageSnapshot.billing_cadence,
    packageSnapshot: funding.packageSnapshot, paidAt: funding.paidAt });
}
function verifyReceipt(receipt, agreement, funding, initial) {
  const r = contractSnapshot(receipt), p = funding.packageSnapshot, role = p.first_role_prepay;
  check(closed(r, ['version', 'source', 'funding_receipt', 'subscription', 'client_initial', 'plan_initial',
    'credit_initial', 'credit_id', 'applied_at']) && r.version === 'retail_admin_existing_billing_v1'
    && equal(r.source, agreement.checkout_attempt_source) && equal(r.funding_receipt, agreement.retail_funding_receipt)
    && equal(r.subscription, initialSubscription(agreement.retail_funding_receipt.proof.period,funding.packageSnapshot))
    && equal(r.client_initial, initial), 'retail_admin_billing_adapter_receipt_unknown');
  const expected = buildAlphaScreenPlanSettingsPayload({ clientId: agreement.client_id, planKey: p.plan_key,
    billingInterval: p.billing_cadence, packageSnapshot: p });
  check(expected && ['fixed', 'rollover', 'usage'].includes(r.plan_initial?.billing_model)
    && Number.isSafeInteger(r.plan_initial?.rollover_days) && r.plan_initial.rollover_days > 0,
  'retail_admin_billing_adapter_receipt_unknown');
  // Original sticky model; Basic intentionally omits rollover in old upsert.
  expected.billing_model = r.plan_initial.billing_model;
  if (Object.hasOwn(expected, 'rollover_days')) check(expected.rollover_days === r.plan_initial.rollover_days,
    'retail_admin_billing_adapter_receipt_unknown');
  else expected.rollover_days = r.plan_initial.rollover_days;
  check(equal(r.plan_initial, expected), 'retail_admin_billing_adapter_receipt_unknown');
  let credit = null;
  if (role?.selected === true) {
    credit = { billing_client_id: agreement.client_id, source_client_id: agreement.client_id,
      source_public_purchase_intent_id: null, source_membership_agreement_id: agreement.id,
      source_stripe_checkout_session_id: funding.checkoutSessionId, credit_type: 'first_role_prepay', membership_key: p.plan_key,
      normal_role_fee_cents: role.normal_role_fee_cents, discounted_credit_amount_cents: role.discounted_credit_amount_cents,
      discount_percent: role.discount_percent, status: 'unused', used_at: null, used_by_role_id: null,
      metadata: { source: 'public_purchase_activation', non_refundable: role.non_refundable === true,
        expires: role.expires === true, purchase_intent_id: null, membership_agreement_id: agreement.id },
      created_at: funding.paidAt, updated_at: funding.paidAt };
    check(typeof r.credit_id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.credit_id),
      'retail_admin_billing_adapter_receipt_unknown');
  } else check(r.credit_id === null, 'retail_admin_billing_adapter_receipt_unknown');
  check(equal(r.credit_initial, credit), 'retail_admin_billing_adapter_receipt_unknown');
  const applied = stamp(r.applied_at);
  check(applied >= stamp(agreement.retail_funding_receipt.recorded_at) && applied <= BigInt(Date.now()) * 1000n,
    'retail_admin_billing_adapter_receipt_unknown');
  return r;
}
async function applyBilling(options) {
  const { db, stripe, agreementId, assertFence = async () => {} } = options;
  await assertFence();
  const before = await row(db, 'membership_agreements', 'id', agreementId);
  const linked = await row(db, 'public_purchase_intents', 'agreement_id', agreementId);
  if (!before || before.template_version !== 'membership_agreement_retail_terms_v2' || !before.retail_funding_receipt
    || linked || before.template_snapshot?.purchase_intent
    || ![undefined, null, 'admin'].includes(before.template_snapshot?.source)) return null;
  check(before.id === agreementId && before.checkout_status === 'paid' && before.checkout_paid_at
    && before.checkout_attempt_source?.intent === null && !options.intentId && !options.claimKey,
  'retail_admin_billing_adapter_source_unknown');
  const funding = await readExistingRetailActivationFunding({ ...options, db, stripe, agreementId, assertFence });
  check(funding?.receiptReplay === true && funding.replay === true && funding.sourceIntentId === null,
    'retail_admin_billing_adapter_source_unknown');
  const period = before.retail_funding_receipt.proof.period;
  await assertFence();
  const checkout = snapshotStripeSdkData(await stripe.checkout.sessions.retrieve(period.checkout_session_id));
  check(checkout?.object === 'checkout.session' && checkout.id === period.checkout_session_id && checkout.status === 'complete'
    && checkout.payment_status === 'paid' && checkout.mode === 'subscription' && checkout.currency === 'usd'
    && checkout.livemode === period.livemode && id(checkout.customer) === period.customer_id
    && id(checkout.subscription) === period.subscription_id && id(checkout.invoice) === period.invoice_id,
  'retail_admin_billing_adapter_checkout_unknown');
  const current = snapshotStripeSdkData(funding.subscription), sub = initialSubscription(period,funding.packageSnapshot);
  const historical = before.retail_admin_billing_receipt != null;
  if (!historical) {
    check(current?.object === 'subscription' && current.status === sub.status && current.cancel_at_period_end === false
      && Number.isSafeInteger(current.current_period_end) && current.current_period_end > 0 && current.current_period_end <= 253402300799
      && current.current_period_end === sub.current_period_end && id(current.customer) === sub.customer && current.id === sub.id
      && current.cancel_at == null && current.pause_collection == null, 'retail_admin_billing_adapter_subscription_unknown');
    if (current.current_period_end <= Date.now() / 1000) fail('retail_admin_billing_adapter_period_ended', 410);
  }
  await assertFence();
  const saved = await row(db, 'membership_agreements', 'id', agreementId), source = saved?.checkout_attempt_source;
  check(saved?.client_id === before.client_id && saved.client_id === funding.clientId && equal(source, before.checkout_attempt_source)
    && equal(saved.retail_funding_receipt, before.retail_funding_receipt)
    && equal(saved.retail_admin_billing_receipt, before.retail_admin_billing_receipt)
    && saved.checkout_session_id === period.checkout_session_id && equal(saved.template_snapshot, funding.sourceTemplate)
    && saved.template_version === funding.sourceTemplateVersion && funding.agreementId === agreementId && funding.paidAt === period.paid_at
    && funding.checkoutSessionId === period.checkout_session_id && funding.customerId === period.customer_id,
  'retail_admin_billing_adapter_source_unknown');
  const initial = initialClient(saved, funding, historical ? sub : current);
  if (historical) verifyReceipt(saved.retail_admin_billing_receipt, saved, funding, initial);
  const args = { p_agreement: agreementId, p_client: saved.client_id, p_source: plain(source),
    p_funding: plain(saved.retail_funding_receipt), p_initial: initial, p_subscription: sub };
  async function native() {
    await assertFence();
    const r = await db.rpc('apply_retail_existing_admin_billing', args);
    if (r?.error?.message === 'retail_admin_client_paid_period_ended') fail('retail_admin_billing_adapter_period_ended', 410);
    if (['retail_admin_billing_source_denied', 'retail_admin_billing_owner_denied', 'retail_admin_billing_payload_denied',
      'retail_admin_billing_replay_conflict', 'retail_admin_billing_credit_conflict', 'retail_admin_client_existing_state_conflict',
      'retail_admin_client_source_denied', 'retail_admin_client_owner_denied', 'retail_admin_client_subscription_denied',
      'retail_admin_client_payload_denied', 'retail_funding_customer_denied', 'retail_funding_source_denied',
      'retail_funding_paid_source_denied', 'retail_funding_source_changed'].includes(r?.error?.message)) fail('retail_admin_billing_adapter_conflict', 409);
    check(r && !r.error && r.data, 'retail_admin_billing_adapter_ack_unknown');
    const ack = contractSnapshot(r.data);
    check(closed(ack, ['status', 'receipt']) && ['applied', 'already_applied'].includes(ack.status),
      'retail_admin_billing_adapter_ack_unknown');
    verifyReceipt(ack.receipt, saved, funding, initial); return ack;
  }
  const result = await native();
  if (historical) check(result.status === 'already_applied' && equal(result.receipt, saved.retail_admin_billing_receipt),
    'retail_admin_billing_adapter_ack_unknown');
  await assertFence();
  const read = await db.rpc('read_retail_existing_funding', { p_agreement: agreementId, p_client: saved.client_id,
    p_claim: null, p_source: plain(source) });
  check(read && !read.error && read.data, 'retail_admin_billing_adapter_readback_unknown');
  const locked = snapshotStripeSdkData(read.data);
  check(closed(locked, ['phase', 'receipt', 'version']) && locked.phase === 'paid'
    && locked.version === 'retail_existing_funding_read_v1' && equal(locked.receipt, saved.retail_funding_receipt),
  'retail_admin_billing_adapter_readback_unknown');
  const after = await row(db, 'membership_agreements', 'id', agreementId);
  const afterIntent = await row(db, 'public_purchase_intents', 'agreement_id', agreementId);
  const client = await row(db, 'clients', 'id', saved.client_id);
  check(!afterIntent && after?.client_id === saved.client_id && equal(after.checkout_attempt_source, source)
    && equal(after.retail_funding_receipt, saved.retail_funding_receipt) && equal(after.template_snapshot, saved.template_snapshot)
    && after.template_version === saved.template_version && after.is_current === true && ['signed', 'active'].includes(after.status)
    && !after.superseded_at && !after.superseded_by_agreement_id && !after.voided_at && after.checkout_status === 'paid'
    && new Date(after.checkout_paid_at).toISOString() === funding.paidAt && after.checkout_session_id === funding.checkoutSessionId
    && client?.id === saved.client_id && client.parent_client_id === null && client.archived_at === null
    && client.stripe_customer_id === period.customer_id && client.stripe_subscription_id === period.subscription_id
    && equal(after.retail_admin_billing_receipt, result.receipt), 'retail_admin_billing_adapter_readback_unknown');
  // Missing/unknown persisted marker refused ABOVE. This is a locked no-DML
  // financial/owner readback, never a fallback first writer or tuple reset.
  const confirmed = await native();
  check(confirmed.status === 'already_applied' && equal(confirmed.receipt, result.receipt),
    'retail_admin_billing_adapter_readback_unknown');
  await assertFence();
  return freeze({ status: result.status, receipt: plain(result.receipt), funding,
    currentProviderSubscription: plain(current), billing_applied: true, membership_activation_required: true, credits_spendable: false });
}
async function applyExistingRetailAdminBilling(options) {
  try { return await applyBilling(options); }
  catch (e) {
    if (e?.code === 'public_purchase_activation_guard_lost' || typeof e?.code === 'string'
      && /^retail_admin_billing_adapter_[a-z_]+$/.test(e.code) && e.message === e.code) throw e;
    fail(); // No raw DB/provider responses, URLs or credentials.
  }
}
module.exports = { applyExistingRetailAdminBilling };
