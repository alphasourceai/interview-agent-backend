'use strict';

// LOCAL/UNMOUNTED: request construction and read-only authenticated-SDK census.
// No invoice/item/finalize/pay call, DB write, access, payroll or recipient effect.
// Native batch/leaf CAS must separately authorize each exact persisted request.
const { isDeepStrictEqual } = require('node:util');
const { snapshotStripeSdkData: sdk, snapshotEnterpriseUsageCensusData: native } = require('./enterprisePoolPaymentProof');
const { planEnterpriseExistingUsage } = require('./enterpriseExistingUsageReservation');
const { usageOperationKey, normalizeRoleStatus } = require('./usageBilling');
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const id = (v, prefix) => typeof v === 'string' && v.length <= 255 && new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(v);
const cents = n => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647;
const epoch = n => Number.isSafeInteger(n) && n > 0 && n <= 253402300799;
const empty = v => v === null || (Array.isArray(v) && v.length === 0);
function held() { throw Object.assign(new Error('enterprise_usage_invoice_held'), { code: 'enterprise_usage_invoice_held', status: 409 }); }
function check(v) { if (!v) held(); }
function clean(v, copier = sdk) { try { return copier(v); } catch (_) { held(); } }
function text(v) { check(typeof v === 'string' && v.trim().length > 0 && v.length <= 1000); return v; }
function period(s) {
  const start = Date.parse(s.month_start) / 1000, end = Date.parse(s.month_end) / 1000;
  check(epoch(start) && epoch(end) && end > start); return { start, end };
}

function usageInvoiceBinding(raw) {
  const b = clean(raw, native), s = b.snapshot;
  check(b.phase === 'reserved' && UUID.test(b.id) && UUID.test(b.owner_id) && UUID.test(b.agreement_id)
    && id(b.account_id, 'acct') && typeof b.livemode === 'boolean' && id(b.customer_id, 'cus')
    && id(b.subscription_id, 'sub') && /^[a-f0-9]{64}$/.test(b.snapshot_digest)
    && s?.owner_id === b.owner_id && s.agreement_id === b.agreement_id
    && s.month_start.slice(0, 10) === b.service_month && Number.isSafeInteger(b.generation) && b.generation > 0);
  const p = s.receipt?.funding_receipt?.proof, initial = s.receipt?.client_initial;
  check(p?.provider_account_id === b.account_id && p.livemode === b.livemode
    && initial?.stripe_customer_id === b.customer_id && initial.stripe_subscription_id === b.subscription_id
    && s.receipt.plan_initial.usage_interview_fee_cents === b.unit_price_cents);
  let plan; try { plan = planEnterpriseExistingUsage(s); } catch (_) { held(); }
  check(!plan.no_usage && isDeepStrictEqual(clean(plan.groups, native), b.groups)
    && isDeepStrictEqual(clean(plan.prefix, native), b.prefix));
  const roles = new Map(s.roles.map(r => [r.id, r])), clients = new Map(s.clients.map(c => [c.id, c]));
  const groups = b.groups.map(g => {
    const role = roles.get(g.role_id), client = clients.get(role?.client_id);
    check(role && client && cents(g.amount_cents) && g.amount_cents > 0);
    const label = role.client_id === b.owner_id ? null : text(client.entity_label || client.name);
    const month = new Date(s.month_start).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const title = text(role.title), status = normalizeRoleStatus(text(role.status));
    return { ...g, description: label ? `Interviews — ${label} · ${title} [${status}] (${month})`
      : `Interviews — ${title} [${status}] (${month})` };
  }).sort((a, c) => a.role_id.localeCompare(c.role_id));
  const total = groups.reduce((sum, g) => sum + g.amount_cents, 0); check(cents(total) && total > 0);
  return clean({ batch_id: b.id, owner_id: b.owner_id, agreement_id: b.agreement_id,
    account_id: b.account_id, livemode: b.livemode, customer_id: b.customer_id, subscription_id: b.subscription_id,
    generation: b.generation, snapshot_digest: b.snapshot_digest, period: period(s), groups, total_cents: total }, native);
}
function metadata(b) { return { client_id: b.owner_id, source: 'usage_billing', enterprise_usage_batch_id: b.batch_id }; }
function usageInvoiceCreateRequest(b) {
  return clean({ key: `enterprise-usage-invoice:${b.batch_id}`, body: { customer: b.customer_id,
    collection_method: 'charge_automatically', auto_advance: false, pending_invoice_items_behavior: 'exclude',
    currency: 'usd', metadata: metadata(b) } });
}
function usageInvoiceFreshBinding(raw) {
  const read = clean(raw, native), b = read.batch, original = usageInvoiceBinding(b), census = read.census;
  check(read.status === 'read' && typeof read.observed_at === 'string' && Number.isFinite(Date.parse(read.observed_at))
    && isDeepStrictEqual(read.receipt, b.snapshot.receipt) && census && Array.isArray(census.ledger));
  const expected = new Map(b.groups.flatMap(g => g.interview_ids.map(iv => [iv, g]))), seen = new Set();
  const finalize = b.provider_operation?.operations?.finalize?.proof;
  for (const row of census.ledger.filter(row => row.enterprise_usage_batch_id === b.id)) {
    const g = expected.get(row.interview_id); check(g && !seen.has(row.interview_id)); seen.add(row.interview_id);
    check(row.client_id === b.owner_id && row.role_id === g.role_id && row.unit_price_cents === g.unit_price_cents
      && Date.parse(row.period_start) / 1000 === original.period.start && Date.parse(row.period_end) / 1000 === original.period.end);
    const unstamped = row.stripe_invoice_id === null && row.stripe_invoice_item_id === null && row.billed_at === null;
    if (!unstamped) check(finalize?.stage === 'finalized' && row.stripe_invoice_id === finalize.invoice_id
      && finalize.items.some(i => i.role_id === g.role_id && i.invoice_item_id === row.stripe_invoice_item_id)
      && typeof row.billed_at === 'string' && Number.isFinite(Date.parse(row.billed_at)));
  }
  check(seen.size === expected.size);
  const current = { ...b.snapshot, ...census, observed_at: read.observed_at, receipt: read.receipt,
    ledger: census.ledger.filter(row => row.enterprise_usage_batch_id !== b.id) };
  let planned; try { planned = planEnterpriseExistingUsage(current); } catch (_) { held(); }
  check(isDeepStrictEqual(clean(planned.groups, native), b.groups) && isDeepStrictEqual(clean(planned.prefix, native), b.prefix));
  // Original labels/digest/key remain frozen; current census only revalidates
  // the same allocation/source, not a request rewrite using today's titles.
  return original;
}
function usageInvoiceItemRequest(b, invoiceId, roleId) {
  check(id(invoiceId, 'in'));
  const g = b.groups.find(g => g.role_id === roleId); check(g);
  const operation = usageOperationKey({ invoiceId, clientId: b.owner_id, line: g });
  return clean({ key: `usage-item-${operation}`, body: { customer: b.customer_id, invoice: invoiceId,
    currency: 'usd', unit_amount: g.unit_price_cents, quantity: g.quantity, description: g.description,
    period: b.period, metadata: { ...metadata(b), role_id: g.role_id, usage_operation: operation } } });
}
function usageInvoiceFinalizeRequest(b, invoiceId) {
  check(id(invoiceId, 'in'));
  return clean({ key: `enterprise-usage-finalize:${b.batch_id}:${invoiceId}`, body: { auto_advance: false } });
}
function usageInvoicePayRequest(b, invoiceId, paymentMethodId) {
  check(id(invoiceId, 'in') && id(paymentMethodId, 'pm'));
  return clean({ key: `enterprise-usage-pay:${b.batch_id}:${invoiceId}`,
    body: { payment_method: paymentMethodId, off_session: true } });
}

// Pagination failure is a hold, never fabricated absence. Pages must finish;
// duplicates, cycles/no progress and the bounded safety ceiling reject whole read.
async function completePages(read, prefix, maxPages = 1000) {
  let after, count; const rows = [], seen = new Set();
  for (let n = 0; n < maxPages; n++) {
    const p = clean(await read({ limit: 100, ...(after ? { starting_after: after } : {}) }));
    check(p.object === 'list' && typeof p.has_more === 'boolean' && Array.isArray(p.data) && p.data.length <= 100);
    if (p.total_count != null) {
      check(Number.isSafeInteger(p.total_count) && p.total_count >= 0 && (count === undefined || count === p.total_count));
      count = p.total_count;
    }
    for (const r of p.data) { check(id(r?.id, prefix) && !seen.has(r.id)); seen.add(r.id); rows.push(r); }
    if (!p.has_more) { check(count === undefined || count === rows.length); return rows; }
    check(p.data.length > 0 && n + 1 < maxPages); after = p.data.at(-1).id;
  }
  held();
}
function zeroExtras(i) {
  check(i.automatic_tax?.enabled === false && empty(i.default_tax_rates) && empty(i.total_tax_amounts)
    && i.tax === null && i.discount === null && empty(i.discounts) && empty(i.total_discount_amounts)
    && i.pre_payment_credit_notes_amount === 0 && i.post_payment_credit_notes_amount === 0
    && i.starting_balance === 0 && i.application_fee_amount === null && i.transfer_data === null
    && i.on_behalf_of === null && i.shipping_cost === null);
}
function invoiceMoney(i, expected) {
  check(cents(expected) && [i.total, i.subtotal, i.amount_due, i.subtotal_excluding_tax, i.total_excluding_tax].every(n => n === expected));
}
function matchingMetadata(actual, expected) { check(actual && Object.entries(expected).every(([k, v]) => actual[k] === v)); }
function matchingPrice(price, request, mode) {
  if(price===null)return; // Integer-amount legacy item bodies need not create a Price.
  check(price?.object === 'price' && id(price.id, 'price') && price.livemode === mode && price.currency === 'usd'
    && price.unit_amount === request.unit_amount
    && (price.unit_amount_decimal===null||price.unit_amount_decimal === String(request.unit_amount))
    && price.type === 'one_time' && price.recurring === null && price.billing_scheme === 'per_unit'
    && price.transform_quantity === null && price.tiers_mode === null && price.custom_unit_amount === null);
}
function matchingItem(item, request, mode) {
  check(item?.object === 'invoiceitem' && id(item.id, 'ii') && item.customer === request.customer
    && item.invoice === request.invoice && item.livemode === mode && item.currency === 'usd'
    && item.subscription === null && item.proration === false && empty(item.tax_rates) && empty(item.discounts)
    && item.quantity === request.quantity && item.unit_amount === request.unit_amount
    && (item.unit_amount_decimal===null||item.unit_amount_decimal === String(request.unit_amount))
    && item.amount === request.quantity * request.unit_amount
    && item.description === request.description && isDeepStrictEqual(item.period, request.period));
  matchingMetadata(item.metadata, request.metadata); matchingPrice(item.price, request, mode);
}
function matchingLine(line, item, request, mode) {
  check(line?.object === 'line_item' && id(line.id, 'il') && line.type === 'invoiceitem'
    && line.invoice_item === item.id && line.invoice === request.invoice && line.subscription === null
    && line.livemode === mode && line.currency === 'usd' && line.proration === false
    && empty(line.tax_amounts) && empty(line.tax_rates) && empty(line.discount_amounts) && empty(line.discounts)
    && line.quantity === request.quantity && line.amount === item.amount && line.amount_excluding_tax === item.amount
    && (line.unit_amount_excluding_tax===null||line.unit_amount_excluding_tax === String(request.unit_amount))
    && line.description === request.description && isDeepStrictEqual(line.period, request.period));
  matchingMetadata(line.metadata, request.metadata); matchingPrice(line.price, request, mode);
}

function verifyUsageInvoicePhase({ binding: b, invoice, items, lines, provenRoleIds, invoiceId, stage, replayInvoiceId = null }) {
  const i = clean(invoice), its = clean(items), ls = clean(lines), roles = clean(provenRoleIds);
  check(id(invoiceId, 'in') && i?.object === 'invoice' && i.id === invoiceId && i.livemode === b.livemode
    && i.customer === b.customer_id && i.subscription === null && i.currency === 'usd'
    && i.collection_method === 'charge_automatically' && i.auto_advance === false
    && i.paid_out_of_band === false && Array.isArray(its) && Array.isArray(ls) && Array.isArray(roles)
    && new Set(roles).size === roles.length && roles.length <= b.groups.length
    && isDeepStrictEqual(roles, b.groups.slice(0, roles.length).map(g => g.role_id)));
  matchingMetadata(i.metadata, metadata(b)); zeroExtras(i);
  check(its.length === roles.length && ls.length === roles.length
    && new Set(its.map(x => x.id)).size === its.length && new Set(ls.map(x => x.id)).size === ls.length);
  const proofs = []; let sum = 0;
  for (const roleId of roles) {
    const req = usageInvoiceItemRequest(b, invoiceId, roleId).body;
    const candidates = its.filter(x => x.metadata?.role_id === roleId); check(candidates.length === 1);
    const item = candidates[0]; matchingItem(item, req, b.livemode);
    const matches = ls.filter(x => x.invoice_item === item.id); check(matches.length === 1);
    matchingLine(matches[0], item, req, b.livemode); sum += item.amount;
    proofs.push({ role_id: roleId, invoice_item_id: item.id, line_id: matches[0].id });
  }
  invoiceMoney(i, sum);
  if (stage === 'shell' || stage === 'items') {
    check(i.status === 'draft' && i.paid === false && i.attempted === false && i.amount_paid === 0
      && i.amount_remaining === 0 && i.ending_balance === null);
    if (stage === 'shell') check(roles.length === 0 && replayInvoiceId === invoiceId);
    else check(roles.length>0);
  } else {
    check(['finalized', 'paid'].includes(stage) && roles.length === b.groups.length && sum === b.total_cents
      && i.ending_balance === 0 && epoch(i.status_transitions?.finalized_at));
    if (stage === 'finalized') check(i.status === 'open' && i.paid === false && i.amount_paid === 0 && i.amount_remaining === sum);
    else check(i.status === 'paid' && i.paid === true && i.amount_paid === sum && i.amount_remaining === 0);
  }
  return clean({ invoice_id: invoiceId, stage, total_cents: sum, items: proofs, provider_effect_authorized: false,
    paid_access_authorized: false, payroll_authorized: false });
}

function selectUsageInvoicePaymentMethod({ binding: b, customer, subscription, paymentMethod }) {
  const c = clean(customer), s = clean(subscription), pm = clean(paymentMethod);
  check(c?.object === 'customer' && c.id === b.customer_id && c.deleted !== true && c.livemode === b.livemode
    && c.default_source === null && s?.object === 'subscription' && s.id === b.subscription_id
    && s.customer === b.customer_id && s.livemode === b.livemode && s.default_source === null);
  const cd = c.invoice_settings?.default_payment_method, sd = s.default_payment_method;
  check((cd === null || id(cd, 'pm')) && (sd === null || id(sd, 'pm')) && !(cd && sd && cd !== sd));
  const selected = cd || sd; check(id(selected, 'pm') && pm?.object === 'payment_method' && pm.id === selected
    && pm.customer === b.customer_id && pm.livemode === b.livemode && pm.type === 'card');
  return selected; // Never retain the PaymentMethod/card object in native leaf.
}

function verifyUsageInvoicePaid({ binding: b, invoiceId, invoice, items, lines, paymentMethodId,
  paymentIntent, charge, refunds, observationEpoch }) {
  const i = clean(invoice), pi = clean(paymentIntent), ch = clean(charge), rs = clean(refunds);
  verifyUsageInvoicePhase({ binding: b, invoiceId, invoice: i, items, lines,
    provenRoleIds: b.groups.map(g => g.role_id), stage: 'paid' });
  check(i.status === 'paid' && i.paid === true && i.paid_out_of_band === false && id(i.id, 'in')
    && i.customer === b.customer_id && i.subscription === null && i.currency === 'usd' && i.livemode === b.livemode
    && i.amount_paid === b.total_cents && i.amount_remaining === 0 && i.amount_due === b.total_cents
    && epoch(observationEpoch) && epoch(i.status_transitions?.paid_at) && i.status_transitions.paid_at <= observationEpoch);
  for (const [o, kind] of [[pi, 'payment_intent'], [ch, 'charge']]) check(o?.object === kind
    && o.customer === b.customer_id && o.livemode === b.livemode && o.currency === 'usd'
    && o.amount === b.total_cents && epoch(o.created) && o.created <= i.status_transitions.paid_at);
  check(id(paymentMethodId, 'pm') && pi.payment_method === paymentMethodId && ch.payment_method === paymentMethodId
    && id(pi.id, 'pi') && id(ch.id, 'ch') && i.payment_intent === pi.id && i.charge === ch.id
    && pi.invoice === i.id && pi.latest_charge === ch.id && ch.invoice === i.id && ch.payment_intent === pi.id
    && pi.status === 'succeeded' && pi.amount_received === b.total_cents && ch.status === 'succeeded'
    && ch.paid === true && ch.captured === true && ch.amount_captured === b.total_cents
    && ch.amount_refunded === 0 && ch.refunded === false && ch.disputed === false
    && (!Object.hasOwn(ch, 'dispute') || ch.dispute === null) && Array.isArray(rs) && rs.length === 0
    && (!Object.hasOwn(ch, 'refunds') || ch.refunds === null || (ch.refunds?.object === 'list' && ch.refunds.has_more === false
      && Array.isArray(ch.refunds.data) && ch.refunds.data.length === 0)));
  return clean({ invoice_id: i.id, payment_intent_id: pi.id, charge_id: ch.id, amount_cents: b.total_cents,
    paid_at: i.status_transitions.paid_at, provider_effect_authorized: false, paid_access_authorized: false, payroll_authorized: false });
}

async function readUsageInvoiceCensus({ stripe, binding: b, invoiceId = null }) {
  const api = () => check(stripe?.getApiField('version') === '2023-10-16');
  const provider = async fn => { api(); try { return await fn(); } catch (e) {
    if (e?.code === 'enterprise_usage_invoice_held') throw e;
    throw Object.assign(new Error('enterprise_usage_invoice_unknown'), { code: 'enterprise_usage_invoice_unknown', status: 503 });
  } };
  const account = async () => { const a = clean(await provider(() => stripe.accounts.retrieve()));
    check(a.object === 'account' && a.id === b.account_id); };
  await account();
  const invoices = await completePages(args => provider(() => stripe.invoices.list({ customer: b.customer_id, ...args })), 'in');
  check(invoices.every(i => i.object === 'invoice' && i.customer === b.customer_id && i.livemode === b.livemode));
  let invoice = null, items = [], lines = [];
  if (invoiceId !== null) {
    check(id(invoiceId, 'in') && invoices.filter(i => i.id === invoiceId).length === 1);
    invoice = clean(await provider(() => stripe.invoices.retrieve(invoiceId)));
    items = await completePages(args => provider(() => stripe.invoiceItems.list({ customer: b.customer_id, invoice: invoiceId, ...args })), 'ii');
    lines = await completePages(args => provider(() => stripe.invoices.listLineItems(invoiceId, args)), 'il');
    const again = clean(await provider(() => stripe.invoices.retrieve(invoiceId)));
    check(isDeepStrictEqual(invoice, again));
  }
  // Full customer-head repeat detects common concurrent insertion. This is not
  // an atomic provider snapshot, and cannot prove absence after an unknown send.
  const again = await completePages(args => provider(() => stripe.invoices.list({ customer: b.customer_id, ...args })), 'in');
  check(isDeepStrictEqual(invoices, again)); await account(); api();
  return { invoices, invoice, items, lines, provider_effect_authorized: false,
    paid_access_authorized:false,payroll_authorized:false };
}
module.exports = { usageInvoiceBinding, usageInvoiceFreshBinding, usageInvoiceCreateRequest, usageInvoiceItemRequest, usageInvoiceFinalizeRequest,
  usageInvoicePayRequest, verifyUsageInvoicePhase, selectUsageInvoicePaymentMethod, verifyUsageInvoicePaid,
  readUsageInvoiceCensus, completePages };
