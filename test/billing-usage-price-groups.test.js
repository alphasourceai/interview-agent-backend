'use strict';
// In-memory synthetic DB/provider graph, not PostgreSQL or Stripe acceptance.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createHash } = require('node:crypto');
const { createFakeSupabase } = require('./helpers/fakeSupabase');
const { applyUsageToInvoice } = require('../src/services/usageBilling');
const CLIENT = 'synthetic_client', ROLE = 'synthetic_role', INVOICE = 'in_synthetic';
const NOW = '2026-09-15T00:00:00.000Z';
function key(roleId, price, interviews) {
  return createHash('sha256').update(JSON.stringify({ invoiceId: INVOICE, clientId: CLIENT,
    roleId, price, interviews: [...interviews].sort() })).digest('hex');
}
function fixture(prices = [2500, 3000], dbOptions = {}) {
  const failOn = {};
  const rows = prices.map((price, index) => ({ id: `synthetic_row_${index}`, client_id: CLIENT,
    role_id: ROLE, interview_id: `synthetic_iv_${index}`, unit_price_cents: price,
    stripe_invoice_id: INVOICE, stripe_invoice_item_id: null, billed_at: null,
    period_start: '2026-08-01T00:00:00.000Z', period_end: '2026-09-01T00:00:00.000Z' }));
  const db = createFakeSupabase({ clients: [{ id: CLIENT, parent_client_id: null }],
    client_plan_settings: [{ client_id: CLIENT, plan_tier: 'enterprise', billing_model: 'usage',
      included_interviews_per_role: 0, usage_interview_fee_cents: 2500 }],
    roles: [{ id: ROLE, client_id: CLIENT, title: 'Synthetic Role' }], interviews: [],
    usage_billing_ledger: rows }, { failOn, ...dbOptions });
  const items = [], keys = new Map();
  let created = 0;
  const stripe = { invoiceItems: {
    list: async () => ({ data: [...items], has_more: false }),
    create: async (payload, options) => {
      if (keys.has(options?.idempotencyKey)) return keys.get(options.idempotencyKey);
      const item = { id: `ii_synthetic_${created++}`, ...payload,
        amount: payload.unit_amount * payload.quantity };
      items.push(item); keys.set(options?.idempotencyKey, item); return item;
    }
  } };
  return { db, rows, items, keys, stripe, failOn,
    run: () => applyUsageToInvoice({ db, stripe, clientId: CLIENT, customerId: 'cus_synthetic',
      invoiceId: INVOICE, asOf: NOW, now: NOW }) };
}
function item({ price = 2500, quantity = 1, role = ROLE, interviews = ['synthetic_iv_0'], amount } = {}) {
  return { id: 'ii_existing', invoice: INVOICE, customer: 'cus_synthetic', currency: 'usd',
    quantity, amount: amount ?? price * quantity,
    metadata: { client_id: CLIENT, role_id: role, source: 'usage_billing',
      usage_operation: key(role, price, interviews) } };
}

test('mixed reserved prices produce two exact items, not first-price multiplication', async () => {
  const f = fixture();
  f.db.tables.client_plan_settings[0].usage_interview_fee_cents = 9999;
  const result = await f.run();
  assert.equal(result.total_cents, 5500);
  assert.equal(result.items, 2);
  assert.deepEqual(f.items.map(i => [i.unit_amount, i.quantity, i.amount]), [[2500, 1, 2500], [3000, 1, 3000]]);
  assert.equal(f.rows[0].stripe_invoice_item_id, f.items[0].id);
  assert.equal(f.rows[1].stripe_invoice_item_id, f.items[1].id);
  assert.ok(f.rows.every(r => r.billed_at === NOW));
  assert.deepEqual([...f.keys.keys()], [
    `usage-item-${key(ROLE, 2500, ['synthetic_iv_0'])}`,
    `usage-item-${key(ROLE, 3000, ['synthetic_iv_1'])}`
  ]);
});
test('same-price rows stay one group and use exact original key shape', async () => {
  const f = fixture([2500, 2500]);
  assert.equal((await f.run()).total_cents, 5000);
  assert.equal(f.items.length, 1);
  assert.equal(f.items[0].metadata.usage_operation, key(ROLE, 2500, ['synthetic_iv_0', 'synthetic_iv_1']));
  assert.equal(f.items[0].quantity, 2);
  assert.equal((await f.run()).reason, 'already_billed');
  assert.equal(f.items.length, 1);
});
test('same role can have multiple quantities at each frozen price, including DB integer strings', async () => {
  const f = fixture([2500, '3000', '2500']);
  assert.equal((await f.run()).total_cents, 8000);
  assert.deepEqual(f.items.map(i => [i.quantity, i.amount]), [[2, 5000], [1, 3000]]);
  assert.equal(f.rows[0].stripe_invoice_item_id, f.rows[2].stripe_invoice_item_id);
  assert.notEqual(f.rows[0].stripe_invoice_item_id, f.rows[1].stripe_invoice_item_id);
});
test('old legitimate zero-price usage is preserved', async () => {
  const f = fixture([0, 3000]);
  assert.equal((await f.run()).total_cents, 3000);
  assert.deepEqual(f.items.map(i => i.amount), [0, 3000]);
});
for (const which of [1, 2]) {
  test(`lost response at mixed group ${which} recovers after provider key-cache expiry`, async () => {
    const f = fixture(), create = f.stripe.invoiceItems.create;
    let call = 0;
    f.stripe.invoiceItems.create = async (...args) => {
      const result = await create(...args);
      if (++call === which) throw Error('synthetic lost response');
      return result;
    };
    await assert.rejects(f.run(), /synthetic lost response/);
    f.keys.clear(); f.stripe.invoiceItems.create = create;
    f.db.tables.roles[0].title = 'Renamed';
    await f.run();
    assert.equal(f.items.length, 2);
    assert.equal(f.items.reduce((n, i) => n + i.amount, 0), 5500);
    assert.ok(f.rows.every(r => r.billed_at === NOW));
  });
}
test('provider-accepted mixed item survives failed native stamp without duplicate charge', async () => {
  const f = fixture();
  f.failOn.usage_billing_ledger = { op: 'update', error: { message: 'synthetic stamp outage' } };
  await assert.rejects(f.run(), /synthetic stamp outage/);
  assert.equal(f.items.length, 1);
  assert.ok(f.rows.every(r => r.billed_at === null));
  f.keys.clear();
  await f.run();
  assert.equal(f.items.length, 2);
  assert.equal(f.items.reduce((n, i) => n + i.amount, 0), 5500);
});
test('already stamped price group remains recognized when only second group is pending', async () => {
  const f = fixture();
  f.rows[0].billed_at = NOW; f.rows[0].stripe_invoice_item_id = 'ii_existing';
  f.items.push(item());
  const result = await f.run();
  assert.equal(result.items, 1); assert.equal(result.total_cents, 3000);
  assert.equal(f.items.length, 2);
  assert.equal(f.rows[0].stripe_invoice_item_id, 'ii_existing');
  assert.ok(f.rows.every(r => r.billed_at === NOW));
});
for (const amount of [5000, 5500]) {
  test(`old combined item ${amount}c holds before any new group or other-role mutation`, async () => {
    const f = fixture();
    f.rows.unshift({ ...f.rows[0], id: 'synthetic_other', role_id: 'synthetic_other_role', interview_id: 'synthetic_other_iv' });
    f.items.push(item({ quantity: 2, interviews: ['synthetic_iv_0', 'synthetic_iv_1'], amount }));
    await assert.rejects(f.run(), /USAGE_INVOICE_REQUIRES_REVIEW/);
    assert.equal(f.items.length, 1);
    assert.equal(f.keys.size, 0);
    assert.ok(f.rows.every(r => r.billed_at === null && r.stripe_invoice_item_id === null));
  });
}
test('partially stamped group cannot be split into another charge', async () => {
  const f = fixture([2500, 2500, 3000]);
  f.rows[0].billed_at = NOW;
  await assert.rejects(f.run(), /partially stamped price group/);
  assert.equal(f.items.length, 0);
  assert.equal(f.rows[1].billed_at, null);
});
for (const [name, mutate] of Object.entries({
  unknownKey: i => { i.metadata.usage_operation = 'unknown'; },
  missingKey: i => { delete i.metadata.usage_operation; },
  wrongInvoice: i => { i.invoice = 'in_other'; },
  wrongCustomer: i => { i.customer = 'cus_other'; },
  wrongClient: i => { i.metadata.client_id = 'other'; },
  wrongRole: i => { i.metadata.role_id = 'other'; },
  changedSource: i => { i.metadata.source = 'other_feature'; },
  missingSource: i => { delete i.metadata.source; },
  wrongCurrency: i => { i.currency = 'eur'; },
  wrongAmount: i => { i.amount -= 1; },
  wrongQuantity: i => { i.quantity = 2; },
  nullAmount: i => { i.amount = null; },
  stringAmount: i => { i.amount = '2500'; },
  stringQuantity: i => { i.quantity = '1'; },
  booleanQuantity: i => { i.quantity = true; },
  missingId: i => { delete i.id; }
})) {
  test(`mixed provider preflight holds ${name} before all writes`, async () => {
    const f = fixture(), existing = item(); mutate(existing); f.items.push(existing);
    await assert.rejects(f.run(), /USAGE_INVOICE_REQUIRES_REVIEW/);
    assert.equal(f.items.length, 1); assert.equal(f.keys.size, 0);
    assert.ok(f.rows.every(r => r.billed_at === null));
  });
}
test('duplicate provider operation is rejected even under distinct item IDs', async () => {
  const f = fixture(); f.items.push(item(), { ...item(), id: 'ii_duplicate' });
  await assert.rejects(f.run(), /unknown or duplicate mixed-price operation/);
  assert.equal(f.items.length, 2); assert.ok(f.rows.every(r => r.billed_at === null));
});
test('null native amount cannot masquerade as a legitimate zero-price item', async () => {
  const f = fixture([0, 3000]), existing = item({ price: 0 });
  existing.amount = null; f.items.push(existing);
  await assert.rejects(f.run(), /mixed-price provider item mismatch/);
  assert.equal(f.items.length, 1); assert.ok(f.rows.every(r => r.billed_at === null));
});
test('unknown aggregate on a later page blocks even earlier uniform-role writes', async () => {
  const f = fixture();
  f.rows.unshift({ ...f.rows[0], id: 'synthetic_other_row', role_id: 'synthetic_other_role', interview_id: 'synthetic_other_iv' });
  f.items.push({ id: 'ii_other', metadata: { source: 'other_feature' } },
    item({ quantity: 2, interviews: ['synthetic_iv_0', 'synthetic_iv_1'] }));
  f.stripe.invoiceItems.list = async ({ starting_after }) => ({
    data: starting_after ? [f.items[1]] : [f.items[0]], has_more: !starting_after });
  await assert.rejects(f.run(), /unknown or duplicate mixed-price operation/);
  assert.equal(f.keys.size, 0); assert.ok(f.rows.every(r => r.billed_at === null));
});
test('provider history exceeding fixed page budget holds without effects', async () => {
  const f = fixture(); let pages = 0;
  f.stripe.invoiceItems.list = async () => ({
    data: [{ id: `ii_other_${++pages}`, metadata: { source: 'other_feature' } }], has_more: true });
  await assert.rejects(f.run(), /mixed-price provider scan limit/);
  assert.equal(pages, 100); assert.equal(f.items.length, 0);
  assert.ok(f.rows.every(r => r.billed_at === null));
});
test('mixed create response must have exact provider readback before native stamp', async () => {
  for (const mode of ['missing', 'changed', 'lateAggregate']) {
    const f = fixture(), create = f.stripe.invoiceItems.create;
    f.stripe.invoiceItems.create = async (...args) => {
      const result = await create(...args);
      if (mode === 'missing') f.items.length = 0;
      else if (mode === 'changed') result.amount = 1;
      else f.items.push(item({ quantity: 2, interviews: ['synthetic_iv_0', 'synthetic_iv_1'] }));
      return result;
    };
    await assert.rejects(f.run(), /USAGE_INVOICE_REQUIRES_REVIEW/);
    assert.ok(f.rows.every(r => r.billed_at === null));
    assert.equal(f.keys.size, 1, 'stop before the second provider group');
  }
});
test('complete later provider page can recover the missing known item', async () => {
  const f = fixture();
  f.items.push({ id: 'ii_other', metadata: { source: 'other_feature' } }, item());
  f.stripe.invoiceItems.list = async ({ starting_after }) => {
    const start = starting_after ? f.items.findIndex(i => i.id === starting_after) + 1 : 0;
    return { data: f.items.slice(start, start + 1), has_more: start + 1 < f.items.length };
  };
  await f.run();
  assert.equal(f.items.length, 3);
  assert.equal(f.items.reduce((n, i) => n + (i.amount || 0), 0), 5500);
});
for (const [name, list] of Object.entries({ missingCompleteness: async () => ({ data: [] }),
  invalidData: async () => ({ data: null, has_more: false }),
  emptyNextPage: async () => ({ data: [], has_more: true }),
  repeatedCursor: async () => ({ data: [{ id: 'ii_repeat', metadata: {} }], has_more: true }) })) {
  test(`mixed provider pagination holds ${name} without mutation`, async () => {
    const f = fixture(); f.stripe.invoiceItems.list = list;
    await assert.rejects(f.run(), /USAGE_INVOICE_REQUIRES_REVIEW/);
    assert.equal(f.items.length, 0); assert.ok(f.rows.every(r => r.billed_at === null));
  });
}
for (const value of [null, undefined, -1, 1.5, 'bad', '', true, 2147483648]) {
  test(`invalid reserved unit ${String(value)} cannot silently become free`, async () => {
    const f = fixture([value, 3000]);
    await assert.rejects(f.run(), /invalid reserved price group/);
    assert.equal(f.items.length, 0); assert.ok(f.rows.every(r => r.billed_at === null));
  });
}
test('duplicate interviews and overflowing groups hold before provider writes', async () => {
  for (const mode of ['duplicate', 'overflow']) {
    const f = fixture(mode === 'overflow' ? [2147483647, 2147483647] : [2500, 3000]);
    if (mode === 'duplicate') f.rows[1].interview_id = f.rows[0].interview_id;
    await assert.rejects(f.run(), /USAGE_INVOICE_REQUIRES_REVIEW/);
    assert.equal(f.items.length, 0);
  }
});
test('concurrent mixed-price replay uses exact stable keys without a second item', async () => {
  const f = fixture(); await Promise.all([f.run(), f.run()]);
  assert.equal(f.items.length, 2);
  assert.equal(f.items.reduce((n, i) => n + i.amount, 0), 5500);
  assert.ok(f.rows.every(r => r.billed_at === NOW));
});

// A fresh reserve can own only A while a concurrent worker inserted B. The
// complete invoice census must still detect a lost old [A,B] combined item.
function freshOwnedFixture({ amount = null, otherRole = false, siblingPrice = 3000 } = {}) {
  const f = fixture(), sibling = { ...f.rows[1], unit_price_cents: siblingPrice };
  f.rows.length = 0;
  f.db.tables.interviews.push({ id: 'synthetic_iv_0', client_id: CLIENT, role_id: ROLE,
    status: 'completed', completed_at: '2026-08-11T00:00:00.000Z' });
  if (otherRole) {
    f.db.tables.roles.push({ id: 'synthetic_other_role', client_id: CLIENT, title: 'Other synthetic role' });
    f.db.tables.interviews.unshift({ id: 'synthetic_other_iv', client_id: CLIENT,
      role_id: 'synthetic_other_role', status: 'completed', completed_at: '2026-08-10T00:00:00.000Z' });
  }
  const from = f.db.from;
  let inserted = false;
  f.db.from = table => {
    const query = from(table);
    if (table === 'usage_billing_ledger') {
      const upsert = query.upsert;
      query.upsert = (...args) => {
        if (!inserted) { f.rows.push(sibling); inserted = true; }
        return upsert(...args);
      };
    }
    return query;
  };
  if (amount !== null) f.items.push(item({ quantity: 2,
    interviews: ['synthetic_iv_0', 'synthetic_iv_1'], amount }));
  return f;
}
for (const amount of [5000, 5500]) for (const otherRole of [false, true]) {
  test(`fresh single-price owned subset sees sibling and holds combined ${amount}, other role=${otherRole}`, async () => {
    const f = freshOwnedFixture({ amount, otherRole });
    await assert.rejects(f.run(), /unknown or duplicate mixed-price operation/);
    assert.equal(f.items.length, 1); assert.equal(f.keys.size, 0);
    assert.equal(f.rows.length, otherRole ? 3 : 2);
    assert.ok(f.rows.every(r => r.billed_at === null));
  });
}
test('fresh owned subset charges only A, not sibling B; next replay reconciles without duplication', async () => {
  const f = freshOwnedFixture();
  const first = await f.run();
  assert.equal(first.items, 1); assert.equal(first.total_cents, 2500);
  assert.equal(f.items.length, 1);
  assert.equal(f.rows.find(r => r.interview_id === 'synthetic_iv_1').billed_at, null);
  f.keys.clear();
  assert.equal((await f.run()).total_cents, 3000);
  assert.equal(f.items.length, 2);
  assert.equal(f.items.reduce((n, i) => n + i.amount, 0), 5500);
});
test('owned subset of a wider same-price group holds rather than widen charge or invent batch', async () => {
  const f = freshOwnedFixture({ siblingPrice: 2500 });
  await assert.rejects(f.run(), /partial owned price group/);
  assert.equal(f.items.length, 0); assert.ok(f.rows.every(r => r.billed_at === null));
});
test('exact census count rejects a capped invoice scan before any provider operation', async () => {
  const f = fixture([2500, 3000], { maxRows: 1 });
  await assert.rejects(f.run(), /incomplete invoice ledger census/);
  assert.equal(f.items.length, 0); assert.ok(f.rows.every(r => r.billed_at === null));
});
test('missing exact native count cannot establish a complete census', async () => {
  const f = fixture(), from = f.db.from;
  f.db.from = table => {
    const query = from(table), then = query.then;
    if (table === 'usage_billing_ledger') query.then = (resolve, reject) => then(
      result => resolve({ ...result, count: undefined }), reject);
    return query;
  };
  await assert.rejects(f.run(), /incomplete invoice ledger census/);
  assert.equal(f.items.length, 0); assert.ok(f.rows.every(r => r.billed_at === null));
});
test('uniform role with an unknown wider key holds instead of skipping it', async () => {
  const f = fixture([2500]);
  f.items.push(item({ quantity: 2, interviews: ['synthetic_iv_0', 'synthetic_unknown'] }));
  await assert.rejects(f.run(), /unknown or duplicate mixed-price operation/);
  assert.equal(f.items.length, 1); assert.equal(f.rows[0].billed_at, null);
});
