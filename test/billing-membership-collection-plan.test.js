'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRetailOffer, OFFER_VERSION, anchoredMonthInstant } = require('../src/services/membershipOffers');
const { planMembershipCollection } = require('../src/services/membershipCollectionPlan');
const base = { purchaseId: '00000000-0000-4000-8000-000000000001', sourceDigest: 'a'.repeat(64),
  originalPaidAt: '2026-01-31T23:59:59.000Z' };
function offer(planKey = 'basic', commitmentMonths = 3, paymentOption = 'monthly_installments', firstRolePrepaySelected = false) {
  return buildRetailOffer({ planKey, commitmentMonths, paymentOption, firstRolePrepaySelected,
    channel: 'sales', offerVersion: OFFER_VERSION });
}
function plan(changes = {}) {
  return planMembershipCollection({ ...base, offer: offer(), boundaryOffset: 1, ...changes });
}

for (const planKey of ['basic', 'pro']) for (const commitmentMonths of [3, 6, 12]) {
  for (const paymentOption of ['prepaid', 'monthly_installments']) for (const firstRole of [false, true]) {
    test(`pure collection descriptor ${planKey}/${commitmentMonths}/${paymentOption}/role:${firstRole}`, () => {
      const selected = offer(planKey, commitmentMonths, paymentOption, firstRole);
      assert.equal(selected.first_role_prepay.selected, firstRole);
      assert.equal(selected.first_role_prepay.amount_cents, firstRole ? (planKey === 'basic' ? 35900 : 62900) : 0);
      const n = paymentOption === 'prepaid' ? commitmentMonths : 1;
      const row = plan({ offer: selected, boundaryOffset: n });
      assert.equal(row.platform_cents_before_tax, selected.platform_payment_cents);
      assert.equal(row.first_role_cents, 0);
      assert.equal(row.period_start_at, anchoredMonthInstant(base.originalPaidAt, n));
      assert.equal(row.period_end_at, anchoredMonthInstant(base.originalPaidAt, n + (paymentOption === 'prepaid' ? commitmentMonths : 1)));
      assert.equal(row.kind, paymentOption === 'prepaid' ? 'renewal_first_payment' : 'commitment_installment');
      assert.equal(row.requires_renewal_preference_fence, paymentOption === 'prepaid');
      assert.equal(row.requires_existing_commitment, paymentOption === 'monthly_installments');
      assert.equal(row.collect_not_before, row.period_start_at);
      for (const key of ['provider_effects_enabled', 'paid_access_enabled', 'commission_enabled', 'required_invoice_auto_advance']) assert.equal(row[key], false);
      assert.equal(row.requires_native_period_and_owner_proof, true);
      assert.equal(row.requires_verified_tax_policy, true);
      assert.equal(new Set(Object.values(row.operations)).size, 3);
      assert.ok(Object.values(row.operations).every(key => key.startsWith(row.collection_key) && key.length < 255));
      assert.ok(Object.isFrozen(row) && Object.isFrozen(row.operations));
    });
  }
}
test('original month-end restores 31 after short month, no rolling anchor', () => {
  assert.equal(plan().period_start_at, '2026-02-28T23:59:59.000Z');
  assert.equal(plan().period_end_at, '2026-03-31T23:59:59.000Z');
  assert.equal(plan({ boundaryOffset: 2 }).period_end_at, '2026-04-30T23:59:59.000Z');
  assert.equal(plan({ boundaryOffset: 3 }).period_end_at, '2026-05-31T23:59:59.000Z');
  const quarterly = offer('pro', 3, 'prepaid');
  assert.equal(plan({ offer: quarterly, boundaryOffset: 3 }).period_start_at, '2026-04-30T23:59:59.000Z');
  assert.equal(plan({ offer: quarterly, boundaryOffset: 3 }).period_end_at, '2026-07-31T23:59:59.000Z');
  assert.equal(plan({ offer: quarterly, boundaryOffset: 6 }).period_end_at, '2026-10-31T23:59:59.000Z');
});
test('leap years, midnight and semiannual phase use the original instant', () => {
  assert.equal(plan({ originalPaidAt: '2024-01-31T00:00:00.000Z' }).period_start_at, '2024-02-29T00:00:00.000Z');
  assert.equal(plan({ originalPaidAt: '2024-01-31T00:00:00.000Z', boundaryOffset: 2 }).period_start_at, '2024-03-31T00:00:00.000Z');
  const six = offer('basic', 6, 'prepaid');
  const first = plan({ offer: six, originalPaidAt: '2023-08-31T00:00:00.000Z', boundaryOffset: 6 });
  const next = plan({ offer: six, originalPaidAt: '2023-08-31T00:00:00.000Z', boundaryOffset: 12 });
  assert.equal(first.period_start_at, '2024-02-29T00:00:00.000Z');
  assert.equal(first.period_end_at, '2024-08-31T00:00:00.000Z');
  assert.equal(next.period_end_at, '2025-02-28T00:00:00.000Z');
});
test('renewal preference fence is separate from already committed installments', () => {
  for (const months of [3, 6, 12]) {
    const selected = offer('basic', months);
    for (let n = 1; n < months; n++) {
      const row = plan({ offer: selected, boundaryOffset: n });
      assert.equal(row.requires_existing_commitment, true);
      assert.equal(row.requires_renewal_preference_fence, false);
      assert.equal(row.term_index, 0);
    }
    const nextTerm = plan({ offer: selected, boundaryOffset: months });
    assert.equal(nextTerm.requires_existing_commitment, false);
    assert.equal(nextTerm.requires_renewal_preference_fence, true);
    assert.equal(nextTerm.term_index, 1);
    const owedInNextTerm = plan({ offer: selected, boundaryOffset: months + 1 });
    assert.equal(owedInNextTerm.term_index, 1);
    assert.equal(owedInNextTerm.requires_existing_commitment, true);
    assert.equal(owedInNextTerm.requires_renewal_preference_fence, false);
    // The planner grants NO next-term authority; native commitment is required.
    assert.equal(owedInNextTerm.provider_effects_enabled, false);
  }
});
test('accepted pricing is retained without consulting current catalog; changed descriptors cannot change identity', () => {
  const selected = structuredClone(offer());
  selected.offer_version = 'future-accepted-synthetic-v99';
  selected.platform_payment_cents = 12345;
  selected.platform_commitment_total_cents = 37035;
  selected.initial_payment_cents = 12345;
  const row = plan({ offer: selected });
  assert.equal(row.platform_cents_before_tax, 12345);
  assert.equal(row.offer_version, 'future-accepted-synthetic-v99');
  assert.equal(row.collection_key, plan().collection_key);
  assert.deepEqual(row.operations, plan().operations);
  assert.equal(plan({ sourceDigest: 'b'.repeat(64) }).collection_key, row.collection_key);
  assert.equal(plan({ originalPaidAt: '2026-02-01T00:00:00.000Z' }).collection_key, row.collection_key);
  const differentCommitment = offer('basic', 6);
  assert.notEqual(plan({ boundaryOffset: 3 }).kind, plan({ offer: differentCommitment, boundaryOffset: 3 }).kind);
  assert.equal(plan({ boundaryOffset: 3 }).collection_key, plan({ offer: differentCommitment, boundaryOffset: 3 }).collection_key);
  // Native ledger MUST reject changed descriptors for this SAME unique identity.
});
test('invalid/extra body fields, unsupported cadence/instant and unsafe JSON fail without getters', () => {
  for (const changes of [ { boundaryOffset: 0 }, { boundaryOffset: -1 }, { boundaryOffset: 1.5 }, { boundaryOffset: 12000 },
    { boundaryOffset: '1' }, { purchaseId: '00000000-0000-0000-0000-000000000000' }, { sourceDigest: 'bad' },
    { originalPaidAt: '2026-01-31' }, { originalPaidAt: '2026-01-31T00:00:00+00:00' },
    { originalPaidAt: '9999-12-31T00:00:00.000Z' }, { offer: { ...offer(), platform_commitment_total_cents: 1 } },
    { offer: { ...offer(), first_role_prepay: { selected: false, amount_cents: 1 } } },
    { offer: { ...offer(), renewal: { ...offer().renewal, non_renewal_cutoff: '30days' } } },
    { offer: offer('pro', 6, 'prepaid'), boundaryOffset: 1 }, { autoRenew: true }, { amount: 1 }, { environment: 'production' } ]) {
    assert.throws(() => plan(changes), error => error.code === 'invalid_membership_collection_plan');
  }
  const poisoned = { ...offer() };
  Object.defineProperty(poisoned, 'currency', { enumerable: true, get() { throw Error('must not execute'); } });
  assert.throws(() => plan({ offer: poisoned }), error => error.code === 'invalid_membership_collection_plan');
  assert.throws(() => plan({ offer: new Proxy(offer(), {}) }), error => error.code === 'invalid_membership_collection_plan');
  const outer = { ...base, offer: offer(), boundaryOffset: 1 };
  Object.defineProperty(outer, 'boundaryOffset', { enumerable: true, get() { throw Error('must not execute'); } });
  assert.throws(() => planMembershipCollection(outer), error => error.code === 'invalid_membership_collection_plan');
  for (const key of ['purchaseId', 'sourceDigest']) {
    assert.throws(() => plan({ [key]: { toString() { throw Error('must not coerce'); } } }),
      error => error.code === 'invalid_membership_collection_plan');
    assert.throws(() => plan({ [key]: Symbol('synthetic') }),
      error => error.code === 'invalid_membership_collection_plan');
  }
});
