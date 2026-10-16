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
async function binding({v2=false}={}) {
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
  if(v2){s.version='enterprise_existing_usage_snapshot_v2';s.legal_window=clone(f.legal);}
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
    amount_remaining: paid ? 0 : sum, ending_balance: stage === 'draft' ? null : 0,
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
test('fresh full census revalidates reserved ledger and allocation without repricing frozen labels', async () => {
  const {raw,b}=await binding();
  const census=Object.fromEntries(['clients','agreements','settings','roles','interviews','pools','purchases','credits','ledger','intents','customers','seals']
    .map(k=>[k,clone(raw.snapshot[k])]));
  census.ledger=raw.groups.flatMap(g=>g.interview_ids.map(interview_id=>({id:randomUUID(),client_id:raw.owner_id,
    role_id:g.role_id,interview_id,unit_price_cents:g.unit_price_cents,enterprise_usage_batch_id:raw.id,
    period_start:raw.snapshot.month_start,period_end:raw.snapshot.month_end,
    stripe_invoice_id:null,stripe_invoice_item_id:null,billed_at:null})));
  const read={status:'read',batch:raw,census,receipt:raw.snapshot.receipt,observed_at:raw.snapshot.observed_at};
  assert.deepEqual(proof.usageInvoiceFreshBinding(read),b);
  census.roles[0].title='Changed current title';assert.deepEqual(proof.usageInvoiceFreshBinding(read),b);
  for(const change of [r=>{r.census.ledger.pop();},r=>{r.census.ledger[0].stripe_invoice_id='in_UNPROVEN';},
    r=>{r.census.interviews[0].completed_at=null;},r=>{r.receipt.client_initial.stripe_customer_id='cus_OTHER';}]){
    const bad=clone(read);change(bad);assert.throws(()=>proof.usageInvoiceFreshBinding(bad));
  }
  const {readEnterpriseExistingUsageProvider,changeEnterpriseExistingUsageProvider}=require('../src/services/enterpriseExistingUsageReservation');
  const calls=[];
  const db={async rpc(name,args){calls.push({name,args});return{error:null,data:args.p_action==='read'
    ?{...read,provider_effect_authorized:false,paid_access_authorized:false,payroll_authorized:false}
    :{status:'store',provider_effect_authorized:false,paid_access_authorized:false,payroll_authorized:false,leaf:{generation:1}}};}};
  const state=await readEnterpriseExistingUsageProvider({db,billingClientId:raw.owner_id});
  assert.deepEqual(state.binding,b);
  await changeEnterpriseExistingUsageProvider({db,state,action:'store',step:'invoice',request:proof.usageInvoiceCreateRequest(b)});
  assert.equal(calls.length,2);assert.equal(calls[1].name,'change_enterprise_existing_usage_provider');
  assert.deepEqual(clone(calls[1].args.p_observation),census);
  assert.equal(calls[1].args.p_generation,0);assert.equal(Object.keys(calls[1].args).some(k=>/clock|until|sent_at/.test(k)),false);
});
test('v2 reserved debt keeps its pinned native legal proof and identical invoice keys through fresh census validation',async()=>{
 const {raw,b}=await binding({v2:true}),before=clone(raw.snapshot.legal_window);
 const census=Object.fromEntries(['clients','agreements','settings','roles','interviews','pools','purchases','credits','ledger','intents','customers','seals']
  .map(k=>[k,clone(raw.snapshot[k])]));
 census.ledger=raw.groups.flatMap(g=>g.interview_ids.map(interview_id=>({id:randomUUID(),client_id:raw.owner_id,
  role_id:g.role_id,interview_id,unit_price_cents:g.unit_price_cents,enterprise_usage_batch_id:raw.id,
  period_start:raw.snapshot.month_start,period_end:raw.snapshot.month_end,stripe_invoice_id:null,stripe_invoice_item_id:null,billed_at:null})));
 const fresh=proof.usageInvoiceFreshBinding({status:'read',batch:raw,census,receipt:raw.snapshot.receipt,legal_window:before,observed_at:'2026-11-02T00:00:00.000000Z'});
 assert.deepEqual(fresh,b);assert.deepEqual(raw.snapshot.legal_window,before);
 assert.deepEqual(proof.usageInvoiceCreateRequest(fresh),proof.usageInvoiceCreateRequest(b));
 census.settings[0].usage_interview_fee_cents=1;
 assert.deepEqual(proof.usageInvoiceFreshBinding({status:'read',batch:raw,census,receipt:raw.snapshot.receipt,legal_window:before,observed_at:'2026-11-02T00:00:00.000000Z'}),b);
});
for(const v2 of [false,true])test(`old ${v2?'v2':'v1'} debt reconciles after renewal with fresh native scope and unchanged invoice amount/keys`,async()=>{
 const {raw,b}=await binding({v2}),pinned=clone(raw);
 const census=Object.fromEntries(['clients','agreements','settings','roles','interviews','pools','purchases','credits','ledger','intents','customers','seals']
  .map(k=>[k,clone(raw.snapshot[k])]));
 census.ledger=raw.groups.flatMap(g=>g.interview_ids.map(interview_id=>({id:randomUUID(),client_id:raw.owner_id,
  role_id:g.role_id,interview_id,unit_price_cents:g.unit_price_cents,enterprise_usage_batch_id:raw.id,
  period_start:raw.snapshot.month_start,period_end:raw.snapshot.month_end,stripe_invoice_id:null,stripe_invoice_item_id:null,billed_at:null})));
 census.interviews.push({...census.interviews[0],id:randomUUID(),completed_at:'2027-10-02T00:00:00.000Z'});
 const initial=raw.snapshot.receipt.client_initial,legal={version:'enterprise_existing_legal_window_v1',agreement_id:raw.agreement_id,
  client_id:raw.owner_id,billing_source_digest:'a'.repeat(32),term_index:1,initial_term_start:initial.contract_start_at,
  original_term_end:initial.contract_end_at,term_start_at:initial.contract_end_at,term_end_at:'2028-10-01T13:00:00.000000Z',
  notice_cutoff_at:'2028-09-01T13:00:00.000000Z',auto_renew:true,accepted_operation_id:null,
  funded_from:'2026-10-01T13:00:00.000000Z',funded_through:'2027-11-01T00:00:00.000000Z',observed_at:'2027-10-02T00:00:01.000000Z',
  provider_effect_authorized:false,paid_access_authorized:false,payroll_authorized:false};
 const read={status:'read',batch:raw,census,receipt:raw.snapshot.receipt,legal_window:legal,observed_at:'2027-11-01T00:00:00.000000Z'};
 assert.deepEqual(proof.usageInvoiceFreshBinding(read),b);assert.deepEqual(raw,pinned);
 assert.deepEqual(proof.usageInvoiceCreateRequest(proof.usageInvoiceFreshBinding(read)),proof.usageInvoiceCreateRequest(b));
 for(const bad of [{legal_window:null},{legal_window:{...legal,client_id:randomUUID()}},
  {legal_window:{...legal,term_end_at:'2027-10-01T13:00:00.000000Z'}},
  {legal_window:{...legal,paid_access_authorized:true}}])assert.throws(()=>proof.usageInvoiceFreshBinding({...read,...bad}),{code:'enterprise_usage_invoice_held'});
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
  shell.stage='items';assert.throws(()=>proof.verifyUsageInvoicePhase(shell));
});
test('draft unpaid remaining must equal its exact verified line total, never a fictitious zero balance',async()=>{
 const {b}=await binding();
 for(const size of [1,2]){
  const f=objects(b,size,'draft');assert.equal(f.invoice.amount_remaining,size*2500);
  assert.equal(proof.verifyUsageInvoicePhase(f).total_cents,size*2500);
  for(const wrong of [0,size*2500-1,size*2500+1]){
   const bad=clone(f);bad.invoice.amount_remaining=wrong;
   assert.throws(()=>proof.verifyUsageInvoicePhase(bad),{code:'enterprise_usage_invoice_held'});
  }
 }
});
test('integer-amount items accept null Price/decimal but never mismatched or coerced values',async()=>{
 const {b}=await binding(),f=objects(b);
 for(const item of f.items){item.price=null;item.unit_amount_decimal=null;}
 for(const line of f.lines){line.price=null;line.unit_amount_excluding_tax=null;}
 assert.equal(proof.verifyUsageInvoicePhase(f).total_cents,b.total_cents);
 for(const change of [x=>{x.items[0].unit_amount='2500';},x=>{x.items[0].unit_amount_decimal='2499';},
  x=>{x.lines[0].unit_amount_excluding_tax='2499';},x=>{x.lines[0].amount=1;},
  x=>{x.items[0].price=objects(b).items[0].price;x.items[0].price.unit_amount=1;}]){
  const bad=clone(f);change(bad);assert.throws(()=>proof.verifyUsageInvoicePhase(bad));
 }
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
function paidObjects(b) {
  const f = objects(b, 2, 'paid');
  Object.assign(f, { paymentMethodId: 'pm_SYNTHETIC', observationEpoch: 1793491204, refunds: [],
    paymentIntent: { id: 'pi_SYNTHETIC', object: 'payment_intent', customer: b.customer_id, livemode: b.livemode,
      currency: 'usd', amount: b.total_cents, amount_received: b.total_cents, created: 1793491202, status: 'succeeded',
      invoice: f.invoiceId, latest_charge: 'ch_SYNTHETIC', payment_method: 'pm_SYNTHETIC' },
    charge: { id: 'ch_SYNTHETIC', object: 'charge', customer: b.customer_id, livemode: b.livemode,
      currency: 'usd', amount: b.total_cents, amount_captured: b.total_cents, created: 1793491202, status: 'succeeded',
      invoice: f.invoiceId, payment_intent: 'pi_SYNTHETIC', payment_method: 'pm_SYNTHETIC', paid: true,
      captured: true, amount_refunded: 0, refunded: false, disputed: false, refunds: null } });
  return f;
}
test('paid proof requires pinned invoice, exact full phase, successful same method PI/charge and refund census', async () => {
  const { b } = await binding(), f = paidObjects(b);
  const result = proof.verifyUsageInvoicePaid(f); assert.equal(result.amount_cents, 5000);
  assert.equal(result.payroll_authorized, false); assert.equal(result.paid_access_authorized, false);
  for (const change of [x => { x.invoiceId = 'in_OTHER'; }, x => { x.paymentIntent.status = 'processing'; },
    x => { x.charge.payment_method = 'pm_OTHER'; }, x => { x.charge.amount_refunded = 1; },
    x => { x.refunds = [{ id: 're_SYNTHETIC' }]; }, x => { x.invoice.paid_out_of_band = true; },
    x => { x.lines.pop(); }]) { const bad = clone(f); change(bad); assert.throws(() => proof.verifyUsageInvoicePaid(bad)); }
});
test('API2023 usage paid proof accepts omitted optional embedded refunds only with fresh empty refunds',async()=>{
  const {b}=await binding(),f=paidObjects(b);delete f.charge.refunds;
  const result=proof.verifyUsageInvoicePaid(f);
  assert.equal(result.amount_cents,5000);assert.equal(result.payroll_authorized,false);assert.equal(result.paid_access_authorized,false);
});
for(const [label,change] of [
  ['missing fresh refunds',f=>{delete f.refunds;}],['nonarray fresh refunds',f=>{f.refunds={object:'list',data:[],has_more:false};}],
  ['nonempty fresh refunds',f=>{f.refunds=[{id:'re_SYNTHETIC'}];}],
  ['own undefined embedded',f=>{f.charge.refunds=undefined;}],['malformed embedded',f=>{f.charge.refunds={};}],
  ['nonempty embedded',f=>{f.charge.refunds={object:'list',has_more:false,data:[{id:'re_SYNTHETIC'}]};}],
  ['truncated embedded',f=>{f.charge.refunds={object:'list',has_more:true,data:[]};}],
  ['refunded charge',f=>{f.charge.amount_refunded=1;}],['disputed charge',f=>{f.charge.disputed=true;}]
])test(`usage paid proof without embedded refunds still denies ${label}`,async()=>{
  const {b}=await binding(),f=paidObjects(b);delete f.charge.refunds;change(f);
  assert.throws(()=>proof.verifyUsageInvoicePaid(f),{code:'enterprise_usage_invoice_held'});
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
  assert.equal(r.paid_access_authorized,false);assert.equal(r.payroll_authorized,false);
  stripe.invoices.list = async () => list([foreign]);
  await assert.rejects(() => proof.readUsageInvoiceCensus({ stripe, binding: b, invoiceId: f.invoiceId }));
  const empty = await proof.readUsageInvoiceCensus({ stripe, binding: b });
  assert.equal(Object.hasOwn(empty, 'effect_absent'), false);
  stripe.getApiField = () => 'wrong'; await assert.rejects(() => proof.readUsageInvoiceCensus({ stripe, binding: b }));
});
test('usage webhook reuses actual native reader/allocation and paid proof, then processed replay only rechecks account',async()=>{
 const {raw,b}=await binding(),f=paidObjects(b);
 const cash=proof.verifyUsageInvoicePaid(f),finalized=proof.verifyUsageInvoicePhase(objects(b,2,'open'));
 raw.provider_operation={version:'enterprise_existing_usage_provider_v1',generation:1,status:'paid',step:'pay',
  invoice_id:f.invoiceId,operations:{finalize:{proof:finalized},pay:{proof:cash,
   request:proof.usageInvoicePayRequest(b,f.invoiceId,f.paymentMethodId)}}};
 const census=Object.fromEntries(['clients','agreements','settings','roles','interviews','pools','purchases','credits','ledger','intents','customers','seals']
  .map(key=>[key,clone(raw.snapshot[key])]));
 census.ledger=raw.groups.flatMap(g=>g.interview_ids.map(interview_id=>({id:randomUUID(),client_id:raw.owner_id,
  role_id:g.role_id,interview_id,unit_price_cents:g.unit_price_cents,enterprise_usage_batch_id:raw.id,
  period_start:raw.snapshot.month_start,period_end:raw.snapshot.month_end,stripe_invoice_id:f.invoiceId,
  stripe_invoice_item_id:finalized.items.find(i=>i.role_id===g.role_id).invoice_item_id,billed_at:'2026-11-01T00:00:02Z'})));
 const state={status:'read',batch:raw,census,receipt:raw.snapshot.receipt,observed_at:'2026-11-01T00:00:10Z',
  provider_effect_authorized:false,paid_access_authorized:false,payroll_authorized:false};
 const before=clone(state),calls=[];let processed=false;
 const db={from(table){assert.ok(['clients','billing_events'].includes(table));return{select(){return this;},
  eq(key,value){assert.equal(key,table==='clients'?'stripe_customer_id':'stripe_event_id');
   assert.equal(value,table==='clients'?b.customer_id:'evt_USAGE_REAL_READER');return this;},
  async maybeSingle(){return{error:null,data:table==='clients'?clone(raw.snapshot.clients[0]):processed?{processed_ok:true}:null};}};},
  async rpc(name,args){assert.equal(name,'change_enterprise_existing_usage_provider');assert.equal(args.p_action,'read');
   assert.equal(args.p_owner,b.owner_id);assert.equal(args.p_batch,b.batch_id);calls.push('native_read');return{error:null,data:clone(state)};}};
 const list=data=>({object:'list',has_more:false,data:clone(data)});
 const stripe={getApiField:()=> '2023-10-16',accounts:{retrieve:async()=>{calls.push('account_get');return{object:'account',id:b.account_id};}},
  invoices:{list:async()=>{calls.push('invoice_list');return list([f.invoice]);},retrieve:async id=>{
   assert.equal(id,f.invoiceId);calls.push('invoice_get');return clone(f.invoice);},listLineItems:async()=>list(f.lines)},
  invoiceItems:{list:async()=>list(f.items)},paymentIntents:{retrieve:async id=>{assert.equal(id,f.paymentIntent.id);return clone(f.paymentIntent);}},
  charges:{retrieve:async id=>{assert.equal(id,f.charge.id);return clone(f.charge);}},refunds:{list:async()=>list([])}};
 delete f.charge.refunds;
 const event={id:'evt_USAGE_REAL_READER',type:'invoice.paid',livemode:b.livemode,data:{object:clone(f.invoice)}};
 delete event.data.object.paid;
 const {classifyExistingEnterprisePaymentEvent:classify}=require('../src/services/existingEnterprisePaymentWebhook');
 const result=await classify({db,stripe,event});assert.equal(result.action,'usage_paid_ack');assert.equal(result.requiresReentry,true);
 assert.equal(calls.filter(c=>c==='native_read').length,2);assert.ok(calls.includes('invoice_get'));assert.deepEqual(clone(state),before);
 processed=true;calls.length=0;
 const repeated=await classify({db,stripe,event});assert.equal(repeated.action,'usage_paid_ack');
 assert.deepEqual(calls,['native_read','account_get','native_read']);assert.deepEqual(clone(state),before);
 // Same full native/proof chain through the INSTALLED SDK over loopback only.
 // Every request is GET; actual SDK hidden response metadata must be stripped.
 const http=require('node:http'),Stripe=require('stripe'),requests=[];
 const server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,'http://127.0.0.1');requests.push({method:req.method,path:url.pathname,version:req.headers['stripe-version']});
  assert.equal(req.method,'GET');let value;
  if(url.pathname==='/v1/account')value=await stripe.accounts.retrieve();
  else if(url.pathname==='/v1/invoices')value=await stripe.invoices.list();
  else if(url.pathname===`/v1/invoices/${f.invoiceId}`)value=await stripe.invoices.retrieve(f.invoiceId);
  else if(url.pathname===`/v1/invoices/${f.invoiceId}/lines`)value=await stripe.invoices.listLineItems();
  else if(url.pathname==='/v1/invoiceitems')value=await stripe.invoiceItems.list();
  else if(url.pathname===`/v1/payment_intents/${f.paymentIntent.id}`)value=await stripe.paymentIntents.retrieve(f.paymentIntent.id);
  else if(url.pathname===`/v1/charges/${f.charge.id}`)value=await stripe.charges.retrieve(f.charge.id);
  else if(url.pathname==='/v1/refunds')value=await stripe.refunds.list();
  assert.ok(value,'only approved local SDK read paths');
  res.writeHead(200,{'content-type':'application/json','request-id':'req_SYNTHETIC_GET_ONLY'});res.end(JSON.stringify(value));
 }catch(_){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'synthetic local read rejected'}}));}});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 try{
  processed=false;
  const sdk=new Stripe('sk_test_SYNTHETIC_LOCAL_ONLY',{apiVersion:'2023-10-16',host:'127.0.0.1',
   port:server.address().port,protocol:'http',maxNetworkRetries:0});
  assert.equal((await classify({db,stripe:sdk,event})).action,'usage_paid_ack');
  assert.ok(requests.length>=10);assert.ok(requests.every(r=>r.method==='GET'&&r.version==='2023-10-16'));
  assert.deepEqual(clone(state),before);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
