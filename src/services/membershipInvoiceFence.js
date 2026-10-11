'use strict';

// Pure v2 classification and reconciliation planning; intentionally unwired.
// The eventual Stripe adapter MUST derive kind/accepted/parentLineId from the
// stored accepted Price/item mapping and provider-native linkage, never browser
// labels. This planner performs no collection, void, access or term updates.

const CLASSES = Object.freeze({ CURRENT: 'current', NEXT: 'next_term', RECONCILE: 'reconciliation_only' });

function validEpoch(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validPeriod(start, end) {
  return validEpoch(start) && validEpoch(end) && start < end;
}

function classifyPlatformPeriod({ start, end, termStart, termEnd } = {}) {
  if (!validPeriod(start, end) || !validPeriod(termStart, termEnd)) return CLASSES.RECONCILE;
  if (start >= termStart && end <= termEnd) return CLASSES.CURRENT;
  if (start >= termEnd) return CLASSES.NEXT;
  return CLASSES.RECONCILE;
}

function classifyMembershipInvoice({ contractSubscriptionId, invoiceSubscriptionId, termStart, termEnd, lines } = {}) {
  if (!invoiceSubscriptionId) return { classification: 'outside_subscription', platform_periods: [] };
  if (!contractSubscriptionId || invoiceSubscriptionId !== contractSubscriptionId) {
    return { classification: 'foreign_subscription', platform_periods: [] };
  }
  const reconcile = { classification: CLASSES.RECONCILE, platform_periods: [] };
  if (!validPeriod(termStart, termEnd) || !Array.isArray(lines) || !lines.length) return reconcile;
  // Missing or duplicate provider line IDs cannot establish trusted linkage.
  if (lines.some(line => !line || typeof line.id !== 'string' || !line.id)) return reconcile;
  if (new Set(lines.map(line => line.id)).size !== lines.length) return reconcile;
  const platform = lines.filter(line => line.kind === 'platform');
  if (!platform.length) return reconcile;
  const kinds = platform.map(line => classifyPlatformPeriod({ ...line, termStart, termEnd }));
  const ids = new Set(platform.map(line => line.id));
  const linked = line => ['tax', 'discount'].includes(line.kind) && ids.has(line.parentLineId);
  const other = lines.filter(line => line.kind !== 'platform');
  if (kinds.every(kind => kind === CLASSES.NEXT) && other.every(linked)) {
    return { classification: CLASSES.NEXT, platform_periods: platform.map(({ id, start, end }) => ({ id, start, end })) };
  }
  // A recognized opening credit can share the first platform invoice; unknown
  // or future companion charges never ride an in-term installment unnoticed.
  const currentCompanion = line => linked(line)
    || (line.kind === 'first_role' && line.accepted === true)
    || (line.kind === 'extra_interview' && line.accepted === true
      && classifyPlatformPeriod({ ...line, termStart, termEnd }) === CLASSES.CURRENT);
  if (kinds.every(kind => kind === CLASSES.CURRENT) && other.every(currentCompanion)) {
    return { classification: CLASSES.CURRENT, platform_periods: platform.map(({ id, start, end }) => ({ id, start, end })) };
  }
  return reconcile;
}

function planMembershipInvoiceReconciliation({ classification, invoiceStatus, nonRenewalReserved = false } = {}) {
  if (['outside_subscription', 'foreign_subscription'].includes(classification)) return { action: 'untouched' };
  if (['void', 'uncollectible'].includes(invoiceStatus)) return { action: 'none' };
  if (!Object.values(CLASSES).includes(classification)) return { action: 'manual_reconciliation' };
  if (!['draft', 'open', 'paid'].includes(invoiceStatus)) return { action: 'manual_reconciliation' };
  if (classification === CLASSES.CURRENT) {
    return { action: invoiceStatus === 'paid' ? 'verify_current_payment' : 'current_obligation' };
  }
  if (classification === CLASSES.NEXT && nonRenewalReserved !== true) return { action: 'reconcile_renewal' };
  if (invoiceStatus === 'paid') return { action: 'record_paid_exception' };
  if (nonRenewalReserved !== true) return { action: 'manual_reconciliation' };
  return { action: classification === CLASSES.NEXT ? 'stop_or_void_then_readback' : 'hold_then_readback' };
}

module.exports = { classifyPlatformPeriod, classifyMembershipInvoice, planMembershipInvoiceReconciliation };
