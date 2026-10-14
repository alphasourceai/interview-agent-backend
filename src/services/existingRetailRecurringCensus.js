'use strict';

// UNMOUNTED adapter over the existing subscription invoices. Chronology only:
// no atomic provider snapshot, funds/access/collection/commission authority.
const { isDeepStrictEqual, types: { isProxy } } = require('node:util');
const { snapshotStripeSdkData: snapshot } = require('./enterprisePoolPaymentProof');
const { readExistingRetailRecurringSource } = require('./existingRetailRecurringSource');
const { inspectExistingRetailRecurringPeriods } = require('./existingRetailRecurringPeriods');
class CensusError extends Error {
  constructor(code = 'retail_recurring_census_invalid', status = 409) { super(code); this.code = code; this.status = status; }
}
const invalid = () => { throw new CensusError(); };
const unknown = () => { throw new CensusError('retail_recurring_census_unknown', 503); };
const check = v => { if (!v) invalid(); };
function fields(value, sdk = false) {
  check(value && typeof value === 'object' && !isProxy(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const f = Object.getOwnPropertyDescriptors(value);
  check(Reflect.ownKeys(f).every(key => typeof key === 'string' && Object.hasOwn(f[key], 'value')
    && (sdk && key === 'lastResponse' ? !f[key].enumerable && !f[key].writable && !f[key].configurable : f[key].enumerable)));
  return f;
}
function page(raw) {
  const f = fields(raw, true), data = f.data?.value;
  check(Array.isArray(data) && !isProxy(data) && Object.getPrototypeOf(data) === Array.prototype);
  const e = Object.getOwnPropertyDescriptors(data), n = e.length?.value;
  check(Number.isSafeInteger(n) && n >= 0 && n <= 100 && Reflect.ownKeys(e).length === n + 1);
  for (let i = 0; i < n; i++) check(e[i]?.enumerable && Object.hasOwn(e[i], 'value'));
  const meta = clean({ object: f.object?.value, has_more: f.has_more?.value });
  check(meta.object === 'list' && typeof meta.has_more === 'boolean' && (!meta.has_more || n > 0));
  return { has_more: meta.has_more, data: Array.from({ length: n }, (_, i) => e[i].value),
    total_count: f.total_count?.value };
}
function clean(value) { try { return snapshot(value); } catch (_) { invalid(); } }
function invoiceProjection(raw) {
  const f = fields(raw, true), values = {};
  // Only chronology identity is consumed. In particular, never traverse
  // original embedded lines/money/refunds, or retain private invoice fields.
  for (const key of ['id', 'object', 'customer', 'subscription', 'currency', 'livemode', 'billing_reason']) values[key] = f[key]?.value;
  return clean(values);
}
const invoiceId = id => typeof id === 'string' && /^in_[A-Za-z0-9_]{1,250}$/.test(id) && id.length <= 255;
async function read(input) {
  const f = fields(input), keys = ['db', 'stripe', 'agreementId', 'clientId'];
  check(Object.keys(f).length === keys.length && keys.every(key => Object.hasOwn(f, key)));
  const db = f.db.value, stripe = f.stripe.value, agreementId = f.agreementId.value, clientId = f.clientId.value;
  const api = () => check(typeof stripe?.getApiField === 'function' && stripe.getApiField('version') === '2023-10-16');
  api();
  async function source() {
    try { return await readExistingRetailRecurringSource({ db, agreementId, clientId }); }
    catch (e) { if (e?.code === 'retail_recurring_source_invalid') invalid(); unknown(); }
  }
  async function provider(fn) { api(); try { return await fn(); } catch (_) { unknown(); } }
  const original = await source(), p = original.original_period;
  async function account() {
    const a = clean(await provider(() => stripe.accounts.retrieve()));
    check(a?.object === 'account' && a.id === original.original_provider_account_id);
  }
  await account();
  const args = { subscription: p.subscription_id, limit: 100 }, invoices = [], seen = new Set();
  let after, head, reportedCount;
  for (let n = 0; n < 10; n++) {
    const r = page(await provider(() => stripe.invoices.list({ ...args, ...(after ? { starting_after: after } : {}) })));
    if (r.total_count !== undefined) {
      check(Number.isSafeInteger(r.total_count) && r.total_count >= r.data.length && r.total_count <= 1000
        && (reportedCount === undefined || reportedCount === r.total_count));
      reportedCount = r.total_count;
    }
    const ids = [];
    for (const raw of r.data) {
      const invoice = invoiceProjection(raw); check(invoiceId(invoice?.id) && !seen.has(invoice.id));
      seen.add(invoice.id); ids.push(invoice.id); invoices.push(invoice);
    }
    if (n === 0) head = { ids, has_more: r.has_more };
    if (!r.has_more) break;
    check(n < 9); after = ids.at(-1);
  }
  check(reportedCount === undefined || reportedCount === invoices.length);
  for (const invoice of invoices) if (invoice.id !== p.invoice_id) {
    const r = page(await provider(() => stripe.invoices.listLineItems(invoice.id, { limit: 100 })));
    check(r.has_more === false && r.data.length === 1 && (r.total_count === undefined || r.total_count === 1));
    invoice.lines = { object: 'list', has_more: false, data: [clean(r.data[0])] };
  }
  const last = page(await provider(() => stripe.invoices.list({ ...args })));
  const lastIds = last.data.map(raw => { const i = invoiceProjection(raw); check(invoiceId(i?.id)); return i.id; });
  check(last.has_more === head.has_more && isDeepStrictEqual(lastIds, head.ids));
  await account(); check(isDeepStrictEqual(await source(), original)); api();
  try { return inspectExistingRetailRecurringPeriods({ packageSnapshot: original.package_snapshot, originalPeriod: p,
    originalProviderAccountId: original.original_provider_account_id, providerAccountId: original.original_provider_account_id,
    invoices: { object: 'list', has_more: false, data: invoices } }); }
  catch (e) { if (e?.code === 'retail_recurring_period_unsupported') throw new CensusError(e.code); invalid(); }
}
async function readExistingRetailRecurringCensus(input) {
  try { return await read(input); } catch (e) { if (e instanceof CensusError) throw e; unknown(); }
}
module.exports = { readExistingRetailRecurringCensus };
