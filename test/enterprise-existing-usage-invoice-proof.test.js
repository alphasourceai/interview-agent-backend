'use strict';
// Fake SDK and authored native rows only. Not hosted/provider/payment acceptance.
const { test } = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const dbPath = require.resolve('../src/clients/supabase');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
  exports: { supabaseAdmin: { from() { throw Error('pure test DB forbidden'); } } } };
const accepted = require('./helpers/accepted-enterprise-usage-fixture');
const { planEnterpriseExistingUsage: plan } = require('../src/services/enterpriseExistingUsageReservation');
const { usageOperationKey } = require('../src/services/usageBilling');
const proof = require('../src/services/enterpriseExistingUsageInvoiceProof');
const clone = v => structuredClone(v);
async function binding() {
  const f = await accepted(), role = randomUUID(), role2 = randomUUID(), quantity = f.w.funding_receipt.proof.quantity;
  const s = { version: 'enterprise_existing_usage_snapshot_v1', owner_id: f.client.id, agreement_id: f.a.id,
    month_start: '2026-10-01T00:00:00.000Z', month_end: '2026-11-01T00:00:00.000Z', observed_at: '2026-11-01T00:00:01.000Z',
    receipt: f.w, clients: [{ ...f.client, parent_client_id: null, archived_at: null }],
    agreements: [{ ...f.a, superseded_by_agreement_id: null, voided_at: null }], settings: [f.plan],
    roles: [{ id: role, client_id: f.client.id, title: 'Synthetic Alpha', status: 'open' },
      { id: role2, client_id: f.client.id, title: 'Synthetic Beta', status: 'closed' }],
    interviews: Array.from({ length: quantity + 2 }, (_, i) => ({ id: randomUUID(),
      role_id: i === quantity + 1 ? role2 : role, client_id: f.client.id,
      completed_at: new Date(Date.parse('2026-10-02T00:00:00Z') + i * 1000).toISOString(),
      updated_at: '2026-10-02T12:00:00.000Z', status: 'completed', transcript_scores: null, interview_summary: null,
      has_substantive_response: true, failure_code: null, conversation_progress_state: null })),
    pools: [{ id: f.w.funding_receipt.proof.pool_id, client_id: f.client.id, quantity_purchased: quantity,
      status: 'paid', paid_at: f.w.funding_receipt.proof.payment_success_at, created_at: '2026-10-01T12:00:00.000Z' }],
    purchases: [], credits: [], ledger: [], intents: [], customers: [], seals: [], history: [] };
  const p = plan(s), b = { id: randomUUID(), owner_id: s.owner_id, agreement_id: s.agreement_id,
    account_id: f.w.funding_receipt.proof.provider_account_id, livemode: f.w.funding_receipt.proof.livemode,
    customer_id: f.w.client_initial.stripe_customer_id, subscription_id: f.w.client_initial.stripe_subscription_id,
    unit_price_cents: 2500, snapshot_digest: 'a'.repeat(64), service_month: '2026-10-01', generation: 1,
    phase: 'reserved', snapshot: s, groups: p.groups, prefix: p.prefix };
  return { raw: clone(b), b: proof.usageInvoiceBinding(b) };
}
function objects(b, size = b.groups.length, stage = 'draft') {
  const invoiceId = 'in_SYNTHETIC', items = [], lines = [];
  for (const [n, g] of b.groups.slice(0, size).entries()) {
    const r = proof.usageInvoiceItemRequest(b, invoiceId, g.role_id).body;
    const price = { id: `price_SYNTHETIC${n}`, object: 'price', livemode: b.livemode, currency: 'usd',
      unit_amount: r.unit_amount, unit_amount_decimal: String(r.unit_amount), type: 'one_time', recurring: null,
      billing_scheme: 'per_unit', transform_quantity: null, tiers_mode: null, custom_unit_amount: null };
    const item = { id: `ii_SYNTHETIC${n}`, object: 'invoiceitem', ...r, livemode: b.livemode, subscription: null,
      proration: false, tax_rates: [], discounts: [], unit_amount_decimal: String(r.unit_amount),
      amount: r.unit_amount * r.quantity, price };
    items.push(item); lines.push({ id: `il_SYNTHETIC${n}`, object: 'line_item', type: 'invoiceitem',
      invoice_item: item.id, invoice: invoiceId, livemode: b.livemode, subscription: null, currency: 'usd',
      proration: false, tax_amounts: [], tax_rates: [], discount_amounts: [], discounts: [], price,
      quantity: r.quantity, amount: item.amount, amount_excluding_tax: item.amount,
      unit_amount_excluding_tax: String(r.unit_amount), description: r.description, period: r.period, metadata: r.metadata });
  }
  const sum = items.reduce((sum, i) => sum + i.amount, 0), paid = stage === 'paid';
  const invoice = { id: invoiceId, object: 'invoice', livemode: b.livemode, customer: b.customer_id,
    subscription: null, currency: 'usd', collection_method: 'charge_automatically', auto_advance: false,
    paid_out_of_band: false, status: stage, paid, attempted: paid, amount_paid: paid ? sum : 0,
    amount_remaining: stage === 'open' ? sum : 0, ending_balance: stage === 'draft' ? null : 0,
    metadata: proof.usageInvoiceCreateRequest(b).body.metadata, automatic_tax: { enabled: false },
    default_tax_rates: [], total_tax_amounts: [], tax: null, discount: null, discounts: [], total_discount_amounts: [],
    pre_payment_credit_notes_amount: 0, post_payment_credit_notes_amount: 0, starting_balance: 0,
    application_fee_amount: null, transfer_data: null, on_behalf_of: null, shipping_cost: null,
    total: sum, subtotal: sum, amount_due: sum, subtotal_excluding_tax: sum, total_excluding_tax: sum,
    status_transitions: { finalized_at: 1793491202, paid_at: paid ? 1793491203 : null },
    payment_intent: paid ? 'pi_SYNTHETIC' : null, charge: paid ? 'ch_SYNTHETIC' : null };
  return { binding: b, invoiceId, invoice, items, lines, provenRoleIds: b.groups.slice(0, size).map(g => g.role_id),
    stage: stage === 'draft' ? (size ? 'items' : 'shell') : stage === 'open' ? 'finalized' : 'paid',
    replayInvoiceId: size ? null : invoiceId };
}
test('native groups and frozen role labels reuse allocation and old stable item key; no caller customer', async () => {
  const { raw, b } = await binding(); assert.equal(b.total_cents, 5000); assert.equal(b.groups.length, 2);
  const before = clone(raw); proof.usageInvoiceBinding(raw); assert.deepEqual(raw, before);
  const request = proof.usageInvoiceCreateRequest(b);
  assert.equal(request.key, `enterprise-usage-invoice:${raw.id}`); assert.equal(request.body.customer, raw.customer_id);
  for (const field of ['subscription', 'default_payment_method', 'default_source']) assert.equal(Object.hasOwn(request.body, field), false);
  const g = b.groups[0], item = proof.usageInvoiceItemRequest(b, 'in_SYNTHETIC', g.role_id);
  assert.equal(item.key, `usage-item-${usageOperationKey({ invoiceId: 'in_SYNTHETIC', clientId: raw.owner_id, line: g })}`);
  assert.deepEqual(clone(item.body.period), { start: 1790812800, end: 1793491200 });
  assert.match(item.body.description, /Synthetic (Alpha|Beta).*October 2026/);
  const newer = { ...b, generation: 99 };
  assert.deepEqual(proof.usageInvoiceCreateRequest(newer), request);
  assert.deepEqual(proof.usageInvoiceItemRequest(newer, 'in_SYNTHETIC', g.role_id), item);
  assert.deepEqual(clone(proof.usageInvoiceFinalizeRequest(b, 'in_SYNTHETIC').body), { auto_advance: false });
  assert.deepEqual(clone(proof.usageInvoicePayRequest(b, 'in_SYNTHETIC', 'pm_SYNTHETIC').body),
    { payment_method: 'pm_SYNTHETIC', off_session: true });
});
test('tampered rate, allocation, prefix, account and no_usage hold before building any request', async () => {
  for (const change of [b => { b.groups[0].unit_price_cents = 1; }, b => { b.prefix.pop(); },
    b => { b.account_id = 'acct_FOREIGN'; }, b => { b.phase = 'no_usage'; }, b => { b.customer_id = 'cus_FOREIGN'; }]) {
    const { raw } = await binding(); change(raw); assert.throws(() => proof.usageInvoiceBinding(raw), { code: 'enterprise_usage_invoice_held' });
  }
});
test('shell and per-role partial proofs precede full finalized proof; never claim cash or effects', async () => {
  const { b } = await binding();
  for (const [n, status] of [[0, 'draft'], [1, 'draft'], [2, 'draft'], [2, 'open'], [2, 'paid']]) {
    const f = objects(b, n, status), p = proof.verifyUsageInvoicePhase(f);
    assert.equal(p.total_cents, n * 2500); assert.equal(p.provider_effect_authorized, false);
    assert.equal(p.paid_access_authorized, false); assert.equal(p.payroll_authorized, false);
  }
  const partial = objects(b, 1, 'open'); assert.throws(() => proof.verifyUsageInvoicePhase(partial));
  const shell = objects(b, 0); shell.replayInvoiceId = null; assert.throws(() => proof.verifyUsageInvoicePhase(shell));
});
for (const [name, change] of [
  ['tax', f => { f.invoice.total_tax_amounts = [{ amount: 0 }]; }],
  ['balance', f => { f.invoice.starting_balance = 1; }],
  ['foreign subscription', f => { f.invoice.subscription = f.binding.subscription_id; }],
  ['credit note', f => { f.invoice.pre_payment_credit_notes_amount = 1; }],
  ['amount coercion', f => { f.items[0].quantity = '1'; }],
  ['price drift', f => { f.lines[0].price.unit_amount = 1; }],
  ['changed frozen label', f => { f.items[0].description = 'Other'; }],
  ['future group at partial phase', f => { f.provenRoleIds.pop(); }],
  ['reordered role proof', f => { f.provenRoleIds.reverse(); }],
  ['proration', f => { f.lines[0].proration = true; }],
  ['extra item', f => { f.items.push(clone(f.items[0])); }],
  ['extra line', f => { f.lines.push(clone(f.lines[0])); }],
  ['period inclusive adjustment', f => { f.items[0].period.end--; }],
  ['unknown draft balance', f => { delete f.invoice.ending_balance; }],
  ['provider auto advancement', f => { f.invoice.auto_advance = true; }]
]) test(`${name} rejects the entire phase, with no partial or monetary authority`, async () => {
  const { b } = await binding(), f = objects(b); change(f);
  assert.throws(() => proof.verifyUsageInvoicePhase(f), { code: 'enterprise_usage_invoice_held' });
});
function methodFixture(b, cd = 'pm_SYNTHETIC', sd = 'pm_SYNTHETIC') {
  return { binding: b, customer: { id: b.customer_id, object: 'customer', livemode: b.livemode,
    default_source: null, invoice_settings: { default_payment_method: cd } },
  subscription: { id: b.subscription_id, object: 'subscription', customer: b.customer_id, livemode: b.livemode,
    default_source: null, default_payment_method: sd }, paymentMethod: { id: 'pm_SYNTHETIC', object: 'payment_method',
    type: 'card', customer: b.customer_id, livemode: b.livemode, card: { synthetic: 'not persisted' } } };
}
test('payment selection reuses saved subscription card, or equal/only customer default; retains id only', async () => {
  const { b } = await binding();
  for (const [cd, sd] of [[null, 'pm_SYNTHETIC'], ['pm_SYNTHETIC', null], ['pm_SYNTHETIC', 'pm_SYNTHETIC']])
    assert.equal(proof.selectUsageInvoicePaymentMethod(methodFixture(b, cd, sd)), 'pm_SYNTHETIC');
});
test('conflicting/missing/default-source/noncard/foreign payment selection holds, never rewrites', async () => {
  const { b } = await binding();
  for (const [cd, sd] of [[null, null], ['pm_OTHER', 'pm_SYNTHETIC'], ['src_SYNTHETIC', null]])
    assert.throws(() => proof.selectUsageInvoicePaymentMethod(methodFixture(b, cd, sd)));
  for (const change of [f => { f.paymentMethod.type = 'us_bank_account'; }, f => { f.paymentMethod.customer = 'cus_OTHER'; },
    f => { f.subscription.default_source = 'card_OLD'; }, f => { f.customer.deleted = true; }]) {
    const f = methodFixture(b); change(f); assert.throws(() => proof.selectUsageInvoicePaymentMethod(f));
  }
});
test('paid proof requires pinned invoice, exact full phase, successful same method PI/charge and refund census', async () => {
  const { b } = await binding(), f = objects(b, 2, 'paid');
  Object.assign(f, { paymentMethodId: 'pm_SYNTHETIC', observationEpoch: 1793491204, refunds: [],
    paymentIntent: { id: 'pi_SYNTHETIC', object: 'payment_intent', customer: b.customer_id, livemode: b.livemode,
      currency: 'usd', amount: b.total_cents, amount_received: b.total_cents, created: 1793491202, status: 'succeeded',
      invoice: f.invoiceId, latest_charge: 'ch_SYNTHETIC', payment_method: 'pm_SYNTHETIC' },
    charge: { id: 'ch_SYNTHETIC', object: 'charge', customer: b.customer_id, livemode: b.livemode,
      currency: 'usd', amount: b.total_cents, amount_captured: b.total_cents, created: 1793491202, status: 'succeeded',
      invoice: f.invoiceId, payment_intent: 'pi_SYNTHETIC', payment_method: 'pm_SYNTHETIC', paid: true,
      captured: true, amount_refunded: 0, refunded: false, disputed: false, refunds: null } });
  const result = proof.verifyUsageInvoicePaid(f); assert.equal(result.amount_cents, 5000);
  assert.equal(result.payroll_authorized, false); assert.equal(result.paid_access_authorized, false);
  for (const change of [x => { x.invoiceId = 'in_OTHER'; }, x => { x.paymentIntent.status = 'processing'; },
    x => { x.charge.payment_method = 'pm_OTHER'; }, x => { x.charge.amount_refunded = 1; },
    x => { x.refunds = [{ id: 're_SYNTHETIC' }]; }, x => { x.invoice.paid_out_of_band = true; },
    x => { x.lines.pop(); }]) { const bad = clone(f); change(bad); assert.throws(() => proof.verifyUsageInvoicePaid(bad)); }
});
test('pagination follows every page, holds ceiling/duplicates/no progress instead of claiming absence', async () => {
  const calls = []; const rows = await proof.completePages(async args => { calls.push(args);
    return { object: 'list', data: [{ id: args.starting_after ? 'in_TWO' : 'in_ONE' }], has_more: !args.starting_after }; }, 'in');
  assert.equal(rows.length, 2); assert.equal(calls[1].starting_after, 'in_ONE');
  for (const read of [async () => ({ object: 'list', data: [], has_more: true }),
    async () => ({ object: 'list', data: [{ id: 'in_SAME' }], has_more: true })])
    await assert.rejects(() => proof.completePages(read, 'in', 2), { code: 'enterprise_usage_invoice_held' });
  await assert.rejects(() => proof.completePages(async () => ({ object: 'list', data: [{ id: 'in_ONE' }], has_more: true }), 'in', 1));
});
test('read-only SDK census keeps foreign platform invoices and never writes or infers absent effect', async () => {
  const { b } = await binding(), f = objects(b), calls = [];
  const foreign = { object: 'invoice', id: 'in_PLATFORM', customer: b.customer_id, subscription: b.subscription_id, livemode: b.livemode };
  const list = data => ({ object: 'list', data, has_more: false });
  const stripe = { getApiField: () => '2023-10-16', accounts: { retrieve: async () => ({ object: 'account', id: b.account_id }) },
    invoices: { list: async args => { calls.push(args); return list([f.invoice, foreign]); }, retrieve: async () => f.invoice,
      listLineItems: async () => list(f.lines) }, invoiceItems: { list: async () => list(f.items) } };
  const r = await proof.readUsageInvoiceCensus({ stripe, binding: b, invoiceId: f.invoiceId });
  assert.equal(r.invoices.length, 2); assert.equal(r.provider_effect_authorized, false); assert.equal(calls.length, 2);
  stripe.invoices.list = async () => list([foreign]);
  await assert.rejects(() => proof.readUsageInvoiceCensus({ stripe, binding: b, invoiceId: f.invoiceId }));
  const empty = await proof.readUsageInvoiceCensus({ stripe, binding: b });
  assert.equal(Object.hasOwn(empty, 'effect_absent'), false);
  stripe.getApiField = () => 'wrong'; await assert.rejects(() => proof.readUsageInvoiceCensus({ stripe, binding: b }));
});
