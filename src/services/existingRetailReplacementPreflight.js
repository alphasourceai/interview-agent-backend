'use strict';
// UNMOUNTED provider GET-only observation + existing pending journal. This
// neither authorizes nor executes cancellation, billing, access or recovery.
const { isDeepStrictEqual, types } = require('node:util');
const { snapshotStripeSdkData: snap, snapshotEnterpriseUsageCensusData: contractSnapshot } = require('./enterprisePoolPaymentProof');
const { readExistingRetailFundingReceipt } = require('./existingRetailFundingReplay');
const { readSavedRetailCheckoutTerms } = require('./savedMembershipCheckoutTerms');
const { collect, verifyExistingRetailFunding } = require('./existingRetailCheckoutFunding');
const {retailInitialEvidenceGeometry,GENERATION_DATE_OFFER_VERSION}=require('./membershipOffers');
const plain = v => JSON.parse(JSON.stringify(v));
const equal = (a, b) => a === undefined || b === undefined ? a === b : isDeepStrictEqual(contractSnapshot(a), contractSnapshot(b));
const id = v => typeof v === 'string' ? v : v?.id;
class Hold extends Error {
  constructor(suffix) { super('retail_replacement_preflight_' + suffix); this.code = this.message; this.status = 503; }
}
const fail = suffix => { throw new Hold(suffix); };
const check = (v, suffix = 'unknown') => { if (!v) fail(suffix); };
const closed = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const epoch = n => Number.isSafeInteger(n) && n > 0 && n <= 253402300799;
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function stamp(v) {
  check(typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v), 'ack_unknown');
  const t = Date.parse(v);
  check(Number.isFinite(t) && new Date(t).toISOString() === v.replace(/(\.\d{3})\d{3}Z$/, '$1Z') && t <= Date.now(), 'ack_unknown');
  return t;
}
function current(s, b,offer) {
  const geometry=retailInitialEvidenceGeometry({offer,evidence:b});
  check(s?.object === 'subscription' && s.id === b.subscription_id && id(s.customer) === b.customer_id
    && s.currency === 'usd' && s.livemode === b.livemode && s.status === geometry.initialSubscriptionStatus
    && epoch(s.current_period_end) && s.current_period_end === geometry.initialCoverageEndEpoch
    && s.current_period_end > Date.now() / 1000 && s.cancel_at_period_end === false
    && Object.hasOwn(s, 'cancel_at') && s.cancel_at === null
    && Object.hasOwn(s, 'pause_collection') && s.pause_collection === null, 'current_unknown');
  // Preserve legacy current() admission exactly. Only the new schedule needs
  // these additional checks; do not retroactively constrain accepted sources.
  if(geometry.generation)check(s.current_period_start===b.provider_trial_start&&s.trial_start===b.provider_trial_start
    && s.trial_end===b.provider_trial_end&&s.billing_cycle_anchor===b.provider_trial_end&&s.schedule===null,'current_unknown');
  return { id: s.id, customer: id(s.customer), status: s.status, current_period_end: s.current_period_end,
    cancel_at_period_end: s.cancel_at_period_end, cancel_at: s.cancel_at, pause_collection: s.pause_collection };
}
async function prepare(options) {
  const { db, stripe, agreementId, claimKey = null, assertFence = async () => {} } = options;
  const api = () => check(typeof stripe?.getApiField === 'function' && stripe.getApiField('version') === '2023-10-16', 'api_mismatch');
  api();
  const trace = [];
  // Preserve the original configured transport and native helper. Capture its
  // real whole read envelopes; never fabricate a phase from an agreement row.
  const readDb = { from: (...args) => db.from(...args), async rpc(name, args) {
    check(name === 'read_retail_existing_funding', 'read_unknown');
    const r = await db.rpc(name, args); check(r && !r.error, 'read_unknown');
    const data = snap(r.data);
    check(closed(data, ['phase', 'receipt', 'version']) && ['pending', 'paid'].includes(data.phase)
      && data.version === 'retail_existing_funding_read_v1', 'read_unknown');
    trace.push(data); return { data, error: null };
  } };
  async function read() {
    const r = await readExistingRetailFundingReceipt({ ...options, db: readDb, claimKey });
    check(r?.native_receipt_required === true && r.funding?.receiptReplay === true, 'source_unknown');
    return contractSnapshot(r);
  }
  async function row(table, key, value) {
    await assertFence(); const r = await db.from(table).select('*').eq(key, value).maybeSingle();
    check(r && !r.error, 'source_unknown'); return contractSnapshot(r.data);
  }
  async function get(call) { api(); await assertFence(); const v = snap(await call()); api(); return v; }
  const first = await read();
  check(trace.length === 2 && equal(trace[0], trace[1]), 'read_changed');
  const a = await row('membership_agreements', 'id', agreementId);
  const i = await row('public_purchase_intents', 'agreement_id', agreementId);
  const f = first.funding, p = first.receipt?.proof, b = p?.period;
  check(a?.id === agreementId && f.agreementId === agreementId && a.client_id === f.clientId
    && (i?.id || null) === f.sourceIntentId && equal(a.retail_funding_receipt, first.receipt)
    && equal(a.template_snapshot, f.sourceTemplate) && a.template_version === f.sourceTemplateVersion, 'source_unknown');
  const terms = readSavedRetailCheckoutTerms({ agreement: plain(a), intent: i ? plain(i) : null, deadlineMode: 'stored' });
  check(terms && equal(terms.packageSnapshot, f.packageSnapshot), 'source_unknown');
  const generation=terms.offer.offer_version===GENERATION_DATE_OFFER_VERSION;
  function evidence(value){const selected=generation?'initialProviderSchedule':'initialProviderPeriod',other=generation?'initialProviderPeriod':'initialProviderSchedule';
    check(!Object.hasOwn(value,other)&&value[selected]?.version===(generation?'retail_generation_initial_schedule_v1':'retail_initial_provider_period_v1'),
      'source_unknown');return value[selected];}
  check(equal(evidence(f),b),'source_unknown');
  const checkout = await get(() => stripe.checkout.sessions.retrieve(b.checkout_session_id));
  check(checkout?.object === 'checkout.session' && checkout.id === b.checkout_session_id && checkout.mode === 'subscription'
    && checkout.status === 'complete' && checkout.payment_status === 'paid' && checkout.currency === 'usd'
    && checkout.livemode === b.livemode && id(checkout.customer) === b.customer_id
    && id(checkout.subscription) === b.subscription_id && (!id(checkout.invoice) || id(checkout.invoice) === b.invoice_id), 'checkout_unknown');
  const subscription = await get(() => stripe.subscriptions.retrieve(b.subscription_id));
  const initialCurrent = current(subscription, b,terms.offer);
  const invoice = await get(() => stripe.invoices.retrieve(b.invoice_id));
  const checkoutLines = snap(await collect(after => get(() => stripe.checkout.sessions.listLineItems(b.checkout_session_id,
    { limit: 100, ...(after ? { starting_after: after } : {}) })), assertFence));
  const invoiceLines = snap(await collect(after => get(() => stripe.invoices.listLineItems(b.invoice_id,
    { limit: 100, ...(after ? { starting_after: after } : {}) })), assertFence));
  const subscriptionItems = snap(await collect(after => get(() => stripe.subscriptionItems.list(
    { subscription: b.subscription_id, limit: 100, ...(after ? { starting_after: after } : {}) })), assertFence));
  const paymentIntent = await get(() => stripe.paymentIntents.retrieve(p.payment_intent_id));
  const charge = await get(() => stripe.charges.retrieve(p.charge_id));
  // Reuse the ORIGINAL monetary validator, distinct from historical replay.
  let proof;
  try { proof = snap(verifyExistingRetailFunding({ offer: plain(terms.offer), checkout, checkoutLines, subscription,
    subscriptionItems, invoice, invoiceLines, paymentIntent, charge, expected: { checkoutId: b.checkout_session_id,
      customerId: b.customer_id, signedAt: a.signed_at, agreementDeadline: a.agreement_expires_at, intentDeadline: i?.expires_at,
      ...(terms.offer.offer_version===GENERATION_DATE_OFFER_VERSION?{subscriptionId:b.subscription_id,eventLivemode:b.livemode,
        generatedAt:a.template_snapshot.generated_at,initialTermStart:a.initial_term_start,initialRenewalDate:a.initial_renewal_date,
        prices:a.retail_checkout_prices}:{}) } }));
  } catch (_) { fail('cash_unknown'); }
  const fields = { paymentIntentId: 'payment_intent_id', chargeId: 'charge_id', checkoutCreatedEpoch: 'checkout_created',
    invoiceCreatedEpoch: 'invoice_created', platformGrossCents: 'platform_gross_cents', platformDiscountCents: 'platform_discount_cents',
    platformNetCents: 'platform_net_cents', roleGrossCents: 'role_gross_cents', roleDiscountCents: 'role_discount_cents',
    roleNetCents: 'role_net_cents', taxCents: 'tax_cents', cashCents: 'cash_cents' };
  check(proof.paidAt === b.paid_at && proof.invoiceId === b.invoice_id && equal(evidence(proof), b)
    && Object.entries(fields).every(([k, v]) => proof[k] === p[v]), 'cash_changed');
  async function reserve(projected) {
    api(); await assertFence(); const r = await db.rpc('reserve_retail_existing_replacement_cancel', {
      p_agreement: agreementId, p_intent: f.sourceIntentId, p_claim: claimKey, p_current: projected });
    check(r && !r.error, 'ack_unknown'); const v = snap(r.data);
    check(closed(v, ['status', 'request', 'created_at']), 'ack_unknown');
    if (a.replaces_stripe_subscription_id == null) {
      check(a.replacement_policy == null && v.status === 'no_replacement' && v.request === null && v.created_at === null, 'ack_unknown');
    } else {
      const q = v.request;
      check(['reserved', 'existing'].includes(v.status) && closed(q, ['version', 'api_version', 'agreement_id', 'client_id', 'intent_id',
        'source_digest', 'funding_receipt_digest', 'provider_account_id', 'livemode', 'customer_id', 'old_subscription_id', 'new_subscription_id', 'cancellation'])
        && q.version === 'retail_existing_replacement_cancel_v1' && q.api_version === '2023-10-16'
        && q.agreement_id === a.id && q.client_id === a.client_id && q.intent_id === f.sourceIntentId
        && q.provider_account_id === p.provider_account_id && q.livemode === b.livemode && q.customer_id === b.customer_id
        && /^sub_[A-Za-z0-9_]{1,250}$/.test(q.old_subscription_id) && q.old_subscription_id === a.replaces_stripe_subscription_id
        && q.old_subscription_id !== b.subscription_id && q.new_subscription_id === b.subscription_id
        && typeof q.source_digest === 'string' && /^[a-f0-9]{64}$/.test(q.source_digest)
        && typeof q.funding_receipt_digest === 'string' && /^[a-f0-9]{64}$/.test(q.funding_receipt_digest)
        && a.replacement_policy === 'immediate_cancel' && equal(q.cancellation, { method: 'DELETE', path: '/v1/subscriptions/' + q.old_subscription_id,
          parameters: { invoice_now: false, prorate: false }, policy: 'immediate_cancel' }), 'ack_unknown');
      check(stamp(v.created_at) >= Date.parse(first.receipt.recorded_at), 'ack_unknown');
    }
    return v;
  }
  const reservation = await reserve(initialCurrent);
  let old = null;
  if (reservation.request) {
    const q = reservation.request, s = await get(() => stripe.subscriptions.retrieve(q.old_subscription_id));
    check(s?.object === 'subscription' && s.id === q.old_subscription_id && id(s.customer) === q.customer_id
      && s.currency === 'usd' && s.livemode === q.livemode
      && ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused'].includes(s.status)
      && (s.canceled_at == null || epoch(s.canceled_at) && s.canceled_at <= Math.floor(Date.now() / 1000))
      && (s.status !== 'canceled' || epoch(s.canceled_at)), 'old_unknown');
    old = { id: s.id, customer: id(s.customer), currency: s.currency, livemode: s.livemode, status: s.status, canceled_at: s.canceled_at ?? null };
  }
  const last = await read();
  check(trace.length === 4 && trace.every(v => equal(v, trace[0])) && equal(last.receipt, first.receipt)
    && ['agreementId', 'clientId', 'sourceIntentId', 'sourceTemplateVersion'].every(k => last.funding[k] === f[k])
    && equal(last.funding.sourceTemplate, f.sourceTemplate) && equal(last.funding.packageSnapshot, f.packageSnapshot)
    && equal(evidence(last.funding),evidence(f))
    && equal(last.funding.sourceCheckoutPrices,f.sourceCheckoutPrices), 'read_changed');
  const finalCurrent = current(last.funding.subscription, b,terms.offer), finalReservation = await reserve(finalCurrent);
  check(finalReservation.status === (reservation.request ? 'existing' : 'no_replacement')
    && equal(finalReservation.request, reservation.request) && finalReservation.created_at === reservation.created_at, 'ack_changed');
  await assertFence(); api();
  return freeze({ status: reservation.request ? 'preflight_verified' : 'no_replacement', request: plain(reservation.request),
    created_at: reservation.created_at, new_subscription: finalCurrent, old_subscription: old, effect_authorized: false, native_completion: false });
}
async function prepareExistingRetailReplacement(options) {
  try { return await prepare(options); } catch (e) {
    if (!types.isProxy(e) && e instanceof Hold) throw new Hold(e.code.replace('retail_replacement_preflight_', ''));
    if (e && !types.isProxy(e) && Object.getOwnPropertyDescriptor(e, 'code')?.value === 'public_purchase_activation_guard_lost') {
      const clean = new Error('public_purchase_activation_guard_lost'); clean.code = clean.message; clean.status = 503; throw clean;
    }
    fail('unknown'); // Never echo provider, database, URL, token or source detail.
  }
}
module.exports = { prepareExistingRetailReplacement };
