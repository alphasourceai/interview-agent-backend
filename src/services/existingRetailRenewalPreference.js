'use strict';

// Setting-only adapter for the existing subscription. Native operations live
// on the existing client row; original receipts still own access and money.
const { isDeepStrictEqual } = require('node:util');
const { snapshotStripeSdkData: snapshot } = require('./enterprisePoolPaymentProof');
const { readExistingRetailRecurringSource } = require('./existingRetailRecurringSource');
const { readExistingRetailRecurringCensus } = require('./existingRetailRecurringCensus');
const { anchoredMonthInstant, STRIPE_RECURRING_OFFER_VERSION } = require('./membershipOffers');
const { readRetailPackageOffer } = require('./membershipPackageCompatibility');

class RenewalError extends Error {
  constructor(code = 'retail_renewal_control_unknown', status = 503) {
    super(code); this.code = code; this.status = status;
  }
}
const check = value => { if (!value) throw new RenewalError('retail_renewal_control_denied', 409); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const epoch = value => Number.isSafeInteger(value) && value > 0 && value <= 253402300799;
const anchor = (b, months) => Date.parse(anchoredMonthInstant(new Date(b * 1000).toISOString(), months)) / 1000;

function renewalBillingCutoff(source, now = Date.now()) {
  const offer = readRetailPackageOffer(source?.package_snapshot);
  check(offer?.offer_version === STRIPE_RECURRING_OFFER_VERSION && Number.isFinite(now));
  const b = source.original_period.provider_period_start, n = offer.commitment_months;
  check(epoch(b));
  const original = new Date(b * 1000), current = new Date(now);
  let step = Math.max(1, Math.floor(((current.getUTCFullYear() - original.getUTCFullYear()) * 12
    + current.getUTCMonth() - original.getUTCMonth()) / n));
  check(step <= 1000);
  while (anchor(b, step * n) * 1000 <= now) { step++; check(step <= 1000); }
  return new Date(anchor(b, step * n) * 1000).toISOString();
}

function renewalSubscriptionProjection(raw, source) {
  const sub = snapshot(raw), p = source.original_period, offer = readRetailPackageOffer(source.package_snapshot);
  check(offer?.offer_version === STRIPE_RECURRING_OFFER_VERSION
    && sub?.object === 'subscription' && sub.id === p.subscription_id && sub.customer === p.customer_id
    && sub.livemode === p.livemode && sub.currency === 'usd' && sub.billing_cycle_anchor === p.provider_period_start
    && epoch(sub.current_period_start) && epoch(sub.current_period_end)
    && ['active', 'past_due', 'unpaid', 'canceled'].includes(sub.status) && typeof sub.cancel_at_period_end === 'boolean'
    && (sub.cancel_at === null || epoch(sub.cancel_at)) && (sub.canceled_at === null || epoch(sub.canceled_at))
    && sub.schedule === null && sub.pause_collection === null && sub.trial_start === null && sub.trial_end === null
    && sub.items?.object === 'list' && sub.items.has_more === false && sub.items.data?.length === 1
    && (sub.test_clock === null || (!sub.livemode && typeof sub.test_clock === 'string')));
  const item = sub.items.data[0], price = item.price;
  check(item.id === p.subscription_item_id && item.subscription === p.subscription_id && item.quantity === 1
    && price?.object === 'price' && price.id === p.price_id && price.currency === 'usd'
    && price.type === 'recurring' && price.unit_amount === offer.platform_payment_cents
    && price.recurring?.interval === 'month' && price.recurring.interval_count === offer.stripe_recurrence.interval_count
    && price.recurring.usage_type === 'licensed');
  const first = new Date(p.provider_period_start * 1000), start = new Date(sub.current_period_start * 1000);
  const offset = (start.getUTCFullYear() - first.getUTCFullYear()) * 12 + start.getUTCMonth() - first.getUTCMonth();
  check(offset >= 0 && offset % offer.stripe_recurrence.interval_count === 0
    && offset <= 12000 && anchor(p.provider_period_start, offset) === sub.current_period_start
    && anchor(p.provider_period_start, offset + offer.stripe_recurrence.interval_count) === sub.current_period_end);
  return snapshot({ subscription_id: sub.id, customer_id: sub.customer, livemode: sub.livemode,
    price_id: price.id, subscription_item_id: item.id, unit_amount: price.unit_amount,
    interval_count: price.recurring.interval_count, quantity: item.quantity, currency: sub.currency,
    billing_cycle_anchor: sub.billing_cycle_anchor, current_period_start: sub.current_period_start,
    current_period_end: sub.current_period_end, status: sub.status,
    cancel_at_period_end: sub.cancel_at_period_end, cancel_at: sub.cancel_at, test_clock: sub.test_clock });
}

async function native(db, source, action, extra = {}) {
  let response;
  try { response = snapshot(await db.rpc('change_retail_existing_renewal', {
    p_agreement: source.agreement_id, p_client: source.client_id, p_source: source, p_action: action,
    p_auto_renew: null, p_operation: null, p_generation: null, p_observation: null, ...extra
  })); } catch (_) { throw new RenewalError(); }
  if (!response || response.error || !response.data) throw new RenewalError();
  const r = response.data;
  check(['waiting', 'claimed', 'unknown', 'applied', 'held', 'none', 'busy'].includes(r.status));
  if (r.operation) check(uuid(r.operation.operation_id) && r.operation.source
    && isDeepStrictEqual(r.operation.source, snapshot(source)) && typeof r.operation.requested_auto_renew === 'boolean'
    && Number.isSafeInteger(r.operation.generation));
  return r;
}
async function sourceFor(input) {
  check(uuid(input.agreementId) && uuid(input.clientId));
  return readExistingRetailRecurringSource({ db: input.db, agreementId: input.agreementId, clientId: input.clientId });
}
function desired(sub, op) {
  return op.requested_auto_renew ? sub.status !== 'canceled' && sub.cancel_at_period_end === false && sub.cancel_at === null
    : sub.cancel_at_period_end === true && sub.cancel_at === Date.parse(op.billing_cutoff_at) / 1000;
}
function unchanged(before, after) {
  const keys = ['subscription_id', 'customer_id', 'livemode', 'price_id', 'subscription_item_id', 'unit_amount',
    'interval_count', 'quantity', 'currency', 'billing_cycle_anchor', 'current_period_start', 'current_period_end',
    'status', 'test_clock'];
  check(keys.every(k => before[k] === after[k]));
}

async function reconcileExistingRetailRenewal(input) {
  if (input.effectsEnabled !== true) return { status: 'disabled' };
  const source = await sourceFor(input), r = await native(input.db, source, 'read');
  if (!r.operation || ['applied', 'held'].includes(r.status)) return r;
  const { stripe, db } = input, op = r.operation;
  const api = () => check(stripe.getApiField('version') === '2023-10-16');
  const provider = async (fn, setting = false) => { api(); try { return await fn(); } catch (e) {
    const error = new RenewalError();
    error.knownRejection = setting && Number.isInteger(e?.statusCode) && e.statusCode >= 400 && e.statusCode < 500;
    throw error;
  } };
  const account = async () => {
    const a = snapshot(await provider(() => stripe.accounts.retrieve()));
    check(a?.object === 'account' && a.id === source.original_provider_account_id);
  };
  await account();
  const read = async () => renewalSubscriptionProjection(await provider(() => stripe.subscriptions.retrieve(
    source.original_period.subscription_id)), source);
  async function pendingItems() {
    const page = snapshot(await provider(() => stripe.invoiceItems.list({
      customer: source.original_period.customer_id, pending: true, limit: 100 })));
    check(page?.object === 'list' && page.has_more === false && Array.isArray(page.data) && page.data.length <= 100);
    const ids = new Set();
    return page.data.map(item => {
      check(item?.object === 'invoiceitem' && typeof item.id === 'string' && !ids.has(item.id)
        && item.proration === false && item.customer === source.original_period.customer_id
        && item.livemode === source.original_period.livemode && item.currency === 'usd' && Number.isSafeInteger(item.amount));
      ids.add(item.id); return { id: item.id, amount: item.amount, currency: item.currency };
    }).sort((a, b) => a.id.localeCompare(b.id));
  }
  let before = await read();
  check(isDeepStrictEqual(await sourceFor(input), source));
  const cutoff = Date.parse(op.billing_cutoff_at) / 1000;
  if (before.test_clock !== null) return native(db, source, 'hold', {
    p_operation: op.operation_id, p_generation: op.generation });
  // Waiting is a saved preference, never a premature cancellation of owed installments.
  if (before.current_period_end < cutoff) return r;
  const alreadyDesired = desired(before, op);
  if (before.status !== 'active' && !alreadyDesired) return r; // Waiting, not a provider send.
  if (before.current_period_end !== cutoff || (!alreadyDesired && cutoff * 1000 <= Date.now())
    || (before.cancel_at !== null && before.cancel_at !== cutoff)) return native(db, source, 'hold', {
    p_operation: op.operation_id, p_generation: op.generation
  });
  const claim = await native(db, source, 'claim', { p_operation: op.operation_id, p_generation: op.generation,
    p_observation: before });
  if (claim.status !== 'claimed') return claim;
  const current = claim.operation, args = { p_operation: current.operation_id, p_generation: current.generation };
  before = await read(); await account();
  check(isDeepStrictEqual(await sourceFor(input), source));
  unchanged(claim.operation.observation, before);
  const pendingBefore = await pendingItems();
  const censusBefore = await readExistingRetailRecurringCensus({ db, stripe,
    agreementId: source.agreement_id, clientId: source.client_id });
  // Lost ACK: observed exact setting is authoritative. Never mint another key.
  if (desired(before, current)) return native(db, source, 'finish', { ...args, p_observation: before });
  const armed = await native(db, source, 'send', { ...args, p_observation: before });
  if (armed.status !== 'claimed') return armed;
  try {
    const body = current.requested_auto_renew ? { cancel_at_period_end: false }
      : { cancel_at_period_end: true, proration_behavior: 'none' };
    const known = renewalSubscriptionProjection(await provider(() => stripe.subscriptions.update(
      source.original_period.subscription_id, body, { idempotencyKey: `retail-renewal:${current.operation_id}` }), true), source);
    unchanged(before, known);
    // A known response may leave an explicit cancel_at. Clearing is its own
    // fixed operation key, never a different request body under the first key.
    if (current.requested_auto_renew && known.cancel_at_period_end === false && known.cancel_at === cutoff) {
      const fresh = await read(); unchanged(before, fresh);
      check(fresh.current_period_end === cutoff && cutoff * 1000 > Date.now() && fresh.cancel_at === cutoff);
      await native(db, source, 'repair', { ...args, p_observation: fresh });
      const repaired = renewalSubscriptionProjection(await provider(() => stripe.subscriptions.update(
        source.original_period.subscription_id, { cancel_at: '' },
        { idempotencyKey: `retail-renewal:${current.operation_id}:clear-cancel-at` }), true), source);
      unchanged(before, repaired); check(desired(repaired, current));
    } else check(desired(known, current));
    const after = await read(); await account(); unchanged(before, after); check(desired(after, current));
    check(isDeepStrictEqual(await pendingItems(), pendingBefore));
    check(isDeepStrictEqual(await readExistingRetailRecurringCensus({ db, stripe,
      agreementId: source.agreement_id, clientId: source.client_id }), censusBefore));
    check(isDeepStrictEqual(await sourceFor(input), source));
    return await native(db, source, 'finish', { ...args, p_observation: after });
  } catch (error) {
    if (error.knownRejection === true) {
      // Known rejected request is held once; transport/commit loss is different.
      try { return await native(db, source, 'reject', { ...args, p_observation: before }); } catch (_) { throw new RenewalError(); }
    }
    // Provider or commit acknowledgement may be lost. Keep the same operation.
    try { await native(db, source, 'unknown', args); } catch (_) { /* lease remains */ }
    throw new RenewalError();
  }
}

async function requestExistingRetailRenewal(input) {
  check(typeof input.autoRenew === 'boolean');
  const source = await sourceFor(input);
  const r = await native(input.db, source, 'request', { p_auto_renew: input.autoRenew });
  return input.effectsEnabled === true ? reconcileExistingRetailRenewal(input) : r;
}

async function readExistingRetailRenewalSummary(input) {
  const source = await sourceFor(input), result = await native(input.db, source, 'read');
  const op = result.operation;
  // A completed renewal-on is a past setting operation, not a permanent
  // display anchor. Open/uncertain/off operations retain their stored cutoff.
  const completedOn = result.status === 'applied' && op?.requested_auto_renew === true;
  return {
    stripe_renewal_billing_cutoff_at: completedOn ? renewalBillingCutoff(source) : op?.billing_cutoff_at || renewalBillingCutoff(source),
    renewal_request_status: result.status,
    requested_auto_renew: op?.requested_auto_renew ?? null,
    renewal_requested_at: op?.requested_at ?? null
  };
}

module.exports = { renewalBillingCutoff, renewalSubscriptionProjection, requestExistingRetailRenewal,
  reconcileExistingRetailRenewal, readExistingRetailRenewalSummary };
