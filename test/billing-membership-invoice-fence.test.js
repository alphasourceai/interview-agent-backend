'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyPlatformPeriod, classifyMembershipInvoice, planMembershipInvoiceReconciliation } = require('../src/services/membershipInvoiceFence');
const contract = { contractSubscriptionId: 'sub_fixture', invoiceSubscriptionId: 'sub_fixture', termStart: 100, termEnd: 200 };
const line = (start, end, id = 'line_platform') => ({ id, kind: 'platform', start, end });
const classify = lines => classifyMembershipInvoice({ ...contract, lines }).classification;

test('half-open boundaries are total: current, next, prior and crossing', () => {
  assert.equal(classify([line(100, 200)]), 'current');
  assert.equal(classify([line(199, 200)]), 'current');
  assert.equal(classify([line(200, 300)]), 'next_term');
  assert.equal(classify([line(50, 100)]), 'reconciliation_only');
  assert.equal(classify([line(199, 201)]), 'reconciliation_only');
  assert.equal(classify([line(99, 150)]), 'reconciliation_only');
});
test('missing, reversed, zero-length or invalid periods and contract dates hold', () => {
  for (const [start, end] of [[undefined, 200], [100, null], [200, 100], [100, 100], ['100', 200], [100.5, 200]]) {
    assert.equal(classify([line(start, end)]), 'reconciliation_only');
  }
  assert.equal(classifyPlatformPeriod({ start: 100, end: 200, termStart: 200, termEnd: 100 }), 'reconciliation_only');
  assert.equal(classifyMembershipInvoice({ ...contract, termEnd: null, lines: [line(100, 200)] }).classification, 'reconciliation_only');
});
test('mixed current/next platform invoices stay unvoided under reconciliation', () => {
  const classification = classify([line(100, 200), line(200, 300, 'line_next')]);
  assert.equal(classification, 'reconciliation_only');
  assert.deepEqual(planMembershipInvoiceReconciliation({ classification, invoiceStatus: 'draft', nonRenewalReserved: true }), { action: 'hold_then_readback' });
});
test('next-term invoice only admits provider-linked tax/discount companions', () => {
  for (const kind of ['tax', 'discount']) {
    assert.equal(classify([line(200, 300), { id: 'line_other', kind, parentLineId: 'line_platform' }]), 'next_term');
    assert.equal(classify([line(200, 300), { id: 'line_other', kind, parentLineId: 'unmatched' }]), 'reconciliation_only');
  }
  for (const kind of ['first_role', 'extra_interview', 'usage', 'unknown']) {
    assert.equal(classify([line(200, 300), { id: 'line_other', kind, accepted: true }]), 'reconciliation_only');
  }
});
test('current opening admits accepted one-time credit, but not unknown or future charges', () => {
  assert.equal(classify([line(100, 200), { id: 'credit', kind: 'first_role', accepted: true }]), 'current');
  assert.equal(classify([line(100, 200), { id: 'extra', kind: 'extra_interview', accepted: true, start: 110, end: 150 }]), 'current');
  for (const companion of [{ id: 'unknown', kind: 'unknown' }, { id: 'credit', kind: 'first_role' },
    { id: 'extra', kind: 'extra_interview', accepted: true, start: 200, end: 210 }]) {
    assert.equal(classify([line(100, 200), companion]), 'reconciliation_only');
  }
});
test('foreign and absent subscription invoices stay outside this fence', () => {
  for (const [invoiceSubscriptionId, expected] of [['sub_other', 'foreign_subscription'], [null, 'outside_subscription']]) {
    const result = classifyMembershipInvoice({ ...contract, invoiceSubscriptionId, lines: [line(200, 300)] });
    assert.equal(result.classification, expected);
    assert.deepEqual(planMembershipInvoiceReconciliation({ classification: expected, invoiceStatus: 'paid', nonRenewalReserved: true }), { action: 'untouched' });
  }
});
test('untrusted/missing/duplicate line identity and platform-free invoices hold', () => {
  for (const lines of [[], [null], [{ kind: 'platform', start: 100, end: 200 }],
    [line(100, 200), line(100, 200)], [{ id: 'usage', kind: 'usage' }]]) {
    assert.equal(classify(lines), 'reconciliation_only');
  }
});
test('paid next-term and crossing payments plan an exception, never entitlement mutation', () => {
  for (const classification of ['next_term', 'reconciliation_only']) {
    assert.deepEqual(planMembershipInvoiceReconciliation({ classification, invoiceStatus: 'paid', nonRenewalReserved: true }), { action: 'record_paid_exception' });
  }
});
test('current paid access must be verified separately; pending renewal alignment does not erase obligation', () => {
  assert.deepEqual(planMembershipInvoiceReconciliation({ classification: 'current', invoiceStatus: 'paid', nonRenewalReserved: true }), { action: 'verify_current_payment' });
  assert.deepEqual(planMembershipInvoiceReconciliation({ classification: 'current', invoiceStatus: 'open', nonRenewalReserved: true }), { action: 'current_obligation' });
});
test('only a durably reserved non-renewal permits stop/void; auto-renew uses distinct renewal reconciliation', () => {
  assert.deepEqual(planMembershipInvoiceReconciliation({ classification: 'next_term', invoiceStatus: 'open', nonRenewalReserved: true }), { action: 'stop_or_void_then_readback' });
  for (const nonRenewalReserved of [false, 'true']) {
    assert.deepEqual(planMembershipInvoiceReconciliation({ classification: 'next_term', invoiceStatus: 'open', nonRenewalReserved }), { action: 'reconcile_renewal' });
  }
});
test('void/uncollectible and ambiguous statuses never grant access or claim provider success', () => {
  for (const invoiceStatus of ['void', 'uncollectible']) {
    assert.deepEqual(planMembershipInvoiceReconciliation({ classification: 'next_term', invoiceStatus, nonRenewalReserved: true }), { action: 'none' });
  }
  assert.deepEqual(planMembershipInvoiceReconciliation({ classification: 'next_term', invoiceStatus: 'processing', nonRenewalReserved: true }), { action: 'manual_reconciliation' });
});
