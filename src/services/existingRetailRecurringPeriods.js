'use strict';

// Pure, unmounted chronology inspection. The caller owns receipt/provider
// provenance; these observations authorize no collection, access or payroll.
const { isProxy } = require('node:util').types;
const { readRetailPackageOffer } = require('./membershipPackageCompatibility');
const { anchoredMonthInstant, retailTermWindow } = require('./membershipOffers');
const { snapshotStripeSdkData: snapshot } = require('./enterprisePoolPaymentProof');

const INPUT_KEYS = ['packageSnapshot', 'originalPeriod', 'originalProviderAccountId', 'providerAccountId', 'invoices'];
const PERIOD_KEYS = ['version', 'api_version', 'invoice_id', 'platform_invoice_line_id', 'price_id', 'subscription_id',
  'subscription_item_id', 'customer_id', 'checkout_session_id', 'livemode', 'paid_at', 'provider_period_start', 'provider_period_end'];
class PeriodError extends Error {
  constructor(code) { super(code); this.code = code; this.status = 409; }
}
const invalid = () => { throw new PeriodError('retail_recurring_period_invalid'); };
const unsupported = () => { throw new PeriodError('retail_recurring_period_unsupported'); };
const check = value => { if (!value) invalid(); };
const nativeId = (value, prefix) => typeof value === 'string'
  && new RegExp(`^${prefix}_[A-Za-z0-9_]{1,250}$`).test(value);
const exactKeys = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function descriptors(value, sdkMetadata = false) {
  check(value && typeof value === 'object' && !isProxy(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const fields = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(fields).every(key => {
    if (typeof key !== 'string') return false;
    const field = fields[key];
    if (sdkMetadata && key === 'lastResponse') return Object.hasOwn(field, 'value')
      && field.enumerable === false && field.writable === false && field.configurable === false;
    return field.enumerable && Object.hasOwn(field, 'value');
  }));
  return fields;
}

// Only snapshot list metadata here. A shared snapshot of a rich 1,000-invoice
// history would exceed the existing per-object 10k-node budget. Records are
// independently snapshotted below and projected immediately to scalar output.
function closedList(value, maxLength) {
  const fields = descriptors(value, true);
  const data = fields.data?.value;
  check(Array.isArray(data) && !isProxy(data) && Object.getPrototypeOf(data) === Array.prototype);
  const elements = Object.getOwnPropertyDescriptors(data);
  const length = elements.length?.value;
  check(Number.isSafeInteger(length) && length >= 0 && length <= maxLength);
  const keys = Reflect.ownKeys(elements).filter(key => key !== 'length');
  check(keys.length === length && keys.every(key => typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)
    && Number(key) < length && elements[key].enumerable && Object.hasOwn(elements[key], 'value')));
  const metadata = snapshot({ object: fields.object?.value, has_more: fields.has_more?.value,
    ...(Object.hasOwn(fields, 'total_count') ? { total_count: fields.total_count.value } : {}) });
  check(metadata.object === 'list' && metadata.has_more === false
    && (!Object.hasOwn(metadata, 'total_count') || metadata.total_count === length));
  return Array.from({ length }, (_, index) => elements[String(index)].value);
}

function epochIso(value) {
  check(Number.isSafeInteger(value) && value > 0 && value <= 253402300799);
  const iso = new Date(value * 1000).toISOString();
  check(Date.parse(iso) / 1000 === value);
  return iso;
}
function anchored(iso, months) {
  try { return anchoredMonthInstant(iso, months); } catch (_) { unsupported(); }
}
function originalTuple(value, interval) {
  const period = snapshot(value);
  check(period && exactKeys(period, PERIOD_KEYS) && period.version === 'retail_initial_provider_period_v1'
    && period.api_version === '2023-10-16' && typeof period.livemode === 'boolean');
  for (const [key, prefix] of [['invoice_id', 'in'], ['platform_invoice_line_id', 'il'], ['price_id', 'price'],
    ['subscription_id', 'sub'], ['subscription_item_id', 'si'], ['customer_id', 'cus'], ['checkout_session_id', 'cs']]) {
    check(nativeId(period[key], prefix));
  }
  check(typeof period.paid_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(period.paid_at));
  const paidEpoch = Date.parse(period.paid_at) / 1000;
  check(epochIso(paidEpoch) === period.paid_at);
  const startIso = epochIso(period.provider_period_start);
  const endIso = epochIso(period.provider_period_end);
  check(paidEpoch >= period.provider_period_start);
  if (endIso !== anchored(startIso, interval)) unsupported();
  return { period, startIso };
}
function invoiceIdentity(invoice, period) {
  check(invoice?.object === 'invoice' && nativeId(invoice.id, 'in') && invoice.currency === 'usd'
    && typeof invoice.livemode === 'boolean' && invoice.livemode === period.livemode
    && typeof invoice.customer === 'string' && invoice.customer === period.customer_id
    && typeof invoice.subscription === 'string' && invoice.subscription === period.subscription_id);
}
function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

function inspect(input) {
  const fields = descriptors(input);
  check(exactKeys(fields, INPUT_KEYS));
  const offer = readRetailPackageOffer(fields.packageSnapshot.value);
  check(offer);
  const originalAccount = fields.originalProviderAccountId.value;
  const account = fields.providerAccountId.value;
  check(nativeId(originalAccount, 'acct') && nativeId(account, 'acct') && account === originalAccount);
  const interval = offer.stripe_recurrence.interval_count;
  const { period, startIso } = originalTuple(fields.originalPeriod.value, interval);
  const originalStart = new Date(period.provider_period_start * 1000);
  const invoiceIds = new Set(), lineIds = new Set([period.platform_invoice_line_id]), cycles = [];
  let initialCount = 0;
  for (const rawInvoice of closedList(fields.invoices.value, 1000)) {
    const invoice = snapshot(rawInvoice);
    invoiceIdentity(invoice, period);
    check(!invoiceIds.has(invoice.id)); invoiceIds.add(invoice.id);
    if (invoice.id === period.invoice_id) {
      check(invoice.billing_reason === 'subscription_create'); initialCount += 1;
      // Original money remains the immutable native receipt. Neither its
      // current status/refunds nor its lookback dates/lines reprove that money.
      continue;
    }
    check(invoice.billing_reason === 'subscription_cycle');
    const rawLines = closedList(invoice.lines, 1);
    check(rawLines.length === 1);
    const line = snapshot(rawLines[0]), price = line?.price;
    check(line?.object === 'line_item' && nativeId(line.id, 'il') && !lineIds.has(line.id)
      && line.type === 'subscription' && line.proration === false && line.quantity === 1
      && line.currency === 'usd' && line.subscription === period.subscription_id
      && line.subscription_item === period.subscription_item_id
      && price?.object === 'price' && price.id === period.price_id && price.currency === 'usd'
      && price.type === 'recurring' && price.unit_amount === offer.platform_payment_cents
      && line.amount === offer.platform_payment_cents && price.recurring?.interval === 'month'
      && price.recurring.interval_count === interval && price.recurring.usage_type === 'licensed');
    lineIds.add(line.id);
    const lineStartIso = epochIso(line.period?.start), lineEndIso = epochIso(line.period?.end);
    if (line.period.end <= line.period.start) unsupported();
    const lineStart = new Date(line.period.start * 1000);
    const offset = (lineStart.getUTCFullYear() - originalStart.getUTCFullYear()) * 12
      + lineStart.getUTCMonth() - originalStart.getUTCMonth();
    if (offset <= 0 || offset % interval !== 0 || lineStartIso !== anchored(startIso, offset)
      || lineEndIso !== anchored(startIso, offset + interval)) unsupported();
    const ordinal = offset / interval;
    const termIndex = offer.payment_option === 'prepaid' ? ordinal : Math.floor(ordinal / offer.commitment_months);
    let term;
    try { term = retailTermWindow({ originalStart: period.paid_at, commitmentMonths: offer.commitment_months, termIndex }); }
    catch (_) { unsupported(); }
    cycles.push({ ordinal, invoice_id: invoice.id, line_id: line.id,
      provider_period_start: line.period.start, provider_period_end: line.period.end,
      observed_original_a_period_start: anchored(period.paid_at, offset),
      observed_original_a_period_end: anchored(period.paid_at, offset + interval),
      term_index: term.term_index,
      installment_index: offer.payment_option === 'prepaid' ? 1 : ordinal % offer.commitment_months + 1,
      observed_term_start_at: term.term_start_at, observed_term_end_at: term.term_end_at });
  }
  check(initialCount === 1);
  cycles.sort((a, b) => a.ordinal - b.ordinal);
  check(cycles.every((cycle, index) => cycle.ordinal === index + 1));
  return freeze({ version: 'retail_recurring_period_observation_v1', effect_authorized: false, collection_ready: false,
    paid_access_authorized: false, collection_absence_proven: false, provider_effect_absence_proven: false,
    cycle_count: cycles.length, cycles });
}

function inspectExistingRetailRecurringPeriods(input) {
  try { return inspect(input); } catch (error) {
    if (error instanceof PeriodError) throw error;
    invalid(); // Never leak parser/snapshot details or return a partial census.
  }
}
module.exports = { inspectExistingRetailRecurringPeriods };
