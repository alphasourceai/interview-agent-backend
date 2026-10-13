'use strict';

// Usage billing for the Enterprise model.
//
// Enterprise clients pay a platform fee and, beyond a per-role included count,
// a price per interview. This module works out what is owed and records it; it
// does not talk to Stripe.
//
// What is owed is read from the allocation, which decides what paid for every
// interview. Nothing here scans interviews or keeps a counter: the ledger is the
// record of what was billed, written when Stripe asks for an invoice.
//
// The period is the prior calendar month, decided by interviews.completed_at.
// The ledger's unique interview_id is what prevents double billing.
// Prospective receipt-backed Enterprise uses accepted source rates for display;
// its writers are held until the separate calendar-month executor is reviewed.
// Mutable allocations are not immutable invoice authorization for that cohort.
//
// A child client has no subscription of its own, so interviews run under a
// child's roles are billed on the parent's invoice, tagged with the child's
// entity label. Interview credits deliberately do not roll up that way: a credit
// is earned by a role and stays with the client that owns it. See
// review/BILLING-LOG.md.

const { SOURCE_USAGE } = require('./interviewAllocation');
const { createHash } = require('node:crypto');
const { loadAcceptedEnterpriseUsageTerms, fenceAcceptedEnterpriseUsageWriter, hold } = require('./acceptedEnterpriseUsageTerms');

const USAGE_BILLING_MODEL = 'usage';

const EMPTY_USAGE = Object.freeze({ lines: [], total_cents: 0 });

function emptyUsage(reason) {
  return { lines: [], total_cents: 0, reason };
}

function parseWholeNonNegative(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** The prior calendar month in UTC, as [start, end). */
function priorMonthBounds(asOf) {
  const now = asOf instanceof Date ? asOf : new Date(asOf || Date.now());
  const base = Number.isFinite(now.getTime()) ? now : new Date();
  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

function monthLabel(startIso) {
  const date = new Date(startIso);
  if (!Number.isFinite(date.getTime())) return 'current period';
  return `${date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${date.getUTCFullYear()}`;
}

const PRIOR_MONTH_WINDOW = 'prior-month';
const ALL_UNBILLED_WINDOW = 'all';

function normalizeRoleStatus(value) {
  return String(value || '').trim().toLowerCase() === 'inactive' ? 'closed' : 'open';
}

/**
 * What this client owes, read from the allocation rather than scanned.
 *
 * Bills the prior calendar month. A used interview with **no completed_at** is
 * billed on the invoice being built now rather than waiting: its stamp failed,
 * so there is no month to wait for, and leaving it unbilled would lose it
 * silently. The ledger's unique interview_id is what stops it being billed
 * again, and the caller stamps completed_at afterwards so it behaves normally
 * from then on.
 *
 * `window: 'all'` drops the month filter and answers with every metered
 * interview that is not yet on the ledger — what a dashboard shows, where an
 * interview run this morning should already be visible. Billing always uses the
 * default window, so what is *displayed* and what is *charged* come from the
 * same arithmetic and differ only in how far they look.
 */
async function computeUnbilledUsage({ db, clientId, asOf, allocation = null, window = PRIOR_MONTH_WINDOW } = {}) {
  if (!db || !clientId) return emptyUsage('invalid_request');

  const accepted = await loadAcceptedEnterpriseUsageTerms({ db, clientId });
  const billingClientId = accepted?.billingClientId || clientId;

  const resolved = allocation
    || await require('./interviewAllocation').allocateInterviews({ db, billingClientId });
  if (accepted && (resolved.billing_model !== USAGE_BILLING_MODEL || resolved.included_per_role !== 0
    || !(resolved.allowance_by_role instanceof Map) || [...resolved.allowance_by_role.values()].some(n => n !== 0)
    || !(resolved.entity_label_by_client instanceof Map) || !Array.isArray(resolved.entries))) hold();
  if (resolved.billing_model !== USAGE_BILLING_MODEL) return emptyUsage('billing_model');

  const unitPriceCents = accepted?.unitPriceCents ?? parseWholeNonNegative(resolved.usage_interview_fee_cents);
  if (unitPriceCents == null) return emptyUsage('no_usage_price');

  const wholeHistory = window === ALL_UNBILLED_WINDOW;
  const { start, end } = priorMonthBounds(asOf);

  const familyIds = [String(billingClientId), ...[...resolved.entity_label_by_client.keys()]];
  const { data: ledgerRows, error: ledgerError } = await db
    .from('usage_billing_ledger')
    .select('interview_id')
    .in('client_id', familyIds);
  if (ledgerError) throw new Error(ledgerError.message || 'Usage billing ledger lookup failed');
  const ledgered = new Set((ledgerRows || []).map((row) => String(row?.interview_id ?? '')));

  const roleById = new Map((resolved.roles || []).map((role) => [String(role.id), role]));
  if (accepted) {
    const seen = new Set();
    for (const entry of resolved.entries) {
      const completed = typeof entry.completed_at === 'string' ? Date.parse(entry.completed_at) : NaN;
      const role = roleById.get(String(entry.role_id));
      if (!entry.interview_id || seen.has(String(entry.interview_id)) || !role
        || String(role.client_id) !== String(entry.client_id) || !familyIds.includes(String(entry.client_id))
        || !Number.isFinite(completed) || completed < accepted.start || completed >= accepted.end
        || !['usage', 'pool'].includes(entry.source)
        || (entry.source === 'pool' && String(entry.source_id) !== String(accepted.poolId))
        || (entry.source === 'usage' && entry.source_id != null)) hold();
      seen.add(String(entry.interview_id));
    }
  }

  const byRole = new Map();
  const missingCompletedAt = [];
  let totalCents = 0;

  for (const entry of resolved.entries) {
    if (entry.source !== SOURCE_USAGE) continue;
    if (ledgered.has(String(entry.interview_id))) continue;

    const completedAt = entry.completed_at;
    const isMissing = !completedAt;
    if (!wholeHistory && !isMissing && !(accepted
      ? Date.parse(completedAt) >= Date.parse(start) && Date.parse(completedAt) < Date.parse(end)
      : completedAt >= start && completedAt < end)) continue;
    if (isMissing) missingCompletedAt.push(entry);

    const roleId = String(entry.role_id);
    if (!byRole.has(roleId)) {
      const role = roleById.get(roleId) || {};
      byRole.set(roleId, {
        role_id: roleId,
        role_title: String(role.title || '').trim() || 'Role',
        role_status: normalizeRoleStatus(role.status),
        entity_label: resolved.entity_label_by_client.get(String(entry.client_id)) || null,
        quantity: 0,
        unit_price_cents: unitPriceCents,
        amount_cents: 0,
        interview_ids: []
      });
    }
    const line = byRole.get(roleId);
    line.quantity += 1;
    line.amount_cents = line.quantity * unitPriceCents;
    line.interview_ids.push(String(entry.interview_id));
    totalCents += unitPriceCents;
    if (accepted && (!Number.isSafeInteger(line.amount_cents) || !Number.isSafeInteger(totalCents))) hold();
  }

  const lines = [...byRole.values()];
  if (!lines.length) return emptyUsage('nothing_unbilled');
  return {
    lines,
    total_cents: totalCents,
    period_start: start,
    period_end: end,
    month_label: monthLabel(start),
    missing_completed_at: missingCompletedAt.map((entry) => ({
      interview_id: String(entry.interview_id),
      client_id: String(entry.client_id)
    }))
  };
}

/**
 * Stamps completed_at on interviews that reached billing without one.
 *
 * Their completion stamp failed, so the billing time is the only defensible
 * value. Each is logged so the failure can be investigated rather than buried.
 */
async function stampMissingCompletedAt({ db, missing, billedAt } = {}) {
  if (!db || !Array.isArray(missing) || !missing.length) return 0;
  const stampedAt = toIso(billedAt) || new Date().toISOString();
  let stamped = 0;
  for (const row of missing) {
    console.warn('usage_missing_completed_at', {
      interview_id: row.interview_id,
      client_id: row.client_id,
      stamped_completed_at: stampedAt
    });
    const { error } = await db
      .from('interviews')
      .update({ completed_at: stampedAt })
      .eq('id', row.interview_id)
      .is('completed_at', null);
    if (error) {
      console.error('usage_missing_completed_at_stamp_failed', {
        interview_id: row.interview_id,
        error: error.message || error
      });
      continue;
    }
    stamped += 1;
  }
  return stamped;
}

async function recordUsageLines({ db, clientId, lines, stripeInvoiceId, periodStart, periodEnd } = {}) {
  if (!db || !clientId || !Array.isArray(lines) || !lines.length) return { inserted: 0, rows: [] };

  const rows = [];
  for (const line of lines) {
    for (const interviewId of (line?.interview_ids || [])) {
      rows.push({
        client_id: clientId,
        role_id: line.role_id,
        interview_id: interviewId,
        unit_price_cents: line.unit_price_cents,
        stripe_invoice_id: stripeInvoiceId || null,
        period_start: toIso(periodStart),
        period_end: toIso(periodEnd),
        billed_at: null
      });
    }
  }
  if (!rows.length) return { inserted: 0, rows: [] };
  if (rows.length >= 1000) throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: reservation batch limit');

  // unit_price_cents comes back because the caller rebuilds its invoice lines
  // from these rows, and must bill them at the price they were reserved at.
  const { data, error } = await db
    .from('usage_billing_ledger')
    .upsert(rows, { onConflict: 'interview_id', ignoreDuplicates: true })
    .select('id,interview_id,role_id,unit_price_cents');
  if (error) throw new Error(error.message || 'Usage billing ledger write failed');

  const inserted = Array.isArray(data) ? data : [];
  return { inserted: inserted.length, rows: inserted };
}

/**
 * The invoices this client's usage has already been billed on, newest first.
 *
 * History comes from the ledger rather than the allocation: it is the record of
 * what was actually charged, at the price it was charged at, and it must not
 * move if a role is renamed or an interview is re-examined later.
 */
async function listBilledUsageInvoices({ db, clientId, limit = 12 } = {}) {
  if (!db || !clientId) return [];
  const { data, error } = await db
    .from('usage_billing_ledger')
    .select('stripe_invoice_id,unit_price_cents,period_start,period_end,billed_at')
    .eq('client_id', clientId)
    .not('billed_at', 'is', null)
    .order('billed_at', { ascending: false });
  if (error) throw new Error(error.message || 'Usage billing ledger lookup failed');

  const byInvoice = new Map();
  for (const row of (data || [])) {
    const invoiceId = String(row?.stripe_invoice_id || '').trim();
    if (!invoiceId) continue;
    if (!byInvoice.has(invoiceId)) {
      byInvoice.set(invoiceId, {
        stripe_invoice_id: invoiceId,
        interviews: 0,
        amount_cents: 0,
        period_start: row.period_start || null,
        period_end: row.period_end || null,
        month_label: row.period_start ? monthLabel(row.period_start) : null,
        billed_at: row.billed_at || null
      });
    }
    const invoice = byInvoice.get(invoiceId);
    invoice.interviews += 1;
    invoice.amount_cents += Number(row.unit_price_cents || 0);
  }
  return [...byInvoice.values()].slice(0, limit);
}

/** Every ledger row attached to one Stripe invoice. */
async function listLedgerRowsForInvoice({ db, stripeInvoiceId } = {}) {
  if (!db || !stripeInvoiceId) return [];
  const { data, error, count } = await db
    .from('usage_billing_ledger')
    .select('id,client_id,role_id,interview_id,unit_price_cents,stripe_invoice_item_id,billed_at,period_start,period_end', { count: 'exact' })
    .eq('stripe_invoice_id', stripeInvoiceId);
  if (error) throw new Error(error.message || 'Usage billing ledger lookup failed');
  if (!Array.isArray(data) || !Number.isSafeInteger(count) || count !== data.length || count >= 1000) {
    throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: incomplete invoice ledger census');
  }
  return data;
}

/**
 * Stamps the Stripe item and the billing time onto the rows it paid for.
 *
 * Scoped to the invoice as well as the interviews: rows reserved against an
 * invoice that never completed must not be claimed by a later invoice that
 * happens to cover the same interviews.
 */
async function markUsageLinesBilled({ db, stripeInvoiceId, interviewIds, stripeInvoiceItemId, billedAt } = {}) {
  if (!db || !stripeInvoiceId || !Array.isArray(interviewIds) || !interviewIds.length) return 0;
  const { data, error } = await db
    .from('usage_billing_ledger')
    .update({
      stripe_invoice_item_id: stripeInvoiceItemId || null,
      billed_at: toIso(billedAt) || new Date().toISOString()
    })
    .in('interview_id', interviewIds)
    .eq('stripe_invoice_id', stripeInvoiceId)
    .is('billed_at', null)
    .select('id');
  if (error) throw new Error(error.message || 'Usage billing ledger stamp failed');
  return Array.isArray(data) ? data.length : 0;
}

// Rebuilds invoice lines from ledger rows a previous attempt already reserved,
// so a resumed run bills exactly what was reserved and nothing more.
function linesFromLedgerRows(rows, roleMetaById) {
  const byPrice = new Map();
  const interviews = new Set();
  const rowIds = new Set();
  for (const row of rows) {
    const roleId = String(row?.role_id ?? '');
    const interviewId = String(row?.interview_id ?? '');
    const rawPrice = row?.unit_price_cents;
    const unitPrice = (typeof rawPrice === 'number' || (typeof rawPrice === 'string' && /^[0-9]+$/.test(rawPrice)))
      ? parseWholeNonNegative(rawPrice) : null;
    if (!roleId || !interviewId || interviews.has(interviewId) || (row?.id != null && rowIds.has(row.id))
      || !Number.isSafeInteger(unitPrice) || unitPrice < 0 || unitPrice > 2147483647) {
      throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: invalid reserved price group');
    }
    interviews.add(interviewId);
    if (row?.id != null) rowIds.add(row.id);
    const key = JSON.stringify([roleId, unitPrice]);
    if (!byPrice.has(key)) {
      const meta = roleMetaById.get(roleId) || {};
      byPrice.set(key, {
        role_id: roleId,
        role_title: meta.title || 'Role',
        entity_label: meta.entity_label || null,
        quantity: 0,
        unit_price_cents: unitPrice,
        amount_cents: 0,
        interview_ids: []
      });
    }
    const line = byPrice.get(key);
    line.quantity += 1;
    line.interview_ids.push(interviewId);
    line.amount_cents = line.quantity * line.unit_price_cents;
    if (!Number.isSafeInteger(line.amount_cents) || line.amount_cents > 2147483647) {
      throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: reserved price group overflow');
    }
  }
  return [...byPrice.values()];
}

// Preserve the exact old key for valid uniform-price groups.
function usageOperationKey({ invoiceId, clientId, line }) {
  return createHash('sha256').update(JSON.stringify({
    invoiceId, clientId, roleId: line.role_id, price: line.unit_price_cents,
    interviews: [...line.interview_ids].sort()
  })).digest('hex');
}

function assertWholeReservedGroups(rows) {
  const states = new Map();
  for (const row of rows) {
    const key = JSON.stringify([String(row.role_id), Number(row.unit_price_cents)]);
    if (!states.has(key)) states.set(key, new Set());
    states.get(key).add(row.billed_at != null);
  }
  if ([...states.values()].some(v => v.size > 1)) {
    throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: partially stamped price group');
  }
}

// A former role-only item must not be ignored after splitting its prices: that
// could duplicate money following an unknown response. The whole invoice census
// (including siblings) detects wide items even when this worker owns one price.
// All usage history is checked BEFORE any create/stamp. Uniform valid keys and
// the old reconciliation below are retained. This is not a new
// immutable invoice/batch ledger or an authenticated account proof.
async function preflightReservedUsageItems({ stripe, invoiceId, customerId, clientId, allLines }) {
  const counts = new Map();
  for (const line of allLines) counts.set(line.role_id, (counts.get(line.role_id) || 0) + 1);
  const expected = new Map(allLines
    .map(line => [usageOperationKey({ invoiceId, clientId, line }), line]));
  const found = new Map(), seen = new Set();
  let cursor;
  for (let page = 0; page < 100; page++) {
    const result = await stripe.invoiceItems.list({ invoice: invoiceId, limit: 100,
      ...(cursor ? { starting_after: cursor } : {}) });
    if (!Array.isArray(result?.data) || result.data.length > 100 || typeof result.has_more !== 'boolean') {
      throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: incomplete mixed-price provider history');
    }
    for (const item of result.data) {
      if (typeof item?.id !== 'string' || !item.id || seen.has(item.id)) {
        throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: duplicate or missing provider item identity');
      }
      seen.add(item.id);
      const key = item.metadata?.usage_operation;
      if (item.metadata?.source !== 'usage_billing') {
        if (expected.has(key) || (key && counts.has(item.metadata?.role_id))) {
          throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: changed mixed-price usage source');
        }
        continue;
      }
      if (!counts.has(item.metadata.role_id)) {
        throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: unknown usage role in mixed-price invoice');
      }
      const line = expected.get(key);
      if (!line || found.has(key)) {
        throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: unknown or duplicate mixed-price operation');
      }
      if ((item.invoice?.id || item.invoice) !== invoiceId || (item.customer?.id || item.customer) !== customerId
        || item.metadata.client_id !== clientId || item.metadata.role_id !== line.role_id
        || item.currency !== 'usd' || !Number.isSafeInteger(item.quantity) || item.quantity !== line.quantity
        || !Number.isSafeInteger(item.amount) || item.amount !== line.amount_cents) {
        throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: mixed-price provider item mismatch');
      }
      found.set(key, item);
    }
    if (!result.has_more) return found;
    const next = result.data.at(-1)?.id;
    if (!next || next === cursor) throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: invalid mixed-price provider cursor');
    cursor = next;
  }
  throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: mixed-price provider scan limit');
}

// A Stripe write can succeed even when its response, or our ledger stamp, fails.
// Reconcile provider items before retrying; a short-lived idempotency key alone
// is not sufficient after Stripe expires its cache. Never infer a legacy item's
// interview set from its role label, or silently pick one of two matches.
async function findExistingUsageItem({ stripe, invoiceId, customerId, clientId, line, operationKey }) {
  let cursor;
  const matches = [];
  for (let page = 0; page < 100; page++) {
    const result = await stripe.invoiceItems.list({ invoice: invoiceId, limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
    if (!Array.isArray(result?.data)) throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: invalid provider item response');
    for (const item of result.data) {
      if (item.metadata?.source !== 'usage_billing' || item.metadata?.role_id !== line.role_id) continue;
      if (!item.metadata.usage_operation) throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: legacy usage item');
      if (item.metadata.usage_operation === operationKey) matches.push(item);
    }
    if (!result.has_more) {
      if (matches.length > 1) throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: duplicate provider items');
      const item = matches[0];
      if (item && (!item.id || (item.invoice?.id || item.invoice) !== invoiceId
        || (item.customer?.id || item.customer) !== customerId
        || item.metadata.client_id !== clientId || item.currency !== 'usd'
        || Number(item.quantity) !== line.quantity || Number(item.amount) !== line.amount_cents)) {
        throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: provider item does not match reserved usage');
      }
      return item || null;
    }
    const next = result.data.at(-1)?.id;
    if (!next || next === cursor) throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: invalid provider cursor');
    cursor = next;
  }
  throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: provider item scan limit');
}

/**
 * Adds one usage item per role and reserved price to a Stripe invoice.
 *
 * Ordering is what makes a partial failure recoverable: the ledger rows are
 * reserved first with billed_at null, then each Stripe item is created, then the
 * rows it paid for are stamped. A retry reconciles unstamped rows against
 * provider items before creating anything, using a stable idempotency key for
 * concurrent requests. Ambiguous provider history is held for manual review.
 *
 * Stripe failures are rethrown so the caller can let Stripe retry.
 */
async function applyUsageToInvoice({
  db, stripe, clientId, customerId, invoiceId, asOf, metadata, now
} = {}) {
  require('../config/guardedPricingDev').assertGuardedDevOutboundAllowed();
  if (!db || !stripe || !clientId || !invoiceId) {
    return { applied: false, reason: 'invalid_request', items: 0, total_cents: 0 };
  }

  await fenceAcceptedEnterpriseUsageWriter({ db, clientId });

  const existing = await listLedgerRowsForInvoice({ db, stripeInvoiceId: invoiceId });
  if (existing.length && existing.every((row) => row.billed_at != null)) {
    return { applied: false, reason: 'already_billed', items: 0, total_cents: 0 };
  }

  const allocation = await require('./interviewAllocation')
    .allocateInterviews({ db, billingClientId: clientId });
  const roleMetaById = new Map((allocation.roles || []).map((role) => [String(role.id), {
    title: String(role.title || '').trim() || 'Role',
    role_status: normalizeRoleStatus(role.status),
    entity_label: allocation.entity_label_by_client.get(String(role.client_id ?? '')) || null
  }]));

  let lines;
  let allLines;
  let periodStart = null;
  let periodEnd = null;
  let billedLabel = monthLabel(priorMonthBounds(asOf).start);
  let missingCompletedAt = [];
  if (existing.length) {
    periodStart = existing[0]?.period_start || null;
    periodEnd = existing[0]?.period_end || null;
    billedLabel = monthLabel(periodStart);
    // Resume: bill exactly what the failed attempt reserved.
    allLines = linesFromLedgerRows(existing, roleMetaById);
    assertWholeReservedGroups(existing);
    lines = linesFromLedgerRows(existing.filter((row) => row.billed_at == null), roleMetaById);
  } else {
    const usage = await computeUnbilledUsage({ db, clientId, asOf, allocation });
    if (!usage.lines.length) {
      return { applied: false, reason: usage.reason || 'nothing_unbilled', items: 0, total_cents: 0 };
    }
    periodStart = usage.period_start;
    periodEnd = usage.period_end;
    billedLabel = usage.month_label;
    missingCompletedAt = usage.missing_completed_at || [];

    // Bill exactly what this run reserved, never what it computed. The reserve
    // is an upsert that skips interviews already on the ledger, so a run that
    // overlapped with another gets back fewer rows than it asked for — and
    // billing the computed set would charge the client twice for the interviews
    // the other run already took.
    const reserved = await recordUsageLines({
      db, clientId, lines: usage.lines, stripeInvoiceId: invoiceId, periodStart, periodEnd
    });
    if (!reserved.inserted) {
      return { applied: false, reason: 'already_reserved', items: 0, total_cents: 0 };
    }
    lines = linesFromLedgerRows(reserved.rows, roleMetaById);
    // Wider detection must not widen this worker's charged reservation subset.
    const census = await listLedgerRowsForInvoice({ db, stripeInvoiceId: invoiceId });
    allLines = linesFromLedgerRows(census, roleMetaById);
    assertWholeReservedGroups(census);
  }

  if (!lines.length) return { applied: false, reason: 'nothing_unbilled', items: 0, total_cents: 0 };

  const completeKeys = new Set(allLines.map(line => usageOperationKey({ invoiceId, clientId, line })));
  if (lines.some(line => !completeKeys.has(usageOperationKey({ invoiceId, clientId, line })))) {
    throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: partial owned price group');
  }
  const reconciledMixed = await preflightReservedUsageItems({ stripe, invoiceId, customerId, clientId, allLines });
  const roleCounts = new Map();
  for (const line of allLines) roleCounts.set(line.role_id, (roleCounts.get(line.role_id) || 0) + 1);
  const mixedRoleIds = new Set([...roleCounts].filter(([, n]) => n > 1).map(([role]) => role));

  const label = billedLabel;
  let items = 0;
  let totalCents = 0;
  for (const line of lines) {
    const operationKey = usageOperationKey({ invoiceId, clientId, line });
    const existingItem = reconciledMixed.get(operationKey)
      || await findExistingUsageItem({ stripe, invoiceId, customerId, clientId, line, operationKey });
    const item = existingItem || await stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoiceId,
      currency: 'usd',
      unit_amount: line.unit_price_cents,
      quantity: line.quantity,
      description: line.entity_label
        ? `Interviews — ${line.entity_label} · ${line.role_title} [${line.role_status || roleMetaById.get(String(line.role_id))?.role_status || 'open'}] (${label})`
        : `Interviews — ${line.role_title} [${line.role_status || roleMetaById.get(String(line.role_id))?.role_status || 'open'}] (${label})`,
      metadata: {
        ...(metadata || {}),
        client_id: clientId,
        role_id: line.role_id,
        source: 'usage_billing',
        usage_operation: operationKey
      }
    }, { idempotencyKey: `usage-item-${operationKey}` });
    if (!item?.id) throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: provider returned no item id');
    if (mixedRoleIds.has(line.role_id)) {
      // A returned identifier alone is not the reserved amount/ownership proof.
      const readback = await preflightReservedUsageItems({ stripe, invoiceId, customerId, clientId, allLines });
      if (readback.get(operationKey)?.id !== item.id) {
        throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: mixed-price item readback missing');
      }
    }

    await markUsageLinesBilled({
      db,
      stripeInvoiceId: invoiceId,
      interviewIds: line.interview_ids,
      stripeInvoiceItemId: item?.id || null,
      billedAt: toIso(now) || new Date().toISOString()
    });
    items += 1;
    totalCents += line.amount_cents;
  }

  // Their completion stamp failed, so billing time is the only defensible value.
  // Stamped after the ledger rows exist, so the unique interview_id is already
  // guarding against a second charge.
  await stampMissingCompletedAt({ db, missing: missingCompletedAt, billedAt: toIso(now) });

  return { applied: true, items, total_cents: totalCents, lines };
}

/**
 * Raises a usage invoice of its own, rather than waiting for the next cycle.
 *
 * Used for the one-time order at signup and for annual Enterprise clients, whose
 * platform-fee invoice only appears once a year. The invoice is created first so
 * the items and the ledger have something to attach to, then finalized.
 */
async function createImmediateUsageInvoice({
  db, stripe, clientId, customerId, asOf, requestId, reason, now
} = {}) {
  require('../config/guardedPricingDev').assertGuardedDevOutboundAllowed();
  if (!db || !stripe || !clientId) return { skipped: true, reason: 'invalid_request' };

  await fenceAcceptedEnterpriseUsageWriter({ db, clientId });

  const { data: client, error: clientError } = await db
    .from('clients')
    .select('id,stripe_customer_id')
    .eq('id', clientId)
    .maybeSingle();
  if (clientError) throw new Error(clientError.message || 'Usage invoice client lookup failed');
  if (!client) return { skipped: true, reason: 'client_not_found' };

  const stripeCustomerId = String(customerId || client.stripe_customer_id || '').trim();
  if (!stripeCustomerId) return { skipped: true, reason: 'no_stripe_customer' };

  // Immediate-invoice retries do not have Stripe's webhook invoice id. A held
  // reservation must be surfaced for reconciliation, never silently skipped or
  // replaced with a fresh invoice. Keep failed drafts unable to auto-collect.
  const { start, end } = priorMonthBounds(asOf);
  const { data: held, error: heldError } = await db.from('usage_billing_ledger')
    .select('stripe_invoice_id,billed_at,period_start,period_end')
    .eq('client_id', clientId).order('id', { ascending: true }).limit(1000);
  if (heldError) throw new Error(heldError.message || 'Usage invoice reservation lookup failed');
  if ((held || []).length >= 1000) throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: reservation scan limit');
  if ((held || []).some(row => row.stripe_invoice_id && !row.billed_at)) {
    throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: unstamped invoice reservation');
  }
  const periodInvoiceIds = new Set((held || [])
    .filter(row => toIso(row.period_start) === start && toIso(row.period_end) === end)
    .map(row => row.stripe_invoice_id).filter(Boolean));
  for (const id of periodInvoiceIds) {
    const existingInvoice = await stripe.invoices.retrieve(id);
    if (!existingInvoice || existingInvoice.status === 'draft') {
      throw new Error('USAGE_INVOICE_REQUIRES_REVIEW: held draft invoice');
    }
  }

  // Checked before creating an invoice, so an empty one is never raised.
  const usage = await computeUnbilledUsage({ db, clientId, asOf });
  if (!usage.lines.length) return { skipped: true, reason: usage.reason || 'nothing_unbilled' };

  const invoice = await stripe.invoices.create({
    customer: stripeCustomerId,
    collection_method: 'charge_automatically',
    auto_advance: false,
    metadata: {
      client_id: clientId,
      source: 'usage_billing',
      reason: String(reason || 'admin_request'),
      ...(requestId ? { request_id: String(requestId) } : {})
    }
  });
  const invoiceId = String(invoice?.id || '').trim();
  if (!invoiceId) throw new Error('Usage invoice creation returned no id');

  const applied = await applyUsageToInvoice({
    db,
    stripe,
    clientId,
    customerId: stripeCustomerId,
    invoiceId,
    asOf,
    metadata: { reason: String(reason || 'admin_request') },
    now
  });

  // Nothing was added — the usual cause is a resumed run whose rows were all
  // stamped already. Finalizing now would send the client an empty invoice, and
  // auto_advance would try to collect it, so the draft is discarded instead.
  if (!applied.applied) {
    try {
      await stripe.invoices.del(invoiceId);
    } catch (discardError) {
      console.error('usage_invoice_discard_failed', {
        client_id: clientId,
        stripe_invoice_id: invoiceId,
        error: discardError?.message || String(discardError)
      });
    }
    return { skipped: true, reason: applied.reason || 'nothing_applied' };
  }

  await stripe.invoices.finalizeInvoice(invoiceId, { auto_advance: true });

  return {
    invoice_id: invoiceId,
    period_start: usage.period_start,
    period_end: usage.period_end,
    total_cents: applied.total_cents,
    lines: applied.lines || usage.lines
  };
}

module.exports = {
  ALL_UNBILLED_WINDOW,
  EMPTY_USAGE,
  PRIOR_MONTH_WINDOW,
  USAGE_BILLING_MODEL,
  applyUsageToInvoice,
  computeUnbilledUsage,
  createImmediateUsageInvoice,
  listBilledUsageInvoices,
  listLedgerRowsForInvoice,
  markUsageLinesBilled,
  priorMonthBounds,
  recordUsageLines,
  stampMissingCompletedAt
};
