'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { fixture } = require('./fixtures/existing-retail-funding-fixture');
const { verifyExistingRetailFunding } = require('../src/services/existingRetailCheckoutFunding');
const { anchoredMonthInstant } = require('../src/services/membershipOffers');
const { inspectExistingRetailRecurringPeriods: inspect } = require('../src/services/existingRetailRecurringPeriods');
const { readExistingRetailRecurringCensus: read } = require('../src/services/existingRetailRecurringCensus');
function setup(plan = 'basic', months = 3, payment = 'monthly_installments', role = false, count = 4, pageSize = 100) {
  const f = fixture(plan, months, payment, role), o = f.pkg.membership_terms;
  const p = structuredClone(verifyExistingRetailFunding({ offer: o, checkout: f.cs,
    checkoutLines: { object: 'list', has_more: false, data: f.cl }, subscription: f.s, subscriptionItems: f.s.items,
    invoice: f.inv, invoiceLines: f.inv.lines, paymentIntent: f.pi, charge: f.ch,
    expected: { customerId: f.c.stripe_customer_id, signedAt: f.g.signed_at, agreementDeadline: f.g.agreement_expires_at, intentDeadline: f.i.expires_at } }).initialProviderPeriod);
  const source = { version: 'retail_existing_recurring_source_v1', agreement_id: f.g.id, client_id: f.c.id,
    source_intent_id: f.i.id, package_snapshot: structuredClone(f.pkg), original_period: p,
    original_provider_account_id: 'acct_SYNTHETIC', effect_authorized: false, collection_ready: false, paid_access_authorized: false, payroll_authorized: false };
  const records = [structuredClone(f.inv)], lines = new Map(), calls = [], rpcCalls = [];
  const b = new Date(p.provider_period_start * 1000).toISOString(), interval = o.stripe_recurrence.interval_count;
  for (let n = 1; n <= count; n++) {
    const l = structuredClone(f.il[0]); l.id = `il_CYCLE_${n}`;
    l.period = { start: Date.parse(anchoredMonthInstant(b, n * interval)) / 1000, end: Date.parse(anchoredMonthInstant(b, (n + 1) * interval)) / 1000 };
    const invoice = { object: 'invoice', id: `in_CYCLE_${n}`, billing_reason: 'subscription_cycle', subscription: p.subscription_id,
      customer: p.customer_id, currency: 'usd', livemode: false, status: 'draft', lines: { object: 'list', data: [], has_more: true } };
    records.push(invoice); lines.set(invoice.id, { object: 'list', data: [l], has_more: false, total_count: 1 });
  }
  records.reverse();
  const sdk = { getApiField: () => '2023-10-16', accounts: { async retrieve() { calls.push(['account']); return { object: 'account', id: 'acct_SYNTHETIC' }; } },
    invoices: { async list(args) {
      calls.push(['list', structuredClone(args)]); const start = args.starting_after ? records.findIndex(i => i.id === args.starting_after) + 1 : 0;
      return { object: 'list', data: structuredClone(records.slice(start, start + pageSize)), has_more: start + pageSize < records.length };
    }, async listLineItems(id, args) { calls.push(['lines', id, structuredClone(args)]); return structuredClone(lines.get(id)); } } };
  const db = { async rpc(name, args) { rpcCalls.push([name, structuredClone(args)]); return { data: structuredClone(source), error: null }; } };
  const options = { db, stripe: sdk, agreementId: f.g.id, clientId: f.c.id };
  const expected = () => inspect({ packageSnapshot: source.package_snapshot, originalPeriod: source.original_period,
    originalProviderAccountId: source.original_provider_account_id, providerAccountId: source.original_provider_account_id,
    invoices: { object: 'list', has_more: false, data: records.map(i => i.id === p.invoice_id ? i : { ...i, lines: lines.get(i.id) }) } });
  return { source, records, lines, calls, rpcCalls, sdk, db, options, expected };
}
const denied = (f, code = 'retail_recurring_census_invalid', status = 409) => assert.rejects(read(f.options), { code, status, message: code });
for (const plan of ['basic', 'pro']) for (const months of [3, 6, 12]) for (const payment of ['prepaid', 'monthly_installments']) for (const role of [false, true])
test(`existing SDK chronology ${plan}/${months}/${payment}/role:${role}`, async () => {
  const f = setup(plan, months, payment, role), before = structuredClone(f.source), records = structuredClone(f.records), result = await read(f.options);
  assert.deepEqual(result, f.expected()); assert.equal(Object.isFrozen(result.cycles[0]), true);
  assert.deepEqual(f.source, before); assert.deepEqual(f.records, records); assert.equal(Object.isFrozen(f.source), false);
  assert.equal(f.rpcCalls.length, 2); assert.ok(f.rpcCalls.every(([name, args]) => name === 'read_retail_existing_recurring_source'
    && Object.keys(args).sort().join(',') === 'p_agreement,p_client'));
  assert.deepEqual(f.calls.filter(c => c[0] === 'list').map(c => c[1]), Array(2).fill({ subscription: 'sub_SYNTHETIC', limit: 100 }));
  assert.ok(f.calls.filter(c => c[0] === 'lines').every(c => c[1] !== f.source.original_period.invoice_id && c[2].limit === 100));
  assert.equal(f.calls.filter(c => c[0] === 'account').length, 2);
});
test('complete pagination uses exact previous cursor; empty cycles remain no absence/effect proof', async () => {
  const f = setup('basic', 3, 'monthly_installments', false, 205), result = await read(f.options);
  assert.equal(result.cycle_count, 205); assert.deepEqual(f.calls.filter(c => c[0] === 'list').map(c => c[1]), [
    { subscription: 'sub_SYNTHETIC', limit: 100 }, { subscription: 'sub_SYNTHETIC', limit: 100, starting_after: 'in_CYCLE_106' },
    { subscription: 'sub_SYNTHETIC', limit: 100, starting_after: 'in_CYCLE_6' }, { subscription: 'sub_SYNTHETIC', limit: 100 }]);
  const empty = setup('pro', 6, 'prepaid', true, 0), r = await read(empty.options);
  assert.equal(r.cycle_count, 0); assert.equal(r.collection_absence_proven, false); assert.equal(r.provider_effect_absence_proven, false);
  assert.equal(empty.calls.filter(c => c[0] === 'lines').length, 0);
});
test('rich1000-record census respects independent snapshot budgets and refuses1001 without partial output', async () => {
  const f = setup('basic', 3, 'monthly_installments', false, 999);
  f.records.forEach(i => { i.metadata = Object.fromEntries(Array.from({ length: 15 }, (_, n) => [`synthetic_${n}`, 'observation'])); });
  assert.equal((await read(f.options)).cycle_count, 999);
  assert.equal(f.calls.filter(c => c[0] === 'list').length, 11);
  const big = setup('basic', 3, 'monthly_installments', false, 1000); await denied(big);
  assert.equal(big.calls.filter(c => c[0] === 'list').length, 10); assert.equal(big.calls.filter(c => c[0] === 'lines').length, 0);
});
test('duplicate/malformed/empty-more/overlarge/partial pages refuse wholly', async () => {
  for (const mutate of [r => r.data.push(r.data[0]), r => r.data[0].id = 'not-invoice', r => { r.data = []; r.has_more = true; },
    r => r.data = Array(101).fill(r.data[0]), r => r.has_more = 'false', r => delete r.object, r => r.object = () => 'list', r => r.total_count = 99,
    r => { r.data.length++; }, r => r.data.extra = true]) {
    const f = setup(), old = f.sdk.invoices.list; f.sdk.invoices.list = async args => { const r = await old(args); mutate(r); return r; }; await denied(f);
  }
  const f = setup('basic', 3, 'monthly_installments', false, 10, 1); await denied(f);
});
test('nonoriginal line list is rehydrated completely and contradictory/multiple/partial lines hold', async () => {
  for (const mutate of [r => r.has_more = true, r => r.data = [], r => r.data.push(r.data[0]), r => r.total_count = 2,
    r => r.data[0].subscription_item = 'si_WRONG', r => r.data[0].price.id = 'price_WRONG', r => r.data[0].amount++,
    r => r.data[0].proration = true, r => r.data[0].subscription = 'sub_WRONG']) {
    const f = setup(); mutate(f.lines.get(f.records[0].id)); await denied(f);
  }
});
test('head/account/source/API/owner/context drift cannot yield an observation', async () => {
  for (const stage of ['head', 'has-more', 'account', 'source', 'api', 'owner', 'initial', 'version']) {
    const f = setup(), old = f.sdk.invoices.list; let lists = 0;
    if (stage === 'head' || stage === 'has-more') f.sdk.invoices.list = async args => { const r = await old(args);
      if (++lists === 2) { if (stage === 'head') r.data.pop(); else r.has_more = true; } return r; };
    if (stage === 'account') { let accounts = 0; f.sdk.accounts.retrieve = async () => ({ object: 'account', id: ++accounts === 1 ? 'acct_SYNTHETIC' : 'acct_WRONG' }); }
    if (stage === 'source') f.db.rpc = async () => ({ data: { ...structuredClone(f.source), source_intent_id: f.rpcCalls.push([]) === 1 ? f.source.source_intent_id : null }, error: null });
    if (stage === 'api') f.sdk.getApiField = () => '2024-06-20';
    if (stage === 'owner') f.records[0].customer = 'cus_OTHER';
    if (stage === 'initial') f.records.pop();
    if (stage === 'version') f.sdk.getApiField = () => f.calls.length > 1 ? 'other' : '2023-10-16';
    await denied(f);
  }
});
test('initial refunds/financial fields/status and current clock are not funds reproof or used as dates', async () => {
  const f = setup('pro', 6, 'prepaid', true), original = f.records.at(-1), expected = f.expected(), clock = Date.now;
  original.status = 'void'; original.amount_paid = 0; original.charge = null; original.status_transitions = { paid_at: null };
  f.records.forEach(i => { i.period_start = 1; i.period_end = 2; i.status = 'uncollectible'; });
  Date.now = () => { throw Error('No current clock'); };
  try { assert.deepEqual(await read(f.options), expected); } finally { Date.now = clock; }
});
test('initial embedded-line graph is never traversed or used to re-prove funding', async () => {
  const f = setup(), expected = f.expected(); let reads = 0;
  f.records.at(-1).lines = new Proxy({}, { get() { reads++; throw Error('No original line reads'); } });
  f.sdk.invoices.list = async () => ({ object: 'list', has_more: false, data: f.records });
  assert.deepEqual(await read(f.options), expected); assert.equal(reads, 0);
});
test('unsupported actual provider calendar is surfaced at409 without money fallback', async () => {
  const f = setup(); f.lines.get(f.records[0].id).data[0].period.end++;
  await denied(f, 'retail_recurring_period_unsupported');
});
test('poison descriptors/proxies never execute; sealed root SDK metadata stays inert', async () => {
  let accesses = 0;
  for (const stage of ['input', 'page', 'array', 'invoice', 'line']) {
    const f = setup(), get = () => { accesses++; throw Error('PRIVATE'); };
    if (stage === 'input') Object.defineProperty(f.options, 'agreementId', { enumerable: true, get });
    else if (stage === 'line') f.sdk.invoices.listLineItems = async () => ({ object: 'list', has_more: false, data: [new Proxy({}, { get })] });
    else { const old = f.sdk.invoices.list; f.sdk.invoices.list = async args => { const r = await old(args);
      if (stage === 'page') Object.defineProperty(r, 'data', { enumerable: true, get });
      if (stage === 'array') Object.defineProperty(r.data, '0', { enumerable: true, get });
      if (stage === 'invoice') Object.defineProperty(r.data[0], 'id', { enumerable: true, get }); return r; }; }
    await denied(f);
  }
  assert.equal(accesses, 0);
  const f = setup(), old = f.sdk.invoices.list;
  f.sdk.invoices.list = async args => { const r = await old(args);
    Object.defineProperty(r, 'lastResponse', { value: new Proxy({}, { get() { accesses++; throw Error('PRIVATE'); } }) }); return r; };
  assert.equal((await read(f.options)).cycle_count, 4); assert.equal(accesses, 0);
});
test('DB/provider errors are sanitized503; no calls to write/charges/subscription/activation APIs', async () => {
  for (const stage of ['db', 'account', 'invoices', 'lines']) {
    const f = setup(), fail = async () => { throw Error('PRIVATE_URL_TOKEN'); };
    if (stage === 'db') f.db.rpc = fail;
    if (stage === 'account') f.sdk.accounts.retrieve = fail;
    if (stage === 'invoices') f.sdk.invoices.list = fail;
    if (stage === 'lines') f.sdk.invoices.listLineItems = fail;
    await denied(f, 'retail_recurring_census_unknown', 503);
  }
  const f = setup(); for (const key of ['subscriptions', 'charges', 'paymentIntents', 'checkout']) f.sdk[key] = new Proxy({}, { get() { throw Error('No operations outside invoice read'); } });
  f.db.from = () => { throw Error('No table mutation'); }; assert.equal((await read(f.options)).cycle_count, 4);
});
test('installed SDK retains2023 read paths/query/header and all requests stay local loopback', async () => {
  const http = require('node:http'), Stripe = require('stripe'), f = setup(), requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, version: req.headers['stripe-version'] }); const u = new URL(req.url, 'http://127.0.0.1');
    const r = u.pathname === '/v1/account' ? { object: 'account', id: 'acct_SYNTHETIC' }
      : u.pathname === '/v1/invoices' ? { object: 'list', has_more: false, data: f.records }
        : f.lines.get(u.pathname.split('/')[3]);
    if (!r) { res.statusCode = 500; res.end('synthetic unrecognized read'); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(r));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    f.options.stripe = new Stripe('sk_test_SYNTHETIC_NO_PROVIDER', { apiVersion: '2023-10-16', host: '127.0.0.1',
      port: server.address().port, protocol: 'http', maxNetworkRetries: 0 });
    assert.deepEqual(await read(f.options), f.expected()); assert.ok(requests.every(r => r.method === 'GET' && r.version === '2023-10-16'));
    assert.deepEqual(requests.filter(r => r.url.startsWith('/v1/invoices?')).map(r => r.url), Array(2).fill('/v1/invoices?subscription=sub_SYNTHETIC&limit=100'));
    assert.equal(requests.filter(r => /\/lines\?limit=100$/.test(r.url)).length, 4);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('SDK census remains unmounted in every source extension', () => {
  function scan(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? scan(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
  assert.deepEqual(scan(path.join(__dirname, '../src')).filter(p => /\.(js|cjs|mjs|ts|tsx)$/.test(p)
    && !p.endsWith('/existingRetailRecurringCensus.js') && fs.readFileSync(p, 'utf8').includes('existingRetailRecurringCensus')), []);
});
