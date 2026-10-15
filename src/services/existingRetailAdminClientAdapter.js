'use strict';
// UNMOUNTED existing SDK/receipt -> native CLIENT tuple only. Not full billing,
// plan/credit/Auth completion or delivery. No new payment/account engine.
const { isDeepStrictEqual } = require('node:util');
const { snapshotStripeSdkData, snapshotEnterpriseUsageCensusData: contractSnapshot } = require('./enterprisePoolPaymentProof');
const { readExistingRetailActivationFunding } = require('./existingRetailActivationFunding');
const {retailInitialEvidenceGeometry}=require('./membershipOffers');
const equal = (a, b) => a === undefined || b === undefined ? a === b : isDeepStrictEqual(contractSnapshot(a), contractSnapshot(b));
const plain = v => JSON.parse(JSON.stringify(v));
const id = v => typeof v === 'string' ? v : v?.id;
function periodEnded() {
  const e = new Error('retail_admin_adapter_period_ended'); e.code = e.message;
  e.status = 410; e.permanentFailure = true; throw e;
}
function nativeConflict() {
  const e = new Error('retail_admin_adapter_conflict'); e.code = e.message;
  e.status = 409; e.permanentFailure = true; throw e;
}
function fail(code = 'retail_admin_adapter_unknown') {
  const e = new Error(code); e.code = code; e.status = 503; throw e;
}
const check = (v, code) => { if (!v) fail(code); };
function freeze(v) {
  if (v && typeof v === 'object') { for (const x of Object.values(v)) freeze(x); Object.freeze(v); }
  return v;
}
async function row(db, table, key, value) {
  const r = await db.from(table).select('*').eq(key, value).maybeSingle();
  check(r && !r.error); return contractSnapshot(r.data);
}
async function applyClient(options) {
  const { db, agreementId, stripe, assertFence = async () => {} } = options;
  await assertFence();
  const before = await row(db, 'membership_agreements', 'id', agreementId);
  const intent = await row(db, 'public_purchase_intents', 'agreement_id', agreementId);
  // Do not enroll accepted historical sources or intercept the linked writer.
  if (!before || before.template_version !== 'membership_agreement_retail_terms_v2'
    || !before.retail_funding_receipt || intent || before.template_snapshot?.purchase_intent
    || ![undefined, null, 'admin'].includes(before.template_snapshot?.source)) return null;
  check(before.id === agreementId && before.checkout_status === 'paid' && before.checkout_paid_at
    && before.checkout_attempt_source?.intent === null && !options.intentId && !options.claimKey,
  'retail_admin_adapter_source_unknown');
  const funding = await readExistingRetailActivationFunding({ ...options, db, stripe, agreementId, assertFence });
  check(funding && funding.receiptReplay === true && funding.replay === true && funding.sourceIntentId === null,
    'retail_admin_adapter_source_unknown');
  const receipt = before.retail_funding_receipt, period = receipt?.proof?.period;
  const geometry=retailInitialEvidenceGeometry({offer:funding.packageSnapshot.membership_terms,evidence:period});
  await assertFence();
  const checkout = snapshotStripeSdkData(await stripe.checkout.sessions.retrieve(period.checkout_session_id));
  check(checkout?.object === 'checkout.session' && checkout.id === period.checkout_session_id
    && checkout.status === 'complete' && checkout.payment_status === 'paid' && checkout.mode === 'subscription'
    && checkout.currency === 'usd' && checkout.livemode === period.livemode
    && id(checkout.customer) === period.customer_id && id(checkout.subscription) === period.subscription_id
    && id(checkout.invoice) === period.invoice_id, 'retail_admin_adapter_checkout_unknown');
  const current = snapshotStripeSdkData(funding.subscription);
  // Validate ACTUAL current SDK state before the old builder can fall back to
  // active. Never substitute original B for a newer current provider period.
  const subscription = { id: current?.id, customer: id(current?.customer), status: current?.status,
    current_period_end: current?.current_period_end, cancel_at_period_end: current?.cancel_at_period_end };
  check(current?.object === 'subscription' && subscription.status === geometry.initialSubscriptionStatus
    && subscription.cancel_at_period_end === false && Number.isSafeInteger(subscription.current_period_end)
    && subscription.current_period_end > 0 && subscription.current_period_end <= 253402300799
    && current.cancel_at == null && current.pause_collection == null
    && subscription.current_period_end === geometry.initialCoverageEndEpoch && subscription.id === period?.subscription_id
    && subscription.customer === period?.customer_id, 'retail_admin_adapter_subscription_unknown');
  if (subscription.current_period_end <= Date.now() / 1000) periodEnded();
  await assertFence();
  const saved = await row(db, 'membership_agreements', 'id', agreementId);
  const source = saved?.checkout_attempt_source;
  check(saved?.client_id === funding.clientId && saved.client_id === before.client_id
    && equal(source, before.checkout_attempt_source) && equal(saved.retail_funding_receipt, receipt)
    && saved.checkout_session_id === period.checkout_session_id
    && equal(saved.template_snapshot, funding.sourceTemplate) && saved.template_version === funding.sourceTemplateVersion
    && funding.agreementId === agreementId && funding.paidAt === period.paid_at
    && funding.checkoutSessionId === period.checkout_session_id && funding.customerId === period.customer_id,
  'retail_admin_adapter_source_unknown');
  // Lazy import preserves historical/no-op inspection without constructing a
  // hosted Supabase client. This is the SAME original pure payload builder.
  const { buildClientActivationPayload } = require('./publicPurchaseActivation');
  const initial = buildClientActivationPayload({ agreement: plain(saved), subscription: plain(current),
    planKey: funding.packageSnapshot.plan_key, billingInterval: funding.packageSnapshot.billing_cadence,
    packageSnapshot: funding.packageSnapshot, paidAt: funding.paidAt });
  await assertFence();
  const ack = await db.rpc('apply_retail_existing_admin_client', { p_agreement: agreementId, p_client: saved.client_id,
    p_source: plain(source), p_funding: plain(receipt), p_initial: initial, p_subscription: subscription });
  if (ack?.error?.message === 'retail_admin_client_paid_period_ended') periodEnded();
  if (['retail_admin_client_existing_state_conflict', 'retail_admin_client_source_denied',
    'retail_admin_client_owner_denied', 'retail_admin_client_subscription_denied',
    'retail_admin_client_payload_denied', 'retail_admin_client_trigger_drift'].includes(ack?.error?.message)) nativeConflict();
  check(ack && !ack.error && ack.data, 'retail_admin_adapter_ack_unknown');
  const result = snapshotStripeSdkData(ack.data);
  check(Object.keys(result).sort().join(',') === 'client_initial,status'
    && ['applied', 'already_applied'].includes(result.status) && equal(result.client_initial, initial),
  'retail_admin_adapter_ack_unknown');
  await assertFence();
  const read = await db.rpc('read_retail_existing_funding', { p_agreement: agreementId, p_client: saved.client_id,
    p_claim: null, p_source: plain(source) });
  check(read && !read.error && read.data, 'retail_admin_adapter_readback_unknown');
  const locked = snapshotStripeSdkData(read.data);
  check(Object.keys(locked).sort().join(',') === 'phase,receipt,version'
    && locked.version === 'retail_existing_funding_read_v1' && locked.phase === 'paid' && equal(locked.receipt, receipt),
  'retail_admin_adapter_readback_unknown');
  const after = await row(db, 'membership_agreements', 'id', agreementId);
  const linked = await row(db, 'public_purchase_intents', 'agreement_id', agreementId);
  const client = await row(db, 'clients', 'id', saved.client_id);
  check(!linked && after?.client_id === saved.client_id && equal(after.checkout_attempt_source, source)
    && equal(after.retail_funding_receipt, receipt) && equal(after.template_snapshot, saved.template_snapshot)
    && after.template_version === saved.template_version && after.is_current === true
    && ['signed', 'active'].includes(after.status) && !after.superseded_at && !after.superseded_by_agreement_id && !after.voided_at
    && after.checkout_status === 'paid' && new Date(after.checkout_paid_at).toISOString() === funding.paidAt
    && after.checkout_session_id === funding.checkoutSessionId && client?.id === saved.client_id
    && client.parent_client_id === null && client.archived_at === null, 'retail_admin_adapter_readback_unknown');
  const tuple = Object.fromEntries(Object.keys(initial).map(key => [key, client[key]]));
  for (const key of ['contract_start_at', 'contract_end_at', 'current_term_end']) {
    check(typeof tuple[key] === 'string' && Number.isFinite(Date.parse(tuple[key])), 'retail_admin_adapter_readback_unknown');
    tuple[key] = new Date(tuple[key]).toISOString();
  }
  check(equal(tuple, initial), 'retail_admin_adapter_readback_unknown');
  await assertFence();
  // A committed tuple is NOT rolled back by expiry during ACK/readback. Do not
  // retry it indefinitely; recurrence review is needed before this can resume.
  if (subscription.current_period_end <= Date.now() / 1000) periodEnded();
  return freeze({ status: result.status, clientInitial: plain(initial), funding,
    client_update_applied: true, billing_completion_required: true, membership_activation_required: true, credits_spendable: false });
}
async function applyExistingRetailAdminClient(options) {
  try { return await applyClient(options); }
  catch (e) {
    if (e?.code === 'public_purchase_activation_guard_lost'
      || typeof e?.code === 'string' && /^retail_admin_adapter_[a-z_]+$/.test(e.code) && e.message === e.code) throw e;
    // Never leak provider/DB credentials, URLs or underlying response text.
    fail();
  }
}
module.exports = { applyExistingRetailAdminClient };
