'use strict';

const { formatInTimeZone } = require('date-fns-tz');

const TIMEZONE = 'America/Denver';

function integer(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`invalid_report_${label}`);
  return number;
}

function localDate(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('invalid_report_event_date');
  return formatInTimeZone(parsed, TIMEZONE, 'yyyy-MM-dd');
}

function emptyTotals() {
  return { sale_count: 0, gross_sales_cents: 0, adjustment_cents: 0, net_revenue_cents: 0, commission_cents: 0 };
}

function addEvent(representative, event) {
  representative.events.push(event);
  representative.gross_sales_cents += event.gross_sales_cents;
  representative.adjustment_cents += event.adjustment_cents;
  representative.net_revenue_cents += event.net_revenue_cents;
  representative.commission_cents += event.commission_cents;
  if (![representative.gross_sales_cents, representative.adjustment_cents, representative.net_revenue_cents,
    representative.commission_cents].every(Number.isSafeInteger)) throw new Error('report_amount_out_of_range');
}

function buildSalesPayrollReport({ dateFrom, dateTo, representatives, receipts, adjustments, linkedReceipts, intents, generatedAt = new Date().toISOString() }) {
  const reps = representatives.map((row) => ({
    user_id: row.user_id, display_name: String(row.display_name || '').trim(), email: String(row.email || '').trim(),
    ...emptyTotals(), events: [],
  }));
  const repById = new Map(reps.map((row) => [row.user_id, row]));
  const receiptsById = new Map([...linkedReceipts, ...receipts].map((row) => [row.id, row]));
  const intentById = new Map(intents.map((row) => [row.id, row]));
  const salesByRep = new Map(reps.map((row) => [row.user_id, new Set()]));

  function context(receipt) {
    if (!receipt) throw new Error('report_missing_receipt');
    const representative = repById.get(receipt.rep_user_id);
    const intent = intentById.get(receipt.purchase_intent_id);
    if (!representative || !intent || intent.created_by_user_id !== receipt.rep_user_id || intent.channel !== 'sales_assisted') {
      throw new Error('report_missing_sales_attribution');
    }
    const client = String(intent.company_legal_name || intent.buyer_email || '').trim();
    if (!client) throw new Error('report_missing_client_name');
    return { representative, client };
  }

  for (const receipt of receipts) {
    const { representative, client } = context(receipt);
    const gross = integer(receipt.gross_membership_cents, 'gross');
    const discount = integer(receipt.discount_cents, 'discount');
    const fee = integer(receipt.provider_fee_cents, 'provider_fee');
    const net = integer(receipt.net_membership_cents, 'net');
    const commission = integer(receipt.commission_cents, 'commission');
    if (gross <= 0 || discount < 0 || fee < 0 || gross - discount - fee !== net) throw new Error('report_receipt_reconciliation_failed');
    addEvent(representative, {
      id: `receipt:${receipt.id}`, date: localDate(receipt.funds_received_at), client_name: client,
      activity: receipt.payment_kind === 'monthly' ? 'Monthly payment' : receipt.payment_kind === 'financed_checkout' ? 'Financed payment' : 'Annual payment',
      gross_sales_cents: gross, adjustment_cents: -discount - fee, net_revenue_cents: net,
      commission_cents: commission, purchase_intent_id: receipt.purchase_intent_id, receipt_id: receipt.id,
    });
    salesByRep.get(representative.user_id).add(receipt.purchase_intent_id);
  }

  for (const adjustment of adjustments) {
    const receipt = receiptsById.get(adjustment.receipt_id);
    const { representative, client } = context(receipt);
    const delta = integer(adjustment.net_membership_delta_cents, 'adjustment');
    const commission = integer(adjustment.commission_delta_cents, 'commission_adjustment');
    if (delta === 0) throw new Error('report_zero_adjustment');
    addEvent(representative, {
      id: `adjustment:${adjustment.id}`, date: localDate(adjustment.effective_at), client_name: client,
      activity: adjustment.adjustment_type === 'refund' ? 'Refund' : adjustment.adjustment_type === 'chargeback' ? 'Chargeback' : 'Recovery',
      gross_sales_cents: 0, adjustment_cents: delta, net_revenue_cents: delta,
      commission_cents: commission, purchase_intent_id: receipt.purchase_intent_id, receipt_id: receipt.id,
    });
  }

  const totals = emptyTotals();
  for (const representative of reps) {
    representative.sale_count = salesByRep.get(representative.user_id).size;
    representative.events.sort((a, b) => b.date.localeCompare(a.date) || a.client_name.localeCompare(b.client_name) || a.id.localeCompare(b.id));
    for (const field of Object.keys(totals)) totals[field] += representative[field];
  }
  if (!Object.values(totals).every(Number.isSafeInteger) || totals.gross_sales_cents + totals.adjustment_cents !== totals.net_revenue_cents) {
    throw new Error('report_total_reconciliation_failed');
  }
  reps.sort((a, b) => (a.display_name || a.email).localeCompare(b.display_name || b.email));
  return { date_from: dateFrom, date_to: dateTo, timezone: TIMEZONE, generated_at: generatedAt,
    basis: 'reviewed membership payments by funds-received date; linked adjustments by effective date',
    totals, representatives: reps };
}

module.exports = { buildSalesPayrollReport, localDate };
