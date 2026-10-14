'use strict';
// Pure authored snapshots and RPC doubles only. Not native reservation, cash,
// hosted acceptance, or bank/provider proof. Native tests must follow separately.
const { test } = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const dbPath = require.resolve('../src/clients/supabase');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
  exports: { supabaseAdmin: { from() { throw Error('DB forbidden in pure gap'); }, rpc() { throw Error('DB forbidden in pure gap'); } } } };
const accepted = require('./helpers/accepted-enterprise-usage-fixture');
const { planEnterpriseExistingUsage: plan, prepareAndReserveEnterpriseExistingUsage: reserve } = require('../src/services/enterpriseExistingUsageReservation');
async function fixture(cadence = 'monthly') {
  const f = await accepted({ cadence }), role = crypto.randomUUID(), quantity = f.w.funding_receipt.proof.quantity;
  const agreement = { ...f.a, superseded_by_agreement_id: null, voided_at: null };
  const snapshot = { version: 'enterprise_existing_usage_snapshot_v1', owner_id: f.client.id, agreement_id: f.a.id,
    month_start: '2026-10-01T00:00:00.000Z', month_end: '2026-11-01T00:00:00.000Z', observed_at: '2026-11-01T00:00:01.000Z',
    receipt: f.w, clients: [{ ...f.client, parent_client_id: null, archived_at: null }], agreements: [agreement],
    settings: [f.plan], roles: [{ id: role, client_id: f.client.id, title: 'Synthetic Role', status: 'open' }],
    interviews: Array.from({ length: quantity + 2 }, (_, i) => ({ id: crypto.randomUUID(), role_id: role,
      client_id: f.client.id, completed_at: new Date(Date.parse('2026-10-02T00:00:00Z') + i * 1000).toISOString(),
      updated_at: '2026-10-02T12:00:00.000Z', status: 'completed', transcript_scores: null, interview_summary: null,
      has_substantive_response: true, failure_code: null, conversation_progress_state: null })),
    pools: [{ id: f.w.funding_receipt.proof.pool_id, client_id: f.client.id, quantity_purchased: quantity,
      status: 'paid', paid_at: f.w.funding_receipt.proof.payment_success_at, created_at: '2026-10-01T12:00:00.000Z' }],
    credits: [], purchases: [], ledger: [], intents: [], customers: [], seals: [], history: [] };
  return { s: structuredClone(snapshot), role, quantity };
}
for (const cadence of ['monthly','annual']) test(`same allocator uses accepted pool/rate for ${cadence} platform cadence`, async () => {
  const f = await fixture(cadence), before = structuredClone(f.s), result = plan(f.s);
  assert.equal(result.total_cents, 5000); assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].quantity, 2); assert.equal(result.groups[0].unit_price_cents, 2500);
  assert.equal(result.prefix.length, f.quantity + 2);
  assert.equal(result.prefix.filter(row => row.source === 'pool').length, f.quantity);
  assert.deepEqual(f.s, before);
  f.s.settings[0].usage_interview_fee_cents = 1; assert.equal(plan(f.s).total_cents, 5000);
});
test('unchanged existing pure allowance logic and no-usage result do not meter included service', async () => {
  const f = await fixture(); f.s.interviews.splice(f.quantity);
  const result = plan(f.s); assert.equal(result.no_usage, true); assert.equal(result.total_cents, 0);
  assert.deepEqual(result.groups, []); assert.equal(result.prefix.length, f.quantity);
});
test('used/current source is not reduced to a month-only or already-ledgered prefix', async () => {
  const f = await fixture(); f.s.interviews.push({ ...f.s.interviews[0], id: crypto.randomUUID(),
    completed_at: null, status: 'invited', has_substantive_response: false });
  assert.equal(plan(f.s).groups[0].quantity, 2);
  f.s.ledger.push({ id: crypto.randomUUID(), client_id: f.s.owner_id,
    interview_id: f.s.interviews.at(-2).id, role_id: f.role, unit_price_cents: 2500 });
  assert.throws(() => plan(f.s), { code: 'enterprise_usage_reservation_held' });
});
for (const [name, change] of [
  ['null used completion', s => { s.interviews[0].completed_at = null; }],
  ['before service', s => { s.interviews[0].completed_at = '2026-09-30T12:00:00.000Z'; }],
  ['after service', s => { s.interviews[0].completed_at = '2028-01-01T00:00:00.000Z'; }],
  ['future to observed clock', s => { s.interviews[0].completed_at = '2026-11-01T00:00:02.000Z'; }],
  ['wrong customer', s => { s.clients[0].stripe_customer_id = 'cus_FOREIGN'; }],
  ['duplicate interview', s => { s.interviews.push(s.interviews[0]); }],
  ['foreign role', s => { s.interviews[0].role_id = crypto.randomUUID(); }],
  ['foreign client', s => { s.interviews[0].client_id = crypto.randomUUID(); }],
  ['extra pool', s => { s.pools.push({ ...s.pools[0], id: crypto.randomUUID() }); }],
  ['missing pool', s => { s.pools = []; }],
  ['string count', s => { s.pools[0].quantity_purchased = String(s.pools[0].quantity_purchased); }],
  ['model fallback', s => { s.settings[0].billing_model = null; }],
  ['changed allowance', s => { s.settings[0].included_interviews_per_role = 1; }],
  ['bad timestamp', s => { s.interviews[0].updated_at = 'bad'; }],
  ['nested family', s => { const child = crypto.randomUUID(); s.clients.push({ id: child, parent_client_id: s.owner_id },
    { id: crypto.randomUUID(), parent_client_id: child }); }],
  ['second accepted marker', s => { s.agreements.push({ ...s.agreements[0], id: crypto.randomUUID(), is_current: false }); }],
  ['open month', s => { s.observed_at = '2026-10-31T23:59:59.000Z'; }]
]) test(`${name} holds rather than coerces, truncates, reprices or allocates a partial family`, async () => {
  const f = await fixture(); change(f.s); assert.throws(() => plan(f.s), { code: 'enterprise_usage_reservation_held' });
});
test('prior prefix cannot be silently reallocated by a changed completion or source', async () => {
  const f = await fixture(), good = plan(f.s);
  f.s.history.push({ id: crypto.randomUUID(), owner_id: f.s.owner_id, agreement_id: f.s.agreement_id,
    phase: 'reserved', prefix: good.prefix.slice(0, 5) });
  assert.equal(plan(f.s).total_cents, 5000);
  f.s.history[0].prefix[0].source = 'usage'; assert.throws(() => plan(f.s), { code: 'enterprise_usage_reservation_held' });
});
test('unmounted bridge does only prepare, pure kernel, reserve and grants no effect authority', async () => {
  const f = await fixture(), id = crypto.randomUUID(), calls = [];
  const db = { async rpc(name, args) {
    calls.push({ name, args });
    if (name === 'prepare_enterprise_existing_usage') return { data: { phase: 'prepared', batch_id: id,
      generation: 1, snapshot_digest: 'a'.repeat(64), snapshot: f.s }, error: null };
    assert.equal(name, 'reserve_enterprise_existing_usage');
    return { data: { phase: 'reserved', batch_id: id, generation: 1, total_cents: 5000 }, error: null };
  }, from() { throw Error('DB call forbidden in kernel gap'); } };
  const result = await reserve({ db, billingClientId: f.s.owner_id });
  assert.equal(calls.length, 2); assert.deepEqual(Object.keys(calls[0].args), ['p_owner']);
  assert.equal(Object.keys(calls[1].args).some(k => /clock|expiry|stripe/.test(k)), false);
  assert.equal(result.provider_effect_authorized, false); assert.equal(result.paid_access_authorized, false);
  assert.equal(result.payroll_authorized, false); assert.equal(result.total_cents, 5000);
});
test('unmounted bridge skips an open service month without minting a no-usage or money claim',async()=>{
 let calls=0;
 const db={async rpc(name,args){calls++;assert.equal(name,'prepare_enterprise_existing_usage');assert.deepEqual(Object.keys(args),['p_owner']);
  return {data:{phase:'not_due',provider_effect_authorized:false},error:null};}};
 const result=await reserve({db,billingClientId:crypto.randomUUID()});
 assert.equal(calls,1);assert.equal(result.phase,'not_due');assert.equal(Object.hasOwn(result,'total_cents'),false);
 assert.equal(result.provider_effect_authorized,false);assert.equal(result.paid_access_authorized,false);assert.equal(result.payroll_authorized,false);
});
