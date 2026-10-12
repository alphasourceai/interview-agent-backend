'use strict';

// UNMOUNTED pure policy for the existing pinned Stripe API2023-10-16 shapes.
// A JSON shape is NOT authentication. Only a trusted adapter may supply an
// immutable native binding and fresh objects read from its authenticated SDK.
// This never retrieves, persists, activates, releases credits or grants access.
const { isProxy } = require('node:util').types;
const { validateEnterprisePoolSnapshot } = require('./enterprisePoolSnapshot');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cents = n => Number.isSafeInteger(n) && n >= 0 && n <= 2147483647;
const epoch = n => Number.isSafeInteger(n) && n > 0 && n <= 253402300799;
const nativeId = (v, prefix) => typeof v === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(v);
const id = value => typeof value === 'string' ? value : value?.id;
const empty = value => Array.isArray(value) && value.length === 0;
function fail(code) { const e = new Error(code); e.code = code; e.status = 409; throw e; }
function check(value, code) { if (!value) fail(code); }

// Snapshot plain own-data JSON without invoking accessors, proxies or toJSON.
// Shared ordinary object references are fine; cycles, holes and oversized graphs
// are not. A caller cannot alter the graph between successive proof predicates.
function safeSnapshot(input) {
  let count = 0;
  const active = new Set();
  function copy(v, depth) {
    check(++count <= 10000 && depth <= 20, 'pool_proof_invalid_graph');
    if (v == null || ['string', 'boolean', 'undefined'].includes(typeof v)) {
      check(typeof v !== 'string' || v.length <= 8192, 'pool_proof_invalid_graph');
      return v;
    }
    if (typeof v === 'number') { check(Number.isFinite(v), 'pool_proof_invalid_graph'); return v; }
    check(typeof v === 'object' && !isProxy(v) && !active.has(v), 'pool_proof_invalid_graph');
    const array = Array.isArray(v);
    check(array || [Object.prototype, null].includes(Object.getPrototypeOf(v)), 'pool_proof_invalid_graph');
    const descriptors = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(descriptors);
    const dataKeys = array ? keys.filter(k => k !== 'length') : keys;
    check(dataKeys.every(k => typeof k === 'string' && descriptors[k].enumerable
      && Object.hasOwn(descriptors[k], 'value')), 'pool_proof_invalid_graph');
    if (array) check(dataKeys.length === v.length && dataKeys.every(k => /^(0|[1-9][0-9]*)$/.test(k)
      && Number(k) < v.length), 'pool_proof_invalid_graph');
    active.add(v);
    const result = array ? [] : Object.create(null);
    for (const k of dataKeys) result[k] = copy(descriptors[k].value, depth + 1);
    active.delete(v);
    return result;
  }
  return copy(input, 0);
}

function list(value, prefix, length) {
  check(value?.object === 'list' && value.has_more === false && Array.isArray(value.data)
    && value.data.length === length && (value.total_count == null || value.total_count === length)
    && value.data.every(v => nativeId(v?.id, prefix))
    && new Set(value.data.map(v => v.id)).size === length, 'pool_proof_incomplete_list');
  return value.data;
}

function price(p, expectedId, amount, recurring, mode, paidAt) {
  check(p?.object === 'price' && p.id === expectedId && p.livemode === mode
    && p.currency === 'usd' && p.unit_amount === amount
    && (p.unit_amount_decimal == null || p.unit_amount_decimal === String(amount))
    && p.billing_scheme === 'per_unit' && p.custom_unit_amount === null
    && p.transform_quantity === null && p.tiers_mode === null
    && p.type === (recurring ? 'recurring' : 'one_time')
    && epoch(p.created) && p.created <= paidAt, 'pool_proof_price_mismatch');
  if (recurring) check(p.recurring?.interval === 'month' && p.recurring.interval_count === 1
    && p.recurring.usage_type === 'licensed', 'pool_proof_price_mismatch');
  else check(p.recurring === null, 'pool_proof_price_mismatch');
}

function taxes(values) {
  check(Array.isArray(values), 'pool_proof_tax_unverified');
  let sum = 0;
  for (const t of values) {
    check(cents(t?.amount) && t.inclusive === false && nativeId(id(t.tax_rate), 'txr'),
      'pool_proof_tax_unverified');
    sum += t.amount;
    check(cents(sum), 'pool_proof_tax_unverified');
  }
  return sum;
}

function proveEnterprisePoolPayment(raw = {}) {
  const input = safeSnapshot(raw);
  check(input && typeof input === 'object' && !Array.isArray(input), 'pool_proof_invalid_graph');
  const { binding: b, account, checkout, checkoutLines, subscription, invoice,
    paymentIntent: pi, charge, observedAt } = input;
  check(b && UUID.test(b.poolId || '') && UUID.test(b.clientId || '')
    && nativeId(b.providerAccountId, 'acct') && typeof b.livemode === 'boolean'
    && nativeId(b.customerId, 'cus') && nativeId(b.checkoutSessionId, 'cs')
    && nativeId(b.subscriptionId, 'sub') && nativeId(b.platformItemId, 'si')
    && nativeId(b.platformPriceId, 'price') && nativeId(b.poolPriceId, 'price')
    && b.platformPriceId !== b.poolPriceId && cents(b.platformMonthlyCents)
    && b.platformMonthlyCents > 0, 'pool_proof_invalid_binding');
  const offer = validateEnterprisePoolSnapshot(b.snapshot, b.digest);
  check(offer.net_cents > 0, 'pool_proof_free_pool_requires_policy');
  check(account?.object === 'account' && account.id === b.providerAccountId, 'pool_proof_account_mismatch');
  const objects = [[checkout, 'checkout.session', b.checkoutSessionId],
    [subscription, 'subscription', b.subscriptionId], [invoice, 'invoice', null],
    [pi, 'payment_intent', null], [charge, 'charge', null]];
  check(objects.every(([o, type, expected]) => o?.object === type && (expected === null || o.id === expected)
    && o.livemode === b.livemode && id(o.customer) === b.customerId && o.currency === 'usd'),
    'pool_proof_object_identity_mismatch');
  check(nativeId(invoice.id, 'in') && nativeId(pi.id, 'pi') && nativeId(charge.id, 'ch')
    && id(checkout.subscription) === b.subscriptionId && id(checkout.invoice) === invoice.id
    && id(invoice.subscription) === b.subscriptionId && id(invoice.payment_intent) === pi.id
    && id(invoice.charge) === charge.id && id(pi.invoice) === invoice.id
    && id(pi.latest_charge) === charge.id && id(charge.invoice) === invoice.id
    && id(charge.payment_intent) === pi.id, 'pool_proof_object_link_mismatch');
  const paidAt = invoice.status_transitions?.paid_at;
  check(epoch(observedAt) && epoch(paidAt) && paidAt <= observedAt
    && objects.every(([o]) => epoch(o.created) && o.created <= paidAt), 'pool_proof_time_unverified');
  check(checkout.mode === 'subscription' && checkout.status === 'complete' && checkout.payment_status === 'paid'
    && checkout.payment_intent === null && subscription.status === 'active', 'pool_proof_checkout_not_paid');
  check(subscription.discount === null && empty(subscription.discounts), 'pool_proof_provider_discount');
  const collected = invoice.total;
  check(cents(collected) && collected > 0 && collected >= offer.net_cents
    && [checkout.amount_total, invoice.amount_due, invoice.amount_paid, pi.amount,
      pi.amount_received, charge.amount, charge.amount_captured].every(n => cents(n) && n === collected)
    && cents(checkout.amount_subtotal) && cents(invoice.subtotal)
    && cents(checkout.total_details?.amount_tax), 'pool_proof_collection_mismatch');
  check(invoice.billing_reason === 'subscription_create' && invoice.status === 'paid' && invoice.paid === true
    && invoice.paid_out_of_band === false && invoice.collection_method === 'charge_automatically'
    && cents(invoice.amount_due) && invoice.amount_due > 0 && invoice.amount_paid === invoice.amount_due
    && invoice.amount_remaining === 0 && invoice.amount_paid === invoice.total
    && invoice.starting_balance === 0 && invoice.ending_balance === 0
    && invoice.pre_payment_credit_notes_amount === 0 && invoice.post_payment_credit_notes_amount === 0
    && empty(invoice.discounts) && empty(invoice.total_discount_amounts), 'pool_proof_invoice_not_collected');
  list(charge.refunds, 're', 0);
  check(pi.status === 'succeeded' && pi.amount === invoice.total && pi.amount_received === invoice.total
    && charge.status === 'succeeded' && charge.paid === true && charge.captured === true
    && charge.amount === invoice.total && charge.amount_captured === invoice.total
    && charge.amount_refunded === 0 && charge.refunded === false
    && charge.disputed === false && charge.dispute == null, 'pool_proof_payment_not_succeeded');

  const item = list(subscription.items, 'si', 1)[0];
  check(item.id === b.platformItemId && item.quantity === 1 && id(item.subscription) === b.subscriptionId,
    'pool_proof_subscription_item_mismatch');
  check(empty(item.discounts), 'pool_proof_provider_discount');
  price(item.price, b.platformPriceId, b.platformMonthlyCents, true, b.livemode, paidAt);
  const nativeLines = list(invoice.lines, 'il', 2);
  const poolLines = nativeLines.filter(v => id(v.price) === b.poolPriceId);
  const platformLines = nativeLines.filter(v => id(v.price) === b.platformPriceId);
  check(poolLines.length === 1 && platformLines.length === 1, 'pool_proof_mixed_lines');
  const pool = poolLines[0], platform = platformLines[0];
  for (const line of nativeLines) {
    check(line.object === 'line_item' && line.livemode === b.livemode && id(line.invoice) === invoice.id
      && line.quantity === 1 && line.currency === 'usd' && empty(line.discount_amounts)
      && empty(line.discounts) && cents(line.amount), 'pool_proof_invoice_line_mismatch');
  }
  check(pool.type === 'invoiceitem' && pool.subscription_item == null && pool.proration === false
    && (pool.subscription == null || id(pool.subscription) === b.subscriptionId)
    && pool.amount === offer.net_cents, 'pool_proof_pool_line_mismatch');
  check(platform.type === 'subscription' && id(platform.subscription) === b.subscriptionId
    && id(platform.subscription_item) === b.platformItemId && typeof platform.proration === 'boolean'
    && platform.amount <= b.platformMonthlyCents
    && (platform.proration || platform.amount === b.platformMonthlyCents), 'pool_proof_platform_line_mismatch');
  price(pool.price, b.poolPriceId, offer.net_cents, false, b.livemode, paidAt);
  price(platform.price, b.platformPriceId, b.platformMonthlyCents, true, b.livemode, paidAt);
  const poolTax = taxes(pool.tax_amounts), platformTax = taxes(platform.tax_amounts);
  const totalTax = taxes(invoice.total_tax_amounts), subtotal = pool.amount + platform.amount;
  check(cents(subtotal) && totalTax === poolTax + platformTax
    && (invoice.tax === totalTax || (totalTax === 0 && invoice.tax == null))
    && invoice.subtotal === subtotal && invoice.total === subtotal + totalTax
    && cents(invoice.total) && invoice.total > 0 && invoice.total >= offer.net_cents,
    'pool_proof_invoice_total_mismatch');

  const checkoutItems = list(checkoutLines, 'li', 2);
  const checkoutPools = checkoutItems.filter(v => id(v.price) === b.poolPriceId);
  const checkoutPlatforms = checkoutItems.filter(v => id(v.price) === b.platformPriceId);
  check(checkoutPools.length === 1 && checkoutPlatforms.length === 1, 'pool_proof_mixed_lines');
  for (const line of checkoutItems) {
    const isPool = line === checkoutPools[0], amount = isPool ? pool.amount : platform.amount;
    const tax = isPool ? poolTax : platformTax;
    check(line.object === 'item' && line.quantity === 1 && line.currency === 'usd'
      && line.amount_discount === 0 && (line.discounts == null || empty(line.discounts))
      && line.amount_subtotal === amount && line.amount_tax === tax
      && line.amount_total === amount + tax, 'pool_proof_checkout_line_mismatch');
    price(line.price, isPool ? b.poolPriceId : b.platformPriceId,
      isPool ? offer.net_cents : b.platformMonthlyCents, !isPool, b.livemode, paidAt);
  }
  check(checkout.amount_subtotal === subtotal && checkout.amount_total === invoice.total
    && checkout.total_details?.amount_tax === totalTax && checkout.total_details.amount_discount === 0
    && checkout.total_details.amount_shipping === 0
    && (checkout.total_details.breakdown == null || empty(checkout.total_details.breakdown.discounts)),
    'pool_proof_checkout_total_mismatch');

  return Object.freeze({ pool_id: b.poolId, client_id: b.clientId, provider_account_id: b.providerAccountId,
    livemode: b.livemode, currency: 'usd', offer_version: offer.offer_version, offer_digest: b.digest,
    customer_id: b.customerId, checkout_session_id: checkout.id, subscription_id: subscription.id,
    invoice_id: invoice.id, pool_line_id: pool.id, payment_intent_id: pi.id, charge_id: charge.id,
    platform_item_id: item.id, platform_price_id: b.platformPriceId, pool_price_id: b.poolPriceId,
    payment_success_at: new Date(paidAt * 1000).toISOString(), quantity: offer.quantity,
    pool_paid_cents: pool.amount, pool_tax_cents: poolTax, platform_line_cents: platform.amount,
    tax_cents: totalTax, collected_cents: invoice.total, credits_spendable: false,
    membership_activation_required: true, native_receipt_required: true });
}

module.exports = { proveEnterprisePoolPayment };
