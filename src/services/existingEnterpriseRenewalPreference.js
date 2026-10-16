'use strict';

// Setting-only adapter over the EXISTING subscription and native consent
// journal. No invoice, receipt, payment, access, contract or pool writer.
const { createHash } = require('node:crypto');
const { isDeepStrictEqual, types: { isProxy } } = require('node:util');
const { snapshotStripeSdkData: snapshot } = require('./enterprisePoolPaymentProof');
const { readExistingEnterpriseCheckoutScope } = require('./existingEnterpriseCheckoutFunding');
const { collect } = require('./existingRetailCheckoutFunding');
const { anchoredMonthInstant } = require('./membershipOffers');
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const id = (v, prefix) => typeof v === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,250}$`).test(v);
const epoch = v => Number.isSafeInteger(v) && v > 0 && v <= 253402300799;
const statuses = ['none', 'waiting', 'claimed', 'busy', 'unknown', 'held', 'applied'];
class RenewalError extends Error {
  constructor() { super('enterprise_renewal_control_unverified'); this.code = this.message; this.status = 503; }
}
const check = v => { if (!v) throw new RenewalError(); };
function inputFields(input, extra = []) {
  check(input && typeof input === 'object' && !isProxy(input)
    && [Object.prototype, null].includes(Object.getPrototypeOf(input)));
  const d = Object.getOwnPropertyDescriptors(input), required = ['db', 'agreementId', 'clientId', ...extra];
  check(Reflect.ownKeys(d).every(k => [...required, 'stripe', 'effectsEnabled'].includes(k))
    && required.every(k => d[k]) && Object.values(d).every(v => v.enumerable && Object.hasOwn(v, 'value')));
  const result = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.value]));
  check(uuid(result.agreementId) && uuid(result.clientId)
    && (result.effectsEnabled === undefined || typeof result.effectsEnabled === 'boolean'));
  return result;
}
async function sourceFor(input) {
  const n = await readExistingEnterpriseCheckoutScope({ db: input.db, agreementId: input.agreementId });
  check(n?.a?.id === input.agreementId && n.a.client_id === input.clientId && n.client.id === input.clientId
    && n.a.checkout_status === 'paid' && n.billingReceipt);
  return n.billingReceipt;
}
async function native(input, source, action, extra = {}, advance = false) {
  const result = snapshot(await input.db.rpc(advance ? 'advance_enterprise_existing_renewal' : 'change_enterprise_existing_renewal', {
    p_agreement: input.agreementId, p_client: input.clientId, p_billing: source, p_action: action,
    ...(advance ? {} : { p_auto_renew: null }), ...extra
  }));
  check(result && !result.error && statuses.includes(result.data?.status));
  const r = result.data, op = r.operation;
  check(r.provider_effect_authorized === false && r.paid_access_authorized === false && r.payroll_authorized === false);
  if (op) check(uuid(op.operation_id) && isDeepStrictEqual(op.source, snapshot(source))
    && ['enterprise_existing_renewal_change_v1', 'enterprise_existing_renewal_change_v2'].includes(op.version)
    && typeof op.requested_auto_renew === 'boolean' && Number.isSafeInteger(op.generation) && op.generation >= 0
    && Number.isFinite(Date.parse(op.effective_at)) && Number.isFinite(Date.parse(op.accepted_at)));
  return r;
}
// Stable JSON, not PostgreSQL's source digest. Only the complete provider GET
// census uses this SHA256. The native billing-source MD5 stays opaque.
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  check(v !== undefined); return JSON.stringify(v);
}
function subscription(raw, w, op) {
  const sub = snapshot(raw), p = w.funding_receipt.proof, item = sub?.items?.data?.[0], price = item?.price;
  check(sub?.object === 'subscription' && sub.id === p.subscription_id && sub.customer === p.customer_id
    && sub.livemode === p.livemode && sub.currency === 'usd' && sub.collection_method === 'charge_automatically'
    && ['active', 'past_due', 'unpaid', 'canceled'].includes(sub.status) && typeof sub.cancel_at_period_end === 'boolean'
    && (sub.cancel_at === null || epoch(sub.cancel_at)) && sub.billing_cycle_anchor === w.subscription.current_period_end
    && sub.schedule === null && sub.pause_collection === null && sub.trial_start === null && sub.trial_end === null && sub.test_clock === null
    && sub.items?.object === 'list' && sub.items.has_more === false && Array.isArray(sub.items.data) && sub.items.data.length === 1
    && item.object === 'subscription_item' && item.id === p.platform_item_id && item.subscription === p.subscription_id && item.quantity === 1
    && price?.object === 'price' && price.id === p.platform_price_id && price.livemode === p.livemode && price.currency === 'usd'
    && price.unit_amount === p.platform_nominal_cents && price.type === 'recurring' && price.billing_scheme === 'per_unit'
    && price.transform_quantity === null && price.tiers_mode === null && price.custom_unit_amount === null
    && price.recurring?.interval === p.platform_interval && price.recurring.interval_count === 1 && price.recurring.usage_type === 'licensed');
  const start = sub.current_period_start, end = sub.current_period_end, anchor = sub.billing_cycle_anchor;
  check(epoch(start) && epoch(end) && end > start && start * 1000 <= Date.now());
  if (start < anchor) {
    // The original partial Checkout period is never a cancellation-send
    // window. Keep a timely saved preference waiting for the first full cycle.
    check(end === anchor && sub.cancel_at === null && sub.cancel_at_period_end === false
      && start <= Date.parse(p.payment_success_at) / 1000);
    return { initial: true, sub };
  }
  const a = new Date(anchor * 1000), s = new Date(start * 1000), span = p.platform_interval === 'month' ? 1 : 12;
  const offset = (s.getUTCFullYear() - a.getUTCFullYear()) * 12 + s.getUTCMonth() - a.getUTCMonth();
  check(['month', 'year'].includes(p.platform_interval) && offset >= 0 && offset % span === 0 && offset / span <= 999
    && Date.parse(anchoredMonthInstant(a.toISOString(), offset)) === start * 1000);
  const fullEnd = Date.parse(anchoredMonthInstant(a.toISOString(), offset + span)) / 1000;
  const cutoff = Date.parse(op.effective_at) / 1000;
  const owned = (!op.requested_auto_renew && op.sent_at !== null) || uuid(op.provider_cancel_operation_id);
  check(sub.cancel_at === null ? end === fullEnd : owned && sub.cancel_at === cutoff && end === cutoff);
  // A period-end cancellation at a different boundary is foreign too.
  check(!sub.cancel_at_period_end || sub.cancel_at === cutoff && end === cutoff);
  return { sub, fullEnd, projection: snapshot({ subscription_id: sub.id, customer_id: sub.customer, livemode: sub.livemode,
    currency: sub.currency, price_id: price.id, subscription_item_id: item.id, unit_amount: price.unit_amount,
    interval: price.recurring.interval, quantity: 1, billing_cycle_anchor: anchor, current_period_start: start,
    current_period_end: end, status: sub.status, cancel_at_period_end: sub.cancel_at_period_end, cancel_at: sub.cancel_at,
    test_clock: sub.test_clock, schedule: sub.schedule, pause_collection: sub.pause_collection, trial_start: sub.trial_start, trial_end: sub.trial_end }) };
}
function desired(o, op) {
  const sub = o.subscription;
  return op.requested_auto_renew ? sub.status !== 'canceled' && sub.cancel_at === null && sub.cancel_at_period_end === false
    : sub.cancel_at === Date.parse(op.effective_at) / 1000;
}
function sameCensus(a, b) {
  check(a.census_digest === b.census_digest && isDeepStrictEqual(a.invoice, b.invoice)
    && isDeepStrictEqual(snapshot({ ...a.subscription, cancel_at: null, cancel_at_period_end: false, current_period_end: null }),
      snapshot({ ...b.subscription, cancel_at: null, cancel_at_period_end: false, current_period_end: null })));
}
function providerReader(stripe, source) {
  const p = source.funding_receipt.proof;
  const api = () => check(stripe?.getApiField?.('version') === '2023-10-16');
  const get = async fn => { api(); const v = snapshot(await fn()); api(); return v; };
  const pages = fn => collect(after => get(() => fn({ limit: 100, ...(after ? { starting_after: after } : {}) })), async () => api());
  const account = async () => { const a = await get(() => stripe.accounts.retrieve()); check(a?.object === 'account' && a.id === p.provider_account_id); };
  // Complete bounded financial census, NOT the Retail chronology-only census.
  // Keep ALL invoice/line/pending amounts, balances, discounts, taxes, credits,
  // payment identities and refund graphs in the digest. No financial writes.
  async function census() {
    const invoices = await pages(args => stripe.invoices.list({ customer: p.customer_id, ...args }));
    check(invoices.data.length <= 1000);
    const rows = [];
    for (const listed of invoices.data) {
      check(id(listed.id, 'in'));
      const invoice = await get(() => stripe.invoices.retrieve(listed.id));
      check(invoice?.object === 'invoice' && invoice.id === listed.id && invoice.customer === p.customer_id
        && invoice.livemode === p.livemode && typeof invoice.currency === 'string');
      const lines = await pages(args => stripe.invoices.listLineItems(invoice.id, args));
      const payments = {};
      if (invoice.payment_intent !== null) {
        check(id(invoice.payment_intent, 'pi'));
        payments.intent = await get(() => stripe.paymentIntents.retrieve(invoice.payment_intent));
        check(payments.intent?.object === 'payment_intent' && payments.intent.id === invoice.payment_intent
          && payments.intent.customer === p.customer_id && payments.intent.livemode === p.livemode);
      }
      if (invoice.charge !== null) {
        check(id(invoice.charge, 'ch'));
        payments.charge = await get(() => stripe.charges.retrieve(invoice.charge));
        check(payments.charge?.object === 'charge' && payments.charge.id === invoice.charge
          && payments.charge.customer === p.customer_id && payments.charge.livemode === p.livemode);
        payments.refunds = (await pages(args => stripe.refunds.list({ charge: invoice.charge, ...args }))).data.sort((a,b) => a.id.localeCompare(b.id));
      }
      rows.push({ invoice, lines: lines.data.sort((a,b) => a.id.localeCompare(b.id)), payments });
    }
    const pending = await pages(args => stripe.invoiceItems.list({ customer: p.customer_id, pending: true, ...args }));
    for (const item of pending.data) check(item.object === 'invoiceitem' && item.customer === p.customer_id
      && item.livemode === p.livemode && item.proration === false && Number.isSafeInteger(item.amount));
    rows.sort((a,b) => a.invoice.id.localeCompare(b.invoice.id)); pending.data.sort((a,b) => a.id.localeCompare(b.id));
    return { rows, digest: createHash('sha256').update(canonical({ rows, pending: pending.data })).digest('hex') };
  }
  async function observe(op) {
    await account();
    const before = await get(() => stripe.subscriptions.retrieve(p.subscription_id));
    const s = subscription(before, source, op);
    if (s.initial) {
      check(isDeepStrictEqual(before, await get(() => stripe.subscriptions.retrieve(p.subscription_id))));
      await account(); return null;
    }
    const c = await census();
    check(isDeepStrictEqual(before, await get(() => stripe.subscriptions.retrieve(p.subscription_id))));
    await account();
    const candidates = c.rows.flatMap(row => row.lines.filter(l => l.price?.id === p.platform_price_id
      && l.subscription === p.subscription_id && l.subscription_item === p.platform_item_id
      && l.period?.start === s.projection.current_period_start && l.period?.end === s.fullEnd).map(line => ({ ...row, line })));
    check(candidates.length === 1);
    const { invoice: i, line: l } = candidates[0];
    check(i.subscription === p.subscription_id && i.currency === 'usd' && ['open', 'paid'].includes(i.status)
      && epoch(i.status_transitions?.finalized_at) && i.status_transitions.finalized_at * 1000 <= Date.now()
      && l.object === 'line_item' && id(l.id, 'il') && l.type === 'subscription' && l.proration === false
      && l.quantity === 1 && l.currency === 'usd' && l.amount === p.platform_nominal_cents
      && l.price.unit_amount === p.platform_nominal_cents);
    // Only setting fields that this operation is allowed to change are omitted
    // from the financial fence. All other subscription economics must survive.
    const economics = { ...before };
    for (const key of ['cancel_at', 'cancel_at_period_end', 'current_period_end', 'canceled_at', 'cancellation_details']) delete economics[key];
    const digest = createHash('sha256').update(canonical({ census: c.digest, subscription: economics })).digest('hex');
    return snapshot({ version: 'enterprise_existing_renewal_observation_v1', provider_account_id: p.provider_account_id,
      subscription: s.projection, invoice: { id: i.id, subscription_id: i.subscription, customer_id: i.customer,
        livemode: i.livemode, currency: i.currency, price_id: l.price.id, subscription_item_id: l.subscription_item,
        unit_amount: l.amount, quantity: l.quantity, period_start: l.period.start, period_end: l.period.end,
        status: i.status, finalized_at: i.status_transitions.finalized_at }, census_digest: digest, observed_at: new Date(Date.now()).toISOString() });
  }
  return { get, observe };
}
async function reconcileExistingEnterpriseRenewal(raw) {
  const input = inputFields(raw);
  if (input.effectsEnabled !== true) return { status: 'disabled' };
  const source = await sourceFor(input), r = await native(input, source, 'read');
  if (!r.operation || ['applied', 'held'].includes(r.status)) return r;
  const op = r.operation, p = source.funding_receipt.proof, reader = providerReader(input.stripe, source);
  const checkSource = async () => check(isDeepStrictEqual(source, await sourceFor(input)));
  const args = operation => ({ p_operation: operation.operation_id, p_generation: operation.generation, p_observation: null });
  let observation;
  try { observation = await reader.observe(op); await checkSource(); }
  catch (_) { throw new RenewalError(); } // Never claim/send from incomplete GETs.
  if (observation === null) return r;
  const cutoff = Date.parse(op.effective_at) / 1000;
  if (!epoch(cutoff)) return native(input, source, 'hold', args(op), true);
  // Native Stripe billing schedule: defer cancellation until E is inside the
  // current full billed period. Never forgive the remaining installments.
  const fullEnd = observation.invoice.period_end;
  if (fullEnd < cutoff) return r;
  if (observation.subscription.current_period_start >= cutoff) return native(input, source, 'hold', args(op), true);
  const claim = await native(input, source, 'claim', { ...args(op), p_observation: observation }, true);
  if (claim.status !== 'claimed') return claim;
  const current = claim.operation, claimObservation = current.observation;
  const advance = (action, obs) => native(input, source, action, { ...args(current), p_observation: obs }, true);
  let armed = false;
  try {
    const fresh = await reader.observe(current); sameCensus(claimObservation, fresh); await checkSource();
    if (desired(fresh, current)) return await advance('finish', fresh);
    const reserved = await advance('send', fresh);
    if (reserved.status !== 'claimed' || !reserved.operation.sent_at) return reserved;
    armed = true;
    const send = async (body, suffix = '') => {
      check(input.stripe.getApiField('version') === '2023-10-16');
      try {
        await input.stripe.subscriptions.update(p.subscription_id, body,
          { idempotencyKey: `enterprise-renewal:${current.operation_id}${suffix}`, maxNetworkRetries: 0 });
      } catch (e) {
        const error = new RenewalError();
        error.knownRejection = Number.isInteger(e?.statusCode) && e.statusCode >= 400 && e.statusCode < 500;
        throw error;
      }
    };
    await send(current.requested_auto_renew ? { cancel_at_period_end: false }
      : { cancel_at: cutoff, proration_behavior: 'none' });
    let after = await reader.observe(reserved.operation); sameCensus(claimObservation, after); await checkSource();
    if (current.requested_auto_renew && !desired(after, current)) {
      check(after.subscription.cancel_at_period_end === false && after.subscription.cancel_at === cutoff
        && uuid(current.provider_cancel_operation_id));
      const repair = await advance('repair', after);
      check(repair.status === 'claimed' && repair.operation.repair_sent_at);
      await send({ cancel_at: '', proration_behavior: 'none' }, ':clear-cancel-at');
      after = await reader.observe(repair.operation); sameCensus(claimObservation, after); await checkSource();
    }
    check(desired(after, current));
    return await advance('finish', after);
  } catch (error) {
    if (armed) {
      // Transport/commit loss never retries the SDK or invents another key.
      // Native requires the ORIGINAL claim observation, not the changed GET.
      try { await advance(error.knownRejection ? 'reject' : 'unknown', claimObservation); } catch (_) { /* lease remains */ }
    }
    throw new RenewalError();
  }
}
async function requestExistingEnterpriseRenewal(raw) {
  const input = inputFields(raw, ['autoRenew']); check(typeof input.autoRenew === 'boolean');
  const source = await sourceFor(input), r = await native(input, source, 'request', { p_auto_renew: input.autoRenew });
  // Busy or a deadline hold means this preference was NOT accepted. Do not
  // reconcile an older operation and overwrite this request's rejection.
  if (['busy', 'held'].includes(r.status) || input.effectsEnabled !== true) return r;
  const { autoRenew, ...reconcile } = input;
  return reconcileExistingEnterpriseRenewal(reconcile);
}
async function readExistingEnterpriseRenewalSummary(raw) {
  const input = inputFields(raw), source = await sourceFor(input), r = await native(input, source, 'read'), op = r.operation;
  const completedOn = r.status === 'applied' && op?.requested_auto_renew === true;
  check(Number.isFinite(Date.parse(r.legal_term_end)) && Number.isFinite(Date.parse(r.notice_cutoff_at)));
  return { stripe_renewal_billing_cutoff_at: completedOn ? r.legal_term_end : op?.effective_at || r.legal_term_end,
    renewal_notice_cutoff_at: completedOn ? r.notice_cutoff_at : op?.notice_cutoff_at || r.notice_cutoff_at,
    renewal_request_status: r.status, requested_auto_renew: op?.requested_auto_renew ?? null,
    renewal_requested_at: op?.accepted_at ?? null };
}
module.exports = { reconcileExistingEnterpriseRenewal, requestExistingEnterpriseRenewal, readExistingEnterpriseRenewalSummary };
