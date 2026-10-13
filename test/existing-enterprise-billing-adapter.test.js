'use strict';
// Injected SDK/RPC mocks, NOT native SQL, Stripe cash or delivery acceptance.
const { test } = require('node:test'), assert = require('node:assert/strict');
const { applyExistingEnterpriseBilling: apply } = require('../src/services/existingEnterpriseBillingAdapter');
const { verifyEnterpriseBillingReceipt } = require('../src/services/existingEnterpriseBillingReceipt');
const fixture = require('./helpers/enterprise-existing-funding-fixture');
const clone = value => structuredClone(value);
function ready(options) {
  const f = fixture(options), values = f.a.template_snapshot.values;
  Object.assign(values, { term_start_basis: 'successful_payment', initial_term_start: '', initial_renewal_date: '' });
  const { execution, ...unsigned } = f.a.template_snapshot;
  f.seal.source_snapshot = clone(unsigned);
  f.a.enterprise_checkout_source.material.template_snapshot = clone(f.a.template_snapshot);
  f.a.enterprise_checkout_source.material.execution_seal = clone(f.seal);
  Object.assign(f.p.subscription, { current_period_end: Date.parse('2026-11-01T00:00:00Z') / 1000, cancel_at_period_end: false });
  f.nativeWrites = 0; f.fundWrites = 0; f.rpcNames = []; f.initialPlan = null;
  f.db.rpc = async (name, params) => {
    f.rpcNames.push(name);
    if (name === 'read_enterprise_existing_billing') {
      assert.equal(params.p_agreement, f.a.id);
      const w = f.a.enterprise_billing_receipt;
      if (w && (f.client.stripe_subscription_id !== w.funding_receipt.proof.subscription_id
        || f.client.stripe_customer_id !== w.funding_receipt.proof.customer_id || f.a.is_current !== true
        || f.a.status !== 'signed' || f.pool.status !== 'pending')) return { data: null, error: { message: 'SYNTHETIC binding denied' } };
      return { data: w ? clone(w) : null, error: null };
    }
    if (name === 'record_enterprise_existing_funding') {
      if (f.client.stripe_subscription_id) return { data: null, error: { message: 'SYNTHETIC original funding context denied' } };
      if (!f.a.enterprise_funding_receipt) {
        f.fundWrites++; f.a.enterprise_funding_receipt = { version: 'enterprise_existing_funding_v1', proof: clone(params.p_proof),
          recorded_at: '2026-10-13T12:00:00.123456Z' };
      } else assert.deepEqual(f.a.enterprise_funding_receipt.proof, params.p_proof);
      if (f.loseFundAck) { f.loseFundAck = false; return { data: null, error: { message: 'SYNTHETIC lost funding ACK' } }; }
      return { data: clone(f.a.enterprise_funding_receipt), error: null };
    }
    assert.equal(name, 'apply_enterprise_existing_billing');
    assert.equal(params.p_agreement, f.a.id); assert.equal(params.p_client, f.a.client_id);
    assert.deepEqual(params.p_source, f.a.enterprise_checkout_source); assert.deepEqual(params.p_prices, f.a.enterprise_checkout_prices);
    assert.deepEqual(clone(params.p_funding), f.a.enterprise_funding_receipt);
    if (!f.a.enterprise_billing_receipt) {
      const proof = params.p_funding.proof, sub = params.p_subscription, six = instant => instant.replace(/(\.\d{3})Z$/, '$1000Z');
      assert.equal(sub.status, 'active'); assert.equal(sub.cancel_at_period_end, false);
      assert.equal(typeof sub.current_period_end, 'number');
      const clientInitial = { stripe_customer_id: proof.customer_id, stripe_subscription_id: proof.subscription_id,
        subscription_status: 'active', billing_status: 'active', billing_interval: f.a.billing_option, plan_tier: 'enterprise',
        current_term_end: six(new Date(sub.current_period_end * 1000).toISOString()), cancel_at_term_end: false,
        auto_renew: true, cancel_effective_at: null, contract_start_at: six(proof.payment_success_at),
        contract_end_at: '2027-10-01T13:00:00.000000Z' };
      const planInitial = { client_id: f.a.client_id, plan_tier: 'enterprise', billing_interval: f.a.billing_option,
        platform_fee: 999.99, per_role_fee: 0, included_interviews_per_role: 0, additional_interview_fee: 0,
        max_interview_minutes: 20, scored_question_count: 5, billing_model: 'usage', usage_interview_fee_cents: 2500 };
      f.a.enterprise_billing_receipt = { version: 'enterprise_existing_billing_v1', funding_receipt: clone(params.p_funding),
        subscription: clone(sub), client_initial: clientInitial, plan_initial: planInitial, applied_at: '2026-10-13T12:00:00.123457Z' };
      Object.assign(f.client, clone(clientInitial)); f.initialPlan = clone(planInitial); f.nativeWrites++;
    } else {
      assert.deepEqual(clone(params.p_funding), f.a.enterprise_billing_receipt.funding_receipt);
      assert.deepEqual(clone(params.p_subscription), f.a.enterprise_billing_receipt.subscription);
    }
    if (f.afterBilling) f.afterBilling();
    if (f.loseBillingAck) { f.loseBillingAck = false; return { data: null, error: { message: 'SYNTHETIC lost billing ACK' } }; }
    let data = clone(f.a.enterprise_billing_receipt);
    if (f.mutateAck) data = f.mutateAck(data);
    return { data, error: null };
  };
  return f;
}
for (const cadence of ['monthly', 'annual']) for (const embedded of [true, false]) {
  test('SDK/native-RPC mocks apply and replay ' + cadence + '/' + embedded + ' without original-context retry or paid flags', async () => {
    const f = ready({ cadence, embedded }), first = await apply({ ...f.args, eventSessionId: 'cs_synthetic', eventLivemode: false });
    assert.equal(first.billing_applied, true); assert.equal(first.credits_spendable, false);
    assert.equal(first.membership_activation_required, true); assert.equal(first.native_receipt_required, true);
    assert.ok(Object.isFrozen(first.billingReceipt)); assert.equal(f.nativeWrites, 1); assert.equal(f.fundWrites, 1);
    const count = f.rpcNames.filter(name => name === 'record_enterprise_existing_funding').length;
    f.p.subscription.current_period_end += 86400; f.p.subscription.cancel_at_period_end = true;
    f.client.subscription_status = 'past_due'; f.client.auto_renew = false; f.initialPlan.billing_model = 'fixed';
    const second = await apply({ ...f.args, eventSubscriptionId: 'sub_synthetic', eventInvoiceId: 'in_initial', eventLivemode: false });
    assert.deepEqual(second.billingReceipt, first.billingReceipt); assert.equal(f.nativeWrites, 1);
    assert.equal(f.rpcNames.filter(name => name === 'record_enterprise_existing_funding').length, count);
    assert.equal(f.client.subscription_status, 'past_due'); assert.equal(f.initialPlan.billing_model, 'fixed');
    assert.equal(f.a.checkout_status, 'pending_payment'); assert.equal(f.a.checkout_paid_at, null);
    assert.equal(f.pool.status, 'pending'); assert.equal(f.pool.paid_at, null); assert.equal(f.db.updates.length, 0);
  });
}
for (const flag of ['loseFundAck', 'loseBillingAck']) {
  test('unknown ' + flag + ' stops, then revalidates SDK and resumes saved native winner once', async () => {
    const f = ready(); f[flag] = true;
    await assert.rejects(apply(f.args), { status: 503 });
    const reads = f.calls.length, done = await apply(f.args);
    assert.equal(done.billing_applied, true); assert.ok(f.calls.length > reads);
    assert.equal(f.nativeWrites, 1); assert.equal(f.fundWrites, 1);
  });
}
for (const change of [w => ({ ...w, extra: true }), w => ({ ...w, version: 'OTHER' }),
  w => ({ ...w, applied_at: '2026-11-31T12:00:00.123457Z' }), w => ({ ...w, applied_at: '2026-10-13T12:00:00.123455Z' }),
  w => ({ ...w, plan_initial: { ...w.plan_initial, platform_fee: 1 } }),
  w => ({ ...w, client_initial: { ...w.client_initial, contract_end_at: '2027-11-01T00:00:00.000000Z' } }),
  w => ({ ...w, subscription: { ...w.subscription, extra: true } })]) {
  test('incomplete/forged native billing acknowledgment never authorizes completion', async () => {
    const f = ready(); f.mutateAck = change;
    await assert.rejects(apply(f.args), { status: 503 }); assert.equal(f.pool.status, 'pending'); assert.equal(f.a.checkout_paid_at, null);
  });
}
test('caller funding/subscription/skip flags cannot bypass SDK proof; corrupt SDK blocks before any native billing', async () => {
  const f = ready(); f.p.paymentIntent.amount_received--;
  await assert.rejects(apply({ ...f.args, funding: { paid: true }, subscription: { status: 'active' }, skipBilling: true }));
  assert.equal(f.nativeWrites, 0); assert.equal(f.fundWrites, 0);
});
test('after billing refunds/nonactive subscription/foreign current identity still require actual SDK/native validation', async () => {
  for (const mutate of [f => { f.p.charge.amount_refunded = 1; }, f => { f.p.subscription.status = 'past_due'; },
    f => { f.client.stripe_customer_id = 'cus_OTHER'; }, f => { f.client.stripe_subscription_id = 'sub_OTHER'; },
    f => { f.a.enterprise_billing_receipt = {}; }, f => { f.a.enterprise_funding_receipt = null; }]) {
    const f = ready(); await apply(f.args); mutate(f);
    await assert.rejects(apply(f.args)); assert.equal(f.nativeWrites, 1); assert.equal(f.fundWrites, 1);
  }
});
test('first native readback changed after ACK is held; retry never restores archived or wrong-owner state', async () => {
  const f = ready(); f.afterBilling = () => { f.a.is_current = false; };
  await assert.rejects(apply(f.args), { status: 503 }); assert.equal(f.nativeWrites, 1);
  await assert.rejects(apply(f.args)); assert.equal(f.nativeWrites, 1);
});
test('strict client/plan derivation and microsecond stamp ordering do not trust a copied self-consistent ACK', async () => {
  const f = ready(), result = await apply(f.args);
  const good = clone(result.billingReceipt);
  assert.throws(() => verifyEnterpriseBillingReceipt({ ...good, applied_at: '2026-10-13T12:00:00.123455Z' },
    { source: f.a.enterprise_checkout_source, prices: f.a.enterprise_checkout_prices, fundingReceipt: good.funding_receipt }), { status: 503 });
  assert.equal(good.client_initial.contract_start_at, '2026-10-01T13:00:00.000000Z');
});
